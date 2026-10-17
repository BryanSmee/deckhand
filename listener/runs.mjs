// Runs: one sandbox per run, started, followed and removed through the runner
// (runner/docker.mjs). They run detached, so they outlive a listener restart: the next
// listener picks them up (restart.mjs). Each run's reply, reactions and label once it is over.
import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { engineNote, recheckMounts, RunError, validateRun } from "./access.mjs";
import { agentFor } from "./agents/index.mjs";
import { entryLabel, nextFallback, resolveEntry } from "./agents/select.mjs";
import { commentsText, taskKey } from "./events.mjs";
import { nextStep, replyFooter } from "./footer.mjs";
import {
  customMode,
  entryRun,
  isFresh,
  isLight,
  OPEN,
  permissionsFor,
  sessionName,
} from "./modes.mjs";
import { branchConfigReport } from "./onboarding.mjs";
import { createPreparation } from "./preparation.mjs";
import { openingMessages, promptFor } from "./prompts.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import {
  addRun,
  lastResult,
  newRecord,
  openLog,
  outcome,
  questionsOf,
  saveSummary,
  summaryOf,
  writeEvent,
} from "./runlog.mjs";
import { sandboxSpec } from "./sandbox-spec.mjs";
import { noLongerAllowed } from "./tasks.mjs";
import { operatorSecrets, redact } from "./secrets.mjs";

