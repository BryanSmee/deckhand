// Runs: one sandbox per run, started, followed and removed through the runner
// (runner/docker.mjs). They run detached, so they outlive a listener restart: the next
// listener picks them up (restart.mjs). Each run's reply, reactions and label once it is over.
import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { engineNote, recheckMounts, RunError, validateRun } from "./access.mjs";
import { agentFor } from "./agents/index.mjs";
import { authOf, entryLabel, nextFallback, resolveEntry } from "./agents/select.mjs";
import { ReplyError } from "./comments.mjs";
import { commentsText, dashboardLink, taskKey } from "./events.mjs";
import { nextStep, replyFooter } from "./footer.mjs";
import { customMode, entryRun, isFresh, isLight, sessionName } from "./modes.mjs";
import { branchConfigReport } from "./onboarding.mjs";
import { createPreparation } from "./preparation.mjs";
import { openingMessages, promptFor } from "./prompts.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import { askAfterRun } from "./reviewers.mjs";
import { postReview } from "./reviews.mjs";
import {
  addRun,
  enterPhase,
  minutes,
  newRecord,
  outcome,
  phaseOf,
  questionsOf,
  saveSummary,
  summaryOf,
  timed,
  writeEvent,
} from "./runlog.mjs";
import { logSent } from "./restart.mjs";
import { sandboxSpec, sessionOf } from "./sandbox-spec.mjs";
import { noLongerAllowed } from "./tasks.mjs";
import { operatorSecrets, redact } from "./secrets.mjs";

// A run cancelled before its sandbox started (cancel()): finish() ends it as cancelled.
class Cancelled extends Error {}

// How long a sandbox may stay silent after its answer, its inbox closed, before the listener
// stops it and posts that answer (linger()): the agent should have exited, but one that left
// background work behind can go on, or never exit (#204).
export const ANSWER_GRACE_MS = 2 * 60_000;

