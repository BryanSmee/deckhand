// Runs: one sandbox per run, started, followed and removed through the runner
// (runner/docker.mjs). They run detached, so they outlive a listener restart: the next
// listener picks them up (restart.mjs). Each run's reply, reactions and label once it is over.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentFor, effortOf, modelOf } from "./agents/index.mjs";
import { operatorHosts, proxyEnv, runHosts } from "./egress.mjs";
import { commentsText, sameRepo } from "./events.mjs";
import { grantCheck, hardeningArgs, mountArgs, resolveMounts } from "./grants.mjs";
import { imageRef } from "./images.mjs";
import { BUILT_IN, isFresh, isLight, kindOf, permissionsFor, sessionName } from "./modes.mjs";
import { branchConfigReport, triggerWord } from "./onboarding.mjs";
import { firstMessage, promptFor } from "./prompts.mjs";
import { CONFIG_FILE, customMode, engineCacheVolume } from "./repo-config.mjs";
import { ENGINE_HOST } from "./runner/engine.mjs";
import { lastResult, openLog, outcome, summaryOf } from "./runlog.mjs";
import { noLongerAllowed } from "./tasks.mjs";
import { redact } from "./secrets.mjs";

// A run that can't start for a reason the maintainer can fix: the reply says it.
export class RunError extends Error {}

// `name`: the run's agent's (agents/).
export function configErrors(base, errors, name = agentFor().displayName) {
  return `${name} can't run here: \`${CONFIG_FILE}\` on \`${base || "main"}\` has errors.\n\n${errors.map((e) => `- ${e}`).join("\n")}`;
}

function refusedMounts(refused, name) {
  return `${name} can't run here: host mounts requested by \`${CONFIG_FILE}\` are refused.\n\n${refused.map((r) => `- ${r}`).join("\n")}\n\nOnly paths under a root the operator grants this repository can be mounted.`;
}

// The model and effort of a run: the comments' "/model" and "/effort" (`options`), else the
// repo's mode's, else those of light runs or work. Tiers (`best`…) and efforts as the run's
// agent names them.
export function modelFor(settings, own, light, options, agent = agentFor()) {
  const defaults = own
    ? [own.model, own.effort]
    : light
      ? [settings.brainstormModel, settings.brainstormEffort]
      : [settings.model, settings.effort];
  return [
    modelOf(agent, options.model ?? defaults[0]),
    effortOf(agent, options.effort ?? defaults[1]),
  ];
}

// On a phone, the reply is where the next step is read.
export function nextStep(mode, { talk, fresh, trigger }) {
  if (mode === "stop") return " · 💬 brainstorm ended: a trigger line starts it again";
  if (talk) return " · 💬 brainstorm: reply to continue, `/stop` to wrap up";
  if (mode === "discussion") return " · 💬 reply in this discussion to continue";
  if (mode === "onboarding") {
    return ` · 💬 onboarding: reply to change the proposal, \`${triggerWord(trigger)}\` opens the pull request`;
  }
  if (!BUILT_IN.has(mode) && !fresh) {
    return ` · ${mode} mode: replies go on in it, \`/mode work\` switches`;
  }
  return "";
}

