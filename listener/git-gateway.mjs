// Git gateway: the only way a sandbox pushes. Sandbox tokens only read contents, so git
// sends pushes here instead (entrypoint.sh: `url.<broker>/git/.pushInsteadOf`), with the
// run's secret as its password (git-credential-deckhand). The gateway reads the push's ref
// updates, refuses any outside `refs/heads/`, to the repo's default branch (the branch
// Deckhand trusts: its `.deckhand.yaml`, preview hook and Dockerfile come from there) or to a
// branch that isn't the run's own (broker.mjs allow(): its issue's, its pull request's), and
// forwards the rest to GitHub with a token of its own that the sandbox never sees. Updates,
// force-pushes and deletes alike: another task's branch, a maintainer's pull request or
// gh-pages stay out of reach.
//
// That token writes contents only, so GitHub refuses a push that touches .github/workflows/,
// unless the repo is granted `allow_workflows` (grants.mjs): then a push whose refs all pass
// gets one with `workflows: write` too. The grant is read on each push, so revoking it
// applies to the next one. Such a push is read whole first, and its workflow files checked
// against the repo's mirror (git-mirror.mjs, workflow-check.mjs): GitHub runs a branch's own
// workflows, so one that writes or names a secret is refused. Other repos' pushes stream
// through unread.
//
// Only the smart HTTP push service: fetches go straight to GitHub with the read token.
// Served on the broker's port, which only the runs' networks reach.
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { branchAllowed, NOT_ITS_SANDBOX } from "./broker.mjs";
import { createMirrors, MAX_WORKFLOW } from "./git-mirror.mjs";
import { PUSH_PERMISSIONS, WORKFLOW_PUSH_PERMISSIONS } from "./github-app.mjs";
import { workflowProblems } from "./workflow-check.mjs";

// The ref updates come first in a push: anything bigger than this before them is not git. A
// ref update is a hundred bytes or so; a push of hundreds of branches still fits.
export const MAX_COMMANDS = 64 * 1024;
// How long a sandbox may take to send them, and to send the rest of a refused push.
const HEAD_MS = 30_000;
const DRAIN_MS = 60_000;

const PATH = /^\/git\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(info\/refs|git-receive-pack)$/;

// The first `n` bytes of `chunks`, removed from them: copied only when they span several
// chunks, so a pkt-line sent whole costs no copy.
function takeBytes(chunks, n) {
  if (chunks[0].length >= n) {
    const out = chunks[0].subarray(0, n);
    chunks[0] = chunks[0].subarray(n);
    if (!chunks[0].length) chunks.shift();
    return out;
  }
  const parts = [];
  for (let got = 0; got < n;) {
    const c = chunks[0];
    const k = Math.min(c.length, n - got);
    parts.push(c.subarray(0, k));
    got += k;
    if (k === c.length) chunks.shift();
    else chunks[0] = c.subarray(k);
  }
  return Buffer.concat(parts, n);
}

