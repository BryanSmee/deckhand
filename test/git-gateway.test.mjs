// The git gateway: a sandbox's only way to push. The real git client pushes through it to a
// local `git http-backend` that plays GitHub.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function backendFetch(root, seen) {
  return async (url, { method, headers, body }) => {
    const { pathname, search } = new URL(url);
    seen.push({ method, url, authorization: headers.authorization });
    const chunks = [];
    if (body) for await (const chunk of body) chunks.push(chunk);
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
  { register = issueRun, app = true, headMs, drainMs, sentFrom = sandboxAt() } = {},
) {
  const dir = tempDir(t, "gateway-");
  const root = join(dir, "github");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(root, "org/repo.git")]);
  const seen = [];
  const minted = [];
  const lookups = [];
  const github = {
    repoToken: async (repo, extra) => {
      minted.push({ repo, extra });
      return { token: "push-token", expiresAt: Date.now() + 3600000 };
    },
    request: async (repo, method, path) => {
      lookups.push(path);
      return Response.json({ default_branch: "main" });
    },
  };
  const broker = createBroker({ app: () => github, sentFrom });
  const secret = register(broker);
  const logs = [];
  const gateway = createGitGateway({
    broker,
    app: () => (app ? github : null),
    githubUrl: "https://github.test",
    fetch: backendFetch(root, seen),
    log: (line) => logs.push(line),
    headMs,
    drainMs,
  });
  const { port } = await serve(t, (req, res) => gateway.handle(req, res));
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
  return { work, remote, seen, minted, lookups, logs, upstream, seed, sha, port };
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
