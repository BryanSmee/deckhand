// The services Deckhand runs as (#499, docs/services.md), and which calls which: what the
// broker hands each one service tokens for (service-token.mjs), and what the network test holds
// compose.yaml to (test/networks.test.mjs). A call that isn't here never gets a token, and its
// two services share no network.
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
  // The orchestrator: the dashboard's API, /status and the screenshots, which edge passes on
  // with the signed-in user (#506), the runs' live logs among them. The github service: /setup's
  // conversion, the redeliveries, the App's reads.
  edge: ["orchestrator", "github", "broker"],
  // The models service: which credentials it holds (names), their fingerprints, a run's API
  // state, its stream, and the agents' calls of a proxy from before it (#504). Edge: the
  // verified deliveries' stream, the App's public parts, the dashboard's "from" tags (#506).
  orchestrator: ["runner", "broker", "github", "policy", "models", "edge"],
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
