// The listener end to end, without Docker or GitHub: a fake `docker` on PATH plays the
// sandbox (asks the broker for a token, prints a result), a local server plays GitHub.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const SECRET = "webhook-secret";

function fakeDocker(dir) {
  const path = join(dir, "docker");
  writeFileSync(
    path,
    `#!/bin/bash
# Everything but the sandbox run is logged, one call per line.
case "$1" in
  ps|wait) exit 1 ;;
  volume)
    [ "$2" = inspect ] && exit 1
    echo "$*" >> "${dir}/docker-calls" ;;
  image)
    # The base image exists; repo images don't, until built.
    [ "$2" = inspect ] && case "$*" in *-repo-*) exit 1 ;; *) echo sha256:base ;; esac ;;
  build)
    echo "$*" >> "${dir}/docker-calls"
    # The build context is the repo's checkout.
    cp "\${@: -1}/docker/Dockerfile" "${dir}/built-dockerfile" ;;
  run)
    case "$*" in *--entrypoint*) echo "$*" >> "${dir}/docker-calls"; exit 0 ;; esac
    printf '%s\\n' "$@" > "${dir}/run-args"
    echo "$DECKHAND_RUN_SECRET" > "${dir}/run-secret"
    env > "${dir}/run-env"
    curl -fsS -H "Authorization: Bearer $DECKHAND_RUN_SECRET" "$DECKHAND_BROKER_URL/token" \\
      > "${dir}/broker-answer"
    echo '{"type":"result","result":"All done.","duration_ms":60000}'
    cat > /dev/null # until the listener closes stdin
    ;;
esac
`,
  );
  chmodSync(path, 0o755);
}

// `files`: the repo's files on its default branch, served by the contents API and as a
// tarball; none: no .deckhand.yaml (404).
async function fakeGitHub(files = {}) {
  const tarball = files["Dockerfile"] || files["docker/Dockerfile"] ? tarOf(files) : null;
  const requests = [];
  const waiters = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const entry = {
        method: req.method,
        path: req.url,
        auth: req.headers.authorization,
        body,
      };
      requests.push(entry);
      for (const w of [...waiters]) if (w.match(entry)) w.resolve(entry);
      res.setHeader("content-type", "application/json");
      const file = /^\/repos\/org\/repo\/contents\/([^?]+)\?ref=trunk$/.exec(req.url);
      if (file) {
        const text = files[decodeURIComponent(file[1])];
        if (text === undefined) return res.writeHead(404).end("{}");
        const content = Buffer.from(text).toString("base64");
        return res.end(JSON.stringify({ type: "file", sha: `blob-${text.length}`, content }));
      }
      if (req.url === "/repos/org/repo/tarball/trunk" && tarball) {
        res.setHeader("content-type", "application/gzip");
        return res.end(tarball);
      }
      if (req.url === "/app/installations/7/access_tokens") {
        const scoped = body.includes("repositories");
        const expires_at = new Date(Date.now() + 3600000).toISOString();
        return res.end(
          JSON.stringify({
            token: scoped ? "repo-token" : "app-token",
            expires_at,
          }),
        );
      }
      res.end(JSON.stringify({ id: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const waitFor = (match) =>
    new Promise((resolve) => {
      const found = requests.find(match);
      if (found) return resolve(found);
      waiters.push({ match, resolve });
    });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    waitFor,
    server,
  };
}

// GitHub's tarball: one top folder holding the repo's files.
function tarOf(files) {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-repo-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, "org-repo-abc", dirname(path)), { recursive: true });
    writeFileSync(join(dir, "org-repo-abc", path), text);
  }
  return execFileSync("tar", ["-czf", "-", "-C", dir, "org-repo-abc"]);
}

function start(env) {
  const child = spawn(process.execPath, ["listener/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const until = (text) =>
    new Promise((resolve, reject) => {
      const timer = setInterval(
        () => out.includes(text) && (clearInterval(timer), resolve(out)),
        20,
      );
      child.on("exit", (code) => (clearInterval(timer), reject(new Error(`exit ${code}: ${out}`))));
    });
  return { child, until, output: () => out };
}

test("refuses to start with an empty allowlist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-"));
  const { child, output } = start({
    PATH: process.env.PATH,
    DATA_DIR: dir,
    ALLOWED_USERS: " ",
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(output(), /ALLOWED_USERS/);
});

// A listener with an App, a fake Docker and a fake GitHub serving `files`.
async function listen(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-"));
  fakeDocker(dir);
  const github = await fakeGitHub(files);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(
    join(dir, "app.json"),
    JSON.stringify({
      id: 5,
      client_id: "Iv1.x",
      slug: "deckhand-x",
      bot_id: 77,
      webhook_secret: SECRET,
      pem: privateKey.export({ type: "pkcs1", format: "pem" }),
    }),
  );
  const port = 20000 + Math.floor(Math.random() * 20000);
  const brokerPort = port + 1;
  const listener = start({
    PATH: `${dir}:${process.env.PATH}`,
    DATA_DIR: dir,
    ALLOWED_USERS: "alice,bob",
    PORT: String(port),
    BROKER_PORT: String(brokerPort),
    BROKER_URL: `http://127.0.0.1:${brokerPort}`,
    GITHUB_API: github.url,
    PUBLIC_URL: "https://hooks.example.com",
    DEBOUNCE_MS: "0",
  });
  t.after(() => {
    listener.child.kill("SIGKILL");
    github.server.close();
  });
  await listener.until("Token broker on");
  const send = (payload, event = "issue_comment") => {
    const body = JSON.stringify(payload);
    return fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      },
      body,
    });
  };
  return { dir, github, listener, port, brokerPort, send };
}

