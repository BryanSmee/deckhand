// Git gateway: the only way a sandbox pushes. Sandbox tokens only read contents, so git
// sends pushes here instead (entrypoint.sh: `url.<broker>/git/.pushInsteadOf`), with the
// run token as its password (git-credential-deckhand), checked offline (broker.mjs check()).
// The gateway reads the push's ref updates, refuses any outside `refs/heads/`, to the repo's
// default branch (the branch Deckhand trusts: its `.deckhand.yaml` and Dockerfile
// come from there) or to a branch that isn't the run's own (broker.mjs allow(): its issue's,
// its pull request's), and forwards the rest to GitHub with a token of its own that the sandbox never sees. Updates,
// force-pushes and deletes alike: another task's branch, a maintainer's pull request or
// gh-pages stay out of reach. Then the policies decide each branch it updates (`allow_push`,
// `deny_push`: pushInput(); Deckhand's default, ../policy/mode-work.rego, allows work runs' and
// the repo's own modes that aren't light): a refusal refuses the whole push.
//
// That token writes contents only, so GitHub refuses a push that touches .github/workflows/,
// unless the repo is granted `workflows` (grants.mjs): then a push whose refs all pass
// gets one with `workflows: write` too. The grant is read on each push, so revoking it
// applies to the next one. Such a push is read whole first, and its workflow files checked
// against the repo's mirror (git-mirror.mjs, workflow-check.mjs): GitHub runs a branch's own
// workflows, so one that writes or names a secret is refused, unless the repo is granted
// `workflow_secrets` too and GitHub only runs the default branch's copy of it (#700). Other
// repos' pushes are read too, and refused when their new commits change a workflow (#400):
// GitHub would refuse one the push carries, but a fork's commits are already on GitHub, and
// the gateway doesn't rest on its check for them.
//
// A push GitHub took is the run's last (broker.mjs watchPushes()): when, and to which branch,
// for the dashboard.
//
// Only the smart HTTP push service: fetches go straight to GitHub with the read token.
// Served by the github service (../github/), which sandboxes reach through the egress proxy alone.
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { branchAllowed } from "./broker.mjs";
import { createMirrors } from "./git-mirror.mjs";
import { PUSH_PERMISSIONS, WORKFLOW_PUSH_PERMISSIONS } from "./github-app.mjs";
import { FORK_RUN } from "./github-forks.mjs";
import { runTraits } from "./github-writes.mjs";
import { pkt, pktLines } from "./pkt-line.mjs";

// The ref updates come first in a push: anything bigger than this before them is not git. A
// ref update is a hundred bytes or so; a push of hundreds of branches still fits.
export const MAX_COMMANDS = 64 * 1024;
// GitHub's answer to a push read for its report: a report is a line per ref, and the progress
// lines around it are few.
const MAX_REPORT = 64 * 1024;
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

// The refs GitHub's answer to a push (`answer`, receive-pack's) says it updated, the client
// asking with `caps`: its report's "ok <ref>" lines, from band 1 with side-band. Null without
// report-status: the answer doesn't say.
export function acceptedRefs(answer, caps) {
  if (!caps.includes("report-status") && !caps.includes("report-status-v2")) return null;
  let report = answer;
  if (caps.includes("side-band-64k") || caps.includes("side-band")) {
    const band = pktLines(answer).filter((line) => line[0] === 1);
    report = Buffer.concat(band.map((line) => line.subarray(1)));
  }
  return pktLines(report)
    .map((line) => /^ok (\S+)/.exec(line.toString("utf8"))?.[1])
    .filter(Boolean);
}

