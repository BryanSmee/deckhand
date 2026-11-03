// The orchestrator's maps in the store, one key per item (lib/store-map.mjs, #615): each change
// writes its key alone, a JSON file from before is moved once, and the writes wait out a store
// that is away.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { openStore, values } from "../lib/store.mjs";
import { storeMap, storeMaps } from "../lib/store-map.mjs";
import { isRoot, needsModes, tempDir } from "./helpers.mjs";

// `store` with its calls recorded, and failing while `down.is`.
function recorded(store) {
  const calls = [];
  const down = { is: false };
  const wrap =
    (name) =>
    async (...args) => {
      if (down.is) throw new Error("the store is away");
      calls.push([name, ...args]);
      return store[name](...args);
    };
  return {
    store: { ...store, set: wrap("set"), delete: wrap("delete"), setIfAbsent: wrap("setIfAbsent") },
    calls,
    down,
  };
}

const all = async (store, prefix) => {
  const found = {};
  for await (const [key, value] of values(store, prefix)) found[key] = value;
  return found;
};

test("storeMap: a Map whose changes write their own key alone, read back by the next copy", async () => {
  const { store, calls } = recorded(openStore("memory:"));
  const map = await storeMap(store, "pulls");
  for (let n = 1; n <= 50; n++) map.set(`org/repo#${n}`, { number: n });
  await map.settled();
  calls.length = 0;

  map.set("org/repo#7", { number: 70 });
  map.delete("org/repo#8");
  assert.equal(map.delete("org/repo#404"), false);
  assert.equal(map.get("org/repo#7").number, 70);
  assert.equal(map.size, 49);
  await map.settled();
  assert.deepEqual(calls, [
    ["set", "pulls/org/repo#7", { number: 70 }],
    ["delete", "pulls/org/repo#8"],
  ]);

  const next = await storeMap(store, "pulls");
  assert.equal(next.size, 49);
  assert.deepEqual(next.get("org/repo#7"), { number: 70 });
  assert.equal(next.has("org/repo#8"), false);
  // Another map's keys aren't its own.
  assert.equal((await storeMap(store, "pull")).size, 0);
});

test("storeMap: the value as it was set, though its caller changes it after", async () => {
  const store = openStore("memory:");
  const map = await storeMap(store, "lanes");
  const entry = { key: "org/app#1", name: "Before" };
  map.set("org/app#1", entry);
  entry.name = "Changed in place";
  await map.settled();
  assert.deepEqual(await store.get("lanes/org/app#1"), { key: "org/app#1", name: "Before" });
  map.clear();
  await map.settled();
  assert.deepEqual(await all(store, "lanes/"), {});
});

test("storeMap: no null or undefined, which the store wouldn't read back or keep", async () => {
  const map = await storeMap(openStore("memory:"), "closed");
  assert.throws(() => map.set("org/repo#1", null), TypeError);
  assert.throws(() => map.set("org/repo#1", undefined), TypeError);
  assert.equal(map.has("org/repo#1"), false);
  assert.equal(map.waiting(), 0);
});

test("storeMap: after a crash, a new process reads what was written (the file store)", async (t) => {
  const url = pathToFileURL(join(tempDir(t), "store")).href;
  const first = openStore(url);
  const map = await storeMap(first, "titles");
  map.set("org/repo#1", "One");
  map.set("org/repo#2", "Two");
  map.delete("org/repo#2");
  await map.settled();
  // No close(): what is written is there anyway.
  const again = await storeMap(openStore(url), "titles");
  assert.deepEqual([...again], [["org/repo#1", "One"]]);
});

test("storeMap: people's text goes without a secret, rather than refused whole", async () => {
  const secret = "s3cr3t-value-of-the-operator";
  const store = openStore("memory:", { secrets: () => [secret] });
  const map = await storeMap(store, "titles", { secrets: () => [secret] });
  map.set("org/repo#1", `Leaked ${secret} in a title`);
  await map.settled();
  assert.equal(await store.get("titles/org/repo#1"), "Leaked [redacted] in a title");
  // In memory, as it was set.
  assert.equal(map.get("org/repo#1"), `Leaked ${secret} in a title`);
});

