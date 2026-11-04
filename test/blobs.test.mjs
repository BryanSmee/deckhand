// Blob storage (lib/blobs.mjs): BLOB_URL's three backends against the same interface tests
// (s3:// through the fake S3 server, file:// in a temp dir, unset: the store), its credentials,
// the check at start, the warning, and the secret key kept out of the store and the log; then
// the broker and the runner started for real, stopped by blob storage or warning on /health.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  BlobError,
  blobCredentials,
  blobSecrets,
  blobWarning,
  checkBlobs,
  openBlobs,
  startBlobs,
} from "../lib/blobs.mjs";
import { createLogger } from "../lib/log.mjs";
import { openStore } from "../lib/store.mjs";
import { assertHealth, closedPort, fakeS3, listening, needsBash, tempDir } from "./helpers.mjs";

const root = join(import.meta.dirname, "..");

const s3Url = (s3, { bucket = s3.bucket, prefix = "", region = s3.region } = {}) =>
  `s3://${bucket}${prefix ? `/${prefix}` : ""}?endpoint=${encodeURIComponent(s3.endpoint)}&region=${region}`;
const credentialsOf = ({ accessKeyId, secretAccessKey }) => ({ accessKeyId, secretAccessKey });
// No retries nor waits: a failure fails at once.
const S3_OPTIONS = { retries: 0, timeoutMs: 5000 };

// Each backend, opened anew for a test: → the blobs.
const BACKENDS = {
  s3: async (t) => {
    const s3 = await fakeS3(t);
    const blobs = openBlobs(s3Url(s3, { prefix: "deckhand" }), {
      credentials: credentialsOf(s3),
      s3: S3_OPTIONS,
    });
    t.after(() => blobs.close());
    return blobs;
  },
  file: async (t) => openBlobs(pathToFileURL(join(tempDir(t), "blobs")).href),
  store: async () => openBlobs(undefined, { store: openStore("memory:") }),
};

