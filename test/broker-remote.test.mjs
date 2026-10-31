// The listener's calls to the broker service (listener/broker-service.mjs, #505): the key it
// signed tokens with before, handed over as a public key only; the runs' inboxes copied from the
// runner's files, a lost answer or a broker away caught up with; the stream's screenshots copied
// into the shots folder; the runs that ended while the listener was down ended there too.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createCallers } from "../broker/callers.mjs";
import { createBroker, storeSecrets } from "../broker/server.mjs";
import { createRuns } from "../broker/runs.mjs";
import { createBroker as createListenerBroker } from "../listener/broker.mjs";
import { createBrokerService, legacyKey } from "../listener/broker-service.mjs";
import { createInbox } from "../listener/runner/inbox.mjs";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { openStore } from "../lib/store.mjs";
import { keyId, LEGACY_KEY_MS, signToken, TOKEN_VERSION } from "../lib/tokens.mjs";
import { tempDir, testKey } from "./helpers.mjs";

const FOLDER = "0123456789abcdef01234567";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

// The broker service on loopback, the listener calling it as the orchestrator; on `port` (0:
// one the OS picks), so a test can stop it and start it again where it was.
async function service(t, { store = openStore("memory:"), key = testKey(), port = 0 } = {}) {
  const broker = createBroker({
    store,
    key,
    callers: createCallers({ networks: "orchestrator=127.0.0.0/8" }),
  });
  await new Promise((resolve) => broker.server.listen(port, "127.0.0.1", resolve));
  broker.server.unref();
  const stop = () =>
    new Promise((resolve) => {
      broker.server.closeAllConnections();
      broker.server.close(resolve);
    });
  t.after(stop);
  return { ...broker, store, key, port: broker.server.address().port, stop };
}

function remote(t, broker, { legacy = null, logged = [] } = {}) {
  const made = createBrokerService({
    caller: createBrokerCaller({ url: `http://127.0.0.1:${broker.port}` }),
    legacy,
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

test("the listener's old key: its private part removed, its public part handed to the broker for the tokens it signed", async (t) => {
  const dir = tempDir(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(dir, "run-token.key"), privateKey.export({ type: "pkcs8", format: "pem" }));
  const logged = [];
  const pem = legacyKey(dir, { now: () => 1000, log: (line) => logged.push(line) });
  assert.equal(existsSync(join(dir, "run-token.key")), false);
  assert.match(pem, /BEGIN PUBLIC KEY/);
  assert.match(logged[0], /run-token\.key removed/);
  // The next start finds the public part alone; past its last token's life, nothing.
  assert.equal(legacyKey(dir, { now: () => 2000 }), pem);
  assert.equal(legacyKey(dir, { now: () => 1000 + LEGACY_KEY_MS + 1 }), null);
  assert.equal(existsSync(join(dir, "run-token.pub")), false);
  assert.equal(legacyKey(tempDir(t)), null);

  // Handed over: a token it signed for a running sandbox checks here and renews there.
  const broker = await service(t);
  const listener = remote(t, broker, { legacy: pem });
  await listener.start();
  const old = { privateKey, publicKey, kid: keyId(publicKey) };
  const claims = { ver: TOKEN_VERSION, jti: "old", repo: "org/a", sandbox: "net-o", caps: [] };
  const token = signToken(claims, { ...old, audience: "deckhand:broker", ttlMs: 60_000 });
  assert.ok(listener.keys().has(old.kid));
  assert.ok(listener.keys().has(broker.key.kid));
  await listener.issuer.put("old", { repo: "org/a", sandbox: "net-o" });
  assert.ok((await broker.runs.renew(token, "net-o")).token);
});

test("an inbox: the runner's file copied from the offset the broker has, a broker away caught up with", async (t) => {
  const store = openStore("memory:");
  const key = testKey();
  let broker = await service(t, { store, key });
  const logged = [];
  const listener = remote(t, broker, { logged });
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

test("the stream: a screenshot copied into the shots folder, deleted at the broker, acknowledged", async (t) => {
  const broker = await service(t);
  const listener = remote(t, broker);
  const shotsDir = tempDir(t);
  const { token } = await listener.issuer.issue("run-a", {
    repo: "org/a",
    sandbox: "net-a",
    shots: FOLDER,
  });
  const seen = [];
  listener.consume({ shotsDir, handlers: { started: async (e) => seen.push(e.type) } });
  const record = await broker.runs.get("run-a");
  const req = Object.assign(
    (async function* () {
      yield Buffer.concat([PNG, Buffer.from("x")]);
    })(),
    { headers: {} },
  );
  assert.equal((await broker.files.putShot(req, record, "page.png")).status, 204);
  const copied = join(shotsDir, FOLDER, "page.png");
  await until(() => existsSync(copied));
  assert.deepEqual(readFileSync(copied), Buffer.concat([PNG, Buffer.from("x")]));
  await until(async () => (await broker.store.readBlob(`shot:${FOLDER}/page.png`)) === null);
  await until(async () => (await broker.store.read("runs", "orchestrator")).length === 0);
  assert.deepEqual(seen, ["started"]);
  assert.ok(token);
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
  listenerBroker.register("org/a", undefined, { id: "run-a" });
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
  // A run's from before: its file redacted in place before it is copied whole.
  writeFileSync(join(inboxDir, "r1", "inbox.jsonl"), `{"t":"ghp_${"c".repeat(36)}"}\n`);
  await inbox.resync("r1");
  assert.equal(copied.at(-1), '{"t":"[redacted]"}\n');
});

test("a message quoting a PEM's armour goes through send() and the broker whole; the broker's own key never does", async (t) => {
  // The store as the broker opens it: its key's own part is the secret, not the armour.
  const key = testKey();
  const store = openStore("memory:", { secrets: () => storeSecrets(key) });
  const broker = await service(t, { store, key });
  const listener = remote(t, broker);
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
