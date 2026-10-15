// Deckhand's listener: receives the GitHub App's webhooks, runs Claude Code in a sandbox
// container (../sandbox/) for issue and pull request comments, one container and one set of
// volumes per issue, and posts Claude's final message back as a comment.
//
//   On an issue:   "Deckhand" (TRIGGER) as the first line starts the work; the other lines
//                  are extra instructions. Once started, any comment continues the session.
//                  The sandbox opens the branch and draft pull request (../sandbox/draft-pr.sh).
//   On its PR:     any comment, review or review comment continues the same session.
//   Anywhere:      "/model sonnet" or "/effort high" lines pick the model or thinking effort
//                  for that run (defaults: SANDBOX_MODEL, SANDBOX_EFFORT).
//
// A comment that arrives while its issue's run is working goes to that run: after the usual
// pause (so a burst is one message), the listener writes it to the run's inbox (stream-json
// input, TASK_INPUT=stream in ../sandbox/entrypoint.sh), and Claude sees it after its current
// tool call; the run's final message is still the one reply and covers it. "/model" and
// "/effort" cannot change a live process: they apply to the next run, and the reply says so.
// Comments the run cannot take (a trigger that switches between work and brainstorm, a
// wrap-up, or one arriving once Claude's input is closed) wait for a follow-up run.
//
// "Deckhand" then "/mode brainstorm" (or "Deckhand /mode brainstorm" on one line) starts a
// brainstorm instead: Claude discusses the issue (../prompts/brainstorm.md) without
// writing code, and each later comment on the issue is the next message of that
// conversation. A brainstorm run starts light (SANDBOX_LIGHT) after a short pause
// (BRAINSTORM_DEBOUNCE_MS) and goes before queued work. "/stop" ends it: Claude posts a
// summary and updates the issue's description, then comments no longer reach it until a
// trigger line. After BRAINSTORM_IDLE_MINUTES (10) without a comment it shows as idle; a
// comment then restores it from the issue's session volume. "Deckhand" or "/mode work"
// afterwards implements in the same session, so the decisions carry over. Issues only.
//
// A "/mode <name>" line picks a mode: work, brainstorm or one of the repo's own (its
// config's `modes:`), with the trigger line, or alone on an issue that has a session, which
// then goes on in the new mode with its conversation so far. A repo's mode brings its own
// instructions, model and effort; a light one runs like a brainstorm and only comments (its
// token only reads), a fresh one starts a new session each time. Comments without a trigger
// or "/mode" line go on in the issue's current mode (modes.json).
//
// Installing the App on a repo without a .deckhand.yaml (an `installation` or
// `installation_repositories` delivery, sent to every App) opens an onboarding issue there
// (onboarding.mjs) and starts the "onboarding" mode on it: a light conversation like a
// brainstorm, with a read-only token, where Claude proposes the file
// (../prompts/onboarding.md). Comments go on in it; the trigger line or "/mode work" opens the
// pull request, and the reply says what the listener makes of the branch's config.
// "/mode onboarding" starts it on any issue.
//
// A run that stops to ask (its final message starts with "<!-- needs-input -->", see
// ../prompts/sandbox.md) shows as "needs-input" on the dashboard and labels the issue or PR
// NEEDS_INPUT_LABEL (default needs-input) until the next run starts.
//
// Reactions on the triggering comment follow its run: 👀 when it is received, then 🚀 (done),
// 😕 (needs input) or 👎 (error) once the run that handled it is over.
//
// GitHub: the operator's private App, created at /setup (setup.mjs) and stored in the data
// volume. The listener calls GitHub with installation tokens; sandboxes get none up front and
// ask the broker (broker.mjs, BROKER_PORT, only on the sandboxes' network) for a fresh token
// limited to their repo, with a secret that dies with the run.
//
// GET / is a dashboard of every repo's issues and pull requests, their state and live logs,
// for ALLOWED_USERS signed in with GitHub through the App (auth.mjs, board.mjs), built from
// ../dashboard/ (static.mjs, titles.mjs); GET /status says what is going on, to them and to
// calls from inside the container.
//
// The listener can restart at any time (an update is `docker compose pull && up -d`).
// Sandboxes run detached, through the runner (runner/docker.mjs): on SIGTERM the listener
// starts no more runs and saves the comments still waiting for one to queue.json; each run's
// state is in logs/<run>.live.json all along. The next listener reads both, finds the
// sandboxes by their labels, follows their output from where the previous one stopped, and
// posts each reply once.
//
// GET /shots/<token>/<file> serves the screenshots runs save for their pull requests: GitHub
// cannot take image uploads through its API, so they need a public URL.
//
// Each repo may bring a .deckhand.yaml on its default branch (repo-config.mjs): its own
// trigger word, models, parallel cap and users (only narrowing the operator's), a setup
// command and extra instructions for the sandbox, a Dockerfile FROM the base image
// (images.mjs builds it), cache volumes, and a preview hook run on pull_request and
// workflow_run deliveries (previews.mjs). A config with errors stops runs, and the reply
// says why.
//
// Sandboxes run with no capabilities, no-new-privileges and CPU, memory and pids limits, on
// an internal network (checked before each run) whose only way out is the egress proxy
// (../proxy/proxy.mjs): it asks the broker's port, for each connection, whether the sandbox
// at that address may reach that host (egress.mjs). Host mounts only happen under roots the
// operator grants the repo (grants.mjs, GRANTS_FILE). See ../docs/security.md.
//
// Only comments from ALLOWED_USERS, on repos where the App is installed (narrowed by
// ALLOWED_REPOS if set), are acted on: the sandbox runs without permission prompts and can
// push. No dependencies: node:http, node:crypto, docker CLI.
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createAuth, page, sessionKey } from "./auth.mjs";
import { board, STATES } from "./board.mjs";
import { createBroker } from "./broker.mjs";
import { checkout } from "./checkout.mjs";
import { ConfigError, loadConfig } from "./config.mjs";
import { docker } from "./docker.mjs";
import { mandatoryHosts, matchHost, proxyEnv, runHosts } from "./egress.mjs";
import { MARKER, previewEvent, pullRequest, takeOptions, verified, workItem } from "./events.mjs";
import {
  createGitHubApp,
  DISCUSSION_PERMISSIONS,
  loadCredentials,
  READ_ONLY_PERMISSIONS,
  saveCredentials,
} from "./github-app.mjs";
import { grantFor, hardeningArgs, loadGrants, mountArgs, resolveMounts } from "./grants.mjs";
import { createImages, imageRef } from "./images.mjs";
import {
  branchConfigReport,
  createOnboarding,
  createOnboardingStore,
  onboardingTargets,
  triggerWord,
} from "./onboarding.mjs";
import { createRepoApi, createRepoList, refreshFor } from "./repos.mjs";
import { createPreviews } from "./previews.mjs";
import {
  CONFIG_FILE,
  customMode,
  effectiveConfig,
  loadRepoSettings,
  modeNames,
  readRepoFile,
  startable,
} from "./repo-config.mjs";
import { createDockerRunner } from "./runner/docker.mjs";
import { createSetup } from "./setup.mjs";
import { serveAsset } from "./static.mjs";
import { createPulls } from "./pulls.mjs";
import { createTitles } from "./titles.mjs";

const env = process.env;
// The release (a git tag) the images were built from; "dev" from source.
const VERSION = env.DECKHAND_VERSION || "dev";
let config;
try {
  config = loadConfig(env);
  // Read again at each run; a broken file at start is the operator's to fix now.
  loadGrants(config);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}
const logDir = join(config.dataDir, "logs");
const shotsDir = join(config.dataDir, "shots");
mkdirSync(logDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });

// Starts the final message of a run that stopped to ask the maintainer (../prompts/sandbox.md).
const NEEDS_INPUT = "<!-- needs-input -->";