for (const [name, open] of Object.entries(BACKENDS)) {
  test(`blobs (${name}): put, read whole and in ranges, size, replace, delete`, async (t) => {
    const blobs = await open(t);
    assert.equal(blobs.kind, name);
    assert.equal(await blobs.read("logs/run-1/0"), null);
    assert.equal(await blobs.size("logs/run-1/0"), null);

    await blobs.put("logs/run-1/0", Buffer.from("hello, world"));
    assert.equal((await blobs.read("logs/run-1/0")).toString(), "hello, world");
    assert.equal(await blobs.size("logs/run-1/0"), 12);
    assert.equal((await blobs.read("logs/run-1/0", { offset: 7 })).toString(), "world");
    assert.equal((await blobs.read("logs/run-1/0", { offset: 7, length: 3 })).toString(), "wor");
    assert.equal((await blobs.read("logs/run-1/0", { length: 5 })).toString(), "hello");
    // Past its end: nothing, never an error.
    assert.equal((await blobs.read("logs/run-1/0", { offset: 10, length: 50 })).toString(), "ld");
    assert.equal((await blobs.read("logs/run-1/0", { offset: 12 })).length, 0);
    assert.equal((await blobs.read("logs/run-1/0", { offset: 99 })).length, 0);
    assert.equal((await blobs.read("logs/run-1/0", { offset: 3, length: 0 })).length, 0);

    // Text too, and bytes that aren't UTF-8 come back as they were.
    await blobs.put("logs/run-1/1", "été");
    assert.equal((await blobs.read("logs/run-1/1")).toString(), "été");
    const bytes = Buffer.from([0, 255, 128, 10, 13]);
    await blobs.put("shots/a.png", bytes);
    assert.deepEqual(await blobs.read("shots/a.png"), bytes);

    // A put replaces it whole.
    await blobs.put("logs/run-1/0", "short");
    assert.equal((await blobs.read("logs/run-1/0")).toString(), "short");
    assert.equal(await blobs.size("logs/run-1/0"), 5);

    await blobs.delete("logs/run-1/0");
    assert.equal(await blobs.read("logs/run-1/0"), null);
    assert.equal(await blobs.size("logs/run-1/0"), null);
    // Deleting one that isn't there is no error.
    await blobs.delete("logs/run-1/0");
    assert.equal((await blobs.read("logs/run-1/1")).toString(), "été");
  });

  test(`blobs (${name}): a key and a key under it, and a long key, as S3 keeps them`, async (t) => {
    const blobs = await open(t);
    await blobs.put("logs/r1", "segment list");
    await blobs.put("logs/r1/2", "a segment");
    assert.equal((await blobs.read("logs/r1")).toString(), "segment list");
    assert.equal((await blobs.read("logs/r1/2")).toString(), "a segment");
    // The other way round too.
    await blobs.put("files/r1/a/b", "deep");
    await blobs.put("files/r1/a", "shallow");
    assert.equal((await blobs.read("files/r1/a/b")).toString(), "deep");
    assert.equal(await blobs.size("files/r1/a"), 7);
    // A part far past a file name's 255 bytes, and a whole key near S3's 1024.
    const long = `files/r1/${"x".repeat(400)}/${"y".repeat(500)}`;
    const other = `${long.slice(0, -1)}z`;
    await blobs.put(long, "long");
    await blobs.put(other, "other");
    assert.equal((await blobs.read(long)).toString(), "long");
    assert.equal((await blobs.read(other)).toString(), "other");
    await blobs.delete(long);
    assert.equal(await blobs.size(long), null);
    assert.equal(await blobs.size(other), 5);
  });

  test(`blobs (${name}): a range that isn't one is refused, as on S3`, async (t) => {
    const blobs = await open(t);
    await blobs.put("logs/r", "hello");
    for (const range of [{ length: -2 }, { length: NaN }, { length: 1.5 }, { offset: -1 }]) {
      await assert.rejects(blobs.read("logs/r", range), TypeError, JSON.stringify(range));
    }
    assert.equal((await blobs.read("logs/r", { offset: 1, length: 2 })).toString(), "el");
  });

  test(`blobs (${name}): keys climbing out are refused`, async (t) => {
    const blobs = await open(t);
    for (const key of ["", "../x", "a/../../x", "/etc/passwd", "a//b", "a\\b", "a/./b"]) {
      await assert.rejects(blobs.put(key, "x"), /^TypeError: blobs: /, JSON.stringify(key));
      await assert.rejects(blobs.read(key), TypeError, JSON.stringify(key));
    }
  });

  test(`blobs (${name}): the check at start passes`, async (t) => {
    const blobs = await open(t);
    await checkBlobs(blobs);
  });

  test(`blobs (${name}): the service's secrets are redacted from a blob`, async (t) => {
    const s3 = name === "s3" ? await fakeS3(t) : null;
    const secret = "blob-secret-key-0123456789abcdefXYZ";
    const secrets = () => [secret];
    const blobs =
      name === "s3"
        ? openBlobs(s3Url(s3), { credentials: credentialsOf(s3), secrets, s3: S3_OPTIONS })
        : name === "file"
          ? openBlobs(pathToFileURL(tempDir(t)).href, { secrets })
          : openBlobs(undefined, { store: openStore("memory:", { secrets }) });
    t.after(() => blobs.close());
    await blobs.put("logs/r", `a line with ${secret} in it\n`);
    const back = (await blobs.read("logs/r")).toString();
    assert.ok(!back.includes(secret), back);
    assert.match(back, /^a line with .*redacted.* in it\n$/);
  });
}

test("blobs (s3): the prefix goes before every key, in the bucket the URL names", async (t) => {
  const s3 = await fakeS3(t);
  const blobs = openBlobs(s3Url(s3, { prefix: "team/deckhand" }), {
    credentials: credentialsOf(s3),
    s3: S3_OPTIONS,
  });
  t.after(() => blobs.close());
  await blobs.put("logs/a", "x");
  assert.deepEqual([...s3.objects.keys()], ["team/deckhand/logs/a"]);
  assert.equal(blobs.where, `bucket deckhand at ${new URL(s3.endpoint).origin}`);
});

