// Failed runs the maintainer dismissed from the dashboard, by task key ("org/repo#12") →
// { runId, by, at }: the task stops asking (Waiting on you, the Error chip) while that run is
// still its last. Also the runs that stopped to ask whose questions nobody will answer any
// more ({ runId, by, at, questions: true }, setAside()): someone took the needs-input label off
// since, or the issue or its pull request closed or merged. The task then no longer waits for
// input (board.mjs). A new run shows it again with no cleanup here; the entries it leaves are
// dropped on the next start (prune()). Kept in the store (lib/store-map.mjs: `dismissed`).
import { parseKey } from "./events.mjs";
import { respellMap, taskId } from "./spelling.mjs";

// `dismissed`: the Map they are kept in (storeMap()'s).
export function createDismissals({ dismissed = new Map(), now = Date.now } = {}) {
  function dismiss(key, runId, by) {
    dismissed.set(key, { runId, by, at: now() });
  }

  // The questions of run `runId`, the task's last, set aside (`by`: who took the label off, null
  // for a close or when unknown).
  function setAside(key, runId, by) {
    if (dismissed.get(key)?.runId === runId) return;
    dismissed.set(key, { runId, by, at: now(), questions: true });
  }

  // The questions of task `key`'s last run set aside, if it stopped to ask (askedOn()) before
  // `at`, when what sets them aside happened (GitHub's time, ms; null: unknown, now): its key,
  // else null. A delivery redelivered late (redeliveries.mjs) says nothing of a run that asked
  // since.
  function setAsideOn(runs, key, by, at = null) {
    const asked = askedOn(runs, key);
    if (!asked || (at !== null && at < asked.finishedAt)) return null;
    setAside(asked.key, asked.runId, by);
    return asked.key;
  }

  // The questions of task `key`'s last run asking again: the label put back, at `at` (as
  // setAsideOn()), after they were set aside. Its key when they were, else null.
  function restoreOn(runs, key, at = null) {
    const asked = askedOn(runs, key);
    const entry = asked && dismissed.get(asked.key);
    if (!entry?.questions || entry.runId !== asked.runId) return null;
    if (at !== null && at < entry.at) return null;
    dismissed.delete(asked.key);
    return asked.key;
  }

  // Whether run `runId` of the task was dismissed, which Undo takes back. A run's questions set
  // aside are undone the same way: they wait again.
  function undo(key, runId) {
    if (dismissed.get(key)?.runId !== runId) return false;
    dismissed.delete(key);
    return true;
  }

  // Drops the entries whose run is no longer their task's last, nor (questions set aside) the
  // run still asking (askingRun()). `runs`: newest first, as ctx.runs is.
  function prune(runs) {
    const tasks = byTask(runs);
    for (const [key, { runId, questions }] of [...dismissed]) {
      const own = tasks.get(taskId(key)) ?? [];
      const kept = own[0]?.id === runId || (questions && askingRun(own)?.id === runId);
      if (!kept) dismissed.delete(key);
    }
  }

  return {
    dismiss,
    setAside,
    setAsideOn,
    restoreOn,
    undo,
    prune,
    // Whether run `runId` is the task's entry, dismissed or set aside.
    has: (key, runId) =>
      [...dismissed].some(([k, d]) => taskId(k) === taskId(key) && d.runId === runId),
    // [{ key, runId, by, at }], as board() takes them.
    list: () => [...dismissed].map(([key, d]) => ({ key, ...d })),
    keys: () => [...dismissed.keys()],
    respell: (spelled) => respellMap(dismissed, spelled),
  };
}

// The runs after a task's run that stopped to ask which leave its questions waiting: a review
// of its pull request, and a light run, which keep the needs-input label on when they start
// (runs.mjs start(): a light one with `wait_for_answers`, which only helps answer them). A
// review requesting changes then has its fix skipped for the input awaited (reviews.mjs).
const leavesAsking = (r) => r.status !== "running" && (r.taskMode === "review" || !!r.light);

// The run of a task that stopped to ask and still waits for answers, from its runs newest
// first: its last, or the last before those that leave its questions waiting; else null.
export function askingRun(runs) {
  for (const r of runs) {
    if (r.status === "needs-input") return r;
    if (!leavesAsking(r)) return null;
  }
  return null;
}

// `runs` (newest first) by taskId() of their key, each task's newest first.
function byTask(runs) {
  const tasks = new Map();
  for (const r of runs) {
    const id = taskId(r.key);
    if (!tasks.has(id)) tasks.set(id, []);
    tasks.get(id).push(r);
  }
  return tasks;
}

// Task `key`'s run that stopped to ask and still waits (askingRun()): { key, runId,
// finishedAt }, under the run's spelling of the key, else null. A run labels its own task's
// issue or pull request (runs.mjs), even when it replied on another (an issue's task, on its
// pull request), so the label taken off there is what sets its questions aside. `runs`: newest
// first, as ctx.runs is.
export function askedOn(runs, key) {
  const asked = askingRun(runs.filter((r) => taskId(r.key) === taskId(key)));
  if (!asked) return null;
  return { key: asked.key, runId: asked.id, finishedAt: asked.finishedAt ?? asked.startedAt ?? 0 };
}

// The tasks whose run that stopped to ask still waits (askingRun()) and whose issue or pull
// request is known closed or merged, for setAsideClosed(): [{ key, repo, numbers }].
// `closed(key)`: how the task's issue or pull request closed (titles.mjs), null while open;
// `pr(key)`: its pull request (pulls.mjs).
export function closedTasks(runs, closed, pr) {
  const tasks = [];
  for (const own of byTask(runs).values()) {
    const r = askingRun(own);
    const target = r && parseKey(r.key);
    if (!target || target.kind === "discussion") continue;
    const pull = pr(r.key);
    const numbers = new Set();
    if (closed(r.key)) numbers.add(target.number);
    // A pull request closed without merging answers nothing of its issue's questions.
    if (pull?.state === "merged" || (pull?.state === "closed" && target.kind === "pr")) {
      numbers.add(pull.number);
    }
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
