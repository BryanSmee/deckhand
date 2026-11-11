// reviewLoop()'s CI fix counters (listener/review-loop.mjs, #899): the dashboard's "CI fix x/y".
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewLoop } from "../listener/review-loop.mjs";

const at = (entry) => {
  const { ciFixes, ciRounds } = reviewLoop(entry, "ci-fix");
  return { ciFixes, ciRounds };
};

test("reviewLoop: the CI fix runs so far, of the rounds `review.ci_fix` allowed", () => {
  assert.deepEqual(at({ ciFixes: 1, ciRounds: 2 }), { ciFixes: 1, ciRounds: 2 });
  // An entry written before the rounds were kept: the count alone, of 0 (not known).
  assert.deepEqual(at({ ciFixes: 1 }), { ciFixes: 1, ciRounds: 0 });
  // None ran: neither, as before (api/state stays as it was).
  assert.deepEqual(at({}), { ciFixes: undefined, ciRounds: undefined });
  assert.ok(!("ciFixes" in reviewLoop({}, "ci-fix")));
});
