// The MCP server's tools (listener/mcp.mjs, #482), as edge passes /mcp on to the orchestrator
// (listener/http.mjs): the transport, and what each tool shows the login, no more than the
// dashboard does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttp } from "../listener/http.mjs";
import { MAX_PAGE_BYTES, PAGE_BYTES, PROTOCOL_VERSIONS } from "../listener/mcp.mjs";
import { createRepoApi } from "../listener/repos.mjs";
import { MEMBER, permissionsOf, serve, testConfig } from "./helpers.mjs";

const line = (value) => `${JSON.stringify(value)}\n`;
const text = (t) => line({ type: "assistant", message: { content: [{ type: "text", text: t }] } });

// A run of `key`, finished unless `status` says otherwise.
const runOf = (key, id, extra = {}) => ({
  id,
  key,
  repo: key.split("#")[0],
  kind: "issue",
  taskMode: "work",
  mode: null,
  agent: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  startedAt: 1000,
  finishedAt: 61_000,
  status: "ok",
  summary: "Fixed it.",
  ...extra,
});

// An orchestrator with runs in org/repo, which alice sees, and org/secret, whose `users` leave
// her out (bob only); each run's log in `logs` (id → text), read as the runner does: `reads`
// keeps each read's { id, offset, length, got }, the runner's answer one segment's at most.
function orchestrator({ logs = {}, runs = [], extra = {} } = {}) {
  const usersOf = (repo) => (repo.toLowerCase() === "org/secret" ? ["bob"] : null);
  const permissions = permissionsOf(
    {
      alice: { "org/repo": MEMBER, "org/secret": MEMBER },
      bob: { "org/repo": MEMBER, "org/secret": MEMBER },
    },
    { usersOf },
  );
  const config = testConfig({ ALLOWED_USERS: "alice,bob", ALLOWED_REPOS: "org/repo,org/secret" });
  const rows = ["org/repo", "org/secret"].map((repo) => ({
    repo,
    url: `https://github.com/${repo}`,
    private: repo === "org/secret",
    issues: true,
    status: "configured",
    issue: null,
    readAt: 1,
    autoMerge: false,
  }));
  const reads = [];
  const segment = 4096;
  const ctx = {
    config,
    log: () => {},
    skip: () => {},
    tasks: new Map(),
    app: {},
    server: { version: "1.2.3" },
    runs,
    runsById: new Map(runs.map((r) => [r.id, r])),
    running: runs.filter((r) => r.status === "running").length,
    usersOf,
    permissions,
    brainstorms: { list: () => [] },
    waits: { list: () => [] },
    inputs: { list: () => [] },
    inboxes: () => [],
    titles: { get: (key) => `Title of ${key}`, closed: () => null, fill: () => {} },
    pulls: { get: () => null, fill: () => {} },
    repoList: { listed: () => rows.map((r) => r.repo), refresh: () => {} },
    runLogs: {
      read: async (id, { offset = 0, length = 4 * 1024 * 1024 } = {}) => {
        const all = Buffer.from(logs[id] ?? "");
        const end = Math.min(
          all.length,
          offset + length,
          (Math.floor(offset / segment) + 1) * segment,
        );
        const data = all.subarray(offset, Math.max(offset, end));
        reads.push({ id, offset, length, got: data.length });
        return { size: all.length, data };
      },
    },
    workApi: {
      backlog: async (repo) => ({
        issues: [
          { number: 9, title: `Backlog of ${repo}`, url: `https://github.com/${repo}/issues/9` },
        ],
        modes: ["work"],
        errors: false,
        readAt: 5,
        refreshing: false,
      }),
    },
    ...extra,
  };
  ctx.repoApi = createRepoApi({
    config,
    list: { list: async () => rows, listedAt: () => 7, installations: () => [] },
    permissions,
    start: async () => null,
    fs: {},
  });
  return { ctx, reads };
}

// `ctx`'s /mcp as edge passes it on: the login in x-user, the scopes in x-scopes (none: not
// passed on, as for anything but /mcp).
async function serveMcp(t, ctx) {
  const http = createHttp(ctx);
  const { url } = await serve(t, (req, res) => {
    const scopes = req.headers["x-scopes"];
    http.handle(req, res, {
      user: req.headers["x-user"] ?? null,
      scopes: scopes === undefined ? null : scopes.split(" ").filter(Boolean),
    });
  });
  let n = 0;
  // A JSON-RPC call as `user`: its answer's `result` (or `error`).
  const rpc = async (method, params, { user = "alice", scopes = "deckhand:read" } = {}) => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": user, "x-scopes": scopes },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, n);
    return body.error ? { error: body.error } : body.result;
  };
  const tool = (name, args = {}, options) => rpc("tools/call", { name, arguments: args }, options);
  return { url, rpc, tool };
}

