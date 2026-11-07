// Blob storage against a real S3 server (#610): Garage in docs/guides/blob-storage.md, or any other
// the operator runs, rather than test/helpers.mjs's fakeS3. Skipped unless TEST_BLOB_URL (a
// BLOB_URL, s3://…), TEST_BLOB_ACCESS_KEY_ID and TEST_BLOB_SECRET_ACCESS_KEY name one: no CI job
// runs a server. Each run writes under a prefix of its own, and deletes what it wrote.
//
//   docker run -d --name garage -p 3900:3900 … (docs/guides/blob-storage.md, Garage)
//   TEST_BLOB_URL='s3://deckhand?endpoint=http://localhost:3900&region=garage' \
//   TEST_BLOB_ACCESS_KEY_ID=… TEST_BLOB_SECRET_ACCESS_KEY=… node --test test/blob-server.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createFiles } from "../broker/files.mjs";
import { blobCredentials, BlobError, checkBlobs, openBlobs, startBlobs } from "../lib/blobs.mjs";
import { openStore } from "../lib/store.mjs";
import { createLogs } from "../runner/logs.mjs";

const URL_SET = process.env.TEST_BLOB_URL ?? "";
const skip = !URL_SET && "TEST_BLOB_URL unset: no S3 server to check against";

const RUN = `deckhand-test-${randomBytes(6).toString("hex")}`;