// The branch a push GitHub answered with `answer` updated (the last one, deletions aside), or
// null: none, or GitHub refused them.
export function pushedBranch(updates, caps, answer) {
  const accepted = acceptedRefs(answer, caps);
  const update = updates.findLast(
    (u) =>
      u.ref.startsWith("refs/heads/") &&
      !/^0+$/.test(u.new) &&
      (accepted === null || accepted.includes(u.ref)),
  );
  return update ? update.ref.slice("refs/heads/".length) : null;
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
async function packStart(file, end, caps) {
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

// What became of a push GitHub was sent (`answer`: forward()'s, null or none when it failed):
// `rejected` when its report says some ref wasn't taken (a branch protection, a ruleset).
export function pushResult({ refs, caps }, answer) {
  if (!answer) return "failed";
  let accepted;
  try {
    accepted = acceptedRefs(answer, caps);
  } catch {
    return "ok";
  }
  return accepted && refs.some((ref) => !accepted.includes(ref)) ? "rejected" : "ok";
}

// What git shows for a refused ref: one line, not too long.
function oneLine(text, max = 1000) {
  const line = text.replace(/[\0-\x1f\x7f]+/g, " ");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// Why a work run's push can't point `ref` at `missing`, an object it doesn't carry and `repo`
// doesn't have.
const unconnectedReason = (repo, ref, missing) =>
  `this push points ${ref} at ${missing.slice(0, 12)}, which it doesn't carry and ${repo} doesn't have: GitHub keeps a fork's objects with the repository's, so it may be a fork's; push the commits themselves, or: ${FORK_RUN}`;

// Why the workflow files of a push can't go through, by ref (git-mirror.mjs check()'s
// findings, { ref, path, problems }): empty when they all pass. `secrets`: the repo is granted
// `workflow_secrets`, which the message names then.
function workflowRefusals(found, secrets = false) {
  const byRef = new Map();
  for (const { ref, path, problems } of found) {
    byRef.set(ref, [...(byRef.get(ref) ?? []), `${path}: ${problems.join(", ")}`]);
  }
  return new Map(
    [...byRef].map(([ref, files]) => [
      ref,
      oneLine(
        `workflow files a sandbox pushes must cap their token at read and name no secret${secrets ? ", unless \`workflow_secrets\` covers them" : ""}: ${files.join("; ")}`,
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

// What the policies' `allow_push` and `deny_push` read of a push's update of `ref` ({ ref, old,
// new }: commandReader()'s) by `run` (the broker's), the repo's default branch being `base`
// (docs/repo-config/policy-inputs.md#the-push-input): the run as `allow_github` reads it, the branch, and
// whether the push creates or deletes it.
export function pushInput(run, { ref, old, new: next }, base) {
  const zero = (oid) => /^0+$/.test(oid);
  return {
    repo: run.repo,
    mode: run.mode ?? null,
    ...runTraits(run),
    issue: run.issue ?? null,
    action: "push",
    branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null,
    ref,
    created: zero(old),
    deleted: zero(next),
    default_branch: base,
  };
}

export function createGitGateway({
  broker, // broker.mjs: the run a token belongs to
  app, // () => the GitHub App (github-app.mjs), or null before /setup
  // policies.mjs's: `allow_push` and `deny_push` on each branch a push updates. None: every push
  // is refused.
  policies = null,
  // (repo) → whether the operator's policies grant it `workflows` (grants.mjs), or a promise of it
  allowWorkflows = () => false,
  // (repo) → whether they grant it `workflow_secrets` too, or a promise of it: its workflows
  // that only run from the default branch may use secrets (workflow-check.mjs)
  allowWorkflowSecrets = () => false,
  // github-forks.mjs createForkChecks(): whose pushes are checked for a fork's objects
  // (restricted()). None: nobody's.
  forks = null,
  githubUrl = "https://github.com",
  // Where the mirrors of the repos granted `workflows` are kept (git-mirror.mjs).
  mirrorDir = join(tmpdir(), "deckhand-git-mirrors"),
  // Where their pushes are saved while checked; their size cap (git-mirror.mjs).
  spoolDir,
  maxPush,
  fetch = globalThis.fetch,
  // (op, result) → nothing: each push (`ok`, `refused`, `rejected` by GitHub, `failed`) and each
  // mirror's clone or update (the github service's metrics, ../github/metrics.mjs).
  onGit = () => {},
  // (reason) → nothing: each push refused, why (metrics.mjs PUSH_REASONS).
  onRefused = () => {},
  log = () => {},
  now = Date.now,
  headMs = HEAD_MS,
  drainMs = DRAIN_MS,
}) {
  const mirrors = createMirrors({
    root: mirrorDir,
    spoolRoot: spoolDir,
    githubUrl,
    maxPush,
    onFetch: onGit,
  });
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

    // Git only sends credentials once asked: a 401 asks for them (again).
    const { run, claims, status, message } = await broker.check(secretOf(req), req);
    if (!run) {
      const challenge = status === 401 ? { "www-authenticate": 'Basic realm="Deckhand"' } : {};
      return fail(res, status, `Deckhand: ${message}`, challenge);
    }
    // What it may push, from its token's claims, which the broker signed: its repo and
    // branches. A run that can't push has none (broker.mjs allow()).
    const may = {
      repo: claims.repo,
      branches: Array.isArray(claims.branches) ? claims.branches : [],
      push: Array.isArray(claims.branches) && claims.branches.length > 0,
      fork: claims.fork === true,
    };
    // Only a push's requests count as a push refused: its probe, or its pack.
    const pushing =
      service === "git-receive-pack"
        ? req.method === "POST"
        : req.method === "GET" && url.searchParams.get("service") === "git-receive-pack";
    if (may.repo !== repo) {
      if (pushing) counted("run");
      return fail(res, 403, `Deckhand: this run can only push to ${may.repo}`);
    }
    if (!may.push) {
      if (pushing) counted("run");
      return fail(res, 403, "Deckhand: this run can't push");
    }

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
    return { repo, service, run, may, github };
  }

  // A push refused, counted: why (`reason`, metrics.mjs PUSH_REASONS).
  function counted(reason) {
    onRefused(reason);
    onGit("push", "refused");
  }

  // The push's refs refused with `reasons` (ref → why) for `reason` (counted()): what's left of
  // the pack is read and dropped, and git's own rejection report sent when the client reads one.
  async function refuse(req, res, repo, parsed, reasons, reason) {
    counted(reason);
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

  // A push whose every ref update the run may make: { body, token, done, parsed }, `token` the
  // gateway's own for it, `done` what to call once it is forwarded and `parsed` its ref updates
  // (commands()), or nothing once the push is refused.
  async function checkPush(req, res, { repo, run, may, github }) {
    let parsed;
    try {
      parsed = await commands(req);
    } catch (error) {
      counted("error");
      return fail(res, 400, `Deckhand: ${error.message}`);
    }
    // Looked up on each push: a renamed default branch is protected at once. No answer, no
    // push.
    let base;
    try {
      base = await defaultBranch(github, repo);
    } catch (error) {
      log(`Git gateway: ${repo}: ${error.message}`);
      onGit("push", "failed");
      return fail(res, 502, "Deckhand: couldn't check the default branch; try again");
    }
    const reasons = new Map();
    let toBase = false;
    for (const ref of parsed.refs) {
      const why = refusal(ref, base, may.branches);
      if (why) reasons.set(ref, why);
      toBase ||= ref.toLowerCase() === `refs/heads/${base.toLowerCase()}`;
    }
    if (reasons.size) {
      return refuse(req, res, repo, parsed, reasons, toBase ? "default_branch" : "branch");
    }
    // Then the policies, on each branch: one refused refuses the push, as GitHub would take the
    // rest without it.
    for (const update of parsed.updates) {
      const why = await policyRefusal(run, repo, update, base);
      if (why) reasons.set(update.ref, why);
    }
    if (reasons.size) return refuse(req, res, repo, parsed, reasons, "policies");
    // A work run that isn't a fork's: its push is read whole, and its branches may only reach
    // what it carries or the repository has (mirrors.connect()): GitHub keeps a fork network's
    // objects together, so a branch pointed at a fork's commit, or a new commit over a fork's
    // tree, needn't carry them, and its next fetch would bring them as the repository's own.
    const strict = forks?.restricted(may) === true;
    // Without `workflows`, every push is read too, a fork's run's included: GitHub refuses a
    // workflow change pushed without the Workflows permission, but the gateway doesn't rest on
    // it for a fork's commits GitHub already has (#400).
    const workflows = await workflowsGranted(repo);
    // Only now: a push of no branch of the run's (a fork's pull request has none) never gets it.
    if (!workflows) {
      return checkSpooled(req, res, { repo, run, github }, parsed, base, null, strict);
    }
    let token;
    try {
      ({ token } = await github.repoToken(repo, WORKFLOW_PUSH_PERMISSIONS));
    } catch (error) {
      log(`Git gateway: ${repo}: ${error.message ?? error}`);
      // GitHub answers 422 when the installation lacks a permission asked for. Never pushed
      // without it: the run would see GitHub's refusal and not know the grant is there.
      const why =
        error.status === 422
          ? "`workflows` is granted but the App doesn't have the Workflows permission: add Workflows: read and write in its settings and accept it on the installation (docs/guides/github-app.md)"
          : "couldn't get a token for this push; try again";
      return refuse(req, res, repo, parsed, new Map(parsed.refs.map((ref) => [ref, why])), "error");
    }
    return checkSpooled(req, res, { repo, run, github }, parsed, base, token, strict);
  }

  // Why the policies refuse `run`'s update of a branch ({ ref, old, new }), or null.
  async function policyRefusal(run, repo, update, base) {
    if (!policies) return "no policy decides this run's pushes";
    const input = pushInput({ ...run, repo }, update, base);
    const messages = await policies.deny("deny_push", repo, base, () => input);
    return messages.length ? oneLine(`the policies refuse it: ${messages.join("; ")}`) : null;
  }

  // A push read whole, forwarded from disk once it passes: with `strict` (a work run that isn't
  // a fork's), its branches reach nothing it doesn't carry that the repository doesn't have
  // (mirrors.connect()); with `token` (a repo granted `workflows`, the token it pushes
  // with), the workflow files it changes pass (workflow-check.mjs); without, it changes none
  // (ungranted()). Never forwarded unchecked: a mirror that can't be fetched, or a pack that
  // can't be read, refuses it.
  async function checkSpooled(req, res, { repo, run, github }, parsed, base, token, strict) {
    const all = (why) => new Map(parsed.refs.map((ref) => [ref, why]));
    // One push of a run's on disk at a time: a run can't fill it with pushes sent at once.
    if (saving.has(run)) {
      return refuse(
        req,
        res,
        repo,
        parsed,
        all("another push of this run is being checked; try again"),
        "error",
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
      counted("error");
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
    let reason = "fork";
    try {
      const start = await packStart(spooled.file, parsed.end, parsed.caps);
      const read = await github.repoToken(repo, { contents: "read" });
      const pushed = { repo, token: read.token, file: spooled.file, start, dir: spooled.dir };
      if (!token) {
        ({ reasons, reason } = await ungranted(pushed, parsed, strict));
      } else {
        reasons = strict ? await unconnected(pushed, parsed) : new Map();
        if (!reasons.size) {
          reason = "workflows";
          reasons = await workflowReasons(github, pushed, parsed, base);
        }
      }
    } catch (error) {
      log(`Git gateway: ${repo}: ${error.message ?? error}`);
      reason = "error";
      reasons = all(
        token
          ? "couldn't check the workflow files of this push; try again"
          : "couldn't check this push; try again",
      );
    }
    if (reasons.size) {
      await done();
      return refuse(req, res, repo, parsed, reasons, reason);
    }
    return { body: createReadStream(spooled.file), token, done, parsed };
  }

  // Why each branch of a push (`pushed`: mirrors.connect()'s) reaches an object it doesn't
  // carry and the repository doesn't have: ref → why. GitHub keeps a fork's objects with the
  // repository's, so such an object may be a fork's.
  async function unconnected(pushed, parsed) {
    const reasons = new Map();
    for (const { ref, missing } of await mirrors.connect({ ...pushed, updates: parsed.updates })) {
      reasons.set(ref, unconnectedReason(pushed.repo, ref, missing));
    }
    return reasons;
  }

  // Why each branch of a push of a repo not granted `workflows` can't go through: { reasons, reason
  // }, reasons ref → why, and the first's `reason` (counted()). With `strict`, it may reach no
  // object it doesn't carry that the repository doesn't have (unconnected()); a fork's run's may,
  // read from GitHub. Either way, the commits it brings may change no workflow.
  async function ungranted(pushed, parsed, strict) {
    const found = await mirrors.connect({
      ...pushed,
      updates: parsed.updates,
      strict,
      workflows: true,
    });
    const reasons = new Map();
    let reason = null;
    for (const { ref, missing, paths } of found) {
      if (missing) {
        reasons.set(
          ref,
          strict
            ? unconnectedReason(pushed.repo, ref, missing)
            : `couldn't read ${missing.slice(0, 12)}, which this push points ${ref} at and doesn't carry; push the commits themselves`,
        );
        reason ??= strict ? "fork" : "error";
      } else {
        const shown = paths.slice(0, 5).join(", ") + (paths.length > 5 ? ", …" : "");
        reasons.set(
          ref,
          `this push changes ${shown}, and ${pushed.repo} isn't granted \`workflows\`: a sandbox's push changes no workflow without it (docs/security/github.md#without-the-grant); push commits that leave .github/workflows/ as the repository has it (rebase on the default branch when the branch was cut from commits it no longer has)`,
        );
        reason ??= "workflows";
      }
    }
    return { reasons, reason };
  }

  // Why each branch of a push of a repo granted `workflows` can't go through, by its
  // workflow files, alone and merged with the bases of its pull requests: ref → why.
  async function workflowReasons(github, pushed, parsed, base) {
    const updates = [];
    for (const update of parsed.updates) {
      const bases = /^0+$/.test(update.new) ? [] : await pullBases(github, pushed.repo, update.ref);
      updates.push({ ...update, bases });
    }
    const secrets = await secretsGranted(pushed.repo);
    return workflowRefusals(await mirrors.check({ ...pushed, base, updates, secrets }), secrets);
  }

  // The bases of the open pull requests from `ref`, a branch: GitHub runs their workflows from
  // a merge with each.
  async function pullBases(github, repo, ref) {
    const head = `${repo.split("/")[0]}:${ref.slice("refs/heads/".length)}`;
    const res = await github.request(
      repo,
      "GET",
      `/repos/${repo}/pulls?state=open&per_page=100&head=${encodeURIComponent(head)}`,
    );
    if (!res.ok) throw new Error(`pull requests lookup: ${res.status}`);
    const pulls = await res.json();
    if (!Array.isArray(pulls)) throw new Error("pull requests lookup: not a list");
    return pulls.map((pr) => pr.base?.ref).filter(Boolean);
  }

  // Why the run's branch `branch`, already on GitHub, can't have a pull request into `into`
  // opened, edited or marked ready (github-pulls.mjs): its workflows, merged with `into`, as a push of it
  // would be refused. Null when they pass, or the repo isn't granted `workflows`.
  // Throws when they can't be checked.
  async function checkBranch(repo, branch, into) {
    if (!(await workflowsGranted(repo))) return null;
    const github = app();
    if (!github) throw new Error("the GitHub App is not set up");
    const base = await defaultBranch(github, repo);
    const { token } = await github.repoToken(repo, { contents: "read" });
    const secrets = await secretsGranted(repo);
    const found = await mirrors.checkBranch({ repo, token, base, branch, into, secrets });
    return (
      workflowRefusals(
        found.map((f) => ({ ...f, ref: branch })),
        secrets,
      ).get(branch) ?? null
    );
  }

  // Whether the repo is granted `workflows` now; not when that can't be decided.
  const workflowsGranted = (repo) => granted(allowWorkflows, repo);
  // The same for `workflow_secrets`, read with each check: only with `workflows` granted.
  const secretsGranted = (repo) => granted(allowWorkflowSecrets, repo);

  async function granted(allow, repo) {
    try {
      return (await allow(repo)) === true;
    } catch (error) {
      log(`Git gateway: ${repo}: ${error.message ?? error}`);
      return false;
    }
  }

  // Sends the request on to GitHub with the gateway's own push token (`token`, or one with
  // PUSH_PERMISSIONS), and its answer back. Resolves to the answer's first MAX_REPORT bytes
  // when it was a success, null otherwise.
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
    if (!upstream.body) {
      res.end();
      return upstream.ok ? Buffer.alloc(0) : null;
    }
    const kept = [];
    let size = 0;
    const tap = new Transform({
      transform(chunk, _, done) {
        if (size < MAX_REPORT) {
          kept.push(chunk);
          size += chunk.length;
        }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(upstream.body), tap, res);
    return upstream.ok ? Buffer.concat(kept) : null;
  }

  // Tells the run its push went through (broker.mjs watchPushes()), when GitHub updated a branch.
  function pushed(run, repo, parsed, answer) {
    if (!answer) return;
    try {
      const branch = pushedBranch(parsed.updates, parsed.caps, answer);
      if (branch) {
        const head = parsed.updates.findLast((u) => u.ref === `refs/heads/${branch}`)?.new;
        run.pushed?.({ branch, at: now(), head });
      }
    } catch (error) {
      log(`Git gateway: ${repo}: recording a push: ${error.message ?? error}`);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://broker");
    const admitted = await admit(req, res, url);
    if (!admitted) return;
    if (admitted.service === "info/refs") return forward(req, res, url, admitted);
    const push = await checkPush(req, res, admitted);
    if (!push) return;
    // `failed` unless GitHub's answer came whole: the client gone mid-answer counts too.
    let result = "failed";
    try {
      const answer = await forward(req, res, url, admitted, push.body, push.token);
      result = pushResult(push.parsed, answer);
      pushed(admitted.run, admitted.repo, push.parsed, answer);
    } finally {
      onGit("push", result);
      await push.done?.();
    }
  }

  return { handle, checkBranch };
}
