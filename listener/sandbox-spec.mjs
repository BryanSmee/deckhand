// What the runner (runner/) starts for a run: the sandbox's image, environment, user, limits
// and volumes. A description, not a backend's options: runner/docker.mjs turns it into `docker
// run` arguments (sandboxArgs()). Pure: runs.mjs start() gathers the parts. `run`: { config,
// task (with its `live`, runs.mjs), agent (agents/), bot (the App's git identity), publicUrl,
// broker (broker.mjs, which signs the run's tokens: tokens()) }.
import { proxyEnv } from "./egress.mjs";
import { languageLine } from "./language.mjs";
import { restricted } from "./github-forks.mjs";
import { isApart, isFresh, RESEARCH } from "./modes.mjs";
import { ENGINE_HOST } from "./runner/engine.mjs";
import { SCREENSHOT_DIR } from "./runner/inbox.mjs";
import { SANDBOX_URLS } from "../lib/services.mjs";

// The sandbox's user: the base image's `node`.
export const SANDBOX_USER = { uid: 1000, gid: 1000 };

// The agent's first message is TASK_PROMPT (and TASK_MESSAGE); comments that arrive during the
// run reach it through its inbox (tasks.mjs deliver()). `caches`: the repo's cache volumes
// (images.caches()); `mounts`: the host paths granted (access.mjs).
//
// → { run, name, image, labels, env, tokens, user, limits, caps, volumes, engine, ca, digest },
// `tokens(sandbox)` the variables that hold the run's tokens (tokenEnv()), which the runner adds
// to `env` once it knows the ID of its sandbox's network or pod, each of
// `volumes` { kind, name, path, readOnly, subpath }: `kind` agent, session, cache or
// mount, `name` the volume (a mount's: the host path), `subpath` the folder of it mounted;
// the agent's has `install` too ({ command, env }).
export function sandboxSpec(
  run,
  prompt,
  message,
  { image, caches = [], settings, mounts, limits, engine, ca, digest },
) {
  const { config, task, agent } = run;
  const { live } = task;
  const n = task.name;
  const session = sessionOf(n, live);
  const install = agent.install(config);
  // Its network is its own (runner/).
  const volumes = [
    // The agent, installed by the listener before the run (images.installAgent()).
    // Read-only: shared by every repository, so a run that could rewrite it would run its
    // code in the next sandbox of any repository, with that run's tokens.
    // `install`: how to fill it, for a runner that installs it in the sandbox's own pod
    // (runner/kubernetes.mjs, without a claim for it).
    {
      kind: "agent",
      name: install.volume,
      path: install.mount,
      readOnly: true,
      install: {
        command: install.command,
        env: { [install.versionVar]: install.version, ...install.env },
      },
    },
    // The issue's clone and agent session, kept between its runs: those of its light runs
    // apart from those of its work, and from those of runs that trust them (sessionOf()).
    // A fork's run gets a clone of its own: what it checked out (the fork's commits, branches, a
    // stash) stays out of the issue's other work runs, which may not fetch it (github-forks.mjs).
    {
      kind: "session",
      name: `${session}${live.fork ? "-fork" : ""}-workspace`,
      path: "/workspace",
    },
    { kind: "session", name: `${session}-${agent.session.volume}`, path: agent.session.path },
    // The repo's caches (its config's `caches`), one volume per path, kept across its runs.
    ...caches.map(({ name, path }) => ({ kind: "cache", name, path })),
    // Host paths the operator grants the repo and its config asks for (access.mjs
    // grantedAccess()), read-only for a run without `push` and a fork's (preparation.mjs): a
    // work run may trust what is there.
    ...mounts.map(({ source, target, readOnly }) => ({
      kind: "mount",
      name: source,
      path: target,
      readOnly: readOnly || !capabilitiesOf(live).has("push") || live.fork,
    })),
  ];
  const env = sandboxEnv(run, prompt, message, settings, engine);
  const labels = { "deckhand.task": live.key };
  // Its engine, if any, is the runner's to start: DOCKER_HOST comes from it.
  return {
    run: live.id,
    name: n,
    image,
    labels,
    env,
    tokens: (sandbox) => tokenEnv(run, sandbox),
    // Whatever a repo or branch image ends with: a sandbox as root would own root-owned files
    // in granted mounts (grants.mjs) and leave root-owned files in them and in cache volumes.
    // An image that needs root at runtime fails loudly.
    user: SANDBOX_USER,
    limits,
    // No capabilities, no privilege gain.
    caps: [],
    volumes,
    engine: engine ?? undefined,
    ca: ca ?? undefined,
    digest,
  };
}

