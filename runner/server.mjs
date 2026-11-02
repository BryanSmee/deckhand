// The runner service's entry point (#503, service.mjs says what it does): its settings, the
// backend (RUNNER: the host's Docker or a Kubernetes cluster), its store, the broker's keys and
// its own service tokens, then its lease: the copy holding it answers, the other waits.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { activePassive } from "../lib/active.mjs";
import { BlobError, blobCredentials, blobSecrets, startBlobs } from "../lib/blobs.mjs";
import { DRAIN_MS } from "../lib/drain.mjs";
import { healthInfo } from "../lib/health.mjs";
import { createLogger } from "../lib/log.mjs";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { serviceClient } from "../lib/service-client.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { openStore } from "../lib/store.mjs";
import { keyFolder } from "../lib/tokens.mjs";
import { createBrokerService } from "../listener/broker-service.mjs";
import { checkout } from "../listener/checkout.mjs";
import { ConfigError, loadConfig, readConfigFile } from "../listener/config.mjs";
import { createImages } from "../listener/images.mjs";
import { grantsBy } from "../listener/grants.mjs";
import { policyClient } from "../listener/policy-client.mjs";
import { createPolicies } from "../listener/policies.mjs";
import { createBackend } from "../listener/runner/index.mjs";
import { createLogs } from "./logs.mjs";
import { createRunnerService, loginRefresh } from "./service.mjs";

const env = process.env;
// Blob storage's credentials (BLOB_URL's, S3's): its secret key is redacted from its lines.
let credentials = null;
const secrets = () => blobSecrets(credentials);
const log = createLogger({ service: "runner", secrets });

let config;
let backend;
let bound;
let brokerCaller;
try {
  config = loadConfig(env, readConfigFile(env), { service: "runner" });
  credentials = blobCredentials(env);
  // Kubernetes' NetworkPolicies and the pods' own service accounts tell callers apart there
  // (#396): SERVICE_NETWORKS=none says so. Anywhere else, a runner without it takes no call.
  bound = env.SERVICE_NETWORKS === "none" ? null : networkCallers(env.SERVICE_NETWORKS);
  // The broker service (#505): this service's tokens, for the broker itself (the runs' inboxes
  // and files), the github service (the repos' tarballs), the orchestrator (a run's first
  // tokens) and the policy service (what the operator's policies grant a repository, #498).
  brokerCaller = createBrokerCaller({
    url: config.brokerServiceUrl,
    service: "runner",
    audiences: ["broker", "github", "orchestrator", "policy"],
    podTokenFile: config.serviceAccountTokenFile,
    log,
  });
  mkdirSync(join(config.dataDir, "runs"), { recursive: true });
  // Each run's inbox and files, copied to the broker service as they change, which serves them
  // to the sandbox (../listener/runner/inbox.mjs `mirror`).
  const { mirror } = createBrokerService({ caller: brokerCaller, log });
  backend = createBackend({ config, inboxDir: join(config.dataDir, "runs"), mirror, log });
} catch (error) {
  if (
    !(error instanceof ConfigError) &&
    !(error instanceof BlobError) &&
    !/SERVICE_NETWORKS/.test(error.message)
  )
    throw error;
  log.error(error.message);
  process.exit(1);
}

// Blob storage's secret key never goes in it: refused in a value, redacted from a blob.
const storeUrl = env.STORE_URL || `file://${join(config.dataDir, "store")}`;
const store = openStore(storeUrl, { password: env.REDIS_PASSWORD, secrets });

// Blob storage (BLOB_URL), checked before the runner takes a call: a setting that fails stops it.
let warnings;
try {
  ({ warnings } = await startBlobs(env, {
    store,
    storeUrl,
    credentials,
    secrets,
    what: "The runs' logs",
    log,
  }));
} catch (error) {
  if (!(error instanceof BlobError)) throw error;
  log.error(error.message);
  process.exit(1);
}

