// Deckhand's listener: receives the GitHub App's webhooks, runs Claude Code in a sandbox
// container (../sandbox/) for issue, pull request and discussion comments, one container and
// one set of volumes per issue, and posts Claude's final message back as a comment.
//
// This file only wires the listener together: its settings, the GitHub App, the shared state
// (`ctx`) and the modules that act on it, then starts the servers and picks up what a
// previous listener left. How a comment becomes a run, and which module does what:
// ../docs/architecture.md. No dependencies: node:http, node:crypto, docker CLI.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAnalysis } from "./analysis.mjs";
import { createAuth, sessionKey } from "./auth.mjs";
import { createAnthropicProxy } from "./anthropic.mjs";
import { antigravity } from "./agents/antigravity.mjs";
import { createAntigravityLogin } from "./antigravity-login.mjs";
import { createChatgptLogin } from "./chatgpt.mjs";
import { createGoogleRelay } from "./google.mjs";
import { createOpenAiProxy } from "./openai.mjs";
import { planWarning } from "./upstream.mjs";
import { createBroker } from "./broker.mjs";
import { createBrokerHttp, runAt } from "./broker-http.mjs";
import { createGitGateway } from "./git-gateway.mjs";
import { createPrReady } from "./pr-ready.mjs";
import { createBrainstorms, createIssueModes } from "./brainstorms.mjs";
import { checkout } from "./checkout.mjs";
import { createComments } from "./comments.mjs";
import { createConflicts } from "./conflicts.mjs";
import { ConfigError, loadConfig, readConfigFile, withCredentialFiles } from "./config.mjs";
import { docker } from "./docker.mjs";
import {
  checkAppEvents,
  createGitHubApp,
  loadCredentials,
  saveCredentials,
} from "./github-app.mjs";
import { pullEntry } from "./events.mjs";
import { createGitHub, fetchPull, fetchTitle, listLabelled, listPulls } from "./github.mjs";
import { autoMergeGrants, grantErrors, grantFor, loadGrants } from "./grants.mjs";
import { createHttp } from "./http.mjs";
import { createHistory } from "./history.mjs";
import { createImages } from "./images.mjs";
import { createInputs } from "./inputs.mjs";
import { createOnboarding, createOnboardingStore } from "./onboarding.mjs";
import { createPolicies } from "./policies.mjs";
import { createPreviews } from "./previews.mjs";
import { createPulls } from "./pulls.mjs";
import { createDecisions } from "./decisions.mjs";
import { createRedeliveries } from "./redeliveries.mjs";
import { fetchEgressCa } from "./egress.mjs";
import { createRepoCheck } from "./repo-check.mjs";
import { readRepoFile } from "./repo-config.mjs";
import { createRepoSettings } from "./repo-settings.mjs";
import { createRepoApi, createRepoList } from "./repos.mjs";
import { createRestart } from "./restart.mjs";
import { createReviews } from "./reviews.mjs";
import { loadRuns } from "./runlog.mjs";
import { createDiscussionApi, fromKey } from "./discussions.mjs";
import { createDockerRunner } from "./runner/docker.mjs";
import { operatorSecrets } from "./secrets.mjs";
import { createRuns } from "./runs.mjs";
import { createSetup } from "./setup.mjs";
import { createStatus, serverInfo } from "./status.mjs";
import { busyTask, createTasks } from "./tasks.mjs";
import { createTitles } from "./titles.mjs";
import { createWaits } from "./waits.mjs";
import { createWorkApi } from "./work.mjs";

// How often the listener and the egress proxy are joined again to the running sandboxes'
// networks, should either have been recreated (restart.mjs relink()).
const RELINK_MS = 60000;

