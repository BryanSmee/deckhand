// What the dashboard lists: one entry per issue or pull request the listener knows about,
// with its current state, grouped by project (the repo's owner) and repo.
//
// States, from what the listener holds right now:
//   scheduled       a run was taken from the queue, and its agent hasn't started yet (its
//                   settings, sandbox, clone and the repo's setup: the run's setup phase)
//   building-image  a run waits for its repo's image to build (a step of its scheduling)
//   working         a run's agent is at work
//   stopping        a brainstorm is wrapping up ("/stop")
//   queued          comments wait for a run (a free slot, or the running one to finish);
//                   `position`: its place in the run order while it waits for a slot
//   in-review       its pull request is in the automatic review-and-fix loop, between its
//                   runs: the next review or fix run queued or being decided, or the
//                   auto-merge waiting for checks (`review`, reviews.mjs reviewLoop()); while
//                   one runs, the task has that run's state, and its `review` says the round
//   waiting         a comment waits for other issues to be done ("/after #12", waits.mjs)
//                   (needs-input once they are, while its open questions aren't answered)
//   brainstorm      a brainstorm waits for the maintainer's next comment
//   idle-brainstorm a brainstorm without a comment for a while; the next one restores it
//   needs-input     the last run stopped to ask, or the issue carries the needs-input label
//                   (open questions in its body, inputs.mjs), with or without a run. A run's
//                   questions no longer wait once they are set aside: the label taken off by
//                   a person, or the issue or its pull request closed or merged after the run
//                   asked (dismissals.mjs setAside())
//   done, error, interrupted, cancelled   how the last run ended (interrupted: the listener
//                   restarted; cancelled: someone stopped it, `/cancel` or the dashboard)
// A task whose last run is error, interrupted or cancelled is `rerunnable` when it may run
// again, and `dismissed` ({ by, at }) while that run is the one someone dismissed from the
// dashboard (dismissals.mjs): it keeps its state, but no longer asks for attention.
import { parseKey, taskKey } from "./events.mjs";
import { APART } from "./modes.mjs";
import { LOOP_STEPS, LOOPING, loopState } from "./reviews.mjs";
import { taskId } from "./spelling.mjs";

export const STATES = [
  "scheduled",
  "building-image",
  "working",
  "stopping",
  "queued",
  "in-review",
  "waiting",
  "brainstorm",
  "idle-brainstorm",
  "needs-input",
  "done",
  "error",
  "interrupted",
  "cancelled",
];

// How a run can end, as a task's state.
const ENDED = ["done", "error", "interrupted", "cancelled"];

// Whether something is going on or waits on the task: what ended (done, error, interrupted,
// cancelled) isn't. The work area's backlog lists an open issue again once its task isn't live.
export const isLive = (t) => !ENDED.includes(t.state);

// Where each task waiting for a slot is in the run order, 1 next to start: task key → place.
// `queue`: tasks.mjs queueOrder()'s tasks; `shown(repo)`: whether the user sees the repo. Only
// those are counted, so the places don't tell of tasks in repos the user can't see.
export function runPlaces(queue, shown = () => true) {
  return new Map(queue.filter((t) => shown(t.repo)).map((t, i) => [taskKey(t.repo, t.id), i + 1]));
}

// Runs kept per entry: older ones stay in the logs.
const RUNS_PER_TASK = 20;

function runState(r) {
  if (r.status === "running") {
    // Its log's phase (runlog.mjs enterPhase()). "building image": a record saved by a
    // listener from before phases were kept on records; no phase, one from before that: work.
    if (r.phase === "image" || r.phase === "building image") return "building-image";
    if (r.phase === "setup") return "scheduled";
    return r.mode === "wrap-up" ? "stopping" : "working";
  }
  if (r.status === "ok") return "done";
  return r.status; // needs-input, error, interrupted, cancelled
}

// How a run can end that may want attention: what Rerun and Dismiss take.
export const FAILED = ["error", "interrupted", "cancelled"];

// Whether the task's last run may run again from the dashboard (work.mjs rerun()): it failed,
// was lost or cancelled, nothing came after it, and it was work on an issue or pull request (in work or
// one of the repo's own modes) whose comments its log kept.
export function rerunnable(t) {
  const last = t.runs[0];
  return (
    !!last &&
    FAILED.includes(last.status) &&
    t.state === last.status &&
    ["issue", "pr"].includes(t.kind) &&
    !!last.taskMode &&
    !APART.has(last.taskMode) &&
    Array.isArray(last.items)
  );
}