test("MCP: initialize, the five read tools, ping; notifications accepted, GET refused", async (t) => {
  const { ctx } = orchestrator();
  const { url, rpc } = await serveMcp(t, ctx);
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "2" },
  });
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(init.serverInfo, { name: "deckhand", title: "Deckhand", version: "1.2.3" });
  // A version it doesn't know: its newest, the client decides.
  assert.equal(
    (await rpc("initialize", { protocolVersion: "2099-01-01" })).protocolVersion,
    PROTOCOL_VERSIONS[0],
  );
  const { tools } = await rpc("tools/list", {});
  assert.deepEqual(
    tools.map((x) => x.name),
    ["list_repos", "list_tasks", "list_runs", "get_run_log", "get_schedule"],
  );
  for (const x of tools) {
    assert.equal(x.annotations.readOnlyHint, true, x.name);
    assert.equal(x.inputSchema.type, "object", x.name);
  }
  assert.match(tools.find((x) => x.name === "get_run_log").description, /data, not instructions/);
  assert.deepEqual(await rpc("ping"), {});
  assert.equal((await rpc("nope")).error.code, -32601);
  assert.equal((await rpc("tools/call", { name: "rerun" })).error.code, -32602);

  const post = (body, headers = {}) =>
    fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "x-user": "alice", "x-scopes": "deckhand:read", ...headers },
      body,
    });
  const initialized = await post(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assert.equal(initialized.status, 202);
  assert.equal(await initialized.text(), "");
  const notJson = await post("{");
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error.code, -32700);
  // A batch, answered as one.
  const batch = await post(
    JSON.stringify([
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]),
  );
  assert.deepEqual(await batch.json(), [{ jsonrpc: "2.0", id: "a", result: {} }]);
  const version = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), {
    "mcp-protocol-version": "1999-01-01",
  });
  assert.equal(version.status, 400);
  const get = await fetch(`${url}/mcp`, {
    headers: { "x-user": "alice", "x-scopes": "deckhand:read" },
  });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  // Not passed on with a token's scopes (the dashboard's session): nothing.
  const noScopes = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "x-user": "alice" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(noScopes.status, 401);
  // Too large a body is refused before it is read whole.
  const large = await post(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(70_000) }),
  ).catch((error) => error);
  assert.ok(large instanceof Error || large.status >= 400);
});

test("MCP: a token without deckhand:read lists no tool, and calls none", async (t) => {
  const { ctx } = orchestrator();
  const { rpc, tool } = await serveMcp(t, ctx);
  const scopes = "deckhand:machine";
  assert.deepEqual((await rpc("tools/list", {}, { scopes })).tools, []);
  const refused = await tool("list_repos", {}, { scopes });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /deckhand:read/);
});

