// Runs a previous listener left behind (restart.mjs): what the broker knows of them again.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { board } from "../listener/board.mjs";
import { createPulls } from "../listener/pulls.mjs";
import {
  createRestart,
  liveRunIds,
  LIVE_PREFIX,
  QUEUE_KEY,
  savedCapabilities,
} from "../listener/restart.mjs";
import { createTasks, newTask } from "../listener/tasks.mjs";
import { ambiguous, respellMap, respelled, spellings } from "../listener/spelling.mjs";
import { openLog } from "../listener/runlog.mjs";
import { createRuns } from "../listener/runs.mjs";
import { fileStore } from "../lib/store-file.mjs";
import { openStore, values } from "../lib/store.mjs";
import { logContext, withLogContext } from "../lib/log.mjs";
import {
  MEMBER,
  VIEWER,
  assertMode,
  fileLogs,
  localBroker,
  mapStore,
  permissionsOf,
  tempDir,
  until,
} from "./helpers.mjs";

// A run's saved state, as saveLive() writes it, in `store`. → its id, the broker's handle once
// restored.
async function saveRun(store, id, issue, record, more = {}) {
  const saved = {
    task: { repo: "org/repo", id: issue, kind: "issue" },
    id,
    mode: "work",
    light: false,
    record: { id, key: `org/repo#${issue}`, ...record },
    handled: [],
    unanswered: [],
    ...more,
  };
  await store.set(`${LIVE_PREFIX}${id}`, saved);
  return id;
}

// A run's saved state, as the store has it.
const savedRun = (store, id) => store.get(`${LIVE_PREFIX}${id}`);

// What restoreRuns() reads: a listener's state, its store in memory. `extra`: more of it.
function runContext(dir, extra = {}) {
  return {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: [],
    runsById: new Map(),
    runner: { closed: async () => false },
    runLogs: fileLogs(dir),
    broker: createBroker({}),
    running: 0,
    store: fileStore(),
    ...extra,
  };
}

test("a restored run's calls go to its provider, or its agent's own when none was saved", async (t) => {
  const dir = tempDir(t);
  const broker = createBroker({});
  const ctx = runContext(dir, { broker });
  const fallback = await saveRun(ctx.store, "r1", 1, {
    agent: "claude",
    provider: "openrouter",
    reason: "review-fix",
  });
  const codex = await saveRun(ctx.store, "r2", 2, { agent: "codex" });
  const old = await saveRun(ctx.store, "r3", 3, {});
  await createRestart(ctx).restoreRuns();
  assert.equal(broker.runOf(fallback).provider, "openrouter");
  // Why the listener started it, for the policies, as before the restart.
  assert.equal(broker.runOf(fallback).reason, "review-fix");
  assert.equal(broker.runOf(codex).reason, null);
  assert.equal(broker.runOf(codex).provider, "openai");
  // Saved before records named their agent: Claude Code's.
  assert.equal(broker.runOf(old).provider, "anthropic");
  // A refused call is a line in that run's log.
  broker.runOf(codex).note("Deckhand refused the agent's call GET /openai/files");
  assert.match(readFileSync(join(dir, "r2.log"), "utf8"), /"event":"note".*GET \/openai\/files/);
});

test("a restored run's pushes go on its record, saved with it", async (t) => {
  const dir = tempDir(t);
  const broker = createBroker({});
  const ctx = runContext(dir, { broker });
  // A review's commit (runs.mjs launch()) goes along too: its review is posted there. And
  // whether it has a container engine: the proxy's engines' port answers for it (#573).
  const secret = await saveRun(
    ctx.store,
    "r1",
    1,
    { agent: "claude" },
    { reviewFrom: "start1", engine: true },
  );
  await createRestart(ctx).restoreRuns();
  // What the git gateway calls once GitHub took a push.
  broker.runOf(secret).pushed({ branch: "issue-1-x", at: 1234 });
  const task = [...ctx.tasks.values()][0];
  assert.equal(task.live.record.branch, "issue-1-x");
  assert.equal(task.live.record.lastPushAt, 1234);
  await task.live.saving;
  const saved = await savedRun(ctx.store, "r1");
  assert.deepEqual([saved.record.branch, saved.record.lastPushAt], ["issue-1-x", 1234]);
  assert.deepEqual([task.live.reviewFrom, saved.reviewFrom], ["start1", "start1"]);
  assert.deepEqual([task.live.engine, saved.engine], [true, true]);
});

test("a restored run keeps the issues it created, the comments it posted and the workflow runs it reran, and saves those it adds next", async (t) => {
  const dir = tempDir(t);
  const broker = createBroker({});
  const ctx = runContext(dir, { broker });
  const secret = await saveRun(ctx.store, "r1", 1, { agent: "claude" });
  const saved = await savedRun(ctx.store, "r1");
  await ctx.store.set(`${LIVE_PREFIX}r1`, {
    ...saved,
    created: [
      { number: 30, at: 5 },
      { comment: 3000000001, at: 5 },
    ],
    reruns: [{ run_id: 70, sha: "abc", at: 4 }],
  });
  // Saved before runs kept them: none.
  const old = await saveRun(ctx.store, "r2", 2, { agent: "claude" });
  await createRestart(ctx).restoreRuns();
  const run = broker.runOf(secret);
  assert.deepEqual(run.created, [
    { number: 30, at: 5 },
    { comment: 3000000001, at: 5 },
  ]);
  assert.deepEqual(broker.runOf(old).created, []);
  // The workflow runs it reran too, which bound its next reruns (github-writes.mjs MAX_RERUNS).
  assert.deepEqual(run.reruns, [{ run_id: 70, sha: "abc", at: 4 }]);
  assert.deepEqual(broker.runOf(old).reruns, []);
  // What github-writes.mjs answered() does for the next one: the live state's own list.
  run.created.push({ number: 31, at: 6 }, { comment: 3000000002, at: 6 });
  run.changed();
  const task = [...ctx.tasks.values()].find((t) => t.live.id === secret);
  await task.live.saving;
  const again = await savedRun(ctx.store, "r1");
  assert.deepEqual(again.created, [
    { number: 30, at: 5 },
    { comment: 3000000001, at: 5 },
    { number: 31, at: 6 },
    { comment: 3000000002, at: 6 },
  ]);
  run.reruns.push({ run_id: 71, sha: "abc", at: 7 });
  run.changed();
  await task.live.saving;
  const third = await savedRun(ctx.store, "r1");
  assert.deepEqual(third.reruns, [
    { run_id: 70, sha: "abc", at: 4 },
    { run_id: 71, sha: "abc", at: 7 },
  ]);
});

test("a key under runs/ that holds no run's state is logged and removed, the runs beside it restored", async (t) => {
  const lines = [];
  const ctx = runContext(tempDir(t), { log: (line) => lines.push(line) });
  await saveRun(ctx.store, "r1", 1, { agent: "claude" });
  // No record (a write cut short, a hand edit), and not even an object.
  await ctx.store.set(`${LIVE_PREFIX}r2`, {
    id: "r2",
    task: { repo: "org/repo", id: 2, kind: "issue" },
  });
  await ctx.store.set(`${LIVE_PREFIX}r3`, "garbage");
  await createRestart(ctx).restoreRuns();
  assert.deepEqual(
    [...ctx.tasks.values()].map((task) => task.live.id),
    ["r1"],
  );
  assert.equal(await savedRun(ctx.store, "r2"), null);
  assert.equal(await savedRun(ctx.store, "r3"), null);
  assert.ok(await savedRun(ctx.store, "r1"));
  for (const id of ["r2", "r3"])
    assert.ok(lines.includes(`${LIVE_PREFIX}${id}: not a run's state, removed`));
});

test("a key under runs/ the store refuses to remove is logged, the start going on", async (t) => {
  const lines = [];
  const store = fileStore();
  store.delete = async () => {
    throw new Error("store away");
  };
  const ctx = runContext(tempDir(t), { log: (line) => lines.push(line), store });
  await saveRun(store, "r1", 1, { agent: "claude" });
  await store.set(`${LIVE_PREFIX}r2`, { id: "r2" });
  await createRestart(ctx).restoreRuns();
  assert.deepEqual(
    [...ctx.tasks.values()].map((task) => task.live.id),
    ["r1"],
  );
  assert.ok(lines.includes(`${LIVE_PREFIX}r2: not a run's state, its removal failed: store away`));
  // Still there: the next takeover tries again.
  assert.ok(await store.get(`${LIVE_PREFIX}r2`));
});

