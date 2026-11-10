import assert from "node:assert/strict";
import { test } from "node:test";
import { askedOn, closedTasks, createDismissals, setAsideClosed } from "../listener/dismissals.mjs";
import { mapStore } from "./helpers.mjs";

test("dismissals survive a restart; prune() drops those whose run is no longer the last", async () => {
  const maps = mapStore();
  const first = createDismissals({ dismissed: await maps.map("dismissed"), now: () => 5 });
  first.dismiss("org/app#1", "run-1", "alice");
  first.dismiss("org/app#2", "run-2", "bob");
  first.dismiss("org/app#3", "run-3", "bob");
  const again = createDismissals({ dismissed: await maps.again("dismissed") });
  assert.deepEqual(again.list(), [
    { key: "org/app#1", runId: "run-1", by: "alice", at: 5 },
    { key: "org/app#2", runId: "run-2", by: "bob", at: 5 },
    { key: "org/app#3", runId: "run-3", by: "bob", at: 5 },
  ]);
  // Newest first: #2 ran again since; #3's runs rolled out of the logs.
  again.prune([
    { id: "run-2b", key: "org/app#2" },
    { id: "run-1", key: "Org/App#1" },
    { id: "run-2", key: "org/app#2" },
  ]);
  assert.deepEqual(
    createDismissals({ dismissed: await maps.again("dismissed") })
      .list()
      .map((d) => d.key),
    ["org/app#1"],
  );
});

test("undo: only the run dismissed; respell: under the repo's one spelling", () => {
  const d = createDismissals({ now: () => 1 });
  d.dismiss("org/App#1", "run-1", "alice");
  assert.equal(d.undo("org/App#1", "run-0"), false);
  d.respell((repo) => repo.toLowerCase());
  assert.deepEqual(d.keys(), ["org/app#1"]);
  assert.equal(d.undo("org/app#1", "run-1"), true);
  assert.deepEqual(d.list(), []);
});

test("setAside: a run's questions, once; askedOn: the task's last run, if it asked", () => {
  const d = createDismissals({ now: () => 3 });
  d.setAside("org/app#1", "run-1", "alice");
  d.setAside("org/app#1", "run-1", "bob");
  assert.deepEqual(d.list(), [
    { key: "org/app#1", runId: "run-1", by: "alice", at: 3, questions: true },
  ]);
  assert.equal(d.has("Org/App#1", "run-1"), true);
  assert.equal(d.has("org/app#1", "run-0"), false);
  const r = (id, key, status, finishedAt = 10) => ({ id, key, status, finishedAt });
  // Newest first.
  const runs = [
    r("a", "org/app#5", "needs-input"),
    r("b", "org/app#pr-9", "needs-input", 20),
    r("c", "org/app#6", "running"),
    r("d", "org/app#6", "needs-input"),
    r("e", "Org/App#7", "needs-input"),
  ];
  assert.deepEqual(askedOn(runs, "org/app#pr-9"), {
    key: "org/app#pr-9",
    runId: "b",
    finishedAt: 20,
  });
  assert.equal(askedOn(runs, "org/app#9"), null);
  // A run going since: nothing to set aside.
  assert.equal(askedOn(runs, "org/app#6"), null);
  // Its key as the run spells it.
  assert.equal(askedOn(runs, "org/APP#7").key, "Org/App#7");
  // setAsideOn(): the task's key, once set aside; null when nothing asked, or when what sets it
  // aside happened before the run asked (a delivery redelivered late).
  assert.equal(d.setAsideOn(runs, "org/app#pr-9", "carol", 19), null);
  assert.equal(d.setAsideOn(runs, "org/app#pr-9", "carol", 20), "org/app#pr-9");
  assert.equal(d.setAsideOn(runs, "org/app#6", null), null);
  assert.deepEqual(
    d.list().map((x) => [x.key, x.runId, x.by]),
    [
      ["org/app#1", "run-1", "alice"],
      ["org/app#pr-9", "b", "carol"],
    ],
  );
  // restoreOn(): the label put back takes the entry of its task's last run back, nothing else,
  // and not for a label put back before the entry (`at` 3).
  d.dismiss("org/app#5", "a", "alice");
  assert.equal(d.restoreOn(runs, "org/app#5"), null);
  assert.equal(d.restoreOn(runs, "org/app#6"), null);
  assert.equal(d.restoreOn(runs, "org/app#pr-9", 2), null);
  assert.equal(d.restoreOn(runs, "org/app#pr-9", 3), "org/app#pr-9");
  assert.deepEqual(
    d.list().map((x) => x.key),
    ["org/app#1", "org/app#5"],
  );
});

