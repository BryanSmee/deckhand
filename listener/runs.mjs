// Runs: one sandbox per run, started, followed and removed through the runner
// (runner/docker.mjs). They run detached, so they outlive a listener restart: the next
// listener picks them up (restart.mjs). Each run's reply, reactions and label once it is over.
// An external run (#597) has no sandbox: a user's machine claimed its task (claims.mjs) and
// reports its life through /mcp, its log's lines, its end; the rest is a sandbox run's.
import { engineNote, recheckMounts, RunError, validateRun } from "./access.mjs";
import { agentFor } from "./agents/index.mjs";
import { authOf, resolveEntry } from "./agents/select.mjs";
import { commentsText, taskKey } from "./events.mjs";
import { brainstormDefaults, customMode, entryRun, isApart, isFresh } from "./modes.mjs";
import { TALKS, WRAP_UPS } from "./modes.mjs";
import { createPreparation } from "./preparation.mjs";
import { openingMessages, promptFor } from "./prompts.mjs";
import { reviewStart } from "./review-post.mjs";
import { addRun, enterPhase, newRecord, writeEvent } from "./runlog.mjs";
import { sandboxSpec, sessionName, sessionOf } from "./sandbox-spec.mjs";
import { countRun, isChat, noLongerAllowed, pickedTask, refusedItems } from "./tasks.mjs";
import { createRunOutput } from "./run-output.mjs";
import { createRunReplies } from "./run-replies.mjs";
import { createRunEnd } from "./run-end.mjs";
import { createExternalRuns } from "./external-runs.mjs";
import { newLogContext, newRequestId, withLogContext } from "../lib/log.mjs";

// What a run logs, and the calls it makes to the other services, name it (lib/log.mjs), from
// its start or its pick-up after a restart (restart.mjs) to its end: under a request ID of its
// own, not that of whatever happened to start it (a delivery that freed a place, another run's
// end). Its run's ID once it has one (task.live).
export const runLogContext = (task) => ({
  request: newRequestId(),
  repo: task.repo,
  issue: task.number,
  run: task.live?.id,
});

// Where it was before the split (#1068): its tests read it here.
export { GITHUB_REQUEUE_MS } from "./run-replies.mjs";

// A run cancelled before its sandbox started (cancel()): finish() ends it as cancelled.
class Cancelled extends Error {}

// How long a sandbox may stay silent after its answer, its inbox closed, before the listener
// stops it and posts that answer (linger()): the agent should have exited, but one that left
// background work behind can go on, or never exit (#204).
const ANSWER_GRACE_MS = 2 * 60_000;

