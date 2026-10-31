// Deckhand's listener: receives the GitHub App's webhooks, runs Claude Code in a sandbox
// container (../sandbox/) for issue, pull request and discussion comments, one container and
// one set of volumes per issue, and posts Claude's final message back as a comment.
//
// This file only wires the listener together: its settings, the GitHub App, the shared state
// (`ctx`) and the modules that act on it, then starts the servers and picks up what a
// previous listener left. How a comment becomes a run, and which module does what:
// ../docs/architecture.md. No dependencies: node:http, node:crypto. Sandboxes, images and
// preview hooks are the runner service's (../runner/), the only one with the Docker socket.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAnalysis } from "./analysis.mjs";
import { createAuth, sessionKey } from "./auth.mjs";
import { planWarning } from "./agents/credentials.mjs";
import { AGENT_SECRETS } from "./agents/index.mjs";
import { createModelsService } from "./models-service.mjs";
import { createBroker } from "./broker.mjs";
import { createBrokerService, legacyKey } from "./broker-service.mjs";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { clientAddress, createBrokerHttp, runAt, runFrom, sandboxAt } from "./broker-http.mjs";
import { createGitGateway } from "./git-gateway.mjs";
import { createForkChecks } from "./github-forks.mjs";
import { createGithubGateway } from "./github-gateway.mjs";
import { createGraphqlChecks, createValidator, lookupNodes } from "./github-graphql.mjs";
import { createPullChecks } from "./github-pulls.mjs";
import { createReadChecks, createWriteChecks } from "./github-writes.mjs";
import { createProjects } from "./projects.mjs";
import { createBrainstorms, createIssueModes } from "./brainstorms.mjs";
import { createComments } from "./comments.mjs";
import { createConflicts, intoDefaultBranch } from "./conflicts.mjs";
import {
  brokerServiceUrl,
  ConfigError,
  loadConfig,
  modelsServiceUrl,
  readConfigFile,
  withModelCredentials,
} from "./config.mjs";
import { drain } from "../lib/drain.mjs";
import { pathToFileURL } from "node:url";
import { nextEpoch, openStore } from "../lib/store.mjs";
import {
  checkAppSettings,
  createGitHubApp,
  loadCredentials,
  saveCredentials,
} from "./github-app.mjs";
import { hasLabel, pullEntry, taskKey } from "./events.mjs";
import {
  createGitHub,
  fetchPull,
  getJson,
  fetchTitle,
  listLabelled,
  listPulls,
} from "./github.mjs";
import { autoMergeFiles, grantErrors, grantFor, grantOf, grantsBy, loadGrants } from "./grants.mjs";
import { createHttp } from "./http.mjs";
import { createHistory } from "./history.mjs";
import { createInputs } from "./inputs.mjs";
import { createOnboarding, createOnboardingStore } from "./onboarding.mjs";
import { createLinkedBranches } from "./linked-branch.mjs";
import { createPolicies } from "./policies.mjs";
import { operatorPolicies } from "../lib/policy-files.mjs";
import { policyClient } from "./policy-client.mjs";
import { createPulls } from "./pulls.mjs";
import { createDecisions } from "./decisions.mjs";
import { createRedeliveries } from "./redeliveries.mjs";
import { fetchEgressCa } from "./egress.mjs";
import { createRepoCheck } from "./repo-check.mjs";
import { readRepoFile } from "./repo-config.mjs";
import { createRepoSettings } from "./repo-settings.mjs";
import { createRepoApi, createRepoList } from "./repos.mjs";
import { createRestart } from "./restart.mjs";
import { createReviewers, openerOf } from "./reviewers.mjs";
import { createReviews, stepsGoing } from "./reviews.mjs";
import { loadRuns, moveLogs, saveSummary } from "./runlog.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { createRunnerClient } from "../runner/client.mjs";
import { createServicesHttp } from "./services-http.mjs";
import { createRunEvents } from "./run-events.mjs";
import { createDiscussionApi, fromKey } from "./discussions.mjs";
import { askedOn, closedTasks, createDismissals, setAsideClosed } from "./dismissals.mjs";
import { operatorSecrets } from "./secrets.mjs";
import { createRuns } from "./runs.mjs";
import { createSetup } from "./setup.mjs";
import { createStatus, serverInfo, serverSetup } from "./status.mjs";
import { createSync } from "./sync.mjs";
import { busyTask, createTasks } from "./tasks.mjs";
import { createAutoPickup } from "./auto-pickup.mjs";
import { createLanes, fetchParent } from "./lanes.mjs";
import { createOrder } from "./order.mjs";
import { createTitles } from "./titles.mjs";
import { createWaits } from "./waits.mjs";
import { createWorkApi } from "./work.mjs";

