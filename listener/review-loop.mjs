// Where a pull request's review loop is (reviews.mjs), from its entry in the orchestrator's
// store (`reviews`): its rounds for the dashboard (reviewLoop(), loopState()), and the loop's
// steps among the queued tasks (stepsGoing()).
import { sameRepo } from "./events.mjs";

// How many fix runs a pull request's entry (`reviews`) counts: `fixes`, or 1 in an entry
// from before the rounds (fixedAt); and how many of them had their review queued (fixed()),
// the round of an old entry with rereviewAt over.
export const fixesOf = (entry) => entry?.fixes ?? (entry?.fixedAt ? 1 : 0);
export const reviewedFixesOf = (entry) => entry?.reviewedFixes ?? (entry?.rereviewAt ? 1 : 0);

// Where the fix loop of a pull request is, for the dashboard (board.mjs), from its entry in
// `reviews` and `step`, the reason of its task's run going or queued ("review",
// "review-fix", "ci-fix", "conflict"; null for none, or a maintainer's comment) → { loop, round,
// rounds, history, manual? } or null when Deckhand never reviewed it. `loop`:
//   reviewing, fixing  a review or fix run of the loop is queued or running
//   ci-fix             a CI fix run (`review.ci`) is queued or running
//   rebasing           a conflict run (conflicts.mjs) is queued or running on a pull request
//                      the loop reviewed: its end reviews the rebased head (rebased())
//   ci                 the review waits for the head commit's Actions runs (`review.ci`)
//   ci-failed          CI failed and the CI step stopped without a review: a CI fix run was
//                      refused, failed or pushed nothing (`ciStopped`), and no maintainer's
//                      review came since
//   checks             the auto-merge waits for the reviewed commit's Actions runs
//   clean              the last review had nothing above the tolerance
//   rounds-out         the review after the last fix run `review.fix` allows still blocks
//   fixed              a fix run followed the last review, and by design nothing reviews it
//                      (`review.fix: true` without `merge`): what that review found isn't
//                      known to be left
//   stopped            it still blocks, and no more fix run comes: one ended badly or pushed
//                      nothing, a policy refused it, the task was busy or waits for input
// `settling`: the task's last run ({ reason, startedAt }) when it was one of the loop's and is
// over: while the listener decides what follows it, its `next` step is still that one
// (nextStep()), and the loop is still there. Only the step's own run: one started after the
// step was queued (`nextAt`), not an earlier run of the same kind when the step queued since
// never ran (cancelled, refused). `entry.deciding`: the listener is deciding about the loop's
// step right now (createReviews() entry()): it is there too.
// `round`: the fix runs started so far (0 for the first review), of `rounds` the repo allows;
// `history`: each review's { round, at, head, counts, blocking, followUps, comments: { blocking,
// notes }, comment?, commentId?, manual? } (recordRound()), oldest first;
// `manual`: true when no loop ran, only maintainers' reviews (the dashboard's "Reviews").
export function reviewLoop(entry, step = null, { settling = null } = {}) {
  const history = entry?.rounds ?? [];
  // A conflict run is the loop's only on a pull request the loop reviewed (rebased()).
  if (step === "conflict" && !entry?.head) step = null;
  if (!step && entry?.deciding) step = entry.deciding;
  const own = settling && settling.startedAt >= (entry?.nextAt ?? 0);
  if (!step && own && entry?.next === settling.reason) step = settling.reason;
  // "ci": the CI step being decided (ciRecheck()), its wait cleared before what follows is queued.
  const looping = LOOP_STEPS.includes(step) || step === "ci" || !!entry?.ciWaiting;
  if (!history.length && !looping && !entry?.ciStopped) return null;
  const fixes = fixesOf(entry);
  const rounds = entry?.fixRounds ?? 0;
  const last = history.at(-1);
  const manual = !looping && !fixes && !entry?.ciStopped && history.every((r) => r.manual);
  const at = {
    round: looping ? fixes : (last?.round ?? fixes),
    rounds,
    history,
    ...(manual && { manual }),
  };
  if (step === "review") return { loop: "reviewing", ...at };
  if (step === "review-fix") return { loop: "fixing", ...at };
  if (step === "ci-fix") return { loop: "ci-fix", ...at };
  if (step === "conflict") return { loop: "rebasing", ...at };
  if (step === "ci" || entry?.ciWaiting) return { loop: "ci", ...at };
  // A maintainer's review of that head since (recordRound()) is the latest: the loop goes by
  // it. Not an older head's review that ended after CI stopped on a push. The mark stays, for
  // consider(): ready again at that head runs the CI step again.
  const ci = entry?.ciStopped;
  if (ci && !(last && last.head === ci.sha && last.at > (ci.at ?? 0))) {
    return { loop: "ci-failed", ...at };
  }
  if (entry.waiting && !entry.mergeAt) return { loop: "checks", ...at };
  if (!last.blocking) return { loop: "clean", ...at };
  if (entry.unreviewedFix === fixes && last.round < fixes) {
    return { loop: "fixed", ...at, round: fixes };
  }
  // The review of the last fix run is the last one: nothing more was started after it.
  const out = fixes >= rounds && last.round >= fixes;
  return { loop: out ? "rounds-out" : "stopped", ...at };
}

// The loop of a task's pull request (`entry`, reviewed()) as reviewLoop() has it, from the
// task's last run `last` (its step while it runs; once over, the step the listener said is on
// its way) and the reason of its queued run (`queued`), if any: the dashboard's `review`
// (board.mjs) and whether an auto-picked task keeps its slot between steps (tasks.mjs).
export function loopState(entry, last, queued = null) {
  const running = last?.status === "running" ? last.reason : null;
  const step = [running, queued].find((r) => LOOP_STEPS.includes(r)) ?? null;
  const settling = last?.status === "ok" && LOOP_STEPS.includes(last.reason) ? last : null;
  return reviewLoop(entry, step, { settling });
}

// reviewLoop()'s states between two of the loop's runs: the task is in review (board.mjs), and
// an auto-picked one keeps its reserved slot (tasks.mjs loopGoing()).
export const LOOPING = ["reviewing", "fixing", "checks", "ci", "ci-fix", "rebasing"];

// The reasons of the loop's own runs, and a conflict run's, whose end the loop goes on from
// (rebased(); reviewLoop() counts it only on a pull request the loop reviewed).
export const LOOP_STEPS = ["review", "review-fix", "ci-fix", "conflict"];

// Which pull requests have a review or fix run of their loop running or queued, among `tasks`
// (tasks.mjs, their `pending` items and their live run's `handled` ones) → going(repo, number),
// for forgetSteps(). Both items reply on the pull request.
export function stepsGoing(tasks) {
  return (repo, number) =>
    [...tasks.values()].some(
      (t) =>
        sameRepo(t.repo, repo) &&
        [...(t.pending ?? []), ...(t.running ? (t.live?.handled ?? []) : [])].some(
          (item) => LOOP_STEPS.includes(item.reason) && item.replyTo === number,
        ),
    );
}
