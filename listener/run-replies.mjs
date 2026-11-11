// A run's replies on GitHub (run-end.mjs finish()): its answer, a review's, the issue's pointer
// to a reply on its pull request; a provider's failure handed to the next entry, GitHub's
// failing the run's start.
import { entryLabel, resolved } from "./agents/select.mjs";
import { dashboardLink, taskKey } from "./events.mjs";
import { incidentNote } from "./github.mjs";
import { nextStep, replyFooter } from "./footer.mjs";
import { isFresh } from "./modes.mjs";
import { answersOnly } from "./capabilities.mjs";
import { branchConfigReport } from "./onboarding.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import { isOpen } from "./pulls.mjs";
import { postReview } from "./review-post.mjs";
import { minutes, summaryOf, writeEvent } from "./runlog.mjs";
import { isChat } from "./tasks.mjs";

// A run GitHub kept failing before its sandbox started (GitHubUnavailable, after the App's own
// tries): its comments back in the queue after each of these waits, then its reply says so.
export const GITHUB_REQUEUE_MS = [60_000, 5 * 60_000, 15 * 60_000];

// `ctx` (server.mjs), and what it calls of the run's other parts (runs.mjs createRuns()).
export function createRunReplies(ctx, { agentOf, hidden, reviewTolerance, onboardingWork }) {
  const { config, log } = ctx;

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

  async function configCheck(task) {
    if (!onboardingWork(task)) return null;
    try {
      return await branchConfigReport(
        ctx.github,
        config,
        task.repo,
        task.number,
        ctx.policies,
        ctx.workflows,
      );
    } catch (error) {
      log(`${taskKey(task.repo, task.id)}: checking the branch's config: ${error.stack ?? error}`);
      return `⚠️ The listener couldn't check the branch's \`${CONFIG_FILE}\`: ${error.message}`;
    }
  }

  return { target, post, githubDown, githubSaid, fallBack, postReply };
}
