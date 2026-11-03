// The calls to the broker service (listener/broker-service.mjs, #505), the orchestrator's and the
// runner's: the runs' inboxes copied from the runner's files, a lost answer or a broker away
// caught up with; the stream's screenshots left at the broker, and those an older orchestrator
// kept moved there and removed with their run; the runs that ended while the orchestrator was down
// ended there too.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createCallers } from "../broker/callers.mjs";
import { createBroker, storeSecrets } from "../broker/server.mjs";
import { createRuns } from "../broker/runs.mjs";
import { createBroker as createListenerBroker } from "../listener/broker.mjs";
import { createBrokerService } from "../listener/broker-service.mjs";
import { createInbox } from "../listener/runner/inbox.mjs";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { openStore } from "../lib/store.mjs";
import { signToken, TOKEN_VERSION } from "../lib/tokens.mjs";
import { listenToRestart, needsBash, tempDir, testKey } from "./helpers.mjs";

const FOLDER = "0123456789abcdef01234567";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

// Where each caller reaches the broker: the address a call arrives at tells them apart.
const AT = { orchestrator: "127.0.0.1", runner: "127.0.0.2" };

// The broker service on loopback, called as the orchestrator and as the runner; on `port` (none:
// listenToRestart()'s), so a test can stop it and start it again where it was.
async function service(t, { store = openStore("memory:"), key = testKey(), port = null } = {}) {
  const broker = createBroker({
    store,
    key,
    callers: createCallers({ networks: "orchestrator=127.0.0.1/32,runner=127.0.0.2/32" }),
  });
  if (port === null) await listenToRestart(broker.server, "0.0.0.0");
  else await new Promise((resolve) => broker.server.listen(port, "0.0.0.0", resolve));
  broker.server.unref();
  const stop = () =>
    new Promise((resolve) => {
      broker.server.closeAllConnections();
      broker.server.close(resolve);
    });
  t.after(stop);
  return { ...broker, store, key, port: broker.server.address().port, stop };
}

// `as`: the service calling, the orchestrator (its runs, its stream) or the runner (the inboxes
// and files it copies there).
function remote(t, broker, { as = "orchestrator", logged = [] } = {}) {
  const made = createBrokerService({
    caller: createBrokerCaller({ url: `http://${AT[as]}:${broker.port}` }),
    epoch: () => 1,
    log: (line) => logged.push(line),
  });
  t.after(() => made.stop());
  return made;
}

