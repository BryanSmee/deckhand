// Runs: one sandbox per run, started, followed and removed through the runner
// (runner/docker.mjs). They run detached, so they outlive a listener restart: the next
// listener picks them up (restart.mjs). Each run's reply, reactions and label once it is over.
// An external run (#597) has no sandbox: a user's machine claimed its task (claims.mjs) and
// reports its life through /mcp, its log's lines, its end; the rest is a sandbox run's.
import { recordUsage, sessionTotals } from "./run-data.mjs";
import { engineNote, recheckMounts, RunError, validateRun } from "./access.mjs";
import { agentFor } from "./agents/index.mjs";
import { authOf, entryLabel, nextFallback, resolved, resolveEntry } from "./agents/select.mjs";
import { ReplyError } from "./comments.mjs";
import { commentsText, dashboardLink, taskKey } from "./events.mjs";
import { GitHubUnavailable, incidentNote } from "./github.mjs";
import { nextStep, replyFooter, setupText } from "./footer.mjs";
import { brainstormDefaults, customMode, entryRun, isApart, isFresh, TALKS } from "./modes.mjs";
import { answersOnly } from "./capabilities.mjs";
import { branchConfigReport } from "./onboarding.mjs";
import { createPreparation } from "./preparation.mjs";
import { openingMessages, promptFor } from "./prompts.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import { isOpen } from "./pulls.mjs";
import { askAfterRun } from "./reviewers.mjs";
import { postReview, reviewStart } from "./reviews.mjs";
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
  needsStamp,
  plainLine,
  writeEvent,
} from "./runlog.mjs";
import { endWait, logSent, QUEUE_RETRY_MS } from "./restart.mjs";
import { sandboxSpec, sessionName, sessionOf } from "./sandbox-spec.mjs";
import { NEEDS_INPUT, asksInput } from "./questions.mjs";
import { countRun, isChat, noLongerAllowed, pickedTask, refusedItems } from "./tasks.mjs";
import { operatorSecrets, redact } from "./secrets.mjs";
import { newLogContext, newRequestId, withLogContext } from "../lib/log.mjs";

