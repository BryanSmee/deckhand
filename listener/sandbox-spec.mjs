// What the runner (runner/docker.mjs) starts for a run: the sandbox's image, environment,
// volumes and limits. Pure: runs.mjs start() gathers the parts. `run`: { config, task (with
// its `live`, runs.mjs), agent (agents/), bot (the App's git identity), publicUrl }.
import { proxyEnv } from "./egress.mjs";
import { hardeningArgs, mountArgs } from "./grants.mjs";
import { isFresh, OPEN, sessionName } from "./modes.mjs";
import { ENGINE_HOST } from "./runner/engine.mjs";

// The agent's first message is TASK_PROMPT (and TASK_MESSAGE); comments that arrive during the
// run reach it through its inbox (tasks.mjs deliver()).
export function sandboxSpec(
  run,
  prompt,
  message,
  { image, cacheArgs, settings, mounts, limits, engine, ca, digest },
) {
  const { config, task, agent } = run;
  const { live } = task;
  const n = task.name;
  const volumes = sessionName(n, live.light, live.mode);
  const install = agent.install(config);
  // Its network is its own (runner/docker.mjs).
  const args = [
    // The base image's `node`, whatever a repo or branch image ends with: a sandbox as root
    // would own root-owned files in granted mounts (grants.mjs) and leave root-owned files
    // in them and in cache volumes. An image that needs root at runtime fails loudly.
    ...["--user", "1000:1000"],
    ...hardeningArgs(limits),
    // Its own folder of the screenshots volume only: no run sees another's. None for a
    // research run, whose only output is its reply: the volume is publicly served.
    ...(live.shots
      ? [
          "--mount",
          `type=volume,src=${config.shotsVolume},dst=/screenshots,volume-subpath=${live.shots}`,
        ]
      : []),
    // The agent, installed by the listener before the run (images.installAgent()).
    // Read-only: shared by every repository, so a run that could rewrite it would run its
    // code in the next sandbox of any repository, with that run's broker secret.
    ...["-v", `${install.volume}:${install.mount}:ro`],
    // The issue's clone and agent session, kept between its runs: those of its light runs
    // apart from those of its work (sessionName()).
    ...["-v", `${volumes}-workspace:/workspace`],
    ...["-v", `${volumes}-${agent.session.volume}:${agent.session.path}`],
    // The repo's caches (its config's `caches`), one volume per path, kept across its runs.
    ...cacheArgs,
    // Host paths the operator grants the repo and its config asks for (access.mjs
    // grantedAccess()), read-only for a light run and a fork's (preparation.mjs): a work run
    // may trust what is there.
    ...mountArgs(live.light || live.fork ? mounts.map((m) => ({ ...m, readOnly: true })) : mounts),
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
    args,
    engine: engine ?? undefined,
    ca: ca ?? undefined,
    digest,
  };
}

// Values reach the container by name only: they never show in `ps`. The App's credentials
// are not among them: they stay in the data volume. Nor is the agent's credential: the
// agent's env (agents/) gives it the run's secret in its place.
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
    ...agent.env(config, live.secret, provider),
    DECKHAND_RUN_SECRET: live.secret,
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
    // Reading and answering needs no project setup.
    SANDBOX_LIGHT: light ? "1" : "",
    SANDBOX_NO_CLONE: open ? "1" : "",
    SANDBOX_SETUP: light ? "" : (settings.setup ?? ""),
    // Read by the sandbox from its default branch (origin/BASE_BRANCH), like the config.
    SANDBOX_INSTRUCTIONS: open ? "" : (settings.instructions ?? ""),
    SANDBOX_MODEL: live.record.model,
    SANDBOX_EFFORT: live.record.effort,
    // "fast": the agent's fast mode, already checked against the settings (agents/select.mjs).
    SANDBOX_SPEED: live.record.speed ?? "normal",
    SCREENSHOT_DIR: live.shots ? "/screenshots" : "",
    SCREENSHOT_URL: live.shots ? `${publicUrl}/shots/${live.shots}` : "",
    // The engine is reached directly, on the run's network.
    ...proxyEnv(config, engine ? [ENGINE_HOST] : []),
  };
}