async function until(check, ms = 12_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("an inbox: the runner's file copied from the offset the broker has, a broker away caught up with", async (t) => {
  const store = openStore("memory:");
  const key = testKey();
  let broker = await service(t, { store, key });
  const logged = [];
  const listener = remote(t, broker, { as: "runner", logged });
  const file = join(tempDir(t), "inbox.jsonl");
  writeFileSync(file, "");
  const bytesFrom = (from) => readFileSync(file).subarray(from);
  const blob = async () => (await store.readBlob("inbox:run-a"))?.toString() ?? null;
  await listener.mirror.sync("run-a", bytesFrom);
  assert.equal(await blob(), "");
  writeFileSync(file, "one\n", { flag: "a" });
  await listener.mirror.sync("run-a", bytesFrom);
  assert.equal(await blob(), "one\n");
  // The broker away: what comes meanwhile waits, and goes once it is back.
  const { port } = broker;
  await broker.stop();
  writeFileSync(file, "two\n", { flag: "a" });
  await assert.rejects(listener.mirror.sync("run-a", bytesFrom));
  broker = await service(t, { store, key, port });
  await until(async () => (await blob()) === "one\ntwo\n");
  assert.ok(logged.some((line) => /inbox .*trying again/.test(line)));
  // A broker that has less than the listener thinks (another store): from what it has.
  await store.deleteBlob("inbox:run-a");
  await store.putBlob("inbox:run-a", "one\n");
  writeFileSync(file, "three\n", { flag: "a" });
  await listener.mirror.sync("run-a", bytesFrom);
  assert.equal(await blob(), "one\ntwo\nthree\n");
});

test("the stream: a screenshot said, left at the broker, acknowledged", async (t) => {
  const broker = await service(t);
  const listener = remote(t, broker);
  const { token } = await listener.issuer.issue("run-a", {
    repo: "org/a",
    sandbox: "net-a",
    shots: FOLDER,
  });
  const seen = [];
  listener.consume({ handlers: { started: async (e) => seen.push(e.type) } });
  const record = await broker.runs.get("run-a");
  const image = Buffer.concat([PNG, Buffer.from("x")]);
  assert.equal((await broker.files.putShot(upload(image), record, "page.png")).status, 204);
  await until(async () => (await broker.store.read("runs", "orchestrator")).length === 0);
  assert.deepEqual(seen, ["started"]);
  // The broker keeps it (#609): the orchestrator copies nothing.
  assert.deepEqual(await broker.files.getShot(FOLDER, "page.png"), image);
  assert.ok(token);
});

// An upload's request, as files.putShot() reads it: its body, then its headers.
const upload = (body) =>
  Object.assign(
    (async function* () {
      yield body;
    })(),
    { headers: {} },
  );

test("the screenshots an older orchestrator kept: moved to the broker, regular files only, then removed with their run", async (t) => {
  let broker = await service(t);
  const logged = [];
  const listener = remote(t, broker, { logged });
  const dataDir = tempDir(t);
  const shotsDir = join(dataDir, "shots");
  const dir = join(shotsDir, FOLDER);
  mkdirSync(dir, { recursive: true });
  const image = Buffer.concat([PNG, Buffer.from("page")]);
  writeFileSync(join(dir, "page.png"), image);
  // Not an image (a sandbox of an older release wrote these folders): dropped.
  writeFileSync(join(dir, "fake.png"), "GIF89a");
  // Links, wherever they point, and a file linked twice: never read (the orchestrator's App,
  // here a PNG's first bytes to pass the broker's check).
  writeFileSync(join(dataDir, "app.json"), Buffer.concat([PNG, Buffer.from("secret")]));
  symlinkSync(join(dataDir, "app.json"), join(dir, "absolute.png"));
  symlinkSync("../../app.json", join(dir, "relative.png"));
  symlinkSync("page.png", join(dir, "sibling.png"));
  symlinkSync(dataDir, join(dir, "dir.png"));
  // A folder that is a link (listed first): nothing follows it either.
  symlinkSync(dir, join(shotsDir, "0000000000000000000000aa"));
  linkSync(join(dataDir, "app.json"), join(dir, "hard.png"));
  // A FIFO would block a plain open until something writes it (a regression hangs here).
  if (!needsBash) execFileSync("mkfifo", [join(dir, "fifo.png")]);
  // A folder retention would have removed, and what isn't a run's folder.
  const forgotten = "f".repeat(24);
  mkdirSync(join(shotsDir, forgotten));
  writeFileSync(join(shotsDir, forgotten, "old.png"), image);
  mkdirSync(join(shotsDir, "not-a-run"));
  // The broker away: the folders stay, for the next try.
  const { port, store, key } = broker;
  await broker.stop();
  const drop = (folder) => folder === forgotten;
  await assert.rejects(listener.moveShots(shotsDir, { drop }));
  assert.ok(existsSync(join(dir, "page.png")));
  broker = await service(t, { store, key, port });
  assert.equal(await listener.moveShots(shotsDir, { drop }), 1);
  assert.deepEqual(await broker.files.getShot(FOLDER, "page.png"), image);
  for (const name of ["fake.png", "absolute.png", "relative.png", "sibling.png", "hard.png"]) {
    assert.equal(await broker.files.getShot(FOLDER, name), null, name);
  }
  assert.equal(await broker.files.getShot("0000000000000000000000aa", "page.png"), null);
  assert.equal(await broker.files.getShot(forgotten, "old.png"), null);
  assert.ok(logged.some((line) => /fake\.png refused by the broker \(415\), dropped/.test(line)));
  // Every run's folder is gone; the rest isn't the orchestrator's to remove.
  assert.deepEqual(readdirSync(shotsDir), ["not-a-run"]);
  assert.equal(await listener.moveShots(shotsDir), 0);
  assert.equal(await listener.moveShots(join(dataDir, "none")), 0);
  // Retention: the run's screenshots go at the broker.
  await listener.removeShots(FOLDER);
  assert.equal(await broker.files.getShot(FOLDER, "page.png"), null);
});

test("the runs the broker still has that ended while the listener was down end there; an end not heard is told again", async (t) => {
  const store = openStore("memory:");
  const key = testKey();
  let broker = await service(t, { store, key });
  const listener = remote(t, broker);
  for (const id of ["going", "gone"]) {
    await listener.issuer.issue(id, { repo: "org/a", sandbox: `net-${id}` });
  }
  await listener.reconcile(() => ["going"]);
  assert.deepEqual(await broker.runs.list(), ["going"]);
  // Its end while the broker is away: told again once it is back.
  const { port } = broker;
  await broker.stop();
  await listener.issuer.end("going");
  broker = await service(t, { store, key, port });
  await until(async () => (await broker.runs.list()).length === 0);
});

test("a token signed with a key the listener doesn't have yet: the keys read again, at most every 30 s", async (t) => {
  const broker = await service(t);
  const listener = remote(t, broker);
  // Its keys never read (a broker whose key changed since, say): the token's check asks again.
  const listenerBroker = createListenerBroker({
    issuer: listener.issuer,
    keys: listener.keys,
    unknownKey: listener.unknownKey,
    sandboxOf: async () => "net-a",
  });
  listenerBroker.register("org/a", { id: "run-a" });
  const { token } = await listenerBroker.issue("run-a", "net-a");
  assert.equal(listener.keys().has(broker.key.kid), false);
  assert.equal((await listenerBroker.check(token, "10.0.0.2")).run.id, "run-a");
  assert.equal(listener.keys().has(broker.key.kid), true);
  // A forged kid right after: not read again.
  const forged = signToken(
    { ver: TOKEN_VERSION, jti: "run-a", sandbox: "net-a" },
    { ...testKey(), audience: "deckhand:broker", ttlMs: 60_000 },
  );
  let asked = 0;
  const counting = createListenerBroker({
    keys: listener.keys,
    unknownKey: () => (asked++, listener.unknownKey()),
  });
  assert.match((await counting.check(forged, "10.0.0.2")).message, /unknown key/);
  assert.equal(asked, 1);
});

test("the runner's inbox: a token's shape in a message redacted before it is written, its copy the same bytes", async (t) => {
  const inboxDir = tempDir(t);
  const copied = [];
  const inbox = createInbox({
    inboxDir,
    mirror: {
      files: async () => {},
      sync: async (run, bytesFrom) => copied.push(bytesFrom(0).toString()),
      forget: () => {},
    },
  });
  await inbox.write("r1", null, null);
  inbox.send("r1", `my token is ghp_${"b".repeat(36)}, revoked`);
  const file = readFileSync(join(inboxDir, "r1", "inbox.jsonl"), "utf8");
  assert.match(file, /my token is \[redacted\], revoked/);
  assert.ok(!file.includes("ghp_"));
  JSON.parse(file);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(copied.at(-1), file);
});

test("a message quoting a PEM's armour goes through send() and the broker whole; the broker's own key never does", async (t) => {
  // The store as the broker opens it: its key's own part is the secret, not the armour.
  const key = testKey();
  const store = openStore("memory:", { secrets: () => storeSecrets(key) });
  const broker = await service(t, { store, key });
  const listener = remote(t, broker, { as: "runner" });
  const inboxDir = tempDir(t);
  const inbox = createInbox({ inboxDir, mirror: listener.mirror });
  await inbox.write("r1", null, null);
  const other = testKey().privateKey.export({ type: "pkcs8", format: "pem" });
  inbox.send("r1", `A fixture's key, for the test:\n${other}`);
  const file = () => readFileSync(join(inboxDir, "r1", "inbox.jsonl"));
  await until(async () => (await store.readBlob("inbox:r1"))?.equals(file()));
  assert.match(file().toString(), /BEGIN PRIVATE KEY/);
  // The broker's own key is refused there, and what follows waits behind it.
  const own = key.privateKey.export({ type: "pkcs8", format: "pem" });
  const before = await store.readBlob("inbox:r1");
  inbox.send("r1", own);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(await store.readBlob("inbox:r1"), before);
});

test("an expired run's files go, unless its id started again before they did", async () => {
  const store = openStore("memory:");
  const removed = [];
  const runs = createRuns({ store, key: testKey(), expired: async (id) => removed.push(id) });
  await runs.issue("gone", { repo: "o/r", sandbox: "net-1" });
  await runs.issue("again", { repo: "o/r", sandbox: "net-2" });
  await store.delete("run:gone");
  // "again" found expired, then started anew before its files went.
  const get = store.get;
  let first = true;
  store.get = async (name) => {
    if (name === "run:again" && first) return ((first = false), null);
    return get(name);
  };
  assert.deepEqual(await runs.list(), []);
  assert.deepEqual(removed, ["gone"]);
});

test("an inbox over the broker's limit: a restarted runner asks what the broker has, then sends the rest in parts", async (t) => {
  const store = openStore("memory:");
  const broker = await service(t, { store });
  const file = join(tempDir(t), "inbox.jsonl");
  // 9 MiB of lines, over the 8 MiB one append may carry.
  const line = `${JSON.stringify({ text: "x".repeat(1000) })}\n`;
  writeFileSync(file, line.repeat(Math.ceil((9 * 1024 * 1024) / line.length)));
  const bytesFrom = (from) => readFileSync(file).subarray(from);
  const first = remote(t, broker, { as: "runner" });
  await first.mirror.sync("run-a", bytesFrom);
  assert.deepEqual(await store.readBlob("inbox:run-a"), readFileSync(file));
  // The next runner knows nothing of it: a line more, and only it goes.
  writeFileSync(file, '{"text":"after"}\n', { flag: "a" });
  const appended = [];
  const appendBlobAt = store.appendBlobAt;
  store.appendBlobAt = async (key, at, data) => (
    appended.push(data.length),
    appendBlobAt(key, at, data)
  );
  const next = remote(t, broker, { as: "runner" });
  await next.mirror.sync("run-a", bytesFrom);
  assert.deepEqual(await store.readBlob("inbox:run-a"), readFileSync(file));
  assert.deepEqual(appended, [0, 17]);
});

test("a renewal from a run's old sandbox, the run started again elsewhere meanwhile, is refused", async () => {
  const inner = openStore("memory:");
  const runs = createRuns({ store: inner, key: testKey() });
  const { token } = await runs.issue("r", { repo: "o/r", sandbox: "net-old" });
  // Between the check and the update (another copy's issue()): the run bound to net-new.
  const get = inner.get;
  let reads = 0;
  inner.get = async (name) => {
    const value = await get(name);
    if (name === "run:r" && ++reads === 1) {
      await inner.set("run:r", { ...value, sandbox: "net-new", issued: [] });
    }
    return value;
  };
  const answer = await runs.renew(token, "net-old");
  assert.equal(answer.status, 403);
  inner.get = get;
  const record = await inner.get("run:r");
  assert.equal(record.sandbox, "net-new");
  assert.deepEqual(record.issued, []);
});
