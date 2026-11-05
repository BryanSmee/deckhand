// The github service's entry point (#502, service.mjs says what it does): its settings, the
// App's credentials (app.mjs), its store, the broker's keys and its own service tokens, the
// policies its gateways ask, then its port. Two copies may run side by side on one store.
//
// Settings, from the environment (and config.yaml, as the listener reads them):
//   PORT                8080
//   STORE_URL           its store (../lib/store.mjs): file:///data/store, or Redis for two copies
//                       on several nodes (REDIS_PASSWORD)
//   APP_DIR             the App's credentials, its key with them (app.json): /app-key, its own
//                       volume or Secret, never the store
//   SERVICE_NETWORKS    with Docker: each caller's network, service=subnet; none on Kubernetes
//   BROKER_SERVICE_URL  the broker: its keys, and this service's tokens
//   POLICY_SERVICE_URL  the policy service: the runs' writes and pushes
//   GITHUB_URL, GITHUB_API, ALLOWED_REPOS, GRANTS_DIR, DATA_DIR (its git mirrors)
//   DRAIN_SECONDS       how long a stopping copy lets its calls finish (a push, a clone): 280
//   METRICS_PORT        GET /metrics alone (../lib/metrics.mjs): none by default
import { join } from "node:path";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { DRAIN_MS, drainOnSigterm } from "../lib/drain.mjs";
import { createLogger } from "../lib/log.mjs";
import { startMetrics } from "../lib/metrics.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { openStore } from "../lib/store.mjs";
import { createBrokerService } from "../listener/broker-service.mjs";
import { ConfigError, loadConfig, readConfigFile } from "../listener/config.mjs";
import { createGitHub } from "../listener/github.mjs";
import { grantFor, grantOf, grantsBy, loadGrants } from "../listener/grants.mjs";
import { createPolicies } from "../listener/policies.mjs";
import { policyClient } from "../listener/policy-client.mjs";
import { createAppHolder } from "./app.mjs";
import { declareMetrics } from "./metrics.mjs";
import { createGithubService } from "./service.mjs";

const env = process.env;
// Its lines redact the App's key too, once read (below).
const log = createLogger({ service: "github", secrets: () => appKey() });

let started;
try {
  const config = loadConfig(env, readConfigFile(env), { service: "github" });
  // Kubernetes' NetworkPolicies and the pods' own service accounts tell callers apart there:
  // SERVICE_NETWORKS=none says so. Anywhere else, a github service without it takes no call.
  if (!env.SERVICE_NETWORKS) {
    throw new Error(
      "SERVICE_NETWORKS is needed: each caller's network (edge+orchestrator=<subnet>,proxy=<subnet>,runner=<subnet>), or none on Kubernetes",
    );
  }
  const bound = env.SERVICE_NETWORKS === "none" ? null : networkCallers(env.SERVICE_NETWORKS);
  const graceMs = Number(env.DRAIN_SECONDS) > 0 ? Number(env.DRAIN_SECONDS) * 1000 : DRAIN_MS;
  started = { config, bound, graceMs };
} catch (error) {
  if (!(error instanceof ConfigError) && !/SERVICE_NETWORKS/.test(error.message)) throw error;
  log.error(`GitHub service: ${error.message}`);
  process.exit(1);
}
const { config, bound, graceMs } = started;
// Its metrics, on their own port when METRICS_PORT is set: GitHub's calls, its rate limit and
// the git operations (metrics.mjs).
const mirrorDir = join(config.dataDir, "git-mirrors");
const metrics = declareMetrics(
  startMetrics({ service: "github", port: config.metricsPort, log }).registry,
  {
    mirrorDir,
  },
);

// The broker: its keys (run tokens and the callers' service tokens are checked with them,
// offline) and this service's own tokens, for the policy service.
const brokerCaller = createBrokerCaller({
  url: config.brokerServiceUrl,
  service: "github",
  audiences: ["broker", "policy"],
  podTokenFile: config.serviceAccountTokenFile,
  log,
});
const broker = createBrokerService({ caller: brokerCaller, log });

const app = createAppHolder({
  dir: env.APP_DIR || "/app-key",
  api: config.githubApi,
  fetch: metrics.fetch,
  log,
});
function appKey() {
  const pem = app.get()?.credentials.pem;
  return pem ? [pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")] : [];
}
// The App's key never goes in the store: a value holding it is refused there, a blob redacted.
const store = openStore(env.STORE_URL || `file://${join(config.dataDir, "store")}`, {
  password: env.REDIS_PASSWORD,
  secrets: () => appKey(),
});

const { github } = createGitHub(() => app.get());
const policies = createPolicies({
  config,
  github,
  service: policyClient({
    url: config.policyServiceUrl,
    header: () => brokerCaller.header("policy"),
  }),
  log,
});

// The operator's grants, read again at each call: one taken back applies to the next.
const grants = {
  projects: (repo) => grantFor(loadGrants(config), config, repo).allowProjects,
  // Through grantOf(), as the listener reads every grant: its policies' and its files'.
  workflows: async (repo) =>
    (await grantOf(config, repo, { granted: grantsBy(policies) })).allowWorkflows === true,
  workflowSecrets: async (repo) =>
    (await grantOf(config, repo, { granted: grantsBy(policies) })).allowWorkflowSecrets === true,
};

const { server } = createGithubService({
  config,
  store,
  app,
  broker,
  bound,
  policies,
  grants,
  // Granted repos' copies, their pushed workflow files checked against them: a cache.
  mirrorDir,
  metrics,
  log,
});

const port = Number(env.PORT || 8080);
server.listen(port, () => {
  const held = app.info();
  log(
    `Deckhand github service on :${server.address().port}, ${held.configured ? `App ${held.slug}` : "no App yet (edge's /setup)"}`,
  );
});
// Its keys and tokens, asked for until the broker answers; calls wait for them meanwhile.
broker.start().catch((error) => log(`Broker: ${error.message}`));

// A rolling update starts the next copy first: this one, out of rotation (/ready), lets the
// pushes, clones and API calls in flight finish, then exits.
drainOnSigterm([server], {
  graceMs,
  log,
  before: async () => {
    server.startDraining();
    broker.stop();
  },
});
