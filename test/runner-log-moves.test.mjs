// Closed log segments moving to blob storage (../runner/logs.mjs, #608): a log ends with only its
// index in the store, a live run's segments move while it goes on, a move cut short after any
// step finishes on the next start with no read failing meanwhile, blob storage away keeps them in
// the store (and /health says so), and retention deletes them there too. Segments closed with no
// note (BLOB_URL unset then, #671) are found in the logs' indexes once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openBlobs } from "../lib/blobs.mjs";
import { fileStore } from "../lib/store-file.mjs";
import {
  createLogs,
  MAX_RETRY_MS,
  MOVES,
  PASS_MS,
  RETRY_MS,
  SWEPT,
  waitingWarning,
  WAITING_READ_MS,
} from "../runner/logs.mjs";
import { fakeS3, until } from "./helpers.mjs";

const ID = "dh-o-a-1-1";
const index = (store) => store.get(`logs/${ID}/index`);

// Blob storage on the fake S3 server, failing at once (no retries).
async function s3Blobs(t) {
  const s3 = await fakeS3(t);
  const url = `s3://${s3.bucket}/deckhand?endpoint=${encodeURIComponent(s3.endpoint)}&region=${s3.region}`;
  const { accessKeyId, secretAccessKey } = s3;
  const blobs = openBlobs(url, {
    credentials: { accessKeyId, secretAccessKey },
    s3: { retries: 0, timeoutMs: 5000 },
  });
  t.after(() => blobs.close());
  return { s3, blobs };
}

// Timers run by hand: each one set, with its delay.
function manualTimers() {
  const set = [];
  return {
    set,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      set.push(timer);
      return timer;
    },
    clearTimeout: (timer) => timer && (timer.cleared = true),
    // The last one set and not cleared, run.
    async fire() {
      const timer = set.findLast((x) => !x.cleared);
      timer.cleared = true;
      await timer.fn();
    },
  };
}

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
  return Buffer.concat(parts).toString();
}

// A log of a few segments, closed at its end: → its text.
async function writeLog(logs, parts = ["one\n", "two\n", "three\n", "four\n"]) {
  let at = 0;
  for (const part of parts) at = await logs.append(ID, at, Buffer.from(part), { step: true });
  await logs.append(ID, at, Buffer.alloc(0), { close: true });
  return parts.join("");
}

async function storeSegments(store) {
  const { segments } = await index(store);
  const sizes = await Promise.all(segments.map((_, n) => store.blobSize(`logs/${ID}/${n}`)));
  return sizes.filter((size) => size !== null).length;
}

test("a run's log ends with only its index in the store, and reads back byte for byte from blob storage", async (t) => {
  const { s3, blobs } = await s3Blobs(t);
  const store = fileStore();
  const logs = createLogs({ store, blobs, segmentMax: 8 });
  const whole = await writeLog(logs);
  await logs.moves.pass();

  const { segments } = await index(store);
  assert.equal(segments.length, 4);
  assert.ok(segments.every((s) => s.where === "blobs"));
  assert.equal(await storeSegments(store), 0);
  assert.equal(await store.blobSize(`logs/${ID}/4`), null);
  assert.deepEqual(
    [...s3.objects.keys()].sort(),
    [0, 1, 2, 3].map((n) => `deckhand/logs/${ID}/${n}`),
  );
  assert.deepEqual(await store.read(MOVES, "runner"), []);
  for (let offset = 0; offset <= whole.length; offset++) {
    assert.equal(await readAll(logs, offset), whole.slice(offset), `from ${offset}`);
  }
  // A ranged GET of the one segment holding the offset, never the whole object.
  const { data } = await logs.read(ID, { offset: 5, length: 2 });
  assert.equal(data.toString(), "wo");
  assert.equal(s3.requests.at(-1).headers.range, "bytes=1-2");
});

