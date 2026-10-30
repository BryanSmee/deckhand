// The listener's moves on a repo's projects (v2) (projects.mjs): which deliveries move an issue,
// the granted projects only, the option of each step, and nothing that stops a run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validationError } from "../listener/github-graphql.mjs";
import { createProjects, PROJECT_MS, PROJECT_QUERIES, projectStep } from "../listener/projects.mjs";
import { testConfig } from "./helpers.mjs";

const config = testConfig();

test("the listener's queries and mutations are valid on GitHub", () => {
  for (const [name, query] of Object.entries(PROJECT_QUERIES)) {
    assert.equal(validationError(query), null, name);
  }
});

// A `pull_request` delivery from a branch of the repo that closes #12.
const delivery = (action, pr = {}) => ({
  action,
  installation: { id: 1 },
  repository: { full_name: "Org/Repo", default_branch: "trunk" },
  pull_request: {
    number: 40,
    state: "open",
    draft: false,
    body: "Closes #12",
    head: { ref: "issue-12-x", repo: { full_name: "Org/Repo" } },
    base: { ref: "trunk" },
    user: { login: "alice" },
    ...pr,
  },
});

test("projectStep: ready for review, opened ready, merged; from a branch of the repo only", () => {
  const at = (step) => ({
    repo: "Org/Repo",
    base: "trunk",
    number: 12,
    pull: 40,
    author: "alice",
    step,
  });
  const step = (p) => projectStep(config, "pull_request", p);
  assert.deepEqual(step(delivery("ready_for_review")), at("ready"));
  assert.deepEqual(step(delivery("opened")), at("ready"));
  assert.deepEqual(
    step(delivery("closed", { state: "closed", merged_at: "2026-10-30" })),
    at("merged"),
  );
  // Into another branch than the default one: GitHub doesn't close the issue, nothing moves.
  const feature = { base: { ref: "feature/x" } };
  assert.equal(step(delivery("ready_for_review", feature)), null);
  assert.equal(step(delivery("closed", { ...feature, state: "closed", merged_at: "x" })), null);
  assert.equal(step(delivery("ready_for_review", { base: undefined })), null);
  // A draft opened, a close without a merge, a push, an edit: nothing moves.
  assert.equal(step(delivery("opened", { draft: true })), null);
  assert.equal(step(delivery("closed", { state: "closed", merged_at: null })), null);
  assert.equal(step(delivery("synchronize")), null);
  assert.equal(step(delivery("edited")), null);
  // A fork's pull request doesn't speak for the issue; one closing none moves nothing.
  const fork = { head: { ref: "x", repo: { full_name: "someone/Repo" } } };
  assert.equal(step(delivery("ready_for_review", fork)), null);
  assert.equal(step(delivery("ready_for_review", { body: "no issue" })), null);
  // Not from an installation, another event, a repo the operator doesn't allow.
  assert.equal(step({ ...delivery("ready_for_review"), installation: undefined }), null);
  assert.equal(projectStep(config, "issues", delivery("ready_for_review")), null);
  const only = testConfig({ ALLOWED_REPOS: "org/other" });
  assert.equal(projectStep(only, "pull_request", delivery("ready_for_review")), null);
});

// A fake GitHub GraphQL: acme/3's Status field, issue #12, the items it added and the options
// it set; `fail` makes a query throw.
function fakeGraphql({ options = ["Todo", "In progress", "In review", "Done"], fail = null } = {}) {
  const sent = [];
  const graphql = async (repo, query, variables) => {
    sent.push({ repo, query: query.split(/[({]/)[0].trim(), variables });
    if (fail?.(query, variables)) throw new Error("GraphQL: 502");
    if (query.includes("organization(")) {
      if (variables.org !== "acme") return { organization: null };
      return {
        organization: {
          projectV2: {
            id: `PV_${variables.number}`,
            field:
              variables.field === "Status"
                ? {
                    __typename: "ProjectV2SingleSelectField",
                    id: "F_status",
                    options: options.map((name, i) => ({ id: `O_${i}`, name })),
                  }
                : { __typename: "ProjectV2Field" },
          },
        },
      };
    }
    if (query.includes("pullRequest(")) {
      return { repository: { pullRequest: { id: `PR_${variables.number}` } } };
    }
    if (query.includes("repository(")) return { repository: { issue: { id: "I_12" } } };
    if (query.includes("addProjectV2ItemById")) {
      return { addProjectV2ItemById: { item: { id: `PVTI_${variables.content}` } } };
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } };
    }
    throw new Error(`unexpected ${query}`);
  };
  return { graphql, sent };
}

const entry = (project, steps, field = "Status") => ({
  project,
  field,
  start: null,
  ready: null,
  merged: null,
  ...steps,
});

