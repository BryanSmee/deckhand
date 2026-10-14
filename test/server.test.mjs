// The listener end to end, without Docker or GitHub: a fake `docker` on PATH plays the
// sandbox (asks the broker for a token, prints a result), a local server plays GitHub.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  network)
    # The sandboxes' network: internal unless the test says otherwise.
    cat "${dir}/network-internal" 2> /dev/null || echo true ;;
  inspect)
    # The sandbox's address on that network, for the egress proxy's questions.
    echo '{"deckhand-sandboxes":{"IPAddress":"10.9.0.5"}}' ;;
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
    # What the egress proxy would ask about this sandbox's connections.
    for host in api.anthropic.com github.com objects.githubusercontent.com evil.example \\
      registry.npmjs.org pypi.org a.b.example.com example.com lan.internal; do
      echo "$host $(curl -fsS "$DECKHAND_BROKER_URL/egress?ip=10.9.0.5&host=$host")" \\
        >> "${dir}/egress"
    done
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

// A listener with an App, a fake Docker and a fake GitHub serving `files`; `extra`: more
// settings. Either may be a function of the listener's temp dir.
async function listen(t, files, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-"));
  fakeDocker(dir);
  const github = await fakeGitHub(typeof files === "function" ? files(dir) : files);
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
    // The egress proxy asks from here: in the tests, the fake sandbox itself.
    EGRESS_PROXY: "http://127.0.0.1:3128",
    GRANTS_FILE: join(dir, "grants.yaml"),
    ...(typeof extra === "function" ? extra(dir) : extra),
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

  // Hardened, limited, and only its own screenshots folder.
  const joined = args.join(" ");
  assert.match(joined, /--cap-drop ALL --security-opt no-new-privileges/);
  assert.match(joined, /--cpus 2 --memory 4g --memory-swap 4g --pids-limit 2048/);
  const shots = joined.match(/SCREENSHOT_URL=https:\/\/hooks\.example\.com\/shots\/(\w+)/)[1];
  assert.ok(
    args.includes(`type=volume,src=deckhand-screenshots,dst=/screenshots,volume-subpath=${shots}`),
  );
  assert.equal(
    args.some((a) => a.startsWith("deckhand-screenshots:")),
    false,
  );
  assert.ok(args.includes("SCREENSHOT_DIR=/screenshots"));
  // Out through the egress proxy only, the broker directly.
  assert.match(runEnv, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:3128$/m);
  assert.match(runEnv, /^https_proxy=http:\/\/127\.0\.0\.1:3128$/m);
  assert.match(runEnv, /^NO_PROXY=localhost,127\.0\.0\.1,::1$/m);
  assert.match(runEnv, /^NODE_USE_ENV_PROXY=1$/m);
  // The default policy: Anthropic and GitHub, nothing else.
  const egress = egressAnswers(dir);
  assert.deepEqual(allowedHosts(egress), [
    "api.anthropic.com",
    "github.com",
    "objects.githubusercontent.com",
  ]);
  assert.match(listener.output(), /Egress: refused evil\.example for org\/repo#12/);

  // Once the run is over, its secret gets nothing.
  await listener.until("done (ok)");
  const secret = readFileSync(join(dir, "run-secret"), "utf8").trim();
  const after = await fetch(`http://127.0.0.1:${brokerPort}/token`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(after.status, 401);
});

// "host {json}" lines the fake sandbox wrote → { host: answer }.
function egressAnswers(dir) {
  const lines = readFileSync(join(dir, "egress"), "utf8").trim().split("\n");
  return Object.fromEntries(lines.map((l) => [l.split(" ")[0], JSON.parse(l.split(" ")[1])]));
}

function allowedHosts(answers) {
  return Object.keys(answers).filter((h) => answers[h].allowed);
}

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

test("hosts from the operator, its grants and the repo; granted mounts and limits", async (t) => {
  const { dir, github, send } = await listen(
    t,
    (dir) => ({
      ".deckhand.yaml": `hosts: ["*.example.com"]
mounts:
  - path: ${dir}/nfs/api
    read_only: false
  - path: ${dir}/nfs/docs
`,
    }),
    (dir) => {
      mkdirSync(join(dir, "nfs", "api"), { recursive: true });
      mkdirSync(join(dir, "nfs", "docs"), { recursive: true });
      writeFileSync(
        join(dir, "grants.yaml"),
        `org/repo:
  hosts: [pypi.org]
  limits: { memory: 8g }
  mounts:
    - root: ${join(dir, "nfs")}
      read_only: false
`,
      );
      return { ALLOWED_HOSTS: "registry.npmjs.org" };
    },
  );
  assert.equal((await send(comment("alice"))).status, 202);
  await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  const egress = egressAnswers(dir);
  assert.deepEqual(allowedHosts(egress), [
    "api.anthropic.com",
    "github.com",
    "objects.githubusercontent.com",
    "registry.npmjs.org",
    "pypi.org",
    "a.b.example.com",
  ]);
  // Named hosts may resolve to private addresses; only "*" may not (proxy.mjs).
  assert.equal(egress["a.b.example.com"].private, true);
  const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
  const joined = args.join(" ");
  assert.match(joined, /--cpus 2 --memory 8g --memory-swap 8g --pids-limit 2048/);
  assert.ok(
    args.includes(`type=bind,src=${join(dir, "nfs", "api")},dst=${join(dir, "nfs", "api")}`),
  );
  assert.ok(
    args.includes(
      `type=bind,src=${join(dir, "nfs", "docs")},dst=${join(dir, "nfs", "docs")},readonly`,
    ),
  );
});

test("a mount outside the granted root, through a symlink, is refused on the issue", async (t) => {
  const { dir, github, send } = await listen(
    t,
    (dir) => ({ ".deckhand.yaml": `mounts:\n  - ${dir}/nfs/escape\n  - ${dir}/nfs/../etc\n` }),
    (dir) => {
      mkdirSync(join(dir, "nfs"), { recursive: true });
      symlinkSync("/etc", join(dir, "nfs", "escape"));
      writeFileSync(join(dir, "grants.yaml"), `org/repo:\n  mounts: [${join(dir, "nfs")}]\n`);
      return {};
    },
  );
  await send(comment("alice"));
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  const body = JSON.parse(reply.body).body;
  assert.match(body, /host mounts requested by `\.deckhand\.yaml` are refused/);
  assert.match(body, /escape`: resolves to \/etc, outside the roots/);
  assert.match(body, /\.\.\/etc`: (resolves to \S+, outside|doesn't exist)/);
  assert.throws(() => readFileSync(join(dir, "run-args")));
});

test("a sandboxes' network with a route out stops the run", async (t) => {
  const { github, send } = await listen(t, {}, (dir) => {
    writeFileSync(join(dir, "network-internal"), "false\n");
    return {};
  });
  await send(comment("alice"));
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  assert.match(JSON.parse(reply.body).body, /deckhand-sandboxes is not internal/);
});

test("a comment on the ideas inbox is a light run with the idea prompt, answered there", async (t) => {
  const { dir, github, send } = await listen(t, {
    ".deckhand.yaml": "inbox: { ideas: 12 }\nsetup: npm ci\n",
  });
  const payload = comment("alice", "A dark mode");
  payload.comment.html_url = "https://github.com/org/repo/issues/12#issuecomment-99";
  assert.equal((await send(payload)).status, 202);
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  assert.match(JSON.parse(reply.body).body, /^All done\./);
  const runEnv = readFileSync(join(dir, "run-env"), "utf8");
  assert.match(runEnv, /^TASK_MODE=idea$/m);
  assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
  // No branch, no setup, and the entry comes with the prompt of a new session.
  assert.match(runEnv, /^TASK_ISSUE=$/m);
  assert.match(runEnv, /^SANDBOX_SETUP=$/m);
  assert.match(runEnv, /^TASK_MESSAGE=$/m);
  assert.match(runEnv, /^TASK_PROMPT=New on the ideas inbox of org\/repo \(issue #12\)/m);
  assert.match(runEnv, /--label idea/);
  assert.match(
    runEnv,
    /From @alice \(https:\/\/github\.com\/org\/repo\/issues\/12#issuecomment-99\):\n\nA dark mode/,
  );
});

function discussion(category, login = "alice") {
  return {
    action: "created",
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    discussion: {
      id: 5,
      node_id: "D_5",
      number: 8,
      title: "How do restarts work?",
      body: "Is the queue kept?",
      category: { name: category },
      user: { login, type: "User" },
    },
    sender: { login },
  };
}

test("a discussion in the repo's category is answered in it, with a discussions token", async (t) => {
  const { dir, github, listener, send } = await listen(t, {
    ".deckhand.yaml": "inbox:\n  discussions: Ask Claude\n",
  });
  await send(discussion("General"), "discussion");
  await listener.until(`category "General" doesn't call Claude`);
  assert.equal((await send(discussion("Ask Claude"), "discussion")).status, 202);
  const graphql = (text) => (r) => r.path === "/graphql" && r.body.includes(text);
  const posted = await github.waitFor(graphql("addDiscussionComment"));
  const { variables } = JSON.parse(posted.body);
  assert.equal(variables.id, "D_5");
  // The discussion itself: a top-level comment.
  assert.equal(variables.thread, null);
  assert.match(variables.body, /^All done\.[\s\S]*reply in this discussion to continue/);
  const eyes = await github.waitFor(graphql("addReaction"));
  assert.deepEqual(JSON.parse(eyes.body).variables, { id: "D_5", content: "EYES" });
  // Nothing is posted to an issue of the same number.
  assert.equal(
    github.requests.some((r) => r.path.endsWith("/issues/8/comments")),
    false,
  );
  const mint = github.requests.find((r) => r.body.includes("repositories"));
  assert.equal(JSON.parse(mint.body).permissions.discussions, "write");
  const runEnv = readFileSync(join(dir, "run-env"), "utf8");
  assert.match(runEnv, /^TASK_MODE=discussion$/m);
  assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
  assert.match(runEnv, /^TASK_PROMPT=New on discussion #8 of org\/repo/m);
  const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
  assert.ok(args.includes("deckhand.task=org/repo#discussion-8"));
});
