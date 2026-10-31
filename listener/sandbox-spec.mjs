// What the runner (runner/) starts for a run: the sandbox's image, environment, user, limits
// and volumes. A description, not a backend's options: runner/docker.mjs turns it into `docker
// run` arguments (sandboxArgs()). Pure: runs.mjs start() gathers the parts. `run`: { config,
// task (with its `live`, runs.mjs), agent (agents/), bot (the App's git identity), publicUrl,
// broker (broker.mjs, which signs the run's tokens: tokens()) }.
import { proxyEnv } from "./egress.mjs";
import { isFresh, OPEN, sessionName } from "./modes.mjs";
import { ENGINE_HOST } from "./runner/engine.mjs";
import { SCREENSHOT_DIR } from "./runner/inbox.mjs";

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
  const session = sessionName(n, live.light, live.mode);
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
    // apart from those of its work (sessionName()).
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
    // grantedAccess()), read-only for a light run and a fork's (preparation.mjs): a work run
    // may trust what is there.
    ...mounts.map(({ source, target, readOnly }) => ({
      kind: "mount",
      name: source,
      path: target,
      readOnly: readOnly || live.light || live.fork,
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

// The run's tokens (broker.mjs issue()), bound to `sandbox`, the ID of its network or pod: the
// run token, which the sandbox writes to a file and renews (../sandbox/deckhand-token), and
// the agent's, which its env (agents/) gives it in place of the operator's credential. Kept
// on the live run too, for its output's redaction after a restart (restart.mjs).
export function tokenEnv({ config, task, agent, broker }, sandbox) {
  const { live } = task;
  const { token, agentToken } = broker.issue(live.id, sandbox);
  live.agentToken = agentToken;
  // What the egress policy and its anonymous GitHub calls find the run by (broker-http.mjs).
  live.sandbox = String(sandbox);
  const provider = live.record.provider ?? agent.defaultProvider;
  return {
    ...agent.env(config, agentToken, provider, live.record.credential ?? null),
    DECKHAND_RUN_TOKEN: token,
  };
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
  const { light } = live;
  // Research (modes.mjs OPEN): no clone, nothing of the repo's to run or read.
  const open = OPEN.has(live.mode);
  const install = agent.install(config);
  const provider = live.record.provider ?? agent.defaultProvider;
  return {
    DECKHAND_BROKER_URL: config.brokerUrl,
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
    // Reading and answering needs no project setup.
    SANDBOX_LIGHT: light ? "1" : "",
    SANDBOX_NO_CLONE: open ? "1" : "",
    // A work run that isn't a fork's clones whole: the GitHub gateway lets it fetch the
    // repository's commits only, never a blob on its own, as a blobless clone does on demand
    // (github-forks.mjs).
    SANDBOX_FULL_CLONE: !light && !open && !live.fork ? "1" : "",
    SANDBOX_SETUP: light ? "" : (settings.setup ?? ""),
    // Read by the sandbox from its default branch (origin/BASE_BRANCH), like the config.
    SANDBOX_INSTRUCTIONS: open ? "" : (settings.instructions ?? ""),
    SANDBOX_MODEL: live.record.model,
    SANDBOX_EFFORT: live.record.effort,
    // "fast": the agent's fast mode, already checked against the settings (agents/select.mjs).
    SANDBOX_SPEED: live.record.speed ?? "normal",
    // A folder of its own, which ../sandbox/deckhand-files uploads to the broker
    // (run-files.mjs). None for a research run, whose only output is its reply: the folder is
    // publicly served.
    SCREENSHOT_DIR: live.shots ? SCREENSHOT_DIR : "",
    SCREENSHOT_URL: live.shots ? `${publicUrl}/shots/${live.shots}` : "",
    // The engine is reached directly, on the run's network.
    ...proxyEnv(config, engine ? [ENGINE_HOST] : []),
  };
}
