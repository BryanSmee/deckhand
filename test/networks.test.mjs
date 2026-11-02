// The networks compose.yaml attaches each service to (docs/security.md, The services' networks):
// two services share a network only when one calls the other (lib/services.mjs CALLS), each
// network a service is on is one it calls or is called over, or its way to the internet when it
// needs one, and a runs' network holds the egress proxy alone (and the sandboxes, which the
// runner attaches). A service added to compose.yaml has to say here what it runs.
//
// compose.yaml declares no runs' network: the runner creates one per run (runner/networks.mjs),
// so the `deckhand.role: runs` rule below only holds the fixtures to it, for when a deployment
// declares them. What the runner joins to a run's network is tested apart, at the end.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CALLS, calls } from "../lib/services.mjs";
import { AGENT_SECRETS } from "../listener/agents/index.mjs";
import { createNetworks } from "../listener/runner/networks.mjs";
import { parseYaml } from "../lib/yaml.mjs";
import { overlaps, parseCidr } from "../lib/subnets.mjs";

const root = join(import.meta.dirname, "..");

// compose.yaml's services → the services of lib/services.mjs each one runs.
const RUNS = {
  edge: ["edge"],
  orchestrator: ["orchestrator"],
  broker: ["broker"],
  github: ["github"],
  models: ["models"],
  runner: ["runner"],
  policy: ["policy"],
  egress: ["proxy"],
};

// Those reaching the internet: edge (webhooks and browsers, a published port), github, models
// (the agents' APIs), the runner (registries) and the proxy (the hosts granted to runs).
const INTERNET = ["edge", "github", "models", "runner", "proxy"];

// compose.yaml as lib/yaml.mjs reads it, which refuses anchors and aliases: each anchor dropped
// (the image names', the logging's), each alias read as `alias-<name>`.
function readCompose(text) {
  return parseYaml(
    text.replace(/^(x-[\w-]+:)[ \t]*&[\w-]+/gm, "$1").replace(/:\s+\*([\w-]+)\s*$/gm, ": alias-$1"),
  );
}

// A service's networks: compose's `default` when it names none, nothing with a network_mode.
function networksOf(service) {
  if (service.network_mode) return [];
  const { networks } = service;
  if (!networks) return ["default"];
  return Array.isArray(networks) ? networks : Object.keys(networks);
}

// Calls without a service token, so not in lib/services.mjs: the egress proxy asks the
// orchestrator's egress policy about each connection (POLICY_URL), and hands it what it relays
// there (RELAY_URL), which the orchestrator tells apart by the caller's address.
const UNTOKENED = [["proxy", "orchestrator"]];
const untokened = (x, y) =>
  UNTOKENED.some(([a, b]) => (a === x && b === y) || (a === y && b === x));
const between = (a, b) =>
  (RUNS[a] ?? []).some((x) =>
    (RUNS[b] ?? []).some((y) => calls(x, y) || calls(y, x) || untokened(x, y)),
  );

// What is wrong with a compose file's networks: [] when nothing.
function problems(compose) {
  const found = [];
  const services = compose.services ?? {};
  const declared = compose.networks ?? {};
  const members = new Map(); // network → compose services on it
  for (const [name, service] of Object.entries(services)) {
    if (!RUNS[name] && service.network_mode !== "none") {
      found.push(`${name}: not in RUNS, and on a network`);
    }
    for (const net of networksOf(service)) {
      if (!members.has(net)) members.set(net, []);
      members.get(net).push(name);
    }
  }
  for (const [net, names] of members) {
    const options = declared[net] ?? {};
    const runs = options.labels?.["deckhand.role"] === "runs";
    for (const name of names) {
      if (runs && !RUNS[name]?.every((s) => s === "proxy")) {
        found.push(`${name}: on the runs' network ${net}, which only the proxy may be on`);
      }
      // Its peers there must be services it calls or is called by.
      const peers = names.filter((other) => other !== name);
      for (const other of peers) {
        if (name < other && !between(name, other)) {
          found.push(`${name} and ${other} share ${net}, and neither calls the other`);
        }
      }
      const outside = !options.internal && !runs;
      const needed =
        peers.some((other) => between(name, other)) ||
        (outside && RUNS[name]?.some((s) => INTERNET.includes(s)));
      if (!needed) found.push(`${name}: on ${net}, which it doesn't call over`);
    }
  }
  if (runsNetworkPeers(services).some((name) => !RUNS[name]?.includes("proxy"))) {
    found.push("deckhand.role=egress names a service that isn't the proxy");
  }
  return found;
}

