// The listener end to end, without Docker or GitHub: a fake `docker` on PATH plays the
// sandbox (asks the broker for a token, prints a result), a local server plays GitHub.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const SECRET = "webhook-secret";

// Sandboxes run detached: `run` starts the fake sandbox in the background (its output in
// containers/<name>/out), `logs --follow` tails it, `ps`, `inspect`, `wait` and `rm` see it.
// The fake sandbox asks the broker and the egress policy, prints a result (once
// ${dir}/go exists, if ${dir}/hold does), then answers each comment of its inbox, through
// the image's own deckhand-inbox, until the listener closes it.
function fakeDocker(dir) {
  const path = join(dir, "docker");
  const inbox = new URL("../sandbox/deckhand-inbox", import.meta.url).pathname;
  writeFileSync(
    path,
    `#!/bin/bash
# Everything but the sandbox run is logged, one call per line.
c="${dir}/containers"
alive() { [ -f "$c/$1/pid" ] && kill -0 "$(cat "$c/$1/pid")" 2> /dev/null; }
case "$1" in
  ps)
    for d in "$c"/*/; do
      [ -d "$d" ] || continue
      n=$(basename "$d")
      alive "$n" && state=running || state=exited
      printf '%s\\t%s\\t%s\\n' "$n" "$(cat "$d/run")" "$state"
    done ;;
  wait)
    while alive "\${@: -1}"; do sleep 0.05; done ;;
  rm)
    rm -rf "$c/\${@: -1}" ;;
  logs)
    n=\${@: -1}
    [ -d "$c/$n" ] || exit 1
    exec tail -n +1 -f --pid="$(cat "$c/$n/pid")" -s 0.05 "$c/$n/out" ;;
  network)
    # The sandboxes' network: internal unless the test says otherwise. Checked while the run
    # is prepared, so a test can change things then.
    [ -x "${dir}/while-preparing" ] && "${dir}/while-preparing"
    cat "${dir}/network-internal" 2> /dev/null || echo true ;;
  inspect)
    n=\${@: -1}
    case "$3" in
      *State*)
        [ -d "$c/$n" ] || exit 1
        alive "$n" && echo running || echo exited ;;
      # The sandbox's address on that network, for the egress proxy's questions.
      *) echo '{"deckhand-sandboxes":{"IPAddress":"10.9.0.5"}}' ;;
    esac ;;
  volume)
    # The volumes a test says exist (one name per line in ${dir}/volumes).
    if [ "$2" = inspect ]; then grep -qx -- "\${@: -1}" "${dir}/volumes" 2> /dev/null; exit; fi
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
    name=$(printf '%s\\n' "$@" | grep -A1 -x -- --name | tail -1)
    run=$(printf '%s\\n' "$@" | sed -n 's/^deckhand\\.run=//p')
    mkdir -p "$c/$name"
    echo "$run" > "$c/$name/run"
    setsid bash -c '
      curl -fsS -H "Authorization: Bearer $DECKHAND_RUN_SECRET" "$DECKHAND_BROKER_URL/token" \\
        > "${dir}/broker-answer"
      # What the egress proxy would ask about this sandbox'"'"'s connections.
      for host in api.anthropic.com github.com objects.githubusercontent.com evil.example \\
        registry.npmjs.org pypi.org a.b.example.com example.com lan.internal; do
        echo "$host $(curl -fsS "$DECKHAND_BROKER_URL/egress?ip=10.9.0.5&host=$host")" \\
          >> "${dir}/egress"
      done
      # Not all of stdout is Claude'"'"'s: gh prints the draft pull request'"'"'s address.
      echo "https://github.com/org/repo/pull/13"
      if [ -e "${dir}/hold" ]; then
        until [ -e "${dir}/go" ]; do sleep 0.05; done
      fi
      echo "{\\"type\\":\\"result\\",\\"result\\":\\"All done.\\",\\"duration_ms\\":60000}"
      node "${inbox}" "${dir}/runs/$1/inbox.jsonl" | while IFS= read -r line; do
        echo "$line" >> "${dir}/delivered"
        if [ -e "${dir}/hold-answer" ]; then
          until [ -e "${dir}/answer" ]; do sleep 0.05; done
        fi
        echo "{\\"type\\":\\"result\\",\\"result\\":\\"Answered.\\",\\"duration_ms\\":6000}"
      done
    ' sandbox "$run" > "$c/$name/out" 2> "$c/$name/err" < /dev/null &
    echo $! > "$c/$name/pid"
    ;;
esac
`,
  );
  chmodSync(path, 0o755);
}

