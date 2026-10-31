// Failed runs the maintainer dismissed from the dashboard, by task key ("org/repo#12") →
// { runId, by, at }: the task stops asking (Waiting on you, the Error chip) while that run is
// still its last. A new run shows it again with no cleanup here; the entries it leaves are
// dropped on the next start (prune()). Kept in dismissed.json.
import { respellMap, taskId } from "./spelling.mjs";
import { persistentMap } from "../lib/files.mjs";

export function createDismissals({ path, now = Date.now } = {}) {
  const dismissed = persistentMap(path);
  const save = dismissed.save;

  function dismiss(key, runId, by) {
    dismissed.set(key, { runId, by, at: now() });
    save();
  }

  // Whether run `runId` of the task was dismissed, which Undo takes back.
  function undo(key, runId) {
    if (dismissed.get(key)?.runId !== runId) return false;
    dismissed.delete(key);
    save();
    return true;
  }

  // Drops the entries whose run is no longer their task's last. `runs`: newest first, as
  // ctx.runs is.
  function prune(runs) {
    const last = new Map();
    for (const r of runs) if (!last.has(taskId(r.key))) last.set(taskId(r.key), r.id);
    let changed = false;
    for (const [key, { runId }] of [...dismissed]) {
      if (last.get(taskId(key)) === runId) continue;
      dismissed.delete(key);
      changed = true;
    }
    if (changed) save();
  }

  return {
    dismiss,
    undo,
    prune,
    // [{ key, runId, by, at }], as board() takes them.
    list: () => [...dismissed].map(([key, d]) => ({ key, ...d })),
    keys: () => [...dismissed.keys()],
    respell: (spelled) => respellMap(dismissed, spelled) && save(),
  };
}