// Reads the ref updates at the start of a receive-pack request (pkt-lines up to a flush) as
// its chunks come: push(chunk) returns null while they are incomplete, then { refs, updates,
// caps, end } with `updates` each ref's { ref, old, new }, `caps` the client's capabilities
// (after the first one) and `end` the offset of what follows; it throws on anything else, or
// past `limit` bytes. Each byte is looked at once, and copied at most once (a pkt-line split
// across chunks): a client sending a few bytes at a time costs no more than one sending it
// all. Signed pushes (push-cert) are refused rather than
// parsed.
export function commandReader(limit = MAX_COMMANDS) {
  const chunks = []; // received, not parsed yet
  let buffered = 0;
  let consumed = 0;
  let length = null; // of the pkt-line being read, once its header is in
  const refs = [];
  const updates = [];
  let caps = [];

  // The next `n` buffered bytes, removed from the buffer.
  function take(n) {
    buffered -= n;
    return takeBytes(chunks, n);
  }

  function line(data) {
    const [text, extra] = data.toString("utf8").replace(/\n$/, "").split("\0");
    if (text.startsWith("shallow ")) return;
    if (text.startsWith("push-cert")) throw new Error("signed pushes are not supported");
    const match = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S+)$/.exec(text);
    if (!match) throw new Error("not a git push");
    if (!refs.length && extra) caps = extra.trim().split(/\s+/);
    refs.push(match[3]);
    updates.push({ ref: match[3], old: match[1], new: match[2] });
  }

  function push(chunk) {
    chunks.push(chunk);
    buffered += chunk.length;
    for (;;) {
      if (length === null) {
        if (buffered < 4) break;
        const hex = take(4).toString("latin1");
        consumed += 4;
        if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error("not a git push");
        length = parseInt(hex, 16);
        if (length === 0) return { refs, updates, caps, end: consumed };
        if (length < 5) throw new Error("not a git push");
      }
      if (buffered < length - 4) break;
      line(take(length - 4));
      consumed += length - 4;
      length = null;
    }
    if (consumed + buffered > limit) throw new Error("not a git push");
    return null;
  }

  return { push };
}

function pkt(data) {
  const body = Buffer.from(data);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}

// What receive-pack answers when it rejects every ref, so git prints each as
// "! [remote rejected] <ref> (<reason>)": `reasons` maps a ref to why, the others fail with
// it. Without report-status, git only sees an HTTP error: null.
export function rejection(refs, caps, reasons) {
  // v2 only adds lines after "ok": its rejections read the same.
  if (!caps.includes("report-status") && !caps.includes("report-status-v2")) return null;
  const lines = [pkt("unpack ok\n")];
  for (const ref of refs) {
    const why = reasons.get(ref) ?? "another ref in this push was refused";
    lines.push(pkt(`ng ${ref} Deckhand: ${why}\n`));
  }
  const report = Buffer.concat([...lines, Buffer.from("0000")]);
  if (!caps.includes("side-band-64k") && !caps.includes("side-band")) return report;
  // Side-band: the report goes on band 1, in pieces that fit a packet.
  const max = caps.includes("side-band-64k") ? 65515 : 995;
  const out = [];
  for (let i = 0; i < report.length; i += max) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + max)])));
  }
  return Buffer.concat([...out, Buffer.from("0000")]);
}

// Where the pack starts in a push spooled to `file`, its ref updates ending at `end`: past the
// push options when the client sends some. Null when there is no pack (only deletions).
export async function packStart(file, end, caps) {
  const handle = await open(file);
  try {
    const { size } = await handle.stat();
    let at = end;
    if (caps.includes("push-options")) {
      const head = Buffer.alloc(Math.min(MAX_COMMANDS, size - end));
      await handle.read(head, 0, head.length, end);
      for (let p = 0; ;) {
        const hex = head.subarray(p, p + 4).toString("latin1");
        if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error("bad push options");
        const length = parseInt(hex, 16);
        if (length === 0) {
          at = end + p + 4;
          break;
        }
        if (length < 4) throw new Error("bad push options");
        p += length;
      }
    }
    return at < size ? at : null;
  } finally {
    await handle.close();
  }
}