// "ok", "needs-input" or "error" for a stream-json `result` event (null: no result).
function outcome(result) {
  if (!result || result.is_error) return "error";
  return (result.result ?? "").trimStart().startsWith(NEEDS_INPUT) ? "needs-input" : "ok";
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Logs why a delivery is ignored: deliveries that do nothing are the usual question.
function skip(reason) {
  log(`  ignored: ${reason}`);
  return null;
}

// --- GitHub ----------------------------------------------------------------------------

// Null until /setup has stored an App: webhooks are refused meanwhile.
let app = null;

function useApp(credentials) {
  app = createGitHubApp({ credentials, api: config.githubApi, log });
}

{
  const credentials = loadCredentials(config.dataDir);
  if (credentials) useApp(credentials);
}

const setup = createSetup({
  config,
  configured: () => app !== null,
  onConfigured: (credentials) => {
    saveCredentials(config.dataDir, credentials);
    useApp(credentials);
  },
  log,
});

const broker = createBroker({ app: () => app, log });

const auth = createAuth({
  config,
  app: () => app,
  publicUrl,
  key: sessionKey(config.dataDir),
  log,
});
if (env.DASHBOARD_PASSWORD) {
  log("DASHBOARD_PASSWORD is no longer used: allowed users sign in with GitHub (docs/setup.md)");
}

// PUBLIC_URL, or the one /setup stored with the App.
function publicUrl() {
  return config.publicUrl ?? app?.credentials.public_url ?? `http://localhost:${config.port}`;
}

// `expected`: error statuses that are normal for this call, so not logged.
async function github(repo, method, path, body, expected = []) {
  if (!app) throw new Error("the GitHub App is not set up");
  return app.request(repo, method, path, body, expected);
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

// The dashboard's titles: from webhooks, else fetched once (titles.mjs).
const titles = createTitles({
  path: join(config.dataDir, "titles.json"),
  log,
  fetchTitle: async (repo, kind, number) => {
    if (kind === "discussion") {
      const [owner, name] = repo.split("/");
      const data = await graphql(
        repo,
        "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { title } } }",
        { owner, name, number },
      );
      return data.repository?.discussion?.title ?? null;
    }
    // Pull requests are issues too, for their title.
    const res = await github(repo, "GET", `/repos/${repo}/issues/${number}`, undefined, [404]);
    return res.ok ? ((await res.json()).title ?? null) : null;
  },
});

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

// GitHub's reactions have no ✅: 🚀 reads as "shipped" and isn't mistaken for a manual 👍.
// A wrap-up ("/stop") only loses its 👀.
const REACTIONS = {
  ok: "rocket",
  "needs-input": "confused",
  error: "-1",
  stopped: null,
};

// GraphQL's names for the reactions above.
const REACTION_ENUM = { eyes: "EYES", rocket: "ROCKET", confused: "CONFUSED", "-1": "THUMBS_DOWN" };

// Reaction failures (already removed, 403, 404…) are logged and never break a run.
async function react(repo, comment, content) {
  const kind = comment.review ? "pulls/comments" : "issues/comments";
  try {
    if (comment.discussion) {
      // Removed by content rather than id (settle()): any truthy value will do.
      await graphql(
        repo,
        "mutation($id: ID!, $content: ReactionContent!) { addReaction(input: {subjectId: $id, content: $content}) { clientMutationId } }",
        { id: comment.node_id, content: REACTION_ENUM[content] },
      );
      return content;
    }
    const res = await github(repo, "POST", `/repos/${repo}/${kind}/${comment.id}/reactions`, {
      content,
    });
    return res.ok ? (await res.json()).id : null;
  } catch (error) {
    log(`Reaction on comment ${comment.id}: ${error}`);
    return null;
  }
}

// 👀 on receipt; its id is kept so the run's outcome can replace it (a reaction can't be
// edited). Reviews without a comment have no reactions API: they get none.
function received(item) {
  if (item.comment) item.eyes = react(item.repo, item.comment, "eyes");
}

// Once the run that handled a comment is over: 👀 off, then the outcome's reaction.
async function settle(item, status) {
  const { repo, comment } = item;
  if (!comment) return;
  const kind = comment.review ? "pulls/comments" : "issues/comments";
  try {
    const eyes = await item.eyes;
    if (eyes && comment.discussion) {
      await graphql(
        repo,
        "mutation($id: ID!) { removeReaction(input: {subjectId: $id, content: EYES}) { clientMutationId } }",
        { id: comment.node_id },
      );
    } else if (eyes) {
      await github(
        repo,
        "DELETE",
        `/repos/${repo}/${kind}/${comment.id}/reactions/${eyes}`,
        null,
        [404],
      );
    }
  } catch (error) {
    log(`Reaction on comment ${comment.id}: ${error}`);
  }
  if (REACTIONS[status]) await react(repo, comment, REACTIONS[status]);
}

function reply(repo, number, text) {
  const body = text.length > 60000 ? text.slice(0, 60000) + "\n\n…" : text;
  return github(repo, "POST", `/repos/${repo}/issues/${number}/comments`, {
    body: `${body}\n\n${MARKER}`,
  });
}

// Where a run's answer goes: a comment on the issue or pull request `target.replyTo`, or in
// the discussion, in the thread of the comment it answers (`target.comment`; GitHub threads
// are one level deep, so a reply to a reply goes to the same thread).
async function answer(target, text) {
  if (target.kind !== "discussion") return reply(target.repo, target.replyTo, text);
  const body = text.length > 60000 ? text.slice(0, 60000) + "\n\n…" : text;
  const c = target.comment;
  let thread = null;
  if (c?.discussion && c.node_id !== target.discussionId) {
    thread = c.node_id;
    if (c.parent_id) {
      const data = await graphql(
        target.repo,
        "query($id: ID!) { node(id: $id) { ... on DiscussionComment { replyTo { id } } } }",
        { id: c.node_id },
      );
      thread = data.node?.replyTo?.id ?? null;
    }
  }
  return graphql(
    target.repo,
    "mutation($id: ID!, $thread: ID, $body: String!) { addDiscussionComment(input: {discussionId: $id, replyToId: $thread, body: $body}) { comment { url } } }",
    { id: target.discussionId, thread, body: `${body}\n\n${MARKER}` },
  );
}

// Adding a label that doesn't exist yet creates it.
function label(repo, number, add) {
  const name = config.needsInputLabel;
  return add
    ? github(repo, "POST", `/repos/${repo}/issues/${number}/labels`, {
        labels: [name],
      })
    : github(
        repo,
        "DELETE",
        `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`,
        null,
        [404],
      );
}

// --- Per-repo settings, images and preview hooks -------------------------------------------

// A repo's settings from its default branch; errors in its config file stop its runs.
function repoSettings(repo, base) {
  return loadRepoSettings(github, config, repo, base || "main");
}

const repoFile = (repo, path, ref) => readRepoFile(github, repo, path, ref);
const fetchCheckout = (repo, ref) => checkout(github, repo, ref);

const images = createImages({ config, docker, readFile: repoFile, checkout: fetchCheckout, log });
// The repos onboarded so far (onboarding.json) and their onboarding issues (onboarding.mjs).
const onboarded = createOnboardingStore(join(config.dataDir, "onboarding.json"));
const onboarding = createOnboarding({ request: github, store: onboarded, config, log });
const previews = createPreviews({
  config,
  docker,
  checkout: fetchCheckout,
  logDir: join(config.dataDir, "previews"),
  log,
});

// A run that can't start for a reason the maintainer can fix: the reply says it.
class RunError extends Error {}

function configErrors(base, errors) {
  return `Claude can't run here: \`${CONFIG_FILE}\` on \`${base || "main"}\` has errors.\n\n${errors.map((e) => `- ${e}`).join("\n")}`;
}

// A comment that passed the operator's checks, checked again with its repo's settings
// (users, trigger lines), then queued.
async function admit(first, event, payload) {
  const { settings, errors } = await repoSettings(first.repo, first.base);
  if (errors.length) {
    log(`${first.repo}: ${CONFIG_FILE} has errors: ${errors.join("; ")}`);
    // Only to someone asking for a run: other comments can't tell a broken config from none,
    // and discussions can't tell whether they are in the category that calls Claude.
    if ((first.trigger || first.modeLine) && first.kind !== "discussion") {
      await reply(first.repo, first.replyTo, configErrors(first.base, errors));
    }
    return;
  }
  const item = workItem(effectiveConfig(config, settings), event, payload, skip);
  if (!item) return;
  item.base = first.base;
  item.settings = settings;
  await accept(item);
}

// An onboarding issue for the repo, if it needs one, starting an onboarding run on it as a
// "/mode onboarding" comment would. Resolves to the issue, or null (the reason logged).
// `byHand`: started from the dashboard's repository list.
async function onboardRepo(repo, sender, byHand = false) {
  const issue = await onboarding.open(repo, sender, byHand).catch((error) => {
    log(`  onboarding ${repo}: ${error.stack ?? error}`);
    return null;
  });
  if (!issue) return null;
  const { settings } = await repoSettings(repo, issue.base);
  await accept({
    repo,
    id: String(issue.number),
    kind: "issue",
    number: issue.number,
    title: issue.title,
    trigger: null,
    modeLine: "onboarding",
    text: "",
    replyTo: issue.number,
    comment: null,
    base: issue.base,
    settings,
  });
  return issue;
}

// An installation delivery: an onboarding issue per repo that needs one.
async function onboard(repos, sender) {
  for (const repo of repos) await onboardRepo(repo, sender);
}

// The dashboard's repository list (repos.mjs), refreshed by the deliveries that change it.
const repoList = createRepoList({
  app: {
    asApp: (...args) => app.asApp(...args),
    asInstallation: (...args) => app.asInstallation(...args),
    request: github,
    remember: (...args) => app.remember(...args),
  },
  config,
  store: onboarded,
  log,
});
const repoApi = createRepoApi({
  config,
  list: repoList,
  publicUrl,
  start: (repo, login) => onboardRepo(repo, login, true),
  log,
});

async function previewHook({ repo, base, event }, payload) {
  const { settings, errors } = await repoSettings(repo, base);
  if (errors.length) return skip(`${event}: ${CONFIG_FILE} of ${repo} has errors`);
  if (!settings.preview) return skip(`${event}: ${repo} has no preview hook`);
  const image =
    settings.preview.image ??
    (await images.imageFor({ repo, ref: base, dockerfile: settings.dockerfile }));
  await previews.run({ repo, event, payload, ref: base, hook: settings.preview, image });
}

// --- Tasks: one queue per issue, at most maxParallel containers -----------------------------

// live: the running sandbox's input (see run()); next: /model and /effort for the next run.
const tasks = new Map(); // key → { repo, id, kind, number, base, pending: [], running, ready, timer, live, next }
let running = 0;

function containerName(repo, id) {
  return `${config.prefix}-${repo}-${id}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

async function accept(item) {
  const name = containerName(item.repo, item.id);
  const key = `${item.repo}#${item.id}`;
  item.mode = await modeOf(item, key, name);
  if (!item.mode) return;
  titles.set(key, item.title);
  let task = tasks.get(key);
  if (!task) {
    task = {
      ...item,
      name,
      pending: [],
      running: false,
      ready: false,
      timer: null,
      live: null,
      next: {},
    };
    tasks.set(key, task);
  }
  // The latest settings decide the repo's parallel cap.
  if (item.settings) task.settings = item.settings;
  received(item);
  task.pending.push(item);
  if (task.running) {
    const live = deliverable(task) === task.pending.length;
    log(
      `${key}: ${live ? "for the running session" : "queued after the running one"} (${item.mode})`,
    );
    if (live) {
      clearTimeout(task.timer);
      task.timer = setTimeout(() => deliver(task), debounce(task));
    }
  } else {
    log(`${key}: queued (${item.mode}, ${item.kind} ${item.number}, reply on #${item.replyTo})`);
    clearTimeout(task.timer);
    task.ready = false;
    task.timer = setTimeout(() => {
      task.ready = true;
      schedule();
    }, debounce(task));
  }
}

// What a comment asks for: "work", "brainstorm", "stop" (wrap a brainstorm up) or one of the
// repo's own modes (its config's `modes:`); null when it doesn't reach Claude. A "/mode"
// line picks the mode, with or without a trigger line; without either, a comment goes on in
// the issue's current mode. Keeps the issue's brainstorm and mode state up to date.
async function modeOf(item, key, name) {
  // The inbox issue or the discussion category is the trigger (workItem()).
  if (INBOX.has(item.trigger)) return item.trigger;
  const b = brainstorms.get(key);
  let wanted = item.trigger === "stop" ? null : item.trigger;
  if (item.modeLine && item.trigger !== "stop") {
    if (!modeNames(item.settings).includes(item.modeLine)) {
      await unknownMode(item, `Unknown mode \`${item.modeLine}\`.`);
      return null;
    }
    // Without a trigger line, a switch: the conversation so far carries over. Onboarding
    // starts its own.
    const starts = item.modeLine === "onboarding";
    if (!item.trigger && !starts && !b && !issueModes.has(key) && !tasks.has(key)) {
      if (!(await runner.hasSession(name)))
        return skip(`#${item.replyTo} has no Claude session and no trigger line`);
    }
    wanted = item.modeLine;
  }
  // A comment without either goes on in the repo's own mode the issue is in, if any.
  const current = issueModes.get(key);
  const talks = b && item.replyTo === item.number && b.status !== "stopped";
  if (!wanted && item.trigger !== "stop" && current && !talks) {
    if (current === "onboarding") return current;
    if (!customMode(item.settings, current)) {
      // Gone from the config: don't guess what to run instead (work could push).
      await unknownMode(item, `The mode \`${current}\` is no longer in \`${CONFIG_FILE}\`.`);
      return null;
    }
    return current;
  }
  if (wanted === "onboarding") {
    // Like a brainstorm, kept in modes.json: comments go on in it until the trigger line.
    if (b) {
      clearTimeout(b.timer);
      brainstorms.delete(key);
      saveBrainstorms();
    }
    setIssueMode(key, "onboarding");
    // Its work run gets the onboarding prompt and the config check (finish()); no
    // automatic issue for the repo any more.
    if (!onboarded.isIssue(item.repo, item.number)) onboarded.record(item.repo, item.number);
    return wanted;
  }
  const own = customMode(item.settings, wanted);
  if (wanted === "work" || (own && !own.fresh)) {
    // Same session: the work (or the repo's mode) starts from what the brainstorm settled.
    if (b) {
      clearTimeout(b.timer);
      brainstorms.delete(key);
      saveBrainstorms();
    }
    setIssueMode(key, own ? wanted : null);
    return wanted;
  }
  // A fresh mode runs once on its own session: the issue stays in the mode it was in.
  if (own) return wanted;
  if (item.trigger === "stop") {
    if (!b || b.status === "stopped") return skip(`#${item.number} has no brainstorm to stop`);
    clearTimeout(b.timer);
    b.status = "stopped";
    saveBrainstorms();
    return "stop";
  }
  // A comment on the issue itself continues its brainstorm; one on its pull request is work.
  if (wanted === "brainstorm" || (!wanted && b && item.replyTo === item.number)) {
    if (!wanted && b.status === "stopped") {
      return skip(`#${item.number}: brainstorm stopped and no trigger line`);
    }
    setIssueMode(key, null);
    item.restored = b?.status === "idle";
    const next = b ?? { repo: item.repo, number: item.number, timer: null };
    Object.assign(next, {
      status: "active",
      deadline: Date.now() + config.brainstormIdleMs,
    });
    brainstorms.set(key, next);
    armIdle(key, next);
    saveBrainstorms();
    return "brainstorm";
  }
  // Without a trigger line, a comment only continues work Claude already started.
  if (!item.trigger && !tasks.has(key)) {
    if (!(await runner.hasSession(name)))
      return skip(`#${item.replyTo} has no Claude session and no trigger line`);
  }
  return "work";
}

// The reply to a "/mode" Claude can't run: the modes there are. No run starts.
async function unknownMode(item, what) {
  const own = item.settings?.modes ?? {};
  const list = modeNames(item.settings)
    .map((m) => `\`${m}\`${own[m]?.light ? " (comments only)" : ""}`)
    .join(", ");
  const where = `${item.repo}#${item.id}`;
  log(`${where}: ${what}`);
  const text = `${what} The modes here: ${list}. Pick one with a \`/mode <name>\` line.`;
  await reply(item.repo, item.replyTo, text).catch((error) => log(`${where}: ${error}`));
}

// Runs that read the code and answer, without a branch or the repo's setup: brainstorms (and
// their wrap-up), onboarding, inbox entries and discussions.
const INBOX = new Set(["idea", "bug", "discussion"]);
const LIGHT = new Set(["brainstorm", "stop", "onboarding", ...INBOX]);

// Each inbox entry starts a fresh session (the inbox issue collects unrelated entries); a
// discussion keeps its own, like a brainstorm.
const FRESH = new Set(["idea", "bug"]);

// Any other mode is one of the repo's own.
const BUILT_IN = new Set(["work", "brainstorm", "stop", "onboarding", ...INBOX]);

// The repo's own modes (its config's `modes:`, customMode()) add theirs to both.
function isLight(task, mode) {
  return LIGHT.has(mode) || !!customMode(task.settings, mode)?.light;
}

function isFresh(task, mode) {
  return FRESH.has(mode) || !!customMode(task.settings, mode)?.fresh;
}

// A light run is what the task's next run will be: it goes first, after a shorter pause.
function talking(task) {
  return isLight(task, task.pending.at(-1)?.mode);
}

// What the dashboard shows a run or queued task as.
function kindOf(mode, kind) {
  return mode === "brainstorm" || mode === "stop" ? "brainstorm" : INBOX.has(mode) ? mode : kind;
}

function debounce(task) {
  return talking(task) ? config.brainstormDebounceMs : config.debounceMs;
}

// How many of the pending comments, from the first, the running session can take: those in
// its own mode. A wrap-up or a switch between work and brainstorm needs its own prompt, so it
// and everything after it (order is kept) wait for the next run.
function deliverable(task) {
  const live = task.live;
  if (!live?.open || live.mode === "stop") return 0;
  const n = task.pending.findIndex((i) => i.mode !== live.mode);
  return n < 0 ? task.pending.length : n;
}

// Sends the comments the running session can take as one message; false when none went.
function deliver(task) {
  if (stopping) return false; // what waits is saved for the next listener
  const live = task.live;
  const items = task.pending.splice(0, deliverable(task));
  if (!items.length) return false;
  const options = {};
  const text = items
    .map((i) => takeOptions(i.text, options))
    .filter(Boolean)
    .join("\n\n---\n\n");
  // The process is already running with its model and effort: they are for the next run.
  Object.assign(task.next, options);
  Object.assign(live.later, options);
  live.replyTo = items.at(-1).replyTo;
  live.handled.push(...items);
  log(`${live.key}: delivered ${items.length} comment(s) to the running session`);
  live.record.delivered = (live.record.delivered ?? 0) + items.length;
  // Only "/model …" lines: nothing to tell Claude.
  if (!text) {
    saveLive(task);
    return false;
  }
  runner.send(live.id, liveMessage(live.mode, text));
  const at = Date.now();
  live.logFile.write(
    JSON.stringify({
      type: "listener",
      event: "delivered",
      at,
      message: text,
    }) + "\n",
  );
  live.unanswered.push(...items);
  saveLive(task);
  return true;
}

// What Claude reads for comments delivered mid-run (the CLI adds that the user sent it while
// Claude was working).
function liveMessage(mode, text) {
  const reply =
    "Your final message is still posted as the single reply for this run: make it cover this comment too. (Don't post comments on GitHub yourself.)";
  if (mode === "brainstorm") {
    return `New comment on the issue: ${text}\n\n(Still a brainstorm: no code, branch, commit, pull request or new issue. ${reply})`;
  }
  if (FRESH.has(mode)) {
    return `Another entry arrived on the inbox while you were working:\n\n${text}\n\nHandle it like the others, as its own entry. ${reply}`;
  }
  if (mode === "discussion") return `New comment in the discussion:\n\n${text}\n\n${reply}`;
  if (mode === "onboarding") {
    return `New comment on the issue: ${text}\n\n(Still onboarding: no code, branch, commit, pull request or new issue. ${reply})`;
  }
  return `New comment on this issue while you are working:\n\n${text}\n\nTake it into account from here on. ${reply}`;
}

function schedule() {
  if (stopping) return;
  // Brainstorms first: someone is waiting for the reply, work runs take minutes anyway.
  const ready = [...tasks.values()]
    .filter((t) => t.ready && !t.running && t.pending.length)
    .sort((a, b) => Number(talking(b)) - Number(talking(a)));
  const perRepo = new Map();
  for (const t of tasks.values()) {
    if (t.running) perRepo.set(t.repo, (perRepo.get(t.repo) ?? 0) + 1);
  }
  for (const task of startable(ready, perRepo, running, config.maxParallel)) run(task);
}

// --- Brainstorms: each issue's discussion state, kept across listener restarts -------------

const brainstormsPath = join(config.dataDir, "brainstorms.json");
// Claude's reply keeps a brainstorm active at least this long, so an answer can follow it.
const REPLY_GRACE_MS = 2 * 60000;
const brainstorms = loadBrainstorms(); // key → { repo, number, status, deadline, timer }

function loadBrainstorms() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(brainstormsPath, "utf8"));
  } catch {
    // None yet.
  }
  const map = new Map(Object.entries(saved).map(([key, b]) => [key, { ...b, timer: null }]));
  for (const [key, b] of map) if (b.status === "active") armIdle(key, b);
  return map;
}

