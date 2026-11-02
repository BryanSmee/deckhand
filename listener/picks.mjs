// Auto-picked work that is over (#591), by task id ("org/repo#12", lowercased) → the id of its
// last run then: the issue closed, its pull request merged or closed, or the sweep gave its
// slot away (tasks.mjs releasePicks()). What is queued on the
// task after that doesn't follow the pick (tasks.mjs followsPick()), the issue reopened too,
// while that run is still the task's last. A new run replaces nothing here: it isn't picked, so
// nothing follows it. Kept in picks.json, one entry per picked task.
import { taskId } from "./spelling.mjs";
import { persistentMap } from "../lib/files.mjs";

export function createPicks({ path } = {}) {
  const ended = persistentMap(path);

  // Task `key`'s picked work over, its last run `runId`.
  function end(key, runId) {
    if (ended.get(taskId(key)) === runId) return;
    ended.set(taskId(key), runId);
    ended.save();
  }

  // At start: entries whose run is no longer its task's last (`runs`, newest first) can't match
  // again, dropped.
  function prune(runs) {
    const last = new Map();
    for (const r of runs) if (!last.has(taskId(r.key))) last.set(taskId(r.key), r.id);
    let changed = false;
    for (const [key, runId] of [...ended]) {
      if (last.get(key) === runId) continue;
      ended.delete(key);
      changed = true;
    }
    if (changed) ended.save();
  }

  return { end, ended: (key, runId) => ended.get(taskId(key)) === runId, prune };
}

// The picked work of the tasks `keys` is over (a close or merge delivery, http.mjs): each one
// whose last run of `runs` (newest first) was auto-picked.
export function endPicks(picks, runs, keys) {
  for (const key of keys) {
    const last = runs.find((r) => taskId(r.key) === taskId(key));
    if (last?.autoPickup) picks?.end(key, last.id);
  }
}
