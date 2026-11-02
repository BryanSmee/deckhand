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
  // state and its stream (#504). Edge: the
  // verified deliveries' stream, the App's public parts, the dashboard's "from" tags (#506).
  orchestrator: ["runner", "broker", "github", "policy", "models", "edge"],
  // The orchestrator: a run's first tokens, which it has the broker sign once the runner knows
  // the sandbox's network or pod (#503): their claims are the orchestrator's, never the runner's.
  // The policy service: what the operator's policies grant a repository, which it checks every
  // spec and build against (#498).
  runner: ["broker", "github", "orchestrator", "policy"],
  broker: ["policy"],
  github: ["policy", "broker"],
  models: ["runner", "broker"],
  policy: [],
  // And the hosts sandboxes are granted.
  proxy: ["github", "models", "broker"],
};

// What sandboxes call the broker, the github and the models service by: names the egress proxy
// alone reads (a sandbox resolves none), forwarding their plain HTTP to its own URL for each
// (BROKER_SERVICE_URL, GITHUB_SERVICE_URL, MODELS_SERVICE_URL), once the orchestrator's egress
// policy said the caller is a run's sandbox or engine. The same everywhere, so a sandbox started
// before an update calls the same names after it.
export const SANDBOX_URLS = {
  broker: "http://broker:8081",
  github: "http://github:8080",
  models: "http://models:8080",
};

// The egress proxy's second port, for a run's container engine where it shares its sandbox's
// address (a Kubernetes pod, #573): what arrives there is the engine's (its pulls, its builds and
// containers), whose HTTPS the proxy never decrypts, as the orchestrator answers only for a run
// that has one (../listener/egress-http.mjs). On Docker, the engine has an address of its own.
export const ENGINE_PROXY_PORT = 3129;

// Whether `caller` calls `callee`.
export const calls = (caller, callee) => CALLS[caller]?.includes(callee) ?? false;
