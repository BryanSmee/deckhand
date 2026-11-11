// Pull request reviews (the built-in `review` mode, opt-in with a repo's `review` block): when
// one starts by itself, and the GitHub review the listener posts from the run's final message.
// The run's token only reads, so a prompt-injected diff can't write anything: the listener
// posts the review with its own. It reads the thread the listener hands it (reviewThread()),
// without what users outside the allowlist wrote: with `review.fix`, its findings become the
// message of a run that can push (docs/security/github.md#review-fix-runs).
//
// No loops: each pull request's reviewed head commit is kept in the orchestrator's store
// (`reviews`, lib/store-map.mjs), so a redelivered
// webhook, a restart or the same commit again never pays for a second review. The App's own
// review is a bot's `pull_request_review`, which workItem() ignores: a "request changes"
// starts nothing by itself. With `review.fix`, a review that requests changes starts a work
// run that addresses it, and the listener reviews what it pushed (fixed()): review, fix,
// review, as many fix runs as `review.fix` says (`true`: one; at most the operator's
// MAX_FIX_ROUNDS), each counted in its entry (`fixes`) before it is queued. Its push is a
// `synchronize`, which starts no review by itself. The loop stops at a review with nothing
// above `review.max_allowed_severity`, when the rounds run out (roundsOut()), or at a fix that
// ended badly, a policy's refusal, a busy task or one waiting for input: at most N fix runs
// and N reviews after them, kept across restarts. Once it is over, a maintainer's Fix on the
// dashboard (work.mjs) grants one more round at a time (`grantedTo`), counted the same way.
//
// Auto-merge (`review.merge`, with the operator's `auto_merge` grant): the listener,
// never a sandbox, merges Deckhand's pull request after a review with nothing blocking, at the
// reviewed head commit, once its gates pass (mergeRefusal()). The review that ends the fix
// loop decides it: the merge or a comment saying why not (mergeAt), once per pull request.
// GitHub Actions runs still going on the reviewed commit defer that decision (`waiting`)
// rather than refuse it, until they complete or `review.merge_wait` runs out.
//
// CI first (`review.ci: wait`): an automatic review waits for the GitHub Actions runs on the
// head commit (`ciWaiting`), decided again when one completes or by tick(). Passed (or none):
// the review. Failed: no review, a comment naming the failed runs, and with `review.fix` a CI
// fix run (`ci-fix`), counted apart (`ciFixes`, at most `review.ci_fix`), whose push goes back
// to waiting. Out of CI fix runs, or `review.ci_wait` minutes gone: the review anyway.
import { ciState, PASSED } from "./ci.mjs";
import { ensureLabel, waitsForInput } from "./comments.mjs";
import { repoAllowed } from "./config.mjs";
import {
  headInRepo,
  linkedIssue,
  linkTo,
  MARKER,
  parseKey,
  prId,
  REFUSED,
  sameRepo,
  taskKey,
} from "./events.mjs";
import { allowed, isBot } from "./auto-pickup.mjs";
import { autoMergeProblems } from "./grants.mjs";
import { getJson, paginate } from "./github.mjs";
import {
  DECISIONS,
  OPERATOR_ONLY,
  denyKept,
  INPUT_VERSION,
  isPolicyError,
  passed,
} from "./policies.mjs";
import {
  above,
  BLOCKING,
  blockingComments,
  blockingSeverities,
  parsePostedReview,
  REVIEW_HEAD,
  titleOf,
} from "./review-parse.mjs";
import { fixMessage, lastPosted, reviewEvent } from "./review-post.mjs";
import {
  actionsRuns,
  checksOf,
  fixInput,
  mergeBlockers,
  mergeInput,
  mergeRefusal,
  readPullInput,
} from "./review-merge.mjs";
import {
  afterFixes,
  blockingText,
  blockingWhat,
  CI_NEXT,
  ciFailedText,
  ciFixMessage,
  ciNoteText,
  ciStoppedText,
  FOLLOW_UP_LABEL,
  FOLLOW_UPS_MAX,
  followUpBody,
  followUpsText,
  mergedText,
  noFixText,
  notMergedText,
  oneLine,
  policyWhy,
  roundsOutText,
  short,
  stoppedWhy,
} from "./review-texts.mjs";
import { fixesOf, reviewedFixesOf } from "./review-loop.mjs";
import {
  dryRunText,
  githubSamples,
  linkSample,
  pushSample,
  runSamples,
} from "./review-dry-run.mjs";
import { ownReady, requestInput, reviewersFor, runFields } from "./reviewers.mjs";
import { SEVERITIES } from "./severities.mjs";
import { respellMap } from "./spelling.mjs";

// A reviewed head commit is forgotten after this: the pull request is long merged or closed.
const KEEP_MS = 90 * 24 * 3600_000;

// When pull request entry `v` was last of use: its last review's step (`at`), or the latest
// follow-up it labelled for auto-pickup, whose record (followUpPick()) must last KEEP_MS from
// its own filing, however long before the merge the pull request was reviewed (#682).
function lastAt(v) {
  const picks = (v.pickups ?? []).map((p) => Date.parse(p.at)).filter(Number.isFinite);
  return Math.max(v.at ?? 0, ...picks);
}

// A review's item as the dashboard gets it: its place and its text, nothing else.
const placed = ({ path, line, text }) => ({ path, line, text });

// How often the pull requests waiting for their checks are decided again (tick()), for a lost
// `workflow_run` delivery and `review.merge_wait`'s deadline.
const WAIT_TICK_MS = 5 * 60_000;

// How many times an automatic review the policies failed to decide is asked again, a tick
// apart (decideReview()): a GitHub or opa hiccup, not a policy that never compiles.
const POLICY_RETRIES = 3;
// How long a policy that failed waits before it is asked again, at once (asking()).
const POLICY_AGAIN_MS = 10_000;

// The reviews kept per pull request (`rounds`, the loop's or a maintainer's, `manual`): more
// than the operator's MAX_FIX_ROUNDS allows in one loop, as the history goes on across the
// pull request turning ready again: its fix count carries over, so that review is numbered
// after the fix runs so far (R<fixes>), not a new first review.
const ROUNDS_KEPT = 20;

// How many fix runs a repo's settings allow per pull request (`review.fix`).
const roundsOf = (settings) =>
  settings?.review?.fix ? Math.max(1, settings.review.fixRounds ?? 1) : 0;

// How many fix runs pull request `entry` may have: `review.fix`'s, or up to the last fix round
// a maintainer granted from the dashboard (`grantedTo`, startFix()), with `review.fix` only. A
// round, not a count: `review.fix` changed since neither takes a grant back nor adds to it.
const limitOf = (settings, entry) => {
  const rounds = roundsOf(settings);
  return rounds ? Math.max(rounds, entry?.grantedTo ?? 0) : 0;
};

// Whether the CI step is on (`review.ci: wait`, with `review.on: ready`), and how many CI fix
// runs it allows per pull request (`review.ci_fix`, with `review.fix` only).
const ciOn = (settings) => settings?.review?.on === "ready" && settings.review.ci === "wait";
const ciRoundsOf = (settings) => (settings?.review?.fix ? (settings.review.ciFix ?? 1) : 0);

// Without any Actions run on the head commit yet, the CI step waits this long before it takes
// "none" for "no CI": GitHub creates the runs of a push a moment after it.
const CI_GRACE_MS = 60_000;

// A follow-up's title as compared with another's (an issue's too, filed before titles lost
// their trailing separator): case, spacing and a trailing separator aside.
const titleKey = (title) => titleOf(title ?? "").toLowerCase();

// How far the `labeled` event of a follow-up filed with the auto-pickup label may be from its
// issue's creation, as GitHub gives both to the second (followUpPick()).
const PICK_SKEW_MS = 2000;

// A `pull_request` delivery that may start a review by itself → { repo, base, pr, author, own,
// bot } (openedBy()), or null. Only a pull request that turned ready (marked ready, or opened as
// ready), on a branch of the repo (never a fork's), opened by the App (Deckhand's own), a bot or
// an allowed user: outsiders never cost a review. The allowlist lists people: other bots are
// left to the policies' `deny_review` (policy/review.rego skips them unless a file of that name
// lets them).
export function reviewCandidate(config, event, p, skip = () => null) {
  if (event !== "pull_request") return null;
  const pr = p.pull_request;
  const ready = p.action === "ready_for_review" || (p.action === "opened" && pr && !pr.draft);
  if (!ready) return null;
  const repo = p.repository?.full_name;
  if (!p.installation?.id || !repo) return skip("not from an installation of the App", REFUSED);
  if (!repoAllowed(config, repo)) return skip(`${repo} not in ALLOWED_REPOS`, REFUSED);
  if (pr.state && pr.state !== "open") return skip(`review: #${pr.number} isn't open`);
  if (!headInRepo(pr, repo)) return skip(`review: #${pr.number} is from a fork`);
  const by = openedBy(config, pr);
  if (!by) return skip(`review: #${pr.number} by ${pr.user?.login ?? "?"}, not an allowed user`);
  const base = p.repository.default_branch || "main";
  return { repo, base, pr, ...by };
}

// Who opened `pr`, for the automatic review → { author, own, bot }: the App (`own`), another
// bot (`bot`), or a user of ALLOWED_USERS (`author`, their login, checked again with the repo's
// `users`; null for the App's and a bot's). Null for anyone else.
function openedBy(config, pr) {
  const login = pr.user?.login?.toLowerCase() ?? "";
  const own = !!config.bot && login === config.bot.toLowerCase();
  const bot = !own && pr.user?.type === "Bot";
  if (!own && !bot && !config.users.includes(login)) return null;
  return { author: own || bot ? null : pr.user.login, own, bot };
}