test("storeMap: a file from the release before is moved, then removed; moved twice, nothing changes", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "order.json");
  const legacy = { "org/app#3": { key: "org/app#3" }, "org/app#1": { key: "Org/app#1" } };
  writeFileSync(file, JSON.stringify(legacy));
  const { store, calls } = recorded(openStore("memory:"));
  const logs = [];
  const moved = (entries) => entries.map(([k, v], i) => [k, { ...v, rank: i }]);
  const map = await storeMap(store, "order", { file, moved, log: (line) => logs.push(line) });
  assert.equal(existsSync(file), false);
  assert.deepEqual(Object.fromEntries(map), {
    "org/app#3": { key: "org/app#3", rank: 0 },
    "org/app#1": { key: "Org/app#1", rank: 1 },
  });
  assert.match(logs[0], /order: 2 item\(s\) moved to the store/);

  // A crash before the file went: moved again, the store's values kept (the same ones, or a
  // newer one written since).
  map.set("org/app#1", { key: "org/app#1", rank: 5 });
  await map.settled();
  writeFileSync(file, JSON.stringify(legacy));
  calls.length = 0;
  const again = await storeMap(store, "order", { file, moved });
  assert.equal(existsSync(file), false);
  assert.deepEqual(again.get("org/app#1"), { key: "org/app#1", rank: 5 });
  assert.deepEqual(again.get("org/app#3"), { key: "org/app#3", rank: 0 });
  assert.deepEqual(
    calls.map(([name, key]) => [name, key]),
    [
      ["setIfAbsent", "order/org/app#3"],
      ["setIfAbsent", "order/org/app#1"],
    ],
  );
  // No file: nothing moved, nothing written.
  calls.length = 0;
  assert.equal((await storeMap(store, "order", { file, moved })).size, 2);
  assert.deepEqual(calls, []);
});

test("storeMap: a file's null items aren't moved; a file that can't be read is left, and said", async (t) => {
  const dir = tempDir(t);
  const store = openStore("memory:");
  // closed.json from before: an issue seen open is null there.
  const file = join(dir, "closed.json");
  writeFileSync(file, JSON.stringify({ "o/r#1": null, "o/r#2": "completed" }));
  const closed = await storeMap(store, "closed", { file });
  assert.deepEqual([...closed], [["o/r#2", "completed"]]);
  assert.deepEqual((await store.keys("closed/")).keys, ["closed/o/r#2"]);
  assert.equal(existsSync(file), false);

  // Cut short by a crash: its items stay where they are, for the operator.
  const half = join(dir, "titles.json");
  writeFileSync(half, '{"o/r#1": "A');
  const logs = [];
  const titles = await storeMap(store, "titles", { file: half, log: (line) => logs.push(line) });
  assert.equal(titles.size, 0);
  assert.equal(readFileSync(half, "utf8"), '{"o/r#1": "A');
  assert.match(logs.join("\n"), /titles\.json: not moved to the store, left as it is/);
  // Nor one that isn't a map.
  writeFileSync(half, "[1]");
  await storeMap(store, "titles", { file: half, log: (line) => logs.push(line) });
  assert.equal(existsSync(half), true);
  assert.match(logs.at(-1), /not a map/);
});

test(
  "storeMap: a file it may not read is left, and said",
  { skip: (isRoot && "root reads anything") || needsModes },
  async (t) => {
    const dir = tempDir(t);
    const file = join(dir, "pulls.json");
    writeFileSync(file, JSON.stringify({ "o/r#1": { number: 2 } }));
    chmodSync(file, 0o000);
    const logs = [];
    const map = await storeMap(openStore("memory:"), "pulls", {
      file,
      log: (line) => logs.push(line),
    });
    assert.equal(map.size, 0);
    assert.equal(existsSync(file), true);
    assert.match(logs[0], /pulls\.json: not moved to the store, left as it is: EACCES/);
  },
);

