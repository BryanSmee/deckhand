// Deckhand's listener: receives the GitHub App's webhooks, runs Claude Code in a sandbox
// container (../sandbox/) for issue and pull request comments, one container and one set of
// volumes per issue, and posts Claude's final message back as a comment.
//
//   On an issue:   "Claude work on this" as the first line starts the work; the other lines
//                  are extra instructions. Once started, any comment continues the session.
//                  The sandbox opens the branch and draft pull request (../sandbox/draft-pr.sh).
//   On its PR:     any comment, review or review comment continues the same session.
//   Anywhere:      "/model sonnet" or "/effort high" lines pick the model or thinking effort
//                  for that run (defaults: SANDBOX_MODEL, SANDBOX_EFFORT).
//
// A comment that arrives while its issue's run is working goes to that run: after the usual
// pause (so a burst is one message), the listener writes it to Claude's stdin (stream-json
// input, TASK_INPUT=stream in ../sandbox/entrypoint.sh), and Claude sees it after its current
// tool call; the run's final message is still the one reply and covers it. "/model" and
// "/effort" cannot change a live process: they apply to the next run, and the reply says so.
// Comments the run cannot take (a trigger that switches between work and brainstorm, a
// wrap-up, or one arriving once Claude's input is closed) wait for a follow-up run.
//
// "Claude let's brainstorm this" (BRAINSTORM_TRIGGER) as the first line of an issue comment
// starts a brainstorm instead: Claude discusses the issue (../prompts/brainstorm.md) without
// writing code, and each later comment on the issue is the next message of that
// conversation. A brainstorm run starts light (SANDBOX_LIGHT) after a short pause
// (BRAINSTORM_DEBOUNCE_MS) and goes before queued work. "Claude stop" or "/stop" ends it:
// Claude posts a summary and updates the issue's description, then comments no longer reach
// it until a trigger line. After BRAINSTORM_IDLE_MINUTES (10) without a comment it shows as
// idle; a comment then restores it from the issue's session volume. "Claude work on this"
// afterwards implements in the same session, so the decisions carry over. Issues only.
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
// GET / is a dashboard of the runs with their live logs, behind DASHBOARD_PASSWORD; GET
// /status says whether the listener is idle. Comments still waiting for a run are saved to
// queue.json on SIGTERM and picked up at the next start.
//
// GET /shots/<token>/<file> serves the screenshots runs save for their pull requests: GitHub
// cannot take image uploads through its API, so they need a public URL.
//
// Each repo may bring a .deckhand.yaml on its default branch (repo-config.mjs): its own
// trigger lines, models, parallel cap and users (only narrowing the operator's), a setup
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
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  rmdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createBroker } from "./broker.mjs";
import { checkout } from "./checkout.mjs";
import { ConfigError, loadConfig } from "./config.mjs";
import { docker } from "./docker.mjs";
import { matchHost, proxyEnv, runHosts } from "./egress.mjs";
import { MARKER, previewEvent, takeOptions, verified, workItem } from "./events.mjs";
import { createGitHubApp, loadCredentials, saveCredentials } from "./github-app.mjs";
import { grantFor, hardeningArgs, loadGrants, mountArgs, resolveMounts } from "./grants.mjs";
import { createImages, imageRef } from "./images.mjs";
import { createPreviews } from "./previews.mjs";
import {
  CONFIG_FILE,
  effectiveConfig,
  loadRepoSettings,
  readRepoFile,
  startable,
} from "./repo-config.mjs";
import { createSetup } from "./setup.mjs";

const env = process.env;
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

// PUBLIC_URL, or the one /setup stored with the App.
function publicUrl() {
  return config.publicUrl ?? app?.credentials.public_url ?? `http://localhost:${config.port}`;
}

// `expected`: error statuses that are normal for this call, so not logged.
async function github(repo, method, path, body, expected = []) {
  if (!app) throw new Error("the GitHub App is not set up");
  return app.request(repo, method, path, body, expected);
}

// GitHub's reactions have no ✅: 🚀 reads as "shipped" and isn't mistaken for a manual 👍.
// A wrap-up ("/stop") only loses its 👀.
const REACTIONS = {
  ok: "rocket",
  "needs-input": "confused",
  error: "-1",
  stopped: null,
};

