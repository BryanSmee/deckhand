// What binds a run's secret from before tokens to its sandbox (broker-http.mjs runAt()): the run's own task's
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
    address: async (name) => (looked.push(name), addresses[name].length ? addresses[name] : null),
    engineAddress: async (name) => engines[name],
  };
  const task = (name, repo) => ({
    name,
    repo,
    // Whether it started an engine (runs.mjs launch()).
    live: {
      id: name,
      secret: broker.register(repo, undefined, { id: name, secret: `${name}-secret` }),
      hosts: ["github.com"],
      ip: null,
      engine: !!engines[name],
    },
  });
  const tasks = new Map([
    ["org/a#1", task("a", "org/a")],
    ["org/b#2", task("b", "org/b")],
  ]);
  const clock = { t: 1_000_000 };
  const ctx = { broker, runner, tasks, now: () => clock.t };
  const runOf = (key) => broker.runOf(tasks.get(key).live.secret);
  return { ctx, tasks, runOf, looked, addresses, engines, clock };
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

test("runAt: an engine started before its sandbox isn't kept as the run's addresses (#517)", async () => {
  const { ctx, tasks, runOf, addresses, engines, looked } = twoRuns();
  const live = tasks.get("org/b#2").live;
  // B's engine runs, its sandbox doesn't exist yet: only the engine has an address.
  live.engine = true;
  engines.b = ["10.2.0.3"];
  addresses.b = [];
  // Another sandbox connects meanwhile: the broker asks about every task (taskAt(), runFrom()).
  assert.equal(await runFrom(ctx, "10.9.0.2"), null);
  assert.equal(live.ip, null, "the engine's address alone isn't kept");
  assert.deepEqual(live.engineIp, ["10.2.0.3"]);
  // The engine's own calls are B's.
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.3"), true);
  // The sandbox starts: its first call is B's, and its addresses are kept from then on.
  addresses.b = ["10.2.0.2"];
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.2"), true);
  assert.deepEqual(live.ip, ["10.2.0.2", "10.2.0.3"]);
  looked.length = 0;
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.2"), true);
  assert.deepEqual(looked, []);
});

test("runAt: an engine's lookup that fails loses nothing, and keeps nothing (#518)", async () => {
  const { ctx, tasks, runOf, addresses, engines } = twoRuns();
  const b = runOf("org/b#2");
  const live = tasks.get("org/b#2").live;
  live.engine = true;
  engines.b = ["10.2.0.3"];
  addresses.b = [];
  assert.equal(await runAt(ctx, b, "10.2.0.3"), true);
  assert.deepEqual(live.engineIp, ["10.2.0.3"]);
  // The engine's inspection fails once (Docker busy): what was known of it stays.
  engines.b = null;
  assert.equal(await runAt(ctx, b, "10.2.0.3"), true);
  assert.deepEqual(live.engineIp, ["10.2.0.3"]);
  assert.equal(live.ip, null, "the engine's address alone is never kept");
  // The sandbox starts while the engine's inspection still fails: both are the run's.
  addresses.b = ["10.2.0.2"];
  assert.equal(await runAt(ctx, b, "10.2.0.2"), true);
  assert.deepEqual(live.ip, ["10.2.0.2", "10.2.0.3"]);
  // Its engine is still told apart: no record for its anonymous calls.
  assert.equal(await runFrom(ctx, "10.2.0.3"), null);
});

test("a run with an engine missed by every lookup so far: its sandbox's address alone isn't kept", async () => {
  const { ctx, tasks, runOf, engines } = twoRuns();
  const live = tasks.get("org/b#2").live;
  live.engine = true;
  // Its sandbox is up, but its engine's inspection fails (Docker busy).
  engines.b = null;
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.2"), true);
  assert.equal(live.ip, null, "kept without the engine, its connections would be nobody's");
  // The next egress question finds the engine: kept, with both.
  engines.b = ["10.2.0.3"];
  assert.equal(await runFrom(ctx, "10.9.0.2"), null);
  assert.deepEqual(live.ip, ["10.2.0.2", "10.2.0.3"]);
  assert.equal(await runFrom(ctx, "10.2.0.3"), null, "the engine, told apart");
  assert.equal(await runFrom(ctx, "10.2.0.2"), runOf("org/b#2"));
  // A run that started none keeps its sandbox's alone, at once.
  engines.a = null;
  const a = tasks.get("org/a#1").live;
  Object.assign(a, { engine: false, ip: null, engineIp: null });
  assert.equal(await runAt(ctx, runOf("org/a#1"), "10.1.0.2"), true);
  assert.deepEqual(a.ip, ["10.1.0.2"]);
});