function projects({
  settings = [entry("acme/3", { start: "In progress", ready: "in review", merged: "Done" })],
  granted = ["acme/3"],
  graphql = fakeGraphql(),
  clock = { now: 0 },
  users = ["alice"],
  errors = [],
  pulls = {},
} = {}) {
  const logged = [];
  const read = [];
  const p = createProjects({
    config,
    graphql: graphql.graphql,
    repoSettings: async (repo, base) => (
      read.push([repo, base]),
      { settings: { projects: settings, users }, errors }
    ),
    grantOf: () => (granted ? { allowProjects: granted } : null),
    pullOf: (key) => pulls[key] ?? null,
    now: () => clock.now,
    log: (line) => logged.push(line),
  });
  return { ...p, logged, read, sent: graphql.sent };
}

test("move: the issue added to each granted project, its field set to the step's option", async () => {
  const p = projects();
  assert.deepEqual(await p.move("Org/Repo", "trunk", 12, "ready"), ["acme/3: In review"]);
  assert.deepEqual(p.read, [["Org/Repo", "trunk"]]);
  assert.deepEqual(p.sent, [
    {
      repo: "Org/Repo",
      query: "query",
      variables: { org: "acme", number: 3, field: "Status" },
    },
    { repo: "Org/Repo", query: "query", variables: { owner: "Org", name: "Repo", number: 12 } },
    { repo: "Org/Repo", query: "mutation", variables: { project: "PV_3", content: "I_12" } },
    {
      repo: "Org/Repo",
      query: "mutation",
      variables: { project: "PV_3", item: "PVTI_I_12", field: "F_status", option: "O_2" },
    },
  ]);
  assert.deepEqual(p.logged, ["Org/Repo#12: projects: acme/3: In review (ready)"]);
  // The project's ids are kept a while, then asked again.
  await p.move("Org/Repo", "trunk", 12, "merged");
  assert.equal(p.sent.filter((s) => s.variables.org).length, 1);
});

