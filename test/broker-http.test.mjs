// What binds a run's secret to its sandbox (broker-http.mjs runAt()): the run's own task's
// addresses, never another running sandbox's.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clientAddress, createBrokerHttp, runAt, runFrom } from "../listener/broker-http.mjs";
import { createBroker } from "../listener/broker.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

// Two running tasks, A and B, each with its sandbox's and its engine's addresses.
function twoRuns() {
  const broker = createBroker({});
  const looked = [];
  const addresses = { a: ["10.1.0.2"], b: ["10.2.0.2"] };
  const engines = { a: ["10.1.0.3"], b: null };
  const runner = {
    proxyAddresses: async () => ["10.0.0.9"],
    address: async (name) => (looked.push(name), [...addresses[name], ...(engines[name] ?? [])]),
    engineAddress: async (name) => engines[name],
  };
  const task = (name, repo) => ({
    name,
    repo,
    live: { secret: broker.register(repo), hosts: ["github.com"], ip: null },
  });
  const tasks = new Map([
    ["org/a#1", task("a", "org/a")],
    ["org/b#2", task("b", "org/b")],
  ]);
  const ctx = { broker, runner, tasks };
  const runOf = (key) => broker.runOf(tasks.get(key).live.secret);
  return { ctx, tasks, runOf, looked };
}

test("runAt: a run's record from its own sandbox or engine, not from another sandbox", async () => {
  const { ctx, runOf, looked } = twoRuns();
  const a = runOf("org/a#1");
  assert.equal(await runAt(ctx, a, "10.1.0.2"), true);
  assert.equal(await runAt(ctx, a, "10.1.0.3"), true);
  // A's secret, replayed from B's sandbox (a research run's, say): refused.
  assert.equal(await runAt(ctx, a, "10.2.0.2"), false);
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.2"), true);
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.1.0.2"), false);
  // Looked up once per run.
  assert.deepEqual(looked, ["a", "b"]);
  // A record no running task holds (revoked, unknown): nobody's.
  assert.equal(await runAt(ctx, { repo: "org/a" }, "10.1.0.2"), false);
  assert.equal(await runAt(ctx, undefined, "10.1.0.2"), false);
});

test("runAt: a finished run (finish() cleared its hosts and addresses) is nobody's", async () => {
  const { ctx, tasks, runOf } = twoRuns();
  const a = runOf("org/a#1");
  assert.equal(await runAt(ctx, a, "10.1.0.2"), true);
  const live = tasks.get("org/a#1").live;
  live.hosts = null;
  live.ip = null;
  assert.equal(await runAt(ctx, a, "10.1.0.2"), false);
  assert.equal(live.ip, null, "not looked up again");
});

test("runFrom: the record of the running task whose sandbox has the address, never its engine", async () => {
  const { ctx, tasks, runOf } = twoRuns();
  assert.equal(await runFrom(ctx, "10.1.0.2"), runOf("org/a#1"));
  // The engine's builds and containers have no secret: nobody's run, so no token.
  assert.equal(await runFrom(ctx, "10.1.0.3"), null);
  assert.equal(await runFrom(ctx, "10.2.0.2"), runOf("org/b#2"));
  assert.equal(await runFrom(ctx, "10.3.0.2"), null);
  // Finished: nobody's.
  tasks.get("org/a#1").live.hosts = null;
  assert.equal(await runFrom(ctx, "10.1.0.2"), null);
});

test("clientAddress: the sandbox the egress proxy names, believed from the proxy alone", async () => {
  const { ctx } = twoRuns();
  const req = (from, named) => ({
    socket: { remoteAddress: from },
    headers: named ? { "x-deckhand-client": named } : {},
  });
  assert.equal(await clientAddress(ctx, req("::ffff:10.0.0.9", "10.1.0.2")), "10.1.0.2");
  assert.equal(await clientAddress(ctx, req("10.0.0.9")), "10.0.0.9");
  // A sandbox naming another one gets its own address.
  assert.equal(await clientAddress(ctx, req("10.2.0.2", "10.1.0.2")), "10.2.0.2");
  assert.equal(await clientAddress(ctx, req("::ffff:10.2.0.2")), "10.2.0.2");
});

