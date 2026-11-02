// Auto-picked work that is over (#591), by task id ("org/repo#12", lowercased) → the id of its
// last run then: the issue closed, or its pull request merged or closed. What is queued on the
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

  return { end, ended: (key, runId) => ended.get(taskId(key)) === runId };
}

// The picked work of the tasks `keys` is over (a close or merge delivery, http.mjs): each one
// whose last run of `runs` (newest first) was auto-picked.
export function endPicks(picks, runs, keys) {
  for (const key of keys) {
    const last = runs.find((r) => taskId(r.key) === taskId(key));
    if (last?.autoPickup) picks?.end(key, last.id);
  }
}
