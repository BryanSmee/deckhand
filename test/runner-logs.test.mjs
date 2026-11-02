// A run's log in segments (../runner/logs.mjs, #607): what reads back, what closes a segment,
// appends sent again or through two copies, the logs of before segments, and their removal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileStore } from "../lib/store-file.mjs";
import { createLogs, LogConflict, MAX_READ } from "../runner/logs.mjs";

const ID = "dh-o-a-1-1";
const index = (store) => store.get(`logs/${ID}/index`);

// The whole log, read as the dashboard does: from each answer's end on.
async function readAll(logs, from = 0) {
  const parts = [];
  for (let offset = from; ;) {
    const { size, data } = await logs.read(ID, { offset });
    if (!data.length) break;
    parts.push(data);
    offset += data.length;
    if (offset >= size) break;
  }
  return Buffer.concat(parts);
}

test("a log written across several segments reads back byte for byte, from any offset", async () => {
  const store = fileStore();
  const logs = createLogs({ store, segmentMax: 10 });
  const parts = ["0123456", "789ab", "cdefghijklmn", "o", "pq", "rstuvwxyz"];
  let at = 0;
  for (const [i, part] of parts.entries()) {
    at = await logs.append(ID, at, Buffer.from(part), { step: i === 3 });
  }
  const whole = parts.join("");
  assert.equal(at, whole.length);
  assert.ok((await index(store)).segments.length >= 3);
  for (let offset = 0; offset <= whole.length; offset++) {
    assert.equal((await readAll(logs, offset)).toString(), whole.slice(offset), `from ${offset}`);
  }
  // Each read from one segment alone, never across two.
  const { segments } = await index(store);
  const { data } = await logs.read(ID, { offset: segments[1].at - 2 });
  assert.equal(data.length, 2);
  assert.equal((await logs.read(ID, { offset: 0 })).size, whole.length);
  assert.equal(await logs.size(ID), whole.length);
});

test("a segment closes at a step and at LOG_SEGMENT_MB, whichever comes first", async () => {
  const store = fileStore();
  const logs = createLogs({ store, segmentMax: 8 });
  let at = await logs.append(ID, 0, Buffer.from("abc"));
  // A step: its line starts the next segment.
  at = await logs.append(ID, at, Buffer.from("de"), { step: true });
  assert.deepEqual(await index(store), { segments: [{ at: 0, size: 3, where: "store" }], open: 3 });
  // The cap: an append that would pass it goes to the next one.
  at = await logs.append(ID, at, Buffer.from("fghij"));
  at = await logs.append(ID, at, Buffer.from("kl"));
  assert.deepEqual((await index(store)).segments.at(-1), { at: 3, size: 7, where: "store" });
  assert.equal((await index(store)).open, 10);
  // A step closes it below the cap; an append over the cap alone stays whole.
  at = await logs.append(ID, at, Buffer.from("0123456789"), { step: true });
  assert.equal((await index(store)).open, 12);
  assert.equal(await store.blobSize(`logs/${ID}/3`), 10);
  // The run's end closes the last one; a step on an empty segment closes nothing.
  at = await logs.append(ID, at, Buffer.alloc(0), { close: true });
  at = await logs.append(ID, at, Buffer.from("z"), { step: true });
  assert.deepEqual(await index(store), {
    segments: [
      { at: 0, size: 3, where: "store" },
      { at: 3, size: 7, where: "store" },
      { at: 10, size: 2, where: "store" },
      { at: 12, size: 10, where: "store" },
    ],
    open: 22,
  });
  assert.equal((await readAll(logs)).toString(), "abcdefghijkl0123456789z");
});

