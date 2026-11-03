// The store (lib/store.mjs): the shared suite on each backend, then what the file backend
// adds, everything kept across a restart.
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { sealWith } from "../lib/seal.mjs";
import { nextEpoch, openStore, storable, values } from "../lib/store.mjs";
import { fileStore } from "../lib/store-file.mjs";
import { isRoot, needsModes, needsPosixRename, tempDir } from "./helpers.mjs";
import { storeContract } from "./store-contract.mjs";

storeContract("memory", (t, clock) => fileStore({ now: clock.now }));
storeContract("file", (t, clock) => fileStore({ dir: tempDir(t), now: clock.now }));

test("file: calls made together are written together, each on disk once it resolves", async (t) => {
  const dir = tempDir(t);
  const store = fileStore({ dir });
  const other = fileStore({ dir });
  // A burst, as a map's items moved at start (store-map.mjs): one batch, one write of the file.
  const writes = Array.from({ length: 500 }, (_, i) => store.set(`k/${i}`, i));
  // One call of the batch failing fails alone.
  const bad = store.set("k/bad", undefined);
  const read = store.get("k/1");
  await Promise.all(writes);
  await assert.rejects(bad, TypeError);
  assert.equal(await read, 1);
  // Another process reads them all once they resolved.
  assert.equal(await other.get("k/499"), 499);
  assert.equal((await other.keys("k/", { count: 1000 })).keys.length, 500);
});

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

// A state file another user's process wrote (the root orchestrator of the release before, #536):
// read as empty, the next save would write over the queue and the consumers for good.
test(
  "file: a state file it can't read stops it, rather than being taken for empty and written over",
  { skip: (isRoot && "root reads anywhere") || needsModes },
  async (t) => {
    const dir = tempDir(t);
    const before = fileStore({ dir });
    await before.set("queue", ["kept"]);
    await before.close();
    const state = join(dir, "state.json");
    const saved = readFileSync(state, "utf8");
    chmodSync(state, 0o000);
    assert.throws(() => fileStore({ dir }), { code: "EACCES" });
    chmodSync(state, 0o600);
    assert.equal(readFileSync(state, "utf8"), saved);
    assert.deepEqual(await fileStore({ dir }).get("queue"), ["kept"]);
  },
);

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

// Two processes on one folder (#506): a service's two copies on one node, one acting and one
// waiting for its lease, each its own fileStore().
test("file: two copies on one folder see each other's keys, leases and streams at once", async (t) => {
  const dir = tempDir(t);
  const a = fileStore({ dir });
  const b = fileStore({ dir });
  await a.set("k", 1);
  assert.equal(await b.get("k"), 1);
  assert.equal(await a.setIfAbsent("delivery/g", 1), true);
  assert.equal(await b.setIfAbsent("delivery/g", 1), false);
  // A lease is one copy's; released, the other takes it at once, with a higher epoch.
  const held = await a.acquire("orchestrator", "a", { ttlMs: 60_000 });
  assert.equal(await b.acquire("orchestrator", "b", { ttlMs: 60_000 }), null);
  assert.equal(await a.release("orchestrator", "a", held.epoch), true);
  const taken = await b.acquire("orchestrator", "b", { ttlMs: 60_000 });
  assert.ok(taken.epoch > held.epoch);
  assert.equal(await a.renew("orchestrator", "a", held.epoch, { ttlMs: 60_000 }), null);
  // One appends, the other reads and acknowledges: the first sees it acknowledged.
  const id = await a.append("deliveries", { n: 1 });
  assert.deepEqual(await b.read("deliveries", "orchestrator"), [{ id, event: { n: 1 } }]);
  assert.equal(await b.ack("deliveries", "orchestrator", [id]), 1);
  assert.deepEqual(await a.read("deliveries", "orchestrator"), []);
  const next = await b.append("deliveries", { n: 2 });
  assert.ok(Number(next) > Number(id));
  assert.deepEqual(await a.read("deliveries", "orchestrator"), [{ id: next, event: { n: 2 } }]);
  // A stream one rewrote (a trim) is read again whole by the other.
  for (let n = 3; n < 10; n++) await a.append("short", { n }, { maxLength: 2 });
  assert.deepEqual(
    (await b.read("short", "c")).map((e) => e.event.n),
    [8, 9],
  );
});

