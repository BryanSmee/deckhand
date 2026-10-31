import assert from "node:assert/strict";
import { test } from "node:test";
import { loopStep, waitEdges } from "../listener/http.mjs";
import { board, isLive, runPlaces } from "../listener/board.mjs";

const run = (key, startedAt, extra = {}) => ({
  id: `${key}-${startedAt}`,
  key,
  repo: key.split("#")[0],
  kind: "issue",
  replyTo: Number(key.split("#")[1]),
  mode: "start",
  startedAt,
  status: "ok",
  ...extra,
});

test("each issue's state reflects the listener's", () => {
  const tasks = board({
    runs: [
      run("acme/api#1", 90, { status: "running", phase: "image" }),
      run("acme/api#2", 80, { status: "running", phase: "work" }),
      run("acme/web#3", 70, { status: "running", kind: "brainstorm", mode: "wrap-up" }),
      run("acme/web#4", 60, { status: "needs-input" }),
      run("solo/tool#5", 50, { kind: "brainstorm" }),
      run("solo/tool#6", 40, { kind: "brainstorm" }),
      run("solo/tool#7", 30, { status: "error" }),
      run("solo/tool#8", 20, { status: "interrupted" }),
      run("solo/tool#9", 10),
      run("acme/web#4", 5),
    ],
    queued: [{ key: "acme/api#10", kind: "issue", repo: "acme/api", replyTo: 11 }],
    brainstorms: [
      { key: "solo/tool#5", repo: "solo/tool", number: 5, status: "active", deadline: 55 },
      { key: "solo/tool#6", repo: "solo/tool", number: 6, status: "idle", deadline: 45 },
    ],
  });
  const states = Object.fromEntries(tasks.map((t) => [t.key, t.state]));
  assert.deepEqual(states, {
    "acme/api#1": "building-image",
    "acme/api#2": "working",
    "acme/web#3": "stopping",
    "acme/api#10": "queued",
    "solo/tool#5": "brainstorm",
    "acme/web#4": "needs-input",
    "solo/tool#6": "idle-brainstorm",
    "solo/tool#7": "error",
    "solo/tool#8": "interrupted",
    "solo/tool#9": "done",
  });
  // Live ones first, then by latest activity; grouped by owner and repo.
  assert.deepEqual(
    tasks.slice(0, 4).map((t) => t.key),
    ["acme/api#1", "acme/api#2", "acme/web#3", "acme/api#10"],
  );
  const queued = tasks.find((t) => t.key === "acme/api#10");
  assert.deepEqual(
    [queued.project, queued.repo, queued.number, queued.replyTo, queued.runs],
    ["acme", "acme/api", 10, 11, []],
  );
  const four = tasks.find((t) => t.key === "acme/web#4");
  assert.deepEqual(
    four.runs.map((r) => r.startedAt),
    [60, 5],
  );
  assert.equal(tasks.find((t) => t.key === "solo/tool#5").kind, "brainstorm");
});

test("a running run is scheduled until its agent starts: its setup phase", () => {
  const stateOf = (extra) =>
    board({
      runs: [run("acme/api#1", 10, { status: "running", ...extra })],
      queued: [],
      brainstorms: [],
    })[0].state;
  assert.equal(stateOf({ phase: "setup" }), "scheduled");
  // The image's build is a step of it, and has its own state.
  assert.equal(stateOf({ phase: "image" }), "building-image");
  for (const phase of ["work", "push", "wrap-up"]) assert.equal(stateOf({ phase }), "working");
  assert.equal(stateOf({ phase: "setup", mode: "wrap-up" }), "scheduled");
  assert.equal(stateOf({ phase: "work", mode: "wrap-up" }), "stopping");
  // Records from before phases were kept on them: "building image", or none for the rest.
  assert.equal(stateOf({ phase: "building image" }), "building-image");
  assert.equal(stateOf({}), "working");
  // A scheduled task is live: it sorts with the running ones.
  const tasks = board({
    runs: [run("acme/api#1", 10, { status: "running", phase: "setup" }), run("acme/api#2", 20)],
    queued: [],
    brainstorms: [],
  });
  assert.deepEqual(
    tasks.map((t) => t.key),
    ["acme/api#1", "acme/api#2"],
  );
});

