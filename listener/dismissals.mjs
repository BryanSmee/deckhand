// Failed runs the maintainer dismissed from the dashboard, by task key ("org/repo#12") →
// { runId, by, at }: the task stops asking (Waiting on you, the Error chip) while that run is
// still its last. Also the runs that stopped to ask whose questions nobody will answer any
// more ({ runId, by, at, questions: true }, setAside()): someone took the needs-input label off
// since, or the issue or its pull request closed or merged. The task then no longer waits for
// input (board.mjs). A new run shows it again with no cleanup here; the entries it leaves are
// dropped on the next start (prune()). Kept in dismissed.json.
import { parseKey } from "./events.mjs";
import { respellMap, taskId } from "./spelling.mjs";
import { persistentMap } from "../lib/files.mjs";

export function createDismissals({ path, now = Date.now } = {}) {
  const dismissed = persistentMap(path);
  const save = dismissed.save;

  function dismiss(key, runId, by) {
    dismissed.set(key, { runId, by, at: now() });
    save();
  }

  // The questions of run `runId`, the task's last, set aside (`by`: who took the label off, null
  // for a close or when unknown).
  function setAside(key, runId, by) {
    if (dismissed.get(key)?.runId === runId) return;
    dismissed.set(key, { runId, by, at: now(), questions: true });
    save();
  }

  // The questions of task `key`'s last run set aside, if it stopped to ask (askedOn()): its
  // key, else null.
  function setAsideOn(runs, key, by) {
    const asked = askedOn(runs, key);
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
    // Whether run `runId` is the task's entry, dismissed or set aside.
    has: (key, runId) =>
      [...dismissed].some(([k, d]) => taskId(k) === taskId(key) && d.runId === runId),
    // [{ key, runId, by, at }], as board() takes them.
    list: () => [...dismissed].map(([key, d]) => ({ key, ...d })),
    keys: () => [...dismissed.keys()],
    respell: (spelled) => respellMap(dismissed, spelled) && save(),
  };
}

// Task `key`'s last run when it stopped to ask: { key, runId, finishedAt }, under the run's
// spelling of the key, else null. A run labels its own task's issue or pull request (runs.mjs),
// even when it replied on another (an issue's task, on its pull request), so the label taken off
// there is what sets its questions aside. `runs`: newest first, as ctx.runs is.
export function askedOn(runs, key) {
  const last = runs.find((r) => taskId(r.key) === taskId(key));
  if (last?.status !== "needs-input") return null;
  return { key: last.key, runId: last.id, finishedAt: last.finishedAt ?? last.startedAt ?? 0 };
}

// The tasks whose last run stopped to ask and whose issue or pull request is known closed or
// merged, for setAsideClosed(): [{ key, repo, numbers }]. `closed(key)`: how the task's issue
// or pull request closed (titles.mjs), null while open; `pr(key)`: its pull request (pulls.mjs).
export function closedTasks(runs, closed, pr) {
  const seen = new Set();
  const tasks = [];
  for (const r of runs) {
    if (seen.has(taskId(r.key))) continue;
    seen.add(taskId(r.key));
    const target = parseKey(r.key);
    if (r.status !== "needs-input" || !target || target.kind === "discussion") continue;
    const pull = pr(r.key);
    const numbers = new Set();
    if (closed(r.key)) numbers.add(target.number);
    if (["merged", "closed"].includes(pull?.state)) numbers.add(pull.number);
    if (numbers.size) tasks.push({ key: r.key, repo: target.repo, numbers: [...numbers] });
  }
  return tasks;
}

// The questions of runs whose issue or pull request closed or merged after they asked, while
// no listener heard it (or before set-asides were kept): set aside as the `closed` delivery
// would have (http.mjs). `tasks`: [{ key, repo, numbers }], the tasks known closed or merged,
// with the issues and pull requests that are; `closedAt(repo, number)`: when GitHub says it
// closed, in ms, or null. A run that asked after the close (a comment on a closed issue starts
// one) still waits, and is asked about again at each start while it is its task's last: one
// call for each, which isn't worth keeping a mark for. Resolves to the keys set aside.
export async function setAsideClosed({ runs, dismissals, tasks, closedAt, log = () => {} }) {
  const aside = [];
  for (const { key, repo, numbers } of tasks) {
    const asked = askedOn(runs, key);
    if (!asked || dismissals.has(key, asked.runId)) continue;
    for (const number of numbers) {
      let at;
      try {
        at = await closedAt(repo, number);
      } catch (error) {
        log(`${key}: when #${number} closed: ${error.message ?? error}`);
        continue;
      }
      if (at === null || at < asked.finishedAt) continue;
      dismissals.setAside(asked.key, asked.runId, null);
      aside.push(asked.key);
      break;
    }
  }
  return aside;
}