// Stops the fake sandboxes a test leaves running.
function stopSandboxes(dir) {
  try {
    for (const name of readdirSync(join(dir, "containers"))) {
      try {
        process.kill(-Number(readFileSync(join(dir, "containers", name, "pid"), "utf8")));
      } catch {
        // Already over.
      }
    }
  } catch {
    // None started.
  }
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
      // Other branches' files are keyed "<branch>:<path>".
      const file = /^\/repos\/org\/repo\/contents\/([^?]+)\?ref=(.+)$/.exec(req.url);
      if (file) {
        const path = decodeURIComponent(file[1]);
        const ref = decodeURIComponent(file[2]);
        const text = ref === "trunk" ? files[path] : files[`${ref}:${path}`];
        if (text === undefined) return res.writeHead(404).end("{}");
        const content = Buffer.from(text).toString("base64");
        return res.end(JSON.stringify({ type: "file", sha: `blob-${text.length}`, content }));
      }
      if (req.url === "/repos/org/repo/tarball/trunk" && tarball) {
        res.setHeader("content-type", "application/gzip");
        return res.end(tarball);
      }
      // Dashboard sign-in: the browser comes back as alice.
      if (req.url === "/login/oauth/access_token") {
        return res.end(JSON.stringify({ access_token: "user-token" }));
      }
      if (req.url === "/user") return res.end(JSON.stringify({ login: "alice" }));
      // A task from before titles were kept: the dashboard asks for its title once.
      if (req.method === "GET" && req.url === "/repos/org/repo/issues/3") {
        return res.end(JSON.stringify({ title: "An older pull request" }));
      }
      // A task from before pull requests were kept: looked up once.
      if (req.url === "/repos/org/repo/pulls?state=all&sort=updated&direction=desc&per_page=100") {
        const url = "https://github.com/org/repo/pull/3";
        return res.end(JSON.stringify([{ number: 3, html_url: url, state: "open", draft: false }]));
      }
      // Onboarding: the repo, its new issue, and the pull request the work run opened.
      if (req.method === "GET" && req.url === "/repos/org/repo") {
        return res.end(JSON.stringify({ default_branch: "trunk", has_issues: true }));
      }
      if (req.method === "POST" && req.url === "/repos/org/repo/issues") {
        return res.end(JSON.stringify({ number: 30 }));
      }
      if (req.url === "/repos/org/repo/pulls?state=open&per_page=100") {
        return res.end(
          JSON.stringify([{ number: 31, head: { ref: "issue-30-deckhand-config" }, body: "" }]),
        );
      }
      // A listener that restarted looks the installation up instead of reading it from a
      // delivery.
      if (req.url === "/repos/org/repo/installation") return res.end(JSON.stringify({ id: 7 }));
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
        () =>
          (typeof text === "string" ? out.includes(text) : text.test(out)) &&
          (clearInterval(timer), resolve(out)),
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

// The ports a listener bound, from its log: its own, then its broker's.
async function ports(listener) {
  const bound = async (name) => {
    const re = new RegExp(`${name} on :(\\d+)\n`);
    return Number((await listener.until(re)).match(re)[1]);
  };
  return [await bound("Listening"), await bound("Token broker")];
}

// A listener with an App, a fake Docker and a fake GitHub serving `files`; `extra`: more
// settings. Either may be a function of the listener's temp dir (and `extra`, of the fake
// GitHub).
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
      client_secret: "cs",
      slug: "deckhand-x",
      bot_id: 77,
      webhook_secret: SECRET,
      pem: privateKey.export({ type: "pkcs1", format: "pem" }),
    }),
  );
  // Port 0: the OS picks free ports, which the listener logs. The broker's URL gets its port.
  const settings = {
    PATH: `${dir}:${process.env.PATH}`,
    DATA_DIR: dir,
    ALLOWED_USERS: "alice,bob",
    PORT: "0",
    BROKER_PORT: "0",
    BROKER_URL: "http://127.0.0.1",
    GITHUB_API: github.url,
    PUBLIC_URL: "https://hooks.example.com",
    DEBOUNCE_MS: "0",
    // The egress proxy asks from here: in the tests, the fake sandbox itself.
    EGRESS_PROXY: "http://127.0.0.1:3128",
    GRANTS_FILE: join(dir, "grants.yaml"),
    ...(typeof extra === "function" ? extra(dir, github) : extra),
  };
  let listener = start(settings);
  t.after(() => {
    listener.child.kill("SIGKILL");
    github.server.close();
    stopSandboxes(dir);
  });
  const [port, brokerPort] = await ports(listener);
  // Restarts keep them: the sandboxes still running talk to the broker at a fixed URL.
  Object.assign(settings, {
    PORT: String(port),
    BROKER_PORT: String(brokerPort),
    BROKER_URL: `http://127.0.0.1:${brokerPort}`,
  });
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
  // Stops the listener (SIGTERM unless `signal` says otherwise) and starts another one on the
  // same data and ports, with `more` settings.
  const restart = async ({ signal = "SIGTERM", ...more } = {}) => {
    const old = listener;
    const { child } = old;
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const code = child.exitCode ?? (child.signalCode || (child.kill(signal), await exited));
    listener = start({ ...settings, ...more });
    await ports(listener);
    return { code, output: old.output() };
  };
  return {
    dir,
    github,
    get listener() {
      return listener;
    },
    port,
    brokerPort,
    send,
    restart,
  };
}

function comment(login, body = "Deckhand") {
  return {
    action: "created",
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    issue: { number: 12 },
    comment: { id: 99, body, user: { login, type: "User" } },
    sender: { login },
  };
}

