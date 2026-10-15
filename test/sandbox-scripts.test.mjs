// The sandbox's side of the broker: git's credential helper asks it for a token per call.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { createPrReady } from "../listener/pr-ready.mjs";

const bin = new URL("../sandbox/", import.meta.url).pathname;

async function broker() {
  let n = 0;
  const b = createBroker({
    app: () => ({
      repoToken: async () => ({
        token: `fresh-${++n}`,
        expiresAt: Date.now() + 1,
      }),
    }),
  });
  const server = createServer((req, res) => b.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    b,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

// Async: the broker answers from this same process.
function helper(env, input) {
  return new Promise((resolve) => {
    const child = execFile(
      `${bin}git-credential-deckhand`,
      ["get"],
      { env: { PATH: `${bin}:${process.env.PATH}`, ...env }, timeout: 10000 },
      (error, stdout) => resolve({ status: error ? (error.code ?? 1) : 0, stdout }),
    );
    child.stdin.end(input);
  });
}

test("git gets a fresh token for the repo's host on each call", async (t) => {
  const { b, url, close } = await broker();
  t.after(close);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: b.register("org/repo", undefined, { push: true }),
    REPO_URL: "https://github.com/org/repo.git",
  };
  const ask = "protocol=https\nhost=github.com\n\n";
  assert.equal((await helper(env, ask)).stdout, "username=x-access-token\npassword=fresh-1\n");
  assert.equal((await helper(env, ask)).stdout, "username=x-access-token\npassword=fresh-2\n");
  // Another host never sees the token.
  assert.equal((await helper(env, "protocol=https\nhost=evil.example\n\n")).stdout, "");
});

test("a finished run's helper answers nothing, so git fails instead of using a stale token", async (t) => {
  const { b, url, close } = await broker();
  t.after(close);
  const secret = b.register("org/repo", undefined, { push: true });
  b.revoke(secret);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: secret,
    REPO_URL: "https://github.com/o/r",
  };
  const res = await helper(env, "protocol=https\nhost=github.com\n\n");
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
});