test("closed since their run asked: set aside after GitHub's closed_at, not before", async () => {
  const r = (id, key, status, finishedAt) => ({ id, key, status, finishedAt });
  const runs = [
    r("a", "org/app#1", "needs-input", 100),
    r("b", "org/app#2", "needs-input", 100),
    r("c", "org/app#3", "needs-input", 100),
    r("d", "org/app#4", "needs-input", 100),
    r("e", "org/app#5", "ok", 100),
    r("f", "org/app#6", "needs-input", 100),
    r("g", "org/app#discussion-7", "needs-input", 100),
    r("h", "org/app#8", "needs-input", 100),
    r("i", "org/app#pr-9", "needs-input", 100),
  ];
  // #1 closed, #2 closed before its run asked (a comment on a closed issue), #3 open with its
  // pull request #30 merged, #4 open, #5's run didn't ask, #6 closed and set aside already.
  const closed = (key) =>
    ["org/app#1", "org/app#2", "org/app#5", "org/app#6"].includes(key) ? "completed" : null;
  // #8's pull request closed without merging: nothing of #8's. #pr-9 closed: its own.
  const pr = (key) =>
    ({
      "org/app#3": { number: 30, state: "merged" },
      "org/app#8": { number: 80, state: "closed" },
      "org/app#pr-9": { number: 9, state: "closed" },
    })[key] ?? null;
  const tasks = closedTasks(runs, closed, pr);
  assert.deepEqual(tasks, [
    { key: "org/app#1", repo: "org/app", numbers: [1] },
    { key: "org/app#2", repo: "org/app", numbers: [2] },
    { key: "org/app#3", repo: "org/app", numbers: [30] },
    { key: "org/app#6", repo: "org/app", numbers: [6] },
    { key: "org/app#pr-9", repo: "org/app", numbers: [9] },
  ]);
  const d = createDismissals({ now: () => 7 });
  d.setAside("org/app#6", "f", "alice");
  const asked = [];
  const at = { 1: 150, 2: 50, 30: 120, 6: 200 };
  const aside = await setAsideClosed({
    runs,
    dismissals: d,
    tasks: tasks.slice(0, 4),
    closedAt: async (repo, number) => (asked.push(number), at[number] ?? null),
  });
  assert.deepEqual(aside, ["org/app#1", "org/app#3"]);
  // #6 isn't asked about again.
  assert.deepEqual(asked, [1, 2, 30]);
  // A lookup that fails is logged; the next start asks again.
  const logs = [];
  const none = await setAsideClosed({
    runs,
    dismissals: createDismissals(),
    tasks: [tasks[1]],
    closedAt: async () => {
      throw new Error("502");
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual([none, logs], [[], ["org/app#2: when #2 closed: 502"]]);
});

// #1002: a review of its pull request (or a light run) after the run that asked leaves its
// questions waiting: they are still that run's to set aside, kept, or closed.
test("a review after the run that asked: askedOn, closedTasks and prune() still find that run", () => {
  const r = (id, key, status, extra = {}) => ({ id, key, status, finishedAt: 10, ...extra });
  const review = (id, key, extra = {}) => r(id, key, "ok", { taskMode: "review", ...extra });
  // Newest first.
  const runs = [
    review("rev-5", "org/app#5"),
    r("ask-5", "org/app#5", "needs-input"),
    r("light-6", "org/app#6", "ok", { light: true }),
    review("rev-6", "org/app#6"),
    r("ask-6", "org/app#6", "needs-input"),
    review("rev-7", "org/app#7", { status: "running" }),
    r("ask-7", "org/app#7", "needs-input"),
    r("work-8", "org/app#8", "ok", { taskMode: "work" }),
    r("ask-8", "org/app#8", "needs-input"),
  ];
  assert.equal(askedOn(runs, "org/app#5").runId, "ask-5");
  assert.equal(askedOn(runs, "org/app#6").runId, "ask-6");
  // A review going, or a work run since: nothing waits.
  assert.equal(askedOn(runs, "org/app#7"), null);
  assert.equal(askedOn(runs, "org/app#8"), null);
  const merged = { state: "merged", number: 9 };
  assert.deepEqual(
    closedTasks(
      runs,
      () => null,
      () => merged,
    ),
    [
      { key: "org/app#5", repo: "org/app", numbers: [9] },
      { key: "org/app#6", repo: "org/app", numbers: [9] },
    ],
  );
  // prune(): a set-aside stays while its run still asks; a failure dismissed, while it is last.
  const d = createDismissals({ now: () => 1 });
  d.setAside("org/app#5", "ask-5", null);
  d.setAside("org/app#8", "ask-8", null);
  d.dismiss("org/app#6", "ask-6", "alice");
  d.prune(runs);
  assert.deepEqual(d.keys(), ["org/app#5"]);
});