function saveBrainstorms() {
  const plain = Object.fromEntries([...brainstorms].map(([key, { timer, ...b }]) => [key, b]));
  writeFileSync(brainstormsPath, JSON.stringify(plain, null, 2));
}

// "active" → "idle" once the deadline passes with no comment. One container per reply means
// nothing is held open meanwhile: idle is what the dashboard shows, and the next comment
// restores the session from its volume and says so to Claude.
function armIdle(key, b) {
  clearTimeout(b.timer);
  b.timer = setTimeout(
    () => {
      const task = tasks.get(key);
      // A reply still on its way: posting it arms the timer again.
      if (task?.running || task?.pending.length || b.status !== "active") return;
      b.status = "idle";
      saveBrainstorms();
      log(`${key}: brainstorm idle`);
    },
    Math.max(0, b.deadline - Date.now()),
  );
}

// --- Repo modes: the issues whose session is in one of their repo's own modes -------------

// key → mode name, kept across listener restarts: a comment without a trigger or "/mode"
// line goes on in that mode (modeOf()). Fresh modes don't change it; work, a brainstorm or
// another "/mode" do.
const issueModesPath = join(config.dataDir, "modes.json");
const issueModes = loadIssueModes();

function loadIssueModes() {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(issueModesPath, "utf8"))));
  } catch {
    return new Map(); // None yet.
  }
}

function setIssueMode(key, mode) {
  if ((issueModes.get(key) ?? null) === mode) return;
  if (mode) issueModes.set(key, mode);
  else issueModes.delete(key);
  writeFileSync(issueModesPath, JSON.stringify(Object.fromEntries(issueModes), null, 2));
}

// --- Prompts -------------------------------------------------------------------------------

