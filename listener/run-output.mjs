// A run's sandbox's output (runs.mjs follow()): redacted, timed, written to its log up to
// RUN_LOG_MAX_MB, its phases and results; a run that answered stopped once silent (linger()).
import { recordUsage, sessionTotals } from "./run-data.mjs";
import { enterPhase, minutes, needsStamp, phaseOf, plainLine, writeEvent } from "./runlog.mjs";
import { isChat } from "./tasks.mjs";
import { operatorSecrets, redact } from "./secrets.mjs";

// `ctx` (server.mjs), and what it calls of the run's other parts (runs.mjs createRuns()).
export function createRunOutput(ctx, { graceMs, agentOf, close, end }) {
  const { config, log } = ctx;

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

  return { hidden, output, stamp, keep, fits, overflowMessage, linger };
}
