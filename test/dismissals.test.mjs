import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createDismissals } from "../listener/dismissals.mjs";
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
