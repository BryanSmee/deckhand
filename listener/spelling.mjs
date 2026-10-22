// One spelling per repo in the listener's state. GitHub's names ignore case, but tasks are
// keyed by exact strings, and a listener from before dashboard actions took GitHub's spelling
// (work.mjs) may have one repo under two: "Org/app" from webhooks, "org/app" from a typed
// address. A restart puts everything under one (restart.mjs unifySpellings()).
import { parseKey, sameRepo, taskKey } from "./events.mjs";

// The repos `records` ({ repo }) have under more than one spelling: one name each.
export function ambiguous(records) {
  const seen = new Map();
  for (const { repo } of records) {
    if (typeof repo !== "string") continue;
    const all = seen.get(repo.toLowerCase()) ?? new Set();
    seen.set(repo.toLowerCase(), all.add(repo));
  }
  return [...seen.values()].filter((all) => all.size > 1).map((all) => [...all][0]);
}

// spelled(repo) for `records` ({ repo, startedAt?, live? }): GitHub's name when `known` has it
// (lowercase name → full_name), else a run still going's (moving its task away from the
// webhooks' key would start a second run), else the most recent record's, else the first.
export function spellings(records, known = new Map()) {
  const rank = (r) => [r.live ? 1 : 0, r.startedAt ?? 0];
  const best = new Map();
  for (const r of records) {
    if (typeof r.repo !== "string") continue;
    const name = r.repo.toLowerCase();
    const was = best.get(name);
    const [live, at] = rank(r);
    const [wasLive, wasAt] = was ? rank(was) : [-1, -1];
    if (live > wasLive || (live === wasLive && at > wasAt)) best.set(name, r);
  }
  return (repo) => {
    if (typeof repo !== "string") return repo;
    const name = repo.toLowerCase();
    return known.get(name) ?? best.get(name)?.repo ?? repo;
  };
}

// GitHub's names of `repos` (nameOf(): repo-check.mjs), lowercase name → full_name, for those
// it answers within `waitMs`; one it renamed to another name entirely is left out.
export async function githubNames(repos, nameOf, waitMs = 5000) {
  const known = new Map();
  let timer;
  const asked = Promise.all(
    repos.map(async (repo) => {
      try {
        const name = await nameOf(repo);
        if (sameRepo(name, repo)) known.set(repo.toLowerCase(), name);
      } catch {
        // Not known: the state's own spelling.
      }
    }),
  );
  await Promise.race([asked, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
  return new Map(known);
}

// A task's key with its repo spelled as spelled() has it.
export function respelled(key, spelled) {
  const parsed = parseKey(key ?? "");
  return parsed ? taskKey(spelled(parsed.repo), parsed.id) : key;
}

// A Map keyed by task keys, rekeyed with spelled(), each moved value through `fix`. When both
// spellings of a task are there, the one already under the new key stays. Whether it changed.
export function respellMap(map, spelled, fix = (value) => value) {
  let changed = false;
  for (const [key, value] of [...map]) {
    const to = respelled(key, spelled);
    if (to === key) continue;
    map.delete(key);
    if (!map.has(to)) map.set(to, fix(value));
    changed = true;
  }
  return changed;
}
