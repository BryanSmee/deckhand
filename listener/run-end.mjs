// A run's end (runs.mjs follow()): cancelled, overflowed, failed or done, its reply
// (run-replies.mjs), then its teardown, its comments' reactions, and what comes after it.
import { RunError } from "./access.mjs";
import { nextFallback } from "./agents/select.mjs";
import { ReplyError } from "./comments.mjs";
import { GitHubUnavailable } from "./github.mjs";
import { replyFooter } from "./footer.mjs";
import { WRAP_UPS } from "./modes.mjs";
import { askAfterRun } from "./reviewers.mjs";
import { outcome, questionsOf, saveSummary, summaryOf, writeEvent } from "./runlog.mjs";
import { endWait, logSent, QUEUE_RETRY_MS } from "./restart.mjs";
import { countRun, isChat } from "./tasks.mjs";

// The most a run's end waits for its state at the github service, every try included.
const GITHUB_STATE_MS = 10_000;

// `ctx` (server.mjs), and what it calls of the run's other parts (runs.mjs createRuns()).
export function createRunEnd(
  ctx,
  {
    agentOf,
    overflowMessage,
    dropPending,
    post,
    target,
    fallBack,
    postReply,
    githubSaid,
    githubDown,
  },
) {
  const { config, log } = ctx;

  // Ends under way: a listener that stops lets them post their reply first, so the next one
  // doesn't post it again.
  const ending = new Set();

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
      // Its workflow's next steps, if it waited for the run (conflicts.mjs ended()).
      ctx.conflicts?.ended({
        key,
        repo: task.repo,
        number: rebaseRun.replyTo,
        base: task.base,
      });
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
        : WRAP_UPS.has(mode)
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

  return { end, ending, cancel, teardown };
}