test("sandbox names: a hash keeps colliding repos apart, sessions from before keep theirs", async (t) => {
  const { dir, github, send, listener } = await listen(t);
  // Issue 12 has a session from before names had a hash; issue 14 has none.
  writeFileSync(join(dir, "volumes"), "deckhand-org-repo-12-claude\n");
  const name = () => {
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    return [args[args.indexOf("--name") + 1], args.filter((a) => a.endsWith(":/workspace"))[0]];
  };
  // No trigger line: it goes on in the session issue 12 has.
  await send(comment("alice", "And the tests?"));
  await github.waitFor((r) => r.path === "/repos/org/repo/issues/12/comments");
  assert.deepEqual(name(), ["deckhand-org-repo-12", "deckhand-org-repo-12-workspace:/workspace"]);
  await listener.until("done (ok)");
  await send({ ...comment("alice"), issue: { number: 14 } });
  await github.waitFor((r) => r.path === "/repos/org/repo/issues/14/comments");
  const [fresh, workspace] = name();
  assert.match(fresh, /^deckhand-org-repo-14-[0-9a-f]{10}$/);
  assert.equal(workspace, `${fresh}-workspace:/workspace`);
});

// Sends a delivery's headers and holds its body back: the answer comes from the headers alone.
function headersOnly(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ port, method: "POST", path: "/webhook", headers }, (res) => {
      resolve(res.statusCode);
      res.resume();
      req.destroy();
    });
    req.on("error", reject);
    req.flushHeaders();
  });
}

test("unsigned or oversized deliveries are refused before their body is read", async (t) => {
  const { port, listener } = await listen(t);
  const signed = { "x-github-event": "issue_comment", "x-hub-signature-256": "sha256=00" };
  assert.equal(
    await headersOnly(port, { "x-github-event": "issue_comment", "content-length": "100" }),
    401,
  );
  assert.equal(
    await headersOnly(port, { ...signed, "content-length": String(26 * 1024 * 1024) }),
    413,
  );
  await listener.until("Rejected a delivery: over 26214400 bytes");
  assert.match(listener.output(), /Rejected a delivery: no signature/);
  // At most 16 bodies being read: the 17th is refused until one of them is done.
  const held = [];
  for (let i = 0; i < 16; i++) {
    const req = request({ port, method: "POST", path: "/webhook", headers: signed });
    req.on("error", () => {});
    req.write("{");
    held.push(req);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await headersOnly(port, signed), 503);
  await listener.until("16 deliveries being read already");
  for (const req of held) req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const body = JSON.stringify(comment("mallory"));
  const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      "x-github-event": "issue_comment",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  assert.equal(res.status, 202);
});

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
  const shots = runEnv.match(/^SCREENSHOT_URL=https:\/\/hooks\.example\.com\/shots\/(\w+)$/m)[1];
  assert.ok(
    args.includes(`type=volume,src=deckhand-screenshots,dst=/screenshots,volume-subpath=${shots}`),
  );
  assert.equal(
    args.some((a) => a.startsWith("deckhand-screenshots:")),
    false,
  );
  assert.match(runEnv, /^SCREENSHOT_DIR=\/screenshots$/m);
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
  // Its pushes went through the broker's port too (git-gateway.mjs): now refused, with the
  // challenge git needs to ask its credential helper.
  const push = await fetch(
    `http://127.0.0.1:${brokerPort}/git/org/repo.git/info/refs?service=git-receive-pack`,
    { headers: { authorization: `Basic ${Buffer.from(`deckhand:${secret}`).toString("base64")}` } },
  );
  assert.equal(push.status, 401);
  assert.match(push.headers.get("www-authenticate"), /^Basic/);
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
  // Shared by every repository: no run may change what the next one runs.
  assert.ok(args.includes("deckhand-claude-code:/opt/claude-code:ro"));
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
      chmodSync(join(dir, "nfs"), 0o555); // not writable by the sandbox's user: api may be read-write
      writeFileSync(
        join(dir, "grants.yaml"),
        `org/repo:
  hosts: [pypi.org]
  allow_repo_hosts: true
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

test("a repo's hosts without allow_repo_hosts: refused on the issue, unless already allowed", async (t) => {
  const { dir, github, send } = await listen(
    t,
    { ".deckhand.yaml": 'hosts: [registry.npmjs.org, pypi.org, "*.evil.net"]\n' },
    (dir) => {
      writeFileSync(join(dir, "grants.yaml"), "org/repo:\n  hosts: [pypi.org]\n");
      return { ALLOWED_HOSTS: "registry.npmjs.org" };
    },
  );
  await send(comment("alice"));
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  const body = JSON.parse(reply.body).body;
  assert.match(body, /`\.deckhand\.yaml` on `trunk` has errors/);
  assert.match(
    body,
    /- hosts: `\*\.evil\.net`: the operator doesn't let this repository add hosts/,
  );
  assert.doesNotMatch(body, /pypi\.org`|registry\.npmjs\.org`/);
  assert.match(body, /allow_repo_hosts: true/);
  assert.throws(() => readFileSync(join(dir, "run-args")));
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

test("a mount that resolves elsewhere once the run is prepared stops it", async (t) => {
  const { dir, github, send } = await listen(
    t,
    (dir) => ({ ".deckhand.yaml": `mounts:\n  - ${dir}/nfs/api\n` }),
    (dir) => {
      mkdirSync(join(dir, "nfs", "a"), { recursive: true });
      mkdirSync(join(dir, "nfs", "b"));
      symlinkSync("a", join(dir, "nfs", "api"));
      writeFileSync(join(dir, "while-preparing"), `#!/bin/sh\nln -sfn b "${dir}/nfs/api"\n`);
      chmodSync(join(dir, "while-preparing"), 0o755);
      writeFileSync(join(dir, "grants.yaml"), `org/repo:\n  mounts: [${join(dir, "nfs")}]\n`);
      return {};
    },
  );
  await send(comment("alice"));
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  const body = JSON.parse(reply.body).body;
  assert.match(body, /host mounts changed while the run was being prepared/);
  assert.match(body, /`\S+\/nfs\/api` no longer resolves to `\S+\/nfs\/a`/);
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