// Reaction failures (already removed, 403, 404…) are logged and never break a run.
async function react(repo, comment, content) {
  const kind = comment.review ? "pulls/comments" : "issues/comments";
  try {
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
    if (eyes) {
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
    // Only to someone asking for a run: other comments can't tell a broken config from none.
    if (first.trigger) await reply(first.repo, first.replyTo, configErrors(first.base, errors));
    return;
  }
  const item = workItem(effectiveConfig(config, settings), event, payload, skip);
  if (!item) return;
  item.base = first.base;
  item.settings = settings;
  await accept(item);
}

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

// What a comment asks for: "work", "brainstorm" or "stop" (wrap a brainstorm up); null when
// it doesn't reach Claude. Keeps the issue's brainstorm state up to date.
async function modeOf(item, key, name) {
  const b = brainstorms.get(key);
  if (item.trigger === "work") {
    // Same session: the implementation starts from what the brainstorm settled.
    if (b) {
      clearTimeout(b.timer);
      brainstorms.delete(key);
      saveBrainstorms();
    }
    return "work";
  }
  if (item.trigger === "stop") {
    if (!b || b.status === "stopped") return skip(`#${item.number} has no brainstorm to stop`);
    clearTimeout(b.timer);
    b.status = "stopped";
    saveBrainstorms();
    return "stop";
  }
  // A comment on the issue itself continues its brainstorm; one on its pull request is work.
  if (item.trigger === "brainstorm" || (b && item.replyTo === item.number)) {
    if (!item.trigger && b.status === "stopped") {
      return skip(`#${item.number}: brainstorm stopped and no trigger line`);
    }
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
    const started = (await docker(["volume", "inspect", `${name}-claude`])).code === 0;
    if (!started) return skip(`#${item.replyTo} has no Claude session and no trigger line`);
  }
  return "work";
}

// A brainstorm reply (or wrap-up) is what the task's next run will be.
function talking(task) {
  const mode = task.pending.at(-1)?.mode;
  return mode === "brainstorm" || mode === "stop";
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
  if (!text) return false;
  live.send(liveMessage(live.mode, text));
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
  return true;
}

// What Claude reads for comments delivered mid-run (the CLI adds that the user sent it while
// Claude was working).
function liveMessage(mode, text) {
  const reply =
    "Your final message is still posted as the single reply for this run: make it cover this comment too. (Don't post comments on GitHub yourself.)";
  return mode === "brainstorm"
    ? `New comment on the issue: ${text}\n\n(Still a brainstorm: no code, branch, commit, pull request or new issue. ${reply})`
    : `New comment on this issue while you are working:\n\n${text}\n\nTake it into account from here on. ${reply}`;
}

function schedule() {
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

// --- Prompts -------------------------------------------------------------------------------

const brainstormInstructions = readFileSync(
  new URL("../prompts/brainstorm.md", import.meta.url),
  "utf8",
);

function brainstormPrompt(task) {
  return `Brainstorm GitHub issue #${task.number} of ${task.repo} with the maintainer. Read it with
\`gh issue view ${task.number} --comments\`.

${brainstormInstructions}`;
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

// --- Runs ----------------------------------------------------------------------------------

async function run(task) {
  task.running = true;
  task.ready = false;
  running++;
  const items = task.pending.splice(0);
  const replyTo = items.at(-1).replyTo;
  // The last comment decides: a work trigger after a brainstorm comment means work.
  const mode = items.at(-1).mode;
  const talk = mode === "brainstorm" || mode === "stop";
  const key = `${task.repo}#${task.id}`;
  const id = `${task.name}-${Date.now()}`;
  const logPath = join(logDir, `${id}.log`);
  const logFile = createWriteStream(logPath);
  const record = {
    id,
    key,
    kind: talk ? "brainstorm" : task.kind,
    repo: task.repo,
    replyTo,
    mode: null,
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    logPath,
  };
  runs.unshift(record);
  // This run's comments, and those delivered to it while it works (see deliver()).
  const handled = [...items];
  // The sandbox's only way to GitHub: tokens for this repo, while this run lasts.
  const secret = broker.register(task.repo);
  try {
    // Left over from a listener restart: wait for it.
    if ((await docker(["ps", "-q", "--filter", `name=^${task.name}$`])).out) {
      await docker(["wait", task.name]);
    }
    const started = (await docker(["volume", "inspect", `${task.name}-claude`])).code === 0;
    // A new comment answers the questions, if any: the issue no longer waits for input.
    if (config.needsInputLabel) await label(task.repo, task.number, false);
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
    const message = started
      ? `${body || "Continue."}\n\n(Don't post comments on GitHub yourself: your final message is posted as a reply.)`
      : body;
    // Fresh from the default branch: a config merged since the comment applies.
    const { settings, errors, warnings } = await repoSettings(task.repo, task.base);
    task.settings = settings;
    const defaults = talk
      ? [settings.brainstormModel, settings.brainstormEffort]
      : [settings.model, settings.effort];
    record.model = options.model ?? defaults[0];
    record.effort = options.effort ?? defaults[1];
    record.mode =
      mode === "stop" ? "wrap-up" : restored ? "restore" : started ? "continue" : "start";
    log(
      `${key}: running ${task.name} (${mode}, ${record.mode}, ${record.model}/${record.effort}), log ${logPath}`,
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
    const access = grantedAccess(task.repo, settings, note);
    const prepared = await prepare(task, items, settings, record, note, logFile);

    // A fresh, unguessable folder per run: its screenshots are public once linked on GitHub.
    const shots = randomBytes(12).toString("hex");
    mkdirSync(join(shotsDir, shots), { recursive: true });
    chmodSync(join(shotsDir, shots), 0o777); // the sandbox runs as uid 1000
    // Where comments that arrive during the run go (deliver()).
    task.live = {
      key,
      mode,
      open: false,
      // What the egress proxy lets it reach (egressAnswer()), and its address once known.
      hosts: access.hosts,
      ip: null,
      logFile,
      record,
      replyTo,
      later: {}, // "/model" and "/effort" that came too late for this run
      unanswered: [], // delivered since Claude's last result
      handled: [], // every comment delivered to it, for their reactions
    };
    const prompt = talk ? brainstormPrompt(task) : initialPrompt(task);
    const result = await sandbox(task, prompt, message, logFile, shots, record, secret, {
      ...prepared,
      ...access,
    });
    const live = task.live;
    task.live = null;
    handled.push(...(live?.handled ?? []));
    // Claude exited before answering a delivered comment (a crash): the next run gets it.
    if (live?.unanswered.length) task.pending.unshift(...live.unanswered);
    const target = live?.replyTo ?? replyTo;
    if (!readdirSync(join(shotsDir, shots)).length) rmdirSync(join(shotsDir, shots));
    const minutes = result ? Math.round(result.duration_ms / 6000) / 10 : null;
    // On a phone, the reply is where the next step is read.
    const hint =
      mode === "stop"
        ? " · 💬 brainstorm ended: a trigger line starts it again"
        : talk
          ? " · 💬 brainstorm: reply to continue, `/stop` to wrap up"
          : "";
    const later = Object.entries(live?.later ?? {})
      .map(([k, v]) => `\`/${k} ${v}\``)
      .join(" ");
    const next = later ? ` · ${later} came mid-run: it applies to the next run` : "";
    const footer = `<sub>🤖 Claude ${record.model} · ${record.effort} effort${minutes !== null ? ` · ${minutes} min` : ""}${hint}${next}</sub>`;
    const status = outcome(result);
    if (status !== "error") {
      await reply(task.repo, target, `${result.result}\n\n${footer}`);
      // A brainstorm asks questions all along: no label for those.
      if (status === "needs-input" && config.needsInputLabel && !talk) {
        await label(task.repo, task.number, true);
      }
    } else {
      const detail = result?.result ?? "No result: see the listener logs.";
      await reply(task.repo, target, `Claude stopped with an error.\n\n> ${detail}\n\n${footer}`);
    }
    log(`${key}: done (${status})`);
    record.status = status;
  } catch (error) {
    log(`${key}: ${error.stack ?? error}`);
    record.status = "error";
    if (error instanceof RunError) {
      await reply(task.repo, replyTo, error.message).catch((e) => log(`${key}: ${e}`));
    }
  } finally {
    record.phase = null;
    broker.revoke(secret);
    record.finishedAt = Date.now();
    logFile.end();
    if (task.live) handled.push(...task.live.handled); // the run threw mid-way
    task.live = null;
    task.running = false;
    running--;
    // Comments put back for the next run keep their 👀 until that one is over. A brainstorm
    // asks questions all along, like for the label: its replies are "done".
    const status =
      !talk || record.status === "error" ? record.status : mode === "stop" ? "stopped" : "ok";
    for (const item of handled) if (!task.pending.includes(item)) track(settle(item, status));
    const b = brainstorms.get(key);
    if (talk && b?.status === "active") {
      b.deadline = Math.max(b.deadline, Date.now() + REPLY_GRACE_MS);
      armIdle(key, b);
      saveBrainstorms();
    }
    // Comments the run could not take go out together, after the usual pause.
    if (task.pending.length) {
      clearTimeout(task.timer);
      task.timer = setTimeout(() => {
        task.ready = true;
        schedule();
      }, debounce(task));
    }
    schedule();
  }
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

// Sandboxes reach the outside through the egress proxy only: their network must have no
// route out. Checked until it passes once, so a fixed network needs no restart.
let internalNetwork = false;

async function checkNetwork() {
  if (internalNetwork) return;
  const { code, out } = await docker([
    "network",
    "inspect",
    "--format",
    "{{.Internal}}",
    config.network,
  ]);
  if (code !== 0 || out !== "true") {
    throw new Error(
      `the sandboxes' network ${config.network} is ${code === 0 ? "not internal" : "missing"}: sandboxes would bypass the egress proxy (see docs/security.md)`,
    );
  }
  internalNetwork = true;
}

// The run's image (built first if the repo's Dockerfile changed), Claude Code and the repo's
// cache volumes. While an image builds, the dashboard shows the run as "building image".
async function prepare(task, items, settings, record, note, logFile) {
  const base = task.base || "main";
  const output = (chunk) => logFile.write(chunk);
  try {
    await checkNetwork();
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

// Runs the sandbox with raw stream-json output and resolves with its last `result` event.
// Claude's stdin stays open for comments that arrive during the run; at each result the
// listener sends what is waiting, or closes it so Claude exits. A message written before the
// close is still answered (one more result), so nothing delivered is dropped.
function sandbox(
  task,
  prompt,
  message,
  logFile,
  shots,
  { kind, model, effort },
  secret,
  { image, cacheArgs, settings, mounts, limits },
) {
  const talk = kind === "brainstorm";
  const live = task.live;
  const n = task.name;
  const bot = app.identity();
  const args = [
    "run",
    "--rm",
    "--init",
    "-i",
    "--name",
    n,
    "--label",
    `deckhand.task=${task.repo}#${task.id}`,
    "--network",
    config.network,
    ...hardeningArgs(limits),
    // Values come from the environment below, so they never show in `ps`.
    ...[
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "DECKHAND_RUN_SECRET",
      "DECKHAND_BROKER_URL",
      "CLAUDE_CODE_VERSION",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "REPO_URL",
      "BASE_BRANCH",
      "TASK_PROMPT",
      "TASK_MESSAGE",
      "TASK_MODE",
      "TASK_ISSUE",
      "SANDBOX_LIGHT",
      "SANDBOX_SETUP",
      "SANDBOX_INSTRUCTIONS",
      "SANDBOX_MODEL",
      "SANDBOX_EFFORT",
      ...Object.keys(proxyEnv(config)),
    ].flatMap((k) => ["-e", k]),
    ...["-e", "TASK_INPUT=stream", "-e", "TASK_OUTPUT=json"],
    "-e",
    "SCREENSHOT_DIR=/screenshots",
    "-e",
    `SCREENSHOT_URL=${publicUrl()}/shots/${shots}`,
    // Its own folder of the screenshots volume only: no run sees another's.
    "--mount",
    `type=volume,src=${config.shotsVolume},dst=/screenshots,volume-subpath=${shots}`,
    // Claude Code, installed by the first run that needs this version (../sandbox/entrypoint.sh).
    ...["-v", `${config.claudeCodeVolume}:/opt/claude-code`],
    // The issue's clone and Claude session, kept between its runs.
    ...["-v", `${n}-workspace:/workspace`],
    ...["-v", `${n}-claude:/home/node/.claude`],
    // The repo's caches (its config's `caches`), one volume per path, kept across its runs.
    ...cacheArgs,
    // Host paths the operator grants the repo and its config asks for (grantedAccess()).
    ...mountArgs(mounts),
    image,
  ];
  // Only what is named in `args` reaches the container. The App's credentials are not in
  // the environment at all: they stay in the data volume.
  const childEnv = {
    ...env,
    DECKHAND_RUN_SECRET: secret,
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
    TASK_MODE: talk ? "brainstorm" : "work",
    // The sandbox opens the issue's branch and draft pull request (../sandbox/draft-pr.sh);
    // not for pull requests without an issue.
    TASK_ISSUE: task.kind === "issue" && !talk ? String(task.number) : "",
    // Talking needs no project setup.
    SANDBOX_LIGHT: talk ? "1" : "",
    SANDBOX_SETUP: talk ? "" : (settings.setup ?? ""),
    // Read by the sandbox from its default branch (origin/BASE_BRANCH), like the config.
    SANDBOX_INSTRUCTIONS: settings.instructions ?? "",
    SANDBOX_MODEL: model,
    SANDBOX_EFFORT: effort,
    ...proxyEnv(config),
  };
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Written before Claude starts (setup takes a while), a message waits in the pipe.
    child.stdin.on("error", () => {}); // the container is gone: close() takes over
    live.send = (text) =>
      child.stdin.write(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: text },
        }) + "\n",
      );
    live.open = true;
    const close = () => {
      if (!live.open) return;
      live.open = false;
      child.stdin.end();
    };
    let result = null;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      logFile.write(chunk);
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "result") {
            // One result per turn: a comment answered after the first adds a turn.
            result = {
              ...event,
              duration_ms: (result?.duration_ms ?? 0) + event.duration_ms,
            };
            live.unanswered = [];
            // Comments still in their pause go now, rather than to a new container.
            clearTimeout(task.timer);
            if (!deliver(task)) close();
          }
        } catch {
          // Setup output (clone, install) before Claude starts.
        }
      }
    });
    child.stderr.on("data", (chunk) => logFile.write(chunk));
    child.on("close", () => {
      live.open = false;
      resolve(result);
    });
  });
}