// What git shows for a refused ref: one line, not too long.
function oneLine(text, max = 1000) {
  const line = text.replace(/[\0-\x1f\x7f]+/g, " ");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// Why the workflow files a branch changes (git-mirror.mjs changedWorkflows()) can't be
// pushed, by ref: empty when they all pass.
export function workflowRefusals(changed) {
  const byRef = new Map();
  for (const { ref, path, text, problem } of changed) {
    const problems = problem
      ? [problem]
      : text === null
        ? [`not a plain UTF-8 file of at most ${MAX_WORKFLOW / 1024} KiB`]
        : workflowProblems(text);
    if (!problems.length) continue;
    byRef.set(ref, [...(byRef.get(ref) ?? []), `${path}: ${problems.join(", ")}`]);
  }
  return new Map(
    [...byRef].map(([ref, files]) => [
      ref,
      oneLine(
        `workflow files a sandbox pushes must cap their token at read and name no secret: ${files.join("; ")}`,
      ),
    ]),
  );
}

// Why a sandbox may not update `ref`, or null when it may: the run's own branches
// (`branches`, broker.mjs allow()), never the default one.
export function refusal(ref, base, branches) {
  if (!ref.startsWith("refs/heads/")) return `only branches can be pushed (${ref})`;
  const branch = ref.slice("refs/heads/".length);
  // Case-insensitive: "Main" must not pass for a repo whose default is "main".
  if (branch.toLowerCase() === base.toLowerCase()) {
    return `pushing to ${base}, the default branch, is not allowed from a sandbox; push a branch`;
  }
  if (!branchAllowed(branches, branch)) {
    return branches.length
      ? `this run can only push ${branches.join(", ")}, not ${branch}`
      : `this run has no branch to push (${branch})`;
  }
  return null;
}

export function createGitGateway({
  broker, // broker.mjs: the run a secret belongs to
  app, // () => the GitHub App (github-app.mjs), or null before /setup
  allowWorkflows = () => false, // (repo) => whether its grant sets `allow_workflows`
  githubUrl = "https://github.com",
  // Where the mirrors of the repos granted `allow_workflows` are kept (git-mirror.mjs).
  mirrorDir = join(tmpdir(), "deckhand-git-mirrors"),
  // Where their pushes are saved while checked; their size cap (git-mirror.mjs).
  spoolDir,
  maxPush,
  fetch = globalThis.fetch,
  log = () => {},
  headMs = HEAD_MS,
  drainMs = DRAIN_MS,
}) {
  const mirrors = createMirrors({ root: mirrorDir, spoolRoot: spoolDir, githubUrl, maxPush });
  // The runs with a push being saved and checked.
  const saving = new Set();

  // Git shows a text/plain error body as "remote: …" lines.
  function fail(res, status, message, headers = {}) {
    res.writeHead(status, { "content-type": "text/plain", ...headers });
    res.end(`${message}\n`);
  }

  function secretOf(req) {
    const [scheme, value] = (req.headers.authorization ?? "").split(" ");
    if (scheme !== "Basic" || !value) return null;
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded.slice(decoded.indexOf(":") + 1) || null;
  }

  async function defaultBranch(github, repo) {
    const res = await github.request(repo, "GET", `/repos/${repo}`);
    if (!res.ok) throw new Error(`repo lookup: ${res.status}`);
    const branch = (await res.json()).default_branch;
    if (!branch) throw new Error("repo lookup: no default branch");
    return branch;
  }

  // Reads the request until its ref updates are complete: { refs, caps, body } with `body` the
  // whole request again, read so far and then the rest as it comes. Within `headMs`, or the
  // request is dropped.
  async function commands(req) {
    const chunks = req[Symbol.asyncIterator]();
    const reader = commandReader();
    const seen = [];
    const timer = setTimeout(() => req.destroy(new Error("ref updates too slow")), headMs);
    let parsed = null;
    try {
      while (!parsed) {
        const { value, done } = await chunks.next();
        if (done) throw new Error("not a git push");
        seen.push(value);
        parsed = reader.push(value);
      }
    } finally {
      clearTimeout(timer);
    }
    async function* body() {
      yield* seen;
      for (let next = await chunks.next(); !next.done; next = await chunks.next()) {
        yield next.value;
      }
    }
    return { ...parsed, body: body() };
  }

  // The rest of a refused push, read and dropped, so the client reads the answer. Not for
  // longer than `drainMs`: the request is then dropped.
  async function drain(req, body) {
    const timer = setTimeout(() => req.destroy(new Error("refused push too slow")), drainMs);
    try {
      for await (const _ of body);
    } catch {
      // The client gave up, or took too long: nothing to do.
    } finally {
      clearTimeout(timer);
    }
  }

  // The run a request comes from, once it may go through: { repo, service, run, github }, or
  // nothing once refused. Checked in this order: path, run, its sandbox, repo, push right,
  // method, encoding, the App.
  async function admit(req, res, url) {
    const path = PATH.exec(url.pathname);
    if (!path) return fail(res, 404, "not found");
    const repo = `${path[1]}/${path[2]}`.toLowerCase();
    const service = path[3];

    const run = broker.runOf(secretOf(req));
    if (!run) {
      // Git only sends credentials once asked.
      return fail(res, 401, "Deckhand: unknown or finished run", {
        "www-authenticate": 'Basic realm="Deckhand"',
      });
    }
    if (!(await broker.sentBy(run, req))) return fail(res, 403, `Deckhand: ${NOT_ITS_SANDBOX}`);
    if (run.repo !== repo) return fail(res, 403, `Deckhand: this run can only push to ${run.repo}`);
    if (!run.push) return fail(res, 403, "Deckhand: this run can't push");

    if (service === "info/refs") {
      if (req.method !== "GET" || url.searchParams.get("service") !== "git-receive-pack") {
        return fail(res, 403, "Deckhand: only pushes go through the gateway");
      }
    } else if (req.method !== "POST") {
      return fail(res, 405, "method not allowed");
    }
    // A compressed body would hide its ref updates: refused rather than inflated.
    const encoding = req.headers["content-encoding"];
    if (encoding && encoding !== "identity") {
      return fail(res, 415, "Deckhand: compressed pushes are not supported");
    }

    const github = app();
    if (!github) return fail(res, 503, "Deckhand: the GitHub App is not set up");
    return { repo, service, run, github };
  }

  // The push's refs refused with `reasons` (ref → why): what's left of the pack is read and
  // dropped, and git's own rejection report sent when the client reads one.
  async function refuse(req, res, repo, parsed, reasons) {
    log(`Git gateway: refused a push to ${repo}: ${[...reasons.values()].join("; ")}`);
    // The pack is not forwarded: let the client finish sending it.
    await drain(req, parsed.body);
    const report = rejection(parsed.refs, parsed.caps, reasons);
    if (!report) {
      return fail(res, 403, [...reasons.values()].map((r) => `Deckhand: ${r}`).join("\n"));
    }
    res.writeHead(200, {
      "content-type": "application/x-git-receive-pack-result",
      "cache-control": "no-cache",
    });
    res.end(report);
  }

  // A push whose every ref update the run may make: { body, token, done }, `token` the
  // gateway's own for it and `done` what to call once it is forwarded, or nothing once the
  // push is refused.
  async function checkPush(req, res, { repo, run, github }) {
    let parsed;
    try {
      parsed = await commands(req);
    } catch (error) {
      return fail(res, 400, `Deckhand: ${error.message}`);
    }
    // Looked up on each push: a renamed default branch is protected at once. No answer, no
    // push.
    let base;
    try {
      base = await defaultBranch(github, repo);
    } catch (error) {
      log(`Git gateway: ${repo}: ${error.message}`);
      return fail(res, 502, "Deckhand: couldn't check the default branch; try again");
    }
    const reasons = new Map();
    for (const ref of parsed.refs) {
      const why = refusal(ref, base, run.branches);
      if (why) reasons.set(ref, why);
    }
    if (reasons.size) return refuse(req, res, repo, parsed, reasons);
    // Only now: a push of no branch of the run's (a fork's pull request has none) never gets it.
    if (!workflowsGranted(repo)) return { body: parsed.body, token: null };
    let token;
    try {
      ({ token } = await github.repoToken(repo, WORKFLOW_PUSH_PERMISSIONS));
    } catch (error) {
      log(`Git gateway: ${repo}: ${error.message ?? error}`);
      // GitHub answers 422 when the installation lacks a permission asked for. Never pushed
      // without it: the run would see GitHub's refusal and not know the grant is there.
      const why =
        error.status === 422
          ? "`allow_workflows` is granted but the App doesn't have the Workflows permission: add Workflows: read and write in its settings and accept it on the installation (docs/setup.md)"
          : "couldn't get a token for this push; try again";
      return refuse(req, res, repo, parsed, new Map(parsed.refs.map((ref) => [ref, why])));
    }
    return checkWorkflows(req, res, { repo, run, github }, parsed, base, token);
  }

  // The push of a repo granted `allow_workflows`, read whole: forwarded from disk once the
  // workflow files it changes pass (workflow-check.mjs). Never forwarded unchecked: a mirror
  // that can't be fetched, or a pack that can't be read, refuses it.
  async function checkWorkflows(req, res, { repo, run, github }, parsed, base, token) {
    const all = (why) => new Map(parsed.refs.map((ref) => [ref, why]));
    // One push of a run's on disk at a time: a run can't fill it with pushes sent at once.
    if (saving.has(run)) {
      return refuse(
        req,
        res,
        repo,
        parsed,
        all("another push of this run is being checked; try again"),
      );
    }
    saving.add(run);
    let spooled;
    try {
      spooled = await mirrors.spool(parsed.body);
    } catch (error) {
      saving.delete(run);
      log(`Git gateway: ${repo}: ${error.message ?? error}`);
      // The request was dropped with the body: no report the client would still read.
      const tooLarge = error.message === "push too large";
      return fail(
        res,
        tooLarge ? 413 : 400,
        tooLarge
          ? "Deckhand: this push is too large for GitHub"
          : "Deckhand: couldn't receive this push; try again",
        { connection: "close" },
      );
    }
    const done = async () => {
      saving.delete(run);
      await mirrors.remove(spooled.dir);
    };
    let reasons;
    try {
      const start = await packStart(spooled.file, parsed.end, parsed.caps);
      const read = await github.repoToken(repo, { contents: "read" });
      const changed = await mirrors.changedWorkflows({
        repo,
        token: read.token,
        base,
        updates: parsed.updates,
        file: spooled.file,
        start,
        dir: spooled.dir,
      });
      reasons = workflowRefusals(changed);
    } catch (error) {
      log(`Git gateway: ${repo}: ${error.message ?? error}`);
      reasons = all("couldn't check the workflow files of this push; try again");
    }
    if (reasons.size) {
      await done();
      return refuse(req, res, repo, parsed, reasons);
    }
    return { body: createReadStream(spooled.file), token, done };
  }

  // Whether the repo's grant sets `allow_workflows` now; not when it can't be read.
  function workflowsGranted(repo) {
    try {
      return allowWorkflows(repo) === true;
    } catch (error) {
      log(`Git gateway: ${repo}: ${error.message ?? error}`);
      return false;
    }
  }

  // Sends the request on to GitHub with the gateway's own push token (`token`, or one with
  // PUSH_PERMISSIONS), and its answer back.
  async function forward(req, res, url, { repo, service, github }, body, token) {
    let upstream;
    try {
      token ??= (await github.repoToken(repo, PUSH_PERMISSIONS)).token;
      const headers = {
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        "user-agent": req.headers["user-agent"] ?? "git/deckhand",
      };
      for (const name of ["accept", "content-type", "git-protocol"]) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      upstream = await fetch(`${githubUrl}/${repo}.git/${service}${url.search}`, {
        method: req.method,
        headers,
        body,
        duplex: body ? "half" : undefined,
      });
    } catch (error) {
      log(`Git gateway: ${repo}: ${error.message ?? error}`);
      return fail(res, 502, "Deckhand: GitHub couldn't be reached");
    }
    const headers = { "cache-control": "no-cache" };
    const type = upstream.headers.get("content-type");
    if (type) headers["content-type"] = type;
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://broker");
    const admitted = await admit(req, res, url);
    if (!admitted) return;
    if (admitted.service === "info/refs") return forward(req, res, url, admitted);
    const push = await checkPush(req, res, admitted);
    if (!push) return;
    try {
      await forward(req, res, url, admitted, push.body, push.token);
    } finally {
      await push.done?.();
    }
  }

  return { handle };
}