// With the plans' logins found in the credentials folder (/data/credentials) when their
// variables are unset.
const env = withCredentialFiles(process.env);
let config;
try {
  config = loadConfig(env, readConfigFile(env));
  // Read again at each run. A broken layout or default.yaml at start is the operator's to fix
  // now; a broken repo file stops that repo's runs only, so the others start.
  const grants = loadGrants(config);
  for (const error of grantErrors(grants)) {
    console.error(`${error.message} (no run starts in that repository until it is fixed)`);
  }
  // Loud on purpose: model output reaches these default branches with no human reading it.
  for (const { repo, value } of autoMergeGrants(grants)) {
    console.error(
      `WARNING: auto-merge is granted to ${repo}${value === "public" ? ", public repositories included" : ""}: with review.merge in its .deckhand.yaml, Deckhand merges its own pull requests with no human review (docs/security.md#auto-merge)`,
    );
  }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}
const logDir = join(config.dataDir, "logs");
const shotsDir = join(config.dataDir, "shots");
const runsDir = join(config.dataDir, "runs");
for (const dir of [logDir, shotsDir, runsDir]) mkdirSync(dir, { recursive: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
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
  server: serverInfo(env),
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
  runs: loadRuns(logDir, { log }),
  runsById: new Map(),
  // Runs with a sandbox, for the parallel cap.
  running: 0,
  // Set on SIGTERM: no run starts any more, what waits is saved for the next listener.
  stopping: false,
};

for (const run of ctx.runs) ctx.runsById.set(run.id, run);

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

// Events the App's settings miss (without `issues`, open questions get no label), and who
// owns it, which the link to its settings needs.
function checkApp() {
  const app = ctx.app;
  checkAppEvents(app.asApp, log, { githubUrl: config.githubUrl, credentials: app.credentials })
    .then(({ app: info }) => ctx.app === app && info && (ctx.appInfo = info))
    .catch((error) => log(`The GitHub App's events: ${error.message ?? error}`));
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

// Open issues labelled needs-input: from webhooks, and looked up once per start (inputs.mjs).
const inputs = createInputs({
  path: join(config.dataDir, "inputs.json"),
  log,
  listLabelled: (repo) => listLabelled(github, repo, config.needsInputLabel),
});

// --- Per-repo settings, images and preview hooks -------------------------------------------

const repoFile = (repo, path, ref) => readRepoFile(github, repo, path, ref);
const fetchCheckout = (repo, ref) => checkout(github, repo, ref);

// The repos onboarded so far (onboarding.json) and their onboarding issues (onboarding.mjs).
const onboarded = createOnboardingStore(join(config.dataDir, "onboarding.json"));

// The dashboard's repository list (repos.mjs), refreshed by the deliveries that change it.
const repoList = createRepoList({
  app: {
    asApp: (...args) => ctx.app.asApp(...args),
    asInstallation: (...args) => ctx.app.asInstallation(...args),
    request: github,
    remember: (...args) => ctx.app.remember(...args),
  },
  config,
  store: onboarded,
  log,
});

// Each repo's settings as last read: its runs' and comments', its `users` for the dashboard.
const { repoSettings, ...repoReads } = createRepoSettings({ github, config, repoList });

// The operator's and the repos' policies (rules as code), evaluated by `opa` after the built-in
// gates. The operator's are checked now, as the grants are: an error refuses each decision a
// policy is asked for (fail closed), so it is said at once.
const policies = createPolicies({ config, github, secrets: () => operatorSecrets(ctx), log });
policies.checkOperator().then(({ errors, warnings }) => {
  for (const error of errors) {
    console.error(
      `GRANTS_DIR/policy: ${error} (every decision a policy is asked for refuses until it is fixed)`,
    );
  }
  for (const warning of warnings) console.error(`GRANTS_DIR/policy: ${warning}`);
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
  pulls,
  inputs,
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
  images: createImages({ config, docker, readFile: repoFile, checkout: fetchCheckout, log }),
  previews: createPreviews({
    config,
    docker,
    checkout: fetchCheckout,
    logDir: join(config.dataDir, "previews"),
    log,
  }),
  // The sandboxes' only way to GitHub: short-lived tokens for their run's repo, which only
  // read the code, for requests from that run's sandbox alone.
  broker: createBroker({
    app: () => ctx.app,
    sentFrom: (run, ip) => runAt(ctx, run, ip),
    log,
  }),
  // The egress proxy's CA certificate, for runs whose grant has cached_hosts (egress.mjs).
  egressCa: () => fetchEgressCa(config.egressProxy),
  // Sandboxes are started, followed and removed through it; they run detached.
  runner: createDockerRunner({ config, docker, inboxDir: runsDir, log }),
});

// Their pushes, on the broker's port: to the run's own branches only, never the default one.
ctx.gitGateway = createGitGateway({
  broker: ctx.broker,
  app: () => ctx.app,
  // Read on each push: a grant taken back applies to the next one.
  allowWorkflows: (repo) => grantFor(loadGrants(config), config, repo).allowWorkflows,
  githubUrl: config.githubUrl,
  // Granted repos' copies, their pushed workflow files checked against them (git-mirror.mjs).
  mirrorDir: join(config.dataDir, "git-mirrors"),
  log,
});
// Their Claude Code's API calls, with the operator's credential that they never see.
ctx.anthropic = createAnthropicProxy({
  broker: ctx.broker,
  name: config.claudeCredential,
  credential: config.claudeCredential && env[config.claudeCredential],
  upstream: config.anthropicUrl,
  // claude@openrouter, for runs that fall back to it (FALLBACKS).
  providers: {
    openrouter: {
      name: "OPENROUTER_API_KEY",
      credential: env.OPENROUTER_API_KEY,
      upstream: config.openrouterUrl,
    },
  },
  log,
});
// Their Codex's, likewise: with a ChatGPT plan's login, the listener holds and refreshes it.
const chatgptLogin =
  config.openaiCredential === "CODEX_AUTH_FILE"
    ? createChatgptLogin({ file: env.CODEX_AUTH_FILE, log })
    : null;
ctx.openai = createOpenAiProxy({
  broker: ctx.broker,
  credential: config.openaiCredential === "OPENAI_API_KEY" ? env.OPENAI_API_KEY : null,
  login: chatgptLogin,
  upstream: config.openaiUrl,
  log,
});
// Their Antigravity CLI's: a Gemini API key, or a Google AI plan's login (relayed by the
// egress proxy), which the listener holds and refreshes with `agy` itself.
const agyLogin =
  config.agyCredential === "AGY_AUTH_FILE"
    ? createAntigravityLogin({
        file: env.AGY_AUTH_FILE,
        config,
        docker,
        install: () => ctx.images.installAgent(antigravity, () => {}),
        log,
      })
    : null;
ctx.google = createGoogleRelay({
  broker: ctx.broker,
  credential: config.agyCredential === "GEMINI_API_KEY" ? env.GEMINI_API_KEY : null,
  login: agyLogin,
  upstream: config.geminiUrl,
  log,
});
// Their pull requests ready for review (or back to draft): their own token can't.
ctx.prReady = createPrReady({
  broker: ctx.broker,
  app: () => ctx.app,
  api: config.githubApi,
  log,
  // A granted repo's workflows, in the merge a new or ready pull request runs them from.
  checkWorkflows: (repo, branch, base) => ctx.gitGateway.checkBranch(repo, branch, base),
  // The dashboard has the change at once, whether its delivery comes or not.
  record: (repo, pr, readyAt) => {
    const { key, pr: entry } = pullEntry(repo, pr, readyAt);
    if (pulls.record(key, entry)) log(`${key}: pull request #${entry.number} ${entry.state}`);
  },
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
  log,
});
// Pull requests that turn ready in opted-in repos get a review run (`review.on`), a review
// that requests changes one fix run (`review.fix`), and with the operator's
// `allow_auto_merge`, a clean review the merge (`review.merge`).
// Each task's last policy decisions, for its page (decisions.mjs).
ctx.decisions = createDecisions({ path: join(config.dataDir, "decisions.json") });
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
  grantOf: (repo) => {
    try {
      return grantFor(loadGrants(config), config, repo);
    } catch (error) {
      log(`${repo}: its grants: ${error.message}`);
      return null;
    }
  },
  // The dashboard's "merged by Deckhand", at once.
  merged: (repo, pr) => {
    const { key, pr: entry } = pullEntry(repo, pr);
    pulls.record(key, { ...entry, autoMerged: true });
  },
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
  log,
});

