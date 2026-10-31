// The services the listener is being split into (#499, docs/services.md), and which calls
// which: what the broker hands each one service tokens for (service-token.mjs), and what the
// network test holds compose.yaml to (test/networks.test.mjs). A call that isn't here never
// gets a token, and its two services share no network.
export const SERVICES = [
  "edge",
  "orchestrator",
  "runner",
  "broker",
  "github",
  "models",
  "policy",
  "proxy",
];

// caller → the services it calls. Every one that calls another also calls the broker, for its
// own service tokens; the policy service calls none.
export const CALLS = {
  edge: ["orchestrator", "github", "runner", "broker"],
  // The models service: which credentials it holds (names), their fingerprints, a run's API
  // state, its stream, and the agents' calls of a proxy from before it (#504).
  orchestrator: ["runner", "broker", "github", "policy", "models"],
  // The orchestrator: a run's first tokens, which it has the broker sign once the runner knows
  // the sandbox's network or pod (#503): their claims are the orchestrator's, never the runner's.
  // The policy service: what the operator's policies grant a repository, which it checks every
  // spec, build and preview hook against (#498).
  runner: ["broker", "github", "orchestrator", "policy"],
  broker: ["policy"],
  github: ["policy", "broker"],
  models: ["runner", "broker"],
  policy: [],
  // And the hosts sandboxes are granted.
  proxy: ["github", "models", "broker"],
};

// Whether `caller` calls `callee`.
export const calls = (caller, callee) => CALLS[caller]?.includes(callee) ?? false;