test("a live run's closed segments move while it goes on, and a reader following it sees no gap", async (t) => {
  const { blobs } = await s3Blobs(t);
  const store = fileStore();
  const logs = createLogs({ store, blobs, segmentMax: 16 });
  t.after(() => logs.moves.stop());
  logs.moves.start();

  // The dashboard's live view: from each answer's end, waiting for more.
  let followed = "";
  let done = false;
  const follower = (async () => {
    while (!done || followed.length < (await logs.size(ID))) {
      const { data } = await logs.read(ID, { offset: followed.length, wait: 50 });
      followed += data.toString();
    }
  })();

  let at = 0;
  let whole = "";
  for (let i = 0; i < 40; i++) {
    const line = `line ${i}\n`;
    at = await logs.append(ID, at, Buffer.from(line), { step: i % 7 === 0 });
    whole += line;
    if (i === 20) {
      // Segments moved while it still writes.
      await until(async () => (await index(store)).segments.some((s) => s.where === "blobs"));
    }
  }
  await logs.append(ID, at, Buffer.alloc(0), { close: true });
  done = true;
  await follower;
  assert.equal(followed, whole);
  await until(async () => (await index(store)).segments.every((s) => s.where === "blobs"));
  await until(async () => (await storeSegments(store)) === 0);
  assert.equal(await readAll(logs), whole);
});

// Each of a move's steps, then a failure: the copy stops there (a crash), the next one's start
// finishes it. Copy: put and measured, the index not pointed yet; point: the index says blobs,
// the store still holds it; delete: gone from the store, its note not acknowledged.
for (const [step, failing] of [
  ["the copy", { compareAndSet: true }],
  ["the index's compare-and-set", { deleteBlob: true }],
  ["the store's delete", { ack: true }],
]) {
  test(`a move stopped after ${step} finishes on the next start, and no read fails meanwhile`, async (t) => {
    const { s3, blobs } = await s3Blobs(t);
    const shared = fileStore();
    const whole = await writeLog(createLogs({ store: shared, segmentMax: 8 }), ["abc", "def"]);
    // Noted as they closed, by a copy with blob storage.
    const writer = createLogs({ store: shared, blobs, segmentMax: 8 });
    await shared.append(MOVES, { id: ID, n: 0, size: 3 });
    await shared.append(MOVES, { id: ID, n: 1, size: 3 });
    assert.equal(await readAll(writer), whole);

    const crash = () => {
      throw new Error("stopped here");
    };
    const failingStore = {
      ...shared,
      compareAndSet: async (key, ...rest) =>
        failing.compareAndSet && key.endsWith("/index")
          ? crash()
          : shared.compareAndSet(key, ...rest),
      deleteBlob: async (key) =>
        failing.deleteBlob && /\/\d+$/.test(key) ? crash() : shared.deleteBlob(key),
      ack: async (...args) => (failing.ack ? crash() : shared.ack(...args)),
    };
    const logged = [];
    const first = createLogs({ store: failingStore, blobs, log: (line) => logged.push(line) });
    await first.moves.pass();
    assert.match(logged.join("\n"), /stopped here/);
    assert.ok(s3.objects.has(`deckhand/logs/${ID}/0`));
    // Wherever it stopped, the log reads whole, from either copy, from any offset.
    for (const logs of [first, writer]) {
      for (let offset = 0; offset <= whole.length; offset++) {
        assert.equal(await readAll(logs, offset), whole.slice(offset));
      }
    }

    const next = createLogs({ store: shared, blobs });
    await next.moves.pass();
    const { segments } = await index(shared);
    assert.ok(segments.every((s) => s.where === "blobs"));
    assert.equal(await storeSegments(shared), 0);
    assert.deepEqual(await shared.read(MOVES, "runner"), []);
    assert.equal(await readAll(next), whole);
  });
}

