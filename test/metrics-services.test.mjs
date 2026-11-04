// Every service's metrics together (#651): built as each server builds them, they are the ones
// their code declares, documented in docs/setup.md, with bounded labels only, and no two
// services declare one name for different things.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { brokerMetrics } from "../broker/metrics.mjs";
import { edgeMetrics } from "../edge/metrics.mjs";
import { githubMetrics } from "../github/metrics.mjs";
import {
  buildInfo,
  createRegistry,
  leaseMetric,
  processMetrics,
  UNBOUNDED_LABELS,
} from "../lib/metrics.mjs";
import { fallbacksMetric, orchestratorMetrics, serviceCallMetrics } from "../listener/metrics.mjs";
import { modelMetrics } from "../models/metrics.mjs";
import { policyMetrics } from "../policy-service/metrics.mjs";
import { egressMetrics } from "../proxy/metrics.mjs";
import { runnerMetrics } from "../runner/metrics.mjs";

const repo = join(import.meta.dirname, "..");
const read = (...path) => readFileSync(join(repo, ...path), "utf8");

// Each service's registry, with what every service has (lib/metrics.mjs startMetrics()) and its
// own, the outside stubbed: what a scrape collects doesn't matter here, only what is declared.
function registries(t) {
  const common = (service) => {
    const registry = createRegistry();
    buildInfo(registry, { service, version: "test" });
    const { stop } = processMetrics(registry);
    t.after(stop);
    return registry;
  };
  const services = {};
  const add = (service, build) => {
    const registry = common(service);
    build(registry);
    services[service] = registry;
  };
  add("edge", (r) => {
    edgeMetrics(r, { store: null });
    leaseMetric(r, { "edge/redeliveries": () => false });
  });
  add("orchestrator", (r) => {
    serviceCallMetrics(r);
    leaseMetric(r, { orchestrator: () => false });
    orchestratorMetrics(r, { ctx: () => null });
    fallbacksMetric(r);
  });
  add("runner", (r) => {
    // The Kubernetes backend: its network probe's metrics on top of what Docker has.
    runnerMetrics(r, { runner: "kubernetes", active: () => false });
    leaseMetric(r, { runner: () => false });
  });
  add("broker", (r) => brokerMetrics(r, { runs: { live: () => 0 } }));
  add("github", (r) => githubMetrics(r, { fetch: async () => new Response("") }));
  add("models", (r) => modelMetrics(r));
  add("policy", (r) => policyMetrics(r));
  add("egress", (r) => egressMetrics(r));
  return services;
}

// A registry's metrics: name → { type, labels } from its rendering's # TYPE lines and samples.
async function described(registry) {
  const text = await registry.render();
  const metrics = new Map();
  for (const [, name, type] of text.matchAll(/^# TYPE (\S+) (\S+)$/gm)) {
    metrics.set(name, { type, labels: new Set() });
  }
  for (const [, sample, labels] of text.matchAll(/^(deckhand_[a-z0-9_]+)\{([^}]*)\}/gm)) {
    const name = sample.replace(/_(bucket|sum|count)$/, "");
    const metric = metrics.get(metrics.has(sample) ? sample : name);
    for (const [, label] of labels.matchAll(/([a-z_]+)="/g)) metric?.labels.add(label);
  }
  return metrics;
}

// Every `deckhand_…` a registry call names in the services' code.
function declaredInCode() {
  const names = new Set();
  const dirs = ["lib", "listener", "edge", "orchestrator", "runner", "broker", "github", "models"];
  for (const dir of [...dirs, "policy-service", "proxy"]) {
    for (const entry of readdirSync(join(repo, dir), { recursive: true })) {
      if (!String(entry).endsWith(".mjs") || String(entry).includes("node_modules")) continue;
      const text = read(dir, String(entry));
      const declared = /\.(?:counter|gauge|histogram)\(\s*"(deckhand_[a-z0-9_]+)"/g;
      for (const [, name] of text.matchAll(declared)) names.add(name);
    }
  }
  return names;
}

test("every service's metrics: those its code declares, documented, their labels bounded", async (t) => {
  const services = registries(t);
  const all = new Map();
  for (const [service, registry] of Object.entries(services)) {
    for (const [name, metric] of await described(registry)) {
      const seen = all.get(name);
      // The same name in two services is the same metric (build_info, the process's, a lease's).
      if (seen) assert.equal(seen.type, metric.type, `${name}: ${service}'s type`);
      all.set(name, metric);
    }
  }
  // Built here, every metric the code declares: none left out of a module this test builds.
  assert.deepEqual([...all.keys()].sort(), [...declaredInCode()].sort());

  const setup = read("docs", "setup.md");
  const section = setup.slice(setup.indexOf("\n## Metrics\n"));
  const undocumented = [...all.keys()].filter((name) => !section.includes(`\`${name}`));
  assert.deepEqual(undocumented, [], "in docs/setup.md's Metrics");

  for (const [name, { labels }] of all) {
    for (const label of labels) {
      if (label === "le") continue;
      assert.ok(!UNBOUNDED_LABELS.has(label), `${name}{${label}}`);
    }
  }
});

test("every service's metric names are its own, but for what all of them share", async (t) => {
  const shared = new Set([
    "deckhand_build_info",
    "deckhand_lease_held",
    "deckhand_lease_takeovers_total",
  ]);
  const owner = new Map();
  for (const [service, registry] of Object.entries(registries(t))) {
    for (const name of (await described(registry)).keys()) {
      if (shared.has(name) || name.startsWith("deckhand_process_")) continue;
      assert.equal(
        owner.get(name) ?? service,
        service,
        `${name}: ${owner.get(name)} and ${service}`,
      );
      owner.set(name, service);
    }
  }
});
