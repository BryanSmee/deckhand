// The conflict watcher: every few minutes, the open pull requests of Deckhand's own tasks
// (pulls.mjs) in the repos that opt in (`conflicts.check_minutes`, never more often than the
// operator's CONFLICT_CHECK_MINUTES) are asked whether they still merge. One in conflict with
// its base gets a work run in its task's session that rebases it. The `pull_request` webhook
// doesn't fire when the base branch moves: hence polling, and a check soon after the
// deliveries that say a default branch moved (a merge, a push) and Deckhand's own auto-merge.
//
// No loops: each attempt's (head, base) pair is kept (the store's `conflicts`), and the same pair
// never starts a second run, across restarts: a rebase that failed or stopped to ask waits
// for a new push or a new base commit.
//
// Before a run starts, the repo's policies are asked (`deny_fix`, `reason: "conflict"`): a
// refusal starts nothing, says why on the pull request (once for the same reasons: a base
// that keeps moving doesn't repeat it), and keeps the pair as an attempt.
//
// What a conflict found does is a workflow's (#1040, workflow-engine.mjs): the repo's own on
// `conflict` (`.deckhand/workflows/`, workflows.mjs), else Deckhand's built-in one, a single
// `run: rebase`. The pair is the event's id: the engine never handles one twice either, and
// keeps each pull request's instance (its vars, its step, its version of the workflow) in the
// store. A rebase run waits for its end (ended()) before the workflow's next step.
import { repoAllowed } from "./config.mjs";
import { waitsForInput } from "./comments.mjs";
import { headInRepo, mergeConflict, parseKey } from "./events.mjs";
import { getJson } from "./github.mjs";
import { denyKept, passed } from "./policies.mjs";
import { fixInput, readPullInput } from "./review-merge.mjs";
import { policyWhy } from "./review-texts.mjs";
import { respellMap } from "./spelling.mjs";
import { createEngine, facts } from "./workflow-engine.mjs";
import { builtInWorkflow } from "./workflow-format.mjs";
import { pullFacts } from "./workflows.mjs";

// The event the watcher's workflows run on (workflow-format.mjs EVENTS).
const EVENT = "conflict";