test("with the S3 server failing, segments stay in the store, /health says so, and move once it answers", async (t) => {
  const { s3, blobs } = await s3Blobs(t);
  const store = fileStore();
  const timers = manualTimers();
  const logged = [];
  const logs = createLogs({ store, blobs, segmentMax: 8, timers, log: (l) => logged.push(l) });
  logs.moves.start();
  assert.equal(timers.set.at(-1).ms, 0);
  s3.fail(...Array.from({ length: 3 }, () => ({ status: 503, code: "SlowDown" })));
  const whole = await writeLog(logs, ["0123456", "789"]);

  // Each failing pass: the segments wait, counted; the next try later each time.
  await timers.fire();
  assert.deepEqual(await logs.moves.waiting(), { segments: 2, bytes: 10 });
  assert.equal(
    waitingWarning(await logs.moves.waiting()),
    "2 closed log segments (0.0 MB) wait in the store: they can't be moved to blob storage now, tried again with a growing delay (the runner's log says why)",
  );
  assert.match(logged.at(-1), /503 SlowDown.*2 wait in the store, tried again in 30 s/);
  assert.equal(timers.set.at(-1).ms, RETRY_MS);
  assert.equal(await storeSegments(store), 2);
  assert.equal(await readAll(logs), whole);
  // A segment closing meanwhile doesn't cut the delay short.
  const before = timers.set.length;
  await logs.append(ID, whole.length, Buffer.from("x"), { close: true });
  assert.equal(timers.set.length, before);
  await timers.fire();
  assert.equal(timers.set.at(-1).ms, RETRY_MS * 2);
  await timers.fire();
  assert.equal(timers.set.at(-1).ms, RETRY_MS * 4);
  assert.deepEqual(await logs.moves.waiting(), { segments: 3, bytes: 11 });

  // It answers again: every one moves, and the passes go back to their pace.
  await timers.fire();
  assert.equal(await logs.moves.waiting(), null);
  assert.equal(waitingWarning(null), null);
  assert.equal(timers.set.at(-1).ms, PASS_MS);
  assert.equal(await storeSegments(store), 0);
  assert.equal(await readAll(logs), `${whole}x`);
  logs.moves.stop();
  assert.ok(MAX_RETRY_MS >= RETRY_MS);
});

test("the retry's delay grows to MAX_RETRY_MS, no further", async (t) => {
  const store = fileStore();
  const timers = manualTimers();
  const down = { put: async () => Promise.reject(new Error("down")) };
  const logs = createLogs({ store, blobs: down, segmentMax: 8, timers });
  await writeLog(logs, ["abc", "def"]);
  logs.moves.start();
  for (let i = 0; i < 12; i++) await timers.fire();
  assert.equal(timers.set.at(-1).ms, MAX_RETRY_MS);
  logs.moves.stop();
  assert.ok(timers.set.every((x) => x.cleared));
});

test("retention deletes the segments in blob storage, then the index; one that fails is tried again", async (t) => {
  const { s3, blobs } = await s3Blobs(t);
  const store = fileStore();
  const logs = createLogs({ store, blobs, segmentMax: 8 });
  await writeLog(logs);
  await logs.moves.pass();
  assert.equal(s3.objects.size, 4);

  // Blob storage away: nothing goes, the log stays whole for the next day's pass.
  s3.fail({ status: 503, code: "SlowDown" });
  await assert.rejects(logs.remove(ID), /503/);
  assert.ok(await index(store));
  assert.equal(s3.objects.size, 4);

  assert.equal(await logs.remove(ID), true);
  assert.equal(s3.objects.size, 0);
  assert.equal(await index(store), null);
  assert.deepEqual(await logs.read(ID), { size: 0, data: Buffer.alloc(0) });
});

test("without blob storage, nothing moves nor is noted", async () => {
  const store = fileStore();
  const logs = createLogs({ store, segmentMax: 8 });
  const whole = await writeLog(logs);
  logs.moves.start();
  await logs.moves.pass();
  logs.moves.stop();
  assert.deepEqual(await store.read(MOVES, "runner"), []);
  assert.ok((await index(store)).segments.every((s) => s.where === "store"));
  assert.equal(await readAll(logs), whole);
  assert.equal(await logs.moves.waiting(), null);
});

test("a segment in blob storage with BLOB_URL unset since: reads and retention say so", async (t) => {
  const { blobs } = await s3Blobs(t);
  const store = fileStore();
  const before = createLogs({ store, blobs, segmentMax: 8 });
  await writeLog(before, ["abc", "def"]);
  await before.moves.pass();
  const after = createLogs({ store });
  await assert.rejects(after.read(ID), /in blob storage, and BLOB_URL is unset/);
  await assert.rejects(after.remove(ID), /BLOB_URL is unset/);
  assert.ok(await index(store));
});

// `store` whose first call of `method` on a key matching `pattern` runs `between` before its own.
function between(store, method, pattern, run) {
  let armed = true;
  return {
    ...store,
    [method]: async (key, ...rest) => {
      if (armed && pattern.test(key)) {
        armed = false;
        await run();
      }
      return store[method](key, ...rest);
    },
  };
}