// The compose services the runner joins to each run's network: the one labelled as the proxy
// (runner/networks.mjs), and no other.
function runsNetworkPeers(services) {
  return Object.entries(services)
    .filter(([, s]) => s.labels?.["deckhand.role"] === "egress")
    .map(([name]) => name);
}

test("compose.yaml: each network joins services that call each other, the runs' the proxy alone", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  assert.deepEqual(problems(compose), []);
  assert.deepEqual(runsNetworkPeers(compose.services), ["egress"]);
  // No other role either: the runner joined the orchestrator by `broker` before #511.
  const roles = Object.entries(compose.services).filter(([, s]) => s.labels?.["deckhand.role"]);
  assert.deepEqual(
    roles.map(([name, s]) => `${name}=${s.labels["deckhand.role"]}`),
    ["egress=egress"],
  );
});

// The broker, the runner, the models service and the github service tell their callers apart by
// the network a call arrives on (SERVICE_NETWORKS): each caller's subnet there has to be the one
// of a network it shares with that service, and with no other, or another service's calls would
// count as its own.
for (const callee of ["broker", "runner", "models", "github", "edge", "orchestrator"]) {
  test(`compose.yaml: the ${callee}'s SERVICE_NETWORKS names each caller's own network to it`, () => {
    const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
    const subnet = (net) =>
      /^\$\{[A-Z_]+:-(.+)\}$/.exec(compose.networks[net]?.ipam?.config?.[0]?.subnet ?? "")?.[1];
    const text = compose.services[callee].environment.SERVICE_NETWORKS.replace(
      /\$\{[A-Z_]+:-([^}]+)\}/g,
      "$1",
    );
    const callers = Object.fromEntries(text.split(",").map((part) => part.split("=")));
    const own = networksOf(compose.services[callee]);
    const used = new Set();
    for (const [caller, cidr] of Object.entries(callers)) {
      const net = own.find((n) => subnet(n) === cidr);
      assert.ok(net, `${caller}=${cidr}: no network of the ${callee}'s has that subnet`);
      used.add(net);
      const on = Object.entries(compose.services)
        .filter(([name, service]) => name !== callee && networksOf(service).includes(net))
        .map(([name]) => name);
      assert.equal(on.length, 1, `${net}: ${on.join(", ")}`);
      // "edge+orchestrator=…": the services one container still is (lib/service-token.mjs).
      for (const one of caller.split("+")) {
        assert.ok(RUNS[on[0]].includes(one), `${net} is ${on[0]}'s, not ${one}'s`);
      }
      assert.equal(compose.networks[net].internal, true, `${net}: no way out`);
    }
    // Every internal network of the service's is a caller's or a callee's: the broker's are its
    // callers' alone.
    if (callee === "broker") assert.equal(used.size, own.length);
    // And a caller shares no other network with it: Docker's DNS answers the service's name
    // with its address on a network that isn't internal first (`default`), where SERVICE_NETWORKS
    // names no caller, and every call would be refused.
    for (const [name, service] of Object.entries(compose.services)) {
      if (name === callee) continue;
      const shared = networksOf(service).filter((n) => own.includes(n));
      const named = shared.filter((n) => used.has(n));
      if (!named.length) continue;
      assert.deepEqual(shared, named, `${name} and ${callee} share ${shared.join(", ")}`);
    }
  });
}