test("a running run wins over comments queued for the next one", () => {
  const [task] = board({
    runs: [run("acme/api#1", 10, { status: "running" })],
    queued: [{ key: "acme/api#1", kind: "issue", repo: "acme/api", replyTo: 1 }],
    brainstorms: [],
  });
  assert.equal(task.state, "working");
});

test("a task waiting for a slot has its place in the run order; a brainstorm starts first", () => {
  const q = (n, extra) => ({
    key: `acme/api#${n}`,
    kind: "issue",
    repo: "acme/api",
    replyTo: n,
    ...extra,
  });
  const tasks = board({
    runs: [run("acme/api#3", 10, { status: "running" })],
    queued: [
      q(1, { position: 2 }),
      q(2, { position: 1, startsFirst: true }),
      // Its follow-up waits for the run going: no place yet.
      q(3, { position: null }),
    ],
    brainstorms: [],
  });
  const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
  assert.equal(byKey["acme/api#1"].position, 2);
  assert.equal(byKey["acme/api#1"].startsFirst, undefined);
  assert.equal(byKey["acme/api#2"].position, 1);
  assert.equal(byKey["acme/api#2"].startsFirst, true);
  assert.equal(byKey["acme/api#3"].position, undefined);
});

test("runPlaces: counted among the repos the user sees, which tell nothing of the others", () => {
  const queue = [
    { repo: "acme/api", id: "1" },
    { repo: "acme/secret", id: "2" },
    { repo: "acme/api", id: "pr-3" },
  ];
  assert.deepEqual(
    [...runPlaces(queue)],
    [
      ["acme/api#1", 1],
      ["acme/secret#2", 2],
      ["acme/api#pr-3", 3],
    ],
  );
  assert.deepEqual(
    [...runPlaces(queue, (repo) => repo !== "acme/secret")],
    [
      ["acme/api#1", 1],
      ["acme/api#pr-3", 2],
    ],
  );
});

test("a comment waiting for other issues: its state and what it waits for", () => {
  const wait = (key, fields = {}) => ({
    key,
    repo: "acme/api",
    kind: "issue",
    mode: "work",
    replyTo: Number(key.split("#")[1]),
    blockers: [77, 80],
    since: 50,
    ...fields,
  });
  const tasks = board({
    runs: [
      run("acme/api#1", 10, { status: "running" }),
      run("acme/api#2", 20),
      run("acme/api#3", 30),
    ],
    queued: [{ key: "acme/api#3", kind: "issue", repo: "acme/api", replyTo: 3 }],
    brainstorms: [],
    waits: [
      wait("acme/api#1"),
      wait("acme/api#2"),
      wait("acme/api#3"),
      wait("acme/api#4", { mode: "audit" }),
    ],
  });
  const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
  // Its run goes on, or its queued comments go first: the wait is for the run after.
  assert.equal(byKey["acme/api#1"].state, "working");
  assert.equal(byKey["acme/api#3"].state, "queued");
  assert.equal(byKey["acme/api#2"].state, "waiting");
  assert.equal(byKey["acme/api#2"].since, 50);
  assert.deepEqual(byKey["acme/api#1"].waitingFor, [77, 80]);
  // Only a wait: a task of its own.
  assert.equal(byKey["acme/api#4"].state, "waiting");
  assert.equal(byKey["acme/api#4"].mode, "audit");
  assert.equal(byKey["acme/api#4"].kind, "issue");
  assert.equal(byKey["acme/api#4"].replyTo, 4);
});

test("a stopped brainstorm shows how its last run ended", () => {
  const [task] = board({
    runs: [run("acme/api#1", 10, { kind: "brainstorm", mode: "wrap-up" })],
    queued: [],
    brainstorms: [{ key: "acme/api#1", repo: "acme/api", status: "stopped", deadline: 5 }],
  });
  assert.equal(task.state, "done");
});

test("pull requests and discussions keep their number and kind", () => {
  const tasks = board({
    runs: [
      run("acme/api#pr-14", 20, { kind: "pr", replyTo: 14 }),
      run("acme/api#discussion-8", 10, { kind: "discussion", replyTo: 8 }),
    ],
    queued: [],
    brainstorms: [],
  });
  assert.deepEqual(
    tasks.map((t) => [t.number, t.kind]),
    [
      [14, "pr"],
      [8, "discussion"],
    ],
  );
});