// How long the egress policy's answers in flight get once the broker drained: they are quick.
const POLICY_DRAIN_MS = 5000;

// How long a listener that stops waits for the 👀 still on their way, for the queue it leaves.
const EYES_WAIT_MS = 10_000;

// How often the listener and the egress proxy are joined again to the running sandboxes'
// networks, should either have been recreated (restart.mjs relink()).
const RELINK_MS = 60000;

// How often the runs the broker service has are compared with the listener's.
const RECONCILE_MS = 60 * 60_000;
// How often the preview hooks the runner runs are asked again, for /status and the dashboard.
const PREVIEWS_MS = 5000;

const env = process.env;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// The broker service (../broker/, #505): the runs' tokens, which it alone signs, their files and
// its stream of their events. The key the listener signed tokens with before it moves out of
// the data volume, but for its public part (legacyKey()).
// Its calls carry the listener's service tokens, as the orchestrator: for the broker, the policy
// service, the runner and the models service.
let brokerCaller;
let models;
try {
  brokerCaller = createBrokerCaller({
    url: brokerServiceUrl(env),
    service: "orchestrator",
    audiences: ["broker", "policy", "runner", "models"],
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
  console.error(error.message);
  process.exit(1);
}
const held = await models.credentials();
// Their fingerprints too, before any run's output is read (the runs restored below): read again
// every minute from then on.
await models.start();
const stray = AGENT_SECRETS.filter((name) => env[name]);
if (stray.length) {
  log(
    `Warning: the listener's environment holds ${stray.join(", ")}, which it no longer uses: the models service holds the agents' credentials (docs/setup.md). Remove them from the listener's.`,
  );
}
let config;
try {
  config = loadConfig(withModelCredentials(env, held), readConfigFile(env));
  // Read again at each run. A broken layout or default.yaml at start is the operator's to fix
  // now; a broken repo file stops that repo's runs only, so the others start.
  const grants = loadGrants(config);
  for (const error of grantErrors(grants)) {
    console.error(`${error.message} (no run starts in that repository until it is fixed)`);
  }
  // Loud on purpose: model output reaches these default branches with no human reading it.
  let files = new Map();
  try {
    files = operatorPolicies(config.grantsDir);
  } catch {
    // The policies' own check says it (policies.checkOperator()).
  }
  for (const file of autoMergeFiles(files)) {
    console.error(
      `WARNING: policy/${file} in the grants folder grants auto-merge: with review.merge in their .deckhand.yaml, Deckhand merges its own pull requests in those repositories with no human review (docs/security.md#auto-merge)`,
    );
  }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}
const logDir = join(config.dataDir, "logs");
const shotsDir = join(config.dataDir, "shots");
for (const dir of [logDir, shotsDir]) mkdirSync(dir, { recursive: true });

const brokerService = createBrokerService({
  caller: brokerCaller,
  legacy: legacyKey(config.dataDir, { log }),
  log,
});

// The orchestrator's fencing epoch (#506 makes it its lease's): higher at each start, sent with
// every call to the runner, which refuses an older one. A listener still draining once the next
// one started can't start or stop a run. From the clock, and above the last one: a data volume
// made anew (the store with it) doesn't start again below what the runner has seen.
// The listener's state through the store's interface (lib/store.mjs), in the data volume: the
// queue for now (restart.mjs), the epoch, the rest as the services take it over (#499). The
// operator's secrets are refused in it (lib/store.mjs), once `ctx` can say them.
let storeSecrets = () => [];
const store = openStore(env.STORE_URL || pathToFileURL(join(config.dataDir, "store")).href, {
  secrets: () => storeSecrets(),
});
const epoch = await nextEpoch(store);

// The services the listener still is, each with its own token for the runner, from the broker
// service: the orchestrator drives runs (and the egress policy asks where a sandbox is), edge
// reads their logs (runner/service.mjs ROUTES).
const callers = {
  orchestrator: brokerCaller,
  ...Object.fromEntries(
    ["edge"].map((service) => [
      service,
      createBrokerCaller({
        url: config.brokerServiceUrl,
        service,
        audiences: ["runner"],
        podTokenFile: config.serviceAccountTokenFile,
        log,
      }),
    ]),
  ),
};
// Asked for until the broker answers; a call waits for its token (lib/broker-client.mjs).
callers.edge.start();

// The runs being started: the first tokens the runner asks for once their network or pod
// exists (services-http.mjs).
const pendingTokens = new Map();

// Where sandboxes, images, preview hooks and the runs' logs are: the runner service (RUNNER is
// its setting).
const runnerClient = createRunnerClient({
  urls: config.runnerUrl,
  token: (sub) => callers[sub].header("runner"),
  epoch: () => epoch,
  pendingTokens,
  log,
});

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
  server: serverInfo(env),
  // How it is set up (engine, egress proxy, grants, who may sign in): GET api/server.
  serverSetup: () => serverSetup(config),
  config,
  log,
  skip,
  logDir,
  shotsDir,
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
  storeSecrets: () => operatorSecrets(ctx),
};
storeSecrets = () => operatorSecrets(ctx);

// --- GitHub ----------------------------------------------------------------------------

function useApp(credentials) {
  ctx.app = createGitHubApp({ credentials, api: config.githubApi, log });
  // The App's own login: its pull requests are Claude's (events.mjs linkedIssue()).
  config.bot = ctx.app.identity().name;
}

{
  const credentials = loadCredentials(config.dataDir);
  if (credentials) useApp(credentials);
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

// The App as the dashboard links to it: the stored credentials' public parts (never its
// secrets), with what GET /app said. Null before /setup.
function appSummary() {
  if (!ctx.app) return null;
  const { slug, owner, html_url } = ctx.app.credentials;
  return { slug, owner, html_url, ...ctx.appInfo };
}

// PUBLIC_URL, or the one /setup stored with the App.
function publicUrl() {
  return config.publicUrl ?? ctx.app?.credentials.public_url ?? `http://localhost:${config.port}`;
}

// The App's calls as the repo's installation, REST and GraphQL (github.mjs).
const { github, graphql } = createGitHub(() => ctx.app);

// The runner's calls, before anything waits on it: its tokens, a run's first ones, the repos'
// tarballs (services-http.mjs).
const services = createServicesHttp({
  config,
  // The broker service's own keys: never the listener's from before it.
  keys: { get: (kid) => brokerService.serviceKeys().get(kid) },
  bound: networkCallers(config.serviceNetworks),
  github,
  pendingTokens,
  log,
});
await new Promise((resolve) => services.listen(config.servicesPort, resolve));
log(`Services on :${services.address().port}`);

// The logs this listener kept before the runner kept them go to it, while it goes on; the runs
// are listed from their summaries (runlog.mjs).
const moved = moveLogs(logDir, runnerClient.logs, { log });
ctx.logsMoving = moved.moving;
// A log on its way there is read once it arrived (a digest, the dashboard's live view).
ctx.logMoved = (id) => moved.moving.get(id) ?? Promise.resolve();
ctx.runs = loadRuns(logDir, { log });
for (const run of ctx.runs) ctx.runsById.set(run.id, run);

const setup = createSetup({
  config,
  configured: () => ctx.app !== null,
  onConfigured: (credentials) => {
    saveCredentials(config.dataDir, credentials);
    useApp(credentials);
    ctx.appInfo = null;
    checkApp();
  },
  log,
});

const auth = createAuth({
  config,
  app: () => ctx.app,
  publicUrl,
  key: sessionKey(config.dataDir),
  epochsPath: join(config.dataDir, "sessions.json"),
  log,
});

// The dashboard's titles and closed states: from webhooks, else fetched (titles.mjs).
const titles = createTitles({
  path: join(config.dataDir, "titles.json"),
  closedPath: join(config.dataDir, "closed.json"),
  log,
  fetchTitle: (repo, kind, number) => fetchTitle(github, repo, kind, number),
});
// Logs that have their title (newest first: the latest wins).
titles.seed(ctx.runs.map((r) => [r.key, r.title]));

// Each task's pull request: from webhooks, else looked up once (pulls.mjs).
const pulls = createPulls({
  path: join(config.dataDir, "pulls.json"),
  log,
  listPulls: (repo) => listPulls(github, repo),
  getPull: (repo, number) => fetchPull(github, repo, number),
});

// Failed runs dismissed from the dashboard, and runs whose questions were set aside (their
// needs-input label taken off), while each is its task's last (dismissals.mjs).
const dismissals = createDismissals({ path: join(config.dataDir, "dismissed.json") });

// Open issues labelled needs-input: from webhooks, and looked up once per start (inputs.mjs).
// One whose label came off meanwhile sets its run's questions aside, as the delivery would,
// once the issue itself says so: a listing read page by page can miss one that moved between
// pages. Its `updated_at` is when, at the latest: a run that asked since still waits.
const inputs = createInputs({
  path: join(config.dataDir, "inputs.json"),
  log,
  listLabelled: (repo) => listLabelled(github, repo, config.needsInputLabel),
  dropped: (repo, number) => {
    const key = taskKey(repo, number);
    if (!askedOn(ctx.runs, key)) return;
    lookup(repo, `/repos/${repo}/issues/${number}`)
      .then((issue) => {
        if (issue?.state === "open" && hasLabel(issue.labels, config.needsInputLabel)) return;
        const at = Date.parse(issue?.updated_at) || null;
        const aside = dismissals.setAsideOn(ctx.runs, key, null, at);
        if (aside) log(`${aside}: label removed meanwhile, its last run's questions set aside`);
      })
      .catch((error) => log(`${key}: its label: ${error.message ?? error}`));
  },
});

// The run order the maintainer set on the dashboard: which queued task starts next (order.mjs).
const order = createOrder({ path: join(config.dataDir, "order.json") });

// --- Per-repo settings, images and preview hooks -------------------------------------------

const repoFile = (repo, path, ref) => readRepoFile(github, repo, path, ref);

// The repos onboarded so far (onboarding.json) and their onboarding issues (onboarding.mjs).
const onboarded = createOnboardingStore(join(config.dataDir, "onboarding.json"));

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
    console.error(
      `Policies (Deckhand's and GRANTS_DIR/policy): ${error} (every decision a policy is asked for refuses until it is fixed)`,
    );
  }
  for (const warning of warnings)
    console.error(`Policies (Deckhand's and GRANTS_DIR/policy): ${warning}`);
});

