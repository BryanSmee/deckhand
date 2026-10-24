// The dashboard's titles of issues, pull requests and discussions, by task key
// ("org/repo#12", "org/repo#pr-3", "org/repo#discussion-8"), and whether each issue or pull
// request is closed, which the graph shows. Webhooks bring most of them; the rest are fetched
// from GitHub and kept in titles.json and closed.json, so a restart doesn't ask again.
import { parseKey } from "./events.mjs";
import { respellMap } from "./spelling.mjs";
import { persistentMap } from "./store.mjs";

// events.mjs issueOutcome() ("open", "done", "not-done") → the dashboard's closed state: null
// (open), "completed" (a pull request: merged) or "not_planned".
export function closedAs(outcome) {
  if (outcome === "done") return "completed";
  return outcome === "not-done" ? "not_planned" : null;
}

// `fetchTitle(repo, kind, number)`: { title, closed } on GitHub (`closed` as closedAs() has
// it, undefined for discussions), or null. `closedPath`: where the closed states are kept.
export function createTitles({ path, closedPath, fetchTitle, log = () => {} }) {
  const titles = persistentMap(path);
  // Key → closedAs(); null: open when last heard of.
  const closed = persistentMap(closedPath);
  // Fetched once per listener: a failure (a deleted issue, no access) isn't retried until
  // the next start, which also asks again about what was open (a close missed while down).
  const tried = new Set();
  let fetching = null;

  const save = titles.save;

  function set(key, title) {
    if (!title || titles.get(key) === title) return;
    titles.set(key, title);
    save();
  }

  // From an `issues` or `pull_request` delivery, or a fetch: `state` as closedAs() has it.
  function setClosed(key, state) {
    if (!closedPath || closed.get(key) === state) return;
    closed.set(key, state);
    closed.save();
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

  // Discussions have no closed state here; a closed issue rarely reopens, and its webhook says.
  const known = (key, kind) =>
    titles.has(key) && (kind === "discussion" || !closedPath || closed.get(key));

  // Fetches what `keys` lack, one at a time; calls during a fetch wait for the next.
  function fill(keys) {
    const missing = [...new Set(keys)]
      .map((key) => ({ key, target: parseKey(key) }))
      .filter(({ key, target }) => !tried.has(key) && !known(key, target?.kind));
    if (fetching || !missing.length) return fetching;
    fetching = (async () => {
      for (const { key, target } of missing) {
        tried.add(key);
        if (!target) continue;
        try {
          const found = await fetchTitle(target.repo, target.kind, target.number);
          set(key, found?.title);
          if (found && found.closed !== undefined) setClosed(key, found.closed);
        } catch (error) {
          log(`Title of ${key}: ${error.message ?? error}`);
        }
      }
    })().finally(() => (fetching = null));
    return fetching;
  }

  return {
    get: (key) => titles.get(key) ?? null,
    closed: (key) => closed.get(key) ?? null,
    set,
    setClosed,
    seed,
    fill,
    keys: () => [...new Set([...titles.keys(), ...closed.keys()])],
    // Rekeyed with spelled() (restart.mjs unifySpellings()), as the tasks they name are.
    respell(spelled) {
      if (respellMap(titles, spelled)) save();
      if (respellMap(closed, spelled) && closedPath) closed.save();
    },
  };
}
