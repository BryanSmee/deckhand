// The conflict watcher: every few minutes, the open pull requests of Deckhand's own tasks
// (pulls.mjs) in the repos that opt in (`conflicts.check_minutes`, never more often than the
// operator's CONFLICT_CHECK_MINUTES) are asked whether they still merge. One in conflict with
// its base gets a work run in its task's session that rebases it. The `pull_request` webhook
// doesn't fire when the base branch moves: hence polling.
//
// No loops: each attempt's (head, base) pair is kept in conflicts.json, and the same pair
// never starts a second run, across restarts: a rebase that failed or stopped to ask waits
// for a new push or a new base commit.
import { sameRepo } from "./events.mjs";
import { readJson, writeJsonAtomic } from "./store.mjs";
import { parseKey } from "./titles.mjs";

// How often the watcher wakes up; each repo is checked at its own interval.
export const TICK_MS = 60_000;

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
  // "org/repo#12" → { pr, head, base } of its last attempt.
  const attempts = new Map(Object.entries(readJson(path, {})));
  // repo (lowercase) → when it is next due. A restart checks every repo at once.
  const due = new Map();
  let ticking = null;
  let timer = null;

  async function json(repo, url, expected = []) {
    const res = await github(repo, "GET", url, undefined, expected);
    if (!res.ok) return null;
    return res.json();
  }

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
      if (config.repos.length && !config.repos.includes(target.repo.toLowerCase())) continue;
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
    if (!pr || pr.state !== "open" || !sameRepo(pr, repo)) return null;
    if (pr.mergeable === null || pr.mergeable === undefined || pr.mergeable_state === "unknown") {
      return "pending";
    }
    // Conflicts only: a pull request merely behind its base merges as it is.
    if (pr.mergeable !== false && pr.mergeable_state !== "dirty") return null;
    const target = parseKey(key);
    if (await waitsForInput(repo, pr, target)) return null;
    const baseSha = await baseHead(repo, pr.base.ref);
    if (!baseSha) return null;
    const pair = { pr: number, head: pr.head.sha, base: baseSha };
    const last = attempts.get(key);
    if (last && last.pr === pair.pr && last.head === pair.head && last.base === pair.base) {
      return null;
    }
    // Checked again: a comment may have come during the calls above.
    if (busy(key)) return null;
    attempts.set(key, pair);
    writeJsonAtomic(path, Object.fromEntries(attempts));
    log(`${key}: pull request #${number} conflicts with ${pr.base.ref}, starting a rebase run`);
    await accept({
      repo,
      id: key.slice(key.lastIndexOf("#") + 1),
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

  // The pull request, or its issue (where runs put the label), waits for the maintainer.
  async function waitsForInput(repo, pr, target) {
    const name = config.needsInputLabel;
    if (!name) return false;
    const has = (labels) => (labels ?? []).some((l) => l.name === name);
    if (has(pr.labels)) return true;
    if (target.kind !== "issue") return false;
    const issue = await json(repo, `/repos/${repo}/issues/${target.number}`, [404]);
    return has(issue?.labels);
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

  return { tick, start, stop };
}