// The GitHub App's key is the github service's alone (#502): its volume is mounted nowhere
// else, and nothing else is told where GitHub's key or an installation token is.
test("compose.yaml: only the github service holds the App's key", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  const holders = Object.entries(compose.services)
    .filter(([, s]) => (s.volumes ?? []).some((v) => String(v).startsWith("github-key:")))
    .map(([name]) => name);
  assert.deepEqual(holders, ["github"]);
  // It gets none of the other services' secrets.
  const { github, models } = compose.services;
  const secrets = Object.keys(models.environment).filter(
    (name) => /TOKEN|KEY|SECRET|AUTH_FILE/.test(name) && !name.startsWith("KUBERNETES_"),
  );
  for (const name of secrets)
    assert.ok(!(name in github.environment), `${name} on the github service`);
});

// Edge holds the webhook secret, the session key and the OAuth client's (#506), in its own volume
// and nowhere else; the orchestrator holds no secret: none in its settings, no secret's volume.
test("compose.yaml: edge holds its three secrets alone, the orchestrator none", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  const { edge, orchestrator } = compose.services;
  const secretLike = (name) =>
    /TOKEN|KEY|SECRET|AUTH_FILE|PASSWORD|PEM/.test(name) && !name.startsWith("KUBERNETES_");
  for (const [service, { environment = {} }] of Object.entries({ edge, orchestrator })) {
    assert.deepEqual(Object.keys(environment).filter(secretLike), [], `${service}'s settings`);
  }
  const holders = Object.entries(compose.services)
    .filter(([, s]) => (s.volumes ?? []).some((v) => String(v).startsWith("edge-data:")))
    .map(([name]) => name);
  assert.deepEqual(holders, ["edge"]);
  // Edge: its volume and the configuration folder, read only; nothing of another service's.
  assert.deepEqual(
    edge.volumes.map((v) => String(v).split(":")[0]),
    ["edge-data", "${DECKHAND_SERVER_DIR"],
  );
  for (const volume of orchestrator.volumes) {
    assert.doesNotMatch(String(volume), /key|credentials|docker\.sock|edge-data/, volume);
  }
  // Only edge is published, and only edge is on a network with a way out.
  const published = Object.entries(compose.services)
    .filter(([, s]) => s.ports?.length)
    .map(([name]) => name);
  assert.deepEqual(published, ["edge"]);
  assert.ok(
    networksOf(orchestrator).every((n) => compose.networks[n]?.internal === true),
    `the orchestrator's networks: ${networksOf(orchestrator).join(", ")}`,
  );
});

// Blob storage's settings and key pair (#606) are the runner's and the broker's alone, the
// services that keep blobs: never the orchestrator's or edge's (the orchestrator holds no
// secret), nor the github or models service's.
test("compose.yaml: only the runner and the broker get blob storage's settings", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  const names = ["BLOB_URL", "BLOB_ACCESS_KEY_ID", "BLOB_SECRET_ACCESS_KEY"];
  for (const service of ["runner", "broker"]) {
    for (const name of names) {
      assert.equal(compose.services[service].environment[name], `\${${name}:-}`, `${service}`);
    }
  }
  for (const [service, { environment = {} }] of Object.entries(compose.services)) {
    if (service === "runner" || service === "broker") continue;
    const named = Object.keys(environment).filter((name) => name.startsWith("BLOB_"));
    assert.deepEqual(named, [], `${service}'s settings`);
  }
});

// The Docker socket is root on the host: only the runner holds it (#503), and the runner holds
// none of the listener's secrets (the App's key is in the listener's data volume). The agents'
// credentials are the models service's alone (#504): its environment and the credentials
// folder, no other service's.
test("compose.yaml: only the runner mounts the Docker socket, only the models service gets the agents' credentials", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  const socket = Object.entries(compose.services)
    .filter(([, s]) => (s.volumes ?? []).some((v) => String(v).includes("docker.sock")))
    .map(([name]) => name);
  assert.deepEqual(socket, ["runner"]);
  const { runner, models } = compose.services;
  assert.ok(!runner.volumes.some((v) => /^data:|credentials/.test(String(v))));
  for (const name of AGENT_SECRETS)
    assert.ok(name in models.environment, `${name}: not the models'`);
  for (const [service, { environment = {}, volumes = [] }] of Object.entries(compose.services)) {
    if (service === "models") continue;
    for (const name of AGENT_SECRETS) assert.ok(!(name in environment), `${name} on ${service}`);
    assert.ok(!volumes.some((v) => /credentials/.test(String(v))), `credentials on ${service}`);
  }
  // Read only: the refreshed logins go in its store, sealed.
  assert.ok(models.volumes.some((v) => /:\/data\/credentials:ro$/.test(String(v))));
});

