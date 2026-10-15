// What the dashboard lists: one entry per issue or pull request the listener knows about,
// with its current state, grouped by project (the repo's owner) and repo.
//
// States, from what the listener holds right now:
//   building-image  a run waits for its repo's image to build
//   working         a run is in progress
//   stopping        a brainstorm is wrapping up ("/stop")
//   queued          comments wait for a run (a free slot, or the running one to finish)
//   waiting         a comment waits for other issues to be done ("/after #12", waits.mjs)
//   brainstorm      a brainstorm waits for the maintainer's next comment
//   idle-brainstorm a brainstorm without a comment for a while; the next one restores it
//   needs-input     the last run stopped to ask, or the issue carries the needs-input label
//                   (open questions in its body, inputs.mjs), with or without a run
//   done, error, interrupted   how the last run ended (interrupted: the listener restarted)
export const STATES = [
  "building-image",
  "working",
  "stopping",
  "queued",
  "waiting",
  "brainstorm",
  "idle-brainstorm",
  "needs-input",
  "done",
  "error",
  "interrupted",
];

// Runs kept per entry: older ones stay in the logs.
const RUNS_PER_TASK = 20;

function runState(r) {
  if (r.status === "running") {
    if (r.phase === "building image") return "building-image";
    return r.mode === "wrap-up" ? "stopping" : "working";
  }
  if (r.status === "ok") return "done";
  return r.status; // needs-input, error, interrupted
}

// `runs`: newest first; `queued`, `brainstorms`, `waits`: as http.mjs's state() has them;
// `inputs`: the open issues labelled needs-input (inputs.mjs list()).
export function board({ runs, queued, brainstorms, waits = [], inputs = [] }) {
  const tasks = new Map();
  const entry = (key, repo) => {
    if (!tasks.has(key)) {
      const name = repo ?? key.slice(0, key.lastIndexOf("#"));
      tasks.set(key, {
        key,
        repo: name,
        project: name.split("/")[0],
        // "#12", "#pr-12", "#discussion-8"
        number: Number(/(\d+)$/.exec(key)?.[1]) || null,
        kind: null,
        // work, brainstorm, idea, bug, discussion or one of the repo's own modes.
        mode: null,
        replyTo: null,
        state: null,
        since: 0,
        runs: [],
      });
    }
    return tasks.get(key);
  };
  for (const r of runs) {
    const t = entry(r.key, r.repo);
    if (t.runs.length < RUNS_PER_TASK) t.runs.push(r);
  }
  const waiting = new Map(queued.map((q) => [q.key, q]));
  for (const q of queued) entry(q.key, q.repo);
  const talks = new Map(brainstorms.map((b) => [b.key, b]));
  for (const b of brainstorms) entry(b.key, b.repo);
  const held = new Map(waits.map((w) => [w.key, w]));
  for (const w of waits) entry(w.key, w.repo);
  const labelled = new Map(inputs.map((i) => [i.key, i]));
  for (const i of inputs) entry(i.key, i.repo);

  for (const t of tasks.values()) {
    const last = t.runs[0];
    const q = waiting.get(t.key);
    const b = talks.get(t.key);
    const w = held.get(t.key);
    t.kind = q?.kind ?? last?.kind ?? w?.kind ?? (b ? "brainstorm" : null);
    t.mode = (q?.mode === "stop" ? "brainstorm" : q?.mode) ?? w?.mode ?? last?.taskMode ?? null;
    t.replyTo = q?.replyTo ?? w?.replyTo ?? last?.replyTo ?? t.number;
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
    // The label outlasts how the last run ended (a run starting takes it off), not a live one.
    const input = labelled.get(t.key);
    if (input && ["done", "error", "interrupted"].includes(t.state)) {
      t.state = "needs-input";
      t.kind ??= "issue";
      t.since = Math.max(t.since, input.since ?? 0);
    }
    if (b && b.status !== "stopped") {
      t.kind = "brainstorm";
      t.mode = "brainstorm";
      t.deadline = b.deadline;
    }
  }
  // Most recent activity first, the live ones on top.
  const live = (t) => ["building-image", "working", "stopping", "queued"].includes(t.state);
  return [...tasks.values()].sort((a, b) => Number(live(b)) - Number(live(a)) || b.since - a.since);
}
