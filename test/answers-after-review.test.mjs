// #1002: a work run stops to ask, then its pull request is reviewed (the review requests
// changes, its fix run skipped for the input awaited: reviews.mjs queueFix()). The review leaves
// the needs-input label on, so the work run's questions still wait: ticking its reply's boxes,
// or the dashboard's answers, continue its session, as before the review. The fix loop then goes
// on from the label the work run's start takes off (runs.mjs start(), reviews.test.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { board } from "../listener/board.mjs";
import { permissionsOf } from "./helpers.mjs";
import { call, open, setup } from "./work-fixture.mjs";

const QUESTIONS = [
  {
    title: "Mermaid",
    text: "May `mermaid` be added?",
    options: [
      { label: "Approve `mermaid`", recommended: true },
      { label: "Draw them by hand", recommended: false },
    ],
  },
];

// Issue #5's runs, newest first: the work run asked on its pull request #9, then the review.
const RUNS = [
  {
    id: "review-1",
    key: "org/app#5",
    repo: "org/app",
    kind: "issue",
    taskMode: "review",
    reason: "review",
    replyTo: 9,
    startedAt: 40,
    finishedAt: 45,
    status: "ok",
  },
  {
    id: "work-1",
    key: "org/app#5",
    repo: "org/app",
    kind: "issue",
    taskMode: "work",
    replyTo: 9,
    startedAt: 10,
    finishedAt: 30,
    status: "needs-input",
    questions: { items: QUESTIONS, raw: "1. **Mermaid**: …" },
  },
];

// The work area with #5 on the board as board() makes it, its label still on. bob may answer
// and start work, but no review: the session that goes on is the work run's.
function asked() {
  const [task] = board({
    runs: RUNS,
    queued: [],
    brainstorms: [],
    inputs: [{ key: "org/app#5", repo: "org/app", since: 30, questions: null }],
  });
  const w = setup({
    issues: { 5: open("Five"), 9: { ...open("Its PR"), pull_request: {} } },
    tasks: { "org/app#5": task },
    board: ["org/app#5"],
    permissions: permissionsOf({
      bob: { "org/app": ["tasks:read", "runs:manage", "runs:start:work"] },
    }),
  });
  return { w, task };
}

test("after a review, the task still waits on the work run's questions, where it asked", () => {
  const { task } = asked();
  assert.equal(task.state, "needs-input");
  assert.deepEqual(task.questions, { source: "run", runId: "work-1", ...RUNS[1].questions });
  assert.deepEqual([task.mode, task.replyTo], ["work", 9]);
});

test("after a review, ticking the work run's boxes answers it and continues its session", async () => {
  const { w } = asked();
  const items = QUESTIONS.map((q) => ({
    ...q,
    options: q.options.map((o, j) => ({ ...o, checked: j === 0 })),
  }));
  const said = await w.api.ticked("org/app", "bob", { number: 9, pr: true, items });
  assert.equal(said, "Answers sent: #5 continues.");
  assert.match(w.comments[0][1], /^Answers from @bob, ticked in the run's questions:/);
  const [item] = w.accepted;
  assert.deepEqual(
    [item.id, item.kind, item.replyTo, item.trigger, item.modeLine, item.dashboard],
    ["5", "issue", 9, null, null, false],
  );
  assert.equal(w.comments[0][0], 9);
});

test("after a review, the dashboard's answers continue the work run's session", async () => {
  const { w } = asked();
  const res = await call(w.api, "POST", "/api/repos/org/app/answer", {
    user: "bob",
    body: { number: 5, answers: [{ options: [0] }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "Answers sent: #5 continues.");
  const [item] = w.accepted;
  assert.deepEqual([item.id, item.replyTo, item.trigger, item.dashboard], ["5", 9, null, true]);
  // A run's reply: the work run's start takes the label off, not the answer.
  assert.deepEqual(w.labels, []);
});

test("after a review, answers without the run's questions in the format still continue it", async () => {
  const runs = [RUNS[0], { ...RUNS[1], questions: null }];
  const [task] = board({
    runs,
    queued: [],
    brainstorms: [],
    inputs: [{ key: "org/app#5", repo: "org/app", since: 30, questions: null }],
  });
  assert.deepEqual([task.state, task.questions], ["needs-input", undefined]);
  const w = setup({ issues: { 5: open("Five") }, tasks: { "org/app#5": task } });
  const res = await call(w.api, "POST", "/api/repos/org/app/answer", {
    body: { number: 5, text: "Approve it" },
  });
  assert.equal(res.body.message, "Answers sent: #5 continues.");
  assert.equal(w.accepted.length, 1);
  assert.deepEqual(w.labels, []);
});
