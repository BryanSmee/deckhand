// The store (lib/store.mjs): the shared suite on each backend, then what the file backend
// adds, everything kept across a restart.
import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../lib/store.mjs";
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
  const writes = [
    () => store.set("app", { key: pem }),
    () => store.setIfAbsent("signing", signingKey),
    () => store.compareAndSet("signing", null, `prefix ${signingKey.slice(0, 20)}`),
    () => store.append("runs", { token }),
    () => store.putBlob("log", Buffer.from(`key: ${signingKey}`)),
    () => store.appendBlob("log", `${token}\n`),
  ];
  for (const write of writes) await assert.rejects(write(), /a secret can't go in the store/);
  // Nothing of them was written.
  assert.equal(await store.get("app"), null);
  assert.equal(await store.get("signing"), null);
  assert.deepEqual(await store.read("runs", "edge"), []);
  assert.equal(await store.readBlob("log"), null);
  // The rest goes through.
  await store.set("app", { id: 42 });
  assert.deepEqual(await store.get("app"), { id: 42 });
  assert.ok(!readFileSync(join(dir, "state.json"), "utf8").includes("signing-0123"));
});