// The names of the board's lanes: one a maintainer typed, or a parent's title (lanes.mjs).
const lanes = createLanes({
  path: join(config.dataDir, "lanes.json"),
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
  setup,
  auth,
  titles,
  lanes,
  pulls,
  inputs,
  dismissals,
  order,
  onboarded,
  repoList,
  // Replies, reactions and the needs-input label.
  ...createComments({ config, github, graphql, log }),
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
  previews: runnerClient.previews,
  runLogs: runnerClient.logs,
  // Runs' tokens, signed by the broker service and checked here with its public keys; and the
  // secrets of runs from before them. Both work from their own sandbox alone, whether it calls
  // the listener directly or through the egress proxy.
  brokerService,
  broker: createBroker({
    issuer: brokerService.issuer,
    keys: brokerService.keys,
    unknownKey: brokerService.unknownKey,
    sandboxOf: (ip) => sandboxAt(ctx, ip),
    sentFrom: (run, ip) => runAt(ctx, run, ip),
    clientOf: (req) => clientAddress(ctx, req),
  }),
  // The egress proxy's CA certificate, for runs that reach GitHub, or whose grant has
  // cached_hosts (egress.mjs).
  egressCa: () => fetchEgressCa(config.egressProxy),
  // Sandboxes are started, followed and removed through it; they run detached.
  runner: runnerClient.runner,
});