const instructions = (name) => readFileSync(new URL(`../prompts/${name}`, import.meta.url), "utf8");
const brainstormInstructions = instructions("brainstorm.md");
const onboardingInstructions = instructions("onboarding.md");
// The config's reference, in the image next to the prompts so the two can't drift apart.
const configReference = readFileSync(new URL("../docs/repo-config.md", import.meta.url), "utf8");
const inboxInstructions = {
  idea: instructions("idea.md"),
  bug: instructions("bug.md"),
  discussion: instructions("discussion.md"),
};

// Inbox entries and discussions: the entries come with the prompt, as the session is new.
function inboxPrompt(task, mode, text) {
  const { repo, number } = task;
  const where = {
    idea: `the ideas inbox of ${repo} (issue #${number})`,
    bug: `the bug reports inbox of ${repo} (issue #${number})`,
    discussion: `discussion #${number} of ${repo}`,
  }[mode];
  const read =
    mode === "discussion"
      ? `Read the whole discussion with:

\`\`\`sh
gh api graphql -F owner=${repo.split("/")[0]} -F name=${repo.split("/")[1]} -F number=${number} -f query='
  query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
    discussion(number: $number) { title body url author { login } comments(last: 50) { nodes {
      author { login } body url replies(last: 50) { nodes { author { login } body url } } } } } } }'
\`\`\``
      : `The latest comments of the inbox give the context of a follow-up:
\`gh issue view ${number} --comments\`.`;
  return `New on ${where}. ${read}

${inboxInstructions[mode]}

${mode === "discussion" ? "The message" : "The entries, each its own"}:

${text}`;
}

function brainstormPrompt(task) {
  return `Brainstorm GitHub issue #${task.number} of ${task.repo} with the maintainer. Read it with
\`gh issue view ${task.number} --comments\`.

${brainstormInstructions}`;
}

// Onboarding: its instructions, what this Deckhand allows the repo (a config can only narrow
// it, the operator's grants widen it), and the config's reference.
function onboardingPrompt(task, settings) {
  const { repo, number } = task;
  const grant = grantFor(loadGrants(config), config, repo);
  const none = (items) => (items.length ? items.map((i) => `\`${i}\``).join(", ") : "none");
  const roots = grant.mounts.map((m) => `${m.root}${m.readOnly === false ? " (read-write)" : ""}`);
  return `Onboard ${repo} with the maintainer, on GitHub issue #${number}. Read it with
\`gh issue view ${number} --comments\`.

${onboardingInstructions}

## This Deckhand

- Trigger (confirms the proposal, alone on the first line of a comment): \`${triggerWord(settings.trigger)}\`
- Users who may start runs (\`ALLOWED_USERS\`; \`users\` can only narrow it): ${none(config.users)}
- Hosts every sandbox reaches: ${none(mandatoryHosts(config))}, and the operator's \`ALLOWED_HOSTS\`: ${none(config.hosts)}
- Hosts the operator grants this repository: ${none(grant.hosts)}
- Host mount roots granted to this repository: ${roots.length ? none(roots) : "none: a \`mounts\` entry would be refused until the operator grants a root"}
- Models: work \`${settings.model}\` (${settings.effort} effort), brainstorms \`${settings.brainstormModel}\` (${settings.brainstormEffort})

## Reference: \`.deckhand.yaml\` (docs/repo-config.md)

${configReference}`;
}

// The run the trigger line starts on an onboarding issue: the agreed files, nothing else.
function onboardingWorkPrompt(task) {
  const n = task.number;
  const base = task.base || "main";
  return `The maintainer confirmed the onboarding proposal on GitHub issue #${n} of ${task.repo}
(\`gh issue view ${n} --comments\` has the conversation). Open the pull request:
1. The sandbox has already checked out the issue's branch, pushed it and opened a draft pull
   request (\`Closes #${n}\`; \`gh pr view\` shows it). If you are still on ${base}, create a
   branch from ${base} named \`issue-${n}-deckhand-config\` and push it.
2. If the maintainer agreed to inbox issues, create them now (\`gh issue create\`) and put
   their numbers in \`inbox\`. Create none they didn't agree to.
3. Write only the agreed files (\`.deckhand.yaml\`, and the Dockerfile and instructions file
   if they were part of it), exactly as last proposed with the changes agreed since. Change
   nothing else in the repository.
4. Commit, push, then update the pull request with \`gh pr edit\`: title "Set up Deckhand", a
   description with \`Closes #${n}\` and a line per file, and mark it ready with
   \`gh pr ready\`.
Never push to ${base}. The listener checks the branch's \`.deckhand.yaml\` once you are done
and adds the result to your reply.
Don't post comments on GitHub yourself: your final message is posted for you as a reply, so
end with a short summary (the pull request link, the files, the inbox issues created).`;
}

// What Claude reads for a brainstorm run, besides the comments themselves.
function brainstormMessage(mode, text, restored) {
  if (mode === "stop") {
    return `The maintainer ends the brainstorm here${text ? `, adding:\n\n${text}\n\n` : ". "}Wrap up as in step 4 of your instructions: post the summary and update the issue's description with what was decided.`;
  }
  return restored
    ? `${text}\n\n(The brainstorm resumes after a pause: check the issue for comments you haven't seen.)`
    : text;
}

function initialPrompt(task) {
  const base = task.base || "main";
  const common = `Follow the repository's AGENTS.md and CLAUDE.md if it has them, with tests where the
code has them, and run the checks they list before pushing. Never push to ${base}. When
something is ambiguous, pick the reasonable option and say so rather than stopping, unless it
is a blocker only the maintainer can resolve: then push your work in progress and end with
your questions (see "Stopping to ask" in CLAUDE.md).
Don't post comments on GitHub yourself: your final message is posted for you as a reply, so
end with a short summary (what you did, the pull request link, anything left open).`;
  if (task.kind === "pr") {
    return `Work on pull request #${task.number} of ${task.repo}: check it out with
\`gh pr checkout ${task.number}\`, read it with \`gh pr view ${task.number} --comments\`, do what
is asked below, and push to the same branch.
${common}`;
  }
  return `Work on GitHub issue #${task.number} of ${task.repo} until it is ready for review.
1. Read it with \`gh issue view ${task.number} --comments\`.
2. The sandbox has already checked out the issue's branch, pushed it and opened a draft pull
   request (\`Closes #${task.number}\`; \`gh pr view\` shows it): work on that branch. If you
   are still on ${base}, it couldn't: create a branch from ${base} named
   \`issue-${task.number}-<short-slug>\` and push it, and the draft pull request is opened for
   you.
3. Implement it, pushing to the same branch as you go.
4. When the checks pass, update the pull request with \`gh pr edit\`: final title, and a
   description with \`Closes #${task.number}\`, what changed and why, any choice you made, and
   screenshots if the UI changed (see "Screenshots" in CLAUDE.md). Then mark it ready for
   review with \`gh pr ready\`.
${common}`;
}

// A run in one of the repo's own modes: its instructions (`instructions`, the file's text
// from the default branch) after what every run of that kind is told. CLAUDE.md has the
// generic rules, as for work.
function modePrompt(task, own, instructions) {
  const { number: n, repo } = task;
  const base = task.base || "main";
  const where =
    task.kind === "pr"
      ? `pull request #${n} of ${repo}. Read it with \`gh pr view ${n} --comments\` and \`gh pr diff ${n}\``
      : `GitHub issue #${n} of ${repo}. Read it with \`gh issue view ${n} --comments\`, and its pull
request if it has one (\`gh pr list --state all --search ${n}\`)`;
  const rules = own.light
    ? `This mode only comments: never write or edit code, create a branch, commit, push, open a
pull request or create issues (your GitHub token can only read). The clone in /workspace is
set up for reading, not running: the project's setup was skipped. The base branch was
fetched from \`origin\` at the start of this run.`
    : task.kind === "pr"
      ? `Check the pull request out with \`gh pr checkout ${n}\` if you change code, and push to its
branch. Never push to ${base}.`
      : `The sandbox has already checked out the issue's branch, pushed it and opened a draft pull
request (\`gh pr view\` shows it): if you change code, commit and push to that branch. Never
push to ${base}.`;
  return `You are in the "${own.name}" mode of this repository, on ${where}.

${rules}
Don't post comments on GitHub yourself: your final message is posted for you as the reply.

The ${own.name} mode's instructions, from the repository:

${instructions.trim()}`;
}

// The instructions file of the repo's mode, from its default branch like the config.
async function modeInstructions(task, own) {
  const base = task.base || "main";
  const missing = `Claude can't run here: the \`${own.name}\` mode's instructions, \`${own.instructions}\`, are not on \`${base}\`.`;
  let file;
  try {
    file = await repoFile(task.repo, own.instructions, base);
  } catch (error) {
    throw new RunError(`${missing}\n\n${error.message}`);
  }
  if (!file) throw new RunError(missing);
  return file.text;
}

// --- Runs ----------------------------------------------------------------------------------

// A discussion run answers through GraphQL: its token needs Discussions too. Onboarding and
// a light run in one of the repo's own modes only comment: their token only reads.
function permissionsFor(mode, light) {
  if (mode === "discussion") return DISCUSSION_PERMISSIONS;
  // Onboarding proposes: nothing is pushed or created before the trigger line.
  if (mode === "onboarding") return READ_ONLY_PERMISSIONS;
  return light && !LIGHT.has(mode) ? READ_ONLY_PERMISSIONS : undefined;
}

// Sandboxes are started, followed and removed through the runner (runner/docker.mjs). They
// run detached, so they outlive a listener restart: the next listener picks them up
// (restoreRuns()).
const runsDir = join(config.dataDir, "runs");
mkdirSync(runsDir, { recursive: true });
const runner = createDockerRunner({ config, docker, inboxDir: runsDir, log });

// Set on SIGTERM: no run starts any more, what waits is saved for the next listener.
let stopping = false;

// Appended synchronously, so a line counted as read (live.lines) is on disk.
function openLog(path) {
  return { write: (text) => appendFileSync(path, text) };
}