test("blobs (file): a put lands whole, and nothing is left beside it", async (t) => {
  const dir = tempDir(t);
  const blobs = openBlobs(pathToFileURL(dir).href);
  await blobs.put("logs/a/0", "x".repeat(100_000));
  // One file in the folder itself, named as the store names its blobs' files.
  assert.deepEqual(readdirSync(dir), ["logs%2Fa%2F0"]);
  assert.equal(readFileSync(join(dir, "logs%2Fa%2F0"), "utf8").length, 100_000);
  await checkBlobs(blobs);
  assert.deepEqual(readdirSync(dir), ["logs%2Fa%2F0"]);
});

test("BLOB_URL: what isn't blob storage, or puts credentials in the URL, is refused", async (t) => {
  const s3 = await fakeS3(t);
  const credentials = credentialsOf(s3);
  const refused = (url, pattern, options = { credentials }) =>
    assert.throws(
      () => openBlobs(url, options),
      (e) => e instanceof BlobError && pattern.test(e.message),
    );
  refused("redis://redis:6379", /redis: isn't blob storage/);
  refused("not a url", /not a URL/);
  refused(`s3://AKID:secret@deckhand?endpoint=${s3.endpoint}`, /no credentials in the URL/);
  refused("s3://deckhand", /needs \?endpoint=/);
  refused(`s3://deckhand?endpoint=${s3.endpoint}&style=virtual`, /unknown style/);
  refused(`s3://deckhand?endpoint=ftp://host`, /not an http\(s\) endpoint/);
  refused(`s3://deckhand?endpoint=${s3.endpoint}`, /needs BLOB_ACCESS_KEY_ID/, {});
  refused(`s3://deckhand/%zz?endpoint=${s3.endpoint}`, /^BLOB_URL: not a valid prefix$/);
  refused("file:///blobs?endpoint=x", /file:\/\/\/<folder> alone/, {});
  refused("file:///blobs#x", /file:\/\/\/<folder> alone/, {});
  refused("", /no store/, {});
  // The secret key is in no message.
  try {
    openBlobs(`s3://${credentials.accessKeyId}:${credentials.secretAccessKey}@deckhand`, {});
  } catch (error) {
    assert.ok(!error.message.includes(credentials.secretAccessKey));
  }
});

test("blobCredentials: the variables or their _FILE forms, both or neither", (t) => {
  assert.equal(blobCredentials({}), null);
  assert.deepEqual(
    blobCredentials({
      BLOB_ACCESS_KEY_ID: "AKID",
      BLOB_SECRET_ACCESS_KEY: "s3cr3t-0123456789abcdef",
    }),
    { accessKeyId: "AKID", secretAccessKey: "s3cr3t-0123456789abcdef" },
  );
  const dir = tempDir(t);
  writeFileSync(join(dir, "id"), "AKID\n");
  writeFileSync(join(dir, "secret"), "s3cr3t-0123456789abcdef\n");
  assert.deepEqual(
    blobCredentials({
      BLOB_ACCESS_KEY_ID_FILE: join(dir, "id"),
      BLOB_SECRET_ACCESS_KEY_FILE: join(dir, "secret"),
    }),
    { accessKeyId: "AKID", secretAccessKey: "s3cr3t-0123456789abcdef" },
  );
  assert.throws(() => blobCredentials({ BLOB_ACCESS_KEY_ID: "AKID" }), /set both, or neither/);
  assert.throws(
    () =>
      blobCredentials({
        BLOB_ACCESS_KEY_ID: "AKID",
        BLOB_SECRET_ACCESS_KEY: "x",
        BLOB_SECRET_ACCESS_KEY_FILE: join(dir, "secret"),
      }),
    /not both/,
  );
  assert.throws(
    () =>
      blobCredentials({
        BLOB_ACCESS_KEY_ID: "AKID",
        BLOB_SECRET_ACCESS_KEY_FILE: join(dir, "none"),
      }),
    (e) =>
      e instanceof BlobError &&
      /BLOB_SECRET_ACCESS_KEY_FILE: can't read .* \(ENOENT\)/.test(e.message),
  );
  // A secret key redact() would leave as it is (under 16 characters): refused, fail closed.
  assert.throws(
    () =>
      blobCredentials({ BLOB_ACCESS_KEY_ID: "minioadmin", BLOB_SECRET_ACCESS_KEY: "minioadmin" }),
    (e) =>
      e instanceof BlobError && /BLOB_SECRET_ACCESS_KEY: 16 characters at least/.test(e.message),
  );
  assert.deepEqual(blobSecrets(null), []);
  assert.deepEqual(
    blobSecrets({ accessKeyId: "AKID", secretAccessKey: "s3cr3t-0123456789abcdef" }),
    ["s3cr3t-0123456789abcdef"],
  );
});

test("the check at start: a wrong key or a bucket that doesn't exist says what failed", async (t) => {
  const s3 = await fakeS3(t);
  const failing = async (url, credentials, pattern) => {
    const blobs = openBlobs(url, { credentials, s3: S3_OPTIONS });
    t.after(() => blobs.close());
    await assert.rejects(
      checkBlobs(blobs),
      (e) =>
        e instanceof BlobError &&
        pattern.test(e.message) &&
        !e.message.includes(s3.secretAccessKey),
    );
  };
  await failing(
    s3Url(s3),
    { accessKeyId: "AKIDWRONG", secretAccessKey: s3.secretAccessKey },
    /^BLOB_URL \(bucket deckhand at .*\): can't write an object: S3 put \.deckhand-check\/\w+: 403 InvalidAccessKeyId \(the access key isn't known there\)$/,
  );
  await failing(
    s3Url(s3),
    { accessKeyId: s3.accessKeyId, secretAccessKey: "not-the-secret-key-at-all-0123456789" },
    /403 SignatureDoesNotMatch \(the secret key is wrong, or the region\)$/,
  );
  await failing(
    s3Url(s3, { bucket: "nope" }),
    credentialsOf(s3),
    /^BLOB_URL \(bucket nope at .*\): can't write an object: .*404 NoSuchBucket \(no such bucket\)$/,
  );
  // An endpoint nothing answers on.
  await failing(
    `s3://deckhand?endpoint=http://127.0.0.1:1`,
    credentialsOf(s3),
    /can't write an object: .*ECONNREFUSED/,
  );
});