test("each entry names its mode, the repo's own ones included", () => {
  const tasks = board({
    runs: [
      run("acme/api#1", 30, { taskMode: "audit" }),
      run("acme/api#2", 20, { taskMode: "work" }),
      run("acme/api#3", 10, { taskMode: "audit" }),
    ],
    queued: [{ key: "acme/api#3", kind: "issue", mode: "triage", repo: "acme/api", replyTo: 3 }],
    brainstorms: [{ key: "acme/api#4", repo: "acme/api", number: 4, status: "active" }],
  });
  const modes = Object.fromEntries(tasks.map((t) => [t.key, t.mode]));
  // A queued comment says what the next run will be.
  assert.deepEqual(modes, {
    "acme/api#1": "audit",
    "acme/api#2": "work",
    "acme/api#3": "triage",
    "acme/api#4": "brainstorm",
  });
});

test("issues labelled needs-input show as such, with or without a run, unless one is live", () => {
  const tasks = board({
    runs: [
      run("acme/api#1", 30),
      run("acme/api#2", 20, { status: "running" }),
      run("acme/api#3", 10, { status: "error" }),
    ],
    queued: [{ key: "acme/api#4", kind: "issue", repo: "acme/api", replyTo: 4 }],
    brainstorms: [{ key: "acme/api#5", repo: "acme/api", number: 5, status: "active" }],
    inputs: [
      "acme/api#1",
      "acme/api#2",
      "acme/api#3",
      "acme/api#4",
      "acme/api#5",
      "solo/tool#9",
    ].map((key) => ({ key, repo: key.split("#")[0], since: 40 })),
  });
  const states = Object.fromEntries(tasks.map((t) => [t.key, t.state]));
  assert.deepEqual(states, {
    "acme/api#1": "needs-input",
    "acme/api#2": "working",
    "acme/api#3": "needs-input",
    "acme/api#4": "queued",
    "acme/api#5": "brainstorm",
    "solo/tool#9": "needs-input",
  });
  // Filed by an inbox run: no run of its own.
  const filed = tasks.find((t) => t.key === "solo/tool#9");
  assert.deepEqual(
    [filed.project, filed.repo, filed.number, filed.kind, filed.replyTo, filed.since, filed.runs],
    ["solo", "solo/tool", 9, "issue", 9, 40, []],
  );
});

test("a wait whose issues are done shows as needs-input while its issue is labelled", () => {
  const wait = (key, fields) => ({ key, repo: "acme/api", kind: "issue", mode: "work", ...fields });
  const tasks = board({
    runs: [],
    queued: [],
    brainstorms: [],
    waits: [
      wait("acme/api#1", { replyTo: 1, blockers: [], answers: true, since: 5 }),
      wait("acme/api#2", { replyTo: 2, blockers: [77], answers: false, since: 5 }),
      wait("acme/api#3", { replyTo: 3, blockers: [], answers: true, since: 5 }),
    ],
    inputs: ["acme/api#1", "acme/api#2"].map((key) => ({ key, repo: "acme/api", since: 9 })),
  });
  const states = Object.fromEntries(tasks.map((t) => [t.key, t.state]));
  // #3's label came off: the check starts it soon.
  assert.deepEqual(states, {
    "acme/api#1": "needs-input",
    "acme/api#2": "waiting",
    "acme/api#3": "waiting",
  });
});

test("a task waiting for input carries its questions: its last run's, else its issue's", () => {
  const asked = (raw) => ({ items: null, raw });
  const tasks = board({
    runs: [
      run("acme/api#1", 30, { status: "needs-input", questions: asked("From the run") }),
      // Stopped to ask without questions in the format's place: the issue's.
      run("acme/api#2", 20, { status: "needs-input", questions: null }),
      run("acme/api#3", 10, { status: "running" }),
    ],
    queued: [],
    brainstorms: [],
    inputs: ["acme/api#1", "acme/api#2", "acme/api#3", "acme/api#4", "acme/api#5"].map((key) => ({
      key,
      repo: "acme/api",
      since: 5,
      questions: key.endsWith("5") ? null : asked(`From ${key}`),
    })),
  });
  const questions = Object.fromEntries(tasks.map((t) => [t.key, t.questions]));
  assert.deepEqual(questions, {
    "acme/api#1": { source: "run", runId: "acme/api#1-30", items: null, raw: "From the run" },
    "acme/api#2": { source: "issue", items: null, raw: "From acme/api#2" },
    // Working on it: not waiting.
    "acme/api#3": undefined,
    "acme/api#4": { source: "issue", items: null, raw: "From acme/api#4" },
    // Labelled by hand, nothing in its body.
    "acme/api#5": undefined,
  });
});