// The run's tokens (broker.mjs issue(), from the broker service), bound to `sandbox`, the ID of
// its network or pod: the run token, which the sandbox writes to a file and renews with the
// broker service (../sandbox/deckhand-token), and the agent's, which its env (agents/) gives it
// in place of the operator's credential. The listener's broker keeps both, for its output's
// redaction (runs.mjs). The broker service takes its screenshots into `live.shots`.
export async function tokenEnv({ config, task, agent, broker }, sandbox) {
  const { live } = task;
  const { token, agentToken } = await broker.issue(live.id, sandbox, live.shots ?? null);
  // What the egress policy and its anonymous GitHub calls find the run by (egress-http.mjs).
  live.sandbox = String(sandbox);
  const provider = live.record.provider ?? agent.defaultProvider;
  return {
    ...agent.env(config, agentToken, provider, live.record.credential ?? null),
    DECKHAND_RUN_TOKEN: token,
  };
}

// The run's capabilities (capabilities.mjs), which preparation.mjs decided: none before.
const capabilitiesOf = (live) => new Set(live.capabilities ?? []);

// Whether the gateways check the run's fetches (github-forks.mjs restricted(), on what the broker
// has: its capabilities, whether it is a fork's): it gets what the repo's later runs trust, so it
// may not fetch a fork's code.
const checked = (live) => restricted({ fork: live.fork, caps: live.capabilities ?? [] });

// The name a run in `mode` of the issue `name` starts its volumes with before its capabilities
// are decided: its mode's (modes.mjs `volumes`), where runs.mjs looks for a session to continue.
// sessionOf() may then pick another of the same mode's.
export function sessionName(name, mode) {
  if (RESEARCH.has(mode)) return `${name}-research`;
  return isApart(mode) ? `${name}-light` : name;
}

// The name its volumes start with. Runs in a mode with volumes of its own (`live.light`: modes.mjs
// `volumes`, apart) and work runs never share one, as the issue's sessions are theirs: a comment
// without a trigger line goes on with work's only (task-modes.mjs, sessionNames()). Within each,
// apart:
// - a run without `pull` (`-bare`: nothing of the repository's, not even an earlier run's clone
//   or transcript);
// - a run that doesn't stash from one that does (`push`, as for how it starts: SANDBOX_LIGHT,
//   sandboxEnv()): its reset throws away what the other leaves uncommitted for its next run. A
//   work run without `push` gets `-readonly`, a run apart with it `-push`;
// - a run the gateways check from one they don't (`-trusted`: it gets caches, an engine or a
//   branch, so it never starts where a run that may fetch a fork's code left it);
// - a run that reaches the open internet (`-open`) from one that doesn't: whatever a page gets
//   it to write in its clone or the agent's home (hooks, settings, a transcript) never runs in,
//   nor is read by, a run that has caches or a token without it.
// Research runs have their own (sessionName()).
export function sessionOf(name, live) {
  if (RESEARCH.has(live.mode)) return sessionName(name, live.mode);
  const kept = keptSession(name, live);
  return capabilitiesOf(live).has("internet") ? `${kept}-open` : kept;
}

// sessionOf()'s name for a run without the open internet.
function keptSession(name, live) {
  const caps = capabilitiesOf(live);
  const own = live.light ? `${name}-light` : name;
  if (live.capabilities && !caps.has("pull")) return `${own}-bare`;
  const stashes = live.capabilities ? caps.has("push") : !live.light;
  if (stashes) return live.light ? `${own}-push` : name;
  const base = live.light ? own : `${name}-readonly`;
  return checked(live) ? `${base}-trusted` : base;
}

// Every name sessionOf() may give a run of the issue `name` that isn't a research run: a work
// run's (`light` false) or one apart's (true), either when `light` is undefined; the two never
// share one. Where a comment without a trigger line looks for a session to go on with, before
// the run's capabilities are decided (task-modes.mjs).
export function sessionNames(name, light) {
  const each = (names) => names.flatMap((n) => [n, `${n}-open`]);
  const work = each([name, `${name}-readonly`, `${name}-readonly-trusted`, `${name}-bare`]);
  const lighter = each([
    `${name}-light`,
    `${name}-light-trusted`,
    `${name}-light-bare`,
    `${name}-light-push`,
  ]);
  if (light === undefined) return [...work, ...lighter];
  return light ? lighter : work;
}

