// The dashboard's titles of issues, pull requests and discussions, by task key
// ("org/repo#12", "org/repo#pr-3", "org/repo#discussion-8"). Webhooks bring most of them;
// tasks older than that (logs written before titles were kept) are fetched once from GitHub
// and kept in titles.json, so a restart doesn't ask again.
import { readJson, writeJsonAtomic } from "./store.mjs";

// `fetchTitle(repo, kind, number)`: the title on GitHub, or null.
export function createTitles({ path, fetchTitle, log = () => {} }) {
  const titles = new Map(Object.entries(readJson(path, {})));
  // Fetched once per listener: a failure (a deleted issue, no access) isn't retried until
  // the next start.
  const tried = new Set();
  let fetching = null;

  function save() {
    writeJsonAtomic(path, Object.fromEntries(titles));
  }

  function set(key, title) {
    if (!title || titles.get(key) === title) return;
    titles.set(key, title);
    save();
  }

  // [key, title] pairs, newest first, for keys that have none yet: one write for all.
  function seed(pairs) {
    let changed = false;
    for (const [key, title] of pairs) {
      if (!title || titles.has(key)) continue;
      titles.set(key, title);
      changed = true;
    }
    if (changed) save();
  }

  // Fetches the titles `keys` lack, one at a time; calls during a fetch wait for the next.
  function fill(keys) {
    const missing = [...new Set(keys)].filter((k) => !titles.has(k) && !tried.has(k));
    if (fetching || !missing.length) return fetching;
    fetching = (async () => {
      for (const key of missing) {
        tried.add(key);
        const target = parseKey(key);
        if (!target) continue;
        try {
          set(key, await fetchTitle(target.repo, target.kind, target.number));
        } catch (error) {
          log(`Title of ${key}: ${error.message ?? error}`);
        }
      }
    })().finally(() => (fetching = null));
    return fetching;
  }

  return { get: (key) => titles.get(key) ?? null, set, seed, fill };
}

// "org/repo#pr-3" → { repo: "org/repo", kind: "pr", number: 3 }.
export function parseKey(key) {
  const m = /^([^/#]+\/[^/#]+)#(?:(pr|discussion)-)?(\d+)$/.exec(key);
  return m && { repo: m[1], kind: m[2] ?? "issue", number: Number(m[3]) };
}