test(
  "file: two processes' increments on one folder are never lost; a crashed one's lock is taken over",
  { skip: needsPosixRename },
  async (t) => {
    const dir = tempDir(t);
    const script = `
    import { fileStore } from ${JSON.stringify(new URL("../lib/store-file.mjs", import.meta.url).href)};
    const store = fileStore({ dir: process.argv[1] });
    for (let i = 0; i < 100; i++) await store.increment("n");
  `;
    const { spawn } = await import("node:child_process");
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    await Promise.all([run(), run()]);
    assert.equal(await fileStore({ dir }).get("n"), 200);
    // A lock left behind, old enough: not waited for forever.
    writeFileSync(join(dir, "state.lock"), "12345");
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "state.lock"), old, old);
    assert.equal(await fileStore({ dir }).increment("n"), 201);
    // Left behind again, and four processes racing to take it over: one at a time, none lost
    // (a takeover never removes the lock another process made anew).
    for (let round = 0; round < 3; round++) {
      writeFileSync(join(dir, "state.lock"), "12345");
      utimesSync(join(dir, "state.lock"), old, old);
      await Promise.all([run(), run(), run(), run()]);
    }
    assert.equal(await fileStore({ dir }).get("n"), 201 + 3 * 400);
  },
);

test("file: acknowledged with drop, a stream's events leave its memory and, past 100, its file (#506)", async (t) => {
  const dir = tempDir(t);
  const store = fileStore({ dir });
  for (let n = 0; n < 250; n++) {
    const id = await store.append("deliveries", { n, text: "x".repeat(1000) });
    await store.read("deliveries", "orchestrator");
    await store.ack("deliveries", "orchestrator", [id], { drop: true });
  }
  const file = readFileSync(join(dir, "streams", "deliveries.jsonl"), "utf8");
  assert.ok(file.split("\n").filter(Boolean).length < 100, "acknowledged lines kept");
  // Read again from the folder (a restart, the other copy): none of them comes back.
  const again = fileStore({ dir });
  assert.deepEqual(await again.read("deliveries", "another"), []);
  const id = await again.append("deliveries", { n: 250 });
  assert.equal(Number(id), 251);
});

test("file: a stream whose file was rewritten empty (every event dropped) goes on from its next id", async (t) => {
  const dir = tempDir(t);
  const store = fileStore({ dir });
  // Opened before the rewrite: edge's other copy.
  const other = fileStore({ dir });
  await other.read("deliveries", "orchestrator");
  for (let n = 1; n <= 100; n++) {
    const id = await store.append("deliveries", { n });
    await store.read("deliveries", "orchestrator");
    await store.ack("deliveries", "orchestrator", [id], { drop: true });
  }
  assert.equal(readFileSync(join(dir, "streams", "deliveries.jsonl"), "utf8"), "");
  // The other copy appends next, then a store opened anew (a restart): ids go on, and the
  // orchestrator reads both.
  assert.equal(await other.append("deliveries", { n: 101 }), "101");
  const restarted = fileStore({ dir });
  assert.equal(await restarted.append("deliveries", { n: 102 }), "102");
  assert.deepEqual(
    (await restarted.read("deliveries", "orchestrator")).map((e) => e.event.n),
    [101, 102],
  );
});

test("file: an earlier event still pending while later ones are dropped: ids never handed out twice", async (t) => {
  const dir = tempDir(t);
  const store = fileStore({ dir });
  const other = fileStore({ dir });
  await other.read("deliveries", "orchestrator");
  const ids = [];
  for (let n = 1; n <= 101; n++) ids.push(await store.append("deliveries", { n }));
  await store.read("deliveries", "orchestrator", { count: 200 });
  // The first still handled (retried, say) while the 100 after it are done.
  for (const id of ids.slice(1))
    await store.ack("deliveries", "orchestrator", [id], { drop: true });
  assert.equal(
    readFileSync(join(dir, "streams", "deliveries.jsonl"), "utf8")
      .trim()
      .split("\n").length,
    1,
  );
  // The other copy, and a store opened anew, append next: their ids follow the last one.
  assert.equal(await other.append("deliveries", { n: 102 }), "102");
  const restarted = fileStore({ dir });
  assert.equal(await restarted.append("deliveries", { n: 103 }), "103");
  await restarted.ack("deliveries", "orchestrator", [ids[0]], { drop: true });
  assert.deepEqual(
    (await restarted.read("deliveries", "orchestrator")).map((e) => e.event.n),
    [102, 103],
  );
});

