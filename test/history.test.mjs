import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createHistory,
  forgottenShots,
  noteUnnamedShots,
  pruneRuns,
  UNNAMED_SHOTS,
} from "../listener/history.mjs";
import { openStore } from "../lib/store.mjs";
import { leftInData } from "../listener/config.mjs";
import { loadRuns, moveSummaries, saveSummary, summaryKey } from "../listener/runlog.mjs";
import { tempDir } from "./helpers.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1000 * DAY;

// A run of `key` that ended `age` days before NOW, with its log (the runner's: `logs`, which
// removeLog() removes from, or refuses to for an id in `stuck`), summary (the orchestrator's
// store) and screenshots (the broker's: `shots`, which removeShots() removes from, or refuses to
// for a folder in `stuck`).
function fixture() {
  const store = openStore("memory:");
  const logs = new Set();
  const shots = new Set();
  const stuck = new Set();
  const removeLog = async (id) => {
    if (stuck.has(id)) throw new Error("the runner service didn't answer");
    return logs.delete(id);
  };
  const removeShots = async (folder) => {
    if (stuck.has(folder)) throw new Error("the broker service didn't answer");
    shots.delete(folder);
  };
  let n = 0;
  const run = (key, age, extra = {}) => {
    n++;
    const id = `deckhand-${key.replace(/\W/g, "-")}-${n}`;
    const folder = n.toString(16).padStart(24, "0");
    shots.add(folder);
    logs.add(id);
    const finishedAt = NOW - age * DAY;
    const record = {
      id,
      key,
      startedAt: finishedAt - 1000,
      finishedAt,
      status: "ok",
      shots: folder,
    };
    saved.push(saveSummary(store, record));
    return { ...record, ...extra };
  };
  const saved = [];
  const files = async (r) => {
    await Promise.all(saved);
    return [logs.has(r.id), (await store.get(summaryKey(r.id))) !== null, shots.has(r.shots)];
  };
  const prune = async (options) => {
    await Promise.all(saved);
    return pruneRuns({ store, now: NOW, needed: () => false, removeLog, removeShots, ...options });
  };
  return { store, run, files, prune, removeLog, removeShots, stuck };
}

test("retention: runs past the limit lose their log, summary and screenshots, and leave the list", async (t) => {
  const { run, files, prune } = fixture();
  // Newest first, as ctx.runs.
  const fresh = run("org/repo#1", 10);
  const old = run("org/repo#1", 100);
  const lone = run("org/repo#2", 91);
  const runs = [fresh, old, lone];
  const byId = new Map(runs.map((r) => [r.id, r]));
  const gone = await prune({ runs, byId, days: 90 });
  assert.deepEqual(
    gone.map((r) => r.id),
    [old.id, lone.id],
  );
  assert.deepEqual(runs, [fresh]);
  assert.deepEqual([...byId.keys()], [fresh.id]);
  assert.deepEqual(await files(fresh), [true, true, true]);
  assert.deepEqual(await files(old), [false, false, false]);
  assert.deepEqual(await files(lone), [false, false, false]);
});

test("retention: what a task still needs is kept, however old", async (t) => {
  const { run, files, prune } = fixture();
  const running = run("org/repo#1", 200, { status: "running", finishedAt: null });
  const asked = run("org/repo#2", 200, { status: "needs-input" });
  const askedBefore = run("org/repo#2", 300, { status: "needs-input" });
  const queued = run("org/repo#3", 200);
  const queuedBefore = run("org/repo#3", 300);
  const done = run("org/repo#4", 200);
  const runs = [running, asked, askedBefore, queued, queuedBefore, done];
  const byId = new Map(runs.map((r) => [r.id, r]));
  const needed = (key) => key === "org/repo#3";
  await prune({ runs, byId, days: 90, needed });
  // Only the latest run of a task: older ones go.
  assert.deepEqual(runs, [running, asked, queued]);
  assert.deepEqual(await files(queued), [true, true, true]);
  assert.deepEqual(await files(queuedBefore), [false, false, false]);
  assert.deepEqual(await files(done), [false, false, false]);
});

