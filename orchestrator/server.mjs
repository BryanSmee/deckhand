// The orchestrator's entry point (#506): the queue and the runs' lives. It takes the verified
// deliveries edge puts on its stream (../edge/), runs Claude Code in a sandbox container
// (../sandbox/) through the runner for issue, pull request and discussion comments, one
// container and one set of volumes per issue, and posts the final message back through the
// github service. It answers the dashboard's API, which edge passes on with the signed-in user.
// It holds no secret: the App's key is the github service's, the webhook secret and the
// sessions' edge's, the agents' credentials the models service's, the Docker socket the
// runner's.
//
// Two copies, active/passive (../lib/active.mjs): the one holding the orchestrator's lease in
// the store acts (consumes the streams, arms the timers, starts runs), with the lease's epoch on
// every call to the github service, the runner and the broker, which refuse an older one. The
// other waits for the lease, and takes it at once when the first releases it on SIGTERM (or
// once it expires after a crash), then rebuilds its state from the store and the files it
// shares (the data volume). A copy that loses its lease without stopping exits: it never acts
// on a stale epoch.
//
// This file only wires it together: its settings, the shared state (`ctx`) and the modules
// that act on it, then the servers, and what a previous copy left. How a comment becomes a
// run, and which module does what: ../docs/architecture.md. No dependencies: node:http,
// node:crypto.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fingerprint, fingerprintRedactor } from "../lib/fingerprints.mjs";
import { join } from "node:path";
import { createAnalysis } from "../listener/analysis.mjs";
import { planWarning } from "../listener/agents/credentials.mjs";
import { AGENT_SECRETS, ENTRIES } from "../listener/agents/index.mjs";
import { createModelsService } from "../listener/models-service.mjs";
import { createBroker } from "../listener/broker.mjs";
import { createBrokerService } from "../listener/broker-service.mjs";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { createEgressHttp } from "../listener/egress-http.mjs";
import { createGithubClient } from "../github/client.mjs";
import { createProjects } from "../listener/projects.mjs";
import { createBrainstorms, createIssueModes } from "../listener/brainstorms.mjs";
import { createComments } from "../listener/comments.mjs";
import { createConflicts, intoDefaultBranch } from "../listener/conflicts.mjs";
import {
  brokerServiceUrl,
  ConfigError,
  loadConfig,
  modelsServiceUrl,
  readConfigFile,
  unwritableData,
  withModelCredentials,
} from "../listener/config.mjs";
import { activePassive } from "../lib/active.mjs";
import { drain } from "../lib/drain.mjs";
import { pathToFileURL } from "node:url";
import { openStore, values } from "../lib/store.mjs";
import { storeMaps } from "../lib/store-map.mjs";
import { readJson } from "../lib/files.mjs";
import { createLogger, deliveryContext, withLogContext } from "../lib/log.mjs";
import { leaseMetric, startMetrics } from "../lib/metrics.mjs";
import { createEdgeClient } from "../edge/client.mjs";
import { checkAppSettings, loadCredentials, saveCredentials } from "../listener/github-app.mjs";
import { hasLabel, pullEntry, taskKey } from "../listener/events.mjs";
import {
  createGitHub,
  fetchPull,
  getJson,
  fetchTitle,
  listLabelled,
  listPulls,
} from "../listener/github.mjs";
import {
  autoMergeFiles,
  grantErrors,
  grantFor,
  grantOf,
  grantsBy,
  grantWarnings,
  loadGrants,
} from "../listener/grants.mjs";
import { createHttp } from "../listener/http.mjs";
import { createHistory, forgottenShots, noteUnnamedShots } from "../listener/history.mjs";
import { createInputs } from "../listener/inputs.mjs";
import { createOnboarding, createOnboardingStore } from "../listener/onboarding.mjs";
import { createLinkedBranches } from "../listener/linked-branch.mjs";
import { createPolicies } from "../listener/policies.mjs";
import { operatorPolicies } from "../lib/policy-files.mjs";
import { policyClient } from "../listener/policy-client.mjs";
import { createPulls } from "../listener/pulls.mjs";
import { commitCi } from "../listener/ci.mjs";
import { parseQuestions, questionsSection } from "../listener/questions.mjs";
import { createDecisions } from "../listener/decisions.mjs";
import { fetchEgressCa } from "../listener/egress.mjs";
import { createRepoCheck } from "../listener/repo-check.mjs";
import { readRepoFile } from "../listener/repo-config.mjs";
import { createRepoSettings } from "../listener/repo-settings.mjs";
import { createRepoApi, createRepoList } from "../listener/repos.mjs";
import { createRestart, LIVE_PREFIX } from "../listener/restart.mjs";
import { createReviewers, openerOf } from "../listener/reviewers.mjs";
import { createReviews, stepsGoing } from "../listener/reviews.mjs";
import { loadRuns, moveLogs, moveSummaries, saveSummary, SUMMARIES } from "../listener/runlog.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { createRunnerClient } from "../runner/client.mjs";
import { createServicesHttp } from "../listener/services-http.mjs";
import { createRunEvents } from "../listener/run-events.mjs";
import { createDiscussionApi } from "../listener/discussions.mjs";
import { askedOn, closedTasks, createDismissals, setAsideClosed } from "../listener/dismissals.mjs";
import { createPicks } from "../listener/picks.mjs";
import { operatorSecrets } from "../listener/secrets.mjs";
import { createRuns } from "../listener/runs.mjs";
import { createStatus, serverInfo, serverSetup } from "../listener/status.mjs";
import { createSync } from "../listener/sync.mjs";
import { busyTask, createTasks } from "../listener/tasks.mjs";
import { createAutoPickup } from "../listener/auto-pickup.mjs";
import { createLanes, fetchParent } from "../listener/lanes.mjs";
import { createOrder, ranked } from "../listener/order.mjs";
import { createTitles } from "../listener/titles.mjs";
import { createWaits } from "../listener/waits.mjs";
import { createWorkApi } from "../listener/work.mjs";
import { createHealth } from "../listener/health.mjs";

// How long the egress policy's answers in flight get once the rest is saved: they are quick.
const POLICY_DRAIN_MS = 5000;

// How long a listener that stops waits for the 👀 still on their way, for the queue it leaves.
const EYES_WAIT_MS = 10_000;

// How long a copy that stops waits for its maps' writes, should the store be away.
const MAPS_WAIT_MS = 10_000;

// How often the listener and the egress proxy are joined again to the running sandboxes'
// networks, should either have been recreated (restart.mjs relink()).
const RELINK_MS = 60000;

// How often the operator's credentials are looked at again, for their fingerprints.
const FINGERPRINTS_MS = 30_000;

// How often the runs the broker service has are compared with the listener's.
const RECONCILE_MS = 60 * 60_000;

// How often the App's public parts are asked of edge again (another App set up there), and
// how soon while it has none.
const APP_MS = 60_000;
const NO_APP_MS = 5000;

const env = process.env;

// Its lines redact the operator's secrets too, once known (storeSecrets, below).
const log = createLogger({ service: "orchestrator", secrets: () => storeSecrets() });

