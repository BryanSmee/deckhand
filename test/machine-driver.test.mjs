// The machine driver (machine/deckhand-machine.mjs, #599): its machine.yaml, the settings it
// suggests (paths built with each platform's join()), its sign-in, and its loop against a fake
// /mcp and a fake claude (test/fixtures/fake-claude.mjs): claim, run, stream, push, finish, a
// lease kept through a long run, a session resumed, a claim that ends stopping its agent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix as posixPath, win32 } from "node:path";
import { test } from "node:test";
import {
  CHECKED_WITH,
  createDriver,
  credentialPaths,
  login,
  mcpClient,
  parseYaml,
  readConfig,
  rulePath,
  settingsFor,
  ToolError,
  WARNING,
} from "../machine/deckhand-machine.mjs";
import { WARNING as SERVER_WARNING } from "../listener/machines.mjs";
import { scriptEnv, serve, tempDir, until } from "./helpers.mjs";

const FAKE_CLAUDE = join(import.meta.dirname, "fixtures", "fake-claude.mjs");

test("machine.yaml: the YAML it needs, its defaults, and what it refuses", () => {
  assert.deepEqual(
    parseYaml(`# a machine
name: "Desk"
labels: [unreal, 'gpu']
capacity: 2
repos:
- org/game   # the game
paths:
  - path: C:\\Program Files\\Epic Games
    write: false
  - ~/assets
sandbox: true
`),
    {
      name: "Desk",
      labels: ["unreal", "gpu"],
      capacity: 2,
      repos: ["org/game"],
      paths: [{ path: "C:\\Program Files\\Epic Games", write: false }, "~/assets"],
      sandbox: true,
    },
  );
  assert.throws(() => parseYaml("a: &x 1"), /plain or quoted/);
  assert.throws(() => parseYaml("a: 1\n  b: 2"), /indentation/);

  const home = join("/", "home", "ada");
  const where = { home, base: join(home, ".deckhand-machine") };
  const config = readConfig(
    "name: Desk\nrepos: [Org/Game]\npaths:\n  - path: ~/engine\n  - path: data\n    write: true",
    where,
  );
  assert.equal(config.capacity, 1);
  assert.deepEqual(config.repos, ["org/game"]);
  assert.equal(config.workspace, join(home, "deckhand"));
  assert.deepEqual(config.paths, [
    { path: join(home, "engine"), write: false },
    { path: join(home, ".deckhand-machine", "data"), write: true },
  ]);
  assert.deepEqual(
    [config.permissionMode, config.sandbox, config.suggestedSettings, config.claude],
    ["acceptEdits", true, true, ["claude"]],
  );
  // Never an agent that skips every check; nothing it doesn't know.
  assert.throws(
    () => readConfig("repos: [o/r]\npermission_mode: bypassPermissions", where),
    /never bypassPermissions/,
  );
  assert.throws(() => readConfig("repos: [o/r]\nsandbox: maybe", where), /sandbox: true or false/);
  // A mode claim would refuse: said at start, not at each claim.
  assert.throws(
    () => readConfig("repos: [o/r]\npermission_mode: accept edits", where),
    /permission_mode: one of Claude Code's modes/,
  );
  assert.throws(() => readConfig("name: x\nrepo: [o/r]", where), /repo: not a setting.*repos:/);
});

test("the driver's warning is Deckhand's", () => {
  assert.equal(WARNING, SERVER_WARNING);
});