async function run(task) {
  task.running = true;
  task.ready = false;
  running++;
  const items = task.pending.splice(0);
  const replyTo = items.at(-1).replyTo;
  // The last comment decides: a work trigger after a brainstorm comment means work.
  const mode = items.at(-1).mode;
  const talk = mode === "brainstorm" || mode === "stop";
  const light = isLight(task, mode);
  const key = `${task.repo}#${task.id}`;
  const id = `${task.name}-${Date.now()}`;
  const logPath = join(logDir, `${id}.log`);
  const record = {
    id,
    key,
    kind: kindOf(mode, task.kind),
    // work, brainstorm, idea, bug, discussion or one of the repo's own modes.
    taskMode: mode === "stop" ? "brainstorm" : mode,
    repo: task.repo,
    title: titles.get(key),
    replyTo,
    mode: null,
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    logPath,
  };
  runs.unshift(record);
  // Where comments that arrive during the run go (deliver()), and what a listener that
  // restarts meanwhile needs to carry on with it (saveLive()).
  task.live = {
    id,
    key,
    mode,
    talk,
    light,
    record,
    logFile: openLog(logPath),
    // The sandbox's only way to GitHub: tokens for this repo, while this run lasts.
    secret: broker.register(task.repo, permissionsFor(mode, light)),
    asked: replyTo, // where errors go
    replyTo, // where the reply goes: the issue or pull request of the last comment it took
    open: false, // whether its inbox takes comments
    replied: false,
    // What the egress proxy lets it reach (egressAnswer()), and its address once known.
    hosts: null,
    ip: null,
    shots: null,
    lines: { out: 0, err: 0 }, // of its output read so far, so a restart skips them
    result: null, // its last result, with the duration of all
    later: {}, // "/model" and "/effort" that came too late for this run
    unanswered: [], // delivered since Claude's last result
    handled: [...items], // its comments and those delivered to it, for their reactions
    saving: null,
  };
  saveLive(task);
  try {
    if (!(await start(task, items))) return;
  } catch (error) {
    return end(task, error);
  }
  await follow(task);
}

// Everything up to the sandbox's start; false when the listener is stopping meanwhile (the
// next one queues these comments again).
async function start(task, items) {
  const { live } = task;
  const { key, mode, talk, light, record, logFile } = live;
  // Left over from a listener that lost track of it: wait for it, then make room.
  const leftover = await runner.state(task.name);
  if (leftover === "running") await runner.wait(task.name);
  if (leftover) await runner.remove(task.name);
  // Inbox entries start afresh: the sandbox doesn't resume their session (entrypoint.sh).
  const started = !isFresh(task, mode) && (await runner.hasSession(task.name));
  // A new comment answers the questions, if any: the issue no longer waits for input.
  if (config.needsInputLabel && task.kind !== "discussion") {
    await label(task.repo, task.number, false);
  }
  // "/model" and "/effort" sent during the previous run, unless these comments say otherwise.
  const options = task.next;
  task.next = {};
  const text = items
    .map((i) => takeOptions(i.text, options))
    .filter(Boolean)
    .join("\n\n---\n\n");
  const restored = items.some((i) => i.restored);
  const body = talk ? brainstormMessage(mode, text, restored) : text;
  // An empty follow-up (only "/model …", say) would open an interactive session instead.
  // A new inbox session reads its entries in the prompt (inboxPrompt()).
  const message = started
    ? `${body || "Continue."}\n\n(Don't post comments on GitHub yourself: your final message is posted as a reply.)`
    : INBOX.has(mode)
      ? ""
      : body;
  // Fresh from the default branch: a config merged since the comment applies.
  const { settings, errors, warnings } = await repoSettings(task.repo, task.base);
  task.settings = settings;
  const own = customMode(settings, mode);
  const defaults = own
    ? [own.model, own.effort]
    : light
      ? [settings.brainstormModel, settings.brainstormEffort]
      : [settings.model, settings.effort];
  record.model = options.model ?? defaults[0];
  record.effort = options.effort ?? defaults[1];
  record.mode = mode === "stop" ? "wrap-up" : restored ? "restore" : started ? "continue" : "start";
  log(
    `${key}: running ${task.name} (${mode}, ${record.mode}, ${record.model}/${record.effort}), log ${record.logPath}`,
  );
  // First line of every log: what the dashboard needs to list it after a restart.
  const { logPath: _, ...meta } = record;
  logFile.write(JSON.stringify({ type: "listener", ...meta, message: text }) + "\n");
  const note = (message) =>
    logFile.write(
      JSON.stringify({ type: "listener", event: "note", at: Date.now(), message }) + "\n",
    );
  if (errors.length) throw new RunError(configErrors(task.base, errors));
  for (const warning of warnings) note(`${CONFIG_FILE}: ${warning}`);
  if (!own && !BUILT_IN.has(mode)) {
    throw new RunError(
      `Claude can't run here: the \`${mode}\` mode is no longer in \`${CONFIG_FILE}\` on \`${task.base || "main"}\`.`,
    );
  }
  const ownInstructions = own && (await modeInstructions(task, own));
  const access = grantedAccess(task.repo, settings, note);
  const prepared = await prepare(task, items, settings, record, note, logFile);

  // A fresh, unguessable folder per run: its screenshots are public once linked on GitHub.
  const shots = randomBytes(12).toString("hex");
  mkdirSync(join(shotsDir, shots), { recursive: true });
  chmodSync(join(shotsDir, shots), 0o777); // the sandbox runs as uid 1000
  live.shots = shots;
  live.hosts = access.hosts;
  if (stopping) return false;
  const prompt = talk
    ? brainstormPrompt(task)
    : INBOX.has(mode)
      ? inboxPrompt(task, mode, text)
      : mode === "onboarding"
        ? onboardingPrompt(task, settings)
        : own
          ? modePrompt(task, own, ownInstructions)
          : onboardingWork(task)
            ? onboardingWorkPrompt(task)
            : initialPrompt(task);
  await runner.start(sandboxSpec(task, prompt, message, { ...prepared, ...access }));
  // Written before Claude starts (setup takes a while), a message waits in the inbox.
  live.open = true;
  saveLive(task);
  return true;
}

// What the operator grants the repo, with its config's requests: the hosts its sandbox may
// reach, its host mounts (refused ones stop the run, and the reply lists them) and limits.
function grantedAccess(repo, settings, note) {
  let grant;
  try {
    grant = grantFor(loadGrants(config), config, repo);
  } catch (error) {
    log(`${repo}: ${error.message}`);
    throw new RunError(
      "Claude can't run here: the operator's grants file has errors (see the listener's logs).",
    );
  }
  const { mounts, refused, notes } = resolveMounts(settings.mounts, grant, {
    caches: settings.caches,
  });
  if (refused.length) {
    throw new RunError(
      `Claude can't run here: host mounts requested by \`${CONFIG_FILE}\` are refused.\n\n${refused.map((r) => `- ${r}`).join("\n")}\n\nOnly paths under a root the operator grants this repository can be mounted.`,
    );
  }
  for (const text of notes) note(text);
  for (const m of mounts) note(`Host mount ${m.target}${m.readOnly ? " (read-only)" : ""}`);
  return { hosts: runHosts(config, grant, settings), mounts, limits: grant.limits };
}

// The run's image (built first if the repo's Dockerfile changed), Claude Code and the repo's
// cache volumes. While an image builds, the dashboard shows the run as "building image".
async function prepare(task, items, settings, record, note, logFile) {
  const base = task.base || "main";
  const output = (chunk) => logFile.write(chunk);
  try {
    await runner.checkNetwork();
    // A comment on a pull request may run on the image of its own branch (imageRef()).
    const pr = items.at(-1).replyTo;
    let source = { ref: base, branch: false };
    if (
      settings.allowBranchDockerImages &&
      settings.dockerfile &&
      (task.kind === "pr" || pr !== task.number)
    ) {
      const res = await github(task.repo, "GET", `/repos/${task.repo}/pulls/${pr}`);
      if (res.ok) source = imageRef(settings, task.repo, base, await res.json());
    }
    const image = await images.imageFor({
      repo: task.repo,
      ref: source.ref,
      dockerfile: settings.dockerfile,
      onBuild: (tag) => {
        record.phase = "building image";
        note(
          `Building ${tag} from ${settings.dockerfile} (${source.branch ? "pull request branch" : base})`,
        );
      },
      output,
    });
    record.phase = null;
    if (image !== config.image)
      note(`Image ${image}${source.branch ? " (pull request branch)" : ""}`);
    await images.installClaudeCode(output);
    const cacheArgs = await images.caches(task.repo, settings.caches, image);
    return { image, cacheArgs, settings };
  } catch (error) {
    throw new RunError(
      `Claude couldn't start: ${error.message}\n\nThe run's log on the dashboard has the details.`,
    );
  }
}

// What the runner starts: the sandbox's image, environment, volumes and limits. Claude's
// first message is TASK_PROMPT (and TASK_MESSAGE); comments that arrive during the run reach
// it through its inbox (deliver()).
function sandboxSpec(task, prompt, message, { image, cacheArgs, settings, mounts, limits }) {
  const { live } = task;
  const mode = live.mode === "stop" ? "brainstorm" : live.mode;
  const { light } = live;
  const n = task.name;
  const bot = app.identity();
  // Values reach the container by name only: they never show in `ps`. The App's credentials
  // are not among them: they stay in the data volume.
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DECKHAND_RUN_SECRET: live.secret,
    DECKHAND_BROKER_URL: config.brokerUrl,
    CLAUDE_CODE_VERSION: config.claudeCodeVersion,
    GIT_AUTHOR_NAME: bot.name,
    GIT_AUTHOR_EMAIL: bot.email,
    GIT_COMMITTER_NAME: bot.name,
    GIT_COMMITTER_EMAIL: bot.email,
    REPO_URL: `${config.githubUrl}/${task.repo}.git`,
    BASE_BRANCH: task.base || "main",
    TASK_PROMPT: prompt,
    TASK_MESSAGE: message,
    // work, brainstorm, idea, bug, discussion or one of the repo's own modes.
    TASK_MODE: mode,
    // A new session each time, which doesn't replace the issue's (inbox entries, fresh modes).
    TASK_SESSION: isFresh(task, mode) ? "fresh" : "",
    // Comments as stream-json messages (the runner's inbox), raw stream-json out.
    TASK_INPUT: "stream",
    TASK_OUTPUT: "json",
    // The sandbox opens the issue's branch and draft pull request (../sandbox/draft-pr.sh);
    // not for pull requests without an issue.
    TASK_ISSUE: task.kind === "issue" && !light ? String(task.number) : "",
    // Reading and answering needs no project setup.
    SANDBOX_LIGHT: light ? "1" : "",
    SANDBOX_SETUP: light ? "" : (settings.setup ?? ""),
    // Read by the sandbox from its default branch (origin/BASE_BRANCH), like the config.
    SANDBOX_INSTRUCTIONS: settings.instructions ?? "",
    SANDBOX_MODEL: live.record.model,
    SANDBOX_EFFORT: live.record.effort,
    SCREENSHOT_DIR: "/screenshots",
    SCREENSHOT_URL: `${publicUrl()}/shots/${live.shots}`,
    ...proxyEnv(config),
  };
  const args = [
    "--network",
    config.network,
    ...hardeningArgs(limits),
    // Its own folder of the screenshots volume only: no run sees another's.
    "--mount",
    `type=volume,src=${config.shotsVolume},dst=/screenshots,volume-subpath=${live.shots}`,
    // Claude Code, installed by the first run that needs this version (../sandbox/entrypoint.sh).
    ...["-v", `${config.claudeCodeVolume}:/opt/claude-code`],
    // The issue's clone and Claude session, kept between its runs.
    ...["-v", `${n}-workspace:/workspace`],
    ...["-v", `${n}-claude:/home/node/.claude`],
    // The repo's caches (its config's `caches`), one volume per path, kept across its runs.
    ...cacheArgs,
    // Host paths the operator grants the repo and its config asks for (grantedAccess()).
    ...mountArgs(mounts),
  ];
  return { run: live.id, name: n, image, labels: { "deckhand.task": live.key }, env, args };
}

