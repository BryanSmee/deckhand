// The conflict watcher: every few minutes, the open pull requests of Deckhand's own tasks
// (pulls.mjs) in the repos that opt in (`conflicts.check_minutes`, never more often than the
// operator's CONFLICT_CHECK_MINUTES) are asked whether they still merge. One in conflict with
// its base gets a work run in its task's session that rebases it. The `pull_request` webhook
// doesn't fire when the base branch moves: hence polling.
//
// No loops: each attempt's (head, base) pair is kept in conflicts.json, and the same pair
// never starts a second run, across restarts: a rebase that failed or stopped to ask waits
// for a new push or a new base commit.
import { repoAllowed } from "./config.mjs";
import { waitsForInput } from "./comments.mjs";
import { parseKey, headInRepo } from "./events.mjs";
import { getJson } from "./github.mjs";
import { respellMap } from "./spelling.mjs";
import { persistentMap } from "./store.mjs";

// How often the watcher wakes up; each repo is checked at its own interval.
const TICK_MS = 60_000;

// Of one task's two attempts (respell()), the later; `moved` when neither knows when.
const later = (kept, moved) => ((kept.at ?? 0) > (moved.at ?? 0) ? kept : moved);

// What the run is asked to do, as if a maintainer had commented it.
export function rebaseMessage(base) {
  return `This pull request conflicts with \`${base}\`: rebase it on \`origin/${base}\`, resolve the conflicts, rerun the checks and push with \`--force-with-lease\`. If the conflicts can't be resolved safely, stop and ask.`;
}

// `github(repo, method, path, body, expected)`: the App's calls (server.mjs).
// `repoSettings(repo, base)`: the repo's settings from its default branch.
// `busy(key)`: the task has a run going or queued. `accept(item)`: queues a work item (tasks.mjs).
export function createConflicts({
  path,
  config,
  pulls,
  github,
  repoSettings,
  busy,
  accept,
  log = () => {},
  now = Date.now,
}) {
  // "org/repo#12" → { pr, head, base, at } of its last attempt.
  const attempts = persistentMap(path);
  // repo (lowercase) → when it is next due. A restart checks every repo at once.
  const due = new Map();
  let ticking = null;
  let timer = null;

  const json = (repo, url, expected) => getJson(github, repo, url, expected);

  // One pass over the repos that are due. Overlapping ticks share the pass under way.
  function tick() {
    if (!config.conflictCheckMinutes) return Promise.resolve();
    ticking ??= pass().finally(() => (ticking = null));
    return ticking;
  }

  async function pass() {
    const byRepo = new Map();
    for (const [key, pr] of pulls.open()) {
      const target = parseKey(key);
      if (!target || target.kind === "discussion") continue;
      // Fail closed, as for webhooks: the operator may have narrowed ALLOWED_REPOS since.
      if (!repoAllowed(config, target.repo)) continue;
      const repo = target.repo.toLowerCase();
      if ((due.get(repo) ?? 0) > now()) continue;
      if (!byRepo.has(repo)) byRepo.set(repo, { repo: target.repo, tasks: [] });
      byRepo.get(repo).tasks.push({ key, pr });
    }
    for (const [id, { repo, tasks }] of byRepo) {
      try {
        await checkRepo(id, repo, tasks);
      } catch (error) {
        log(`Conflicts in ${repo}: ${error.message ?? error}`);
      }
    }
  }

  async function checkRepo(id, repo, tasks) {
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
    if (last && last.pr === pair.pr && last.head === pair.head && last.base === pair.base) {
      return null;
    }
    // Checked again: a comment may have come during the calls above.
    if (busy(key)) return null;
    attempts.set(key, { ...pair, at: now() });
    attempts.save();
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
    start,
    stop,
    keys: () => [...attempts.keys()],
    // Rekeyed with spelled() (restart.mjs unifySpellings()), so an attempt is found again
    // under the key pulls.mjs now has. Both spellings: the later attempt, or without times
    // (saved before they were), the old spelling's: the watcher ran under it, not the rest.
    respell: (spelled) => respellMap(attempts, spelled, undefined, later) && attempts.save(),
  };
}
