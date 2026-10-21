// The git gateway: a sandbox's only way to push. The real git client pushes through it to a
// local `git http-backend` that plays GitHub.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { branchAllowed, createBroker } from "../listener/broker.mjs";
import {
  commandReader,
  createGitGateway,
  MAX_COMMANDS,
  refusal,
  rejection,
} from "../listener/git-gateway.mjs";
import { NO_TOKEN } from "../listener/github-app.mjs";
import { sandboxAt, serve, tempDir } from "./helpers.mjs";

const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

function pkt(line) {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}

// The ref updates of a whole buffer: null while it is too short.
const readCommands = (buffer) => commandReader(Infinity).push(buffer);

test("the ref updates of a push are read up to the flush", () => {
  const head = Buffer.from(
    pkt(`${A} ${B} refs/heads/topic\0report-status side-band-64k\n`) +
      pkt(`${ZERO} ${B} refs/heads/other\n`) +
      "0000PACK...",
  );
  assert.deepEqual(readCommands(head), {
    refs: ["refs/heads/topic", "refs/heads/other"],
    updates: [
      { ref: "refs/heads/topic", old: A, new: B },
      { ref: "refs/heads/other", old: ZERO, new: B },
    ],
    caps: ["report-status", "side-band-64k"],
    end: head.indexOf("PACK"),
  });
  // Not all there yet: more is read.
  assert.equal(readCommands(head.subarray(0, 10)), null);
  assert.equal(readCommands(head.subarray(0, head.indexOf("0000"))), null);
  // Shallow lines are skipped, an empty push has no refs.
  assert.deepEqual(readCommands(Buffer.from(pkt(`shallow ${A}\n`) + "0000")).refs, []);
});

test("ref updates sent a byte at a time read the same, each byte once; past the cap, refused", () => {
  const head = Buffer.from(
    pkt(`${A} ${B} refs/heads/topic\0report-status side-band-64k\n`) +
      pkt(`${ZERO} ${B} refs/heads/other\n`) +
      "0000PACK...",
  );
  const reader = commandReader();
  let parsed = null;
  for (let i = 0; !parsed; i++) parsed = reader.push(head.subarray(i, i + 1));
  assert.deepEqual(parsed, readCommands(head));
  // Shallow lines up to the cap, a few bytes at a time: refused once past it, quickly.
  const shallow = Buffer.from(pkt(`shallow ${A}\n`).repeat(Math.ceil(MAX_COMMANDS / 40) + 10));
  const slow = commandReader();
  const started = Date.now();
  assert.throws(() => {
    for (let i = 0; i < shallow.length; i += 3) slow.push(shallow.subarray(i, i + 3));
  }, /not a git push/);
  assert.ok(Date.now() - started < 2000);
});

test("anything else in place of ref updates is refused", () => {
  for (const bad of [
    "GET / HTTP/1.1",
    pkt("hello world\n") + "0000",
    pkt(`push-cert\0report-status\n`) + "0000",
    "0001",
    pkt(`${A} ${B}\n`) + "0000",
  ]) {
    assert.throws(() => readCommands(Buffer.from(bad)), undefined, bad);
  }
});

test("the run's branches may be pushed, never the default one, nor tags or other refs", () => {
  const own = ["issue-34-*"];
  assert.equal(refusal("refs/heads/issue-34-x", "main", own), null);
  assert.equal(refusal("refs/heads/main-ish", "main", ["main-ish"]), null);
  assert.match(refusal("refs/heads/main", "main", ["main"]), /default branch/);
  assert.match(refusal("refs/heads/Main", "main", ["*"]), /default branch/);
  assert.match(refusal("refs/heads/trunk", "trunk", own), /default branch/);
  assert.match(refusal("refs/tags/v1", "main", own), /only branches/);
  assert.match(refusal("refs/notes/x", "main", own), /only branches/);
});

test("a run's branches: its issue's glob or exact names, case-sensitive, nothing by default", () => {
  const own = ["issue-12-*", "feature/x"];
  for (const branch of ["issue-12-x", "issue-12-a/b", "feature/x"]) {
    assert.equal(branchAllowed(own, branch), true, branch);
  }
  for (const branch of [
    "issue-12-",
    "issue-12",
    "issue-123-x",
    "issue-13-x",
    "Issue-12-x",
    "feature/x2",
    "feature",
    "gh-pages",
    "release/1.0",
    "",
    undefined,
  ]) {
    assert.equal(branchAllowed(own, branch), false, String(branch));
  }
  assert.equal(branchAllowed([], "issue-12-x"), false);
  assert.match(
    refusal("refs/heads/issue-13-x", "main", own),
    /can only push issue-12-\*, feature\/x, not issue-13-x/,
  );
  assert.match(refusal("refs/heads/x", "main", []), /no branch to push/);
});

test("a refused push gets a status report git can show, on the side band if asked", () => {
  const reasons = new Map([["refs/heads/main", "no"]]);
  const refs = ["refs/heads/ok", "refs/heads/main"];
  const report =
    pkt("unpack ok\n") +
    pkt("ng refs/heads/ok Deckhand: another ref in this push was refused\n") +
    pkt("ng refs/heads/main Deckhand: no\n") +
    "0000";
  assert.equal(rejection(refs, ["report-status"], reasons).toString(), report);
  assert.equal(
    rejection(refs, ["report-status", "side-band-64k"], reasons).toString(),
    pkt(`\x01${report}`) + "0000",
  );
  assert.equal(rejection(refs, [], reasons), null);
});