test("retention: a log the runner doesn't remove keeps its run listed, for the next try", async (t) => {
  const { run, files, prune, stuck } = fixture();
  const newer = run("org/repo#1", 95);
  const older = run("org/repo#2", 100);
  const runs = [newer, older];
  const byId = new Map(runs.map((r) => [r.id, r]));
  stuck.add(newer.id);
  const gone = await prune({ runs, byId, days: 90 });
  assert.deepEqual(
    gone.map((r) => r.id),
    [older.id],
  );
  assert.deepEqual(runs, [newer]);
  assert.deepEqual(await files(newer), [true, true, true]);
  stuck.clear();
  await prune({ runs, byId, days: 90 });
  assert.deepEqual([runs, await files(newer)], [[], [false, false, false]]);
});

test("retention: screenshots the broker doesn't remove keep their run listed, for the next try", async (t) => {
  const { run, files, prune, stuck } = fixture();
  const old = run("org/repo#1", 100);
  const runs = [old];
  const byId = new Map([[old.id, old]]);
  stuck.add(old.shots);
  assert.deepEqual(await prune({ runs, byId, days: 90 }), []);
  // Its log went (removing it again is nothing), its summary and screenshots stay.
  assert.deepEqual(await files(old), [false, true, true]);
  assert.deepEqual(runs, [old]);
  stuck.clear();
  await prune({ runs, byId, days: 90 });
  assert.deepEqual([runs, await files(old)], [[], [false, false, false]]);
});

test("retention: a summary the store doesn't delete keeps its run listed, for the next try", async () => {
  const { store, run, files, prune } = fixture();
  const old = run("org/repo#1", 100);
  const runs = [old];
  const byId = new Map([[old.id, old]]);
  const failing = {
    ...store,
    delete: async () => {
      throw new Error("the store is away");
    },
  };
  const logs = [];
  const log = (line) => logs.push(line);
  assert.deepEqual(await prune({ runs, byId, days: 90, store: failing, log }), []);
  assert.deepEqual(await files(old), [false, true, false]);
  assert.deepEqual([runs, [...byId.keys()]], [[old], [old.id]]);
  assert.match(logs.join("\n"), /removing the summary of .*: the store is away/);
  await prune({ runs, byId, days: 90 });
  assert.deepEqual([runs, await files(old)], [[], [false, false, false]]);
});

test("retention: 0 keeps everything", async (t) => {
  const { run, files, prune } = fixture();
  const old = run("org/repo#1", 400);
  const runs = [old];
  const byId = new Map([[old.id, old]]);
  assert.deepEqual(await prune({ runs, byId, days: 0 }), []);
  assert.deepEqual(await files(old), [true, true, true]);
});

test("the screenshots an older release kept: a folder no run names, past the days, isn't moved", () => {
  const named = "a".repeat(24);
  const runs = [
    { id: "r1", shots: named },
    { id: "r2", shots: null },
  ];
  const old = NOW - 100 * DAY;
  const forgotten = forgottenShots(runs, 90, NOW);
  assert.equal(forgotten("f".repeat(24), old), true);
  assert.equal(forgotten("f".repeat(24), NOW - DAY), false);
  // Its run is listed: kept, whatever its age.
  assert.equal(forgotten(named, old), false);
  // 0: forever.
  assert.equal(forgottenShots(runs, 0, NOW)("f".repeat(24), old), false);
});

test("retention: at start, then daily, with what the listener's state still needs", async (t) => {
  const { store, run, removeLog, removeShots } = fixture();
  const brainstorm = run("org/repo#1", 200);
  const waiting = run("org/repo#2", 200);
  const labelled = run("org/repo#3", 200);
  const pending = run("org/repo#4", 200);
  const done = run("org/repo#5", 200);
  const later = run("org/repo#6", 50);
  const runs = [brainstorm, waiting, labelled, pending, done, later];
  const ctx = {
    config: { logRetentionDays: 90 },
    log: () => {},
    store,
    runLogs: { remove: removeLog },
    removeShots,
    runs,
    runsById: new Map(runs.map((r) => [r.id, r])),
    tasks: new Map([
      ["org/repo#4", { pending: [{}], running: false }],
      ["org/repo#5", { pending: [], running: false }],
    ]),
    brainstorms: { get: (key) => (key === "org/repo#1" ? {} : undefined) },
    waits: { get: (key) => (key === "org/repo#2" ? {} : undefined) },
    inputs: { has: (key) => key === "org/repo#3" },
  };
  let now = NOW;
  const timers = [];
  const history = createHistory(ctx, {
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.at(-1),
    clear: (t) => timers.splice(timers.indexOf(t), 1),
  });
  await history.start();
  assert.deepEqual(ctx.runs, [brainstorm, waiting, labelled, pending, later]);
  assert.deepEqual(
    timers.map((t) => t.ms),
    [DAY],
  );
  // 41 days on: the run 50 days old then is past 90.
  now += 41 * DAY;
  await timers[0].fn();
  assert.deepEqual(ctx.runs, [brainstorm, waiting, labelled, pending]);
  assert.equal(ctx.runsById.has(later.id), false);
  history.stop();
  assert.deepEqual(timers, []);
});