// The Claude Code volume is read-only in a sandbox: a missing version is the listener's to
// install, and the entrypoint says so instead of trying.
test("a sandbox without its Claude Code version stops with a clear message", () => {
  const result = spawnSync(`${bin}entrypoint.sh`, [], {
    env: {
      PATH: process.env.PATH,
      REPO_URL: "https://github.com/org/repo.git",
      CLAUDE_CODE_VERSION: "0.0.0-missing",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Claude Code 0\.0\.0-missing is not installed in \/opt\/claude-code/);
});

// The work feedback prompt can't run here (it needs Claude Code): its text, as bash has it.
test("work feedback rebases on the base and force-pushes with a lease before gh pr ready", () => {
  const script = readFileSync(`${bin}entrypoint.sh`, "utf8");
  const feedback = /prompt="New feedback on this issue: [^]*?"\n/.exec(script)[0];
  assert.match(feedback, /Before marking it ready[^]*\\`git rebase origin\/\$BASE_BRANCH\\`/);
  assert.match(feedback, /run the checks again, then\s+\\`git push --force-with-lease\\`/);
  assert.match(feedback, /can't be resolved safely[^]*stop\s+and ask/);
});

test(
  "installing Claude Code refuses to run as the sandbox's user",
  { skip: process.getuid() === 0 },
  () => {
    const result = spawnSync(`${bin}install-claude-code`, [], {
      env: { PATH: process.env.PATH, CLAUDE_CODE_VERSION: "9.9.9" },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run it as root/);
  },
);

test("for the broker's host, git gets the run's secret: what the git gateway takes", async (t) => {
  const { b, url, close } = await broker();
  t.after(close);
  const secret = b.register("org/repo", undefined, { push: true });
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: secret,
    REPO_URL: "https://github.com/org/repo.git",
  };
  const host = new URL(url).host;
  const res = await helper(env, `protocol=http\nhost=${host}\n\n`);
  assert.equal(res.stdout, `username=deckhand\npassword=${secret}\n`);
});

// --- gh pr ready, through the listener ---------------------------------------------------------

// A broker that also marks pull requests ready (pr-ready.mjs): `mutations` are its calls to
// GitHub. Pull request 7 of org/repo is a draft, 8 is ready.
async function prBroker() {
  const mutations = [];
  const github = {
    repoToken: async () => ({ token: "token", expiresAt: Date.now() + 3600000 }),
    request: async (repo, method, path) => {
      const number = Number(path.split("/").pop());
      return Response.json({
        draft: number === 7,
        node_id: `PR_${number}`,
        base: { repo: { full_name: repo } },
        head: { repo: { full_name: repo } },
      });
    },
  };
  const b = createBroker({ app: () => github });
  const prReady = createPrReady({
    broker: b,
    app: () => github,
    fetch: async (url, { body }) => {
      const { query, variables } = JSON.parse(body);
      mutations.push(`${/\{ (\w+)\(/.exec(query)[1]} ${variables.id}`);
      return Response.json({ data: {} });
    },
  });
  const server = createServer((req, res) =>
    (req.url.startsWith("/pr/") ? prReady : b).handle(req, res),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    b,
    mutations,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

// The real gh, played by a script: logs its arguments and token, and finds pull request 7 for
// the current branch, or the number it was given.
function fakeGh(t) {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls");
  const path = join(dir, "gh");
  writeFileSync(
    path,
    `#!/bin/bash
echo "$GH_TOKEN $*" >> ${JSON.stringify(log)}
if [ "$1 $2" = "pr view" ]; then
  n=7
  case \${3:-} in [0-9]*) n=$3 ;; esac
  echo "https://github.com/org/repo/pull/$n"
fi
`,
  );
  chmodSync(path, 0o755);
  return { path, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

function gh(env, ...args) {
  return new Promise((resolve) => {
    execFile(
      `${bin}gh`,
      args,
      { env: { PATH: `${bin}:${process.env.PATH}`, ...env }, timeout: 10000 },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test("gh pr ready goes to the listener, with or without a number, and --undo too", async (t) => {
  const { b, mutations, url, close } = await prBroker();
  t.after(close);
  const real = fakeGh(t);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: b.register("org/repo", undefined, { push: true }),
    DECKHAND_REAL_GH: real.path,
  };
  const current = await gh(env, "pr", "ready");
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /org\/repo#7 is marked as ready for review/);
  assert.equal((await gh(env, "pr", "ready", "8", "--undo")).status, 0);
  assert.equal((await gh(env, "pr", "ready", "--undo", "-R", "org/repo", "8")).status, 0);
  assert.deepEqual(mutations, [
    "markPullRequestReadyForReview PR_7",
    "convertPullRequestToDraft PR_8",
    "convertPullRequestToDraft PR_8",
  ]);
  // The real gh only looked the pull requests up, with a fresh token.
  assert.deepEqual(real.calls(), [
    "token pr view --json url --jq .url",
    "token pr view 8 --json url --jq .url",
    "token pr view 8 --repo org/repo --json url --jq .url",
  ]);
});

test("a refused gh pr ready fails with the listener's reason", async (t) => {
  const { b, mutations, url, close } = await prBroker();
  t.after(close);
  const real = fakeGh(t);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: b.register("org/repo", { pull_requests: "read" }, { push: false }),
    DECKHAND_REAL_GH: real.path,
  };
  const res = await gh(env, "pr", "ready", "7");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /this run can't change pull requests/);
  assert.deepEqual(mutations, []);
});

test("other gh commands go to the real gh, with a fresh token", async (t) => {
  const { b, mutations, url, close } = await prBroker();
  t.after(close);
  const real = fakeGh(t);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: b.register("org/repo", undefined, { push: true }),
    DECKHAND_REAL_GH: real.path,
  };
  assert.equal((await gh(env, "pr", "edit", "7", "--title", "x")).status, 0);
  assert.equal((await gh(env, "issue", "view", "3")).status, 0);
  assert.deepEqual(real.calls(), ["token pr edit 7 --title x", "token issue view 3"]);
  assert.deepEqual(mutations, []);
});

// AGENTS.md's syntax check names the scripts one by one: a new one must join the list.
test("AGENTS.md's syntax check covers every script in sandbox/, and they pass it", () => {
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  const check = agents.split("\n").find((line) => line.startsWith("| Syntax check"));
  for (const file of readdirSync(bin)) {
    if (statSync(join(bin, file)).isDirectory()) continue;
    const shebang = readFileSync(join(bin, file), "utf8").split("\n")[0];
    const listed = check.includes(file.endsWith(".sh") ? "sandbox/*.sh" : `sandbox/${file}`);
    if (shebang === "#!/bin/bash") {
      assert.ok(listed, `${file} is not in AGENTS.md's syntax check`);
      assert.equal(spawnSync("bash", ["-n", join(bin, file)]).status, 0, `bash -n ${file}`);
    } else if (shebang === "#!/usr/bin/env node") {
      assert.ok(listed, `${file} is not in AGENTS.md's syntax check`);
      assert.equal(
        spawnSync("node", ["--check", join(bin, file)]).status,
        0,
        `node --check ${file}`,
      );
    } else assert.doesNotMatch(shebang, /^#!/, `${file}: a script AGENTS.md doesn't check`);
  }
});
