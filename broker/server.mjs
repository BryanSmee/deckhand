// Deckhand's broker service (#505, docs/services.md): the one service holding the tokens'
// signing key. It signs and renews the runs' tokens and the services' own, keeps the live runs
// and their files in its store, and serves the endpoints a sandbox calls about its own run,
// through the egress proxy. Two copies may run side by side on one store (Redis, #509): every
// call either one answers, the other could have.
//
// Settings, from the environment:
//   PORT              8081
//   STORE_URL         its store (lib/store.mjs): file:///data/store, or Redis for two copies on
//                     several nodes (REDIS_PASSWORD)
//   BLOB_URL          its blob storage (lib/blobs.mjs), for the runs' screenshots: s3://…,
//                     file:///…, or none (the store);
//                     BLOB_ACCESS_KEY_ID and BLOB_SECRET_ACCESS_KEY (or _FILE) for S3
//   KEY_DIR           its signing key's folder (run-token.key, made on first start): /keys,
//                     its own volume or Secret, never the store
//   SERVICE_NETWORKS  with Docker: each caller's network, service=subnet (callers.mjs)
//   SERVICE_ACCOUNTS  on Kubernetes: each caller's service account, service=namespace:name
//   DRAIN_SECONDS     how long a stopping copy lets its calls finish: 30, over an inbox's long
//                     poll (25 s), under compose's stop_grace_period
//   SERVICE_KEYS_DIR  where it publishes its public key (<kid>.pem) for the services that check
//                     service tokens offline (the policy service's, #501): none by default
//   METRICS_PORT      GET /metrics alone (../lib/metrics.mjs): none by default
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { blobCredentials, blobSecrets, startBlobs } from "../lib/blobs.mjs";
import { drainOnSigterm } from "../lib/drain.mjs";
import { healthInfo } from "../lib/health.mjs";
import { createLogger } from "../lib/log.mjs";
import { metricsPort, startMetrics } from "../lib/metrics.mjs";
import { openStore } from "../lib/store.mjs";
import { publishKey, signingKey } from "../lib/tokens.mjs";
import { createCallers, inClusterReview } from "./callers.mjs";
import { createFiles } from "./files.mjs";
import { createBrokerServer } from "./http.mjs";
import { createRuns } from "./runs.mjs";

export const DRAIN_MS = 30_000;

// DRAIN_SECONDS → milliseconds.
export function drainMs(text) {
  if (text === undefined || text === "") return DRAIN_MS;
  if (!/^\d+$/.test(text)) throw new Error(`DRAIN_SECONDS: expected seconds, got ${text}`);
  return Number(text) * 1000;
}

// What its store refuses or redacts of the signing key (lib/store.mjs `secrets`): the key's own
// part, past the armour and the 16 bytes every Ed25519 PKCS8 key starts with
// (`MC4CAQAwBQYDK2VwBCIEI`, 21 base64 characters, the 22nd shared with the key). The whole PEM
// would refuse any message quoting `-----BEGIN PRIVATE KEY-----`, which is no secret.
export function storeSecrets(key) {
  const pem = key.privateKey.export({ type: "pkcs8", format: "pem" });
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return [body.slice(22)];
}

// The broker's parts on `store`, with `key`: what the tests start too. → { server, runs, files }.
// `keysDir`: where its public key is published, for the services that check its tokens offline;
// `blobs`: where the screenshots go (lib/blobs.mjs: the store's own blobs by default).
export function createBroker({
  store,
  blobs,
  key,
  callers,
  keysDir = null,
  now = Date.now,
  sleep,
  log = () => {},
  // What GET /health says (../lib/health.mjs): its start, version and warnings.
  health,
}) {
  if (keysDir) {
    mkdirSync(keysDir, { recursive: true });
    publishKey(keysDir, key);
  }
  const runs = createRuns({ store, key, now, expired: (id) => files.remove(id) });
  const files = createFiles({ store, blobs, runs, now, sleep });
  let draining = false;
  const server = createBrokerServer({
    runs,
    files,
    callers,
    signing: key,
    store,
    draining: () => draining,
    now,
    sleep,
    log,
    ...(health && { health }),
  });
  server.startDraining = () => (draining = true);
  return { server, runs, files };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Its lines redact its signing key and blob storage's secret key too, once read.
  let secrets = [];
  const log = createLogger({ service: "broker", secrets: () => secrets });
  const env = process.env;
  let started;
  try {
    const callers = createCallers({
      networks: env.SERVICE_NETWORKS,
      accounts: env.SERVICE_ACCOUNTS,
      review: inClusterReview({
        host: env.KUBERNETES_SERVICE_HOST,
        port: env.KUBERNETES_SERVICE_PORT,
      }),
    });
    const key = signingKey(env.KEY_DIR || "/keys");
    const credentials = blobCredentials(env);
    // Its key never goes in the store: a value holding it is refused there, a blob redacted.
    // Nor does blob storage's secret key.
    secrets = [...storeSecrets(key), ...blobSecrets(credentials)];
    const storeUrl = env.STORE_URL || "file:///data/store";
    const store = openStore(storeUrl, {
      password: env.REDIS_PASSWORD,
      secrets: () => secrets,
    });
    // Blob storage (BLOB_URL), checked before it takes a call: the runs' screenshots (#609).
    const { blobs, warnings } = await startBlobs(env, {
      store,
      storeUrl,
      credentials,
      secrets: () => secrets,
      what: "The runs' files",
      log,
    });
    const graceMs = drainMs(env.DRAIN_SECONDS);
    startMetrics({ service: "broker", port: metricsPort(env.METRICS_PORT), log });
    const keysDir = env.SERVICE_KEYS_DIR || null;
    const health = { ...healthInfo(), warnings };
    started = {
      ...createBroker({ store, blobs, key, callers, keysDir, log, health }),
      graceMs,
      key,
    };
  } catch (error) {
    log.error(`Broker: ${error.message}`);
    process.exit(1);
  }
  const { server, graceMs, key } = started;
  const port = Number(env.PORT ?? 8081);
  server.listen(port, () => log(`Broker on :${port}, key ${key.kid}`));
  // A rolling update starts the next copy first: this one, out of rotation (/ready), lets the
  // inbox polls and uploads in flight finish, then exits.
  drainOnSigterm([server], { graceMs, log, before: async () => server.startDraining() });
}