test("file: a stream rewritten twice by another copy is read again whole, its inode reused or not", async (t) => {
  const dir = tempDir(t);
  const a = fileStore({ dir });
  const b = fileStore({ dir });
  for (let n = 1; n <= 3; n++) await a.append("deliveries", { n });
  // B has the stream cached: three events, their bytes.
  assert.equal((await b.read("deliveries", "orchestrator")).length, 3);
  // Its file's inode, kept aside by a second name.
  const kept = join(dir, "kept-inode");
  linkSync(join(dir, "streams", "deliveries.jsonl"), kept);
  await b.ack("deliveries", "orchestrator", ["1", "2", "3"], { drop: true });
  // A handles 200 more, two rewrites (a rename may hand the second the first's inode), then 5.
  for (let n = 4; n <= 203; n++) {
    const id = await a.append("deliveries", { n });
    await a.read("deliveries", "orchestrator");
    await a.ack("deliveries", "orchestrator", [id], { drop: true });
  }
  for (let n = 204; n <= 208; n++) await a.append("deliveries", { n, text: "x".repeat(50) });
  // The inode B cached handed back to the file, as a rename may: the file as A left it, under it.
  const path = join(dir, "streams", "deliveries.jsonl");
  const now = readFileSync(path);
  writeFileSync(kept, now);
  renameSync(kept, path);
  // B's next append follows A's, and the orchestrator reads all six.
  assert.equal(await b.append("deliveries", { n: 209 }), "209");
  assert.equal(await a.append("deliveries", { n: 210 }), "210");
  assert.deepEqual(
    (await a.read("deliveries", "orchestrator")).map((e) => e.event.n),
    [204, 205, 206, 207, 208, 209, 210],
  );
});

test("a sealed value is never refused for a token's shape, and one sealed in base64url still opens", async () => {
  const store = openStore("memory:");
  const { seal, open } = sealWith(randomBytes(32), "test");
  // No `_` (nor `-`) for a token's shape to start from, however many seals.
  const sealed = seal("x".repeat(600));
  assert.doesNotMatch(sealed, /[_-]/);
  for (let i = 0; i < 2000; i++) await store.set("sealed", seal(randomBytes(400).toString("hex")));
  // What earlier copies wrote, base64url: read back the same.
  const urlSafe = sealed
    .split(".")
    .map((part) => Buffer.from(part, "base64").toString("base64url"))
    .join(".");
  assert.equal(open(urlSafe), "x".repeat(600));
  assert.equal(open(sealed), "x".repeat(600));
});

test("values(): a key listed again on a later page comes once, one gone before its get() not at all", async () => {
  // Pages as Redis's SCAN may give them: "a" on two of them, an empty one before the last.
  const pages = [
    { keys: ["a", "b"], cursor: "1" },
    { keys: [], cursor: "2" },
    { keys: ["a", "c", "gone"], cursor: null },
  ];
  const asked = [];
  const store = {
    keys: async (prefix, { cursor }) => {
      asked.push([prefix, cursor]);
      return pages[cursor === null ? 0 : Number(cursor)];
    },
    get: async (key) => (key === "gone" ? null : `value of ${key}`),
  };
  assert.deepEqual(await Array.fromAsync(values(store, "p/")), [
    ["a", "value of a"],
    ["b", "value of b"],
    ["c", "value of c"],
  ]);
  assert.deepEqual(asked, [
    ["p/", null],
    ["p/", "1"],
    ["p/", "2"],
  ]);
});