// --- Restarts: what a restart would cut short, and the queue kept across it ----------------

// Reaction updates still on their way to GitHub once a run is over (see run()).
const inflight = new Set();

function track(promise) {
  inflight.add(promise);
  promise.finally(() => inflight.delete(promise));
}

// Queued comments don't count: they are saved (saveQueue()), and brainstorms between replies
// are restored from brainstorms.json and their volume.
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
    idle: running === 0 && !reasons.length,
    previews: previews.status(),
    reasons,
    setUp: app !== null,
    queued: [...tasks.values()].reduce((n, t) => n + t.pending.length, 0),
    now: Date.now(),
  };
}

const queuePath = join(config.dataDir, "queue.json");

// Comments that wait for a run, with the 👀 they got, so the next listener runs them.
async function saveQueue() {
  const saved = [];
  for (const t of tasks.values()) {
    if (!t.pending.length && !Object.keys(t.next).length) continue;
    const pending = [];
    for (const { eyes, comment, ...item } of t.pending) {
      pending.push({
        ...item,
        comment: comment && {
          id: comment.id,
          html_url: comment.html_url,
          review: comment.review,
        },
        eyes: (await eyes?.catch(() => null)) ?? null,
      });
    }
    saved.push({ ...pick(t), pending, next: t.next });
  }
  if (saved.length) writeFileSync(queuePath, JSON.stringify(saved, null, 2));
  log(`Saved ${saved.length} task(s) with queued comments`);
}