test("storeMap: with the store away, the writes wait and land in order once it is back", async () => {
  const { store, calls, down } = recorded(openStore("memory:"));
  const logs = [];
  // The retries' waits, released by the test.
  const sleeps = [];
  const sleep = () => new Promise((resolve) => sleeps.push(resolve));
  const map = await storeMap(store, "modes", { sleep, log: (line) => logs.push(line) });
  const retry = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    for (const resolve of sleeps.splice(0)) resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };

  down.is = true;
  map.set("org/repo#1", "review");
  map.set("org/repo#2", "audit");
  await retry();
  // A later write of a key replaces one still waiting: the store ends with the last.
  map.set("org/repo#1", "research");
  map.delete("org/repo#2");
  map.set("org/repo#3", "brainstorm");
  assert.equal(map.waiting(), 3);
  await retry();
  await retry();
  assert.deepEqual(calls, []);
  assert.equal(logs.filter((line) => /org\/repo#1: the store is away/.test(line)).length, 1);

  down.is = false;
  let settled = false;
  map.settled().then(() => (settled = true));
  await retry();
  await retry();
  assert.equal(settled, true);
  assert.equal(map.waiting(), 0);
  assert.deepEqual(await all(store, "modes/"), {
    "modes/org/repo#1": "research",
    "modes/org/repo#3": "brainstorm",
  });
  // Each key's writes in order: #1's last value after its first, #2's delete after its set,
  // or never set at all.
  const of = (key) => calls.filter(([, k]) => k === key);
  assert.deepEqual(of("modes/org/repo#1").at(-1), ["set", "modes/org/repo#1", "research"]);
  assert.notEqual(of("modes/org/repo#2").at(-1)?.[0], "set");
  assert.ok(logs.some((line) => line === "modes/org/repo#1: written"));
});

test("storeMap: the lease lost, the writes still waiting are given up", async () => {
  const { store, calls, down } = recorded(openStore("memory:"));
  let held = true;
  const sleeps = [];
  const sleep = () => new Promise((resolve) => sleeps.push(resolve));
  const map = await storeMap(store, "requested", { sleep, held: () => held });
  down.is = true;
  map.set("org/repo#pr-1", { head: "abc" });
  await new Promise((resolve) => setImmediate(resolve));
  held = false;
  down.is = false;
  const settled = map.settled();
  for (const resolve of sleeps.splice(0)) resolve();
  await settled;
  assert.deepEqual(calls, []);
  assert.equal(map.waiting(), 0);
});

test("storeMap: a write ordered after another waits for it, and so do the key's later writes", async () => {
  const { store, calls } = recorded(openStore("memory:"));
  const map = await storeMap(store, "waits");
  map.set("org/repo#1", { blockers: [7] });
  map.set("org/repo#2", { blockers: [8] });
  await map.settled();
  calls.length = 0;
  let queued;
  const after = new Promise((resolve) => (queued = resolve));
  map.delete("org/repo#1", { after });
  // Another key goes on; this one, its later write too, waits for the queue.
  map.set("org/repo#2", { blockers: [9] });
  await map.written("org/repo#2");
  let written = false;
  map.written("org/repo#1").then(() => (written = true));
  await new Promise((resolve) => setImmediate(resolve));
  map.set("org/repo#1", { blockers: [], answers: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written, false);
  assert.deepEqual(calls, [["set", "waits/org/repo#2", { blockers: [9] }]]);
  assert.equal(map.waiting(), 1);
  queued();
  await map.written("org/repo#1");
  assert.equal(written, true);
  assert.deepEqual(calls.slice(1), [["set", "waits/org/repo#1", { blockers: [], answers: true }]]);
  // A gate that fails is no reason to keep the write back.
  map.delete("org/repo#2", { after: Promise.reject(new Error("the queue's write failed")) });
  await map.settled();
  assert.deepEqual(calls.at(-1), ["delete", "waits/org/repo#2"]);
  await map.written("org/repo#404");
});

test("storeMaps: each map from its file in a folder, settled() and waiting() over all", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "titles.json"), JSON.stringify({ "o/r#1": "A" }));
  const store = openStore("memory:");
  const state = await storeMaps(store, { titles: {}, closed: {} }, { dir });
  assert.equal(state.maps.titles.get("o/r#1"), "A");
  assert.equal(existsSync(join(dir, "titles.json")), false);
  state.maps.closed.set("o/r#1", "completed");
  assert.equal(state.waiting(), 1);
  await state.settled();
  assert.equal(state.waiting(), 0);
  assert.equal(await store.get("closed/o/r#1"), "completed");
  // Nothing written to the folder.
  assert.throws(() => readFileSync(join(dir, "closed.json")), { code: "ENOENT" });
});