// Run analyses (the dashboard's Analyze): digests of a repo's past runs, without the secrets
// their logs must never carry.
ctx.analysis = createAnalysis({
  runs: () => ctx.runs,
  secrets: () => operatorSecrets(ctx),
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
  publicUrl,
  fromKey: dashboardKey,
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
];
const spelled = await ctx.unifySpellings({
  nameOf: discussionChecks.nameOf,
  keys: keyed.flatMap((state) => state.keys()),
});
for (const state of keyed) state.respell(spelled);

const http = createHttp(ctx, {
  dashboardDir: env.DASHBOARD_DIR || new URL("../dashboard/dist", import.meta.url).pathname,
});
http.listen();
createBrokerHttp(ctx).listen();

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
// The dashboard's Sync: the same now, and the open pull requests' states asked again.
ctx.sync = async () => {
  const [redelivered, changed] = await Promise.all([redeliveries.scan(), pulls.resync()]);
  return { redelivered: redelivered ?? 0, pulls: changed };
};

log(`Deckhand ${ctx.server.version}`);
log(
  `Agents: ${config.agent} for work, ${config.brainstormAgent} for light runs; repos may pick ${config.agents.join(", ")}${config.fallbacks.length ? `; on provider errors, falls back to ${config.fallbacks.join(", ")}` : ""}`,
);
for (const name of [config.claudeCredential, config.openaiCredential, config.agyCredential]) {
  const plan = planWarning(name);
  if (plan) log(plan);
}
// Read (and refreshed if due) now, so a missing or spent login shows before a run needs it.
chatgptLogin
  ?.headers()
  .then(() => log(`Codex: a ChatGPT plan's login, from ${env.CODEX_AUTH_FILE}`))
  .catch((error) => log(`Codex: ${error.message}`));
agyLogin
  ?.headers()
  .then(() => log(`Antigravity CLI: a Google AI plan's login, from ${env.AGY_AUTH_FILE}`))
  .catch((error) => log(`Antigravity CLI: ${error.message}`));
if (!ctx.app) log(`No GitHub App yet. Set it up at ${setup.link()}`);

// Before any request is served: runs still going since the previous listener, then what it
// left queued (comments for those runs are delivered to them).
const restored = ctx.restoreRuns();
ctx.loadQueue();
ctx.reattach(restored).catch((error) => log(`Re-attaching: ${error.stack ?? error}`));
const relinking = setInterval(ctx.relink, RELINK_MS);
ctx.conflicts.start();
ctx.waits.start();
// After restoreRuns() and loadQueue(): what they bring back is kept.
const history = createHistory(ctx);
history.start();
redeliveries.start();
if (ctx.app) checkApp();
// Pull requests that changed while the listener was down, or whose delivery was lost.
if (ctx.app) pulls.resync().catch((error) => log(`Pull requests: ${error.message ?? error}`));
// Labels added or removed while the listener was down.
if (ctx.app && config.needsInputLabel) {
  repoList
    .names()
    .then((repos) => inputs.sync(repos))
    .then((found) => titles.seed(found))
    .catch((error) => log(`Issues waiting for input: ${error.message ?? error}`));
}

// `docker compose up`, `restart` or an update stops the listener with SIGTERM, and kills it
// after the stop grace period. Sandboxes go on: no run starts any more, what is queued is
// saved with the 👀 ids, the runs' state is written, and the next listener carries on.
process.on("SIGTERM", () => {
  ctx.stopping = true;
  ctx.conflicts.stop();
  ctx.waits.stop();
  history.stop();
  redeliveries.stop();
  clearInterval(relinking);
  log("Stopping: running sandboxes go on, the next listener picks them up");
  // Replies being posted and comments being admitted first, then what they leave.
  Promise.allSettled([...ctx.ending, ...http.admitting])
    .then(ctx.saveQueue)
    .then(() => Promise.all([...ctx.tasks.values()].map((t) => t.live && ctx.saveLive(t))))
    .catch((error) => log(`Saving the queue: ${error.stack ?? error}`))
    .finally(() => process.exit(0));
});
