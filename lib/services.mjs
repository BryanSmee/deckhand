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
  orchestrator: ["runner", "broker", "github", "policy"],
  // The orchestrator: a run's first tokens, which it has the broker sign once the runner knows
  // the sandbox's network or pod (#503): their claims are the orchestrator's, never the runner's.
  runner: ["broker", "github", "orchestrator"],
  broker: ["policy"],
  github: ["policy", "broker"],
  models: ["runner", "broker"],
  policy: [],
  // And the hosts sandboxes are granted.
  proxy: ["github", "models", "broker"],
};

// Whether `caller` calls `callee`.
export const calls = (caller, callee) => CALLS[caller]?.includes(callee) ?? false;