// How long a restored run whose grace passed while no listener was there waits, once the
// follow has skipped what was read before, for its sandbox's output from meanwhile before it is
// stopped (follow()).
const CATCH_UP_MS = 10_000;

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createRuns(ctx) {
  const { config, log } = ctx;
  const graceMs = ctx.answerGraceMs ?? ANSWER_GRACE_MS;
  const catchUpMs = ctx.catchUpMs ?? CATCH_UP_MS;

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
    // Started: out of the run order (order.mjs), what comes after it goes by its queue time.
    ctx.order?.drop(taskKey(task.repo, task.id));
    task.live = newLive(task, items);
    addRun(ctx, task.live.record);
    // In its saved state before they leave the saved queue (restart.mjs take()).
    if (ctx.take) ctx.take(task, items);
    else ctx.saveLive(task);
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
    const before = task.pending.length;
    task.pending = task.pending.filter((item) => {
      const refused = noLongerAllowed(config, item, settings);
      if (!refused) return true;
      log(`${taskKey(task.repo, task.id)}: a queued comment dropped: ${refused}`);
      ctx.track(ctx.settle(item, "refused"));
      return false;
    });
    if (task.pending.length < before) ctx.saveQueue?.();
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
    const { reason = null, round = null, rounds = null } = items.at(-1);
    const record = newRecord(
      task,
      { id, key, mode, light, replyTo, reason, round, rounds, items },
      {
        title: ctx.titles.get(key),
        agent: light ? config.brainstormAgent : config.agent,
      },
    );
    // The issues it creates and the comments it posts, as GitHub answers its calls
    // (github-writes.mjs), saved with it.
    const created = [];
    // The GitHub Actions runs it reruns, with their head commit, the same (github-writes.mjs
    // MAX_RERUNS).
    const reruns = [];
    // Its tokens, which its sandbox holds instead of a GitHub token (the GitHub gateway swaps
    // them for one limited to this repo) or the operator's credential, name it by its id while
    // it lasts. Signed once its sandbox's network is known (sandbox-spec.mjs).
    ctx.broker.register(task.repo, {
      id,
      push: !light,
      mode,
      issue: task.number,
      base: task.base,
      created,
      reruns,
      reason,
    });
    return {
      id,
      key,
      mode,
      talk: mode === "brainstorm" || mode === "stop",
      light,
      record,
      // Its log, the runner's (../runner/client.mjs openRemote()): written at once, sent in order.
      logFile: ctx.runLogs.open(id),
      // Its agent's token, saved with it for redaction (restart.mjs): the broker's are gone
      // after a restart.
      agentToken: null,
      // The ID of its network (or pod), once its sandbox has one: what the egress policy and its
      // anonymous GitHub calls find it by (broker-http.mjs sandboxOfTask()).
      sandbox: null,
      asked: replyTo, // where errors go
      replyTo, // where the reply goes: the issue or pull request of the last comment it took
      open: false, // whether its inbox takes comments
      replied: false,
      // What the egress proxy lets it reach (egressAnswer()), those of them that may resolve to
      // private addresses (the operator's), those whose answers it may cache (and decrypt),
      // those it never may whatever `cached` says. Until it exits.
      hosts: null,
      trusted: null,
      cached: null,
      uncached: null,
      // What it may push (pushBranches()), once it starts.
      branches: [],
      // What its sandbox gets (capabilities.mjs), once its start decided it.
      capabilities: null,
      created,
      reruns,
      shots: null,
      lines: { out: 0, err: 0 }, // of its output read so far, so a restart skips them
      logPhase: null, // the part of the run its log is in (runlog.mjs PHASES, enterPhase())
      result: null, // its last result, with the duration of all
      later: {}, // "/model", "/effort", "/speed"… that came too late for this run
      unanswered: [], // delivered since the agent's last result
      handled: [...items], // its comments and those delivered to it, for their reactions
      cancelled: null, // { by, at } once someone stopped it (cancel())
      overflow: null, // { at, max } once its output passed RUN_LOG_MAX_MB (keep())
      answered: false, // whether it gave a result with its inbox closed: its final answer
      lingering: null, // the timer that stops it if it stays silent after that (linger())
      saving: null,
    };
  }

  // Everything up to the sandbox's start; false when the listener is stopping meanwhile (the
  // next one queues these comments again).
  async function start(task, items) {
    const run = await begin(task, items);
    // A new comment answers the questions, if any: the issue no longer waits for input. With
    // the repo's `wait_for_answers`, a light run only helps answer them: the label stays. A
    // review answers nothing, and often has no comment at all (reviews.mjs).
    const helps = task.live.mode === "review" || (task.live.light && task.settings?.waitForAnswers);
    if (config.needsInputLabel && task.kind !== "discussion" && !helps) {
      await ctx.label(task.repo, task.number, false);
    }
    const note = writeHeader(task, run);
    enterPhase(task.live, "setup");
    validateRun(agentOf(task), task, run, note);
    const parts = await prepareRun(task, items, run, note);
    if (ctx.stopping) return false;
    // Cancelled while it was prepared (its image building, say): no sandbox starts.
    if (task.live.cancelled) throw new Cancelled();
    // Its issue on the repo's projects, at `start` (projects.mjs), once every check let the run
    // start: a run refused (its config's errors, its grants, its agent) moves nothing. Never in
    // the run's way.
    ctx.projects
      ?.started(task, note, run.errors)
      .catch((error) => log(`${task.live.key}: projects: ${error.stack ?? error}`));
    await launch(task, items, run, parts, note);
    // Written before the agent starts (setup takes a while), a message waits in the inbox.
    task.live.open = true;
    ctx.saveLive(task);
    return true;
  }

  // The run's settings, agent, provider, model, effort and speed (resolveEntry()), kept on its
  // record, and its first message.
  async function begin(task, items) {
    const { key, mode, light, record, logFile } = task.live;
    await makeRoom(task);
    // Fresh from the default branch: a config merged since the comment applies.
    const { settings, errors, warnings } = await ctx.repoSettings(task.repo, task.base);
    task.settings = settings;
    const own = customMode(settings, mode);
    const previous = ctx.runs.find(
      (r) => r !== record && r.key === key && !!r.light === light && r.status !== "running",
    );
    // "/model", "/effort", "/speed" and "/agent" sent during the previous run, unless these comments say
    // otherwise.
    const options = task.next;
    task.next = {};
    // Used: a listener restarting mid-run doesn't give them to the next run too.
    ctx.saveQueue?.();
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
      // The provider's credential its entry names (`claude@anthropic:key`); null: the default.
      credential: entry.credential ?? null,
      // The credential it runs on, named or the default one (authOf()): "plan", "key",
      // "gateway", or null off Anthropic.
      auth: authOf(config, entry),
      fallback: entry.fallback,
      picked: entry.picked ?? null,
      model: chosen.model,
      effort: chosen.effort,
      speed: chosen.speed,
      // Why it isn't the speed or model asked for (speedFor()), for the reply.
      speedNote: chosen.speedNote,
    });
    ctx.broker.provide(
      task.live.id,
      entry.provider,
      (message) => writeEvent(logFile, "note", { message }),
      entry.credential ?? null,
    );
    ctx.watchPushes(task);
    const started =
      !fresh &&
      !chosen.takeOver &&
      (await ctx.runner.hasSession(sessionName(task.name, light, mode), agentOf(task)));
    const restored = items.some((i) => i.restored);
    record.mode =
      mode === "stop" ? "wrap-up" : restored ? "restore" : started ? "continue" : "start";
    const messages = openingMessages(mode, text, chosen, { restored, started, previous });
    // Once its capabilities are decided (preparation.mjs), the volume the run mounts
    // (sandbox-spec.mjs sessionOf()) may not be its mode's: looked at again there, and when that
    // changes whether it continues, its record and its first message are made again → the new
    // { message, handoff }, or null when nothing changed.
    const reopen = async (note) => {
      const now =
        fresh || chosen.takeOver
          ? started
          : await ctx.runner.hasSession(sessionOf(task.name, task.live), agentOf(task));
      const changed = reopenedMode({ mode, restored, started, now });
      if (changed !== null) record.mode = changed;
      // The log's first line already has the record: what the dashboard reads after a restart is
      // this event's, the first of the log (runlog.mjs sessionModeOf()). Written for every run,
      // before anything of the run's own (its image's build, its agent's install) goes in the
      // log, so that no line of theirs can come first.
      writeEvent(logFile, "session", { mode: record.mode, capabilities: task.live.capabilities });
      if (changed === null) return null;
      note?.(
        now
          ? "What this run gets gives it another session volume, which has a session: it continues there."
          : "What this run gets gives it a session volume of its own, without the session it would have continued: it starts afresh.",
      );
      return openingMessages(mode, text, chosen, { restored, started: now, previous });
    };
    return { ...chosen, ...messages, settings, errors, warnings, own, text, reopen };
  }

  // The first line of every log: what the dashboard needs to list the run after a restart.
  // Returns `note(text)`, which adds a line to it.
  function writeHeader(task, { text, foreign }) {
    const { key, mode, record, logFile } = task.live;
    const agent = agentOf(task);
    const on =
      record.fallback || record.picked || record.credential
        ? `@${record.provider}${record.credential ? `:${record.credential}` : ""}`
        : "";
    const fast = record.speed === "fast" ? "/fast" : "";
    log(
      `${key}: running ${task.name} (${mode}, ${record.mode}, ${agent.name}${on} ${record.model}/${record.effort}${fast}), log ${record.id}`,
    );
    logFile.write(JSON.stringify({ type: "listener", ...record, message: text }) + "\n");
    const note = (message) => writeEvent(logFile, "note", { message });
    if (foreign) note(`${foreign}: ${agent.displayName} runs its best model instead`);
    if (record.speedNote) note(record.speedNote);
    return note;
  }

  // A review's tolerance (reviews' tolerance()): only the listener's own reviews (`auto`) may
  // merge, not a "/mode review" comment's, and one in a fix loop or deciding the merge may tolerate
  // medium findings (`review.max_allowed_severity`). → { auto, allowed }
  async function reviewTolerance(task, items) {
    const auto = items.some((item) => item.reason === "review");
    const at = { repo: task.repo, number: task.live.replyTo, base: task.base, auto };
    return { auto, allowed: (await ctx.reviews?.tolerance(at)) ?? "low" };
  }

  // The prompt, the mounts checked again, and the sandbox started (sandbox-spec.mjs).
  async function launch(task, items, { settings, own, text }, parts, note) {
    const { live } = task;
    const { message, instructions, access, engine, prepared, ca } = parts;
    const agent = agentOf(task);
    // A review is told what it may find without requesting changes.
    const allowed =
      live.mode === "review" ? (await reviewTolerance(task, items)).allowed : undefined;
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
      pull: live.replyTo,
      allowed,
      // A review the CI step queued before CI passed (reviews.mjs ciDecide()).
      ciNote: live.mode === "review" ? (items.findLast((i) => i.ciNote)?.ciNote ?? null) : null,
      capabilities: live.capabilities,
    });
    // A run without `pull` mounts nothing (access.mjs bareAccess()), nor one with the open
    // internet (preparation.mjs): no mount to check again.
    const caps = live.capabilities ?? [];
    if (caps.includes("pull") && !caps.includes("internet")) recheckMounts(agent, settings, access);
    const digest =
      parts.digest ??
      (live.mode === "analyze" ? await analysisDigest(task, items, note) : undefined);
    try {
      const bot = ctx.app.identity();
      const spec = sandboxSpec(
        { config, task, agent, bot, publicUrl: ctx.publicUrl(), broker: ctx.broker },
        prompt,
        message,
        { ...prepared, ...access, engine, ca, digest },
      );
      // What the log has from here may be the sandbox's own: a `session` event counts only
      // before this (runlog.mjs sessionModeOf()).
      writeEvent(live.logFile, "sandbox");
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
    // A run that answered before the listener restarted: all of its grace while the follow
    // skips what was read before (a log of up to RUN_LOG_MAX_MB), then what was left of it
    // (`graceUntil`), and at least a moment for the follow to read what its sandbox wrote
    // while no listener was there, which pushes it back. Saved before its deadline was: all
    // of it.
    let saved = live.answered ? (live.graceUntil ?? null) : null;
    if (live.answered) linger(task);
    const whole = live.graceUntil;
    const caughtUp = () => {
      if (saved === null || !live.answered || task.live !== live) return;
      const until = Math.max(saved, Date.now() + Math.min(graceMs, catchUpMs));
      saved = null;
      // A new line pushed it back already (Docker's stdout past its skip before stderr): its
      // whole grace from that line holds.
      if (live.graceUntil !== whole) return;
      linger(task, until);
    };
    try {
      for (;;) {
        await ctx.runner.follow(task.name, {
          skip: { ...live.lines },
          onCaughtUp: caughtUp,
          onOut: (line, at) => output(task, line, at),
          // Setup output (clone, install) before the agent starts.
          onErr: (line) => {
            if (ctx.stopping) return; // left for the next listener
            const kept = keep(task, hidden(live, line));
            live.lines.err++;
            ctx.saveLiveSoon?.(task);
            if (!kept) return;
            if (live.answered) linger(task);
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

  // The GitHub tokens the gateway used for it too (broker.mjs), while the broker holds the run,
  // though its sandbox never had them: redact() also knows their shape, for those a restarted
  // listener no longer lists.
  function secretValues(live) {
    const tokens = ctx.broker.runOf(live.id)?.tokens ?? [];
    return [live.secret, ...ctx.broker.secretsOf(live.id), ...operatorSecrets(ctx), ...tokens];
  }

  // `at`: when the sandbox wrote it (runner.follow()), null when Docker didn't say.
  function output(task, raw, at = null) {
    const live = task.live;
    if (ctx.stopping) return; // left for the next listener
    const line = hidden(live, raw);
    const events = agentOf(task).normalize(line);
    // Before the line that starts it, if that line is kept (keep()); saved, so a listener that
    // restarts doesn't write it again.
    const phase = fits(live, line) ? phaseOf(live.logPhase, events) : null;
    if (phase && enterPhase(live, phase)) ctx.saveLive(task);
    // When a tool call or its output came, for the dashboard's durations: a line of the
    // listener's before it, so the agent's line stays as it printed it (runlog.mjs reader()).
    if (at !== null && fits(live, line) && events.some(timed))
      writeEvent(live.logFile, "at", { at });
    const kept = keep(task, line);
    live.lines.out++;
    ctx.saveLiveSoon?.(task);
    if (!kept) return;
    // Still at work after its answer (a background task's turn): its stop waits.
    if (live.answered) linger(task);
    const event = events.findLast((e) => e.type === "result");
    if (!event) return;
    // One result per turn: a comment answered after the first adds a turn.
    live.result = { ...event, durationMs: (live.result?.durationMs ?? 0) + event.durationMs };
    live.unanswered = [];
    // Comments still in their pause go now, rather than to a new container.
    clearTimeout(task.timer);
    if (!ctx.deliver(task)) close(task);
    // Nothing more for it: it should exit now, with this as its answer.
    if (!live.open && !live.cancelled && !live.finishing) {
      live.answered = true;
      enterPhase(live, "wrap-up"); // saved below
      linger(task);
    }
    ctx.saveLive(task);
  }

  // Writes a line of the sandbox's output to its log, unless that would take the log past
  // RUN_LOG_MAX_MB: then nothing more is written, and the run is stopped (overflow()). False
  // when the line isn't kept. The listener's own lines (writeEvent()) aren't capped: a few.
  function keep(task, line) {
    const live = task.live;
    if (live.overflow) return false;
    if (!fits(live, line)) {
      overflow(task, config.runLogMax);
      return false;
    }
    live.logFile.write(line + "\n");
    return true;
  }

  // Whether `line` still goes in the run's log, under RUN_LOG_MAX_MB.
  function fits(live, line) {
    const max = config.runLogMax;
    return !live.overflow && !(max && live.logFile.size + Buffer.byteLength(line) + 1 > max);
  }

  // Its sandbox is stopped, and finish() ends the run as failed: output without end (a
  // setup script's, a prompt-injected agent's) would fill the data volume.
  function overflow(task, max) {
    const live = task.live;
    live.overflow = { at: Date.now(), max };
    if (live.cancelled || live.finishing) return;
    clearTimeout(live.lingering);
    // Nothing more goes to its inbox: what waits is for the next run.
    live.open = false;
    const message = `Stopped as failed: ${overflowMessage(live)}`;
    writeEvent(live.logFile, "note", { message });
    log(`${live.key}: ${message}`);
    ctx
      .saveLive(task)
      .then(() => ctx.runner.kill(task.name))
      .catch((error) => log(`${live.key}: stopping its sandbox: ${error.message ?? error}`));
  }

  const overflowMessage = (live) =>
    `its output passed RUN_LOG_MAX_MB (${Math.round(live.overflow.max / 1024 / 1024)} MB), the rest of it not kept`;

  // (Re)starts the timer of a run that answered with its inbox closed: if its sandbox writes
  // nothing more for graceMs, it is stopped, and finish() posts its last result as usual. Its
  // deadline, `graceUntil`, is saved with the run (saveLiveSoon()): a listener that follows it
  // again keeps to it (`until`).
  function linger(task, until = Date.now() + graceMs) {
    const live = task.live;
    clearTimeout(live.lingering);
    live.graceUntil = until;
    const timer = setTimeout(() => endSilent(task, live, timer), Math.max(0, until - Date.now()));
    // A listener that stops leaves it to the next one (follow()).
    timer.unref?.();
    live.lingering = timer;
  }

  async function endSilent(task, live, timer) {
    const current = () =>
      task.live === live && live.lingering === timer && !live.finishing && !live.cancelled;
    if (ctx.stopping || !current()) return;
    const state = await ctx.runner.state(task.name).catch(() => null);
    if (state !== "running" || ctx.stopping || !current()) return;
    const message = `Silent for ${minutes(graceMs)} min after its answer: stopped, its answer posted`;
    writeEvent(live.logFile, "ended", { after: graceMs });
    log(`${live.key}: ${message}`);
    // The follow loop sees it exit, and ends the run.
    await ctx.runner
      .kill(task.name)
      .catch((error) => log(`${live.key}: stopping its sandbox: ${error.message ?? error}`));
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
      clearTimeout(live.lingering);
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
    ctx.saveQueue?.();
    ctx.order?.drop(key);
    log(`${key}: queued comments dropped by ${by}`);
    return "queued";
  }

  // A cancelled run's end: a short reply, no fallback, and nothing put back in the queue
  // (what was delivered went with the run). Its session and pushed commits stay. One stopped
  // after its final answer (output()) posts that answer, which would be lost otherwise.
  async function endCancelled(task) {
    const live = task.live;
    const { key, record } = live;
    const { by } = live.cancelled;
    removeEmptyShots(live);
    if (!live.replied) {
      // How long it ran, setup included: it may have no result to say.
      const ran = { durationMs: live.cancelled.at - record.startedAt };
      const footer = replyFooter(record, ran, "", live.later);
      const answer = live.answered && outcome(live.result) !== "error" && live.result.text;
      const text = answer
        ? `${answer}\n\nStopped by @${by} after its answer.\n\n${footer}`
        : `Stopped by @${by}.\n\n${footer}`;
      await post(task, text);
      live.replied = true;
      ctx.saveLive(task);
    }
    log(`${key}: done (cancelled)`);
    record.status = "cancelled";
    record.summary = `Stopped by @${by}`;
    record.questions = null;
  }

  // The end of a run whose output passed RUN_LOG_MAX_MB (overflow()): failed, no fallback (its
  // provider didn't fail). An answer it gave before is posted, which would be lost otherwise;
  // comments delivered and not answered go to the next run, as after a crash.
  async function endOverflowed(task) {
    const live = task.live;
    const { key, record } = live;
    removeEmptyShots(live);
    if (live.unanswered.length) task.pending.unshift(...live.unanswered);
    const why = overflowMessage(live);
    if (!live.replied) {
      const ran = live.result ?? { durationMs: live.overflow.at - record.startedAt };
      const footer = replyFooter(record, ran, "", live.later);
      const name = agentOf(task).displayName;
      const answer = live.answered && outcome(live.result) !== "error" && live.result.text;
      const text = answer
        ? `${answer}\n\n${name} was stopped as failed after its answer: ${why}.\n\n${footer}`
        : `${name} was stopped as failed: ${why}.\n\n${footer}`;
      await post(task, text);
      live.replied = true;
      ctx.saveLive(task);
    }
    log(`${key}: done (error, its output past RUN_LOG_MAX_MB)`);
    record.status = "error";
    record.summary = `Stopped as failed: ${why}`;
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

  // The run's reply. Throws a ReplyError when GitHub doesn't take it, retries included
  // (comments.mjs): finish() then ends the run as failed, `live.replied` still false.
  function post(task, text) {
    const { live } = task;
    return ctx.answer(target(task, live.replyTo), hidden(live, text), { full: runLink(task) });
  }

  // The run on the dashboard, where its whole answer is, should GitHub take only its start.
  function runLink(task) {
    const url = ctx.publicUrl?.();
    const { key, id } = task.live;
    return url ? dashboardLink(url, task.repo, key, id) : null;
  }

  // Once the sandbox exited (or couldn't start): the reply, reactions and label, then the next
  // run for comments that came too late for this one.
  async function finish(task, error) {
    const live = task.live;
    const { key, record } = live;
    live.open = false;
    live.finishing = true;
    clearTimeout(live.lingering);
    // Its address goes back to Docker, which may give it to another sandbox before the
    // reply is posted: the egress proxy's answers for it stop now.
    live.hosts = null;
    live.trusted = null;
    live.cached = null;
    live.uncached = null;
    // Its output at the runner first: the dashboard's live view reads it to its end once the
    // run's status changes (runlog.mjs stream()).
    await logSent(live);
    try {
      // Stopped on purpose: whatever the exit looked like, not an error.
      if (live.cancelled) return await endCancelled(task);
      if (error) throw error;
      if (live.overflow) return await endOverflowed(task);
      // The agent exited before answering a delivered comment (a crash): the next run gets it.
      if (live.unanswered.length) task.pending.unshift(...live.unanswered);
      removeEmptyShots(live);
      const status = outcome(live.result);
      const { apiStatus, apiReset } = ctx.broker.runOf(live.id) ?? {};
      const fallback =
        status === "error" && !live.replied
          ? nextFallback(config, record, live.result, apiStatus, { apiReset, now: Date.now() })
          : null;
      if (fallback) fallBack(task, fallback);
      // Once: a listener restarting from here on doesn't post it again.
      else if (!live.replied) await postReply(task, status);
      log(`${key}: done (${status})`);
      record.status = status;
      record.summary = fallback ? fallback.summary : summaryOf(live.result);
      record.questions = questionsOf(live.result);
    } catch (error) {
      record.status = "error";
      if (error instanceof ReplyError) {
        // Its comments get 👎 (cleanUp()), and the dashboard says why.
        log(`${key}: done (error, its reply refused): ${error.message}`);
        record.summary = `The reply couldn't be posted: ${error.reason}`;
        record.questions = null;
        writeEvent(live.logFile, "note", { message: `${record.summary} (${error.message})` });
      } else log(`${key}: ${error.stack ?? error}`);
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
    const apiError = ctx.broker.runOf(live.id)?.apiError;
    const why = apiError ? `Its last failed API call, through the listener: ${apiError}.\n\n` : "";
    const text =
      status !== "error"
        ? `${result.text}\n\n${check ? `${check}\n\n` : ""}${footer}`
        : `${agentOf(task).displayName} stopped with an error.\n\n> ${result?.text || "No result: see the listener logs."}\n\n${why}${footer}`;
    // Already redacted line by line; again, as a result saved by an older listener wasn't.
    // A review's result is one GitHub review, posted with the listener's token (reviews.mjs).
    if (mode === "review" && status !== "error") {
      // Its fix run or auto-merge, if any, once this run is over (cleanUp()). The tolerance
      // again, as the settings say now: the prompt was told the one at launch.
      const { auto, allowed } = await reviewTolerance(task, live.handled);
      const posted = await postReview(
        ctx,
        task.repo,
        live.replyTo,
        hidden(live, result.text),
        footer,
        { allowed, full: runLink(task) },
      );
      log(`${live.key}: review posted on #${live.replyTo} (${posted.event ?? "as a comment"})`);
      live.reviewed = { number: live.replyTo, posted, auto };
    } else await post(task, text);
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
    // The broker service hears it first, so its tokens renew nowhere once its network goes; a
    // broker that doesn't answer soon is told again later (broker-service.mjs end()).
    const revoked = ctx.broker.revoke(live.id);
    await Promise.race([revoked, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
    live.record.finishedAt = Date.now();
    saveSummary(ctx.logDir, live.record, log);
    // What it wrote last, at the runner before its state goes.
    await logSent(live);
    await ctx.runner.remove(task.name, live.id).catch((e) => log(`${live.key}: ${e}`));
    live.over = true;
    clearTimeout(live.soon);
    await live.saving;
    // What it puts back in the queue (unanswered comments, a fallback's) is saved before its
    // own state goes: a listener killed between the two finds them in both, and the run's win.
    // When the queue couldn't be written, what the task has queued goes in a file of its own
    // until a write of the queue succeeds (restart.mjs keepQueued()): the run is over, and the
    // next listener must not take it for one going. Its state is kept only when even that file
    // can't be written.
    if ((await ctx.saveQueue?.()) === false && ctx.keepQueued?.(task, live) === false) {
      log(`${live.key}: its state is kept until the queue is saved with what it put back`);
      ctx.removeOnceSaved?.(ctx.livePath(live.id));
    } else rmSync(ctx.livePath(live.id), { force: true });
    task.live = null;
    task.running = false;
    ctx.running--;
  }

  // The run is over (teardown()), its comments get their outcome's reaction, and the task's
  // next run starts after the usual pause.
  async function cleanUp(task) {
    const live = task.live;
    const { key, mode, light, record, reviewed } = live;
    await teardown(task);
    // A review that requests changes may start a fix run, and one with nothing blocking may
    // merge (reviews.mjs settle()), now that the review's own run no longer makes the task
    // busy. Not waited for: its GitHub calls mustn't hold the slot this run freed, and
    // settle() checks again for a run started meanwhile.
    if (reviewed) {
      const { repo, base, settings } = task;
      const { number, posted, auto } = reviewed;
      ctx.reviews
        ?.settle({ repo, number, base, settings, auto }, posted)
        .catch((error) => log(`${key}: after the review: ${error.stack ?? error}`));
    }
    // A fix run that is over (not put back for a fallback): the review of what it pushed, in
    // auto-merge mode or with fix rounds left to run (reviews.mjs fixed()).
    const fixRun = live.handled.find(
      (item) => item.reason === "review-fix" && !task.pending.includes(item),
    );
    if (fixRun) {
      ctx.reviews
        ?.fixed({ repo: task.repo, number: fixRun.replyTo, base: task.base, status: record.status })
        .catch((error) => log(`${key}: after the fix run: ${error.stack ?? error}`));
    }
    // A CI fix run that is over: what it pushed goes back to waiting for CI (reviews.mjs
    // ciFixed()).
    const ciRun = live.handled.find(
      (item) => item.reason === "ci-fix" && !task.pending.includes(item),
    );
    // A run that pushed and finished, on a task whose pull request is ready: its reviewers
    // again (reviewers.mjs askAfterRun(), pushed()).
    const pull = ctx.pulls?.get(key);
    if (askAfterRun({ light, record, pull })) {
      ctx.reviewers
        ?.pushed({ repo: task.repo, base: task.base, number: pull.number })
        .catch((error) => log(`${key}: requesting its reviewers: ${error.stack ?? error}`));
    }
    // Any run's end: a CI fix run may have waited for the issue's task to be free (reviews.mjs
    // runEnded()).
    ctx.reviews?.runEnded(task.repo);
    if (ciRun) {
      ctx.reviews
        ?.ciFixed({
          repo: task.repo,
          number: ciRun.replyTo,
          base: task.base,
          status: record.status,
          reruns: live.reruns,
        })
        .catch((error) => log(`${key}: after the CI fix run: ${error.stack ?? error}`));
    }
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
      return await branchConfigReport(ctx.github, config, task.repo, task.number, ctx.policies);
    } catch (error) {
      log(`${taskKey(task.repo, task.id)}: checking the branch's config: ${error.stack ?? error}`);
      return `⚠️ The listener couldn't check the branch's \`${CONFIG_FILE}\`: ${error.message}`;
    }
  }

  return { run, follow, ending, dropRefused, cancel, teardown };
}

// A run's record mode once its capabilities are decided (runs.mjs begin()'s reopen()): null when
// the volume they give it has a session as its mode's had (`started`, `now`: whether each has
// one), else what begin() would have said from `now`: a wrap-up and a restored run stay so.
export function reopenedMode({ mode, restored, started, now }) {
  if (now === started) return null;
  if (mode === "stop") return "wrap-up";
  if (restored) return "restore";
  return now ? "continue" : "start";
}