// The broker service (../broker/, #505): the runs' tokens, which it alone signs, their files and
// its stream of their events. Its calls carry the orchestrator's service tokens: for the broker, the policy service, the
// runner, the models service, the github service and edge.
let brokerCaller;
let models;
try {
  brokerCaller = createBrokerCaller({
    url: brokerServiceUrl(env),
    service: "orchestrator",
    audiences: ["broker", "policy", "runner", "models", "github", "edge"],
    podTokenFile: env.SERVICE_ACCOUNT_TOKEN_FILE || null,
    log,
  });
  // The models service (../models/, #504), the only one holding the agents' credentials: the
  // listener learns which of them it has, by name, before its settings are read (FALLBACKS and
  // the agents need them), and their fingerprints, for redaction.
  models = createModelsService({
    urls: modelsServiceUrl(env),
    token: () => brokerCaller.header("models"),
    log,
  });
} catch (error) {
  log.error(error.message);
  process.exit(1);
}
const held = await models.credentials();
// Their fingerprints too, before any run's output is read (the runs restored below): read again
// every minute from then on.
await models.start();
const stray = AGENT_SECRETS.filter((name) => env[name]);
if (stray.length) {
  log(
    `Warning: the orchestrator's environment holds ${stray.join(", ")}, which it doesn't use: the models service holds the agents' credentials (docs/setup.md). Remove them from the orchestrator's.`,
  );
}
let config;
try {
  config = loadConfig(withModelCredentials(env, held), readConfigFile(env));
  // Read again at each run. A broken layout or default.yaml at start is the operator's to fix
  // now; a broken repo file stops that repo's runs only, so the others start.
  const grants = loadGrants(config);
  for (const error of grantErrors(grants)) {
    log.error(`${error.message} (no run starts in that repository until it is fixed)`);
  }
  for (const warning of grantWarnings(grants)) log.warn(`Grants: ${warning}`);
  // Loud on purpose: model output reaches these default branches with no human reading it.
  let files = new Map();
  try {
    files = operatorPolicies(config.grantsDir);
  } catch {
    // The policies' own check says it (policies.checkOperator()).
  }
  for (const file of autoMergeFiles(files)) {
    log.warn(
      `policy/${file} in the grants folder grants auto-merge: with review.merge in their .deckhand.yaml, Deckhand merges its own pull requests in those repositories with no human review (docs/security.md#auto-merge)`,
    );
  }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  log.error(error.message);
  process.exit(1);
}
// Not root (#536): a data volume it can't write would fail run after run, so it doesn't start.
const unwritable = unwritableData(config.dataDir);
if (unwritable.length) {
  for (const line of unwritable) log.error(line);
  process.exit(1);
}
const logDir = join(config.dataDir, "logs");
mkdirSync(logDir, { recursive: true });
// The screenshots a release before #609 kept here: moved to the broker (below), never written.
const shotsDir = join(config.dataDir, "shots");

// The orchestrator's state through the store's interface (lib/store.mjs), in the data volume:
// the queue (restart.mjs), its lease, the deliveries it handled, the rest as the services take
// it over (#499). Its two copies share it. The operator's secrets are refused in it
// (lib/store.mjs), once `ctx` can say them. The runs' summaries, thousands, are a file each with
// the file backend: out of the state file every lease renewal writes.
let storeSecrets = () => [];
const store = openStore(env.STORE_URL || pathToFileURL(join(config.dataDir, "store")).href, {
  password: env.REDIS_PASSWORD,
  secrets: () => storeSecrets(),
  apart: [SUMMARIES],
});

// Its fencing epoch, once it holds the lease (below).
let epoch = null;

const brokerService = createBrokerService({
  caller: brokerCaller,
  epoch: () => epoch,
  log,
});

// The runs being started: the first tokens the runner asks for once their network or pod
// exists (services-http.mjs).
const pendingTokens = new Map();

