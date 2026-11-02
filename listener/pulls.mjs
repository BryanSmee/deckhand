// Each task's pull request for the dashboard, by task key ("org/repo#12", "org/repo#pr-3"):
// { number, url, state, readyAt, autoMerged?, additions?, deletions?, changedFiles?, commits?,
// head?, ci? }, its size and commit count as the last pull request object that had them said
// (events.mjs pullSize()). `ci`: what CI says of its `head` commit, { sha, state, runs }
// (ci.mjs ciSummary(), #436), kept up to date from CI's deliveries (ciChanged()) while it is
// open; a new head resets it to `none` until something reports; the last one known stays once
// it is merged or closed. `pull_request` webhooks keep it current (events.mjs pullRequest()), and the
// listener's own record of the runs' changes (github-pulls.mjs); tasks older than that are looked up once per listener
// start, from the repo's recent pull requests. Kept in pulls.json, so a restart neither forgets
// nor asks again. The open ones are asked about again at start and from the dashboard's Sync
// (resync()): a lost delivery would leave one a draft forever.
import {
  linkedIssue,
  parseKey,
  prState,
  PULL_SIZE,
  pullSize,
  headInRepo,
  sameRepo,
} from "./events.mjs";
import { respellMap, sameTask } from "./spelling.mjs";
import { persistentMap } from "../lib/files.mjs";

const open = (pr) => pr?.state === "draft" || pr?.state === "ready";
// How many open pull requests' CI resync() reads at once (three GitHub calls each).
const CI_AT_ONCE = 4;