// What a run logs, and the calls it makes to the other services, name it (lib/log.mjs), from
// its start or its pick-up after a restart (restart.mjs) to its end: under a request ID of its
// own, not that of whatever happened to start it (a delivery that freed a place, another run's
// end).
// Its run's ID once it has one (task.live).
export const runLogContext = (task) => ({
  request: newRequestId(),
  repo: task.repo,
  issue: task.number,
  run: task.live?.id,
});

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
// How many times in a row the output of a sandbox that exited is followed again after a follow
// that failed (the runner refusing, its stream cut, `docker logs` failing) before the run ends
// with what was read: a Codex sandbox exits as soon as it answers, its result in the last lines.
const EXITED_FOLLOWS = 3;
// The most a run's end waits for its state at the github service, every try included.
const GITHUB_STATE_MS = 10_000;
// A run GitHub kept failing before its sandbox started (GitHubUnavailable, after the App's own
// tries): its comments back in the queue after each of these waits, then its reply says so.
export const GITHUB_REQUEUE_MS = [60_000, 5 * 60_000, 15 * 60_000];

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

  // A line of the sandbox's output without the secrets it must not publish (secrets.mjs):
  // what is stored is what the dashboard shows, and the result is what gets posted.
  // The installation tokens the github service's gateway used for it, by the fingerprints it
  // sent (server.mjs, its `token` events: `scrubs` on the broker's run), though neither the
  // sandbox nor the listener ever had them; redact() also knows their shape (`ghs_…`), for those
  // a restarted listener no longer has, or one cut short, which a fingerprint doesn't find.
  function hidden(live, line) {
    const scrubs = ctx.broker.runOf(live.id)?.scrubs ?? [];
    return scrubs.reduce((text, scrub) => scrub(text), redact(line, secretValues(live)));
  }

  // Its own tokens, the operator's credentials, and any GitHub token the listener's broker lists
  // for it (none since the github service: hidden() has their fingerprints).
  function secretValues(live) {
    const tokens = ctx.broker.runOf(live.id)?.tokens ?? [];
    return [...ctx.broker.secretsOf(live.id), ...operatorSecrets(ctx), ...tokens];
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
    if (at !== null) stamp(live, line, events, at);
    const kept = keep(task, line);
    recordUsage(live.record, line, sessionTotals(ctx.runs, live.record));
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
    // A chat's idle time counts from its answer too (chats.mjs).
    if (isChat(task)) ctx.chats?.answered(task);
    // Comments still in their pause go now, rather than to a new container. A chat's inbox stays
    // open for the user's next message, until it is idle (chats.mjs rest()).
    clearTimeout(task.timer);
    if (!ctx.deliver(task) && !isChat(task)) close(task);
    // Nothing more for it: it should exit now, with this as its answer.
    if (!live.open && !live.cancelled && !live.finishing) {
      live.answered = true;
      enterPhase(live, "wrap-up"); // saved below
      linger(task);
    }
    ctx.saveLive(task);
  }

  // When a tool call, its output or a message came (`at`), for the dashboard's durations and
  // timestamps; setup's output once a second: a line of the listener's before it, so the
  // agent's line stays as it printed it (runlog.mjs reader()).
  function stamp(live, line, events, at) {
    const stamped = fits(live, line) && needsStamp(line, events, at, live.stampedAt ?? null);
    if (stamped) writeEvent(live.logFile, "at", { at });
    // A run of plain lines (runlog.mjs reader()): any other line of the sandbox's ends it.
    if (!plainLine(line, events)) {
      if (line.trim()) live.stampedAt = null;
    } else if (stamped) live.stampedAt = at;
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
    // No sandbox to stop: its end is now, its machine told by its claim's end.
    if (live.external) return void end(task);
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
    // The timer counts on the monotonic clock, whole milliseconds apart from the wall clock's:
    // it can fire a moment before `graceUntil` by Date.now(), the clock the deadline is saved
    // and followed again on. Early, it waits for what's left.
    if (Date.now() < live.graceUntil) return void linger(task, live.graceUntil);
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

  function end(task, error = null) {
    const done = finish(task, error);
    ending.add(done);
    done.finally(() => ending.delete(done));
    return done;
  }

  // Stops the task's run now (a `/cancel` comment, the dashboard's Stop): marked cancelled in
  // its log and saved state first, so a listener restarting before the sandbox exits still
  // knows, then its sandbox is stopped. The follow loop sees it exit and finish() ends the
  // run as cancelled. The task is marked stopped (stopped.mjs): nothing starts on it again
  // until something asks for a run, and comments waiting for a follow-up run wait for that too
  // (tasks.mjs holdStopped()). A task with no run going loses its queued comments instead, and
  // those held since a stop. `by`: who stopped it. Returns "running",
  // "queued" (no run: the task is back in the backlog), "following" (comments behind a run
  // that is ending) or null when there was nothing to stop.
  function cancel(key, by) {
    const task = ctx.tasks.get(key);
    if (!task) return null;
    const live = task.live;
    // An external run (#597): ended now, as cancelled; its machine told at its next heartbeat,
    // which no longer lists its claim.
    if (live?.external && !live.finishing && !live.cancelled) {
      live.cancelled = { by, at: Date.now() };
      live.open = false;
      writeEvent(live.logFile, "cancelled", live.cancelled);
      log(`${key}: cancelled by ${by}`);
      ctx.stopped?.stop(key, by, live.cancelled.at);
      end(task);
      return "running";
    }
    // A machine's claim without a run (claims.mjs): over, its machine told at its next heartbeat.
    if (task.claim && !live && ctx.claims?.cancel(task, by)) {
      ctx.stopped?.stop(key, by);
      return "running";
    }
    if (live && !live.finishing && !live.cancelled) {
      live.cancelled = { by, at: Date.now() };
      // Before its sandbox goes: a comment meanwhile mustn't go on in its session.
      ctx.stopped?.stop(key, by, live.cancelled.at);
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
    if (!task.pending.length && !task.onHold?.length) return null;
    const following = task.running;
    dropPending(task, key);
    log(`${key}: queued comments dropped by ${by}`);
    return following ? "following" : "queued";
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

  // A cancelled run's end: a short reply, no fallback, and nothing put back in the queue
  // (what was delivered went with the run). Its session and pushed commits stay. One stopped
  // after its final answer (output()) posts that answer, which would be lost otherwise.
  async function endCancelled(task) {
    const live = task.live;
    const { key, record } = live;
    const { by } = live.cancelled;
    if (!live.replied) {
      // How long it ran, setup included: it may have no result to say.
      const ran = { durationMs: live.cancelled.at - record.startedAt };
      const footer = replyFooter(record, ran, "", live.later);
      const answer = live.answered && outcome(live.result) !== "error" && live.result.text;
      const text = answer
        ? `${answer}\n\nStopped by @${by} after its answer.\n\n${footer}`
        : `Stopped by @${by}.\n\n${footer}`;
      await post(task, text, "cancelled");
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
      await post(task, text, "error");
      live.replied = true;
      ctx.saveLive(task);
    }
    log(`${key}: done (error, its output past RUN_LOG_MAX_MB)`);
    record.status = "error";
    record.summary = `Stopped as failed: ${why}`;
    record.questions = null;
  }

  // The comment answered last decides where the reply goes (a discussion's thread).
  function target(task, replyTo) {
    return { ...task, replyTo, comment: task.live.handled.at(-1)?.comment };
  }

  // The run's reply. Throws a ReplyError when GitHub doesn't take it, retries included
  // (comments.mjs): finish() then ends the run as failed, `live.replied` still false.
  // `status`: how it ended, for the issue's pointer (pointTo()).
  async function post(task, text, status) {
    const { live } = task;
    // A chat's answers are in its log, which its owner reads: nothing goes to GitHub.
    if (isChat(task)) return;
    // A work run's reply goes on its task's open pull request, whatever started it (#1053):
    // one place for the questions and what changed. Saved before it is posted, so that the
    // next copy, after a handover, posts it there too (an idempotency key is per path).
    const pull = workPull(task);
    if (isOpen(pull) && live.replyTo !== pull.number) {
      live.replyTo = pull.number;
      live.record.replyTo = pull.number;
      await ctx.saveLive(task);
    }
    // Once per run (`live.replied`): asked again after a handover, it isn't posted twice.
    const posted = await ctx.answer(target(task, live.replyTo), hidden(live, text), {
      full: runLink(task),
      key: `${live.id}:reply`,
    });
    if (pull && live.replyTo === pull.number && pull.number !== task.number) {
      await pointTo(task, pull.number, posted, text, status);
    }
  }

  // The task's pull request, for a work run on an issue (one that may push: not a review,
  // a brainstorm, an inbox entry's or a discussion's), or null.
  function workPull(task) {
    const { live } = task;
    if (task.kind !== "issue" || live.mode === "review" || answersOnly(live)) return null;
    return ctx.pulls?.get(live.key) ?? null;
  }

  // The issue's comment for a reply posted on its pull request `number`: where it is, and, for
  // one that doesn't ask, its first line, which the prompt asks to say what changed and what was
  // decided. Its own
  // idempotency key: a handover doesn't post it twice. Not posted is only logged: the reply is.
  async function pointTo(task, number, posted, text, status) {
    const { live } = task;
    const url = await Promise.resolve(posted?.json?.())
      .then((c) => c?.html_url ?? null)
      .catch(() => null);
    const reply = url ? `[the reply](${url})` : "the reply";
    const lead =
      status === "needs-input"
        ? `Waiting for your input on #${number}: its questions are in ${reply}.`
        : `Replied on #${number}: ${reply}.`;
    // Its questions are what a reply that asks starts with: the pointer says where they are.
    const gist = status === "needs-input" ? null : summaryOf({ text: hidden(live, text) });
    await ctx
      .answer(
        { ...task, replyTo: task.number, comment: null },
        gist ? `${lead}\n\n> ${gist}` : lead,
        {
          key: `${live.id}:issue-note`,
        },
      )
      .catch((error) =>
        log(`${live.key}: its pointer on #${task.number}: ${error.message ?? error}`),
      );
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
    // Its agent's requests for more permissions still waiting: denied, its agent gone (#479).
    ctx.requests?.ended(live.id);
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
      const status = outcome(live.result);
      // What its agent's calls last got, from the models service (#504), for an error's
      // fallback and reply.
      // An external run's agent called its own provider, not Deckhand's.
      const api =
        status === "error" && !live.replied && !live.external
          ? await ctx.models.apiOf(live.id)
          : {};
      const { apiStatus, apiReset } = api;
      live.apiError = api.apiError ?? null;
      // Not a chat's: its messages would all be sent again to the next entry.
      // Nor an external run's: its machine runs the agent it has.
      const fallback =
        status === "error" && !live.replied && !isChat(task) && !live.external
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
        // GitHub's own 5xx: whether its status page reported an incident then (#943).
        const said = error.status >= 500 ? await githubSaid() : null;
        record.summary = `The reply couldn't be posted: ${error.reason}${said ? `. ${said}` : ""}`;
        record.questions = null;
        writeEvent(live.logFile, "note", { message: `${record.summary} (${error.message})` });
      } else if (error instanceof GitHubUnavailable) {
        const gaveUp = await githubDown(task, error);
        if (gaveUp && !live.replied && !isChat(task)) {
          await ctx.answer(target(task, live.asked), gaveUp).catch((e) => log(`${key}: ${e}`));
        }
      } else log(`${key}: ${error.stack ?? error}`);
      if (error instanceof RunError && !live.replied) {
        // A chat's owner reads it in the conversation.
        if (isChat(task)) writeEvent(live.logFile, "note", { message: error.message });
        else {
          await ctx
            .answer(target(task, live.asked), error.message)
            .catch((e) => log(`${key}: ${e}`));
        }
      }
    } finally {
      // Its outcome as its `done (…)` line says, or "error" for a run that failed before it.
      ctx.metrics?.runFinished(live);
      await cleanUp(task);
    }
  }

  // GitHub failing a call the run's start needed (GitHubUnavailable): the run ends as failed,
  // its log and the dashboard saying why, and its comments go back in the queue for a run
  // GITHUB_REQUEUE_MS later (`live.retryAt`, cleanUp()), keeping their 👀. Its summary, log and
  // reply say whether GitHub's status page reported an incident then (#943). → the reply's text
  // once those tries are over, else null.
  async function githubDown(task, error) {
    const { live } = task;
    const delays = ctx.githubRequeueMs ?? GITHUB_REQUEUE_MS;
    const tries = Math.max(0, ...live.handled.map((item) => item.githubTries ?? 0));
    const ms = delays[tries];
    const status = error.status >= 500 ? await githubStatus() : null;
    const said = incidentNote(status);
    const then = said ? `. ${said}` : "";
    if (ms === undefined) {
      live.record.summary = `Failed: ${error.message}${then}`;
      log(`${live.key}: done (error, GitHub unavailable): ${error.message}, ${tries + 1} tries`);
      writeEvent(live.logFile, "note", {
        message: `Failed: ${error.message}, ${tries + 1} tries${then}`,
      });
      for (const item of live.handled) delete item.githubTries;
      const linked = incidentNote(status, { links: true });
      return `${agentOf(task).displayName} couldn't start: ${error.message}, ${tries + 1} times.${linked ? ` ${linked}` : ""} Comment again once GitHub answers.`;
    }
    const later = ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${minutes(ms)} min`;
    live.record.summary = `Failed: ${error.message}. Tried again in ${later}${then}`;
    log(`${live.key}: done (error, GitHub unavailable): ${error.message}, tried again in ${later}`);
    writeEvent(live.logFile, "note", { message: live.record.summary });
    for (const item of live.handled) item.githubTries = tries + 1;
    task.pending.unshift(...live.handled.filter((item) => !task.pending.includes(item)));
    live.retryAt = Date.now() + ms;
    return null;
  }

  // GitHub's own status as the github service last read it (GET /status), or null when it can't
  // say: a failed run's outcome goes without it rather than waiting.
  function githubStatus() {
    return Promise.resolve()
      .then(() => ctx.githubStatus?.() ?? null)
      .catch((e) => {
        log(`GitHub's status: ${e.message ?? e}`);
        return null;
      });
  }

  const githubSaid = async () => incidentNote(await githubStatus());

  // The provider failed: the run's comments go back in the queue, marked for the next entry of
  // FALLBACKS (entryFor()), with the last result for the agent that takes over. No reply:
  // the next run's says what happened. Queued, they keep their 👀 and survive a restart.
  function fallBack(task, fallback) {
    const { live } = task;
    const result = (live.result?.text ?? "").slice(0, 4000);
    fallback.summary = `${entryLabel(fallback.from)}'s provider failed: ${fallback.reason}. Falling back to ${entryLabel(fallback.entry)}`;
    log(`${live.key}: ${fallback.summary}`);
    ctx.fallbacks?.inc({ from: fallback.from, to: resolved(config, fallback.entry) });
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
    const apiError = live.apiError;
    const why = apiError ? `Its last failed API call, through Deckhand: ${apiError}.\n\n` : "";
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
        {
          allowed,
          full: runLink(task),
          from: live.reviewFrom ?? null,
          followUps: task.settings?.review?.followUps !== false,
        },
      );
      log(`${live.key}: review posted on #${live.replyTo} (${posted.event ?? "as a comment"})`);
      live.reviewed = { number: live.replyTo, posted, auto };
    } else await post(task, text, status);
    live.replied = true;
    ctx.saveLive(task);
    // Runs that only answer (no `push`) ask questions all along: no label for those.
    if (status === "needs-input" && config.needsInputLabel && !answersOnly(live)) {
      await ctx.label(task.repo, task.number, true);
    }
  }

  // The run's state at the github service, within GITHUB_STATE_MS in all (its client tries a
  // service that is away again until then): the run holds its slot meanwhile. Not read: logged,
  // so that a CI step counting reruns from the run's own copy (cleanUp()) can be traced to it.
  async function githubState(live) {
    if (!ctx.githubRunState) return null;
    try {
      return await ctx.githubRunState(live.id, { waitMs: GITHUB_STATE_MS });
    } catch (error) {
      log(
        `${live.key}: its state at the github service not read (${error.message}): its reruns are as the run started`,
      );
      return null;
    }
  }

  // Whether the run's summary is in the store, tried again every QUEUE_RETRY_MS until it is, or
  // this copy stops. Its first failure is logged, and the try that lands: not every 5 s of a
  // long outage. Meanwhile the run is one whose end waits (restart.mjs endWait()): /ready and
  // the dashboard's status page say it, the log again every 10 min.
  async function summarySaved(live) {
    const retryMs = ctx.queueRetryMs ?? QUEUE_RETRY_MS;
    const wait = endWait(ctx, live, "summary");
    let tries = 0;
    const once = (line) => tries === 1 && log(line);
    try {
      for (;;) {
        tries++;
        const saved = await saveSummary(ctx.store, live.record, {
          log: once,
          secrets: ctx.storeSecrets?.(),
          failed: wait.failed,
        });
        if (saved) break;
        if (ctx.stopping || !(ctx.held?.() ?? true)) {
          log(
            `${live.key}: its summary not saved as this copy stops: the run stays for the next one`,
          );
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs).unref?.());
      }
    } finally {
      wait.done();
    }
    if (tries > 1) log(`${live.key}: its summary saved, at try ${tries}`);
    return true;
  }

  // A run's end, however it ends (cleanUp(), restart.mjs requeue()): its record's summary
  // saved, its token, sandbox and saved state gone, its slot free. → false when this copy stops
  // before its summary is saved: the run is left to the next one.
  async function teardown(task) {
    const live = task.live;
    live.record.phase = null;
    // An external run has no state at the github service, no tokens, no sandbox (#597).
    if (!live.external) {
      // What it did on GitHub, the github service's: its reruns, for the CI step (cleanUp()).
      const state = await githubState(live);
      if (Array.isArray(state?.reruns)) live.reruns.splice(0, live.reruns.length, ...state.reruns);
      if (Array.isArray(state?.created))
        live.created.splice(0, live.created.length, ...state.created);
      // The broker service hears it first, so its tokens renew nowhere once its network goes; a
      // broker that doesn't answer soon is told again later (broker-service.mjs end()).
      const revoked = ctx.broker.revoke(live.id);
      await Promise.race([revoked, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
    }
    live.record.finishedAt = Date.now();
    // Its summary before anything of the run goes: tried again while the store is away, as the
    // orchestrator keeps it nowhere else (#619). A copy that stops meanwhile leaves the run's
    // sandbox and state for the next copy to end again; its tokens are revoked already (above),
    // which an ended run no longer needs.
    if (!(await summarySaved(live))) return false;
    // What it wrote last, at the runner before its state goes, and its last segment closed
    // there after it (../runner/logs.mjs).
    await logSent(live);
    live.logFile?.close?.();
    if (!live.external) {
      await ctx.runner.remove(task.name, live.id).catch((e) => log(`${live.key}: ${e}`));
    }
    live.over = true;
    clearTimeout(live.soon);
    await live.saving;
    // Its machine's claim ends with it, in the queue's write below: its next heartbeat no longer
    // lists it.
    if (live.external && task.claim?.id === live.id) task.claim = null;
    // What it puts back in the queue (unanswered comments, a fallback's) is saved before its
    // own state goes, tried again until it is (restart.mjs removeLive()): a listener killed
    // between the two finds them in both, and the run's win. A stopped run's follow-up comments
    // wait for the next trigger (tasks.mjs holdStopped()), in that same write.
    if (live.cancelled) ctx.holdStopped?.(task);
    await ctx.removeLive(task);
    task.live = null;
    task.running = false;
    countRun(ctx, task, -1);
    // Its machine's requests waiting on it answer, and its machine may claim again.
    if (live.external) ctx.claims?.wake();
    return true;
  }

  // The run is over (teardown()), its comments get their outcome's reaction, and the task's
  // next run starts after the usual pause.
  async function cleanUp(task) {
    const live = task.live;
    const { key, mode, light, record, reviewed } = live;
    if (!(await teardown(task))) return;
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
    // A conflict run that is over: the review loop goes on from what it pushed (reviews.mjs
    // rebased()), its decision marking the loop at once (looping()).
    const rebaseRun = live.handled.find(
      (item) => item.reason === "conflict" && !task.pending.includes(item),
    );
    if (rebaseRun) {
      ctx.reviews
        ?.rebased({
          repo: task.repo,
          number: rebaseRun.replyTo,
          base: task.base,
          status: record.status,
          from: rebaseRun.rebaseFrom ?? null,
        })
        .catch((error) => log(`${key}: after the rebase run: ${error.stack ?? error}`));
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
    if (task.kind !== "discussion" && !isChat(task)) {
      ctx.waits
        ?.recheck(task.repo, task.number)
        .catch((error) => log(`${key}: what waits for it: ${error.message ?? error}`));
    }
    // Comments the run could not take go out together, after the usual pause.
    // Or when GitHub may answer again (githubDown()).
    if (task.pending.length) ctx.startLater(task, live.retryAt ?? undefined);
    ctx.schedule();
    // A slot is free: the next labelled issue, without waiting for the next sweep. Any run's
    // end, not only an auto-picked one's: its repo's own max_parallel may have held a labelled
    // issue back. soon() batches them, and does nothing without reserved slots.
    ctx.autoPickup?.soon();
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

  // --- External runs (#597) ----------------------------------------------------------------

  // A machine's claim (claims.mjs take()), its comments `items` taken: its run, with the record,
  // log, reactions and label of a sandbox run's, though nothing of Deckhand's starts. `work`:
  // what the claim returns (its run's id, mode, first message); `m`: the machine; `reported`:
  // the agent, model and effort its driver says it runs ({ agent, model, effort }, each or none);
  // `settings`: the repo's, as the claim read them.
  function startExternal(task, items, work, m, reported = {}, settings = null) {
    return newLogContext({ ...runLogContext(task), run: work.run }, () => {
      countRun(ctx, task, 1);
      task.settings = settings;
      task.settingsAt = Date.now();
      const external = { machine: m.id, name: m.name, owner: m.owner };
      const live = newLive(task, items, { id: work.run, external });
      task.live = live;
      const { record, logFile } = live;
      Object.assign(record, {
        agent: agentFor(reported.agent).name,
        model: reported.model ?? null,
        effort: reported.effort ?? null,
        machine: m.name,
        // How its agent runs there, as the machine reports it (#599): never checked.
        setup: reported.setup ?? null,
        mode: work.resume ? "continue" : "start",
      });
      addRun(ctx, record);
      log(
        `${live.key}: running on ${m.owner}'s ${m.name} (${live.mode}, ${record.mode}, ${record.agent}${record.model ? ` ${record.model}` : ""}), log ${record.id}`,
      );
      logFile.write(JSON.stringify({ type: "listener", ...record, message: work.message }) + "\n");
      ctx.metrics?.runStarted(live);
      writeEvent(logFile, "session", { mode: record.mode, capabilities: null });
      writeEvent(logFile, "note", {
        message: `Claimed by ${m.owner}'s machine ${m.name}: its agent runs there, its lines reported through /mcp.`,
      });
      if (record.setup) {
        writeEvent(logFile, "note", {
          message: `As ${m.name} reports it, not checked by Deckhand: ${setupText(record.setup)}.`,
        });
      }
      enterPhase(live, "work");
      live.open = true;
      // In its saved state before they leave the saved queue, as a sandbox run's (restart.mjs).
      if (ctx.take) ctx.take(task, items);
      else ctx.saveLive(task);
      // As start() does: a new comment answers the questions, the issue no longer waits.
      if (config.needsInputLabel && task.kind === "issue") {
        ctx.track?.(
          Promise.resolve(ctx.label(task.repo, task.number, false)).catch((error) =>
            log(`${live.key}: its label: ${error.message ?? error}`),
          ),
        );
      }
      ctx.projects
        ?.started(task, (message) => writeEvent(logFile, "note", { message }), [])
        .catch((error) => log(`${live.key}: projects: ${error.stack ?? error}`));
      return live;
    });
  }

  // The agent's stream-json lines `lines` its machine reports (post_events), from the line
  // `from` of its output (null: after those it had), into the run's log as a sandbox's output
  // is: redacted, timed, cut at RUN_LOG_MAX_MB, its phases, its results. Lines it had already (a
  // driver sending again what a handover may have lost) are skipped. → how many it has now.
  async function externalLines(task, lines, from = null) {
    const live = task.live;
    const had = live.lines.out;
    const skip = from === null ? 0 : had - from;
    if (skip < 0) {
      throw new RangeError(`Lines from ${from} sent, but the run has ${had}: send from ${had}.`);
    }
    for (const raw of lines.slice(skip)) {
      if (task.live !== live || live.finishing || live.overflow) break;
      externalLine(task, raw);
    }
    // Saved before the machine is told: a handover never loses a line it was told was taken.
    if (task.live === live && !live.over) await ctx.saveLive(task);
    return live.lines.out;
  }

  function externalLine(task, raw) {
    const live = task.live;
    const line = hidden(live, String(raw));
    const events = agentOf(task).normalize(line);
    const phase = fits(live, line) ? phaseOf(live.logPhase, events) : null;
    if (phase) enterPhase(live, phase);
    // Stamped as it comes, on the orchestrator's clock rather than the machine's: its driver
    // sends each line as its agent prints it, batching only those printed while a call is out.
    stamp(live, line, events, Date.now());
    const kept = keep(task, line);
    recordUsage(live.record, line, sessionTotals(ctx.runs, live.record));
    live.lines.out++;
    if (!kept) return;
    const event = events.findLast((e) => e.type === "result");
    if (!event) return;
    // One result per turn, as output()'s; the comments still in their pause go now, or its
    // inbox closes and the agent ends with this as its answer.
    live.result = { ...event, durationMs: (live.result?.durationMs ?? 0) + event.durationMs };
    live.unanswered = [];
    clearTimeout(task.timer);
    if (!ctx.deliver(task)) close(task);
  }

  // A message for the external run's agent (tasks.mjs deliver()): in its outbox, which its
  // machine reads (claims.mjs nextMessage()).
  function sendExternal(task, message) {
    task.live.outbox.push(message);
    ctx.claims?.wake();
  }

  // Its machine says it is over (finish, or ask: `outcome` "needs-input"): `reply`, or its last
  // result's text, posted as the App, then the end of a sandbox run's (finish(), cleanUp()).
  // `outcome`: "ok", "error" or "needs-input", the reply's marker added for the last.
  function finishExternal(task, { outcome: said = "ok", reply = null } = {}) {
    const live = task.live;
    let text = reply ?? live.result?.text ?? "";
    if (said === "needs-input" && !asksInput(text)) text = `${NEEDS_INPUT}\n\n${text}`;
    // How long its agent's turns took, as its results said; the whole claim without one.
    const durationMs = live.result?.durationMs ?? Math.max(0, Date.now() - live.record.startedAt);
    live.result = { ...live.result, type: "result", ok: said !== "error", text, durationMs };
    writeEvent(live.logFile, "note", { message: `Its machine says it is over (${said}).` });
    enterPhase(live, "wrap-up");
    live.answered = true;
    return end(task);
  }

  // The external run ends as interrupted (its machine released its claim, or its lease ran out,
  // or the machine was removed: claims.mjs giveBack()): its issue told, its comments back first
  // in the queue for that machine's next claim, as a sandbox that never started (restart.mjs
  // requeue()).
  async function interruptExternal(task, why) {
    const live = task.live;
    if (!live?.external || live.finishing) return;
    live.open = false;
    live.finishing = true;
    // Its agent's requests still waiting: denied, as a sandbox run's that ends (#600).
    ctx.requests?.ended(live.id);
    const { key, record } = live;
    record.status = "interrupted";
    record.summary = `Interrupted: ${why}`;
    record.questions = null;
    writeEvent(live.logFile, "note", { message: record.summary });
    log(`${key}: done (interrupted: ${why})`);
    task.pending.unshift(...live.handled.filter((item) => !task.pending.includes(item)));
    ctx.metrics?.runFinished(live);
    if (task.kind === "issue") {
      const text = `${live.external.name}'s run was interrupted: ${why}. Its comments wait for that machine's next claim; \`/machine none\` sends the issue back to sandboxes.`;
      await Promise.resolve(ctx.reply(task.repo, task.number, text)).catch((error) =>
        log(`${key}: ${error.message ?? error}`),
      );
    }
    if (!(await teardown(task))) return;
    if (task.pending.length) ctx.startLater(task, 0);
    ctx.schedule();
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
    startExternal,
    endExternal: end,
    externalLines,
    sendExternal,
    finishExternal,
    interruptExternal,
  };
}

// A chat task's id ("chat-<id>") → the chat's.
const chatOf = (task) => task.id.slice("chat-".length);

// A run's record mode once its capabilities are decided (runs.mjs begin()'s reopen()): null when
// the volume they give it has a session as its mode's had (`started`, `now`: whether each has
// one), else what begin() would have said from `now`: a wrap-up and a restored run stay so.
export function reopenedMode({ mode, restored, started, now }) {
  if (now === started) return null;
  if (mode === "stop") return "wrap-up";
  if (restored) return "restore";
  return now ? "continue" : "start";
}
