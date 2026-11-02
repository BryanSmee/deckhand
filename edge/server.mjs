// Edge's entry point (#506): the only service the internet reaches. GitHub's webhooks (their
// HMAC checked, each taken once, put on the stream the orchestrator reads), /setup, sign-in and
// sessions, the dashboard's files, and its API, /status and the screenshots, which the
// orchestrator answers (forward.mjs). It holds the webhook secret, the session key and the
// OAuth client's, nothing else: no App key (the github service's), no agent credential (the
// models service's), no Docker socket (the runner's). Two copies may run side by side on one
// store, both active: either takes any request, the deliveries are taken once, a sign-out ends
// the login's sessions on both, and the redeliveries' poller runs on the one holding its lease.
//
// Settings, from the environment (and config.yaml, as the orchestrator reads them):
//   PORT                8080: webhooks, /setup, sign-in, the dashboard (published)
//   INTERNAL_PORT       8083: the orchestrator's calls (internal.mjs), on their network alone
//   DATA_DIR            /data: the App's credentials but its key (app.json), the session key
//   STORE_URL           its store (../lib/store.mjs): file:///data/store, or Redis for two copies
//                       on several nodes (REDIS_PASSWORD)
//   ALLOWED_USERS       who may sign in (or allowed_users in config.yaml): required
//   PUBLIC_URL, GITHUB_URL, GITHUB_API
//   ORCHESTRATOR_URL    the orchestrator's services port: http://orchestrator:8083
//   GITHUB_SERVICE_URL  /setup's conversion, the redeliveries, the App's reads
//   BROKER_SERVICE_URL  its service tokens, and the keys the orchestrator's are checked with
//   SERVICE_NETWORKS    with Docker, the orchestrator's network to it (orchestrator=<subnet>)
//   DRAIN_SECONDS       how long a stopping copy lets its requests finish (a live log): 25
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activePassive } from "../lib/active.mjs";
import { writeFileAtomic } from "../lib/files.mjs";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { drain } from "../lib/drain.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { openStore } from "../lib/store.mjs";
import { createGithubClient } from "../github/client.mjs";
import { createAuth, importEpochs, sessionKey } from "../listener/auth.mjs";
import { createBrokerService } from "../listener/broker-service.mjs";
import { ConfigError, loadConfig, readConfigFile } from "../listener/config.mjs";
import { createRedeliveries } from "../listener/redeliveries.mjs";
import { createSetup } from "../listener/setup.mjs";
import { serverInfo } from "../listener/status.mjs";
import { createEdgeApp } from "./app.mjs";
import { createForwarder } from "./forward.mjs";
import { createEdgeHttp, takenDelivery } from "./http.mjs";
import { createEdgeInternal } from "./internal.mjs";

const env = process.env;
const log = (...args) => console.log(new Date().toISOString(), ...args);