test("an append sent again across a segment's closing is taken once; a wrong offset is a LogConflict", async () => {
  const store = fileStore();
  const logs = createLogs({ store, segmentMax: 4 });
  await logs.append(ID, 0, Buffer.from("abc"));
  await logs.append(ID, 3, Buffer.from("de")); // closes the first segment before it
  assert.equal((await index(store)).segments.length, 1);
  // Sent again (its answer lost), the step mark too: taken already, nothing closes.
  assert.equal(await logs.append(ID, 3, Buffer.from("de"), { step: true }), 5);
  assert.equal((await index(store)).segments.length, 1);
  assert.equal((await readAll(logs)).toString(), "abcde");
  // "x" at 0 doesn't end the log, nor at 2 or 6: refused, with its size.
  for (const at of [0, 2, 6]) {
    await assert.rejects(logs.append(ID, at, Buffer.from("x")), (error) => {
      assert.ok(error instanceof LogConflict);
      assert.equal(error.size, 5);
      return true;
    });
  }
});

// A stalled copy (its lease expired) that read the log before the other closed its segment
// and wrote on: its bytes land past the closed segment's end, in none, and it says so.
test("two copies through a handover never lose or repeat bytes", async () => {
  const shared = fileStore();
  let stall = null;
  const stalling = {
    ...shared,
    appendBlobAt: async (...args) => {
      if (stall) {
        const wait = stall;
        stall = null;
        await wait();
      }
      return shared.appendBlobAt(...args);
    },
  };
  const a = createLogs({ store: stalling, segmentMax: 1024 });
  const b = createLogs({ store: shared, segmentMax: 1024 });
  await a.append(ID, 0, Buffer.from("one\n"));
  // a reads the log (4 bytes, one open segment), then stalls before writing; meanwhile b
  // takes the same append, a step's: the segment a writes to closes before it.
  stall = async () => {
    assert.equal(await b.append(ID, 4, Buffer.from("two\n"), { step: true }), 8);
  };
  // Past the closed segment's end: refused with the log's size, which ends where this append
  // does (the writer takes it as taken).
  await assert.rejects(a.append(ID, 4, Buffer.from("two\n")), (error) => {
    assert.ok(error instanceof LogConflict);
    assert.equal(error.size, 8);
    return true;
  });
  assert.deepEqual(await shared.get(`logs/${ID}/index`), {
    segments: [{ at: 0, size: 4, where: "store" }],
    open: 4,
  });
  assert.equal((await readAll(a)).toString(), "one\ntwo\n");
  assert.equal(await b.append(ID, 8, Buffer.from("three\n")), 14);
  assert.equal((await readAll(a)).toString(), "one\ntwo\nthree\n");

  // The same append through both at once, across a closing: written once.
  const both = await Promise.all([
    a.append(ID, 14, Buffer.from("four\n"), { step: true }),
    b.append(ID, 14, Buffer.from("four\n"), { step: true }),
  ]);
  assert.deepEqual(both, [19, 19]);
  assert.equal((await readAll(b)).toString(), "one\ntwo\nthree\nfour\n");
  assert.equal((await shared.get(`logs/${ID}/index`)).segments.length, 2);
});

// The race the `closing` mark is for: a's write lands after b measured the segment, before b
// records that size. a finds the mark after its write, and records the size itself, its bytes
// in it; b's record, of an older measure, fails.
test("a write between the other copy's measure of a closing segment and its record is kept", async () => {
  const shared = fileStore();
  let reached;
  const writing = new Promise((resolve) => (reached = resolve));
  let go;
  const gate = new Promise((resolve) => (go = resolve));
  let hold = false;
  const a = createLogs({
    store: {
      ...shared,
      appendBlobAt: async (...args) => {
        if (hold) {
          hold = false;
          reached();
          await gate;
        }
        return shared.appendBlobAt(...args);
      },
    },
  });
  let pending = null;
  const b = createLogs({
    store: {
      ...shared,
      compareAndSet: async (key, expected, value) => {
        // b's record of the size it measured: a writes first.
        if (expected?.closing && pending) {
          go();
          assert.equal(await pending, 8);
        }
        return shared.compareAndSet(key, expected, value);
      },
    },
  });
  await a.append(ID, 0, Buffer.from("one\n"));
  hold = true;
  pending = a.append(ID, 4, Buffer.from("two\n"));
  await writing;
  // b closes the segment (its run's end): it marks it, measures 4 bytes, then a writes.
  assert.equal(await b.append(ID, 4, Buffer.alloc(0), { close: true }), 4);
  assert.deepEqual(await shared.get(`logs/${ID}/index`), {
    segments: [{ at: 0, size: 8, where: "store" }],
    open: 8,
  });
  assert.equal((await readAll(b)).toString(), "one\ntwo\n");
  assert.equal(await b.append(ID, 8, Buffer.from("three\n")), 14);
  assert.equal((await readAll(a)).toString(), "one\ntwo\nthree\n");
});