// Polls until `check()` is truthy.
async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function exists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Temporary files of state writes, in the data volume and its logs.
const leftovers = (dir) =>
  [...readdirSync(dir), ...readdirSync(join(dir, "logs"))].filter((f) => f.endsWith(".tmp"));

const replies = (github) =>
  github.requests.filter(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );

// A follow-up comment on issue 12 (no trigger line), with its own id.
function followUp(id, body) {
  const payload = comment("alice", body);
  payload.comment = { ...payload.comment, id };
  return payload;
}

// A listener whose sandbox waits (`hold`) before Claude's first answer, with a run started.
async function holding(t) {
  const ctx = await listen(t, {}, (dir) => {
    writeFileSync(join(dir, "hold"), "");
    return {};
  });
  await ctx.send(comment("alice"));
  const egress = join(ctx.dir, "egress");
  await until(() => exists(egress)?.trim().split("\n").length === 9, "the sandbox");
  return ctx;
}

test("a restart during a run: it goes on, a new comment reaches it, one reply", async (t) => {
  const ctx = await holding(t);
  const { dir, github, send, brokerPort } = ctx;
  const { code, output } = await ctx.restart();
  assert.equal(code, 0);
  assert.match(output, /Stopping: running sandboxes go on/);
  await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");

  // Its token still works, through the new listener's broker.
  const secret = readFileSync(join(dir, "run-secret"), "utf8").trim();
  const token = await fetch(`http://127.0.0.1:${brokerPort}/token`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(token.status, 200);

  // A comment without a trigger line goes to the running session, through its inbox.
  await send(followUp(100, "Also cover the edge case"));
  const [run] = readdirSync(join(dir, "runs"));
  const inbox = join(dir, "runs", run, "inbox.jsonl");
  await until(() => exists(inbox)?.includes("Also cover the edge case"), "the delivery");
  writeFileSync(join(dir, "go"), "");
  await ctx.listener.until("done (ok)");
  assert.match(exists(join(dir, "delivered")), /Also cover the edge case/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(replies(github).length, 1);
  assert.match(JSON.parse(replies(github)[0].body).body, /^Answered\./);
  // Both comments get their outcome.
  for (const id of [99, 100]) {
    await github.waitFor(
      (r) => r.path === `/repos/org/repo/issues/comments/${id}/reactions` && /rocket/.test(r.body),
    );
  }
  // The sandbox, its inbox and the run's saved state are gone.
  assert.deepEqual(readdirSync(join(dir, "containers")), []);
  assert.deepEqual(readdirSync(join(dir, "runs")), []);
  assert.deepEqual(
    readdirSync(join(dir, "logs")).filter((f) => f.endsWith(".live.json")),
    [],
  );
  // Its state was written whole each time (store.mjs).
  assert.deepEqual(leftovers(dir), []);
});

test("a listener killed mid-run: Claude answers meanwhile, the next one replies once", async (t) => {
  const ctx = await holding(t);
  const { dir, github } = ctx;
  // Claude answers while no listener is there: the sandbox waits for its inbox to close.
  const killed = ctx.listener.child;
  killed.kill("SIGKILL");
  await new Promise((resolve) => killed.on("exit", resolve));
  writeFileSync(join(dir, "go"), "");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await ctx.restart();
  await ctx.listener.until("done (ok)");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(replies(github).length, 1);
  assert.match(JSON.parse(replies(github)[0].body).body, /^All done\./);
  // Its log on the dashboard holds Claude's answer once.
  const [log] = readdirSync(join(dir, "logs")).filter((f) => f.endsWith(".log"));
  const results = readFileSync(join(dir, "logs", log), "utf8").match(/"type":"result"/g);
  assert.equal(results.length, 1);
});

test("comments queued when the listener stops run after it starts", async (t) => {
  const ctx = await listen(t, {}, { DEBOUNCE_MS: "60000" });
  await ctx.send(comment("alice"));
  await ctx.listener.until("queued (work");
  await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/99/reactions");
  const { output } = await ctx.restart({ DEBOUNCE_MS: "0" });
  assert.match(output, /Saved 1 task\(s\) with queued comments/);
  await ctx.listener.until("1 comment(s) queued before the restart");
  await ctx.listener.until("done (ok)");
  assert.equal(replies(ctx.github).length, 1);
  // Its 👀 from before the restart is replaced by the outcome.
  await ctx.github.waitFor(
    (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/comments/99/reactions/1",
  );
  assert.deepEqual(leftovers(ctx.dir), []);
});

test("a restart after Claude answered once: nothing is read twice", async (t) => {
  const ctx = await holding(t);
  const { dir, github, send } = ctx;
  writeFileSync(join(dir, "hold-answer"), "");
  await send(followUp(100, "Also cover the edge case"));
  const [run] = readdirSync(join(dir, "runs"));
  const inbox = join(dir, "runs", run, "inbox.jsonl");
  await until(() => exists(inbox)?.includes("Also cover the edge case"), "the delivery");
  writeFileSync(join(dir, "go"), "");
  // Claude answered the prompt and reads the comment: the listener restarts meanwhile.
  await until(() => exists(join(dir, "delivered")), "Claude reading the comment");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await ctx.restart();
  await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
  writeFileSync(join(dir, "answer"), "");
  await ctx.listener.until("done (ok)");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(replies(github).length, 1);
  assert.match(JSON.parse(replies(github)[0].body).body, /^Answered\./);
  // Both answers once each in the run's log, and the duration of both in the footer.
  const [log] = readdirSync(join(dir, "logs")).filter((f) => f.endsWith(".log"));
  const text = readFileSync(join(dir, "logs", log), "utf8");
  assert.equal(text.match(/"type":"result"/g).length, 2);
  assert.equal(text.match(/pull\/13/g).length, 1);
  assert.match(JSON.parse(replies(github)[0].body).body, / · 1\.1 min/);
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

const MODES = `setup: npm ci
model: opus
hosts: [registry.npmjs.org]
modes:
  review:
    instructions: .deckhand/review.md
    light: true
    model: sonnet
    effort: high
`;

test("/mode review: the repo's light mode, its instructions and model, the repo's grants", async (t) => {
  const { dir, github, listener, send } = await listen(
    t,
    { ".deckhand.yaml": MODES, ".deckhand/review.md": "Read the diff and list the risks." },
    (dir) => {
      writeFileSync(
        join(dir, "grants.yaml"),
        "org/repo:\n  hosts: [pypi.org]\n  allow_repo_hosts: true\n",
      );
      return {};
    },
  );
  await send(comment("alice", "Deckhand\n/mode review\nMind the tests."));
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  assert.match(JSON.parse(reply.body).body, /review mode: replies go on in it, `\/mode work`/);
  const runEnv = readFileSync(join(dir, "run-env"), "utf8");
  assert.match(runEnv, /^TASK_MODE=review$/m);
  assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
  assert.match(runEnv, /^TASK_SESSION=$/m);
  assert.match(runEnv, /^SANDBOX_MODEL=sonnet$/m);
  assert.match(runEnv, /^SANDBOX_EFFORT=high$/m);
  // Like a brainstorm: no branch, no setup.
  assert.match(runEnv, /^TASK_ISSUE=$/m);
  assert.match(runEnv, /^SANDBOX_SETUP=$/m);
  assert.match(runEnv, /^TASK_PROMPT=You are in the "review" mode of this repository/m);
  assert.match(runEnv, /This mode only comments/);
  assert.match(runEnv, /Read the diff and list the risks\./);
  assert.match(runEnv, /^TASK_MESSAGE=Mind the tests\.$/m);
  // Comments only: its token reads.
  const mint = github.requests.find((r) => r.body.includes("repositories"));
  assert.deepEqual(JSON.parse(mint.body).permissions, {
    contents: "read",
    issues: "read",
    pull_requests: "read",
    metadata: "read",
    actions: "read",
  });
  // The same hosts as any run of the repo: the operator's, its grant's and its config's.
  assert.deepEqual(allowedHosts(egressAnswers(dir)), [
    "api.anthropic.com",
    "github.com",
    "objects.githubusercontent.com",
    "registry.npmjs.org",
    "pypi.org",
  ]);
  // The run's record names the mode.
  const [log] = readdirSync(join(dir, "logs")).filter((f) => f.endsWith(".log"));
  const meta = JSON.parse(readFileSync(join(dir, "logs", log), "utf8").split("\n")[0]);
  assert.equal(meta.taskMode, "review");
  assert.equal(meta.kind, "issue");
  await listener.until("done (ok)");

  // A comment without a trigger line goes on in the mode; "/mode work" moves to work.
  await send(followUp(100, "And the docs?"));
  await until(() => replies(github).length === 2, "the second reply");
  assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_MODE=review$/m);
  await send(followUp(101, "/mode work\nFix them."));
  await until(() => replies(github).length === 3, "the third reply");
  const work = readFileSync(join(dir, "run-env"), "utf8");
  assert.match(work, /^TASK_MODE=work$/m);
  assert.match(work, /^SANDBOX_LIGHT=$/m);
  assert.match(work, /^SANDBOX_SETUP=npm ci$/m);
  assert.match(work, /^SANDBOX_MODEL=opus$/m);
  assert.match(work, /^TASK_ISSUE=12$/m);
  const mints = github.requests.filter((r) => r.body.includes("repositories"));
  // A work run writes pull requests; it pushes through the git gateway, its token only reads.
  assert.equal(JSON.parse(mints.at(-1).body).permissions.pull_requests, "write");
  assert.equal(JSON.parse(mints.at(-1).body).permissions.contents, "read");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "modes.json"), "utf8")), {});
});