test("an engine gone mid-run: its sandbox's kept after 5 s, the engine looked for every 5 s", async () => {
  const { ctx, tasks, runOf, engines, looked, clock } = twoRuns();
  const live = tasks.get("org/b#2").live;
  live.engine = true;
  engines.b = null;
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.2"), true);
  assert.equal(live.ip, null);
  // 5 s on, its engine still missing: its sandbox's are kept, so a question costs no lookup.
  clock.t += 5_000;
  assert.equal(await runFrom(ctx, "10.2.0.2"), runOf("org/b#2"));
  assert.deepEqual(live.ip, ["10.2.0.2"]);
  // Other sandboxes' questions look its engine up again, at most every 5 s.
  looked.length = 0;
  clock.t += 1_000;
  await runFrom(ctx, "10.9.0.2");
  assert.deepEqual(looked, []);
  clock.t += 4_000;
  await runFrom(ctx, "10.9.0.2");
  assert.deepEqual(looked, ["b"]);
  // It's back: in the list, and told apart.
  engines.b = ["10.2.0.3"];
  clock.t += 5_000;
  await runFrom(ctx, "10.9.0.2");
  assert.deepEqual(live.ip, ["10.2.0.2", "10.2.0.3"]);
  assert.equal(await runFrom(ctx, "10.2.0.3"), null);
  // Then nobody looks it up again.
  looked.length = 0;
  clock.t += 60_000;
  await runFrom(ctx, "10.9.0.2");
  assert.deepEqual(looked, []);
});

test("a run saved before `engine` was: it may have one, so its sandbox's wait for it", async () => {
  const { ctx, tasks, runOf, engines } = twoRuns();
  const live = tasks.get("org/b#2").live;
  delete live.engine;
  engines.b = null;
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.2"), true);
  assert.equal(live.ip, null);
  engines.b = ["10.2.0.3"];
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.2"), true);
  assert.deepEqual(live.ip, ["10.2.0.2", "10.2.0.3"]);
});

test("runAt: calls that miss at once share one lookup, and the limit holds when it finds nothing", async () => {
  const { ctx, tasks, runOf, addresses, looked, clock } = twoRuns();
  const a = runOf("org/a#1");
  assert.equal(await runAt(ctx, a, "10.1.0.2"), true);
  // A secret replayed from another sandbox, 50 calls at once: one lookup.
  clock.t += 5_000;
  looked.length = 0;
  const answers = await Promise.all(Array.from({ length: 50 }, () => runAt(ctx, a, "10.2.0.2")));
  assert.ok(answers.every((answer) => answer === false));
  assert.deepEqual(looked, ["a"]);
  // Its sandbox gone (before finish()): the lookup finds nothing, and the next waits 5 s anyway.
  addresses.a = [];
  clock.t += 5_000;
  assert.equal(await runAt(ctx, a, "10.2.0.2"), false);
  assert.equal(await runAt(ctx, a, "10.2.0.2"), false);
  assert.deepEqual(looked, ["a", "a"]);
  assert.deepEqual(tasks.get("org/a#1").live.ip, ["10.1.0.2", "10.1.0.3"], "what was kept stays");
});

