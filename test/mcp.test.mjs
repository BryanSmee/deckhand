// The MCP server's tools (listener/mcp.mjs, #482), as edge passes /mcp on to the orchestrator
// (listener/http.mjs): the transport, and what each tool shows the login, no more than the
// dashboard does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttp } from "../listener/http.mjs";
import { createMachines, ONLINE_MS, WARNING } from "../listener/machines.mjs";
import { Refused } from "../lib/http.mjs";
import { agentFor } from "../listener/agents/index.mjs";
import {
  MAX_PAGE_BYTES,
  MAX_TASKS_PAGE,
  PAGE_BYTES,
  PROTOCOL_VERSIONS,
  TASKS_PAGE,
} from "../listener/mcp.mjs";
import { createRepoApi } from "../listener/repos.mjs";
import { reader } from "../listener/runlog.mjs";
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
  assert.equal((await rpc("tools/call", { name: "nope" })).error.code, -32602);

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

test("MCP: a token without deckhand:read lists no read tool, and calls none", async (t) => {
  const { ctx } = orchestrator();
  const { rpc, tool } = await serveMcp(t, ctx);
  const scopes = "deckhand:machine";
  assert.deepEqual(
    (await rpc("tools/list", {}, { scopes })).tools.map((x) => x.name),
    [
      "register_machine",
      "heartbeat",
      "claim",
      "post_events",
      "next_message",
      "ask",
      "finish",
      "approve_permission",
      "release",
      "unregister_machine",
    ],
  );
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
  assert.deepEqual(tasks.structuredContent.tasks[0], {
    key: "org/repo#1",
    number: 1,
    kind: "issue",
    state: "done",
    title: "Title of org/repo#1",
    pr: null,
    runs: 2,
    lastRun: { id: "org-repo-1-1000", status: "ok" },
  });
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

test("MCP: list_tasks gives a page of tasks at a time, and where the next starts", async (t) => {
  const runs = Array.from({ length: 30 }, (_, i) =>
    runOf(`org/repo#${i + 1}`, `org-repo-${i + 1}-1000`, { startedAt: 1000 + i }),
  );
  const { ctx } = orchestrator({ runs });
  const { tool } = await serveMcp(t, ctx);
  const first = await tool("list_tasks");
  assert.equal(first.structuredContent.tasks.length, TASKS_PAGE);
  assert.equal(first.structuredContent.total, 30);
  assert.equal(first.structuredContent.next, TASKS_PAGE);
  assert.match(first.content[0].text, /^30 tasks, 1–25 here\. More: offset=25\./);
  const rest = (await tool("list_tasks", { offset: TASKS_PAGE })).structuredContent;
  assert.equal(rest.tasks.length, 30 - TASKS_PAGE);
  assert.equal(rest.next, null);
  const keys = [...first.structuredContent.tasks, ...rest.tasks].map((x) => x.key);
  assert.equal(new Set(keys).size, 30);
  const small = (await tool("list_tasks", { limit: 2, offset: 1 })).structuredContent;
  assert.deepEqual(
    small.tasks.map((x) => x.key),
    keys.slice(1, 3),
  );
  assert.equal(small.next, 3);
  assert.deepEqual((await tool("list_tasks", { offset: 99 })).structuredContent.tasks, []);
  assert.equal((await tool("list_tasks", { limit: MAX_TASKS_PAGE + 1 })).isError, true);
  assert.equal((await tool("list_tasks", { offset: -1 })).isError, true);
});

test("MCP: a task's row says its mode, wait and questions only when it has them", async (t) => {
  const asked = { items: [{ title: "Phones", text: "Which way?" }], raw: "1. Which way?" };
  const runs = [
    runOf("org/repo#1", "org-repo-1-1000", { taskMode: "review" }),
    runOf("org/repo#2", "org-repo-2-1000", { status: "needs-input", questions: asked }),
    runOf("org/repo#3", "org-repo-3-1000", { status: "error", items: [{ text: "go" }] }),
  ];
  const waits = [
    { key: "org/repo#4", repo: "org/repo", kind: "issue", mode: "work", blockers: [1], since: 10 },
  ];
  const { ctx } = orchestrator({ runs, extra: { waits: { list: () => waits } } });
  const { tool } = await serveMcp(t, ctx);
  const rows = Object.fromEntries(
    (await tool("list_tasks")).structuredContent.tasks.map((x) => [x.key, x]),
  );
  const extras = (row) =>
    Object.fromEntries(
      ["mode", "position", "waitingFor", "questions", "rerunnable"]
        .filter((k) => k in row)
        .map((k) => [k, row[k]]),
    );
  assert.deepEqual(extras(rows["org/repo#1"]), { mode: "review" });
  assert.deepEqual(extras(rows["org/repo#2"]), { questions: 1 });
  assert.deepEqual(extras(rows["org/repo#3"]), { rerunnable: true });
  assert.deepEqual(extras(rows["org/repo#4"]), { waitingFor: [1] });
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
  // Whole lines only: the page starts at one, that of the line it would have cut.
  assert.equal(log[newest.from - 1], "\n");
  assert.ok(size - newest.from > PAGE_BYTES);
  assert.ok(size - newest.from < PAGE_BYTES + Buffer.byteLength(lines[0]));
  // Far less than the log was read, and never more than a page at once.
  const bytes = reads.reduce((sum, r) => sum + r.got, 0);
  assert.ok(bytes < 2 * PAGE_BYTES, `${bytes} bytes read`);
  // (The newest page's, a page and the start of the line it would have cut.)
  assert.ok(reads.every((r) => r.length <= PAGE_BYTES + Buffer.byteLength(lines[0]) + 1));

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

test("MCP: the newest page of a log takes in the line it would cut, when it is near", async (t) => {
  const entry = (n) => text(`${n}`.repeat(40));
  const log = line({ type: "listener", key: "org/repo#1" }) + entry(1) + entry(2) + text("end");
  const [two, end] = [Buffer.byteLength(entry(2)), Buffer.byteLength(text("end"))];
  const runs = [runOf("org/repo#1", "org-repo-1-1000")];
  const { ctx } = orchestrator({ runs, logs: { "org-repo-1-1000": log } });
  const { tool } = await serveMcp(t, ctx);
  // `limit` bytes from the end falls inside entry 2's line, which starts less than `limit`
  // before it: the page starts at it, not after it.
  const limit = end + two - 10;
  const page = (await tool("get_run_log", { runId: "org-repo-1-1000", limit })).structuredContent;
  assert.deepEqual(
    page.entries.map((e) => e.text),
    ["2".repeat(40), "end"],
  );
  // Further back than `limit`: the page starts at the next line, as before.
  const tight = (await tool("get_run_log", { runId: "org-repo-1-1000", limit: end + 5 }))
    .structuredContent;
  assert.deepEqual(
    tight.entries.map((e) => e.text),
    ["end"],
  );
  assert.equal(tight.previous.from + tight.previous.limit, tight.from);
});

test("MCP: the newest page takes in a line starting exactly `limit` bytes before it, no further", async (t) => {
  // A long line, then a short one, so that `limit` (half their length) puts the page's start
  // inside the long line, exactly `limit` bytes after the long line's start.
  const end = Buffer.byteLength(text("end"));
  let long = text("x".repeat(80));
  if ((Buffer.byteLength(long) + end) % 2) long = text("x".repeat(81));
  const log = line({ type: "listener", key: "org/repo#1" }) + long + text("end");
  const runs = [runOf("org/repo#1", "org-repo-1-1000")];
  const { ctx } = orchestrator({ runs, logs: { "org-repo-1-1000": log } });
  const { tool } = await serveMcp(t, ctx);
  const limit = (Buffer.byteLength(long) + end) / 2;
  const at = (n) => tool("get_run_log", { runId: "org-repo-1-1000", limit: n });
  const exact = (await at(limit)).structuredContent;
  assert.equal(exact.from, Buffer.byteLength(log) - Buffer.byteLength(long) - end);
  // A byte less: that line starts further back than `limit`, so the page starts after it.
  const less = (await at(limit - 1)).structuredContent;
  assert.equal(less.from, Buffer.byteLength(log) - end);
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

// A page from the middle of a log reads as that part of the whole log does (#889): a chat's
// messages, the image's build as its steps, a line timed by the `at` line before the page.
test("MCP: get_run_log reads a page from the middle as the whole log reads there", async (t) => {
  const id = "org-repo-1-1000";
  const listener = (fields) => line({ type: "listener", ...fields });
  const at = (ms) => listener({ event: "at", at: ms });
  const setup = Array.from({ length: 50 }, (_, i) => `Setup line ${i}\n`).join("");
  const build = Array.from({ length: 300 }, (_, i) => `#5 0.${i} npm output ${i}\n`).join("");
  const work = Array.from({ length: 2000 }, (_, i) => text(`work ${i}`)).join("");
  const call = line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
  });
  const prepared =
    listener({ mode: "start", kind: "chat", key: "org/repo#1" }) +
    listener({ event: "phase", phase: "setup", at: 1000 }) +
    setup +
    listener({ event: "phase", phase: "image", at: 2000 }) +
    at(7000) +
    "#5 [stage 1/2] RUN npm ci\n" +
    build +
    "#5 DONE 3.0s\n" +
    listener({ event: "phase", phase: "setup", at: 3000 }) +
    listener({ event: "phase", phase: "work", at: 4000 });
  const tail = at(9000) + call + listener({ event: "delivered", at: 9500, message: "Hi" });
  const log = prepared + work + tail + work;
  const { ctx, reads } = orchestrator({ runs: [runOf("org/repo#1", id)], logs: { [id]: log } });
  const { tool } = await serveMcp(t, ctx);
  const whole = log.split("\n").flatMap(reader(agentFor("claude")));

  // Every page, small ones, back to the start: together, what the whole log reads as.
  const pages = await pagesBack(tool, id, 2048);
  assert.ok(pages.length > 20);
  assert.deepEqual(
    pages.flatMap((p) => p.entries),
    JSON.parse(JSON.stringify(whole)),
  );

  const page = async (from) => (await tool("get_run_log", { runId: id, from })).structuredContent;
  // In the build: its lines are its step's output, its end the step's, as started at 7000.
  const inBuild = await page(Buffer.byteLength(prepared) - 3000);
  assert.deepEqual(
    inBuild.entries.find((e) => e.kind === "raw"),
    {
      kind: "raw",
      step: 5,
      text: inBuild.entries.find((e) => e.kind === "raw").text,
    },
  );
  assert.match(inBuild.entries.find((e) => e.kind === "raw").text, /^npm output \d+$/);
  assert.deepEqual(
    inBuild.entries.filter((e) => e.kind === "step"),
    [
      {
        kind: "step",
        step: 5,
        stage: "stage 1/2",
        name: "RUN npm ci",
        status: "done",
        seconds: 3,
        error: null,
        at: 7000,
      },
    ],
  );

  // Right after an `at` line: the page's first line has its time; a chat's message is one.
  const start = Buffer.byteLength(prepared + work + at(9000));
  reads.length = 0;
  const timed = await page(start);
  assert.equal(timed.from, start);
  assert.deepEqual(timed.entries.slice(0, 2), [
    { kind: "tool", name: "Bash", text: "ls", id: "t1", at: 9000 },
    { kind: "message", text: "Hi" },
  ]);
  // The preparation read, and the line before the page, not the work between them.
  const skipped = [Buffer.byteLength(prepared) + PAGE_BYTES, start - 128];
  assert.ok(skipped[1] - skipped[0] > PAGE_BYTES);
  assert.ok(
    reads.every((r) => r.offset + r.got <= skipped[0] || r.offset >= skipped[1]),
    JSON.stringify(reads),
  );
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

// --- The write tools (#483) ------------------------------------------------------------------

// The work area's MCP way in (work.mjs `mcp`, tested there), recording what it was asked:
// `answer(kind, ...args)` its message, or a throw.
function workArea(answer = () => "Done.") {
  const asked = [];
  const mcp = {
    rerun: async (...args) => (asked.push(["rerun", ...args]), answer("rerun", ...args)),
    schedule: async (...args) => (asked.push(["schedule", ...args]), answer("schedule", ...args)),
  };
  return { asked, mcp };
}

const WRITE = "deckhand:read deckhand:work";

test("MCP: rerun and schedule need deckhand:work, and say they act", async (t) => {
  const area = workArea();
  const { ctx } = orchestrator();
  ctx.workApi.mcp = area.mcp;
  const { rpc, tool } = await serveMcp(t, ctx);
  const names = async (scopes) =>
    (await rpc("tools/list", {}, { scopes })).tools.map((x) => x.name);
  assert.ok(!(await names("deckhand:read")).includes("rerun"));
  assert.deepEqual(await names("deckhand:work"), ["rerun", "schedule"]);
  const { tools } = await rpc("tools/list", {}, { scopes: WRITE });
  for (const name of ["rerun", "schedule"]) {
    const x = tools.find((y) => y.name === name);
    assert.equal(x.annotations.readOnlyHint, false, name);
    assert.equal(x.annotations.destructiveHint, true, name);
  }
  // A token with deckhand:read alone: refused before the work area is asked.
  for (const [name, args] of [
    ["rerun", { runId: "r" }],
    ["schedule", { repo: "org/repo", number: 1, action: "start" }],
  ]) {
    const refused = await tool(name, args);
    assert.equal(refused.isError, true, name);
    assert.match(refused.content[0].text, /deckhand:work/);
  }
  assert.deepEqual(area.asked, []);
});

test("MCP: schedule and rerun answer the dashboard's message, its refusals as tool errors", async (t) => {
  const area = workArea((kind, user, ...args) => {
    if (kind === "rerun" && args[0] === "hidden")
      throw new Refused(404, "No run hidden among those you see.");
    if (kind === "schedule" && args[1].number === 9) {
      throw new Refused(409, "#9 is running or queued: it can't be moved now.");
    }
    return kind === "rerun" ? "Rerun of #5 queued." : `#${args[1].number} started.`;
  });
  const { ctx } = orchestrator();
  ctx.workApi.mcp = area.mcp;
  const { tool } = await serveMcp(t, ctx);
  const as = { scopes: WRITE };

  const rerun = await tool("rerun", { runId: "org-repo-5-1" }, as);
  assert.equal(rerun.isError, undefined);
  assert.equal(rerun.content[0].text, "Rerun of #5 queued.");
  assert.deepEqual(rerun.structuredContent, { message: "Rerun of #5 queued." });
  const hidden = await tool("rerun", { runId: "hidden" }, as);
  assert.equal(hidden.isError, true);
  assert.equal(hidden.content[0].text, "No run hidden among those you see.");

  const started = await tool("schedule", { repo: "org/repo", number: 5, action: "start" }, as);
  assert.equal(started.content[0].text, "#5 started.");
  await tool(
    "schedule",
    { repo: "org/repo", number: 6, action: "queue", after: 5, mode: "brainstorm", pr: null },
    as,
  );
  const busy = await tool("schedule", { repo: "org/repo", number: 9, action: "start" }, as);
  assert.equal(busy.isError, true);
  assert.match(busy.content[0].text, /^#9 is running or queued/);
  // Its arguments are the dashboard's body, checked there; what isn't it is refused here.
  assert.deepEqual(area.asked, [
    ["rerun", "alice", "org-repo-5-1"],
    ["rerun", "alice", "hidden"],
    ["schedule", "alice", "org/repo", { action: "start", number: 5 }],
    ["schedule", "alice", "org/repo", { action: "queue", number: 6, after: 5, mode: "brainstorm" }],
    ["schedule", "alice", "org/repo", { action: "start", number: 9 }],
  ]);
  for (const args of [
    { repo: "org/repo", number: 5, action: "stop" },
    { repo: "org", number: 5, action: "start" },
    { repo: "org/repo", number: 5 },
    { repo: "org/repo", number: 5, action: "start", extra: 1 },
  ]) {
    const refused = await tool("schedule", args, as);
    assert.equal(refused.isError, true, JSON.stringify(args));
  }
  assert.equal((await tool("rerun", {}, as)).isError, true);
  assert.equal(area.asked.length, 5);
  // Anything else failing: the logs say why, not the client.
  const broken = workArea(() => {
    throw new Error("GitHub down");
  });
  ctx.workApi.mcp = broken.mcp;
  const failed = await tool("rerun", { runId: "r" }, as);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /orchestrator's logs/);
});

// The machines of alice and bob (listener/machines.mjs): org/repo grants machines and opts in
// for `unreal` machines, org/secret does neither.
function withMachines(ctx, clock = { now: 1_000_000 }) {
  ctx.machines = createMachines({
    config: ctx.config,
    repoNames: async () => ["org/repo", "org/secret"],
    granted: async (repo) => repo === "org/repo",
    settings: async (repo) => ({
      settings: { machines: repo === "org/repo" ? { labels: ["unreal"] } : null },
      errors: [],
    }),
    mayRun: async () => true,
    now: () => clock.now,
  });
  return clock;
}

const MACHINE = { scopes: "deckhand:machine" };

test("MCP: register, heartbeat and unregister a machine with deckhand:machine, refused without", async (t) => {
  const { ctx } = orchestrator();
  const clock = withMachines(ctx);
  const { rpc, tool } = await serveMcp(t, ctx);
  // Not listed nor called with the other scopes.
  const listed = (await rpc("tools/list", {}, { scopes: "deckhand:read deckhand:work" })).tools;
  assert.ok(!listed.some((x) => x.name.includes("machine") || x.name === "heartbeat"));
  for (const [name, args] of [
    ["register_machine", { name: "desk", repos: ["org/*"] }],
    ["heartbeat", { machine: "0123456789abcdef" }],
    ["unregister_machine", { machine: "0123456789abcdef" }],
  ]) {
    const refused = await tool(name, args, { scopes: "deckhand:read deckhand:work" });
    assert.equal(refused.isError, true, name);
    assert.match(refused.content[0].text, /deckhand:machine/, name);
  }
  assert.deepEqual(ctx.machines.list("alice"), []);

  const { tools } = await rpc("tools/list", {}, MACHINE);
  for (const x of tools) {
    assert.equal(x.annotations.readOnlyHint, false, x.name);
    assert.equal(x.annotations.openWorldHint, false, x.name);
  }
  assert.ok(tools.find((x) => x.name === "register_machine").description.includes(WARNING));

  const registered = await tool(
    "register_machine",
    { name: "desk", labels: ["Unreal", "gpu"], repos: ["org/*"], version: "0.1.0" },
    MACHINE,
  );
  assert.equal(registered.isError, undefined, registered.content[0].text);
  const { machine, offered, warning } = registered.structuredContent;
  assert.match(machine.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(
    { ...machine, id: null },
    {
      id: null,
      name: "desk",
      labels: ["unreal", "gpu"],
      capacity: 1,
      repos: ["org/*"],
      version: "0.1.0",
      online: true,
      seenAt: clock.now,
    },
  );
  // org/secret neither grants nor opts in; org/repo takes its `unreal` label alone.
  assert.deepEqual(offered, [{ repo: "org/repo", labels: ["unreal"] }]);
  assert.equal(warning, WARNING);
  assert.match(registered.content[0].text, /Warning: An agent will run on this machine/);
  assert.match(registered.content[0].text, /- org\/repo \(unreal\)/);

  // Offline once its heartbeats stop; a heartbeat brings it back.
  clock.now += ONLINE_MS;
  assert.equal(ctx.machines.list("alice")[0].online, false);
  const beat = await tool("heartbeat", { machine: machine.id, version: "0.1.1" }, MACHINE);
  assert.equal(beat.structuredContent.machine.online, true);
  assert.equal(beat.structuredContent.machine.version, "0.1.1");
  assert.equal(ctx.machines.list("alice")[0].seenAt, clock.now);

  // The same name again: the same machine, its fields replaced.
  const again = await tool(
    "register_machine",
    { name: "desk", repos: ["org/repo"], capacity: 2 },
    MACHINE,
  );
  assert.equal(again.structuredContent.machine.id, machine.id);
  assert.equal(again.structuredContent.machine.capacity, 2);
  // Not offered: it has no `unreal` label any more.
  assert.deepEqual(again.structuredContent.offered, []);
  assert.match(again.content[0].text, /None: no repository/);

  const bad = await tool("register_machine", { name: "desk", repos: ["nope"] }, MACHINE);
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /isn't "owner\/name" or "owner\/\*"/);

  const gone = await tool("unregister_machine", { machine: machine.id }, MACHINE);
  assert.equal(gone.content[0].text, "desk is unregistered.");
  assert.deepEqual(ctx.machines.list("alice"), []);
  const after = await tool("heartbeat", { machine: machine.id }, MACHINE);
  assert.equal(after.isError, true);
  assert.match(after.content[0].text, /register it again/);
});

test("MCP: claim, heartbeat with the claims' runs, and release, with deckhand:machine", async (t) => {
  const { ctx } = orchestrator();
  withMachines(ctx);
  const asked = [];
  let work = null;
  ctx.claims = {
    claim: async (user, id) => (asked.push(["claim", user, id]), work),
    renew: (user, id, runs) => (
      asked.push(["renew", user, id, runs]),
      [{ run: "r1", key: "org/repo#12", leaseUntil: 5 }]
    ),
    release: (user, id, run) => {
      asked.push(["release", user, id, run]);
      if (run !== "r1") throw new Refused(404, "No claim r2 on this machine.");
      return "org/repo#12";
    },
  };
  const { tool } = await serveMcp(t, ctx);
  const desk = await tool("register_machine", { name: "desk", repos: ["org/repo"] }, MACHINE);
  const id = desk.structuredContent.machine.id;
  const refused = await tool("claim", { machine: id }, { scopes: "deckhand:work" });
  assert.match(refused.content[0].text, /deckhand:machine/);
  const none = await tool("claim", { machine: id }, MACHINE);
  assert.deepEqual(none.structuredContent, { work: null });
  assert.equal(none.content[0].text, "Nothing to take now: claim again.");
  work = { run: "r1", key: "org/repo#12", mode: "work", branch: "issue-12-x", resume: true };
  const claimed = await tool("claim", { machine: id }, MACHINE);
  assert.deepEqual(claimed.structuredContent.work, work);
  assert.match(
    claimed.content[0].text,
    /^Claimed org\/repo#12 \(work, its session goes on\): run r1/,
  );
  const beat = await tool("heartbeat", { machine: id, runs: ["r1"] }, MACHINE);
  assert.deepEqual(beat.structuredContent.claims, [
    { run: "r1", key: "org/repo#12", leaseUntil: 5 },
  ]);
  assert.equal((await tool("heartbeat", { machine: id, runs: "r1" }, MACHINE)).isError, true);
  const released = await tool("release", { machine: id, run: "r1" }, MACHINE);
  assert.deepEqual(released.structuredContent, { released: "r1", key: "org/repo#12" });
  const wrong = await tool("release", { machine: id, run: "r2" }, MACHINE);
  assert.equal(wrong.isError, true);
  assert.equal(wrong.content[0].text, "No claim r2 on this machine.");
  assert.deepEqual(asked, [
    ["claim", "alice", id],
    ["claim", "alice", id],
    ["renew", "alice", id, ["r1"]],
    ["release", "alice", id, "r1"],
    ["release", "alice", id, "r2"],
  ]);
});

test("MCP: a claim's run tools (#597): its output, messages, question and end, under the protocol it speaks", async (t) => {
  const { ctx } = orchestrator();
  withMachines(ctx);
  const asked = [];
  ctx.claims = {
    claim: async (user, id, options) => (asked.push(["claim", options.reported]), null),
    post: async (user, id, run, lines, from) => {
      asked.push(["post", run, lines.length, from]);
      if (from > 3) throw new Refused(409, "Lines from 9 sent, but the run has 3: send from 3.");
      return { key: "org/repo#12", next: (from ?? 0) + lines.length };
    },
    nextMessage: async (user, id, run, from) => (
      asked.push(["next", run, from]),
      { messages: ["New comment: the menu."], next: from + 1, closed: false }
    ),
    ask: async (user, id, run, question) => (
      asked.push(["ask", run, question]),
      { key: "org/repo#12", status: "needs-input" }
    ),
    finish: async (user, id, run, end) => (
      asked.push(["finish", run, end]),
      { key: "org/repo#12", status: end.outcome }
    ),
  };
  const { tool, url } = await serveMcp(t, ctx);
  const desk = await tool("register_machine", { name: "desk", repos: ["org/repo"] }, MACHINE);
  const machine = desk.structuredContent.machine.id;
  await tool("claim", { machine, agent: "codex", model: "gpt-5", protocol: 1 }, MACHINE);
  const unknown = await tool("claim", { machine, agent: "gpt-7" }, MACHINE);
  assert.equal(unknown.isError, true);
  // A protocol this copy doesn't speak: the driver is told to update.
  const newer = await tool("post_events", { machine, run: "r1", lines: [], protocol: 2 }, MACHINE);
  assert.equal(newer.isError, true);
  assert.match(newer.content[0].text, /`protocol` 2 isn't one this Deckhand speaks: 1\. Update/);
  // Its lines, a large batch included: a machine's call may be up to 1 MB.
  const line = JSON.stringify({ type: "assistant", pad: "x".repeat(200_000) });
  const posted = await tool("post_events", { machine, run: "r1", lines: [line], from: 0 }, MACHINE);
  assert.deepEqual(posted.structuredContent, { next: 1 });
  assert.equal(posted.content[0].text, "1 line taken: send from 1.");
  const late = await tool("post_events", { machine, run: "r1", lines: ["{}"], from: 9 }, MACHINE);
  assert.equal(late.isError, true);
  assert.match(late.content[0].text, /send from 3/);
  const many = Array.from({ length: 1001 }, () => "{}");
  assert.equal(
    (await tool("post_events", { machine, run: "r1", lines: many }, MACHINE)).isError,
    true,
  );
  const message = await tool("next_message", { machine, run: "r1", from: 2 }, MACHINE);
  assert.deepEqual(message.structuredContent, {
    messages: ["New comment: the menu."],
    next: 3,
    closed: false,
  });
  const question = await tool(
    "ask",
    { machine, run: "r1", question: "1. **Menu**: which?" },
    MACHINE,
  );
  assert.deepEqual(question.structuredContent, { key: "org/repo#12", status: "needs-input" });
  const wrong = await tool("finish", { machine, run: "r1", outcome: "great" }, MACHINE);
  assert.equal(wrong.isError, true);
  const done = await tool(
    "finish",
    { machine, run: "r1", outcome: "ok", reply: "Built." },
    MACHINE,
  );
  assert.deepEqual(done.structuredContent, { key: "org/repo#12", status: "ok" });
  // Not with another scope.
  const work = await tool(
    "finish",
    { machine, run: "r1", outcome: "ok" },
    { scopes: "deckhand:work" },
  );
  assert.match(work.content[0].text, /deckhand:machine/);
  assert.deepEqual(asked, [
    ["claim", { agent: "codex", model: "gpt-5", effort: null }],
    ["post", "r1", 1, 0],
    ["post", "r1", 1, 9],
    ["next", "r1", 2],
    ["ask", "r1", "1. **Menu**: which?"],
    ["finish", "r1", { outcome: "ok", reply: "Built." }],
  ]);
  // The same body without deckhand:machine is past what the other tools' calls take.
  const large = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": "alice", "x-scopes": "deckhand:read" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: line }),
  }).catch((error) => error);
  assert.ok(large instanceof Error || large.status >= 400);
});

test("MCP: approve_permission (#600) waits on the owner's answer, then says it as Claude Code's permission prompt reads it", async (t) => {
  const { ctx } = orchestrator();
  withMachines(ctx);
  const asked = [];
  // Pending at the first call, allowed at the second, denied for another tool.
  ctx.claims = {
    approve: async (user, id, run, ask) => {
      asked.push([user, run, ask]);
      if (ask.tool === "WebFetch") {
        return { request: "r-2", state: "denied", message: "Denied by alice." };
      }
      return asked.length === 1
        ? { request: "r-1", state: "pending", message: null }
        : { request: "r-1", state: "granted", message: "Allowed by alice once." };
    },
  };
  const { tool } = await serveMcp(t, ctx);
  const desk = await tool("register_machine", { name: "desk", repos: ["org/repo"] }, MACHINE);
  const machine = desk.structuredContent.machine.id;
  const call = {
    machine,
    run: "r1",
    tool_name: "Bash",
    input: { command: "npm test" },
    tool_use_id: "toolu_1",
  };
  const waiting = await tool("approve_permission", call, MACHINE);
  assert.deepEqual(waiting.structuredContent, { request: "r-1", state: "pending" });
  assert.match(waiting.content[0].text, /call again with the same tool_use_id/);
  const allowed = await tool("approve_permission", call, MACHINE);
  assert.deepEqual(JSON.parse(allowed.content[0].text), {
    behavior: "allow",
    updatedInput: { command: "npm test" },
  });
  assert.equal(allowed.structuredContent.state, "granted");
  const denied = await tool(
    "approve_permission",
    { ...call, tool_name: "WebFetch", tool_use_id: "toolu_2" },
    MACHINE,
  );
  assert.deepEqual(JSON.parse(denied.content[0].text), {
    behavior: "deny",
    message: "Denied by alice.",
  });
  // Its input is an object; its tool_use_id required.
  assert.equal((await tool("approve_permission", { ...call, input: "ls" }, MACHINE)).isError, true);
  const { tool_use_id: _, ...anonymous } = call;
  assert.equal((await tool("approve_permission", anonymous, MACHINE)).isError, true);
  assert.deepEqual(
    asked.map(([user, run, ask]) => [user, run, ask.tool, ask.toolUseId]),
    [
      ["alice", "r1", "Bash", "toolu_1"],
      ["alice", "r1", "Bash", "toolu_1"],
      ["alice", "r1", "WebFetch", "toolu_2"],
    ],
  );
});

test("MCP: a machine is listed and reached by its owner alone", async (t) => {
  const { ctx } = orchestrator();
  withMachines(ctx);
  const { url, tool } = await serveMcp(t, ctx);
  const alice = await tool("register_machine", { name: "desk", repos: ["org/repo"] }, MACHINE);
  const id = alice.structuredContent.machine.id;
  // Bob's own of the same name is another machine.
  const bob = await tool(
    "register_machine",
    { name: "desk", repos: ["org/repo"] },
    { ...MACHINE, user: "bob" },
  );
  assert.notEqual(bob.structuredContent.machine.id, id);
  for (const [name, args] of [
    ["heartbeat", { machine: id }],
    ["unregister_machine", { machine: id }],
  ]) {
    const refused = await tool(name, args, { ...MACHINE, user: "bob" });
    assert.equal(refused.isError, true, name);
    assert.equal(refused.content[0].text, `No machine ${id} of yours: register it again.`);
  }
  // The dashboard's list: each their own.
  const list = async (user) =>
    (await (await fetch(`${url}/api/machines`, { headers: { "x-user": user } })).json()).machines;
  const listed = (await list("alice")).map((m) => m.id);
  assert.deepEqual(listed, [id]);
  assert.deepEqual(
    (await list("bob")).map((m) => m.id),
    [bob.structuredContent.machine.id],
  );
  // Bob's Remove of Alice's machine is refused; hers goes through, from the dashboard's page.
  const remove = (user, origin = url) =>
    fetch(`${url}/api/machines/${id}/remove`, {
      method: "POST",
      headers: { "x-user": user, origin, host: new URL(url).host },
    });
  assert.equal((await remove("bob")).status, 404);
  assert.equal((await remove("alice", "https://elsewhere.example")).status, 403);
  const removed = await remove("alice");
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: id });
  assert.deepEqual(await list("alice"), []);
  assert.equal((await list("bob")).length, 1);
});

test("MCP: a login taken out of ALLOWED_USERS loses its machines at once", async (t) => {
  const { ctx } = orchestrator();
  withMachines(ctx);
  const { tool } = await serveMcp(t, ctx);
  const desk = await tool("register_machine", { name: "desk", repos: ["org/repo"] }, MACHINE);
  const id = desk.structuredContent.machine.id;
  ctx.config.users = ["bob"];
  assert.deepEqual(ctx.machines.list("alice"), []);
  const beat = await tool("heartbeat", { machine: id }, MACHINE);
  assert.equal(beat.isError, true);
  await assert.rejects(ctx.machines.offers("alice", id), /No machine/);
  // Back in, the machine is there again, offline until its next heartbeat.
  ctx.config.users = ["alice", "bob"];
  assert.equal(ctx.machines.list("alice").length, 1);
});