// The sandboxes' only way to GitHub, on the broker's port: their calls, relayed by the egress
// proxy, go on with a token for their run's repo that they never see, their writes redacted.
const lookup = (repo, path) => getJson(github, repo, path, [404, 410]);
// Their pull requests' own writes (`gh pr create`, `edit`, `ready`): from their own branches.
const pullChecks = createPullChecks({
  lookup,
  // A granted repo's workflows, in the merge a new or changed pull request runs them from.
  checkWorkflows: (repo, branch, base) => ctx.gitGateway.checkBranch(repo, branch, base),
  // The dashboard has the change at once, whether its delivery comes or not.
  record: (repo, pr, readyAt) => {
    const { key, pr: entry } = pullEntry(repo, pr, readyAt);
    if (pulls.record(key, entry)) log(`${key}: pull request #${entry.number} ${entry.state}`);
  },
  log,
});
// The projects the operator grants a repo's runs (allow_projects), read again at each write
// like the grants: one taken back applies to the next.
const grantedProjects = (repo) => grantFor(loadGrants(config), config, repo).allowProjects;
// Whether a repo's runs read projects, asked on each of their GitHub calls: kept a while per
// repo rather than reading the grants folder each time (a broken one said once per while).
const PROJECT_READS_MS = 30_000;
const projectReads = new Map(); // repo → { at, reads }
function readsProjects(repo) {
  const known = projectReads.get(repo);
  if (known && Date.now() - known.at < PROJECT_READS_MS) return known.reads;
  let reads = false;
  try {
    reads = grantedProjects(repo).length > 0;
  } catch (error) {
    log(`GitHub gateway: ${repo}: its grants: ${error.message ?? error}`);
  }
  projectReads.set(repo, { at: Date.now(), reads });
  return reads;
}
const writeChecks = createWriteChecks({
  lookup,
  bot: () => config.bot,
  listenerReacted: (...args) => ctx.listenerReacted(...args),
  // Whom a run may assign: the repo's `users` as last read (its run's start read them), else
  // ALLOWED_USERS.
  users: (repo) => ctx.usersOf(repo) ?? config.users,
  needsInputLabel: () => config.needsInputLabel,
  projects: grantedProjects,
  policies,
  pulls: pullChecks,
  log,
});
// What a work run that isn't a fork's may fetch: nothing that brings a fork's code.
const forkChecks = createForkChecks({
  get: (repo, path, expected) => getJson(github, repo, path, expected),
  log,
});
// Their GraphQL: parsed, validated (in a worker: a document can take a moment), and each
// mutation held to the same checks, its node IDs looked up with the listener's token.
const graphqlChecks = createGraphqlChecks({
  validator: createValidator().check,
  files: forkChecks.checkGraphql,
  nodes: (repo, ids) => lookupNodes(github, repo, ids),
  checkWrite: writeChecks.checkWrite,
  budget: writeChecks.budget,
  log,
});
ctx.githubGateway = createGithubGateway({
  broker: ctx.broker,
  app: () => ctx.app,
  api: config.githubApi,
  web: config.githubUrl,
  forks: forkChecks,
  clientOf: (req) => clientAddress(ctx, req),
  runFrom: (ip) => runFrom(ctx, ip),
  // The run's own tokens too, and its secret from before tokens, which the broker keeps by
  // hash only.
  secrets: (run) => [
    ...ctx.broker.secretsOf(run.id),
    ...[...ctx.tasks.values()]
      .filter((t) => t.live?.secret && ctx.broker.runOf(t.live.id) === run)
      .map((t) => t.live.secret),
    ...operatorSecrets(ctx),
  ],
  // Their REST writes and GraphQL mutations: what the policies' `allow_github` allows and their
  // `deny_github` doesn't refuse. Their targets are looked up with the listener's token.
  checkWrite: writeChecks.check,
  checkGraphql: graphqlChecks.check,
  // Their reads of CI's results beyond Actions, and of the organization's projects: what the
  // policies allow, once per run.
  checkRead: createReadChecks({ policies }).checkRead,
  // Their creates' and comments' answers: the issues each run created, for its links, and the
  // comments it posted, which it may edit.
  wroteWrite: writeChecks.answered,
  readsProjects,
  // A run's own issue's next pages, which GitHub's links name by its repository's id.
  repoId: async (repo) => (await lookup(repo, `/repos/${repo}`))?.id ?? null,
  log,
});
// Their pushes, on the broker's port: to the run's own branches only, never the default one,
// and what the policies' `allow_push` allows and their `deny_push` doesn't refuse.
ctx.gitGateway = createGitGateway({
  broker: ctx.broker,
  app: () => ctx.app,
  policies,
  // Asked on each push: a grant taken back applies to the next one. Through grantOf(), as every
  // other grant: a repository whose grants file has errors has none (it throws: the gateway
  // takes that for no).
  allowWorkflows: async (repo) =>
    (await grantOf(config, repo, { granted: grantsBy(policies) })).allowWorkflows === true,
  // A work run that isn't a fork's pushes nothing that reaches a fork's objects.
  forks: forkChecks,
  githubUrl: config.githubUrl,
  // Granted repos' copies, their pushed workflow files checked against them (git-mirror.mjs).
  mirrorDir: join(config.dataDir, "git-mirrors"),
  log,
});
// --- Tasks, runs and restarts --------------------------------------------------------------

