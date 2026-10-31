// Active/passive (lib/active.mjs): of two copies on one store, one holds the lease and acts; the
// other takes it at once when it is released, or once it expires, with a higher epoch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activePassive } from "../lib/active.mjs";
import { fileStore } from "../lib/store-file.mjs";

const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

function copy(t, store, holder, ttlMs = 150) {
  const said = [];
  const lease = activePassive({
    store,
    name: "runner",
    holder,
    ttlMs,
    pollMs: 5,
    onActive: (got) => said.push(`active ${got.epoch}`),
    onPassive: () => said.push("passive"),
  });
  t.after(() => lease.stop());
  return { lease, said };
}

test("one copy acts; the other takes over at once on release, with a higher epoch", async (t) => {
  const store = fileStore();
  // Leases far longer than the handover: it doesn't wait for one to expire.
  const a = copy(t, store, "a", 5000);
  const b = copy(t, store, "b", 5000);
  await a.lease.start();
  await b.lease.start();
  assert.deepEqual([a.lease.active(), b.lease.active()], [true, false]);
  const first = a.lease.epoch();
  assert.ok(first > 0);
  const released = Date.now();
  assert.equal(await a.lease.stop(), true);
  await until(() => b.lease.active(), "b's lease");
  assert.ok(Date.now() - released < 1000, `took ${Date.now() - released} ms`);
  assert.ok(b.lease.epoch() > first);
  assert.deepEqual(a.said, [`active ${first}`, "passive"]);
  assert.deepEqual(b.said, [`active ${b.lease.epoch()}`]);
});

test("a holder that stops renewing loses the lease: the other takes over once it expires", async (t) => {
  const store = fileStore();
  let frozen = false;
  // Its renewals no longer reach the store (a pause, a cut network): no answer comes.
  const flaky = {
    ...store,
    renew: (...args) => (frozen ? new Promise(() => {}) : store.renew(...args)),
  };
  const a = copy(t, flaky, "a");
  const b = copy(t, store, "b");
  await a.lease.start();
  await b.lease.start();
  const first = a.lease.epoch();
  // Renewed a third into its life, so it lasts while its holder does: twice its life on.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual([a.lease.active(), b.lease.active()], [true, false]);
  frozen = true;
  await until(() => b.lease.active(), "the expiry");
  assert.ok(b.lease.epoch() > first);
  // The first copy stops acting: its lease ended by its own clock (and onPassive() once its
  // look gives up).
  assert.equal(a.lease.active(), false);
  await until(() => a.said.includes("passive"), "a's loss");
  assert.deepEqual(a.said, [`active ${first}`, "passive"]);
  // Back, it waits: the lease is the other's.
  frozen = false;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual([a.lease.active(), b.lease.active()], [false, true]);
});

test("a holder whose store hangs stops acting by its own clock, before its next look fails", async (t) => {
  const store = fileStore();
  let hanging = false;
  const stalled = {
    ...store,
    renew: (...args) => (hanging ? new Promise(() => {}) : store.renew(...args)),
  };
  let clock = 1000;
  const lease = activePassive({
    store: stalled,
    name: "runner",
    holder: "a",
    ttlMs: 60_000,
    now: () => clock,
  });
  t.after(() => lease.stop());
  await lease.start();
  assert.equal(lease.active(), true);
  hanging = true;
  // Past its lifetime by its own clock: no longer acting, whatever its look in flight.
  clock += 60_000;
  assert.equal(lease.active(), false);
});

test("a stop while the lease is being taken gives it back: the other copy doesn't wait a lifetime", async (t) => {
  const store = fileStore();
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  // Its acquire answers only once stop() was called.
  const slow = { ...store, acquire: async (...args) => (await gate, store.acquire(...args)) };
  const a = copy(t, slow, "a", 5000);
  const b = copy(t, store, "b", 5000);
  const starting = a.lease.start();
  const stopping = a.lease.stop();
  open();
  await starting;
  await stopping;
  assert.equal(a.lease.active(), false);
  await b.lease.start();
  assert.equal(b.lease.active(), true);
  assert.deepEqual(a.said, []);
});
