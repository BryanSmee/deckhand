// Tasks whose run was stopped (`/cancel`, the dashboard's Stop: runs.mjs cancel()), by task id
// ("org/repo#12", lowercased) → { by, at } (#1003). Their agent's session is kept (#177), so
// a plain comment would otherwise go on in it: while the mark is there, nothing starts on the
// task but what asks for a run (asksForRun()), which clears it. A comment without a trigger
// line is skipped (task-modes.mjs), the conflict watcher's rebase runs and the review loop's
// fix runs don't start (conflicts.mjs, reviews.mjs), and what was queued behind the stopped run
// waits for the next trigger (tasks.mjs holdStopped()). Kept in the orchestrator's store
// (`stopped`, lib/store-map.mjs): a restart or a handover keeps it. A task stopped before it
// existed has none: as before, not stopped.
import { taskId } from "./spelling.mjs";

// Whether `item` explicitly asks for a run: a person's trigger or `/mode` line (a comment, a
// wait released, an auto-pickup label), or anything from the dashboard or MCP (Start, Queue,
// Rerun, a drag, Fix, answers). Not the listener's own (a rebase, a fix round, a CI fix), nor
// a plain comment.
export function asksForRun(item) {
  if (item.dashboard && item.author) return true;
  return !!item.author && !item.reason && !!(item.trigger || item.modeLine);
}

// `stopped`: the Map they are kept in (storeMap()'s).
export function createStopped({ stopped = new Map() } = {}) {
  return {
    // Task `key`'s run stopped by `by`.
    stop: (key, by, at = Date.now()) => void stopped.set(taskId(key), { by: by ?? null, at }),
    // The mark of task `key`, or null.
    get: (key) => stopped.get(taskId(key)) ?? null,
    has: (key) => stopped.has(taskId(key)),
    // Task `key` asked for a run again: → whether it was stopped.
    clear(key) {
      if (!stopped.has(taskId(key))) return false;
      stopped.delete(taskId(key));
      return true;
    },
  };
}
