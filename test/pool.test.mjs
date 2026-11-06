// mapLimited(): the worker pool behind the listener's bounded reads (#974).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimited } from "../lib/pool.mjs";

test("mapLimited: its results in order, never more than its limit at once", async () => {
  let running = 0;
  let most = 0;
  const results = await mapLimited([5, 1, 4, 2, 3], 2, async (n) => {
    running++;
    most = Math.max(most, running);
    for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
    running--;
    return n * 10;
  });
  assert.deepEqual(results, [50, 10, 40, 20, 30]);
  assert.equal(most, 2);
  assert.deepEqual(await mapLimited([], 4, async () => 1), []);
});

test("mapLimited: a limit past the items starts one worker per item, each item called once", async () => {
  const called = [];
  const results = await mapLimited(["a", "b"], 8, async (item) => {
    called.push(item);
    return item.toUpperCase();
  });
  assert.deepEqual(results, ["A", "B"]);
  assert.deepEqual(called, ["a", "b"]);
});

test("mapLimited: a call that throws rejects it", async () => {
  await assert.rejects(
    mapLimited([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("two");
      return n;
    }),
    /two/,
  );
});
