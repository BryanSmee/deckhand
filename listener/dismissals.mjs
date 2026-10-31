// Failed runs the maintainer dismissed from the dashboard, by task key ("org/repo#12") →
// { runId, by, at }: the task stops asking (Waiting on you, the Error chip) while that run is
// still its last. Also the runs that stopped to ask whose needs-input label was taken off
// since ({ runId, by, at, questions: true }, setAside()): their questions no longer wait
// (board.mjs). A new run shows it again with no cleanup here; the entries it leaves are
// dropped on the next start (prune()). Kept in dismissed.json.
import { parseKey, sameRepo } from "./events.mjs";
import { respellMap, taskId } from "./spelling.mjs";
import { persistentMap } from "../lib/files.mjs";

export function createDismissals({ path, now = Date.now } = {}) {
  const dismissed = persistentMap(path);
  const save = dismissed.save;

  function dismiss(key, runId, by) {
    dismissed.set(key, { runId, by, at: now() });
    save();
  }

  // The questions of run `runId`, the task's last, set aside: the label came off (`by`: who
  // took it off, null when unknown).
  function setAside(key, runId, by) {
    if (dismissed.get(key)?.runId === runId) return;
    dismissed.set(key, { runId, by, at: now(), questions: true });
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
    setAside,
    undo,
    prune,
    // [{ key, runId, by, at }], as board() takes them.
    list: () => [...dismissed].map(([key, d]) => ({ key, ...d })),
    keys: () => [...dismissed.keys()],
    respell: (spelled) => respellMap(dismissed, spelled) && save(),
  };
}

// The tasks whose last run stopped to ask on issue or pull request `number` of `repo` (`pr`:
// a pull request): the task's own, or one whose run replied there (an issue's task replies on
// its pull request). `runs`: newest first, as ctx.runs is. [{ key, runId }].
export function askedOn(runs, repo, number, pr) {
  const seen = new Set();
  const found = [];
  for (const r of runs) {
    const id = taskId(r.key);
    if (seen.has(id)) continue;
    seen.add(id);
    const target = parseKey(r.key);
    if (r.status !== "needs-input" || !target || !sameRepo(target.repo, repo)) continue;
    if (target.kind === "discussion") continue;
    const own = target.number === number && (target.kind === "pr") === pr;
    if (own || r.replyTo === number) found.push({ key: r.key, runId: r.id });
  }
  return found;
}