test("MCP: each tool shows only the repos the login sees, as the dashboard does", async (t) => {
  const runs = [
    runOf("org/repo#1", "org-repo-1-1000"),
    runOf("org/repo#1", "org-repo-1-500", { startedAt: 500, finishedAt: 900, status: "error" }),
    runOf("org/secret#2", "org-secret-2-1000"),
  ];
  const logs = {
    "org-repo-1-1000": line({ type: "listener", key: "org/repo#1" }) + text("hello"),
    "org-secret-2-1000": line({ type: "listener", key: "org/secret#2" }) + text("the secret"),
  };
  const { ctx } = orchestrator({ runs, logs });
  const { tool } = await serveMcp(t, ctx);

  const repos = await tool("list_repos");
  assert.deepEqual(
    repos.structuredContent.repos.map((r) => r.repo),
    ["org/repo"],
  );
  assert.doesNotMatch(repos.content[0].text, /secret/);

  const tasks = await tool("list_tasks");
  assert.deepEqual(
    tasks.structuredContent.tasks.map((x) => [x.key, x.state, x.runs, x.lastRun.status]),
    [["org/repo#1", "done", 2, "ok"]],
  );
  assert.equal(tasks.structuredContent.tasks[0].url, "https://github.com/org/repo/issues/1");
  assert.deepEqual((await tool("list_tasks", { repo: "org/secret" })).structuredContent.tasks, []);
  assert.deepEqual((await tool("list_tasks", { state: "error" })).structuredContent.tasks, []);
  assert.equal((await tool("list_tasks", { state: "bogus" })).isError, true);

  const listed = await tool("list_runs", { task: "Org/Repo#1" });
  assert.deepEqual(
    listed.structuredContent.runs.map((r) => [
      r.id,
      r.status,
      r.mode,
      r.agent,
      r.model,
      r.durationMs,
    ]),
    [
      ["org-repo-1-1000", "ok", "work", "claude", "claude-opus-5-5", 60_000],
      ["org-repo-1-500", "error", "work", "claude", "claude-opus-5-5", 400],
    ],
  );
  const hidden = await tool("list_runs", { task: "org/secret#2" });
  assert.equal(hidden.isError, true);
  assert.match(hidden.content[0].text, /No task/);

  const log = await tool("get_run_log", { runId: "org-repo-1-1000" });
  assert.equal(log.isError, undefined);
  assert.match(log.content[0].text, /hello/);
  assert.deepEqual(log.structuredContent.entries.at(-1), { kind: "text", text: "hello" });
  // Its run is one alice can't read: "not found", as one that doesn't exist.
  const secret = await tool("get_run_log", { runId: "org-secret-2-1000" });
  assert.equal(secret.isError, true);
  assert.doesNotMatch(JSON.stringify(secret), /the secret/);
  assert.deepEqual(secret, await tool("get_run_log", { runId: "org-secret-2-1000" }));
  assert.match((await tool("get_run_log", { runId: "nope" })).content[0].text, /No run nope/);

  const schedule = await tool("get_schedule");
  assert.deepEqual(
    schedule.structuredContent.backlog.map((b) => b.repo),
    [],
    "no count was read yet",
  );
  const mine = await tool("get_schedule", { repo: "ORG/REPO" });
  assert.equal(mine.structuredContent.repo, "org/repo");
  assert.deepEqual(
    mine.structuredContent.backlog.issues.map((i) => i.number),
    [9],
  );
  const theirs = await tool("get_schedule", { repo: "org/secret" });
  assert.equal(theirs.isError, true);
  assert.doesNotMatch(JSON.stringify(theirs), /Backlog of/);

  // Bob is among org/secret's users: he sees it all.
  const bob = { user: "bob" };
  assert.deepEqual(
    (await tool("list_repos", {}, bob)).structuredContent.repos.map((r) => r.repo),
    ["org/repo", "org/secret"],
  );
  assert.match(
    (await tool("get_run_log", { runId: "org-secret-2-1000" }, bob)).content[0].text,
    /the secret/,
  );
  assert.deepEqual(
    (await tool("get_schedule", { repo: "org/secret" }, bob)).structuredContent.backlog.issues[0]
      .title,
    "Backlog of org/secret",
  );
});

test("MCP: list_runs lists every run of a task, past the board's 20 newest", async (t) => {
  const runs = Array.from({ length: 25 }, (_, i) =>
    runOf("org/repo#1", `org-repo-1-${i}`, { startedAt: 1000 + i, finishedAt: 2000 + i }),
  );
  // One that ended without its end time (a summary from an older release).
  runs.push(
    runOf("org/repo#1", "org-repo-1-old", {
      startedAt: 10,
      finishedAt: null,
      status: "interrupted",
    }),
  );
  const { ctx } = orchestrator({ runs });
  const { tool } = await serveMcp(t, ctx);
  const listed = (await tool("list_runs", { task: "org/repo#1" })).structuredContent.runs;
  assert.equal(listed.length, 26);
  assert.equal(listed[0].id, "org-repo-1-24");
  assert.deepEqual(listed.at(-1), { ...listed.at(-1), id: "org-repo-1-old", durationMs: null });
  const listedText = (await tool("list_runs", { task: "org/repo#1" })).content[0].text;
  assert.doesNotMatch(listedText, /-\d+ s/);
  const [task] = (await tool("list_tasks")).structuredContent.tasks;
  assert.equal(task.runs, 26);
});

