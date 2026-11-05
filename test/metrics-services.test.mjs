// Every service's metrics together (#651): built through the declareMetrics() each server calls
// (#759, held to it below), they are the ones their code declares, documented in docs/setup.md,
// with bounded labels only, and no two services declare one name for different things.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { declareMetrics as broker } from "../broker/metrics.mjs";
import { declareMetrics as edge } from "../edge/metrics.mjs";
import { declareMetrics as github } from "../github/metrics.mjs";
import { buildInfo, createRegistry, processMetrics, UNBOUNDED_LABELS } from "../lib/metrics.mjs";
import { declareMetrics as orchestrator } from "../listener/metrics.mjs";
import { declareMetrics as models } from "../models/metrics.mjs";
import { declareMetrics as policy } from "../policy-service/metrics.mjs";
import { declareMetrics as egress } from "../proxy/metrics.mjs";
import { declareMetrics as runner } from "../runner/metrics.mjs";
import { posix } from "./helpers.mjs";

const repo = join(import.meta.dirname, "..");
const read = (...path) => readFileSync(join(repo, ...path), "utf8");

// Each service: the file its process starts from, which declares its metrics through its
// declareMetrics() alone, imported from `module` (a test below holds them to it), and that
// declareMetrics() with the outside stubbed: what a scrape collects doesn't matter here, only
// what is declared.
const SERVICES = {
  edge: {
    server: "edge/server.mjs",
    module: "./metrics.mjs",
    declare: (r) => edge(r, { store: null, redeliveries: () => false }),
  },
  orchestrator: {
    server: "orchestrator/server.mjs",
    module: "../listener/metrics.mjs",
    declare: (r) => orchestrator(r, { acting: () => false, ctx: () => null }),
  },
  // The Kubernetes backend: its network probe's metrics on top of what Docker has.
  runner: {
    server: "runner/server.mjs",
    module: "./metrics.mjs",
    declare: (r) => runner(r, { runner: "kubernetes", active: () => false }),
  },
  broker: {
    server: "broker/server.mjs",
    module: "./metrics.mjs",
    declare: (r) => broker(r, { runs: { live: () => 0 } }),
  },
  github: {
    server: "github/server.mjs",
    module: "./metrics.mjs",
    declare: (r) => github(r, { fetch: async () => new Response("") }),
  },
  models: { server: "models/server.mjs", module: "./metrics.mjs", declare: (r) => models(r) },
  policy: {
    server: "policy-service/service.mjs",
    module: "./metrics.mjs",
    declare: (r) => policy(r),
  },
  egress: { server: "proxy/proxy.mjs", module: "./metrics.mjs", declare: (r) => egress(r) },
};

// The services' code, but for the bundled graphql-js: [path, text without its comments].
function sources() {
  const dirs = ["lib", "listener", "edge", "orchestrator", "runner", "broker", "github", "models"];
  const files = [];
  for (const dir of [...dirs, "policy-service", "proxy"]) {
    for (const entry of readdirSync(join(repo, dir), { recursive: true })) {
      const path = String(entry);
      if (!path.endsWith(".mjs") || /node_modules|vendor/.test(path)) continue;
      files.push([posix(join(dir, path)), read(dir, path).replace(/\/\/.*$/gm, "")]);
    }
  }
  return files;
}

// Each service's registry, with what every service has (lib/metrics.mjs startMetrics()) and its
// own, as its server declares them.
function registries(t) {
  const services = {};
  for (const [service, { declare }] of Object.entries(SERVICES)) {
    const registry = createRegistry();
    buildInfo(registry, { service, version: "test" });
    const { stop } = processMetrics(registry);
    t.after(stop);
    declare(registry);
    services[service] = registry;
  }
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
  const declared = /\.(?:counter|gauge|histogram)\(\s*"(deckhand_[a-z0-9_]+)"/g;
  for (const [, text] of sources()) {
    for (const [, name] of text.matchAll(declared)) names.add(name);
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

// What the tests above build is what the servers declare: each server calls its own
// declareMetrics(), and nothing outside the metrics.mjs files declares a metric or calls what
// declares them (a builder: `…Metric(s)`, buildInfo) but through it and startMetrics().
test("every server declares its metrics through its own declareMetrics() alone", () => {
  for (const [service, { server, module }] of Object.entries(SERVICES)) {
    const text = read(server).replace(/\/\/.*$/gm, "");
    assert.match(text, /\bdeclareMetrics\(/, `${server}: calls declareMetrics()`);
    const imported = new RegExp(
      `import \\{[^}]*\\bdeclareMetrics\\b[^}]*\\} from "${RegExp.escape(module)}"`,
    );
    assert.match(text, imported, `${service}: its declareMetrics() from ${module}`);
  }
  const builder = /\b([a-zA-Z]\w*Metrics?|buildInfo)\(/g;
  const declaring = /\.(?:counter|gauge|histogram)\(\s*"deckhand_/;
  const allowed = new Set(["declareMetrics", "startMetrics"]);
  for (const [path, text] of sources()) {
    if (path.endsWith("/metrics.mjs")) continue;
    assert.doesNotMatch(text, declaring, `${path}: a metric declared outside a metrics.mjs`);
    const called = [...text.matchAll(builder)].map(([, name]) => name);
    assert.deepEqual(
      called.filter((name) => !allowed.has(name)),
      [],
      `${path}: builders called`,
    );
  }
});
