// Each task's pull request for the dashboard, by task key ("org/repo#12", "org/repo#pr-3"):
// { number, url, state, readyAt, autoMerged? }. `pull_request` webhooks keep it current (events.mjs
// pullRequest()), and the listener's own changes (pr-ready.mjs); tasks older than that are
// looked up once per listener start, from the repo's recent pull requests. Kept in pulls.json,
// so a restart neither forgets nor asks again. The open ones are asked about again at start and
// from the dashboard's Sync (resync()): a lost delivery would leave one a draft forever.
import { linkedIssue, parseKey, prState, headInRepo, sameRepo } from "./events.mjs";
import { respellMap, sameTask } from "./spelling.mjs";
import { persistentMap } from "./store.mjs";

const open = (pr) => pr?.state === "draft" || pr?.state === "ready";

// `listPulls(repo)`: the repo's recent pull requests, as GET /repos/{repo}/pulls has them;
// `getPull(repo, number)`: one of them, or null.
export function createPulls({ path, listPulls, getPull = async () => null, log = () => {} }) {
  const pulls = persistentMap(path);
  // Listed once per listener: tasks after that get theirs from webhooks.
  const listed = new Set();
  let fetching = null;
  let resyncing = null;

  // Records `pr` on task `key`, the latest event winning: the same pull request leaves the
  // task it was on (its "Closes #n" was edited, or a listener from before #287 kept it under
  // another spelling of the repo). A closed pull request doesn't replace another
  // one still open on the task: a new attempt was opened before the old one was closed.
  function record(key, pr) {
    const repo = parseKey(key)?.repo;
    const current = pulls.get(key);
    if (current && current.number !== pr.number && open(current) && !open(pr)) return false;
    let before = null;
    for (const [other, p] of pulls) {
      if (p.number !== pr.number || !sameRepo(parseKey(other)?.repo, repo)) continue;
      before = p;
      if (other !== key) pulls.delete(other);
    }
    // An edit or a close says nothing about when it turned ready: the earlier event did. Nor
    // does the `ready_for_review` delivery of a change the listener recorded already
    // (pr-ready.mjs): one notification, not two.
    const already = before?.state === "ready" && pr.state === "ready";
    const readyAt = already ? before.readyAt : (pr.readyAt ?? before?.readyAt ?? null);
    // Merged by the listener (reviews.mjs autoMerge()): the `closed` delivery that follows
    // doesn't know it.
    const autoMerged = pr.autoMerged || before?.autoMerged;
    pulls.set(key, { ...pr, readyAt, ...(autoMerged && { autoMerged: true }) });
    pulls.save();
    return true;
  }

  // Whether the task has a pull request under any spelling of its repo: a key spelled as the
  // state was at restart (GitHub's name not known in time) mustn't add a second entry.
  const has = (key) => pulls.has(key) || [...pulls.keys()].some((k) => sameTask(k, key));

  // Looks up the pull requests of the tasks in `keys` that have none: one listing per repo.
  function fill(keys) {
    const missing = [...new Set(keys)]
      .filter((k) => !has(k))
      .map((key) => ({ key, ...parseKey(key) }))
      .filter((t) => t.repo && t.kind !== "discussion" && !listed.has(t.repo));
    if (fetching || !missing.length) return fetching;
    fetching = (async () => {
      let changed = false;
      for (const repo of new Set(missing.map((t) => t.repo))) {
        listed.add(repo);
        let list;
        try {
          list = await listPulls(repo);
        } catch (error) {
          log(`Pull requests of ${repo}: ${error.message ?? error}`);
          continue;
        }
        for (const t of missing.filter((m) => m.repo === repo)) {
          const pr = match(list, repo, t);
          if (!pr || has(t.key)) continue;
          // readyAt unknown: the dashboard doesn't notify for what it finds this way.
          pulls.set(t.key, {
            number: pr.number,
            url: pr.html_url,
            state: prState(pr),
            readyAt: null,
          });
          changed = true;
        }
      }
      if (changed) pulls.save();
    })()
      // Nobody awaits it (http.mjs state()): a failure is logged, never thrown.
      .catch((error) => log(`Pull requests: ${error.message ?? error}`))
      .finally(() => (fetching = null));
    return fetching;
  }

  // [key, pr] of the tasks whose pull request is open, for the conflict watcher.
  const openPulls = () => [...pulls].filter(([, pr]) => open(pr));

  // The open pull requests' states asked again from GitHub (one listing per repo, then those it
  // doesn't have one by one), and the tasks without one looked up again at the next fill().
  // Resolves to how many changed. One at a time: a second call shares it.
  function resync() {
    if (resyncing) return resyncing;
    listed.clear();
    resyncing = (async () => {
      const byRepo = new Map();
      for (const [key, pr] of openPulls()) {
        const repo = parseKey(key)?.repo;
        if (repo) byRepo.set(repo, [...(byRepo.get(repo) ?? []), [key, pr]]);
      }
      let changed = 0;
      for (const [repo, entries] of byRepo) {
        const list = await listPulls(repo).catch((error) => {
          log(`Pull requests of ${repo}: ${error.message ?? error}`);
          return [];
        });
        for (const [key, pr] of entries) {
          let found = list.find((p) => p.number === pr.number);
          if (!found) {
            try {
              found = await getPull(repo, pr.number);
            } catch (error) {
              log(`Pull requests: ${repo}#${pr.number}: ${error.message ?? error}`);
            }
          }
          const state = found && prState(found);
          // Recorded meanwhile by a delivery: that one is newer.
          if (!state || pulls.get(key) !== pr || state === pr.state) continue;
          pulls.set(key, { ...pr, state, url: found.html_url ?? pr.url });
          log(`${key}: pull request #${pr.number} ${state} (was ${pr.state})`);
          changed++;
        }
      }
      if (changed) pulls.save();
      return changed;
    })().finally(() => (resyncing = null));
    return resyncing;
  }

  // Rekeyed with spelled() (restart.mjs unifySpellings()): the conflict watcher would start
  // runs under a key the rest of the state no longer has. Both spellings of one task: merged.
  function respell(spelled) {
    if (respellMap(pulls, spelled, undefined, mergePulls)) pulls.save();
  }

  return {
    get: (key) => pulls.get(key) ?? null,
    record,
    fill,
    resync,
    open: openPulls,
    keys: () => [...pulls.keys()],
    respell,
  };
}

// One task's pull request under two spellings, `kept` the one respellMap() met first under the
// new key. Which is newer isn't known: the open one of two pull requests, as record() has it;
// for one pull request, kept's state (resync() asks GitHub about the open ones at start), with
// when it turned ready and whether the listener merged it from either.
function mergePulls(kept, moved) {
  if (kept.number !== moved.number) return open(moved) && !open(kept) ? moved : kept;
  const autoMerged = kept.autoMerged || moved.autoMerged;
  return {
    ...kept,
    readyAt: kept.readyAt ?? moved.readyAt ?? null,
    ...(autoMerged && { autoMerged: true }),
  };
}

// A task's pull request in a listing, newest first: itself for "#pr-n"; for an issue, the
// one on its branch (issue-<n>-…, not a fork's) or that closes it.
function match(list, repo, { kind, number }) {
  if (kind === "pr") return list.find((p) => p.number === number);
  return (
    list.find((p) => headInRepo(p, repo) && p.head.ref?.startsWith(`issue-${number}-`)) ??
    list.find((p) => linkedIssue(p, repo) === number)
  );
}
