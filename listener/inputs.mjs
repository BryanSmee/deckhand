// The open issues carrying the needs-input label, for the dashboard, by task key
// ("org/repo#12") → { since }. `issues` webhooks keep it current (questions.mjs); labels
// added or removed while the listener was down are caught by one lookup per repo when it
// starts (sync()). Kept in inputs.json, so a restart doesn't forget them meanwhile.
import { readJson, writeJsonAtomic } from "./store.mjs";
import { parseKey } from "./titles.mjs";

// `listLabelled(repo)`: the repo's open issues with the label, as GET /repos/{repo}/issues
// has them.
export function createInputs({ path, listLabelled, now = Date.now, log = () => {} }) {
  const inputs = new Map(Object.entries(readJson(path, {})));

  function save() {
    writeJsonAtomic(path, Object.fromEntries(inputs));
  }

  // Whether issue `key` waits for input now.
  function set(key, on) {
    if (on === inputs.has(key)) return;
    if (on) inputs.set(key, { since: now() });
    else inputs.delete(key);
    save();
  }

  // Replaces what is known of each repo in `repos` with GitHub's list. A repo that can't be
  // listed keeps what it had. Resolves to [key, title] pairs, for the dashboard's titles.
  async function sync(repos) {
    const titles = [];
    let changed = false;
    for (const repo of repos) {
      let list;
      try {
        list = await listLabelled(repo);
      } catch (error) {
        log(`Issues waiting for input in ${repo}: ${error.message ?? error}`);
        continue;
      }
      const found = new Map();
      for (const issue of list) {
        // Pull requests are issues to that listing: their runs show them already.
        if (issue.pull_request) continue;
        const key = `${repo}#${issue.number}`;
        found.set(key, Date.parse(issue.updated_at) || now());
        titles.push([key, issue.title]);
      }
      for (const key of inputs.keys()) {
        if (parseKey(key)?.repo.toLowerCase() !== repo.toLowerCase() || found.has(key)) continue;
        inputs.delete(key);
        changed = true;
      }
      for (const [key, since] of found) {
        if (inputs.has(key)) continue;
        inputs.set(key, { since });
        changed = true;
      }
    }
    if (changed) save();
    return titles;
  }

  // [{ key, repo, since }], for board().
  const list = () =>
    [...inputs].map(([key, { since }]) => ({ key, repo: parseKey(key)?.repo ?? null, since }));

  return { set, sync, list, has: (key) => inputs.has(key) };
}