test("the graph's arrows: a wait's blockers, pull requests on the board by their own key", () => {
  const shown = [{ key: "org/repo#24" }, { key: "org/repo#22" }, { key: "org/repo#pr-30" }];
  const waits = [
    { key: "org/repo#24", repo: "org/repo", blockers: [22, 23, 30] },
    // Not on the board (past the first 200): no arrow.
    { key: "org/repo#99", repo: "org/repo", blockers: [22] },
  ];
  assert.deepEqual(waitEdges(shown, waits), {
    edges: [
      { from: "org/repo#22", to: "org/repo#24", kind: "after" },
      { from: "org/repo#23", to: "org/repo#24", kind: "after" },
      { from: "org/repo#pr-30", to: "org/repo#24", kind: "after" },
    ],
    blockers: ["org/repo#23"],
  });
  assert.deepEqual(waitEdges(shown, []), { edges: [], blockers: [] });
});

test("rerunnable: the latest run failed or was lost, work on an issue or pull request", () => {
  const items = [{ id: "1", kind: "issue", number: 1, trigger: "work", modeLine: null, text: "" }];
  const failed = (key, startedAt, extra = {}) =>
    run(key, startedAt, { status: "error", taskMode: "work", items, ...extra });
  const tasks = board({
    runs: [
      failed("a/b#1", 100),
      failed("a/b#2", 100, { status: "interrupted", taskMode: "audit" }),
      failed("a/b#pr-3", 100, { kind: "pr" }),
      failed("a/b#4", 100, { status: "ok" }),
      failed("a/b#5", 100, { status: "needs-input" }),
      failed("a/b#6", 100, { status: "running" }),
      failed("a/b#7", 100),
      failed("a/b#8", 100, { kind: "brainstorm", taskMode: "brainstorm" }),
      failed("a/b#9", 100, { items: undefined }),
      failed("a/b#10", 100),
      failed("a/b#11", 100, { status: "ok" }),
      failed("a/b#11", 50),
      failed("a/b#12", 100),
      failed("a/b#13", 100, { status: "cancelled" }),
    ],
    queued: [{ key: "a/b#7", kind: "issue", repo: "a/b", replyTo: 7 }],
    brainstorms: [],
    waits: [{ key: "a/b#10", repo: "a/b", kind: "issue", blockers: [1], since: 1 }],
    inputs: [{ key: "a/b#12", repo: "a/b", since: 1 }],
  });
  const yes = tasks.filter((t) => t.rerunnable).map((t) => t.key);
  assert.deepEqual(yes.sort(), ["a/b#1", "a/b#13", "a/b#2", "a/b#pr-3"]);
  // Cancelled: its own state, over.
  const cancelled = tasks.find((t) => t.key === "a/b#13");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(isLive(cancelled), false);
});

test("isLive: a stopped brainstorm whose wrap-up is done is over, an idle one isn't", () => {
  const tasks = board({
    runs: [
      run("o/r#1", 10, { taskMode: "brainstorm", mode: "wrap-up" }),
      run("o/r#2", 10, { taskMode: "brainstorm" }),
      run("o/r#3", 10, { status: "running", mode: "wrap-up", taskMode: "brainstorm" }),
      run("o/r#4", 10, { status: "error" }),
    ],
    queued: [{ key: "o/r#5", repo: "o/r", kind: "issue", mode: "stop", replyTo: 5 }],
    brainstorms: [
      { key: "o/r#1", repo: "o/r", number: 1, status: "stopped", deadline: 5 },
      { key: "o/r#2", repo: "o/r", number: 2, status: "idle", deadline: 5 },
      { key: "o/r#3", repo: "o/r", number: 3, status: "stopped", deadline: 5 },
      { key: "o/r#5", repo: "o/r", number: 5, status: "stopped", deadline: 5 },
    ],
  });
  const live = Object.fromEntries(tasks.map((t) => [t.key, isLive(t)]));
  assert.deepEqual(live, {
    "o/r#1": false,
    "o/r#2": true,
    "o/r#3": true,
    "o/r#4": false,
    "o/r#5": true,
  });
});