let config;
let internalPort;
try {
  config = loadConfig(env, readConfigFile(env), { service: "edge" });
  internalPort = Number(env.INTERNAL_PORT || 8083);
  if (!Number.isInteger(internalPort) || internalPort < 0 || internalPort > 65535) {
    throw new ConfigError("INTERNAL_PORT: expected a port");
  }
  if (internalPort && internalPort === config.port) {
    throw new ConfigError("INTERNAL_PORT: not PORT's, which the internet reaches");
  }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Edge: ${error.message}`);
  process.exit(1);
}
const graceMs = Number(env.DRAIN_SECONDS) > 0 ? Number(env.DRAIN_SECONDS) * 1000 : 25_000;
const dataDir = config.dataDir;

// Its service tokens, for the orchestrator and the github service, from the broker, whose keys
// the orchestrator's tokens are checked with.
const brokerCaller = createBrokerCaller({
  url: config.brokerServiceUrl,
  service: "edge",
  audiences: ["broker", "orchestrator", "github"],
  podTokenFile: config.serviceAccountTokenFile,
  log,
});
const broker = createBrokerService({ caller: brokerCaller, log });

const app = createEdgeApp({ dir: dataDir, log });
// The session key, read again once another copy of edge on this volume replaced it (a
// listener's taken over there).
const keyPath = join(dataDir, "session.key");
let key = sessionKey(dataDir);
let keySeen = statSync(keyPath).mtimeMs;
function sessionKeyNow() {
  try {
    const at = statSync(keyPath).mtimeMs;
    if (at !== keySeen) [key, keySeen] = [sessionKey(dataDir), at];
  } catch {
    // Removed by hand: the one in memory signs on until the next start.
  }
  return key;
}
// Its secrets never go in the store: refused in a value, redacted from what people wrote.
const secrets = () => {
  const now = sessionKeyNow();
  return [...app.secrets(), now.toString("hex"), now.toString("base64")];
};
const store = openStore(env.STORE_URL || pathToFileURL(join(dataDir, "store")).href, {
  password: env.REDIS_PASSWORD,
  secrets,
});

// The github service, as edge: reads, /setup's conversion and the redeliveries, never a write
// of a run's (../github/service.mjs ROUTES).
const github = createGithubClient({
  urls: config.githubServiceUrl,
  token: () => brokerCaller.header("github"),
  log,
});
const appClient = () => (app.get() ? github.app(app.get()) : null);

const publicUrl = () =>
  config.publicUrl ?? app.get()?.public_url ?? `http://localhost:${config.port}`;

const setup = createSetup({
  config,
  configured: () => app.get() !== null,
  convert: (code) => github.setup.convert(code),
  onConfigured: (credentials) => app.save(credentials),
  log,
});

const auth = createAuth({
  config,
  app: () => (app.get() ? { credentials: app.get() } : null),
  publicUrl,
  key: sessionKeyNow,
  store,
  log,
});

const redeliveries = createRedeliveries({
  store,
  app: appClient,
  handled: (guid) => takenDelivery(store, guid),
  log,
});

const orchestrator = createForwarder({
  urls: env.ORCHESTRATOR_URL || "http://orchestrator:8083",
  token: () => brokerCaller.header("orchestrator"),
  log,
});

let stopping = false;
const http = createEdgeHttp({
  config,
  app,
  auth,
  setup,
  store,
  orchestrator,
  redeliveries,
  dashboardDir: env.DASHBOARD_DIR || fileURLToPath(new URL("../dashboard/dist", import.meta.url)),
  secrets,
  stopping: () => stopping,
  log,
});

const internal = createEdgeInternal({
  store,
  app,
  keys: { get: (kid) => broker.serviceKeys().get(kid) },
  bound: env.SERVICE_NETWORKS === "none" ? null : networkCallers(config.serviceNetworks ?? ""),
  redeliveries,
  // A listener's session key and sign-outs, with its App: its sessions go on.
  handOver: async ({ sessionKey: legacy, epochs }) => {
    // The sign-outs first: a key taken without them would let cookies signed out of work again.
    const count = await importEpochs(store, epochs);
    const taken = typeof legacy === "string" ? Buffer.from(legacy, "base64") : null;
    if (taken?.length >= 32) {
      // Whole or not at all: the other copy, reading it meanwhile, never sees it cut short.
      writeFileAtomic(keyPath, taken, { mode: 0o600 });
      key = taken;
      keySeen = statSync(keyPath).mtimeMs;
    }
    log(`Sessions: the listener's key${count ? ` and ${count} sign-out(s)` : ""} taken over`);
  },
  log,
});

const { version } = serverInfo(env);
const web = http.listen(config.port);
internal.listen(internalPort, () => log(`Internal port on :${internal.address().port}`));
log(`Deckhand ${version}: edge`);
if (!app.get()) log(`No GitHub App yet. Set it up at ${setup.link()}`);
broker.start().catch((error) => log(`Broker: ${error.message}`));

// The redeliveries' poller on one copy: the one holding its lease (lib/active.mjs). The other
// takes it once this one stops, or within a lease's life after a crash.
const poller = activePassive({
  store,
  name: "edge/redeliveries",
  holder: `edge-${randomUUID()}`,
  onActive: () => redeliveries.start(),
  onPassive: () => redeliveries.stop(),
  log,
});
poller.start();

// A rolling update starts the next copy first: this one takes no new connection, lets the
// requests in flight finish (a live log streams until the browser reconnects to the other),
// gives the poller's lease to the other copy, then exits. Deliveries refused meanwhile are 503:
// GitHub marks them failed, and the next scan asks for them again.
process.once("SIGTERM", async () => {
  stopping = true;
  log("Stopping: requests in flight finish, the poller's lease goes to the other copy");
  await poller.stop().catch(() => false);
  broker.stop();
  const all = await Promise.all([drain(web, { graceMs }), drain(internal, { graceMs })]);
  if (!all.every(Boolean))
    log("Stopping: requests still going at the end of the grace period, cut");
  await store.close().catch(() => {});
  process.exit(0);
});