// Reads the sandbox's output until it exits. At each result Claude gives, the comments
// waiting for it go to its inbox, or the inbox closes so Claude exits; a message written
// before the close is still answered (one more result), so nothing delivered is dropped.
// Also how a restarted listener picks a run up: what it already read is skipped.
async function follow(task) {
  const live = task.live;
  try {
    for (;;) {
      await runner.follow(task.name, {
        skip: { ...live.lines },
        onOut: (line) => output(task, line),
        // Setup output (clone, install) before Claude starts.
        onErr: (line) => {
          if (stopping) return; // left for the next listener
          live.logFile.write(line + "\n");
          live.lines.err++;
        },
      });
      if (stopping || (await runner.state(task.name)) !== "running") break;
      // The output stopped while the sandbox runs on (the daemon restarted, say): follow again.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    return end(task, error);
  }
  if (!stopping) await end(task);
}

function output(task, line) {
  const live = task.live;
  if (stopping) return; // left for the next listener
  live.logFile.write(line + "\n");
  live.lines.out++;
  const event = parse(line);
  if (event?.type !== "result") return;
  // One result per turn: a comment answered after the first adds a turn.
  live.result = {
    ...event,
    duration_ms: (live.result?.duration_ms ?? 0) + event.duration_ms,
  };
  live.unanswered = [];
  // Comments still in their pause go now, rather than to a new container.
  clearTimeout(task.timer);
  if (!deliver(task)) close(task);
  saveLive(task);
}

// No more comments for this run: Claude exits once it has answered.
function close(task) {
  const live = task.live;
  if (!live.open) return;
  live.open = false;
  runner.close(live.id);
}

// Ends under way: a listener that stops lets them post their reply first, so the next one
// doesn't post it again.
const ending = new Set();

function end(task, error = null) {
  const done = finish(task, error);
  ending.add(done);
  done.finally(() => ending.delete(done));
  return done;
}

// Once the sandbox exited (or couldn't start): the reply, reactions and label, then the next
// run for comments that came too late for this one.
async function finish(task, error) {
  const live = task.live;
  const { key, mode, talk, light, record } = live;
  live.open = false;
  // The comment answered last decides where the reply goes (a discussion's thread).
  const target = (replyTo) => ({ ...task, replyTo, comment: live.handled.at(-1)?.comment });
  try {
    if (error) throw error;
    const result = live.result;
    // Claude exited before answering a delivered comment (a crash): the next run gets it.
    if (live.unanswered.length) task.pending.unshift(...live.unanswered);
    const shots = live.shots && join(shotsDir, live.shots);
    if (shots && existsSync(shots) && !readdirSync(shots).length) rmdirSync(shots);
    const minutes = result ? Math.round(result.duration_ms / 6000) / 10 : null;
    // On a phone, the reply is where the next step is read.
    const hint =
      mode === "stop"
        ? " · 💬 brainstorm ended: a trigger line starts it again"
        : talk
          ? " · 💬 brainstorm: reply to continue, `/stop` to wrap up"
          : mode === "discussion"
            ? " · 💬 reply in this discussion to continue"
            : mode === "onboarding"
              ? ` · 💬 onboarding: reply to change the proposal, \`${triggerWord(task.settings?.trigger ?? config.trigger)}\` opens the pull request`
              : !BUILT_IN.has(mode) && !isFresh(task, mode)
                ? ` · ${mode} mode: replies go on in it, \`/mode work\` switches`
                : "";
    const later = Object.entries(live.later)
      .map(([k, v]) => `\`/${k} ${v}\``)
      .join(" ");
    const next = later ? ` · ${later} came mid-run: it applies to the next run` : "";
    const footer = `<sub>🤖 Claude ${record.model} · ${record.effort} effort${minutes !== null ? ` · ${minutes} min` : ""}${hint}${next}</sub>`;
    const status = outcome(result);
    // Once: a listener restarting from here on doesn't post it again.
    if (!live.replied) {
      const check = status !== "error" && mode === "work" ? await configCheck(task) : null;
      const text =
        status !== "error"
          ? `${result.result}\n\n${check ? `${check}\n\n` : ""}${footer}`
          : `Claude stopped with an error.\n\n> ${result?.result ?? "No result: see the listener logs."}\n\n${footer}`;
      await answer(target(live.replyTo), text);
      live.replied = true;
      saveLive(task);
      // Light runs ask questions all along: no label for those.
      if (status === "needs-input" && config.needsInputLabel && !light) {
        await label(task.repo, task.number, true);
      }
    }
    log(`${key}: done (${status})`);
    record.status = status;
    record.summary = summaryOf(result);
  } catch (error) {
    log(`${key}: ${error.stack ?? error}`);
    record.status = "error";
    if (error instanceof RunError && !live.replied) {
      await answer(target(live.asked), error.message).catch((e) => log(`${key}: ${e}`));
    }
  } finally {
    record.phase = null;
    broker.revoke(live.secret);
    record.finishedAt = Date.now();
    await runner.remove(task.name, live.id).catch((e) => log(`${key}: ${e}`));
    await live.saving;
    rmSync(livePath(live.id), { force: true });
    task.live = null;
    task.running = false;
    running--;
    // Comments put back for the next run keep their 👀 until that one is over. Light runs
    // ask questions all along, like for the label: their replies are "done".
    const status =
      !light || record.status === "error" ? record.status : mode === "stop" ? "stopped" : "ok";
    for (const item of live.handled) if (!task.pending.includes(item)) track(settle(item, status));
    const b = brainstorms.get(key);
    if (talk && b?.status === "active") {
      b.deadline = Math.max(b.deadline, Date.now() + REPLY_GRACE_MS);
      armIdle(key, b);
      saveBrainstorms();
    }
    // Comments the run could not take go out together, after the usual pause.
    if (task.pending.length) startLater(task);
    schedule();
  }
}

// A work run on an onboarding issue proposes a config for merging: what the listener makes of
// its branch's .deckhand.yaml goes with the reply.
function onboardingWork(task) {
  return task.kind === "issue" && onboarded.isIssue(task.repo, task.number);
}

async function configCheck(task) {
  if (!onboardingWork(task)) return null;
  try {
    return await branchConfigReport(github, config, task.repo, task.number);
  } catch (error) {
    log(`${task.repo}#${task.id}: checking the branch's config: ${error.stack ?? error}`);
    return `⚠️ The listener couldn't check the branch's \`${CONFIG_FILE}\`: ${error.message}`;
  }
}

// Starts the task's next run after the usual pause, so a burst of comments is one run.
function startLater(task) {
  clearTimeout(task.timer);
  task.ready = false;
  task.timer = setTimeout(() => {
    task.ready = true;
    schedule();
  }, debounce(task));
}
// --- Restarts: the queue and the runs a listener leaves to the next one -------------------

// Reaction updates still on their way to GitHub once a run is over (see end()).
const inflight = new Set();

function track(promise) {
  inflight.add(promise);
  promise.finally(() => inflight.delete(promise));
}

// Queued comments don't count: they are saved (saveQueue()), running sandboxes go on without
// the listener (restoreRuns()), and brainstorms between replies are restored from
// brainstorms.json and their volume. Nothing needs to drain before a restart.
function status() {
  const active = runs.filter((r) => r.status === "running");
  const reasons = [
    ...active.map((r) => `${r.kind} run ${r.key} since ${new Date(r.startedAt).toISOString()}`),
    ...(inflight.size ? [`${inflight.size} reaction update(s) in flight`] : []),
    // A preview hook may be deploying: a restart waits for it too.
    ...previews
      .status()
      .map(
        (h) =>
          `preview hook ${h.repo} (${h.event}) ${h.state} since ${new Date(h.since).toISOString()}`,
      ),
  ];
  return {
    version: VERSION,
    idle: running === 0 && !reasons.length,
    previews: previews.status(),
    reasons,
    setUp: app !== null,
    queued: [...tasks.values()].reduce((n, t) => n + t.pending.length, 0),
    now: Date.now(),
  };
}

// A comment as saved to disk: the id of its 👀 rather than the promise of it.
async function plain({ eyes, comment, ...item }) {
  return {
    ...item,
    comment: comment && {
      id: comment.id,
      html_url: comment.html_url,
      review: comment.review,
      node_id: comment.node_id,
      parent_id: comment.parent_id,
      discussion: comment.discussion,
    },
    eyes: (await eyes?.catch(() => null)) ?? null,
  };
}

function revive(item) {
  return { ...item, eyes: Promise.resolve(item.eyes) };
}

function pick({ repo, id, kind, number, name, base, discussionId, settings }) {
  return { repo, id, kind, number, name, base, discussionId, settings };
}

const queuePath = join(config.dataDir, "queue.json");

// Comments that wait for a run, with the 👀 they got, so the next listener runs them.
async function saveQueue() {
  const saved = [];
  for (const t of tasks.values()) {
    if (!t.pending.length && !Object.keys(t.next).length) continue;
    const pending = await Promise.all(t.pending.map(plain));
    saved.push({ ...pick(t), pending, next: t.next });
  }
  if (saved.length) writeFileSync(queuePath, JSON.stringify(saved, null, 2));
  log(`Saved ${saved.length} task(s) with queued comments`);
}

function loadQueue() {
  let saved = [];
  try {
    saved = JSON.parse(readFileSync(queuePath, "utf8"));
  } catch {
    return; // Nothing was waiting.
  }
  rmSync(queuePath, { force: true });
  for (const t of saved) {
    const key = `${t.repo}#${t.id}`;
    // Its run may have gone on through the restart (restoreRuns()).
    let task = tasks.get(key);
    if (!task) {
      task = { ...t, pending: [], running: false, ready: false, timer: null, live: null };
      tasks.set(key, task);
    }
    task.next = { ...t.next, ...task.next };
    task.pending.push(...t.pending.map(revive));
    if (!t.pending.length) continue;
    log(`${key}: ${t.pending.length} comment(s) queued before the restart`);
    if (!task.running) startLater(task);
    else task.timer = setTimeout(() => deliver(task), debounce(task));
  }
}

// What a listener needs to carry on with a run started by a previous one: written when it
// starts and whenever a comment reaches it, Claude answers or the reply is posted; removed
// once it is over. In order, each after the comments' 👀 are known.
const livePath = (id) => join(logDir, `${id}.live.json`);

function saveLive(task) {
  const live = task.live;
  const write = async () => {
    const { logPath, ...record } = live.record;
    const state = {
      task: pick(task),
      ...Object.fromEntries(
        ["id", "mode", "talk", "light", "secret", "asked", "replyTo", "replied", "hosts", "shots"]
          .concat(["lines", "result", "later"])
          .map((k) => [k, live[k]]),
      ),
      record,
      handled: await Promise.all(live.handled.map(plain)),
      // Delivered comments are among the handled ones.
      unanswered: live.unanswered.map((i) => live.handled.indexOf(i)),
    };
    const path = livePath(live.id);
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${path}.tmp`, path);
  };
  live.saving = (live.saving ?? Promise.resolve())
    .then(write)
    .catch((error) => log(`${live.key}: saving its state: ${error.stack ?? error}`));
  return live.saving;
}

// Runs a previous listener left behind, from their saved state: their tokens and egress work
// again at once, and comments find them. reattach() then follows their sandboxes.
function restoreRuns() {
  const restored = [];
  for (const file of readdirSync(logDir).filter((f) => f.endsWith(".live.json"))) {
    let saved;
    try {
      saved = JSON.parse(readFileSync(join(logDir, file), "utf8"));
    } catch {
      continue;
    }
    const key = `${saved.task.repo}#${saved.task.id}`;
    const logPath = join(logDir, `${saved.id}.log`);
    const record = { ...saved.record, logPath, status: "running", finishedAt: null };
    const known = runs.findIndex((r) => r.id === saved.id);
    if (known >= 0) runs[known] = record;
    else runs.unshift(record);
    let task = tasks.get(key);
    if (!task) {
      task = { ...saved.task, pending: [], ready: false, timer: null, next: {} };
      tasks.set(key, task);
    }
    const handled = saved.handled.map(revive);
    task.live = {
      ...saved,
      key,
      record,
      logFile: openLog(logPath),
      open: !runner.closed(saved.id),
      ip: null,
      handled,
      unanswered: saved.unanswered.map((i) => handled[i]).filter(Boolean),
      saving: null,
    };
    delete task.live.task;
    task.running = true;
    running++;
    broker.register(task.repo, permissionsFor(saved.mode, saved.light), saved.secret);
    restored.push(task);
  }
  return restored;
}

// Follows each restored run's sandbox to its end, as if the listener had never stopped. A
// run whose sandbox never started gives its comments back to the queue. Sandboxes nobody
// knows about any more are told to finish (their next run waits for them).
async function reattach(restored) {
  let sandboxes;
  // Not knowing isn't "none": that would remove sandboxes still at work.
  while (!sandboxes) {
    try {
      sandboxes = await runner.list();
    } catch (error) {
      log(`Listing the sandboxes (again in 5 s): ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  for (const task of restored) {
    const live = task.live;
    if (live.replied || sandboxes.some((s) => s.run === live.id)) {
      log(`${live.key}: picked up ${task.name} again`);
      follow(task);
      continue;
    }
    log(`${live.key}: its sandbox never started: its comments are queued again`);
    live.record.status = "interrupted";
    live.record.finishedAt = Date.now();
    broker.revoke(live.secret);
    await runner.remove(task.name, live.id);
    rmSync(livePath(live.id), { force: true });
    task.pending.unshift(...live.handled);
    task.live = null;
    task.running = false;
    running--;
    startLater(task);
  }
  for (const s of sandboxes) {
    if (restored.some((t) => t.live?.id === s.run || t.name === s.name)) continue;
    log(`${s.name}: no saved state for it: ${s.running ? "closing its input" : "removing it"}`);
    if (s.running) runner.close(s.run);
    else await runner.remove(s.name, s.run);
  }
}
// --- Runs and their logs, for the dashboard ------------------------------------------------

const runs = loadRuns(); // newest first
// Logs that have their title (newest first: the latest wins).
titles.seed(runs.map((r) => [r.key, r.title]));

// Rebuilds the list from the log files, so the dashboard survives a listener restart.
function loadRuns() {
  const files = readdirSync(logDir).filter((f) => f.endsWith(".log"));
  return files
    .map((file) => {
      const logPath = join(logDir, file);
      const lines = readFileSync(logPath, "utf8").split("\n");
      const meta = parse(lines[0])?.type === "listener" ? parse(lines[0]) : {};
      const result = lines.map(parse).findLast((e) => e?.type === "result");
      const id = file.slice(0, -4);
      return {
        id,
        key: meta.key ?? id.replace(/-\d+$/, ""),
        kind: meta.kind ?? null,
        title: meta.title ?? null,
        repo: meta.repo ?? null,
        replyTo: meta.replyTo ?? null,
        mode: meta.mode ?? null,
        taskMode: meta.taskMode ?? null,
        model: meta.model ?? null,
        effort: meta.effort ?? null,
        startedAt: meta.startedAt ?? Number(id.match(/-(\d+)$/)?.[1] ?? 0),
        finishedAt: statSync(logPath).mtimeMs,
        // Unfinished and not ours: the listener restarted during the run.
        status: result ? outcome(result) : "interrupted",
        summary: summaryOf(result),
        logPath,
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}

// The first line of a run's reply, for the dashboard: what the run ended with. Headings
// ("## Needs your input") say less than the sentence under them.
function summaryOf(result) {
  const lines = (result?.result ?? "").replace(NEEDS_INPUT, "").split("\n");
  const plain = (l) => l.replace(/^[#>*\s-]+/, "").trim();
  const line =
    plain(lines.find((l) => plain(l) && !/^\s*#/.test(l)) ?? "") || plain(lines.find(plain) ?? "");
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function clip(text, lines, chars) {
  const all = String(text).split("\n");
  let out = all.slice(0, lines).join("\n");
  if (out.length > chars) out = out.slice(0, chars);
  return out.length < String(text).length ? out + "\n…" : out;
}

const STARTING = {
  brainstorm: "Starting a brainstorm",
  idea: "New idea",
  bug: "New bug report",
  discussion: "Answering a discussion",
};

// One log line (stream-json, or setup output) → entries for the dashboard.
function format(line) {
  if (!line.trim()) return [];
  const e = parse(line);
  if (!e) return [{ kind: "raw", text: line }];
  if (e.type === "listener" && e.event === "note") return [{ kind: "meta", text: e.message }];
  if (e.type === "listener" && e.event === "delivered") {
    const time = new Date(e.at).toISOString().slice(11, 19);
    return [
      {
        kind: "meta",
        text: `New comment delivered to Claude at ${time} UTC: ${e.message}`,
      },
    ];
  }
  if (e.type === "listener") {
    const own = e.taskMode && e.taskMode !== "work" ? `Starting the ${e.taskMode} mode` : null;
    const what =
      ({
        "wrap-up": "Wrapping up the brainstorm",
        restore: "Restoring the session after a pause",
        continue: "Continuing the session",
      }[e.mode] ??
        STARTING[e.kind] ??
        own ??
        "Starting") + (e.model ? ` (${e.model}, ${e.effort} effort)` : "");
    return [{ kind: "meta", text: what + (e.message ? `: ${e.message}` : "") }];
  }
  if (e.type === "system" && e.subtype === "init") {
    return [{ kind: "meta", text: `Claude started (${e.model})` }];
  }
  if (e.type === "assistant") {
    return (e.message?.content ?? []).flatMap((c) => {
      if (c.type === "text") return [{ kind: "text", text: c.text }];
      if (c.type !== "tool_use") return [];
      const i = c.input ?? {};
      const detail =
        i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? i.prompt ?? i.query;
      const text = detail ?? (Object.keys(i).length ? JSON.stringify(i) : "");
      return [{ kind: "tool", name: c.name, text: clip(text, 6, 600) }];
    });
  }
  if (e.type === "user") {
    return (e.message?.content ?? [])
      .filter((c) => c.type === "tool_result")
      .map((c) => {
        const text = Array.isArray(c.content)
          ? c.content.map((p) => p.text ?? "").join("\n")
          : (c.content ?? "");
        return {
          kind: "output",
          error: !!c.is_error,
          text: clip(text, 40, 4000),
        };
      });
  }
  if (e.type === "result") {
    return [
      {
        kind: "result",
        status: outcome(e),
        text: e.result ?? "",
        minutes: Math.round((e.duration_ms ?? 0) / 6000) / 10,
      },
    ];
  }
  return [];
}

function publicRun(r) {
  const { logPath, ...rest } = r;
  return rest;
}

// What the dashboard shows `user`: each issue and pull request with its state (board.mjs).
function state(user) {
  // A running task's comments are queued only when they wait for a follow-up run: the others
  // are on their way to the live session.
  const queued = [...tasks.values()]
    .filter((t) => t.pending.length > (t.running ? deliverable(t) : 0))
    .map((t) => ({
      key: `${t.repo}#${t.id}`,
      kind: kindOf(t.pending.at(-1).mode, t.kind),
      mode: t.pending.at(-1).mode,
      repo: t.repo,
      replyTo: t.pending.at(-1).replyTo,
    }));
  const talks = [...brainstorms].map(([key, { timer, ...b }]) => ({ key, ...b }));
  const shown = board({ runs, queued, brainstorms: talks }).slice(0, 200);
  // Titles the listener doesn't have yet show on a later poll.
  if (app) {
    titles.fill(shown.map((t) => t.key));
    pulls.fill(shown.map((t) => t.key));
  }
  // `now`: the dashboard compares run start times with the server clock, not its own.
  return {
    user,
    tasks: shown.map((t) => ({
      ...t,
      title: titles.get(t.key),
      pr: pulls.get(t.key),
      runs: t.runs.map(publicRun),
    })),
    states: STATES,
    running,
    queued: queued.length,
    maxParallel: config.maxParallel,
    previews: previews.status(),
    // GitHub Enterprise: the dashboard's links go where the listener's do.
    githubUrl: config.githubUrl,
    now: Date.now(),
  };
}

// Server-sent events: the log so far, then new lines as they are written, until the run ends.
function stream(req, res, run) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  let offset = 0;
  let rest = "";
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const pump = () => {
    const size = statSync(run.logPath).size;
    if (size > offset) {
      const fd = openSync(run.logPath, "r");
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      closeSync(fd);
      offset = size;
      const lines = (rest + buffer.toString("utf8")).split("\n");
      rest = lines.pop();
      const entries = lines.flatMap(format);
      if (entries.length) send("entries", entries);
    }
    if (run.status !== "running") {
      if (rest) send("entries", format(rest));
      send("end", publicRun(run));
      return stop();
    }
  };
  const timer = setInterval(pump, 1000);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  const stop = () => {
    clearInterval(timer);
    clearInterval(keepAlive);
    res.end();
  };
  req.on("close", stop);
  pump();
}

