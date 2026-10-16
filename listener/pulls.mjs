// Each task's pull request for the dashboard, by task key ("org/repo#12", "org/repo#pr-3"):
// { number, url, state, readyAt }. `pull_request` webhooks keep it current (events.mjs
// pullRequest()); tasks older than that are looked up once per listener start, from the
// repo's recent pull requests. Kept in pulls.json, so a restart neither forgets nor asks again.
import { linkedIssue, parseKey, prState, sameRepo } from "./events.mjs";
import { persistentMap } from "./store.mjs";

const open = (pr) => pr?.state === "draft" || pr?.state === "ready";

// `listPulls(repo)`: the repo's recent pull requests, as GET /repos/{repo}/pulls has them.
export function createPulls({ path, listPulls, log = () => {} }) {
  const pulls = persistentMap(path);
  // Listed once per listener: tasks after that get theirs from webhooks.
  const listed = new Set();
  let fetching = null;

  // Records `pr` on task `key`, the latest event winning: the same pull request leaves the
  // task it was on (its "Closes #n" was edited). A closed pull request doesn't replace another
  // one still open on the task: a new attempt was opened before the old one was closed.
  function record(key, pr) {
    const repo = parseKey(key)?.repo;
    const current = pulls.get(key);
    if (current && current.number !== pr.number && open(current) && !open(pr)) return false;
    let before = null;
    for (const [other, p] of pulls) {
      if (!other.startsWith(`${repo}#`) || p.number !== pr.number) continue;
      before = p;
      if (other !== key) pulls.delete(other);
    }
    // An edit or a close says nothing about when it turned ready: the earlier event did.
    const readyAt = pr.readyAt ?? before?.readyAt ?? null;
    pulls.set(key, { ...pr, readyAt });
    pulls.save();
    return true;
  }

  // Looks up the pull requests of the tasks in `keys` that have none: one listing per repo.
  function fill(keys) {
    const missing = [...new Set(keys)]
      .filter((k) => !pulls.has(k))
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
          if (!pr || pulls.has(t.key)) continue;
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

  return { get: (key) => pulls.get(key) ?? null, record, fill, open: openPulls };
}

// A task's pull request in a listing, newest first: itself for "#pr-n"; for an issue, the
// one on its branch (issue-<n>-…, not a fork's) or that closes it.
function match(list, repo, { kind, number }) {
  if (kind === "pr") return list.find((p) => p.number === number);
  return (
    list.find((p) => sameRepo(p, repo) && p.head.ref?.startsWith(`issue-${number}-`)) ??
    list.find((p) => linkedIssue(p, repo) === number)
  );
}
