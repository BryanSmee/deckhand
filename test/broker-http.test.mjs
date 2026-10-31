// What finds a connection's run (broker-http.mjs taskWhere()): the ID of the network (or pod)
// its address is on, as the runner tells now, never a list of addresses kept per run. What binds
// a run's secret from before tokens to its sandbox (runAt()) is the same.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  clientAddress,
  createBrokerHttp,
  runAt,
  runFrom,
  sandboxAt,
  taskWhere,
} from "../listener/broker-http.mjs";
import { createBroker } from "../listener/broker.mjs";
import { localBroker, tempDir, testConfig } from "./helpers.mjs";

// Two running tasks, A and B, on networks net-a and net-b: A's sandbox and its engine, B's
// sandbox, and the listener on A's. `at`: address → { sandbox, name }, as runner.locate()
// answers; `asked`: its questions.
function twoRuns() {
  const broker = createBroker({});
  const at = {
    "10.1.0.2": { sandbox: "net-a", name: "a" },
    "10.1.0.3": { sandbox: "net-a", name: "a-engine" },
    "10.1.0.9": { sandbox: "net-a", name: "listener" },
    "10.2.0.2": { sandbox: "net-b", name: "b" },
  };
  const asked = [];
  const runner = {
    proxyAddresses: async () => ["10.0.0.9"],
    locate: async (ip) => (asked.push(ip), at[ip] ?? null),
    sandboxIdOf: async (name, run) => `net-${run}`,
  };
  const task = (name, repo) => ({
    name,
    repo,
    live: {
      id: name,
      secret: broker.register(repo, undefined, { id: name, secret: `${name}-secret` }),
      hosts: ["github.com"],
      sandbox: `net-${name}`,
    },
  });
  const tasks = new Map([
    ["org/a#1", task("a", "org/a")],
    ["org/b#2", task("b", "org/b")],
  ]);
  const ctx = { broker, runner, tasks };
  const runOf = (key) => broker.runOf(tasks.get(key).live.secret);
  return { ctx, tasks, runOf, at, asked };
}

test("runAt: a run's record from its own sandbox or engine, not from another sandbox", async () => {
  const { ctx, runOf } = twoRuns();
  const a = runOf("org/a#1");
  assert.equal(await runAt(ctx, a, "10.1.0.2"), true);
  assert.equal(await runAt(ctx, a, "10.1.0.3"), true);
  // A's secret, replayed from B's sandbox (a research run's, say): refused.
  assert.equal(await runAt(ctx, a, "10.2.0.2"), false);
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.2"), true);
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.1.0.2"), false);
  // Another container on A's network (the listener, the proxy) isn't A's.
  assert.equal(await runAt(ctx, a, "10.1.0.9"), false);
  // A record no running task holds (revoked, unknown): nobody's.
  assert.equal(await runAt(ctx, { repo: "org/a" }, "10.1.0.2"), false);
  assert.equal(await runAt(ctx, undefined, "10.1.0.2"), false);
});

test("runAt: a finished run (finish() cleared its hosts) is nobody's", async () => {
  const { ctx, tasks, runOf } = twoRuns();
  const a = runOf("org/a#1");
  assert.equal(await runAt(ctx, a, "10.1.0.2"), true);
  tasks.get("org/a#1").live.hosts = null;
  assert.equal(await runAt(ctx, a, "10.1.0.2"), false);
  assert.equal(await taskWhere(ctx, "10.1.0.2"), null);
});

test("taskWhere: nothing kept per run, so another run's engine starting changes nothing (#517)", async () => {
  const { ctx, tasks, at, asked } = twoRuns();
  const b = tasks.get("org/b#2");
  // B's engine runs before its sandbox does; A's sandbox connects meanwhile.
  delete at["10.2.0.2"];
  at["10.2.0.3"] = { sandbox: "net-b", name: "b-engine" };
  assert.equal((await taskWhere(ctx, "10.1.0.2")).task, tasks.get("org/a#1"));
  assert.deepEqual(await taskWhere(ctx, "10.2.0.3"), { task: b, engine: true });
  // B's sandbox starts: its own at once, nothing to look up again.
  at["10.2.0.2"] = { sandbox: "net-b", name: "b" };
  assert.deepEqual(await taskWhere(ctx, "10.2.0.2"), { task: b, engine: false });
  assert.equal((await taskWhere(ctx, "10.1.0.2")).engine, false);
  // Each question asks the runner, whose cache is its own (runner/networks.mjs locate()); the
  // runs' live states hold no address.
  assert.deepEqual(asked, ["10.1.0.2", "10.2.0.3", "10.2.0.2", "10.1.0.2"]);
  for (const task of tasks.values()) {
    assert.deepEqual(
      Object.keys(task.live).filter((k) => /ip/i.test(k)),
      [],
    );
  }
});

test("taskWhere: a run from before tokens has its network's ID looked up once, by its name", async () => {
  const { ctx, tasks, asked } = twoRuns();
  const a = tasks.get("org/a#1");
  a.live.sandbox = null;
  let looked = 0;
  const sandboxIdOf = ctx.runner.sandboxIdOf;
  ctx.runner.sandboxIdOf = async (...args) => (looked++, sandboxIdOf(...args));
  assert.equal((await taskWhere(ctx, "10.1.0.2")).task, a);
  assert.equal((await taskWhere(ctx, "10.1.0.3")).task, a);
  assert.equal(looked, 1);
  assert.equal(a.live.sandbox, "net-a");
  assert.equal(asked.length, 2);
});