test("a log of the old shape still reads, and is appended to as before", async () => {
  const store = fileStore();
  const logs = createLogs({ store, segmentMax: 4 });
  await store.putBlob(`logs/${ID}`, "written before segments\n");
  assert.equal((await readAll(logs)).toString(), "written before segments\n");
  assert.equal((await logs.read(ID, { offset: 8 })).data.toString(), "before segments\n");
  // A run in flight through the update: its log stays one blob, whatever the marks.
  assert.equal(await logs.append(ID, 24, Buffer.from("more\n"), { step: true, close: true }), 29);
  assert.equal(await index(store), null);
  assert.equal((await store.readBlob(`logs/${ID}`)).toString(), "written before segments\nmore\n");
  await assert.rejects(logs.append(ID, 3, Buffer.from("x")), (error) => error.size === 29);
  assert.equal(await logs.remove(ID), true);
  assert.deepEqual(await logs.read(ID), { size: 0, data: Buffer.alloc(0) });
});

test("remove(): every segment and the index; a log never written reads as empty", async () => {
  const store = fileStore();
  const logs = createLogs({ store, segmentMax: 2 });
  assert.deepEqual(await logs.read(ID), { size: 0, data: Buffer.alloc(0) });
  assert.equal(await logs.remove(ID), false);
  let at = 0;
  for (const part of ["ab", "cd", "ef", "g"]) at = await logs.append(ID, at, Buffer.from(part));
  assert.equal((await index(store)).segments.length, 3);
  assert.equal(await logs.remove(ID), true);
  for (const n of [0, 1, 2, 3]) assert.equal(await store.blobSize(`logs/${ID}/${n}`), null);
  assert.equal(await index(store), null);
  assert.deepEqual(await logs.read(ID), { size: 0, data: Buffer.alloc(0) });
  // Written again from 0: a log of its own.
  assert.equal(await logs.append(ID, 0, Buffer.from("new")), 3);
  assert.equal((await readAll(logs)).toString(), "new");
});

test("a read answers MAX_READ at most, within its segment", async () => {
  const store = fileStore();
  const logs = createLogs({ store, segmentMax: MAX_READ * 2 });
  const big = Buffer.alloc(MAX_READ + 10, "x");
  await logs.append(ID, 0, big);
  assert.equal((await logs.read(ID)).data.length, MAX_READ);
  assert.equal((await logs.read(ID, { offset: MAX_READ })).data.length, 10);
});

// A stalled copy that read the log before its removal (retention) writes on: no segment is
// left that no index names.
test("an append landing after its log's removal leaves no segment behind", async () => {
  const shared = fileStore();
  let stall = null;
  const a = createLogs({
    store: {
      ...shared,
      appendBlobAt: async (...args) => {
        if (stall) await stall().finally(() => (stall = null));
        return shared.appendBlobAt(...args);
      },
    },
    segmentMax: 4,
  });
  const b = createLogs({ store: shared, segmentMax: 4 });
  await b.append(ID, 0, Buffer.from("abcd"));
  await b.append(ID, 4, Buffer.from("ef")); // the second segment, open
  stall = async () => assert.equal(await b.remove(ID), true);
  await assert.rejects(a.append(ID, 6, Buffer.from("gh")), (error) => error.size === 0);
  for (const n of [0, 1, 2]) assert.equal(await shared.blobSize(`logs/${ID}/${n}`), null);
  assert.equal(await shared.get(`logs/${ID}/index`), null);
});