// The dashboard's build (../dashboard/, `npm run build`), copied there by the image.
const dashboardDir = env.DASHBOARD_DIR || new URL("../dashboard/dist", import.meta.url).pathname;

// Health checks and scripts call from inside the container (docker compose exec).
function local(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

function trusted(req) {
  return local(req) || auth.user(req) !== null;
}

function sendJson(res, value) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

function serveDashboard(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (!app) {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    return res.end(
      "Deckhand listener: up, no GitHub App yet. Open the /setup link from the listener's logs.\n",
    );
  }
  const user = auth.user(req);
  if (!user) {
    if (url.pathname !== "/") return res.writeHead(401).end();
    return page(
      res,
      200,
      "Deckhand",
      `<p>Runs, brainstorms and their live logs, for this Deckhand's allowed users.</p>
<p><a class="button" href="/auth/login">Sign in with GitHub</a></p>`,
    );
  }
  if (serveAsset(res, dashboardDir, url.pathname)) return;
  res.setHeader("cache-control", "no-store");
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    return res
      .writeHead(503)
      .end(
        `Deckhand listener: the dashboard isn't built (${dashboardDir}): run npm run build in dashboard/.\n`,
      );
  }
  if (url.pathname === "/api/state") return sendJson(res, state(user));
  const match = /^\/api\/runs\/([\w.-]+)\/stream$/.exec(url.pathname);
  const run = match && runs.find((r) => r.id === match[1]);
  if (run) return stream(req, res, run);
  res.statusCode = 404;
  res.end();
}

const imageTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// Public, like any image in a GitHub comment; the folder token is the only protection.
function serveShot(req, res) {
  const match = /^\/shots\/([0-9a-f]{24})\/([\w.-]+\.(png|jpe?g|webp))$/.exec(req.url);
  const path = match && join(shotsDir, match[1], match[2]);
  try {
    if (!path || !statSync(path).isFile()) throw new Error();
  } catch {
    res.statusCode = 404;
    return res.end();
  }
  res.writeHead(200, {
    "content-type": imageTypes[match[3]],
    "cache-control": "public, max-age=31536000, immutable",
  });
  createReadStream(path).pipe(res);
}

// --- HTTP --------------------------------------------------------------------------------

// Comments on their way to the queue: a listener that stops saves them too.
const admitting = new Set();

function webhook(req, res) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (stopping) {
      // Failed on GitHub's side, where it can be redelivered, rather than lost.
      log("Rejected a delivery: stopping");
      res.statusCode = 503;
      return res.end("restarting");
    }
    if (!app) {
      log("Rejected a delivery: no GitHub App yet (open /setup)");
      res.statusCode = 503;
      return res.end("not set up");
    }
    if (!verified(app.credentials.webhook_secret, req.headers["x-hub-signature-256"], body)) {
      log("Rejected a delivery: bad signature (not from this listener's App)");
      res.statusCode = 401;
      return res.end("bad signature");
    }
    // Answer at once: GitHub gives up after 10 seconds, runs take minutes.
    res.statusCode = 202;
    res.end();
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return;
    }
    const event = req.headers["x-github-event"];
    log(`Delivery: ${event} ${payload.action ?? ""} from ${payload.sender?.login ?? "?"}`);
    app.remember(payload.repository?.full_name, payload.installation?.id);
    refreshFor(event, payload, repoList.refresh);
    // Only the repository list's: nothing runs on a push.
    if (event === "push") return;
    if (event === "installation" || event === "installation_repositories") {
      const added = [...(payload.repositories ?? []), ...(payload.repositories_added ?? [])];
      for (const r of added) app.remember(r.full_name, payload.installation?.id);
      const repos = onboardingTargets(config, event, payload, skip);
      if (!repos.length) return;
      const started = onboard(repos, payload.sender.login).catch((e) => log(e.stack ?? e));
      admitting.add(started);
      started.finally(() => admitting.delete(started));
      return;
    }
    const pr = pullRequest(config, event, payload, Date.now(), skip);
    if (pr && pulls.record(pr.key, pr.pr))
      log(`${pr.key}: pull request #${pr.pr.number} ${pr.pr.state}`);
    const preview = previewEvent(config, event, payload, skip);
    if (preview) {
      previewHook(preview, payload).catch((error) => log(error.stack ?? error));
      return;
    }
    // The operator's checks first, so only comments that may run cost a config read.
    const item = workItem(config, event, payload, skip);
    if (item) {
      item.base = payload.repository?.default_branch;
      const admitted = admit(item, event, payload).catch((error) => log(error.stack ?? error));
      admitting.add(admitted);
      admitted.finally(() => admitting.delete(admitted));
    }
  });
}

const web = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return res.end("ok");
  if (req.method === "GET" && req.url.startsWith("/shots/")) return serveShot(req, res);
  if (setup.handle(req, res)) return;
  if (auth.handle(req, res)) return;
  if (req.url === "/status") {
    if (!trusted(req)) return res.writeHead(401).end();
    return sendJson(res, status());
  }
  if (req.method === "POST" && req.url === "/webhook") return webhook(req, res);
  if (req.url.startsWith("/api/repos")) {
    if (!app) return res.writeHead(503).end();
    if (repoApi.handle(req, res, auth.user(req))) return;
  }
  // GitHub only ever POSTs to /webhook; everything a browser asks for is the dashboard.
  if (req.method === "GET") return serveDashboard(req, res);
  res.statusCode = 404;
  res.end();
}).listen(config.port, () => {
  // PORT=0 (the tests): the OS picks a free port, logged for whoever started the listener.
  config.port = web.address().port;
  log(`Listening on :${config.port}`);
});

// --- Egress: the proxy asks, for each connection, whether a sandbox may reach a host ------

// The running task whose sandbox has this address on the sandboxes' network. Addresses are
// looked up once per run, the first time its sandbox connects.
async function taskAt(ip) {
  for (const task of tasks.values()) {
    const live = task.live;
    if (!live?.hosts) continue;
    if (!live.ip) live.ip = await runner.address(task.name);
    if (task.live === live && live.ip?.includes(ip)) return task;
  }
  return null;
}

// Only the proxy may ask: it is the one that knows the connection's source address.
async function fromProxy(req) {
  const caller = req.socket.remoteAddress.replace(/^::ffff:/, "");
  const host = new URL(config.egressProxy).hostname;
  try {
    return (await lookup(host, { all: true })).some((a) => a.address === caller);
  } catch {
    return false;
  }
}

async function egressAnswer(req, res) {
  const url = new URL(req.url, "http://broker");
  const ip = url.searchParams.get("ip") ?? "";
  const host = url.searchParams.get("host") ?? "";
  if (!(await fromProxy(req))) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ allowed: false }));
  }
  const task = await taskAt(ip);
  const match = task ? matchHost(host, task.live.hosts) : null;
  if (!match) log(`Egress: refused ${host} for ${task ? `${task.repo}#${task.id}` : ip}`);
  sendJson(res, { allowed: !!match, private: !!match && match !== "any" });
}

// Sandboxes and the egress proxy only: compose.yaml doesn't publish this port.
const brokerServer = createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/egress?")) {
    return egressAnswer(req, res).catch((error) => {
      log(`Egress: ${error.stack ?? error}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  }
  broker.handle(req, res).catch((error) => {
    log(`Broker: ${error.stack ?? error}`);
    if (!res.headersSent) res.writeHead(500).end();
  });
}).listen(config.brokerPort, () => {
  // BROKER_PORT=0 (the tests): the OS picks a free port, and sandboxes are sent to that one.
  if (!config.brokerPort) {
    const url = new URL(config.brokerUrl);
    url.port = brokerServer.address().port;
    config.brokerUrl = url.href.replace(/\/$/, "");
  }
  config.brokerPort = brokerServer.address().port;
  log(`Token broker on :${config.brokerPort}`);
});

log(`Deckhand ${VERSION}`);
if (!app) log(`No GitHub App yet. Set it up at ${setup.link()}`);

// Before any request is served: runs still going since the previous listener, then what it
// left queued (comments for those runs are delivered to them).
const restored = restoreRuns();
loadQueue();
reattach(restored).catch((error) => log(`Re-attaching: ${error.stack ?? error}`));

// `docker compose up`, `restart` or an update stops the listener with SIGTERM, and kills it
// after the stop grace period. Sandboxes go on: no run starts any more, what is queued is
// saved with the 👀 ids, the runs' state is written, and the next listener carries on.
process.on("SIGTERM", () => {
  stopping = true;
  log("Stopping: running sandboxes go on, the next listener picks them up");
  // Replies being posted and comments being admitted first, then what they leave.
  Promise.allSettled([...ending, ...admitting])
    .then(saveQueue)
    .then(() => Promise.all([...tasks.values()].map((t) => t.live && saveLive(t))))
    .catch((error) => log(`Saving the queue: ${error.stack ?? error}`))
    .finally(() => process.exit(0));
});
