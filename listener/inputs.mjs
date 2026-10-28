// The open issues carrying the needs-input label, for the dashboard, by task key
// ("org/repo#12") → { since, questions, botTicks } (parseQuestions() of its body, or null;
// `botTicks`: the App's bot's edit ticked its last boxes, which answer nothing). `issues`
// webhooks keep it current (questions.mjs); labels added or removed, or bodies edited, while
// the listener was down are caught by one lookup per repo when it starts (sync()). Kept in
// inputs.json, so a restart doesn't forget them meanwhile.
import { hasLabel } from "./comments.mjs";
import { parseKey, sameRepo, taskKey } from "./events.mjs";
import { paginate } from "./github.mjs";
import { allTicked, parseQuestions, questionsSection } from "./questions.mjs";
import { respellMap } from "./spelling.mjs";
import { persistentMap } from "./store.mjs";

// `listLabelled(repo)`: the repo's open issues with the label, as GET /repos/{repo}/issues
// has them.
export function createInputs({ path, listLabelled, now = Date.now, log = () => {} }) {
  const inputs = persistentMap(path);
  const save = inputs.save;

  // Whether issue `key` waits for input now, its questions and whether the bot ticked them
  // when known (undefined: as they were).
  function set(key, on, questions, botTicks) {
    const was = inputs.get(key);
    if (!on) {
      if (inputs.delete(key)) save();
      return;
    }
    const next = {
      since: was?.since ?? now(),
      questions: questions === undefined ? (was?.questions ?? null) : questions,
      ...((botTicks ?? was?.botTicks) && { botTicks: true }),
    };
    if (was && JSON.stringify(was) === JSON.stringify(next)) return;
    inputs.set(key, next);
    save();
  }

  // An edit to the questions of an issue already listed.
  function update(key, questions, botTicks) {
    if (inputs.has(key)) set(key, true, questions, botTicks);
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
        if (!sameRepo(parseKey(key)?.repo, repo) || found.has(key)) continue;
        inputs.delete(key);
        changed = true;
      }
      // Bodies edited meanwhile: their questions as they are now.
      for (const [key, entry] of found) {
        const was = inputs.get(key);
        const next = {
          since: was?.since ?? entry.since,
          questions: entry.questions,
          ...(was?.botTicks && { botTicks: true }),
        };
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

  return {
    set,
    update,
    sync,
    list,
    has: (key) => inputs.has(key),
    // Whether the bot's edit ticked issue `key`'s last boxes: its ticks don't answer.
    botTicked: (key) => !!inputs.get(key)?.botTicks,
    keys: () => [...inputs.keys()],
    // One spelling per repo (spelling.mjs, at a restart).
    respell: (spelled) => respellMap(inputs, spelled) && save(),
  };
}

// Open questions in the bodies of a repo's open issues (the work area's backlog, work.mjs)
// that the needs-input label never came for. `github`: the App's calls; `label(repo, number,
// on)`: the label (comments.mjs); `inputs`: createInputs(); `boardKeys()`: the keys of the
// tasks on the dashboard.
export function createInputSeeder({ config, github, label, inputs, boardKeys, log = () => {} }) {
  // Issues with open questions whose label was taken off once: answered, or removed by hand.
  const unlabelled = new Set();

  // Open questions in an issue's body that the needs-input label never came for: without the
  // `issues` event, or when the label call failed, only the label's listing (sync()) knew
  // of them, so the graph's form didn't open and a start went through unanswered. Listed and
  // labelled here, as an `issues opened` delivery would have, unless the label was taken off
  // once (its timeline says): its questions were answered, or someone said they don't hold.
  // An issue on the board had a run, whose start takes the label off: left alone too.
  async function seed(repo, list, users) {
    const name = config.needsInputLabel;
    if (!name) return;
    const keys = boardKeys();
    const author = (u) =>
      u?.type === "Bot"
        ? !!config.bot && u.login?.toLowerCase() === config.bot.toLowerCase()
        : !!u?.login &&
          config.users.includes(u.login.toLowerCase()) &&
          users.includes(u.login.toLowerCase());
    for (const issue of list) {
      const key = taskKey(repo, issue.number);
      if (issue.pull_request || inputs.has(key) || keys.has(key) || unlabelled.has(key)) continue;
      // Fail closed, as questions.mjs: only an allowed user's issue, or the App's own.
      if (!author(issue.user)) continue;
      const questions = parseQuestions(questionsSection(issue.body));
      if (!questions) continue;
      const labelled = hasLabel(issue.labels, name);
      // Every box ticked in an allowed user's issue, unlabelled: answered already. Still
      // labelled, the label says it waits (the bot's ticks answer nothing), and the App's own
      // issues (an inbox run's) wait whatever their ticks.
      if (!labelled && issue.user?.type !== "Bot" && allTicked(questions)) continue;
      try {
        if (!labelled) {
          if (await wasUnlabelled(repo, issue.number, name)) {
            unlabelled.add(key);
            continue;
          }
          const res = await label(repo, issue.number, true);
          if (!res.ok) log(`${key}: label: ${res.status}`);
        }
        log(`${key}: open questions found in the backlog`);
        inputs.set(key, true, questions);
      } catch (error) {
        // The next read tries again.
        log(`${key}: open questions: ${error.message ?? error}`);
      }
    }
  }

  // Whether the label was ever taken off issue `number`.
  async function wasUnlabelled(repo, number, name) {
    const events = await paginate(
      (path) => github(repo, "GET", path),
      `/repos/${repo}/issues/${number}/events`,
    );
    return events.some((e) => e.event === "unlabeled" && hasLabel([e.label], name));
  }

  return { seed };
}