// A port another copy holds (two copies on one host, the tests'; the one acting, or the one that
// held the lease before, as it drains): taken once free, however long that takes.
async function listenWhenFree(server, port, host) {
  for (let tries = 0; ; tries++) {
    try {
      return await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => (server.off("error", reject), resolve()));
      });
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      if (tries === 100) log(`Port ${port}: another process holds it, waiting for it`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// The runner's calls, before anything waits on it: a run's first tokens; and edge's, once the
// state is back (`edgeReady`): the dashboard's API (services-http.mjs).
let edgeReady = null;
// The orchestrator's maps in the store, once read (below).
let maps = null;
// Whether this copy acts: from the lease's taking until SIGTERM.
let acting = false;
// The version the images were built from, its repository and when this orchestrator started:
// api/state's, and its own /health (../lib/health.mjs).
const server = serverInfo(env);
// Its metrics (../lib/metrics.mjs), on their own port when METRICS_PORT is set: the waiting copy
// answers too, its lease not held.
const metrics = startMetrics({ service: "orchestrator", port: config.metricsPort, log });
leaseMetric(metrics.registry, { orchestrator: () => acting });
const services = createServicesHttp({
  health: server,
  // The broker service's keys.
  keys: { get: (kid) => brokerService.serviceKeys().get(kid) },
  // none on Kubernetes: the callers' service tokens, and NetworkPolicies (deploy/kubernetes/).
  bound: config.serviceNetworks === "none" ? null : networkCallers(config.serviceNetworks),
  pendingTokens,
  edge: () => edgeReady,
  active: () => acting,
  // The maps' items not written to the store yet (lib/store-map.mjs), once they are loaded.
  waiting: () => maps?.waiting() ?? 0,
  allowed: (login) => config.users.includes(login),
  log,
});
// While it waits too, for its probes: a waiting copy answers 503 to the rest.
const servicesListening = listenWhenFree(services, config.servicesPort).then(() =>
  log(`Services on :${services.address().port}`),
);

// One copy acts: the one holding the lease (lib/active.mjs). This one waits for it, doing
// nothing else meanwhile: no timer, no stream read, and of its servers only the services port,
// which answers its probes and 503 to every call (`acting`). Its epoch fences every call it
// makes to the runner, the github service and the broker: higher at each new holder, above
// what they have seen (lib/store.mjs acquire()), so a copy that lost the lease can't start or
// stop a run, nor post a reply. Losing it while acting, this copy exits: the restart makes it
// the waiting one.
let leaseLost = () => {};
let sigterm = () => process.exit(0);
process.on("SIGTERM", () => sigterm());
const lease = await new Promise((resolve) => {
  // The lease's timers don't keep a process alive: this does, while it waits.
  const alive = setInterval(() => {}, 60_000);
  const waiting = setTimeout(
    () => log("Waiting for the orchestrator's lease: another copy acts"),
    1000,
  );
  waiting.unref();
  const leased = activePassive({
    store,
    name: "orchestrator",
    holder: `orchestrator-${randomUUID()}`,
    // LEASE_SECONDS (15): how long a crashed copy's lease lasts before the other takes it.
    ...(Number(env.LEASE_SECONDS) > 0 && { ttlMs: Number(env.LEASE_SECONDS) * 1000 }),
    onActive: (held) => {
      clearTimeout(waiting);
      clearInterval(alive);
      resolve({ ...held, control: leased });
    },
    onPassive: () => leaseLost(),
    log,
  });
  leased.start();
});
epoch = lease.epoch;
acting = true;
// Until it is lost, or released on SIGTERM: the maps' writes stop trying then (lib/store-map.mjs).
let leaseHeld = true;
// Stopped before it is up: its lease given back, for the other copy to take at once.
sigterm = () => {
  leaseLost = () => {};
  lease.control.stop().finally(() => process.exit(0));
};
await servicesListening;
leaseLost = () => {
  leaseHeld = false;
  log.error("The orchestrator's lease is lost: another copy acts now. Exiting.");
  process.exit(1);
};

// Edge (../edge/, #506): the verified deliveries' stream, the App's public parts, the
// dashboard's "from" tags, the redeliveries' scan.
const edgeUrl = env.EDGE_URL || "http://edge:8083";
const edge = createEdgeClient({
  urls: edgeUrl,
  token: () => brokerCaller.header("edge"),
  log,
});

// Where sandboxes, images and the runs' logs are: the runner service (RUNNER is
// its setting).
const runnerClient = createRunnerClient({
  urls: config.runnerUrl,
  token: () => brokerCaller.header("runner"),
  epoch: () => epoch,
  pendingTokens,
  log,
});

// The github service (../github/, #502), the only one with the GitHub App's key: every GitHub
// call of the listener's goes there, as the orchestrator, with its epoch (GITHUB_SERVICE_URL).
const githubService = createGithubClient({
  urls: config.githubServiceUrl,
  token: () => brokerCaller.header("github"),
  epoch: () => epoch,
  log,
});

// What the listener's broker tells the github service of each run (broker.mjs `gateway`), with
// whom its writes may assign (the repo's `users` as last read, else ALLOWED_USERS) and the label
// its questions wait under.
function githubGateway() {
  return {
    async put(id, fields) {
      await githubService.runs.put(id, {
        ...fields,
        users: ctx.usersOf?.(fields.repo) ?? config.users,
        needsInputLabel: config.needsInputLabel,
      });
    },
    end: (id) => githubService.persist(`the end of run ${id}`, () => githubService.runs.end(id)),
  };
}

// Logs why a delivery is ignored: deliveries that do nothing are the usual question.
function skip(reason) {
  log(`  ignored: ${reason}`);
  return null;
}

// What the modules share. They read it at call time, so a module can call one created after
// it (a finished run schedules the next one, the queue starts runs) and see `app` once /setup
// has stored one.
const ctx = {
  // The version the images were built from, its repository and when this listener started.
  server,
  // Whether this copy still holds the lease: writes ordered after the queue's stop trying when
  // it is lost (restart.mjs queueWritten()).
  held: () => leaseHeld,
  // How it is set up (engine, egress proxy, grants, who may sign in): GET api/server.
  serverSetup: () => serverSetup(config),
  // The services' health, each one's GET /health (GET api/health: the status page).
  health: createHealth({
    urls: {
      edge: edgeUrl,
      runner: config.runnerUrl,
      broker: config.brokerServiceUrl,
      github: config.githubServiceUrl,
      models: config.modelsServiceUrl,
      policy: config.policyServiceUrl,
      proxy: config.egressProxy,
    },
    self: { name: "orchestrator", startedAt: server.startedAt, version: server.version },
  }),
  config,
  log,
  skip,
  logDir,
  // Null until /setup has stored an App: webhooks are refused meanwhile.
  app: null,
  // What GET /app said at start, { name, slug, owner, ownerType }: the dashboard's App links.
  appInfo: null,
  // key ("org/repo#12") → task (tasks.mjs).
  tasks: new Map(),
  // The dashboard's runs, newest first (runlog.mjs), and by id; pruned daily (history.mjs).
  // Listed once the logs kept here moved to the runner (below).
  runs: [],
  runsById: new Map(),
  // Runs with a sandbox, for the parallel cap.
  running: 0,
  // Set on SIGTERM: no run starts any more, what waits is left to the next listener (saved
  // already, as it changed).
  stopping: false,
  // The listener's store (above): the operator's secrets are left out of what the queue writes
  // there (restart.mjs storable()).
  store,
  // The models service: the agents' credentials' fingerprints, a run's API state at its end.
  models,
  // The runs whose provider failed, another entry of FALLBACKS taking over (runs.mjs fallBack()):
  // the models service's calls say why, the fallback is decided here.
  fallbacks: metrics.registry.counter(
    "deckhand_model_fallbacks_total",
    "Runs whose provider failed, put back for the next entry of FALLBACKS (from, to: agent@provider[:credential]).",
    { labels: ["from", "to"], values: { from: ENTRIES, to: ENTRIES } },
  ),
  storeSecrets: () => operatorSecrets(ctx),
};
storeSecrets = () => operatorSecrets(ctx);

// --- GitHub ----------------------------------------------------------------------------

// The App as edge holds it (../edge/app.mjs): its public parts only (its names, its owner,
// where the dashboard is), never its webhook secret nor its OAuth client's, which are edge's.
// Its key is the github service's alone, where its calls go (../github/client.mjs app()).
function useApp(parts) {
  ctx.app = githubService.app(parts);
  // The App's own login: its pull requests are Claude's (events.mjs linkedIssue()).
  config.bot = ctx.app.identity().name;
}

// What edge says of the App now: used once it has one, and again when another one is set up
// there. Resolves to whether it has one.
async function refreshApp() {
  const { configured, ...parts } = (await edge.app({ waitMs: 10_000 })) ?? {};
  if (!configured) return false;
  if (JSON.stringify(ctx.app?.credentials) === JSON.stringify(parts)) return true;
  const first = !ctx.app;
  useApp(parts);
  ctx.appInfo = null;
  if (!first) log(`GitHub App ${parts.slug}: set up at edge`);
  checkApp();
  return true;
}

// `fn()` until it resolves, again every few seconds while it fails (`what` in the log).
async function persist(what, fn) {
  for (let said = false; !ctx.stopping; said = true) {
    try {
      return await fn();
    } catch (error) {
      if (!said) log(`${what}: ${error.message ?? error}, trying again`);
      await new Promise((resolve) => setTimeout(resolve, 5000).unref());
    }
  }
}

// A listener's App, kept in the data volume this orchestrator took over: its key handed to the
// github service, then the rest (the webhook secret, the OAuth client's) to edge with the
// sessions' key and sign-outs; then removed here, where nothing secret stays. The first GitHub
// calls at start wait for the key a while (below).
let handedOver = Promise.resolve();
{
  const credentials = loadCredentials(config.dataDir);
  if (credentials) {
    const { pem, ...kept } = credentials;
    // As edge gives them (../edge/app.mjs publicPart()): its names, nothing secret.
    const names = ["id", "slug", "owner", "html_url", "bot_id", "public_url"];
    useApp(Object.fromEntries(names.filter((k) => kept[k] != null).map((k) => [k, kept[k]])));
    let keyTaken = !pem;
    const key = !pem
      ? Promise.resolve()
      : githubService.persist("handing over the App's key", async () => {
          try {
            await githubService.setup.handOver(credentials);
            keyTaken = true;
          } catch (error) {
            // Refused for good, another App's key there (409) or none in what it was sent (400):
            // asking again changes nothing. Anything else (a service not up yet, its keys not
            // read: 401, 503) is asked again.
            if (error.status !== 409 && error.status !== 400) throw error;
            log.error(
              `The GitHub App's key: the github service refused it (${error.message}). It stays in /data/app.json until resolved by hand: remove the github service's app.json (its github-key volume) to take this App's, or this one's key from /data/app.json to keep the service's (docs/setup.md#the-github-service)`,
            );
          }
        });
    handedOver = key.then(async () => {
      if (!keyTaken) return;
      if (pem) {
        saveCredentials(config.dataDir, kept);
        log("The GitHub App's key: handed over to the github service, removed from app.json");
      }
      await handOverToEdge(kept);
    });
  }
}

// The listener's webhook secret, OAuth client and sessions, to edge (#506): once it took them,
// none of them stays in the orchestrator's volume.
async function handOverToEdge(kept) {
  const read = (name) => {
    try {
      return readFileSync(join(config.dataDir, name));
    } catch {
      return null;
    }
  };
  const sessionKey = read("session.key");
  const taken = await persist("Edge: handing over the App's credentials", async () => {
    try {
      await edge.handOver({
        credentials: kept,
        sessionKey: sessionKey?.toString("base64") ?? null,
        epochs: readJson(join(config.dataDir, "sessions.json"), null),
      });
      return true;
    } catch (error) {
      if (error.status !== 409 && error.status !== 400) throw error;
      log.error(
        `The GitHub App's credentials: edge refused them (${error.message}). They stay in /data/app.json until resolved by hand: remove edge's app.json (its edge-data volume) to take this App's, or /data/app.json to keep edge's (docs/setup.md#from-the-listener)`,
      );
      return false;
    }
  });
  if (!taken) return;
  for (const name of ["app.json", "session.key", "sessions.json", "redeliveries.json"]) {
    rmSync(join(config.dataDir, name), { force: true });
  }
  log("The GitHub App's credentials and the sessions: handed over to edge, removed from /data");
}

// Events and permissions the App's settings miss (without `issues`, open questions get no
// label), and who owns it, which the link to its settings needs. Read at start and with each
// listing of the repositories (repos.mjs), each warning logged only when it is new. Resolves to
// the permissions the App lacks, or null when GitHub didn't say.
let appWarnings = new Set();
function checkApp() {
  const app = ctx.app;
  const lines = [];
  return checkAppSettings(app.asApp, (line) => lines.push(line), {
    githubUrl: config.githubUrl,
    credentials: app.credentials,
  })
    .then(({ app: info, missing, permissions }) => {
      if (ctx.app !== app || !info) return null;
      for (const line of lines) if (!appWarnings.has(line)) log(line);
      appWarnings = new Set(lines);
      ctx.appInfo = { ...info, missingEvents: missing, missingPermissions: permissions };
      return permissions;
    })
    .catch((error) => (log(`The GitHub App's settings: ${error.message ?? error}`), null));
}

// The App as the dashboard links to it: its public parts, with what GitHub's GET /app said.
// Null before /setup.
function appSummary() {
  if (!ctx.app) return null;
  const { slug, owner, html_url } = ctx.app.credentials;
  return { slug, owner, html_url, ...ctx.appInfo };
}

// PUBLIC_URL, or the one /setup stored with the App (at edge).
function publicUrl() {
  return config.publicUrl ?? ctx.app?.credentials.public_url ?? `http://localhost:${config.port}`;
}

// The App's calls as the repo's installation, REST and GraphQL (github.mjs).
const { github, graphql } = createGitHub(() => ctx.app);

// The logs this listener kept before the runner kept them go to it, while it goes on; the runs
// are listed from their summaries in the store, where those a release before #618 kept in
// logs/ go first (runlog.mjs).
// The live runs' ids first, from their states in the store (restart.mjs): their logs aren't
// summarized as ended ones.
const liveIds = new Set();
for await (const [key] of values(store, LIVE_PREFIX)) liveIds.add(key.slice(LIVE_PREFIX.length));
const moved = moveLogs(logDir, runnerClient.logs, { log, live: liveIds });
ctx.logsMoving = moved.moving;
// A log on its way there is read once it arrived (a digest, the dashboard's live view).
ctx.logMoved = (id) => moved.moving.get(id) ?? Promise.resolve();
await moveSummaries(logDir, store, { log, secrets: storeSecrets() });
ctx.runs = await loadRuns(store, { log });
for (const run of ctx.runs) ctx.runsById.set(run.id, run);

// The orchestrator's maps that hold data alone (#615), in the store one key per item
// (lib/store-map.mjs), read back now that this copy holds the lease, before anything is
// restored: what a release before kept in the data volume (`<name>.json`) is moved there
// first. Each change writes its own key, tried again while the store is away (/ready says how
// many wait), until written or the lease is lost. The maps behind timers and comments (#616)
// too: `waits`, `inputs`, `reviews`, `brainstorms`, `decisions` and `picks`, their deadlines
// data the modules arm again from (brainstorms.mjs, reviews.mjs tick(), waits.mjs check()), the
// comments they hold written without a secret (storable()); where one change writes such a map
// and the queue, the two writes go in the order that leaves a comment somewhere after a crash
// between them (waits.mjs releasing() and hold(), brainstorms.mjs end()).
maps = await persist("Reading the orchestrator's maps from the store", () =>
  storeMaps(
    store,
    {
      titles: {},
      closed: {},
      pulls: {},
      dismissed: {},
      order: { moved: ranked },
      onboarding: {},
      lanes: {},
      modes: {},
      conflicts: {},
      "dry-runs": {},
      requested: {},
      waits: {},
      inputs: {},
      reviews: {},
      brainstorms: {},
      decisions: {},
      picks: {},
    },
    {
      dir: config.dataDir,
      secrets: () => operatorSecrets(ctx),
      held: () => leaseHeld,
      log,
    },
  ),
);

// The dashboard's titles and closed states: from webhooks, else fetched (titles.mjs).
const titles = createTitles({
  titles: maps.maps.titles,
  closed: maps.maps.closed,
  log,
  fetchTitle: (repo, kind, number) => fetchTitle(github, repo, kind, number),
});
// Logs that have their title (newest first: the latest wins).
titles.seed(ctx.runs.map((r) => [r.key, r.title]));

// Each task's pull request: from webhooks, else looked up once (pulls.mjs).
const pulls = createPulls({
  pulls: maps.maps.pulls,
  log,
  listPulls: (repo) => listPulls(github, repo),
  getPull: (repo, number) => fetchPull(github, repo, number),
  readCi: (repo, sha) => commitCi(github, repo, sha),
});

// Failed runs dismissed from the dashboard, and runs whose questions were set aside (their
// needs-input label taken off), while each is its task's last (dismissals.mjs).
const dismissals = createDismissals({ dismissed: maps.maps.dismissed });

// Auto-picked work that is over: its issue closed, its pull request merged or closed, or the
// sweep gave its slot to the next issue (picks.mjs, tasks.mjs releasePicks()).
const picks = createPicks({ ended: maps.maps.picks });

// Open issues labelled needs-input: from webhooks, and looked up once per start (inputs.mjs).
// One the listing no longer has is asked about on its own: a listing read page by page can
// miss one that moved between pages. Still open and labelled, it is listed again; its label
// off meanwhile, it sets its run's questions aside, as the delivery would. Its `updated_at` is
// when, at the latest: a run that asked since still waits.
const inputs = createInputs({
  inputs: maps.maps.inputs,
  log,
  listLabelled: (repo) => listLabelled(github, repo, config.needsInputLabel),
  dropped: (repo, number) => {
    const key = taskKey(repo, number);
    lookup(repo, `/repos/${repo}/issues/${number}`)
      .then((issue) => {
        if (issue?.state === "open" && hasLabel(issue.labels, config.needsInputLabel)) {
          // A delivery during the lookup has the last word: it listed or dropped the issue.
          if (inputs.keep(key, parseQuestions(questionsSection(issue.body)))) {
            log(`${key}: still labelled, though the label's listing missed it`);
          }
          return;
        }
        if (!askedOn(ctx.runs, key)) return;
        const at = Date.parse(issue?.updated_at) || null;
        const aside = dismissals.setAsideOn(ctx.runs, key, null, at);
        if (aside) log(`${aside}: label removed meanwhile, its last run's questions set aside`);
      })
      .catch((error) => log(`${key}: its label: ${error.message ?? error}`))
      // Kept or not, the entry sync() dropped is no longer held (inputs.mjs keep()).
      .finally(() => inputs.release(key));
  },
});

// The run order the maintainer set on the dashboard: which queued task starts next (order.mjs).
const order = createOrder({ order: maps.maps.order });

// --- Per-repo settings and images ----------------------------------------------------------

const repoFile = (repo, path, ref) => readRepoFile(github, repo, path, ref);

// The repos onboarded so far and their onboarding issues (onboarding.mjs).
const onboarded = createOnboardingStore(maps.maps.onboarding);

// The dashboard's repository list (repos.mjs), refreshed by the deliveries that change it.
const repoList = createRepoList({
  app: {
    asApp: (...args) => ctx.app.asApp(...args),
    asInstallation: (...args) => ctx.app.asInstallation(...args),
    request: github,
    remember: (...args) => ctx.app.remember(...args),
    rememberPermissions: (...args) => ctx.app.rememberPermissions(...args),
    settings: checkApp,
  },
  config,
  store: onboarded,
  // Asked once the policies below exist: on the first list, not now.
  granted: (repo) => policies.grants(repo),
  log,
});

// Each repo's settings as last read: its runs' and comments', its `users` for the dashboard.
const { repoSettings, ...repoReads } = createRepoSettings({ github, config, repoList });

// Deckhand's, the operator's and the repos' policies (rules as code), evaluated by the policy
// service after the built-in gates (POLICY_SERVICE_URL, ../policy-service/). The operator's are
// checked now, over Deckhand's, as the grants are: an error refuses each decision a policy is
// asked for (fail closed), so it is said at once.
const policies = createPolicies({
  config,
  github,
  service: policyClient({
    url: config.policyServiceUrl,
    // Its service token for the policy service, from the broker service, which publishes the
    // key the policy service checks it with (SERVICE_KEYS_DIR there).
    header: () => brokerCaller.header("policy"),
  }),
  secrets: () => operatorSecrets(ctx),
  log,
});
policies.checkOperator().then(({ errors, warnings }) => {
  for (const error of errors) {
    log.error(
      `Policies (Deckhand's and GRANTS_DIR/policy): ${error} (every decision a policy is asked for refuses until it is fixed)`,
    );
  }
  for (const warning of warnings)
    log.warn(`Policies (Deckhand's and GRANTS_DIR/policy): ${warning}`);
});

// The names of the board's lanes: one a maintainer typed, or a parent's title (lanes.mjs).
const lanes = createLanes({
  lanes: maps.maps.lanes,
  fetchParent: (repo, number) => fetchParent(github, repo, number),
  closed: (key) => titles.closed(key) !== null,
  known: (key) => titles.get(key) !== null || titles.closed(key) !== null,
  log,
});

Object.assign(ctx, {
  github,
  graphql,
  publicUrl,
  repoSettings,
  policies,
  ...repoReads,
  repoFile,
  titles,
  lanes,
  pulls,
  inputs,
  dismissals,
  picks,
  order,
  onboarded,
  repoList,
  // Replies, reactions and the needs-input label.
  ...createComments({ config, github, graphql, shared: githubService.claim, log }),
  // Onboarding issues, and the run each starts.
  onboarding: createOnboarding({
    request: github,
    store: onboarded,
    config,
    repoSettings,
    accept: (item) => ctx.accept(item),
    log,
  }),
  // Built and run by the runner service, from tarballs it gets through the listener.
  images: runnerClient.images,
  runLogs: runnerClient.logs,
  // The runs' screenshots, the broker's (#609): removed with their run (history.mjs).
  removeShots: (folder) => brokerService.removeShots(folder),
  // Runs' tokens, signed by the broker service, and what each run may do, which the services
  // its sandbox calls check them against: the orchestrator checks none itself.
  brokerService,
  broker: createBroker({ issuer: brokerService.issuer, gateway: githubGateway() }),
  // The egress proxy's CA certificate, for runs that reach GitHub, or whose grant has
  // cached_hosts (egress.mjs).
  egressCa: () => fetchEgressCa(config.egressProxy),
  // Sandboxes are started, followed and removed through it; they run detached.
  runner: runnerClient.runner,
});

// The github service (../github/, #502), the sandboxes' only way to GitHub.
const lookup = (repo, path) => getJson(github, repo, path, [404, 410]);
ctx.githubService = githubService;
// What a run did on GitHub (its reruns, for the CI step), read at its end.
ctx.githubRunState = (id, options) => githubService.runs.state(id, options);

// --- Tasks, runs and restarts --------------------------------------------------------------

// A task with a run going or comments waiting for one, under any spelling of its repo.
const taskBusy = (key) => busyTask(ctx.tasks, key);

Object.assign(ctx, {
  brainstorms: createBrainstorms({
    brainstorms: maps.maps.brainstorms,
    queueSaved: () => ctx.queueWritten(),
    idleMs: config.brainstormIdleMs,
    // A reply still on its way: posting it arms the timer again.
    busy: taskBusy,
    log,
  }),
  // The issues whose session is in one of their repo's own modes.
  issueModes: createIssueModes(maps.maps.modes),
});
Object.assign(ctx, createStatus(ctx), createTasks(ctx), createRuns(ctx), createRestart(ctx));
// Open pull requests of opted-in repos that conflict with their base get a rebase run.
ctx.conflicts = createConflicts({
  attempts: maps.maps.conflicts,
  config,
  pulls,
  github,
  repoSettings,
  busy: taskBusy,
  accept: (item) => ctx.accept(item),
  // A conflict run is a fix run too: `deny_fix`, its refusal said on the pull request.
  policies,
  decided: (key, entry) => ctx.decisions.record(key, entry),
  fixes: (repo, number) => ctx.reviews.fixes(repo, number),
  reply: ctx.reply,
  log,
});
// Pull requests that turn ready in opted-in repos get a review run (`review.on`), a review
// that requests changes a fix loop (`review.fix`), and with the operator's
// `auto_merge` grant, a clean review the merge (`review.merge`).
// Each task's last policy decisions and dry run, for its page (decisions.mjs).
ctx.decisions = createDecisions({
  decisions: maps.maps.decisions,
  dryRuns: maps.maps["dry-runs"],
  secrets: () => operatorSecrets(ctx),
});
// A work run's branch, created and linked to its issue before its sandbox starts
// (linked-branch.mjs).
ctx.linkedBranches = createLinkedBranches({
  github,
  graphql,
  policies,
  runOf: (id) => ctx.broker.runOf(id),
  decided: (key, entry) => ctx.decisions.record(key, entry),
  log,
});
ctx.reviews = createReviews({
  reviewed: maps.maps.reviews,
  config,
  repoSettings,
  accept: (item) => ctx.accept(item),
  github,
  busy: taskBusy,
  reply: ctx.reply,
  policies,
  decided: (repo, pr, entry) => ctx.decisions.record(pullEntry(repo, pr).key, entry),
  // `/mode policy`'s deny_request_review, about the run that opened the pull request.
  runOf: (key, pr) => openerOf(ctx.runs, key, pr),
  grantOf: async (repo) => {
    try {
      return await grantOf(config, repo, { granted: grantsBy(policies) });
    } catch (error) {
      log(`${repo}: its grants: ${error.message}`);
      return null;
    }
  },
  // The dashboard's "merged by Deckhand", at once; and, merged into the default branch, the
  // repo's other pull requests asked soon whether they still merge: no delivery comes first.
  merged: (repo, pr) => {
    const { key, pr: entry } = pullEntry(repo, pr);
    pulls.record(key, { ...entry, autoMerged: true });
    if (intoDefaultBranch(pr)) {
      ctx.conflicts.soon(repo).catch((error) => log(`Conflicts: ${error.stack ?? error}`));
    }
  },
  log,
});
// Deckhand's ready pull requests get the reviewers their repo's `review.request` names, again
// after a run pushed to them (reviewers.mjs).
ctx.reviewers = createReviewers({
  requested: maps.maps.requested,
  config,
  repoSettings,
  github,
  // The run whose pull request it is: the one that opened it.
  runOf: (key, pr) => openerOf(ctx.runs, key, pr),
  policies,
  decided: (repo, pr, entry) => ctx.decisions.record(pullEntry(repo, pr).key, entry),
  log,
});
// The repos' issues on their projects (v2), moved as their work starts, turns ready and merges
// (`projects:`), on the projects the operator grants them.
ctx.projects = createProjects({
  config,
  graphql,
  repoSettings,
  grantOf: (repo) => {
    try {
      return grantFor(loadGrants(config), config, repo);
    } catch (error) {
      log(`${repo}: its grants: ${error.message}`);
      return null;
    }
  },
  pullOf: (key) => pulls.get(key),
  log,
});
// Comments that wait for other issues to be done ("/after #12").
ctx.waits = createWaits({
  waits: maps.maps.waits,
  queueSaved: () => ctx.queueWritten(),
  github,
  reply: ctx.reply,
  received: ctx.received,
  settle: ctx.settle,
  resume: (item) => ctx.resume(item),
  checkMs: config.waitsCheckMinutes * 60_000,
  log,
});
ctx.repoApi = createRepoApi({
  config,
  list: repoList,
  app: appSummary,
  publicUrl,
  start: (repo, login) => ctx.onboarding.start(repo, login, true),
  policies,
  granted: grantsBy(policies),
  // The Overview's repository cards: no GitHub read per repo when they show.
  backlogs: (repos, user) => ctx.workApi.counts(repos, user),
  log,
});

// Run analyses (the dashboard's Analyze): digests of a repo's past runs, without the secrets
// their logs must never carry.
ctx.analysis = createAnalysis({
  runs: () => ctx.runs,
  secrets: () => operatorSecrets(ctx),
  // From the runner, which keeps the logs.
  readLog: async (id) => (await ctx.logMoved(id), runnerClient.logs.text(id)),
});

// What signs the dashboard's posts as their users' (discussions.mjs fromLine()): a run posts
// as the App too, and can't make one. Edge's, which holds the webhook secret the key comes from.
const fromTags = (items) => edge.tags(items);

// The graph's work area: the backlog, starting or queueing issues by dragging them, and the
// answers to open questions sent from a task's page.
ctx.workApi = createWorkApi({
  config,
  github,
  repoSettings,
  reply: ctx.reply,
  waits: ctx.waits,
  accept: (item) => ctx.accept(item),
  boardKeys: () => http.boardKeys(),
  liveKeys: () => http.liveKeys(),
  busy: taskBusy,
  taskOf: (key) => http.taskOf(key),
  label: (repo, number, on) => ctx.label(repo, number, on),
  inputs,
  runOf: (id) => ctx.runsById.get(id) ?? null,
  cancel: (key, user) => ctx.cancel(key, user),
  queuedTask: (key) => ctx.queuedTask(key),
  unqueue: (key, user) => ctx.unqueue(key, user),
  analysis: ctx.analysis,
  lanes,
  dismissals,
  order,
  queueOrder: () => ctx.queueOrder(),
  reviews: ctx.reviews,
  granted: grantsBy(policies),
  publicUrl,
  fromTags,
  log,
});

// The issues labelled AUTO_PICKUP_LABEL, started by the listener itself in AUTO_PICKUP_SLOTS.
ctx.autoPickup = createAutoPickup({
  config,
  github,
  // None until the App is set up (setup.mjs).
  repos: async () => (ctx.app ? repoList.autoPickup() : []),
  repoSettings,
  accept: (item) => ctx.accept(item),
  reply: ctx.reply,
  live: () => {
    const keys = new Set([...http.liveKeys()].map((k) => k.toLowerCase()));
    return (key) => taskBusy(key) || keys.has(key.toLowerCase());
  },
  taken: () => ctx.pickedCount(),
  release: () => ctx.releasePicks(),
  load: (repo) => ctx.repoLoad(repo),
  // The follow-ups the reviews filed with the label, for whoever merged their pull request.
  followUpPick: (repo, number, at) => ctx.reviews.followUpPick(repo, number, at),
  log,
});

// Discussions started, read and answered from the dashboard, with the work area's checks.
const discussionChecks = createRepoCheck({ config, github, repoSettings });
ctx.discussionApi = createDiscussionApi({
  config,
  graphql,
  checkedRepo: discussionChecks.checkedRepo,
  nameOf: discussionChecks.nameOf,
  accept: (item) => ctx.accept(item),
  publicUrl,
  tags: fromTags,
  log,
});

// --- Servers -------------------------------------------------------------------------------

// The App as edge has it, before what needs it at start. Edge away a while: the start goes on
// without it (or with a listener's from the data volume), and it comes with the next ask.
const appAsked = refreshApp().catch((error) => log(`Edge: the App (${error.message ?? error})`));
await Promise.race([appAsked, new Promise((resolve) => setTimeout(resolve, 15_000).unref())]);
let appTimer = null;
function askApp() {
  appTimer = setTimeout(
    () =>
      refreshApp()
        .catch((error) => log(`Edge: the App (${error.message ?? error})`))
        .finally(() => !ctx.stopping && askApp()),
    ctx.app ? APP_MS : NO_APP_MS,
  );
  appTimer.unref();
}
askApp();

// Before any request is served, as restoreRuns() wants: one spelling per repo in the state
// (GitHub's for one it has under two, restart.mjs), the task keys of the rest too.
const keyed = [
  ctx.waits,
  ctx.brainstorms,
  ctx.issueModes,
  inputs,
  pulls,
  ctx.conflicts,
  ctx.reviews,
  ctx.decisions,
  titles,
  lanes,
  dismissals,
  order,
];
const spelled = await ctx.unifySpellings({
  nameOf: discussionChecks.nameOf,
  keys: keyed.flatMap((state) => state.keys()),
});
for (const state of keyed) state.respell(spelled);
// A run since a dismissal shows its task again: its entry is stale.
dismissals.prune(ctx.runs);
picks.prune(ctx.runs);
// Issues and pull requests that closed or merged after their run asked, while no listener heard
// it: their questions set aside, as the `closed` delivery would have (http.mjs). GitHub says
// when each closed; a run that asked after that still waits.
if (ctx.app) {
  setAsideClosed({
    runs: ctx.runs,
    dismissals,
    tasks: closedTasks(ctx.runs, titles.closed, (key) => pulls.get(key)),
    // Gone (404) or deleted (410): null, as never closed.
    closedAt: async (repo, number) => {
      const issue = await lookup(repo, `/repos/${repo}/issues/${number}`);
      return issue?.closed_at ? Date.parse(issue.closed_at) : null;
    },
    log,
  })
    .then((keys) => keys.length && log(`Closed since their run asked: ${keys.join(", ")}`))
    .catch((error) => log(`Closed since their run asked: ${error.stack ?? error}`));
}

// Before any request is served: runs still going since the previous listener (their inboxes
// and logs asked of the runner), then what it left queued (comments for those runs are
// delivered to them).
const restored = await ctx.restoreRuns();
await ctx.loadQueue();
// A wait whose comment is queued or running now was released by a copy stopped before it was
// deleted from the store (waits.mjs releasing()): its comment goes on, the wait goes.
ctx.waits.dedupe(
  new Set(
    [...ctx.tasks.values()]
      .flatMap((t) => [...t.pending, ...(t.live?.handled ?? [])])
      .map((item) => item.queueId)
      .filter(Boolean),
  ),
);
// A fix loop's step whose run neither came back nor waits in the queue: no longer on its way.
ctx.reviews.forgetSteps(stepsGoing(ctx.tasks));
// The keys of comments dropped as the queue came back (their author no longer allowed) stay in
// the run order otherwise, and would rank a new comment there as placed.
order.keep(ctx.queueOrder().map((t) => taskKey(t.repo, t.id)));

// The dashboard's API and the deliveries, both edge's to pass on: answered from here on.
const http = createHttp(ctx);
edgeReady = http.handle;
const bind = (server, port, done) => listenWhenFree(server, port).then(done);
// Not drained: the egress proxy asks it about every sandbox connection until the orchestrator
// exits.
const policy = createEgressHttp(ctx).listen(bind);

// At start and from the dashboard's Sync: the deliveries GitHub couldn't hand over, asked for
// again by edge (redeliveries.mjs), and the open pull requests' states asked again; from Sync,
// their conflicts checked now. The last one's result goes in api/state (sync.mjs).
const syncs = createSync({
  scan: () => edge.scan(),
  resync: pulls.resync,
  check: ctx.conflicts.check,
  log,
});
ctx.sync = syncs.sync;
ctx.lastSync = syncs.last;

log(`Deckhand ${ctx.server.version}`);
log(
  `Agents: ${config.agent} for work, ${config.brainstormAgent} for light runs; repos may pick ${config.agents.join(", ")}${config.fallbacks.length ? `; on provider errors, falls back to ${config.fallbacks.join(", ")}` : ""}`,
);
// The plan's token is used when it is the default, or when an entry names it: `/agent` (unless
// a gateway is the default, agents/select.mjs pickable()) or FALLBACKS.
const claude = config.credentials["claude@anthropic"];
const planUsed =
  claude.set.includes("plan") &&
  (claude.default !== null || config.fallbacks.includes("claude@anthropic:plan"));
const claudeCredential = planUsed ? "CLAUDE_CODE_OAUTH_TOKEN" : config.claudeCredential;
for (const name of [claudeCredential, config.openaiCredential, config.agyCredential]) {
  const plan = planWarning(name);
  if (plan) log(plan);
}
if (!ctx.app) log("No GitHub App yet: set it up with the /setup link in edge's logs");

// The broker service's keys first: the restored runs' tokens are checked with them.
brokerService
  .start()
  .catch((error) => log(`Broker: ${error.stack ?? error}`))
  .then(() => ctx.reattach(restored))
  .catch((error) => log(`Re-attaching: ${error.stack ?? error}`))
  // Runs the broker service still has that ended while the listener was down: asked until it
  // answers, then every hour (the broker drops the files of runs whose record expired then).
  .then(reconcileRuns);
function reconcileRuns() {
  const going = () => [...ctx.tasks.values()].flatMap((t) => t.live?.id ?? []);
  return brokerService.persist("its runs", () => brokerService.reconcile(going));
}
const reconciling = setInterval(reconcileRuns, RECONCILE_MS);
reconciling.unref();
// Its stream: the runs' events (the broker keeps their screenshots, #609). A run token renewed:
// the run's tokens asked again, for its output's redaction (#617).
brokerService.consume({
  handlers: { renewed: async ({ run }) => ctx.broker.runOf(run) && ctx.broker.recall(run) },
});
// The screenshots this orchestrator kept before the broker did go to it, while it goes on: asked
// until the broker takes them (a reply posted before links to them still). A folder no run
// names, past the run history's days, is removed instead, as retention removed those; a younger
// one is moved, and noted for retention to remove later.
const forgotten = forgottenShots(ctx.runs, config.logRetentionDays, Date.now());
const named = new Set(ctx.runs.map((run) => run.shots).filter(Boolean));
const unnamed = (folder, at) =>
  named.has(folder) ? undefined : noteUnnamedShots(store, folder, at);
const shotsMoved = brokerService.persist("the screenshots kept here", () =>
  brokerService.moveShots(shotsDir, { drop: forgotten, moved: unnamed }),
);
// The operator's credentials' fingerprints, which the github service redacts the runs' GitHub
// writes by without holding them: the models service's sets, as it gave them (lib/redact.mjs,
// #504), and lib/fingerprints.mjs's of any still in the listener's environment. Sent at start,
// and again once they change (a plan's login refreshed).
let printed = null;
function sendFingerprints() {
  const secrets = operatorSecrets(ctx).filter((s) => typeof s === "string" && s);
  const sets = models.prints();
  const digest = createHash("sha256")
    .update(JSON.stringify([secrets, sets]))
    .digest("hex");
  if (digest === printed) return Promise.resolve();
  return githubService
    .fingerprints({ ...fingerprint(secrets), sets })
    .then(() => (printed = digest));
}
githubService.persist("the operator's credentials' fingerprints", sendFingerprints);
const printing = setInterval(
  () => sendFingerprints().catch((error) => log(`GitHub service: fingerprints (${error.message})`)),
  FINGERPRINTS_MS,
);
printing.unref();
// The github service's: the pushes GitHub took (the run's record, restart.mjs watchPushes()),
// the lines its gateways add to a run's log, the pull requests runs changed (the dashboard has
// them at once, whether their delivery comes or not).
githubService.consume({
  pushed: async ({ run, branch, at }) => ctx.broker.runOf(run)?.pushed?.({ branch, at }),
  note: async ({ run, message }) => ctx.broker.runOf(run)?.note?.(message),
  // An installation token the gateway used for a run, by its fingerprint: what its log and reply
  // are redacted of (runs.mjs hidden()), the token itself never leaving the service.
  token: async ({ run, fingerprints }) => {
    const found = ctx.broker.runOf(run);
    if (found) (found.scrubs ??= []).push(fingerprintRedactor(fingerprints));
  },
  pull: async ({ key, pr }) => {
    if (typeof key === "string" && pr && pulls.record(key, pr)) {
      log(`${key}: pull request #${pr.number} ${pr.state}`);
    }
  },
});
// The models service's: the agents' calls it refused, each a line in its run's log.
models.consume({ note: (event) => ctx.broker.runOf(event.run)?.note?.(event.message) });
const relinking = setInterval(ctx.relink, RELINK_MS);
ctx.conflicts.start();
ctx.waits.start();
ctx.reviews.start();
ctx.autoPickup.start();
// After restoreRuns() and loadQueue(): what they bring back is kept.
const history = createHistory(ctx);
// Once the logs and screenshots kept here are at the runner and the broker: one removed before it
// arrives would arrive after its summary went, and stay there for good.
Promise.all([moved.done, shotsMoved]).then(() => ctx.stopping || history.start());
// How the runner's sandboxes ended (runner/events.mjs).
const runEvents = createRunEvents({
  events: runnerClient.events,
  // Live, or over (its end said once its sandbox went): on its record and summary, and in
  // its log, at the runner.
  runOf: (id) => {
    const live = [...ctx.tasks.values()].find((t) => t.live?.id === id)?.live;
    const record = live?.record ?? ctx.runsById.get(id);
    if (!record) return null;
    let file = live?.logFile;
    return {
      record,
      get logFile() {
        return (file ??= runnerClient.logs.open(id, { size: null }));
      },
      // Once it has one: its end writes it, with this, or not yet.
      save: () =>
        record.finishedAt && saveSummary(store, record, { log, secrets: storeSecrets(), logDir }),
    };
  },
  log,
});
runEvents.start();
// The App's key at the github service first, should this copy be the one handing it over (30 s
// at most): what follows needs it there. Not waited for here: the SIGTERM handler below is.
Promise.race([handedOver, new Promise((resolve) => setTimeout(resolve, 30_000).unref())]).then(
  () => {
    if (ctx.stopping || !ctx.app) return;
    checkApp();
    // Pull requests that changed while no copy acted, or whose delivery was lost; the
    // deliveries GitHub couldn't hand over, asked again by edge.
    ctx.sync(null);
    // The repositories listed at start (without their configs): the listing also warns about
    // the permissions an installation hasn't accepted (repos.mjs).
    const listed = repoList.names();
    // Labels added or removed while no copy acted.
    if (config.needsInputLabel) {
      listed
        .then((repos) => inputs.sync(repos))
        .then((found) => titles.seed(found))
        .catch((error) => log(`Issues waiting for input: ${error.message ?? error}`));
    } else listed.catch((error) => log(`Listing the repositories: ${error.message ?? error}`));
  },
);

// `docker compose up`, `restart` or an update stops the orchestrator with SIGTERM, and kills it
// after the stop grace period. Sandboxes go on: no run starts any more, edge's requests and
// deliveries wait for the next copy, which carries on from what is saved as it changes (the
// queue with its deadlines and 👀 ids, the runs' state): here, only the writes under way are
// waited for, the delivery being handled, and the lines of output read in the last second.
// Then the lease is released, and the waiting copy takes it at once (a second, about). The
// egress policy's port answers until it exits.
sigterm = () => {
  if (ctx.stopping) return;
  ctx.stopping = true;
  // Edge's and the runner's calls are refused from now on (503): they ask the next copy.
  edgeReady = null;
  acting = false;
  ctx.conflicts.stop();
  ctx.waits.stop();
  ctx.reviews.stop();
  ctx.autoPickup.stop();
  history.stop();
  runEvents.stop();
  clearInterval(relinking);
  clearInterval(reconciling);
  clearInterval(printing);
  clearTimeout(appTimer);
  // What it read of the streams and didn't acknowledge, the next copy reads again; the delivery
  // being handled is acknowledged first.
  const delivered = edge.stop();
  brokerService.stop();
  githubService.stop();
  models.stop();
  log("Stopping: running sandboxes go on, the next copy picks them up");
  // Replies being posted and comments being admitted first, then what they leave.
  // The 👀 still on their way too, for a while (the drain's grace bounds it anyway).
  // The dashboard's posts edge passed on, still being answered (30 s at most): what they
  // change is saved before the lease goes.
  const posted = Promise.race([
    Promise.allSettled(services.posting()),
    new Promise((resolve) => setTimeout(resolve, 30_000).unref()),
  ]);
  const released = Promise.allSettled([...ctx.ending, ...http.admitting, delivered, posted])
    .then(() => ctx.eyesSaved(EYES_WAIT_MS))
    .then(ctx.saveQueue)
    // The maps' writes still waiting (the store away): for a while, the rest is lost.
    .then(() =>
      Promise.race([
        maps.settled(),
        new Promise((resolve) => setTimeout(resolve, MAPS_WAIT_MS).unref()),
      ]),
    )
    .then(() => {
      if (maps.waiting()) log(`Stopping: ${maps.waiting()} map item(s) not written to the store`);
      const queued = [...ctx.tasks.values()].filter((t) => t.pending.length).length;
      log(`Stopping: ${queued} task(s) with queued comments left to the next copy`);
    })
    .then(() => Promise.all([...ctx.tasks.values()].map((t) => t.live && ctx.saveLive(t))))
    .catch((error) => log(`Saving the queue: ${error.stack ?? error}`))
    // Everything is in the store: the lease goes to the next copy now, rather than in 15 s.
    .then(() => {
      leaseLost = () => {};
      leaseHeld = false;
      return lease.control.stop();
    })
    .catch((error) => log(`Releasing the lease: ${error.stack ?? error}`));
  const saved = released
    .then(() => ctx.store.close())
    .catch((error) => log(`Closing the store: ${error.stack ?? error}`))
    // The dashboard's streams: its page reconnects, through edge, to the next copy.
    .finally(() => services.closeAllConnections());
  // Last, the egress policy: closed, so that the proxy's next questions are refused and wait for
  // the next copy, and its answers in flight are sent, rather than cut by the exit (which
  // the proxy would take for a refusal).
  saved.then(() => drain(policy, { graceMs: POLICY_DRAIN_MS })).finally(() => process.exit(0));
};

// Verified deliveries, from edge's stream, each acknowledged once handled (http.mjs deliver()):
// none is lost while this copy hands over. One handled already whose acknowledgement was lost
// (edge away, this copy stopped in between) is read again: taken once, by its GUID, kept an hour
// (an acknowledgement isn't lost for longer: edge's stream keeps the delivery until then).
const handledKey = (id) => `deliveries/handled/${id}`;
const HANDLED_TTL_MS = 3600_000;
// Each one handled under the request ID edge gave it, with its repository and issue: what it
// logs here, and the calls it makes to the other services, carry them.
edge.consume(
  (entry) =>
    withLogContext(deliveryContext(entry), async () => {
      if (entry?.id && (await store.get(handledKey(entry.id)))) return;
      // Edge took it with an App this copy hasn't heard of yet (set up a moment ago): asked now,
      // and the delivery read again later without one.
      if (!ctx.app && !(await refreshApp())) throw new Error("no GitHub App known yet");
      await http.deliver(entry ?? {});
      if (entry?.id) await store.set(handledKey(entry.id), 1, { ttlMs: HANDLED_TTL_MS });
    }),
  { active: () => !ctx.stopping },
);
