// The orchestrator's egress policy (egress-http.mjs): what finds a connection's run
// (taskWhere()), the ID of the network (or pod) its address is on, as the runner tells now,
// never a list of addresses kept per run; and what it answers the egress proxy, for the hosts a
// run may reach and the services' names its sandbox calls.
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createEgressHttp, taskWhere } from "../listener/egress-http.mjs";
import { createBroker } from "../listener/broker.mjs";
import { testConfig } from "./helpers.mjs";

// Two running tasks, A and B, on networks net-a and net-b: A's sandbox and its engine, B's
// sandbox, and the egress proxy on A's. `at`: address → { sandbox, name }, as runner.locate()
// answers; `asked`: its questions.
function twoRuns() {
  const broker = createBroker({});
  const at = {
    "10.1.0.2": { sandbox: "net-a", name: "a" },
    "10.1.0.3": { sandbox: "net-a", name: "a-engine" },
    "10.1.0.9": { sandbox: "net-a", name: "egress-1" },
    "10.2.0.2": { sandbox: "net-b", name: "b" },
  };
  const asked = [];
  const runner = {
    proxyAddresses: async () => ["10.0.0.9"],
    locate: async (ip) => (asked.push(ip), at[ip] ?? null),
  };
  const task = (name, repo) => ({
    name,
    repo,
    live: {
      id: broker.register(repo, { id: name }),
      hosts: ["github.com"],
      sandbox: `net-${name}`,
    },
  });
  const tasks = new Map([
    ["org/a#1", task("a", "org/a")],
    ["org/b#2", task("b", "org/b")],
  ]);
  const ctx = { broker, runner, tasks };
  return { ctx, tasks, at, asked };
}

test("taskWhere: a run's own sandbox or engine, never another container on its network", async () => {
  const { ctx, tasks } = twoRuns();
  const a = tasks.get("org/a#1");
  assert.deepEqual(await taskWhere(ctx, "10.1.0.2"), { task: a, engine: false });
  assert.deepEqual(await taskWhere(ctx, "10.1.0.3"), { task: a, engine: true });
  assert.equal((await taskWhere(ctx, "10.2.0.2")).task, tasks.get("org/b#2"));
  // The egress proxy on A's network (a call it made itself), or an address on none: nobody's.
  assert.equal(await taskWhere(ctx, "10.1.0.9"), null);
  assert.equal(await taskWhere(ctx, "10.3.0.2"), null);
  assert.equal(await taskWhere(ctx, ""), null);
});

test("taskWhere: a finished run (finish() cleared its hosts) is nobody's; one still starting, too", async () => {
  const { ctx, tasks } = twoRuns();
  const a = tasks.get("org/a#1");
  a.live.hosts = null;
  assert.equal(await taskWhere(ctx, "10.1.0.2"), null);
  // Its tokens not signed yet: no network to find it by.
  const b = tasks.get("org/b#2");
  b.live.sandbox = null;
  assert.equal(await taskWhere(ctx, "10.2.0.2"), null);
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

// The egress policy's server on a port the OS picks, for `ctx` (its config's port set to 0):
// ask(ip, host, extra) → its answer.
async function policyServer(t, ctx) {
  ctx.config.policyPort = 0;
  const server = createEgressHttp(ctx).listen();
  await once(server, "listening");
  t.after(() => server.close());
  return async (ip, host, extra = "") =>
    (
      await fetch(`http://127.0.0.1:${ctx.config.policyPort}/egress?ip=${ip}&host=${host}${extra}`)
    ).json();
}

test("egress: only the proxy may ask", async (t) => {
  const { ctx } = twoRuns();
  const ask = await policyServer(t, { ...ctx, config: testConfig(), log: () => {} });
  // The test isn't the proxy (10.0.0.9): refused, whatever it asks.
  assert.deepEqual(await ask("10.1.0.2", "github.com"), { allowed: false });
});

// --- Kubernetes: the builder, install pods and init containers ----------------------------------

test("egress: the runner's builder and installs answered by the images, an installing sandbox its install's hosts only", async (t) => {
  const config = testConfig();
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
            id: broker.register("org/a"),
            sandbox: "net-a",
            hosts: ["github.com", "pypi.org"],
            trusted: [],
            record: { agent: "claude" },
          },
        },
      ],
    ]),
  };
  const ask = await policyServer(t, ctx);
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