test("liveRunIds(): the ids of the runs' states in the store, not those of keys that hold none", async () => {
  const store = fileStore();
  await saveRun(store, "r1", 1, { agent: "claude" });
  await store.set(`${LIVE_PREFIX}r2`, {
    id: "r2",
    task: { repo: "org/repo", id: 2, kind: "issue" },
  });
  await store.set(`${LIVE_PREFIX}r3`, "garbage");
  assert.deepEqual([...(await liveRunIds(store))], ["r1"]);
});

test("a restored run keeps the network its tokens are bound to, and saves it again", async (t) => {
  const dir = tempDir(t);
  const broker = createBroker({});
  const ctx = runContext(dir, { broker });
  const secret = await saveRun(ctx.store, "r1", 1, { agent: "claude" });
  const saved = await savedRun(ctx.store, "r1");
  await ctx.store.set(`${LIVE_PREFIX}r1`, { ...saved, sandbox: "net-1" });
  // Saved before runs kept it: looked up when asked (broker-http.mjs sandboxOfTask()).
  const old = await saveRun(ctx.store, "r2", 2, { agent: "claude" });
  await createRestart(ctx).restoreRuns();
  const of = (s) => [...ctx.tasks.values()].find((task) => task.live.id === s).live;
  assert.equal(of(secret).sandbox, "net-1");
  assert.equal(broker.runOf("r1").sandbox, "net-1");
  assert.equal(of(old).sandbox, undefined);
  assert.equal(broker.runOf("r2").sandbox, null);
  broker.runOf(secret).changed();
  await of(secret).saving;
  assert.equal((await savedRun(ctx.store, "r1")).sandbox, "net-1");
});

// A data dir whose runs, run going and queue have one repo under two spellings: `live` the
// running one's, `newest` the last finished run's.
function twoSpellings(t, { live, newest }) {
  const dir = tempDir(t);
  // The runs' list, as loadRuns() makes it from their summaries: newest first.
  const runs = [];
  const summary = (id, repo, n, startedAt) => {
    writeFileSync(join(dir, `${id}.log`), "");
    runs.push({ id, key: `${repo}#${n}`, repo, status: "ok", startedAt, finishedAt: startedAt });
  };
  summary("a-1", "Storywake/storywake", 1, 1000);
  summary("b-2", newest, 2, 3000);
  summary("c-3", "org/other", 3, 3000);
  writeFileSync(
    join(dir, "d-5.live.json"),
    JSON.stringify({
      task: { repo: live, id: "5", kind: "issue" },
      id: "d-5",
      mode: "work",
      light: false,
      secret: "s",
      record: { id: "d-5", key: `${live}#5`, repo: live, startedAt: 2000 },
      handled: [],
      unanswered: [],
    }),
  );
  // The same task queued under both: one task once loaded.
  writeFileSync(
    join(dir, "queue.json"),
    JSON.stringify([
      { repo: "storywake/storywake", id: "4", kind: "issue", pending: [], next: { model: "x" } },
      {
        repo: "STORYWAKE/storywake",
        id: "4",
        kind: "issue",
        pending: [],
        next: { effort: "high" },
      },
    ]),
  );
  return {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: runs.sort((a, b) => b.startedAt - a.startedAt),
    runsById: new Map(),
    runner: { closed: async () => false },
    runLogs: fileLogs(dir),
    broker: createBroker({}),
    running: 0,
    store: fileStore(),
  };
}

async function restarted(ctx, options) {
  const restart = createRestart(ctx);
  const spelled = options && (await restart.unifySpellings(options));
  await restart.restoreRuns();
  await restart.loadQueue();
  return spelled;
}

test("two spellings of a repo load as one: GitHub's, asked for that repo alone", async (t) => {
  const ctx = twoSpellings(t, { live: "storywake/storywake", newest: "storywake/storywake" });
  const asked = [];
  const nameOf = async (repo) => {
    asked.push(repo);
    return "Storywake/storywake";
  };
  const spelled = await restarted(ctx, { nameOf, keys: ["storywake/STORYWAKE#9"] });
  assert.equal(asked.length, 1);
  assert.equal(spelled("STORYWAKE/STORYWAKE"), "Storywake/storywake");
  const repos = new Set(ctx.runs.map((r) => r.repo));
  assert.deepEqual([...repos].sort(), ["Storywake/storywake", "org/other"]);
  assert.equal(ctx.runs.find((r) => r.id === "b-2").key, "Storywake/storywake#2");
  assert.deepEqual([...ctx.tasks.keys()].sort(), [
    "Storywake/storywake#4",
    "Storywake/storywake#5",
  ]);
  assert.deepEqual(ctx.tasks.get("Storywake/storywake#4").next, { effort: "high", model: "x" });
  assert.equal(ctx.tasks.get("Storywake/storywake#5").live.record.repo, "Storywake/storywake");
  // The dashboard's tasks: one repo.
  const tasks = board({ runs: ctx.runs, queued: [], brainstorms: [] });
  assert.deepEqual(tasks.map((t) => t.key).sort(), [
    "Storywake/storywake#1",
    "Storywake/storywake#2",
    "Storywake/storywake#5",
    "org/other#3",
  ]);
});

test("two spellings without GitHub's: the run going keeps the webhooks' key, newer runs or not", async (t) => {
  for (const nameOf of [
    null,
    async () => {
      throw new Error("GitHub down");
    },
    // Renamed to another repo: not a spelling of this one.
    async () => "Elsewhere/storywake",
    // No answer in time.
    () => new Promise(() => {}),
  ]) {
    const ctx = twoSpellings(t, { live: "Storywake/storywake", newest: "storywake/storywake" });
    await restarted(ctx, nameOf && { nameOf, waitMs: 20 });
    assert.equal(ctx.runs.find((r) => r.id === "b-2").key, "Storywake/storywake#2");
    assert.ok(ctx.tasks.get("Storywake/storywake#5").running);
  }
});

test("spellings: GitHub's, else a run going's, else the most recent; whatever the case asked", () => {
  const records = [
    { repo: "org/App", startedAt: 1, live: true },
    { repo: "Org/app", startedAt: 3 },
    { repo: "org/app", startedAt: 2 },
    { repo: "org/other" },
    { repo: null, startedAt: 4 },
  ];
  assert.deepEqual(ambiguous(records), ["org/App"]);
  assert.equal(spellings(records)("ORG/APP"), "org/App");
  assert.equal(spellings(records.slice(1))("ORG/APP"), "Org/app");
  const spelled = spellings(records, new Map([["org/app", "ORG/App"]]));
  assert.equal(spelled("org/app"), "ORG/App");
  assert.equal(spelled("org/other"), "org/other");
  assert.equal(spelled("new/one"), "new/one");
  assert.equal(respelled("org/APP#pr-3", spelled), "ORG/App#pr-3");
  assert.equal(respelled("not a key", spelled), "not a key");
  // State keyed by task: the entry already under the new key stays.
  const map = new Map([
    ["org/app#1", { repo: "org/app" }],
    ["ORG/App#1", { repo: "ORG/App", kept: true }],
    ["org/app#2", { repo: "org/app" }],
  ]);
  const fix = (v) => ({ ...v, repo: spelled(v.repo) });
  assert.equal(respellMap(map, spelled, fix), true);
  assert.deepEqual(Object.fromEntries(map), {
    "ORG/App#1": { repo: "ORG/App", kept: true },
    "ORG/App#2": { repo: "ORG/App" },
  });
  assert.equal(respellMap(map, spelled, fix), false);
});

test("pulls.json under an old spelling loads under GitHub's: one entry, one task on the board", async (t) => {
  const ctx = twoSpellings(t, { live: "Storywake/storywake", newest: "storywake/storywake" });
  const path = join(ctx.config.dataDir, "pulls.json");
  writeFileSync(
    path,
    JSON.stringify({
      // Started from a typed address before #287, then a webhook under GitHub's spelling.
      "storywake/storywake#5": { number: 6, state: "ready", readyAt: 100 },
      "Storywake/storywake#5": { number: 6, state: "ready", readyAt: null },
      "storywake/storywake#2": { number: 7, state: "draft", readyAt: null },
    }),
  );
  const maps = mapStore();
  const pulls = createPulls({
    pulls: await maps.map("pulls", { file: path }),
    listPulls: async () => [],
  });
  const nameOf = async () => "Storywake/storywake";
  const spelled = await restarted(ctx, { nameOf, keys: pulls.keys() });
  pulls.respell(spelled);
  assert.deepEqual(Object.fromEntries(await maps.again("pulls")), {
    "Storywake/storywake#5": { number: 6, state: "ready", readyAt: 100 },
    "Storywake/storywake#2": { number: 7, state: "draft", readyAt: null },
  });
  assert.deepEqual(
    pulls.open().map(([key]) => key),
    ["Storywake/storywake#5", "Storywake/storywake#2"],
  );
  const keys = board({ runs: ctx.runs, queued: [], brainstorms: [] }).map((t) => t.key);
  assert.deepEqual(keys.sort(), [
    "Storywake/storywake#1",
    "Storywake/storywake#2",
    "Storywake/storywake#5",
    "org/other#3",
  ]);
});