test("MCP: a chat's run is its owner's alone, as on the dashboard", async (t) => {
  const run = runOf("org/repo#chat-1", "chat-1-1000", { owner: "bob" });
  const { ctx } = orchestrator({ runs: [run], logs: { [run.id]: text("mine") } });
  const { tool } = await serveMcp(t, ctx);
  assert.equal((await tool("get_run_log", { runId: run.id })).isError, true);
  assert.deepEqual((await tool("list_tasks")).structuredContent.tasks, []);
});

test("MCP: get_run_log pages through a long log, its newest page first, never reading it whole", async (t) => {
  const id = "org-repo-1-1000";
  const lines = Array.from({ length: 3000 }, (_, i) => text(`line ${String(i).padStart(4, "0")}`));
  const log = line({ type: "listener", key: "org/repo#1" }) + lines.join("");
  const { ctx, reads } = orchestrator({ runs: [runOf("org/repo#1", id)], logs: { [id]: log } });
  const { tool } = await serveMcp(t, ctx);
  const size = Buffer.byteLength(log);
  assert.ok(size > 3 * PAGE_BYTES);

  const newest = (await tool("get_run_log", { runId: id })).structuredContent;
  assert.equal(newest.size, size);
  assert.equal(newest.to, size);
  assert.equal(newest.next, null);
  assert.deepEqual(newest.entries.at(-1), { kind: "text", text: "line 2999" });
  // Whole lines only: the page starts at one.
  assert.equal(log[newest.from - 1], "\n");
  assert.ok(size - newest.from <= PAGE_BYTES);
  // Far less than the log was read, and never more than a page at once.
  const bytes = reads.reduce((sum, r) => sum + r.got, 0);
  assert.ok(bytes < 2 * PAGE_BYTES, `${bytes} bytes read`);
  assert.ok(reads.every((r) => r.length <= PAGE_BYTES + 1));

  // Back to the start, page by page, then forward again: every line once, in order.
  const pages = [newest];
  for (let page = newest; page.previous;) {
    page = (await tool("get_run_log", { runId: id, ...page.previous })).structuredContent;
    pages.unshift(page);
  }
  assert.equal(pages[0].from, 0);
  const seen = pages.flatMap((p) => p.entries.filter((e) => e.kind === "text").map((e) => e.text));
  assert.deepEqual(
    seen,
    lines.map((_, i) => `line ${String(i).padStart(4, "0")}`),
  );
  for (let i = 1; i < pages.length; i++) assert.equal(pages[i].from, pages[i - 1].to);
  let forward = (await tool("get_run_log", { runId: id, from: 0, limit: 2048 })).structuredContent;
  assert.equal(forward.entries[0].kind, "meta");
  forward = (await tool("get_run_log", { runId: id, ...forward.next })).structuredContent;
  assert.equal(log[forward.from - 1], "\n");

  // A page starting mid-line starts at the next line.
  const mid = (await tool("get_run_log", { runId: id, from: 50, limit: 1024 })).structuredContent;
  assert.ok(mid.from > 50);
  assert.equal(log[mid.from - 1], "\n");
  // An older page's cursor near the start covers what is left, however little.
  const second = (await tool("get_run_log", { runId: id, from: 0, limit: 300 })).structuredContent;
  const after = (await tool("get_run_log", { runId: id, from: second.next.from }))
    .structuredContent;
  assert.deepEqual(after.previous, { from: 0, limit: after.from });
  const first = (await tool("get_run_log", { runId: id, ...after.previous })).structuredContent;
  assert.equal(first.to, after.from);
  assert.equal((await tool("get_run_log", { runId: id, limit: MAX_PAGE_BYTES + 1 })).isError, true);
  assert.equal((await tool("get_run_log", { runId: id, from: -1 })).isError, true);
  assert.equal((await tool("get_run_log", { runId: id, page: 2 })).isError, true);
});

// Every page of a run's log, from its newest back to its start (`previous`), oldest first: each
// strictly before the one after it, so none comes back.
async function pagesBack(tool, runId, limit) {
  const pages = [(await tool("get_run_log", { runId, limit })).structuredContent];
  while (pages[0].previous) {
    const page = (await tool("get_run_log", { runId, ...pages[0].previous })).structuredContent;
    assert.ok(page.from < pages[0].from, `${page.from} before ${pages[0].from}`);
    pages.unshift(page);
  }
  return pages;
}