function pick({ repo, id, kind, number, name, base }) {
  return { repo, id, kind, number, name, base };
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
    const pending = t.pending.map((i) => ({
      ...i,
      eyes: Promise.resolve(i.eyes),
    }));
    const task = {
      ...t,
      pending,
      running: false,
      ready: false,
      timer: null,
      live: null,
    };
    tasks.set(key, task);
    if (pending.length) {
      log(`${key}: ${pending.length} comment(s) queued before the restart`);
      task.timer = setTimeout(() => {
        task.ready = true;
        schedule();
      }, debounce(task));
    }
  }
}

// --- Runs and their logs, for the dashboard ------------------------------------------------

const runs = loadRuns(); // newest first

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
        startedAt: meta.startedAt ?? Number(id.match(/-(\d+)$/)?.[1] ?? 0),
        finishedAt: statSync(logPath).mtimeMs,
        // Unfinished and not ours: the listener restarted during the run.
        status: result ? outcome(result) : "interrupted",
        logPath,
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt);
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
    const what =
      ({
        "wrap-up": "Wrapping up the brainstorm",
        restore: "Restoring the session after a pause",
        continue: "Continuing the session",
      }[e.mode] ?? (e.kind === "brainstorm" ? "Starting a brainstorm" : "Starting")) +
      (e.model ? ` (${e.model}, ${e.effort} effort)` : "");
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