// The services but the runner run as node, without capabilities, and on a read-only root but the
// github service: what a hole in one of them gets is that user's (#536). An exception has to say
// why here.
const AS_ROOT = { runner: "the host's Docker socket, root-equivalent anyway" };
const WRITES_ITS_ROOT = { github: "its git mirrors and pushes' spool, in the temp folder" };

test("compose.yaml and the Dockerfiles: every service but the runner runs as node, read-only and without capabilities", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  for (const name of Object.keys(RUNS)) {
    const service = compose.services[name];
    const dockerfile = readFileSync(join(root, service.build.dockerfile), "utf8");
    // The final stage's last USER: what the released image runs as.
    const final = dockerfile.split(/^FROM /m).at(-1);
    const user = [...final.matchAll(/^USER (\S+)/gm)].at(-1)?.[1];
    assert.ok(!service.user, `${name}: compose sets its user`);
    if (AS_ROOT[name]) {
      assert.equal(user, undefined, `${name}: root, for ${AS_ROOT[name]}`);
      continue;
    }
    assert.equal(user, "node", `${name}: its Dockerfile's USER`);
    assert.deepEqual(service.cap_drop, ["ALL"], `${name}: cap_drop`);
    assert.ok(!service.cap_add, `${name}: cap_add`);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"], `${name}: security_opt`);
    assert.equal(service.read_only, WRITES_ITS_ROOT[name] ? undefined : true, `${name}: read_only`);
  }
});

// The runner checks again what the orchestrator decided (the grants, the names it gives Docker
// objects, the agents' volumes): given other values, it refuses every run, or checks against
// other grants than the orchestrator built the spec from.
test("compose.yaml: the runner gets every setting its checks read, as the orchestrator has it", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  const { runner, orchestrator: listener } = compose.services;
  for (const name of [
    "GRANTS_DIR",
    "NAME_PREFIX",
    "RUNNER",
    "INSTALL_NETWORK",
    "CLAUDE_CODE_VOLUME",
    "CODEX_VOLUME",
    "AGY_VOLUME",
  ]) {
    assert.ok(name in listener.environment, `${name}: not the orchestrator's`);
    assert.equal(runner.environment[name], listener.environment[name], `${name} on the runner`);
  }
  // The same configuration folder, for what config.yaml and grants/ say.
  const server = (s) => s.volumes.find((v) => String(v).includes(":/etc/deckhand"));
  assert.ok(server(listener));
  assert.equal(server(runner), server(listener));
});

test("the check fails on a network that joins too much", () => {
  // A service compose.yaml would add without saying what it runs.
  assert.deepEqual(
    problems({ services: { edge: {}, cache: {}, sandbox: { network_mode: "none" } } }),
    [
      "cache: not in RUNS, and on a network",
      "cache and edge share default, and neither calls the other",
      "cache: on default, which it doesn't call over",
    ],
  );
  // A service the proxy calls on a runs' network; the proxy on an internal network it calls
  // nothing over.
  assert.deepEqual(
    problems({
      services: {
        github: { networks: ["runs", "outside"] },
        egress: { networks: ["runs", "lonely"] },
      },
      networks: {
        runs: { internal: true, labels: { "deckhand.role": "runs" } },
        lonely: { internal: true },
        outside: {},
      },
    }),
    [
      "github: on the runs' network runs, which only the proxy may be on",
      "egress: on lonely, which it doesn't call over",
    ],
  );
  assert.deepEqual(problems({ services: { edge: { labels: { "deckhand.role": "egress" } } } }), [
    "deckhand.role=egress names a service that isn't the proxy",
  ]);
});