// `listPulls(repo)`: the repo's recent pull requests, as GET /repos/{repo}/pulls has them;
// `getPull(repo, number)`: one of them, or null.
// `readCi(repo, sha)`: a commit's CI as GitHub has it now (ci.mjs commitCi()), or null.
export function createPulls({
  path,
  listPulls,
  getPull = async () => null,
  readCi = async () => null,
  log = () => {},
}) {
  const pulls = persistentMap(path);
  // The tasks whose CI is being read (`key` → whether to read it once more after): deliveries
  // come by the dozen for one commit, and one read answers them all.
  const reading = new Map();
  // Listed once per listener: tasks after that get theirs from webhooks.
  const listed = new Set();
  // The pull requests whose size was asked for once ("key#number"), when they had none: one
  // GitHub can't give isn't asked about again on every poll.
  const sizeAsked = new Set();
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
    // (github-pulls.mjs): one notification, not two.
    const already = before?.state === "ready" && pr.state === "ready";
    const readyAt = already ? before.readyAt : (pr.readyAt ?? before?.readyAt ?? null);
    // Merged by the listener (reviews.mjs autoMerge()): the `closed` delivery that follows
    // doesn't know it.
    const autoMerged = pr.autoMerged || before?.autoMerged;
    // A pull request object without its size (the listener's own changes may have none): the
    // one known stays.
    const size = before ? knownSize(before) : {};
    // The head and its CI known stay, unless the pull request moved to another head: its CI
    // starts again, nothing reported yet. Not back to an older one: a delivery older than the
    // one that set it (a redelivery, two handled at once ending out of order) keeps it.
    const older =
      pr.updatedAt != null && before?.updatedAt != null && pr.updatedAt < before.updatedAt;
    const head = older ? (before.head ?? pr.head) : (pr.head ?? before?.head);
    const updatedAt = Math.max(pr.updatedAt ?? 0, before?.updatedAt ?? 0) || undefined;
    const ci = !head
      ? before?.ci
      : before?.ci?.sha === head
        ? before.ci
        : { sha: head, state: "none", runs: [] };
    pulls.set(key, {
      ...size,
      ...pr,
      readyAt,
      ...(autoMerged && { autoMerged: true }),
      ...(head && { head }),
      ...(updatedAt && { updatedAt }),
      ...(ci && { ci }),
    });
    pulls.save();
    // Moved to a new head: its CI read now, as the delivery that said it changed may have been
    // handled before this one, and found no pull request at that commit.
    if (head && before?.ci?.sha !== head && open(pr)) {
      readCiOf(key).catch((error) => log(`${key}: CI: ${error.message ?? error}`));
    }
    return true;
  }

  // Whether the task has a pull request under any spelling of its repo: a key spelled as the
  // state was at restart (GitHub's name not known in time) mustn't add a second entry.
  const has = (key) => pulls.has(key) || [...pulls.keys()].some((k) => sameTask(k, key));

  // The tasks in `keys` whose pull request has no size yet, not asked for already.
  const unsized = (keys) =>
    keys.filter((k) => {
      const pr = pulls.get(k);
      return pr && !("additions" in pr) && !sizeAsked.has(`${k}#${pr.number}`);
    });

  // Looks up the pull requests of the tasks in `keys` that have none (one listing per repo),
  // then the size of those without one, each once: listings don't have it, and a closed one's
  // never changes.
  function fill(keys) {
    const unique = [...new Set(keys)];
    const missing = unique
      .filter((k) => !has(k))
      .map((key) => ({ key, ...parseKey(key) }))
      .filter((t) => t.repo && t.kind !== "discussion" && !listed.has(t.repo));
    if (fetching || (!missing.length && !unsized(unique).length)) return fetching;
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
            ...(pr.head?.sha && { head: pr.head.sha }),
          });
          changed = true;
        }
      }
      for (const key of unsized(unique)) {
        const pr = pulls.get(key);
        sizeAsked.add(`${key}#${pr.number}`);
        let found;
        try {
          found = await getPull(parseKey(key).repo, pr.number);
        } catch (error) {
          log(`Pull requests: ${key} #${pr.number}: ${error.message ?? error}`);
          continue;
        }
        const size = pullSize(found);
        // Recorded meanwhile by a delivery: that one is newer.
        const now = pulls.get(key);
        if (!Object.keys(size).length || !sameBesidesCi(now, pr)) continue;
        pulls.set(key, { ...now, ...size });
        changed = true;
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
  // doesn't have or whose size isn't known one by one), and the tasks without one looked up
  // again at the next fill(). Resolves to how many changed state. One at a time: a second call shares it.
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
      let dirty = false;
      for (const [repo, entries] of byRepo) {
        const list = await listPulls(repo).catch((error) => {
          log(`Pull requests of ${repo}: ${error.message ?? error}`);
          return [];
        });
        for (const [key, pr] of entries) {
          let found = list.find((p) => p.number === pr.number);
          // Not listed, or its size not known yet (recorded from a listing, or before sizes
          // were): the pull request itself has it.
          if (!found || !("additions" in pr)) {
            try {
              found = await getPull(repo, pr.number);
            } catch (error) {
              log(`Pull requests: ${repo}#${pr.number}: ${error.message ?? error}`);
            }
            found ??= list.find((p) => p.number === pr.number);
          }
          const state = found && prState(found);
          // Recorded meanwhile by a delivery: that one is newer. Only its CI read meanwhile
          // (readCiOf()): what it found stays.
          const now = pulls.get(key);
          if (!state || !sameBesidesCi(now, pr)) continue;
          // Only getPull() has its size: a listing's leaves the one known.
          const size = pullSize(found);
          const resized = Object.entries(size).some(([k, v]) => pr[k] !== v);
          // A head that moved without its delivery: its CI starts again (ciStale()).
          const head = found.head?.sha ?? pr.head;
          if (state === pr.state && !resized && head === pr.head) continue;
          const moved = head && head !== pr.head && now.ci?.sha !== head;
          pulls.set(key, {
            ...now,
            ...size,
            state,
            url: found.html_url ?? pr.url,
            ...(head && { head }),
            ...(moved && { ci: { sha: head, state: "none", runs: [] } }),
          });
          dirty = true;
          // A size alone isn't what the dashboard's Sync reports.
          if (state === pr.state) continue;
          log(`${key}: pull request #${pr.number} ${state} (was ${pr.state})`);
          changed++;
        }
      }
      if (dirty) pulls.save();
      // What CI deliveries lost meanwhile (the listener down, a delivery that failed): read
      // again for the open pull requests whose CI isn't settled for their head, after, so the
      // dashboard's Sync doesn't wait for them.
      catchUp(
        openPulls()
          .filter(([, pr]) => ciStale(pr))
          .map(([key]) => key),
      );
      return changed;
    })().finally(() => (resyncing = null));
    return resyncing;
  }

  // The CI of the tasks in `keys` read again, CI_AT_ONCE at a time; resolves once all are read.
  // A catch-up still going takes the new keys after its own.
  let catching = Promise.resolve();
  function catchUp(keys) {
    const queue = [...keys];
    const worker = async () => {
      while (queue.length) {
        const key = queue.shift();
        await readCiOf(key).catch((error) => log(`${key}: CI: ${error.message ?? error}`));
      }
    };
    const run = () => Promise.all(Array.from({ length: CI_AT_ONCE }, worker));
    catching = catching.then(run, run);
    return catching;
  }

  // Whether an open pull request's CI is worth reading again from GitHub: never read for its
  // head (a new head's `none` included, as a delivery may have been lost), or still running.
  const ciStale = (pr) =>
    !!pr.head && (pr.ci?.sha !== pr.head || pr.ci.state === "none" || pr.ci.state === "running");

  // A delivery said CI changed on commit `sha` of `repo` (events.mjs ciDelivery()): the open
  // pull requests at that head read theirs again. A commit no pull request is at (an older head,
  // the default branch) is left alone. Resolves once read.
  function ciChanged(repo, sha) {
    const keys = openPulls()
      .filter(([key, pr]) => pr.head === sha && sameRepo(parseKey(key)?.repo, repo))
      .map(([key]) => key);
    return Promise.all(keys.map(readCiOf));
  }

  // Task `key`'s pull request's CI read from GitHub and recorded, if its head is still the one
  // read for. One read at a time per task: one asked meanwhile reads once more after it.
  function readCiOf(key) {
    if (reading.has(key)) {
      reading.get(key).again = true;
      return reading.get(key).done;
    }
    const entry = { again: false, done: null };
    reading.set(key, entry);
    entry.done = (async () => {
      do {
        entry.again = false;
        const pr = pulls.get(key);
        if (!pr?.head || !open(pr)) break;
        const repo = parseKey(key)?.repo;
        let ci;
        try {
          ci = await readCi(repo, pr.head);
        } catch (error) {
          // A delivery since asks again: the error may have passed.
          log(`${key}: CI of #${pr.number}: ${error.message ?? error}`);
          continue;
        }
        const now = pulls.get(key);
        // Moved to another head meanwhile: that one's CI is the one shown.
        if (!ci || now?.head !== ci.sha) continue;
        if (JSON.stringify(now.ci) === JSON.stringify(ci)) continue;
        pulls.set(key, { ...now, ci });
        pulls.save();
        if (now.ci?.state !== ci.state) log(`${key}: CI of #${now.number} ${ci.state}`);
      } while (entry.again);
    })().finally(() => reading.delete(key));
    return entry.done;
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
    ciChanged,
    // The CI reads resync() started, for tests.
    caughtUp: () => catching,
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

// Whether entries `a` and `b` are the same, but for their CI: readCiOf() writes only that, and
// the lookups that were going meanwhile still apply.
function sameBesidesCi(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const rest = ({ ci, ...other }) => other;
  return JSON.stringify(rest(a)) === JSON.stringify(rest(b));
}

// The size fields of a recorded pull request, those it has.
function knownSize(pr) {
  return Object.fromEntries(
    Object.keys(PULL_SIZE)
      .filter((k) => k in pr)
      .map((k) => [k, pr[k]]),
  );
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
