// What a plan's answer says it did (plans.mjs planSummary()): the plan itself is work.test.mjs's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planSummary } from "../listener/plans.mjs";

test("planSummary: one issue starts, or several, or none; then each wait in the plan's order", () => {
  // #10's sub-issues #11 and #12, #11 blocked by #12: only #12 starts.
  const one = new Map([
    [10, [11, 12]],
    [11, [12]],
    [12, []],
  ]);
  assert.equal(
    planSummary([10, 11, 12], one),
    "#12 starts; #10 waits for #11 and #12; #11 waits for #12",
  );
  const two = new Map([
    [10, [11, 12, 13]],
    [11, [12]],
    [12, []],
    [13, []],
  ]);
  assert.equal(
    planSummary([10, 11, 12, 13], two),
    "#12 and #13 start; #10 waits for #11, #12 and #13; #11 waits for #12",
  );
  // Everything waits for something outside the tree: nothing starts, and it says no more.
  const none = new Map([
    [10, [11]],
    [11, [20]],
  ]);
  assert.equal(planSummary([10, 11], none), "#10 waits for #11; #11 waits for #20");
});
