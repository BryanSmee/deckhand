// The policy service's metrics (#660): the decisions it evaluates and how long opa took on them,
// against the 2 s limit (engine.mjs TIMEOUT_MS), and each load of the operator's policies.
// Declared on the service's registry (../lib/metrics.mjs), served on METRICS_PORT. Each copy
// counts what it answered: add the copies up.

// The decisions the callers ask (../listener/policies.mjs DECISIONS, which a test holds this
// to: the listener isn't in this image), `capabilities`, what a run gets as it starts, and
// `access`, who may do what where (#730).
export const POLICIES = [
  "run",
  "merge",
  "review",
  "fix",
  "link_branch",
  "request_review",
  "github",
  "push",
  "grant",
  "capabilities",
  "access",
];
// What a decision gave:
//   allow  its layers' allow rules true and no deny (capabilities: evaluated, the caller
//          reading what each mode gets)
//   deny   an allow rule false or a deny rule's reason
//   error  the policies couldn't be evaluated (they don't compile, took over 2 s, gave a rule
//          the wrong type, opa down): the caller refuses
export const DECISION_RESULTS = ["allow", "deny", "error"];
// A load of the operator's policies (the first a decision read, then each change to its files):
//   ok     they compile
//   error  they can't be read, or don't compile: every decision is refused until they are
//          fixed (fail closed, never the last good set)
export const RELOAD_RESULTS = ["ok", "error"];

// From a few milliseconds to past the 2 s limit, where a decision is cut.
export const DECISION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5];

// The hooks the engine calls when no registry is given: counting nothing.
export const NO_METRICS = { decision() {}, reload() {} };

// What evaluate() said (engine.mjs) → allow, deny or error.
export function resultOf(said) {
  if (said.error) return "error";
  const layers = [said.operator, said.repo].filter(Boolean);
  const allowed = layers.every((l) => l.allow !== false && !l.denies?.length);
  return allowed ? "allow" : "deny";
}

// → the hooks the engine calls: decision(policy, result, seconds), seconds null when opa wasn't
// asked (a set that failed first); reload(result).
export function policyMetrics(registry) {
  const decisions = registry.counter(
    "deckhand_policy_decisions_total",
    "Decisions evaluated, by policy and result (error: the caller refuses).",
    { labels: ["policy", "result"], values: { policy: POLICIES, result: DECISION_RESULTS } },
  );
  const durations = registry.histogram(
    "deckhand_policy_decision_seconds",
    "How long opa took on a decision, in seconds: cut at 2 s.",
    { labels: ["policy"], values: { policy: POLICIES }, buckets: DECISION_BUCKETS },
  );
  const reloads = registry.counter(
    "deckhand_policy_reloads_total",
    "Loads of the operator's policies (the first, then each change), by result: error refuses every decision.",
    { labels: ["result"], values: { result: RELOAD_RESULTS } },
  );
  return {
    decision(policy, result, seconds = null) {
      decisions.inc({ policy, result });
      if (seconds != null) durations.observe({ policy }, seconds);
    },
    reload: (result) => reloads.inc({ result }),
  };
}