// TEST_BLOB_URL under a prefix of this run's; `bucket`: another bucket's name instead.
function blobUrl({ prefix = RUN, bucket } = {}) {
  const url = new URL(URL_SET);
  if (bucket) url.hostname = bucket;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${prefix}`;
  return url.href;
}

const credentials = () =>
  blobCredentials({
    BLOB_ACCESS_KEY_ID: process.env.TEST_BLOB_ACCESS_KEY_ID,
    BLOB_SECRET_ACCESS_KEY: process.env.TEST_BLOB_SECRET_ACCESS_KEY,
  });

function open(t, options = {}) {
  const blobs = openBlobs(blobUrl(options), {
    credentials: options.credentials ?? credentials(),
    s3: { retries: 0 },
  });
  t.after(() => blobs.close());
  return blobs;
}

const ID = "dh-o-a-1-1";
const FOLDER = "0123456789abcdef01234567";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

test("blob storage: the start's check, PUT, ranged GET, HEAD and DELETE", { skip }, async (t) => {
  const blobs = open(t);
  const logged = [];
  const started = await startBlobs(
    { BLOB_URL: blobUrl() },
    {
      credentials: credentials(),
      storeUrl: "file:///data/store",
      log: (line) => logged.push(line),
      s3: { retries: 0 },
    },
  );
  t.after(() => started.blobs.close());
  assert.deepEqual(started.warnings, []);
  assert.match(logged[0], /^Blob storage: s3, bucket /);

  const data = randomBytes(3 * 1024 * 1024 + 7);
  await blobs.put("logs/r1/0", data);
  assert.equal(await blobs.size("logs/r1/0"), data.length);
  assert.deepEqual(await blobs.read("logs/r1/0"), data);
  assert.deepEqual(
    await blobs.read("logs/r1/0", { offset: 1000, length: 10 }),
    data.subarray(1000, 1010),
  );
  // To its end, and past it: what is left, nothing.
  assert.deepEqual(await blobs.read("logs/r1/0", { offset: data.length - 3 }), data.subarray(-3));
  assert.equal((await blobs.read("logs/r1/0", { offset: data.length })).length, 0);
  assert.equal((await blobs.read("logs/r1/0", { offset: data.length + 10 })).length, 0);
  // A key and a key under it, both there.
  await blobs.put("logs/r1", "legacy");
  assert.equal((await blobs.read("logs/r1")).toString(), "legacy");
  await blobs.delete("logs/r1/0");
  await blobs.delete("logs/r1");
  assert.equal(await blobs.size("logs/r1/0"), null);
  assert.equal(await blobs.read("logs/r1/0"), null);
  // Deleting what isn't there.
  await blobs.delete("logs/r1/0");
});

test("blob storage: a wrong key or bucket stops the service, saying why", { skip }, async (t) => {
  const { accessKeyId, secretAccessKey } = credentials();
  const wrongSecret = open(t, {
    credentials: { accessKeyId, secretAccessKey: `${secretAccessKey}x` },
  });
  await assert.rejects(checkBlobs(wrongSecret), (error) => {
    assert.ok(error instanceof BlobError);
    assert.match(error.message, /can't write an object: .*403/);
    assert.ok(!error.message.includes(secretAccessKey));
    return true;
  });
  const noBucket = open(t, { bucket: `${RUN}-none` });
  await assert.rejects(checkBlobs(noBucket), /can't write an object: .*(NoSuchBucket|404|403)/);
});

// The whole log, as the dashboard reads it.
async function readAll(logs, offset = 0) {
  const parts = [];
  for (;;) {
    const { size, data } = await logs.read(ID, { offset });
    if (!data.length) break;
    parts.push(data);
    offset += data.length;
    if (offset >= size) break;
  }
  return Buffer.concat(parts);
}

test(
  "a run's log: its closed segments moved, read back from any offset, deleted by retention",
  { skip },
  async (t) => {
    const blobs = open(t);
    const store = openStore("memory:");
    const logs = createLogs({ store, blobs, segmentMax: 1024 * 1024 });
    // Four segments: the second one past the cap, the next two each a step of its own.
    const parts = [
      [randomBytes(700 * 1024), false],
      [randomBytes(700 * 1024), false],
      [randomBytes(10), true],
      [randomBytes(900 * 1024), true],
    ];
    let at = 0;
    for (const [part, step] of parts) at = await logs.append(ID, at, part, { step });
    await logs.append(ID, at, Buffer.alloc(0), { close: true });
    await logs.moves.pass();

    const { segments } = await store.get(`logs/${ID}/index`);
    assert.equal(segments.length, 4);
    assert.ok(segments.every((s) => s.where === "blobs"));
    for (const [n, segment] of segments.entries()) {
      assert.equal(await store.blobSize(`logs/${ID}/${n}`), null, `segment ${n} left the store`);
      assert.equal(await blobs.size(`logs/${ID}/${n}`), segment.size);
    }
    const whole = Buffer.concat(parts.map(([part]) => part));
    assert.deepEqual(await readAll(logs), whole);
    for (const offset of [1, 700 * 1024 - 1, 700 * 1024, 1400 * 1024 + 5, whole.length - 1]) {
      assert.deepEqual(await readAll(logs, offset), whole.subarray(offset), `from ${offset}`);
    }

    assert.equal(await logs.remove(ID), true);
    for (const n of segments.keys()) assert.equal(await blobs.size(`logs/${ID}/${n}`), null);
    assert.equal(await store.get(`logs/${ID}/index`), null);
  },
);

// An upload's request, as files.putShot() reads it.
const upload = (body) =>
  Object.assign(
    (async function* () {
      yield body;
    })(),
    { headers: { "content-length": String(body.length) } },
  );

test("a screenshot: written once, served in parts, deleted with its run", { skip }, async (t) => {
  const blobs = open(t);
  const files = createFiles({
    store: openStore("memory:"),
    blobs,
    runs: { event: async () => {} },
  });
  const image = Buffer.concat([PNG, randomBytes(600 * 1024)]);
  const record = { id: "run-a", shots: FOLDER };
  assert.equal((await files.putShot(upload(image), record, "page.png")).status, 204);
  assert.equal(await blobs.size(`shots/${FOLDER}/page.png`), image.length);
  const shot = await files.openShot(FOLDER, "page.png");
  assert.equal(shot.size, image.length);
  const half = 256 * 1024;
  const served = Buffer.concat([
    await shot.read(0, half),
    await shot.read(half, half),
    await shot.read(2 * half, half),
  ]);
  assert.deepEqual(served, image);
  assert.equal(await files.removeShots(FOLDER), 1);
  assert.equal(await blobs.size(`shots/${FOLDER}/page.png`), null);
  assert.equal(await files.openShot(FOLDER, "page.png"), null);
});