// How long a restored run whose grace passed while no listener was there waits, once the
// follow has skipped what was read before, for its sandbox's output from meanwhile before it is
// stopped (follow()).
const CATCH_UP_MS = 10_000;
// How many times in a row the output of a sandbox that exited is followed again after a follow
// that failed (the runner refusing, its stream cut, `docker logs` failing) before the run ends
// with what was read: a Codex sandbox exits as soon as it answers, its result in the last lines.
const EXITED_FOLLOWS = 3;

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createRuns(ctx) {
  const { config, log } = ctx;
  const graceMs = ctx.answerGraceMs ?? ANSWER_GRACE_MS;
  const catchUpMs = ctx.catchUpMs ?? CATCH_UP_MS;

  // The run's agent (agents/), by the name its record keeps across a restart.
  const agentOf = (task) => agentFor(task.live.record.agent);
  const { prepareRun, analysisDigest, makeRoom } = createPreparation(ctx);
  // Its parts, each given what it calls of the others: its sandbox's output (run-output.mjs),
  // its replies (run-replies.mjs), its end (run-end.mjs), external runs (external-runs.mjs).
  // `end` called late: a run's output may end it (overflow()).
  const { hidden, output, stamp, keep, fits, overflowMessage, linger } = createRunOutput(ctx, {
    graceMs,
    agentOf,
    close,
    end: (task, error) => end(task, error),
  });
  const replies = createRunReplies(ctx, { agentOf, hidden, reviewTolerance, onboardingWork });
  const { end, ending, cancel, teardown } = createRunEnd(ctx, {
    agentOf,
    overflowMessage,
    dropPending,
    ...replies,
  });
  const external = createExternalRuns(ctx, {
    newLive,
    agentOf,
    hidden,
    fits,
    stamp,
    keep,
    close,
    end,
    teardown,
  });

  // In its own context from its first line: what started it (another run's end, a delivery for
  // another issue) is no part of it.
  function run(task) {
    return newLogContext(runLogContext(task), () => runTask(task));
  }

  async function runTask(task) {
    task.running = true;
    task.ready = false;
    countRun(ctx, task, 1);
    // Still in the queue meanwhile: a listener that stops now saves them.
    await dropRefused(task);
    if (ctx.stopping || !task.pending.length) {
      task.running = false;
      countRun(ctx, task, -1);
      if (!ctx.stopping) ctx.schedule();
      return;
    }
    // An inbox entry goes alone: the next one starts its own run when this one ends.
    const items = task.pending.splice(0, entryRun(task.pending[0].mode) ? 1 : Infinity);
    // Started: out of the run order (order.mjs), what comes after it goes by its queue time.
    ctx.order?.drop(taskKey(task.repo, task.id));
    task.live = newLive(task, items);
    return withLogContext({ run: task.live.id }, () => started(task, items));
  }

  // A run whose record is made: started, then followed to its end.
  async function started(task, items) {
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
  // and the access decision as they are now: its `users` or its author's actions may have
  // narrowed while they waited (the pause, a restart, a busy repo). Dropped, their 👀 off.
  // Settings that can't be read are begin()'s to report.
  async function dropRefused(task) {
    let settings = null;
    try {
      const read = await ctx.repoSettings(task.repo, task.base);
      if (!read.errors.length) settings = read.settings;
    } catch {
      // begin() reads them again, and fails the run with the error.
    }
    // Their authors' access as it is now (permissions.mjs): by item, a comment queued while it
    // is decided checked as it came.
    const snapshot = [...task.pending];
    const refusedOf = await refusedItems(ctx, task.repo, snapshot, settings);
    let dropped = 0;
    task.pending = task.pending.filter((item) => {
      // One queued meanwhile, as it is checked when it came: its author's users, still.
      const refused = refusedOf.get(item) ?? noLongerAllowed(config, item, settings);
      if (!refused) return true;
      log(`${taskKey(task.repo, task.id)}: a queued comment dropped: ${refused}`);
      ctx.track(ctx.settle(item, "refused"));
      dropped++;
      return false;
    });
    if (dropped) ctx.saveQueue?.();
  }

  // Where comments that arrive during the run go (deliver()), and what a listener that
  // restarts meanwhile needs to carry on with it (saveLive()).
  // `id` and `external` (the machine whose claim it is): an external run's (startExternal()).
  function newLive(task, items, { id = `${task.name}-${Date.now()}`, external = null } = {}) {
    const replyTo = items.at(-1).replyTo;
    // The last comment decides: a work trigger after a brainstorm comment means work.
    const mode = items.at(-1).mode;
    // Its mode's volumes are its own (modes.mjs `volumes`): what the run's record says as
    // `light`, as runs before #498 did.
    const light = isApart(mode);
    const key = taskKey(task.repo, task.id);
    const { reason = null, round = null, rounds = null } = items.at(-1);
    const record = newRecord(
      task,
      { id, key, mode, light, replyTo, reason, round, rounds, items },
      {
        title: ctx.titles.get(key),
        agent: brainstormDefaults(mode) ? config.brainstormAgent : config.agent,
      },
    );
    // A chat's run (chats.mjs): its chat and its owner, the only one the dashboard shows it to.
    if (isChat(task)) Object.assign(record, { chat: chatOf(task), owner: items[0].author });
    // The issues it creates and the comments it posts, as GitHub answers its calls
    // (github-writes.mjs), saved with it.
    const created = [];
    // The GitHub Actions runs it reruns, with their head commit, the same (github-writes.mjs
    // MAX_RERUNS).
    const reruns = [];
    // Its tokens, which its sandbox holds instead of a GitHub token (the GitHub gateway swaps
    // them for one limited to this repo) or the operator's credential, name it by its id while
    // it lasts. Signed once its sandbox's network is known (sandbox-spec.mjs).
    // Whether it pushes is its capabilities' (broker.mjs grant()), once its start decided them.
    // An external run has none: nothing of Deckhand's runs on its machine.
    if (!external) {
      ctx.broker.register(task.repo, {
        id,
        mode,
        issue: task.number,
        base: task.base,
        created,
        reruns,
        reason,
      });
    }
    return {
      id,
      key,
      // The machine of an external run: { machine, name, owner } (claims.mjs); null for a sandbox's.
      external,
      // An external run's inbox: the messages delivered to it, which its machine reads from an
      // offset (next_message) so that none is lost or read twice across a handover.
      outbox: [],
      mode,
      talk: TALKS.has(mode),
      light,
      record,
      // Its log, the runner's (../runner/client.mjs openRemote()): written at once, sent in order.
      logFile: ctx.runLogs.open(id),
      // The ID of its network (or pod), once its sandbox has one: what the egress policy and its
      // anonymous GitHub calls find it by (egress-http.mjs sandboxOfTask()).
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
      stampedAt: null, // its run of plain lines' last `at` line's time (output()), null: none
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
    const issue = task.kind !== "discussion" && !isChat(task);
    if (config.needsInputLabel && issue && !helps) {
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
    if (!isChat(task)) {
      ctx.projects
        ?.started(task, note, run.errors)
        .catch((error) => log(`${task.live.key}: projects: ${error.stack ?? error}`));
    }
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
    task.settingsAt = Date.now();
    const own = customMode(settings, mode);
    const previous = ctx.runs.find(
      (r) => r !== record && r.key === key && !!r.light === light && r.status !== "running",
    );
    // "/model", "/effort", "/speed" and "/agent" sent during the previous run, unless these comments say
    // otherwise; a chat's agent, model and effort as it was created, under them (chats.mjs).
    const options = isChat(task) ? { ...ctx.chats?.options(task), ...task.next } : task.next;
    task.next = {};
    // Used: a listener restarting mid-run doesn't give them to the next run too.
    ctx.saveQueue?.();
    const text = commentsText(items, options);
    const marker = items.findLast((i) => i.fallback)?.fallback;
    // Inbox entries have no previous run to hand over, and start afresh: the sandbox doesn't
    // resume their session (entrypoint.sh).
    const fresh = isFresh(task, mode);
    const chosen = resolveEntry({
      config,
      settings,
      own,
      light: brainstormDefaults(mode),
      previous,
      options,
      marker,
      fresh,
    });
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
      (await ctx.runner.hasSession(sessionName(task.name, mode), agentOf(task)));
    const restored = items.some((i) => i.restored);
    const wrapUp = WRAP_UPS.has(mode);
    record.mode = wrapUp ? "wrap-up" : restored ? "restore" : started ? "continue" : "start";
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
      // The log's first line already has the record: what its start decided goes after it, for
      // whoever reads the log. Written for every run, before anything of the run's own (its
      // image's build, its agent's install) goes in the log, so that no line of theirs can come
      // first.
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
    ctx.metrics?.runStarted(task.live);
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
    // The commit it reviews, the pull request's head at its start: its prompt pins it there
    // (reviewPrompt()) and its review is posted there (postReview()), so a push while it runs
    // is left for the next review.
    const start = live.mode === "review" ? await reviewStart(ctx, task.repo, live.replyTo) : null;
    if (live.mode === "review") live.reviewFrom = start?.sha ?? null;
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
      reviewed: start,
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
      // What the log has from here may be the sandbox's own: a `session` event is the
      // listener's only before this.
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
    // Failed reads of an exited sandbox's output, in a row (one that ran on doesn't count, and
    // any whole read starts it again): its output is read again, up to EXITED_FOLLOWS times.
    let failed = 0;
    try {
      for (;;) {
        const complete = await ctx.runner.follow(task.name, {
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
        if (ctx.stopping) break;
        if (complete !== false) failed = 0;
        const state = await ctx.runner.state(task.name);
        // The output stopped while the sandbox runs on (the daemon restarted, say), or failed
        // to come whole from one that exited (its result may be in what wasn't read): follow
        // again, a few times for one that exited.
        const again =
          state === "running" ||
          (state === "exited" && complete === false && ++failed <= EXITED_FOLLOWS);
        if (!again) {
          if (complete === false) log(`${live.key}: its output couldn't be read to its end`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, ctx.followAgainMs ?? 1000));
      }
    } catch (error) {
      return end(task, error);
    }
    if (!ctx.stopping) await end(task);
  }

  // A chat idle for CHAT_IDLE_MINUTES (chats.mjs): its inbox closes, so its agent exits once it
  // has answered what it was sent, and one that answered already and stays silent is stopped
  // after the usual grace. An inbox not known open (a restart whose question to the runner
  // failed, restart.mjs restoreRuns()) is closed at the runner all the same: the agent may be
  // waiting on it. False when it had no run going, or rested already.
  function rest(task) {
    const live = task.live;
    if (!live || live.finishing || live.cancelled || live.answered) return false;
    if (live.open) close(task);
    else ctx.runner.close(live.id);
    if (live.result && !live.unanswered.length) {
      live.answered = true;
      enterPhase(live, "wrap-up");
      linger(task);
    }
    ctx.saveLive(task);
    return true;
  }

  // No more comments for this run: the agent exits once it has answered.
  function close(task) {
    const live = task.live;
    if (!live.open) return;
    live.open = false;
    // An external run's machine reads the close with its next message (claims.mjs nextMessage()).
    if (live.external) ctx.claims?.wake();
    else ctx.runner.close(live.id);
  }

  // The task's queued comments go, and those held since a stop, their 👀 off (but `keep`'s),
  // and it leaves the run order. Waiting for a slot or their pause, or for a run that is
  // ending. An auto-picked one frees its reserved slot: the next labelled issue, without
  // waiting for the next sweep.
  function dropPending(task, key, keep = null) {
    const picked = !task.running && pickedTask(task);
    clearTimeout(task.timer);
    task.ready = false;
    for (const item of [...task.pending.splice(0), ...(task.onHold?.splice(0) ?? [])]) {
      if (item !== keep) ctx.track(ctx.settle(item, "cancelled"));
    }
    ctx.saveQueue?.();
    ctx.order?.drop(key);
    if (picked) ctx.autoPickup?.soon();
  }

  // A task waiting for a slot, no run going or ending (a follow-up waits for that one):
  // { item, replies, others }. `item`: its newest comment that starts a run (an issue's trigger
  // or `/mode` comment), which can wait for another issue instead (the dashboard's Queue
  // after…, work.mjs); null when none does. `replies`: none does, and every comment queued is a
  // plain reply to its last run (not an inbox entry, a wrap-up, a pull request's…). `others`:
  // some comment queued isn't `item`'s author's, which unqueue() would drop. Null otherwise.
  function queuedTask(key) {
    const task = ctx.tasks.get(key);
    if (!task || task.running || task.live || !task.pending.length) return null;
    const item = task.pending.findLast(
      (i) => i.kind === "issue" && (i.trigger === "work" || !!i.modeLine),
    );
    const replies =
      !item && task.pending.every((i) => i.kind === "issue" && !i.trigger && !i.modeLine);
    const others = !!item && task.pending.some((i) => i !== item && !sameAuthor(i, item));
    return { item: item ?? null, replies, others };
  }

  // queuedTask()'s task out of the queue: { item, dropped }. `item` is returned for its wait
  // (waits.mjs hold()), which keeps that comment's 👀, author and mode line, with the text of
  // every comment its author queued, as the run would have read them (events.mjs
  // commentsText()). The wait has one author, whom the run's checks see (tasks.mjs
  // noLongerAllowed()): another author's comments aren't folded in, but dropped (`dropped`, how
  // many). The others lose their 👀. `by`: who moved it. Null when queuedTask() has no item.
  // `until`: once the wait is in the store, the queue's writes have them till then
  // (restart.mjs park()); `unqueued`, their queueIds, go with the wait (waits.mjs hold()).
  function unqueue(key, by, until = null) {
    const task = ctx.tasks.get(key);
    const held = queuedTask(key)?.item;
    if (!held) return null;
    const own = task.pending.filter((i) => i === held || sameAuthor(i, held));
    const texts = own.map((i) => i.text).filter(Boolean);
    const dropped = task.pending.length - own.length;
    const unqueued = task.pending.map((i) => i.queueId).filter(Boolean);
    // Before dropPending() writes the queue.
    if (until) ctx.park?.(task, [...task.pending], until);
    dropPending(task, key, held);
    log(
      `${key}: taken out of the queue by ${by}, to wait (${dropped} comment(s) by others dropped)`,
    );
    // Queued again once its wait ends (tasks.mjs queue()): its mode, its place in line and no
    // auto-pickup slot then.
    const item = { ...held, text: texts.join("\n\n---\n\n") };
    for (const k of ["mode", "queuedAt", "queueId", "autoPickup"]) delete item[k];
    return { item, dropped, unqueued };
  }

  // GitHub's logins regardless of case; none known (the listener's own items) isn't anyone's.
  const sameAuthor = (a, b) => !!a.author && a.author.toLowerCase() === b.author?.toLowerCase();

  // A work run on an onboarding issue proposes a config for merging: what the listener makes of
  // its branch's .deckhand.yaml goes with the reply.
  function onboardingWork(task) {
    return task.kind === "issue" && ctx.onboarded.isIssue(task.repo, task.number);
  }

  return {
    run,
    follow,
    ending,
    dropRefused,
    cancel,
    queuedTask,
    unqueue,
    rest,
    teardown,
    ...external,
    endExternal: end,
  };
}

// A chat task's id ("chat-<id>") → the chat's.
const chatOf = (task) => task.id.slice("chat-".length);

// A run's record mode once its capabilities are decided (runs.mjs begin()'s reopen()): null when
// the volume they give it has a session as its mode's had (`started`, `now`: whether each has
// one), else what begin() would have said from `now`: a wrap-up and a restored run stay so.
export function reopenedMode({ mode, restored, started, now }) {
  if (now === started) return null;
  if (WRAP_UPS.has(mode)) return "wrap-up";
  if (restored) return "restore";
  return now ? "continue" : "start";
}
