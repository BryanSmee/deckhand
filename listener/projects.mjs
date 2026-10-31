// The listener's moves on a repo's projects (v2) (issue #454): a repo whose .deckhand.yaml lists
// `projects:` (repo-config.mjs) has each issue a work run starts on put on those projects, and
// the option of their field (Status by default) set when the run starts, when the issue's pull
// request turns ready, and when it merges. Only projects the operator's grants list for the
// repo (`allow_projects`, grants.mjs) are written; runs only add items (github-writes.mjs), so
// the board moves as the listener sees the work, not as a run says. Nothing here stops a run:
// a move that fails is logged, and noted in the run's log when a run started it.
import { answersOnly } from "./capabilities.mjs";
import { repoAllowed } from "./config.mjs";
import { linkedIssue } from "./events.mjs";

// How long a project's ids (its own, its field's and the field's options) are kept: an option
// renamed on the board is found again after that.
export const PROJECT_MS = 10 * 60_000;

const PROJECT = `query($org: String!, $number: Int!, $field: String!) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      field(name: $field) {
        __typename
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
    }
  }
}`;
const ISSUE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id } }
}`;
const PULL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;
const ADD = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`;
const SET = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`;

// What the listener sends, for the test that validates them against GitHub's pinned schema.
export const PROJECT_QUERIES = { PROJECT, ISSUE, PULL, ADD, SET };

// A pull request's dashboard states (pulls.mjs) past which its issue's work is no longer
// starting: a run then is a fix or a follow-up, and `start` would move the issue back.
const PAST_START = new Set(["ready", "merged"]);

// A `pull_request` delivery → { repo, base, number, pull, author, step } when it moves the
// issue it closes and itself (events.mjs linkedIssue(): only a pull request from a branch of
// the repo speaks for one): `ready` when it turned ready for review, `merged` when it merged.
// `author`: its author's login, which move() checks. Else null.
export function projectStep(config, event, p) {
  if (event !== "pull_request") return null;
  const repo = p.repository?.full_name;
  const pr = p.pull_request;
  if (!p.installation?.id || !repo || !pr || !repoAllowed(config, repo)) return null;
  const ready =
    p.action === "ready_for_review" ||
    (["opened", "reopened"].includes(p.action) && pr.state === "open" && !pr.draft);
  const merged = p.action === "closed" && !!(pr.merged_at ?? pr.merged);
  if (!ready && !merged) return null;
  // Into the default branch only: GitHub closes the issue a pull request names only then, and
  // one merged into another branch hasn't done it.
  const base = p.repository.default_branch || "main";
  if (pr.base?.ref !== base) return null;
  const number = linkedIssue(pr, repo);
  if (!number) return null;
  return {
    repo,
    base,
    number,
    pull: pr.number,
    author: pr.user?.login ?? null,
    step: merged ? "merged" : "ready",
  };
}

// `graphql(repo, query, variables)`: the App's, as the repo's installation (github.mjs);
// `repoSettings(repo, base)`: its .deckhand.yaml (repo-settings.mjs); `grantOf(repo)`: its grants
// (grants.mjs grantFor()), null when they have errors; `pullOf(key)`: the dashboard's pull
// request of a task (pulls.mjs get()), null when none; `now`: the clock.
export function createProjects({
  config,
  graphql,
  repoSettings,
  grantOf,
  pullOf = () => null,
  now = Date.now,
  log,
}) {
  // "acme/3|Status" → { at, ids: Promise<{ project, field, options }> }
  const cache = new Map();

  function idsOf(repo, project, field) {
    const key = `${project}|${field}`;
    const known = cache.get(key);
    if (known && now() - known.at < PROJECT_MS) return known.ids;
    const [org, number] = project.split("/");
    const ids = graphql(repo, PROJECT, { org, number: Number(number), field }).then((data) => {
      const found = data?.organization?.projectV2;
      if (!found) throw new Error(`${project} isn't there, or the GitHub App can't see it`);
      if (found.field?.__typename !== "ProjectV2SingleSelectField") {
        throw new Error(`${project} has no single select field named ${field}`);
      }
      return { project: found.id, field: found.field.id, options: found.field.options ?? [] };
    });
    cache.set(key, { at: now(), ids });
    // A failure is not kept: the next move asks again.
    ids.catch(() => cache.get(key)?.ids === ids && cache.delete(key));
    return ids;
  }

  // Issue `number` of `repo`, and with `pull` its pull request too, put on each of its granted
  // projects, and their field set to the option `step` names (repo-config.mjs PROJECT_STEPS),
  // where its entry names one. `author`: a delivery's pull request's, which must be one of the
  // repo's users or the App's bot (an Actions workflow or another App may open pull requests
  // from outsiders' text); none for a run's start, whose author the run's admission checked.
  // `note`: a line in the run's log, when a run started it. Resolves to the moves made,
  // ["acme/3: In progress"]; never throws.
  // `settings`: the repo's, as a run starting read them (runs.mjs begin()), else read here.
  async function move(
    repo,
    base,
    number,
    step,
    { note = () => {}, pull = null, author, settings: known = null } = {},
  ) {
    const done = [];
    const failed = (what) => {
      log(`${repo}#${number}: projects: ${what}`);
      try {
        note(`Deckhand couldn't move #${number} on its project: ${what}`);
      } catch (error) {
        log(`${repo}#${number}: projects: its run's log: ${error.message ?? error}`);
      }
    };
    let read = known && { settings: known, errors: [] };
    try {
      read ??= await repoSettings(repo, base);
    } catch (error) {
      failed(error.message ?? String(error));
      return done;
    }
    // A config with errors moves nothing: its `projects:` may be half read.
    if (read.errors?.length) return done;
    const { settings } = read;
    const wanted = (settings?.projects ?? []).filter((p) => p[step]);
    if (!wanted.length) return done;
    if (author !== undefined) {
      const login = String(author ?? "").toLowerCase();
      const allowed =
        (settings.users ?? []).includes(login) ||
        (!!config.bot && login === config.bot.toLowerCase());
      if (!allowed) {
        log(`${repo}#${number}: projects: #${pull}'s author ${author} isn't one of its users`);
        return done;
      }
    }
    const granted = grantOf(repo)?.allowProjects ?? [];
    const [owner, name] = repo.split("/");
    // The node IDs of what moves, looked up once.
    let contents = null;
    const contentsOf = async () => {
      if (contents) return contents;
      const issue = (await graphql(repo, ISSUE, { owner, name, number }))?.repository?.issue?.id;
      if (!issue) throw new Error(`#${number} isn't an issue of ${repo}`);
      const found = [issue];
      if (pull !== null) {
        const data = await graphql(repo, PULL, { owner, name, number: pull });
        const id = data?.repository?.pullRequest?.id;
        if (!id) throw new Error(`#${pull} isn't a pull request of ${repo}`);
        found.push(id);
      }
      return (contents = found);
    };
    for (const entry of wanted) {
      if (!granted.includes(entry.project)) {
        failed(`the operator's grants don't list ${entry.project} in allow_projects`);
        continue;
      }
      try {
        const ids = await idsOf(repo, entry.project, entry.field);
        const option = ids.options.find((o) => o.name.toLowerCase() === entry[step].toLowerCase());
        if (!option) throw new Error(`${entry.field} has no option ${entry[step]}`);
        for (const content of await contentsOf()) {
          // GitHub answers with the item it already has for the same content.
          const added = await graphql(repo, ADD, { project: ids.project, content });
          const item = added?.addProjectV2ItemById?.item?.id;
          if (!item) throw new Error("GitHub added no item");
          await graphql(repo, SET, {
            project: ids.project,
            item,
            field: ids.field,
            option: option.id,
          });
        }
        done.push(`${entry.project}: ${option.name}`);
      } catch (error) {
        failed(`${entry.project}: ${error.message ?? error}`);
      }
    }
    const what = pull === null ? "" : ` and #${pull}`;
    if (done.length) log(`${repo}#${number}${what}: projects: ${done.join(", ")} (${step})`);
    return done;
  }

  // A work run starting on an issue: its `start` option. A run without `push` only reads and
  // answers (capabilities.mjs answersOnly()): its capabilities are decided by then.
  // Not a run asked from the issue's pull request (a review's fix, a comment there: its
  // `replyTo`), nor one once that pull request is ready or merged: the issue stays where the
  // pull request's steps put it. `errors`: those of the config the run read (runs.mjs begin()):
  // with any, nothing moves, as for a delivery (the runs.mjs caller only gets here once the run
  // passed its checks, which refuse it then).
  function started(task, note, errors = []) {
    if (answersOnly(task.live) || task.kind !== "issue") return Promise.resolve([]);
    if (errors?.length) return Promise.resolve([]);
    const replyTo = task.live?.replyTo;
    if (replyTo != null && replyTo !== task.number) return Promise.resolve([]);
    if (PAST_START.has(pullOf(task.live?.key ?? task.key)?.state)) return Promise.resolve([]);
    // The settings the run started with: no second read.
    return move(task.repo, task.base, task.number, "start", { note, settings: task.settings });
  }

  // A `pull_request` delivery: the issue it closes and itself, at `ready` or `merged`
  // (projectStep()).
  function pulled(event, payload) {
    const found = projectStep(config, event, payload);
    if (!found) return Promise.resolve([]);
    const { repo, base, number, step, pull, author } = found;
    return move(repo, base, number, step, { pull, author });
  }

  return { move, started, pulled };
}
