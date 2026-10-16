// The open issues carrying the needs-input label, for the dashboard, by task key
// ("org/repo#12") → { since, questions } (parseQuestions() of its body, or null). `issues`
// webhooks keep it current (questions.mjs); labels added or removed, or bodies edited, while
// the listener was down are caught by one lookup per repo when it starts (sync()). Kept in
// inputs.json, so a restart doesn't forget them meanwhile.
import { parseKey, taskKey } from "./events.mjs";
import { parseQuestions, questionsSection } from "./questions.mjs";
import { persistentMap } from "./store.mjs";

// `listLabelled(repo)`: the repo's open issues with the label, as GET /repos/{repo}/issues
// has them.
export function createInputs({ path, listLabelled, now = Date.now, log = () => {} }) {
  const inputs = persistentMap(path);
  const save = inputs.save;

  // Whether issue `key` waits for input now, and its questions when known (undefined: as
  // they were).
  function set(key, on, questions) {
    const was = inputs.get(key);
    if (!on) {
      if (inputs.delete(key)) save();
      return;
    }
    const next = {
      since: was?.since ?? now(),
      questions: questions === undefined ? (was?.questions ?? null) : questions,
    };
    if (was && JSON.stringify(was) === JSON.stringify(next)) return;
    inputs.set(key, next);
    save();
  }

  // An edit to the questions of an issue already listed.
  function update(key, questions) {
    if (inputs.has(key)) set(key, true, questions);
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
        const key = taskKey(repo, issue.number);
        found.set(key, {
          since: Date.parse(issue.updated_at) || now(),
          questions: parseQuestions(questionsSection(issue.body)),
        });
        titles.push([key, issue.title]);
      }
      for (const key of inputs.keys()) {
        if (parseKey(key)?.repo.toLowerCase() !== repo.toLowerCase() || found.has(key)) continue;
        inputs.delete(key);
        changed = true;
      }
      // Bodies edited meanwhile: their questions as they are now.
      for (const [key, entry] of found) {
        const was = inputs.get(key);
        const next = { since: was?.since ?? entry.since, questions: entry.questions };
        if (was && JSON.stringify(was) === JSON.stringify(next)) continue;
        inputs.set(key, next);
        changed = true;
      }
    }
    if (changed) save();
    return titles;
  }

  // [{ key, repo, since, questions }], for board().
  const list = () =>
    [...inputs].map(([key, { since, questions = null }]) => ({
      key,
      repo: parseKey(key)?.repo ?? null,
      since,
      questions,
    }));

  return { set, update, sync, list, has: (key) => inputs.has(key) };
}