test("move: the project's ids asked again once PROJECT_MS is over, or after a failure", async () => {
  const clock = { now: 0 };
  let failing = true;
  const graphql = fakeGraphql({ fail: (q) => failing && q.includes("organization(") });
  const p = projects({ clock, graphql });
  assert.deepEqual(await p.move("Org/Repo", "main", 12, "start"), []);
  assert.match(p.logged.at(-1), /Org\/Repo#12: projects: acme\/3: GraphQL: 502/);
  failing = false;
  assert.deepEqual(await p.move("Org/Repo", "main", 12, "start"), ["acme/3: In progress"]);
  clock.now = PROJECT_MS - 1;
  await p.move("Org/Repo", "main", 12, "start");
  clock.now = PROJECT_MS + 1;
  await p.move("Org/Repo", "main", 12, "start");
  assert.equal(p.sent.filter((s) => s.variables.org).length, 3);
});

test("move: ungranted projects, steps without an option, unknown options and fields are skipped, noted", async () => {
  const notes = [];
  const p = projects({
    settings: [
      entry("acme/3", { start: "Doing" }),
      entry("acme/4", { start: "In progress" }),
      entry("acme/5", { start: "In progress" }, "Kind"),
      entry("acme/6", { merged: "Done" }),
      entry("other/1", { start: "In progress" }),
    ],
    granted: ["acme/3", "acme/5", "acme/6", "other/1"],
  });
  assert.deepEqual(
    await p.move("Org/Repo", "main", 12, "start", { note: (n) => notes.push(n) }),
    [],
  );
  assert.deepEqual(notes, [
    "Deckhand couldn't move #12 on its project: acme/3: Status has no option Doing",
    "Deckhand couldn't move #12 on its project: the operator's grants don't list acme/4 in allow_projects",
    "Deckhand couldn't move #12 on its project: acme/5: acme/5 has no single select field named Kind",
    "Deckhand couldn't move #12 on its project: other/1: other/1 isn't there, or the GitHub App can't see it",
  ]);
  // Nothing written: no item added before its option is known.
  assert.ok(!p.sent.some((s) => s.query === "mutation"));
  // Grants with errors: nothing granted.
  const broken = projects({ granted: null });
  assert.deepEqual(await broken.move("Org/Repo", "main", 12, "start"), []);
  assert.match(broken.logged[0], /don't list acme\/3/);
  // No `projects:`: nothing asked.
  const none = projects({ settings: [] });
  assert.deepEqual(await none.move("Org/Repo", "main", 12, "start"), []);
  assert.deepEqual(none.sent, []);
});

test("started: a work run on an issue only; pulled: the issue a pull request closes", async () => {
  const p = projects();
  const task = {
    repo: "Org/Repo",
    base: "main",
    number: 12,
    kind: "issue",
    live: { light: false },
  };
  assert.deepEqual(await p.started(task), ["acme/3: In progress"]);
  assert.deepEqual(await p.started({ ...task, live: { light: true } }), []);
  assert.deepEqual(await p.started({ ...task, kind: "pr" }), []);
  assert.deepEqual(await p.pulled("pull_request", delivery("ready_for_review")), [
    "acme/3: In review",
  ]);
  // The pull request moves with its issue.
  const set = p.sent.filter((s) => s.variables.option === "O_2").map((s) => s.variables.item);
  assert.deepEqual(set, ["PVTI_I_12", "PVTI_PR_40"]);
  assert.match(p.logged.at(-1), /Org\/Repo#12 and #40: projects: acme\/3: In review \(ready\)/);
  assert.deepEqual(
    await p.pulled("pull_request", delivery("closed", { state: "closed", merged_at: "x" })),
    ["acme/3: Done"],
  );
  assert.deepEqual(await p.pulled("pull_request", delivery("synchronize")), []);
  // A repo's settings that can't be read: said, not thrown.
  const broken = createProjects({
    config,
    graphql: async () => ({}),
    repoSettings: async () => {
      throw new Error("GitHub GET: 502");
    },
    grantOf: () => null,
    log: () => {},
  });
  assert.deepEqual(await broken.started(task), []);
});

test("started: the settings the run started with, not read again", async () => {
  const p = projects({ settings: [] });
  const settings = {
    projects: [entry("acme/3", { start: "In progress" })],
    users: ["alice"],
  };
  const task = {
    repo: "Org/Repo",
    base: "main",
    number: 12,
    kind: "issue",
    settings,
    live: { light: false, key: "Org/Repo#12", replyTo: 12 },
  };
  assert.deepEqual(await p.started(task), ["acme/3: In progress"]);
  assert.deepEqual(p.read, []);
  // Its config read with errors: nothing moves, whatever its `projects:` says.
  const broken = projects();
  const errors = ["fast_mod: unknown, ignored", "trigger: expected a line of text"];
  assert.deepEqual(await broken.started(task, () => {}, errors), []);
  assert.deepEqual([broken.read, broken.sent], [[], []]);
  // A repo without `projects:`: nothing asked of GitHub at all.
  const none = projects();
  assert.deepEqual(await none.started({ ...task, settings: { projects: [], users: [] } }), []);
  assert.deepEqual([none.read, none.sent], [[], []]);
});

test("started: not from the issue's pull request, nor once it is ready or merged", async () => {
  const p = projects({ pulls: { "Org/Repo#12": { number: 40, state: "draft" } } });
  const task = {
    repo: "Org/Repo",
    base: "main",
    number: 12,
    kind: "issue",
    live: { light: false, key: "Org/Repo#12", replyTo: 12 },
  };
  // Its pull request still a draft: a run on the issue moves it.
  assert.deepEqual(await p.started(task), ["acme/3: In progress"]);
  // A review's fix run, or a comment on its pull request: replying there, it stays put.
  assert.deepEqual(await p.started({ ...task, live: { ...task.live, replyTo: 40 } }), []);
  // Its pull request ready, or merged: a comment on the issue doesn't move it back either.
  for (const state of ["ready", "merged"]) {
    const q = projects({ pulls: { "Org/Repo#12": { number: 40, state } } });
    assert.deepEqual(await q.started(task), [], state);
    assert.deepEqual(q.sent, [], state);
  }
});

test("pulled: only a pull request of the repo's users or Deckhand's bot; a config with errors moves nothing", async () => {
  const bot = { ...config, bot: "deckhand-x[bot]" };
  // Someone else's (an Actions workflow, another App): nothing.
  const p = projects();
  const outsider = delivery("ready_for_review", { user: { login: "github-actions[bot]" } });
  assert.deepEqual(await p.pulled("pull_request", outsider), []);
  assert.deepEqual(p.sent, []);
  assert.match(p.logged.at(-1), /#40's author github-actions\[bot\] isn't one of its users/);
  // Deckhand's bot's own, whatever the users.
  const logged = [];
  const own = createProjects({
    config: bot,
    graphql: fakeGraphql().graphql,
    repoSettings: async () => ({
      settings: { projects: [entry("acme/3", { ready: "In review" })], users: [] },
      errors: [],
    }),
    grantOf: () => ({ allowProjects: ["acme/3"] }),
    log: (line) => logged.push(line),
  });
  const ours = delivery("ready_for_review", { user: { login: "Deckhand-x[bot]" } });
  assert.deepEqual(await own.pulled("pull_request", ours), ["acme/3: In review"]);
  // Errors in .deckhand.yaml: nothing, its projects: may be half read.
  const broken = projects({ errors: ["projects[1].project: expected <organization>/<number>"] });
  assert.deepEqual(await broken.pulled("pull_request", delivery("ready_for_review")), []);
  assert.deepEqual(await broken.move("Org/Repo", "main", 12, "start"), []);
  assert.deepEqual(broken.sent, []);
});

test("move: a run's log that can't be written to is logged, never thrown", async () => {
  const p = projects({ granted: [] });
  const note = () => {
    throw new Error("ENOSPC");
  };
  assert.deepEqual(await p.move("Org/Repo", "main", 12, "start", { note }), []);
  assert.match(p.logged.at(-1), /its run's log: ENOSPC/);
});