test("a restored run keeps the phase its log is in, and saves it again", async (t) => {
  const dir = tempDir(t);
  const ctx = runContext(dir);
  await saveRun(ctx.store, "r1", 1, { agent: "claude" }, { logPhase: "push" });
  const restart = createRestart(ctx);
  const [task] = await restart.restoreRuns();
  assert.equal(task.live.logPhase, "push");
  task.live.logPhase = "work";
  await restart.saveLive(task);
  assert.equal((await savedRun(ctx.store, "r1")).logPhase, "work");
});

test("a restored run's record takes its log's phase: scheduled through a restart", async (t) => {
  const dir = tempDir(t);
  const ctx = runContext(dir);
  const live = (id, issue, record, logPhase) => saveRun(ctx.store, id, issue, record, { logPhase });
  await live("r1", 1, { agent: "claude", phase: "setup" }, "setup");
  // Saved before enterPhase() wrote its first line.
  await live("r2", 2, { agent: "claude", phase: "setup" }, null);
  // Saved by a listener whose records only knew "building image".
  await live("r3", 3, { agent: "claude", phase: null }, "setup");
  await live("r4", 4, { agent: "claude", phase: "building image" }, "image");
  await live("r5", 5, { agent: "claude", phase: null }, "work");
  await createRestart(ctx).restoreRuns();
  const states = board({ runs: ctx.runs, queued: [], brainstorms: [] });
  assert.deepEqual(Object.fromEntries(states.map((t) => [t.number, t.state])), {
    1: "scheduled",
    2: "scheduled",
    3: "scheduled",
    4: "building-image",
    5: "working",
  });
});

test("queued comments keep when they were queued through a restart: the run order of the unplaced", async (t) => {
  const dir = tempDir(t);
  const store = fileStore({ dir: join(dir, "store") });
  const context = () => {
    const ctx = {
      config: { dataDir: dir, users: ["alice"], repos: ["org/repo"] },
      log: () => {},
      tasks: new Map(),
      logDir: dir,
      runs: [],
      runsById: new Map(),
      running: 0,
      track: () => {},
      settle: async () => {},
      store,
    };
    // Nothing starts: the test reads the queue as loaded.
    return Object.assign(ctx, createTasks(ctx), createRestart(ctx), { startLater: () => {} });
  };
  const before = context();
  // #7's key comes first, its comment was queued last.
  for (const [id, queuedAt] of [
    ["7", 300],
    ["8", 100],
  ]) {
    const task = newTask({ repo: "org/repo", id, kind: "issue", number: Number(id), base: "main" });
    task.pending.push({ repo: "org/repo", id, mode: "work", author: "alice", queuedAt });
    before.tasks.set(`org/repo#${id}`, task);
  }
  await before.saveQueue();
  const after = context();
  await after.loadQueue();
  assert.deepEqual(
    after.tasks.get("org/repo#7").pending.map((i) => i.queuedAt),
    [300],
  );
  assert.deepEqual(
    after.queueOrder().map((task) => task.id),
    ["8", "7"],
  );
});

// Two listeners, one after the other, on one broker service and one store (`store`), as across
// a handover or a crash: `make()` → { broker, ctx, restart }.
function takeover(t) {
  const dir = tempDir(t);
  // The broker service outlives the listener's restart: both listeners ask the same one.
  const service = localBroker();
  const networks = { "10.9.0.5": "net-new", "10.9.1.5": "net-old" };
  const store = fileStore();
  const make = () => {
    const broker = createBroker({ ...service, sandboxOf: async (ip) => networks[ip] ?? null });
    const ctx = runContext(dir, { broker, store });
    return { broker, ctx, restart: createRestart(ctx) };
  };
  return { dir, service, store, make };
}

// Every value in `store`, as JSON: what a test checks no token is in.
async function storeText(store) {
  const all = [];
  for await (const entry of values(store, "")) all.push(entry);
  return JSON.stringify(all);
}

test("across a takeover, a run's tokens still check, and its output is redacted of them, renewed ones too, with none in the store (#617)", async (t) => {
  const { dir, service, store, make } = takeover(t);
  // The first listener: a run with tokens, its state saved as it goes.
  const first = make();
  first.broker.register("org/repo", { id: "new", push: true, mode: "work" });
  first.broker.allow("new", ["issue-1-*"]);
  first.broker.grant("new", ["pull", "push", "setup"]);
  const { token, agentToken } = await first.broker.issue("new", "net-new");
  const task = newTask({ repo: "org/repo", id: 1, kind: "issue" });
  task.live = {
    id: "new",
    key: "org/repo#1",
    mode: "work",
    light: false,
    sandbox: "net-new",
    branches: ["issue-1-*"],
    capabilities: ["pull", "push", "setup"],
    record: { id: "new", key: "org/repo#1", agent: "claude" },
    handled: [],
    unanswered: [],
    // A line it printed, the run's own token in it (redacted where it is shown, runs.mjs).
    result: { ok: true, text: `I hold ${token}` },
  };
  assert.equal(await first.restart.saveLive(task), true);
  // Nothing in the data folder: the store has it all, and none of its tokens.
  assert.deepEqual(readdirSync(dir), []);
  const text = await storeText(store);
  assert.ok(text.includes('"key":"org/repo#1"'));
  for (const secret of [token, agentToken]) assert.ok(!text.includes(secret));

  // The next copy (a handover, or one started after a crash).
  const { broker, restart } = make();
  const [restored] = await restart.restoreRuns();
  assert.equal(restored.live.id, "new");
  await until(() => broker.secretsOf("new").length === 2, { what: "the run's tokens" });
  // Its tokens from the broker service: those signed before the takeover are redacted.
  assert.deepEqual(broker.secretsOf("new"), [agentToken, token]);
  assert.equal((await broker.check(token, "10.9.0.5")).run.id, "new");
  assert.equal((await broker.check(agentToken, "10.9.0.5", "deckhand:agents")).run.id, "new");
  // One renewed after it: asked again on the broker's `renewed` event (server.mjs).
  const renewed = (await service.runs.renew(token, "net-new")).token;
  await broker.recall("new");
  assert.ok(broker.secretsOf("new").includes(renewed));
  assert.equal((await broker.check(renewed, "10.9.1.5")).status, 403);
  // Its renewed tokens carry the capabilities its start decided.
  const claims = JSON.parse(Buffer.from(renewed.split(".")[1], "base64url"));
  assert.deepEqual(claims.caps, ["pull", "push", "setup"]);
  // Saved again by this copy: still none of them in the store.
  assert.equal(await restart.saveLive(restored), true);
  const again = await storeText(store);
  for (const secret of [token, agentToken, renewed]) assert.ok(!again.includes(secret));
});