test("retention: the folders an older release kept that no run names go at the broker once past the days", async () => {
  const store = openStore("memory:");
  const [old, young, stuck] = ["a", "b", "c"].map((c) => c.repeat(24));
  await noteUnnamedShots(store, old, NOW - 100 * DAY);
  await noteUnnamedShots(store, young, NOW - 10 * DAY);
  await noteUnnamedShots(store, stuck, NOW - 200 * DAY);
  const removed = [];
  const ctx = {
    config: { logRetentionDays: 90 },
    log: () => {},
    store,
    runs: [],
    runsById: new Map(),
    tasks: new Map(),
    runLogs: { remove: async () => {} },
    removeShots: async (folder) => {
      if (folder === stuck) throw new Error("the broker service didn't answer");
      removed.push(folder);
    },
  };
  const history = createHistory(ctx, { now: () => NOW, setTimer: () => null });
  await history.prune();
  assert.deepEqual(removed, [old]);
  // One the broker didn't remove stays, for the next day's try; a young one, till its time.
  assert.deepEqual(Object.keys(await store.get(UNNAMED_SHOTS)).sort(), [young, stuck]);
  // 0: forever, nothing asked.
  ctx.config.logRetentionDays = 0;
  await history.prune();
  assert.deepEqual(removed, [old]);
});

test("retention: an old run's log the runner never took isn't summarized again at the next start (#779)", async (t) => {
  const { store, removeLog, removeShots } = fixture();
  // What a release before #619 left in logs/: a run past the days, its summary and its log, which
  // the runner never took (moveLogs() read such a log again at every start, #697).
  const dataDir = tempDir(t);
  const logDir = join(dataDir, "logs");
  mkdirSync(logDir);
  const id = "deckhand-org-repo-1-old";
  const record = {
    id,
    key: "org/repo#1",
    startedAt: NOW - 100 * DAY,
    finishedAt: NOW - 100 * DAY,
    status: "ok",
  };
  writeFileSync(join(logDir, `${id}.json`), JSON.stringify(record));
  const line = JSON.stringify({ type: "listener", event: "note", at: record.startedAt }) + "\n";
  writeFileSync(join(logDir, `${id}.log`), line);
  // The orchestrator's start (server.mjs): the summaries moved, the list loaded, then pruned.
  const start = async () => {
    const moved = await moveSummaries(logDir, store, { log: () => {} });
    const runs = await loadRuns(store, { log: () => {} });
    const byId = new Map(runs.map((r) => [r.id, r]));
    const gone = await pruneRuns({
      runs,
      byId,
      store,
      days: 90,
      now: NOW,
      needed: () => false,
      removeLog,
      removeShots,
    });
    return { moved, listed: runs.length, gone: gone.length };
  };
  assert.deepEqual(await start(), { moved: 1, listed: 0, gone: 1 });
  assert.equal(await store.get(summaryKey(id)), null);
  // The next start finds nothing to summarize: the log stays as it was, named for the operator.
  assert.deepEqual(await start(), { moved: 0, listed: 0, gone: 0 });
  assert.equal(await store.get(summaryKey(id)), null);
  assert.equal(readFileSync(join(logDir, `${id}.log`), "utf8"), line);
  assert.deepEqual(leftInData(dataDir, "store", new Set(["logs"])), [`logs/${id}.log`]);
});
