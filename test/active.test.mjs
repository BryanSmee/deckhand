// Active/passive (lib/active.mjs): of two copies on one store, one holds the lease and acts; the
// other takes it at once when it is released, or once it expires, with a higher epoch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activePassive } from "../lib/active.mjs";
import { fileStore } from "../lib/store-file.mjs";

// The leases' and the store's time, moved on by the test alone (advance()): a loaded runner's
// late timers can't make a lease lapse, nor its loss come late (#563).
function virtualTime() {
  let now = 1_000_000;
  const timers = new Set();
  const settle = async () => {
    // What a fired timer starts (a store call, onPassive()) goes as far as it can.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, unref: () => {} };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    // `ms` on, firing the timers due on the way in their order, each at its own time.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        const due = [...timers].filter((timer) => timer.at <= end);
        if (!due.length) break;
        const next = due.reduce((a, b) => (b.at < a.at ? b : a));
        timers.delete(next);
        now = Math.max(now, next.at);
        next.fn();
      }
      now = end;
      await settle();
    },
    // Moved on `step` ms at a time until `check()`, `ms` at most: how long it took.
    async until(check, ms, step = 1) {
      const start = now;
      while (!check() && now - start < ms) await this.advance(step);
      return now - start;
    },
  };
}

function copy(t, store, holder, ttlMs, time) {
  const said = [];
  const lease = activePassive({
    store,
    name: "runner",
    holder,
    ttlMs,
    pollMs: 5,
    onActive: (got) => said.push(`active ${got.epoch}`),
    onPassive: () => said.push("passive"),
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    now: time.now,
  });
  // A look still in flight is waited for, a lifetime at most: that time passes too.
  t.after(async () => {
    const stopped = lease.stop();
    await time.advance(ttlMs);
    await stopped;
  });
  return { lease, said };
}

test("one copy acts; the other takes over at once on release, with a higher epoch", async (t) => {
  const time = virtualTime();
  const store = fileStore({ now: time.now });
  const a = copy(t, store, "a", 5000, time);
  const b = copy(t, store, "b", 5000, time);
  await a.lease.start();
  await b.lease.start();
  assert.deepEqual([a.lease.active(), b.lease.active()], [true, false]);
  const first = a.lease.epoch();
  assert.ok(first > 0);
  assert.equal(await a.lease.stop(), true);
  // At its next look, not once the lease would have expired.
  assert.ok((await time.until(() => b.lease.active(), 5000)) <= 5);
  assert.ok(b.lease.epoch() > first);
  assert.deepEqual(a.said, [`active ${first}`, "passive"]);
  assert.deepEqual(b.said, [`active ${b.lease.epoch()}`]);
});

test("a holder that stops renewing loses the lease: the other takes over once it expires", async (t) => {
  const time = virtualTime();
  const store = fileStore({ now: time.now });
  let frozen = false;
  // Its renewals no longer reach the store (a pause, a cut network): no answer comes.
  const flaky = {
    ...store,
    renew: (...args) => (frozen ? new Promise(() => {}) : store.renew(...args)),
  };
  const a = copy(t, flaky, "a", 1000, time);
  const b = copy(t, store, "b", 1000, time);
  await a.lease.start();
  await b.lease.start();
  const first = a.lease.epoch();
  // Renewed a third into its life, so it lasts while its holder does: past its first renewal.
  await time.advance(500);
  assert.deepEqual([a.lease.active(), b.lease.active()], [true, false]);
  frozen = true;
  // Last renewed at 333 ms, so it ends at 1333 ms, 833 ms from now: taken at the next look.
  const took = await time.until(() => b.lease.active(), 5000);
  assert.ok(took >= 833 && took <= 838, `${took} ms`);
  assert.ok(b.lease.epoch() > first);
  // The first copy stopped acting at its lease's end, by its own clock.
  assert.equal(a.lease.active(), false);
  assert.deepEqual(a.said, [`active ${first}`, "passive"]);
  // Back, it waits: the lease is the other's.
  frozen = false;
  await time.advance(100);
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
  const time = virtualTime();
  const store = fileStore({ now: time.now });
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  // Its acquire answers only once stop() was called.
  const slow = { ...store, acquire: async (...args) => (await gate, store.acquire(...args)) };
  const a = copy(t, slow, "a", 5000, time);
  const b = copy(t, store, "b", 5000, time);
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

test("a lease not renewed by its end is lost then (onPassive), not at the next look (#506)", async (t) => {
  const time = virtualTime();
  const store = fileStore({ now: time.now });
  let frozen = false;
  const flaky = {
    ...store,
    renew: (...args) => (frozen ? new Promise(() => {}) : store.renew(...args)),
  };
  // A hung renewal (at 333 ms): its look gives up half a life later (833 ms) and looks again a
  // third of one after that (1167 ms), but the lease ends at 1000 ms, and is lost then.
  const a = copy(t, flaky, "a", 1000, time);
  await a.lease.start();
  frozen = true;
  await time.advance(999);
  assert.deepEqual(a.said, [`active ${a.lease.epoch()}`]);
  await time.advance(1);
  assert.equal(a.said.at(-1), "passive");
  assert.equal(a.lease.active(), false);
});
