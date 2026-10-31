// The store (lib/store.mjs): the shared suite on each backend, then what the file backend
// adds, everything kept across a restart.
import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { nextEpoch, openStore, storable } from "../lib/store.mjs";
import { fileStore } from "../lib/store-file.mjs";
import { tempDir } from "./helpers.mjs";
import { storeContract } from "./store-contract.mjs";

storeContract("memory", (t, clock) => fileStore({ now: clock.now }));
storeContract("file", (t, clock) => fileStore({ dir: tempDir(t), now: clock.now }));

test("file: keys, leases, streams, consumers and blobs outlive a restart", async (t) => {
  const dir = tempDir(t);
  let at = 1_000_000;
  const now = () => at;
  const before = fileStore({ dir, now });
  await before.set("kept", { a: 1 });
  await before.set("short", 1, { ttlMs: 1000 });
  const lease = await before.acquire("orchestrator", "copy-a", { ttlMs: 5000 });
  await before.release("orchestrator", "copy-a", lease.epoch);
  const ids = [];
  for (const n of [1, 2, 3]) ids.push(await before.append("runs", { n }));
  await before.read("runs", "orchestrator");
  await before.ack("runs", "orchestrator", [ids[0], ids[2]]);
  await before.appendBlob("log", "a");
  await before.close();

  at += 1000;
  const after = fileStore({ dir, now });
  assert.deepEqual(await after.get("kept"), { a: 1 });
  assert.equal(await after.get("short"), null);
  // The epoch goes on from the one before the restart.
  const next = await after.acquire("orchestrator", "copy-b", { ttlMs: 5000 });
  assert.ok(next.epoch > lease.epoch);
  assert.deepEqual(
    (await after.read("runs", "orchestrator")).map((e) => e.event.n),
    [2],
  );
  const id = await after.append("runs", { n: 4 });
  assert.ok(Number(id) > Number(ids[2]), "ids go on increasing");
  await after.appendBlob("log", "b");
  assert.equal((await after.readBlob("log")).toString(), "ab");
});

test("file: a state file taken back to an older one still gives a new, higher epoch", async (t) => {
  const dir = tempDir(t);
  let at = 1_000_000;
  const now = () => at;
  const before = fileStore({ dir, now });
  const first = await before.acquire("orchestrator", "copy-a", { ttlMs: 1000 });
  await before.release("orchestrator", "copy-a", first.epoch);
  const older = readFileSync(join(dir, "state.json"));
  at += 10;
  const second = await before.acquire("orchestrator", "copy-b", { ttlMs: 1000 });
  // The disk lost copy b's lease: the next start reads the state from before it.
  writeFileSync(join(dir, "state.json"), older);
  at += 10;
  const after = fileStore({ dir, now });
  const third = await after.acquire("orchestrator", "copy-a", { ttlMs: 1000 });
  assert.ok(third.epoch > second.epoch, `${third.epoch} after ${second.epoch}`);
});