// A task with a run going or comments waiting for one, under any spelling of its repo.
const taskBusy = (key) => busyTask(ctx.tasks, key);

Object.assign(ctx, {
  brainstorms: createBrainstorms({
    path: join(config.dataDir, "brainstorms.json"),
    idleMs: config.brainstormIdleMs,
    // A reply still on its way: posting it arms the timer again.
    busy: taskBusy,
    log,
  }),
  // The issues whose session is in one of their repo's own modes.
  issueModes: createIssueModes(join(config.dataDir, "modes.json")),
});
Object.assign(ctx, createStatus(ctx), createTasks(ctx), createRuns(ctx), createRestart(ctx));
// Open pull requests of opted-in repos that conflict with their base get a rebase run.
ctx.conflicts = createConflicts({
  path: join(config.dataDir, "conflicts.json"),
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
  path: join(config.dataDir, "decisions.json"),
  dryRunPath: join(config.dataDir, "dry-runs.json"),
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
  path: join(config.dataDir, "reviews.json"),
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
  path: join(config.dataDir, "requested.json"),
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
  path: join(config.dataDir, "waits.json"),
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
// as the App too, and can't make one.
const dashboardKey = () => fromKey(ctx.app?.credentials?.webhook_secret);

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
  analysis: ctx.analysis,
  lanes,
  dismissals,
  order,
  queueOrder: () => ctx.queueOrder(),
  reviews: ctx.reviews,
  granted: grantsBy(policies),
  publicUrl,
  fromKey: dashboardKey,
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
  load: (repo) => ctx.repoLoad(repo),
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
  key: dashboardKey,
  log,
});

