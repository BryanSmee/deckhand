import assert from "node:assert/strict";
import { test } from "node:test";
import { createSync } from "../listener/sync.mjs";

// Each part answers its count, or throws `fail[part]`.
function syncWith(fail, clock = () => 1000) {
  const logged = [];
  const part = (name, count) => async () => {
    if (fail[name]) throw new Error(fail[name]);
    return count;
  };
  const sync = createSync({
    scan: part("scan", 2),
    resync: part("resync", 1),
    log: (line) => logged.push(line),
    now: clock,
  });
  return { sync, logged };
}

test("the last sync is kept: when, who, what it found", async () => {
  let clock = 1000;
  const { sync, logged } = syncWith({}, () => clock);
  assert.equal(sync.last(), null);
  const atStart = await sync.sync(null);
  assert.deepEqual(atStart, { at: 1000, by: null, redelivered: 2, pulls: 1 });
  assert.equal(sync.last(), atStart);
  clock = 2000;
  const asked = await sync.sync("alice");
  assert.deepEqual(asked, { at: 2000, by: "alice", redelivered: 2, pulls: 1 });
  assert.equal(sync.last(), asked);
  assert.deepEqual(logged, []);
});

test("one part failing: its error, and the other part's count kept", async () => {
  const scanFailed = syncWith({ scan: "GitHub GET /app/hook/deliveries: 502" });
  assert.deepEqual(await scanFailed.sync.sync("alice"), {
    at: 1000,
    by: "alice",
    redelivered: 0,
    pulls: 1,
    error: "GitHub GET /app/hook/deliveries: 502",
  });
  assert.deepEqual(scanFailed.logged, ["Sync: GitHub GET /app/hook/deliveries: 502"]);

  const resyncFailed = syncWith({ resync: "no token" });
  assert.deepEqual(await resyncFailed.sync.sync("alice"), {
    at: 1000,
    by: "alice",
    redelivered: 2,
    pulls: 0,
    error: "no token",
  });

  const both = syncWith({ scan: "502", resync: "no token" });
  assert.equal((await both.sync.sync("alice")).error, "502; no token");
});

test("at start, the scan's error isn't logged twice: redeliveries.start() logged it", async () => {
  const { sync, logged } = syncWith({ scan: "502", resync: "no token" });
  assert.equal((await sync.sync(null)).error, "502; no token");
  assert.deepEqual(logged, ["Sync: no token"]);
});

test("no App yet: no delivery asked again counts as none", async () => {
  const sync = createSync({ scan: async () => null, resync: async () => 0, now: () => 5 });
  assert.deepEqual(await sync.sync(null), { at: 5, by: null, redelivered: 0, pulls: 0 });
});
