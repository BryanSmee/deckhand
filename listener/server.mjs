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
import { createAnthropicProxy, NAMED } from "./anthropic.mjs";
import { antigravity } from "./agents/antigravity.mjs";
import { createAntigravityLogin } from "./antigravity-login.mjs";
import { createChatgptLogin } from "./chatgpt.mjs";
import { createGoogleRelay } from "./google.mjs";
import { createOpenAiProxy } from "./openai.mjs";
import { planWarning } from "./upstream.mjs";
import { createBroker } from "./broker.mjs";
import { clientAddress, createBrokerHttp, runAt, runFrom } from "./broker-http.mjs";
import { createGitGateway } from "./git-gateway.mjs";
import { createForkChecks } from "./github-forks.mjs";
import { createGithubGateway } from "./github-gateway.mjs";
import { createGraphqlChecks, createValidator, lookupNodes } from "./github-graphql.mjs";
import { createPullChecks } from "./github-pulls.mjs";
import { createReadChecks, createWriteChecks } from "./github-writes.mjs";
import { createProjects } from "./projects.mjs";
import { createBrainstorms, createIssueModes } from "./brainstorms.mjs";
import { checkout } from "./checkout.mjs";
import { createComments } from "./comments.mjs";
import { createConflicts, intoDefaultBranch } from "./conflicts.mjs";
import { ConfigError, loadConfig, readConfigFile, withCredentialFiles } from "./config.mjs";
import { drain } from "./drain.mjs";
import {
  checkAppSettings,
  createGitHubApp,
  loadCredentials,
  saveCredentials,
} from "./github-app.mjs";
import { pullEntry, taskKey } from "./events.mjs";
import {
  createGitHub,
  fetchPull,
  getJson,
  fetchTitle,
  listLabelled,
  listPulls,
} from "./github.mjs";
import { autoMergeGrants, grantErrors, grantFor, loadGrants } from "./grants.mjs";
import { createHttp } from "./http.mjs";
import { createHistory } from "./history.mjs";
import { createImages } from "./images.mjs";
import { createInputs } from "./inputs.mjs";
import { createOnboarding, createOnboardingStore } from "./onboarding.mjs";
import { createLinkedBranches } from "./linked-branch.mjs";
import { builtInPolicies, createPolicies } from "./policies.mjs";
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
import { createReviewers, openerOf } from "./reviewers.mjs";
import { createReviews, stepsGoing } from "./reviews.mjs";
import { loadRuns } from "./runlog.mjs";
import { createDiscussionApi, fromKey } from "./discussions.mjs";
import { createDismissals } from "./dismissals.mjs";
import { createBackend } from "./runner/index.mjs";
import { operatorSecrets } from "./secrets.mjs";
import { createRuns } from "./runs.mjs";
import { createSetup } from "./setup.mjs";
import { createStatus, serverInfo, serverSetup } from "./status.mjs";
import { createSync } from "./sync.mjs";
import { busyTask, createTasks } from "./tasks.mjs";
import { createLanes, fetchParent } from "./lanes.mjs";
import { createOrder } from "./order.mjs";
import { createTitles } from "./titles.mjs";
import { createWaits } from "./waits.mjs";
import { createWorkApi } from "./work.mjs";

// How long the egress policy's answers in flight get once the broker drained: they are quick.
const POLICY_DRAIN_MS = 5000;

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

// Where sandboxes, images and the listener's own short containers run (RUNNER).
let backend;
try {
  backend = createBackend({ config, inboxDir: runsDir, log });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
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

// Failed runs dismissed from the dashboard, while each is its task's last (dismissals.mjs).
const dismissals = createDismissals({ path: join(config.dataDir, "dismissed.json") });

// The run order the maintainer set on the dashboard: which queued task starts next (order.mjs).
const order = createOrder({ path: join(config.dataDir, "order.json") });

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
    rememberPermissions: (...args) => ctx.app.rememberPermissions(...args),
    settings: checkApp,
  },
  config,
  store: onboarded,
  log,
});

// Each repo's settings as last read: its runs' and comments', its `users` for the dashboard.
const { repoSettings, ...repoReads } = createRepoSettings({ github, config, repoList });