test("a run's state a listener of the release before kept in its files: moved to the store without its tokens, which the broker service keeps (#617)", async (t) => {
  const { dir, service, store, make } = takeover(t);
  // The release before's listener: a run with tokens, saved in logs/<run>.live.json.
  const first = make();
  first.broker.register("org/repo", { id: "new", push: true, mode: "work" });
  first.broker.allow("new", ["issue-1-*"]);
  const { token, agentToken } = await first.broker.issue("new", "net-new");
  writeFileSync(
    join(dir, "new.live.json"),
    JSON.stringify({
      task: { repo: "org/repo", id: 1, kind: "issue" },
      id: "new",
      mode: "work",
      light: false,
      agentToken,
      sandbox: "net-new",
      runTokens: [token],
      branches: ["issue-1-*"],
      capabilities: ["pull", "push", "setup"],
      record: { id: "new", key: "org/repo#1", agent: "claude" },
      handled: [],
      unanswered: [],
    }),
  );
  // A file that isn't a run's state: left there.
  writeFileSync(join(dir, "other.live.json"), "{}");
  // The broker service lost the run meanwhile (its store, say).
  await service.runs.end("new");

  const { broker, restart } = make();
  await restart.restoreRuns();
  // The token the sandbox holds is redacted at once, before it is renewed.
  assert.deepEqual(broker.secretsOf("new"), [agentToken, token]);
  // Moved: in the store without its tokens, the file gone once the broker service has them.
  await until(() => !readdirSync(dir).includes("new.live.json"), { what: "the file's removal" });
  assert.deepEqual(readdirSync(dir).sort(), ["other.live.json"]);
  const saved = await savedRun(store, "new");
  assert.equal(saved.sandbox, "net-new");
  const text = await storeText(store);
  for (const secret of [token, agentToken]) assert.ok(!text.includes(secret));
  // The broker service hears the run goes on, with its claims and the tokens the file had: its
  // token renews there, from its own sandbox, and the next copy gets them from it.
  await until(async () => (await service.runs.secrets("new"))?.agentToken, {
    what: "the broker service's record",
  });
  assert.deepEqual(await service.runs.secrets("new"), { agentToken, tokens: [token] });
  assert.deepEqual((await service.runs.get("new")).branches, ["issue-1-*"]);
  const renewed = await service.runs.renew(token, "net-new");
  assert.ok(renewed.token);
  assert.equal((await service.runs.renew(token, "net-old")).status, 403);
  assert.equal((await broker.check(renewed.token, "10.9.0.5")).run.id, "new");
  const claims = JSON.parse(Buffer.from(renewed.token.split(".")[1], "base64url"));
  assert.deepEqual(claims.caps, ["pull", "push", "setup"]);
  assert.deepEqual(broker.runOf("new").branches, ["issue-1-*"]);
  const next = make();
  await next.restart.restoreRuns();
  await until(() => next.broker.secretsOf("new").length === 3, { what: "the run's tokens" });
  assert.deepEqual(next.broker.secretsOf("new"), [agentToken, token, renewed.token]);
});

test("a run's state the store refuses to take from its file: the start fails, the file kept (#617)", async (t) => {
  const dir = tempDir(t);
  const ctx = runContext(dir);
  const set = ctx.store.set;
  ctx.store.set = (key, ...rest) =>
    key.startsWith(LIVE_PREFIX)
      ? Promise.reject(new Error("the store is down"))
      : set(key, ...rest);
  writeFileSync(
    join(dir, "r1.live.json"),
    JSON.stringify({
      task: { repo: "org/repo", id: "1", kind: "issue" },
      id: "r1",
      record: { id: "r1", key: "org/repo#1" },
      handled: [],
      unanswered: [],
    }),
  );
  await assert.rejects(createRestart(ctx).restoreRuns(), /the store is down/);
  assert.ok(JSON.parse(readFileSync(join(dir, "r1.live.json"), "utf8")).record);
});

test("a copy that stops before the broker service has a moved file's tokens: the next reads them from the file, the store's state kept (#617)", async (t) => {
  const { dir, service, store, make } = takeover(t);
  const first = make();
  first.broker.register("org/repo", { id: "new", push: true, mode: "work" });
  const { token, agentToken } = await first.broker.issue("new", "net-new");
  const saved = {
    task: { repo: "org/repo", id: 1, kind: "issue" },
    id: "new",
    mode: "work",
    light: false,
    agentToken,
    sandbox: "net-new",
    runTokens: [token],
    record: { id: "new", key: "org/repo#1", agent: "claude" },
    handled: [],
    unanswered: [],
  };
  writeFileSync(join(dir, "new.live.json"), JSON.stringify(saved));
  await service.runs.end("new");
  // The first copy of this release: the broker service never answers it.
  const stuck = make();
  stuck.broker.restore = () => new Promise(() => {});
  await stuck.restart.restoreRuns();
  assert.ok(await savedRun(store, "new"));
  assert.ok(readdirSync(dir).includes("new.live.json"));
  // It saved the run's state again (its output read on) before it died.
  await store.set(`${LIVE_PREFIX}new`, { ...(await savedRun(store, "new")), lines: { out: 7 } });
  const next = make();
  await next.restart.restoreRuns();
  assert.deepEqual(next.broker.secretsOf("new").slice(0, 2), [agentToken, token]);
  assert.deepEqual((await savedRun(store, "new")).lines, { out: 7 });
  await until(() => !readdirSync(dir).includes("new.live.json"), { what: "the file's removal" });
  assert.deepEqual(await service.runs.secrets("new"), { agentToken, tokens: [token] });
});

test("a broker service that doesn't say a restored run's tokens: its output is followed after the wait all the same, their shape redacted (#617)", async (t) => {
  const dir = tempDir(t);
  const broker = createBroker({
    issuer: {
      issue: async () => {
        throw new Error("no");
      },
      put: async () => {},
      secrets: () => new Promise(() => {}),
      end: async () => {},
    },
  });
  const followed = [];
  const ctx = runContext(dir, {
    broker,
    runner: {
      closed: async () => false,
      relink: async () => {},
      list: async () => [{ name: "deckhand-org-repo-1", run: "r1", running: true }],
      remove: async () => {},
    },
    follow: (task) => followed.push(task.live.id),
  });
  await saveRun(ctx.store, "r1", 1, { agent: "claude" });
  const restart = createRestart(ctx);
  const restored = await restart.restoreRuns();
  // Its tokens never known: followed once the (short) wait is over, with none to redact by
  // value (their shape is, lib/redact.mjs).
  await restart.reattach(restored, { waitMs: 30 });
  assert.deepEqual(followed, ["r1"]);
  assert.deepEqual(broker.secretsOf("r1"), []);
});

test("a moved file's tokens a broker of the release before drops: the file stays until one has them (#617)", async (t) => {
  const { dir, service, store, make } = takeover(t);
  const first = make();
  first.broker.register("org/repo", { id: "new", push: true, mode: "work" });
  const { token, agentToken } = await first.broker.issue("new", "net-new");
  writeFileSync(
    join(dir, "new.live.json"),
    JSON.stringify({
      task: { repo: "org/repo", id: 1, kind: "issue" },
      id: "new",
      mode: "work",
      light: false,
      agentToken,
      sandbox: "net-new",
      runTokens: [token],
      record: { id: "new", key: "org/repo#1", agent: "claude" },
      handled: [],
      unanswered: [],
    }),
  );
  await service.runs.end("new");
  // The release before's broker: its PUT takes no tokens, it has no /secrets (403).
  const old = {
    ...service.issuer,
    put: (id, { tokens: _, ...fields }) => service.issuer.put(id, fields),
    secrets: async () => {
      throw Object.assign(new Error("refused: 403"), { status: 403 });
    },
  };
  const next = make();
  const broker = createBroker({ ...service, issuer: old, sandboxOf: async () => "net-new" });
  next.ctx.broker = broker;
  // Each try's outcome (broker-service.mjs persist() would try again later).
  const tries = [];
  next.ctx.brokerService = {
    persist: (what, fn) => {
      const tried = fn().then(
        () => "ok",
        (error) => error.message,
      );
      tries.push(tried);
      return tried;
    },
  };
  await createRestart(next.ctx).restoreRuns();
  assert.deepEqual(await Promise.all(tries), ["refused: 403"]);
  // The PUT answered, the tokens not taken: the file stays, the redaction has them from it.
  assert.ok(readdirSync(dir).includes("new.live.json"));
  assert.deepEqual(broker.secretsOf("new"), [agentToken, token]);
  assert.equal((await service.runs.secrets("new")).agentToken, null);
});