// { by, at } while the task's last run is the dismissed one `d` and the task still ended as it
// did; else null: a new run, or the needs-input label, makes it ask again.
function dismissedOf(t, d) {
  const last = t.runs[0];
  // A run's questions set aside (dismissals.mjs setAside()) aren't a failure dismissed.
  if (!d || d.questions || !last || last.id !== d.runId || !FAILED.includes(last.status)) {
    return null;
  }
  return t.state === last.status ? { by: d.by, at: d.at } : null;
}

// `aside`: the run's questions were set aside, so only the issue's body asks.
function questionsFor(t, last, input, aside) {
  if (t.state !== "needs-input") return null;
  // The run's are the latest: one starting takes the label off.
  if (!aside && last?.status === "needs-input" && last.questions) {
    return { source: "run", runId: last.id, ...last.questions };
  }
  return input?.questions ? { source: "issue", ...input.questions } : null;
}

// `runs`: newest first; `queued`, `brainstorms`, `waits`: as http.mjs's state() has them;
// `inputs`: the open issues labelled needs-input (inputs.mjs list()); `dismissals`: the
// dismissed runs and those whose questions were set aside (dismissals.mjs list());
// `pr(key)`, `decisions(key)`: its pull request (pulls.mjs) and policy decisions, newest first
// (decisions.mjs), for when it last changed; `reviewed(repo, number)`: its pull request's entry
// in the store's `reviews`, for its `review`.
// A task waiting for input carries `questions`: { source, runId?, items, raw }, from the reply
// of its last run when it stopped to ask, else from its issue's body (questions.mjs).
export function board({
  runs,
  queued,
  brainstorms,
  waits = [],
  inputs = [],
  dismissals = [],
  pr = () => null,
  decisions = () => [],
  reviewed = () => null,
}) {
  const tasks = gather(runs, [queued, brainstorms, waits, inputs]);
  const byKey = (list) => new Map(list.map((x) => [one(x.key), x]));
  const waiting = byKey(queued);
  const talks = byKey(brainstorms);
  const held = byKey(waits);
  const labelled = byKey(inputs);
  const dismissed = byKey(dismissals);
  for (const t of tasks.values()) {
    const k = one(t.key);
    const aside = dismissed.get(k)?.questions ? dismissed.get(k) : null;
    settle(t, waiting.get(k), talks.get(k), held.get(k), labelled.get(k), aside);
    inReview(t, waiting.get(k), pr(t.key), reviewed);
    t.dismissed = dismissedOf(t, dismissed.get(k));
    t.updatedAt = updatedAt(t, pr(t.key), decisions(t.key));
  }
  // Most recent activity first, the live ones on top.
  const live = (t) =>
    ["scheduled", "building-image", "working", "stopping", "queued", "in-review"].includes(t.state);
  return [...tasks.values()].sort(
    (a, b) => Number(live(b)) - Number(live(a)) || b.updatedAt - a.updatedAt,
  );
}

// When Deckhand last saw something happen to the task: its `since` (a run starting, a
// brainstorm, a wait, the needs-input label), its last run ending or pushing, its pull request
// turning ready, a policy decision.
function updatedAt(t, pr, decisions) {
  const last = t.runs[0];
  return Math.max(
    t.since,
    last?.finishedAt ?? 0,
    last?.lastPushAt ?? 0,
    pr?.readyAt ?? 0,
    decisions?.[0]?.at ?? 0,
  );
}

// A task key whatever the case of its repo: a restart unifies the spellings (spelling.mjs),
// but a run summary on disk may still have one of a listener from before; its task is one.
const one = taskId;

// One task per key (one() of it), in the order they first appear, with the first one's
// spelling: the runs' (each keeps its latest RUNS_PER_TASK), then each of `lists`' (queued,
// brainstorms, waits, inputs).
function gather(runs, lists) {
  const tasks = new Map();
  const entry = (key, repo) => {
    if (!tasks.has(one(key))) tasks.set(one(key), newTask(key, repo));
    return tasks.get(one(key));
  };
  for (const r of runs) {
    const t = entry(r.key, r.repo);
    if (t.runs.length < RUNS_PER_TASK) t.runs.push(r);
  }
  for (const list of lists) for (const x of list) entry(x.key, x.repo);
  return tasks;
}

