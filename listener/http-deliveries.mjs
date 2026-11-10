// The verified deliveries edge puts on its stream (#1069, from http.mjs): each dispatched to
// onboarding, a pull request's state or a comment, a redelivery replayed as GitHub has it now.
import {
  ciDelivery,
  closedItem,
  pullRequest,
  REFUSED,
  replayedIssue,
  replayedPull,
  touchedItems,
  workItem,
} from "./events.mjs";
import { fetchPull, getJson } from "./github.mjs";
import { QUIET_EVENTS } from "./github-app.mjs";
import { deliveryResult, operatorRefuses } from "./metrics.mjs";
import { onboardingTargets } from "./onboarding.mjs";
import { applyInput, inputEvent } from "./questions.mjs";
import { forgottenFor, refreshFor } from "./repos.mjs";
import { labelAdded, pullClosed } from "./auto-pickup.mjs";
import { staleFor } from "./work.mjs";
import { endPicks } from "./picks.mjs";
import { closedAs } from "./titles.mjs";

// The `issues` actions a redelivery replays as the issue is now (replayIssue()).
const ISSUE_REPLAYS = ["labeled", "unlabeled", "closed", "reopened"];

// `ctx` (../orchestrator/server.mjs): the orchestrator's state and services, read at call time.
export function createDeliveries(ctx) {
  const { config, log } = ctx;

  // The delivery being dispatched, for its metric (metrics.mjs deliveryResult()): whether the
  // operator's checks refused it (its installation and repository, operatorRefuses(); its
  // author, their skip()'s REFUSED, events.mjs), whether it made a work item, whether CI
  // changed. Set and cleared by deliver() in one synchronous turn, which the skip() below relies
  // on: no `await` in between. A redelivery's own dispatch comes later, uncounted.
  let verdict = null;
  const skip = (reason, how) => {
    if (how === REFUSED && verdict) verdict.refused = true;
    return ctx.skip(reason);
  };

  // Comments on their way to the queue: an orchestrator that stops saves them too.
  const admitting = new Set();

  // A verified delivery edge passed on ({ id, event, payload, redelivered }, ../edge/http.mjs):
  // resolves once what it admitted is done (a comment queued, a review considered), so that the
  // orchestrator acknowledges it then, and a copy that stops before reads it again. Its
  // unexpected throw is logged: it never takes the orchestrator down, nor the deliveries after it.
  function deliver({ event, payload, redelivered = false }) {
    const work = [];
    verdict = { event, refused: operatorRefuses(config, event, payload), item: false, ci: false };
    try {
      if (event === "pull_request" && redelivered) replay(event, payload, work);
      else if (event === "issues" && ISSUE_REPLAYS.includes(payload?.action) && redelivered) {
        replayIssue(event, payload, work);
      } else dispatch(event, payload, work);
    } catch (error) {
      (log.error ?? log)(
        `Delivery ${event} ${payload?.action ?? ""} failed: ${error.stack ?? error}`,
      );
    }
    const result = deliveryResult(verdict);
    verdict = null;
    ctx.metrics?.delivery(event, result);
    return Promise.all(work);
  }

  // A redelivered pull request delivery, handled as its pull request is now (events.mjs
  // replayedPull()): its own snapshot may be older than what the orchestrator handled since.
  function replay(event, payload, work) {
    const repo = payload?.repository?.full_name;
    const number = payload?.pull_request?.number;
    if (!repo || !number) return dispatch(event, payload, work);
    work.push(
      admitted(
        fetchPull(ctx.github, repo, number).then((current) => {
          if (!current) {
            return log(`Delivery ${event} ${payload.action}: ${repo}#${number} is gone`);
          }
          log(`Delivery ${event} ${payload.action}: redelivered, as ${repo}#${number} is now`);
          return Promise.all(dispatch(event, replayedPull(payload, current), []));
        }),
      ),
    );
  }

  // An issue or pull request just closed or merged, at `at` (GitHub's time, ms, or null): the
  // questions its task's last run asked before (`keys`: the issue's or pull request's own task,
  // and the one a merged pull request closes) no longer wait (dismissals.mjs). Set aside now,
  // not derived from the closed state later: a comment on a closed issue starts a run, whose
  // questions do wait, and a redelivered `closed` is older than that run.
  function settleQuestions(keys, at) {
    if (!ctx.dismissals) return;
    for (const key of new Set(keys.filter(Boolean))) {
      const aside = ctx.dismissals.setAsideOn(ctx.runs, key, null, at);
      if (aside) log(`${aside}: closed, its last run's questions set aside`);
    }
  }

  // A redelivered `issues` delivery that moves a run's questions or closes something, handled
  // only if the issue still matches it (events.mjs replayedIssue()). One whose issue can't be
  // looked up (a 5xx, a rate limit) is handled as delivered but for the questions: GitHub had
  // its 202 and won't send it again, and a lost `closed` would leave titles, waits and the
  // backlog thinking the issue open. Its questions are left as they are, for a stale delivery
  // must not set aside those of a run that asked since.
  function replayIssue(event, payload, work) {
    const repo = payload?.repository?.full_name;
    const number = payload?.issue?.number;
    if (!repo || !number) return dispatch(event, payload, work);
    const path = `/repos/${repo}/issues/${number}`;
    const said = `Delivery ${event} ${payload.action}`;
    work.push(
      admitted(
        getJson(ctx.github, repo, path, [404, 410]).then(
          (current) => {
            if (!current) return log(`${said}: ${repo}#${number} is gone`);
            const now = replayedIssue(payload, current);
            log(`${said}: redelivered, as ${repo}#${number} is now`);
            return Promise.all(dispatch(event, now, []));
          },
          (error) => {
            log(
              `${said}: redelivered, ${repo}#${number} not looked up (${error.message ?? error}): handled as sent, its questions left as they are`,
            );
            return Promise.all(dispatch(event, payload, [], { questions: false }));
          },
        ),
      ),
    );
  }

  // A verified delivery: onboarding, a pull request's state or a comment. What
  // it admits goes in `work`, returned. `questions: false`: none of the questions' changes
  // (set aside, listed, taken back), for a redelivery whose issue couldn't be looked up.
  function dispatch(event, payload, work, { questions = true } = {}) {
    const admitted = (promise) => work.push(admittedAs(promise));
    const { app } = ctx;
    // CI changed on a commit: the dashboard's CI status of the pull requests at it (pulls.mjs).
    // Not waited for: its GitHub reads would hold the delivery's place, and those behind it (a
    // burst of statuses before a comment); one lost is read again at the next Sync.
    const ci = ciDelivery(config, event, payload);
    if (ci) {
      if (verdict) verdict.ci = true;
      ctx.pulls.ciChanged(ci.repo, ci.sha).catch((error) => log(`CI: ${error.stack ?? error}`));
    }
    // Nothing else to do for them, nor a line each (github-app.mjs QUIET_EVENTS).
    if (QUIET_EVENTS.has(event)) return work;
    log(`Delivery: ${event} ${payload.action ?? ""} from ${payload.sender?.login ?? "?"}`);
    app.remember(payload.repository?.full_name, payload.installation?.id);
    // A default branch that moved, or another one made the default: the repository list and the
    // policies read it again, and its open pull requests are asked soon whether they still merge (conflicts.mjs, and the
    // dashboard's pr.conflict in every repo: pulls.mjs baseMoved()).
    if (refreshFor(event, payload, ctx.repoList.refresh) && payload.repository?.full_name) {
      ctx.policies?.forget(payload.repository.full_name);
      ctx.pulls.baseMoved?.(payload.repository.full_name);
      ctx.conflicts?.soon(payload.repository.full_name)?.catch((error) => {
        log(`Conflicts: ${error.stack ?? error}`);
      });
    }
    // A repository out of the App's reach, deleted, transferred or made private: what the
    // policies kept of it goes now rather than when it expires (repos.mjs forgottenFor()).
    for (const repo of forgottenFor(event, payload)) ctx.policies?.forget(repo);
    // Only the repository list's: nothing runs on a push, nor on a repository's own change.
    if (event === "push" || event === "repository") return work;
    if (event === "installation" || event === "installation_repositories") {
      // Its permissions as they are now: accepting new ones sends `new_permissions_accepted`.
      app.rememberPermissions?.(payload.installation);
      const added = [...(payload.repositories ?? []), ...(payload.repositories_added ?? [])];
      for (const r of added) app.remember(r.full_name, payload.installation?.id);
      const repos = onboardingTargets(config, event, payload, skip);
      if (repos.length) admitted(ctx.onboarding.onboard(repos, payload.sender?.login));
      return work;
    }
    const pr = pullRequest(config, event, payload, Date.now(), skip);
    if (pr && ctx.pulls.record(pr.key, pr.pr))
      log(`${pr.key}: pull request #${pr.pr.number} ${pr.pr.state}`);
    // What comments wait for ("/after #12"): closed issues, merged pull requests.
    const closed = closedItem(config, event, payload, skip);
    if (closed) {
      ctx.titles.setClosed(closed.key, closedAs(closed.state));
      if (closed.state !== "open") {
        // Merged, the issue it closes too; closed without merging, only its own task.
        const target = payload.issue ?? payload.pull_request;
        const at = Date.parse(target?.merged_at ?? target?.closed_at) || null;
        if (questions) settleQuestions([closed.key, closed.state === "done" && pr?.key], at);
        // An auto-picked issue's work is over: a reopen doesn't take its pick back (picks.mjs).
        endPicks(ctx.picks, ctx.runs, [closed.key, pr?.key].filter(Boolean));
        // Its route to a machine, if it had one (claims.mjs forget()).
        ctx.claims?.forget(closed.key);
        // Its stop, and the comments held behind its stopped run (tasks.mjs forgetStopped()):
        // merged, the issue's task too, as its questions.
        for (const key of [closed.key, closed.state === "done" && pr?.key].filter(Boolean)) {
          ctx.forgetStopped?.(key);
        }
      }
      admitted(ctx.waits.closed(closed.repo, closed.number, closed.state));
    }
    // Anything else about what comments wait for, or about the issue a pull request closes,
    // asks GitHub about it again: a merge closes that issue without an `issues` delivery to an
    // App that has no such subscription.
    const touched = touchedItems(config, event, payload);
    for (const n of touched?.numbers ?? []) {
      if (n === closed?.number) continue;
      const { repo } = touched;
      admitted(n === touched.merged ? ctx.waits.merged(repo, n) : ctx.waits.recheck(repo, n));
    }
    // Open questions and answers to them: the needs-input label (questions.mjs).
    const input = questions && inputEvent(config, event, payload, app.identity().name);
    if (input) admitted(applyInput(ctx, input));
    // Nothing runs for an issue being opened, edited, labelled or closed: the graph's backlog
    // is read again now, for its next poll.
    if (event === "issues") {
      staleFor(event, payload, (repo) => ctx.workApi?.stale(repo));
      // Except the auto-pickup label: the next sweep now, rather than within SWEEP_MS.
      if (labelAdded(config, event, payload)) ctx.autoPickup?.soon();
      return work;
    }
    // One of Deckhand's pull requests closed: a repo held by its auto_pickup_max_ready may have
    // room again, the next sweep now.
    if (pullClosed(config, event, payload)) ctx.autoPickup?.soon();
    // A pull request that turned ready, in a repo whose `review.on` asks for a review.
    if (event === "pull_request") admitted(ctx.reviews.consider(event, payload, skip));
    // Deckhand's pull request that turned ready: the reviewers its repo's `review.request` names.
    if (event === "pull_request" && ctx.reviewers) admitted(ctx.reviewers.ready(event, payload));
    // One that turned ready or merged moves its issue on the repo's projects (projects.mjs).
    if (event === "pull_request" && ctx.projects) {
      admitted(ctx.projects.pulled(event, payload));
    }
    // A push to a pull request waiting for CI (`review.ci`): the wait moves to its new head.
    if (event === "pull_request") admitted(ctx.reviews.pushed(event, payload));
    // A merged pull request: the follow-ups its reviews listed, filed as issues.
    if (event === "pull_request") admitted(ctx.reviews.closed(event, payload));
    // A GitHub Actions run that completed on a commit an auto-merge or a review waits on.
    if (event === "workflow_run") admitted(ctx.reviews.checksDone(event, payload));
    // The operator's checks first, so only comments that may run cost a config read.
    const item = workItem(config, event, payload, skip);
    if (item) {
      if (verdict) verdict.item = true;
      item.base = payload.repository?.default_branch;
      admitted(ctx.admit(item, event, payload));
    }
    return work;
  }

  // `promise`'s end, logged when it fails, waited for by an orchestrator that stops.
  function admittedAs(promise) {
    const done = Promise.resolve(promise).catch((error) => log(error.stack ?? error));
    admitting.add(done);
    done.finally(() => admitting.delete(done));
    return done;
  }
  const admitted = admittedAs;

  return { deliver, admitting };
}