test("a runner slow to say whether a restored run's inbox is open: the start goes on, the run takes comments once it says", async (t) => {
  const dir = tempDir(t);
  let answer;
  const asked = new Promise((resolve) => (answer = resolve));
  const delivered = [];
  const ctx = runContext(dir, {
    runner: { closed: () => asked },
    deliverLater: (task) => delivered.push(task.live.id),
  });
  await saveRun(ctx.store, "r1", 1, { agent: "claude" });
  const started = Date.now();
  const [task] = await createRestart(ctx).restoreRuns({ waitMs: 30 });
  assert.ok(Date.now() - started < 1000);
  // Not known yet: no comment goes to it meanwhile.
  assert.equal(task.live.open, false);
  answer(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(task.live.open, true);
  assert.deepEqual(delivered, ["r1"]);
});

// A listener's context for the queue's tests: its tasks (tasks.mjs) and restart.mjs on `store`,
// with a pause of a minute (`debounceMs`). `startLater` records what is re-armed rather than
// arming it, unless `real`.
function queueContext(t, dir, store, { real = false, log = () => {} } = {}) {
  const ctx = {
    config: { dataDir: dir, users: ["alice"], repos: ["org/repo"], debounceMs: 60_000 },
    log,
    tasks: new Map(),
    logDir: dir,
    runs: [],
    runsById: new Map(),
    running: 0,
    track: () => {},
    settle: async () => {},
    received: () => {},
    runLogs: fileLogs(dir),
    store,
  };
  Object.assign(ctx, createTasks(ctx), createRestart(ctx));
  t.after(() => {
    for (const task of ctx.tasks.values()) clearTimeout(task.timer);
  });
  if (real) return ctx;
  ctx.armed = [];
  ctx.startLater = (task, dueAt) => ctx.armed.push([task.id, dueAt]);
  return ctx;
}

const queued = (id, extra = {}) => ({
  repo: "org/repo",
  id,
  kind: "issue",
  number: Number(id),
  base: "main",
  mode: "work",
  author: "alice",
  ...extra,
});

test("a queued comment is in the store with its pause's deadline as soon as it waits, no stop needed", async (t) => {
  const dir = tempDir(t);
  const store = fileStore({ dir: join(dir, "store") });
  const before = queueContext(t, dir, store, { real: true });
  const task = newTask({ repo: "org/repo", id: "7", kind: "issue", number: 7, base: "main" });
  before.tasks.set("org/repo#7", task);
  const item = queued("7", { queueId: "q-1", eyes: Promise.resolve(41) });
  task.pending.push(item);
  const at = Date.now();
  before.startLater(task);
  await before.saveQueue();
  // Its 👀 was a promise when first written: written again once known.
  await new Promise((resolve) => setImmediate(resolve));
  await before.saveQueue();
  const saved = (await fileStore({ dir: join(dir, "store") }).get(QUEUE_KEY))["org/repo#7"];
  assert.equal(saved.pending[0].queueId, "q-1");
  assert.equal(saved.pending[0].eyes, 41);
  assert.ok(saved.dueAt >= at + 60_000 && saved.dueAt <= Date.now() + 60_000);

  // The next listener (the same store, read again from its files): the same deadline re-armed.
  const after = queueContext(t, dir, fileStore({ dir: join(dir, "store") }));
  await after.loadQueue();
  assert.deepEqual(after.armed, [["7", saved.dueAt]]);
  assert.equal(await after.tasks.get("org/repo#7").pending[0].eyes, 41);
});

test("a deadline that passed while no listener ran: re-armed for now", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  await store.set(QUEUE_KEY, {
    "org/repo#7": {
      ...queued("7"),
      pending: [queued("7", { queueId: "q-1" })],
      next: {},
      dueAt: Date.now() - 5000,
    },
  });
  const ctx = queueContext(t, dir, store, { real: true });
  const scheduled = [];
  ctx.run = (task) => scheduled.push(task.id);
  await ctx.loadQueue();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(scheduled, ["7"]);
});

test("a comment both in the queue and in a run's saved state is the run's alone", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const item = queued("1", { queueId: "q-1", comment: { id: 99 } });
  await saveRun(store, "r1", "1", { agent: "claude" }, { handled: [{ ...item, eyes: null }] });
  // Killed after the run's state was written, before the queue was.
  await store.set(QUEUE_KEY, {
    "org/repo#1": { ...queued("1"), pending: [{ ...item, eyes: null }], next: {}, dueAt: 0 },
  });
  const ctx = queueContext(t, dir, store);
  ctx.broker = createBroker({});
  ctx.runner = { closed: () => false };
  await ctx.restoreRuns();
  await ctx.loadQueue();
  const task = ctx.tasks.get("org/repo#1");
  assert.equal(task.live.handled.length, 1);
  assert.deepEqual(task.pending, []);
  assert.deepEqual(ctx.armed, []);
  // And the store has it so.
  assert.deepEqual(await store.get(QUEUE_KEY), {});
});

test("a queue.json a listener from before the store left: loaded once, then in the store", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  writeFileSync(
    join(dir, "queue.json"),
    JSON.stringify([{ ...queued("7"), pending: [{ ...queued("7"), eyes: 5 }], next: {} }]),
  );
  const ctx = queueContext(t, dir, store);
  await ctx.loadQueue();
  // Saved before deadlines were: its pause starts again.
  assert.deepEqual(ctx.armed, [["7", undefined]]);
  assert.throws(() => readFileSync(join(dir, "queue.json")), { code: "ENOENT" });
  const saved = await store.get(QUEUE_KEY);
  assert.deepEqual(Object.keys(saved), ["org/repo#7"]);
  assert.equal(saved["org/repo#7"].pending[0].eyes, 5);
});

test("a run's output read is saved with it once a second, and nothing once it is over", async (t) => {
  const dir = tempDir(t);
  const ctx = queueContext(t, dir, fileStore());
  ctx.broker = { secretsOf: () => [] };
  const live = {
    id: "r1",
    key: "org/repo#1",
    record: { id: "r1" },
    lines: { out: 0, err: 0 },
    handled: [],
    unanswered: [],
  };
  const task = { ...newTask(queued("1")), live };
  for (let i = 1; i <= 3; i++) {
    live.lines.out = i;
    ctx.saveLiveSoon(task, 20);
  }
  assert.equal(await savedRun(ctx.store, "r1"), null);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await live.saving;
  assert.equal((await savedRun(ctx.store, "r1")).lines.out, 3);
  // Its end (runs.mjs teardown()): a save still due writes nothing.
  live.lines.out = 4;
  ctx.saveLiveSoon(task, 20);
  live.over = true;
  await new Promise((resolve) => setTimeout(resolve, 60));
  ctx.saveLive(task);
  await live.saving;
  assert.equal((await savedRun(ctx.store, "r1")).lines.out, 3);
});

// What `store` holds of each run's state as it is written (`live`: id → its comments' queueIds),
// its writes and deletes recorded by `record(key, value)` before they are made.
function watchLive(store, record = () => {}) {
  const live = new Map();
  const id = (key) => key.startsWith(LIVE_PREFIX) && key.slice(LIVE_PREFIX.length);
  const { set, delete: remove } = store;
  store.set = async (key, value, options) => {
    record(key, value);
    const done = await set(key, value, options);
    if (id(key))
      live.set(
        id(key),
        value.handled.map((i) => i.queueId),
      );
    return done;
  };
  store.delete = async (key) => {
    const done = await remove(key);
    if (id(key)) live.delete(id(key));
    return done;
  };
  return live;
}

// The store's writes of the queue as they happen, each with whether the run's state was in the
// store then and which comments it held.
function recordingWrites(store, run) {
  const writes = [];
  const live = watchLive(store, (key, value) => {
    if (key !== QUEUE_KEY) return;
    const ids = Object.values(value).flatMap((t) => t.pending.map((i) => i.queueId));
    writes.push({ ids, live: live.get(run) ?? null });
  });
  return writes;
}

test("a comment a running session takes stays in every write of the queue until the run's state has it", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const ctx = queueContext(t, dir, store, { real: true });
  ctx.broker = { secretsOf: () => [] };
  ctx.runner = { send: () => {} };
  const writes = recordingWrites(store, "r1");
  const task = newTask({ ...queued("1"), name: "deckhand-org-repo-1" });
  task.running = true;
  task.live = {
    id: "r1",
    key: "org/repo#1",
    mode: "work",
    open: true,
    record: { id: "r1", agent: "claude" },
    logFile: openLog(join(dir, "r1.log")),
    lines: { out: 0, err: 0 },
    later: {},
    handled: [],
    unanswered: [],
  };
  ctx.tasks.set("org/repo#1", task);
  // Its 👀 still on its way: the run's state waits for it.
  let eyes;
  const item = queued("1", { queueId: "q-1", text: "And the dates." });
  item.eyes = new Promise((resolve) => (eyes = resolve));
  task.pending.push(item);
  assert.equal(ctx.deliver(task), true);
  // Another task's comment meanwhile: its write still has the one being taken.
  const other = newTask(queued("2"));
  ctx.tasks.set("org/repo#2", other);
  other.pending.push(queued("2", { queueId: "q-2" }));
  await ctx.saveQueue();
  assert.deepEqual(writes.at(-1), { ids: ["q-1", "q-2"], live: null });
  eyes(7);
  await task.live.saving;
  await ctx.saveQueue();
  // Never in neither: each write without it came once the run's state had it.
  for (const write of writes) assert.ok(write.ids.includes("q-1") || write.live?.includes("q-1"));
  assert.deepEqual(writes.at(-1), { ids: ["q-2"], live: ["q-1"] });
});

