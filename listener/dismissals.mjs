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

  // The questions of the last run of issue or pull request `number`'s task set aside, if it
  // stopped to ask (askedOn()): the label came off there. Its task key, else null.
  function setAsideOn(runs, repo, number, pr, by) {
    const asked = askedOn(runs, repo, number, pr);
    if (asked) setAside(asked.key, asked.runId, by);
    return asked?.key ?? null;
  }

  // Whether run `runId` of the task was dismissed, which Undo takes back. A run's questions set
  // aside are undone the same way: they wait again.
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
    setAsideOn,
    undo,
    prune,
    // [{ key, runId, by, at }], as board() takes them.
    list: () => [...dismissed].map(([key, d]) => ({ key, ...d })),
    keys: () => [...dismissed.keys()],
    respell: (spelled) => respellMap(dismissed, spelled) && save(),
  };
}

// The task of issue or pull request `number` of `repo` (`pr`: a pull request) when its last run
// stopped to ask: { key, runId }, else null. A run labels its own task's issue or pull request
// (runs.mjs), even when it replied on another (an issue's task, on its pull request), so the
// label taken off there is what sets its questions aside. `runs`: newest first, as ctx.runs is.
export function askedOn(runs, repo, number, pr) {
  const kind = pr ? "pr" : "issue";
  const last = runs.find((r) => {
    const target = parseKey(r.key);
    return target?.kind === kind && target.number === number && sameRepo(target.repo, repo);
  });
  return last?.status === "needs-input" ? { key: last.key, runId: last.id } : null;
}
