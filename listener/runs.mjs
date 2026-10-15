// Runs: one sandbox per run, started, followed and removed through the runner
// (runner/docker.mjs). They run detached, so they outlive a listener restart: the next
// listener picks them up (restart.mjs). Each run's reply, reactions and label once it is over.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { proxyEnv, refusedRepoHosts, runHosts } from "./egress.mjs";
import { commentsText } from "./events.mjs";
import { grantFor, hardeningArgs, loadGrants, mountArgs, resolveMounts } from "./grants.mjs";
import { imageRef } from "./images.mjs";
import { BUILT_IN, isFresh, isLight, kindOf, permissionsFor } from "./modes.mjs";
import { branchConfigReport, triggerWord } from "./onboarding.mjs";
import { firstMessage, promptFor } from "./prompts.mjs";
import { CONFIG_FILE, customMode } from "./repo-config.mjs";
import { openLog, outcome, parse, summaryOf } from "./runlog.mjs";

// A run that can't start for a reason the maintainer can fix: the reply says it.
export class RunError extends Error {}

export function configErrors(base, errors) {
  return `Claude can't run here: \`${CONFIG_FILE}\` on \`${base || "main"}\` has errors.\n\n${errors.map((e) => `- ${e}`).join("\n")}`;
}

// The model and effort of a run: the comments' "/model" and "/effort" (`options`), else the
// repo's mode's, else those of light runs or work.
export function modelFor(settings, own, light, options) {
  const defaults = own
    ? [own.model, own.effort]
    : light
      ? [settings.brainstormModel, settings.brainstormEffort]
      : [settings.model, settings.effort];
  return [options.model ?? defaults[0], options.effort ?? defaults[1]];
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

// The line under each reply: model, effort, duration, the next step and options that came
// too late for the run.
export function replyFooter(record, result, hint, later) {
  const minutes = result ? Math.round(result.duration_ms / 6000) / 10 : null;
  const late = Object.entries(later)
    .map(([k, v]) => `\`/${k} ${v}\``)
    .join(" ");
  const next = late ? ` · ${late} came mid-run: it applies to the next run` : "";
  return `<sub>🤖 Claude ${record.model} · ${record.effort} effort${minutes !== null ? ` · ${minutes} min` : ""}${hint}${next}</sub>`;
}

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createRuns(ctx) {
  const { config, log } = ctx;

  // Ends under way: a listener that stops lets them post their reply first, so the next one
  // doesn't post it again.
  const ending = new Set();

  async function run(task) {
    task.running = true;
    task.ready = false;
    ctx.running++;
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

  // What the dashboard lists for a run.
  function newRecord(task, { id, key, mode, replyTo }) {
    return {
      id,
      key,
      kind: kindOf(mode, task.kind),
      // work, brainstorm, idea, bug, discussion or one of the repo's own modes.
      taskMode: mode === "stop" ? "brainstorm" : mode,
      repo: task.repo,
      title: ctx.titles.get(key),
      replyTo,
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
    const record = newRecord(task, { id, key, mode, replyTo });
    return {
      id,
      key,
      mode,
      talk: mode === "brainstorm" || mode === "stop",
      light,
      record,
      logFile: openLog(record.logPath),
      // The sandbox's only way to GitHub: tokens for this repo, while this run lasts.
      secret: ctx.broker.register(task.repo, permissionsFor(mode, light)),
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
  }

  // Everything up to the sandbox's start; false when the listener is stopping meanwhile (the
  // next one queues these comments again).
  async function start(task, items) {
    const { live } = task;
    const { text, message, settings, own, note } = await begin(task, items);
    const instructions = own && (await modeInstructions(task, own));
    const access = grantedAccess(task, settings, note);
    const prepared = await prepare(task, items, settings, note);
    live.shots = shotsFolder();
    live.hosts = access.hosts;
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
    });
    await ctx.runner.start(sandboxSpec(task, prompt, message, { ...prepared, ...access }));
    // Written before Claude starts (setup takes a while), a message waits in the inbox.
    live.open = true;
    ctx.saveLive(task);
    return true;
  }

  // The run's comments, settings, model and effort, written as the first line of its log. A
  // config with errors, or a mode no longer in it, stops the run there.
  async function begin(task, items) {
    const { key, mode, light, record, logFile } = task.live;
    await makeRoom(task);
    // Inbox entries start afresh: the sandbox doesn't resume their session (entrypoint.sh).
    const started = !isFresh(task, mode) && (await ctx.runner.hasSession(task.name));
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
    [record.model, record.effort] = modelFor(settings, own, light, options);
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
    if (errors.length) throw new RunError(configErrors(task.base, errors));
    for (const warning of warnings) note(`${CONFIG_FILE}: ${warning}`);
    if (!own && !BUILT_IN.has(mode)) {
      throw new RunError(
        `Claude can't run here: the \`${mode}\` mode is no longer in \`${CONFIG_FILE}\` on \`${task.base || "main"}\`.`,
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
    const missing = `Claude can't run here: the \`${own.name}\` mode's instructions, \`${own.instructions}\`, are not on \`${base}\`.`;
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
  // reach, its host mounts and limits. Refused hosts or mounts stop the run, and the reply
  // lists them.
  function grantedAccess(task, settings, note) {
    const { repo } = task;
    let grant;
    try {
      grant = grantFor(loadGrants(config), config, repo);
    } catch (error) {
      log(`${repo}: ${error.message}`);
      throw new RunError(
        "Claude can't run here: the operator's grants file has errors (see the listener's logs).",
      );
    }
    const hosts = refusedRepoHosts(config, grant, settings);
    if (hosts.length) {
      throw new RunError(
        `${configErrors(task.base, hosts)}\n\nA repository's \`hosts\` only count when the operator's grants file sets \`allow_repo_hosts: true\` for it; hosts the operator already allows can stay.`,
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
    return { grant, hosts: runHosts(config, grant, settings), mounts, limits: grant.limits };
  }

  // The run's image (built first if the repo's Dockerfile changed), Claude Code and the repo's
  // cache volumes. While an image builds, the dashboard shows the run as "building image".
  async function prepare(task, items, settings, note) {
    const { record, logFile } = task.live;
    const base = task.base || "main";
    const output = (chunk) => logFile.write(chunk);
    try {
      await ctx.runner.checkNetwork();
      const source = await imageSource(task, items, settings);
      const image = await ctx.images.imageFor({
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
      await ctx.images.installClaudeCode(output);
      const cacheArgs = await ctx.images.caches(task.repo, settings.caches, image);
      return { image, cacheArgs, settings };
    } catch (error) {
      throw new RunError(
        `Claude couldn't start: ${error.message}\n\nThe run's log on the dashboard has the details.`,
      );
    }
  }

  // A comment on a pull request may run on the image of its own branch (imageRef()).
  async function imageSource(task, items, settings) {
    const base = task.base || "main";
    const pr = items.at(-1).replyTo;
    if (
      settings.allowBranchDockerImages &&
      settings.dockerfile &&
      (task.kind === "pr" || pr !== task.number)
    ) {
      const res = await ctx.github(task.repo, "GET", `/repos/${task.repo}/pulls/${pr}`);
      if (res.ok) return imageRef(settings, task.repo, base, await res.json());
    }
    return { ref: base, branch: false };
  }

  // What the runner starts: the sandbox's image, environment, volumes and limits. Claude's
  // first message is TASK_PROMPT (and TASK_MESSAGE); comments that arrive during the run reach
  // it through its inbox (deliver()).
  function sandboxSpec(task, prompt, message, { image, cacheArgs, settings, mounts, limits }) {
    const { live } = task;
    const n = task.name;
    const args = [
      "--network",
      config.network,
      ...hardeningArgs(limits),
      // Its own folder of the screenshots volume only: no run sees another's.
      "--mount",
      `type=volume,src=${config.shotsVolume},dst=/screenshots,volume-subpath=${live.shots}`,
      // Claude Code, installed by the listener before the run (images.installClaudeCode()).
      // Read-only: shared by every repository, so a run that could rewrite it would run its
      // code in the next sandbox of any repository, with that run's broker secret.
      ...["-v", `${config.claudeCodeVolume}:/opt/claude-code:ro`],
      // The issue's clone and Claude session, kept between its runs.
      ...["-v", `${n}-workspace:/workspace`],
      ...["-v", `${n}-claude:/home/node/.claude`],
      // The repo's caches (its config's `caches`), one volume per path, kept across its runs.
      ...cacheArgs,
      // Host paths the operator grants the repo and its config asks for (grantedAccess()).
      ...mountArgs(mounts),
    ];
    const env = sandboxEnv(task, prompt, message, settings);
    return { run: live.id, name: n, image, labels: { "deckhand.task": live.key }, env, args };
  }

  // Values reach the container by name only: they never show in `ps`. The App's credentials
  // are not among them: they stay in the data volume.
  function sandboxEnv(task, prompt, message, settings) {
    const { live } = task;
    const mode = live.mode === "stop" ? "brainstorm" : live.mode;
    const { light } = live;
    const bot = ctx.app.identity();
    return {
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
      SCREENSHOT_URL: `${ctx.publicUrl()}/shots/${live.shots}`,
      ...proxyEnv(config),
    };
  }

  // Reads the sandbox's output until it exits. At each result Claude gives, the comments
  // waiting for it go to its inbox, or the inbox closes so Claude exits; a message written
  // before the close is still answered (one more result), so nothing delivered is dropped.
  // Also how a restarted listener picks a run up: what it already read is skipped.
  async function follow(task) {
    const live = task.live;
    try {
      for (;;) {
        await ctx.runner.follow(task.name, {
          skip: { ...live.lines },
          onOut: (line) => output(task, line),
          // Setup output (clone, install) before Claude starts.
          onErr: (line) => {
            if (ctx.stopping) return; // left for the next listener
            live.logFile.write(line + "\n");
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

  function output(task, line) {
    const live = task.live;
    if (ctx.stopping) return; // left for the next listener
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
    if (!ctx.deliver(task)) close(task);
    ctx.saveLive(task);
  }

  // No more comments for this run: Claude exits once it has answered.
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
    try {
      if (error) throw error;
      // Claude exited before answering a delivered comment (a crash): the next run gets it.
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
        ? `${result.result}\n\n${check ? `${check}\n\n` : ""}${footer}`
        : `Claude stopped with an error.\n\n> ${result?.result ?? "No result: see the listener logs."}\n\n${footer}`;
    await ctx.answer(target(task, live.replyTo), text);
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

  return { run, follow, ending };
}