// A log of two closed segments, in `store`, noted to move: → its text.
async function noted(store, blobs) {
  return writeLog(createLogs({ store, blobs, segmentMax: 8 }), ["abc", "def"]);
}

test("a read that finds the store's blob moved meanwhile reads the index again, and blob storage", async (t) => {
  const { blobs } = await s3Blobs(t);
  const shared = fileStore();
  const whole = await noted(shared, blobs);
  const mover = createLogs({ store: shared, blobs });
  // The read took the index (segment 0 in the store), then the move ran whole before its read.
  const store = between(shared, "readBlob", /\/0$/, () => mover.moves.pass());
  const logs = createLogs({ store, blobs });
  assert.deepEqual(await logs.read(ID), { size: whole.length, data: Buffer.from("abc") });
  assert.equal(await shared.blobSize(`logs/${ID}/0`), null);
  assert.equal((await index(shared)).segments[0].where, "blobs");
});

test("a move that finds another copy pointed the index meanwhile only deletes the store's blob", async (t) => {
  const { s3, blobs } = await s3Blobs(t);
  const shared = fileStore();
  const whole = await noted(shared, blobs);
  const other = createLogs({ store: shared, blobs });
  // Once its copy is measured, before its compare-and-set: the other copy moves them all.
  let stalled = false;
  const stalling = {
    ...blobs,
    size: async (key) => {
      if (!stalled) {
        stalled = true;
        await other.moves.pass();
      }
      return blobs.size(key);
    },
  };
  const cas = [];
  const counting = {
    ...shared,
    compareAndSet: async (...a) => (cas.push(a[0]), shared.compareAndSet(...a)),
  };
  const logs = createLogs({ store: counting, blobs: stalling });
  await logs.moves.pass();
  assert.deepEqual(cas, []);
  assert.equal(await storeSegments(shared), 0);
  assert.equal(s3.objects.size, 2);
  assert.equal(await readAll(logs), whole);

  // And one that finds it so before its copy (the other copy's delete cut short): the delete alone.
  const again = fileStore();
  await noted(again, blobs);
  await createLogs({ store: { ...again, deleteBlob: async () => false }, blobs }).moves.pass();
  await again.append(MOVES, { id: ID, n: 0, size: 3 });
  await again.append(MOVES, { id: ID, n: 1, size: 3 });
  const puts = s3.requests.filter((r) => r.method === "PUT").length;
  await createLogs({ store: again, blobs }).moves.pass();
  assert.equal(s3.requests.filter((r) => r.method === "PUT").length, puts);
  assert.equal(await storeSegments(again), 0);
});

test("a move whose log is removed between its copy and its compare-and-set deletes its copy", async (t) => {
  const { s3, blobs } = await s3Blobs(t);
  const shared = fileStore();
  await noted(shared, blobs);
  // Retention on another copy, without blob storage to delete: only this move's copy is there.
  const retention = createLogs({ store: shared });
  let removed = false;
  const stalling = {
    ...blobs,
    size: async (key) => {
      if (!removed) {
        removed = true;
        assert.equal(await retention.remove(ID), true);
      }
      return blobs.size(key);
    },
  };
  await createLogs({ store: shared, blobs: stalling }).moves.pass();
  assert.equal(await index(shared), null);
  assert.equal(s3.objects.size, 0);
  assert.deepEqual(await shared.read(MOVES, "runner"), []);
});

test("a segment that isn't in the store as its index says is logged and left, and the others move", async (t) => {
  const { s3, blobs } = await s3Blobs(t);
  const store = fileStore();
  await noted(store, blobs);
  await store.putBlob(`logs/${ID}/0`, "ab");
  const logged = [];
  await createLogs({ store, blobs, log: (l) => logged.push(l) }).moves.pass();
  assert.match(
    logged.join("\n"),
    /logs\/dh-o-a-1-1\/0 isn't in the store as its index says \(2 of 3 bytes\): left there/,
  );
  assert.deepEqual(
    (await index(store)).segments.map((s) => s.where),
    ["store", "blobs"],
  );
  assert.deepEqual([...s3.objects.keys()], [`deckhand/logs/${ID}/1`]);
  assert.deepEqual(await store.read(MOVES, "runner"), []);
});