test("the check at start: a key that may write but not read leaves no object behind", async (t) => {
  const s3 = await fakeS3(t);
  const blobs = openBlobs(s3Url(s3), { credentials: credentialsOf(s3), s3: S3_OPTIONS });
  t.after(() => blobs.close());
  // The PUT goes through, the GET is refused.
  s3.fail(null, { status: 403, code: "AccessDenied" });
  await assert.rejects(checkBlobs(blobs), /can't read an object: .*403 AccessDenied/);
  assert.deepEqual(
    s3.requests.map((r) => r.method),
    ["PUT", "GET", "DELETE"],
  );
  assert.equal(s3.objects.size, 0);
});

test("the check at start: a folder that can't be written says so", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "file"), "");
  // A file where the folder should be: no root override for that.
  const blobs = openBlobs(pathToFileURL(join(dir, "file", "blobs")).href);
  await assert.rejects(checkBlobs(blobs), (e) =>
    /^BLOB_URL \(.*\): can't write an object: .*ENOTDIR/.test(e.message),
  );
});

test("the warning: Redis as the store and no BLOB_URL, and only then", async (t) => {
  assert.match(
    blobWarning("redis://redis:6379", undefined, "The runs' logs"),
    /^The runs' logs take Redis's memory: set BLOB_URL/,
  );
  assert.match(blobWarning("rediss://redis:6379", ""), /^The blobs take Redis's memory/);
  assert.equal(blobWarning("redis://redis:6379", "file:///blobs"), null);
  assert.equal(blobWarning("file:///data/store", undefined), null);

  // startBlobs() logs it, and returns it for /health.
  const lines = [];
  const log = Object.assign((line) => lines.push(["info", line]), {
    warn: (line) => lines.push(["warn", line]),
  });
  const store = openStore("memory:");
  const started = await startBlobs(
    { STORE_URL: "redis://redis:6379" },
    { store, storeUrl: "redis://redis:6379", what: "The runs' files", log },
  );
  assert.equal(started.blobs.kind, "store");
  assert.equal(started.warnings.length, 1);
  assert.deepEqual(lines, [["warn", started.warnings[0]]]);

  // With blob storage: checked, said, no warning.
  lines.length = 0;
  const dir = tempDir(t);
  const set = await startBlobs(
    { BLOB_URL: pathToFileURL(dir).href },
    { store, storeUrl: "redis://redis:6379", what: "The runs' files", log },
  );
  assert.deepEqual(set.warnings, []);
  assert.equal(set.blobs.kind, "file");
  assert.deepEqual(lines, [["info", `Blob storage: file, ${dir}`]]);
  // Its check's object gone.
  assert.deepEqual(readdirSync(dir), []);
});

test("the secret key: refused in a store value, redacted from its blobs and its log", async () => {
  const credentials = { accessKeyId: "AKID", secretAccessKey: "blob-secret-0123456789abcdefXYZ" };
  const secrets = () => blobSecrets(credentials);
  const store = openStore("memory:", { secrets });
  await assert.rejects(
    store.set("x", { key: credentials.secretAccessKey }),
    /a secret can't go in the store/,
  );
  await store.putBlob("logs/a", `key=${credentials.secretAccessKey}\n`);
  assert.ok(!(await store.readBlob("logs/a")).toString().includes(credentials.secretAccessKey));

  const lines = [];
  const log = createLogger({
    service: "runner",
    env: { LOG_FORMAT: "text" },
    secrets,
    write: (line) => lines.push(line),
  });
  log(`the key is ${credentials.secretAccessKey}`);
  log.error("failed", { key: credentials.secretAccessKey });
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(!line.includes(credentials.secretAccessKey), line);
});

// A service, started for real: a BLOB_URL that fails its check stops it with what failed,
// before it takes a call; one that passes lets it start.
function startService(t, script, env) {
  const child = spawn(process.execPath, [join(root, script)], {
    env: { PORT: "0", LOG_FORMAT: "text", STORE_URL: "memory:", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  return {
    out: () => out,
    exited: new Promise((resolve) => child.on("exit", (code) => resolve({ code, out }))),
    until: (pattern) =>
      new Promise((resolve, reject) => {
        const check = () => pattern.test(out) && resolve(out);
        child.stdout.on("data", check);
        child.on("exit", () => reject(new Error(`exited: ${out}`)));
        check();
      }),
  };
}

const startBroker = (t, env) =>
  startService(t, "broker/server.mjs", {
    PATH: process.env.PATH,
    KEY_DIR: tempDir(t),
    SERVICE_NETWORKS: "orchestrator=127.0.0.0/8",
    ...env,
  });

test("the broker stops at start on a wrong key, its message clear and the key not in it", async (t) => {
  const s3 = await fakeS3(t);
  const broker = startBroker(t, {
    BLOB_URL: s3Url(s3),
    BLOB_ACCESS_KEY_ID: s3.accessKeyId,
    BLOB_SECRET_ACCESS_KEY: "the-wrong-secret-key-0123456789abcdef",
  });
  const { code, out } = await broker.exited;
  assert.equal(code, 1);
  assert.match(
    out,
    /Broker: BLOB_URL \(bucket deckhand at .*\): can't write an object: .*SignatureDoesNotMatch/,
  );
  assert.ok(!out.includes("the-wrong-secret-key-0123456789abcdef"));
});

test("the broker starts with blob storage that passes its check", async (t) => {
  const s3 = await fakeS3(t);
  const broker = startBroker(t, {
    BLOB_URL: s3Url(s3),
    BLOB_ACCESS_KEY_ID: s3.accessKeyId,
    BLOB_SECRET_ACCESS_KEY: s3.secretAccessKey,
  });
  const out = await broker.until(/Broker on :\d+/);
  assert.match(out, /Blob storage: s3, bucket deckhand at /);
  // Its check's object written, then deleted.
  assert.deepEqual(
    s3.requests.map((r) => r.method),
    ["PUT", "GET", "HEAD", "DELETE"],
  );
  assert.equal(s3.objects.size, 0);
});

// The runner, started for real beside the fake docker (fixtures/fake-docker.sh): the broker
// it asks for its tokens is a port nothing listens on, which it only retries.
async function startRunner(t, env) {
  const dir = tempDir(t);
  symlinkSync(join(import.meta.dirname, "fixtures", "fake-docker.sh"), join(dir, "docker"));
  return startService(t, "runner/server.mjs", {
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    DATA_DIR: dir,
    SERVICE_KEYS_DIR: tempDir(t),
    SERVICE_NETWORKS: "orchestrator=127.0.0.0/8",
    BROKER_SERVICE_URL: `http://127.0.0.1:${await closedPort()}`,
    ...env,
  });
}

// Stopped by its own catch, before it listens: its error logged, not thrown (no stack).
function assertClean(out) {
  assert.doesNotMatch(out, /Deckhand runner/);
  assert.doesNotMatch(out, /BlobError|^\s+at /m);
}

// Its /health, once it listens.
async function runnerHealth(runner) {
  const out = await runner.until(/Deckhand runner \(docker\) on :\d+/);
  const [, port] = out.match(/Deckhand runner \(docker\) on :(\d+)/);
  return (await fetch(`http://127.0.0.1:${port}/health`)).json();
}

test(
  "the runner stops at start on a wrong key, its message clear and the key not in it",
  { skip: needsBash },
  async (t) => {
    const s3 = await fakeS3(t);
    const runner = await startRunner(t, {
      BLOB_URL: s3Url(s3),
      BLOB_ACCESS_KEY_ID: s3.accessKeyId,
      BLOB_SECRET_ACCESS_KEY: "the-wrong-secret-key-0123456789abcdef",
    });
    const { code, out } = await runner.exited;
    assert.equal(code, 1);
    assert.match(
      out,
      /^\S+ ERROR BLOB_URL \(bucket deckhand at .*\): can't write an object: .*SignatureDoesNotMatch \(the secret key is wrong, or the region\)$/m,
    );
    assert.ok(!out.includes("the-wrong-secret-key-0123456789abcdef"));
    assertClean(out);
  },
);

test("the runner stops at start on half its credentials", { skip: needsBash }, async (t) => {
  const runner = await startRunner(t, { BLOB_ACCESS_KEY_ID: "AKID" });
  const { code, out } = await runner.exited;
  assert.equal(code, 1);
  assert.match(
    out,
    /^\S+ ERROR BLOB_ACCESS_KEY_ID and BLOB_SECRET_ACCESS_KEY: set both, or neither$/m,
  );
  assertClean(out);
});

test(
  "the runner starts with blob storage that passes its check, no warning on /health",
  { skip: needsBash },
  async (t) => {
    const s3 = await fakeS3(t);
    const runner = await startRunner(t, {
      BLOB_URL: s3Url(s3),
      BLOB_ACCESS_KEY_ID: s3.accessKeyId,
      BLOB_SECRET_ACCESS_KEY: s3.secretAccessKey,
    });
    // No warning: none in it. Active or not yet, as it listens before it takes its lease.
    const health = await runnerHealth(runner);
    assertHealth(health, { active: health.active });
    assert.match(await runner.until(/Blob storage: s3/), /Blob storage: s3, bucket deckhand at /);
    // Its check's object written, then deleted.
    assert.deepEqual(
      s3.requests.map((r) => r.method),
      ["PUT", "GET", "HEAD", "DELETE"],
    );
  },
);

test(
  "the runner with Redis as its store and no BLOB_URL: the warning on /health",
  { skip: needsBash },
  async (t) => {
    // A Redis that never answers: the warning comes from STORE_URL alone, and /health never
    // waits on the store (nor the lease, which this copy doesn't get).
    const sockets = new Set();
    const redis = createNetServer((socket) => {
      sockets.add(socket);
      socket.resume();
    });
    const port = await listening(redis);
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      redis.close();
    });
    const runner = await startRunner(t, { STORE_URL: `redis://127.0.0.1:${port}` });
    const health = await runnerHealth(runner);
    assertHealth(health, { warnings: health.warnings, active: false });
    assert.equal(health.warnings.length, 1);
    assert.match(health.warnings[0], /^The runs' logs take Redis's memory: set BLOB_URL/);
    assert.match(runner.out(), /WARN The runs' logs take Redis's memory/);
  },
);
