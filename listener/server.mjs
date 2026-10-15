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
import { createAuth, sessionKey } from "./auth.mjs";
import { createAnthropicProxy } from "./anthropic.mjs";
import { createBroker } from "./broker.mjs";
import { createGitGateway } from "./git-gateway.mjs";
import { createPrReady } from "./pr-ready.mjs";
import { createBrainstorms, createIssueModes } from "./brainstorms.mjs";
import { checkout } from "./checkout.mjs";
import { createComments } from "./comments.mjs";
import { createConflicts } from "./conflicts.mjs";
import { ConfigError, loadConfig, readConfigFile } from "./config.mjs";
import { docker } from "./docker.mjs";
import { outcome } from "./events.mjs";
import { createGitHubApp, loadCredentials, saveCredentials } from "./github-app.mjs";
import { grantErrors, loadGrants } from "./grants.mjs";
import { createHttp } from "./http.mjs";
import { createImages } from "./images.mjs";
import { createInputs } from "./inputs.mjs";
import { createOnboarding, createOnboardingStore } from "./onboarding.mjs";
import { createPreviews } from "./previews.mjs";
import { createPulls } from "./pulls.mjs";
import { loadRepoSettings, readRepoFile } from "./repo-config.mjs";
import { createRepoApi, createRepoList } from "./repos.mjs";
import { createRestart } from "./restart.mjs";
import { loadRuns } from "./runlog.mjs";
import { createDockerRunner } from "./runner/docker.mjs";
import { createRuns } from "./runs.mjs";
import { createSetup } from "./setup.mjs";
import { createTasks } from "./tasks.mjs";
import { closedAs, createTitles } from "./titles.mjs";
import { createWaits } from "./waits.mjs";

const env = process.env;
let config;
try {
  config = loadConfig(env, readConfigFile(env));
  // Read again at each run. A broken layout or default.yaml at start is the operator's to fix
  // now; a broken repo file stops that repo's runs only, so the others start.
  for (const error of grantErrors(loadGrants(config))) {
    console.error(`${error.message} (no run starts in that repository until it is fixed)`);
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
  // The release (a git tag) the images were built from; "dev" from source.
  version: env.DECKHAND_VERSION || "dev",
  config,
  log,
  skip,
  logDir,
  shotsDir,
  // Null until /setup has stored an App: webhooks are refused meanwhile.
  app: null,
  // key ("org/repo#12") → task (tasks.mjs).
  tasks: new Map(),
  // The dashboard's runs, newest first (runlog.mjs).
  runs: loadRuns(logDir),
  // Runs with a sandbox, for the parallel cap.
  running: 0,
  // Set on SIGTERM: no run starts any more, what waits is saved for the next listener.
  stopping: false,
};

// --- GitHub ----------------------------------------------------------------------------

function useApp(credentials) {
  ctx.app = createGitHubApp({ credentials, api: config.githubApi, log });
}

{
  const credentials = loadCredentials(config.dataDir);
  if (credentials) useApp(credentials);
}

// PUBLIC_URL, or the one /setup stored with the App.
function publicUrl() {
  return config.publicUrl ?? ctx.app?.credentials.public_url ?? `http://localhost:${config.port}`;
}

// `expected`: error statuses that are normal for this call, so not logged.
async function github(repo, method, path, body, expected = []) {
  if (!ctx.app) throw new Error("the GitHub App is not set up");
  return ctx.app.request(repo, method, path, body, expected);
}

// Discussions are written to through GraphQL only. Its errors come with a 200: thrown here.
async function graphql(repo, query, variables) {
  const res = await github(repo, "POST", "/graphql", { query, variables });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok || answer.errors) {
    throw new Error(`GraphQL: ${res.status} ${JSON.stringify(answer.errors ?? answer)}`);
  }
  return answer.data;
}

const setup = createSetup({
  config,
  configured: () => ctx.app !== null,
  onConfigured: (credentials) => {
    saveCredentials(config.dataDir, credentials);
    useApp(credentials);
  },
  log,
});

const auth = createAuth({
  config,
  app: () => ctx.app,
  publicUrl,
  key: sessionKey(config.dataDir),
  log,
});

// The dashboard's titles and closed states: from webhooks, else fetched (titles.mjs).
const titles = createTitles({
  path: join(config.dataDir, "titles.json"),
  closedPath: join(config.dataDir, "closed.json"),
  log,
  fetchTitle: async (repo, kind, number) => {
    if (kind === "discussion") {
      const [owner, name] = repo.split("/");
      const data = await graphql(
        repo,
        "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { title } } }",
        { owner, name, number },
      );
      return { title: data.repository?.discussion?.title ?? null };
    }
    // Pull requests are issues too, for their title and whether they are merged.
    const res = await github(repo, "GET", `/repos/${repo}/issues/${number}`, undefined, [404]);
    if (!res.ok) return null;
    const issue = await res.json();
    return { title: issue.title ?? null, closed: closedAs(outcome(issue)) };
  },
});
// Logs that have their title (newest first: the latest wins).
titles.seed(ctx.runs.map((r) => [r.key, r.title]));

