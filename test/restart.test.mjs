// Runs a previous listener left behind (restart.mjs): what the broker knows of them again.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { signingKey } from "../listener/run-token.mjs";
import { board } from "../listener/board.mjs";
import { createPulls } from "../listener/pulls.mjs";
import { createRestart } from "../listener/restart.mjs";
import { createTasks, newTask } from "../listener/tasks.mjs";
import { ambiguous, respellMap, respelled, spellings } from "../listener/spelling.mjs";
import { loadRuns } from "../listener/runlog.mjs";
import { tempDir } from "./helpers.mjs";

// A run's saved state, as saveLive() writes it.
function saveRun(dir, id, issue, record) {
  const secret = `secret-${id}`;
  const saved = {
    task: { repo: "org/repo", id: issue, kind: "issue" },
    id,
    mode: "work",
    light: false,
    secret,
    record: { id, key: `org/repo#${issue}`, ...record },
    handled: [],
    unanswered: [],
  };
  writeFileSync(join(dir, `${id}.live.json`), JSON.stringify(saved));
  return secret;
}

test("a restored run's calls go to its provider, or its agent's own when none was saved", (t) => {
  const dir = tempDir(t);
  const broker = createBroker({});
  const ctx = {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: [],
    runsById: new Map(),
    runner: { closed: () => false },
    broker,
    running: 0,
  };
  const fallback = saveRun(dir, "r1", 1, {
    agent: "claude",
    provider: "openrouter",
    reason: "review-fix",
  });
  const codex = saveRun(dir, "r2", 2, { agent: "codex" });
  const old = saveRun(dir, "r3", 3, {});
  createRestart(ctx).restoreRuns();
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
  const ctx = {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: [],
    runsById: new Map(),
    runner: { closed: () => false },
    broker,
    running: 0,
  };
  const secret = saveRun(dir, "r1", 1, { agent: "claude" });
  createRestart(ctx).restoreRuns();
  // What the git gateway calls once GitHub took a push.
  broker.runOf(secret).pushed({ branch: "issue-1-x", at: 1234 });
  const task = [...ctx.tasks.values()][0];
  assert.equal(task.live.record.branch, "issue-1-x");
  assert.equal(task.live.record.lastPushAt, 1234);
  await task.live.saving;
  const saved = JSON.parse(readFileSync(join(dir, "r1.live.json"), "utf8"));
  assert.deepEqual([saved.record.branch, saved.record.lastPushAt], ["issue-1-x", 1234]);
});

test("a restored run keeps the issues it created, the comments it posted and the workflow runs it reran, and saves those it adds next", async (t) => {
  const dir = tempDir(t);
  const broker = createBroker({});
  const ctx = {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: [],
    runsById: new Map(),
    runner: { closed: () => false },
    broker,
    running: 0,
  };
  const secret = saveRun(dir, "r1", 1, { agent: "claude" });
  const saved = JSON.parse(readFileSync(join(dir, "r1.live.json"), "utf8"));
  writeFileSync(
    join(dir, "r1.live.json"),
    JSON.stringify({
      ...saved,
      created: [
        { number: 30, at: 5 },
        { comment: 3000000001, at: 5 },
      ],
      reruns: [{ run_id: 70, sha: "abc", at: 4 }],
    }),
  );
  // Saved before runs kept them: none.
  const old = saveRun(dir, "r2", 2, { agent: "claude" });
  createRestart(ctx).restoreRuns();
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
  const task = [...ctx.tasks.values()].find((t) => t.live.secret === secret);
  await task.live.saving;
  const again = JSON.parse(readFileSync(join(dir, "r1.live.json"), "utf8"));
  assert.deepEqual(again.created, [
    { number: 30, at: 5 },
    { comment: 3000000001, at: 5 },
    { number: 31, at: 6 },
    { comment: 3000000002, at: 6 },
  ]);
  run.reruns.push({ run_id: 71, sha: "abc", at: 7 });
  run.changed();
  await task.live.saving;
  const third = JSON.parse(readFileSync(join(dir, "r1.live.json"), "utf8"));
  assert.deepEqual(third.reruns, [
    { run_id: 70, sha: "abc", at: 4 },
    { run_id: 71, sha: "abc", at: 7 },
  ]);
});

