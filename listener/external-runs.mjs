// External runs (#597): a user's machine claimed its task (claims.mjs) and reports its life
// through /mcp, its log's lines, its end; the rest is a sandbox run's (runs.mjs).
import { agentFor } from "./agents/index.mjs";
import { recordUsage, sessionTotals } from "./run-data.mjs";
import { setupText } from "./footer.mjs";
import { addRun, enterPhase, phaseOf, writeEvent } from "./runlog.mjs";
import { NEEDS_INPUT, asksInput } from "./questions.mjs";
import { countRun } from "./tasks.mjs";
import { runLogContext } from "./runs.mjs";
import { newLogContext } from "../lib/log.mjs";

// `ctx` (server.mjs), and what it calls of the run's other parts (runs.mjs createRuns()).
export function createExternalRuns(
  ctx,
  { newLive, agentOf, hidden, fits, stamp, keep, close, end, teardown },
) {
  const { config, log } = ctx;

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

  return { startExternal, externalLines, sendExternal, finishExternal, interruptExternal };
}