// --- Through a real git client -------------------------------------------------------------

// GitHub's side: `git http-backend` (CGI) over the repos in `root`, behind a fetch().
// `received`: the bodies of the pushes it gets. `down`: the services it fails, as GitHub
// would when it can't be reached.
function backendFetch(root, seen, received = [], down = new Set()) {
  return async (url, { method, headers, body }) => {
    const { pathname, search } = new URL(url);
    seen.push({ method, url, authorization: headers.authorization });
    const chunks = [];
    if (body) for await (const chunk of body) chunks.push(chunk);
    if (pathname.endsWith("/git-receive-pack")) received.push(Buffer.concat(chunks));
    const service = /service=([\w-]+)/.exec(search)?.[1] ?? pathname.split("/").pop();
    if (down.has(service)) return new Response("down", { status: 503 });
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "github",
        REQUEST_METHOD: method,
        PATH_INFO: pathname,
        QUERY_STRING: search.slice(1),
        CONTENT_TYPE: headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: headers["content-encoding"] ?? "",
        GIT_PROTOCOL: headers["git-protocol"] ?? "",
      },
    });
    child.stdin.end(Buffer.concat(chunks));
    const out = [];
    for await (const chunk of child.stdout) out.push(chunk);
    const raw = Buffer.concat(out);
    const split = raw.indexOf("\r\n\r\n");
    const head = raw.subarray(0, split).toString();
    const status = Number(/^Status: (\d+)/m.exec(head)?.[1] ?? 200);
    const type = /^Content-Type: (.+)$/im.exec(head)?.[1];
    return new Response(raw.subarray(split + 4), {
      status,
      headers: type ? { "content-type": type } : {},
    });
  };
}

function git(cwd, ...args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: gitEnv }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout, stderr }),
    );
  });
}
const gitEnv = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

// A work run on issue 1 by default.
function issueRun(b, branches = ["issue-1-*"]) {
  const secret = b.register("org/repo", undefined, { push: true });
  b.allow(secret, branches);
  return secret;
}

async function setup(
  t,
  {
    register = issueRun,
    app = true,
    headMs,
    drainMs,
    sentFrom = sandboxAt(),
    allowWorkflows,
    // (extra) => the error minting a token with `extra` fails with, or nothing.
    mintError = () => null,
    maxPush,
  } = {},
) {
  const dir = tempDir(t, "gateway-");
  const root = join(dir, "github");
  const bare = join(root, "org/repo.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  // So a client sends push options, as GitHub lets it.
  execFileSync("git", ["-C", bare, "config", "receive.advertisePushOptions", "true"]);
  const seen = [];
  const received = [];
  const pulls = {};
  const down = new Set();
  // GitHub over HTTP: the gateway forwards pushes there, and fetches its mirrors from it.
  const backend = backendFetch(root, seen, received, down);
  const { url: githubUrl } = await serve(t, async (req, res) => {
    const answer = await backend(`https://github.test${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "POST" ? req : undefined,
    });
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  const minted = [];
  const lookups = [];
  const github = {
    repoToken: async (repo, extra) => {
      minted.push({ repo, extra });
      const error = mintError(extra);
      if (error) throw error;
      return { token: "push-token", expiresAt: Date.now() + 3600000 };
    },
    request: async (repo, method, path) => {
      lookups.push(path);
      // A branch's open pull requests: `pulls`, keyed by branch, the bases they go into.
      const head = /\/pulls\?.*head=([^&]+)/.exec(path);
      if (head) {
        const branch = decodeURIComponent(head[1]).split(":")[1];
        return Response.json((pulls[branch] ?? []).map((ref) => ({ base: { ref } })));
      }
      return Response.json({ default_branch: "main" });
    },
  };
  const broker = createBroker({ app: () => github, sentFrom });
  const secret = register(broker);
  const logs = [];
  const mirrorDir = join(dir, "mirrors");
  const spoolDir = join(dir, "pushes");
  const gateway = createGitGateway({
    broker,
    app: () => (app ? github : null),
    githubUrl,
    log: (line) => logs.push(line),
    allowWorkflows,
    mirrorDir,
    spoolDir,
    maxPush,
    headMs,
    drainMs,
  });
  // What the client sends with each push, as the gateway reads it.
  const sent = [];
  const { port } = await serve(t, (req, res) => {
    const read = req[Symbol.asyncIterator].bind(req);
    const body = [];
    if (req.url.endsWith("/git-receive-pack")) sent.push(body);
    req[Symbol.asyncIterator] = async function* () {
      for await (const chunk of read()) yield (body.push(chunk), chunk);
    };
    return gateway.handle(req, res);
  });
  const remote = (s = secret, repo = "org/repo") =>
    `http://deckhand:${s}@127.0.0.1:${port}/git/${repo}.git`;
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work], { env: gitEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "one"], { cwd: work, env: gitEnv });
  const upstream = (ref) =>
    execFileSync("git", [
      "-C",
      join(root, "org/repo.git"),
      "for-each-ref",
      "--format=%(refname)",
      ref,
    ])
      .toString()
      .trim();
  // Branches someone else pushed straight to GitHub: another issue's, a maintainer's pull
  // request, a published site.
  const seed = (...branches) =>
    execFileSync(
      "git",
      ["push", "-q", join(root, "org/repo.git"), ...branches.map((b) => `HEAD:refs/heads/${b}`)],
      { cwd: work, env: gitEnv },
    );
  const sha = (ref) =>
    execFileSync("git", ["-C", join(root, "org/repo.git"), "rev-parse", "--verify", "-q", ref])
      .toString()
      .trim();
  const commit = (files, message = "change") => {
    for (const [path, content] of Object.entries(files)) {
      const file = join(work, path);
      if (content === null) {
        rmSync(file, { force: true });
      } else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
    }
    execFileSync("git", ["add", "-A"], { cwd: work, env: gitEnv });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", message], {
      cwd: work,
      env: gitEnv,
    });
  };
  return {
    work,
    remote,
    seen,
    minted,
    lookups,
    logs,
    upstream,
    seed,
    sha,
    port,
    commit,
    sent: () => sent.map((body) => Buffer.concat(body)),
    received,
    down,
    mirrorDir,
    spoolDir,
    bare,
    pulls,
    gateway,
  };
}