test("a restored run keeps the network its tokens are bound to, and saves it again", async (t) => {
  const dir = tempDir(t);
  const broker = createBroker({});
  const ctx = {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: [],
    runsById: new Map(),
    runner: { closed: () => false },
    broker,
    running: 0,
  };
  const secret = saveRun(dir, "r1", 1, { agent: "claude" });
  const saved = JSON.parse(readFileSync(join(dir, "r1.live.json"), "utf8"));
  writeFileSync(join(dir, "r1.live.json"), JSON.stringify({ ...saved, sandbox: "net-1" }));
  // Saved before runs kept it: looked up when asked (broker-http.mjs sandboxOfTask()).
  const old = saveRun(dir, "r2", 2, { agent: "claude" });
  createRestart(ctx).restoreRuns();
  const of = (s) => [...ctx.tasks.values()].find((task) => task.live.secret === s).live;
  assert.equal(of(secret).sandbox, "net-1");
  assert.equal(broker.runOf("r1").sandbox, "net-1");
  assert.equal(of(old).sandbox, undefined);
  assert.equal(broker.runOf("r2").sandbox, null);
  broker.runOf(secret).changed();
  await of(secret).saving;
  assert.equal(JSON.parse(readFileSync(join(dir, "r1.live.json"), "utf8")).sandbox, "net-1");
});

// A data dir whose runs, run going and queue have one repo under two spellings: `live` the
// running one's, `newest` the last finished run's.
function twoSpellings(t, { live, newest }) {
  const dir = tempDir(t);
  const summary = (id, repo, n, startedAt) => {
    writeFileSync(join(dir, `${id}.log`), "");
    const run = { id, key: `${repo}#${n}`, repo, status: "ok", startedAt, finishedAt: startedAt };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(run));
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
    runs: loadRuns(dir, { log: () => {} }),
    runsById: new Map(),
    runner: { closed: () => false },
    broker: createBroker({}),
    running: 0,
  };
}

async function restarted(ctx, options) {
  const restart = createRestart(ctx);
  const spelled = options && (await restart.unifySpellings(options));
  restart.restoreRuns();
  restart.loadQueue();
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
  const pulls = createPulls({ path, listPulls: async () => [] });
  const nameOf = async () => "Storywake/storywake";
  const spelled = await restarted(ctx, { nameOf, keys: pulls.keys() });
  pulls.respell(spelled);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
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
  const ctx = {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: [],
    runsById: new Map(),
    runner: { closed: () => false },
    broker: createBroker({}),
    running: 0,
  };
  const path = join(dir, "r1.live.json");
  saveRun(dir, "r1", 1, { agent: "claude" });
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), logPhase: "push" }),
  );
  const restart = createRestart(ctx);
  const [task] = restart.restoreRuns();
  assert.equal(task.live.logPhase, "push");
  task.live.logPhase = "work";
  await restart.saveLive(task);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).logPhase, "work");
});

