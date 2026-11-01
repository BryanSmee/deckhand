// The store's interface (lib/store.mjs), as every backend must keep it: one suite, run against
// each one (store.test.mjs; Redis's, #509, too). `node --test` loads it as a file of its own
// too, where it finds no test.
import assert from "node:assert/strict";
import { test } from "node:test";

// `open(t, clock)` → a store whose clock is `clock.now()`.
export function storeContract(name, open) {
  const setup = async (t) => {
    const clock = { at: 1_000_000, now: () => clock.at };
    const store = await open(t, clock);
    t.after(() => store.close());
    return { store, clock };
  };

  test(`${name}: get, set and delete, any JSON value, copied`, async (t) => {
    const { store } = await setup(t);
    assert.equal(await store.get("a"), null);
    const value = { list: [1, "two"], nested: { ok: true } };
    await store.set("a", value);
    value.list.push(3);
    assert.deepEqual(await store.get("a"), { list: [1, "two"], nested: { ok: true } });
    const got = await store.get("a");
    got.nested.ok = false;
    assert.equal((await store.get("a")).nested.ok, true);
    assert.equal(await store.delete("a"), true);
    assert.equal(await store.delete("a"), false);
    assert.equal(await store.get("a"), null);
  });

  test(`${name}: a key with a TTL expires, one set again without lasts`, async (t) => {
    const { store, clock } = await setup(t);
    await store.set("session", "s1", { ttlMs: 1000 });
    await store.set("kept", 1, { ttlMs: 1000 });
    await store.set("kept", 2);
    clock.at += 999;
    assert.equal(await store.get("session"), "s1");
    clock.at += 1;
    assert.equal(await store.get("session"), null);
    assert.equal(await store.get("kept"), 2);
    // Expired, it is absent for setIfAbsent() too.
    assert.equal(await store.setIfAbsent("session", "s2"), true);
  });

  test(`${name}: setIfAbsent, once`, async (t) => {
    const { store } = await setup(t);
    const tries = await Promise.all([1, 2, 3].map((n) => store.setIfAbsent("once", n)));
    assert.deepEqual(tries, [true, false, false]);
    assert.equal(await store.get("once"), 1);
  });

  test(`${name}: compareAndSet sets only from the value expected`, async (t) => {
    const { store } = await setup(t);
    assert.equal(await store.compareAndSet("v", 1, 2), false, "none isn't 1");
    assert.equal(await store.compareAndSet("v", null, { n: 1 }), true, "none is null");
    assert.equal(await store.compareAndSet("v", { n: 2 }, { n: 3 }), false);
    assert.equal(await store.compareAndSet("v", { n: 1 }, { n: 3 }), true);
    assert.deepEqual(await store.get("v"), { n: 3 });
    // Two copies racing from the same value: one wins.
    const race = await Promise.all([
      store.compareAndSet("v", { n: 3 }, { n: 4 }),
      store.compareAndSet("v", { n: 3 }, { n: 5 }),
    ]);
    assert.deepEqual(race, [true, false]);
    assert.deepEqual(await store.get("v"), { n: 4 });
  });

  test(`${name}: increment, from 0, by any step, never lost`, async (t) => {
    const { store, clock } = await setup(t);
    const all = await Promise.all(Array.from({ length: 10 }, () => store.increment("n")));
    assert.deepEqual(
      all.sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.equal(await store.increment("n", 5), 15);
    assert.equal(await store.increment("n", -15), 0);
    // `ttlMs` when created: a counter per window.
    assert.equal(await store.increment("window", 1, { ttlMs: 100 }), 1);
    assert.equal(await store.increment("window", 1, { ttlMs: 100 }), 2);
    clock.at += 100;
    assert.equal(await store.increment("window", 1, { ttlMs: 100 }), 1);
    // A fraction, then compared as the number it is.
    assert.equal(await store.increment("f", 1), 1);
    assert.equal(await store.increment("f", 0.1), 1.1);
    assert.equal(await store.compareAndSet("f", 1.1, 2), true);
    await store.set("text", "a");
    await assert.rejects(store.increment("text"), /isn't a number/);
  });

  test(`${name}: a lease is one holder's, taken over on release with a higher epoch`, async (t) => {
    const { store } = await setup(t);
    const first = await store.acquire("orchestrator", "copy-a", { ttlMs: 10_000 });
    assert.equal(first.holder, "copy-a");
    assert.equal(await store.acquire("orchestrator", "copy-b", { ttlMs: 10_000 }), null);
    // The holder asking again gets its own lease, same epoch.
    const again = await store.acquire("orchestrator", "copy-a", { ttlMs: 10_000 });
    assert.equal(again.epoch, first.epoch);
    assert.deepEqual(await store.lease("orchestrator"), again);
    // Another's release changes nothing; the holder's hands it over at once.
    assert.equal(await store.release("orchestrator", "copy-b", first.epoch), false);
    assert.equal(await store.release("orchestrator", "copy-a", first.epoch), true);
    assert.equal(await store.lease("orchestrator"), null);
    const second = await store.acquire("orchestrator", "copy-b", { ttlMs: 10_000 });
    assert.ok(second.epoch > first.epoch, "a higher epoch");
    // The old holder's lease is lost: no renewal, no release.
    assert.equal(await store.renew("orchestrator", "copy-a", first.epoch, { ttlMs: 10_000 }), null);
    assert.equal(await store.release("orchestrator", "copy-a", first.epoch), false);
    assert.equal((await store.lease("orchestrator")).holder, "copy-b");
  });

  test(`${name}: a lease expires unless renewed, and is taken over with a higher epoch`, async (t) => {
    const { store, clock } = await setup(t);
    const first = await store.acquire("runner", "copy-a", { ttlMs: 1000 });
    clock.at += 900;
    const renewed = await store.renew("runner", "copy-a", first.epoch, { ttlMs: 1000 });
    assert.equal(renewed.epoch, first.epoch);
    assert.equal(renewed.expiresAt, clock.at + 1000);
    clock.at += 999;
    assert.equal(await store.acquire("runner", "copy-b", { ttlMs: 1000 }), null);
    clock.at += 1;
    // Expired: the holder can't renew it any more, another takes it.
    assert.equal(await store.renew("runner", "copy-a", first.epoch, { ttlMs: 1000 }), null);
    assert.equal(await store.lease("runner"), null);
    const second = await store.acquire("runner", "copy-b", { ttlMs: 1000 });
    assert.ok(second.epoch > first.epoch);
    // Even the old holder, taking it back after an expiry, gets a new epoch.
    clock.at += 1000;
    const third = await store.acquire("runner", "copy-a", { ttlMs: 1000 });
    assert.ok(third.epoch > second.epoch);
    // Two copies racing for a free lease: one gets it.
    const race = await Promise.all([
      store.acquire("fresh", "copy-a", { ttlMs: 1000 }),
      store.acquire("fresh", "copy-b", { ttlMs: 1000 }),
    ]);
    assert.equal(race.filter(Boolean).length, 1);
  });

  test(`${name}: a stream's event is read again until acknowledged`, async (t) => {
    const { store } = await setup(t);
    const ids = [];
    for (const n of [1, 2, 3]) ids.push(await store.append("runs", { n }));
    assert.ok(Number(ids[0]) < Number(ids[1]) && Number(ids[1]) < Number(ids[2]));
    const events = (list) => list.map((e) => e.event.n);

    // A copy reads them, handles none and stops: the next one reads them all again. One reader
    // at a time per consumer (the lease holder, lib/store.mjs), so nothing is handed to one
    // reader rather than another.
    assert.deepEqual(events(await store.read("runs", "orchestrator")), [1, 2, 3]);
    assert.deepEqual(events(await store.read("runs", "orchestrator")), [1, 2, 3]);
    // Acknowledged out of order: what is left comes back, oldest first.
    assert.equal(await store.ack("runs", "orchestrator", [ids[1]]), 1);
    assert.deepEqual(events(await store.read("runs", "orchestrator")), [1, 3]);
    assert.equal(await store.ack("runs", "orchestrator", [ids[0], ids[1]]), 1, "once each");
    assert.deepEqual(events(await store.read("runs", "orchestrator", { count: 5 })), [3]);
    // Each consumer has its own.
    assert.deepEqual(events(await store.read("runs", "edge", { count: 2 })), [1, 2]);
    await store.ack("runs", "orchestrator", [ids[2]]);
    assert.deepEqual(await store.read("runs", "orchestrator"), []);
    await store.append("runs", { n: 4 });
    assert.deepEqual(events(await store.read("runs", "orchestrator")), [4]);
    assert.deepEqual(await store.read("other", "orchestrator"), []);
  });

  test(`${name}: only events read are acknowledged`, async (t) => {
    const { store } = await setup(t);
    const ids = [];
    for (const n of [1, 2, 3]) ids.push(await store.append("runs", { n }));
    const events = (list) => list.map((e) => e.event.n);
    // Not read yet: nothing to acknowledge, it is read as any other.
    assert.equal(await store.ack("runs", "orchestrator", [ids[0]]), 0);
    assert.deepEqual(events(await store.read("runs", "orchestrator", { count: 2 })), [1, 2]);
    // The third wasn't read: it stays.
    assert.equal(await store.ack("runs", "orchestrator", ids), 2);
    assert.deepEqual(events(await store.read("runs", "orchestrator")), [3]);
    assert.equal(await store.ack("runs", "orchestrator", [ids[2], "999", "x"]), 1);
    assert.deepEqual(await store.read("runs", "orchestrator"), []);
  });

  test(`${name}: ack's drop: what its one consumer acknowledged goes from the stream`, async (t) => {
    const { store } = await setup(t);
    const ids = [];
    for (const n of [1, 2, 3]) ids.push(await store.append("deliveries", { n }));
    await store.read("deliveries", "orchestrator", { count: 2 });
    // The third wasn't read: neither acknowledged nor dropped.
    assert.equal(await store.ack("deliveries", "orchestrator", ids, { drop: true }), 2);
    assert.deepEqual(
      (await store.read("deliveries", "orchestrator")).map((e) => e.event.n),
      [3],
    );
    // Gone for any reader: a new consumer finds only what was left.
    assert.deepEqual(
      (await store.read("deliveries", "another")).map((e) => e.event.n),
      [3],
    );
    // One acknowledged already (an ack sent again, after a cut connection): dropped all the same.
    const [{ id }] = await store.read("deliveries", "orchestrator");
    assert.equal(await store.ack("deliveries", "orchestrator", [id]), 1);
    assert.equal(await store.ack("deliveries", "orchestrator", [id], { drop: true }), 0);
    assert.deepEqual(await store.read("deliveries", "another"), []);
  });

  test(`${name}: a stream keeps its last maxLength events`, async (t) => {
    const { store } = await setup(t);
    for (let n = 1; n <= 7; n++) await store.append("progress", { n }, { maxLength: 3 });
    const read = await store.read("progress", "edge");
    assert.deepEqual(
      read.map((e) => e.event.n),
      [5, 6, 7],
    );
  });

  test(`${name}: blobs: put, append, read from an offset, delete`, async (t) => {
    const { store } = await setup(t);
    assert.equal(await store.readBlob("runs/1/log"), null);
    await store.appendBlob("runs/1/log", "line 1\n");
    await store.appendBlob("runs/1/log", Buffer.from("line 2\n"));
    assert.equal((await store.readBlob("runs/1/log")).toString(), "line 1\nline 2\n");
    assert.equal((await store.readBlob("runs/1/log", { offset: 7 })).toString(), "line 2\n");
    assert.equal((await store.readBlob("runs/1/log", { offset: 99 })).length, 0);
    // A part of it, and its size, without reading it.
    assert.equal((await store.readBlob("runs/1/log", { offset: 5, length: 3 })).toString(), "1\nl");
    assert.equal(await store.blobSize("runs/1/log"), 14);
    assert.equal(await store.blobSize("runs/2/log"), null);
    await store.putBlob("runs/1/log", "whole");
    assert.equal((await store.readBlob("runs/1/log")).toString(), "whole");
    // A name can't climb out of the blobs.
    await store.putBlob("../escape", "x");
    assert.equal((await store.readBlob("../escape")).toString(), "x");
    assert.equal(await store.deleteBlob("runs/1/log"), true);
    assert.equal(await store.deleteBlob("runs/1/log"), false);
    assert.equal(await store.readBlob("runs/1/log"), null);
  });

  test(`${name}: a blob appended from its writer's offsets: again, or out of order, adds nothing twice`, async (t) => {
    const { store } = await setup(t);
    assert.deepEqual(await store.appendBlobAt("inbox", 0, "one\n"), { length: 4 });
    // The same bytes again (an answer lost), and more over them: only what is new.
    assert.deepEqual(await store.appendBlobAt("inbox", 0, "one\ntwo\n"), { length: 8 });
    assert.deepEqual(await store.appendBlobAt("inbox", 4, "two\n"), { length: 8 });
    // Past its end (a later write first): nothing, and where it is.
    assert.deepEqual(await store.appendBlobAt("inbox", 12, "four\n"), { length: 8, gap: true });
    assert.deepEqual(await store.appendBlobAt("inbox", 8, Buffer.from("three\n")), { length: 14 });
    assert.equal((await store.readBlob("inbox")).toString(), "one\ntwo\nthree\n");
    // Created empty.
    assert.deepEqual(await store.appendBlobAt("other", 0, ""), { length: 0 });
    assert.equal((await store.readBlob("other")).length, 0);
  });

  test(`${name}: a stream, a consumer or a blob needs a name`, async (t) => {
    const { store } = await setup(t);
    await assert.rejects(store.append("", { n: 1 }), /not a name/);
    await assert.rejects(store.read("runs", ""), /not a name/);
    await assert.rejects(store.ack("", "edge", ["1"]), /not a name/);
    await assert.rejects(store.putBlob("", "x"), /not a name/);
    await assert.rejects(store.readBlob(""), /not a name/);
  });

  test(`${name}: a lease needs a lifetime`, async (t) => {
    const { store } = await setup(t);
    for (const ttlMs of [undefined, 0, -1, NaN, "1000"]) {
      await assert.rejects(store.acquire("l", "a", { ttlMs }), TypeError);
    }
    await assert.rejects(store.acquire("l", "a"), TypeError);
    const lease = await store.acquire("l", "a", { ttlMs: 1000 });
    await assert.rejects(store.renew("l", "a", lease.epoch, {}), TypeError);
    // Still a's.
    assert.equal(await store.acquire("l", "b", { ttlMs: 1000 }), null);
  });
}