test("runAt: an address not among those kept looks them up again, at most every 5 s", async () => {
  const { ctx, runOf, addresses, looked, clock } = twoRuns();
  const a = runOf("org/a#1");
  assert.equal(await runAt(ctx, a, "10.1.0.2"), true);
  // Another address (a replayed secret, or one the list missed): no again within 5 s.
  addresses.a = ["10.1.0.2", "10.1.0.4"];
  looked.length = 0;
  assert.equal(await runAt(ctx, a, "10.1.0.4"), false);
  clock.t += 4_999;
  assert.equal(await runAt(ctx, a, "10.1.0.4"), false);
  assert.deepEqual(looked, []);
  // Then looked up again: there now.
  clock.t += 1;
  assert.equal(await runAt(ctx, a, "10.1.0.4"), true);
  assert.deepEqual(looked, ["a"]);
  // Still another sandbox's address: no, and no lookup before the next 5 s.
  assert.equal(await runAt(ctx, a, "10.2.0.2"), false);
  assert.deepEqual(looked, ["a"]);
  // Asking about every task (an egress question) never looks a kept list up again.
  clock.t += 60_000;
  assert.equal(await runFrom(ctx, "10.9.0.2"), null);
  assert.deepEqual(looked, ["a", "b"]);
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

// --- Kubernetes: the builder, install pods and init containers ----------------------------------

test("egress: the runner's builder and installs answered by the images, an installing sandbox its install's hosts only", async (t) => {
  const config = testConfig();
  config.brokerPort = 0;
  config.brokerUrl = "http://127.0.0.1:0";
  const broker = createBroker({});
  let installing = true;
  let asked = 0;
  const ctx = {
    config,
    broker,
    log: () => {},
    runner: {
      // The test is the egress proxy.
      proxyAddresses: async () => ["127.0.0.1"],
      address: async () => ["10.1.0.2"],
      engineAddress: async () => null,
      installing: async (name) => {
        asked++;
        return installing === null ? null : name === "a" && installing;
      },
    },
    images: {
      egressFor: async (ip, host) =>
        ip === "10.9.9.9"
          ? {
              allowed: host === "pypi.org",
              private: false,
              cache: false,
              decrypt: false,
              relay: false,
            }
          : null,
    },
    tasks: new Map([
      [
        "org/a#1",
        {
          name: "a",
          repo: "org/a",
          id: "1",
          live: {
            secret: broker.register("org/a"),
            hosts: ["github.com", "pypi.org"],
            trusted: [],
            record: { agent: "claude" },
          },
        },
      ],
    ]),
  };
  const server = createBrokerHttp(ctx).listen();
  await once(server, "listening");
  t.after(() => server.close());
  const ask = async (ip, host) =>
    (await fetch(`http://127.0.0.1:${config.brokerPort}/egress?ip=${ip}&host=${host}`)).json();
  // The builder: the images' answer.
  assert.equal((await ask("10.9.9.9", "pypi.org")).allowed, true);
  assert.equal((await ask("10.9.9.9", "evil.example")).allowed, false);
  // A sandbox whose init container installs its agent: npm's registry, tunnelled, and
  // nothing of the run's own hosts until the sandbox starts.
  assert.deepEqual(await ask("10.1.0.2", "registry.npmjs.org"), {
    allowed: true,
    private: false,
    cache: false,
    decrypt: false,
    relay: false,
  });
  assert.equal((await ask("10.1.0.2", "pypi.org")).allowed, false);
  // The API can't tell: neither the run's own hosts for an installer, nor install hosts for
  // the sandbox, only those that are both, tunnelled; and it asks again.
  installing = null;
  assert.equal((await ask("10.1.0.2", "pypi.org")).allowed, false);
  assert.equal((await ask("10.1.0.2", "registry.npmjs.org")).allowed, false);
  const { live } = ctx.tasks.get("org/a#1");
  live.hosts.push("registry.npmjs.org");
  assert.deepEqual(await ask("10.1.0.2", "registry.npmjs.org"), {
    allowed: true,
    private: false,
    cache: false,
    decrypt: false,
    relay: false,
  });
  live.hosts.pop();
  installing = true;
  assert.equal((await ask("10.1.0.2", "pypi.org")).allowed, false);
  installing = false;
  assert.equal((await ask("10.1.0.2", "pypi.org")).allowed, true);
  assert.equal((await ask("10.1.0.2", "registry.npmjs.org")).allowed, false);
  // Past its install, the run's connections no longer ask the runner (an API call each).
  const before = asked;
  installing = true;
  assert.equal((await ask("10.1.0.2", "pypi.org")).allowed, true);
  assert.equal(asked, before);
  // Anyone else: refused.
  assert.equal((await ask("10.7.7.7", "pypi.org")).allowed, false);
});

test("egress: the broker's host only for a run's sandbox the proxy forwards, never a build; a proxy's other BROKER_URL said", async (t) => {
  const config = testConfig();
  config.brokerPort = 0;
  config.brokerUrl = "http://listener.test:0";
  const broker = createBroker({});
  const logged = [];
  const ctx = {
    config,
    broker,
    log: (line) => logged.push(line),
    runner: {
      // The test is the egress proxy.
      proxyAddresses: async () => ["127.0.0.1"],
      address: async () => ["10.1.0.2"],
      engineAddress: async () => null,
      installing: async () => false,
    },
    // The builder may reach anything: never the broker through the proxy all the same.
    images: { egressFor: async (ip) => (ip === "10.9.9.9" ? { allowed: true } : null) },
    tasks: new Map([
      [
        "org/a#1",
        {
          name: "a",
          repo: "org/a",
          id: "1",
          live: { secret: broker.register("org/a"), hosts: ["github.com"], trusted: [] },
        },
      ],
    ]),
  };
  const server = createBrokerHttp(ctx).listen();
  await once(server, "listening");
  t.after(() => server.close());
  const ask = async (ip, extra = "&broker=1") =>
    (
      await fetch(
        `http://127.0.0.1:${config.brokerPort}/egress?ip=${ip}&host=listener.test${extra}`,
      )
    ).json();
  assert.deepEqual(await ask("10.1.0.2"), {
    allowed: true,
    private: false,
    cache: false,
    decrypt: false,
    relay: false,
  });
  assert.equal((await ask("10.9.9.9")).allowed, false);
  assert.equal((await ask("10.7.7.7")).allowed, false);
  // Asked as any other host: the proxy's BROKER_URL isn't the listener's. Refused, and said once.
  assert.equal((await ask("10.1.0.2", "")).allowed, false);
  assert.equal((await ask("10.1.0.2", "")).allowed, false);
  const warnings = logged.filter((line) => line.includes("its BROKER_URL must be the listener's"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /http:\/\/listener\.test:\d+/);
});

test("egress: a question between a run's engine start and its sandbox's refuses none of that sandbox's hosts (#517)", async (t) => {
  const config = testConfig();
  config.brokerPort = 0;
  config.brokerUrl = "http://127.0.0.1:0";
  const broker = createBroker({});
  const addresses = { a: ["10.1.0.2"], b: [] };
  const engines = { a: null, b: ["10.2.0.3"] };
  const live = (repo) => ({
    secret: broker.register(repo),
    hosts: ["github.com", "pypi.org"],
    trusted: [],
    record: { agent: "claude" },
  });
  // B first: a question from A's sandbox looks B up on its way.
  const tasks = new Map([
    ["org/b#2", { name: "b", repo: "org/b", id: "2", live: { ...live("org/b"), engine: true } }],
    ["org/a#1", { name: "a", repo: "org/a", id: "1", live: live("org/a") }],
  ]);
  const ctx = {
    config,
    broker,
    log: () => {},
    runner: {
      // The test is the egress proxy.
      proxyAddresses: async () => ["127.0.0.1"],
      address: async (name) => (addresses[name].length ? addresses[name] : null),
      engineAddress: async (name) => engines[name],
    },
    images: { egressFor: async () => null },
    tasks,
  };
  const server = createBrokerHttp(ctx).listen();
  await once(server, "listening");
  t.after(() => server.close());
  const ask = async (ip, host) =>
    (await fetch(`http://127.0.0.1:${config.brokerPort}/egress?ip=${ip}&host=${host}`)).json();
  // B's engine runs, its sandbox doesn't yet, and A's sandbox connects.
  assert.equal((await ask("10.1.0.2", "pypi.org")).allowed, true);
  assert.equal(tasks.get("org/b#2").live.ip ?? null, null, "the engine's address alone isn't kept");
  // B's engine pulls under B's hosts.
  assert.equal((await ask("10.2.0.3", "pypi.org")).allowed, true);
  // B's sandbox starts: its hosts are its own, and only those.
  addresses.b = ["10.2.0.2"];
  assert.equal((await ask("10.2.0.2", "pypi.org")).allowed, true);
  assert.equal((await ask("10.2.0.2", "evil.example")).allowed, false);
  assert.deepEqual(tasks.get("org/b#2").live.ip, ["10.2.0.2", "10.2.0.3"]);
});