test("/mode with a name the repo doesn't have: a reply listing the modes, no run", async (t) => {
  const { dir, github, send } = await listen(t, {
    ".deckhand.yaml": MODES,
    ".deckhand/review.md": "Review.",
  });
  await send(comment("alice", "Deckhand\n/mode reveiw"));
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  assert.match(
    JSON.parse(reply.body).body,
    /^Unknown mode `reveiw`\. The modes here: `work`, `brainstorm`, `onboarding`, `review` \(comments only\)\./,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(exists(join(dir, "run-args")), null);
});

// The run's mode and whether it is light, from the fake sandbox's last environment.
function lastRun(dir) {
  const env = readFileSync(join(dir, "run-env"), "utf8");
  return `${/^TASK_MODE=(.*)$/m.exec(env)[1]} ${/^SANDBOX_LIGHT=(.*)$/m.exec(env)[1] || "full"}`;
}

const brainstormOf = (dir) =>
  JSON.parse(readFileSync(join(dir, "brainstorms.json"), "utf8"))["org/repo#12"];

test("Deckhand /mode brainstorm discusses; /stop wraps up; Deckhand then works", async (t) => {
  const { dir, github, listener, send } = await listen(t, {}, { BRAINSTORM_DEBOUNCE_MS: "0" });
  await send(comment("alice", "@Deckhand /mode Brainstorm\nWhat about dark mode?"));
  await until(() => replies(github).length === 1, "the first reply");
  assert.equal(lastRun(dir), "brainstorm 1");
  const env = readFileSync(join(dir, "run-env"), "utf8");
  assert.match(env, /^TASK_MESSAGE=What about dark mode\?$/m);
  assert.equal(brainstormOf(dir).status, "active");
  await listener.until("done (ok)");
  // A comment without the trigger goes on in the brainstorm.
  await send(followUp(100, "And the contrast?"));
  await until(() => replies(github).length === 2, "the second reply");
  assert.equal(lastRun(dir), "brainstorm 1");
  await send(followUp(101, "/stop"));
  await until(() => replies(github).length === 3, "the wrap-up");
  assert.equal(lastRun(dir), "brainstorm 1");
  assert.equal(brainstormOf(dir).status, "stopped");
  // The trigger alone implements, in the same session.
  await send(followUp(102, "Deckhand\nGo with the second option."));
  await until(() => replies(github).length === 4, "the work reply");
  assert.equal(lastRun(dir), "work full");
  assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_SESSION=$/m);
  assert.equal(brainstormOf(dir), undefined);
});

