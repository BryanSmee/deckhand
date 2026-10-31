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
import { calls } from "../lib/services.mjs";
import { createNetworks } from "../listener/runner/networks.mjs";
import { parseYaml } from "../lib/yaml.mjs";

const root = join(import.meta.dirname, "..");

// compose.yaml's services → the services of lib/services.mjs each one runs. The listener runs
// those that haven't moved out yet (#499): each one gets its own entry then.
const RUNS = {
  listener: ["edge", "orchestrator", "runner", "github", "models", "policy"],
  broker: ["broker"],
  egress: ["proxy"],
};

// Those reaching the internet: edge (webhooks and browsers, a published port), github, models
// (the agents' APIs), the runner (registries) and the proxy (the hosts granted to runs).
const INTERNET = ["edge", "github", "models", "runner", "proxy"];

// compose.yaml as lib/yaml.mjs reads it: without its anchors and aliases (the image names),
// which it refuses, and nothing here needs.
function readCompose(text) {
  return parseYaml(
    text.replace(/^(x-[\w-]+:\s*)&[\w-]+\s+/gm, "$1").replace(/:\s+\*([\w-]+)\s*$/gm, ": alias-$1"),
  );
}

// A service's networks: compose's `default` when it names none, nothing with a network_mode.
function networksOf(service) {
  if (service.network_mode) return [];
  const { networks } = service;
  if (!networks) return ["default"];
  return Array.isArray(networks) ? networks : Object.keys(networks);
}

const between = (a, b) =>
  (RUNS[a] ?? []).some((x) => (RUNS[b] ?? []).some((y) => calls(x, y) || calls(y, x)));

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
// (runner/networks.mjs). The listener joins them too, for its broker, until it moves out (#505).
function runsNetworkPeers(services) {
  return Object.entries(services)
    .filter(([, s]) => s.labels?.["deckhand.role"] === "egress")
    .map(([name]) => name);
}

test("compose.yaml: each network joins services that call each other, the runs' the proxy alone", () => {
  const compose = readCompose(readFileSync(join(root, "compose.yaml"), "utf8"));
  assert.deepEqual(problems(compose), []);
  assert.deepEqual(runsNetworkPeers(compose.services), ["egress"]);
});

test("the check fails on a network that joins too much", () => {
  // A service compose.yaml would add without saying what it runs.
  assert.deepEqual(
    problems({ services: { listener: {}, cache: {}, sandbox: { network_mode: "none" } } }),
    [
      "cache: not in RUNS, and on a network",
      "cache and listener share default, and neither calls the other",
      "cache: on default, which it doesn't call over",
    ],
  );
  // The listener on a runs' network; the proxy on an internal network it calls nothing over.
  assert.deepEqual(
    problems({
      services: {
        listener: { networks: ["runs", "outside"] },
        egress: { networks: ["runs", "lonely"] },
      },
      networks: {
        runs: { internal: true, labels: { "deckhand.role": "runs" } },
        lonely: { internal: true },
        outside: {},
      },
    }),
    [
      "listener: on the runs' network runs, which only the proxy may be on",
      "egress: on lonely, which it doesn't call over",
    ],
  );
  assert.deepEqual(
    problems({ services: { listener: { labels: { "deckhand.role": "egress" } } } }),
    ["deckhand.role=egress names a service that isn't the proxy"],
  );
});

test("a run's network: the runner joins the proxy to it, and the listener until its broker moves out", async () => {
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
      listenerContainer: "listener-container",
      egressContainer: "egress-container",
      brokerUrl: "http://listener:8081",
      egressProxy: "http://egress:3128",
    },
    docker,
    log: () => {},
    now: () => 0,
  });
  await networks.create("deckhand-run-1");
  // The listener: for the endpoints its broker serves sandboxes directly (#505 removes it).
  assert.deepEqual(connected, ["listener-container", "egress-container"]);
});
