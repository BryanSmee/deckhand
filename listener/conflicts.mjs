// The conflict watcher: every few minutes, the open pull requests of Deckhand's own tasks
// (pulls.mjs) in the repos that opt in (`conflicts.check_minutes`, never more often than the
// operator's CONFLICT_CHECK_MINUTES) are asked whether they still merge. One in conflict with
// its base gets a work run in its task's session that rebases it. The `pull_request` webhook
// doesn't fire when the base branch moves: hence polling, and a check soon after the
// deliveries that say a default branch moved (a merge, a push) and Deckhand's own auto-merge.
//
// No loops: each attempt's (head, base) pair is kept in conflicts.json, and the same pair
// never starts a second run, across restarts: a rebase that failed or stopped to ask waits
// for a new push or a new base commit.
//
// Before a run starts, the repo's policies are asked (`deny_fix`, `reason: "conflict"`): a
// refusal starts nothing, says why on the pull request (once for the same reasons: a base
// that keeps moving doesn't repeat it), and keeps the pair as an attempt.
import { repoAllowed } from "./config.mjs";
import { waitsForInput } from "./comments.mjs";
import { parseKey, headInRepo } from "./events.mjs";
import { getJson } from "./github.mjs";
import { denyKept, passed } from "./policies.mjs";
import { fixInput, policyWhy, readPullInput } from "./reviews.mjs";
import { respellMap } from "./spelling.mjs";
import { persistentMap } from "../lib/files.mjs";

// How often the watcher wakes up; each repo is checked at its own interval.
const TICK_MS = 60_000;

// Of one task's two attempts (respell()), the later; `moved` when neither knows when.
const later = (kept, moved) => ((kept.at ?? 0) > (moved.at ?? 0) ? kept : moved);

// A pull request GitHub returned (GET /repos/{repo}/pulls/{n}) that was merged into its repo's
// default branch, so the other pull requests may conflict now. Fails closed: without the
// default branch, nothing says it was that one.
export function intoDefaultBranch(pr) {
  const base = pr?.base?.repo?.default_branch;
  return !!base && pr.base.ref === base;
}

// What the run is asked to do, as if a maintainer had commented it.
export function rebaseMessage(base) {
  return `This pull request conflicts with \`${base}\`: rebase it on \`origin/${base}\`, resolve the conflicts, rerun the checks and push with \`--force-with-lease\`. If the conflicts can't be resolved safely, stop and ask.`;
}

// What a conflict run the policies refused (`deny_fix`) says on the pull request.
export function noRebaseText(why, base) {
  return `**No rebase run** (\`conflicts.check_minutes\`): ${why}. The conflict with \`${base}\` waits for a maintainer, or a new push or base commit.`;
}