// --- Servers -------------------------------------------------------------------------------

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
// A fix loop's step whose run neither came back nor waits in the queue: no longer on its way.
ctx.reviews.forgetSteps(stepsGoing(ctx.tasks));
// The keys of comments dropped as the queue came back (their author no longer allowed) stay in
// order.json otherwise, and would rank a new comment there as placed.
order.keep(ctx.queueOrder().map((t) => taskKey(t.repo, t.id)));

const http = createHttp(ctx, {
  dashboardDir: env.DASHBOARD_DIR || new URL("../dashboard/dist", import.meta.url).pathname,
});
const web = http.listen();
const brokerHttp = createBrokerHttp(ctx);
const broker = brokerHttp.listen();
// Not drained: the egress proxy asks it about every sandbox connection until the listener exits.
const policy = brokerHttp.listenPolicy();

// Deliveries GitHub couldn't hand over (the listener down, restarting, unreachable), asked for
// again at start and every few minutes (redeliveries.mjs).
const redeliveries = createRedeliveries({
  path: join(config.dataDir, "redeliveries.json"),
  app: () => ctx.app,
  handled: http.handled,
  log,
});
// A pull request delivery the listener asked for again is handled as it is now (http.mjs).
ctx.redelivered = redeliveries.redelivered;
// At start and from the dashboard's Sync: the same now, and the open pull requests' states
// asked again; from Sync, their conflicts checked now. The last one's result goes in api/state
// (sync.mjs).
const syncs = createSync({
  scan: redeliveries.scan,
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
if (!ctx.app) log(`No GitHub App yet. Set it up at ${setup.link()}`);

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
// Its stream: the screenshots the runs uploaded, copied where GET /shots serves them.
brokerService.consume({ shotsDir });
// The models service's: the agents' calls it refused, each a line in its run's log.
models.consume({ note: (event) => ctx.broker.runOf(event.run)?.note?.(event.message) });
const relinking = setInterval(ctx.relink, RELINK_MS);
ctx.conflicts.start();
ctx.waits.start();
ctx.reviews.start();
ctx.autoPickup.start();
// After restoreRuns() and loadQueue(): what they bring back is kept.
const history = createHistory(ctx);
// Once the logs kept here are at the runner: one removed before it arrives would arrive after
// its summary went, and stay there for good.
moved.done.then(() => ctx.stopping || history.start());
// How the runner's sandboxes ended (runner/events.mjs), and the preview hooks it runs.
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
      save: () => record.finishedAt && saveSummary(logDir, record, log),
    };
  },
  log,
});
runEvents.start();
runnerClient.previews.refresh();
const previewing = setInterval(() => runnerClient.previews.refresh(), PREVIEWS_MS);
previewing.unref();
redeliveries.start();
if (ctx.app) checkApp();
// Pull requests that changed while the listener was down, or whose delivery was lost. After
// redeliveries.start(): its first scan is shared, and counted in the last sync.
if (ctx.app) ctx.sync(null);
if (ctx.app) {
  // The repositories listed at start (without their configs): the listing also warns about
  // the permissions an installation hasn't accepted (repos.mjs).
  const listed = repoList.names();
  // Labels added or removed while the listener was down.
  if (config.needsInputLabel) {
    listed
      .then((repos) => inputs.sync(repos))
      .then((found) => titles.seed(found))
      .catch((error) => log(`Issues waiting for input: ${error.message ?? error}`));
  } else listed.catch((error) => log(`Listing the repositories: ${error.message ?? error}`));
}