// The results of checkPull() a pass counts: the dashboard's Sync says them.
const COUNTED = ["started", "pending"];

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
// `busy(key)`: the task has a run going or queued; `stopped(key)`: its run was stopped and
// nobody asked for one since (stopped.mjs). `accept(item)`: queues a work item (tasks.mjs).
// `sleep(ms)`: soon()'s wait. `policies`: the policies' engine (policies.mjs), none without;
// `decided(key, entry)`: a decision a policy was asked for, for the task's page (decisions.mjs);
// `fixes(repo, number)`: the pull request's fix runs so far (reviews.mjs); `looping(repo,
// number)`: its review loop is between two steps (reviews.mjs looping()), no rebase run then;
// `reply(repo, number, text)`: a comment with the App's token. `attempts`: the Map the last
// attempts are kept in (storeMap()'s), "org/repo#12" → { pr, head, base, at }. `workflows`: the
// repos' workflows (workflows.mjs createWorkflows()), the built-in one alone without;
// `instances`: the Map the engine keeps its instances in (storeMap()'s too).
export function createConflicts({
  attempts = new Map(),
  workflows = null,
  instances = new Map(),
  config,
  pulls,
  github,
  repoSettings,
  busy,
  stopped = () => false,
  accept,
  policies = null,
  decided = () => {},
  fixes = () => 0,
  looping = () => false,
  reply = async () => {},
  // The orchestrator's metrics (metrics.mjs): each pull request's check, counted.
  metrics = null,
  log = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
}) {
  // repo (lowercase) → when it is next due. A restart checks every repo at once.
  const due = new Map();
  let ticking = null;
  let timer = null;
  // soon()'s wait under way, `{ repos, promise }`: the repos it makes due when it ends.
  let waiting = null;

  const json = (repo, url, expected) => getJson(github, repo, url, expected);
  const engine = createEngine({ instances, maxRounds: config.maxFixRounds, log, now });

  // The workflow that runs a conflict in `repo` → it, or throws when the repo's workflows have
  // errors: nothing runs then, and the pass says why (as for GitHub's errors).
  async function workflowOf(repo, base, settings) {
    if (!workflows) return builtInWorkflow(EVENT);
    const { workflow, errors } = await workflows.forEvent(repo, base, settings, EVENT);
    if (errors.length) throw new Error(`its workflows have errors: ${errors.join("; ")}`);
    return workflow;
  }

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
    const workflow = await workflowOf(repo, base, settings);
    let pending = false;
    for (const { key, pr } of tasks) {
      let result;
      try {
        result = await checkPull(repo, key, pr.number, { base, settings, workflow });
      } catch (error) {
        metrics?.conflictCheck("error");
        throw error;
      }
      metrics?.conflictCheck(result);
      if (result === "pending") pending = true;
      if (COUNTED.includes(result)) counts[result] += 1;
    }
    // GitHub computes mergeability on the first request: its answer is there next time.
    if (pending) due.set(id, 0);
  }

  // Runs the repo's workflow on the pull request if it conflicts (the built-in one starts a
  // rebase run). → "started"; "pending" when GitHub doesn't know yet; "clean" when it merges;
  // "refused" by the policies; "skipped" for the rest (a run going, its review loop deciding a
  // step or waiting for CI, its task stopped, closed, its input awaited, this head and base
  // tried already, a workflow that ran no rebase). Skipped before its attempt is kept (a
  // rebase step that took nothing): the next check tries again, from that step.
  async function checkPull(repo, key, number, { base, settings, workflow }) {
    if (busy(key) || looping(repo, number) || stopped(key)) return "skipped";
    const pr = await json(repo, `/repos/${repo}/pulls/${number}`, [404]);
    if (!pr || pr.state !== "open" || !headInRepo(pr, repo)) return "skipped";
    // What it found, for the dashboard (pulls.mjs): read here anyway.
    pulls.sawMerge?.(key, pr);
    // The dashboard's rule (events.mjs mergeConflict()): not computed yet, pending; conflicts
    // only, a pull request merely behind its base merges as it is.
    const { conflict } = mergeConflict(pr);
    if (conflict === undefined) return "pending";
    if (!conflict) return "clean";
    const target = parseKey(key);
    const issue = target.kind === "issue" ? target.number : null;
    if (await waitsForInput(github, config, repo, pr, issue)) return "skipped";
    const baseSha = await baseHead(repo, pr.base.ref);
    if (!baseSha) return "skipped";
    const pair = { pr: number, head: pr.head.sha, base: baseSha };
    const last = attempts.get(key);
    if (last && last.pr === pair.pr && last.head === pair.head && last.base === pair.base) {
      return "skipped";
    }
    const found = { repo, key, number, base, settings, pr, issue, pair, result: null };
    const event = { name: EVENT, id: `${number}:${pair.head}:${pair.base}`, pr: number };
    const outcome = await engine.trigger(
      key,
      workflow,
      { ...event, head: pair.head },
      steps(found),
    );
    if (outcome === "skipped") return "skipped";
    // A workflow that ran no rebase (or an event the engine had handled): the pair is kept all
    // the same, so it isn't asked again.
    if (!found.result) attempts.set(key, { ...pair, at: now() });
    return found.result ?? "skipped";
  }

  // What the engine runs for a conflict `found` ({ repo, key, number, base, settings, pr,
  // issue, pair, result }): its steps' actions, and the facts its conditions read.
  function steps(found) {
    return {
      facts: facts(pullFacts(github, found.repo, found.pr)),
      act: (step) => (step.run === "rebase" ? rebase(found) : say(found, step.comment)),
    };
  }

  // A `comment` step: said on the pull request. One that fails is logged, not tried again.
  async function say({ repo, key, number }, text) {
    try {
      await reply(repo, number, text);
    } catch (error) {
      log(`${key}: a workflow's comment: ${error.message ?? error}`);
    }
    return "done";
  }

  // A `run: rebase` step: the policies asked (`deny_fix`), then the rebase run queued, or the
  // refusal said. → "wait" (queued: the workflow goes on at its end), "refused", or "skipped"
  // (taken nothing: the same pair asks again). `found.result`: what checkPull() returns.
  async function rebase(found) {
    const { repo, key, number, base, settings, pr, issue } = found;
    let { pair } = found;
    // A rebase after a step that waited (ended()): the pull request must conflict still, at a
    // pair not tried yet.
    if (!pair) {
      if (mergeConflict(pr).conflict !== true) return "refused";
      const baseSha = await baseHead(repo, pr.base.ref);
      if (!baseSha) return "refused";
      pair = { pr: number, head: pr.head.sha, base: baseSha };
      const last = attempts.get(key);
      if (last && last.pr === pair.pr && last.head === pair.head && last.base === pair.base) {
        return "refused";
      }
    }
    const last = attempts.get(key);
    // The refusal last said on the pull request (`said`, kept once its comment was posted): the
    // same refusal again isn't said again.
    const said = last?.pr === number ? last.said : undefined;
    const { messages: denied, unread } = await deny(repo, key, pr, issue, base);
    // Refused because GitHub couldn't be read (the policies, the pull request's files): nothing
    // starts, and the pair isn't kept, so the next check asks again, as for any GitHub error.
    if (unread) throw new Error(`#${number}: ${policyWhy("deny_fix", denied)}`);
    // Checked again: a comment, or the loop's next step, may have come during the calls above.
    if (busy(key) || looping(repo, number) || stopped(key)) {
      found.result = "skipped";
      return "skipped";
    }
    const repeated = denied.length > 0 && JSON.stringify(said) === JSON.stringify(denied);
    attempts.set(key, { ...pair, at: now(), ...(repeated && { said }) });
    if (denied.length) {
      found.result = "refused";
      const why = policyWhy("deny_fix", denied);
      log(`${key}: pull request #${number} conflicts with ${pr.base.ref}, no rebase run, ${why}`);
      if (repeated) return "refused";
      try {
        await reply(repo, number, noRebaseText(why, pr.base.ref));
        attempts.set(key, { ...attempts.get(key), said: denied });
      } catch (error) {
        log(`${key}: saying no rebase run: ${error.message ?? error}`);
      }
      return "refused";
    }
    log(`${key}: pull request #${number} conflicts with ${pr.base.ref}, starting a rebase run`);
    const target = parseKey(key);
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
      // The head it rebases, for the review loop at its end (reviews.mjs rebased()).
      rebaseFrom: pr.head.sha,
    });
    found.result = "started";
    return "wait";
  }

  // A conflict run of task `key` is over (run-end.mjs cleanUp(); `number` its pull request,
  // `base` the repo's default branch): its workflow's next steps, if it waited for it. Resolves
  // to the engine's outcome; "idle" when nothing waited. Never throws: logged.
  async function ended({ key, repo, number, base }) {
    try {
      if (!engine.waiting(key, EVENT)) return "idle";
      const pr = await json(repo, `/repos/${repo}/pulls/${number}`, [404]);
      if (!pr || pr.state !== "open") {
        engine.forget(key, number);
        return "idle";
      }
      const { settings, errors } = await repoSettings(repo, base);
      // The watcher off in the repo now: its next conflict starts the workflow again.
      if (errors.length || !settings.conflicts) return "idle";
      const target = parseKey(key);
      const issue = target?.kind === "issue" ? target.number : null;
      const found = { repo, key, number, base, settings, pr, issue, pair: null, result: null };
      return await engine.resume(key, EVENT, steps(found), pr.head?.sha ?? null);
    } catch (error) {
      log(`${key}: the conflicts workflow after its rebase run: ${error.message ?? error}`);
      return "error";
    }
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
          {
            decision: "fix",
            repo,
            pr,
            issue,
            bot: config.bot,
            external: pulls.externalOf?.(repo, pr.number) ?? null,
            now,
          },
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
    ended,
    // Pull request `number` of task `key` is closed: its workflow's instance goes.
    closed: (key, number) => engine.forget(key, number),
    // Its workflow's instance (workflow-engine.mjs), or null.
    instance: (key) => engine.instance(key, EVENT),
    keys: () => [...new Set([...attempts.keys(), ...engine.keys()])],
    // Rekeyed with spelled() (restart.mjs unifySpellings()), so an attempt is found again
    // under the key pulls.mjs now has. Both spellings: the later attempt, or without times
    // (saved before they were), the old spelling's: the watcher ran under it, not the rest.
    // The workflows' instances too, their vars merged.
    respell: (spelled) => {
      const moved = respellMap(attempts, spelled, undefined, later);
      engine.respell(spelled);
      return moved;
    },
  };
}