// Deckhand's, the operator's and the repos' policies (rules as code), evaluated by `opa` after
// the built-in gates. The operator's are checked now, over Deckhand's, as the grants are: an
// error refuses each decision a policy is asked for (fail closed), so it is said at once.
const policies = createPolicies({
  config,
  github,
  secrets: () => operatorSecrets(ctx),
  readBuiltIn: () => builtInPolicies(),
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
  images: createImages({
    config,
    backend: backend.images,
    jobs: backend.jobs,
    readFile: repoFile,
    checkout: fetchCheckout,
    log,
  }),
  previews: createPreviews({
    config,
    containers: backend.jobs.preview,
    checkout: fetchCheckout,
    logDir: join(config.dataDir, "previews"),
    log,
  }),
  // The runs' secrets, which work from their own sandbox alone.
  broker: createBroker({ sentFrom: (run, ip) => runAt(ctx, run, ip) }),
  // The egress proxy's CA certificate, for runs that reach GitHub, or whose grant has
  // cached_hosts (egress.mjs).
  egressCa: () => fetchEgressCa(config.egressProxy),
  // Sandboxes are started, followed and removed through it; they run detached.
  runner: backend.runner,
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
  // The run's own secret too, which the broker keeps by hash only.
  secrets: (run) => [
    ...[...ctx.tasks.values()]
      .filter((t) => t.live?.secret && ctx.broker.runOf(t.live.secret) === run)
      .map((t) => t.live.secret),
    ...operatorSecrets(ctx),
  ],
  // Their REST writes and GraphQL mutations: within their mode's ceiling, and what the
  // policies' `deny_github` allows. Their targets are looked up with the listener's token.
  checkWrite: writeChecks.check,
  checkGraphql: graphqlChecks.check,
  // Their reads of CI's results beyond Actions: what `deny_github` allows, once per run.
  checkRead: createReadChecks({ policies }).checkRead,
  // Their creates' and comments' answers: the issues each run created, for its links, and the
  // comments it posted, which it may edit.
  wroteWrite: writeChecks.answered,
  readsProjects,
  log,
});
// Their pushes, on the broker's port: to the run's own branches only, never the default one.
ctx.gitGateway = createGitGateway({
  broker: ctx.broker,
  app: () => ctx.app,
  // Read on each push: a grant taken back applies to the next one.
  allowWorkflows: (repo) => grantFor(loadGrants(config), config, repo).allowWorkflows,
  // A work run that isn't a fork's pushes nothing that reaches a fork's objects.
  forks: forkChecks,
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
  // For runs on a credential their entry names (`claude@anthropic:key`, FALLBACKS).
  named: Object.fromEntries(
    config.credentials["claude@anthropic"].set.map((c) => [c, env[NAMED[c].variable]]),
  ),
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
        jobs: backend.jobs,
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
// that requests changes a fix loop (`review.fix`), and with the operator's
// `allow_auto_merge`, a clean review the merge (`review.merge`).
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
  runOf: (secret) => ctx.broker.runOf(secret),
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
  grantOf: (repo) => {
    try {
      return grantFor(loadGrants(config), config, repo);
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
  // The Overview's repository cards: no GitHub read per repo when they show.
  backlogs: (repos, user) => ctx.workApi.counts(repos, user),
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
  lanes,
  dismissals,
  order,
  queueOrder: () => ctx.queueOrder(),
  reviews: ctx.reviews,
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
// A fix loop's step whose run neither came back nor waits in the queue: no longer on its way.
ctx.reviews.forgetSteps(stepsGoing(ctx.tasks));
// queue.json is only written when the listener stops: after a crash, the keys of comments it
// lost stay in order.json, and would rank a new comment there as placed.
order.keep(ctx.queueOrder().map((t) => taskKey(t.repo, t.id)));
ctx.reattach(restored).catch((error) => log(`Re-attaching: ${error.stack ?? error}`));
const relinking = setInterval(ctx.relink, RELINK_MS);
ctx.conflicts.start();
ctx.waits.start();
ctx.reviews.start();
// After restoreRuns() and loadQueue(): what they bring back is kept.
const history = createHistory(ctx);
history.start();
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
// after the stop grace period. Sandboxes go on: no run starts any more, what is queued is
// saved with the 👀 ids, the runs' state is written, and the next listener carries on. The
// broker drains meanwhile: it takes no new connection (the egress proxy waits for the next
// listener, proxy/wait.mjs) and the sandboxes' calls in flight finish (agents' streams, pushes,
// inbox polls) before it exits (drain.mjs). The egress policy's port answers until then.
process.on("SIGTERM", () => {
  ctx.stopping = true;
  ctx.conflicts.stop();
  ctx.waits.stop();
  ctx.reviews.stop();
  history.stop();
  redeliveries.stop();
  clearInterval(relinking);
  log("Stopping: running sandboxes go on, the next listener picks them up");
  // Webhooks go to the next listener (GitHub's redelivery if it isn't up yet, redeliveries.mjs).
  web.close();
  const drained = drain(broker).then((all) => {
    if (!all) log("Stopping: sandboxes' calls still going at the end of the grace period, cut");
  });
  // Replies being posted and comments being admitted first, then what they leave.
  const saved = Promise.allSettled([...ctx.ending, ...http.admitting])
    .then(ctx.saveQueue)
    .then(() => Promise.all([...ctx.tasks.values()].map((t) => t.live && ctx.saveLive(t))))
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