test("suggested settings, POSIX: the run's folder writable, extra paths, credentials unreadable, the claim's hosts", () => {
  const home = join("/", "home", "ada");
  const dir = join(home, "deckhand", "org", "game", "issue-12");
  const engine = join("/", "opt", "unreal");
  const cache = join("/", "var", "cache", "ddc");
  const settings = settingsFor({
    run: "r1",
    dir,
    paths: [
      { path: engine, write: false },
      { path: cache, write: true },
    ],
    deny: [join(home, "secrets")],
    hosts: ["api.anthropic.com", "GitHub.com", "github.com", "assets.example.com"],
    permissionMode: "dontAsk",
    home,
    driverHome: join(home, ".deckhand-machine"),
    platform: "linux",
  });
  assert.equal(settings.deckhand.checkedWith, `Claude Code ${CHECKED_WITH}`);
  assert.equal(settings.permissions.defaultMode, "dontAsk");
  assert.equal(settings.permissions.disableBypassPermissionsMode, "disable");
  assert.deepEqual(settings.permissions.additionalDirectories, [engine, cache]);
  const { sandbox } = settings;
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.failIfUnavailable, true);
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(sandbox.filesystem.allowWrite, [dir, cache]);
  assert.deepEqual(sandbox.network.allowedDomains, [
    "api.anthropic.com",
    "github.com",
    "assets.example.com",
  ]);
  // The usual stores, the owner's own, and the driver's tokens: unreadable, by rule and sandbox.
  for (const path of [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".config", "gh"),
    join(home, ".git-credentials"),
    join(home, ".docker", "config.json"),
    join(home, ".config", "google-chrome"),
    join(home, ".mozilla"),
    join(home, "secrets"),
    join(home, ".deckhand-machine"),
  ]) {
    assert.ok(sandbox.filesystem.denyRead.includes(path), path);
  }
  const { deny } = settings.permissions;
  for (const rule of [
    "Read(~/.ssh/**)",
    "Edit(~/.ssh/**)",
    "Read(~/.git-credentials)",
    "Read(~/.docker/config.json)",
    "Read(~/.config/gh/**)",
    // The owner's own `deny`, a file or a folder: both.
    "Read(~/secrets)",
    "Edit(~/secrets)",
    "Read(~/secrets/**)",
    "Read(~/.deckhand-machine/**)",
    // A read-only extra path: no edit there.
    "Edit(//opt/unreal/**)",
  ]) {
    assert.ok(deny.includes(rule), rule);
  }
  assert.ok(!deny.includes("Edit(//var/cache/ddc/**)"));
  // macOS: its keychains and browser profiles.
  const mac = credentialPaths(home, "darwin").map((c) => c.path);
  assert.ok(mac.includes(join(home, "Library", "Keychains")));
  assert.ok(mac.includes(join(home, "Library", "Application Support", "Google", "Chrome")));
});

test("suggested settings, Windows: its paths and rules, and no sandbox (Claude Code has none there)", () => {
  const home = win32.join("C:\\", "Users", "ada");
  const dir = win32.join(home, "deckhand", "org", "game", "issue-12");
  const engine = win32.join("D:\\", "Epic Games", "UE_5.4");
  const settings = settingsFor({
    run: "r1",
    dir,
    paths: [{ path: engine, write: false }],
    hosts: ["github.com"],
    home,
    platform: "win32",
  });
  assert.deepEqual(settings.sandbox, { enabled: false });
  const paths = credentialPaths(home, "win32").map((c) => c.path);
  assert.ok(paths.includes(win32.join(home, ".ssh")));
  assert.ok(paths.includes(win32.join(home, "AppData", "Local", "Google", "Chrome", "User Data")));
  assert.ok(paths.includes(win32.join(home, "AppData", "Roaming", "Mozilla", "Firefox")));
  const { deny } = settings.permissions;
  assert.ok(deny.includes("Read(~/.ssh/**)"));
  assert.ok(deny.includes("Read(~/AppData/Local/Google/Chrome/User Data/**)"));
  assert.ok(deny.includes("Edit(//d/Epic Games/UE_5.4/**)"));
  assert.deepEqual(settings.permissions.additionalDirectories, [engine]);
  assert.equal(
    rulePath(win32.join(home, ".git-credentials"), { home, platform: "win32", dir: false }),
    "~/.git-credentials",
  );
  assert.equal(
    rulePath(posixPath.join("/srv", "data"), { home: "/home/ada", platform: "linux" }),
    "//srv/data/**",
  );
});

test("login: a client registered, PKCE and the loopback redirect, deckhand:machine asked, its tokens", async (t) => {
  const seen = {};
  const { url } = await serve(t, async (req, res) => {
    const body = await new Promise((r) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => r(b));
    });
    const json = (status, value) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (req.url === "/.well-known/oauth-authorization-server") {
      return json(200, {
        authorization_endpoint: `${url}/oauth/authorize`,
        token_endpoint: `${url}/oauth/token`,
        registration_endpoint: `${url}/oauth/register`,
      });
    }
    if (req.url === "/oauth/register") {
      seen.register = JSON.parse(body);
      return json(201, { client_id: "c1" });
    }
    if (req.url === "/oauth/token") {
      seen.token = Object.fromEntries(new URLSearchParams(body));
      return json(200, {
        access_token: "a1",
        refresh_token: "r1",
        expires_in: 3600,
        scope: "deckhand:machine",
      });
    }
    json(404, {});
  });
  // The browser: signed in, sent back to the driver's loopback with a code.
  const open = async (link) => {
    const asked = new URL(link).searchParams;
    seen.authorize = Object.fromEntries(asked);
    const back = new URL(asked.get("redirect_uri"));
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", asked.get("state"));
    await fetch(back);
  };
  const credentials = await login(`${url}/`, { open, now: () => 1000 });
  assert.deepEqual(seen.register.redirect_uris, ["http://127.0.0.1/callback"]);
  assert.equal(seen.authorize.scope, "deckhand:machine");
  assert.equal(seen.authorize.code_challenge_method, "S256");
  assert.equal(seen.authorize.resource, `${url}/mcp`);
  assert.match(seen.authorize.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(seen.token.code, "the-code");
  assert.equal(seen.token.redirect_uri, seen.authorize.redirect_uri);
  assert.ok(seen.token.code_verifier.length >= 43);
  assert.deepEqual(credentials, {
    url,
    clientId: "c1",
    tokenEndpoint: `${url}/oauth/token`,
    revocationEndpoint: null,
    accessToken: "a1",
    refreshToken: "r1",
    expiresAt: 1000 + 3600_000,
  });
});