// A size blob storage gives back that differs from what was sent (its redaction of the whole
// segment finding a secret that two appends split): trying again changes nothing, so the
// segment stays in the store, its copy goes, and the notes after it don't wait for it.
test("a segment whose copy measures otherwise is left in the store, and doesn't block the others", async (t) => {
  const { s3, blobs } = await s3Blobs(t);
  const store = fileStore();
  const whole = await noted(store, blobs);
  const redacting = {
    ...blobs,
    size: async (key) => (key.endsWith("/0") ? 2 : blobs.size(key)),
  };
  const logged = [];
  const logs = createLogs({ store, blobs: redacting, log: (l) => logged.push(l) });
  await logs.moves.pass();
  assert.match(logged.join("\n"), /\/0 is 2 bytes in blob storage, 3 sent: left in the store/);
  assert.deepEqual(
    (await index(store)).segments.map((s) => s.where),
    ["store", "blobs"],
  );
  assert.deepEqual([...s3.objects.keys()], [`deckhand/logs/${ID}/1`]);
  assert.deepEqual(await store.read(MOVES, "runner"), []);
  assert.equal(await logs.moves.waiting(), null);
  assert.equal(await readAll(logs), whole);
});

// Two copies: the one acting fails and its lease goes; either one's /health says what waits
// until the next one moves them, then neither does. Each answers from memory at once, the one
// not acting reading the store again once what it knows is WAITING_READ_MS old.
test("through a handover, both copies say what waits, and neither once it moved", async (t) => {
  const { s3, blobs } = await s3Blobs(t);
  const store = fileStore();
  await noted(store, blobs);
  let clock = 0;
  const now = () => clock;
  const a = createLogs({ store, blobs, now, timers: manualTimers(), log: () => {} });
  const b = createLogs({ store, blobs, now, timers: manualTimers(), log: () => {} });
  // b reads the store at its first answer (nothing waits yet), then not before WAITING_READ_MS.
  assert.equal(b.moves.waiting(), null);
  await b.moves.refresh();
  s3.fail({ status: 503, code: "SlowDown" });
  a.moves.start();
  await a.moves.pass();
  assert.deepEqual(a.moves.waiting(), { segments: 2, bytes: 6 });
  clock += WAITING_READ_MS - 1;
  assert.equal(b.moves.waiting(), null);
  clock += 1;
  b.moves.waiting(); // reads the store again, in the background
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(b.moves.waiting(), { segments: 2, bytes: 6 });

  a.moves.stop();
  b.moves.start();
  await b.moves.pass();
  b.moves.stop();
  assert.equal(b.moves.waiting(), null);
  clock += WAITING_READ_MS;
  a.moves.waiting();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(a.moves.waiting(), null);
  assert.equal(await storeSegments(store), 0);
});

// A pass in flight as the lease goes, which then fails: what waits is the next holder's to say,
// never written back over what it found.
test("a pass that fails after its lease went says nothing of what waits", async (t) => {
  const { blobs } = await s3Blobs(t);
  const store = fileStore();
  await noted(store, blobs);
  let logs;
  const losing = {
    ...blobs,
    put: async () => {
      logs.moves.stop();
      throw new Error("cut");
    },
  };
  logs = createLogs({ store, blobs: losing, timers: manualTimers(), log: () => {} });
  logs.moves.start();
  await logs.moves.pass();
  assert.equal(await store.get("log-moves/waiting"), null);
  assert.equal(logs.moves.waiting(), null);
});

test("a pass of the lease's stops with it; one started by hand goes on", async (t) => {
  const { blobs } = await s3Blobs(t);
  const store = fileStore();
  await noted(store, blobs);
  await store.set(SWEPT, 1); // the indexes swept already: only the writer's notes
  let logs;
  const losing = {
    ...blobs,
    put: async (...args) => {
      logs.moves.stop(); // the lease lost during the first copy
      return blobs.put(...args);
    },
  };
  logs = createLogs({ store, blobs: losing, timers: manualTimers() });
  logs.moves.start();
  await logs.moves.pass();
  // The move in flight finished; the next note waits for the next holder.
  assert.deepEqual(
    (await index(store)).segments.map((s) => s.where),
    ["blobs", "store"],
  );
  assert.equal((await store.read(MOVES, "runner")).length, 1);
  await logs.moves.pass();
  assert.equal(await storeSegments(store), 0);
});