test("egress: the services' names only for a run's sandbox or engine the proxy forwards, never a build nor a tunnel", async (t) => {
  const config = testConfig();
  const broker = createBroker({});
  const logged = [];
  const ctx = {
    config,
    broker,
    log: (line) => logged.push(line),
    runner: {
      // The test is the egress proxy.
      proxyAddresses: async () => ["127.0.0.1"],
      locate: async (ip) =>
        ({
          "10.1.0.2": { sandbox: "net-a", name: "a" },
          "10.1.0.3": { sandbox: "net-a", name: "a-engine" },
        })[ip] ?? null,
      installing: async () => false,
    },
    // The builder may reach anything: never a service through the proxy all the same.
    images: { egressFor: async (ip) => (ip === "10.9.9.9" ? { allowed: true } : null) },
    tasks: new Map([
      [
        "org/a#1",
        {
          name: "a",
          repo: "org/a",
          id: "1",
          live: {
            id: broker.register("org/a"),
            sandbox: "net-a",
            // Granted by name, a service's still isn't a host of the run's.
            hosts: ["github.com", "broker"],
            trusted: [],
          },
        },
      ],
    ]),
  };
  const ask = await policyServer(t, ctx);
  // With the network of the run's sandbox, which the proxy vouches for to the service; the
  // engine's calls are the run's too (its pushes, its builds' agent calls).
  for (const host of ["broker", "github", "models"]) {
    for (const ip of ["10.1.0.2", "10.1.0.3"]) {
      assert.deepEqual(await ask(ip, host, "&forward=1"), {
        allowed: true,
        private: false,
        cache: false,
        decrypt: false,
        relay: false,
        sandbox: "net-a",
      });
    }
    assert.equal((await ask("10.9.9.9", host, "&forward=1")).allowed, false);
    assert.equal((await ask("10.7.7.7", host, "&forward=1")).allowed, false);
    // Asked as any other host (a CONNECT): refused, and said.
    assert.equal((await ask("10.1.0.2", host)).allowed, false);
  }
  assert.ok(logged.includes("Egress: refused broker for 10.1.0.2"));
});

test("egress: a question between a run's engine start and its sandbox's refuses none of that sandbox's hosts (#517)", async (t) => {
  const config = testConfig();
  const broker = createBroker({});
  // What runner.locate() answers: B's engine runs, its sandbox doesn't yet.
  const at = {
    "10.1.0.2": { sandbox: "net-a", name: "a" },
    "10.2.0.3": { sandbox: "net-b", name: "b-engine" },
  };
  const live = (repo, sandbox) => ({
    id: broker.register(repo),
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
  const ask = await policyServer(t, ctx);
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

test("egress: an agent's relayed host is the models service's, GitHub's the github service's, each with its sandbox's network", async (t) => {
  const config = testConfig();
  const broker = createBroker({});
  const ctx = {
    config,
    broker,
    log: () => {},
    runner: {
      proxyAddresses: async () => ["127.0.0.1"],
      locate: async (ip) => (ip === "10.1.0.2" ? { sandbox: "net-a", name: "a" } : null),
      installing: async () => false,
    },
    images: { egressFor: async () => null },
    tasks: new Map([
      [
        "org/a#1",
        {
          name: "a",
          repo: "org/a",
          id: "1",
          live: {
            id: broker.register("org/a"),
            sandbox: "net-a",
            hosts: ["github.com", "api.github.com", "daily-cloudcode-pa.googleapis.com"],
            trusted: [],
            record: { agent: "antigravity" },
          },
        },
      ],
    ]),
  };
  const ask = await policyServer(t, ctx);
  const agent = await ask("10.1.0.2", "daily-cloudcode-pa.googleapis.com");
  assert.equal(agent.relay, true);
  assert.equal(agent.models, true);
  assert.equal(agent.sandbox, "net-a");
  const github = await ask("10.1.0.2", "api.github.com");
  assert.equal(github.relay, true);
  assert.equal(github.models, undefined);
  assert.equal(github.service, "github");
  assert.equal(github.sandbox, "net-a");
});
