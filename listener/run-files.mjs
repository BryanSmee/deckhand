// A run's files, on the broker's port (broker-http.mjs) rather than in volumes shared with its
// sandbox, which a cluster would need ReadWriteMany storage for (#393). The sandbox sends its
// run token (`Authorization: Bearer`), from its own sandbox only (broker.mjs check()), and
// gets its own run's files only:
//
//   GET /run/inbox?from=<offset>  the inbox's whole lines after byte `offset`, waiting for one
//                                 (a long poll, 204 when none came): ../sandbox/deckhand-inbox
//                                 keeps its offset, so a restarted listener neither loses nor
//                                 repeats a line
//   GET /run/ca, /run/digest      the egress proxy's CA, the run's digest: fetched once at start
//   PUT /run/shots/<file>         a screenshot, into the run's folder that GET /shots/<folder>/
//                                 serves (http.mjs): PNG, JPEG or WebP, capped
//
// What the runner keeps (runner/inbox.mjs) stays in the listener's data volume.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sendJson } from "../lib/http.mjs";
import { isImage, MAX_SHOT, MAX_SHOTS, readCapped, SHOT_NAME } from "../lib/shots.mjs";

// How long GET /run/inbox waits for a line: under the sandbox's own timeout (deckhand-inbox).
const POLL_MS = 25_000;

// `ctx` (server.mjs): broker, tasks, runner, shotsDir, log. `taskOf(ctx, run)`: the running
// task of the broker's record (broker-http.mjs, which imports this file).
export function createRunFiles(ctx, { taskOf }) {
  const liveOf = (run) => taskOf(ctx, run)?.live ?? null;
  // Run folder → name → the bytes its upload in flight reserved: counted against MAX_SHOTS.
  const pending = new Map();

  // The live run a request comes from, or null once refused.
  async function admit(req, res) {
    const [scheme, token] = (req.headers.authorization ?? "").split(" ");
    const { run, status, message } = await ctx.broker.check(scheme === "Bearer" ? token : "", req);
    if (!run) return (sendJson(res, { message }, status), null);
    const live = liveOf(run);
    if (!live) return (sendJson(res, { message: "unknown or finished run" }, 401), null);
    return live;
  }

  async function inbox(req, res, url, live) {
    const from = Number(url.searchParams.get("from") ?? 0);
    if (!Number.isSafeInteger(from) || from < 0) {
      return sendJson(res, { message: "from: a byte offset" }, 400);
    }
    // A sandbox that goes away stops waiting.
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    const lines = await ctx.runner.poll(live.id, from, { timeout: POLL_MS, signal: gone.signal });
    if (lines === null) return sendJson(res, { message: "no inbox" }, 404);
    if (!lines.length) return res.writeHead(204).end();
    res.writeHead(200, { "content-type": "application/x-ndjson" }).end(lines);
  }

  function file(res, live, name) {
    const data = ctx.runner.file(live.id, name);
    if (data === null) return sendJson(res, { message: `this run has no ${name}` }, 404);
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(data);
  }

  // Read whole (it is capped), checked, then renamed into place: GET /shots never serves half
  // a file, nor one that isn't the image its name says.
  async function shot(req, res, live, name) {
    const match = SHOT_NAME.exec(name);
    if (!match) return sendJson(res, { message: "only .png, .jpg, .jpeg and .webp files" }, 400);
    if (!live.shots) return sendJson(res, { message: "this run has no screenshots" }, 403);
    const folder = join(ctx.shotsDir, live.shots);
    // One upload of a name at a time (the watcher's and gh's may meet): a second one is told
    // to come back (409, which deckhand-files retries), never held in memory beside it.
    const inFlight = pending.get(folder) ?? new Map();
    if (inFlight.has(name)) {
      return sendJson(res, { message: `${name} is being uploaded already` }, 409);
    }
    // What the run's other uploads in flight may still add.
    let others = 0;
    for (const bytes of inFlight.values()) others += bytes;
    const used = folderSize(folder, name) + others;
    const room = Math.min(MAX_SHOT, MAX_SHOTS - used);
    const tooBig = () =>
      sendJson(res, { message: `over ${MAX_SHOT} bytes, or the run's ${MAX_SHOTS}` }, 413);
    const declared = Number(req.headers["content-length"]);
    if (declared > room || room <= 0) return tooBig();
    const reserved = Number.isSafeInteger(declared) ? declared : room;
    inFlight.set(name, reserved);
    pending.set(folder, inFlight);
    const part = join(folder, `.${randomBytes(6).toString("hex")}.part`);
    try {
      const body = await readCapped(req, reserved);
      if (body === null) return tooBig();
      if (!isImage(name, body)) {
        return sendJson(res, { message: `not a ${match[1].toUpperCase()} file` }, 415);
      }
      mkdirSync(folder, { recursive: true });
      writeFileSync(part, body, { mode: 0o644 });
      renameSync(part, join(folder, name));
    } finally {
      rmSync(part, { force: true });
      inFlight.delete(name);
      if (!inFlight.size) pending.delete(folder);
    }
    res.writeHead(204).end();
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://broker");
    const live = await admit(req, res);
    if (!live) return;
    if (req.method === "GET" && url.pathname === "/run/inbox") return inbox(req, res, url, live);
    if (req.method === "GET" && url.pathname === "/run/ca") return file(res, live, "ca");
    if (req.method === "GET" && url.pathname === "/run/digest") return file(res, live, "digest");
    const shotName = /^\/run\/shots\/([^/]+)$/.exec(url.pathname)?.[1];
    if (req.method === "PUT" && shotName) return shot(req, res, live, shotName);
    sendJson(res, { message: "not found" }, 404);
  }

  return { handle };
}

// The bytes of the run's screenshots but `except`'s, which an upload replaces.
function folderSize(folder, except) {
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return 0; // none yet
  }
  let total = 0;
  for (const name of names) {
    if (name === except) continue;
    try {
      total += statSync(join(folder, name)).size;
    } catch {
      // Gone meanwhile.
    }
  }
  return total;
}