test("MCP: get_run_log pages back over a line longer than a page, in the middle and last", async (t) => {
  const long = "x".repeat(100_000);
  const short = (n) => Array.from({ length: n }, (_, i) => text(`short ${i}`)).join("");
  const logs = {
    middle: line({ type: "listener", key: "org/repo#1" }) + short(50) + text(long) + short(3),
    last: line({ type: "listener", key: "org/repo#1" }) + short(50) + text(long),
  };
  const runs = Object.keys(logs).map((id) => runOf("org/repo#1", id));
  const { ctx } = orchestrator({ runs, logs });
  const { tool } = await serveMcp(t, ctx);
  const limit = 64 * 1024;
  for (const id of Object.keys(logs)) {
    const pages = await pagesBack(tool, id, limit);
    assert.equal(pages[0].from, 0, id);
    assert.equal(pages.at(-1).to, Buffer.byteLength(logs[id]), id);
    // Each page ends where the next one starts: every line once, the long one whole.
    for (let i = 1; i < pages.length; i++) assert.equal(pages[i].from, pages[i - 1].to, id);
    const texts = pages.flatMap((p) => p.entries.filter((e) => e.kind === "text"));
    assert.equal(texts.filter((e) => e.text === long).length, 1, id);
    assert.equal(texts.length, id === "middle" ? 54 : 51, id);
  }
  // The newest page of the second: the long line itself, read whole.
  const newest = (await tool("get_run_log", { runId: "last", limit })).structuredContent;
  assert.deepEqual(newest.entries, [{ kind: "text", text: long }]);
});

test("MCP: a running run gives what it has written, its last line once it is whole", async (t) => {
  const id = "org-repo-1-1000";
  const run = runOf("org/repo#1", id, { status: "running", finishedAt: null, phase: "work" });
  const logs = {
    [id]: line({ type: "listener", key: "org/repo#1" }) + text("so far") + '{"type":"assis',
  };
  const { ctx } = orchestrator({ runs: [run], logs });
  const { tool } = await serveMcp(t, ctx);
  const page = (await tool("get_run_log", { runId: id })).structuredContent;
  assert.equal(page.status, "running");
  assert.deepEqual(page.entries.at(-1), { kind: "text", text: "so far" });
  assert.deepEqual(page.next, { from: page.to, limit: PAGE_BYTES });
  const tasks = (await tool("list_tasks", { state: "working" })).structuredContent.tasks;
  assert.deepEqual(
    tasks.map((x) => x.key),
    ["org/repo#1"],
  );
  const schedule = (await tool("get_schedule")).structuredContent;
  assert.deepEqual(schedule.running, [
    { key: "org/repo#1", title: "Title of org/repo#1", state: "working", run: id },
  ]);
  assert.equal(schedule.slots.running, 1);
});

test("MCP: get_schedule says what waits for what, and the lanes, of the repos the login sees", async (t) => {
  const waits = [
    { key: "org/repo#3", repo: "org/repo", kind: "issue", mode: "work", blockers: [2], since: 10 },
    {
      key: "org/secret#4",
      repo: "org/secret",
      kind: "issue",
      mode: "work",
      blockers: [1],
      since: 10,
    },
  ];
  const { ctx } = orchestrator({
    runs: [runOf("org/repo#2", "org-repo-2-1000", { status: "running", finishedAt: null })],
    extra: {
      waits: { list: () => waits },
      lanes: {
        parentKeys: () => [],
        fill: () => {},
        labels: (keys) =>
          Object.fromEntries(keys.map((key) => [key, { name: "Auth", source: "user", at: 1 }])),
      },
    },
  });
  const { tool } = await serveMcp(t, ctx);
  const { structuredContent: s, content } = await tool("get_schedule", { repo: "org/repo" });
  assert.deepEqual(s.waiting, [
    {
      key: "org/repo#3",
      title: "Title of org/repo#3",
      state: "waiting",
      waitsFor: [{ key: "org/repo#2", title: "Title of org/repo#2", closed: null }],
    },
  ]);
  assert.deepEqual(s.lanes, [
    { name: "Auth", source: "user", tasks: ["org/repo#2", "org/repo#3"] },
  ]);
  assert.match(content[0].text, /org\/repo#3 Title of org\/repo#3 waits for org\/repo#2/);
  const all = (await tool("get_schedule")).structuredContent;
  assert.doesNotMatch(JSON.stringify(all), /secret/);
});
