import assert from "node:assert/strict";
import { test } from "node:test";
import { ciState, latestStatuses } from "../listener/ci.mjs";

const check = (status, conclusion = null, more = {}) => ({
  name: "build",
  status,
  conclusion,
  app: { slug: "circleci-checks" },
  ...more,
});
const status = (state, more = {}) => ({ context: "ci/jenkins", state, ...more });

test("ciState: check runs from other Apps decide like Actions runs", () => {
  for (const c of ["success", "skipped", "neutral"]) {
    assert.equal(ciState({ checks: [check("completed", c)] }).state, "passed", c);
  }
  for (const c of ["failure", "cancelled", "timed_out", "action_required", "stale"]) {
    assert.equal(ciState({ checks: [check("completed", c)] }).state, "failed", c);
  }
  for (const s of ["queued", "in_progress", "waiting", "requested", "pending"]) {
    assert.equal(ciState({ checks: [check(s)] }).state, "running", s);
  }
  assert.deepEqual(ciState({}), { state: "none", failed: [], going: [] });
  assert.deepEqual(ciState(), { state: "none", failed: [], going: [] });
});

test("ciState: commit statuses: pending runs, success passes, failure and error fail", () => {
  assert.equal(ciState({ statuses: [status("pending")] }).state, "running");
  assert.equal(ciState({ statuses: [status("success")] }).state, "passed");
  assert.equal(ciState({ statuses: [status("failure")] }).state, "failed");
  assert.equal(ciState({ statuses: [status("error")] }).state, "failed");
  // The newest status of a context decides: `…/statuses` lists its pending one too.
  const later = ciState({
    statuses: [
      status("success", { id: 2, updated_at: "2026-10-30T10:05:00Z" }),
      status("pending", { id: 1, updated_at: "2026-10-30T10:00:00Z" }),
    ],
  });
  assert.equal(later.state, "passed");
  const failed = ciState({
    statuses: [
      status("pending", { id: 1, updated_at: "2026-10-30T10:00:00Z" }),
      status("failure", { id: 2, updated_at: "2026-10-30T10:05:00Z" }),
      status("success", { context: "deploy", id: 3 }),
    ],
  });
  assert.deepEqual(
    [failed.state, failed.failed.map((s) => s.id), failed.going],
    ["failed", [2], []],
  );
  assert.equal(latestStatuses([status("pending"), status("success", { id: 1 })]).length, 1);
});

test("ciState: runs, checks and statuses together; a failure anywhere decides", () => {
  const run = { name: "CI", status: "completed", conclusion: "success" };
  const all = (runs, checks, statuses) => ciState({ runs, checks, statuses }).state;
  assert.equal(all([run], [check("completed", "success")], [status("success")]), "passed");
  assert.equal(all([run], [check("in_progress")], [status("success")]), "running");
  assert.equal(all([run], [check("in_progress")], [status("error")]), "failed");
  assert.equal(all([{ ...run, status: "queued" }], [], [status("success")]), "running");
  assert.equal(all([], [check("completed", "failure")], []), "failed");
  // Actions' own check runs are its jobs: with the runs given, the runs decide.
  const job = check("completed", "failure", { app: { slug: "github-actions" } });
  assert.equal(all([run], [job], []), "passed");
  assert.equal(ciState({ checks: [job] }).state, "failed");
  // Failed and going hold them as GitHub gave them.
  const mixed = ciState({ runs: [run], checks: [check("queued")], statuses: [status("error")] });
  assert.deepEqual(mixed.failed, [status("error")]);
  assert.deepEqual(mixed.going, [check("queued")]);
  // An array alone is Actions runs, as the merge gate and the CI step pass them.
  assert.equal(ciState([run]).state, "passed");
});
