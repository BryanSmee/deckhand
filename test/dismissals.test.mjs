import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { askedOn, createDismissals } from "../listener/dismissals.mjs";
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

test("setAside: a run's questions, once; askedOn: the tasks whose last run asked there", () => {
  const d = createDismissals({ now: () => 3 });
  d.setAside("org/app#1", "run-1", "alice");
  d.setAside("org/app#1", "run-1", "bob");
  assert.deepEqual(d.list(), [
    { key: "org/app#1", runId: "run-1", by: "alice", at: 3, questions: true },
  ]);
  const r = (id, key, status, replyTo) => ({ id, key, status, replyTo });
  // Newest first.
  const runs = [
    r("a", "org/app#5", "needs-input", 9),
    r("b", "org/app#pr-9", "needs-input", 9),
    r("c", "org/app#6", "running", 6),
    r("d", "org/app#6", "needs-input", 6),
    r("e", "Org/App#7", "needs-input", 7),
    r("f", "org/app#discussion-9", "needs-input", 9),
    r("g", "other/app#9", "needs-input", 9),
  ];
  // Pull request #9: its own task, and #5's, whose run replied on it.
  assert.deepEqual(askedOn(runs, "org/app", 9, true), [
    { key: "org/app#5", runId: "a" },
    { key: "org/app#pr-9", runId: "b" },
  ]);
  // Issue #5: its task; issue #6: a run going since, nothing.
  assert.deepEqual(askedOn(runs, "org/app", 5, false), [{ key: "org/app#5", runId: "a" }]);
  assert.deepEqual(askedOn(runs, "org/app", 6, false), []);
  assert.deepEqual(askedOn(runs, "org/APP", 7, false), [{ key: "Org/App#7", runId: "e" }]);
});
