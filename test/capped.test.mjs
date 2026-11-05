// keepLast(): a capped Map where a fresh value moves last, so the oldest is first to go.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keepLast } from "../lib/capped.mjs";

test("keepLast: a key set again moves last, and the one set longest ago goes first", () => {
  const map = new Map();
  keepLast(map, "a", 1, 3);
  keepLast(map, "b", 2, 3);
  // Set again while the Map has room: a plain set() would leave it first (#863).
  keepLast(map, "a", 3, 3);
  keepLast(map, "c", 4, 3);
  keepLast(map, "d", 5, 3);
  assert.deepEqual(
    [...map],
    [
      ["a", 3],
      ["c", 4],
      ["d", 5],
    ],
  );
});

test("keepLast: a key set again when full drops no other entry", () => {
  const map = new Map([
    ["a", 1],
    ["b", 2],
  ]);
  assert.equal(keepLast(map, "a", 3, 2), map);
  assert.deepEqual(
    [...map],
    [
      ["b", 2],
      ["a", 3],
    ],
  );
});

test("keepLast: a Map already past its cap is brought back to it", () => {
  const map = new Map([
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  keepLast(map, "d", 4, 2);
  assert.deepEqual(
    [...map],
    [
      ["c", 3],
      ["d", 4],
    ],
  );
});