test("a restored run whose sandbox never started: its comments in the queue before its state goes", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const writes = recordingWrites(store, "r1");
  await saveRun(
    store,
    "r1",
    "1",
    { agent: "claude" },
    {
      task: { repo: "org/repo", id: "1", kind: "issue", name: "deckhand-org-repo-1" },
      handled: [{ ...queued("1", { queueId: "q-1" }), eyes: 3 }],
    },
  );
  const ctx = queueContext(t, dir, store);
  ctx.broker = createBroker({});
  ctx.runner = {
    closed: () => false,
    relink: async () => {},
    list: async () => [],
    remove: async () => {},
  };
  ctx.shotsDir = dir;
  Object.assign(ctx, { teardown: createRuns(ctx).teardown });
  await ctx.reattach(await ctx.restoreRuns());
  assert.equal(await savedRun(store, "r1"), null);
  // The last write while its state was there already had the comment back: never in neither.
  const last = writes.findLast((w) => w.live);
  assert.deepEqual(last, { ids: ["q-1"], live: ["q-1"] });
  assert.deepEqual(ctx.armed, [["1", undefined]]);
  // Its 👀 known from the start, not saved as none first.
  assert.ok(writes.every((w) => w.ids.length === 0 || w.ids[0] === "q-1"));
  assert.equal((await store.get(QUEUE_KEY))["org/repo#1"].pending[0].eyes, 3);
});

test("a restored comment's 👀 is in the queue's first write after a restart", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  await store.set(QUEUE_KEY, {
    "org/repo#7": { ...queued("7"), pending: [{ ...queued("7"), eyes: 41 }], next: {} },
  });
  const ctx = queueContext(t, dir, store);
  const writes = [];
  const set = store.set;
  store.set = (key, value, options) => {
    writes.push(value["org/repo#7"]?.pending[0].eyes);
    return set(key, value, options);
  };
  await ctx.loadQueue();
  assert.deepEqual(writes, [41]);
});

test("a comment taken, then put back while its run's state isn't written yet: in the queue once", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const ctx = queueContext(t, dir, store, { real: true });
  ctx.broker = { secretsOf: () => [] };
  const task = newTask({ ...queued("1"), name: "deckhand-org-repo-1" });
  task.live = {
    id: "r1",
    key: "org/repo#1",
    record: { id: "r1" },
    lines: { out: 0, err: 0 },
    handled: [],
    unanswered: [],
  };
  ctx.tasks.set("org/repo#1", task);
  let eyes;
  const item = queued("1", { queueId: "q-1" });
  item.eyes = new Promise((resolve) => (eyes = resolve));
  task.live.handled.push(item);
  ctx.take(task, [item]);
  // The agent exited without answering it (runs.mjs finish()).
  task.pending.unshift(item);
  await ctx.saveQueue();
  assert.deepEqual(
    (await store.get(QUEUE_KEY))["org/repo#1"].pending.map((i) => i.queueId),
    ["q-1"],
  );
  eyes(null);
});

test("a run's state that couldn't be written: its comments stay in the queue until one is", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const ctx = queueContext(t, dir, store, { real: true });
  ctx.broker = { secretsOf: () => [] };
  // The store refuses the run's state: the write fails.
  const set = store.set;
  let refused = true;
  store.set = (key, ...rest) =>
    refused && key.startsWith(LIVE_PREFIX)
      ? Promise.reject(new Error("refused"))
      : set(key, ...rest);
  const task = newTask({ ...queued("1"), name: "deckhand-org-repo-1" });
  task.live = {
    id: "r1",
    key: "org/repo#1",
    record: { id: "r1" },
    lines: { out: 0, err: 0 },
    handled: [],
    unanswered: [],
  };
  ctx.tasks.set("org/repo#1", task);
  const item = queued("1", { queueId: "q-1", eyes: Promise.resolve(3) });
  task.live.handled.push(item);
  await ctx.take(task, [item]);
  const ids = async () =>
    ((await store.get(QUEUE_KEY))["org/repo#1"]?.pending ?? []).map((i) => i.queueId);
  assert.deepEqual(await ids(), ["q-1"]);
  // Written at last: out of the queue.
  refused = false;
  ctx.saveLive(task);
  await task.live.saving;
  await ctx.saveQueue();
  assert.deepEqual(await ids(), []);
});

test("a queue.json whose comments the store didn't take stays for the next start", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  store.set = async () => {
    throw new Error("the store is down");
  };
  const path = join(dir, "queue.json");
  writeFileSync(path, JSON.stringify([{ ...queued("7"), pending: [queued("7")], next: {} }]));
  const ctx = queueContext(t, dir, store);
  await ctx.loadQueue();
  assert.ok(readFileSync(path, "utf8").includes('"id":"7"'));
});

test("a run's start: its comments in every write of the queue until its state has them, its next options out once taken", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const ctx = queueContext(t, dir, store, { real: true });
  const writes = [];
  const saved = watchLive(store, (key, value) => {
    if (key !== QUEUE_KEY) return;
    const entry = value["org/repo#1"];
    // Its run over (its comments answered, by its error here): what it took is done with.
    const over = !task.live || !!task.live.over;
    writes.push({
      ids: entry?.pending.map((i) => i.queueId) ?? [],
      next: entry?.next,
      live: [...saved.values()][0] ?? null,
      over,
    });
  });
  // What a run's start reads, up to its failure once it has taken `next` (its agent unknown).
  Object.assign(ctx, {
    shotsDir: dir,
    titles: { get: () => null },
    broker: {
      register: () => {},
      revoke: () => {},
      runOf: () => null,
      secretsOf: () => [],
    },
    runner: { state: async () => null, remove: async () => {} },
    repoSettings: async () => ({ settings: null, errors: [], warnings: [] }),
    answer: async () => {},
    schedule: () => {},
  });
  Object.assign(ctx, createRuns(ctx), { config: { ...ctx.config, agent: "nobody" } });
  const task = newTask({ ...queued("1"), name: "deckhand-org-repo-1" });
  task.next = { model: "x" };
  ctx.tasks.set("org/repo#1", task);
  let eyes;
  const item = queued("1", { queueId: "q-1", replyTo: 1 });
  item.eyes = new Promise((resolve) => (eyes = resolve));
  task.pending.push(item);
  ctx.tasks.set("org/repo#1", task);
  const ran = ctx.run(task).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Its 👀 on its way: the run's state waits for it, the queue still has the comment.
  assert.ok(writes.length > 0);
  for (const w of writes) assert.ok(w.ids.includes("q-1"));
  // Its next options out of the queue once its start took them, before its state is written.
  assert.ok(writes.some((w) => w.next && !w.next.model));
  eyes(5);
  await ran;
  // Never in neither while it runs.
  const running = writes.filter((w) => !w.over);
  assert.ok(running.length > 0);
  for (const w of running) assert.ok(w.ids.includes("q-1") || w.live?.includes("q-1"));
});

test("a comment holding a token or a private key: the queue is saved without them, whole", async (t) => {
  const dir = tempDir(t);
  // The store as the listener opens it: a value holding a secret is refused.
  const store = openStore("memory:", { secrets: () => ["operator-secret-0123456789"] });
  const ctx = queueContext(t, dir, store, { real: true });
  ctx.storeSecrets = () => ["operator-secret-0123456789"];
  const token = `ghp_${"a".repeat(36)}`;
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
  for (const [id, text] of [
    ["1", `Deckhand, use ${token} and operator-secret-0123456789\n${key}\nthanks`],
    ["2", "Deckhand"],
  ]) {
    const task = newTask(queued(id));
    task.pending.push(queued(id, { queueId: `q-${id}`, text }));
    ctx.tasks.set(`org/repo#${id}`, task);
  }
  assert.equal(await ctx.saveQueue(), true);
  const saved = await store.get(QUEUE_KEY);
  assert.equal(
    saved["org/repo#1"].pending[0].text,
    "Deckhand, use [redacted] and [redacted]\n[redacted]\nthanks",
  );
  assert.equal(saved["org/repo#2"].pending[0].text, "Deckhand");
  // The listener's own copy keeps it, for its run.
  assert.match(ctx.tasks.get("org/repo#1").pending[0].text, /ghp_a{36}/);
});