test("/mode work alone moves a brainstorm to work", async (t) => {
  const { dir, github, listener, send } = await listen(t, {}, { BRAINSTORM_DEBOUNCE_MS: "0" });
  await send(comment("alice", "Deckhand\n/mode brainstorm"));
  await until(() => replies(github).length === 1, "the first reply");
  assert.equal(lastRun(dir), "brainstorm 1");
  await listener.until("done (ok)");
  await send(followUp(100, "/mode work\nBuild it."));
  await until(() => replies(github).length === 2, "the work reply");
  assert.equal(lastRun(dir), "work full");
  assert.equal(brainstormOf(dir), undefined);
});

test("/mode foo: a reply listing the modes, no run", async (t) => {
  const { dir, github, send } = await listen(t);
  await send(comment("alice", "Deckhand /mode foo"));
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  assert.match(
    JSON.parse(reply.body).body,
    /^Unknown mode `foo`\. The modes here: `work`, `brainstorm`, `onboarding`\./,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(exists(join(dir, "run-args")), null);
});

test("a mode whose instructions file is missing: the reply says so", async (t) => {
  const { dir, github, send } = await listen(t, { ".deckhand.yaml": MODES });
  await send(comment("alice", "Deckhand\n/mode review"));
  const reply = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );
  assert.match(
    JSON.parse(reply.body).body,
    /the `review` mode's instructions, `\.deckhand\/review\.md`, are not on `trunk`/,
  );
  assert.equal(exists(join(dir, "run-args")), null);
});

function installed(sender = "alice", repos = ["org/repo"]) {
  return {
    action: "created",
    installation: { id: 7 },
    repositories: repos.map((full_name) => ({ full_name })),
    sender: { login: sender },
  };
}

const onIssue30 = (github) =>
  github.requests.filter(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/30/comments",
  );

function onIssue30Comment(id, body) {
  const payload = followUp(id, body);
  payload.issue = { number: 30 };
  return payload;
}

