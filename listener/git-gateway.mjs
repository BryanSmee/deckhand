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
// Only the smart HTTP push service: fetches go straight to GitHub with the read token.
// Served on the broker's port, which only the sandboxes' network reaches.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { branchAllowed } from "./broker.mjs";
import { PUSH_PERMISSIONS } from "./github-app.mjs";

// The ref updates come first in a push; anything bigger than this before them is not git.
const MAX_COMMANDS = 1 << 20;

const PATH = /^\/git\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(info\/refs|git-receive-pack)$/;

// The ref updates at the start of a receive-pack request (pkt-lines up to a flush):
// { refs, caps, end } with `caps` the client's capabilities (after the first one) and `end`
// the offset of what follows, null while `buffer` is too short, or throws on anything else.
// Signed pushes (push-cert) are refused rather than parsed.
export function readCommands(buffer) {
  const refs = [];
  let caps = [];
  let pos = 0;
  for (;;) {
    if (buffer.length < pos + 4) return null;
    const hex = buffer.subarray(pos, pos + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error("not a git push");
    const length = parseInt(hex, 16);
    if (length === 0) return { refs, caps, end: pos + 4 };
    if (length < 5) throw new Error("not a git push");
    if (buffer.length < pos + length) return null;
    const [line, extra] = buffer
      .subarray(pos + 4, pos + length)
      .toString("utf8")
      .replace(/\n$/, "")
      .split("\0");
    pos += length;
    if (line.startsWith("shallow ")) continue;
    if (line.startsWith("push-cert")) throw new Error("signed pushes are not supported");
    const match = /^[0-9a-f]{40,64} [0-9a-f]{40,64} (\S+)$/.exec(line);
    if (!match) throw new Error("not a git push");
    if (!refs.length && extra) caps = extra.trim().split(/\s+/);
    refs.push(match[1]);
  }
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
  githubUrl = "https://github.com",
  fetch = globalThis.fetch,
  log = () => {},
}) {
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
  // whole request again, read so far and then the rest as it comes.
  async function commands(req) {
    const chunks = req[Symbol.asyncIterator]();
    let head = Buffer.alloc(0);
    let parsed = readCommands(head);
    while (!parsed) {
      const { value, done } = await chunks.next();
      if (done) throw new Error("not a git push");
      head = Buffer.concat([head, value]);
      if (head.length > MAX_COMMANDS) throw new Error("not a git push");
      parsed = readCommands(head);
    }
    async function* body() {
      yield head;
      for (let next = await chunks.next(); !next.done; next = await chunks.next()) {
        yield next.value;
      }
    }
    return { refs: parsed.refs, caps: parsed.caps, body: body() };
  }

  async function drain(body) {
    try {
      for await (const _ of body);
    } catch {
      // The client gave up: nothing to do.
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://broker");
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
    if (run.repo !== repo) return fail(res, 403, `Deckhand: this run can only push to ${run.repo}`);
    if (!run.push) return fail(res, 403, "Deckhand: this run can't push");

    const advertising = service === "info/refs";
    if (advertising) {
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

    let body;
    if (!advertising) {
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
      if (reasons.size) {
        log(`Git gateway: refused a push to ${repo}: ${[...reasons.values()].join("; ")}`);
        // The pack is not forwarded: let the client finish sending it.
        await drain(parsed.body);
        const report = rejection(parsed.refs, parsed.caps, reasons);
        if (!report) {
          return fail(res, 403, [...reasons.values()].map((r) => `Deckhand: ${r}`).join("\n"));
        }
        res.writeHead(200, {
          "content-type": "application/x-git-receive-pack-result",
          "cache-control": "no-cache",
        });
        return res.end(report);
      }
      body = parsed.body;
    }

    let upstream;
    try {
      const { token } = await github.repoToken(repo, PUSH_PERMISSIONS);
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

  return { handle };
}