// A run ending (runs.mjs teardown()) while the store refuses every write (until `down.on` is
// false), `item` put back in its task's queue by its end. Its state as saveLive() wrote it last.
// → once its end waits for the store, with `ended`, its end's promise.
async function endWhileStoreDown(t) {
  const dir = tempDir(t);
  const store = fileStore();
  const lines = [];
  const ctx = queueContext(t, dir, store, { real: true, log: (line) => lines.push(line) });
  Object.assign(ctx, {
    shotsDir: dir,
    broker: { revoke: () => {}, secretsOf: () => [] },
    runner: { remove: async () => {} },
    queueRetryMs: 10,
    stopping: false,
  });
  const { teardown } = createRuns(ctx);
  const item = queued("1", { queueId: "q-1", eyes: Promise.resolve(3) });
  await saveRun(
    store,
    "r1",
    "1",
    { agent: "claude" },
    {
      task: { repo: "org/repo", id: "1", kind: "issue", name: "deckhand-org-repo-1" },
      handled: [{ ...item, eyes: 3 }],
    },
  );
  const { set, delete: remove } = store;
  // `refused`: how many writes it refused.
  const down = { on: true, refused: 0 };
  store.set = (...args) =>
    down.on ? (down.refused++, Promise.reject(new Error("disk full"))) : set(...args);
  store.delete = (...args) => (down.on ? Promise.reject(new Error("disk full")) : remove(...args));
  const task = newTask({ ...queued("1"), name: "deckhand-org-repo-1" });
  task.live = {
    id: "r1",
    key: "org/repo#1",
    record: { id: "r1" },
    lines: { out: 0, err: 0 },
    handled: [item],
    unanswered: [],
  };
  task.running = true;
  ctx.running = 1;
  ctx.tasks.set("org/repo#1", task);
  task.pending.push(item);
  const ended = teardown(task);
  await until(() => lines.some((line) => /its state stays until the queue is saved/.test(line)), {
    what: "the end to wait for the store",
  });
  return { dir, store, ctx, down, task, ended };
}

test("a run's end the queue couldn't be written for: tried again until it lands, then its state goes, its task held meanwhile", async (t) => {
  const { store, ctx, down, task, ended } = await endWhileStoreDown(t);
  // The queue's write tried again (queueRetryMs), and again: meanwhile its state stays, and its
  // task is still taken: no other run starts for it.
  const before = down.refused;
  await until(() => down.refused >= before + 2, { what: "two more tries of the queue" });
  assert.ok(await savedRun(store, "r1"));
  assert.equal(task.running, true);
  assert.equal(ctx.running, 1);
  down.on = false;
  await ended;
  assert.equal(await savedRun(store, "r1"), null);
  assert.equal(task.running, false);
  assert.deepEqual(
    (await store.get(QUEUE_KEY))["org/repo#1"].pending.map((i) => i.queueId),
    ["q-1"],
  );
});

test("a copy that stops while its run's end can't write the queue: the next has the comment once, and no run", async (t) => {
  const { dir, store, ctx, down, ended } = await endWhileStoreDown(t);
  ctx.stopping = true;
  await ended;
  down.on = false;
  // The run's state stayed: the next copy finds the comment there, its sandbox gone.
  assert.ok(await savedRun(store, "r1"));
  const next = queueContext(t, dir, store);
  next.broker = createBroker({});
  next.runner = {
    closed: () => false,
    relink: async () => {},
    list: async () => [],
    remove: async () => {},
  };
  next.shotsDir = dir;
  Object.assign(next, { teardown: createRuns(next).teardown });
  const restored = await next.restoreRuns();
  await next.loadQueue();
  await next.reattach(restored);
  assert.deepEqual(next.armed, [["1", undefined]]);
  assert.deepEqual(
    next.tasks.get("org/repo#1").pending.map((i) => i.queueId),
    ["q-1"],
  );
  assert.equal(await savedRun(store, "r1"), null);
  assert.deepEqual(
    (await store.get(QUEUE_KEY))["org/repo#1"].pending.map((i) => i.queueId),
    ["q-1"],
  );
});

test("a task's queue a listener of the release before kept in logs/<run>.queued.json: loaded, then removed once in the store", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const path = join(dir, "r1.queued.json");
  writeFileSync(
    path,
    JSON.stringify([
      { ...queued("1"), pending: [{ ...queued("1", { queueId: "q-1" }), eyes: 3 }], next: {} },
    ]),
  );
  const ctx = queueContext(t, dir, store);
  await ctx.loadQueue();
  assert.deepEqual(ctx.armed, [["1", undefined]]);
  assert.throws(() => readFileSync(path), { code: "ENOENT" });
  assert.deepEqual(
    (await store.get(QUEUE_KEY))["org/repo#1"].pending.map((i) => i.queueId),
    ["q-1"],
  );
});

test("comments saved before queueIds get one as they come back", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  writeFileSync(
    join(dir, "queue.json"),
    JSON.stringify([{ ...queued("7"), pending: [queued("7")], next: {} }]),
  );
  const ctx = queueContext(t, dir, store);
  await ctx.loadQueue();
  const [item] = ctx.tasks.get("org/repo#7").pending;
  assert.match(item.queueId, /^[0-9a-f-]{36}$/);
  assert.equal((await store.get(QUEUE_KEY))["org/repo#7"].pending[0].queueId, item.queueId);
});

test("a queue.json the first write didn't take: removed after the next that succeeds", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const set = store.set;
  let down = true;
  store.set = (...args) => (down ? Promise.reject(new Error("disk full")) : set(...args));
  const path = join(dir, "queue.json");
  writeFileSync(path, JSON.stringify([{ ...queued("7"), pending: [queued("7")], next: {} }]));
  const ctx = queueContext(t, dir, store);
  await ctx.loadQueue();
  assert.ok(readFileSync(path, "utf8").includes('"id":"7"'));
  down = false;
  await ctx.saveQueue();
  assert.throws(() => readFileSync(path), { code: "ENOENT" });
  assert.deepEqual(Object.keys(await store.get(QUEUE_KEY)), ["org/repo#7"]);
});

test("tasks.mjs: a pause armed from a saved deadline ends at it, not after a pause of its own", async (t) => {
  const dir = tempDir(t);
  // A pause of a minute (queueContext()'s debounceMs): the deadline decides.
  const ctx = queueContext(t, dir, fileStore(), { real: true });
  const started = [];
  ctx.run = (task) => started.push([task.id, Date.now()]);
  const task = newTask(queued("7"));
  task.pending.push(queued("7", { queueId: "q-1" }));
  ctx.tasks.set("org/repo#7", task);
  const dueAt = Date.now() + 80;
  ctx.startLater(task, dueAt);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(started, []);
  await until(() => started.length, { ms: 10_000, what: "the run's start" });
  assert.equal(started.length, 1);
  // Its own pause would end a minute on: well before that, however late a busy runner fires
  // the timer (over 150 ms seen).
  assert.ok(started[0][1] >= dueAt - 5 && started[0][1] < dueAt + 10_000);
  // Saved with it.
  assert.equal((await ctx.store.get(QUEUE_KEY))["org/repo#7"].dueAt, dueAt);
});

test("a run saved before capabilities reads after a restart what its mode's token read", () => {
  assert.deepEqual(savedCapabilities({ mode: "work", capabilities: ["pull", "push"] }), [
    "pull",
    "push",
  ]);
  assert.deepEqual(savedCapabilities({ mode: "research" }), []);
  // read:discussions, which mode-work.rego gave before #497, only for a discussion run.
  const saved = ["pull", "read:issues", "read:discussions"];
  assert.deepEqual(savedCapabilities({ mode: "work", capabilities: saved }), [
    "pull",
    "read:issues",
  ]);
  assert.deepEqual(savedCapabilities({ mode: "discussion", capabilities: saved }), saved);
  const reads = ["pull", "read:issues", "read:pulls", "read:actions"];
  assert.deepEqual(savedCapabilities({ mode: "work" }), reads);
  assert.deepEqual(savedCapabilities({ mode: "brainstorm" }), reads);
  assert.deepEqual(savedCapabilities({ mode: "discussion" }), [...reads, "read:discussions"]);
});