function comment(login, body = "Claude work on this") {
  return {
    action: "created",
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    issue: { number: 12 },
    comment: { id: 99, body, user: { login, type: "User" } },
    sender: { login },
  };
}

test("a webhook from the App runs a sandbox that gets its repo's token from the broker", async (t) => {
  const { dir, github, listener, port, brokerPort } = await listen(t);
  const payload = JSON.stringify(comment("alice"));
  const deliver = (signature) =>
    fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });
  // Not signed with the App's secret: refused, nothing runs.
  const forged = createHmac("sha256", "other").update(payload).digest("hex");
  assert.equal((await deliver(`sha256=${forged}`)).status, 401);
  const good = createHmac("sha256", SECRET).update(payload).digest("hex");
  assert.equal((await deliver(`sha256=${good}`)).status, 202);

  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  assert.match(JSON.parse(reply.body).body, /^All done\./);
  // The listener talks to GitHub as the installation, not with a personal token.
  assert.equal(reply.auth, "Bearer app-token");

  // The sandbox got a token limited to its repo, through the broker, and nothing else.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "broker-answer"), "utf8")).repo, "org/repo");
  assert.equal(JSON.parse(readFileSync(join(dir, "broker-answer"), "utf8")).token, "repo-token");
  const mint = github.requests.find((r) => r.body.includes("repositories"));
  assert.deepEqual(JSON.parse(mint.body).repositories, ["repo"]);
  const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("deckhand.task=org/repo#12"));
  assert.equal(
    args.some((a) => a.includes(".ssh") || a.includes(".gitconfig")),
    false,
  );
  const runEnv = readFileSync(join(dir, "run-env"), "utf8");
  assert.match(runEnv, /^REPO_URL=https:\/\/github\.com\/org\/repo\.git$/m);
  assert.match(runEnv, /^BASE_BRANCH=trunk$/m);
  assert.match(runEnv, /^GIT_AUTHOR_EMAIL=77\+deckhand-x\[bot\]@users\.noreply\.github\.com$/m);
  assert.doesNotMatch(runEnv, /^GH_TOKEN=/m);

  // Once the run is over, its secret gets nothing.
  await listener.until("done (ok)");
  const secret = readFileSync(join(dir, "run-secret"), "utf8").trim();
  const after = await fetch(`http://127.0.0.1:${brokerPort}/token`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(after.status, 401);
});

const CONFIG = `# Node project
users: [alice, mallory]   # mallory isn't in ALLOWED_USERS: ignored
model: sonnet
setup: npm ci
instructions: docs/agents.md
dockerfile: docker/Dockerfile
caches:
  - /home/node/.npm
`;

test("a repo's config: its image, caches, setup and model", async (t) => {
  const { dir, github, listener, send } = await listen(t, {
    ".deckhand.yaml": CONFIG,
    "docker/Dockerfile": "ARG DECKHAND_BASE\nFROM $DECKHAND_BASE\nRUN true\n",
  });
  // Bob is allowed by the operator, not by the repo: nothing runs for him.
  await send(comment("bob"));
  await listener.until("bob not in ALLOWED_USERS");
  assert.equal((await send(comment("alice"))).status, 202);
  await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );

  const calls = readFileSync(join(dir, "docker-calls"), "utf8");
  // Built from the default branch's Dockerfile, FROM the base image.
  assert.match(
    calls,
    /^build .*--build-arg DECKHAND_BASE=deckhand-sandbox .*-t deckhand-repo-org-repo:[0-9a-f]{16} /m,
  );
  assert.match(readFileSync(join(dir, "built-dockerfile"), "utf8"), /FROM \$DECKHAND_BASE/);
  // Claude Code in its own container, then the cache volume, handed to the sandbox's user.
  assert.match(
    calls,
    /^run --rm .*CLAUDE_CODE_VERSION=.* --entrypoint deckhand-install-claude-code deckhand-sandbox$/m,
  );
  assert.match(calls, /^volume create .*deckhand-cache-org-repo-home-node-npm-[0-9a-f]{10}$/m);
  assert.match(
    calls,
    /--entrypoint chown -v deckhand-cache-org-repo-home-node-npm-\w+:\/home\/node\/\.npm deckhand-repo-org-repo:\w+ 1000:1000/,
  );

  const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
  assert.match(args.at(-2), /^deckhand-repo-org-repo:[0-9a-f]{16}$/);
  assert.ok(
    args.some((a) => /^deckhand-cache-org-repo-home-node-npm-\w+:\/home\/node\/\.npm$/.test(a)),
  );
  const runEnv = readFileSync(join(dir, "run-env"), "utf8");
  assert.match(runEnv, /^SANDBOX_SETUP=npm ci$/m);
  assert.match(runEnv, /^SANDBOX_INSTRUCTIONS=docs\/agents\.md$/m);
  assert.match(runEnv, /^SANDBOX_MODEL=sonnet$/m);
});

test("a config with errors stops the run and the reply says why", async (t) => {
  const { github, send } = await listen(t, { ".deckhand.yaml": "max_parallel: lots\n" });
  await send(comment("alice"));
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  assert.match(JSON.parse(reply.body).body, /max_parallel: expected a whole number/);
});