test("taskWhere: a run with tokens still starting is looked up nowhere; an older run's lookup is shared, a miss not asked again at once", async () => {
  const { ctx, tasks } = twoRuns();
  let looked = 0;
  let id = null;
  ctx.runner.sandboxIdOf = async () => (looked++, id);
  const clock = { t: 1_000_000 };
  ctx.now = () => clock.t;
  // A has tokens, not signed yet (its sandbox starting): no `sandbox`, no secret.
  const a = tasks.get("org/a#1");
  a.live.sandbox = null;
  delete a.live.secret;
  const questions = Array.from({ length: 50 }, () => taskWhere(ctx, "10.2.0.2"));
  assert.ok((await Promise.all(questions)).every((w) => w.task === tasks.get("org/b#2")));
  assert.equal(looked, 0);
  // B is from before tokens, its network gone: one lookup for many questions, then none for 5 s.
  const b = tasks.get("org/b#2");
  b.live.sandbox = null;
  await Promise.all(Array.from({ length: 20 }, () => taskWhere(ctx, "10.2.0.2")));
  assert.equal(looked, 1);
  assert.equal(await taskWhere(ctx, "10.2.0.2"), null);
  assert.equal(looked, 1);
  clock.t += 5_000;
  id = "net-b";
  assert.equal((await taskWhere(ctx, "10.2.0.2")).task, b);
  assert.equal(looked, 2);
});

test("sandboxAt: a token binds to its run's sandbox or engine, never the listener or the proxy on its network", async () => {
  const { ctx, at } = twoRuns();
  at["10.1.0.8"] = { sandbox: "net-a", name: "egress-1" };
  assert.equal(await sandboxAt(ctx, "10.1.0.2"), "net-a");
  assert.equal(await sandboxAt(ctx, "10.1.0.3"), "net-a");
  assert.equal(await sandboxAt(ctx, "10.1.0.9"), null);
  assert.equal(await sandboxAt(ctx, "10.1.0.8"), null);
  // A's token, as the listener's broker checks it (server.mjs): from the proxy's own address on
  // A's network (a call it made itself, naming no client), refused.
  const broker = createBroker({ ...localBroker(), sandboxOf: (ip) => sandboxAt(ctx, ip) });
  broker.register("org/a", undefined, { id: "a" });
  ctx.broker = broker;
  const { token } = await broker.issue("a", "net-a");
  assert.equal((await broker.check(token, "10.1.0.2")).run.id, "a");
  assert.equal((await broker.check(token, "10.1.0.8")).status, 403);
  assert.equal((await broker.check(token, "10.1.0.9")).status, 403);
});

test("runFrom: the record of the running task whose sandbox has the address, never its engine", async () => {
  const { ctx, tasks, runOf } = twoRuns();
  assert.equal(await runFrom(ctx, "10.1.0.2"), runOf("org/a#1"));
  // The engine's builds and containers have no secret: nobody's run, so no token.
  assert.equal(await runFrom(ctx, "10.1.0.3"), null);
  assert.equal(await runFrom(ctx, "10.2.0.2"), runOf("org/b#2"));
  assert.equal(await runFrom(ctx, "10.3.0.2"), null);
  assert.equal(await runFrom(ctx, "10.1.0.9"), null);
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
      locate: async (ip) => (ip === "10.1.0.2" ? { sandbox: "net-a", name: "a" } : null),
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
            sandbox: "net-a",
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
      locate: async (ip) => (ip === "10.1.0.2" ? { sandbox: "net-a", name: "a" } : null),
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
          live: {
            secret: broker.register("org/a"),
            sandbox: "net-a",
            hosts: ["github.com"],
            trusted: [],
          },
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
  // With the network of the run's sandbox, which the proxy vouches for to the broker service.
  assert.deepEqual(await ask("10.1.0.2"), {
    allowed: true,
    private: false,
    cache: false,
    decrypt: false,
    relay: false,
    sandbox: "net-a",
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
  // What runner.locate() answers: B's engine runs, its sandbox doesn't yet.
  const at = {
    "10.1.0.2": { sandbox: "net-a", name: "a" },
    "10.2.0.3": { sandbox: "net-b", name: "b-engine" },
  };
  const live = (repo, sandbox) => ({
    secret: broker.register(repo),
    sandbox,
    hosts: ["github.com", "pypi.org"],
    trusted: [],
    record: { agent: "claude" },
  });
  // B first: a question from A's sandbox looks B up on its way.
  const tasks = new Map([
    ["org/b#2", { name: "b", repo: "org/b", id: "2", live: live("org/b", "net-b") }],
    ["org/a#1", { name: "a", repo: "org/a", id: "1", live: live("org/a", "net-a") }],
  ]);
  const ctx = {
    config,
    broker,
    log: () => {},
    runner: {
      // The test is the egress proxy.
      proxyAddresses: async () => ["127.0.0.1"],
      locate: async (ip) => at[ip] ?? null,
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
  // B's engine pulls under B's hosts, its HTTPS never decrypted.
  const engine = await ask("10.2.0.3", "pypi.org");
  assert.equal(engine.allowed, true);
  assert.equal(engine.decrypt, false);
  // B's sandbox starts: its hosts are its own, and only those.
  at["10.2.0.2"] = { sandbox: "net-b", name: "b" };
  assert.equal((await ask("10.2.0.2", "pypi.org")).allowed, true);
  assert.equal((await ask("10.2.0.2", "evil.example")).allowed, false);
  // And A's are still A's.
  assert.equal((await ask("10.1.0.2", "pypi.org")).allowed, true);
});
