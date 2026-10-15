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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

const SECRET = "webhook-secret";
// A read-write mount needs every directory from / to its parent out of the sandbox's user's
// reach (uid 1000, maybe the tests' own), which a temp dir isn't: /usr is root's everywhere.
// The fake docker mounts nothing.
const RW_MOUNT = "/usr";

// Sandboxes run detached: `run` starts the fake sandbox in the background (its output in
// containers/<name>/out), `logs --follow` tails it, `ps`, `inspect`, `wait` and `rm` see it.
// Each run's network is a file in nets/, listing the containers joined to it: the sandbox,
// the listener (whatever its host name) and the egress proxy, `egress-1`, whose address is
// 127.0.0.1 (the fake sandbox asks the egress policy from there).
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
    case "$*" in *deckhand.role=egress*) echo egress-1; exit ;; esac
    for d in "$c"/*/; do
      [ -d "$d" ] || continue
      n=$(basename "$d")
      alive "$n" && state=running || state=exited
      printf '%s\\t%s\\t%s\\n' "$n" "$(cat "$d/run")" "$state"
    done ;;
  wait)
    while alive "\${@: -1}"; do sleep 0.05; done ;;
  rm)
    n=\${@: -1}
    [ -f "$c/$n/run" ] && sed -i "/^$n\$/d" "${dir}/nets/$(cat "$c/$n/run")" 2> /dev/null
    rm -rf "$c/$n" ;;
  logs)
    n=\${@: -1}
    [ -d "$c/$n" ] || exit 1
    exec tail -n +1 -f --pid="$(cat "$c/$n/pid")" -s 0.05 "$c/$n/out" ;;
  network)
    n=\${@: -1}
    net=\${@: -2:1}
    case "$2" in
      create)
        echo "$*" >> "${dir}/docker-calls"
        mkdir -p "${dir}/nets" && : > "${dir}/nets/$n" ;;
      inspect)
        [ -f "${dir}/nets/$n" ] || exit 1
        case "$*" in
          *Containers*) tr '\n' ' ' < "${dir}/nets/$n" ;;
          # Internal unless the test says otherwise.
          *) cat "${dir}/network-internal" 2> /dev/null || echo true ;;
        esac ;;
      connect)
        echo "$*" >> "${dir}/docker-calls"
        [ -f "${dir}/nets/$net" ] || exit 1
        echo "$n" >> "${dir}/nets/$net" ;;
      disconnect)
        sed -i "/^$n\$/d" "${dir}/nets/$net" ;;
      rm)
        echo "$*" >> "${dir}/docker-calls"
        rm -f "${dir}/nets/$n" ;;
      ls)
        ls "${dir}/nets" 2> /dev/null ;;
    esac ;;
  inspect)
    n=\${@: -1}
    case "$3" in
      *State*)
        [ -d "$c/$n" ] || exit 1
        alive "$n" && echo running || echo exited ;;
      *compose.project*) echo deckhand ;;
      *deckhand.run*)
        [ -d "$c/$n" ] || exit 1
        cat "$c/$n/run" ;;
      # A sandbox's address on its network, for the egress proxy's questions; the listener's
      # and the proxy's on each network they are joined to.
      *)
        if [ -d "$c/$n" ]; then
          printf '{"%s":{"IPAddress":"10.9.0.5"}}\\n' "$(cat "$c/$n/run")"
          exit
        fi
        ip=10.9.0.1
        [ "$n" = egress-1 ] && ip=127.0.0.1
        printf '{"deckhand_default":{"IPAddress":"%s"}' "$ip"
        for f in "${dir}"/nets/*; do
          [ -f "$f" ] && grep -qx -- "$n" "$f" && printf ',"%s":{"IPAddress":"%s"}' "$(basename "$f")" "$ip"
        done
        echo "}" ;;
    esac ;;
  volume)
    # The volumes a test says exist (one name per line in ${dir}/volumes).
    if [ "$2" = inspect ]; then grep -qx -- "\${@: -1}" "${dir}/volumes" 2> /dev/null; exit; fi
    [ "$2" = ls ] && exit
    echo "$*" >> "${dir}/docker-calls" ;;
  image)
    # Asked while the run is prepared, so a test can change things then.
    [ "$2" = inspect ] && [ -x "${dir}/while-preparing" ] && "${dir}/while-preparing"
    # The base image exists; repo images don't, until built.
    [ "$2" = inspect ] && case "$*" in *-repo-*) exit 1 ;; *) echo sha256:base ;; esac ;;
  create|cp|start)
    # A preview hook's container.
    echo "$*" >> "${dir}/docker-calls" ;;
  build)
    echo "$*" >> "${dir}/docker-calls"
    # The build context is the repo's checkout.
    cp "\${@: -1}/docker/Dockerfile" "${dir}/built-dockerfile" ;;
  info)
    echo '{"runc":{}}' ;;
  run)
    case "$*" in *--entrypoint*) echo "$*" >> "${dir}/docker-calls"; exit 0 ;; esac
    # A run's container engine: its arguments, one per line, and nothing runs.
    case "$*" in *"--network-alias engine"*) printf '%s\n' "$@" > "${dir}/engine-args"; exit 0 ;; esac
    name=$(printf '%s\\n' "$@" | grep -A1 -x -- --name | tail -1)
    run=$(printf '%s\\n' "$@" | sed -n 's/^deckhand\\.run=//p')
    mkdir -p "$c/$name"
    echo "$run" > "$c/$name/run"
    # On its run's network before run-args tells a test it started.
    echo "$name" >> "${dir}/nets/$run"
    # Each file renamed into place, so a test never reads one half-written; run-args last:
    # tests wait for it, then read the others. (Not .tmp: tests look for leftover state writes.)
    echo "$DECKHAND_RUN_SECRET" > "${dir}/run-secret.part" && mv "${dir}/run-secret.part" "${dir}/run-secret"
    env > "${dir}/run-env.part" && mv "${dir}/run-env.part" "${dir}/run-env"
    printf '%s\\n' "$@" > "${dir}/run-args.part" && mv "${dir}/run-args.part" "${dir}/run-args"
    setsid bash -c '
      curl -fsS -H "Authorization: Bearer $DECKHAND_RUN_SECRET" "$DECKHAND_BROKER_URL/token" \\
        > "${dir}/broker-answer"
      # What the egress proxy would ask about this sandbox'"'"'s connections.
      for host in api.anthropic.com github.com objects.githubusercontent.com evil.example \\
        registry.npmjs.org pypi.org a.b.example.com example.com lan.internal; do
        echo "$host $(curl -fsS "$DECKHAND_BROKER_URL/egress?ip=10.9.0.5&host=$host")" \\
          >> "${dir}/egress"
      done
      # Claude Code'"'"'s API call, through the listener, with the run'"'"'s secret.
      bearer="\${ANTHROPIC_AUTH_TOKEN:-\$CLAUDE_CODE_OAUTH_TOKEN}"
      if [ -n "$bearer" ]; then
        curl -sS -X POST -H "Authorization: Bearer $bearer" \\
          -d "{}" "$ANTHROPIC_BASE_URL/v1/messages?beta=true" > "${dir}/anthropic-answer"
      fi
      # Not all of stdout is Claude'"'"'s: gh prints the draft pull request'"'"'s address.
      echo "https://github.com/org/repo/pull/13"
      if [ -e "${dir}/hold" ]; then
        until [ -e "${dir}/go" ]; do sleep 0.05; done
      fi
      result="All done."
      # A run talked into posting secrets: its own, and whatever the test leaves in leak.
      [ -e "${dir}/leak" ] && result="Leaked $DECKHAND_RUN_SECRET and $(cat "${dir}/leak")."
      echo "{\\"type\\":\\"result\\",\\"result\\":\\"$result\\",\\"duration_ms\\":60000}"
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
  // Requests left unanswered until the test lets them go (hold()).
  const holds = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const entry = {
        method: req.method,
        path: req.url,
        auth: req.headers.authorization,
        body,
      };
      requests.push(entry);
      for (const w of [...waiters]) if (w.match(entry)) w.resolve(entry);
      for (const h of holds) if (h.match(entry)) await h.released;
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
      // What a comment waits for ("/after #77"): the test sets its state, as JSON.
      const waitedFor = /^\/repos\/org\/repo\/issues\/(\d+)$/.exec(req.url);
      if (req.method === "GET" && waitedFor && files[`issue:${waitedFor[1]}`]) {
        return res.end(files[`issue:${waitedFor[1]}`]);
      }
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
          JSON.stringify([
            {
              number: 31,
              head: { ref: "issue-30-deckhand-config", repo: { full_name: "org/repo" } },
              body: "",
            },
          ]),
        );
      }
      // Pull requests a comment can come from: a maintainer's branch, a fork's.
      if (req.method === "GET" && req.url === "/repos/org/repo/pulls/40") {
        const head = { ref: "feature/maintainer", repo: { full_name: "org/repo" } };
        return res.end(JSON.stringify({ number: 40, head }));
      }
      if (req.method === "GET" && req.url === "/repos/org/repo/pulls/41") {
        const head = { ref: "feature/x", repo: { full_name: "someone/repo" } };
        return res.end(JSON.stringify({ number: 41, head }));
      }
      // Pull requests saying they close #3: from a branch of the repo, from a fork.
      if (req.method === "GET" && req.url === "/repos/org/repo/pulls/42") {
        const head = { ref: "issue-3-fix", repo: { full_name: "org/repo" } };
        return res.end(JSON.stringify({ number: 42, body: "Closes #3", head }));
      }
      if (req.method === "GET" && req.url === "/repos/org/repo/pulls/43") {
        const head = { ref: "issue-3-fix", repo: { full_name: "mallory/repo" } };
        return res.end(JSON.stringify({ number: 43, body: "Closes #3", head }));
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
      // The listener lists the App's repos when it starts: none here, so a real error in its
      // startup log stands out.
      if (req.url.startsWith("/app/installations?")) return res.end(JSON.stringify([{ id: 7 }]));
      if (req.url.startsWith("/installation/repositories?")) {
        return res.end(JSON.stringify({ repositories: [] }));
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
  // Holds back the answers to requests that `match`, until the returned function is called.
  const hold = (match) => {
    let release;
    holds.push({ match, released: new Promise((resolve) => (release = resolve)) });
    return () => release();
  };
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    waitFor,
    hold,
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

// Each test runs its own listener, fake GitHub and fake Docker in its own temp dir, on ports
// the OS picks, and mostly waits on them: they run side by side, two per core (eight at most).
describe("listener", { concurrency: Math.min(8, 2 * availableParallelism()) }, () => {
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
  // The operator's grant for org/repo, in the test's grants folder.
  function writeGrant(dir, text) {
    mkdirSync(join(dir, "grants", "org"), { recursive: true });
    writeFileSync(join(dir, "grants", "org", "repo.yaml"), text);
  }

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
      BRAINSTORM_DEBOUNCE_MS: "0",
      // The egress proxy asks from here: in the tests, the fake sandbox itself.
      EGRESS_PROXY: "http://127.0.0.1:3128",
      GRANTS_DIR: join(dir, "grants"),
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
    // Issue 12 has a session from before names had a hash, and a run that had that name;
    // issue 14 has none. org/repo-pr #5 had one too, whose old name is org/repo #pr-5's.
    const { dir, github, send, listener } = await listen(t, {}, (dir) => {
      mkdirSync(join(dir, "logs"));
      for (const [key, id] of [
        ["org/repo#12", "deckhand-org-repo-12-1000"],
        ["org/repo-pr#5", "deckhand-org-repo-pr-5-1000"],
      ]) {
        const meta = { type: "listener", key, repo: key.split("#")[0], startedAt: 1000 };
        writeFileSync(join(dir, "logs", `${id}.log`), `${JSON.stringify(meta)}\n`);
      }
      return {};
    });
    writeFileSync(
      join(dir, "volumes"),
      ["deckhand-org-repo-12-claude", "deckhand-org-repo-pr-5-claude", ""].join("\n"),
    );
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
    await listener.until(/org\/repo#14: done/);
    // Pull request 5 of org/repo: the other repo's session isn't its own.
    await send({ ...comment("alice"), issue: { number: 5, pull_request: {} } });
    await github.waitFor((r) => r.path === "/repos/org/repo/issues/5/comments");
    assert.match(name()[0], /^deckhand-org-repo-pr-5-[0-9a-f]{10}$/);
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

  test("unsigned or oversized deliveries are refused unread; one client gets only its share of places", async (t) => {
    const { port, listener } = await listen(t);
    const signed = { "x-github-event": "issue_comment", "x-hub-signature-256": "sha256=00" };
    assert.equal(
      await headersOnly(port, { "x-github-event": "issue_comment", "content-length": "100" }),
      401,
    );
    assert.equal(
      await headersOnly(port, { ...signed, "content-length": String(6 * 1024 * 1024) }),
      413,
    );
    await listener.until("Rejected a delivery: over 5242880 bytes");
    assert.match(listener.output(), /Rejected a delivery: no signature/);
    // One client holds its share of the places, 4, with stalled bodies: its 5th is refused...
    const held = [];
    for (let i = 0; i < 4; i++) {
      const req = request({ port, method: "POST", path: "/webhook", headers: signed });
      req.on("error", () => {});
      req.write("{");
      held.push(req);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await headersOnly(port, signed), 503);
    await listener.until("no place to read a delivery from 127.0.0.1");
    // ...while a signed delivery from another address gets through.
    const body = JSON.stringify(comment("mallory"));
    const delivered = await new Promise((resolve, reject) => {
      const req = request(
        {
          port,
          method: "POST",
          path: "/webhook",
          localAddress: "127.0.0.2",
          headers: {
            "x-github-event": "issue_comment",
            "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
          },
        },
        (res) => (res.resume(), resolve(res.statusCode)),
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(delivered, 202);
    // The stalled bodies are dropped after 2 seconds without data.
    await listener.until("Rejected a delivery: no data for 2000 ms");
    for (const req of held) req.destroy();
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

  test("the Claude credential stays out of sandboxes, and a reply leaking secrets is redacted", async (t) => {
    const credential = "sk-ant-oat01-operator-credential";
    const { dir, github, send, listener } = await listen(
      t,
      (dir) => (writeFileSync(join(dir, "leak"), credential), {}),
      (dir, github) => ({ CLAUDE_CODE_OAUTH_TOKEN: credential, ANTHROPIC_BASE_URL: github.url }),
    );
    await send(comment("alice"));
    const reply = await github.waitFor((r) => r.path === "/repos/org/repo/issues/12/comments");
    await listener.until("done (ok)");

    // The sandbox has the run's secret where the credential would be, and the listener's URL.
    const secret = readFileSync(join(dir, "run-secret"), "utf8").trim();
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.ok(!runEnv.includes(credential));
    assert.match(runEnv, new RegExp(`^CLAUDE_CODE_OAUTH_TOKEN=${secret}$`, "m"));
    assert.doesNotMatch(runEnv, /^ANTHROPIC_API_KEY=/m);
    assert.match(runEnv, /^ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+\/anthropic$/m);

    // Its API call reached "Anthropic" with the operator's credential, not the secret.
    const call = await github.waitFor((r) => r.path === "/v1/messages?beta=true");
    assert.equal(call.auth, `Bearer ${credential}`);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "anthropic-answer"), "utf8")), { id: 1 });

    // Neither secret is posted, nor stored in the run's log. The run's saved state keeps its
    // secret until the run is cleaned up, just after "done": wait for that first.
    const body = JSON.parse(reply.body).body;
    assert.match(body, /^Leaked \[redacted\] and \[redacted\]\./);
    assert.ok(!body.includes(secret) && !body.includes(credential));
    await until(
      () => !readdirSync(join(dir, "logs")).some((f) => f.endsWith(".live.json")),
      "the run's state to go",
    );
    for (const file of readdirSync(join(dir, "logs"))) {
      const log = readFileSync(join(dir, "logs", file), "utf8");
      assert.ok(!log.includes(secret) && !log.includes(credential));
    }
  });

  test("through a gateway: its token stays out too, and opus means the gateway's model", async (t) => {
    const credential = "sk-or-v1-operator-gateway-token";
    const { dir, github, send, listener } = await listen(t, {}, (dir, github) => ({
      ANTHROPIC_AUTH_TOKEN: credential,
      ANTHROPIC_API_KEY: "sk-ant-api03-ignored-for-the-gateway",
      ANTHROPIC_BASE_URL: `${github.url}/api/`,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.1",
      SANDBOX_MODEL: "openai/gpt-5",
    }));
    await send(comment("alice"));
    await listener.until("done (ok)");

    const secret = readFileSync(join(dir, "run-secret"), "utf8").trim();
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.ok(!runEnv.includes(credential));
    assert.match(runEnv, new RegExp(`^ANTHROPIC_AUTH_TOKEN=${secret}$`, "m"));
    // Only the variables named with -e reach the container: not the unused API key.
    const passed = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.ok(passed.includes("ANTHROPIC_AUTH_TOKEN"));
    assert.ok(!passed.includes("ANTHROPIC_API_KEY") && !passed.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    assert.match(runEnv, /^ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+\/anthropic$/m);
    assert.match(runEnv, /^ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic\/claude-opus-4\.1$/m);
    assert.doesNotMatch(runEnv, /^ANTHROPIC_DEFAULT_SONNET_MODEL=/m);
    assert.match(runEnv, /^SANDBOX_MODEL=openai\/gpt-5$/m);

    // The call reached the gateway under its own path, with its token as a bearer.
    const call = await github.waitFor((r) => r.path === "/api/v1/messages?beta=true");
    assert.equal(call.auth, `Bearer ${credential}`);
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
    // uid 1000 whatever the image's USER says.
    assert.match(joined, /--user 1000:1000/);
    assert.match(joined, /--cpus 2 --memory 4g --memory-swap 4g --pids-limit 2048/);
    const shots = runEnv.match(/^SCREENSHOT_URL=https:\/\/hooks\.example\.com\/shots\/(\w+)$/m)[1];
    assert.ok(
      args.includes(
        `type=volume,src=deckhand-screenshots,dst=/screenshots,volume-subpath=${shots}`,
      ),
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
      {
        headers: { authorization: `Basic ${Buffer.from(`deckhand:${secret}`).toString("base64")}` },
      },
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
    const { dir, github, listener, send } = await listen(
      t,
      {
        ".deckhand.yaml": CONFIG,
        "docker/Dockerfile": "ARG DECKHAND_BASE\nFROM $DECKHAND_BASE\nRUN true\n",
      },
      (dir) => {
        writeGrant(dir, "allow_dockerfile: true\n");
        return {};
      },
    );
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
    // No engine without `docker`: no DOCKER_HOST either.
    assert.throws(() => readFileSync(join(dir, "engine-args")));
    assert.doesNotMatch(args.join("\n"), /DOCKER_HOST/);
    assert.match(runEnv, /^SANDBOX_SETUP=npm ci$/m);
    assert.match(runEnv, /^SANDBOX_INSTRUCTIONS=docs\/agents\.md$/m);
    assert.match(runEnv, /^SANDBOX_MODEL=sonnet$/m);
  });

  test("a Dockerfile or preview hook without its grant stops the run, and nothing is built", async (t) => {
    const { dir, github, listener, send } = await listen(t, {
      ".deckhand.yaml": `${CONFIG}preview: ./preview.sh\ndocker: true\n`,
      "docker/Dockerfile": "ARG DECKHAND_BASE\nFROM $DECKHAND_BASE\nRUN true\n",
    });
    await send(comment("alice"));
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    const body = JSON.parse(reply.body).body;
    assert.match(body, /`\.deckhand\.yaml` on `trunk` has errors/);
    assert.match(body, /- preview: .* don't set `allow_preview: true` for this repository/);
    assert.match(body, /- dockerfile: .* don't set `allow_dockerfile: true` for this repository/);
    assert.match(body, /- docker: .* don't set `allow_docker: true` for this repository/);
    await listener.until("asks for what its grant doesn't allow");
    // No build, no sandbox: no docker call was even logged.
    assert.throws(() => readFileSync(join(dir, "docker-calls")));
    assert.throws(() => readFileSync(join(dir, "run-args")));
  });

  test("a preview hook runs only with allow_preview", async (t) => {
    const delivery = {
      action: "opened",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      pull_request: { number: 13 },
      sender: { login: "mallory" },
    };
    const { dir, listener, send } = await listen(t, {
      ".deckhand.yaml": "preview:\n  command: ./preview.sh\n  image: docker:cli\n",
      Dockerfile: "FROM scratch\n",
    });
    const calls = () => {
      try {
        return readFileSync(join(dir, "docker-calls"), "utf8");
      } catch {
        return "";
      }
    };
    assert.equal((await send(delivery, "pull_request")).status, 202);
    await listener.until(
      "preview hook of org/repo not run: preview: the operator's grants don't set `allow_preview: true`",
    );
    assert.doesNotMatch(calls(), /^create /m);
    writeGrant(dir, "allow_preview: true\n");
    await send({ ...delivery, action: "synchronize" }, "pull_request");
    await listener.until("preview hook deckhand-preview-org-repo-");
    assert.match(calls(), /^create .*docker\.sock.* docker:cli .*\.\/preview\.sh$/m);
  });

  test("a broken grant file stops that repo's runs, not the listener", async (t) => {
    const { github, listener, send } = await listen(t, {}, (dir) => {
      writeGrant(dir, "hosts: [bad host]\n");
      return {};
    });
    // Said at start; the listener starts anyway.
    await listener.until("grants: org/repo.yaml: hosts:");
    await send(comment("alice"));
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    const { body } = JSON.parse(reply.body);
    assert.match(body, /`org\/repo\.yaml` in the operator's grants folder has errors/);
    // The details stay in the listener's logs.
    assert.doesNotMatch(body, /bad host/);
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
  - path: ${RW_MOUNT}
    read_only: false
  - path: ${dir}/nfs/docs
`,
      }),
      (dir) => {
        mkdirSync(join(dir, "nfs", "docs"), { recursive: true });
        writeGrant(
          dir,
          `hosts: [pypi.org]
allow_repo_hosts: true
limits: { memory: 8g }
mounts:
  - root: ${RW_MOUNT}
    read_only: false
  - ${join(dir, "nfs")}
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
    // The operator's hosts may resolve to private addresses; the repo's own may not (proxy.mjs).
    assert.equal(egress["pypi.org"].private, true);
    assert.equal(egress["a.b.example.com"].private, false);
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    const joined = args.join(" ");
    assert.match(joined, /--cpus 2 --memory 8g --memory-swap 8g --pids-limit 2048/);
    assert.ok(args.includes(`type=bind,src=${RW_MOUNT},dst=${RW_MOUNT}`));
    assert.ok(
      args.includes(
        `type=bind,src=${join(dir, "nfs", "docs")},dst=${join(dir, "nfs", "docs")},readonly`,
      ),
    );
  });

  test("once its sandbox exits, a run's hosts no longer answer for its address", async (t) => {
    const { github, brokerPort, send } = await listen(t, {});
    // The reply takes its time: Docker could give the address to another sandbox meanwhile.
    const reply = (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments";
    const release = github.hold(reply);
    t.after(release);
    assert.equal((await send(comment("alice"))).status, 202);
    await github.waitFor(reply);
    const asked = await fetch(`http://127.0.0.1:${brokerPort}/egress?ip=10.9.0.5&host=github.com`);
    assert.deepEqual(await asked.json(), { allowed: false, private: false });
    release();
  });

  test("a repo's hosts without allow_repo_hosts: refused on the issue, unless already allowed", async (t) => {
    const { dir, github, send } = await listen(
      t,
      { ".deckhand.yaml": 'hosts: [registry.npmjs.org, pypi.org, "*.evil.net"]\n' },
      (dir) => {
        writeGrant(dir, "hosts: [pypi.org]\n");
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
        writeGrant(dir, `mounts: [${join(dir, "nfs")}]\n`);
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
        writeGrant(dir, `mounts: [${join(dir, "nfs")}]\n`);
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

  test("a run's network with a route out stops the run", async (t) => {
    const { dir, github, send } = await listen(t, {}, (dir) => {
      writeFileSync(join(dir, "network-internal"), "false\n");
      return {};
    });
    await send(comment("alice"));
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(
      JSON.parse(reply.body).body,
      /^Claude couldn't start: the run's network deckhand-org-repo-12-\S+ is not internal/,
    );
    // Neither the sandbox nor its network is left.
    assert.throws(() => readFileSync(join(dir, "run-args")));
    assert.deepEqual(readdirSync(join(dir, "nets")), []);
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

  // A listener whose sandbox waits (`hold`) before Claude's first answer, with a run started by
  // a comment saying `body`.
  async function holding(t, body) {
    const ctx = await listen(t, {}, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    await ctx.send(comment("alice", body));
    const egress = join(ctx.dir, "egress");
    await until(() => exists(egress)?.trim().split("\n").length === 9, "the sandbox");
    return ctx;
  }

  // The comments' outcome reactions: the last thing a finished run does, its reply posted.
  async function settled(github, ids) {
    for (const id of ids) {
      await github.waitFor(
        (r) =>
          r.path === `/repos/org/repo/issues/comments/${id}/reactions` && /rocket/.test(r.body),
      );
    }
  }

  // What the running sandbox's secret gets from the git gateway and from `gh pr ready`.
  async function pushAndReady({ dir, brokerPort }) {
    const secret = readFileSync(join(dir, "run-secret"), "utf8").trim();
    const basic = Buffer.from(`deckhand:${secret}`).toString("base64");
    const push = await fetch(
      `http://127.0.0.1:${brokerPort}/git/org/repo.git/info/refs?service=git-receive-pack`,
      { headers: { authorization: `Basic ${basic}` } },
    );
    const ready = await fetch(`http://127.0.0.1:${brokerPort}/pr/org/repo/13/ready`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    return [`${push.status} ${await push.text()}`, `${ready.status} ${await ready.text()}`];
  }

  test("a brainstorm can't push or mark a pull request ready, before or after a restart", async (t) => {
    const ctx = await holding(t, "Deckhand\n/mode brainstorm\nWhat about dark mode?");
    const refused = [/^403 Deckhand: this run can't push/, /^403 .*can't change pull requests/];
    const check = async () => {
      const answers = await pushAndReady(ctx);
      answers.forEach((answer, i) => assert.match(answer, refused[i]));
    };
    await check();
    assert.match(readFileSync(join(ctx.dir, "run-env"), "utf8"), /^SANDBOX_LIGHT=1$/m);
    await ctx.restart();
    await ctx.listener.until("again");
    await check();
  });

  test("a work run still pushes and marks ready, before and after a restart", async (t) => {
    const ctx = await holding(t);
    // Past the run checks: on to GitHub (here, a fake one that knows neither).
    const check = async () => {
      for (const answer of await pushAndReady(ctx)) {
        assert.doesNotMatch(answer, /^401|can't push|can't change pull requests/);
      }
    };
    await check();
    await ctx.restart();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    await check();
  });

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
    // Both comments get their outcome.
    await settled(github, [99, 100]);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^Answered\./);
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

  test("a recreated listener and proxy join the running sandbox's network again", async (t) => {
    const ctx = await holding(t);
    const { dir } = ctx;
    const [net] = readdirSync(join(dir, "nets"));
    const joined = () =>
      readFileSync(join(dir, "nets", net), "utf8")
        .split("\n")
        .filter(Boolean);
    // Its own network: the sandbox, the listener (its host name) and the proxy.
    assert.equal(joined().length, 3);
    assert.ok(joined().includes("egress-1"));
    // Left by a run nobody knows about any more.
    writeFileSync(join(dir, "nets", "deckhand-gone-1"), "egress-1\n");
    // `docker compose up -d`: new containers, on none of the runs' networks.
    writeFileSync(join(dir, "nets", net), joined()[0] + "\n");
    await ctx.restart({ LISTENER_CONTAINER: "listener-2", EGRESS_CONTAINER: "egress-2" });
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    assert.ok(joined().includes("listener-2"));
    assert.ok(joined().includes("egress-2"));
    const calls = readFileSync(join(dir, "docker-calls"), "utf8");
    assert.match(calls, new RegExp(`^network connect ${net} listener-2$`, "m"));
    assert.deepEqual(readdirSync(join(dir, "nets")), [net]);
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    // The run's network goes with it.
    await until(() => !readdirSync(join(dir, "nets")).length, "the network's removal");
    assert.match(
      calls + readFileSync(join(dir, "docker-calls"), "utf8"),
      new RegExp(`^network rm ${net}$`, "m"),
    );
  });

  test("a comment queued for a running session is checked against the repo's users after a restart", async (t) => {
    const files = { ".deckhand.yaml": "users: [alice, bob]\n" };
    const ctx = await listen(t, files, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    const { dir } = ctx;
    await ctx.send(comment("alice"));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 9, "the sandbox");
    // Bob's comment waits out a long pause for the running session, then the listener stops.
    await ctx.restart({ DEBOUNCE_MS: "60000" });
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    await ctx.send({
      ...followUp(100, "Also delete the tests"),
      comment: { id: 100, body: "Also delete the tests", user: { login: "bob", type: "User" } },
    });
    await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/100/reactions");
    // Meanwhile, the repo's users leave bob out.
    files[".deckhand.yaml"] = "users: [alice]\n";
    const { output } = await ctx.restart({ DEBOUNCE_MS: "0" });
    assert.match(output, /Saved 1 task\(s\) with queued comments/);
    await ctx.listener.until("a queued comment dropped: bob is no longer an allowed user");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [run] = readdirSync(join(dir, "runs"));
    assert.doesNotMatch(exists(join(dir, "runs", run, "inbox.jsonl")) ?? "", /delete the tests/);
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
  });

  test("a listener killed mid-run: Claude answers meanwhile, the next one replies once", async (t) => {
    const ctx = await holding(t);
    const { dir, github } = ctx;
    // Claude answers while no listener is there: the sandbox waits for its inbox to close.
    const killed = ctx.listener.child;
    killed.kill("SIGKILL");
    await new Promise((resolve) => killed.on("exit", resolve));
    writeFileSync(join(dir, "go"), "");
    const [name] = readdirSync(join(dir, "containers"));
    const out = join(dir, "containers", name, "out");
    await until(() => exists(out)?.includes('"type":"result"'), "Claude's answer");
    await ctx.restart();
    await ctx.listener.until("done (ok)");
    await settled(github, [99]);
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

  test("a comment queued before a restart doesn't run once its author left ALLOWED_USERS", async (t) => {
    const ctx = await listen(t, {}, { DEBOUNCE_MS: "60000" });
    await ctx.send(comment("alice"));
    await ctx.listener.until("queued (work");
    await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/99/reactions");
    // Stopped first, to see what it leaves: the queue, the owner's only.
    const { child } = ctx.listener;
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    assert.equal(statSync(join(ctx.dir, "queue.json")).mode & 0o777, 0o600);
    await ctx.restart({ DEBOUNCE_MS: "0", ALLOWED_USERS: "bob" });
    await ctx.listener.until("dropped: alice is no longer an allowed user");
    // Its 👀 goes, and nothing runs.
    await ctx.github.waitFor(
      (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/comments/99/reactions/1",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(ctx.dir, "run-args")), null);
    assert.equal(replies(ctx.github).length, 0);
  });

  test("a comment whose author leaves the repo's users while it waits doesn't run", async (t) => {
    const files = { ".deckhand.yaml": "users: [alice, bob]\n" };
    const ctx = await listen(t, files, { DEBOUNCE_MS: "300" });
    await ctx.send(comment("alice"));
    await ctx.listener.until("queued (work");
    files[".deckhand.yaml"] = "users: [bob]\n";
    await ctx.listener.until("a queued comment dropped: alice is no longer an allowed user");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(ctx.dir, "run-args")), null);
    // The queue goes on: bob's comment runs.
    await ctx.send({
      ...comment("bob"),
      comment: { id: 100, body: "Deckhand", user: { login: "bob", type: "User" } },
    });
    await ctx.listener.until("done (ok)");
  });

  test("a comment on a pull request saying Closes #3 joins #3 only from a branch of the repo", async (t) => {
    const { github, send, listener } = await listen(t);
    const onPull = (number, id) => {
      const payload = comment("alice");
      // Opened by someone else than the App: its head is looked up.
      payload.issue = {
        number,
        body: "Closes #3",
        pull_request: {},
        user: { login: "github-actions[bot]", type: "Bot" },
        author_association: "NONE",
      };
      payload.comment = { ...payload.comment, id };
      return payload;
    };
    await send(onPull(42, 101));
    await listener.until("org/repo#3: queued");
    await listener.until("done (ok)");
    await send(onPull(43, 102));
    await listener.until("org/repo#pr-43: queued");
    assert.match(listener.output(), /org\/repo#pr-43: says it closes #3, not linked/);
    await listener.until(/org\/repo#pr-43: done \(ok\)/);
    assert.ok(github.requests.some((r) => r.path === "/repos/org/repo/pulls/43"));
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
    await settled(github, [99, 100]);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^Answered\./);
    // Both answers once each in the run's log, and the duration of both in the footer.
    const [log] = readdirSync(join(dir, "logs")).filter((f) => f.endsWith(".log"));
    const text = readFileSync(join(dir, "logs", log), "utf8");
    assert.equal(text.match(/"type":"result"/g).length, 2);
    assert.equal(text.match(/pull\/13/g).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, / · 1\.1 min/);
  });

  test("open questions label an issue; an allowed user's answer takes the label off", async (t) => {
    const { github, send, listener } = await listen(t, {});
    const labels = "/repos/org/repo/issues/12/labels";
    const issue = (body, labelled) => ({
      action: "opened",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      issue: {
        number: 12,
        title: "An idea",
        state: "open",
        body,
        user: { login: "deckhand-x[bot]", type: "Bot" },
        labels: labelled ? [{ name: "needs-input" }] : [],
      },
      sender: { login: "deckhand-x[bot]", type: "Bot" },
    });
    // Filed by an inbox run: "None" labels nothing, questions do.
    await send(issue("## Open questions\n\nNone.", false), "issues");
    await listener.until("Delivery: issues opened");
    await send(issue("## Open questions\n\n1. Which one?", false), "issues");
    const added = await github.waitFor((r) => r.method === "POST" && r.path === labels);
    assert.deepEqual(JSON.parse(added.body), { labels: ["needs-input"] });
    await listener.until("org/repo#12: open questions, labelled");
    // Someone not allowed answering doesn't count; alice does.
    const answer = (login) => {
      const c = comment(login, "1. That one");
      c.issue = { ...issue("", true).issue };
      return c;
    };
    await send(answer("mallory"));
    await listener.until("mallory not in ALLOWED_USERS");
    await send(answer("alice"));
    await github.waitFor((r) => r.method === "DELETE" && r.path === `${labels}/needs-input`);
    await listener.until("org/repo#12: answered, label removed");
    assert.equal(github.requests.filter((r) => r.path.startsWith(labels)).length, 2);
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
    await listener.until(`category "General" doesn't call Deckhand`);
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
        writeGrant(dir, "hosts: [pypi.org]\nallow_repo_hosts: true\n");
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
    const { dir, github, listener, send } = await listen(t);
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
    // The trigger alone implements, in a session of its own (the brainstorm's is light).
    await send(followUp(102, "Deckhand\nGo with the second option."));
    await until(() => replies(github).length === 4, "the work reply");
    assert.equal(lastRun(dir), "work full");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_SESSION=$/m);
    assert.equal(brainstormOf(dir), undefined);
  });

  test("/after #77: waits, through a restart, and runs the comment once #77 is done", async (t) => {
    const files = { "issue:77": JSON.stringify({ state: "open" }) };
    const { dir, github, send, restart } = await listen(t, files);
    await send(
      comment("alice", "Deckhand /after #77\n/effort high\nDo it on top of the new parser."),
    );
    await until(() => replies(github).length === 1, "the waiting reply");
    assert.match(
      JSON.parse(replies(github)[0].body).body,
      /^Waiting for #77: I'll start when it is done/,
    );
    // 👀 on the comment, and no run yet.
    assert.ok(
      github.requests.some((r) => r.path === "/repos/org/repo/issues/comments/99/reactions"),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(dir, "run-args")), null);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "waits.json"), "utf8"))["org/repo#12"].blockers,
      [77],
    );

    // #77 is merged while the listener is down: the next one asks GitHub when it starts.
    files["issue:77"] = JSON.stringify({ state: "closed", pull_request: { merged_at: "2026" } });
    await restart();
    await until(() => exists(join(dir, "run-args")), "the run");
    const env = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(env, /^TASK_MESSAGE=Do it on top of the new parser\.$/m);
    assert.match(env, /^SANDBOX_EFFORT=high$/m);
    await until(() => replies(github).length === 3, "the starting reply and the run's");
    assert.match(JSON.parse(replies(github)[1].body).body, /^#77 is done: starting\./);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "waits.json"), "utf8")), {});
  });

  test("/after: an issues webhook starts the run; closed as not planned drops the wait", async (t) => {
    const files = { "issue:77": JSON.stringify({ state: "open" }) };
    const { dir, github, send, listener } = await listen(t, files);
    const closed = (number, state_reason) =>
      send(
        {
          action: "closed",
          installation: { id: 7 },
          repository: { full_name: "org/repo", default_branch: "trunk" },
          issue: { number, state: "closed", state_reason },
          sender: { login: "bob" },
        },
        "issues",
      );
    await send(comment("alice", "Deckhand\n/after #77\nFirst."));
    await until(() => replies(github).length === 1, "the waiting reply");
    await closed(77, "not_planned");
    await until(() => replies(github).length === 2, "the reply that drops it");
    assert.match(JSON.parse(replies(github)[1].body).body, /^#77 was closed without being done/);
    await send(followUp(100, "Deckhand /after #77\nSecond."));
    await until(() => replies(github).length === 3, "the second waiting reply");
    await closed(77, "completed");
    await until(() => exists(join(dir, "run-args")), "the run");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_MESSAGE=Second\.$/m);
    await listener.until("done (ok)");
  });

  // A pull request closed by a merge into `base`, saying "Closes #77", from the repo's branch.
  const mergedPull = (base = "trunk") => ({
    action: "closed",
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    pull_request: {
      number: 90,
      state: "closed",
      merged: true,
      merged_at: "2026-10-15T00:00:00Z",
      body: "Closes #77",
      base: { ref: base },
      head: { ref: "issue-77-parser", repo: { full_name: "org/repo" } },
      html_url: "https://github.com/org/repo/pull/90",
    },
    sender: { login: "bob" },
  });

  test("/after: a merged pull request that closes #77 starts the run, with no issues delivery", async (t) => {
    const files = { "issue:77": JSON.stringify({ state: "open" }) };
    const { dir, github, send, listener } = await listen(t, files);
    await send(comment("alice", "Deckhand /after #77\nOn top of it."));
    await until(() => replies(github).length === 1, "the waiting reply");
    // The merge went to the default branch: GitHub closed #77 as completed.
    files["issue:77"] = JSON.stringify({ state: "closed", state_reason: "completed" });
    await send(mergedPull(), "pull_request");
    await until(() => exists(join(dir, "run-args")), "the run");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_MESSAGE=On top of it\.$/m);
    assert.match(JSON.parse(replies(github)[1].body).body, /^#77 is done: starting\./);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "waits.json"), "utf8")), {});
    await listener.until("done (ok)");
  });

  test("/after: a merge into another branch leaves #77 open, and the wait in place", async (t) => {
    const files = { "issue:77": JSON.stringify({ state: "open" }) };
    const { dir, github, send } = await listen(t, files);
    await send(comment("alice", "Deckhand /after #77\nOn top of it."));
    await until(() => replies(github).length === 1, "the waiting reply");
    const asked = () =>
      github.requests.filter((r) => r.path === "/repos/org/repo/issues/77").length;
    const before = asked();
    await send(mergedPull("release"), "pull_request");
    await until(() => asked() > before, "GitHub asked about #77");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(dir, "run-args")), null);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "waits.json"), "utf8"))["org/repo#12"].blockers,
      [77],
    );
  });

  test("/after: a run on #77 ending asks GitHub about #77 only", async (t) => {
    const files = {
      "issue:77": JSON.stringify({ state: "open" }),
      "issue:80": JSON.stringify({ state: "open" }),
    };
    // The run on #77 waits for `go` before its answer.
    const { dir, github, send, listener } = await listen(t, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return files;
    });
    await send(comment("alice", "Deckhand /after #77 #80\nOn top of them."));
    await until(() => replies(github).length === 1, "the waiting reply");
    await send({ ...followUp(101, "Deckhand"), issue: { number: 77 } });
    await until(() => exists(join(dir, "run-args")), "the run on #77");
    // Its run closes #77 (its pull request merged, say), and no delivery says so.
    files["issue:77"] = JSON.stringify({ state: "closed", state_reason: "completed" });
    const asked = (n) =>
      github.requests.filter((r) => r.method === "GET" && r.path === `/repos/org/repo/issues/${n}`)
        .length;
    const [on77, on80] = [asked(77), asked(80)];
    writeFileSync(join(dir, "go"), "");
    await listener.until("done (ok)");
    const waiting = () => JSON.parse(readFileSync(join(dir, "waits.json"), "utf8"))["org/repo#12"];
    await until(() => waiting().blockers.length === 1, "#77 done");
    assert.deepEqual(waiting().blockers, [80]);
    assert.equal(asked(77), on77 + 1);
    assert.equal(asked(80), on80);
  });

  test("a brainstorm and the issue's work share no writable volume", async (t) => {
    const { dir, github, listener, send } = await listen(
      t,
      (dir) => ({
        ".deckhand.yaml": `caches: [/home/node/.npm]
mounts:
  - path: ${RW_MOUNT}
    read_only: false
`,
      }),
      (dir) => {
        writeGrant(dir, `mounts:\n  - root: ${RW_MOUNT}\n    read_only: false\n`);
        return {};
      },
    );
    // Volumes and bind mounts of the last run, with ",ro" or ",readonly" when read-only.
    const mounted = () => {
      const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
      return args.flatMap((a, i) => (["-v", "--mount"].includes(args[i - 1]) ? [a] : []));
    };
    const writable = (mounts) => mounts.filter((m) => !/(:ro|,readonly)$/.test(m));
    const api = RW_MOUNT;

    await send(comment("alice", "Deckhand\n/mode brainstorm\nWhat about dark mode?"));
    await until(() => replies(github).length === 1, "the brainstorm's reply");
    assert.equal(lastRun(dir), "brainstorm 1");
    const light = mounted();
    assert.ok(light.includes("deckhand-org-repo-12-0e9572aae2-light-workspace:/workspace"));
    assert.ok(light.includes("deckhand-org-repo-12-0e9572aae2-light-claude:/home/node/.claude"));
    // No caches (no setup to fill them), granted host paths read-only.
    assert.equal(
      light.some((m) => m.includes("deckhand-cache-")),
      false,
    );
    assert.ok(light.includes(`type=bind,src=${api},dst=${api},readonly`));
    await listener.until("done (ok)");

    await send(followUp(100, "Deckhand\nGo with the second option."));
    await until(() => replies(github).length === 2, "the work reply");
    assert.equal(lastRun(dir), "work full");
    const work = mounted();
    assert.ok(work.includes("deckhand-org-repo-12-0e9572aae2-workspace:/workspace"));
    assert.ok(work.includes("deckhand-org-repo-12-0e9572aae2-claude:/home/node/.claude"));
    assert.ok(
      work.some((m) => /^deckhand-cache-org-repo-home-node-npm-\w+:\/home\/node\/\.npm$/.test(m)),
    );
    assert.ok(work.includes(`type=bind,src=${api},dst=${api}`));
    // Nothing the brainstorm could write is mounted by the work.
    // A volume's source, with its subfolder when only that is mounted (screenshots).
    const source = (m) =>
      m.startsWith("type=")
        ? `${/src=([^,]+)/.exec(m)[1]}/${/volume-subpath=([^,]+)/.exec(m)?.[1] ?? ""}`
        : m.split(":")[0];
    const lightSources = new Set(writable(light).map(source));
    assert.deepEqual(
      writable(work)
        .map(source)
        .filter((s) => lightSources.has(s)),
      [],
    );
    // A fresh session, from the issue: it reads what the brainstorm settled there.
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_PROMPT=Work on GitHub issue #12 of org\/repo/m);
    assert.match(runEnv, /gh issue view 12 --comments`\. If it was brainstormed there/);
  });

  test("/mode work alone moves a brainstorm to work", async (t) => {
    const { dir, github, listener, send } = await listen(t);
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
        "issue-30-deckhand-config:.deckhand.yaml":
          "effort: huge\ndockerfile: .deckhand/Dockerfile\n",
      },
      { ALLOWED_HOSTS: "registry.npmjs.org" },
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
    const { dir, github, send } = await listen(t, {}, { ONBOARDING: "off" });
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

  test("the dashboard shows a repo's tasks and logs to its own users, once they are known", async (t) => {
    const files = { ".deckhand.yaml": "users: [bob]\n" };
    const { port, send, listener } = await listen(t, files, (dir, github) => {
      mkdirSync(join(dir, "logs"));
      const meta = { type: "listener", key: "org/repo#pr-3", repo: "org/repo", startedAt: 1000 };
      writeFileSync(join(dir, "logs", "org-repo-pr-3-1000.log"), `${JSON.stringify(meta)}\n`);
      return { GITHUB_URL: github.url };
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    // alice (the fake GitHub's browser) signs in: she is in ALLOWED_USERS.
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const keys = async () =>
      (await (await get("/api/state", session)).json()).tasks.map((task) => task.key);
    // The repo's users aren't known yet: ALLOWED_USERS decides.
    assert.deepEqual(await keys(), ["org/repo#pr-3"]);
    const open = await get("/api/runs/org-repo-pr-3-1000/stream", session);
    assert.equal(open.status, 200);
    await open.body.cancel();
    // bob's comment reads the repo's config, whose users leave alice out.
    await send(comment("bob"));
    await listener.until("done (ok)");
    assert.deepEqual(await keys(), []);
    assert.equal((await get("/api/runs/org-repo-pr-3-1000/stream", session)).status, 404);
  });

  test("/status lists a signed-in user only the runs of the repos they may see", async (t) => {
    const files = { ".deckhand.yaml": "users: [bob]\n" };
    const { dir, port, send } = await listen(t, files, (dir, github) => {
      writeFileSync(join(dir, "hold"), "");
      return { GITHUB_URL: github.url };
    });
    await send(comment("bob"));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 9, "the sandbox");
    const base = `http://127.0.0.1:${port}`;
    // Forwarded, so not a call from inside the container: the session decides.
    const get = (path, cookie) =>
      fetch(base + path, {
        redirect: "manual",
        headers: { "x-forwarded-for": "203.0.113.9", ...(cookie ? { cookie } : {}) },
      });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    // alice isn't in the repo's users: bob's run isn't hers to see, though the listener is busy.
    const seen = await (await get("/status", session)).json();
    assert.equal(seen.idle, false);
    assert.deepEqual(seen.reasons, []);
    // From inside the container: everything.
    const all = await (await fetch(`${base}/status`)).json();
    assert.match(all.reasons.join("\n"), /run org\/repo#12 since/);
    writeFileSync(join(dir, "go"), "");
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
      (await (await get("/api/state", session)).json()).tasks.find(
        (x) => x.key === "org/repo#pr-3",
      );
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
    assert.equal(ready.closed, null);
    // #12 closed as completed: the graph shows it implemented.
    await send(
      {
        action: "closed",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        issue: { number: 12, state: "closed", state_reason: "completed" },
        sender: { login: "alice" },
      },
      "issues",
    );
    let closed = null;
    for (let i = 0; i < 100 && !closed; i++) {
      const all = (await (await get("/api/state", session)).json()).tasks;
      closed = all.find((x) => x.key === "org/repo#12").closed;
      if (!closed) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(closed, "completed");
    const stream = await get(`/api/runs/${task.runs[0].id}/stream`, session);
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /event: end/);
    assert.equal((await get(`/api/runs/${task.runs[0].id}/stream`)).status, 401);
  });

  // dashboard/src/types.ts, key by key: [required, optional].
  const STATE_KEYS = [
    [
      "user",
      "tasks",
      "edges",
      "blockers",
      "states",
      "running",
      "queued",
      "maxParallel",
      "githubUrl",
      "now",
    ],
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
      "closed",
      "pr",
      "runs",
    ],
    ["deadline", "waitingFor"],
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
    ["reason", "agent", "model", "effort", "phase", "summary", "delivered"],
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
    // Forwarded by a reverse proxy on the host's network: from anyone, so not trusted.
    for (const header of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
      const proxied = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { [header]: "203.0.113.9" },
      });
      assert.equal(proxied.status, 401, header);
    }
  });

  test("a delivery GitHub sends again is handled once", async (t) => {
    const { port, listener } = await listen(t, {}, { DEBOUNCE_MS: "60000" });
    const body = JSON.stringify(comment("alice"));
    const deliver = () =>
      fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: {
          "x-github-event": "issue_comment",
          "x-github-delivery": "d-1",
          "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
        },
        body,
      });
    assert.equal((await deliver()).status, 202);
    await listener.until("queued (work");
    assert.equal((await deliver()).status, 202);
    await listener.until("Delivery d-1 again: already handled");
    assert.equal(listener.output().match(/queued \(work/g).length, 1);
  });

  // What the git gateway answers a push of `ref` with the run's secret: refused pushes are
  // answered by the gateway itself, the others reach the fake GitHub.
  async function pushProbe(brokerPort, secret, ref) {
    const line = `${"0".repeat(40)} ${"a".repeat(40)} ${ref}\0report-status\n`;
    const body = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
    const res = await fetch(`http://127.0.0.1:${brokerPort}/git/org/repo.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`deckhand:${secret}`).toString("base64")}` },
      body,
    });
    return res.text();
  }

  // The branches a running run may push, from its saved state.
  async function savedBranches(dir) {
    const live = await until(
      () => readdirSync(join(dir, "logs")).find((f) => f.endsWith(".live.json")),
      "the run's saved state",
    );
    // The run's secret is in it: the owner's only.
    assert.equal(statSync(join(dir, "logs", live)).mode & 0o777, 0o600);
    return JSON.parse(readFileSync(join(dir, "logs", live), "utf8")).branches;
  }

  test("a run on an issue pushes issue-<n>-* only, before and after a restart", async (t) => {
    const ctx = await listen(t, {}, (dir, github) => {
      writeFileSync(join(dir, "hold"), "");
      return { GITHUB_URL: github.url };
    });
    const { dir, github, brokerPort } = ctx;
    await ctx.send(comment("alice"));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 9, "the sandbox");
    assert.deepEqual(await savedBranches(dir), ["issue-12-*"]);
    const secret = readFileSync(join(dir, "run-secret"), "utf8").trim();
    const forwarded = () =>
      github.requests.filter((r) => r.path === "/org/repo.git/git-receive-pack").length;

    for (const round of ["before", "after"]) {
      for (const ref of ["refs/heads/issue-13-x", "refs/heads/gh-pages"]) {
        assert.match(
          await pushProbe(brokerPort, secret, ref),
          /ng refs\/heads\/[\w-]+ Deckhand: this run can only push issue-12-\*/,
          `${round}: ${ref}`,
        );
      }
      assert.equal(forwarded(), round === "before" ? 0 : 1);
      await pushProbe(brokerPort, secret, "refs/heads/issue-12-x");
      assert.equal(forwarded(), round === "before" ? 1 : 2);
      if (round === "before") {
        await ctx.restart();
        await ctx.listener.until("picked up");
      }
    }
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
  });

  test("a run on a pull request pushes its head branch, a maintainer's included, never a fork's", async (t) => {
    const ctx = await listen(t, {}, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    const { dir } = ctx;
    const onPull = (number) => {
      const payload = comment("alice");
      payload.issue = { number, pull_request: {} };
      return payload;
    };
    await ctx.send(onPull(40));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 9, "the sandbox");
    assert.deepEqual(await savedBranches(dir), ["feature/maintainer"]);
    assert.match(
      readFileSync(join(dir, "run-env"), "utf8"),
      /push to its branch, `feature\/maintainer`: Deckhand refuses pushes to any other/,
    );
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    rmSync(join(dir, "egress"));
    rmSync(join(dir, "go"));

    await ctx.send(onPull(41));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 9, "the sandbox");
    assert.deepEqual(await savedBranches(dir), []);
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /its branch is in a fork/);
    writeFileSync(join(dir, "go"), "");
  });

  test("a granted repo's work runs get a container engine, never for a fork's pull request", async (t) => {
    const ctx = await listen(t, { ".deckhand.yaml": "docker:\n  cache: true\n" }, (dir) => {
      writeGrant(dir, "allow_docker: true\nlimits: { cpus: 3 }\n");
      return { SANDBOX_ENGINE: "podman" };
    });
    const { dir, github } = ctx;
    await ctx.send(comment("alice"));
    await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    await ctx.listener.until("done (ok)");
    const joined = readFileSync(join(dir, "engine-args"), "utf8").split("\n").join(" ");
    assert.match(joined, /--network-alias engine /);
    assert.match(joined, /--cpus 3 --memory 4g --memory-swap 4g --pids-limit 2048 /);
    assert.match(joined, /src=deckhand-engine-cache-org-repo-[0-9a-f]+-podman,/);
    assert.match(joined, /--label deckhand\.task=org\/repo#12/);
    assert.doesNotMatch(joined, /--privileged|docker\.sock/);
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.ok(args.includes("DOCKER_HOST=tcp://engine:2375"));
    assert.ok(args.includes("DOCKER_BUILDKIT=0"));
    // The sandbox keeps its hardening.
    assert.match(
      args.join(" "),
      /--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges/,
    );
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^NO_PROXY=.*,engine$/m);
    const logs = readdirSync(join(dir, "logs")).filter((f) => f.endsWith(".log"));
    assert.match(
      readFileSync(join(dir, "logs", logs[0]), "utf8"),
      /Container engine: podman, the repository's cache/,
    );

    // A fork's pull request: no engine.
    rmSync(join(dir, "engine-args"));
    const payload = comment("alice");
    payload.issue = { number: 41, pull_request: {} };
    await ctx.send(payload);
    await ctx.listener.until("org/repo#pr-41: done (ok)");
    assert.throws(() => readFileSync(join(dir, "engine-args")));
    assert.doesNotMatch(readFileSync(join(dir, "run-args"), "utf8"), /DOCKER_HOST/);
  });

  test("granted, but no SANDBOX_ENGINE: runs start as before, without an engine", async (t) => {
    const { dir, github, send, listener } = await listen(
      t,
      { ".deckhand.yaml": "docker: true\n" },
      (dir) => (writeGrant(dir, "allow_docker: true\n"), {}),
    );
    await send(comment("alice"));
    await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    await listener.until("done (ok)");
    assert.throws(() => readFileSync(join(dir, "engine-args")));
    assert.doesNotMatch(readFileSync(join(dir, "run-args"), "utf8"), /DOCKER_HOST/);
    assert.doesNotMatch(readFileSync(join(dir, "run-env"), "utf8"), /engine/);
  });
});