// A run cancelled before its sandbox started (cancel()): finish() ends it as cancelled.
class Cancelled extends Error {}

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createRuns(ctx) {
  const { config, log } = ctx;

  // The run's agent (agents/), by the name its record keeps across a restart.
  const agentOf = (task) => agentFor(task.live.record.agent);
  const { prepareRun, analysisDigest, makeRoom } = createPreparation(ctx);

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
    // An inbox entry goes alone: the next one starts its own run when this one ends.
    const items = task.pending.splice(0, entryRun(task.pending[0].mode) ? 1 : Infinity);
    task.live = newLive(task, items);
    addRun(ctx, task.live.record);
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
      log(`${taskKey(task.repo, task.id)}: a queued comment dropped: ${refused}`);
      ctx.track(ctx.settle(item, "refused"));
      return false;
    });
  }

  // Where comments that arrive during the run go (deliver()), and what a listener that
  // restarts meanwhile needs to carry on with it (saveLive()).
  function newLive(task, items) {
    const replyTo = items.at(-1).replyTo;
    // The last comment decides: a work trigger after a brainstorm comment means work.
    const mode = items.at(-1).mode;
    const light = isLight(task, mode);
    const key = taskKey(task.repo, task.id);
    const id = `${task.name}-${Date.now()}`;
    const reason = items.at(-1).reason ?? null;
    const record = newRecord(
      task,
      { id, key, mode, light, replyTo, reason, items },
      {
        title: ctx.titles.get(key),
        agent: light ? config.brainstormAgent : config.agent,
        logDir: ctx.logDir,
      },
    );
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
      // private addresses (the operator's), those whose answers it may cache (and decrypt),
      // those it never may whatever `cached` says, and its address and its engine's once
      // known. Until it exits.
      hosts: null,
      trusted: null,
      cached: null,
      uncached: null,
      ip: null,
      engineIp: null,
      // What it may push (pushBranches()), once it starts.
      branches: [],
      shots: null,
      lines: { out: 0, err: 0 }, // of its output read so far, so a restart skips them
      result: null, // its last result, with the duration of all
      later: {}, // "/model" and "/effort" that came too late for this run
      unanswered: [], // delivered since the agent's last result
      handled: [...items], // its comments and those delivered to it, for their reactions
      cancelled: null, // { by, at } once someone stopped it (cancel())
      saving: null,
    };
  }

  // Everything up to the sandbox's start; false when the listener is stopping meanwhile (the
  // next one queues these comments again).
  async function start(task, items) {
    const run = await begin(task, items);
    // A new comment answers the questions, if any: the issue no longer waits for input. With
    // the repo's `wait_for_answers`, a light run only helps answer them: the label stays.
    const helps = task.live.light && task.settings?.waitForAnswers;
    if (config.needsInputLabel && task.kind !== "discussion" && !helps) {
      await ctx.label(task.repo, task.number, false);
    }
    const note = writeHeader(task, run);
    validateRun(agentOf(task), task, run, note);
    const parts = await prepareRun(task, items, run, note);
    if (ctx.stopping) return false;
    // Cancelled while it was prepared (its image building, say): no sandbox starts.
    if (task.live.cancelled) throw new Cancelled();
    await launch(task, items, run, parts, note);
    // Written before the agent starts (setup takes a while), a message waits in the inbox.
    task.live.open = true;
    ctx.saveLive(task);
    return true;
  }

  // The run's settings, agent, provider, model and effort (resolveEntry()), kept on its
  // record, and its first message.
  async function begin(task, items) {
    const { key, mode, light, record } = task.live;
    await makeRoom(task);
    // Fresh from the default branch: a config merged since the comment applies.
    const { settings, errors, warnings } = await ctx.repoSettings(task.repo, task.base);
    task.settings = settings;
    const own = customMode(settings, mode);
    const previous = ctx.runs.find(
      (r) => r !== record && r.key === key && !!r.light === light && r.status !== "running",
    );
    // "/model", "/effort" and "/agent" sent during the previous run, unless these comments say
    // otherwise.
    const options = task.next;
    task.next = {};
    const text = commentsText(items, options);
    const marker = items.findLast((i) => i.fallback)?.fallback;
    // Inbox entries have no previous run to hand over, and start afresh: the sandbox doesn't
    // resume their session (entrypoint.sh).
    const fresh = isFresh(task, mode);
    const chosen = resolveEntry({ config, settings, own, light, previous, options, marker, fresh });
    const { entry } = chosen;
    Object.assign(record, {
      agent: entry.agent,
      provider: entry.provider,
      fallback: entry.fallback,
      picked: entry.picked ?? null,
      model: chosen.model,
      effort: chosen.effort,
    });
    ctx.broker.provide(task.live.secret, entry.provider);
    const started =
      !fresh &&
      !chosen.takeOver &&
      (await ctx.runner.hasSession(sessionName(task.name, light, mode), agentOf(task)));
    const restored = items.some((i) => i.restored);
    record.mode =
      mode === "stop" ? "wrap-up" : restored ? "restore" : started ? "continue" : "start";
    const messages = openingMessages(mode, text, chosen, { restored, started, previous });
    return { ...chosen, ...messages, settings, errors, warnings, own, text };
  }

  // The first line of every log: what the dashboard needs to list the run after a restart.
  // Returns `note(text)`, which adds a line to it.
  function writeHeader(task, { text, foreign }) {
    const { key, mode, record, logFile } = task.live;
    const agent = agentOf(task);
    const on = record.fallback || record.picked ? `@${record.provider}` : "";
    log(
      `${key}: running ${task.name} (${mode}, ${record.mode}, ${agent.name}${on} ${record.model}/${record.effort}), log ${record.logPath}`,
    );
    const { logPath: _, ...meta } = record;
    logFile.write(JSON.stringify({ type: "listener", ...meta, message: text }) + "\n");
    const note = (message) => writeEvent(logFile, "note", { message });
    if (foreign) note(`${foreign}: ${agent.displayName} runs its best model instead`);
    return note;
  }

  // The prompt, the mounts checked again, and the sandbox started (sandbox-spec.mjs).
  async function launch(task, items, { settings, own, text }, parts, note) {
    const { live } = task;
    const { message, instructions, access, engine, prepared, ca } = parts;
    const agent = agentOf(task);
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
    // A research run mounts nothing (researchAccess()).
    if (!OPEN.has(live.mode)) recheckMounts(agent, settings, access);
    const digest =
      parts.digest ?? (live.mode === "analyze" ? analysisDigest(task, items, note) : undefined);
    try {
      const bot = ctx.app.identity();
      const spec = sandboxSpec(
        { config, task, agent, bot, publicUrl: ctx.publicUrl() },
        prompt,
        message,
        { ...prepared, ...access, engine, ca, digest },
      );
      const started = await ctx.runner.start(spec);
      if (started?.engine) note(engineNote(started.engine, engine));
      // Cancelled while Docker started it: cancel()'s kill came too early to find it.
      if (live.cancelled) await ctx.runner.kill(task.name);
    } catch (error) {
      // Its network (not internal, no proxy to join), or Docker refusing the container.
      throw new RunError(`${agent.displayName} couldn't start: ${error.message}`);
    }
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
    return redact(line, secretValues(live));
  }

  function secretValues(live) {
    return [live.secret, ...operatorSecrets(ctx)];
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

  // Stops the task's run now (a `/cancel` comment, the dashboard's Stop): marked cancelled in
  // its log and saved state first, so a listener restarting before the sandbox exits still
  // knows, then its sandbox is stopped. The follow loop sees it exit and finish() ends the
  // run as cancelled. Comments waiting for a follow-up run stay queued. A task with no run
  // going loses its queued comments instead. `by`: who stopped it. Returns "running",
  // "queued" or null when there was nothing to stop.
  function cancel(key, by) {
    const task = ctx.tasks.get(key);
    if (!task) return null;
    const live = task.live;
    if (live && !live.finishing && !live.cancelled) {
      live.cancelled = { by, at: Date.now() };
      // Nothing more goes to its inbox: what waits is for the next run.
      live.open = false;
      writeEvent(live.logFile, "cancelled", live.cancelled);
      log(`${key}: cancelled by ${by}`);
      ctx
        .saveLive(task)
        // Not started yet (start() checks), or gone already: nothing to stop.
        .then(() => ctx.runner.kill(task.name))
        .catch((error) => log(`${key}: stopping its sandbox: ${error.message ?? error}`));
      return "running";
    }
    if (live?.cancelled) return "running";
    if (!task.pending.length) return null;
    // Waiting for a slot or their pause, or for a run that is ending: dropped, their 👀 off.
    clearTimeout(task.timer);
    task.ready = false;
    for (const item of task.pending.splice(0)) ctx.track(ctx.settle(item, "cancelled"));
    log(`${key}: queued comments dropped by ${by}`);
    return "queued";
  }

  // A cancelled run's end: a short reply, no fallback, and nothing put back in the queue
  // (what was delivered went with the run). Its session and pushed commits stay.
  async function endCancelled(task) {
    const live = task.live;
    const { key, record } = live;
    const { by } = live.cancelled;
    removeEmptyShots(live);
    if (!live.replied) {
      // How long it ran, setup included: it may have no result to say.
      const ran = { durationMs: live.cancelled.at - record.startedAt };
      const footer = replyFooter(record, ran, "", live.later);
      await ctx.answer(target(task, live.replyTo), `Stopped by @${by}.\n\n${footer}`);
      live.replied = true;
      ctx.saveLive(task);
    }
    log(`${key}: done (cancelled)`);
    record.status = "cancelled";
    record.summary = `Stopped by @${by}`;
    record.questions = null;
  }

  function removeEmptyShots(live) {
    const shots = live.shots && join(ctx.shotsDir, live.shots);
    if (shots && existsSync(shots) && !readdirSync(shots).length) rmdirSync(shots);
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
    live.finishing = true;
    // Its address goes back to Docker, which may give it to another sandbox before the
    // reply is posted: the egress proxy's answers for it stop now.
    live.hosts = null;
    live.trusted = null;
    live.cached = null;
    live.uncached = null;
    live.ip = null;
    live.engineIp = null;
    try {
      // Stopped on purpose: whatever the exit looked like, not an error.
      if (live.cancelled) return await endCancelled(task);
      if (error) throw error;
      // The agent exited before answering a delivered comment (a crash): the next run gets it.
      if (live.unanswered.length) task.pending.unshift(...live.unanswered);
      removeEmptyShots(live);
      const status = outcome(live.result);
      const apiStatus = ctx.broker.runOf(live.secret)?.apiStatus;
      const fallback =
        status === "error" && !live.replied
          ? nextFallback(config, record, live.result, apiStatus)
          : null;
      if (fallback) fallBack(task, fallback);
      // Once: a listener restarting from here on doesn't post it again.
      else if (!live.replied) await postReply(task, status);
      log(`${key}: done (${status})`);
      record.status = status;
      record.summary = fallback ? fallback.summary : summaryOf(live.result);
      record.questions = questionsOf(live.result);
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

  // The provider failed: the run's comments go back in the queue, marked for the next entry of
  // FALLBACKS (entryFor()), with the last result for the agent that takes over. No reply:
  // the next run's says what happened. Queued, they keep their 👀 and survive a restart.
  function fallBack(task, fallback) {
    const { live } = task;
    const result = (live.result?.text ?? "").slice(0, 4000);
    fallback.summary = `${entryLabel(fallback.from)}'s provider failed: ${fallback.reason}. Falling back to ${entryLabel(fallback.entry)}`;
    log(`${live.key}: ${fallback.summary}`);
    writeEvent(live.logFile, "note", { message: fallback.summary });
    const { summary: _, ...marker } = fallback;
    for (const item of live.handled) item.fallback = { ...marker, result };
    task.pending.unshift(...live.handled.filter((item) => !task.pending.includes(item)));
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
    const apiError = ctx.broker.runOf(live.secret)?.apiError;
    const why = apiError ? `Its last failed API call, through the listener: ${apiError}.\n\n` : "";
    const text =
      status !== "error"
        ? `${result.text}\n\n${check ? `${check}\n\n` : ""}${footer}`
        : `${agentOf(task).displayName} stopped with an error.\n\n> ${result?.text || "No result: see the listener logs."}\n\n${why}${footer}`;
    // Already redacted line by line; again, as a result saved by an older listener wasn't.
    await ctx.answer(target(task, live.replyTo), hidden(live, text));
    live.replied = true;
    ctx.saveLive(task);
    // Light runs ask questions all along: no label for those.
    if (status === "needs-input" && config.needsInputLabel && !live.light) {
      await ctx.label(task.repo, task.number, true);
    }
  }

  // A run's end, however it ends (cleanUp(), restart.mjs requeue()): its record's summary
  // saved, its token, sandbox and saved state gone, its slot free.
  async function teardown(task) {
    const live = task.live;
    live.record.phase = null;
    ctx.broker.revoke(live.secret);
    live.record.finishedAt = Date.now();
    saveSummary(live.record, log);
    await ctx.runner.remove(task.name, live.id).catch((e) => log(`${live.key}: ${e}`));
    await live.saving;
    rmSync(ctx.livePath(live.id), { force: true });
    task.live = null;
    task.running = false;
    ctx.running--;
  }

  // The run is over (teardown()), its comments get their outcome's reaction, and the task's
  // next run starts after the usual pause.
  async function cleanUp(task) {
    const live = task.live;
    const { key, mode, light, record } = live;
    await teardown(task);
    // Comments put back for the next run keep their 👀 until that one is over. Light runs
    // ask questions all along, like for the label: their replies are "done".
    const status =
      !light || ["error", "cancelled"].includes(record.status)
        ? record.status
        : mode === "stop"
          ? "stopped"
          : "ok";
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
      log(`${taskKey(task.repo, task.id)}: checking the branch's config: ${error.stack ?? error}`);
      return `⚠️ The listener couldn't check the branch's \`${CONFIG_FILE}\`: ${error.message}`;
    }
  }

  return { run, follow, ending, dropRefused, cancel, teardown };
}