// The orchestrator's services port: a run's first tokens (which the orchestrator has the broker service sign, with the claims it decided). The
// github service (#502): the repos' tarballs and blobs.
const orchestratorUrl = env.ORCHESTRATOR_URL || "http://orchestrator:8083";
const githubUrl = env.GITHUB_SERVICE_URL || "http://github:8080";
const orchestrator = serviceClient({
  service: "orchestrator",
  urls: orchestratorUrl,
  token: () => brokerCaller.header("orchestrator"),
  log,
});
const github = serviceClient({
  service: "github",
  urls: githubUrl,
  token: () => brokerCaller.header("github"),
  log,
});
// The broker's public keys, which it publishes (SERVICE_KEYS_DIR, read-only here): its callers'
// service tokens are checked with them, offline, a new key taken as soon as one names it.
const keys = keyFolder(env.SERVICE_KEYS_DIR || "/service-keys");

// A repo's files at a ref (null: its default branch), streamed by the github service
// (checkout.mjs unpacks them).
const tarball = (repo, ref) =>
  github.request("GET", `/tarballs/${repo}${ref === null ? "" : `/${encodeURIComponent(ref)}`}`);
const fetchCheckout = (repo, ref) => checkout(tarball, repo, ref);

// A file's blob id at a ref (null: the default branch), or null: what a repo image's tag hashes.
async function blobOf(repo, path, ref) {
  const query = `path=${encodeURIComponent(path)}${ref === null ? "" : `&ref=${encodeURIComponent(ref)}`}`;
  const res = await github.request("GET", `/blobs/${repo}?${query}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the github service: ${res.status} for ${path} of ${repo}`);
  return (await res.json()).sha;
}

const images = createImages({
  config,
  backend: backend.images,
  jobs: backend.jobs,
  checkout: fetchCheckout,
  log,
});

const holder = `${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;
let service = null;
const lease = activePassive({
  store,
  name: "runner",
  holder,
  onActive: () => service.activate(),
  onPassive: () => service.deactivate(),
  log,
});

// What the operator's policies grant each repository (a container engine, its Dockerfile…),
// asked of the policy service as the listener asks it: the runner checks every spec and build
// against them again, whatever the orchestrator says (#498). Only the
// operator's layer: no repository's policies, so no GitHub read.
const policies = createPolicies({
  config,
  github: null,
  service: policyClient({
    url: config.policyServiceUrl,
    header: () => brokerCaller.header("policy"),
  }),
  log,
});

service = createRunnerService({
  config,
  granted: grantsBy(policies),
  runner: backend.runner,
  images,
  logs: createLogs({ store, segmentMax: config.logSegmentMax }),
  store,
  broker: {
    runTokens: async (run, sandbox) =>
      (
        await orchestrator.json("POST", `/runs/${encodeURIComponent(run)}/tokens`, {
          body: { sandbox: String(sandbox) },
        })
      ).env,
  },
  refresh: loginRefresh({ config, images, jobs: backend.jobs }),
  blobOf,
  keys: () => keys,
  health: { ...healthInfo(), warnings },
  bound,
  lease,
  log,
});

const port = Number(env.PORT || 8080);
service.server.listen(port, () => {
  log(`Deckhand runner (${config.runner}) on :${service.server.address().port}`);
});
// Its tokens, asked for until the broker answers (a broker starting after it, say): a call it
// makes meanwhile asks for them itself (lib/service-token.mjs header()). Not waited for here, so
// the server listening keeps the process up.
brokerCaller.start();
await lease.start();
if (!lease.active()) log("Runner: another copy holds the lease, waiting for it");

// An update stops this copy with SIGTERM: output streams end (their callers follow again from
// the next copy), the calls in flight finish, then the lease goes, and the other copy acts.
// Sandboxes go on.
const graceMs = Number(env.DRAIN_SECONDS) > 0 ? Number(env.DRAIN_SECONDS) * 1000 : DRAIN_MS;
process.once("SIGTERM", async () => {
  log(
    `Stopping: the calls in flight finish, then the lease goes (${Math.round(graceMs / 1000)} s at most, cut past that)`,
  );
  const all = await service.stop({ graceMs });
  if (!all) log("Stopping: calls still going at the end of the grace period, cut");
  brokerCaller.stop();
  await store.close();
  process.exit(0);
});