// `docker compose up`, `restart` or an update stops the listener with SIGTERM, and kills it
// after the stop grace period. Sandboxes go on: no run starts any more, and the next listener
// carries on from what is saved as it changes (the queue with its deadlines and 👀 ids, the
// runs' state): here, only the writes under way are waited for, and the lines of output read
// in the last second. The
// broker drains meanwhile: it takes no new connection (the egress proxy waits for the next
// listener, proxy/wait.mjs) and the sandboxes' calls in flight finish (agents' streams, pushes,
// inbox polls) before it exits (lib/drain.mjs). The egress policy's port answers until then.
process.on("SIGTERM", () => {
  ctx.stopping = true;
  ctx.conflicts.stop();
  ctx.waits.stop();
  ctx.reviews.stop();
  ctx.autoPickup.stop();
  history.stop();
  redeliveries.stop();
  runEvents.stop();
  clearInterval(previewing);
  clearInterval(relinking);
  clearInterval(reconciling);
  // What it read of the broker's stream and didn't acknowledge, the next listener reads again.
  brokerService.stop();
  models.stop();
  log("Stopping: running sandboxes go on, the next listener picks them up");
  // Webhooks go to the next listener (GitHub's redelivery if it isn't up yet, redeliveries.mjs).
  web.close();
  const drained = drain(broker).then((all) => {
    if (!all) log("Stopping: sandboxes' calls still going at the end of the grace period, cut");
  });
  // Replies being posted and comments being admitted first, then what they leave.
  // The 👀 still on their way too, for a while (the drain's grace bounds it anyway).
  const saved = Promise.allSettled([...ctx.ending, ...http.admitting])
    .then(() => ctx.eyesSaved(EYES_WAIT_MS))
    .then(ctx.saveQueue)
    .then(() => {
      const queued = [...ctx.tasks.values()].filter((t) => t.pending.length).length;
      log(`Stopping: ${queued} task(s) with queued comments left to the next listener`);
    })
    .then(() => Promise.all([...ctx.tasks.values()].map((t) => t.live && ctx.saveLive(t))))
    .then(() => ctx.store.close())
    .catch((error) => log(`Saving the queue: ${error.stack ?? error}`))
    // The dashboard's streams: its page reconnects to the next listener.
    .finally(() => web.closeAllConnections());
  // Last, the egress policy: closed, so that the proxy's next questions are refused and wait for
  // the next listener, and its answers in flight are sent, rather than cut by the exit (which
  // the proxy would take for a refusal).
  Promise.all([saved, drained])
    .then(() => drain(policy, { graceMs: POLICY_DRAIN_MS }))
    .finally(() => process.exit(0));
});
