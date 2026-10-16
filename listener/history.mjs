// Run history retention: a run's log, its summary and its screenshots go once it is older than
// LOG_RETENTION_DAYS, at start and then daily, and the run leaves the dashboard's list, so
// memory follows the disk. What a task still needs stays: a running run, and the latest run of
// a task that is queued, brainstorming, waiting or waiting for input (the next run reads it:
// its agent, its summary, the dashboard's Rerun).
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { summaryPath } from "./runlog.mjs";

const DAY = 24 * 60 * 60 * 1000;

// Screenshot folders are random hex (runs.mjs shotsFolder()): nothing else is removed.
const SHOTS = /^[0-9a-f]{24}$/;

// `runs`: newest first, changed in place, with `byId` its index. `needed(key)`: whether that
// task still needs its latest run. Returns the runs removed.
export function pruneRuns({ runs, byId, shotsDir, days, now, needed, log = () => {} }) {
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
  for (const run of gone) {
    try {
      rmSync(run.logPath, { force: true });
      rmSync(summaryPath(run.logPath), { force: true });
      if (SHOTS.test(run.shots ?? "")) {
        rmSync(join(shotsDir, run.shots), { recursive: true, force: true });
      }
    } catch (error) {
      log(`${run.key}: removing the log of ${run.id}: ${error.message}`);
    }
    byId.delete(run.id);
  }
  runs.splice(0, runs.length, ...kept);
  pruneShots(shotsDir, kept, cutoff, log);
  if (gone.length) log(`Run history: ${gone.length} run(s) older than ${days} days removed`);
  return gone;
}

// Folders of runs from before records named theirs, or whose run is gone: by their age.
function pruneShots(shotsDir, runs, cutoff, log) {
  const used = new Set(runs.map((r) => r.shots).filter(Boolean));
  let folders;
  try {
    folders = readdirSync(shotsDir);
  } catch {
    return;
  }
  for (const name of folders) {
    if (!SHOTS.test(name) || used.has(name)) continue;
    const path = join(shotsDir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch (error) {
      log(`Removing the screenshots in ${name}: ${error.message}`);
    }
  }
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

  function prune() {
    try {
      return pruneRuns({
        runs: ctx.runs,
        byId: ctx.runsById,
        shotsDir: ctx.shotsDir,
        days: ctx.config.logRetentionDays,
        now: now(),
        needed,
        log: ctx.log,
      });
    } catch (error) {
      ctx.log(`Run history: ${error.stack ?? error}`);
      return [];
    }
  }

  function start() {
    prune();
    timer = setTimer(prune, DAY);
    timer?.unref?.();
  }

  function stop() {
    if (timer) clear(timer);
    timer = null;
  }

  return { prune, start, stop, needed };
}
