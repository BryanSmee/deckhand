// The listener's moves on a repo's projects (v2) (issue #454): a repo whose .deckhand.yaml lists
// `projects:` (repo-config.mjs) has each issue a work run starts on put on those projects, and
// the option of their field (Status by default) set when the run starts, when the issue's pull
// request turns ready, and when it merges. Only projects the operator's grants list for the
// repo (`allow_projects`, grants.mjs) are written; runs only add items (github-writes.mjs), so
// the board moves as the listener sees the work, not as a run says. Nothing here stops a run:
// a move that fails is logged, and noted in the run's log when a run started it.
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
const ADD = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`;
const SET = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`;

// What the listener sends, for the test that validates them against GitHub's pinned schema.
export const PROJECT_QUERIES = { PROJECT, ISSUE, ADD, SET };

// A `pull_request` delivery → { repo, base, number, step } when it moves the issue it closes
// (events.mjs linkedIssue(): only a pull request from a branch of the repo speaks for one):
// `ready` when it turned ready for review, `merged` when it merged. Else null.
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
  const number = linkedIssue(pr, repo);
  if (!number) return null;
  return {
    repo,
    base: p.repository.default_branch || "main",
    number,
    step: merged ? "merged" : "ready",
  };
}

// `graphql(repo, query, variables)`: the App's, as the repo's installation (github.mjs);
// `repoSettings(repo, base)`: its .deckhand.yaml (repo-settings.mjs); `grantOf(repo)`: its grants
// (grants.mjs grantFor()), null when they have errors; `now`: the clock.
export function createProjects({ config, graphql, repoSettings, grantOf, now = Date.now, log }) {
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

  // Issue `number` of `repo` put on each of its granted projects, and their field set to the
  // option `step` names (repo-config.mjs PROJECT_STEPS), where its entry names one. `note`: a
  // line in the run's log, when a run started it. Resolves to the moves made, ["acme/3: In
  // progress"]; never throws.
  async function move(repo, base, number, step, note = () => {}) {
    const done = [];
    const failed = (what) => {
      log(`${repo}#${number}: projects: ${what}`);
      note(`Deckhand couldn't move #${number} on its project: ${what}`);
    };
    let settings;
    try {
      ({ settings } = await repoSettings(repo, base));
    } catch (error) {
      failed(error.message ?? String(error));
      return done;
    }
    const wanted = (settings?.projects ?? []).filter((p) => p[step]);
    if (!wanted.length) return done;
    const granted = grantOf(repo)?.allowProjects ?? [];
    let content = null;
    for (const entry of wanted) {
      if (!granted.includes(entry.project)) {
        failed(`the operator's grants don't list ${entry.project} in allow_projects`);
        continue;
      }
      try {
        const ids = await idsOf(repo, entry.project, entry.field);
        const option = ids.options.find((o) => o.name.toLowerCase() === entry[step].toLowerCase());
        if (!option) throw new Error(`${entry.field} has no option ${entry[step]}`);
        if (!content) {
          const [owner, name] = repo.split("/");
          const data = await graphql(repo, ISSUE, { owner, name, number });
          content = data?.repository?.issue?.id;
          if (!content) throw new Error(`#${number} isn't an issue of ${repo}`);
        }
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
        done.push(`${entry.project}: ${option.name}`);
      } catch (error) {
        failed(`${entry.project}: ${error.message ?? error}`);
      }
    }
    if (done.length) log(`${repo}#${number}: projects: ${done.join(", ")} (${step})`);
    return done;
  }

  // A work run starting on an issue: its `start` option. Light runs only read and answer, and
  // a pull request's runs move its issue when it turns ready or merges.
  function started(task, note) {
    if (task.live?.light || task.kind !== "issue") return Promise.resolve([]);
    return move(task.repo, task.base, task.number, "start", note);
  }

  // A `pull_request` delivery: the issue it closes, at `ready` or `merged` (projectStep()).
  function pulled(event, payload) {
    const found = projectStep(config, event, payload);
    if (!found) return Promise.resolve([]);
    return move(found.repo, found.base, found.number, found.step);
  }

  return { move, started, pulled };
}
