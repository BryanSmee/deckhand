import assert from "node:assert/strict";
import { test } from "node:test";
import { createSync } from "../listener/sync.mjs";

test("the last sync is kept: when, who, what it found, or why it failed", async () => {
  let clock = 1000;
  let fail = false;
  const logged = [];
  const sync = createSync({
    scan: async () => {
      if (fail) throw new Error("GitHub GET /app/hook/deliveries: 502");
      return 2;
    },
    resync: async () => 1,
    log: (line) => logged.push(line),
    now: () => clock,
  });
  assert.equal(sync.last(), null);
  const atStart = await sync.sync(null);
  assert.deepEqual(atStart, { at: 1000, by: null, redelivered: 2, pulls: 1 });
  assert.equal(sync.last(), atStart);
  clock = 2000;
  fail = true;
  const failed = await sync.sync("alice");
  assert.deepEqual(failed, {
    at: 2000,
    by: "alice",
    redelivered: 0,
    pulls: 0,
    error: "GitHub GET /app/hook/deliveries: 502",
  });
  assert.equal(sync.last(), failed);
  assert.deepEqual(logged, ["Sync: GitHub GET /app/hook/deliveries: 502"]);
});

test("no App yet: no delivery asked again counts as none", async () => {
  const sync = createSync({ scan: async () => null, resync: async () => 0, now: () => 5 });
  assert.deepEqual(await sync.sync(null), { at: 5, by: null, redelivered: 0, pulls: 0 });
});