test("a run's network: the runner joins the proxy to it, and nothing else", async () => {
  const connected = [];
  const docker = async (args) => {
    if (args[0] === "network" && args[1] === "connect") connected.push(args.at(-1));
    if (args[0] === "network" && args[1] === "inspect") return { code: 0, out: "true", err: "" };
    return { code: 0, out: "deckhand", err: "" };
  };
  const networks = createNetworks({
    config: {
      prefix: "deckhand",
      subnets: null,
      egressContainer: "egress-container",
      egressProxy: "http://egress:3128",
    },
    docker,
    log: () => {},
    now: () => 0,
  });
  await networks.create("deckhand-run-1");
  assert.deepEqual(connected, ["egress-container"]);
});

test("compose.yaml: edge gets ALLOWED_REPOS, as the orchestrator does: it passes on CI's deliveries for those repos only", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  for (const name of ["edge", "orchestrator"]) {
    assert.equal(
      compose.services[name].environment.ALLOWED_REPOS,
      "${ALLOWED_REPOS:-}",
      `${name}'s ALLOWED_REPOS`,
    );
  }
});

// Docker's default address pools (`default-address-pools`: 172.17–172.31 in /16s, 192.168 in
// /20s), where `docker network create` and other compose projects take their subnets, and the
// rest of 172.16.0.0/12 with them, where hosts' own networks (VPNs, other bridges) often are. A fixed subnet there clashes on a busy host:
// `Pool overlaps with other one on this address space`, and compose doesn't come up (#543).
const DOCKER_POOLS = ["172.16.0.0/12", "192.168.0.0/16"];

// Every `${NAME_SUBNET:-default}` in compose.yaml → its defaults, in the order they appear.
function subnetDefaults(text) {
  const found = new Map();
  for (const [, name, cidr] of text.matchAll(/\$\{([A-Z_]+_SUBNET):-([^}]+)\}/g)) {
    found.set(name, [...(found.get(name) ?? []), cidr]);
  }
  return found;
}

// What is wrong with compose.yaml's fixed subnets: [] when nothing.
function subnetProblems(text) {
  const found = [];
  const compose = readCompose(text);
  // A subnet is written once on its network and once in each SERVICE_NETWORKS naming it: one
  // edited alone, and the services on that network refuse each other's calls.
  for (const [name, cidrs] of subnetDefaults(text)) {
    const distinct = [...new Set(cidrs)].sort();
    if (distinct.length > 1) found.push(`${name}: written as ${distinct.join(" and ")}`);
  }
  const fixed = Object.entries(compose.networks ?? {}).flatMap(([net, options]) =>
    (options?.ipam?.config ?? []).map(({ subnet }) => [
      net,
      String(subnet).replace(/^\$\{[A-Z_]+:-(.+)\}$/, "$1"),
    ]),
  );
  for (const [i, [net, cidr]] of fixed.entries()) {
    if (!parseCidr(cidr)) found.push(`${net}: ${cidr} isn't an IPv4 range`);
    for (const pool of DOCKER_POOLS) {
      if (overlaps(cidr, pool)) found.push(`${net}: ${cidr} is in Docker's pool ${pool}`);
    }
    for (const [other, theirs] of fixed.slice(i + 1)) {
      if (overlaps(cidr, theirs)) found.push(`${net} and ${other} overlap: ${cidr}, ${theirs}`);
    }
  }
  return found;
}

test("compose.yaml: each fixed subnet is written the same everywhere, apart from the others and Docker's pools", () => {
  const text = readFileSync(join(root, "compose.yaml"), "utf8");
  assert.deepEqual(subnetProblems(text), []);
  // The runner network's, named on both sides: the orchestrator's calls to the runner, the
  // runner's from the orchestrator.
  const compose = readCompose(text);
  const runner = compose.networks.runner.ipam.config[0].subnet;
  const { orchestrator, runner: service } = compose.services;
  assert.ok(orchestrator.environment.SERVICE_NETWORKS.includes(`runner=${runner},`));
  assert.ok(service.environment.SERVICE_NETWORKS.includes(`orchestrator=${runner},`));
  // Each network with a fixed subnet has a variable of its own, which the first check reads.
  const fixed = Object.values(compose.networks).filter((n) => n?.ipam);
  assert.equal(subnetDefaults(text).size, fixed.length);
});

