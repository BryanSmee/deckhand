// A run's files, on the broker's port (broker-http.mjs) rather than in volumes shared with its
// sandbox, which a cluster would need ReadWriteMany storage for (#393). The sandbox sends its
// run's secret (`Authorization: Bearer`), from its own address only (broker.mjs sentBy()), and
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
import { NOT_ITS_SANDBOX } from "./broker.mjs";
import { sendJson } from "./web.mjs";

// A screenshot's size, and all of a run's: they are public once linked, and on the
// listener's disk.
export const MAX_SHOT = 10 * 1024 * 1024;
export const MAX_SHOTS = 100 * 1024 * 1024;

// The names a sandbox may upload, which GET /shots serves (http.mjs, from this one), and what
// each type's file starts with: a file of another kind isn't served as an image. The
// sandbox's deckhand-files keeps a copy.
export const SHOT_NAME = /^[\w.-]+\.(png|jpe?g|webp)$/;
const MAGIC = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  jpg: (b) => b.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")),
  jpeg: (b) => b.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")),
  webp: (b) =>
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP",
};

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
    const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
    const run = scheme === "Bearer" ? ctx.broker.runOf(secret) : undefined;
    const live = run && liveOf(run);
    if (!live) return (sendJson(res, { message: "unknown or finished run" }, 401), null);
    if (!(await ctx.broker.sentBy(run, req))) {
      return (sendJson(res, { message: NOT_ITS_SANDBOX }, 403), null);
    }
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
      if (!MAGIC[match[1]](body)) {
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

// The request's body, or null past `max` bytes (the rest isn't read).
async function readCapped(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
