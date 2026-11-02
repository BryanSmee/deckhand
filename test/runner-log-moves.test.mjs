// Closed log segments moving to blob storage (../runner/logs.mjs, #608): a log ends with only its
// index in the store, a live run's segments move while it goes on, a move cut short after any
// step finishes on the next start with no read failing meanwhile, blob storage away keeps them in
// the store (and /health says so), and retention deletes them there too.
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
  waitingWarning,
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
  assert.deepEqual(logs.moves.waiting(), { segments: 2, bytes: 10 });
  assert.equal(
    waitingWarning(logs.moves.waiting()),
    "2 closed log segments (0.0 MB) wait in the store: blob storage fails, tried again with a growing delay (the runner's log says why)",
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
  assert.deepEqual(logs.moves.waiting(), { segments: 3, bytes: 11 });

  // It answers again: every one moves, and the passes go back to their pace.
  await timers.fire();
  assert.equal(logs.moves.waiting(), null);
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
  assert.equal(logs.moves.waiting(), null);
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