// Values reach the container by name only: they never show in `ps`. The App's credentials
// are not among them: they stay in the data volume. Nor is the agent's credential: the
// agent's env gives it the agent token in its place, which comes with the run token once the
// runner knows where the sandbox runs (tokenEnv()).
export function sandboxEnv(
  { config, task, agent, bot, publicUrl },
  prompt,
  message,
  settings,
  engine,
) {
  const { live } = task;
  const mode = live.mode === "stop" ? "brainstorm" : live.mode;
  // Its capabilities: without `push`, no branch; without `pull`, no clone, nothing of the
  // repo's to run or read (a research run).
  const caps = capabilitiesOf(live);
  const light = !caps.has("push");
  const open = !caps.has("pull");
  const install = agent.install(config);
  const provider = live.record.provider ?? agent.defaultProvider;
  return {
    // The services it calls by their names, through the egress proxy (lib/services.mjs): the
    // broker for its run token and files, the github service for its pushes.
    DECKHAND_BROKER_URL: SANDBOX_URLS.broker,
    DECKHAND_GIT_URL: SANDBOX_URLS.github,
    // Where its agent asks for more permissions (#479, ../sandbox/deckhand-permissions): a
    // chat's run only, as the broker allows (../broker/permissions.mjs PERMISSION_MODES).
    TASK_PERMISSIONS: mode === "chat" ? `${SANDBOX_URLS.broker}/run/permissions` : "",
    // Which of ../sandbox/agents/ runs, and its version.
    SANDBOX_AGENT: agent.name,
    SANDBOX_PROVIDER: provider,
    [install.versionVar]: install.version,
    GIT_AUTHOR_NAME: bot.name,
    GIT_AUTHOR_EMAIL: bot.email,
    GIT_COMMITTER_NAME: bot.name,
    GIT_COMMITTER_EMAIL: bot.email,
    REPO_URL: `${config.githubUrl}/${task.repo}.git`,
    BASE_BRANCH: task.base,
    TASK_PROMPT: prompt,
    TASK_MESSAGE: message,
    // The repo's `language` (language.mjs languageLine()): TASK_PROMPT ends with it, and the
    // entrypoint adds it again after what it says past the prompt (a continued session's
    // notes), so it stays the last thing the agent reads.
    TASK_LANGUAGE: settings.language ? languageLine(settings.language, live.mode) : "",
    // work, brainstorm, idea, bug, discussion or one of the repo's own modes.
    TASK_MODE: mode,
    // A new session each time, which doesn't replace the issue's (inbox entries, fresh modes),
    // or a new one that does: another agent taking over after a fallback.
    TASK_SESSION: isFresh(task, mode) ? "fresh" : live.handoff ? "new" : "",
    // Comments as the agent's messages (the runner's inbox), its raw output out.
    TASK_INPUT: "stream",
    TASK_OUTPUT: "json",
    // The sandbox opens the issue's branch and draft pull request (../sandbox/draft-pr.sh);
    // not for pull requests without an issue.
    TASK_ISSUE: task.kind === "issue" && !light ? String(task.number) : "",
    // The issue's branch (linked-branch.mjs): the one the listener just created at the base's
    // head and linked to the issue, or a work run's issue's one existing branch. draft-pr.sh
    // checks it out, and adds its first commit when it has nothing over the base.
    TASK_BRANCH: (!light && live.linkedBranch) || "",
    // No branch to open (`push`): it reads the clone's base branch.
    SANDBOX_LIGHT: light ? "1" : "",
    SANDBOX_NO_CLONE: open ? "1" : "",
    // A run the gateways check clones whole: they let it fetch the repository's commits only,
    // never a blob on its own, as a blobless clone does on demand (github-forks.mjs).
    SANDBOX_FULL_CLONE: !open && checked(live) ? "1" : "",
    SANDBOX_SETUP: caps.has("setup") ? (settings.setup ?? "") : "",
    // Read by the sandbox from its default branch (origin/BASE_BRANCH), like the config.
    SANDBOX_INSTRUCTIONS: open ? "" : (settings.instructions ?? ""),
    SANDBOX_MODEL: live.record.model,
    SANDBOX_EFFORT: live.record.effort,
    // "fast": the agent's fast mode, already checked against the settings (agents/select.mjs).
    SANDBOX_SPEED: live.record.speed ?? "normal",
    // A folder of its own, which ../sandbox/deckhand-files uploads to the broker service. None for a research run, whose only output is its reply: the folder is
    // publicly served.
    SCREENSHOT_DIR: live.shots ? SCREENSHOT_DIR : "",
    SCREENSHOT_URL: live.shots ? `${publicUrl}/shots/${live.shots}` : "",
    // The engine is reached directly, on the run's network.
    ...proxyEnv(config, engine ? [ENGINE_HOST] : []),
  };
}