// `github(repo, method, path, body, expected)`: the App's calls (server.mjs).
// `repoSettings(repo, base)`: the repo's settings from its default branch.
// `busy(key)`: the task has a run going or queued. `accept(item)`: queues a work item (tasks.mjs).
// `sleep(ms)`: soon()'s wait. `policies`: the policies' engine (policies.mjs), none without;
// `decided(key, entry)`: a decision a policy was asked for, for the task's page (decisions.mjs);
// `fixes(repo, number)`: the pull request's fix runs so far (reviews.mjs);
// `reply(repo, number, text)`: a comment with the App's token.
export function createConflicts({
  path,
  config,
  pulls,
  github,
  repoSettings,
  busy,
  accept,
  policies = null,
  decided = () => {},
  fixes = () => 0,
  reply = async () => {},
  log = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
}) {
  // "org/repo#12" → { pr, head, base, at } of its last attempt.
  const attempts = persistentMap(path);
  // repo (lowercase) → when it is next due. A restart checks every repo at once.
  const due = new Map();
  let ticking = null;
  let timer = null;
  // soon()'s wait under way, `{ repos, promise }`: the repos it makes due when it ends.
  let waiting = null;

  const json = (repo, url, expected) => getJson(github, repo, url, expected);

  // One pass over the repos that are due. Overlapping ticks share the pass under way. Resolves
  // to how many rebase runs it started, how many pull requests GitHub hadn't computed yet, and
  // the errors of the repos it couldn't check ("org/repo: …"), logged already.
  function tick() {
    return run(false);
  }

  // The dashboard's Sync (sync.mjs): the same pass, now, with every repo due. The pending ones
  // are left to the next tick, which checks their repo at once (checkRepo()).
  function check() {
    return run(true);
  }

  // A default branch that moved: the repo's open pull requests checked after a short wait,
  // whatever its interval, rather than at its next check. GitHub recomputes `mergeable` in the
  // background, so asking at once mostly gets "pending". Every call during the wait shares it
  // and its pass; the repo's opt-in is still read in checkRepo(). Resolves to the pass's
  // counts, or null when the watcher is off or the repo isn't allowed.
  function soon(repo) {
    if (!config.conflictCheckMinutes || !repo || !repoAllowed(config, repo)) {
      return Promise.resolve(null);
    }
    if (!waiting) {
      const entry = { repos: new Set() };
      entry.promise = sleep(config.conflictMergeDelayMs).then(async () => {
        waiting = null;
        // A pass under way may have asked about them before the base moved, and sets their
        // next check when it ends: this one comes after it.
        while (ticking) await ticking.promise.catch(() => {});
        for (const id of entry.repos) due.set(id, 0);
        return tick();
      });
      waiting = entry;
    }
    waiting.repos.add(repo.toLowerCase());
    return waiting.promise;
  }

  // The pass under way, `{ all, checked, promise }`: `checked`, the repos it took. A check()
  // during a tick waits for it, then checks the repos it left (not due): none twice, none left.
  function run(all) {
    if (!config.conflictCheckMinutes) {
      return Promise.resolve({ started: 0, pending: 0, errors: [] });
    }
    if (ticking && (ticking.all || !all)) return ticking.promise;
    const under = ticking;
    const checked = under?.checked ?? new Set();
    const entry = { all, checked };
    entry.promise = (
      under
        ? under.promise.then((first) => pass(all, checked).then((next) => merge(first, next)))
        : pass(all, checked)
    ).finally(() => {
      if (ticking === entry) ticking = null;
    });
    ticking = entry;
    return entry.promise;
  }

  const merge = (a, b) => ({
    started: a.started + b.started,
    pending: a.pending + b.pending,
    errors: [...a.errors, ...b.errors],
  });

  // `checked`: the repos already checked by the pass this one follows, skipped; and the ones
  // this one takes, added.
  async function pass(all, checked) {
    const counts = { started: 0, pending: 0, errors: [] };
    const byRepo = new Map();
    for (const [key, pr] of pulls.open()) {
      const target = parseKey(key);
      if (!target || target.kind === "discussion") continue;
      // Fail closed, as for webhooks: the operator may have narrowed ALLOWED_REPOS since.
      if (!repoAllowed(config, target.repo)) continue;
      const repo = target.repo.toLowerCase();
      if (checked.has(repo) && !byRepo.has(repo)) continue;
      if (!all && (due.get(repo) ?? 0) > now()) continue;
      checked.add(repo);
      if (!byRepo.has(repo)) byRepo.set(repo, { repo: target.repo, tasks: [] });
      byRepo.get(repo).tasks.push({ key, pr });
    }
    for (const [id, { repo, tasks }] of byRepo) {
      try {
        await checkRepo(id, repo, tasks, counts);
      } catch (error) {
        log(`Conflicts in ${repo}: ${error.message ?? error}`);
        counts.errors.push(`${repo}: ${error.message ?? error}`);
      }
    }
    return counts;
  }

  async function checkRepo(id, repo, tasks, counts) {
    // Without the opt-in (or with config errors), the config is read again at the floor.
    due.set(id, now() + config.conflictCheckMinutes * 60_000);
    const info = await json(repo, `/repos/${repo}`);
    // Its config is on its default branch: don't guess which one.
    if (!info?.default_branch) return;
    const base = info.default_branch;
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length || !settings.conflicts) return;
    due.set(id, now() + settings.conflicts.checkMinutes * 60_000);
    let pending = false;
    for (const { key, pr } of tasks) {
      const result = await checkPull(repo, key, pr.number, { base, settings });
      if (result === "pending") pending = true;
      if (result) counts[result] += 1;
    }
    // GitHub computes mergeability on the first request: its answer is there next time.
    if (pending) due.set(id, 0);
  }

  // Starts a rebase run for the pull request if it conflicts; "pending" when GitHub doesn't
  // know yet.
  async function checkPull(repo, key, number, { base, settings }) {
    if (busy(key)) return null;
    const pr = await json(repo, `/repos/${repo}/pulls/${number}`, [404]);
    if (!pr || pr.state !== "open" || !headInRepo(pr, repo)) return null;
    if (pr.mergeable === null || pr.mergeable === undefined || pr.mergeable_state === "unknown") {
      return "pending";
    }
    // Conflicts only: a pull request merely behind its base merges as it is.
    if (pr.mergeable !== false && pr.mergeable_state !== "dirty") return null;
    const target = parseKey(key);
    const issue = target.kind === "issue" ? target.number : null;
    if (await waitsForInput(github, config, repo, pr, issue)) return null;
    const baseSha = await baseHead(repo, pr.base.ref);
    if (!baseSha) return null;
    const pair = { pr: number, head: pr.head.sha, base: baseSha };
    const last = attempts.get(key);
    // The refusal last said on the pull request (`said`, kept once its comment was posted): the
    // same refusal again isn't said again.
    const said = last?.pr === number ? last.said : undefined;
    if (last && last.pr === pair.pr && last.head === pair.head && last.base === pair.base) {
      return null;
    }
    const { messages: denied, unread } = await deny(repo, key, pr, issue, base);
    // Refused because GitHub couldn't be read (the policies, the pull request's files): nothing
    // starts, and the pair isn't kept, so the next check asks again, as for any GitHub error.
    if (unread) throw new Error(`#${number}: ${policyWhy("deny_fix", denied)}`);
    // Checked again: a comment may have come during the calls above.
    if (busy(key)) return null;
    const repeated = denied.length > 0 && JSON.stringify(said) === JSON.stringify(denied);
    attempts.set(key, { ...pair, at: now(), ...(repeated && { said }) });
    attempts.save();
    if (denied.length) {
      const why = policyWhy("deny_fix", denied);
      log(`${key}: pull request #${number} conflicts with ${pr.base.ref}, no rebase run, ${why}`);
      if (repeated) return null;
      try {
        await reply(repo, number, noRebaseText(why, pr.base.ref));
        attempts.set(key, { ...attempts.get(key), said: denied });
        attempts.save();
      } catch (error) {
        log(`${key}: saying no rebase run: ${error.message ?? error}`);
      }
      return null;
    }
    log(`${key}: pull request #${number} conflicts with ${pr.base.ref}, starting a rebase run`);
    await accept({
      repo,
      id: target.id,
      kind: target.kind,
      number: target.number,
      title: target.kind === "pr" ? (pr.title ?? null) : null,
      trigger: "work",
      modeLine: null,
      text: rebaseMessage(pr.base.ref),
      replyTo: number,
      comment: null,
      base,
      settings,
      // From the listener, for a task an allowed user started: no comment, nobody to check.
      sender: null,
      reason: "conflict",
    });
    return "started";
  }

  // Why the policies refuse a conflict run on `pr` (`deny_fix`, `reason: "conflict"`):
  // { messages, unread } (denyKept()), no messages without policies. The decision is kept for the task's page.
  // `issue`: the task's issue, or null for a pull request of its own; `ref`: the repo's
  // default branch, where its policies are.
  async function deny(repo, key, pr, issue, ref) {
    if (!policies) return { messages: [], unread: false };
    const extra = { ...fixInput(fixes(repo, pr.number)), ci: false, reason: "conflict" };
    return denyKept(
      policies,
      "deny_fix",
      repo,
      ref,
      () =>
        readPullInput(
          github,
          { decision: "fix", repo, pr, issue, bot: config.bot, now },
          { ...extra, round: null, rounds: null },
        ),
      {
        pr,
        gates: [
          passed("In conflict with its base"),
          passed("No run going"),
          passed("Nobody's input awaited"),
          passed("Not tried at this head and base"),
        ],
        keep: (entry) => decided(key, entry),
        log,
        // GitHub failing is asked again at the next check: no refusal kept for the page.
        keepUnread: false,
      },
    );
  }

  // The base branch's latest commit: a pull request's own base.sha can lag behind it.
  async function baseHead(repo, ref) {
    const path = ref.split("/").map(encodeURIComponent).join("/");
    const head = await json(repo, `/repos/${repo}/git/ref/heads/${path}`, [404]);
    return head?.object?.sha ?? null;
  }

  function start() {
    if (!config.conflictCheckMinutes || timer) return;
    timer = setInterval(() => {
      tick().catch((error) => log(`Conflicts: ${error.stack ?? error}`));
    }, TICK_MS);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return {
    tick,
    check,
    soon,
    start,
    stop,
    keys: () => [...attempts.keys()],
    // Rekeyed with spelled() (restart.mjs unifySpellings()), so an attempt is found again
    // under the key pulls.mjs now has. Both spellings: the later attempt, or without times
    // (saved before they were), the old spelling's: the watcher ran under it, not the rest.
    respell: (spelled) => respellMap(attempts, spelled, undefined, later) && attempts.save(),
  };
}