test("a branch is pushed to GitHub with the gateway's token, not the sandbox's", async (t) => {
  const { work, remote, seen, minted, lookups, upstream } = await setup(t);
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.ok(res.ok, res.stderr);
  assert.equal(upstream("refs/heads/issue-1-x"), "refs/heads/issue-1-x");
  assert.deepEqual(minted[0], { repo: "org/repo", extra: { contents: "write" } });
  assert.deepEqual(lookups, ["/repos/org/repo"]);
  const auth = `Basic ${Buffer.from("x-access-token:push-token").toString("base64")}`;
  assert.ok(seen.every((s) => s.authorization === auth));
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.url}`),
    [
      "GET https://github.test/org/repo.git/info/refs?service=git-receive-pack",
      "POST https://github.test/org/repo.git/git-receive-pack",
    ],
  );
});

test("allow_workflows: the push's token writes workflows, read again on each push", async (t) => {
  let granted = true;
  const asked = [];
  const { work, remote, minted, upstream } = await setup(t, {
    allowWorkflows: (repo) => {
      asked.push(repo);
      return granted;
    },
  });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.ok(res.ok, res.stderr);
  assert.equal(upstream("refs/heads/issue-1-x"), "refs/heads/issue-1-x");
  // git's probe (info/refs) needs no more than contents; the push itself gets workflows, and
  // the mirror its workflow files are checked against is fetched with a token that reads.
  assert.deepEqual(
    minted.map((m) => m.extra),
    [{ contents: "write" }, { contents: "write", workflows: "write" }, { contents: "read" }],
  );
  assert.deepEqual(asked, ["org/repo"]);
  // Taken back: the next push gets contents only.
  granted = false;
  minted.length = 0;
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-1-y")).ok);
  assert.deepEqual(
    minted.map((m) => m.extra),
    [{ contents: "write" }, { contents: "write" }],
  );
});

test("allow_workflows: never for a refused push, nor when the grants can't be read", async (t) => {
  const { work, remote, minted, logs } = await setup(t, {
    allowWorkflows: () => {
      throw new Error("org/repo.yaml: bad");
    },
  });
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x")).ok);
  assert.ok(minted.every((m) => !m.extra.workflows));
  assert.match(logs.join("\n"), /org\/repo\.yaml: bad/);

  // A branch the run can't push (a fork's pull request has none): refused before any token.
  const refused = await setup(t, { allowWorkflows: () => true });
  assert.equal((await git(refused.work, "push", refused.remote(), "HEAD:refs/heads/x")).ok, false);
  assert.ok(refused.minted.every((m) => !m.extra.workflows));
});

test("allow_workflows without the App's permission: refused, naming the grant and the setting", async (t) => {
  const missing = Object.assign(new Error("token for installation 1: 422 not granted"), {
    status: 422,
  });
  const { work, remote, seen, upstream } = await setup(t, {
    allowWorkflows: () => true,
    mintError: (extra) => (extra.workflows ? missing : null),
  });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(res.ok, false);
  assert.match(res.stderr, /\[remote rejected\] .*`allow_workflows` is granted but the App/);
  assert.match(res.stderr, /Workflows: read and write/);
  assert.equal(upstream("refs/"), "");
  // Never pushed without it.
  assert.ok(seen.every((s) => s.method === "GET"));

  // Another failure: refused too, without blaming the App.
  const down = await setup(t, {
    allowWorkflows: () => true,
    mintError: (extra) => (extra.workflows ? new Error("socket hang up") : null),
  });
  const again = await git(down.work, "push", down.remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(again.ok, false);
  assert.match(again.stderr, /couldn't get a token for this push/);
});

test("a run's secret sent from another sandbox's address pushes nothing", async (t) => {
  const { work, remote, seen, minted, upstream } = await setup(t, {
    sentFrom: sandboxAt("10.9.0.5"),
  });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(res.ok, false);
  assert.match(res.stderr, /403|only works from its own sandbox/);
  assert.equal(upstream("refs/"), "");
  assert.deepEqual([seen, minted], [[], []]);
});

test("a push to the default branch is refused, even with --no-verify, and says why", async (t) => {
  const { work, remote, seen, logs, upstream } = await setup(t);
  for (const args of [
    ["push", "--no-verify", remote(), "HEAD:refs/heads/main"],
    // One refused ref refuses the whole push.
    ["push", remote(), "HEAD:refs/heads/ok", "HEAD:refs/heads/main"],
    ["push", remote(), "HEAD:refs/tags/v1"],
  ]) {
    const res = await git(work, ...args);
    assert.equal(res.ok, false, args.join(" "));
    assert.match(res.stderr, /\[remote rejected\] .*\(Deckhand: /);
  }
  assert.equal(upstream("refs/"), "");
  assert.ok(seen.every((s) => s.method === "GET"));
  assert.match(logs.join("\n"), /refused a push to org\/repo: pushing to main/);
});

test("a work run on issue 12 pushes issue-12-…, and nothing else, even forced or deleted", async (t) => {
  const { work, remote, upstream, seed, sha } = await setup(t, {
    register: (b) => issueRun(b, ["issue-12-*"]),
  });
  seed("issue-13-other", "feature/maintainer", "gh-pages");
  const before = ["issue-13-other", "feature/maintainer", "gh-pages"].map((b) =>
    sha(`refs/heads/${b}`),
  );
  // A commit unrelated to theirs: pushing it there would need --force.
  execFileSync("git", ["commit", "-q", "--amend", "--allow-empty", "-m", "rewritten"], {
    cwd: work,
    env: gitEnv,
  });
  for (const args of [
    ["HEAD:refs/heads/issue-13-x"],
    ["--force", "HEAD:refs/heads/issue-13-other"],
    ["--force", "HEAD:refs/heads/feature/maintainer"],
    [":refs/heads/feature/maintainer"],
    [":refs/heads/gh-pages"],
    ["HEAD:refs/heads/release/1.0"],
    ["HEAD:refs/heads/issue-123-x"],
    // One of its own with another: the whole push is refused.
    ["HEAD:refs/heads/issue-12-x", "HEAD:refs/heads/issue-13-x"],
  ]) {
    const res = await git(work, "push", remote(), ...args);
    assert.equal(res.ok, false, args.join(" "));
    assert.match(
      res.stderr,
      /\[remote rejected\] .*\(Deckhand: this run can only push issue-12-\*/,
    );
  }
  assert.deepEqual(
    ["issue-13-other", "feature/maintainer", "gh-pages"].map((b) => sha(`refs/heads/${b}`)),
    before,
  );
  assert.equal(upstream("refs/heads/issue-1*"), "refs/heads/issue-13-other");
  assert.equal(upstream("refs/heads/release"), "");

  // Its own branch: pushed, force-pushed, deleted.
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-12-x")).ok);
  execFileSync("git", ["commit", "-q", "--amend", "--allow-empty", "-m", "again"], {
    cwd: work,
    env: gitEnv,
  });
  const forced = await git(work, "push", "--force", remote(), "HEAD:refs/heads/issue-12-x");
  assert.ok(forced.ok, forced.stderr);
  assert.ok((await git(work, "push", remote(), ":refs/heads/issue-12-x")).ok);
  assert.equal(upstream("refs/heads/issue-12-x"), "");
});

test("a pull request's run pushes its head branch only", async (t) => {
  const { work, remote, seed, sha } = await setup(t, {
    register: (b) => issueRun(b, ["feature/maintainer"]),
  });
  seed("feature/maintainer", "feature/other", "issue-1-x");
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "review fix"], {
    cwd: work,
    env: gitEnv,
  });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/feature/maintainer");
  assert.ok(res.ok, res.stderr);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim();
  assert.equal(sha("refs/heads/feature/maintainer"), head);
  for (const ref of ["feature/other", "issue-1-x", "feature/maintainer2"]) {
    const refused = await git(work, "push", remote(), `HEAD:refs/heads/${ref}`);
    assert.equal(refused.ok, false, ref);
    assert.match(refused.stderr, /can only push feature\/maintainer, not /);
  }
});

test("a run with no branch can't push any", async (t) => {
  const { work, remote, seen } = await setup(t, { register: (b) => issueRun(b, []) });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(res.ok, false);
  assert.match(res.stderr, /no branch to push/);
  assert.ok(seen.every((s) => s.method === "GET"));
});

test("deleting the default branch is refused too", async (t) => {
  const { work, remote, upstream } = await setup(t);
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-1-topic")).ok);
  const res = await git(work, "push", remote(), ":refs/heads/main");
  assert.equal(res.ok, false);
  assert.equal(upstream("refs/heads/issue-1-topic"), "refs/heads/issue-1-topic");
});

test("no secret, another run's repo or a finished run: no push", async (t) => {
  const { work, remote, seen, port } = await setup(t);
  const bare = `http://127.0.0.1:${port}/git/org/repo.git`;
  for (const url of [bare, remote("guess"), remote(undefined, "org/other")]) {
    const res = await git(work, "push", url, "HEAD:refs/heads/x");
    assert.equal(res.ok, false, url);
  }
  assert.deepEqual(seen, []);
});