// A task with nothing known yet but its key: settle() fills in the rest.
function newTask(key, repo) {
  const parsed = parseKey(key);
  const name = repo ?? parsed?.repo ?? "";
  return {
    key,
    repo: name,
    project: name.split("/")[0],
    // "#12", "#pr-12", "#discussion-8"
    number: parsed?.number || null,
    kind: null,
    // work, brainstorm, idea, bug, discussion or one of the repo's own modes.
    mode: null,
    replyTo: null,
    state: null,
    since: 0,
    updatedAt: 0,
    dismissed: null,
    runs: [],
  };
}

// A task's kind, mode, state and the rest, from its last run `t.runs[0]` and its queued entry
// `q`, brainstorm `b`, wait `w` and needs-input label `input`, each if it has one. `aside`:
// its entry when a run's questions were set aside (dismissals.mjs), which hold the task only
// while that run is its last.
function settle(t, q, b, w, input, aside = null) {
  const last = t.runs[0];
  t.kind = q?.kind ?? last?.kind ?? w?.kind ?? (b ? "brainstorm" : null);
  t.mode = (q?.mode === "stop" ? "brainstorm" : q?.mode) ?? w?.mode ?? last?.taskMode ?? null;
  t.replyTo = q?.replyTo ?? w?.replyTo ?? last?.replyTo ?? t.number;
  // Picked by the listener from its auto-pickup label (auto-pickup.mjs), or what follows such a
  // run until its work is done (tasks.mjs followsPick()): queued so, or its last run was.
  if (q?.autoPickup || last?.autoPickup) t.autoPickup = true;
  t.since = Math.max(last?.startedAt ?? 0, b?.deadline ?? 0, w?.since ?? 0);
  // What its next run waits for, whatever it is doing now.
  if (w) t.waitingFor = w.blockers;
  // A running run first: comments for a follow-up wait behind it anyway.
  if (last?.status === "running") t.state = runState(last);
  else if (q) t.state = "queued";
  else if (w) t.state = "waiting";
  else if (b?.status === "active") t.state = "brainstorm";
  else if (b?.status === "idle") t.state = "idle-brainstorm";
  else t.state = last ? runState(last) : "done";
  // A run's questions nobody will answer: set aside since it asked.
  const setAside = !!last && aside?.runId === last.id;
  if (t.state === "needs-input" && setAside) t.state = "done";
  // The label outlasts how the last run ended (a run starting takes it off), not a live one,
  // and is what a wait whose issues are done still waits for (waits.mjs). With the run's
  // questions set aside, the label it put (still on an issue left open when its pull request
  // merged) doesn't hold the task: open questions in the issue's body do, or the label put back
  // since, which asks again.
  const answers = t.state === "waiting" && w.answers;
  const putBack = setAside && (input?.since ?? 0) > aside.at;
  const holds = !setAside || putBack || !!input?.questions;
  if (input && (answers || (ENDED.includes(t.state) && holds))) {
    t.state = "needs-input";
    t.kind ??= "issue";
    t.since = Math.max(t.since, input.since ?? 0);
  }
  const asked = questionsFor(t, last, input, setAside && !putBack);
  if (asked) t.questions = asked;
  if (b && b.status !== "stopped") {
    t.kind = "brainstorm";
    t.mode = "brainstorm";
    t.deadline = b.deadline;
  }
  // Its place in the run order (tasks.mjs queueOrder()), 1 next to start, while it waits for
  // a slot; `startsFirst`: a brainstorm or another mode apart from work (modes.mjs `volumes`),
  // which goes before any work run. `canWait`: it can wait for another issue instead
  // (runs.mjs queuedTask()).
  if (t.state === "queued" && q?.position) {
    t.position = q.position;
    if (q.startsFirst) t.startsFirst = true;
    if (q.canWait) t.canWait = true;
  }
  t.rerunnable = rerunnable(t);
}

// The reasons of the loop's own runs (reviews.mjs).
const STEPS = LOOP_STEPS;

// The fix loop of the task's pull request `p` (reviews.mjs reviewLoop()) as its `review`,
// from the reason of its run going or queued (`q`), or, its last run one of the loop's and
// over, the step the listener said is on its way. `in-review` between the loop's runs: done,
// or queued for the loop's next run; a maintainer's comment queued meanwhile stays queued.
function inReview(t, q, p, reviewed) {
  if (!p) return;
  // The loop's step: its run going, else queued, whatever else runs (the work run that marked
  // the pull request ready may still be).
  const review = loopState(reviewed(t.repo, p.number), t.runs[0], q?.reason);
  if (!review) return;
  t.review = review;
  if (!LOOPING.includes(review.loop)) return;
  if (t.state === "done" || (t.state === "queued" && STEPS.includes(q?.reason) && !q.others)) {
    t.state = "in-review";
  }
}