test("installing the App on a repo without a config: an onboarding issue and conversation, then its pull request", async (t) => {
  const ctx = await listen(
    t,
    {
      // The work run's branch: a config with an error, and the Dockerfile it names is missing.
      "issue-30-deckhand-config:.deckhand.yaml": "effort: huge\ndockerfile: .deckhand/Dockerfile\n",
    },
    { BRAINSTORM_DEBOUNCE_MS: "0", ALLOWED_HOSTS: "registry.npmjs.org" },
  );
  const { dir, github, listener, send, restart } = ctx;
  assert.equal((await send(installed(), "installation")).status, 202);
  const issue = await github.waitFor(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues",
  );
  const created = JSON.parse(issue.body);
  assert.equal(created.title, "Set up Deckhand for this repository");
  assert.deepEqual(created.labels, ["deckhand-onboarding"]);
  assert.match(created.body, /^@alice installed Deckhand/);
  assert.ok(github.requests.some((r) => r.path === "/repos/org/repo/labels"));

  // The onboarding run: light, read-only, its prompt with the operator's frame and the reference.
  await until(() => onIssue30(github).length === 1, "the proposal");
  const reply = JSON.parse(onIssue30(github)[0].body).body;
  assert.match(
    reply,
    /onboarding: reply to change the proposal, `Deckhand` opens the pull request/,
  );
  assert.equal(lastRun(dir), "onboarding 1");
  const env = readFileSync(join(dir, "run-env"), "utf8");
  assert.match(env, /^TASK_ISSUE=$/m);
  assert.match(env, /^TASK_PROMPT=Onboard org\/repo with the maintainer, on GitHub issue #30/m);
  assert.match(env, /operator's `ALLOWED_HOSTS`: `registry\.npmjs\.org`/);
  assert.match(env, /Host mount roots granted to this repository: none/);
  assert.match(env, /## Reference: `\.deckhand\.yaml`[\s\S]*# Per-repo config/);
  const mints = () => github.requests.filter((r) => r.body.includes("repositories"));
  assert.equal(JSON.parse(mints().at(-1).body).permissions.contents, "read");
  assert.equal(JSON.parse(mints().at(-1).body).permissions.issues, "read");
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, "onboarding.json"), "utf8"))["org/repo"].issue,
    30,
  );
  await listener.until("done (ok)");

  // A comment without a trigger line: the same conversation, nothing pushed.
  await send(onIssue30Comment(100, "Looks good, but run the linter too."));
  await until(() => onIssue30(github).length === 2, "the updated proposal");
  assert.equal(lastRun(dir), "onboarding 1");
  assert.match(
    readFileSync(join(dir, "run-env"), "utf8"),
    /^TASK_MESSAGE=Looks good, but run the linter too\./m,
  );
  assert.equal(JSON.parse(mints().at(-1).body).permissions.contents, "read");

  // The trigger line: a work run with the onboarding prompt, and the branch's config checked.
  await send(onIssue30Comment(101, "Deckhand"));
  await until(() => onIssue30(github).length === 3, "the pull request reply");
  assert.equal(lastRun(dir), "work full");
  const work = readFileSync(join(dir, "run-env"), "utf8");
  assert.match(work, /^TASK_ISSUE=30$/m);
  assert.match(work, /^TASK_PROMPT=The maintainer confirmed the onboarding proposal/m);
  assert.equal(JSON.parse(mints().at(-1).body).permissions.pull_requests, "write");
  const done = JSON.parse(onIssue30(github)[2].body).body;
  assert.match(done, /^All done\./);
  assert.match(done, /`\.deckhand\.yaml` on `issue-30-deckhand-config` has errors/);
  assert.match(done, /- ❌ dockerfile: `\.deckhand\/Dockerfile` is not on the branch/);
  await listener.until("done (ok)");

  // A restart, then the App installed again: already onboarded, no second issue.
  await restart();
  await send(installed(), "installation");
  await ctx.listener.until("already onboarded (#30)");
  assert.equal(github.requests.filter((r) => r.path === "/repos/org/repo/issues").length, 1);
});

test("installed by someone not in ALLOWED_USERS, or with ONBOARDING=off: no issue", async (t) => {
  const { github, listener, send } = await listen(t);
  await send(installed("mallory"), "installation");
  await listener.until("mallory not in ALLOWED_USERS, no onboarding issue for org/repo");
  const off = await listen(t, {}, { ONBOARDING: "off" });
  await off.send(installed(), "installation");
  await off.listener.until("ONBOARDING=off, no onboarding issue for org/repo");
  for (const g of [github, off.github]) {
    assert.equal(
      g.requests.some((r) => r.path === "/repos/org/repo/issues"),
      false,
    );
  }
});

test("/mode onboarding alone on an issue starts the conversation by hand", async (t) => {
  const { dir, github, send } = await listen(
    t,
    {},
    { ONBOARDING: "off", BRAINSTORM_DEBOUNCE_MS: "0" },
  );
  await send(comment("alice", "/mode onboarding"));
  await until(() => replies(github).length === 1, "the proposal");
  assert.equal(lastRun(dir), "onboarding 1");
  assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_PROMPT=Onboard org\/repo/m);
  assert.equal(
    JSON.parse(readFileSync(join(dir, "onboarding.json"), "utf8"))["org/repo"].issue,
    12,
  );
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "modes.json"), "utf8")), {
    "org/repo#12": "onboarding",
  });
});

