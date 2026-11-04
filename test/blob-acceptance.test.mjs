// Blob storage's acceptance (#604): with Redis as the store and BLOB_URL set, a run that writes
// 500 MB of log keeps one segment in Redis once its moves caught up (an append never waits on a
// move: how much waits meanwhile is the servers' speed, reported, not asserted), and its whole
// log reads back as the dashboard reads it (GET /logs of the runner service, through its client,
// as edge calls it).
// The runner service in process, on a real Redis and a real S3 server (Garage, docs/setup.md):
// skipped unless TEST_REDIS_URL and TEST_BLOB_URL (with TEST_BLOB_ACCESS_KEY_ID and
// TEST_BLOB_SECRET_ACCESS_KEY, as test/blob-server.test.mjs) name them; no CI job runs them.
// TEST_LOG_MB: the log's size, 500 by default. Each run writes under prefixes of its own, and
// deletes what it wrote, failing or not.
//
//   docker run -d --name redis -p 6379:6379 redis:7 --maxmemory-policy noeviction
//   TEST_REDIS_URL=redis://localhost:6379 TEST_BLOB_URL=… node --test test/blob-acceptance.test.mjs
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { blobCredentials, openBlobs } from "../lib/blobs.mjs";
import { redisClient } from "../lib/resp.mjs";
import { signServiceToken } from "../lib/service-token.mjs";
import { redisStore } from "../lib/store-redis.mjs";
import { keyId } from "../lib/tokens.mjs";
import { createRunnerClient } from "../runner/client.mjs";
import { createLogs } from "../runner/logs.mjs";
import { createRunnerService } from "../runner/service.mjs";
import { scanRedis } from "./helpers.mjs";

const redisUrl = process.env.TEST_REDIS_URL ?? "";
const blobUrl = process.env.TEST_BLOB_URL ?? "";
const skip =
  (!redisUrl && "TEST_REDIS_URL unset: no Redis to check against") ||
  (!blobUrl && "TEST_BLOB_URL unset: no S3 server to check against");
const MB = 1024 * 1024;
const TOTAL = Number(process.env.TEST_LOG_MB || 500) * MB;
// LOG_SEGMENT_MB's default (runner/logs.mjs, listener/config.mjs).
const SEGMENT = 8 * MB;
const ID = "dh-o-a-1-1";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signing = { privateKey, kid: keyId(publicKey) };
const tokenFor = (sub) => `Bearer ${signServiceToken({ sub, aud: "runner" }, signing)}`;

