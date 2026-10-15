// The git gateway: a sandbox's only way to push. The real git client pushes through it to a
// local `git http-backend` that plays GitHub.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { createGitGateway, readCommands, refusal, rejection } from "../listener/git-gateway.mjs";

const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

function pkt(line) {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}

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

test("branches may be pushed, never the default one, nor tags or other refs", () => {
  assert.equal(refusal("refs/heads/issue-34-x", "main"), null);
  assert.equal(refusal("refs/heads/main-ish", "main"), null);
  assert.match(refusal("refs/heads/main", "main"), /default branch/);
  assert.match(refusal("refs/heads/Main", "main"), /default branch/);
  assert.match(refusal("refs/heads/trunk", "trunk"), /default branch/);
  assert.match(refusal("refs/tags/v1", "main"), /only branches/);
  assert.match(refusal("refs/notes/x", "main"), /only branches/);
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

async function setup(t, { register = (b) => b.register("org/repo"), app = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gateway-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  const broker = createBroker({ app: () => github });
  const secret = register(broker);
  const logs = [];
  const gateway = createGitGateway({
    broker,
    app: () => (app ? github : null),
    githubUrl: "https://github.test",
    fetch: backendFetch(root, seen),
    log: (line) => logs.push(line),
  });
  const server = createServer((req, res) => gateway.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
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
  return { work, remote, seen, minted, lookups, logs, upstream, port };
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

test("deleting the default branch is refused too", async (t) => {
  const { work, remote, upstream } = await setup(t);
  // As if a maintainer had pushed it.
  assert.ok((await git(work, "push", remote(), "HEAD:refs/heads/topic")).ok);
  const res = await git(work, "push", remote(), ":refs/heads/main");
  assert.equal(res.ok, false);
  assert.equal(upstream("refs/heads/topic"), "refs/heads/topic");
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

test("a run whose token only reads can't push", async (t) => {
  const { work, remote, seen } = await setup(t, {
    register: (b) =>
      b.register("org/repo", { contents: "read", issues: "read", pull_requests: "read" }),
  });
  const res = await git(work, "push", remote(), "HEAD:refs/heads/x");
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
    "HEAD:refs/heads/big",
  );
  assert.ok(res.ok, res.stderr);
  assert.equal(upstream("refs/heads/big"), "refs/heads/big");
});