test("a task's runs under two spellings of its repo are one task, the newest run's spelling", () => {
  // A run summary on disk from a listener before the spellings were unified.
  const tasks = board({
    runs: [
      run("Storywake/storywake#98", 3000, { status: "running" }),
      run("storywake/storywake#98", 2000),
      run("storywake/storywake#100", 1000),
    ],
    queued: [{ key: "STORYWAKE/storywake#100", kind: "issue", repo: "STORYWAKE/storywake" }],
    brainstorms: [],
  });
  assert.deepEqual(
    tasks.map((t) => [t.key, t.state, t.runs.length]),
    [
      ["Storywake/storywake#98", "working", 2],
      ["storywake/storywake#100", "queued", 1],
    ],
  );
});

test("dismissed: while the dismissed run is the task's last and the task ended as it did", () => {
  const d = (key, runId) => ({ key, runId, by: "alice", at: 7 });
  const tasks = board({
    runs: [
      run("acme/api#1", 30, { status: "error" }),
      run("acme/api#2", 30, { status: "error" }),
      run("acme/api#2", 20, { status: "interrupted" }),
      run("acme/api#3", 30, { status: "cancelled" }),
      run("acme/api#4", 30, { status: "ok" }),
      run("acme/api#5", 30, { status: "error" }),
      run("acme/api#6", 30, { status: "running" }),
      run("acme/api#6", 20, { status: "error" }),
    ],
    queued: [],
    brainstorms: [],
    inputs: [{ key: "acme/api#5", since: 40, questions: null }],
    dismissals: [
      // The last run, failed: dismissed, whatever the key's case.
      d("Acme/API#1", "acme/api#1-30"),
      // An older run: a new failure since asks again.
      d("acme/api#2", "acme/api#2-20"),
      d("acme/api#3", "acme/api#3-30"),
      d("acme/api#4", "acme/api#4-30"),
      // The needs-input label came since: it asks.
      d("acme/api#5", "acme/api#5-30"),
      // A new run going.
      d("acme/api#6", "acme/api#6-20"),
    ],
  });
  const dismissed = Object.fromEntries(tasks.map((t) => [t.key, t.dismissed]));
  assert.deepEqual(dismissed, {
    "acme/api#1": { by: "alice", at: 7 },
    "acme/api#2": null,
    "acme/api#3": { by: "alice", at: 7 },
    "acme/api#4": null,
    "acme/api#5": null,
    "acme/api#6": null,
  });
  // It keeps its state.
  assert.equal(tasks.find((t) => t.key === "acme/api#1").state, "error");
});

test("a run's questions no longer wait once closed, merged, or their label taken off", () => {
  const asked = { items: [], raw: "1. Which?" };
  const ask = (key, at = 30) => run(key, at, { status: "needs-input", questions: asked });
  const aside = (key, runId) => ({ key, runId, by: "alice", at: 40, questions: true });
  const tasks = board({
    runs: [
      ask("acme/api#1"),
      ask("acme/api#2"),
      ask("acme/api#3"),
      ask("acme/api#4"),
      ask("acme/api#5"),
      ask("acme/api#6"),
      ask("acme/api#7"),
      ask("acme/api#7", 20),
      run("acme/api#8", 30, { status: "error" }),
    ],
    queued: [],
    brainstorms: [],
    // The label put back since: it asks again.
    inputs: [{ key: "acme/api#6", since: 50, questions: null }],
    dismissals: [
      aside("Acme/API#3", "acme/api#3-30"),
      aside("acme/api#6", "acme/api#6-30"),
      // An older run's: the last one still asks.
      aside("acme/api#7", "acme/api#7-20"),
      // A failure dismissed isn't a run's questions set aside.
      { key: "acme/api#5", runId: "acme/api#5-30", by: "alice", at: 40 },
      aside("acme/api#8", "acme/api#8-30"),
    ],
    // #1's pull request merged, #4's issue closed.
    pr: (key) => (key === "acme/api#1" ? { number: 9, state: "merged" } : null),
    closed: (key) => (key === "acme/api#4" ? "completed" : null),
  });
  const states = Object.fromEntries(tasks.map((t) => [t.key, t.state]));
  assert.deepEqual(states, {
    "acme/api#1": "done",
    "acme/api#2": "needs-input",
    "acme/api#3": "done",
    "acme/api#4": "done",
    "acme/api#5": "needs-input",
    "acme/api#6": "needs-input",
    "acme/api#7": "needs-input",
    "acme/api#8": "error",
  });
  const of = (key) => tasks.find((t) => t.key === key);
  // No form for questions nobody waits on; the run keeps how it ended.
  assert.equal(of("acme/api#1").questions, undefined);
  assert.equal(of("acme/api#1").runs[0].status, "needs-input");
  assert.equal(of("acme/api#2").questions.source, "run");
  assert.equal(of("acme/api#8").dismissed, null);
});