test("a restored run's record takes its log's phase: scheduled through a restart", (t) => {
  const dir = tempDir(t);
  const ctx = {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: [],
    runsById: new Map(),
    runner: { closed: () => false },
    broker: createBroker({}),
    running: 0,
  };
  const live = (id, issue, record, logPhase) => {
    saveRun(dir, id, issue, record);
    const path = join(dir, `${id}.live.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), logPhase }));
  };
  live("r1", 1, { agent: "claude", phase: "setup" }, "setup");
  // Saved before enterPhase() wrote its first line.
  live("r2", 2, { agent: "claude", phase: "setup" }, null);
  // Saved by a listener whose records only knew "building image".
  live("r3", 3, { agent: "claude", phase: null }, "setup");
  live("r4", 4, { agent: "claude", phase: "building image" }, "image");
  live("r5", 5, { agent: "claude", phase: null }, "work");
  createRestart(ctx).restoreRuns();
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
  after.loadQueue();
  assert.deepEqual(
    after.tasks.get("org/repo#7").pending.map((i) => i.queuedAt),
    [300],
  );
  assert.deepEqual(
    after.queueOrder().map((task) => task.id),
    ["8", "7"],
  );
});

test("across a restart, a run's tokens still check, and a run from before them keeps its secret", async (t) => {
  const dir = tempDir(t);
  const key = signingKey(dir);
  const networks = { "10.9.0.5": "net-new", "10.9.1.5": "net-old" };
  const make = () => {
    // The old run's sandbox at 10.9.1.5, as broker-http.mjs runAt() tells.
    const broker = createBroker({
      key,
      sandboxOf: async (ip) => networks[ip] ?? null,
      sentFrom: async (run, ip) => run.id === "old" && ip === "10.9.1.5",
    });
    const ctx = {
      config: { dataDir: dir },
      log: () => {},
      tasks: new Map(),
      logDir: dir,
      runs: [],
      runsById: new Map(),
      runner: { closed: () => false },
      broker,
      running: 0,
    };
    return { broker, ctx, restart: createRestart(ctx) };
  };
  // The first listener: a run with tokens, saved as saveLive() writes it.
  const first = make();
  first.broker.register("org/repo", undefined, { id: "new", push: true, mode: "work" });
  first.broker.allow("new", ["issue-1-*"]);
  const { token, agentToken } = first.broker.issue("new", "net-new");
  writeFileSync(
    join(dir, "new.live.json"),
    JSON.stringify({
      task: { repo: "org/repo", id: 1, kind: "issue" },
      id: "new",
      mode: "work",
      light: false,
      agentToken,
      runTokens: first.broker.issuedOf("new"),
      branches: ["issue-1-*"],
      record: { id: "new", key: "org/repo#1", agent: "claude" },
      handled: [],
      unanswered: [],
    }),
  );
  // And one a listener from before tokens started: its secret, and no renewal.
  const secret = saveRun(dir, "old", 2, { agent: "claude" });

  const { broker, restart } = make();
  restart.restoreRuns();
  // The token the sandbox holds is redacted at once, before it is renewed.
  assert.deepEqual(broker.secretsOf("new"), [agentToken, token]);
  // Renewed by the next listener, bound where it was (the saved state of a listener that didn't
  // keep `sandbox` says nothing: the token presented does), and it works, as do the next ones.
  const renewed = await broker.renew(token, "10.9.0.5");
  assert.ok(renewed.token);
  assert.equal((await broker.check(renewed.token, "10.9.0.5")).run.id, "new");
  assert.equal((await broker.check(renewed.token, "10.9.1.5")).status, 403);
  const again = await broker.renew(renewed.token, "10.9.0.5");
  assert.equal((await broker.check(again.token, "10.9.0.5")).run.id, "new");
  // The token the sandbox held across the restart is redacted too, not only those renewed since.
  assert.ok(broker.secretsOf("new").includes(token));
  assert.equal((await broker.check(agentToken, "10.9.0.5", "deckhand:agents")).run.id, "new");
  assert.equal((await broker.check(agentToken, "10.9.0.5", "deckhand:agents")).run.id, "new");
  assert.deepEqual(broker.runOf("new").branches, ["issue-1-*"]);
  // Its agent token is redacted from its output still: the live state kept it.
  assert.ok(broker.secretsOf("new").includes(agentToken));
  // The old run's secret works from its own sandbox alone, and has nothing to renew.
  assert.equal((await broker.check(secret, "10.9.1.5")).run.id, "old");
  assert.equal((await broker.check(secret, "10.9.0.5")).status, 403);
  assert.equal((await broker.renew(secret, "10.9.1.5")).status, 401);
});