// --- Sandboxes older than the listener ----------------------------------------------------------

// The broker's server on a port the OS picks, with no running task: its URL, and what it logged.
async function brokerServer(t) {
  const config = testConfig();
  config.brokerPort = 0;
  config.brokerUrl = "http://127.0.0.1:0";
  const logged = [];
  const ctx = { config, log: (line) => logged.push(line), tasks: new Map() };
  const server = createBrokerHttp(ctx).listen();
  await once(server, "listening");
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${config.brokerPort}`, logged };
}

test("the old gh's /pr/ calls get a 410 naming the command that works now; others a 404", async (t) => {
  const { url, logged } = await brokerServer(t);
  const post = async (path) => {
    const res = await fetch(url + path, { method: "POST", body: "{}" });
    return { status: res.status, body: await res.json() };
  };
  const old = (command) =>
    "this sandbox's gh predates its listener: run GH_TOKEN=$(deckhand-token) /usr/bin/gh pr " +
    `${command} with the same flags instead, which goes through the GitHub gateway`;
  assert.deepEqual(await post("/pr/org/repo/7/ready"), {
    status: 410,
    body: { message: old("ready 7") },
  });
  assert.deepEqual((await post("/pr/org/repo/7/draft")).body, { message: old("ready 7 --undo") });
  assert.deepEqual((await post("/pr/org/repo/7/edit")).body, { message: old("edit 7") });
  assert.deepEqual((await post("/pr/org/repo/create")).body, { message: old("create") });
  assert.deepEqual(
    logged.filter((line) => line.startsWith("Broker:")),
    [
      "Broker: /pr/org/repo/7/ready from a sandbox older than the listener",
      "Broker: /pr/org/repo/7/draft from a sandbox older than the listener",
      "Broker: /pr/org/repo/7/edit from a sandbox older than the listener",
      "Broker: /pr/org/repo/create from a sandbox older than the listener",
    ],
  );
  for (const path of ["/pr/org/repo/7/merge", "/pr/org/repo/x/ready", "/token", "/pr/"]) {
    assert.deepEqual(await post(path), { status: 404, body: { error: "not found" } }, path);
  }
});

// The pre-#407 gh wrapper, kept as a fixture, against this broker: what a sandbox started
// before an update across #407 runs.
test("the pre-#407 gh's pr ready prints the command that works now, not 'not found'", async (t) => {
  const { url } = await brokerServer(t);
  const dir = tempDir(t, "deckhand-gh-");
  const real = join(dir, "gh");
  // The real gh, played by a script: finds pull request 7.
  writeFileSync(real, '#!/bin/bash\necho "https://github.com/org/repo/pull/7"\n');
  chmodSync(real, 0o755);
  const old = new URL("fixtures/pre-407/", import.meta.url).pathname;
  const sandbox = new URL("../sandbox/", import.meta.url).pathname;
  const res = await new Promise((resolve) => {
    execFile(
      `${old}gh`,
      ["pr", "ready"],
      {
        env: {
          PATH: `${old}:${sandbox}:${process.env.PATH}`,
          DECKHAND_BROKER_URL: url,
          DECKHAND_RUN_SECRET: "the-secret",
          DECKHAND_REAL_GH: real,
        },
        timeout: 10000,
      },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stderr }),
    );
  });
  assert.equal(res.status, 1);
  // After curl's own line about the 410.
  assert.equal(
    res.stderr.split("\n").at(-2),
    "gh pr ready: this sandbox's gh predates its listener: run GH_TOKEN=$(deckhand-token)" +
      " /usr/bin/gh pr ready 7 with the same flags instead, which goes through the GitHub" +
      " gateway",
  );
  assert.doesNotMatch(res.stderr, /not found/);
});