// Light runs: brainstorms and inbox entries keep a token that writes issues, onboarding and
// a repo's light modes one that only reads. Neither decides: the kind of run does.
for (const [what, extra] of [
  ["a brainstorm", { pull_requests: "read" }],
  ["a light repo mode", { contents: "read", issues: "read", pull_requests: "read" }],
  ["a run registered without saying", undefined],
]) {
  test(`${what} can't push`, async (t) => {
    const { work, remote, seen } = await setup(t, {
      register: (b) => b.register("org/repo", extra),
    });
    const res = await git(work, "push", remote(), "HEAD:refs/heads/x");
    assert.equal(res.ok, false);
    assert.match(res.stderr, /this run can't push/);
    assert.deepEqual(seen, []);
  });
}

test("a light run can't push even with a token that writes pull requests", async (t) => {
  const { work, remote, seen } = await setup(t, {
    register: (b) => b.register("org/repo", { pull_requests: "write" }, { push: false }),
  });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/x");
  assert.equal(res.ok, false);
  assert.match(res.stderr, /this run can't push/);
  assert.deepEqual(seen, []);
});

test("a research run can't push: it has no token, and no push right", async (t) => {
  const { work, remote, seen } = await setup(t, {
    register: (b) => b.register("org/repo", NO_TOKEN, { push: false }),
  });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-12-x");
  assert.equal(res.ok, false);
  assert.match(res.stderr, /this run can't push/);
  assert.deepEqual(seen, []);
});

test("fetches don't go through the gateway", async (t) => {
  const { remote, port, seen } = await setup(t);
  const res = await fetch(
    `http://127.0.0.1:${port}/git/org/repo.git/info/refs?service=git-upload-pack`,
    {
      headers: {
        authorization: `Basic ${Buffer.from(new URL(remote()).username + ":" + new URL(remote()).password).toString("base64")}`,
      },
    },
  );
  assert.equal(res.status, 403);
  assert.deepEqual(seen, []);
});

test("without the default branch, or with a compressed body, nothing is forwarded", async (t) => {
  const { remote, port, seen } = await setup(t);
  const auth = `Basic ${Buffer.from(`deckhand:${new URL(remote()).password}`).toString("base64")}`;
  const url = `http://127.0.0.1:${port}/git/org/repo.git/git-receive-pack`;
  const gz = await fetch(url, {
    method: "POST",
    headers: { authorization: auth, "content-encoding": "gzip" },
    body: "x",
  });
  assert.equal(gz.status, 415);
  const garbage = await fetch(url, {
    method: "POST",
    headers: { authorization: auth },
    body: "nope",
  });
  assert.equal(garbage.status, 400);
  assert.deepEqual(seen, []);
});

// A push whose body starts with `head` and never ends: resolves once the gateway drops it,
// with its answer's status if it sent one.
function stalled(port, secret, head) {
  return new Promise((resolve) => {
    const auth = `Basic ${Buffer.from(`deckhand:${secret}`).toString("base64")}`;
    const req = request({
      port,
      method: "POST",
      path: "/git/org/repo.git/git-receive-pack",
      headers: { authorization: auth, "transfer-encoding": "chunked" },
    });
    let status = null;
    req.on("response", (res) => {
      status = res.statusCode;
      res.resume();
      res.on("close", () => resolve(status));
    });
    req.on("error", () => resolve(status));
    req.on("close", () => resolve(status));
    req.write(head);
  });
}

test("a push whose ref updates or refused pack come too slowly is dropped", async (t) => {
  const { remote, port, seen } = await setup(t, { headMs: 100, drainMs: 100 });
  const secret = new URL(remote()).password;
  // Half a pkt-line, then nothing.
  await stalled(port, secret, "00a0" + A);
  // A refused push whose pack never ends: dropped, never forwarded.
  await stalled(port, secret, pkt(`${ZERO} ${B} refs/heads/main\0report-status\n`) + "0000PACK");
  assert.deepEqual(seen, []);
});

test("before the App is set up, no push", async (t) => {
  const { work, remote, seen } = await setup(t, { app: false });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/x");
  assert.equal(res.ok, false);
  assert.deepEqual(seen, []);
});

test("a push bigger than git's post buffer is streamed through, after git's probe", async (t) => {
  const { work, remote, upstream } = await setup(t);
  writeFileSync(join(work, "big"), randomBytes(256 * 1024));
  execFileSync("git", ["add", "big"], { cwd: work, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "big"], { cwd: work, env: gitEnv });
  const res = await git(
    work,
    "-c",
    "http.postBuffer=1024",
    "push",
    remote(),
    "HEAD:refs/heads/issue-1-big",
  );
  assert.ok(res.ok, res.stderr);
  assert.equal(upstream("refs/heads/issue-1-big"), "refs/heads/issue-1-big");
});

// --- allow_workflows: the pushed workflow files are checked --------------------------------

const SAFE = `name: CI
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

// A grant of allow_workflows, its upstream's default branch holding `files`.
async function granted(t, files = {}) {
  const gateway = await setup(t, { allowWorkflows: () => true });
  if (Object.keys(files).length) {
    gateway.commit(files, "default branch");
    gateway.seed("main");
  }
  return gateway;
}

test("allow_workflows: a workflow that only reads goes through, the same pack GitHub gets", async (t) => {
  const { work, remote, commit, upstream, sent, received, mirrorDir, spoolDir } = await granted(t);
  commit({ ".github/workflows/ci.yml": SAFE });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-ci");
  assert.ok(res.ok, res.stderr);
  assert.equal(upstream("refs/heads/issue-1-ci"), "refs/heads/issue-1-ci");
  assert.equal(received.length, 1);
  assert.ok(received[0].equals(sent()[0]));
  // The pushed objects stay out of the mirror, and the push's file goes.
  assert.ok(existsSync(join(mirrorDir, "org/repo.git")));
  // Removed once the answer is sent: soon after the client has it.
  const pushes = () => readdirSync(spoolDir);
  for (let n = 0; pushes().length && n < 50; n++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(pushes(), []);
});

test("allow_workflows: a workflow that writes, names a secret or hides from the parser is refused", async (t) => {
  const { work, remote, commit, upstream, received } = await granted(t);
  for (const [content, why] of [
    [SAFE.replace("permissions:\n  contents: read\n", ""), /ci\.yml: no top-level `permissions:`/],
    [
      SAFE.replace("contents: read", "contents: write"),
      /`permissions\.contents` must be read or none/,
    ],
    [
      SAFE.replace("contents: read", "Contents: WRITE"),
      /`permissions\.Contents` must be read or none/,
    ],
    [
      SAFE.replace("permissions:\n  contents: read", "permissions: write-all"),
      /`permissions: write-all` is not allowed/,
    ],
    [
      SAFE.replace("    runs-on:", "    permissions: { id-token: write }\n    runs-on:"),
      /`jobs\.test\.permissions\.id-token` must be read or none/,
    ],
    [`${SAFE}      - run: echo "\${{ secrets.TOKEN }}"\n`, /mentions `secrets` \(line 11\)/],
    [`${SAFE}      - run: "echo \${{ \\x73ecrets.TOKEN }}"\n`, /mentions `secrets`/],
    [SAFE.replace("name: CI", "name: &n CI"), /line 1: unsupported YAML/],
    [`${SAFE}---\nname: again\n`, /line 11: several documents/],
  ]) {
    commit({ ".github/workflows/ci.yml": content });
    const res = await git(work, "push", "--force", remote(), "HEAD:refs/heads/issue-1-ci");
    assert.equal(res.ok, false, content);
    assert.match(res.stderr, /\[remote rejected\] HEAD -> issue-1-ci \(Deckhand: workflow files/);
    assert.match(res.stderr, /\.github\/workflows\/ci\.yml: /);
    assert.match(res.stderr, why);
    // Refused at the tip: said once, not again for its merge with main.
    assert.doesNotMatch(res.stderr, /merged with main/);
  }
  assert.equal(upstream("refs/"), "");
  assert.deepEqual(received, []);
});

test("allow_workflows: a thin pack, its deltas against GitHub's objects, is read", async (t) => {
  // A workflow already on GitHub, big enough for git to send a change to it as a delta.
  const steps = Array.from({ length: 200 }, (_, n) => `      - run: echo step ${n}\n`).join("");
  const { work, remote, commit, upstream, received, sent } = await granted(t, {
    ".github/workflows/ci.yml": SAFE + steps,
  });
  commit({ ".github/workflows/ci.yml": `${SAFE}${steps}      - run: echo \${{ secrets.X }}\n` });
  const refused = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-thin");
  assert.equal(refused.ok, false);
  assert.match(refused.stderr, /mentions `secrets` \(line 211\)/);
  // The pack had the change as a delta only: a blob the push doesn't carry whole.
  assert.ok(sent()[0].length < 1000, `${sent()[0].length} bytes`);

  commit({ ".github/workflows/ci.yml": `${SAFE}${steps}      - run: echo done\n` });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-thin");
  assert.ok(res.ok, res.stderr);
  assert.equal(upstream("refs/heads/issue-1-thin"), "refs/heads/issue-1-thin");
  assert.equal(received.length, 1);
});

test("allow_workflows: what the default branch already has, other files and deletions pass", async (t) => {
  // The maintainers' own workflow, which the run couldn't push.
  const theirs = `on: push\njobs:\n  deploy:\n    steps:\n      - run: echo \${{ secrets.DEPLOY }}\n`;
  const { work, remote, commit, upstream } = await granted(t, {
    ".github/workflows/deploy.yml": theirs,
    ".github/workflows/old.yml": theirs,
  });
  commit({ "src/app.js": "1\n", ".github/workflows/README.md": "not YAML: {{" });
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-1-a")).ok);
  commit({ ".github/workflows/old.yml": null });
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-1-a")).ok);
  assert.ok((await git(work, "push", remote(), ":refs/heads/issue-1-a")).ok);
  assert.equal(upstream("refs/heads/issue-1-a"), "");
  // Changed, the same file is checked like any other.
  commit({ ".github/workflows/deploy.yml": `${theirs}# tweaked\n` });
  const changed = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-b");
  assert.equal(changed.ok, false);
  assert.match(changed.stderr, /deploy\.yml: no top-level `permissions:`.*mentions `secrets`/);
});

test("allow_workflows: each branch of a push is checked; symlinks are refused", async (t) => {
  const { work, remote, commit } = await granted(t);
  commit({ ".github/workflows/ci.yml": SAFE }, "safe");
  const safe = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim();
  symlinkSync("../../secret.yml", join(work, ".github/workflows/link.yml"));
  commit({}, "symlink");
  const res = await git(
    work,
    "push",
    remote(),
    `${safe}:refs/heads/issue-1-safe`,
    "HEAD:refs/heads/issue-1-link",
  );
  assert.equal(res.ok, false);
  assert.match(res.stderr, /issue-1-safe \(Deckhand: another ref in this push was refused\)/);
  assert.match(res.stderr, /issue-1-link .*link\.yml: not a plain UTF-8 file/);
});

test("allow_workflows: with push options, the pack after them is read", async (t) => {
  const { work, remote, commit, upstream } = await granted(t);
  commit({ ".github/workflows/ci.yml": SAFE.replace("read", "write") });
  const refused = await git(work, "push", "-o", "ci.skip", remote(), "HEAD:refs/heads/issue-1-o");
  assert.equal(refused.ok, false);
  assert.match(refused.stderr, /must be read or none/);
  commit({ ".github/workflows/ci.yml": SAFE });
  const res = await git(work, "push", "-o", "ci.skip", remote(), "HEAD:refs/heads/issue-1-o");
  assert.ok(res.ok, res.stderr);
  assert.equal(upstream("refs/heads/issue-1-o"), "refs/heads/issue-1-o");
});

test("allow_workflows: without a mirror to check against, nothing is forwarded", async (t) => {
  const { work, remote, commit, down, received, logs } = await granted(t);
  down.add("git-upload-pack");
  commit({ ".github/workflows/ci.yml": SAFE });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(res.ok, false);
  assert.match(res.stderr, /couldn't check the workflow files of this push; try again/);
  assert.deepEqual(received, []);
  assert.match(logs.join("\n"), /git fetch: /);
  // Back: the same push goes through.
  down.clear();
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x")).ok);
});

test("without allow_workflows, pushes stream through: no mirror, nothing kept", async (t) => {
  const { work, remote, commit, mirrorDir, spoolDir, received, sent } = await setup(t);
  commit({ "a.txt": "a\n" });
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x")).ok);
  assert.equal(existsSync(mirrorDir), false);
  assert.equal(existsSync(spoolDir), false);
  assert.ok(received[0].equals(sent()[0]));
});

test("allow_workflows: the merge GitHub runs a pull request from is checked too", async (t) => {
  const { work, remote, commit, seed, received } = await granted(t, {
    ".github/workflows/ci.yml": SAFE,
  });
  const old = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim();
  // The default branch gives the job a secret after the branch was cut.
  const withSecret = SAFE.replace(
    "    steps:",
    '    env: { TOKEN: "${{ secrets.X }}" }\n    steps:',
  );
  commit({ ".github/workflows/ci.yml": withSecret }, "a secret on main");
  seed("main");
  // The run edits a step of the old version: alone it passes, merged it has the secret too.
  execFileSync("git", ["checkout", "-q", "-b", "topic", old], { cwd: work, env: gitEnv });
  commit({ ".github/workflows/ci.yml": SAFE.replace("npm test", "npm test -- --ci") });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-old");
  assert.equal(res.ok, false);
  assert.match(res.stderr, /ci\.yml \(merged with main\): mentions `secrets` \(line 8\)/);

  // An edit that conflicts with the default branch's: refused until rebased.
  commit({
    ".github/workflows/ci.yml": SAFE.replace("    steps:", "    timeout-minutes: 5\n    steps:"),
  });
  const conflict = await git(work, "push", "--force", remote(), "HEAD:refs/heads/issue-1-old");
  assert.equal(conflict.ok, false);
  assert.match(
    conflict.stderr,
    /ci\.yml \(merged with main\): conflicts with main: rebase the branch on it/,
  );

  // A branch of the default one that leaves the file alone: its merge is the default branch's
  // own workflow, which goes through.
  execFileSync("git", ["checkout", "-q", "main"], { cwd: work, env: gitEnv });
  commit({ "src/a.js": "1\n" });
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-1-new")).ok);
  assert.equal(received.length, 1);
});

test("allow_workflows: a .github/workflows that is a symlink is refused", async (t) => {
  const { work, remote, commit } = await granted(t);
  mkdirSync(join(work, ".github"), { recursive: true });
  mkdirSync(join(work, "ci"));
  writeFileSync(join(work, "ci/ci.yml"), SAFE.replace("read", "write"));
  symlinkSync("../ci", join(work, ".github/workflows"));
  commit({});
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(res.ok, false);
  assert.match(res.stderr, /\.github\/workflows: not a plain UTF-8 file/);
});

test("allow_workflows: one push of a run's at a time; one too large is refused", async (t) => {
  const { work, remote, port, commit, received, spoolDir } = await granted(t);
  // A push whose pack never ends: saved, waiting for the rest.
  const secret = new URL(remote()).password;
  const first = request({
    port,
    method: "POST",
    path: "/git/org/repo.git/git-receive-pack",
    headers: {
      authorization: `Basic ${Buffer.from(`deckhand:${secret}`).toString("base64")}`,
      "transfer-encoding": "chunked",
    },
  });
  first.on("error", () => {});
  first.write(pkt(`${ZERO} ${B} refs/heads/issue-1-slow\0report-status\n`) + "0000PACK");
  for (let n = 0; !(existsSync(spoolDir) && readdirSync(spoolDir).length) && n < 100; n++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  commit({ "a.txt": "a\n" });
  const second = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(second.ok, false);
  assert.match(second.stderr, /another push of this run is being checked; try again/);
  first.destroy();
  for (let n = 0; readdirSync(spoolDir).length && n < 100; n++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(readdirSync(spoolDir), []);
  // Over the cap: refused, nothing kept, nothing forwarded.
  const small = await setup(t, { allowWorkflows: () => true, maxPush: 2048 });
  writeFileSync(join(small.work, "big"), randomBytes(64 * 1024));
  small.commit({});
  const big = await git(small.work, "push", small.remote(), "HEAD:refs/heads/issue-1-big");
  assert.equal(big.ok, false);
  assert.match(big.stderr, /413|too large/);
  assert.deepEqual(readdirSync(small.spoolDir), []);
  assert.deepEqual([received, small.received], [[], []]);
});

test("allow_workflows: the workflows a changed one calls are checked too, changed or not", async (t) => {
  // The maintainers' deploy workflow: its environment's secrets, for whoever calls it.
  const deploy = `on: workflow_call
permissions: { contents: read }
jobs:
  deploy:
    environment: production
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh "\${{ secrets.DEPLOY_KEY }}"
`;
  const { work, remote, commit, upstream } = await granted(t, {
    ".github/workflows/deploy.yml": deploy,
  });
  const caller = (uses) => `on: push
permissions: { contents: read }
jobs:
  go:
    uses: ${uses}
`;
  commit({ ".github/workflows/go.yml": caller("./.github/workflows/deploy.yml") });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(res.ok, false);
  assert.match(
    res.stderr,
    /deploy\.yml \(called by \.github\/workflows\/go\.yml\): `jobs\.deploy\.environment`: deploying to an environment is not allowed, mentions `secrets`/,
  );
  commit({ ".github/workflows/go.yml": caller("./.github/workflows/gone.yml") });
  const gone = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.match(gone.stderr, /go\.yml: calls \.github\/workflows\/gone\.yml, which isn't there/);
  // One that passes, calling one that passes: through.
  commit({
    ".github/workflows/go.yml": caller("./.github/workflows/ci.yml"),
    ".github/workflows/ci.yml": SAFE.replace("on: [push, pull_request]", "on: workflow_call"),
  });
  const ok = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.ok(ok.ok, ok.stderr);
  assert.equal(upstream("refs/heads/issue-1-x"), "refs/heads/issue-1-x");
});

test("allow_workflows: merges with the bases of the branch's pull requests, and before one opens", async (t) => {
  const { work, remote, commit, seed, pulls, gateway } = await granted(t, {
    ".github/workflows/ci.yml": SAFE,
  });
  // A release branch whose ci.yml has since given the job a secret.
  const withSecret = SAFE.replace(
    "    steps:",
    '    env: { TOKEN: "\${{ secrets.X }}" }\n    steps:',
  );
  execFileSync("git", ["checkout", "-q", "-b", "release"], { cwd: work, env: gitEnv });
  commit({ ".github/workflows/ci.yml": withSecret }, "release");
  seed("release");
  execFileSync("git", ["checkout", "-q", "main"], { cwd: work, env: gitEnv });
  commit({ ".github/workflows/ci.yml": SAFE.replace("npm test", "npm test -- --ci") });
  // Merged with main: fine. Its pull request into release: refused.
  pulls["issue-1-x"] = ["release"];
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(res.ok, false);
  assert.match(res.stderr, /ci\.yml \(merged with release\): mentions `secrets`/);
  delete pulls["issue-1-x"];
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x")).ok);
  // Before a pull request into release opens (pr-ready.mjs), the same check.
  assert.match(
    await gateway.checkBranch("org/repo", "issue-1-x", "release"),
    /ci\.yml \(merged with release\): mentions `secrets`/,
  );
  assert.equal(await gateway.checkBranch("org/repo", "issue-1-x", "main"), null);
});

test("allow_workflows: a caller the branch adds meets the default branch's newer callee in the merge", async (t) => {
  const helper = `on: workflow_call\npermissions: { contents: read }\njobs:\n  h:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
  const { work, remote, commit, seed, gateway } = await granted(t, {
    ".github/workflows/helper.yml": helper,
  });
  const old = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim();
  // Since then, main's helper deploys with a secret.
  commit(
    {
      ".github/workflows/helper.yml": helper.replace("echo hi", 'echo "${{ secrets.DEPLOY }}"'),
    },
    "helper deploys",
  );
  seed("main");
  // The run's branch, cut from the old main, only adds a caller.
  execFileSync("git", ["checkout", "-q", "-b", "topic", old], { cwd: work, env: gitEnv });
  const caller = `on: pull_request\npermissions: { contents: read }\njobs:\n  call:\n    uses: ./.github/workflows/helper.yml\n`;
  commit({ ".github/workflows/ci.yml": caller });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/issue-1-x");
  assert.equal(res.ok, false);
  assert.match(
    res.stderr,
    /helper\.yml \(called by \.github\/workflows\/ci\.yml\) \(merged with main\): mentions `secrets`/,
  );
  // The tip alone passes: its own helper is the old one. Reported once, for the merge only.
  assert.equal(res.stderr.match(/called by/g).length, 1);
  // The same before a pull request opens, for a branch pushed some other way.
  seed("issue-1-x");
  assert.match(
    await gateway.checkBranch("org/repo", "issue-1-x", "main"),
    /helper\.yml \(called by \.github\/workflows\/ci\.yml\) \(merged with main\)/,
  );
  // A branch that isn't on GitHub runs nothing: no problem, GitHub refuses the pull request.
  assert.equal(await gateway.checkBranch("org/repo", "issue-1-gone", "main"), null);
});

test("saved pushes a stopped listener left are swept, never a check's in progress", async (t) => {
  const dir = tempDir(t, "sweep-");
  const spoolDir = join(dir, "pushes");
  mkdirSync(join(spoolDir, "push-old"), { recursive: true });
  mkdirSync(join(spoolDir, "push-new"));
  const old = new Date(Date.now() - 3 * 3600_000);
  utimesSync(join(spoolDir, "push-old"), old, old);
  const broker = createBroker({ app: () => null, sentFrom: sandboxAt() });
  const gateway = createGitGateway({ broker, app: () => null, mirrorDir: dir, spoolDir });
  // The sweep runs before any check: a branch check of an ungranted repo is a no-op that
  // doesn't wait for it, so wait for it here.
  assert.equal(await gateway.checkBranch("org/repo", "x", "main"), null);
  for (let n = 0; existsSync(join(spoolDir, "push-old")) && n < 50; n++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(readdirSync(spoolDir), ["push-new"]);
});