test("a restored run pushes as its saved capabilities say; one saved before them, as its kind did", async (t) => {
  const dir = tempDir(t);
  const broker = createBroker({});
  const ctx = runContext(dir, { broker });
  // A repo's mode (its `light` false since #498) its policies gave no `push`, and one they did.
  const reads = await saveRun(ctx.store, "r1", 1, {}, { mode: "audit", capabilities: ["pull"] });
  const pushes = await saveRun(
    ctx.store,
    "r2",
    2,
    {},
    { mode: "audit", capabilities: ["pull", "push"] },
  );
  // Before capabilities: its kind decides, a light one never pushes.
  const work = await saveRun(ctx.store, "r3", 3, {});
  const light = await saveRun(ctx.store, "r4", 4, {}, { mode: "brainstorm", light: true });
  await createRestart(ctx).restoreRuns();
  assert.deepEqual(
    [reads, pushes, work, light].map((h) => broker.runOf(h).push),
    [false, true, true, false],
  );
});

// Its lines and calls name it (#547): a run started, or picked up again after a restart, logs
// under its repository, issue and run, and a request ID of its own, not its starter's.
test("a run's lines carry its repository, issue and run, from its start and once picked up again", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  // A run started under another run's context (its end freed a place, schedule()).
  const said = [];
  const started = queueContext(t, dir, store, {
    log: (line) => said.push({ line, ...logContext() }),
  });
  const seen = [];
  Object.assign(started, {
    shotsDir: dir,
    titles: { get: () => null },
    broker: { register: () => {}, revoke: () => {}, runOf: () => null, secretsOf: () => [] },
    runner: { state: async () => null, remove: async () => {} },
    // Its start reads them (begin()): what the context says then.
    repoSettings: async () => (
      seen.push(logContext()),
      { settings: null, errors: [], warnings: [] }
    ),
    answer: async () => {},
    schedule: () => {},
  });
  Object.assign(started, createRuns(started), { config: { ...started.config, agent: "nobody" } });
  const task = newTask({ ...queued("1"), name: "deckhand-org-repo-1" });
  // A comment its author may no longer run: dropped before the run starts (dropRefused()).
  task.pending.push(queued("1", { queueId: "q-0", author: "mallory" }));
  task.pending.push(queued("1", { queueId: "q-1", replyTo: 1 }));
  started.tasks.set("org/repo#1", task);
  const other = { request: "another", repo: "else/where", issue: 9, run: "dh-else-where-9-1" };
  await withLogContext(other, () => started.run(task).catch(() => {}));
  // Before it has a run: its own repository and issue, none of the other run's fields.
  const before = seen[0];
  assert.deepEqual([before.repo, before.issue, before.run], ["org/repo", 1, undefined]);
  assert.match(before.request, /^[0-9a-f]{16}$/);
  const dropped = said.find((l) => /a queued comment dropped/.test(l.line));
  assert.deepEqual([dropped.repo, dropped.issue, dropped.run], ["org/repo", 1, undefined]);
  assert.equal(dropped.request, before.request);
  const during = seen.at(-1);
  assert.deepEqual([during.repo, during.issue], ["org/repo", 1]);
  assert.match(during.run, /^deckhand-org-repo-1-\d+$/);
  assert.equal(during.request, before.request);
  // Picked up again by the next orchestrator: the same fields, its own request ID.
  const id = await saveRun(
    store,
    "r2",
    "2",
    { agent: "claude" },
    { task: { repo: "org/repo", id: "2", kind: "issue", number: 2 } },
  );
  const lines = [];
  const log = (line) => lines.push({ line, ...logContext() });
  const next = queueContext(t, dir, store, { log });
  next.broker = createBroker({});
  next.runner = {
    closed: () => false,
    relink: async () => {},
    list: async () => [{ name: "deckhand-org-repo-2", run: id, running: true }],
    remove: async () => {},
  };
  const followed = [];
  next.follow = () => followed.push(logContext());
  await next.reattach(await next.restoreRuns());
  assert.equal(followed.length, 1);
  assert.deepEqual([followed[0].repo, followed[0].issue, followed[0].run], ["org/repo", 2, id]);
  assert.match(followed[0].request, /^[0-9a-f]{16}$/);
  const picked = lines.find((l) => /picked up/.test(l.line));
  assert.equal(picked.run, id);
});

test("a queued comment moved to a wait: in every write of the queue until the wait is written, then out; a start leaves it to the wait", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const ctx = queueContext(t, dir, store);
  const task = newTask({ repo: "org/repo", id: "7", kind: "issue", number: 7, base: "main" });
  ctx.tasks.set("org/repo#7", task);
  const item = queued("7", { queueId: "q-1", eyes: Promise.resolve(41) });
  task.pending.push(item);
  await ctx.saveQueue();
  const ids = async () =>
    ((await store.get(QUEUE_KEY))["org/repo#7"]?.pending ?? []).map((i) => i.queueId);
  let waitWritten;
  ctx.park(task, [item], new Promise((resolve) => (waitWritten = resolve)));
  task.pending.splice(0);
  await ctx.saveQueue();
  assert.deepEqual(await ids(), ["q-1"]);
  // Killed now: in both. The next copy leaves it to the wait (waits.mjs unqueued()).
  const next = queueContext(t, dir, store);
  next.waits = { unqueued: () => new Set(["q-1"]) };
  await next.loadQueue();
  assert.equal(next.tasks.get("org/repo#7")?.pending.length ?? 0, 0);
  // Not killed: the wait written, the queue goes on without it.
  waitWritten();
  await new Promise((resolve) => setImmediate(resolve));
  await ctx.saveQueue();
  assert.deepEqual(await ids(), []);
});

test("queueWritten(): once the queue is written with what this turn queued, tried again while the store is away", async (t) => {
  const dir = tempDir(t);
  const store = fileStore();
  const set = store.set;
  let down = true;
  store.set = async (...args) => {
    if (down) throw new Error("the store is away");
    return set(...args);
  };
  const ctx = queueContext(t, dir, store);
  const sleeps = [];
  ctx.sleep = () => new Promise((resolve) => sleeps.push(resolve));
  const task = newTask({ repo: "org/repo", id: "7", kind: "issue", number: 7, base: "main" });
  ctx.tasks.set("org/repo#7", task);
  let written = false;
  ctx.queueWritten().then(() => (written = true));
  // Queued after the call, in the same turn (tasks.mjs queue() after modeOf()).
  await Promise.resolve();
  task.pending.push(queued("7", { queueId: "q-1" }));
  while (!sleeps.length) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written, false);
  down = false;
  sleeps.shift()();
  while (!written) await new Promise((resolve) => setImmediate(resolve));
  const saved = await store.get(QUEUE_KEY);
  assert.deepEqual(
    saved["org/repo#7"].pending.map((i) => i.queueId),
    ["q-1"],
  );
});

test("access (#731): queued work is checked again before its run, its author's runs:start as it is now", async (t) => {
  const dir = tempDir(t);
  const said = [];
  const ctx = queueContext(t, dir, fileStore(), { log: (line) => said.push(line) });
  ctx.config.users = ["alice", "bob", "carol"];
  // Queued while bob could start work; his start taken away since, as carol never had one.
  const rules = { alice: { "org/repo": MEMBER }, bob: { "org/repo": MEMBER }, carol: {} };
  ctx.permissions = permissionsOf(rules);
  Object.assign(ctx, {
    shotsDir: dir,
    titles: { get: () => null },
    broker: { register: () => {}, revoke: () => {}, runOf: () => null, secretsOf: () => [] },
    runner: { state: async () => null, remove: async () => {} },
    repoSettings: async () => ({ settings: null, errors: [], warnings: [] }),
    answer: async () => {},
    schedule: () => {},
  });
  Object.assign(ctx, createRuns(ctx), { config: { ...ctx.config, agent: "nobody" } });
  const task = newTask({ ...queued("1"), name: "deckhand-org-repo-1" });
  task.pending.push(queued("1", { queueId: "q-0", author: "bob" }));
  // The dashboard's Fix carol asked for: hers to start, though the listener's run.
  const fix = { queueId: "q-1", author: "carol", reason: "review-fix", dashboard: true };
  task.pending.push(queued("1", fix));
  // An automatic review of bob's pull request: the listener's own, not checked.
  task.pending.push(queued("1", { queueId: "q-2", author: "bob", reason: "review" }));
  task.pending.push(queued("1", { queueId: "q-3" }));
  ctx.tasks.set("org/repo#1", task);
  rules.bob = { "org/repo": VIEWER };
  await ctx.run(task).catch(() => {});
  const dropped = said.filter((l) => /a queued comment dropped/.test(l));
  assert.deepEqual(dropped, [
    "org/repo#1: a queued comment dropped: bob may no longer start runs:start:work here",
    "org/repo#1: a queued comment dropped: carol may no longer start runs:start:work here",
  ]);
});
