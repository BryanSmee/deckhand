// The runner's metrics (#659, on ../lib/metrics.mjs's registry): its sandboxes, the network
// probe's verdict (Kubernetes), repo images and agents' installs. Its lease's are
// ../lib/metrics.mjs leaseMetric()'s, as every two-copy service's.
//
// What declares them is here; what counts them is where it happens, through the hooks this
// returns (an optional `metrics` of the service, ../listener/images.mjs, the backends and
// ../listener/runner/kube-probe.mjs): a caller without one counts nothing. What only the acting
// copy knows (its sandboxes, the probe's verdict) has no samples on the waiting one.
import { AGENTS } from "../listener/agents/index.mjs";

// Seconds, for a sandbox's start (an image pulled, an agent installed: minutes) and an image's
// build (a big one: tens of minutes).
export const START_BUCKETS = [1, 2.5, 5, 10, 20, 30, 60, 120, 300, 600, 1200];
export const BUILD_BUCKETS = [5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600];
// The probe: a pod started and its targets tried (CONNECT_MS each, at once), up to
// KUBERNETES_PENDING_MINUTES and a minute when its pod waits.
export const PROBE_BUCKETS = [1, 2.5, 5, 10, 20, 30, 60, 120, 300, 600];

export const ENGINES = ["none", "sysbox", "podman"];
export const RUNNERS = ["docker", "kubernetes"];

// Why a sandbox didn't start:
//   refused           the runner's spec check (spec-check.mjs) refused it
//   not_isolated      Kubernetes: the sandboxes' NetworkPolicies missing, or not enforced
//                     (the network probe)
//   isolation_unknown Kubernetes: the network probe couldn't tell
//   unschedulable     Kubernetes: Pending past KUBERNETES_PENDING_MINUTES, no node for it
//   image_pull        Kubernetes: Pending past it, an image its node can't pull
//   agent_install     Kubernetes: its init container's install failed, or outlasted the wait
//   network_gate      Kubernetes: its NetworkPolicies never applied (kube-gate.mjs)
//   pending           Kubernetes: Pending past the wait for another reason (a volume, say)
//   error             anything else: Docker's errors, the API's
export const START_FAILURES = [
  "refused",
  "not_isolated",
  "isolation_unknown",
  "unschedulable",
  "image_pull",
  "agent_install",
  "network_gate",
  "pending",
  "error",
];

// The network probe's results: isolated (a sandbox reaches the egress proxy alone), reached (it
// reached something else: every run refused), unknown (it couldn't tell, tried again at the next
// run's start).
export const PROBE_RESULTS = ["isolated", "reached", "unknown"];

// A repo image's old tag: deleted, kept (a sandbox still runs it), or not deleted (an error).
export const PRUNE_RESULTS = ["deleted", "kept", "failed"];