// Each task's pull request: from webhooks, else looked up once (pulls.mjs).
const pulls = createPulls({
  path: join(config.dataDir, "pulls.json"),
  log,
  listPulls: async (repo) => {
    const res = await github(
      repo,
      "GET",
      `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
    );
    const list = res.ok ? await res.json() : null;
    if (!Array.isArray(list)) throw new Error(`no list (${res.status})`);
    return list;
  },
});

// Open issues labelled needs-input: from webhooks, and looked up once per start (inputs.mjs).
const inputs = createInputs({
  path: join(config.dataDir, "inputs.json"),
  log,
  listLabelled: async (repo) => {
    const label = encodeURIComponent(config.needsInputLabel);
    const res = await github(
      repo,
      "GET",
      `/repos/${repo}/issues?labels=${label}&state=open&sort=updated&per_page=100`,
    );
    const list = res.ok ? await res.json() : null;
    if (!Array.isArray(list)) throw new Error(`no list (${res.status})`);
    return list;
  },
});

// --- Per-repo settings, images and preview hooks -------------------------------------------

// A repo's settings from its default branch; errors in its config file stop its runs.
function repoSettings(repo, base) {
  return loadRepoSettings(github, config, repo, base || "main");
}

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

Object.assign(ctx, {
  github,
  graphql,
  publicUrl,
  repoSettings,
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
  onboarding: createOnboarding({ request: github, store: onboarded, config, log }),
  images: createImages({ config, docker, readFile: repoFile, checkout: fetchCheckout, log }),
  previews: createPreviews({
    config,
    docker,
    checkout: fetchCheckout,
    logDir: join(config.dataDir, "previews"),
    log,
  }),
  // The sandboxes' only way to GitHub: short-lived tokens for their run's repo, which only
  // read the code.
  broker: createBroker({ app: () => ctx.app, log }),
  // Sandboxes are started, followed and removed through it; they run detached.
  runner: createDockerRunner({ config, docker, inboxDir: runsDir, log }),
});

// Their pushes, on the broker's port: to the run's own branches only, never the default one.
ctx.gitGateway = createGitGateway({
  broker: ctx.broker,
  app: () => ctx.app,
  githubUrl: config.githubUrl,
  log,
});
// Their Claude Code's API calls, with the operator's credential that they never see.
ctx.anthropic = createAnthropicProxy({
  broker: ctx.broker,
  name: config.claudeCredential,
  credential: config.claudeCredential && env[config.claudeCredential],
  upstream: config.anthropicUrl,
  log,
});
// Their pull requests ready for review (or back to draft): their own token can't.
ctx.prReady = createPrReady({
  broker: ctx.broker,
  app: () => ctx.app,
  api: config.githubApi,
  log,
});

// --- Tasks, runs and restarts --------------------------------------------------------------

// A task with a run going or comments waiting for one.
function taskBusy(key) {
  const task = ctx.tasks.get(key);
  return !!(task?.running || task?.pending.length);
}

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
Object.assign(ctx, createTasks(ctx), createRuns(ctx), createRestart(ctx));
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
// Comments that wait for other issues to be done ("/after #12").
ctx.waits = createWaits({
  path: join(config.dataDir, "waits.json"),
  github,
  reply: ctx.reply,
  received: ctx.received,
  settle: ctx.settle,
  resume: (item) => ctx.resume(item),
  log,
});
ctx.repoApi = createRepoApi({
  config,
  list: repoList,
  publicUrl,
  start: (repo, login) => ctx.onboardRepo(repo, login, true),
  log,
});

// --- Servers -------------------------------------------------------------------------------

const http = createHttp(ctx, {
  dashboardDir: env.DASHBOARD_DIR || new URL("../dashboard/dist", import.meta.url).pathname,
});
http.listen();
http.listenBroker();

log(`Deckhand ${ctx.version}`);
if (!ctx.app) log(`No GitHub App yet. Set it up at ${setup.link()}`);

// Before any request is served: runs still going since the previous listener, then what it
// left queued (comments for those runs are delivered to them).
const restored = ctx.restoreRuns();
ctx.loadQueue();
ctx.reattach(restored).catch((error) => log(`Re-attaching: ${error.stack ?? error}`));
ctx.conflicts.start();
ctx.waits.start();
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
  log("Stopping: running sandboxes go on, the next listener picks them up");
  // Replies being posted and comments being admitted first, then what they leave.
  Promise.allSettled([...ctx.ending, ...http.admitting])
    .then(ctx.saveQueue)
    .then(() => Promise.all([...ctx.tasks.values()].map((t) => t.live && ctx.saveLive(t))))
    .catch((error) => log(`Saving the queue: ${error.stack ?? error}`))
    .finally(() => process.exit(0));
});
