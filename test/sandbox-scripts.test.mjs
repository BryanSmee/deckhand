// The sandbox's side of the broker: git's credential helper asks it for a token per call.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";

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
    DECKHAND_RUN_SECRET: b.register("org/repo"),
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
  const secret = b.register("org/repo");
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
