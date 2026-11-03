// Run history retention: a run's log, its summary and its screenshots go once it is older than
// LOG_RETENTION_DAYS, at start and then daily, and the run leaves the dashboard's list, so
// memory follows the disk. What a task still needs stays: a running run, and the latest run of
// a task that is queued, brainstorming, waiting or waiting for input (the next run reads it:
// its agent, its summary, the dashboard's Rerun). That's the orchestrator's to tell, so it
// decides here; the log is the runner's (#503) and the screenshots the broker's (#609), which
// remove them when asked: a run whose log or screenshots weren't removed stays listed, for the
// next day's try.
import { rmSync } from "node:fs";
import { SHOT_FOLDER } from "../lib/shots.mjs";
import { summaryPath } from "./runlog.mjs";

const DAY = 24 * 60 * 60 * 1000;

// `runs`: newest first, changed in place, with `byId` its index. `needed(key)`: whether that
// task still needs its latest run; `removeLog(id)`: the runner's; `removeShots(folder)`: the
// broker's. Resolves to the runs removed.
export async function pruneRuns({
  runs,
  byId,
  logDir,
  days,
  now,
  needed,
  removeLog,
  removeShots,
  log = () => {},
}) {
  if (!days) return [];
  const cutoff = now - days * DAY;
  const latest = new Set();
  const kept = [];
  const gone = [];
  for (const run of runs) {
    const last = !latest.has(run.key);
    latest.add(run.key);
    const old = (run.finishedAt ?? run.startedAt) < cutoff;
    const keep =
      !old ||
      run.status === "running" ||
      (last && (run.status === "needs-input" || needed(run.key)));
    (keep ? kept : gone).push(run);
  }
  const removed = [];
  for (const run of gone) {
    try {
      await removeLog(run.id);
    } catch (error) {
      log(`${run.key}: removing the log of ${run.id}: ${error.message}`);
      kept.push(run);
      continue;
    }
    try {
      if (SHOT_FOLDER.test(run.shots ?? "")) await removeShots(run.shots);
    } catch (error) {
      log(`${run.key}: removing the screenshots of ${run.id}: ${error.message}`);
      kept.push(run);
      continue;
    }
    try {
      rmSync(summaryPath(logDir, run.id), { force: true });
    } catch (error) {
      log(`${run.key}: removing the summary of ${run.id}: ${error.message}`);
    }
    byId.delete(run.id);
    removed.push(run);
  }
  // In their order, with those added meanwhile (the removals took a while).
  const out = new Set(removed);
  runs.splice(0, runs.length, ...runs.filter((run) => !out.has(run)));
  if (removed.length) log(`Run history: ${removed.length} run(s) older than ${days} days removed`);
  return removed;
}

// Whether a screenshots' folder an older release kept in the orchestrator's shots/ is one retention
// would have removed (broker-service.mjs moveShots(), #609): no run of `runs` names it, and it is
// older than `days` (0: forever). → (folder, mtimeMs) → boolean.
export function forgottenShots(runs, days, now) {
  const named = new Set(runs.map((run) => run.shots).filter(Boolean));
  return (folder, at) => !!days && !named.has(folder) && at < now - days * DAY;
}

// The folders an older release kept that no run names, moved to the broker all the same (younger
// than the days: their links may be in replies): folder → its date, in the orchestrator's store,
// for retention to remove them at the broker once they are past the days, as it removed them
// from shots/ before (#609).
export const UNNAMED_SHOTS = "history/unnamed-shots";

// `fn(folders)` → the new record (undefined: unchanged), written only if no other copy changed it
// meanwhile.
async function updateUnnamed(store, fn) {
  for (;;) {
    const before = await store.get(UNNAMED_SHOTS);
    const after = fn({ ...before });
    if (after === undefined) return;
    if (await store.compareAndSet(UNNAMED_SHOTS, before, after)) return;
  }
}

// One moved (broker-service.mjs moveShots() `moved`), with its folder's date.
export const noteUnnamedShots = (store, folder, at) =>
  updateUnnamed(store, (folders) => ({ ...folders, [folder]: at }));

// Those past `cutoff`, removed at the broker (`removeShots(folder)`), then from the record; one
// the broker didn't remove stays, for the next day's try. → how many were removed.
export async function pruneUnnamedShots({ store, cutoff, removeShots, log = () => {} }) {
  const old = Object.entries((await store.get(UNNAMED_SHOTS)) ?? {})
    .filter(([, at]) => at < cutoff)
    .map(([folder]) => folder);
  const removed = [];
  for (const folder of old) {
    try {
      await removeShots(folder);
      removed.push(folder);
    } catch (error) {
      log(`Run history: removing the screenshots in ${folder}: ${error.message}`);
    }
  }
  if (removed.length) {
    await updateUnnamed(store, (folders) => {
      for (const folder of removed) delete folders[folder];
      return folders;
    });
  }
  return removed.length;
}

// `ctx` (server.mjs) at call time; `now` and the timers injectable for tests.
export function createHistory(
  ctx,
  { now = Date.now, setTimer = setInterval, clear = clearInterval } = {},
) {
  let timer = null;

  // What a task's latest run is still needed for (board.mjs shows the same states).
  function needed(key) {
    const task = ctx.tasks.get(key);
    if (task && (task.running || task.pending.length)) return true;
    if (ctx.brainstorms?.get(key)) return true;
    if (ctx.waits?.get(key)) return true;
    return !!ctx.inputs?.has(key);
  }

  async function prune() {
    try {
      const days = ctx.config.logRetentionDays;
      if (days && ctx.store) {
        await pruneUnnamedShots({
          store: ctx.store,
          cutoff: now() - days * DAY,
          removeShots: (folder) => ctx.removeShots(folder),
          log: ctx.log,
        });
      }
      return await pruneRuns({
        runs: ctx.runs,
        byId: ctx.runsById,
        logDir: ctx.logDir,
        days: ctx.config.logRetentionDays,
        now: now(),
        needed,
        removeLog: (id) => ctx.runLogs.remove(id),
        removeShots: (folder) => ctx.removeShots(folder),
        log: ctx.log,
      });
    } catch (error) {
      ctx.log(`Run history: ${error.stack ?? error}`);
      return [];
    }
  }

  // → the first prune, done.
  function start() {
    const first = prune();
    timer = setTimer(prune, DAY);
    timer?.unref?.();
    return first;
  }

  function stop() {
    if (timer) clear(timer);
    timer = null;
  }

  return { prune, start, stop, needed };
}