test("a segment noted twice (two copies finished its closing) is counted once", async (t) => {
  const store = fileStore();
  const down = { put: async () => Promise.reject(new Error("down")) };
  const logs = createLogs({ store, blobs: down, segmentMax: 8, log: () => {} });
  await writeLog(logs, ["abc", "def"]);
  await store.append(MOVES, { id: ID, n: 0, size: 3 });
  await logs.moves.pass();
  assert.deepEqual(await logs.moves.waiting(), { segments: 2, bytes: 6 });
});

// Closed with no note: BLOB_URL unset then, or a release before the notes handing over (#671).
async function unnoted(store, id = ID, parts = ["abc", "def"]) {
  const logs = createLogs({ store, segmentMax: 8 });
  let at = 0;
  for (const part of parts) at = await logs.append(id, at, Buffer.from(part), { step: true });
  await logs.append(id, at, Buffer.alloc(0), { close: true });
  return parts.join("");
}

test("segments closed with no note move once the lease holder swept the indexes, once", async (t) => {
  const { blobs } = await s3Blobs(t);
  const store = fileStore();
  const whole = await unnoted(store);
  await unnoted(store, "dh-o-a-2-1", ["ghi"]);
  // A log of the old shape has no index: it stays as it is.
  await store.appendBlobAt("logs/dh-o-a-3-1", 0, Buffer.from("old"));
  assert.deepEqual(await store.read(MOVES, "runner"), []);

  const lines = [];
  const timers = manualTimers();
  const logs = createLogs({ store, blobs, timers, log: (line) => lines.push(line) });
  t.after(() => logs.moves.stop());
  logs.moves.start();
  await timers.fire();
  assert.equal(await storeSegments(store), 0);
  assert.ok((await index(store)).segments.every((s) => s.where === "blobs"));
  assert.ok((await store.get("logs/dh-o-a-2-1/index")).segments.every((s) => s.where === "blobs"));
  assert.equal(await store.blobSize("logs/dh-o-a-3-1"), 3);
  assert.equal(await readAll(logs), whole);
  assert.deepEqual(await store.read(MOVES, "runner"), []);
  assert.equal(typeof (await store.get(SWEPT)), "number");
  assert.ok(lines.some((line) => /3 closed before their moves were noted/.test(line)));

  // Swept: what closes with no note after it stays, until the indexes are swept again.
  await unnoted(store, "dh-o-a-4-1", ["jkl"]);
  logs.moves.stop();
  logs.moves.start();
  await timers.fire();
  assert.equal((await store.get("logs/dh-o-a-4-1/index")).segments[0].where, "store");
});

test("a copy acting without blob storage has the indexes swept again once it is set", async (t) => {
  const { blobs } = await s3Blobs(t);
  const store = fileStore();
  await store.set(SWEPT, 1);
  const without = createLogs({ store, segmentMax: 8 });
  without.moves.start();
  await until(async () => (await store.get(SWEPT)) === null);
  await unnoted(store);

  const logs = createLogs({ store, blobs });
  await logs.moves.pass();
  assert.equal(await storeSegments(store), 0);
});

test("a sweep cut short as the lease goes is done again by the next holder", async (t) => {
  const { blobs } = await s3Blobs(t);
  const shared = fileStore();
  await unnoted(shared);
  await unnoted(shared, "dh-o-a-2-1", ["ghi"]);
  let logs;
  const store = {
    ...shared,
    get: async (key) => {
      if (/^logs\/.*\/index$/.test(key) && !(await shared.get(SWEPT))) logs.moves.stop();
      return shared.get(key);
    },
  };
  logs = createLogs({ store, blobs, timers: manualTimers() });
  logs.moves.start();
  await logs.moves.pass();
  assert.equal(await shared.get(SWEPT), null);
  assert.deepEqual(await shared.read(MOVES, "runner"), []);
  assert.equal(await storeSegments(shared), 2);

  const next = createLogs({ store: shared, blobs, timers: manualTimers() });
  next.moves.start();
  await next.moves.pass();
  next.moves.stop();
  assert.equal(await storeSegments(shared), 0);
  assert.equal((await shared.get("logs/dh-o-a-2-1/index")).segments[0].where, "blobs");
});