// TEST_BLOB_URL under a prefix of its own.
function prefixed(prefix) {
  const url = new URL(blobUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${prefix}`;
  return url.href;
}

// The runner service, its logs on `store` and `blobs`, acting (its lease held), listening.
async function runner(t, { store, blobs }) {
  const logs = createLogs({ store, blobs, segmentMax: SEGMENT });
  const service = createRunnerService({
    config: { runner: "docker", prefix: "dh", image: "dh-sandbox" },
    runner: { list: async () => [] },
    images: {},
    logs,
    store,
    broker: {},
    keys: () => new Map([[signing.kid, publicKey]]),
    bound: null,
    lease: { active: () => true, stop: async () => {} },
    watchMs: 60_000,
  });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  await service.activate();
  t.after(async () => {
    service.deactivate();
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  });
  return { logs, url: `http://127.0.0.1:${service.server.address().port}` };
}

// Line `i` of the log: its number, then bytes enough to make a 1 MB chunk of 16 lines.
const filler = randomBytes(48 * 1024).toString("hex");
const chunk = (i) => {
  let text = "";
  for (let line = 0; line < 16; line++) {
    const head = `${i}.${line} `;
    text += `${head}${filler.slice(0, 64 * 1024 - head.length - 1)}\n`;
  }
  return Buffer.from(text);
};

test(
  "Redis and blob storage: a 500 MB log keeps one segment in Redis once its moves caught up, and reads back whole",
  { skip, timeout: 30 * 60_000 },
  async (t) => {
    const prefix = `deckhand-test:${randomUUID()}:`;
    const store = redisStore({ url: redisUrl, prefix });
    const redis = redisClient(redisUrl);
    const blobs = openBlobs(prefixed(`deckhand-test-${randomBytes(6).toString("hex")}`), {
      credentials: blobCredentials({
        BLOB_ACCESS_KEY_ID: process.env.TEST_BLOB_ACCESS_KEY_ID,
        BLOB_SECRET_ACCESS_KEY: process.env.TEST_BLOB_SECRET_ACCESS_KEY,
      }),
    });
    let runnerLogs = null;
    // The log's segments in blob storage, then the Redis keys under `prefix`, failing or not: a
    // Redis or a bucket shared with others keeps theirs.
    t.after(async () => {
      await runnerLogs?.remove(ID).catch(() => {});
      await scanRedis(redis, `${prefix}*`, (keys) => redis.call("DEL", ...keys));
      await Promise.all([store.close(), redis.close(), blobs.close()]);
    });
    const started = await runner(t, { store, blobs });
    runnerLogs = started.logs;
    const { url } = started;
    const { logs } = createRunnerClient({
      urls: url,
      token: async (sub) => tokenFor(sub),
      epoch: () => 1,
    });

    // The bytes of this log's segments in Redis, as STRLEN counts them.
    const inRedis = async () => {
      let bytes = 0;
      await scanRedis(redis, `${prefix}b:logs/${ID}/*`, async (keys) => {
        for (const key of keys) bytes += Number(await redis.call("STRLEN", key));
      });
      return bytes;
    };

    // Written as the orchestrator writes it, as fast as the runner takes it, a step of the run
    // every 100 MB; measured after each MB is at the runner. A closed segment leaves Redis once
    // its copy is in blob storage, and appends don't wait for that: what waits meanwhile
    // (`most`) is the servers' speed against the writer's, reported only. Every 10 MB, once the
    // moves caught up, the open segment alone (`settled`).
    const written = createHash("sha256");
    const file = logs.open(ID);
    let most = 0;
    let settled = 0;
    for (let i = 0; i * MB < TOTAL; i++) {
      const data = chunk(i);
      written.update(data);
      file.write(data, { step: i > 0 && i % 100 === 0 });
      assert.equal(await file.flushed(), true);
      most = Math.max(most, await inRedis());
      if (i % 10 === 9) {
        await runnerLogs.moves.pass();
        const { segments, open } = await store.get(`logs/${ID}/index`);
        assert.ok(
          segments.every((s) => s.where === "blobs"),
          `at ${i + 1} MB`,
        );
        const bytes = await inRedis();
        assert.equal(bytes, (i + 1) * MB - open, `at ${i + 1} MB: the open segment alone`);
        settled = Math.max(settled, bytes);
      }
    }
    file.close();
    assert.equal(await file.flushed(), true);
    await runnerLogs.moves.pass();
    t.diagnostic(
      `in Redis at most: ${(settled / MB).toFixed(1)} MB once the moves caught up, ${(most / MB).toFixed(1)} MB writing flat out`,
    );
    assert.ok(settled <= SEGMENT, `${settled} bytes in Redis, a segment is ${SEGMENT}`);

    // The run over: every segment in blob storage, only the index left in Redis.
    const index = await store.get(`logs/${ID}/index`);
    assert.equal(index.open, TOTAL);
    assert.ok(index.segments.every((s) => s.where === "blobs"));
    assert.ok(index.segments.length >= TOTAL / SEGMENT);
    assert.equal(await inRedis(), 0);

    // Read back as edge reads it for the dashboard, part by part, and from inside a segment.
    const read = createHash("sha256");
    let offset = 0;
    for (;;) {
      const { size, data } = await logs.read(ID, { offset });
      assert.equal(size, TOTAL);
      if (!data.length) break;
      read.update(data);
      offset += data.length;
    }
    assert.equal(offset, TOTAL);
    assert.equal(read.digest("hex"), written.digest("hex"));
    // From inside a segment: its bytes from there (to its end at most).
    const at = 3 * SEGMENT + 12_345;
    const { data } = await logs.read(ID, { offset: at, length: 20 });
    const i = Math.floor(at / MB);
    const expected = Buffer.concat([chunk(i), chunk(i + 1)]).subarray(at - i * MB);
    assert.ok(data.length > 0);
    assert.deepEqual(data, expected.subarray(0, data.length));

    assert.equal(await runnerLogs.remove(ID), true);
    for (const n of index.segments.keys()) assert.equal(await blobs.size(`logs/${ID}/${n}`), null);
    assert.equal(await store.get(`logs/${ID}/index`), null);
  },
);