// The line under each reply: agent, model, effort, duration, the next step and options that
// came too late for the run.
export function replyFooter(record, result, hint, later) {
  const minutes = result ? Math.round(result.durationMs / 6000) / 10 : null;
  const late = Object.entries(later)
    .map(([k, v]) => `\`/${k} ${v}\``)
    .join(" ");
  const next = late ? ` · ${late} came mid-run: it applies to the next run` : "";
  return `<sub>🤖 ${agentFor(record.agent).displayName} ${record.model} · ${record.effort} effort${minutes !== null ? ` · ${minutes} min` : ""}${hint}${next}</sub>`;
}

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createRuns(ctx) {
  const { config, log } = ctx;

  // The run's agent (agents/), by the name its record keeps across a restart.
  const agentOf = (task) => agentFor(task.live.record.agent);
  const cantRun = (task) => `${agentOf(task).displayName} can't run here`;

  // Ends under way: a listener that stops lets them post their reply first, so the next one
  // doesn't post it again.
  const ending = new Set();

  async function run(task) {
    task.running = true;
    task.ready = false;
    ctx.running++;
    // Still in the queue meanwhile: a listener that stops now saves them.
    await dropRefused(task);
    if (ctx.stopping || !task.pending.length) {
      task.running = false;
      ctx.running--;
      if (!ctx.stopping) ctx.schedule();
      return;
    }
    const items = task.pending.splice(0);
    task.live = newLive(task, items);
    ctx.runs.unshift(task.live.record);
    ctx.saveLive(task);
    try {
      if (!(await start(task, items))) return;
    } catch (error) {
      return end(task, error);
    }
    await follow(task);
  }

  // Comments whose author may no longer run the agent here, checked against the repo's settings
  // as they are now: its `users` may have narrowed while they waited (the pause, a restart, a
  // busy repo). Dropped, their 👀 off. Settings that can't be read are begin()'s to report.
  async function dropRefused(task) {
    let settings = null;
    try {
      const read = await ctx.repoSettings(task.repo, task.base);
      if (!read.errors.length) settings = read.settings;
    } catch {
      // begin() reads them again, and fails the run with the error.
    }
    task.pending = task.pending.filter((item) => {
      const refused = noLongerAllowed(config, item, settings);
      if (!refused) return true;
      log(`${task.repo}#${task.id}: a queued comment dropped: ${refused}`);
      ctx.track(ctx.settle(item, "refused"));
      return false;
    });
  }

  // What the dashboard lists for a run.
  function newRecord(task, { id, key, mode, replyTo, reason }) {
    return {
      id,
      key,
      kind: kindOf(mode, task.kind),
      // work, brainstorm, idea, bug, discussion or one of the repo's own modes.
      taskMode: mode === "stop" ? "brainstorm" : mode,
      repo: task.repo,
      title: ctx.titles.get(key),
      replyTo,
      // What runs it: the only agent until a deployment can pick one.
      agent: agentFor().name,
      // Why the listener started it itself ("conflict": conflicts.mjs); null for comments.
      reason,
      mode: null,
      startedAt: Date.now(),
      finishedAt: null,
      status: "running",
      logPath: join(ctx.logDir, `${id}.log`),
    };
  }

  // Where comments that arrive during the run go (deliver()), and what a listener that
  // restarts meanwhile needs to carry on with it (saveLive()).
  function newLive(task, items) {
    const replyTo = items.at(-1).replyTo;
    // The last comment decides: a work trigger after a brainstorm comment means work.
    const mode = items.at(-1).mode;
    const light = isLight(task, mode);
    const key = `${task.repo}#${task.id}`;
    const id = `${task.name}-${Date.now()}`;
    const reason = items.at(-1).reason ?? null;
    const record = newRecord(task, { id, key, mode, replyTo, reason });
    return {
      id,
      key,
      mode,
      talk: mode === "brainstorm" || mode === "stop",
      light,
      record,
      logFile: openLog(record.logPath),
      // The sandbox's only way to GitHub: tokens for this repo, while this run lasts.
      secret: ctx.broker.register(task.repo, permissionsFor(mode, light), { push: !light }),
      asked: replyTo, // where errors go
      replyTo, // where the reply goes: the issue or pull request of the last comment it took
      open: false, // whether its inbox takes comments
      replied: false,
      // What the egress proxy lets it reach (egressAnswer()), those of them that may resolve to
      // private addresses (the operator's), and its address once known. Until it exits.
      hosts: null,
      trusted: null,
      ip: null,
      // What it may push (pushBranches()), once it starts.
      branches: [],
      shots: null,
      lines: { out: 0, err: 0 }, // of its output read so far, so a restart skips them
      result: null, // its last result, with the duration of all
      later: {}, // "/model" and "/effort" that came too late for this run
      unanswered: [], // delivered since the agent's last result
      handled: [...items], // its comments and those delivered to it, for their reactions
      saving: null,
    };
  }

  // Everything up to the sandbox's start; false when the listener is stopping meanwhile (the
  // next one queues these comments again).
  async function start(task, items) {
    const { live } = task;
    const { text, message, settings, own, note } = await begin(task, items);
    const { branches, fork } = await pushBranches(task, items);
    live.branches = branches;
    ctx.broker.allow(live.secret, live.branches);
    const instructions = own && (await modeInstructions(task, own));
    const access = grantedAccess(task, settings, note);
    const engine = engineFor(task, settings, access, fork, note);
    const prepared = await prepare(task, items, settings, access.grant, note);
    live.shots = shotsFolder();
    live.hosts = access.hosts;
    live.trusted = access.trusted;
    if (ctx.stopping) return false;
    const prompt = promptFor(task, {
      mode: live.mode,
      text,
      settings,
      own,
      instructions,
      onboardingWork: onboardingWork(task),
      config,
      grant: access.grant,
      branches: live.branches,
    });
    recheckMounts(task, settings, access);
    try {
      const spec = sandboxSpec(task, prompt, message, { ...prepared, ...access, engine });
      const started = await ctx.runner.start(spec);
      if (started?.engine) note(engineNote(started.engine, engine));
    } catch (error) {
      // Its network (not internal, no proxy to join), or Docker refusing the container.
      throw new RunError(`${agentOf(task).displayName} couldn't start: ${error.message}`);
    }
    // Written before the agent starts (setup takes a while), a message waits in the inbox.
    live.open = true;
    ctx.saveLive(task);
    return true;
  }

  // The run's comments, settings, model and effort, written as the first line of its log. A
  // config with errors, or a mode no longer in it, stops the run there.
  async function begin(task, items) {
    const { key, mode, light, record, logFile } = task.live;
    const agent = agentOf(task);
    await makeRoom(task);
    // Inbox entries start afresh: the sandbox doesn't resume their session (entrypoint.sh).
    const started =
      !isFresh(task, mode) && (await ctx.runner.hasSession(sessionName(task.name, light), agent));
    // A new comment answers the questions, if any: the issue no longer waits for input.
    if (config.needsInputLabel && task.kind !== "discussion") {
      await ctx.label(task.repo, task.number, false);
    }
    // "/model" and "/effort" sent during the previous run, unless these comments say otherwise.
    const options = task.next;
    task.next = {};
    const text = commentsText(items, options);
    const restored = items.some((i) => i.restored);
    const message = firstMessage({ mode, text, restored, started });
    // Fresh from the default branch: a config merged since the comment applies.
    const { settings, errors, warnings } = await ctx.repoSettings(task.repo, task.base);
    task.settings = settings;
    const own = customMode(settings, mode);
    [record.model, record.effort] = modelFor(settings, own, light, options, agent);
    record.mode =
      mode === "stop" ? "wrap-up" : restored ? "restore" : started ? "continue" : "start";
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
    if (errors.length) throw new RunError(configErrors(task.base, errors, agent.displayName));
    for (const warning of warnings) note(`${CONFIG_FILE}: ${warning}`);
    if (!own && !BUILT_IN.has(mode)) {
      throw new RunError(
        `${cantRun(task)}: the \`${mode}\` mode is no longer in \`${CONFIG_FILE}\` on \`${task.base || "main"}\`.`,
      );
    }
    return { text, message, settings, own, note };
  }

  // Left over from a listener that lost track of it: wait for it, then make room.
  async function makeRoom(task) {
    const leftover = await ctx.runner.state(task.name);
    if (leftover === "running") await ctx.runner.wait(task.name);
    if (leftover) await ctx.runner.remove(task.name);
  }

  // A fresh, unguessable folder per run: its screenshots are public once linked on GitHub.
  function shotsFolder() {
    const shots = randomBytes(12).toString("hex");
    mkdirSync(join(ctx.shotsDir, shots), { recursive: true });
    chmodSync(join(ctx.shotsDir, shots), 0o777); // the sandbox runs as uid 1000
    return shots;
  }

  // The instructions file of the repo's mode, from its default branch like the config.
  async function modeInstructions(task, own) {
    const base = task.base || "main";
    const missing = `${cantRun(task)}: the \`${own.name}\` mode's instructions, \`${own.instructions}\`, are not on \`${base}\`.`;
    let file;
    try {
      file = await ctx.repoFile(task.repo, own.instructions, base);
    } catch (error) {
      throw new RunError(`${missing}\n\n${error.message}`);
    }
    if (!file) throw new RunError(missing);
    return file.text;
  }

  // What the operator grants the repo, with its config's requests: the hosts its sandbox may
  // reach, its host mounts and limits. Refused hosts or mounts, and a preview hook or
  // Dockerfile without their grant, stop the run, and the reply lists them.
  function grantedAccess(task, settings, note) {
    const { repo } = task;
    const check = grantCheck(config, repo, settings);
    if (check.error) {
      log(`${repo}: ${check.error.message}`);
      const where = check.error.file
        ? `\`${check.error.file}\` in the operator's grants folder has errors`
        : "the operator's grants folder has errors";
      throw new RunError(`${cantRun(task)}: ${where} (see the listener's logs).`);
    }
    const { grant, hosts, missing } = check;
    if (hosts.length) {
      throw new RunError(
        `${configErrors(task.base, hosts, agentOf(task).displayName)}\n\nA repository's \`hosts\` only count when the operator's grants set \`allow_repo_hosts: true\` for it; hosts the operator already allows can stay.`,
      );
    }
    if (missing.length) {
      log(`${repo}: ${CONFIG_FILE} asks for what its grant doesn't allow: ${missing.join("; ")}`);
      throw new RunError(
        `${configErrors(task.base, missing, agentOf(task).displayName)}\n\nThe operator can add these to the repository's file in the grants folder (see Deckhand's docs/security.md), or the repository can remove them from \`${CONFIG_FILE}\`.`,
      );
    }
    const { mounts, refused, notes } = check.mounts;
    if (refused.length) throw new RunError(refusedMounts(refused, agentOf(task).displayName));
    for (const text of notes) note(text);
    const { light } = task.live;
    for (const m of mounts) {
      note(`Host mount ${m.target}${m.readOnly || light ? " (read-only)" : ""}`);
    }
    return {
      grant,
      hosts: runHosts(config, grant, settings),
      trusted: operatorHosts(config, grant),
      mounts,
      limits: grant.limits,
    };
  }

  // The container engine (runner/engine.mjs) a run gets, or null: only with the operator's
  // SANDBOX_ENGINE, the repo's `docker` and its grant (grantedAccess() stopped the run when
  // that is missing), for work runs whose comments came from no fork's pull request: a
  // fork's code never runs in one.
  function engineFor(task, settings, { grant, limits }, fork, note) {
    if (!settings.docker || !grant.allowDocker || task.live.light) return null;
    if (!config.engine) {
      note("No container engine: the operator hasn't set SANDBOX_ENGINE");
      return null;
    }
    if (fork) {
      note("No container engine: a pull request from a fork");
      return null;
    }
    const cache = settings.docker.cache ? engineCacheVolume(config, task.repo) : null;
    return { limits, cache };
  }

  function engineNote({ backend, cached }, { cache }) {
    const storage = cached
      ? "the repository's cache"
      : cache
        ? "fresh storage: another run has the repository's cache"
        : "fresh storage";
    return `Container engine: ${backend}, ${storage}`;
  }

  // Resolved again as late as possible: preparing the run can take minutes, during which a
  // path's parts may have changed. Anything different from what was checked stops the run.
  function recheckMounts(task, settings, { grant, mounts }) {
    const now = resolveMounts(settings.mounts, grant, { caches: settings.caches });
    if (now.refused.length) {
      throw new RunError(refusedMounts(now.refused, agentOf(task).displayName));
    }
    const changed = mounts.filter(
      (m, i) => now.mounts[i]?.source !== m.source || now.mounts[i]?.readOnly !== m.readOnly,
    );
    if (changed.length || now.mounts.length !== mounts.length) {
      throw new RunError(
        `${cantRun(task)}: host mounts changed while the run was being prepared.\n\n${changed.map((m) => `- \`${m.target}\` no longer resolves to \`${m.source}\``).join("\n")}\n\nComment again to retry once they are stable.`,
      );
    }
  }

  // The run's image (built first if the repo's Dockerfile changed), its agent and the repo's
  // cache volumes. While an image builds, the dashboard shows the run as "building image".
  async function prepare(task, items, settings, grant, note) {
    const { record, logFile } = task.live;
    const base = task.base || "main";
    const output = (chunk) => logFile.write(chunk);
    try {
      const source = await imageSource(task, items, settings, grant);
      const image = await ctx.images.imageFor({
        repo: task.repo,
        ref: source.ref,
        branch: source.branch,
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
      await ctx.images.installAgent(agentOf(task), output);
      // A light run runs no setup: no caches, which work runs trust.
      const cacheArgs = task.live.light
        ? []
        : await ctx.images.caches(task.repo, settings.caches, image);
      return { image, cacheArgs, settings };
    } catch (error) {
      throw new RunError(
        `${agentOf(task).displayName} couldn't start: ${error.message}\n\nThe run's log on the dashboard has the details.`,
      );
    }
  }

  // The branches the run may push (git-gateway.mjs) and whose pull requests it may mark ready
  // (pr-ready.mjs): an issue's own, issue-<n>-* (draft-pr.sh names it from the title, which
  // may change), and the head of each pull request its comments came from, a maintainer's
  // included, but not a fork's. None for a run that can't push. `fork`: whether one of them
  // is a fork's.
  async function pushBranches(task, items) {
    if (!ctx.broker.runOf(task.live.secret)?.push) return { branches: [], fork: false };
    let fork = false;
    const branches = task.kind === "issue" ? [`issue-${task.number}-*`] : [];
    const pulls = new Set(items.map((i) => i.replyTo));
    if (task.kind !== "pr") pulls.delete(task.number);
    for (const number of pulls) {
      let pr;
      try {
        const res = await ctx.github(task.repo, "GET", `/repos/${task.repo}/pulls/${number}`);
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        pr = await res.json();
      } catch (error) {
        throw new RunError(
          `${agentOf(task).displayName} couldn't start: pull request #${number} couldn't be looked up (${error.message ?? error}). Comment again to retry.`,
        );
      }
      const ref = pr.head?.ref;
      if (!sameRepo(pr, task.repo)) fork = true;
      else if (ref && !branches.includes(ref)) branches.push(ref);
    }
    return { branches, fork };
  }

  // A comment on a pull request may run on the image of its own branch (imageRef()).
  async function imageSource(task, items, settings, grant) {
    const base = task.base || "main";
    const pr = items.at(-1).replyTo;
    if (
      grant.allowBranchDockerImages &&
      settings.dockerfile &&
      (task.kind === "pr" || pr !== task.number)
    ) {
      const res = await ctx.github(task.repo, "GET", `/repos/${task.repo}/pulls/${pr}`);
      if (res.ok) return imageRef(grant, settings, task.repo, base, await res.json());
    }
    return { ref: base, branch: false };
  }

  // What the runner starts: the sandbox's image, environment, volumes and limits. The agent's
  // first message is TASK_PROMPT (and TASK_MESSAGE); comments that arrive during the run reach
  // it through its inbox (deliver()).
  function sandboxSpec(
    task,
    prompt,
    message,
    { image, cacheArgs, settings, mounts, limits, engine },
  ) {
    const { live } = task;
    const n = task.name;
    const volumes = sessionName(n, live.light);
    const agent = agentOf(task);
    const install = agent.install(config);
    // Its network is its own (runner/docker.mjs).
    const args = [
      // The base image's `node`, whatever a repo or branch image ends with: a sandbox as root
      // would own root-owned files in granted mounts (grants.mjs) and leave root-owned files
      // in them and in cache volumes. An image that needs root at runtime fails loudly.
      ...["--user", "1000:1000"],
      ...hardeningArgs(limits),
      // Its own folder of the screenshots volume only: no run sees another's.
      "--mount",
      `type=volume,src=${config.shotsVolume},dst=/screenshots,volume-subpath=${live.shots}`,
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
      // Host paths the operator grants the repo and its config asks for (grantedAccess()),
      // read-only for a light run: a work run may trust what is there.
      ...mountArgs(live.light ? mounts.map((m) => ({ ...m, readOnly: true })) : mounts),
    ];
    const env = sandboxEnv(task, prompt, message, settings, engine);
    const labels = { "deckhand.task": live.key };
    // Its engine, if any, is the runner's to start: DOCKER_HOST comes from it.
    return { run: live.id, name: n, image, labels, env, args, engine: engine ?? undefined };
  }

  // Values reach the container by name only: they never show in `ps`. The App's credentials
  // are not among them: they stay in the data volume. Nor is the agent's credential: the
  // agent's env (agents/) gives it the run's secret in its place.
  function sandboxEnv(task, prompt, message, settings, engine) {
    const { live } = task;
    const mode = live.mode === "stop" ? "brainstorm" : live.mode;
    const { light } = live;
    const bot = ctx.app.identity();
    const agent = agentOf(task);
    const install = agent.install(config);
    return {
      ...agent.env(config, live.secret),
      DECKHAND_RUN_SECRET: live.secret,
      DECKHAND_BROKER_URL: config.brokerUrl,
      // Which of ../sandbox/agents/ runs, and its version.
      SANDBOX_AGENT: agent.name,
      [install.versionVar]: install.version,
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
      // Comments as the agent's messages (the runner's inbox), its raw output out.
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
      SCREENSHOT_URL: `${ctx.publicUrl()}/shots/${live.shots}`,
      // The engine is reached directly, on the run's network.
      ...proxyEnv(config, engine ? [ENGINE_HOST] : []),
    };
  }

  // Reads the sandbox's output until it exits. At each result the agent gives, the comments
  // waiting for it go to its inbox, or the inbox closes so the agent exits; a message written
  // before the close is still answered (one more result), so nothing delivered is dropped.
  // Also how a restarted listener picks a run up: what it already read is skipped.
  async function follow(task) {
    const live = task.live;
    try {
      for (;;) {
        await ctx.runner.follow(task.name, {
          skip: { ...live.lines },
          onOut: (line) => output(task, line),
          // Setup output (clone, install) before the agent starts.
          onErr: (line) => {
            if (ctx.stopping) return; // left for the next listener
            live.logFile.write(hidden(live, line) + "\n");
            live.lines.err++;
          },
        });
        if (ctx.stopping || (await ctx.runner.state(task.name)) !== "running") break;
        // The output stopped while the sandbox runs on (the daemon restarted, say): follow again.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      return end(task, error);
    }
    if (!ctx.stopping) await end(task);
  }

  // A line of the sandbox's output without the secrets it must not publish (secrets.mjs):
  // what is stored is what the dashboard shows, and the result is what gets posted.
  function hidden(live, line) {
    const names = agentFor(live.record.agent).secrets;
    return redact(line, [live.secret, ...names.map((name) => process.env[name])]);
  }

  function output(task, raw) {
    const live = task.live;
    if (ctx.stopping) return; // left for the next listener
    const line = hidden(live, raw);
    live.logFile.write(line + "\n");
    live.lines.out++;
    const event = lastResult([line], agentOf(task));
    if (!event) return;
    // One result per turn: a comment answered after the first adds a turn.
    live.result = { ...event, durationMs: (live.result?.durationMs ?? 0) + event.durationMs };
    live.unanswered = [];
    // Comments still in their pause go now, rather than to a new container.
    clearTimeout(task.timer);
    if (!ctx.deliver(task)) close(task);
    ctx.saveLive(task);
  }

  // No more comments for this run: the agent exits once it has answered.
  function close(task) {
    const live = task.live;
    if (!live.open) return;
    live.open = false;
    ctx.runner.close(live.id);
  }

  function end(task, error = null) {
    const done = finish(task, error);
    ending.add(done);
    done.finally(() => ending.delete(done));
    return done;
  }

  // The comment answered last decides where the reply goes (a discussion's thread).
  function target(task, replyTo) {
    return { ...task, replyTo, comment: task.live.handled.at(-1)?.comment };
  }

  // Once the sandbox exited (or couldn't start): the reply, reactions and label, then the next
  // run for comments that came too late for this one.
  async function finish(task, error) {
    const live = task.live;
    const { key, record } = live;
    live.open = false;
    // Its address goes back to Docker, which may give it to another sandbox before the
    // reply is posted: the egress proxy's answers for it stop now.
    live.hosts = null;
    live.trusted = null;
    live.ip = null;
    try {
      if (error) throw error;
      // The agent exited before answering a delivered comment (a crash): the next run gets it.
      if (live.unanswered.length) task.pending.unshift(...live.unanswered);
      const shots = live.shots && join(ctx.shotsDir, live.shots);
      if (shots && existsSync(shots) && !readdirSync(shots).length) rmdirSync(shots);
      const status = outcome(live.result);
      // Once: a listener restarting from here on doesn't post it again.
      if (!live.replied) await postReply(task, status);
      log(`${key}: done (${status})`);
      record.status = status;
      record.summary = summaryOf(live.result);
    } catch (error) {
      log(`${key}: ${error.stack ?? error}`);
      record.status = "error";
      if (error instanceof RunError && !live.replied) {
        await ctx.answer(target(task, live.asked), error.message).catch((e) => log(`${key}: ${e}`));
      }
    } finally {
      await cleanUp(task);
    }
  }

  async function postReply(task, status) {
    const { live } = task;
    const { mode, result } = live;
    const hint = nextStep(mode, {
      talk: live.talk,
      fresh: isFresh(task, mode),
      trigger: task.settings?.trigger ?? config.trigger,
    });
    const footer = replyFooter(live.record, result, hint, live.later);
    const check = status !== "error" && mode === "work" ? await configCheck(task) : null;
    const text =
      status !== "error"
        ? `${result.text}\n\n${check ? `${check}\n\n` : ""}${footer}`
        : `${agentOf(task).displayName} stopped with an error.\n\n> ${result?.text || "No result: see the listener logs."}\n\n${footer}`;
    // Already redacted line by line; again, as a result saved by an older listener wasn't.
    await ctx.answer(target(task, live.replyTo), hidden(live, text));
    live.replied = true;
    ctx.saveLive(task);
    // Light runs ask questions all along: no label for those.
    if (status === "needs-input" && config.needsInputLabel && !live.light) {
      await ctx.label(task.repo, task.number, true);
    }
  }

  // The run is over: its token, sandbox and saved state go, its comments get their outcome's
  // reaction, and the task's next run starts after the usual pause.
  async function cleanUp(task) {
    const live = task.live;
    const { key, mode, light, record } = live;
    record.phase = null;
    ctx.broker.revoke(live.secret);
    record.finishedAt = Date.now();
    await ctx.runner.remove(task.name, live.id).catch((e) => log(`${key}: ${e}`));
    await live.saving;
    rmSync(ctx.livePath(live.id), { force: true });
    task.live = null;
    task.running = false;
    ctx.running--;
    // Comments put back for the next run keep their 👀 until that one is over. Light runs
    // ask questions all along, like for the label: their replies are "done".
    const status =
      !light || record.status === "error" ? record.status : mode === "stop" ? "stopped" : "ok";
    for (const item of live.handled) {
      if (!task.pending.includes(item)) ctx.track(ctx.settle(item, status));
    }
    if (live.talk) ctx.brainstorms.replied(key);
    // Comments waiting for this task ask GitHub about it again: its run may have closed it.
    if (task.kind !== "discussion") {
      ctx.waits
        ?.recheck(task.repo, task.number)
        .catch((error) => log(`${key}: what waits for it: ${error.message ?? error}`));
    }
    // Comments the run could not take go out together, after the usual pause.
    if (task.pending.length) ctx.startLater(task);
    ctx.schedule();
  }

  // A work run on an onboarding issue proposes a config for merging: what the listener makes of
  // its branch's .deckhand.yaml goes with the reply.
  function onboardingWork(task) {
    return task.kind === "issue" && ctx.onboarded.isIssue(task.repo, task.number);
  }

  async function configCheck(task) {
    if (!onboardingWork(task)) return null;
    try {
      return await branchConfigReport(ctx.github, config, task.repo, task.number);
    } catch (error) {
      log(`${task.repo}#${task.id}: checking the branch's config: ${error.stack ?? error}`);
      return `⚠️ The listener couldn't check the branch's \`${CONFIG_FILE}\`: ${error.message}`;
    }
  }

  return { run, follow, ending, dropRefused };
}