test("the dashboard and its logs are for allowed users signed in with GitHub", async (t) => {
  // GitHub's sign-in pages are the fake GitHub too. A built dashboard, and an older log with
  // no title.
  const { github, port, send, listener } = await listen(t, {}, (dir, github) => {
    const dist = join(dir, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<title>Deckhand</title>");
    writeFileSync(join(dist, "assets", "app-1a2b.js"), "export {}");
    writeFileSync(join(dir, "secret.js"), "nope");
    mkdirSync(join(dir, "logs"));
    const meta = { type: "listener", key: "org/repo#pr-3", repo: "org/repo", startedAt: 1000 };
    const result = { type: "result", result: "## Fixed\n\nThe typo.", duration_ms: 6000 };
    writeFileSync(
      join(dir, "logs", "org-repo-pr-3-1000.log"),
      `${JSON.stringify(meta)}\n${JSON.stringify(result)}\n`,
    );
    return { GITHUB_URL: github.url, DASHBOARD_DIR: dist };
  });
  const base = `http://127.0.0.1:${port}`;
  const get = (path, cookie) =>
    fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  // Signed out: a sign-in page, and nothing from the API.
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Sign in with GitHub/);
  assert.equal((await get("/api/state")).status, 401);
  for (const path of ["/assets/app-1a2b.js", "/index.html", "/nope.js"]) {
    assert.equal((await get(path)).status, 401);
  }
  // A run, so there is a log to stream; its title comes with the webhook.
  const titled = comment("alice");
  titled.issue.title = "Fix the queue";
  await send(titled);
  await listener.until("done (ok)");

  const login = await get("/auth/login");
  const to = new URL(login.headers.get("location"));
  assert.equal(to.pathname, "/login/oauth/authorize");
  assert.equal(to.searchParams.get("redirect_uri"), "https://hooks.example.com/auth/callback");
  const state = login.headers.getSetCookie()[0].split(";")[0];
  const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
  assert.equal(back.status, 302);
  const session = back.headers
    .getSetCookie()
    .find((c) => c.startsWith("deckhand_session="))
    .split(";")[0];
  assert.ok(github.requests.some((r) => r.path === "/user" && r.auth === "Bearer user-token"));

  const index = await get("/", session);
  assert.equal(index.headers.get("cache-control"), "no-store");
  assert.match(await index.text(), /<title>Deckhand<\/title>/);
  const asset = await get("/assets/app-1a2b.js", session);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /^text\/javascript/);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  await asset.text();
  for (const path of ["/assets/nope.js", "/../secret.js", "/assets/%2e%2e/%2e%2e/secret.js"]) {
    assert.equal((await get(path, session)).status, 404, path);
  }
  const board = await (await get("/api/state", session)).json();
  assert.equal(board.user, "alice");
  assert.equal(board.githubUrl, github.url);
  // The shape dashboard/src/types.ts expects: change both together.
  assertShape(board, STATE_KEYS, "State");
  for (const t of board.tasks) {
    assertShape(t, TASK_KEYS, "Task");
    for (const r of t.runs) assertShape(r, RUN_KEYS, "Run");
  }
  const [task] = board.tasks;
  assert.deepEqual(
    [task.key, task.project, task.state, task.title],
    ["org/repo#12", "org", "done", "Fix the queue"],
  );
  assert.equal(task.runs[0].title, "Fix the queue");
  assert.equal(task.runs[0].summary, "All done.");
  // The older task's title is fetched once, then shows.
  await github.waitFor((r) => r.method === "GET" && r.path === "/repos/org/repo/issues/3");
  const older = async () =>
    (await (await get("/api/state", session)).json()).tasks.find((x) => x.key === "org/repo#pr-3");
  let fetched = await older();
  for (let i = 0; i < 100 && !fetched.title; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    fetched = await older();
  }
  assert.equal(fetched.title, "An older pull request");
  assert.equal(fetched.runs[0].summary, "The typo.");
  // Its pull request too, without a readyAt: nothing to notify.
  for (let i = 0; i < 100 && !fetched.pr; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    fetched = await older();
  }
  assert.deepEqual(fetched.pr, {
    number: 3,
    url: "https://github.com/org/repo/pull/3",
    state: "ready",
    readyAt: null,
  });

  // A pull request that closes #12, from its webhooks: draft, then ready for review.
  const pr = (action, draft) => ({
    action,
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    pull_request: {
      number: 13,
      html_url: "https://github.com/org/repo/pull/13",
      body: "Closes #12",
      state: "open",
      draft,
      head: { ref: "issue-12-fix", repo: { full_name: "org/repo" } },
    },
    sender: { login: "deckhand[bot]" },
  });
  await send(pr("opened", true), "pull_request");
  await listener.until("org/repo#12: pull request #13 draft");
  await send(pr("ready_for_review", false), "pull_request");
  await listener.until("org/repo#12: pull request #13 ready");
  const ready = (await (await get("/api/state", session)).json()).tasks.find(
    (x) => x.key === "org/repo#12",
  );
  assert.equal(ready.pr.number, 13);
  assert.equal(ready.pr.state, "ready");
  assert.ok(ready.pr.readyAt > 0);
  const stream = await get(`/api/runs/${task.runs[0].id}/stream`, session);
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /event: end/);
  assert.equal((await get(`/api/runs/${task.runs[0].id}/stream`)).status, 401);
});

// dashboard/src/types.ts, key by key: [required, optional].
const STATE_KEYS = [
  ["user", "tasks", "states", "running", "queued", "maxParallel", "githubUrl", "now"],
  ["previews"],
];
const TASK_KEYS = [
  [
    "key",
    "repo",
    "project",
    "number",
    "title",
    "kind",
    "mode",
    "replyTo",
    "state",
    "since",
    "pr",
    "runs",
  ],
  ["deadline"],
];
const RUN_KEYS = [
  [
    "id",
    "key",
    "kind",
    "title",
    "repo",
    "replyTo",
    "mode",
    "taskMode",
    "startedAt",
    "finishedAt",
    "status",
  ],
  ["model", "effort", "phase", "summary", "delivered"],
];

function assertShape(value, [required, optional], name) {
  const keys = Object.keys(value);
  const unknown = keys.filter((k) => !required.includes(k) && !optional.includes(k));
  assert.deepEqual(unknown, [], `${name}: keys types.ts doesn't have`);
  const missing = required.filter((k) => !keys.includes(k));
  assert.deepEqual(missing, [], `${name}: keys types.ts requires`);
}

test("/status answers calls from inside the container without a session", async (t) => {
  const { port } = await listen(t);
  const res = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).idle, true);
});
