import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHistory, pruneRuns } from "../listener/history.mjs";
import { saveSummary } from "../listener/runlog.mjs";
import { tempDir } from "./helpers.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1000 * DAY;

// A run of `key` that ended `age` days before NOW, with its log (the runner's: `logs`, which
// removeLog() removes from, or refuses to for an id in `stuck`), summary and screenshots.
function fixture(t) {
  const dir = tempDir(t, "deckhand-history-");
  const logDir = join(dir, "logs");
  const shotsDir = join(dir, "shots");
  mkdirSync(logDir);
  mkdirSync(shotsDir);
  const logs = new Set();
  const stuck = new Set();
  const removeLog = async (id) => {
    if (stuck.has(id)) throw new Error("the runner service didn't answer");
    return logs.delete(id);
  };
  let n = 0;
  const run = (key, age, extra = {}) => {
    n++;
    const id = `deckhand-${key.replace(/\W/g, "-")}-${n}`;
    const shots = n.toString(16).padStart(24, "0");
    mkdirSync(join(shotsDir, shots));
    writeFileSync(join(shotsDir, shots, "page.png"), "png");
    logs.add(id);
    const finishedAt = NOW - age * DAY;
    const record = { id, key, startedAt: finishedAt - 1000, finishedAt, status: "ok", shots };
    saveSummary(logDir, record);
    return { ...record, ...extra };
  };
  const files = (r) => [
    logs.has(r.id),
    existsSync(join(logDir, `${r.id}.json`)),
    existsSync(join(shotsDir, r.shots)),
  ];
  const prune = (options) =>
    pruneRuns({ logDir, shotsDir, now: NOW, needed: () => false, removeLog, ...options });
  return { logDir, shotsDir, run, files, prune, removeLog, stuck };
}

test("retention: runs past the limit lose their log, summary and screenshots, and leave the list", async (t) => {
  const { run, files, prune } = fixture(t);
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
  assert.deepEqual(files(fresh), [true, true, true]);
  assert.deepEqual(files(old), [false, false, false]);
  assert.deepEqual(files(lone), [false, false, false]);
});

test("retention: what a task still needs is kept, however old", async (t) => {
  const { run, files, prune } = fixture(t);
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
  assert.deepEqual(files(queued), [true, true, true]);
  assert.deepEqual(files(queuedBefore), [false, false, false]);
  assert.deepEqual(files(done), [false, false, false]);
});

test("retention: a log the runner doesn't remove keeps its run listed, for the next try", async (t) => {
  const { run, files, prune, stuck } = fixture(t);
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
  assert.deepEqual(files(newer), [true, true, true]);
  stuck.clear();
  await prune({ runs, byId, days: 90 });
  assert.deepEqual([runs, files(newer)], [[], [false, false, false]]);
});

test("retention: 0 keeps everything; folders of unknown runs go by their age", async (t) => {
  const { shotsDir, run, files, prune } = fixture(t);
  const old = run("org/repo#1", 400);
  const runs = [old];
  const byId = new Map([[old.id, old]]);
  assert.deepEqual(await prune({ runs, byId, days: 0 }), []);
  assert.deepEqual(files(old), [true, true, true]);
  // From before records named their folder: an old one goes, a recent one and others stay.
  const orphan = "f".repeat(24);
  const recent = "e".repeat(24);
  for (const name of [orphan, recent, "not-a-run"]) mkdirSync(join(shotsDir, name));
  const past = (NOW - 100 * DAY) / 1000;
  utimesSync(join(shotsDir, orphan), past, past);
  utimesSync(join(shotsDir, "not-a-run"), past, past);
  utimesSync(join(shotsDir, recent), NOW / 1000, NOW / 1000);
  const kept = run("org/repo#2", 1);
  utimesSync(join(shotsDir, kept.shots), past, past);
  await prune({ runs: [kept], byId: new Map(), days: 90 });
  assert.equal(existsSync(join(shotsDir, orphan)), false);
  assert.equal(existsSync(join(shotsDir, recent)), true);
  assert.equal(existsSync(join(shotsDir, "not-a-run")), true);
  // Its run is kept: its folder too, whatever its age.
  assert.deepEqual(files(kept), [true, true, true]);
});

test("retention: at start, then daily, with what the listener's state still needs", async (t) => {
  const { logDir, shotsDir, run, removeLog } = fixture(t);
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
    logDir,
    shotsDir,
    runLogs: { remove: removeLog },
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