// A fake /mcp: the machine tools as Deckhand answers them, `works` handed out by claim in turn,
// each run's lines, messages and end recorded. A message for the run goes out at its first
// result line; its inbox closes at the next result (or at the first with `once`).
async function fakeMcp(t, works) {
  const seen = {
    calls: [],
    claims: [],
    heartbeats: [],
    lines: {},
    finished: {},
    refreshed: 0,
    approvals: [],
  };
  const outbox = {};
  const closed = {};
  const held = new Set();
  const wakers = new Set();
  const wake = () => {
    for (const w of [...wakers]) w();
  };
  const waitFor = (check, ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wakers.delete(done);
        resolve();
      }
      if (check()) return done();
      wakers.add(() => check() && done());
    });
  const tools = {
    register_machine: () => ({
      machine: { id: "m1" },
      offered: [{ repo: "org/game" }],
      heartbeatSeconds: 30,
    }),
    heartbeat: (a) => {
      seen.heartbeats.push(a.runs);
      return { claims: [...held].map((run) => ({ run })) };
    },
    claim: async (a) => {
      seen.claims.push(a);
      const work = works.shift();
      if (!work) {
        await new Promise((r) => setTimeout(r, 50));
        return { work: null };
      }
      held.add(work.run);
      outbox[work.run] = [];
      seen.lines[work.run] = [];
      return { work };
    },
    post_events: (a) => {
      const lines = seen.lines[a.run];
      assert.equal(a.from, lines.length, "sent from what Deckhand has");
      lines.push(...a.lines);
      const results = lines.filter((l) => JSON.parse(l).type === "result").length;
      const work = seen.works[a.run];
      if (results === 1 && work.comment && !outbox[a.run].length) outbox[a.run].push(work.comment);
      else if (results >= 1 && (!work.comment || results >= 2)) closed[a.run] = true;
      wake();
      return { next: lines.length };
    },
    next_message: async (a) => {
      await waitFor(() => outbox[a.run].length > a.from || closed[a.run], 2000);
      const messages = outbox[a.run].slice(a.from);
      return {
        messages,
        next: a.from + messages.length,
        closed: !!closed[a.run] && !messages.length,
      };
    },
    finish: (a) => {
      seen.finished[a.run] = a;
      held.delete(a.run);
      return { status: a.outcome };
    },
    release: (a) => (held.delete(a.run), { released: a.run }),
    // Pending at first, as while the owner hasn't answered; then allowed.
    approve_permission: (a) => {
      seen.approvals.push(a);
      if (seen.approvals.length === 1) return { request: "q1", state: "pending" };
      return { request: "q1", state: "granted", behavior: "allow", updatedInput: a.input };
    },
  };
  seen.works = Object.fromEntries(works.map((w) => [w.run, w]));
  const { url } = await serve(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/oauth/token") {
      seen.refreshed++;
      return res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 }));
    }
    const token = req.headers.authorization;
    if (token !== "Bearer fresh") return res.writeHead(401).end();
    const { id, params } = JSON.parse(body);
    seen.calls.push(params.name);
    const answer = await tools[params.name](params.arguments);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({ jsonrpc: "2.0", id, result: { content: [], structuredContent: answer } }),
      );
  });
  const credentials = {
    url,
    clientId: "c1",
    tokenEndpoint: `${url}/oauth/token`,
    accessToken: "old",
    refreshToken: "r1",
    expiresAt: Date.now() + 3600_000,
  };
  return { seen, url, credentials, held, wake };
}