test("the subnet check fails on one written apart, two that overlap, one in Docker's pools", () => {
  const text = readFileSync(join(root, "compose.yaml"), "utf8");
  // Each of the runner network's three, edited alone.
  const runner = "${RUNNER_SUBNET:-10.231.250.48/28}";
  const at = [...text.matchAll(RegExp(RegExp.escape(runner), "g"))].map((m) => m.index);
  assert.equal(at.length, 3);
  for (const index of at) {
    const edited =
      text.slice(0, index) +
      "${RUNNER_SUBNET:-10.231.251.48/28}" +
      text.slice(index + runner.length);
    assert.deepEqual(subnetProblems(edited), [
      "RUNNER_SUBNET: written as 10.231.250.48/28 and 10.231.251.48/28",
    ]);
  }
  // The runner network everywhere on its old default, in Docker's pools (#543).
  assert.deepEqual(subnetProblems(text.replaceAll("10.231.250.48/28", "172.31.253.0/24")), [
    "runner: 172.31.253.0/24 is in Docker's pool 172.16.0.0/12",
  ]);
  assert.deepEqual(subnetProblems(text.replaceAll("10.231.250.0/28", "192.168.7.0/28")), [
    "broker-orchestrator: 192.168.7.0/28 is in Docker's pool 192.168.0.0/16",
  ]);
  // Two networks on one subnet.
  assert.deepEqual(subnetProblems(text.replaceAll("10.231.250.224/28", "10.231.250.192/28")), [
    "github-edge and edge-orchestrator overlap: 10.231.250.192/28, 10.231.250.192/28",
  ]);
});

// Text for `docker compose logs`, JSON with one line in .env for a collector (#547): the
// services' own default, unset, is JSON (lib/log.mjs).
test("compose.yaml: every Deckhand service logs as LOG_FORMAT says, text by default", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  for (const name of Object.keys(RUNS)) {
    const { environment = {} } = compose.services[name];
    assert.equal(environment.LOG_FORMAT, "${LOG_FORMAT:-text}", `${name}'s LOG_FORMAT`);
    assert.equal(environment.LOG_LEVEL, "${LOG_LEVEL:-}", `${name}'s LOG_LEVEL`);
  }
});

// The ports compose.yaml's services are reached on: those their callers' URLs name
// (http://broker:8081), and those it publishes.
function portsOf(compose, name) {
  const ports = new Set();
  const text = JSON.stringify(compose.services);
  for (const [, port] of text.matchAll(new RegExp(`http://${name}:(\\d+)`, "g"))) ports.add(port);
  for (const port of compose.services[name].ports ?? []) ports.add(String(port).split(":").at(-1));
  return ports;
}

test("compose.yaml: every long-running service has a health check on its own port, the others wait for it, and its logs rotate", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  const { options } = compose["x-logging"];
  assert.equal(compose["x-logging"].driver, "json-file");
  assert.ok(options["max-size"] && options["max-file"], "the logs rotate");
  const running = Object.entries(compose.services).filter(([, s]) => s.restart !== "no");
  assert.deepEqual(running.map(([name]) => name).sort(), Object.keys(RUNS).sort());
  for (const [name, service] of running) {
    assert.equal(service.logging, "alias-logging", `${name}: the logging anchor`);
    const probe = /fetch\('http:\/\/127\.0\.0\.1:(\d+)(\/health|\/ready)'\)/.exec(
      service.healthcheck?.test ?? "",
    );
    assert.ok(probe, `${name}: a health check calling its /health or /ready`);
    assert.ok(portsOf(compose, name).has(probe[1]), `${name}: ${probe[1]} isn't its port`);
    // A copy waiting for its lease answers /ready with 503 and is still up.
    if (["orchestrator", "runner"].includes(name)) assert.equal(probe[2], "/health", name);
    assert.ok(service.healthcheck.start_interval, `${name}: checked often while it starts`);
    for (const [on, wait] of Object.entries(service.depends_on ?? {})) {
      assert.equal(wait?.condition, "service_healthy", `${name} waits for ${on} to be healthy`);
    }
  }
  // The orchestrator starts once every service it calls is ready.
  assert.deepEqual(
    Object.keys(compose.services.orchestrator.depends_on).sort(),
    [...CALLS.orchestrator].sort(),
  );
});