// `repoSettings(repo, base)`: the repo's settings from its default branch; `accept(item)`:
// queues a work item (tasks.mjs). `github`: the App's calls (server.mjs). `busy(key)`: the
// task has a run going or queued; `stopped(key)`: its run was stopped and nobody asked for one
// since (stopped.mjs), no automatic fix run then. `now`: the clock, for forgetting old pull requests.
// `reply(repo, number, text)`: a comment with the listener's token; `grantOf(repo)`: the
// operator's grant for it, with what its policies grant (grants.mjs grantOf()): a promise of
// it, or null when its grants have errors;
// `merged(repo, pr)`: a pull request it merged, for the dashboard; `sleep(ms)`: the wait
// between asks of `mergeable_state`; `policies`: the policies' engine (policies.mjs), none
// without; `decided(repo, pr, entry)`: a decision a policy was asked for, for the task's page
// (decisions.mjs). `reviewed`: the Map each pull request's loop is kept in (storeMap()'s).
export function createReviews({
  reviewed = new Map(),
  config,
  repoSettings,
  accept,
  github,
  busy,
  stopped = () => false,
  reply = async () => {},
  grantOf = () => null,
  merged = () => {},
  policies = null,
  decided = () => {},
  // The run that opened a pull request, for `/mode policy`'s deny_request_review (reviewers.mjs
  // openerOf()): `runOf(taskKey, pr)`, or null.
  runOf = () => null,
  // The login whose machine pushed a pull request (pulls.mjs externalOf(), #598), for the
  // policies' `pr.external`: `externalOf(repo, number)`, or null.
  externalOf = () => null,
  // The orchestrator's metrics (metrics.mjs): its fix rounds, counted.
  metrics = null,
  log = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // `work()` in `ms`, for the CI step's grace (ciDecide()): not waited for, nor keeping the
  // process up.
  later = (work, ms) => setTimeout(work, ms).unref?.(),
}) {
  // "org/repo#pr-5" → { head, at, fixes, fixedAt, reviewedFixes, roundsOutAt, mergeAt,
  // waiting, rounds, fixRounds, next, nextAt, unreviewedFix, ciWaiting, ciFixes, ciFixedAt,
  // ciSettled, grantedTo, asked, askedFrom, rebaseRetry } of its last automatic review,
  // how many fix runs it had and when the last one was queued, how many of them had their
  // review queued, the comment saying the rounds ran out, and its auto-merge (merged or
  // refused), or the auto-merge waiting for its checks (decide()); each review's counts (the
  // loop's or a maintainer's, `manual`) and the fix runs allowed, the loop's step on its way
  // and when it was queued, and the fix run nothing reviews, for the dashboard (recordRound(),
  // nextStep(), reviewLoop());
  // the CI step's wait ({ sha, since, base, author }), its CI fix runs, when the last one was
  // queued and how many of them were settled (reviewAfterCi(), ciFailed(), ciFixed()); the
  // last fix round maintainers granted from the dashboard beyond `review.fix`, and the last round
  // one asked for there, whose push is always reviewed (startFix()); whether the loop stopped on
  // what a conflict run may have caused (`rebaseRetry`: its merge refused for a conflict, a run
  // going or a moved head, its fix run skipped for a run going), which a rebase lifts
  // (rebased()).
  // Entries from before the rounds have fixedAt and rereviewAt (fixesOf()); from before the
  // dashboard's, no `rounds`.
  // Pull request key → { step } while the listener decides about its loop's step, in memory
  // (deciding()): a webhook's review until it is queued, a run's end until what follows it is.
  const decisions = new Map();
  // Pull request keys whose fix run a maintainer asked for is being started (startFix()): a
  // second click meanwhile starts nothing.
  const granting = new Set();

  // `work()`, with the loop of pull request `key` at `step` meanwhile ("review", "review-fix"),
  // for the dashboard: its GitHub calls and policies may outlast a poll. Its own mark only is
  // taken off: another decision started since keeps its own.
  async function deciding(key, step, work) {
    const mark = { step };
    decisions.set(key, mark);
    try {
      return await work();
    } finally {
      if (decisions.get(key) === mark) decisions.delete(key);
    }
  }

  // At start, after the runs going and the queue are back (restart.mjs): the steps on their way
  // (`next`) whose run nothing has any more, `going(repo, number)` saying which pull requests
  // still have a review or fix run running or queued. A listener stopped while it decided what
  // follows a run never will: the run it settles was over, and nothing settles it now.
  function forgetSteps(going) {
    for (const [k, v] of reviewed) {
      const at = parseKey(k);
      if (!v.next || (at && going(at.repo, at.number))) continue;
      reviewed.set(k, { ...v, next: undefined, nextAt: undefined });
    }
  }

  // A `pull_request` delivery: a review run, if the repo's `review.on` asks for one and this
  // head commit hasn't had one.
  async function consider(event, payload, skip = () => null) {
    const found = reviewCandidate(config, event, payload, skip);
    if (!found) return null;
    return decideReview(found, skip);
  }

  // consider()'s decision about `found` (reviewCandidate()), and a retry's (policyRecheck()):
  // `tries`, the policy errors so far at this head.
  async function decideReview({ repo, base, pr, author, own }, skip, tries = 0) {
    const key = taskKey(repo, prId(pr.number));
    const head = pr.head?.sha ?? null;
    // A wait for CI dropped at this head (ciDecide()), or a CI step stopped there without a
    // review (ciFailed(), afterCiFix()), reviewed nothing: ready again, the CI step runs again.
    const known = reviewed.get(key);
    const unreviewed = known?.ciDropped === head || known?.ciStopped?.sha === head;
    if (head && known?.head === head && !unreviewed) {
      return skip(`review: #${pr.number} at ${head.slice(0, 7)} was reviewed already`);
    }
    // The repo's settings and the policies may take a while: the pull request is in review
    // from its ready delivery on, not ready, until the review is queued or skipped.
    return deciding(key, "review", async () => {
      const { settings, errors } = await repoSettings(repo, base);
      // A broken config: its next comment's reply says why; nothing is posted for a webhook.
      if (errors.length) return skip(`review: ${repo}'s config has errors`);
      if (settings.review?.on !== "ready") return skip(`review: not on in ${repo}`);
      if (author && !settings.users.includes(author.toLowerCase())) {
        return skip(`review: ${author} not in ${repo}'s users`);
      }
      const opener = author
        ? "Opened by an allowed user"
        : own
          ? "Deckhand's own pull request"
          : "Opened by a bot (left to deny_review)";
      const denied = await denyReview(repo, base, pr, [
        passed("Ready for review"),
        passed(opener),
        passed("Not reviewed at this commit"),
      ]);
      if (denied.length) {
        const why = `review: #${pr.number}, ${policyWhy("deny_review", denied)}`;
        // A rule's refusal holds at this head. A failure (GitHub couldn't give the input, opa
        // timed out) would leave a pull request nothing reviews: no delivery comes for its
        // head again, so tick() asks again, POLICY_RETRIES times at most.
        if (!denied.some(isPolicyError) || tries >= POLICY_RETRIES) {
          if (reviewed.get(key)?.policyRetry) keep(key, { policyRetry: undefined });
          return skip(why);
        }
        keep(key, { policyRetry: { sha: head, base, tries: tries + 1 } });
        return skip(`${why}; asked again in ${WAIT_TICK_MS / 60_000} minutes`);
      }
      remember(key, head, { policyRetry: undefined });
      log(`${key}: pull request #${pr.number} is ready, starting a review`);
      return reviewAfterCi({ repo, base, pr, settings, author });
    });
  }

  // `fields` on pull request `key`'s entry, its reviewed head untouched (remember() sets it).
  function keep(key, fields) {
    const entry = reviewed.get(key);
    reviewed.set(key, { ...entry, at: entry?.at ?? now(), ...fields });
  }

  // A review the policies failed to decide (decideReview()), asked again with the pull request
  // as GitHub has it now: dropped once it is closed, a draft, pushed to (a push isn't
  // reviewed by itself), or its author no longer allowed.
  async function policyRecheck(key) {
    const retry = reviewed.get(key)?.policyRetry;
    const at = parseKey(key);
    if (!retry || !at) return null;
    let pr;
    try {
      pr = await getJson(github, at.repo, `/repos/${at.repo}/pulls/${at.number}`, [404]);
    } catch (error) {
      // The same kind of hiccup the retry is for: it counts as a try, and the next tick asks.
      const tries = retry.tries + 1;
      keep(key, { policyRetry: tries > POLICY_RETRIES ? undefined : { ...retry, tries } });
      log(`${key}: reading the pull request to ask the policies again: ${error.message ?? error}`);
      return null;
    }
    // Taken off once read: only another policy error sets it again, whatever else ends this try.
    keep(key, { policyRetry: undefined });
    const drop = (why) => log(`${key}: not asking the policies again, ${why}`);
    if (!pr || pr.state !== "open") return drop("the pull request isn't open");
    if (pr.draft) return drop("the pull request is a draft again");
    if (pr.head?.sha !== retry.sha) return drop("it was pushed to since");
    if (!headInRepo(pr, at.repo)) return drop("it is from a fork");
    const by = openedBy(config, pr);
    if (!by) return drop("its author isn't an allowed user");
    const found = { repo: at.repo, base: retry.base, pr, ...by };
    return decideReview(found, (why) => log(`${key}: ${why}`), retry.tries);
  }

  // The policies, asked about pull request `pr`: what they decide, when one applies, is kept
  // for its task's page (`decided`), with the built-in `gates` that passed before them
  // ([{ name, passed }]) and the input they saw. Null without policies.
  function asking(pr) {
    if (!policies) return null;
    return {
      deny: async (rule, repo, ref, input, { gates = [] } = {}) => {
        let kept = null;
        const ask = () =>
          denyKept(policies, rule, repo, ref, input, {
            pr,
            gates,
            keep: (entry) => (kept = entry),
            log,
          });
        let { messages } = await ask();
        // A failure (GitHub couldn't give the input, opa timed out) is asked once more, a
        // moment later: the review after a fix run stops its loop on one, and since
        // policy/review.rego every automatic review reads GitHub for its input. The task's
        // page keeps the last answer only.
        if (messages.some(isPolicyError)) {
          log(`${repo}#${pr.number}: ${rule} failed, asking again: ${messages.join(" | ")}`);
          await sleep(POLICY_AGAIN_MS);
          kept = null;
          ({ messages } = await ask());
        }
        if (kept) {
          try {
            decided(repo, pr, kept);
          } catch (error) {
            log(`${repo}#${pr.number}: keeping its ${rule} decision: ${error.message ?? error}`);
          }
        }
        return messages;
      },
    };
  }

  // Why the policies refuse an automatic review of `pr` (`deny_review`): their messages, or []
  // (always without policies). A review a maintainer asked for (`/mode review`) never asks.
  // `gates`: what passed before, for the task's page.
  async function denyReview(repo, base, pr, gates) {
    if (!policies) return [];
    const issue = linkedIssue(pr, repo, config.bot);
    const fixes = fixesOf(reviewed.get(taskKey(repo, prId(pr.number))));
    return asking(pr).deny(
      "deny_review",
      repo,
      base,
      () =>
        readPullInput(
          github,
          {
            decision: "review",
            repo,
            pr,
            issue,
            bot: config.bot,
            external: externalOf(repo, pr.number),
            now,
          },
          fixInput(fixes),
        ),
      { gates },
    );
  }

  // Queues a review run of `pr`, on the task of the issue it closes or its own. `ciNote`: why
  // CI hadn't passed when it was queued, for its prompt (ciNoteText()).
  async function queueReview({ repo, base, pr, settings, author = null, ciNote = null }) {
    const item = {
      repo,
      id: prId(pr.number),
      kind: "pr",
      number: pr.number,
      title: pr.title ?? null,
      trigger: "review",
      modeLine: null,
      after: null,
      text: "",
      replyTo: pr.number,
      comment: null,
      base,
      settings,
      // Checked again when it runs (tasks.mjs noLongerAllowed()); the App's has none.
      ...(author ? { author } : {}),
      ...(ciNote ? { ciNote } : {}),
      reason: "review",
    };
    // Deckhand's own pull request is its issue's task, like a comment on it (events.mjs).
    const issue = linkedIssue(pr, repo, config.bot);
    const queued = issue ? linkTo(item, issue) : item;
    const key = taskKey(repo, prId(pr.number));
    const known = reviewed.get(key);
    if (known?.ciStopped || known?.ciDropped || known?.rebaseRetry) {
      remember(key, known.head ?? null, {
        ciStopped: undefined,
        ciDropped: undefined,
        rebaseRetry: undefined,
      });
    }
    nextStep(key, "review");
    await accept(queued);
    return queued;
  }

  // The loop's step on its way on pull request `key` (`next`: "review", "review-fix"), from
  // when it is queued until what follows its run is decided (settle(), fixed()), which may take
  // GitHub calls: the dashboard keeps it in review meanwhile (reviewLoop()). Null: decided.
  // `since`: when clearing, the `nextAt` of the step decided about; another queued since stays.
  function nextStep(key, step, since = undefined) {
    const entry = reviewed.get(key);
    if (!step && !entry?.next) return;
    if (!step && since !== undefined && entry.nextAt !== since) return;
    remember(key, entry?.head ?? null, {
      next: step ?? undefined,
      nextAt: step ? now() : undefined,
    });
  }

  // A fix run's round, just counted in pull request `key`'s entry (`before`: the entry until
  // then), in the store before its run is queued: a copy killed after the queue's write but
  // before this one's would run that round again. → whether the run may be queued: a comment
  // queued on `task` while the write waited (the store away) would join it, and the round is
  // given back then, unless the entry changed again meanwhile.
  async function counted(key, before, task) {
    const counting = reviewed.get(key);
    await reviewed.written?.(key);
    if (!busy(task)) return true;
    if (reviewed.get(key) === counting) {
      if (before) reviewed.set(key, before);
      else reviewed.delete(key);
    }
    return false;
  }

  function remember(key, head, fields = {}) {
    const cutoff = now() - KEEP_MS;
    // Not the one it updates: what it counted so far still holds.
    for (const [k, v] of reviewed) if (lastAt(v) < cutoff && k !== key) reviewed.delete(k);
    reviewed.set(key, { ...reviewed.get(key), head, at: now(), ...fields });
  }

  // A review was posted on pull request `number` (`posted`: postReview()'s result, with the
  // pull request as GitHub had it): a work run that addresses its findings, if the repo's
  // `review.fix` asks for it, the review requests changes, the pull request is Deckhand's own
  // and had fewer fix runs than `review.fix` allows, and the policies don't refuse it
  // (`deny_fix`, said on the pull request). Returns the item queued, or null (the reason
  // logged).
  async function fix(run, posted) {
    return (await startFix(run, posted)).item;
  }

  // fix()'s work → { item, denied, why }: `denied`, why the policies refused the fix run;
  // `why`, why no fix run was queued.
  // `asked`: a maintainer's Fix from the dashboard (work.mjs), { user, announce(round, rounds,
  // left) } where announce() posts the App's comment and returns it, for the run's reactions.
  // Its fix run is one round more than `review.fix` allows when they are used up (`grantedTo`,
  // counted with the round before it is queued, limitOf()), and the review loop goes on from
  // it as from any round: its push is reviewed, its auto-merge decided again (mergeAt, and the
  // comment saying the rounds ran out, cleared). Refused, it posts nothing of its own: the
  // dashboard says why (and work.mjs edits the App's comment, if announce() posted it).
  async function startFix({ repo, number, base, settings }, posted, asked = null) {
    const key = taskKey(repo, prId(number));
    const skip = (why) => {
      log(`${key}: no fix run, ${why}`);
      return { item: null, why };
    };
    const { review, pr } = posted ?? {};
    if (!settings?.review?.fix) return { item: null, why: "`review.fix` is off" };
    if (!review) return skip("the review couldn't be read");
    if (reviewEvent(review) !== "REQUEST_CHANGES") {
      return { item: null, why: "the last review has nothing blocking" };
    }
    // A maintainer's Fix being started holds the pull request: a second click, or the
    // automatic path meanwhile, starts nothing.
    if (granting.has(key)) {
      metrics?.fixRound("skipped");
      return skip("a fix run asked from the dashboard is being started");
    }
    if (!asked) return fixRound({ key, repo, number, base, settings, review, pr }, asked);
    granting.add(key);
    try {
      return await fixRound({ key, repo, number, base, settings, review, pr }, asked);
    } finally {
      granting.delete(key);
    }
  }

  // Whether the review loop of pull request `key` started again since its entry was `before`:
  // a step being decided, a wait for CI or checks, a new head reviewed (the pull request ready
  // again).
  function moved(key, before) {
    const entry = reviewed.get(key) ?? {};
    if (decisions.has(key) || entry.waiting || entry.ciWaiting) return true;
    return (entry.head ?? null) !== (before.head ?? null);
  }

  // queueFix(), counted (deckhand_fix_rounds_total): a fix run queued, refused by the policies,
  // its rounds used up, none now (a run going, the maintainer's input awaited…), or an error.
  async function fixRound(fields, asked) {
    let result;
    try {
      result = await queueFix(fields, asked);
    } catch (error) {
      metrics?.fixRound("error");
      throw error;
    }
    const { item, denied, out } = result;
    metrics?.fixRound(item ? "started" : denied ? "refused" : out ? "exhausted" : "skipped");
    return result;
  }

  // startFix()'s work, the review read and requesting changes.
  async function queueFix({ key, repo, number, base, settings, review, pr }, asked) {
    const skip = (why) => {
      log(`${key}: no fix run, ${why}`);
      return { item: null, why };
    };
    // The loop's own fix run skipped for a run going or queued, maybe a conflict run's: its end
    // reviews the rebased head (rebased()), which starts the fix run then.
    const busySkip = (why) => {
      if (!asked) keep(key, { rebaseRetry: true });
      return skip(why);
    };
    const entry = reviewed.get(key) ?? {};
    // The loop going on: what follows a run being decided, the auto-merge or CI waited for. Its
    // step's run queued or running is busy() below; `next` alone isn't: a review run that
    // failed posts nothing, and its step stays until a restart (forgetSteps()).
    if (asked && (decisions.has(key) || entry.waiting || entry.ciWaiting)) {
      return skip("its review loop is still going");
    }
    // The review read back from GitHub (latestReview(), `head` its commit) is the one the loop
    // shows last: one GitHub refused, posted as a plain comment instead, leaves an older one
    // there, whose findings may be fixed already.
    const last = entry.rounds?.at(-1);
    const stale = last?.comment || (review.head && last?.head && review.head !== last.head);
    if (asked && stale) {
      return skip("its latest review couldn't be read from GitHub: ask for a review first");
    }
    const fixes = fixesOf(entry);
    // A maintainer's Fix with the rounds used up: one more.
    const grant = !!asked && fixes >= limitOf(settings, entry);
    const rounds = grant ? fixes + 1 : limitOf(settings, entry);
    if (fixes >= rounds) {
      const why =
        rounds > 1 ? `it had its ${rounds} fix runs already` : "it had its fix run already";
      return { ...skip(why), out: true };
    }
    const round = fixes + 1;
    // Deckhand's own pull request, on a branch of the repo and linked to the issue it worked
    // on: the fix pushes where its runs already push.
    const own = !!config.bot && pr?.user?.login?.toLowerCase() === config.bot.toLowerCase();
    const issue = own ? linkedIssue(pr, repo, config.bot) : null;
    if (!issue || pr.state !== "open") return skip("not an open pull request of Deckhand's own");
    const task = taskKey(repo, String(issue));
    // A maintainer's comment came first, or the maintainer is to answer.
    if (busy(task)) return busySkip(`#${issue} has a run going or queued`);
    if (await waitsForInput(github, config, repo, pr, issue)) {
      return skip("it waits for the maintainer's input");
    }
    // A maintainer's Fix asks for the run: it lifts the stop (tasks.mjs).
    if (!asked && stopped(task)) return skip(stoppedWhy(issue));
    if (policies) {
      const gates = [
        passed("Review requests changes"),
        passed("Deckhand's own pull request, open"),
        passed(
          grant
            ? `Fix round ${round}, granted from the dashboard by @${asked.user}`
            : rounds > 1
              ? `Fix round ${round} of ${rounds}`
              : "First fix run",
        ),
        passed("No run going"),
        passed("Nobody's input awaited"),
      ];
      const denied = await asking(pr).deny(
        "deny_fix",
        repo,
        base,
        () =>
          readPullInput(
            github,
            {
              decision: "fix",
              repo,
              pr,
              issue,
              review,
              bot: config.bot,
              external: externalOf(repo, pr.number),
              now,
            },
            { ...fixInput(fixes), ci: false, reason: "review", round, rounds },
          ),
        { gates },
      );
      if (denied.length) {
        const why = policyWhy("deny_fix", denied);
        skip(why);
        if (!asked) await reply(repo, number, noFixText(why));
        return { item: null, denied: why, why };
      }
    }
    // Checked again: a comment may have come during the calls above.
    if (busy(task)) return busySkip(`#${issue} has a run going or queued`);
    const comment = asked ? await asked.announce(round, rounds, blockingText(review)) : null;
    // And again after the App's comment, a GitHub call: a comment queued meanwhile would join
    // the fix run, a fix run queued meanwhile has this round, a loop started again has its own
    // step. Refused now, the comment is edited to say so (work.mjs).
    if (asked && busy(task)) return skip(`#${issue} has a run going or queued`);
    if (asked && fixesOf(reviewed.get(key)) !== fixes) return skip("another fix run was queued");
    if (asked && moved(key, entry)) return skip("its review loop started again meanwhile");
    // Before queuing: whatever happens next, never this round twice (in the store first,
    // counted()).
    const before = reviewed.get(key);
    remember(key, reviewed.get(key)?.head ?? null, {
      fixes: round,
      fixedAt: now(),
      next: "review-fix",
      nextAt: now(),
      ...(asked && {
        // Its push is reviewed whatever `review.fix` says, and compared with the head it starts
        // from, which no automatic review may have seen (a maintainer's review of it, an
        // unreviewed `fix: true` push), so a fix that pushed nothing stops the loop
        // (reviewFix()). Apart from `head`, the loop's own review's, which consider() goes by.
        asked: round,
        askedFrom: pr?.head?.sha ?? null,
        ...(grant && { grantedTo: round }),
        fixRounds: rounds,
        mergeAt: undefined,
        roundsOutAt: undefined,
      }),
    });
    if (!(await counted(key, before, task))) {
      return busySkip(`#${issue} has a run going or queued`);
    }
    const of = rounds > 1 ? ` (${round} of ${rounds})` : "";
    log(
      asked
        ? `${key}: @${asked.user} asks for a fix run from the dashboard${of}`
        : `${key}: the review requests changes, starting a fix run${of}`,
    );
    const item = {
      repo,
      id: String(issue),
      kind: "issue",
      number: issue,
      title: null,
      trigger: "work",
      modeLine: null,
      text: fixMessage(review, number, {
        round,
        rounds,
        followUps: settings.review?.followUps !== false,
      }),
      replyTo: number,
      comment,
      base,
      settings,
      // From the listener, for a task an allowed user started: no comment, nobody to check.
      // From the dashboard: the maintainer who asked, checked again when it runs.
      sender: null,
      // `dashboard`: its start is the maintainer's, checked again when it runs (runs.mjs).
      ...(asked && { author: asked.user, dashboard: true }),
      reason: "review-fix",
      // For the dashboard's "Review fix 2/3" (runs.mjs newLive()).
      round,
      rounds,
    };
    await accept(item);
    return { item };
  }

  // A review run is over (run-end.mjs cleanUp()): its fix run (fix(), the item queued), else, for
  // an automatic review (`auto`), with `review.merge` on, the merge ({ sha, method }) or the
  // comment saying why not (null); without, the comment when the rounds ran out (roundsOut()).
  async function settle(run, posted) {
    const key = taskKey(run.repo, prId(run.number));
    if (!run.auto) {
      // A maintainer's review (`/mode review`, the dashboard's Review): the latest round the
      // dashboard shows (`manual`), with or without a loop before it, so that a commit pushed
      // after it is seen there (issue #535); its blocking findings counted with the tolerance
      // of the loop's own reviews (tolerance(), as the dashboard's Fix reads them), so that
      // what the task page offers follows it. Not a loop round: it counts no fix run and
      // starts no loop. With `review.fix`, it may start a fix run while rounds are left:
      // decided as the loop's steps are (deciding()), so a dashboard Fix meanwhile waits.
      // A CI step stopped without a review (`ciStopped`) shows it too (reviewLoop()), its mark
      // kept: it isn't the loop's own review, which ready again at that head still runs.
      const manual = async () => {
        recordRound(run, posted, await tolerance({ ...run, auto: true }), true);
        await lateFollowUps(run, posted);
        return (await startFix(run, posted)).item;
      };
      return run.settings?.review?.fix ? deciding(key, "review", manual) : manual();
    }
    const since = reviewed.get(key)?.nextAt;
    let item = null;
    // From the start, synchronously in the run's end (run-end.mjs cleanUp()): the conflict
    // watcher starts no rebase run meanwhile (looping()).
    return deciding(key, "review", async () => {
      try {
        recordRound(run, posted);
        await lateFollowUps(run, posted);
        const started = await startFix(run, posted);
        item = started.item;
        if (item) return item;
        const mode = await mergeMode(run.repo, run.base);
        if (!mode) return roundsOut(run, posted);
        return autoMerge(run, posted, started.denied, mode);
      } finally {
        // Nothing more on its way, unless a fix run was queued (startFix() said so) or a new
        // review since (the pull request ready again meanwhile).
        if (!item) nextStep(key, null, since);
      }
    });
  }

  // A review posted on pull request `number`: its round of the fix loop, kept in its entry's
  // `rounds` for the dashboard (reviewLoop()), before startFix() counts the next fix run.
  // Counts only, never the findings' text. The same round at the same head again replaces it;
  // `fixRounds`: how many fix runs the repo allows now. `allowed`: the tolerance its blocking
  // findings are counted with, the review's own by default. `manual`: a maintainer's review,
  // not the loop's own.
  function recordRound(
    { repo, number, settings },
    posted,
    allowed = posted?.review?.allowed,
    manual = false,
  ) {
    const review = posted?.review;
    if (!review) return;
    const key = taskKey(repo, prId(number));
    const entry = reviewed.get(key) ?? {};
    const round = fixesOf(entry);
    // The commit the review run started from (postReview()), not a later one pushed meanwhile.
    const head = posted.head ?? posted.pr?.head?.sha ?? entry.head ?? null;
    const counts = Object.fromEntries(
      SEVERITIES.map((s) => [s, review.findings.filter((f) => f.severity === s).length]),
    );
    // Follow-ups and notes never block; blocking comments always do, counted apart.
    const said = review.comments ?? [];
    const comments = { blocking: blockingComments(review).length };
    comments.notes = said.length - comments.blocking;
    const blocking = above(review, allowed).length + comments.blocking;
    const followUps = review.followUps?.length ?? 0;
    const same = (r) => r.round === round && r.head === head;
    // A maintainer's review replacing the loop's own of that head is still a loop's round: a
    // loop ran (reviewLoop() `manual`).
    const theirs = manual && !(entry.rounds ?? []).some((r) => same(r) && !r.manual);
    const rounds = (entry.rounds ?? []).filter((r) => !same(r));
    // Posted as a plain comment (GitHub refused the review): not on GitHub's list of reviews,
    // which the dashboard's Fix reads (latestReview()).
    const comment =
      posted.event === null
        ? { comment: true, ...(posted.commentId && { commentId: posted.commentId }) }
        : {};
    rounds.push({
      round,
      at: now(),
      head,
      counts,
      blocking,
      followUps,
      comments,
      ...comment,
      ...(theirs && { manual: true }),
    });
    // Kept apart from the rounds, which a later review at the same head replaces and
    // ROUNDS_KEPT trims: whether any review listed follow-ups, and the comments GitHub's refused
    // reviews were posted as, for fileFollowUps() after the merge.
    const refused = comment.commentId ? [comment.commentId] : [];
    remember(key, entry.head ?? null, {
      rounds: rounds.slice(-ROUNDS_KEPT),
      fixRounds: limitOf(settings, entry),
      ...((followUps || entry.hasFollowUps) && { hasFollowUps: true }),
      ...(refused.length && {
        reviewComments: [...new Set([...(entry.reviewComments ?? []), ...refused])],
      }),
    });
  }

  // Without auto-merge: a review that still requests changes after the last fix run `review.fix`
  // allows says so on the pull request, once. Any other stop (a busy task, a policy) is said
  // elsewhere or by the task's state.
  async function roundsOut({ repo, number, base }, posted) {
    const review = posted?.review;
    if (!review || reviewEvent(review) !== "REQUEST_CHANGES") return null;
    const key = taskKey(repo, prId(number));
    const entry = reviewed.get(key) ?? {};
    const fixes = fixesOf(entry);
    if (!fixes || entry.roundsOutAt) return null;
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length || fixes < limitOf(settings, entry)) return null;
    remember(key, entry.head ?? null, { roundsOutAt: now() });
    log(`${key}: no more fix runs, ${fixes} ran`);
    await reply(repo, number, roundsOutText(review, fixes));
    return null;
  }

  // Whether `repo` merges by itself: its settings, re-read from the default branch now (a
  // maintainer may have turned it off since), and the operator's grant. → { settings, grant }
  // or null.
  async function mergeMode(repo, base) {
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length || !settings.review?.merge) return null;
    const grant = await grantOf(repo);
    if (autoMergeProblems(grant, settings, null).length) return null;
    return { settings, grant };
  }

  // The most severe finding the review of `number` about to be posted may have without
  // requesting changes: `review.max_allowed_severity` for an automatic review in a fix loop
  // (`review.fix`: within it, the loop stops and starts no fix run) or deciding an auto-merge,
  // else low. autoMerge() reads the settings again and refuses a review posted as
  // REQUEST_CHANGES whatever they say now, so the two never disagree.
  async function tolerance({ repo, number, base, auto }) {
    if (!auto) return "low";
    try {
      const { settings, errors } = await repoSettings(repo, base);
      const review = !errors.length && settings.review;
      if (!review) return "low";
      if (review.fix || (await mergeMode(repo, base))) return review.maxAllowedSeverity;
      return "low";
    } catch (error) {
      log(`${repo}#${number}: the review's tolerance: ${error.message ?? error}`);
      return "low";
    }
  }

  // Leaves the pull request to the maintainer: a comment says why. Once per pull request.
  async function refuse(key, repo, number, why) {
    log(`${key}: not merged, ${why}`);
    await reply(repo, number, notMergedText(why));
    return null;
  }

  // The merge decision after an automatic review that started no fix run: once per pull
  // request (mergeAt), whatever it decides. Nothing blocking (mergeBlockers()), a review that
  // doesn't request changes (neither posted as REQUEST_CHANGES nor with that verdict) and every
  // gate passed: merged at the reviewed head commit, so a push since makes GitHub refuse it.
  // `fixDenied`: why the policies refused the fix run of this review (startFix()), said in the
  // refusal; `mode`: mergeMode()'s.
  async function autoMerge({ repo, number, base }, posted, fixDenied, mode) {
    const key = taskKey(repo, prId(number));
    const { settings } = mode;
    const entry = reviewed.get(key) ?? {};
    if (entry.mergeAt || entry.waiting) {
      log(`${key}: its auto-merge was decided already`);
      return null;
    }
    // Before any GitHub call: whatever happens next, never a second decision.
    remember(key, entry.head ?? null, { mergeAt: now() });
    const { review, pr } = posted ?? {};
    if (!review) return refuse(key, repo, number, "the review's format couldn't be read");
    const fixes = fixesOf(entry);
    // Blocking findings end the loop here when there was no fix run left to start.
    const outOfRounds = fixes >= limitOf(settings, entry);
    const allowed = settings.review.maxAllowedSeverity;
    const after = fixes ? ` ${afterFixes(fixes)}` : "";
    if (mergeBlockers(review, allowed).length) {
      const what = blockingWhat(review, allowed);
      const why = outOfRounds
        ? `the review${after} still has ${what}`
        : `the review has ${what} and no fix run started${fixDenied ? ` (${fixDenied})` : ""}`;
      return refuse(key, repo, number, why);
    }
    // GitHub shows what the review decided: a merge never contradicts it (issue #288).
    if (posted.event === "REQUEST_CHANGES" || review.verdict === "request-changes") {
      return refuse(key, repo, number, `the review${after} requests changes`);
    }
    const sha = pr?.head?.sha ?? null;
    // The review was queued at entry.head: a push before it posted means it may have read
    // another commit than the one it was posted on.
    if (entry.head && sha !== entry.head) {
      keep(key, { rebaseRetry: true });
      return refuse(key, repo, number, "a commit was pushed while the review ran");
    }
    // What the task's page needs of the pull request to file the policies' decision (asking()).
    const about = {
      number,
      body: pr?.body ?? null,
      head: { repo: { full_name: pr?.head?.repo?.full_name ?? null } },
    };
    const waiting = { sha, since: now(), base, review, fixes, allowed, pr: about };
    return oneAtATime(key, () => decide(key, repo, number, mode, waiting));
  }

  // The gates and the merge, or the refusal, for the pull request `key` as `waiting` has it
  // ({ sha, since, base, review, fixes, allowed, pr }). Only Actions runs still going
  // (mergeRefusal()'s `pending`): kept waiting in its entry instead, mergeAt cleared,
  // decided again when a run completes (checksDone()) or by tick(), until `review.merge_wait`
  // minutes after `since`. `again`: a decision after waiting (recheck()), with `waiting` still
  // saved until it decides, so a listener stopped meanwhile asks again: a pull request closed
  // or merged since is dropped quietly, and GitHub failing to answer waits for the next try.
  async function decide(key, repo, number, { settings, grant }, waiting, again = false) {
    const { sha, review, allowed } = waiting;
    // A wait saved before the rounds has `fixed`.
    const fixes = waiting.fixes ?? (waiting.fixed ? 1 : 0);
    const minutes = settings.review.mergeWait ?? 0;
    const inTime = () => now() - waiting.since < minutes * 60_000;
    const decided = (fields = {}) =>
      remember(key, sha, { mergeAt: now(), waiting: undefined, ...fields });
    // `rebase`: a conflict run's end decides it again (rebased()).
    const final = (why, rebase = false) => {
      decided(rebase ? { rebaseRetry: true } : {});
      return refuse(key, repo, number, why);
    };
    let gate;
    let res;
    let merging = false;
    try {
      // What autoMerge() checked already: the first of the merge decision's gates.
      const gates = [
        passed(`Severity ≤ ${allowed}`),
        passed("Review: nothing blocking"),
        passed("At the reviewed commit"),
      ];
      gate = await mergeRefusal(
        {
          github,
          config,
          busy,
          sleep,
          policies: asking(waiting.pr ?? { number }),
          externalOf,
          now,
        },
        { repo, number, sha, settings, grant, review, fixes, gates },
      );
      if (gate.pending) {
        if (inTime()) {
          remember(key, sha, { mergeAt: undefined, waiting });
          log(`${key}: waiting for its checks, ${gate.why}`);
          return null;
        }
        const why = minutes
          ? `its checks didn't finish in time (${minutes} minutes, \`review.merge_wait\`): ${gate.why}`
          : gate.why;
        return final(why);
      }
      if (gate.why) {
        // Closed or merged by someone while it waited: nothing to say.
        if (gate.closed && again) {
          decided();
          log(`${key}: not merged, ${gate.why}`);
          return null;
        }
        return final(gate.why, !!gate.rebase);
      }
      // Before the merge: whatever happens next, never a second one.
      decided();
      merging = true;
      res = await github(
        repo,
        "PUT",
        `/repos/${repo}/pulls/${number}/merge`,
        { sha, merge_method: gate.method },
        [405, 409, 422],
      );
    } catch (error) {
      log(`${key}: auto-merge: ${error.stack ?? error}`);
      // The gates unread while it waits: the next run or tick() asks again.
      if (again && !merging && inTime()) {
        remember(key, sha, { mergeAt: undefined, waiting });
        return null;
      }
      // Decided: said, rather than left with only a log line.
      return final(`GitHub couldn't be read (${error.message ?? error})`);
    }
    if (!res.ok) {
      const said = await res.json().catch(() => ({}));
      const detail = said?.message ? `: ${said.message}` : "";
      return refuse(key, repo, number, `GitHub refused the merge (${res.status}${detail})`);
    }
    remember(key, sha, { mergeAt: now(), mergedAt: now() });
    log(`${key}: merged at ${short(sha)} (${gate.method}), auto-merge`);
    merged(repo, { ...gate.pr, state: "closed", merged: true });
    await reply(repo, number, mergedText(sha, gate.method, fixes, review));
    return { sha, method: gate.method };
  }

  // One decision at a time per pull request: a run completing during one asks for another
  // after it (`again`), which finds the pull request still waiting or decided.
  const checking = new Map();
  async function oneAtATime(key, work) {
    checking.set(key, { again: false });
    try {
      let done = await work();
      while (checking.get(key).again) {
        checking.get(key).again = false;
        done = (await recheck(key, { queued: true })) ?? done;
      }
      return done;
    } finally {
      checking.delete(key);
    }
  }

  // The pull request `key` waiting for its checks, decided again now (none waiting: null).
  // `checking` keeps it to one decision at a time; `waiting` stays saved until it decides.
  async function recheck(key, { queued = false } = {}) {
    if (!queued && checking.has(key)) {
      checking.get(key).again = true;
      return null;
    }
    const entry = reviewed.get(key);
    const waiting = entry?.waiting;
    const at = parseKey(key);
    if (!waiting || entry.mergeAt || !at) return null;
    const work = async () => {
      // Unread settings throw: still waiting, for the next run or tick().
      const mode = await mergeMode(at.repo, waiting.base);
      // Turned off meanwhile: the maintainer's, as before a first decision.
      if (!mode) {
        remember(key, entry.head ?? null, { mergeAt: now(), waiting: undefined });
        log(`${key}: auto-merge is off now, no longer waiting`);
        return null;
      }
      return decide(key, at.repo, at.number, mode, waiting, true);
    };
    return queued ? work() : oneAtATime(key, work);
  }

  // A `workflow_run` delivery: when one completed on the commit a pull request waits on, its
  // merge, or its review (`ciWaiting`), is decided again.
  async function checksDone(event, p) {
    if (event !== "workflow_run" || p.action !== "completed") return;
    const repo = p.repository?.full_name;
    const sha = p.workflow_run?.head_sha;
    if (!p.installation?.id || !repo || !sha || !repoAllowed(config, repo)) return;
    const on = (k) => sameRepo(parseKey(k)?.repo, repo);
    const keys = [...reviewed].filter(([k, v]) => v.waiting?.sha === sha && on(k)).map(([k]) => k);
    for (const key of keys) {
      await recheck(key).catch((error) => log(`${key}: auto-merge: ${error.stack ?? error}`));
    }
    const ci = [...reviewed].filter(([k, v]) => v.ciWaiting?.sha === sha && on(k)).map(([k]) => k);
    for (const key of ci) {
      await ciRecheck(key).catch((error) => log(`${key}: CI step: ${error.stack ?? error}`));
    }
  }

  // A `pull_request` `synchronize` delivery: a pull request waiting for CI moves to its new
  // head (ciDecide()), whose runs decide from then on.
  async function pushed(event, p) {
    if (event !== "pull_request" || p.action !== "synchronize") return;
    const repo = p.repository?.full_name;
    const number = p.pull_request?.number;
    if (!p.installation?.id || !repo || !number || !repoAllowed(config, repo)) return;
    const key = taskKey(repo, prId(number));
    const waiting = reviewed.get(key)?.ciWaiting;
    if (!waiting || waiting.sha === p.pull_request.head?.sha) return;
    await ciRecheck(key).catch((error) => log(`${key}: CI step: ${error.stack ?? error}`));
  }

  // A `pull_request` `closed` delivery of a merged pull request: the follow-ups its reviews
  // listed, filed as issues (fileFollowUps()). Closed without a merge: none, they were about it.
  async function closed(event, p) {
    if (event !== "pull_request" || p.action !== "closed" || !p.pull_request?.merged_at)
      return null;
    const repo = p.repository?.full_name;
    const number = p.pull_request.number;
    if (!p.installation?.id || !repo || !number || !repoAllowed(config, repo)) return null;
    // Seen merged: a review still running, or not yet recorded (settle()), files its own
    // follow-ups once it is (lateFollowUps()).
    const key = taskKey(repo, prId(number));
    if (reviewed.get(key)) keep(key, { mergedSeen: true });
    return filingFollowUps(repo, p.pull_request, p.repository.default_branch || "main");
  }

  // A review posted on pull request `number` after its merge was seen (`mergedSeen`), or on a
  // pull request merged by then (`posted.pr`), with follow-ups: they are filed now, the merge's
  // delivery having come before this review's round was recorded. Those an issue already has
  // (filed after an earlier review) are linked, not filed again.
  async function lateFollowUps({ repo, number, base }, posted) {
    const key = taskKey(repo, prId(number));
    const pr = posted?.pr;
    const merged = pr?.merged || pr?.merged_at || reviewed.get(key)?.mergedSeen;
    if (!merged || !posted?.review?.followUps?.length) return null;
    try {
      return await filingFollowUps(repo, pr ?? { number }, base, { late: true });
    } catch (error) {
      log(`${key}: filing the follow-ups of a review after the merge: ${error.message ?? error}`);
      return null;
    }
  }

  // fileFollowUps(), one at a time per pull request: a late review's (lateFollowUps()) and a
  // merge's delivery at once would both file what neither has seen filed yet.
  const filing = new Map();
  function filingFollowUps(repo, pr, base, options) {
    const key = taskKey(repo, prId(pr.number));
    const next = (filing.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => fileFollowUps(repo, pr, base, options));
    filing.set(key, next);
    next
      .finally(() => {
        if (filing.get(key) === next) filing.delete(key);
      })
      .catch(() => {});
    return next;
  }

  // The follow-ups of the App's reviews of merged pull request `pr` (GitHub's), each filed as an
  // issue labelled FOLLOW_UP_LABEL that links it, then listed in one comment on it. Once per pull
  // request (`followUpsAt`, kept before the first write: a redelivery or a restart files nothing
  // twice, and a failure midway leaves the rest to the maintainer, logged), and only one a review
  // of which listed some (`hasFollowUps`, recordRound()): other merges cost no GitHub call. The
  // same title in several reviews is filed once; one an issue with the label already has is
  // linked, not filed.
  // → the issues' numbers, or null.
  // `late`: a review recorded after the merge (lateFollowUps()), past the mark: what an issue
  // has already is linked rather than filed, and the comment says only what is new.
  async function fileFollowUps(repo, pr, base, { late = false } = {}) {
    const key = taskKey(repo, prId(pr.number));
    const entry = reviewed.get(key);
    const listed = entry?.hasFollowUps || entry?.rounds?.some((r) => r.followUps);
    if (!listed || (entry.followUpsAt && !late)) return null;
    const bot = config.bot?.toLowerCase();
    if (!bot) return null;
    // The repo's settings now, from its default branch: a `review` block still there, without
    // `follow_ups: false`. A config with errors files nothing (fail closed).
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length || !settings.review || settings.review.followUps === false) {
      const why = errors.length
        ? "its config has errors"
        : !settings.review
          ? "reviews are off now"
          : "`review.follow_ups: false`";
      log(`${key}: merged, its follow-ups not filed: ${why}`);
      return null;
    }
    const get = (path) => github(repo, "GET", path);
    // The App's, opening with a review's head line: another body of the App's (a run's reply
    // quoting one) never counts.
    const own = (c) =>
      c.user?.login?.toLowerCase() === bot && REVIEW_HEAD.test(String(c.body ?? "").split("\n")[0]);
    // Its reviews with the marker, then the reviews GitHub refused, posted as plain comments
    // (postReview()): only those whose ids their rounds kept, as the App's other comments may
    // be any run's text.
    const reviews = (await paginate(get, `/repos/${repo}/pulls/${pr.number}/reviews`)).filter(
      (r) => own(r) && (r.body ?? "").includes(MARKER),
    );
    const ids = new Set(
      [...(entry.reviewComments ?? []), ...(entry.rounds ?? []).map((r) => r.commentId)].filter(
        Boolean,
      ),
    );
    const comments = ids.size
      ? (await paginate(get, `/repos/${repo}/issues/${pr.number}/comments`)).filter(
          (c) => ids.has(c.id) && own(c),
        )
      : [];
    const site = pr.base?.repo?.html_url ?? null;
    const found = new Map();
    for (const r of [...reviews, ...comments]) {
      for (const f of parsePostedReview(r.body)?.followUps ?? []) {
        const id = titleKey(f.title);
        if (id && !found.has(id)) found.set(id, { ...f, review: r });
      }
    }
    if (!found.size) {
      log(`${key}: merged, its reviews counted follow-ups but none could be read back`);
      return null;
    }
    const labelled = await paginate(
      get,
      `/repos/${repo}/issues?labels=${encodeURIComponent(FOLLOW_UP_LABEL)}&state=all`,
    );
    const known = new Map(
      labelled.filter((i) => !i.pull_request).map((i) => [titleKey(i.title), i.number]),
    );
    // Before the first write: a read that failed above is tried again by a redelivery, but
    // nothing is filed twice. Asked again here, with no wait before the mark: a redelivery that
    // came during the reads above may have marked it since.
    if (!late && reviewed.get(key)?.followUpsAt) return null;
    // `followUpIssues` with it, empty: an entry with the mark and without the list was filed
    // before the listener kept which issue each follow-up became (followUpsOf()).
    keep(key, {
      followUpsAt: now(),
      followUpIssues: reviewed.get(key)?.followUpIssues ?? [],
    });
    // Its colour and description, should the repo not have it yet.
    await ensureLabel(
      github,
      repo,
      {
        name: FOLLOW_UP_LABEL,
        color: "c5def5",
        description: "Found by Deckhand's review of a pull request, for another issue",
      },
      log,
    );
    const issue = linkedIssue(pr, repo, config.bot);
    const filed = [];
    const linked = [];
    // Who the issues filed now are auto-picked for (pickupFor()), asked before the first one.
    let pickup;
    // Past FOLLOW_UPS_MAX filed for the pull request, its earlier merges' or reviews' included,
    // the titles only, listed for the maintainer.
    const before = reviewed.get(key)?.followUpsFiled ?? 0;
    const left = [];
    // Which issue each follow-up is (`followUpIssues`, by title, filed now or before) and which
    // GitHub refused (`followUpsRefused`): the dashboard's Review tab says so (findings()).
    const issues = new Map(
      (reviewed.get(key)?.followUpIssues ?? []).map((x) => [x.title, x.issue]),
    );
    const refused = new Set(reviewed.get(key)?.followUpsRefused ?? []);
    // Kept as each one is known: a throw midway leaves the rest to the maintainer, not these.
    const note = () =>
      keep(key, {
        followUpIssues: [...issues].map(([title, issue]) => ({ title, issue })),
        followUpsRefused: refused.size ? [...refused] : undefined,
      });
    for (const [id, f] of found) {
      if (known.has(id)) {
        linked.push(known.get(id));
        issues.set(id, known.get(id));
        refused.delete(id);
        note();
        continue;
      }
      if (before + filed.length >= FOLLOW_UPS_MAX) {
        left.push(f.title);
        continue;
      }
      const body = followUpBody(f, { number: pr.number, issue, site });
      if (pickup === undefined) pickup = await pickupFor(repo, pr, settings);
      const res = await github(repo, "POST", `/repos/${repo}/issues`, {
        title: f.title,
        body,
        labels: pickup?.by ? [FOLLOW_UP_LABEL, config.autoPickupLabel] : [FOLLOW_UP_LABEL],
      });
      if (!res.ok) {
        log(`${key}: GitHub refused the follow-up issue "${f.title}" (${res.status})`);
        refused.add(id);
        note();
        continue;
      }
      const made = await res.json();
      known.set(id, made.number);
      filed.push(made.number);
      issues.set(id, made.number);
      refused.delete(id);
      note();
      // What vouches for the App's labelling (followUpPick()): the merger, and the label's
      // time, the issue's creation's. Kept at once: a sweep may read the issue any time now.
      if (pickup?.by) {
        const pickups = reviewed.get(key)?.pickups ?? [];
        const at = made.created_at ?? new Date(now()).toISOString();
        keep(key, { pickups: [...pickups, { issue: made.number, by: pickup.by, at }] });
      }
    }
    log(`${key}: merged, ${filed.length} follow-up issue(s) filed, ${left.length} left`);
    // The titles left past the cap and listed already (`followUpsLeft`): never said twice.
    const said = new Set(reviewed.get(key)?.followUpsLeft ?? []);
    const unsaid = left.filter((title) => !said.has(titleKey(title)));
    keep(key, {
      ...(filed.length && { followUpsFiled: before + filed.length }),
      ...(unsaid.length && { followUpsLeft: [...said, ...unsaid.map(titleKey)] }),
    });
    // After a late review, only what is new: the merge's comment listed the rest.
    if (late && !filed.length && !unsaid.length) return filed;
    if (!filed.length && !linked.length && !unsaid.length) return filed;
    await reply(repo, pr.number, followUpsText(filed, late ? [] : linked, unsaid, pickup));
    return filed;
  }

  // Who the follow-ups of merged pull request `pr` filed now are auto-picked for (#677):
  // { by }, the person who merged it, an allowed user, who reviewed the follow-ups there;
  // { why } when it isn't one (Deckhand's auto-merge, a bot, someone else), said in the
  // comment; null when the repo doesn't ask for it, or nothing would pick them.
  async function pickupFor(repo, pr, settings) {
    if (!settings.review.followUpsAutoPickup || !settings.autoPickup) return null;
    const label = config.autoPickupLabel;
    if (!config.autoPickupSlots || !label) return null;
    const refused = (why) => ({ why, label });
    let merger = pr.merged_by;
    // A late review's pull request may not say: GitHub's, read once more.
    if (!merger?.login) {
      try {
        merger = (await getJson(github, repo, `/repos/${repo}/pulls/${pr.number}`, [404]))
          ?.merged_by;
      } catch (error) {
        log(`${repo}#${pr.number}: who merged it: ${error.message ?? error}`);
      }
    }
    const login = merger?.login;
    if (!login) return refused("who merged the pull request couldn't be read");
    const name = login.toLowerCase();
    if (name === config.bot?.toLowerCase()) {
      return refused("Deckhand merged it (`review.merge`), not a person");
    }
    if (isBot(merger)) return refused(`it was merged by a bot (\`${login}\`)`);
    // As auto-pickup decides it at the pick, which checks it again then.
    if (!allowed(merger, config, settings.users)) {
      return refused(`it was merged by \`${login}\`, who isn't an allowed user`);
    }
    return { by: login, label };
  }

  // The follow-up `number` of `repo` that fileFollowUps() labelled for auto-pickup at `at`
  // (ms, the `labeled` event's), within a second or two → { by, pr }: who the run is for, and
  // the pull request it follows up. Null for any other labelling by the App (a run's).
  function followUpPick(repo, number, at) {
    for (const [k, v] of reviewed) {
      const parsed = parseKey(k);
      if (!v.pickups || !sameRepo(parsed?.repo, repo)) continue;
      const found = v.pickups.find(
        (p) => p.issue === number && Math.abs(Date.parse(p.at) - at) <= PICK_SKEW_MS,
      );
      if (found) return { by: found.by, pr: parsed.number };
    }
    return null;
  }

  // A run of `repo` is over (run-end.mjs cleanUp()): its pull requests waiting for CI are decided
  // again, a CI fix run having waited for the issue's task (ciFailed()). Not waited for.
  function runEnded(repo) {
    const keys = [...reviewed]
      .filter(([k, v]) => v.ciWaiting && sameRepo(parseKey(k)?.repo, repo))
      .map(([k]) => k);
    for (const key of keys) {
      ciRecheck(key).catch((error) => log(`${key}: CI step: ${error.stack ?? error}`));
    }
  }

  // Every pull request still waiting, decided again: past `review.merge_wait`, refused; past
  // `review.ci_wait`, reviewed; and what a lost `workflow_run` delivery would have decided.
  async function tick() {
    const keys = [...reviewed].filter(([, v]) => v.waiting && !v.mergeAt).map(([k]) => k);
    for (const key of keys) {
      await recheck(key).catch((error) => log(`${key}: auto-merge: ${error.stack ?? error}`));
    }
    const ci = [...reviewed].filter(([, v]) => v.ciWaiting).map(([k]) => k);
    for (const key of ci) {
      await ciRecheck(key).catch((error) => log(`${key}: CI step: ${error.stack ?? error}`));
    }
    const retries = [...reviewed].filter(([, v]) => v.policyRetry).map(([k]) => k);
    for (const key of retries) {
      await policyRecheck(key).catch((error) => log(`${key}: review: ${error.stack ?? error}`));
    }
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => tick(), WAIT_TICK_MS);
    timer.unref?.();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // A fix run is over (run-end.mjs cleanUp(), `status` its outcome): one more review of what it
  // pushed, once per fix run (reviewedFixes), whose end starts the next fix run or stops the
  // loop (settle()). In auto-merge mode, or with more than one round (a round granted from the
  // dashboard counts): `fix: true` without `merge` reviews nothing after its one fix run, as
  // before the rounds (issue #376). A fix that
  // failed or pushed nothing leaves the pull request to the maintainer: in auto-merge mode, a
  // comment says why it isn't merged.
  async function fixed(run) {
    const key = taskKey(run.repo, prId(run.number));
    const since = reviewed.get(key)?.nextAt;
    let item = null;
    return deciding(key, "review-fix", async () => {
      try {
        item = await reviewFix(run);
        return item;
      } finally {
        // Its review queued says it is on its way (queueReview()); else the loop is over,
        // unless another step was queued since.
        if (!item) nextStep(key, null, since);
      }
    });
  }

  // fixed()'s work: the review queued, or null.
  async function reviewFix({ repo, number, base, status }) {
    const key = taskKey(repo, prId(number));
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length || !settings.review?.fix) return null;
    const entry = reviewed.get(key) ?? {};
    const fixes = fixesOf(entry);
    if (!fixes || reviewedFixesOf(entry) >= fixes || entry.mergeAt || entry.waiting) return null;
    const mode = await mergeMode(repo, base);
    // `fix: true` without `merge`: by design, nothing reviews what it pushed. Kept, so the
    // dashboard doesn't take the review before it for what is left (reviewLoop()). A round a
    // maintainer asked for from the dashboard (`asked`) is always reviewed.
    if (!mode && limitOf(settings, entry) < 2 && entry.asked !== fixes) {
      if (status === "ok") remember(key, entry.head ?? null, { unreviewedFix: fixes });
      return null;
    }
    remember(key, entry.head ?? null, { reviewedFixes: fixes });
    const stop = async (why) => {
      if (!mode) {
        log(`${key}: no review after the fix run, ${why}`);
        return null;
      }
      remember(key, entry.head ?? null, { mergeAt: now() });
      return refuse(key, repo, number, why);
    };
    if (status !== "ok") return stop(`the fix run ended with \`${status}\``);
    let pr;
    try {
      pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`, [404]);
    } catch (error) {
      log(`${key}: after the fix run: ${error.stack ?? error}`);
      return stop(`GitHub couldn't be read (${error.message ?? error})`);
    }
    if (!pr || pr.state !== "open") return null;
    const head = pr.head?.sha ?? null;
    const from = entry.asked === fixes && entry.askedFrom ? entry.askedFrom : entry.head;
    if (!head || head === from) {
      return stop("the fix run pushed nothing, so the review's findings still stand");
    }
    // The review after a fix run is an automatic one too: refused, the merge is the maintainer's.
    const denied = await denyReview(repo, base, pr, [
      passed("Fix run pushed"),
      passed("Deckhand's own pull request"),
    ]);
    if (denied.length) return stop(policyWhy("deny_review", denied));
    remember(key, head);
    log(`${key}: fix run ${fixes} pushed ${short(head)}, starting its review`);
    return reviewAfterCi({ repo, base, pr, settings });
  }

  // The CI step (`review.ci: wait`) before an automatic review of `pr`: without it, the review
  // is queued at once. With it, the pull request waits for its head commit's Actions runs
  // (`ciWaiting`, kept in its entry: a restart goes on waiting), decided now, then again by
  // checksDone(), pushed() and tick() (ciDecide()). → the review queued, a CI fix run's item,
  // or null (waiting, or stopped).
  // `afterCiFix`: `pr`'s head is what a CI fix run pushed ("pushed"), or the same commit whose
  // failed jobs it reran ("reran": afterCiFix(), `reran` the ids of the workflow runs it reran
  // there), for the next one's message.
  async function reviewAfterCi({
    repo,
    base,
    pr,
    settings,
    author = null,
    afterCiFix = false,
    reran = [],
  }) {
    if (!ciOn(settings)) return queueReview({ repo, base, pr, settings, author });
    const key = taskKey(repo, prId(pr.number));
    const sha = pr.head?.sha ?? null;
    remember(key, sha, {
      // `true` for "pushed", as entries saved before reruns have it.
      ciWaiting: {
        sha,
        since: now(),
        base,
        author,
        ...(afterCiFix && { afterCiFix: afterCiFix === "reran" ? "reran" : true }),
        ...(afterCiFix === "reran" && { reran }),
      },
      ciDropped: undefined,
      ciStopped: undefined,
    });
    return ciRecheck(key);
  }

  // One CI decision at a time per pull request: each waits for the one before, and finds the
  // pull request still waiting or decided.
  const ciQueue = new Map();
  function ciRecheck(key) {
    // The loop is on its CI step until what follows the wait is queued: ciDecide() clears the
    // wait before it queues the review or the CI fix run, and an auto-picked task keeps its
    // reserved slot only while its loop goes on (tasks.mjs pickHolds()).
    const decide = () =>
      reviewed.get(key)?.ciWaiting ? deciding(key, "ci", () => ciDecide(key)) : ciDecide(key);
    const next = (ciQueue.get(key) ?? Promise.resolve()).catch(() => {}).then(decide);
    ciQueue.set(key, next);
    next
      .finally(() => {
        if (ciQueue.get(key) === next) ciQueue.delete(key);
      })
      .catch(() => {});
    return next;
  }

  // The pull request `key` waiting for CI, decided: the review once its head commit's Actions
  // runs passed (or it has none past CI_GRACE_MS), or `review.ci_wait` minutes after the wait
  // started, with a note; on a failed run, ciFailed(). A push meanwhile moves the wait to the
  // new head, from now; closed, a draft again, or the review turned off: no longer waiting.
  // GitHub failing to answer throws, and the wait stays for the next try.
  async function ciDecide(key) {
    const entry = reviewed.get(key);
    const waiting = entry?.ciWaiting;
    const at = parseKey(key);
    if (!waiting || !at) return null;
    const { repo, number } = at;
    const { base } = waiting;
    const author = waiting.author ?? null;
    // The head it waited on was never reviewed: ready again at it, consider() reviews it.
    const drop = (why) => {
      remember(key, entry.head ?? null, { ciWaiting: undefined, ciDropped: entry.head ?? null });
      log(`${key}: no longer waiting for CI, ${why}`);
      return null;
    };
    const pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`, [404]);
    if (!pr || pr.state !== "open") return drop("the pull request isn't open");
    if (pr.draft) return drop("the pull request is a draft again");
    const sha = pr.head?.sha ?? null;
    if (sha !== waiting.sha) {
      const { afterCiFix: _, reran: __, ...moved } = waiting;
      remember(key, sha, { ciWaiting: { ...moved, sha, since: now() } });
      log(`${key}: pushed while waiting for CI, now waiting on ${short(sha)}`);
      // Its runs may not exist yet: asked again once the grace is over, not at the next tick().
      later(() => {
        ciRecheck(key).catch((error) => log(`${key}: CI step: ${error.stack ?? error}`));
      }, CI_GRACE_MS);
      return null;
    }
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length) return drop(`${repo}'s config has errors`);
    if (settings.review?.on !== "ready") return drop("`review.on` isn't `ready` any more");
    const review = (ciNote = null) => {
      remember(key, sha, { ciWaiting: undefined });
      return queueReview({ repo, base, pr, settings, author, ciNote });
    };
    // Turned off meanwhile: the review, as without it.
    if (!ciOn(settings)) return review();
    const minutes = settings.review.ciWait ?? 30;
    const waited = now() - waiting.since;
    const read = await actionsRuns(github, repo, sha);
    if (!read.ok) {
      log(`${key}: its Actions runs can't be read (${read.status}), starting the review`);
      return review(ciNoteText(`its GitHub Actions runs couldn't be read (${read.status})`));
    }
    const { state, failed, going } = ciState(read.runs);
    const grace = Math.min(CI_GRACE_MS, minutes * 60_000);
    if (state === "none" && waited < grace) {
      log(`${key}: no Actions run on ${short(sha)} yet, waiting for CI`);
      // Asked again once the grace is over, rather than at the next tick(), minutes later.
      later(() => {
        ciRecheck(key).catch((error) => log(`${key}: CI step: ${error.stack ?? error}`));
      }, grace - waited);
      return null;
    }
    if (state === "passed" || state === "none") {
      log(
        `${key}: CI ${state === "passed" ? "passed" : "has no run"} on ${short(sha)}, starting the review`,
      );
      return review();
    }
    if (state === "running") {
      if (waited < minutes * 60_000) {
        log(`${key}: waiting for CI, ${going.length} Actions run(s) on ${short(sha)} going`);
        return null;
      }
      log(`${key}: CI didn't finish in ${minutes} minutes, starting the review`);
      const runs =
        going.length > 1 ? `${going.length} GitHub Actions runs` : "a GitHub Actions run";
      return review(
        ciNoteText(
          `${runs} on ${short(sha)} still hadn't finished after ${minutes} minutes (\`review.ci_wait\`)`,
        ),
      );
    }
    return ciFailed(key, {
      repo,
      number,
      base,
      pr,
      settings,
      author,
      sha,
      runs: read.runs,
      failed,
      again: waiting.afterCiFix === "reran" ? "reran" : !!waiting.afterCiFix,
      reran: Array.isArray(waiting.reran) ? waiting.reran : [],
    });
  }

  // CI failed on `sha`, the head commit of pull request `key`: no review, a comment naming the
  // failed runs, then a CI fix run, with the gates of a review's fix run (startFix()): Deckhand's
  // own open pull request, a CI fix round left (`review.ci_fix`, counted in `ciFixes` before it
  // is queued, apart from the review's `fixes`), no run going, nobody's input awaited, and
  // `deny_fix` (`ci: true`). Out of rounds, or no CI fix run possible here (`review.fix` off,
  // someone else's pull request): the review anyway, told CI failed. Refused otherwise: the
  // pull request waits for a maintainer.
  async function ciFailed(
    key,
    { repo, number, base, pr, settings, author, sha, runs, failed, again = false, reran = [] },
  ) {
    // Decided: whatever follows, this head commit's wait is over. Not while the issue's task is
    // busy: the work run whose `gh pr ready` got here may still be going, after a quick CI
    // failure. The wait stays, decided again when a run ends (runEnded()) or by tick().
    const decided = (fields = {}) => remember(key, sha, { ciWaiting: undefined, ...fields });
    const waitForTask = (why) => {
      log(`${key}: CI failed on ${short(sha)}, ${why}: deciding again once it is over`);
      return null;
    };
    const say = async (next) => {
      try {
        await reply(repo, number, ciFailedText(sha, failed, next));
      } catch (error) {
        log(`${key}: saying CI failed: ${error.message ?? error}`);
      }
    };
    const names = failed.slice(0, 5).map((r) => `${oneLine(r.name)} (${r.conclusion})`);
    const anyway = async (next) => {
      decided();
      log(`${key}: CI failed on ${short(sha)}, reviewing anyway`);
      await say(next);
      const ciNote = ciNoteText(`GitHub Actions runs on ${short(sha)} failed: ${names.join(", ")}`);
      return queueReview({ repo, base, pr, settings, author, ciNote });
    };
    const stop = async (why) => {
      decided({ ciStopped: { sha, at: now() } });
      log(`${key}: CI failed on ${short(sha)}, no CI fix run, ${why}`);
      await say(CI_NEXT.stop(why));
      return null;
    };
    const rounds = ciRoundsOf(settings);
    if (!rounds) {
      return anyway(
        CI_NEXT.none(settings.review.fix ? "`review.ci_fix: 0`" : "`review.fix` is off"),
      );
    }
    const entry = reviewed.get(key) ?? {};
    const done = entry.ciFixes ?? 0;
    if (done >= rounds) return anyway(CI_NEXT.out(done));
    const round = done + 1;
    const own = !!config.bot && pr.user?.login?.toLowerCase() === config.bot.toLowerCase();
    const issue = own && headInRepo(pr, repo) ? linkedIssue(pr, repo, config.bot) : null;
    if (!issue) return anyway(CI_NEXT.none("it isn't Deckhand's own pull request"));
    const task = taskKey(repo, String(issue));
    if (busy(task)) return waitForTask(`#${issue} has a run going or queued`);
    if (await waitsForInput(github, config, repo, pr, issue)) {
      return stop(`it or #${issue} waits for the maintainer's input`);
    }
    if (stopped(task)) return stop(stoppedWhy(issue));
    if (policies) {
      const gates = [
        passed("CI failed"),
        passed("Deckhand's own pull request, open"),
        passed(rounds > 1 ? `CI fix round ${round} of ${rounds}` : "First CI fix run"),
        passed("No run going"),
        passed("Nobody's input awaited"),
      ];
      const extra = {
        ...fixInput(fixesOf(entry)),
        ci: true,
        reason: "ci",
        round,
        rounds,
        checks: checksOf(runs),
      };
      const denied = await asking(pr).deny(
        "deny_fix",
        repo,
        base,
        () =>
          readPullInput(
            github,
            {
              decision: "fix",
              repo,
              pr,
              issue,
              bot: config.bot,
              external: externalOf(repo, pr.number),
              now,
            },
            extra,
          ),
        { gates },
      );
      if (denied.length) return stop(policyWhy("deny_fix", denied));
    }
    const withJobs = await failedJobs(repo, failed);
    // Checked again: a comment may have come during the calls above.
    if (busy(task)) return waitForTask(`#${issue} has a run going or queued`);
    // Before queuing: whatever happens next, never this round twice (in the store first,
    // counted()).
    const before = reviewed.get(key);
    decided({ ciFixes: round, ciRounds: rounds, ciFixedAt: now(), next: "ci-fix", nextAt: now() });
    if (!(await counted(key, before, task))) {
      return waitForTask(`#${issue} has a run going or queued`);
    }
    log(`${key}: CI failed on ${short(sha)}, starting a CI fix run (${round} of ${rounds})`);
    const item = {
      repo,
      id: String(issue),
      kind: "issue",
      number: issue,
      title: null,
      trigger: "work",
      modeLine: null,
      text: ciFixMessage(number, sha, withJobs, { round, rounds, again, reran }),
      replyTo: number,
      comment: null,
      base,
      settings,
      sender: null,
      reason: "ci-fix",
      // For the dashboard's "CI fix 1/2" (runs.mjs newLive()).
      round,
      rounds,
    };
    await accept(item);
    await say(CI_NEXT.fix(round, rounds));
    return item;
  }

  // The failed runs, each with its failed jobs (`jobs`: name, conclusion, URL), for the CI fix
  // run's message: the first runs only, and none of a run whose jobs can't be read.
  async function failedJobs(repo, failed) {
    const out = [];
    for (const [i, run] of failed.entries()) {
      let jobs = [];
      if (i < 5 && run.id != null) {
        try {
          const res = await github(
            repo,
            "GET",
            `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
            null,
            [403, 404],
          );
          if (res.ok) {
            jobs = ((await res.json()).jobs ?? []).filter(
              (j) => j.status === "completed" && !PASSED.has(j.conclusion),
            );
          }
        } catch (error) {
          log(`${repo}: run ${run.id}'s jobs: ${error.message ?? error}`);
        }
      }
      out.push({ ...run, jobs });
    }
    return out;
  }

  // A CI fix run is over (run-end.mjs cleanUp(), `status` its outcome): what it pushed goes back to
  // the CI step (reviewAfterCi()), once per CI fix run (`ciSettled`), and so does the same head
  // when it reran its failed jobs instead (`reruns`, github-writes.mjs: a flaky job). One that
  // failed, or pushed and reran nothing, leaves the pull request to the maintainer, said on it.
  async function ciFixed(run) {
    const key = taskKey(run.repo, prId(run.number));
    const since = reviewed.get(key)?.nextAt;
    let item = null;
    return deciding(key, "ci-fix", async () => {
      try {
        item = await afterCiFix(run);
        return item;
      } finally {
        if (!item) nextStep(key, null, since);
      }
    });
  }

  // ciFixed()'s work: the review queued or a CI fix run's item, or null.
  async function afterCiFix({ repo, number, base, status, reruns = [] }) {
    const key = taskKey(repo, prId(number));
    const entry = reviewed.get(key) ?? {};
    const fixes = entry.ciFixes ?? 0;
    if (!fixes || (entry.ciSettled ?? 0) >= fixes) return null;
    remember(key, entry.head ?? null, { ciSettled: fixes });
    const stop = async (why) => {
      const head = reviewed.get(key)?.head ?? null;
      remember(key, head, { ciStopped: { sha: head, at: now() } });
      log(`${key}: no review after the CI fix run, ${why}`);
      await reply(repo, number, ciStoppedText(why));
      return null;
    };
    if (status !== "ok") return stop(`the CI fix run ended with \`${status}\``);
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length || settings.review?.on !== "ready") {
      log(`${key}: after the CI fix run, no automatic review in ${repo} now`);
      return null;
    }
    let pr;
    try {
      pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`, [404]);
    } catch (error) {
      log(`${key}: after the CI fix run: ${error.stack ?? error}`);
      return stop(`GitHub couldn't be read (${error.message ?? error})`);
    }
    if (!pr || pr.state !== "open") return null;
    const head = pr.head?.sha ?? null;
    const reran = !!head && head === entry.head && reruns.some((r) => r.sha === head);
    if (!head || (head === entry.head && !reran)) {
      return stop(`the CI fix run pushed nothing, so CI still fails on ${short(entry.head)}`);
    }
    const denied = await denyReview(repo, base, pr, [
      passed(reran ? "CI fix run reran failed jobs" : "CI fix run pushed"),
      passed("Deckhand's own pull request"),
    ]);
    if (denied.length) return stop(policyWhy("deny_review", denied));
    remember(key, head);
    const what = reran ? `reran failed jobs on ${short(head)}` : `pushed ${short(head)}`;
    log(`${key}: CI fix run ${fixes} ${what}, back to waiting for CI`);
    // The workflow runs it reran on that commit, for the next CI fix run's message.
    const rerunIds = reran
      ? [...new Set(reruns.filter((r) => r.sha === head).map((r) => r.run_id))]
      : [];
    return reviewAfterCi({
      repo,
      base,
      pr,
      settings,
      afterCiFix: reran ? "reran" : "pushed",
      reran: rerunIds,
    });
  }

  // A conflict run is over (run-end.mjs cleanUp(), conflicts.mjs, `status` its outcome, `from` the
  // head it started from): the loop goes on from the rebased head, as after a fix run. Its
  // review, after the CI step, leads to a fix run or the merge as usual; it uses up no fix
  // round. Only for a pull request the loop reviewed (`head`), with `review.on: ready` still.
  // What the conflict ended is cleared: a merge refused for the conflict, a run going or a
  // moved head, a fix run skipped (`rebaseRetry`), or a merge waiting for the old head's checks.
  // Any other merge decision stands (mergeAt): the review says what the rebase changed, and
  // merges nothing. A rebase that failed, stopped to ask or pushed nothing leaves the pull
  // request as it was. Its own (head, base) pair is the conflict watcher's: no second rebase.
  async function rebased(run) {
    const key = taskKey(run.repo, prId(run.number));
    const since = reviewed.get(key)?.nextAt;
    let item = null;
    return deciding(key, "review", async () => {
      try {
        item = await afterRebase(run);
        return item;
      } finally {
        if (!item) nextStep(key, null, since);
      }
    });
  }

  // rebased()'s work: the review queued, or null (waiting for CI, or nothing to do).
  async function afterRebase({ repo, number, base, status, from = null }) {
    const key = taskKey(repo, prId(number));
    const entry = reviewed.get(key);
    if (!entry?.head) return null;
    const leave = (why) => {
      log(`${key}: no review after the rebase run, ${why}`);
      return null;
    };
    if (status !== "ok") return leave(`it ended with \`${status}\``);
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length || settings.review?.on !== "ready") {
      return leave(`no automatic review in ${repo} now`);
    }
    const pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`, [404]);
    if (!pr || pr.state !== "open" || pr.draft)
      return leave("the pull request isn't open and ready");
    const head = pr.head?.sha ?? null;
    // Before queued items carried it, the reviewed head: what the loop knew last.
    if (!head || head === (from ?? entry.head)) return leave("it pushed nothing");
    if (head === entry.head) return leave(`${short(head)} was reviewed already`);
    const issue = linkedIssue(pr, repo, config.bot);
    if (await waitsForInput(github, config, repo, pr, issue)) {
      return leave("it waits for the maintainer's input");
    }
    // Its CI step follows the new head itself (pushed(), ciDecide()).
    if (entry.ciWaiting) return ciRecheck(key);
    const denied = await denyReview(repo, base, pr, [
      passed("Rebase run pushed"),
      passed("Deckhand's own pull request"),
    ]);
    if (denied.length) return leave(policyWhy("deny_review", denied));
    const lifted = entry.rebaseRetry || (entry.waiting && !entry.mergeAt);
    remember(key, head, {
      rebaseRetry: undefined,
      ...(lifted && { mergeAt: undefined, waiting: undefined }),
    });
    log(`${key}: the rebase run pushed ${short(head)}, starting its review`);
    return reviewAfterCi({ repo, base, pr, settings });
  }

  // Whether the loop of pull request `number` is between two of its steps: what follows a
  // run being decided (`decisions`, from the run's end on), or waiting for CI. The conflict
  // watcher starts no rebase run then (conflicts.mjs). Not a merge waiting for checks: a
  // conflict refuses it anyway, and the rebase's end goes on with the loop (rebased()).
  function looping(repo, number) {
    const key = taskKey(repo, prId(number));
    return decisions.has(key) || !!reviewed.get(key)?.ciWaiting;
  }

  // Rekeyed with spelled() (restart.mjs unifySpellings()). Both spellings of one pull request:
  // the later review's, with what only the other had (an auto-merge), the most fix runs either
  // counted, so none happens twice, and the follow-ups' records of both, so the Review tab keeps
  // every issue they became.
  function respell(spelled) {
    const merge = (a, b) => {
      const [earlier, later] = (a.at ?? 0) >= (b.at ?? 0) ? [b, a] : [a, b];
      const both = { ...earlier, ...later };
      const fixes = Math.max(fixesOf(a), fixesOf(b));
      const reviewedFixes = Math.max(reviewedFixesOf(a), reviewedFixesOf(b));
      const ciFixes = Math.max(a.ciFixes ?? 0, b.ciFixes ?? 0);
      const grantedTo = Math.max(a.grantedTo ?? 0, b.grantedTo ?? 0);
      // The follow-ups either listed, and the comments either posted reviews as.
      const hasFollowUps = !!(a.hasFollowUps || b.hasFollowUps);
      const reviewComments = [
        ...new Set([...(a.reviewComments ?? []), ...(b.reviewComments ?? [])]),
      ];
      // The follow-ups either labelled for auto-pickup.
      const pickups = [...(a.pickups ?? []), ...(b.pickups ?? [])].filter(
        (p, i, all) => all.findIndex((q) => q.issue === p.issue && q.at === p.at) === i,
      );
      // The issue each follow-up became under either spelling, by title, the later's first; a
      // title one refused and the other filed isn't refused any more. The titles left past the
      // cap that either listed, and the most either filed (the cap counts them).
      const issues = new Map(
        [...(earlier.followUpIssues ?? []), ...(later.followUpIssues ?? [])].map((x) => [
          x.title,
          x.issue,
        ]),
      );
      const followUpIssues = [...issues].map(([title, issue]) => ({ title, issue }));
      const keptIssues = !!(a.followUpIssues || b.followUpIssues);
      const followUpsRefused = [
        ...new Set([...(earlier.followUpsRefused ?? []), ...(later.followUpsRefused ?? [])]),
      ].filter((title) => !issues.has(title));
      const followUpsLeft = [
        ...new Set([...(earlier.followUpsLeft ?? []), ...(later.followUpsLeft ?? [])]),
      ];
      const followUpsFiled = Math.max(a.followUpsFiled ?? 0, b.followUpsFiled ?? 0);
      // The last fix run's time goes with the count.
      const fixedAt = Math.max(a.fixedAt ?? 0, b.fixedAt ?? 0);
      return {
        ...both,
        ...(fixes && { fixes }),
        ...(fixedAt && { fixedAt }),
        ...(reviewedFixes && { reviewedFixes }),
        ...(ciFixes && { ciFixes }),
        ...(grantedTo && { grantedTo }),
        ...(hasFollowUps && { hasFollowUps }),
        ...(reviewComments.length && { reviewComments }),
        ...(pickups.length && { pickups }),
        // Kept even empty: with `followUpsAt`, it says the issues were filed knowing which.
        ...(keptIssues && { followUpIssues }),
        ...(both.followUpsRefused && {
          followUpsRefused: followUpsRefused.length ? followUpsRefused : undefined,
        }),
        ...(followUpsLeft.length && { followUpsLeft }),
        ...(followUpsFiled && { followUpsFiled }),
      };
    };
    respellMap(reviewed, spelled, undefined, merge);
  }

  // `/mode policy` on pull request `number` (task-modes.mjs): every rule evaluated on its input
  // now → { text, denials }: the reply (dryRunText()) and how many messages the rules denied
  // with. Nothing is reviewed, fixed, merged or kept as a decision: a maintainer debugging a
  // rule doesn't wait for a ready event.
  async function dryRun({ repo, base, number, by = null }) {
    if (!policies) return { text: dryRunText({ number, files: [] }), denials: 0 };
    const described = await policies.describe(repo, base);
    // What decide() evaluates: a file the operator's replaces isn't.
    const files = described.files.filter((f) => f.active);
    const errors = described.errors.map((e) => e.text);
    const texts = described.policies;
    if (!files.length) return { text: dryRunText({ number, files }), denials: 0 };
    const pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`);
    const info = await getJson(github, repo, `/repos/${repo}`);
    const prFiles = await paginate(
      (path) => github(repo, "GET", path),
      `/repos/${repo}/pulls/${number}/files`,
    );
    const issue = linkedIssue(pr, repo, config.bot);
    const found = issue
      ? {
          number: issue,
          ...(await getJson(github, repo, `/repos/${repo}/issues/${issue}`, [404, 410])),
        }
      : null;
    const sha = pr.head?.sha;
    const runs = sha ? (await actionsRuns(github, repo, sha)).runs : [];
    const entry = reviewed.get(taskKey(repo, prId(number)));
    const fixes = fixesOf(entry);
    const { settings } = await repoSettings(repo, base);
    // The merge's input is the fullest: review and fix get the same without `checks`, and
    // with their own `decision`; fix with the round it would be.
    const input = mergeInput({
      info,
      pr,
      files: prFiles,
      issue: found,
      review: null,
      fixes,
      runs,
      bot: config.bot,
      external: externalOf(repo, number),
      now,
    });
    const results = [];
    // `decision` on the input `build()` gives → { messages, layers }.
    const ask = async (decision, build) => {
      const { messages, layers } = await policies.evaluated(decision, repo, texts, build);
      return { decision, messages, layers };
    };
    for (const decision of DECISIONS) {
      // A repository's grants are no decision on a pull request: its config page says them.
      if (OPERATOR_ONLY.has(decision)) continue;
      // No run to start: a comment on this pull request asking for one, by whoever asked.
      if (decision === "run") {
        for (const sample of runSamples(repo, pr, found, by, now, settings)) {
          const said = await ask(decision, () => sample.input);
          const input = { version: INPUT_VERSION, ...sample.input };
          results.push({ ...said, sample: sample.what, input });
        }
        continue;
      }
      // No write to decide on: a comment on this pull request, by a run whose own it is and
      // by a brainstorm elsewhere.
      if (decision === "github") {
        for (const sample of githubSamples(repo, pr, settings?.modes)) {
          const said = await ask(decision, () => sample.input);
          const input = { version: INPUT_VERSION, ...sample.input };
          results.push({ ...said, sample: sample.what, input });
        }
        continue;
      }
      // No branch to link either: one for the issue the pull request closes, by its work run.
      if (decision === "link_branch") {
        const sample = linkSample(repo, pr, found);
        const said = await ask(decision, () => sample.input);
        const input = { version: INPUT_VERSION, ...sample.input };
        results.push({ ...said, sample: sample.what, input });
        continue;
      }
      // No push either: one of its branch, by the work run of the issue it closes.
      if (decision === "push") {
        const sample = pushSample(repo, pr, found, info.default_branch ?? null);
        const said = await ask(decision, () => sample.input);
        const input = { version: INPUT_VERSION, ...sample.input };
        results.push({ ...said, sample: sample.what, input });
        continue;
      }
      // As the listener would ask when it turns ready, about the run that opened it.
      if (decision === "request_review") {
        const task = taskKey(repo, issue ?? prId(number));
        const reviewers = reviewersFor(config, settings, pr);
        const own = requestInput({
          info,
          pr,
          files: prFiles,
          issue: found,
          reviewers,
          when: "ready",
          run: runFields(runOf(task, pr)),
          bot: config.bot,
          external: externalOf(repo, number),
          now,
        });
        const said = await ask(decision, () => own);
        // An "allowed" the listener would never act on: it requests nobody here.
        const nobody = !reviewers.length
          ? "`review.request` names no allowed user"
          : !ownReady(config, repo, pr)
            ? "not Deckhand's own ready pull request"
            : null;
        results.push({ ...said, ...(nobody && { nobody }) });
        continue;
      }
      const own = { ...input, decision };
      if (decision !== "merge") delete own.checks;
      if (decision === "fix") {
        Object.assign(own, {
          ci: false,
          reason: "review",
          round: fixes + 1,
          rounds: limitOf(settings, entry),
        });
      }
      results.push(await ask(decision, () => own));
    }
    const text = dryRunText({
      number,
      sha,
      files,
      errors,
      results,
      input: { version: INPUT_VERSION, ...input },
    });
    // A sample write's denial is no decision on this pull request.
    const decided = results.filter((r) => !r.sample);
    return { text, denials: decided.reduce((n, r) => n + r.messages.length, 0) };
  }

  // The last review the App posted on pull request `number` of `repo`, for the dashboard's
  // Review tab (GET /api/review, http.mjs), read from GitHub as the tab opens: the findings are
  // long and come from a model that read untrusted diffs, so neither this store nor api/state
  // keeps them. The review is read with the repo's tolerance (`review.max_allowed_severity`,
  // as the dashboard's Fix reads it), its follow-ups with the issues fileFollowUps() made of
  // them. → null when the pull request has none in Deckhand's format, else { url, at, verdict,
  // rating, head, round, manual, blob, allowed, findings: [{ severity, path, line, text,
  // tolerated }], followUps: [{ title, path, line, text, filing, issue? }], comments: [{
  // blocking, path, line, text }], merged: { at, by, deckhand } | null }. A review posted as a
  // plain comment (GitHub refused it) isn't read, as for the Fix.
  async function findings(repo, number) {
    const key = taskKey(repo, prId(number));
    const pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`, [404]);
    if (!pr) return null;
    const posted = await lastPosted(github, config, repo, number);
    if (!posted) return null;
    let settings = null;
    try {
      const read = await repoSettings(repo, pr.base?.repo?.default_branch || "main");
      if (!read.errors.length) settings = read.settings;
    } catch (error) {
      log(`${key}: its config for the Review tab: ${error.message ?? error}`);
    }
    const allowed = settings?.review?.maxAllowedSeverity ?? "low";
    const review = parsePostedReview(posted.body, { allowed });
    if (!review) return null;
    const entry = reviewed.get(key);
    const head = posted.commit_id ?? null;
    const round = head ? entry?.rounds?.findLast((r) => r.head === head) : null;
    const site = pr.base?.repo?.html_url ?? null;
    const by = pr.merged_by?.login ?? null;
    const merged = pr.merged_at
      ? {
          at: Date.parse(pr.merged_at),
          by,
          deckhand: !!by && by.toLowerCase() === config.bot?.toLowerCase(),
        }
      : null;
    const blocking = blockingSeverities(allowed);
    return {
      url: posted.html_url ?? null,
      at: posted.submitted_at ? Date.parse(posted.submitted_at) : null,
      verdict: review.verdict,
      rating: review.rating,
      head,
      round: round?.round ?? null,
      manual: !!round?.manual,
      blob: site && head ? `${site}/blob/${head}` : null,
      allowed,
      findings: review.findings.map((f) => ({
        ...placed(f),
        severity: f.severity,
        tolerated: BLOCKING.has(f.severity) && !blocking.includes(f.severity),
      })),
      followUps: await followUpsOf(repo, key, review.followUps, { entry, merged, settings, site }),
      // An unclear comment is posted only when it blocked (commentSection()).
      comments: review.comments.map((c) => ({
        ...placed(c),
        blocking: !!(c.blocking || c.unclear),
      })),
      merged,
    };
  }

  // A follow-up's filing, for findings(): "issue" (with `issue`: { number, state, url }, its
  // state null when it couldn't be read), "failed" (GitHub refused it), "left" (past
  // FOLLOW_UPS_MAX), "off" (the repo's config, read now, files none: `review.follow_ups:
  // false` or no `review`), "unread" (that config can't be read now), "after-merge" (not
  // merged yet, or its filing is on its way), "not-filed" (merged, and nothing filed it: the
  // filing was skipped at the merge, its config failing then, or stopped midway), "unknown"
  // (filed before the listener kept which issue each one became). `key`: the pull request's.
  async function followUpsOf(repo, key, list, { entry, merged, settings, site }) {
    const issues = new Map((entry?.followUpIssues ?? []).map((x) => [x.title, x.issue]));
    const refused = new Set(entry?.followUpsRefused ?? []);
    const left = new Set(entry?.followUpsLeft ?? []);
    const off = settings && (!settings.review || settings.review.followUps === false);
    // Its merge's (or a late review's) filing still going, in this orchestrator.
    const going = filing.has(key);
    const unfiled = () => {
      if (going) return "after-merge";
      if (entry?.followUpsAt) return entry.followUpIssues ? "not-filed" : "unknown";
      // Never started: skipped at the merge, which the config now may say why.
      return off ? "off" : settings ? "not-filed" : "unread";
    };
    const waiting = () => (off ? "off" : settings ? "after-merge" : "unread");
    const numbers = [...new Set(list.map((f) => issues.get(titleKey(f.title))).filter(Boolean))];
    const states = new Map(
      await Promise.all(
        numbers.map(async (n) => {
          try {
            const issue = await getJson(github, repo, `/repos/${repo}/issues/${n}`, [404, 410]);
            return [n, issue?.state ?? null];
          } catch (error) {
            log(`${repo}#${n}: the follow-up's state: ${error.message ?? error}`);
            return [n, null];
          }
        }),
      ),
    );
    return list.map((f) => {
      const id = titleKey(f.title);
      const n = issues.get(id);
      const how = n
        ? "issue"
        : refused.has(id)
          ? "failed"
          : left.has(id)
            ? "left"
            : merged
              ? unfiled()
              : waiting();
      const issue = n && {
        number: n,
        state: states.get(n),
        url: site ? `${site}/issues/${n}` : null,
      };
      return { ...placed(f), title: f.title, filing: how, ...(issue && { issue }) };
    });
  }

  return {
    consider,
    dryRun,
    fix,
    // A maintainer's Fix from the dashboard (work.mjs): startFix() with `asked`.
    fixAsked: (run, posted, asked) => startFix(run, posted, asked),
    findings,
    settle,
    fixed,
    tolerance,
    checksDone,
    pushed,
    closed,
    ciFixed,
    rebased,
    looping,
    runEnded,
    tick,
    start,
    stop,
    keys: () => [...reviewed.keys()],
    // How many fix runs pull request `number` had, for a conflict run's `deny_fix` (conflicts.mjs).
    fixes: (repo, number) => fixesOf(reviewed.get(taskKey(repo, prId(number)))),
    // The entry of pull request `number` in `repo` (reviewLoop()), or null.
    // `deciding`: the step the listener is deciding about right now (deciding()).
    entry: (repo, number) => {
      const key = taskKey(repo, prId(number));
      const decision = decisions.get(key);
      const entry = reviewed.get(key) ?? null;
      return decision ? { ...entry, deciding: decision.step } : entry;
    },
    respell,
    forgetSteps,
    followUpPick,
  };
}