// `runner`: RUNNER (docker, kubernetes). `sandboxes()`: the acting copy's sandboxes as
// [{ engine }], or null on the waiting copy (no samples). `active()`: whether this copy acts.
export function runnerMetrics(registry, { runner, sandboxes = async () => null, active }) {
  registry.gauge(
    "deckhand_sandboxes_running",
    "Sandboxes running (Pending pods included), by the container engine they have.",
    {
      labels: ["engine"],
      values: { engine: ENGINES },
      collect: async () => {
        const list = await sandboxes();
        if (!list) return [];
        const counts = Object.fromEntries(ENGINES.map((engine) => [engine, 0]));
        for (const { engine } of list) counts[engine] = (counts[engine] ?? 0) + 1;
        return Object.entries(counts).map(([engine, n]) => [{ engine }, n]);
      },
    },
  );
  const startSeconds = registry.histogram(
    "deckhand_sandbox_start_seconds",
    "From a sandbox's start asked to its running: on Kubernetes until its pod leaves Pending (its image's pull, its agent's install, its network gate), in seconds.",
    { labels: ["runner"], values: { runner: RUNNERS }, buckets: START_BUCKETS },
  );
  const failed = registry.counter(
    "deckhand_sandboxes_failed_to_start_total",
    "Sandboxes that didn't start, by why.",
    { labels: ["reason"], values: { reason: START_FAILURES } },
  );

  // The network probe's (Kubernetes' alone: Docker's runs each have an internal network of
  // their own, nothing to probe). Its verdict absent before the first, and on the waiting copy.
  const probe = runner === "kubernetes" ? probeMetrics(registry, active) : null;

  const builds = registry.counter(
    "deckhand_image_builds_total",
    "Repo images built, by result (ok, error).",
    { labels: ["runner", "result"], values: { runner: RUNNERS, result: ["ok", "error"] } },
  );
  const buildSeconds = registry.histogram(
    "deckhand_image_build_seconds",
    "How long a repo image's build took, failed ones too, in seconds.",
    { buckets: BUILD_BUCKETS },
  );
  const prunes = registry.counter(
    "deckhand_image_prunes_total",
    "Old repo image tags pruned, by result: deleted, kept (in use), failed.",
    { labels: ["result"], values: { result: PRUNE_RESULTS } },
  );
  const installs = registry.counter(
    "deckhand_agent_installs_total",
    "Agents' installs into their shared volume, by result (ok, error); none where each sandbox installs its own (Kubernetes without a claim).",
    {
      labels: ["agent", "result"],
      values: { agent: Object.keys(AGENTS), result: ["ok", "error"] },
    },
  );

  // At 0 from the start, every series a counter may have: a rate needs its first sample.
  for (const reason of START_FAILURES) failed.inc({ reason }, 0);
  for (const result of ["ok", "error"]) {
    builds.inc({ runner, result }, 0);
    for (const agent of Object.keys(AGENTS)) installs.inc({ agent, result }, 0);
  }
  for (const result of PRUNE_RESULTS) prunes.inc({ result }, 0);

  return {
    // A sandbox running, `seconds` after its start was asked.
    started: (seconds) => startSeconds.observe({ runner }, seconds),
    failedToStart: (reason) => failed.inc({ reason }),
    // `result`: PROBE_RESULTS'.
    probed: (result, seconds) => probe?.(result, seconds),
    built(ok, seconds) {
      builds.inc({ runner, result: ok ? "ok" : "error" });
      buildSeconds.observe(seconds);
    },
    pruned: (result) => prunes.inc({ result }),
    installed: (agent, ok) => installs.inc({ agent, result: ok ? "ok" : "error" }),
  };
}

// The network probe's metrics → probed(result, seconds), its verdict kept for the gauge unless
// it couldn't tell.
function probeMetrics(registry, active) {
  let isolated = null;
  registry.gauge(
    "deckhand_network_isolated",
    "1 when the network probe found the sandboxes isolated, 0 when one reached what it mustn't (every run refused); absent before its first verdict.",
    { collect: () => (isolated === null || !active() ? [] : [[{}, isolated]]) },
  );
  const probes = registry.counter(
    "deckhand_network_probes_total",
    "Network probes, by their result: isolated, reached, unknown (couldn't tell).",
    { labels: ["result"], values: { result: PROBE_RESULTS } },
  );
  const seconds = registry.histogram(
    "deckhand_network_probe_seconds",
    "How long a network probe took, its pod's start included, in seconds.",
    { buckets: PROBE_BUCKETS },
  );
  for (const result of PROBE_RESULTS) probes.inc({ result }, 0);
  return (result, took) => {
    probes.inc({ result });
    seconds.observe(took);
    if (result !== "unknown") isolated = result === "isolated" ? 1 : 0;
  };
}

// Why a sandbox's start failed, as START_FAILURES name it: the backend's `reason` when it set
// one (kubernetes.mjs), `refused` for the spec check's 403, else `error`.
export const startFailure = (error) =>
  START_FAILURES.includes(error?.reason)
    ? error.reason
    : error?.status === 403
      ? "refused"
      : "error";