function state() {
  // A running task's comments are queued only when they wait for a follow-up run: the others
  // are on their way to the live session.
  const queued = [...tasks.values()]
    .filter((t) => t.pending.length > (t.running ? deliverable(t) : 0))
    .map((t) => ({
      key: `${t.repo}#${t.id}`,
      kind: talking(t) ? "brainstorm" : t.kind,
      title: null,
      repo: t.repo,
      replyTo: t.pending.at(-1).replyTo,
    }));
  // `now`: the dashboard compares run start times with the server clock, not its own.
  return {
    runs: runs.slice(0, 100).map(publicRun),
    queued,
    brainstorms: [...brainstorms]
      .map(([key, { timer, ...b }]) => ({ key, ...b }))
      .sort((a, b) => b.deadline - a.deadline)
      .slice(0, 20),
    maxParallel: config.maxParallel,
    previews: previews.status(),
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

const dashboard = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

function sha256(text) {
  return createHash("sha256").update(text).digest();
}

// Basic auth, any user name: the password is the only secret.
function authorized(req) {
  const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(sha256(password), sha256(config.dashboardPassword));
}

// Health checks and scripts call from inside the container (docker compose exec).
function local(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

function trusted(req) {
  return local(req) || (config.dashboardPassword && authorized(req));
}

function sendJson(res, value) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

function serveDashboard(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (!config.dashboardPassword) {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    return res.end(
      app
        ? "Deckhand listener: up. Set DASHBOARD_PASSWORD to see the runs.\n"
        : "Deckhand listener: up, no GitHub App yet. Open the /setup link from the listener's logs.\n",
    );
  }
  if (!authorized(req)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="Deckhand"' });
    return res.end();
  }
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(dashboard);
  }
  if (url.pathname === "/api/state") return sendJson(res, state());
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
    const preview = previewEvent(config, event, payload, skip);
    if (preview) {
      previewHook(preview, payload).catch((error) => log(error.stack ?? error));
      return;
    }
    // The operator's checks first, so only comments that may run cost a config read.
    const item = workItem(config, event, payload, skip);
    if (item) {
      item.base = payload.repository?.default_branch;
      admit(item, event, payload).catch((error) => log(error.stack ?? error));
    }
  });
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return res.end("ok");
  if (req.method === "GET" && req.url.startsWith("/shots/")) return serveShot(req, res);
  if (setup.handle(req, res)) return;
  if (req.url === "/status") {
    if (!trusted(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Deckhand"' });
      return res.end();
    }
    return sendJson(res, status());
  }
  if (req.method === "POST" && req.url === "/webhook") return webhook(req, res);
  // GitHub only ever POSTs to /webhook; everything a browser asks for is the dashboard.
  if (req.method === "GET") return serveDashboard(req, res);
  res.statusCode = 404;
  res.end();
}).listen(config.port, () => log(`Listening on :${config.port}`));

// --- Egress: the proxy asks, for each connection, whether a sandbox may reach a host ------

// The running task whose sandbox has this address on the sandboxes' network. Addresses are
// looked up once per run, the first time its sandbox connects.
async function taskAt(ip) {
  for (const task of tasks.values()) {
    const live = task.live;
    if (!live?.hosts) continue;
    if (!live.ip) {
      const { code, out } = await docker([
        "inspect",
        "--format",
        "{{json .NetworkSettings.Networks}}",
        task.name,
      ]);
      const net = code === 0 ? parse(out)?.[config.network] : null;
      if (net?.IPAddress) live.ip = [net.IPAddress, net.GlobalIPv6Address].filter(Boolean);
    }
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
createServer((req, res) => {
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
}).listen(config.brokerPort, () => log(`Token broker on :${config.brokerPort}`));

if (!app) log(`No GitHub App yet. Set it up at ${setup.link()}`);

loadQueue();

// `docker compose up` or `restart` stops the listener with SIGTERM, and kills it 10 s later:
// enough to wait for the 👀 ids and save what is queued.
process.on("SIGTERM", () => {
  saveQueue()
    .catch((error) => log(`Saving the queue: ${error.stack ?? error}`))
    .finally(() => process.exit(0));
});