// An origin repository with a main branch, in a temp dir: → its path.
function origin(t, root, env) {
  const repo = join(root, "origin.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", repo], { env });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed], { env });
  writeFileSync(join(seed, "README.md"), "The game.\n");
  execFileSync("git", ["add", "."], { cwd: seed, env });
  execFileSync("git", ["commit", "--quiet", "-m", "Start"], { cwd: seed, env });
  execFileSync("git", ["push", "--quiet", repo, "main"], { cwd: seed, env });
  return repo;
}

test("the driver's loop: claim, run, stream, push, finish; its lease kept through a long run; its session resumed; a claim that ends stops its agent", async (t) => {
  const root = tempDir(t);
  const home = join(root, "home");
  mkdirSync(home);
  const log = join(root, "claude.jsonl");
  const env = scriptEnv(t, {
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@example.com",
    FAKE_CLAUDE_LOG: log,
  });
  const repo = origin(t, root, env);
  const work = (run, extra) => ({
    run,
    key: "org/game#12",
    repository: "org/game",
    issue: 12,
    branch: "issue-12-build-the-level",
    base: "main",
    mode: "work",
    prompt: "Deckhand's rules.",
    cloneUrl: repo,
    hosts: ["api.anthropic.com", "github.com", "assets.example.com"],
    protocol: 1,
    ...extra,
  });
  const works = [
    // A long first turn: heartbeats renew its lease meanwhile. The owner's comment comes at its
    // first answer, and makes a commit.
    work("r1", {
      resume: false,
      message: "Build the level. SLEEP 400",
      comment: "Also the menu. COMMIT",
    }),
    // The issue's next run, on this machine again: its session goes on.
    // Its agent asks for a permission: relayed to approve_permission, the owner's answer back.
    work("r2", { resume: true, message: "And the sound. ASK COMMIT" }),
    // A run whose claim ends (cancelled on the dashboard) while its agent works.
    work("r3", { resume: true, message: "Slowly. SLEEP 5000" }),
    // An agent that fails: the run ends as an error, with what it said on stderr.
    work("r4", { resume: true, message: "FAIL" }),
  ];
  const mcp = await fakeMcp(t, works);
  const saved = [];
  const client = mcpClient(mcp.credentials, { save: (c) => saved.push(c) });
  const driverHome = join(home, ".deckhand-machine");
  const lines = [];
  const config = readConfig(
    `name: Desk\nlabels: [unreal]\nrepos: [org/game]\nworkspace: ${JSON.stringify(join(root, "work"))}\npaths:\n  - path: ${JSON.stringify(join(root, "engine"))}\nmodel: opus`,
    { home, base: driverHome },
  );
  config.claude = [process.execPath, FAKE_CLAUDE];
  const state = { sessions: {} };
  const driver = createDriver({
    client,
    config,
    home,
    driverHome,
    state,
    agentVersion: "2.1.300",
    platform: "linux",
    log: (line) => lines.push(line),
    heartbeatMs: 40,
    retryMs: 20,
    env,
  });
  const running = driver.start();
  t.after(() => driver.stop());

  // The first run: its lines streamed, the comment delivered, pushed, finished ok.
  await until(() => mcp.seen.finished.r1, { ms: 20_000, what: "r1's finish" });
  // A token that ran out: refreshed once, saved.
  assert.equal(mcp.seen.refreshed, 1);
  assert.equal(saved.at(-1).accessToken, "fresh");
  assert.deepEqual(mcp.seen.claims[0], {
    machine: "m1",
    agent: "claude",
    model: "opus",
    agentVersion: "2.1.300",
    sandbox: true,
    permissionMode: "acceptEdits",
    suggestedSettings: true,
    protocol: 1,
  });
  const r1 = mcp.seen.lines.r1.map((l) => JSON.parse(l));
  assert.deepEqual(
    r1.map((e) => e.type),
    ["system", "assistant", "result", "assistant", "result"],
  );
  assert.equal(r1[4].result, "Done: Also the menu. COMMIT");
  assert.deepEqual(mcp.seen.finished.r1, { machine: "m1", run: "r1", protocol: 1, outcome: "ok" });
  // Its lease, kept through the long turn.
  assert.ok(
    mcp.seen.heartbeats.filter((runs) => runs?.includes("r1")).length >= 3,
    "heartbeats with r1 during its run",
  );
  // The branch, on the origin, with the agent's commit.
  const pushed = execFileSync(
    "git",
    ["--git-dir", repo, "log", "--format=%s", "issue-12-build-the-level"],
    { env, encoding: "utf8" },
  );
  assert.deepEqual(pushed.trim().split("\n"), ["Turn 2", "Start"]);

  // How Claude Code ran: in the issue's clone, its settings and the claim's prompt.
  const dir = join(root, "work", "org", "game", "issue-12");
  const first = JSON.parse(readFileSync(log, "utf8").split("\n")[0]);
  assert.equal(first.cwd, dir);
  assert.equal(first.env, true);
  const arg = (flag, args = first.args) => args[args.indexOf(flag) + 1];
  assert.ok(first.args.includes("-p"));
  assert.equal(arg("--permission-mode"), "acceptEdits");
  assert.equal(arg("--model"), "opus");
  assert.ok(!first.args.some((a) => /dangerously|bypass/i.test(a)));
  assert.equal(readFileSync(arg("--append-system-prompt-file"), "utf8"), "Deckhand's rules.");
  const settings = JSON.parse(readFileSync(arg("--settings"), "utf8"));
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [dir]);
  assert.ok(settings.sandbox.network.allowedDomains.includes("assets.example.com"));
  assert.deepEqual(settings.permissions.additionalDirectories, [join(root, "engine")]);
  const session = arg("--session-id");
  assert.equal(state.sessions["org/game#12"], session);

  // The next run resumes that session, in the same clone, on top of what it pushed.
  await until(() => mcp.seen.finished.r2, { ms: 20_000, what: "r2's finish" });
  const second = JSON.parse(readFileSync(log, "utf8").split("\n")[1]);
  assert.equal(arg("--resume", second.args), session);
  assert.ok(!second.args.includes("--session-id"));
  // Its permission prompt: through the driver's own MCP server, to approve_permission, asked
  // again while pending, with no token in the agent's reach.
  assert.equal(arg("--permission-prompt-tool", second.args), "mcp__deckhand__approve");
  assert.ok(!readFileSync(arg("--mcp-config", second.args), "utf8").includes("fresh"));
  assert.equal(mcp.seen.approvals.length, 2);
  assert.deepEqual(mcp.seen.approvals[1], {
    machine: "m1",
    run: "r2",
    tool_name: "Bash",
    input: { command: "rm -rf build" },
    tool_use_id: "toolu_1",
    protocol: 1,
  });
  const asked = mcp.seen.lines.r2
    .map((l) => JSON.parse(l))
    .find((e) => /Asked/.test(JSON.stringify(e)));
  assert.equal(
    asked.message.content[0].text,
    'Asked: {"behavior":"allow","updatedInput":{"command":"rm -rf build"}}',
  );
  const after = execFileSync(
    "git",
    ["--git-dir", repo, "log", "--format=%s", "issue-12-build-the-level"],
    {
      env,
      encoding: "utf8",
    },
  );
  assert.equal(after.trim().split("\n").length, 3);

  // The third: its claim ends (no longer in the heartbeat's claims), its agent stops, no finish.
  await until(() => mcp.seen.lines.r3?.length, { ms: 20_000, what: "r3's first line" });
  mcp.held.delete("r3");
  await until(() => !driver.runs.has("r3"), { ms: 20_000, what: "r3 stopped" });
  assert.equal(mcp.seen.finished.r3, undefined);
  assert.ok(lines.some((l) => /org\/game#12: stopped, Deckhand no longer lists its claim/.test(l)));

  await until(() => mcp.seen.finished.r4, { ms: 20_000, what: "r4's finish" });
  assert.equal(mcp.seen.finished.r4.outcome, "error");
  assert.match(mcp.seen.finished.r4.reply, /Claude Code exited with 3 on Desk:[^]*asked to fail/);

  await driver.stop();
  await running;
});

test("a tool's refusal is a ToolError; a network error is another, worth another try", async (t) => {
  const { url } = await serve(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { id } = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "No claim r9 on this machine." }],
          isError: true,
        },
      }),
    );
  });
  const client = mcpClient({ url, accessToken: "a", expiresAt: Date.now() + 3600_000 });
  await assert.rejects(
    client.call("finish", { run: "r9" }),
    (e) => e instanceof ToolError && /No claim r9/.test(e.message),
  );
  const gone = mcpClient({
    url: "http://127.0.0.1:1",
    accessToken: "a",
    expiresAt: Date.now() + 3600_000,
  });
  await assert.rejects(gone.call("heartbeat", {}), (e) => !(e instanceof ToolError));
});
