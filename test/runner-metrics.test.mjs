// The runner's metrics (runner/metrics.mjs): what they render from their hooks, and what the
// waiting copy leaves out. Where they are counted is in the tests of what counts them (images,
// kubernetes, runner-service).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistry } from "../lib/metrics.mjs";
import { declareMetrics, runnerMetrics, startFailure } from "../runner/metrics.mjs";

const samples = (text, name) =>
  text.split("\n").filter((line) => line.startsWith(name) && !line.startsWith("#"));

test("the network probe's verdict: absent before the first, kept through one that couldn't tell, the acting copy's alone", async () => {
  const registry = createRegistry();
  let active = true;
  const metrics = runnerMetrics(registry, { runner: "kubernetes", active: () => active });
  assert.deepEqual(samples(await registry.render(), "deckhand_network_isolated"), []);
  metrics.probed("isolated", 3);
  assert.deepEqual(samples(await registry.render(), "deckhand_network_isolated"), [
    "deckhand_network_isolated 1",
  ]);
  metrics.probed("reached", 4);
  metrics.probed("unknown", 300);
  const text = await registry.render();
  assert.deepEqual(samples(text, "deckhand_network_isolated"), ["deckhand_network_isolated 0"]);
  assert.deepEqual(samples(text, "deckhand_network_probes_total"), [
    'deckhand_network_probes_total{result="isolated"} 1',
    'deckhand_network_probes_total{result="reached"} 1',
    'deckhand_network_probes_total{result="unknown"} 1',
  ]);
  assert.ok(text.includes("deckhand_network_probe_seconds_sum 307\n"));
  active = false;
  assert.deepEqual(samples(await registry.render(), "deckhand_network_isolated"), []);
});

test("sandboxes by engine, every engine at 0 from the acting copy; none from the waiting one", async () => {
  const registry = createRegistry();
  let list = [{ engine: "none" }, { engine: "sysbox" }, { engine: "none" }];
  runnerMetrics(registry, { runner: "docker", sandboxes: async () => list, active: () => true });
  assert.deepEqual(samples(await registry.render(), "deckhand_sandboxes_running"), [
    'deckhand_sandboxes_running{engine="none"} 2',
    'deckhand_sandboxes_running{engine="sysbox"} 1',
    'deckhand_sandboxes_running{engine="podman"} 0',
  ]);
  list = null;
  assert.deepEqual(samples(await registry.render(), "deckhand_sandboxes_running"), []);
});

test("startFailure: the backend's reason, the spec check's 403, else error", () => {
  assert.equal(
    startFailure(Object.assign(new Error("x"), { reason: "not_isolated" })),
    "not_isolated",
  );
  assert.equal(startFailure(Object.assign(new Error("x"), { status: 403 })), "refused");
  assert.equal(startFailure(Object.assign(new Error("x"), { reason: "made up" })), "error");
  assert.equal(startFailure(new Error("docker run: no such image")), "error");
});

test("a label outside its values is folded into other: an unknown agent, a made-up reason", async () => {
  const registry = createRegistry();
  const metrics = runnerMetrics(registry, { runner: "docker", active: () => true });
  metrics.installed("someone-else", true);
  metrics.failedToStart("made up");
  const text = await registry.render();
  assert.ok(text.includes('deckhand_agent_installs_total{agent="other",result="ok"} 1\n'));
  assert.ok(text.includes('deckhand_sandboxes_failed_to_start_total{reason="other"} 1\n'));
});

test("Docker's runner has no network probe's metrics", async () => {
  const registry = createRegistry();
  const metrics = runnerMetrics(registry, { runner: "docker", active: () => true });
  metrics.probed("isolated", 1);
  assert.ok(!(await registry.render()).includes("deckhand_network"));
});

test("declareMetrics: the runner's lease held while it acts, its takeovers counted", async () => {
  const registry = createRegistry();
  let active = false;
  const { leases } = declareMetrics(registry, { runner: "docker", active: () => active });
  assert.match(await registry.render(), /^deckhand_lease_held\{lease="runner"\} 0$/m);
  active = true;
  leases.taken();
  const text = await registry.render();
  assert.match(text, /^deckhand_lease_held\{lease="runner"\} 1$/m);
  assert.match(text, /^deckhand_lease_takeovers_total\{lease="runner"\} 1$/m);
});