test("a task's update time is the latest Deckhand saw, and orders the list", () => {
  const tasks = board({
    runs: [
      run("acme/api#1", 300, { status: "running" }),
      run("acme/api#2", 200),
      run("acme/api#3", 100, { finishedAt: 900 }),
      run("acme/api#4", 50, { finishedAt: 60, lastPushAt: 400 }),
      run("acme/api#5", 40, { finishedAt: 45 }),
      run("acme/api#6", 30, { finishedAt: 35 }),
    ],
    queued: [],
    brainstorms: [],
    pr: (key) => (key === "acme/api#5" ? { readyAt: 700 } : null),
    decisions: (key) => (key === "acme/api#6" ? [{ at: 800 }, { at: 20 }] : []),
  });
  const updated = Object.fromEntries(tasks.map((t) => [t.key, t.updatedAt]));
  assert.deepEqual(updated, {
    "acme/api#1": 300,
    "acme/api#2": 200,
    "acme/api#3": 900,
    "acme/api#4": 400,
    "acme/api#5": 700,
    "acme/api#6": 800,
  });
  // The live one on top, the rest newest update first; `since` stays the run start.
  assert.deepEqual(
    tasks.map((t) => t.key),
    ["acme/api#1", "acme/api#3", "acme/api#6", "acme/api#5", "acme/api#4", "acme/api#2"],
  );
  assert.equal(tasks.find((t) => t.key === "acme/api#3").since, 100);
});

test("a pull request in its fix loop: in review between its runs, its round on the task", () => {
  const pr = { number: 5, state: "ready" };
  const history = [{ round: 0, at: 1, head: "a", counts: { high: 2 }, blocking: 2 }];
  const entry = { head: "a", at: 1, fixes: 1, fixRounds: 3, rounds: history };
  const reviewed = (repo, number) => (number === 5 ? entry : null);
  const tasks = board({
    runs: [
      // The fix run's review is queued after it: in review, not queued.
      run("acme/api#1", 30, { reason: "review-fix", round: 1, rounds: 3 }),
      // The fix run is running: still working.
      run("acme/api#2", 20, { status: "running", reason: "review-fix" }),
      run("acme/api#3", 10),
      run("acme/api#4", 5),
    ],
    queued: [{ key: "acme/api#1", kind: "issue", repo: "acme/api", reason: "review" }],
    brainstorms: [],
    pr: (key) => (key === "acme/api#4" ? { number: 6, state: "ready" } : pr),
    reviewed: (repo, number) =>
      number === 6 ? { ...entry, waiting: { sha: "a" } } : reviewed(repo, number),
  });
  const of = (key) => tasks.find((t) => t.key === key);
  assert.equal(of("acme/api#1").state, "in-review");
  assert.deepEqual(
    [of("acme/api#1").review.loop, of("acme/api#1").review.round, of("acme/api#1").review.rounds],
    ["reviewing", 1, 3],
  );
  assert.equal(of("acme/api#2").state, "working");
  assert.equal(of("acme/api#2").review.loop, "fixing");
  // Nothing going: how the loop ended, with the task's own state.
  assert.equal(of("acme/api#3").state, "done");
  assert.equal(of("acme/api#3").review.loop, "stopped");
  // The auto-merge waits for checks: in review.
  assert.equal(of("acme/api#4").state, "in-review");
  assert.equal(of("acme/api#4").review.loop, "checks");
  // In review is live: on top with the running ones.
  assert.deepEqual(
    tasks.slice(0, 3).map((t) => t.key),
    ["acme/api#1", "acme/api#2", "acme/api#4"],
  );
  // No pull request, or none reviewed: no `review`.
  const plain = board({ runs: [run("acme/api#7", 1)], queued: [], brainstorms: [] });
  assert.equal(plain[0].review, undefined);
});