test("file: an event cut short by a crash is dropped, and the stream goes on", async (t) => {
  const dir = tempDir(t);
  const before = fileStore({ dir });
  await before.append("runs", { n: 1 });
  const [file] = readdirSync(join(dir, "streams"));
  appendFileSync(join(dir, "streams", file), '{"id":2,"ev');

  const after = fileStore({ dir });
  await after.append("runs", { n: 2 });
  assert.deepEqual(
    (await after.read("runs", "edge")).map((e) => e.event.n),
    [1, 2],
  );
  const lines = readFileSync(join(dir, "streams", file), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.equal(lines.length, 2);
});

test("file: names stay in their folder, whatever they hold", async (t) => {
  const dir = tempDir(t);
  const store = fileStore({ dir });
  await store.putBlob("../../etc/x", "x");
  await store.append("../up", { n: 1 });
  assert.deepEqual(readdirSync(dir).sort(), ["blobs", "streams"]);
  assert.equal(readdirSync(join(dir, "blobs")).length, 1);
  assert.equal(readdirSync(join(dir, "streams")).length, 1);
});

test("file: a name too long for a file name is cut and hashed, and stays its own", async (t) => {
  const dir = tempDir(t);
  const store = fileStore({ dir });
  const deep = `runs/42/files/${"src/components/".repeat(12)}`;
  await store.putBlob(`${deep}index.ts`, "a");
  await store.putBlob(`${deep}other.ts`, "b");
  await store.append(`progress/${"x".repeat(300)}`, { n: 1 });
  assert.equal((await store.readBlob(`${deep}index.ts`)).toString(), "a");
  assert.equal((await store.readBlob(`${deep}other.ts`)).toString(), "b");
  const names = [...readdirSync(join(dir, "blobs")), ...readdirSync(join(dir, "streams"))];
  assert.equal(names.length, 3);
  for (const file of names) assert.ok(Buffer.byteLength(file) <= 255, file);
  // A short name holding the hash's mark is never taken for a cut one.
  await store.putBlob("a~b", "c");
  assert.equal((await store.readBlob("a~b")).toString(), "c");
});

test("file: a trimmed stream's file is rewritten, not left to grow", async (t) => {
  const dir = tempDir(t);
  const store = fileStore({ dir });
  for (let n = 1; n <= 20; n++) await store.append("progress", { n }, { maxLength: 3 });
  const [file] = readdirSync(join(dir, "streams"));
  const lines = readFileSync(join(dir, "streams", file), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.ok(lines.length < 6, `${lines.length} lines`);
  // Reopened, it holds the last ones only.
  const reopened = fileStore({ dir });
  const read = (await reopened.read("progress", "edge")).map((e) => e.event.n);
  assert.deepEqual(read, [18, 19, 20]);
});

test("file: events trimmed by maxLength stay gone after a restart", async (t) => {
  const dir = tempDir(t);
  const before = fileStore({ dir });
  for (let n = 1; n <= 8; n++) await before.append("progress", { n }, { maxLength: 5 });
  const read = async (store, consumer) =>
    (await store.read("progress", consumer)).map((e) => e.event.n);
  assert.deepEqual(await read(before, "edge"), [4, 5, 6, 7, 8]);
  const after = fileStore({ dir });
  assert.deepEqual(await read(after, "dashboard"), [4, 5, 6, 7, 8]);
  // And appends go on from there.
  await after.append("progress", { n: 9 }, { maxLength: 5 });
  assert.deepEqual(await read(fileStore({ dir }), "other"), [5, 6, 7, 8, 9]);
});

test("openStore: file:, memory: and redis:, nothing else", async (t) => {
  const dir = tempDir(t);
  const store = openStore(`file://${dir}`);
  await store.set("a", 1);
  assert.deepEqual(readdirSync(dir).includes("state.json"), true);
  assert.equal(await openStore("memory:").get("a"), null);
  assert.throws(() => openStore("postgres://store:5432"), /isn't a store/);
});

test("openStore: a known secret, a private key or a GitHub token is never written", async (t) => {
  const dir = tempDir(t);
  const signingKey = "sk-signing-0123456789abcdef0123456789";
  const store = openStore(`file://${dir}`, { secrets: () => [signingKey] });
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";
  const token = `ghs_${"a".repeat(36)}`;
  // In a value or an event: refused.
  const writes = [
    () => store.set("app", { key: pem }),
    () => store.setIfAbsent("signing", signingKey),
    () => store.compareAndSet("signing", null, `prefix ${signingKey.slice(0, 20)}`),
    () => store.append("runs", { token }),
  ];
  for (const write of writes) await assert.rejects(write(), /a secret can't go in the store/);
  assert.equal(await store.get("app"), null);
  assert.equal(await store.get("signing"), null);
  assert.deepEqual(await store.read("runs", "edge"), []);
  // In a blob (a run's log): redacted, the rest kept, a test fixture's private key too.
  await store.putBlob("log", Buffer.from(`key: ${signingKey}\n`));
  await store.appendBlob("log", `${token}\n`);
  await store.appendBlob("log", `$ cat test/fixture.pem\n${pem}\n`);
  assert.equal(
    (await store.readBlob("log")).toString(),
    `key: [redacted]\n[redacted]\n$ cat test/fixture.pem\n${pem}\n`,
  );
  // Bytes around a secret come back as they were.
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0x00]),
    Buffer.from(signingKey),
    Buffer.from([0x80]),
  ]);
  await store.putBlob("shot", bytes);
  assert.deepEqual(
    await store.readBlob("shot"),
    Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("[redacted]"), Buffer.from([0x80])]),
  );
  // The rest goes through.
  await store.set("app", { id: 42 });
  assert.deepEqual(await store.get("app"), { id: 42 });
  assert.ok(!readFileSync(join(dir, "state.json"), "utf8").includes("signing-0123"));
});

test("openStore: a file: URL's escapes are its path's own characters", async (t) => {
  const dir = join(tempDir(t), "a store");
  await openStore(pathToFileURL(dir).href).set("a", 1);
  assert.deepEqual(readdirSync(dir).includes("state.json"), true);
});

test("storable: what it returns, the store always takes, whatever the text held", async () => {
  const secret = "operator-secret-0123456789";
  const store = openStore("memory:", { secrets: () => [secret] });
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
  const token = `ghp_${"a".repeat(36)}`;
  const values = [
    { text: `use ${token}` },
    { text: `${key} and after` },
    { text: "-----BEGIN PRIVATE KEY-----\ncut short" },
    { text: `a "quoted" ${secret} and \\ backslashes` },
    { [`${token}`]: "a key holding one", nested: [[{ deep: `github_pat_${"b".repeat(40)}` }]] },
    // A secret only once the strings are JSON: split across two of them.
    ["operator-secret-", "0123456789"],
    { n: 1, ok: true, none: null, text: "nothing to hide" },
  ];
  for (const value of values) {
    const clean = storable(value, [secret]);
    await store.set("v", clean);
    assert.deepEqual(await store.get("v"), clean);
  }
  // Nothing to hide: as it was.
  assert.deepEqual(storable(values.at(-1), [secret]), values.at(-1));
  assert.equal(storable({ text: `use ${token}` }, []).text, "use [redacted]");
});

test("nextEpoch: the clock's, above the last one, whatever the clock says", async () => {
  const store = openStore("memory:");
  let now = 1000;
  assert.equal(await nextEpoch(store, { now: () => now }), 1000);
  assert.equal(await nextEpoch(store, { now: () => now }), 1001);
  now = 5;
  assert.equal(await nextEpoch(store, { now: () => now }), 1002);
  // A store made anew starts from the clock: above what was seen while it moved on.
  now = 9000;
  assert.equal(await nextEpoch(openStore("memory:"), { now: () => now }), 9000);
});
