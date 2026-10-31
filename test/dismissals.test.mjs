import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { askedOn, closedTasks, createDismissals, setAsideClosed } from "../listener/dismissals.mjs";
import { tempDir } from "./helpers.mjs";

test("dismissals survive a restart; prune() drops those whose run is no longer the last", (t) => {
  const path = join(tempDir(t), "dismissed.json");
  const first = createDismissals({ path, now: () => 5 });
  first.dismiss("org/app#1", "run-1", "alice");
  first.dismiss("org/app#2", "run-2", "bob");
  first.dismiss("org/app#3", "run-3", "bob");
  const again = createDismissals({ path });
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
    createDismissals({ path })
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
  // setAsideOn(): the task's key, once set aside; null when nothing asked.
  assert.equal(d.setAsideOn(runs, "org/app#pr-9", "carol"), "org/app#pr-9");
  assert.equal(d.setAsideOn(runs, "org/app#6", null), null);
  assert.deepEqual(
    d.list().map((x) => [x.key, x.runId, x.by]),
    [
      ["org/app#1", "run-1", "alice"],
      ["org/app#pr-9", "b", "carol"],
    ],
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
  ];
  // #1 closed, #2 closed before its run asked (a comment on a closed issue), #3 open with its
  // pull request #30 merged, #4 open, #5's run didn't ask, #6 closed and set aside already.
  const closed = (key) =>
    ["org/app#1", "org/app#2", "org/app#5", "org/app#6"].includes(key) ? "completed" : null;
  const pr = (key) => (key === "org/app#3" ? { number: 30, state: "merged" } : null);
  const tasks = closedTasks(runs, closed, pr);
  assert.deepEqual(tasks, [
    { key: "org/app#1", repo: "org/app", numbers: [1] },
    { key: "org/app#2", repo: "org/app", numbers: [2] },
    { key: "org/app#3", repo: "org/app", numbers: [30] },
    { key: "org/app#6", repo: "org/app", numbers: [6] },
  ]);
  const d = createDismissals({ now: () => 7 });
  d.setAside("org/app#6", "f", "alice");
  const asked = [];
  const at = { 1: 150, 2: 50, 30: 120, 6: 200 };
  const aside = await setAsideClosed({
    runs,
    dismissals: d,
    tasks,
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