test("the CI step: waiting for CI and a CI fix run, in review between runs", () => {
  const pr = { number: 5, state: "ready" };
  // Waiting for CI before the first review; a CI fix run over, the listener deciding what
  // follows; a CI fix run queued.
  const entries = {
    1: { ciWaiting: { sha: "a" } },
    2: { next: "ci-fix", nextAt: 0 },
    3: {},
    4: { ciStopped: { sha: "a", at: 1 } },
  };
  const shown = board({
    runs: [
      run("acme/api#1", 30),
      run("acme/api#2", 20, { reason: "ci-fix", round: 1, rounds: 2 }),
      run("acme/api#3", 10),
      run("acme/api#4", 5),
    ],
    queued: [{ key: "acme/api#3", kind: "issue", repo: "acme/api", reason: "ci-fix" }],
    brainstorms: [],
    pr: (key) => ({ ...pr, number: Number(key.split("#")[1]) }),
    reviewed: (repo, number) => entries[number],
  });
  const of = (key) => shown.find((t) => t.key === key);
  assert.deepEqual([of("acme/api#1").state, of("acme/api#1").review.loop], ["in-review", "ci"]);
  assert.deepEqual([of("acme/api#2").state, of("acme/api#2").review.loop], ["in-review", "ci-fix"]);
  assert.deepEqual([of("acme/api#3").state, of("acme/api#3").review.loop], ["in-review", "ci-fix"]);
  // The CI step stopped before any review: done, its loop saying CI failed, never plain ready.
  assert.deepEqual([of("acme/api#4").state, of("acme/api#4").review.loop], ["done", "ci-failed"]);
});

test("in review: a maintainer's comment queued meanwhile stays queued; a loop run over, in review", () => {
  const pr = { number: 5, state: "ready" };
  const history = [{ round: 0, at: 1, head: "a", counts: { high: 1 }, blocking: 1 }];
  const entry = { head: "a", at: 1, fixes: 1, fixRounds: 3, rounds: history };
  const tasks = board({
    runs: [
      run("acme/api#1", 30, { reason: "review" }),
      // Its fix run over, the listener still deciding: in review, fixing.
      run("acme/api#2", 20, { reason: "review-fix" }),
      // A fix run that failed: its step isn't on its way.
      run("acme/api#3", 10, { reason: "review-fix", status: "error" }),
    ],
    // Auto-merge waits for checks on #1's pull request; a maintainer commented meanwhile.
    queued: [{ key: "acme/api#1", kind: "issue", repo: "acme/api", reason: null, position: 1 }],
    brainstorms: [],
    pr: () => pr,
    reviewed: () => ({ ...entry, waiting: { sha: "a" }, next: "review-fix" }),
  });
  const of = (key) => tasks.find((t) => t.key === key);
  assert.deepEqual([of("acme/api#1").state, of("acme/api#1").position], ["queued", 1]);
  assert.equal(of("acme/api#1").review.loop, "checks");
  assert.deepEqual([of("acme/api#2").state, of("acme/api#2").review.loop], ["in-review", "fixing"]);
  assert.equal(of("acme/api#3").state, "error");
});

test("a review queued while the work run that marked the pull request ready still runs", () => {
  const pr = { number: 5, state: "ready" };
  const review = { reason: "review", replyTo: 5 };
  const comment = { reason: undefined, replyTo: 12 };
  // The review queued alone, behind the work run: in review already, the run's state kept.
  assert.deepEqual(loopStep([review]), { reason: "review", others: false });
  // A maintainer's comment queued before it: the task is queued, its comment in the run order.
  assert.deepEqual(loopStep([comment, review]), { reason: "review", others: true });
  assert.deepEqual(loopStep([comment]), { reason: null, others: true });
  const tasks = board({
    runs: [run("acme/api#1", 30, { status: "running" }), run("acme/api#2", 20)],
    queued: [
      { key: "acme/api#1", kind: "issue", repo: "acme/api", ...loopStep([review]) },
      { key: "acme/api#2", kind: "issue", repo: "acme/api", ...loopStep([comment, review]) },
    ],
    brainstorms: [],
    pr: () => pr,
    // Nothing reviewed yet: the first review.
    reviewed: () => null,
  });
  const of = (key) => tasks.find((t) => t.key === key);
  assert.deepEqual(
    [of("acme/api#1").state, of("acme/api#1").review.loop],
    ["working", "reviewing"],
  );
  assert.deepEqual([of("acme/api#2").state, of("acme/api#2").review.loop], ["queued", "reviewing"]);
});
