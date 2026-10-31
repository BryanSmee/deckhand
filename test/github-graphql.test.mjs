// A run's GraphQL (github-graphql.mjs): parsed and validated against GitHub's pinned schema,
// queries passed on, each mutation field classified from the nodes GitHub resolves its IDs to,
// then held to the same checks as REST writes (github-writes.mjs), and printed again.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkReads,
  checkSelections,
  createGraphqlChecks,
  createValidator,
  githubSchema,
  lookupNodes,
  MAX_CHECK_PATHS,
  issueReads,
  MAX_FIELDS,
  MAX_QUERY,
  MAX_TOKENS,
  MUTATIONS,
  parseCall,
  restName,
} from "../listener/github-graphql.mjs";
import { parse } from "../listener/vendor/graphql.mjs";
import { classify, createWriteChecks, MAX_REFUSED_LOOKUPS } from "../listener/github-writes.mjs";
import { allowingPolicies, defaultPolicies, hasOpa, policyEngine } from "./helpers.mjs";

const json = (value) => Buffer.from(JSON.stringify(value));
const call = (query, variables, operationName) => json({ query, variables, operationName });

// GitHub's nodes, by ID: the run's repo, its issues and labels, another repo's.
const NODES = {
  R_repo: { __typename: "Repository", nameWithOwner: "Org/Repo" },
  R_other: { __typename: "Repository", nameWithOwner: "org/other" },
  I_1: {
    __typename: "Issue",
    number: 1,
    databaseId: 101,
    repository: { nameWithOwner: "Org/Repo" },
  },
  I_2: {
    __typename: "Issue",
    number: 2,
    databaseId: 102,
    repository: { nameWithOwner: "Org/Repo" },
  },
  I_3: {
    __typename: "Issue",
    number: 3,
    databaseId: 103,
    repository: { nameWithOwner: "Org/Repo" },
  },
  I_4: {
    __typename: "Issue",
    number: 4,
    databaseId: 104,
    repository: { nameWithOwner: "Org/Repo" },
  },
  I_o: {
    __typename: "Issue",
    number: 1,
    databaseId: 201,
    repository: { nameWithOwner: "org/other" },
  },
  I_5: {
    __typename: "Issue",
    number: 5,
    databaseId: 105,
    repository: { nameWithOwner: "Org/Repo" },
  },
  I_6: {
    __typename: "Issue",
    number: 6,
    databaseId: 106,
    repository: { nameWithOwner: "Org/Repo" },
  },
  PR_7: { __typename: "PullRequest", number: 7, repository: { nameWithOwner: "Org/Repo" } },
  // Comments by their id (a BigInt, sent as a string): one a run posts, the listener's, another
  // repository's.
  IC_own: {
    __typename: "IssueComment",
    fullDatabaseId: "3000000001",
    repository: { nameWithOwner: "Org/Repo" },
  },
  IC_listener: {
    __typename: "IssueComment",
    fullDatabaseId: "3000000009",
    repository: { nameWithOwner: "Org/Repo" },
  },
  IC_o: {
    __typename: "IssueComment",
    fullDatabaseId: "3000000001",
    repository: { nameWithOwner: "org/other" },
  },
  // Comments for reactions: on #1 (with the listener's 👀, the bot's), on #3, on pull request
  // #7; a commit's.
  IC_1: {
    __typename: "IssueComment",
    fullDatabaseId: "11",
    repository: { nameWithOwner: "Org/Repo" },
    reactionGroups: [
      { content: "EYES", viewerHasReacted: true },
      { content: "HEART", viewerHasReacted: false },
    ],
  },
  IC_3: {
    __typename: "IssueComment",
    fullDatabaseId: "13",
    repository: { nameWithOwner: "Org/Repo" },
  },
  RC_7: {
    __typename: "PullRequestReviewComment",
    fullDatabaseId: "17",
    repository: { nameWithOwner: "Org/Repo" },
  },
  CC_1: { __typename: "CommitComment", repository: { nameWithOwner: "Org/Repo" } },
  L_idea: { __typename: "Label", name: "idea", repository: { nameWithOwner: "Org/Repo" } },
  L_bug: { __typename: "Label", name: "bug", repository: { nameWithOwner: "Org/Repo" } },
  L_needs: { __typename: "Label", name: "needs-input", repository: { nameWithOwner: "Org/Repo" } },
  L_o: { __typename: "Label", name: "idea", repository: { nameWithOwner: "org/other" } },
  U_1: { __typename: "User" },
  // Review threads on #7, by their first comment: Deckhand's review's, a person's, one GitHub
  // answers without comments, and another repository's.
  PRRT_d: thread(7, 40),
  PRRT_h: thread(7, 41),
  PRRT_e: { ...thread(7, 0), comments: { nodes: [] } },
  PRRT_o: { ...thread(7, 40), repository: { nameWithOwner: "org/other" } },
  // Projects (v2): outside any repository, named by their owner and number.
  PV_3: { __typename: "ProjectV2", number: 3, title: "Roadmap", owner: { login: "Acme" } },
  PV_9: { __typename: "ProjectV2", number: 9, title: "Other", owner: { login: "acme" } },
  U_alice: { __typename: "User", login: "alice" },
  U_mallory: { __typename: "User", login: "mallory" },
  B_bot: { __typename: "Bot", login: "deckhand" },
  B_copilot: { __typename: "Bot", login: "Copilot" },
  O_org: { __typename: "Organization", login: "org" },
  M_3: {
    __typename: "Milestone",
    number: 3,
    title: "v1",
    repository: { nameWithOwner: "Org/Repo" },
  },
  M_o: {
    __typename: "Milestone",
    number: 3,
    title: "v1",
    repository: { nameWithOwner: "org/other" },
  },
};
function thread(number, comment, repo = "Org/Repo") {
  return {
    __typename: "PullRequestReviewThread",
    repository: { nameWithOwner: repo },
    pullRequest: { number },
    comments: { nodes: [{ databaseId: comment }] },
  };
}

// GitHub's REST answers the write checks look up (github-writes.mjs resolve()): #1 the run's,
// #2 a sub-issue of it, #3 someone else's, #4 someone else's closed, #5 the bot's (one a run
// created, when its `created` says so), #6 a sub-issue waiting for answers, #7 a pull request,
// assigned to bob.
const ISSUES = {
  1: { number: 1, user: { login: "alice" }, labels: [] },
  2: { number: 2, user: { login: "bob" }, labels: [{ name: "idea" }] },
  3: { number: 3, state: "open", user: { login: "bob" }, labels: [] },
  4: { number: 4, state: "closed", user: { login: "bob" }, labels: [] },
  6: { number: 6, user: { login: "bob" }, labels: [{ name: "needs-input" }] },
  5: {
    number: 5,
    user: { login: "deckhand[bot]" },
    created_at: "2026-01-01T00:00:00Z",
    labels: [],
  },
  7: {
    number: 7,
    pull_request: {},
    user: { login: "deckhand[bot]" },
    labels: [],
    assignees: [{ login: "bob" }],
  },
};
// Comments by their path and id: two the bot's (one a run posts, the listener's), and for
// reactions, the issue or pull request each is on.
const COMMENTS = {
  "issues/comments/3000000001": {
    user: { login: "deckhand[bot]" },
    issue_url: "https://api.github.com/repos/Org/Repo/issues/1",
  },
  "issues/comments/3000000009": {
    user: { login: "deckhand[bot]" },
    issue_url: "https://api.github.com/repos/Org/Repo/issues/1",
  },
  "issues/comments/11": {
    id: 11,
    user: { login: "alice" },
    issue_url: "https://api.github.com/repos/org/repo/issues/1",
  },
  "issues/comments/13": {
    id: 13,
    user: { login: "bob" },
    issue_url: "https://api.github.com/repos/org/repo/issues/3",
  },
  "pulls/comments/17": {
    id: 17,
    user: { login: "bob" },
    pull_request_url: "https://api.github.com/repos/org/repo/pulls/7",
  },
  // Review threads' first comments on #7: Deckhand's review's, and a person's.
  "pulls/comments/40": {
    id: 40,
    user: { login: "deckhand[bot]" },
    pull_request_url: "https://api.github.com/repos/Org/Repo/pulls/7",
  },
  "pulls/comments/41": {
    id: 41,
    user: { login: "alice" },
    pull_request_url: "https://api.github.com/repos/Org/Repo/pulls/7",
  },
};
async function lookup(repo, path) {
  const comment = /^\/repos\/org\/repo\/((?:issues|pulls)\/comments\/\d+)$/.exec(path);
  if (comment) return COMMENTS[comment[1]] ?? null;
  const m = /^\/repos\/org\/repo\/(issues|pulls)\/(\d+)(\/parent|\/sub_issues.*)?$/.exec(path);
  if (!m) throw new Error(`unexpected look-up ${path}`);
  const n = +m[2];
  if (m[3] === "/parent") {
    return n === 2 || n === 6
      ? { number: 1, repository_url: "https://api.github.com/repos/Org/Repo" }
      : null;
  }
  if (m[3]) return [];
  if (m[1] === "pulls") return { head: { ref: "issue-1-x", repo: { full_name: "Org/Repo" } } };
  return ISSUES[n] ?? null;
}

const run = (mode, issue = 1, { push = mode === "work", reason = null } = {}) => ({
  repo: "org/repo",
  mode,
  push,
  issue,
  base: "main",
  branches: push ? ["issue-1-*"] : [],
  created: [],
  reason,
  caps: ["pull", "read:issues", "read:pulls"],
});

// The checks, with the writes they held and the IDs they looked up. `policies`: allowing every
// write, for the built-in checks, else their engine (helpers.mjs policyEngine(), which sees each
// write's input, or defaultPolicies(), Deckhand's own, for what each mode may write).
function checks({
  checkWrite,
  needsInputLabel = () => null,
  policies = allowingPolicies,
  projects = () => ["acme/3"],
} = {}) {
  const writes = [];
  const asked = [];
  // The REST look-ups the write checks made.
  const looked = [];
  const real = createWriteChecks({
    needsInputLabel,
    lookup: (repo, path) => (looked.push(path), lookup(repo, path)),
    bot: () => "deckhand[bot]",
    users: () => ["alice", "bob", "copilot"],
    policies,
    projects,
  }).checkWrite;
  const { check } = createGraphqlChecks({
    nodes: async (repo, ids) => (asked.push([repo, ids]), ids.map((id) => NODES[id] ?? null)),
    checkWrite: async (r, write, memo) => (
      writes.push(write),
      (checkWrite ?? real)(r, write, memo)
    ),
  });
  return { check, writes, asked, looked };
}

// The tests of what Deckhand's own policies let each mode write (defaultPolicies()): the real opa.
const withOpa = { skip: !hasOpa() && "no opa on the PATH" };

// gh's own calls (cli/cli: api/queries_issue.go, pkg/cmd/issue/…).
const GH_CREATE =
  "mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { id url } } }";
const GH_COMMENT =
  "mutation CommentCreate($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { url } } } }";
const GH_EDIT =
  "mutation IssueUpdate($input: UpdateIssueInput!) { updateIssue(input: $input) { __typename } }";
// `gh issue comment --edit-last` and `--delete-last` (api/queries_comments.go).
const GH_COMMENT_EDIT =
  "mutation CommentUpdate($input: UpdateIssueCommentInput!) { updateIssueComment(input: $input) { issueComment { url } } }";
const GH_COMMENT_DELETE =
  "mutation CommentDelete($input: DeleteIssueCommentInput!) { deleteIssueComment(input: $input) { clientMutationId } }";

test("the pinned schema is GitHub's, with the mutations Deckhand classifies", () => {
  const fields = githubSchema().getMutationType().getFields();
  for (const name of Object.keys(MUTATIONS)) {
    assert.ok(fields[name], name);
    const input = fields[name].args.find((a) => a.name === "input").type.ofType.getFields();
    const { target, fields: known, empty = [] } = MUTATIONS[name];
    for (const field of [target, ...known, ...empty]) {
      assert.ok(input[field], `${name}.${field}`);
    }
  }
});

test("a query goes on printed again, its variables and operation name kept; nothing looked up", async () => {
  const { check, writes, asked } = checks();
  const query =
    'query Q($n: Int!) { repository(owner: "org", name: "repo") { issue(number: $n) { title } } }';
  const out = await check(run("brainstorm"), call(`  ${query}  # a comment`, { n: 1 }, "Q"));
  assert.equal(out.write, false);
  const sent = JSON.parse(out.body);
  assert.equal(sent.operationName, "Q");
  assert.deepEqual(sent.variables, { n: 1 });
  assert.doesNotMatch(sent.query, /comment/);
  assert.match(sent.query, /^query Q\(\$n: Int!\) \{\n {2}repository/);
  assert.deepEqual([writes, asked], [[], []]);
});

test("refused: what doesn't parse or validate, several operations without their name, a subscription", async () => {
  const { check, asked } = checks();
  const refused = [
    [Buffer.from("not json"), /isn't JSON/],
    [json({ variables: {} }), /without a query/],
    [json({ query: "{ viewer { login } }", variables: [] }), /variables aren't an object/],
    [json({ query: "{ viewer { login } }", operationName: 5 }), /operationName isn't a string/],
    [call("mutation {"), /doesn't parse/],
    [call("{ nope }"), /isn't valid on GitHub: Cannot query field "nope"/],
    // Arguments GitHub's schema doesn't have, a missing required one, a wrong type.
    [
      call('mutation { addComment(input: { subjectId: "I_1" }) { clientMutationId } }'),
      /isn't valid/,
    ],
    [call("query A { viewer { login } } mutation B { __typename }"), /names no single operation/],
    // An operation name that names none of them, and one beside a single anonymous operation.
    [
      call("query A { viewer { login } } query B { viewer { id } }", null, "C"),
      /no single operation/,
    ],
    [call("{ viewer { login } }", null, "A"), /no single operation/],
    [call(GH_COMMENT, { input: { subjectId: "I_1" } }), /variables: .*body/],
    [call(GH_COMMENT), /variables: .*input/],
  ];
  for (const [body, message] of refused) {
    const out = await check(run("work"), body);
    assert.equal(out.refused?.status, 400, body.toString());
    assert.match(out.refused.message, message, body.toString());
  }
  assert.deepEqual(asked, []);
});

test("a document over its caps is refused before it is validated: validation would hold the listener", () => {
  // No schema: validating would throw.
  const tokens = call(`{ ${"a: viewer { login } ".repeat(MAX_TOKENS / 6 + 1)} }`);
  assert.ok(tokens.length < MAX_QUERY);
  assert.match(parseCall(tokens, null).refused.message, /doesn't parse: .*tokens/);
  const bytes = call(`{ viewer { login } } # ${"x".repeat(MAX_QUERY)}`);
  assert.equal(parseCall(bytes, null).refused.status, 413);
  // The worst a document under the caps can do: repeated fields, in a fraction of a second.
  // A mutation, which keeps the rule on fields that can't merge, the quadratic one.
  for (const worst of [
    call(`{ ${"a: viewer { login } ".repeat(Math.floor((MAX_TOKENS - 2) / 6))} }`),
    call(`mutation { ${"a: __typename ".repeat(Math.floor((MAX_TOKENS - 3) / 3))} }`),
  ]) {
    const start = performance.now();
    assert.equal(parseCall(worst).refused, undefined);
    assert.ok(performance.now() - start < 1000);
  }
});

test("gh issue view's query is valid: fragments on distinct types may select a field of two types, as GitHub allows, in a query only", () => {
  // gh's IssueByNumber, trimmed: Issue.state is an IssueState, PullRequest.state a
  // PullRequestState.
  const view = `query IssueByNumber($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue: issueOrPullRequest(number: $number) {
        __typename
        ...on Issue { number, state, labels(first: 100) { nodes { name } } }
        ...on PullRequest { number, state, author { login, ...on User { name } } }
      }
    }
  }`;
  const variables = { owner: "o", repo: "r", number: 1 };
  assert.equal(parseCall(call(view, variables)).op.operation, "query");
  // A mutation keeps the rule: what it selects back can't merge either.
  const comment = `mutation($input: AddCommentInput!) {
    addComment(input: $input) {
      subject { ...on Issue { state } ...on PullRequest { state } }
    }
  }`;
  const out = parseCall(call(comment, { input: { subjectId: "I_1", body: "b" } }));
  assert.match(out.refused.message, /isn't valid on GitHub: Fields "state" conflict/);
});

test("parseCall picks the operation GitHub runs: by its name, among several", () => {
  const doc = "query A { viewer { login } } mutation B { __typename }";
  assert.equal(parseCall(call(doc, null, "B")).op.operation, "mutation");
  assert.equal(parseCall(call(doc, null, "A")).op.operation, "query");
});

test("gh issue create, comment and edit: classified from GitHub's nodes, checked as REST writes", async () => {
  const { check, writes, asked } = checks();
  const idea = run("idea", null);
  // gh's real variables (GH_DEBUG=api, gh 2.103.3): `projectIds: null` whenever it resolves a
  // label, which sets nothing (issue #422).
  const created = await check(
    idea,
    call(GH_CREATE, {
      input: {
        body: "B",
        labelIds: ["L_idea"],
        projectIds: null,
        repositoryId: "R_repo",
        title: "T",
      },
    }),
  );
  assert.equal(created.write, true);
  assert.deepEqual(created.creates, ["createIssue"]);
  // GitHub gets it as gh sent it: it accepts a null projectIds.
  assert.equal(JSON.parse(created.body).variables.input.projectIds, null);
  assert.deepEqual(asked, [["org/repo", ["R_repo", "L_idea"]]]);
  assert.deepEqual(writes[0], {
    repo: "org/repo",
    actions: ["create"],
    target: { kind: "new_issue" },
    change: { fields: ["title", "body", "labels"], labels_added: ["idea"], labels_removed: [] },
  });
  // An empty list sets nothing either: the same write. One with a project is refused.
  const listed = await check(
    idea,
    call(GH_CREATE, {
      input: {
        repositoryId: "R_repo",
        title: "T",
        body: "B",
        labelIds: ["L_idea"],
        projectIds: [],
      },
    }),
  );
  assert.equal(listed.write, true);
  assert.deepEqual(writes.at(-1), writes[0]);
  const project = await check(
    idea,
    call(GH_CREATE, {
      input: { repositoryId: "R_repo", title: "T", labelIds: ["L_idea"], projectIds: ["PRJ_1"] },
    }),
  );
  assert.equal(project.refused?.status, 403);
  assert.match(project.refused.message, /createIssue's projectIds/);

  const brainstorm = run("brainstorm");
  const comment = await check(
    brainstorm,
    call(GH_COMMENT, { input: { subjectId: "I_1", body: "x" } }),
  );
  assert.equal(comment.write, true);
  assert.deepEqual(writes.at(-1).target, { number: 1 });
  const edit = await check(brainstorm, call(GH_EDIT, { input: { id: "I_1", body: "New" } }));
  assert.equal(edit.write, true);
  assert.deepEqual(writes.at(-1).actions, ["edit"]);
  // Another repository's issue, whatever the call says it is.
  const away = await check(
    run("work"),
    call(GH_COMMENT, { input: { subjectId: "I_o", body: "x" } }),
  );
  assert.match(away.refused.message, /subjectId isn't in the run's repository/);
  // A create in another repository.
  const elsewhere = await check(
    run("work"),
    call(GH_CREATE, { input: { repositoryId: "R_other", title: "T" } }),
  );
  assert.match(elsewhere.refused.message, /repositoryId isn't in the run's repository/);
});

test(
  "Deckhand's policies over GraphQL: an idea's issue without its label, a brainstorm's comment, another's issue, its own issue's labels, milestone and assignees",
  withOpa,
  async (t) => {
    const { check } = checks({ policies: defaultPolicies(t) });
    const idea = run("idea", null);
    const create = (input) =>
      call(GH_CREATE, { input: { repositoryId: "R_repo", title: "T", ...input } });
    assert.equal((await check(idea, create({ labelIds: ["L_idea"] }))).write, true);
    assert.match(
      (await check(idea, create({}))).refused.message,
      /^createIssue: the policies refuse it: idea entries' issues carry the idea label/,
    );
    const brainstorm = run("brainstorm");
    // Its own issue's description; a follow-up in a milestone.
    assert.equal(
      (await check(brainstorm, call(GH_EDIT, { input: { id: "I_1", body: "New" } }))).write,
      true,
    );
    assert.equal((await check(brainstorm, create({ milestoneId: "M_3" }))).write, true);
    const refused = [
      // The listener posts its replies.
      [
        call(GH_COMMENT, { input: { subjectId: "I_1", body: "x" } }),
        /a brainstorm doesn't comment/,
      ],
      [
        call(GH_EDIT, { input: { id: "I_3", body: "x" } }),
        /no rule allows `edit` on `other_issue`/,
      ],
      // A label, a milestone or assignees on its own issue, set or cleared.
      [call(GH_EDIT, { input: { id: "I_1", labelIds: ["L_bug"] } }), /`label` on `own_issue`/],
      [call(GH_EDIT, { input: { id: "I_1", milestoneId: "M_3" } }), /`milestone` on `own_issue`/],
      [call(GH_EDIT, { input: { id: "I_1", milestoneId: null } }), /`milestone` on `own_issue`/],
      // Assigning: refused to every run (a deny says so).
      [call(GH_EDIT, { input: { id: "I_1", assigneeIds: null } }), /doesn't assign people/],
      [call(GH_EDIT, { input: { id: "I_1", labelIds: null } }), /`label` on `own_issue`/],
      [
        call(GH_ASSIGN, { input: { assignableId: "I_1", actorLogins: ["alice"] } }),
        /doesn't assign people/,
      ],
    ];
    for (const [body, why] of refused) {
      const out = await check(brainstorm, body);
      assert.equal(out.refused?.status, 403, body.toString());
      assert.match(out.refused.message, why);
    }
    // A work run assigns no one either, unless the operator's policies let it.
    const assign = call(GH_ASSIGN, { input: { assignableId: "I_1", actorLogins: ["alice"] } });
    assert.match((await check(run("work"), assign)).refused.message, /doesn't assign people/);
  },
);

// gh's own (GH_DEBUG=api, gh 2.103.3): `gh issue edit --add-assignee` and `gh issue create
// --assignee` send every assignee by login.
const GH_ASSIGN =
  "mutation ReplaceActorsForAssignable($input:ReplaceActorsForAssignableInput!){replaceActorsForAssignable(input: $input){__typename}}";

test("assignees and milestones over GraphQL: looked up from their nodes, held to the same limits as REST's", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "github.rego": "package deckhand\n" },
  });
  const { check, asked } = checks({ policies });
  const work = run("work");
  const change = () => evals.at(-1).change;
  const ok = async (query, input, mode = work) => {
    const out = await check(mode, call(query, { input }));
    assert.equal(out.refused, undefined, JSON.stringify(input));
    assert.equal(out.write, true);
    return change();
  };
  // gh's call, by login, on the run's pull request (bob's): bob is removed.
  assert.deepEqual(await ok(GH_ASSIGN, { assignableId: "PR_7", actorLogins: ["alice"] }), {
    fields: ["assignees"],
    labels_added: [],
    labels_removed: [],
    assignees: { added: ["alice"], removed: ["bob"] },
  });
  assert.deepEqual(evals.at(-1).actions, ["assign"]);
  // By node ID: a user, the App's bot (its login as REST spells it).
  assert.deepEqual(
    (await ok(GH_ASSIGN, { assignableId: "I_1", actorIds: ["U_alice", "B_bot"] })).assignees,
    { added: ["alice", "deckhand[bot]"], removed: [] },
  );
  assert.deepEqual(asked.at(-1), ["org/repo", ["I_1", "U_alice", "B_bot"]]);
  const add =
    "mutation($input: AddAssigneesToAssignableInput!) { addAssigneesToAssignable(input: $input) { __typename } }";
  assert.deepEqual((await ok(add, { assignableId: "I_2", assigneeIds: ["U_alice"] })).assignees, {
    added: ["alice"],
    removed: [],
  });
  const remove =
    "mutation($input: RemoveAssigneesFromAssignableInput!) { removeAssigneesFromAssignable(input: $input) { __typename } }";
  assert.deepEqual(
    (await ok(remove, { assignableId: "PR_7", assigneeIds: ["U_mallory"] })).assignees,
    { added: [], removed: ["mallory"] },
  );
  // Set in place of the pull request's, with its milestone, looked up.
  const edited = await ok(GH_PR_EDIT, {
    pullRequestId: "PR_7",
    assigneeIds: ["U_alice"],
    milestoneId: "M_3",
  });
  assert.deepEqual(evals.at(-1).actions, ["assign", "milestone"]);
  assert.deepEqual(edited.assignees, { added: ["alice"], removed: ["bob"] });
  assert.deepEqual(edited.milestone, { number: 3, title: "v1" });
  // Neither by ID nor by login: none, the pull request's removed.
  assert.deepEqual((await ok(GH_ASSIGN, { assignableId: "PR_7" })).assignees, {
    added: [],
    removed: ["bob"],
  });
  // Cleared, and a brainstorm filing an issue in a milestone.
  assert.equal((await ok(GH_EDIT, { id: "I_1", milestoneId: null })).milestone, null);
  const create = { repositoryId: "R_repo", title: "T", milestoneId: "M_3" };
  assert.deepEqual((await ok(GH_CREATE, create, run("brainstorm"))).milestone, {
    number: 3,
    title: "v1",
  });
  // Refused whatever the policies say: someone not allowed, Copilot, an organization, another
  // repository's milestone or something that isn't one, Copilot's own fields.
  const asks = evals.length;
  for (const [query, input, message] of [
    [GH_ASSIGN, { assignableId: "I_1", actorLogins: ["mallory"] }, /allowed users .* not @mallory/],
    [GH_ASSIGN, { assignableId: "I_1", actorIds: ["U_mallory"] }, /not @mallory/],
    [GH_ASSIGN, { assignableId: "I_1", actorIds: ["B_copilot"] }, /doesn't assign Copilot/],
    [GH_ASSIGN, { assignableId: "I_1", actorLogins: ["copilot-swe-agent"] }, /Copilot/],
    [add, { assignableId: "I_1", assigneeIds: ["O_org"] }, /names an assignee that isn't a user/],
    [add, { assignableId: "I_1", assigneeIds: ["U_gone"] }, /isn't a user/],
    [GH_EDIT, { id: "I_1", milestoneId: "M_o" }, /milestoneId isn't in the run's repository/],
    [GH_EDIT, { id: "I_1", milestoneId: "I_2" }, /milestoneId isn't in the run's repository/],
    [
      GH_ASSIGN,
      { assignableId: "I_1", agentAssignment: { targetRepositoryId: "R_repo" } },
      /replaceActorsForAssignable's agentAssignment/,
    ],
    [add, { assignableId: "I_1", assignees: [] }, /addAssigneesToAssignable's assignees/],
  ]) {
    const out = await check(work, call(query, { input }));
    assert.equal(out.refused?.status, 403, JSON.stringify(input));
    assert.match(out.refused.message, message, JSON.stringify(input));
  }
  assert.equal(evals.length, asks);
});

test("fragments spreading each other many times over: each field once, quickly", async () => {
  // M0 spreads M1 ten times, which spreads M2 ten times…: 10^9 spreads if walked each time.
  const depth = 9;
  const fragments = Array.from({ length: depth }, (_, i) =>
    i === depth - 1
      ? `fragment M${i} on Mutation { addComment(input: { subjectId: "I_1", body: "x" }) { clientMutationId } __typename }`
      : `fragment M${i} on Mutation { ${`...M${i + 1} `.repeat(10)} }`,
  ).join(" ");
  const { check, writes, asked } = checks();
  const start = performance.now();
  const out = await check(run("work"), call(`mutation { ...M0 } ${fragments}`));
  assert.ok(performance.now() - start < 1000);
  assert.equal(out.write, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(asked, [["org/repo", ["I_1"]]]);
});

test("a field sent as null counts as set: clearing labels, a milestone or assignees", async () => {
  const { check, writes } = checks();
  const edit = (input) => call(GH_EDIT, { input: { id: "I_1", ...input } });
  // Each one set: the policies see the action (Deckhand's refuse them to a brainstorm, above).
  for (const [input, action] of [
    [{ milestoneId: null }, "milestone"],
    [{ assigneeIds: null }, "assign"],
    [{ labelIds: null }, "label"],
  ]) {
    assert.equal((await check(run("brainstorm"), edit(input))).write, true, action);
    assert.deepEqual(writes.at(-1).actions, [action]);
  }
  // A work run labels its issue: labels set to null remove them all.
  assert.equal((await check(run("work"), edit({ labelIds: null }))).write, true);
  assert.deepEqual(writes.at(-1).actions, ["label"]);
  assert.deepEqual(writes.at(-1).change, {
    fields: ["labels"],
    labels_added: [],
    labels_removed: [],
    labels_set: true,
  });
  // A create with a null milestone sets one.
  await check(
    run("work"),
    call(GH_CREATE, { input: { repositoryId: "R_repo", title: "T", milestoneId: null } }),
  );
  assert.deepEqual(writes.at(-1).actions, ["create", "milestone"]);
});

test("variables and inline IDs, aliases and fragments: each field is checked, one refusal refuses all", async () => {
  // Policies that refuse any write to #3.
  const policies = {
    deny: async (_rule, _repo, _ref, input) => (input().target.number === 3 ? ["not #3"] : []),
  };
  const { check, writes } = checks({ policies });
  const work = run("work");
  // Two fields, one aliased, one inline and one from a variable, the second in a fragment.
  const doc = `mutation M($id: ID!) {
    a: addComment(input: { subjectId: "I_1", body: "x" }) { clientMutationId }
    ...F
  }
  fragment F on Mutation { b: addComment(input: { subjectId: $id, body: "y" }) { clientMutationId } }`;
  const ok = await check(work, call(doc, { id: "I_2" }));
  assert.equal(ok.write, true);
  assert.deepEqual(
    writes.map((w) => w.target),
    [{ number: 1 }, { number: 2 }],
  );
  // The same with the variable naming #3: the fragment's field refuses the call.
  const refused = await check(work, call(doc, { id: "I_3" }));
  assert.match(refused.refused.message, /^b: the policies refuse it: not #3/);
  // An inline fragment, and a field aliased as another one's name.
  const inline = `mutation { ... on Mutation { createIssue: addComment(input: { subjectId: "I_3", body: "x" }) { clientMutationId } } }`;
  assert.match((await check(work, call(inline))).refused.message, /^createIssue: .*not #3/);
  // Answers under a createIssue's own key name what it created; an alias is followed.
  const two = `mutation { x: createIssue(input: { repositoryId: "R_repo", title: "A" }) { issue { url } } createIssue(input: { repositoryId: "R_repo", title: "B" }) { issue { url } } c: addComment(input: { subjectId: "I_1", body: "x" }) { clientMutationId } }`;
  assert.deepEqual((await check(work, call(two))).creates, ["x", "createIssue"]);
});

test("a createIssue answer counts only as GitHub's own issue { url }: no alias can name another issue", async () => {
  const { check } = checks();
  const work = run("work");
  const create = (selection, extra = "") =>
    call(
      `mutation { createIssue(input: { repositoryId: "R_repo", title: "https://github.com/org/repo/issues/77" }) ${selection} } ${extra}`,
    );
  const counted = [
    ["{ issue { id url } }", ""],
    ["{ issue { url: url } }", ""],
    ["{ ...P }", "fragment P on CreateIssuePayload { issue { url } }"],
    ["{ ... on CreateIssuePayload { issue { ...I } } }", "fragment I on Issue { url }"],
  ];
  for (const [selection, fragments] of counted) {
    const out = await check(work, create(selection, fragments));
    assert.deepEqual(out.creates, ["createIssue"], selection);
  }
  const fakes = [
    "{ issue { url: title } }",
    "{ issue { id html_url: title } }",
    "{ issue { url html_url: title } }",
    "{ issue: clientMutationId }",
    "{ clientMutationId }",
    "{ issue { id } }",
    "{ issue { ...T } }",
  ];
  for (const selection of fakes) {
    const extra = selection.includes("...T") ? "fragment T on Issue { url: title }" : "";
    const out = await check(work, create(selection, extra));
    assert.equal(out.write, true, selection);
    assert.deepEqual(out.creates, [], selection);
  }
});

test("an addComment answer counts only as GitHub's own commentEdge { node { url } }: no alias can name another comment", async () => {
  const { check } = checks();
  const work = run("work");
  const comment = (selection, extra = "") =>
    call(
      `mutation { addComment(input: { subjectId: "I_1", body: "https://github.com/org/repo/issues/1#issuecomment-3000000009" }) ${selection} } ${extra}`,
    );
  const counted = [
    ["{ commentEdge { node { url } } }", ""],
    ["{ commentEdge { node { id url: url } cursor } }", ""],
    [
      "{ ...P }",
      "fragment P on AddCommentPayload { commentEdge { node { ...C } } } fragment C on IssueComment { url }",
    ],
    ["{ commentEdge { node { ... on IssueComment { url } } } }", ""],
  ];
  for (const [selection, extra] of counted) {
    const out = await check(work, comment(selection, extra));
    assert.deepEqual(out.comments, ["addComment"], selection);
  }
  const fakes = [
    "{ commentEdge { node { url: body } } }",
    "{ commentEdge { node { id url: bodyText } } }",
    "{ commentEdge { node: node { id } } }",
    "{ commentEdge { cursor } }",
    "{ clientMutationId }",
    "{ commentEdge { node { ...B } } }",
    "{ subject { ... on Issue { url } } }",
  ];
  for (const selection of fakes) {
    const extra = selection.includes("...B") ? "fragment B on IssueComment { url: body }" : "";
    const out = await check(work, comment(selection, extra));
    assert.equal(out.write, true, selection);
    assert.deepEqual(out.comments, [], selection);
  }
  // Aliased as a whole, under its own key; a createIssue's isn't a comment.
  const aliased = await check(
    work,
    call(
      'mutation { c: addComment(input: { subjectId: "I_1", body: "x" }) { commentEdge { node { url } } } }',
    ),
  );
  assert.deepEqual(aliased.comments, ["c"]);
  const created = await check(
    work,
    call(
      'mutation { createIssue(input: { repositoryId: "R_repo", title: "T" }) { issue { url } } }',
    ),
  );
  assert.deepEqual([created.creates, created.comments], [["createIssue"], []]);
});

test("gh issue comment --edit-last and --delete-last: a comment the run posted, by its node; any other refused before any look-up", async () => {
  const { check, writes, looked } = checks();
  const work = { ...run("work"), created: [{ comment: 3000000001, at: 0 }] };
  const edit = await check(work, call(GH_COMMENT_EDIT, { input: { id: "IC_own", body: "x" } }));
  assert.equal(edit.write, true);
  assert.deepEqual(writes.at(-1), {
    repo: "org/repo",
    actions: ["edit"],
    target: { comment: 3000000001 },
    change: { fields: ["body"], labels_added: [], labels_removed: [] },
  });
  assert.ok(looked.includes("/repos/org/repo/issues/comments/3000000001"));
  const removed = await check(work, call(GH_COMMENT_DELETE, { input: { id: "IC_own" } }));
  assert.equal(removed.write, true);
  assert.deepEqual(writes.at(-1).actions, ["delete"]);
  // The listener's (the last the bot wrote, which --edit-last picks), one without its id:
  // refused, saying what to send instead, nothing looked up.
  const before = looked.length;
  for (const id of ["IC_listener", "IC_1"]) {
    const out = await check(work, call(GH_COMMENT_EDIT, { input: { id, body: "x" } }));
    assert.equal(out.refused?.status, 403, id);
    assert.match(
      out.refused.message,
      /^updateIssueComment: a run can edit only the comments it posted, .*--edit-last.*gh api -X PATCH repos\/org\/repo\/issues\/comments\/<id>/,
    );
  }
  assert.equal(looked.length, before);
  // Another repository's comment of the same id.
  assert.match(
    (await check(work, call(GH_COMMENT_DELETE, { input: { id: "IC_o" } }))).refused.message,
    /id isn't in the run's repository/,
  );
  // An issue isn't a comment.
  assert.match(
    (await check(work, call(GH_COMMENT_EDIT, { input: { id: "I_1", body: "x" } }))).refused.message,
    /updateIssueComment on a Issue/,
  );
});

test(
  "Deckhand's policies over GraphQL: a work run edits and deletes the comments it posted, a brainstorm neither",
  withOpa,
  async (t) => {
    const { check } = checks({ policies: defaultPolicies(t) });
    const created = [{ comment: 3000000001, at: 0 }];
    const edit = call(GH_COMMENT_EDIT, { input: { id: "IC_own", body: "x" } });
    const remove = call(GH_COMMENT_DELETE, { input: { id: "IC_own" } });
    const work = { ...run("work"), created };
    assert.equal((await check(work, edit)).write, true);
    // Deleting: refused unless the operator's policies let it.
    assert.match((await check(work, remove)).refused.message, /doesn't delete its comments/);
    const brainstorm = { ...run("brainstorm"), created };
    assert.match(
      (await check(brainstorm, edit)).refused.message,
      /no rule allows `edit` on `created_comment` for a `brainstorm` run/,
    );
  },
);

test("an unknown mutation, or an input field Deckhand doesn't check, is refused before any look-up", async () => {
  const { check, asked, writes } = checks();
  const work = run("work");
  const refused = [
    [
      'mutation { deleteIssue(input: { issueId: "I_1" }) { clientMutationId } }',
      /send deleteIssue/,
    ],
    // Beside an allowed one, aliased as one.
    [
      'mutation { addComment(input: { subjectId: "I_1", body: "x" }) { clientMutationId } addComment2: transferIssue(input: { issueId: "I_1", repositoryId: "R_other" }) { clientMutationId } }',
      /send transferIssue/,
    ],
    [
      'mutation { addComment: deleteIssue(input: { issueId: "I_1" }) { clientMutationId } }',
      /send deleteIssue/,
    ],
    // Fields that reach past the issue: projects, another parent, an agent.
    [
      'mutation { createIssue(input: { repositoryId: "R_repo", title: "T", projectV2Ids: ["P_1"] }) { clientMutationId } }',
      /createIssue's projectV2Ids/,
    ],
    [
      'mutation { createIssue(input: { repositoryId: "R_repo", title: "T", parentIssueId: "I_1" }) { clientMutationId } }',
      /createIssue's parentIssueId/,
    ],
    // A template: GitHub would add its labels and assignees, unchecked.
    [
      'mutation { createIssue(input: { repositoryId: "R_repo", title: "T", issueTemplate: "Bug report" }) { clientMutationId } }',
      /createIssue's issueTemplate/,
    ],
    // A sub-issue by URL: only its node ID is looked up.
    [
      'mutation { addSubIssue(input: { issueId: "I_1", subIssueUrl: "https://github.com/org/repo/issues/2" }) { clientMutationId } }',
      /addSubIssue.s subIssueUrl/,
    ],
  ];
  for (const [query, message] of refused) {
    const out = await check(work, call(query));
    assert.equal(out.refused?.status, 403, query);
    assert.match(out.refused.message, message, query);
  }
  assert.deepEqual([asked, writes], [[], []]);
  // A field it doesn't check sent as null: GitHub may read it as clearing it, so refused too.
  for (const [query, input, field] of [
    [GH_EDIT, { id: "I_1", issueTypeId: null }, /updateIssue's issueTypeId/],
    [
      "mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { __typename } }",
      { pullRequestId: "PR_7", projectIds: null },
      /updatePullRequest's projectIds/,
    ],
    // Only a create's empty projectIds goes (issue #422): an update's may clear them.
    [GH_EDIT, { id: "I_1", projectIds: [] }, /updateIssue's projectIds/],
  ]) {
    const out = await check(work, call(query, { input }));
    assert.equal(out.refused?.status, 403, JSON.stringify(input));
    assert.match(out.refused.message, field);
  }
  assert.deepEqual([asked, writes], [[], []]);
  // Only __typename: nothing written, nothing looked up.
  assert.equal((await check(work, call("mutation { __typename }"))).write, false);
});

test("targets come from GitHub's nodes: a missing one, a wrong type, another repo's label", async () => {
  const { check } = checks();
  const work = run("work");
  const cases = [
    // Missing, or another repository's: the same refusal, its type unnamed.
    [GH_COMMENT, { input: { subjectId: "I_404", body: "x" } }, 403, /isn't in the run's repo/],
    [GH_COMMENT, { input: { subjectId: "R_other", body: "x" } }, 403, /isn't in the run's repo/],
    [GH_COMMENT, { input: { subjectId: "U_1", body: "x" } }, 403, /isn't in the run's repo/],
    [GH_CREATE, { input: { repositoryId: "I_1", title: "T" } }, 403, /isn't a repository/],
    [GH_EDIT, { input: { id: "PR_7", title: "T" } }, 403, /on a PullRequest/],
    [
      GH_CREATE,
      { input: { repositoryId: "R_repo", title: "T", labelIds: ["L_o"] } },
      403,
      /a label that isn't its repository's/,
    ],
    [
      GH_CREATE,
      { input: { repositoryId: "R_repo", title: "T", labelIds: ["I_1"] } },
      403,
      /a label that isn't its repository's/,
    ],
  ];
  for (const [query, variables, status, message] of cases) {
    const out = await check(work, call(query, variables));
    assert.equal(out.refused?.status, status, JSON.stringify(variables));
    assert.match(out.refused.message, message);
  }
  // Reactions to a commit's comment: refused as REST refuses them.
  const react = await check(
    work,
    call(
      'mutation { addReaction(input: { subjectId: "CC_1", content: HEART }) { clientMutationId } }',
    ),
  );
  assert.equal(react.refused.status, 403);
  assert.match(react.refused.message, /^addReaction: a run can't react here$/);
  // A look-up that fails refuses the call.
  const { check: failing } = createGraphqlChecks({
    nodes: async () => {
      throw new Error("down");
    },
    checkWrite: async () => null,
  });
  const down = await failing(work, call(GH_COMMENT, { input: { subjectId: "I_1", body: "x" } }));
  assert.equal(down.refused.status, 502);
});

test("a sub-issue link: its child resolved from its node, never moved from another parent", async () => {
  const { check, writes } = checks();
  const brainstorm = run("brainstorm");
  const link = (issueId, subIssueId, more = "") =>
    call(
      `mutation { addSubIssue(input: { issueId: "${issueId}", subIssueId: "${subIssueId}"${more} }) { clientMutationId } }`,
    );
  // Its own issue's sub-issue, reordered under it: fine.
  assert.equal((await check(brainstorm, link("I_1", "I_2"))).write, true);
  assert.deepEqual(writes.at(-1).child, {
    id: 102,
    number: 2,
    repo: "org/repo",
    replace_parent: false,
  });
  assert.match(
    (await check(brainstorm, link("I_1", "I_o"))).refused.message,
    /subIssueId isn't in the run's repository/,
  );
  // Someone else's issue as the child, the run's own issue.
  for (const child of ["I_3", "I_1"]) {
    assert.match(
      (await check(brainstorm, link("I_1", child))).refused.message,
      /links only/,
      child,
    );
  }
  for (const value of ["true", "null"]) {
    assert.match(
      (await check(brainstorm, link("I_1", "I_2", `, replaceParent: ${value}`))).refused.message,
      /replace_parent/,
      value,
    );
  }
  // From the variables too; false is no move.
  const linked = (replaceParent) =>
    check(
      brainstorm,
      call(
        "mutation($input: AddSubIssueInput!) { addSubIssue(input: $input) { clientMutationId } }",
        { input: { issueId: "I_1", subIssueId: "I_2", replaceParent } },
      ),
    );
  assert.match((await linked(null)).refused.message, /replace_parent/);
  assert.equal((await linked(false)).write, true);
  assert.match((await check(brainstorm, link("I_1", "PR_7"))).refused.message, /isn't an issue/);
});

test("a blocked-by link: its blocker resolved from its node, an issue of the run's repo", async () => {
  const { check, writes } = checks();
  const work = run("work");
  const link = (name, issueId, blockingIssueId) =>
    call(
      `mutation { ${name}(input: { issueId: "${issueId}", blockingIssueId: "${blockingIssueId}" }) { clientMutationId } }`,
    );
  // Its sub-issue blocked by its own issue's other sub-issue, or by any open issue: added and
  // removed.
  for (const name of ["addBlockedBy", "removeBlockedBy"]) {
    for (const [target, blocker] of [
      ["I_2", "I_3"],
      ["I_1", "I_3"],
      ["I_1", "I_2"],
    ]) {
      assert.equal((await check(work, link(name, target, blocker))).write, true, name);
    }
  }
  assert.deepEqual(writes.at(-1).blocker, { id: 102, number: 2, repo: "org/repo" });
  assert.deepEqual(writes.at(-1).actions, ["link"]);
  // One spelling for the policies: GraphQL's blocker field as REST names it, added or removed.
  const rest = [
    classify("POST", "repos/org/repo/issues/1/dependencies/blocked_by", json({ issue_id: 102 })),
    classify("DELETE", "repos/org/repo/issues/1/dependencies/blocked_by/102", Buffer.alloc(0)),
  ];
  assert.deepEqual(
    writes.slice(-4).map((w) => w.change.fields),
    Array(4).fill(["issue_id"]),
  );
  assert.deepEqual(
    rest.map((w) => w.change.fields),
    [["issue_id"], ["issue_id"]],
  );
  // A closed issue it didn't create, another repository's, a pull request: refused.
  assert.match(
    (await check(work, link("addBlockedBy", "I_2", "I_4"))).refused.message,
    /an open issue of its repository/,
  );
  assert.match(
    (await check(work, link("addBlockedBy", "I_2", "I_o"))).refused.message,
    /blockingIssueId isn't in the run's repository/,
  );
  assert.match(
    (await check(work, link("addBlockedBy", "I_2", "PR_7"))).refused.message,
    /isn't an issue/,
  );
  // Without its blocker: GitHub's schema requires it.
  assert.match(
    (
      await check(
        work,
        call('mutation { addBlockedBy(input: { issueId: "I_2" }) { clientMutationId } }'),
      )
    ).refused.message,
    /blockingIssueId/,
  );
});

test(
  "Deckhand's policies over GraphQL: a blocked-by link on someone else's issue, or an analysis's, refused",
  withOpa,
  async (t) => {
    const { check } = checks({ policies: defaultPolicies(t) });
    const link = (issueId, blockingIssueId) =>
      call(
        `mutation { addBlockedBy(input: { issueId: "${issueId}", blockingIssueId: "${blockingIssueId}" }) { clientMutationId } }`,
      );
    assert.equal((await check(run("work"), link("I_2", "I_3"))).write, true);
    assert.match(
      (await check(run("work"), link("I_3", "I_2"))).refused.message,
      /no rule allows `link` on `other_issue` for a `work` run/,
    );
    assert.match(
      (await check(run("analyze"), link("I_2", "I_3"))).refused.message,
      /no rule allows `link` on `sub_issue` for a `analyze` run/,
    );
  },
);

// gh's own (cli/cli: api/queries_pr.go UpdateProjectV2Items(), what `gh issue create --project`
// sends; `gh project item-add` sends one field the same). `gh issue/pr edit --add-project` sends
// it too, but with an update whose `projectIds: []` is refused (below).
const GH_PROJECT_ADD =
  "mutation UpdateProjectV2Items($input_000: AddProjectV2ItemByIdInput!) { add_000: addProjectV2ItemById(input: $input_000) { item { id } } }";
const addItem = (contentId, projectId = "PV_3") =>
  call(GH_PROJECT_ADD, { input_000: { contentId, projectId } });

test("a project item: its content one of the run's, its project one the grants list", async () => {
  const { check, writes, asked } = checks();
  const work = run("work");
  // Its issue, its pull request, its sub-issue: added, with a token that writes projects.
  for (const id of ["I_1", "PR_7", "I_2"]) {
    const checked = await check(work, addItem(id));
    assert.equal(checked.write, true, id);
    assert.deepEqual(checked.permissions, { organization_projects: "write" });
  }
  assert.deepEqual(asked.at(-1), ["org/repo", ["I_2", "PV_3"]]);
  assert.deepEqual(writes.at(-1).actions, ["project"]);
  assert.deepEqual(writes.at(-1).change.fields, ["project_id"]);
  assert.deepEqual(writes.at(-1).project, { owner: "acme", number: 3, title: "Roadmap" });
  // A project the grants don't list, or none granted at all: refused, whatever the policies.
  assert.match(
    (await check(work, addItem("I_1", "PV_9"))).refused.message,
    /don't let this repository's runs write project acme\/9 \(allow_projects\)/,
  );
  const none = checks({ projects: () => [] });
  assert.match((await none.check(work, addItem("I_1"))).refused.message, /allow_projects/);
  // Not a project (or one the App can't see), or without one.
  assert.match(
    (await check(work, addItem("I_1", "I_2"))).refused.message,
    /projectId isn't a project, or the GitHub App can't see it/,
  );
  const unseen = (await check(work, addItem("I_1", "PV_x"))).refused;
  assert.match(unseen.message, /isn't a project, or the GitHub App can't see it/);
  // What it needs, for the gateway to name a permission the installation lacks.
  assert.deepEqual(unseen.needs, { organization_projects: "write" });
  // Another repository's issue.
  assert.match((await check(work, addItem("I_o"))).refused.message, /contentId isn't in the run's/);
  // Setting an item's field, removing or archiving one: the listener's, never a run's.
  for (const name of [
    "updateProjectV2ItemFieldValue",
    "clearProjectV2ItemFieldValue",
    "deleteProjectV2Item",
    "archiveProjectV2Item",
    "updateProjectV2",
  ]) {
    const field = MUTATIONS[name];
    assert.equal(field, undefined, name);
  }
  const edit = call(
    'mutation { updateProjectV2ItemFieldValue(input: { projectId: "PV_3", itemId: "PVTI_1", fieldId: "F", value: { text: "x" } }) { clientMutationId } }',
  );
  assert.match(
    (await check(work, edit)).refused.message,
    /Deckhand doesn't let a run send updateProjectV2ItemFieldValue/,
  );
  // createIssue's projectIds are classic projects': still only empty.
  const create = call(GH_CREATE, {
    input: { repositoryId: "R_repo", title: "t", projectIds: ["PV_3"] },
  });
  assert.match((await check(work, create)).refused.message, /createIssue's projectIds/);
});

// What `gh issue edit --add-project` and `gh pr edit --add-project` send besides the item
// (cli/cli pkg/cmd/pr/shared/editable_http.go replaceIssueFields()): an update with the
// classic projects' ids, empty. Refused, as any update's projectIds (issue #422): on a GitHub
// Enterprise Server with classic projects, it could clear them. The prompt says so.
const GH_PR_EDIT =
  "mutation PullRequestUpdate($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { __typename } }";

test(
  "Deckhand's policies over GraphQL: a work run's items, a brainstorm's of the issues it filed only, a repo's mode's with its allow",
  withOpa,
  async (t) => {
    const { check } = checks({ policies: defaultPolicies(t) });
    const work = run("work");
    for (const id of ["I_1", "PR_7", "I_2"]) {
      assert.equal((await check(work, addItem(id))).write, true, id);
    }
    assert.match(
      (await check(work, addItem("I_3"))).refused.message,
      /no rule allows `project` on `other_issue` for a `work` run/,
    );
    const brainstorm = { ...run("brainstorm"), created: [{ number: 5, at: 0 }] };
    assert.equal((await check(brainstorm, addItem("I_5"))).write, true);
    assert.match(
      (await check(brainstorm, addItem("I_1"))).refused.message,
      /no rule allows `project` on `own_issue` for a `brainstorm` run/,
    );
    // A repo's own mode: Deckhand's allow and the repo's (no light mode any more: #498).
    const repo = { "ask.rego": 'package deckhand\n\nallow_github if input.mode == "ask"\n' };
    const own = checks({ policies: defaultPolicies(t, { repo }) });
    assert.equal((await own.check(run("ask"), addItem("I_1"))).write, true);
    const none = checks({
      policies: defaultPolicies(t, { repo: { "x.rego": "package deckhand\n" } }),
    });
    assert.match(
      (await none.check(run("ask"), addItem("I_1"))).refused.message,
      /no rule of \.deckhand\/policy\/ allows `project` on `own_issue` for a `ask` run/,
    );
  },
);

test("gh issue/pr edit --add-project: its update's projectIds refused, the item itself goes", async () => {
  const { check } = checks();
  const work = run("work");
  for (const [query, input] of [
    [GH_EDIT, { id: "I_1", projectIds: [] }],
    [GH_PR_EDIT, { pullRequestId: "PR_7", projectIds: [] }],
  ]) {
    assert.match(
      (await check(work, call(query, { input }))).refused.message,
      /Deckhand doesn't let a run set update(?:Issue|PullRequest)'s projectIds/,
    );
  }
  assert.equal((await check(work, addItem("PR_7"))).write, true);
});

test("lookupNodes: GitHub's nodes in order, a missing one null; a failed answer throws", async () => {
  const sent = [];
  const github =
    (answer, status = 200) =>
    async (repo, method, path, body) => (
      sent.push([repo, method, path, body.variables]),
      new Response(JSON.stringify(answer), { status })
    );
  const nodes = await lookupNodes(
    github({
      data: { nodes: [{ __typename: "Issue", number: 1 }, null] },
      errors: [{ type: "NOT_FOUND" }],
    }),
    "org/repo",
    ["I_1", "I_x"],
  );
  assert.deepEqual(nodes, [{ __typename: "Issue", number: 1 }, null]);
  assert.deepEqual(sent[0], ["org/repo", "POST", "/graphql", { ids: ["I_1", "I_x"] }]);
  await assert.rejects(
    lookupNodes(github({ message: "Bad credentials" }, 401), "org/repo", ["I_1"]),
  );
  await assert.rejects(lookupNodes(github({ data: { nodes: [] } }), "org/repo", ["I_1"]));
});

test("a call holds so many mutation fields; one response key is one field, its targets looked up once", async () => {
  const { check, writes, asked, looked } = checks();
  const work = run("work");
  const comment = (key) =>
    `${key}: addComment(input: { subjectId: "I_1", body: "x" }) { clientMutationId }`;
  const many = Array.from({ length: MAX_FIELDS + 1 }, (_, i) => comment(`a${i}`)).join(" ");
  const over = await check(work, call(`mutation { ${many} }`));
  assert.equal(over.refused.status, 400);
  assert.match(over.refused.message, /over 10 mutation fields/);
  assert.deepEqual([writes, asked, looked], [[], [], []]);
  // The same field again and again, unaliased: GitHub runs it once, it is checked once.
  const same = await check(work, call(`mutation { ${comment("c").repeat(50)} }`));
  assert.equal(same.write, true);
  assert.equal(writes.length, 1);
  // Two fields on the same issue: GitHub is asked about it once.
  writes.length = 0;
  looked.length = 0;
  const two = await check(work, call(`mutation { ${comment("a")} ${comment("b")} }`));
  assert.equal(two.write, true);
  assert.equal(writes.length, 2);
  assert.deepEqual(looked, ["/repos/org/repo/issues/1"]);
});

test("the gateway's validator runs in a worker: the listener's thread goes on meanwhile", async (t) => {
  const { check, close } = createValidator();
  t.after(close);
  assert.equal(await check("{ viewer { login } }"), null);
  assert.deepEqual(await check("{ nope }"), {
    status: 400,
    message: `its GraphQL isn't valid on GitHub: Cannot query field "nope" on type "Query". Did you mean "node" or "nodes"?`,
  });
  assert.match((await check("{")).message, /doesn't parse/);
  // The slowest shape under the caps: one field repeated in a selection set.
  const worst = `mutation { addStar(input: { starrableId: "x" }) { starrable { ... on Repository {
    owner { ... on User { ${"login ".repeat(MAX_TOKENS - 40)} } } } } } }`;
  let longest = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  const start = performance.now();
  assert.equal(await check(worst), null);
  clearInterval(tick);
  assert.ok(performance.now() - start < 5000);
  assert.ok(longest < 100, `the thread stalled ${Math.round(longest)} ms`);
});

// A document that takes the worker a while: one field repeated, with arguments, in a mutation
// (a query skips the rule that takes the time).
const SLOW = `mutation { addStar(input: { starrableId: "x" }) { starrable { ... on Repository {
  owner { ${"repositories(first: 1) { totalCount } ".repeat(270)} } } } } }`;

test("a document the worker can't validate in time is refused alone; the others go on", async (t) => {
  const validator = createValidator({ timeoutMs: 150 });
  t.after(validator.close);
  const [slow, quick] = await Promise.all([
    validator.check(SLOW, "a"),
    validator.check("{ viewer { login } }", "b"),
  ]);
  assert.equal(slow.status, 503);
  assert.match(slow.message, /took over/);
  // Validated by the worker started again.
  assert.equal(quick, null);
});

test("a run that floods the validator delays itself only: the runs take turns", async (t) => {
  const validator = createValidator();
  t.after(validator.close);
  const order = [];
  const sent = (query, run, name) =>
    validator.check(query, run).then((answer) => (order.push(name), answer));
  const calls = [sent(SLOW, "a", "a1"), sent(SLOW, "a", "a2"), sent(SLOW, "a", "a3")];
  calls.push(sent("{ viewer { login } }", "b", "b1"));
  assert.deepEqual(await Promise.all(calls), [null, null, null, null]);
  assert.deepEqual(order, ["a1", "b1", "a2", "a3"]);
});

test("a run's parallel calls while the worker starts all go through", async (t) => {
  const validator = createValidator();
  t.after(validator.close);
  const calls = Array.from({ length: 16 }, () => validator.check("{ viewer { login } }", "a"));
  assert.deepEqual(await Promise.all(calls), Array(16).fill(null));
});

test("restName: GraphQL's input names as REST's body names them", () => {
  assert.deepEqual(
    [
      "labelIds",
      "assigneeIds",
      "milestoneId",
      "baseRefName",
      "title",
      "subIssueId",
      "stateReason",
      "blockingIssueId",
      "actorIds",
      "actorLogins",
    ].map(restName),
    [
      "labels",
      "assignees",
      "milestone",
      "base",
      "title",
      "sub_issue_id",
      "state_reason",
      "issue_id",
      "assignees",
      "assignees",
    ],
  );
});

test("an argument graphql-js refuses after validation: the call refused, nothing thrown", async () => {
  const { check, asked } = checks();
  const out = await check(
    run("work"),
    call(
      'mutation($s: ID = "I_1") { addComment(input: { subjectId: $s, body: "x" }) { __typename } }',
      { s: null },
    ),
  );
  assert.equal(out.refused.status, 400);
  assert.match(out.refused.message, /^its GraphQL arguments: .*not to be null/);
  assert.deepEqual(asked, []);
});

test("createLabel: a label of the run's repository, the same write as REST's", async () => {
  const { check, writes } = checks();
  const GH_LABEL =
    "mutation LabelCreate($input: CreateLabelInput!) { createLabel(input: $input) { label { id } } }";
  const input = { repositoryId: "R_repo", name: "ui", color: "fff", description: "UI" };
  // Its fields in the schema's order, as graphql-js reads them.
  const rest = classify(
    "POST",
    "repos/org/repo/labels",
    json({ color: "fff", name: "ui", description: "UI" }),
  );
  const plan = { ...run("plan"), push: true };
  for (const r of [run("work"), plan, run("brainstorm"), run("idea", null), run("bug", null)]) {
    const out = await check(r, call(GH_LABEL, { input }));
    assert.equal(out.refused, undefined, r.mode);
    assert.equal(out.write, true);
    assert.deepEqual(writes.at(-1), rest, r.mode);
  }
  assert.deepEqual(rest.change.labels_added, ["ui"]);
  // Only in the run's repository.
  for (const repositoryId of ["R_other", "I_1", "R_404"]) {
    const out = await check(run("work"), call(GH_LABEL, { input: { ...input, repositoryId } }));
    assert.equal(out.refused?.status, 403, repositoryId);
  }
  // A label's settings aren't a run's: no mutation changes them.
  for (const name of ["updateLabel", "deleteLabel"]) {
    const out = await check(
      run("work"),
      call(`mutation { ${name}(input: { id: "L_idea" }) { clientMutationId } }`),
    );
    assert.match(out.refused.message, new RegExp(`doesn't let a run send ${name}`));
  }
});

test(
  "Deckhand's policies over GraphQL: the modes that create labels; reviews and analyses don't",
  withOpa,
  async (t) => {
    // A repo's own mode that pushes, which its .deckhand/policy/ allows writes.
    const repo = { "plan.rego": 'package deckhand\n\nallow_github if input.mode == "plan"\n' };
    const { check } = checks({ policies: defaultPolicies(t, { repo }) });
    const GH_LABEL =
      "mutation LabelCreate($input: CreateLabelInput!) { createLabel(input: $input) { label { id } } }";
    const label = call(GH_LABEL, { input: { repositoryId: "R_repo", name: "ui", color: "fff" } });
    const plan = { ...run("plan"), push: true };
    for (const r of [run("work"), plan, run("brainstorm"), run("idea", null), run("bug", null)]) {
      const out = await check(r, label);
      assert.equal(out.refused, undefined, `${r.mode}: ${out.refused?.message}`);
    }
    for (const mode of ["review", "analyze", "onboarding", "discussion"]) {
      const out = await check(run(mode), label);
      assert.match(out.refused?.message ?? "", /no rule allows `create` on `label`/, mode);
    }
  },
);

test(
  "a work run labels its sub-issues and the issues it created over GraphQL as over REST, not another's issue",
  withOpa,
  async (t) => {
    const { check, writes } = checks({ policies: defaultPolicies(t) });
    const work = run("work");
    const add =
      'mutation { addLabelsToLabelable(input: { labelableId: "ID", labelIds: ["L_bug"] }) { clientMutationId } }';
    const remove =
      'mutation { removeLabelsFromLabelable(input: { labelableId: "ID", labelIds: ["L_idea"] }) { clientMutationId } }';
    for (const query of [add, remove]) {
      assert.equal((await check(work, call(query.replace("ID", "I_2")))).refused, undefined);
      const other = await check(work, call(query.replace("ID", "I_3")));
      assert.match(
        other.refused.message,
        /no rule allows `label` on `other_issue` for a `work` run/,
      );
    }
    // #5, once GitHub answered the run's create with it.
    const filed = { ...work, created: [{ number: 5, at: Date.parse("2026-01-01T00:00:00Z") }] };
    assert.equal((await check(work, call(add.replace("ID", "I_5")))).refused?.status, 403);
    assert.equal((await check(filed, call(add.replace("ID", "I_5")))).refused, undefined);
    assert.equal((await check(filed, call(remove.replace("ID", "I_5")))).refused, undefined);
    const set = await check(work, call(GH_EDIT, { input: { id: "I_2", labelIds: ["L_bug"] } }));
    assert.equal(set.refused, undefined);
    assert.deepEqual(writes.at(-1).actions, ["label"]);
  },
);

test("the needs-input label of a sub-issue: neither removed nor added over GraphQL", async () => {
  const { check } = checks({ needsInputLabel: () => "needs-input" });
  const work = run("work");
  const refused = [
    'mutation { removeLabelsFromLabelable(input: { labelableId: "I_6", labelIds: ["L_needs"] }) { clientMutationId } }',
    'mutation { updateIssue(input: { id: "I_6", labelIds: ["L_bug"] }) { clientMutationId } }',
    'mutation { addLabelsToLabelable(input: { labelableId: "I_2", labelIds: ["L_needs"] }) { clientMutationId } }',
  ];
  for (const query of refused) {
    const out = await check(work, call(query));
    assert.equal(out.refused?.status, 403, query);
    assert.match(out.refused.message, /doesn't add or remove needs-input on sub_issue #[26]/);
  }
  // Its other labels, the needs-input label kept.
  const kept = await check(
    work,
    call(
      'mutation { updateIssue(input: { id: "I_6", labelIds: ["L_bug", "L_needs"] }) { clientMutationId } }',
    ),
  );
  assert.equal(kept.refused, undefined);
});

test("deny_github over GraphQL: the run's mode, whether it is the repo's own, and its reason", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "gh-x.rego": "package deckhand\n" },
    messages: (input) =>
      input.custom_mode && input.reason === "conflict" ? ["not in a rebase"] : [],
  });
  const { check } = checks({ policies });
  const comment = call(GH_COMMENT, { input: { subjectId: "I_1", body: "x" } });
  assert.equal((await check(run("work", 1, { reason: "review-fix" }), comment)).write, true);
  assert.deepEqual(
    [evals.at(-1).mode, evals.at(-1).custom_mode, evals.at(-1).reason],
    ["work", false, "review-fix"],
  );
  assert.equal((await check(run("brainstorm"), comment)).write, true);
  assert.deepEqual([evals.at(-1).custom_mode, evals.at(-1).reason], [false, null]);
  assert.ok(!("light" in evals.at(-1)));
  // A repo's own mode: the policies know it is one.
  const plan = run("plan", 1, { push: true, reason: "conflict" });
  const refused = await check(plan, comment);
  assert.equal(refused.refused.status, 403);
  assert.match(refused.refused.message, /the policies refuse it: not in a rebase/);
  assert.deepEqual([evals.at(-1).mode, evals.at(-1).custom_mode], ["plan", true]);
});

test("reactions over GraphQL: on the run's issues, pull requests and their comments; removed only when its own", async () => {
  const { check, writes } = checks();
  const work = run("work");
  const add = (subject, content = "THUMBS_UP") =>
    call(
      `mutation { addReaction(input: { subjectId: "${subject}", content: ${content} }) { reaction { content } } }`,
    );
  const remove = (subject, content) =>
    call(
      `mutation { removeReaction(input: { subjectId: "${subject}", content: ${content} }) { reaction { content } } }`,
    );
  for (const [subject, target, reaction] of [
    ["I_1", { number: 1 }, { subject: "issue:1", content: "+1", fresh: true }],
    ["PR_7", { number: 7 }, { subject: "issue:7", content: "+1", fresh: true }],
    [
      "IC_1",
      { reacted: { id: 11, type: "issue" } },
      { subject: "issue_comment:11", content: "+1", fresh: true },
    ],
    [
      "RC_7",
      { reacted: { id: 17, type: "review" } },
      { subject: "review_comment:17", content: "+1", fresh: true },
    ],
  ]) {
    const out = await check(work, add(subject));
    assert.equal(out.refused, undefined, subject);
    const { subject: key, content } = reaction;
    assert.deepEqual(out.reacts, [{ key: "addReaction", subject: key, content }], subject);
    assert.deepEqual(writes.at(-1).target, target, subject);
    assert.deepEqual(writes.at(-1).reaction, reaction, subject);
    assert.deepEqual(writes.at(-1).actions, ["react"]);
  }
  // 👀 the bot has already (the listener's): it goes on, but isn't the run's.
  const eyes = await check(work, add("IC_1", "EYES"));
  assert.equal(eyes.refused, undefined);
  assert.deepEqual(eyes.reacts, []);
  assert.deepEqual((await check(work, add("IC_1", "HEART"))).reacts, [
    { key: "addReaction", subject: "issue_comment:11", content: "heart" },
  ]);
  // Another's issue's comment: its issue's kind, for the policies (Deckhand's refuse it, below).
  assert.equal((await check(work, add("IC_3"))).write, true);
  assert.deepEqual(writes.at(-1).target, { reacted: { id: 13, type: "issue" } });
  // Removing: only a reaction the run added, by its subject and content.
  const listener = await check(work, remove("IC_1", "EYES"));
  assert.equal(listener.refused?.status, 403);
  assert.match(listener.refused.message, /removes only the reactions it added/);
  const own = {
    ...work,
    created: [{ reaction: { subject: "issue_comment:11", content: "heart" }, at: 0 }],
  };
  const removed = await check(own, remove("IC_1", "HEART"));
  assert.equal(removed.refused, undefined);
  assert.deepEqual(writes.at(-1).actions, ["unreact"]);
  assert.deepEqual(removed.unreacts, [
    { key: "removeReaction", subject: "issue_comment:11", content: "heart" },
  ]);
  assert.deepEqual(removed.reacts, []);
  assert.equal((await check(own, remove("IC_1", "EYES"))).refused?.status, 403);
  assert.equal((await check(own, remove("I_1", "HEART"))).refused?.status, 403);
});

test(
  "Deckhand's policies over GraphQL: a work run reacts on its own issues and pull requests, a brainstorm on its issue and its comments only",
  withOpa,
  async (t) => {
    const { check } = checks({ policies: defaultPolicies(t) });
    const add = (subject) =>
      call(
        `mutation { addReaction(input: { subjectId: "${subject}", content: THUMBS_UP }) { reaction { content } } }`,
      );
    const work = run("work");
    for (const subject of ["I_1", "PR_7", "IC_1", "RC_7"]) {
      assert.equal((await check(work, add(subject))).refused, undefined, subject);
    }
    assert.match(
      (await check(work, add("IC_3"))).refused.message,
      /no rule allows `react` on `other_issue` for a `work` run/,
    );
    const brainstorm = run("brainstorm");
    assert.equal((await check(brainstorm, add("I_1"))).refused, undefined);
    assert.equal((await check(brainstorm, add("IC_1"))).refused, undefined);
    for (const subject of ["PR_7", "RC_7"]) {
      assert.match(
        (await check(brainstorm, add(subject))).refused.message,
        /no rule allows `react` on `pr` for a `brainstorm` run/,
        subject,
      );
    }
  },
);

test("reactions over GraphQL: those GitHub ran are the run's, kept with its issues", () => {
  const { answered } = createWriteChecks({
    needsInputLabel: () => null,
    lookup,
    bot: () => "deckhand[bot]",
  });
  const work = run("work");
  const reacts = [
    { key: "a", subject: "issue:1", content: "+1" },
    { key: "b", subject: "issue_comment:11", content: "heart" },
  ];
  const sent = { method: "POST", path: "/graphql", graphql: true, reacts, at: 5 };
  // GitHub ran `a` only: `b` answers null, with an error beside.
  answered(work, sent, 200, json({ data: { a: { reaction: {} }, b: null }, errors: [{}] }));
  assert.deepEqual(work.created, [{ reaction: { subject: "issue:1", content: "+1" }, at: 5 }]);
  // Again: kept once.
  answered(work, sent, 200, json({ data: { a: { reaction: {} } } }));
  assert.equal(work.created.length, 1);
  answered(work, sent, 502, json({ data: { b: {} } }));
  assert.equal(work.created.length, 1);
  // Removed: no longer its own, but where GitHub didn't run it.
  const unreacts = [
    { key: "c", subject: "issue:1", content: "+1" },
    { key: "d", subject: "issue:1", content: "heart" },
  ];
  work.created.push({ reaction: { subject: "issue:1", content: "heart" }, at: 6 });
  const removing = { method: "POST", path: "/graphql", graphql: true, unreacts, at: 7 };
  answered(work, removing, 200, json({ data: { c: { reaction: {} }, d: null } }));
  assert.deepEqual(work.created, [{ reaction: { subject: "issue:1", content: "heart" }, at: 6 }]);
});

const GH_REPLY =
  "mutation Reply($input: AddPullRequestReviewThreadReplyInput!) { addPullRequestReviewThreadReply(input: $input) { comment { url } } }";
const GH_RESOLVE =
  "mutation Resolve($input: ResolveReviewThreadInput!) { resolveReviewThread(input: $input) { thread { isResolved } } }";
const GH_UNRESOLVE =
  "mutation Unresolve($input: UnresolveReviewThreadInput!) { unresolveReviewThread(input: $input) { thread { isResolved } } }";

test("review threads: a work run replies to and resolves its pull request's, by their first comment, with the token pull requests' writes get", async () => {
  const { check, writes, looked } = checks();
  const reply = await check(
    run("work"),
    call(GH_REPLY, { input: { pullRequestReviewThreadId: "PRRT_h", body: "Fixed in abc123." } }),
  );
  assert.equal(reply.refused, undefined, reply.refused?.message);
  assert.equal(reply.write, true);
  assert.deepEqual(reply.permissions, { pull_requests: "write" });
  // Nothing for the dashboard: the pull request itself didn't change.
  assert.deepEqual(reply.pulls, []);
  assert.deepEqual(writes[0], {
    repo: "org/repo",
    actions: ["reply"],
    target: { number: 7 },
    change: { fields: ["body"], labels_added: [], labels_removed: [] },
    thread: { comment: 41 },
    permissions: { pull_requests: "write" },
  });
  assert.ok(looked.includes("/repos/org/repo/pulls/comments/41"));
  for (const [query, input, actions] of [
    [GH_RESOLVE, { threadId: "PRRT_d" }, ["resolve"]],
    [GH_RESOLVE, { threadId: "PRRT_d", resolutionReason: "ADDRESSED" }, ["resolve"]],
    [GH_UNRESOLVE, { threadId: "PRRT_d" }, ["unresolve"]],
  ]) {
    const out = await check(run("work"), call(query, { input }));
    assert.equal(out.refused, undefined, out.refused?.message);
    assert.deepEqual(out.permissions, { pull_requests: "write" });
    assert.deepEqual(writes.at(-1).actions, actions);
    assert.deepEqual(writes.at(-1).thread, { comment: 40 });
  }
  const refused = [
    // Into a pending review: a run sends no review.
    [
      run("work"),
      call(GH_REPLY, {
        input: { pullRequestReviewThreadId: "PRRT_d", body: "x", pullRequestReviewId: "PRR_1" },
      }),
      /doesn't let a run set addPullRequestReviewThreadReply's pullRequestReviewId/,
    ],
    [
      run("work"),
      call(GH_RESOLVE, { input: { threadId: "PRRT_o" } }),
      /threadId isn't in the run's repository/,
    ],
    [
      run("work"),
      call(GH_RESOLVE, { input: { threadId: "PRRT_e" } }),
      /has no pull request or comment/,
    ],
    // A thread is not a pull request, nor a pull request a thread.
    [run("work"), call(GH_RESOLVE, { input: { threadId: "PR_7" } }), /on a PullRequest isn't/],
    // A new review, or a review comment outside a thread: unknown mutations.
    [
      run("work"),
      call(
        'mutation { addPullRequestReview(input: { pullRequestId: "PR_7", event: COMMENT, body: "x" }) { clientMutationId } }',
      ),
      /doesn't let a run send addPullRequestReview/,
    ],
    [
      run("work"),
      call(
        'mutation { addPullRequestReviewThread(input: { pullRequestId: "PR_7", path: "a", line: 1, body: "x" }) { clientMutationId } }',
      ),
      /doesn't let a run send addPullRequestReviewThread$/,
    ],
  ];
  for (const [r, body, why] of refused) {
    const out = await check(r, body);
    assert.ok(out.refused, body.toString());
    assert.match(out.refused.message, why);
  }
});

test(
  "Deckhand's policies over GraphQL: a work run replies to its pull request's threads and resolves Deckhand's; a brainstorm or a review neither",
  withOpa,
  async (t) => {
    const { check } = checks({ policies: defaultPolicies(t) });
    const reply = (r, id) =>
      check(r, call(GH_REPLY, { input: { pullRequestReviewThreadId: id, body: "x" } }));
    const resolve = (r, id) => check(r, call(GH_RESOLVE, { input: { threadId: id } }));
    const work = run("work");
    assert.equal((await reply(work, "PRRT_h")).refused, undefined);
    assert.equal((await resolve(work, "PRRT_d")).refused, undefined);
    // A person's thread stays open for them to resolve.
    assert.match((await resolve(work, "PRRT_h")).refused.message, /not @alice's: reply instead/);
    assert.match(
      (await reply(run("brainstorm"), "PRRT_d")).refused.message,
      /no rule allows `reply` on `pr` for a `brainstorm` run/,
    );
    assert.match(
      (await resolve(run("review"), "PRRT_d")).refused.message,
      /no rule allows `resolve` on `pr` for a `review` run/,
    );
  },
);

// gh pr checks' query (cli/cli api/query_builder.go RequiredStatusCheckRollupGraphQL), on its
// pull request's node.
const GH_CHECKS = `query PullRequestStatusChecks($id: ID!) { node(id: $id) { ...on PullRequest {
  statusCheckRollup: commits(last: 1) { nodes { commit { statusCheckRollup {
    contexts(first: 100) { nodes { __typename
      ...on StatusContext { context, state, targetUrl, createdAt, description, isRequired(pullRequestId: $id) }
      ...on CheckRun { name, checkSuite { workflowRun { event, workflow { name } } }, status, conclusion,
        startedAt, completedAt, detailsUrl, isRequired(pullRequestId: $id) } }
    pageInfo { hasNextPage, endCursor } } } } } } } } }`;

// gh pr view's rollup field, as gh builds it for its default fields.
const GH_VIEW_ROLLUP = `statusCheckRollup: commits(last: 1) { nodes { commit { statusCheckRollup {
  contexts(first: 100) { nodes { __typename
    ...on StatusContext { context, state, targetUrl, createdAt, description },
    ...on CheckRun { name, checkSuite { workflowRun { workflow { name } } }, status, conclusion,
      startedAt, completedAt, detailsUrl } },
  pageInfo { hasNextPage, endCursor } } } } } }`;

test("checkReads: what a call reads of CI beyond Actions, by its types, through fragments and nodes", async () => {
  const reads = (query) => {
    const doc = parse(query);
    const op = doc.definitions.find((d) => d.kind === "OperationDefinition");
    return checkReads(githubSchema(), doc, op);
  };
  const both = { checks: "read", statuses: "read" };
  assert.deepEqual(reads(GH_CHECKS), both);
  // gh pr view's default fields select the rollup too, as this field (cli/cli
  // api/query_builder.go StatusCheckRollupGraphQLWithoutCountByState).
  assert.deepEqual(
    reads(`{ repository(owner: "o", name: "r") { pullRequest(number: 1) { title
      ${GH_VIEW_ROLLUP} } } }`),
    both,
  );
  assert.deepEqual(
    reads(`{ repository(owner: "o", name: "r") { object(expression: "main") {
      ... on Commit { status { state } } } } }`),
    { statuses: "read" },
  );
  assert.deepEqual(
    reads(`query { repository(owner: "o", name: "r") { object(expression: "main") { ...C } } }
      fragment C on Commit { checkSuites(first: 5) { totalCount } }`),
    { checks: "read" },
  );
  // A node by its ID, or a fragment on one of their types, whatever it selects.
  assert.deepEqual(reads(`{ node(id: "CR_1") { ... on CheckRun { id } } }`), { checks: "read" });
  assert.deepEqual(reads(`{ node(id: "SC_1") { ...S } } fragment S on StatusContext { id }`), {
    statuses: "read",
  });
  assert.deepEqual(reads(`{ nodes(ids: ["x"]) { __typename ... on CheckSuite { id } } }`), {
    checks: "read",
  });
  // Nothing of theirs: nothing. A pull request, its commits, Actions' workflow runs.
  assert.deepEqual(
    reads(`{ repository(owner: "o", name: "r") { pullRequest(number: 1) { title
      commits(last: 1) { nodes { commit { oid message } } } } } }`),
    {},
  );
  assert.deepEqual(reads(`{ viewer { login } }`), {});
  // A mutation's answer counts too.
  assert.deepEqual(
    reads(`mutation { updatePullRequest(input: { pullRequestId: "PR_1", title: "t" }) {
      pullRequest { commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }`),
    both,
  );
  // The checks say so, for a query and a mutation alike; a plain one reads nothing.
  const { check } = checks();
  assert.deepEqual((await check(run("work"), call(GH_CHECKS, { id: "PR_1" }))).reads, both);
  assert.deepEqual((await check(run("work"), call("{ viewer { login } }"))).reads, {});
});

test("checkSelections: where the check and status fields are in the answer, aliases as such", async () => {
  const paths = (query) => {
    const doc = parse(query);
    const op = doc.definitions.find((d) => d.kind === "OperationDefinition");
    return checkSelections(githubSchema(), doc, op).paths;
  };
  // gh pr checks': its alias, under the node; nothing deeper (the rollup covers its subtree).
  assert.deepEqual(paths(GH_CHECKS), [
    ["node", "statusCheckRollup", "nodes", "commit", "statusCheckRollup"],
  ]);
  // gh pr view's: the rollup, and none of the other fields it selects.
  assert.deepEqual(
    paths(`{ repository(owner: "o", name: "r") { pullRequest(number: 1) { title
      projectItems(first: 5) { totalCount } ${GH_VIEW_ROLLUP} } } }`),
    [["repository", "pullRequest", "statusCheckRollup", "nodes", "commit", "statusCheckRollup"]],
  );
  // A fragment on a check type: the field it is spread under. A named fragment spread in two
  // places: under each.
  assert.deepEqual(paths(`{ node(id: "CR_1") { ... on CheckRun { id } } }`), [["node"]]);
  assert.deepEqual(
    paths(`{ a: repository(owner: "o", name: "r") { object(expression: "x") { ...C } }
      b: repository(owner: "o", name: "s") { object(expression: "y") { ...C } } }
      fragment C on Commit { status { state } checkSuites(first: 1) { totalCount } }`),
    [
      ["a", "object", "status"],
      ["a", "object", "checkSuites"],
      ["b", "object", "status"],
      ["b", "object", "checkSuites"],
    ],
  );
  assert.deepEqual(paths(`{ viewer { login } }`), []);
  // An interface or a union a check run or a status context is one of: what the value may be
  // there decides (a node, a resource by URL), not the type's name.
  const selections = (query) => {
    const doc = parse(query);
    const op = doc.definitions.find((d) => d.kind === "OperationDefinition");
    return checkSelections(githubSchema(), doc, op);
  };
  const both = { checks: "read", statuses: "read" };
  assert.deepEqual(
    selections(`{ node(id: "CR_1") { ... on UniformResourceLocatable { url resourcePath }
      ... on RequirableByPullRequest { isRequired(pullRequestNumber: 1) } } }`),
    { reads: both, paths: [["node"], ["node"]] },
  );
  assert.deepEqual(
    selections(`{ n: node(id: "x") { ...U } } fragment U on UniformResourceLocatable { url }`),
    { reads: { checks: "read" }, paths: [["n"]] },
  );
  assert.deepEqual(selections(`{ resource(url: "https://github.com/o/r/runs/1") { url } }`), {
    reads: { checks: "read" },
    paths: [["resource"]],
  });
  // Its fields behind an untyped inline fragment, a directive's, or a named fragment on the
  // same type: still selected on that value.
  for (const [query, path] of [
    [`{ resource(url: "https://github.com/o/r/runs/1") { ... { url resourcePath } } }`, "resource"],
    [
      `{ node(id: "CR_1") { ... on UniformResourceLocatable { ... @include(if: true) { url } } } }`,
      "node",
    ],
    [
      `{ node(id: "CR_1") { ...F } } fragment F on UniformResourceLocatable { ... { url } }`,
      "node",
    ],
    [
      `{ node(id: "CR_1") { ... on UniformResourceLocatable { ...G } } }
      fragment G on UniformResourceLocatable { url }`,
      "node",
    ],
  ]) {
    assert.deepEqual(selections(query), { reads: { checks: "read" }, paths: [[path]] }, query);
  }
  // What can't be a check there, or says nothing of one: no read.
  for (const query of [
    `{ node(id: "x") { ... on UniformResourceLocatable { ...P } } } fragment P on PullRequest { title }`,
    `{ resource(url: "u") { ... { __typename id } } }`,
    `{ resource(url: "https://github.com/o/r/pull/1") { __typename ... on PullRequest { title } } }`,
    `{ repository(owner: "o", name: "r") { ... on Node { id } ... on UniformResourceLocatable { url } } }`,
    `{ node(id: "x") { id __typename ... on Node { id } } }`,
    `{ viewer { ... on Actor { login } } }`,
  ]) {
    assert.deepEqual(selections(query), { reads: {}, paths: [] }, query);
  }
  // Fragments doubling at each level: past the cap, no paths (GitHub's messages kept), quickly.
  const levels = 12;
  let query = '{ repository(owner: "o", name: "r") { object(expression: "x") { ...F0 } } }';
  for (let i = 0; i < levels; i++) {
    query += ` fragment F${i} on Commit { a${i}: parents(first: 1) { nodes { ...F${i + 1} } } b${i}: parents(first: 1) { nodes { ...F${i + 1} } } }`;
  }
  query += ` fragment F${levels} on Commit { status { state } }`;
  assert.ok(2 ** levels > MAX_CHECK_PATHS);
  const started = Date.now();
  const many = checkSelections(githubSchema(), parse(query), parse(query).definitions[0]);
  assert.deepEqual([many.reads, many.paths], [{ statuses: "read" }, null]);
  assert.ok(Date.now() - started < 1000);
  // The checks pass them on with the reads.
  const { check } = checks();
  const out = await check(run("work"), call(GH_CHECKS, { id: "PR_1" }));
  assert.deepEqual(out.readPaths, paths(GH_CHECKS));
});

test("MAX_REFUSED_LOOKUPS: a refused GraphQL call's node look-up counts, and past it none is made", async () => {
  const looked = [];
  // The policies refuse comments on #3, as Deckhand's refuse a work run's on another issue.
  const writes = createWriteChecks({
    needsInputLabel: () => null,
    lookup: (repo, path) => (looked.push(path), lookup(repo, path)),
    bot: () => "deckhand[bot]",
    policies: {
      deny: async (r, repo, ref, input) =>
        input().target.number === 3 ? ["no rule allows it"] : [],
    },
  });
  const asked = [];
  const { check } = createGraphqlChecks({
    nodes: async (repo, ids) => (asked.push(ids), ids.map((id) => NODES[id] ?? null)),
    checkWrite: writes.checkWrite,
    budget: writes.budget,
  });
  const work = run("work");
  const comment = (id) => call(GH_COMMENT, { input: { subjectId: id, body: "x" } });
  // Each refused call: its nodes, the issue and its parent.
  let refused = 0;
  while ((await check(work, comment("I_3"))).refused?.status === 403) refused++;
  // 33 refused calls cost 99; the next one's nodes the 100th, its field refused for it.
  assert.equal(refused, Math.floor(MAX_REFUSED_LOOKUPS / 3));
  const [nodes, rest] = [asked.length, looked.length];
  const spent = await check(work, comment("I_3"));
  assert.equal(spent.refused.status, 429);
  assert.match(spent.refused.message, /refused writes cost 100 look-ups/);
  // Neither the nodes nor the targets looked up again, not even for its own issue.
  assert.equal((await check(work, comment("I_1"))).refused.status, 429);
  assert.deepEqual([asked.length, looked.length], [nodes, rest]);
});

test("MAX_REFUSED_LOOKUPS: a GraphQL call that goes on, or whose nodes GitHub fails, costs nothing", async () => {
  const writes = createWriteChecks({
    needsInputLabel: () => null,
    lookup,
    bot: () => "deckhand[bot]",
    policies: allowingPolicies,
  });
  let down = false;
  const { check } = createGraphqlChecks({
    nodes: async (repo, ids) => {
      if (down) throw new Error("GitHub is down");
      return ids.map((id) => NODES[id] ?? null);
    },
    checkWrite: writes.checkWrite,
    budget: writes.budget,
  });
  const work = run("work");
  const comment = call(GH_COMMENT, { input: { subjectId: "I_1", body: "x" } });
  for (let i = 0; i < MAX_REFUSED_LOOKUPS; i++)
    assert.equal((await check(work, comment)).refused, undefined);
  down = true;
  for (let i = 0; i < MAX_REFUSED_LOOKUPS; i++)
    assert.equal((await check(work, comment)).refused.status, 502);
  down = false;
  assert.equal((await check(work, comment)).refused, undefined);
});

test("issueReads: a run without read:issues reads its own issue only, whatever the way", () => {
  const run = { repo: "org/repo", issue: 7, caps: ["pull", "read:pulls"] };
  const reads = (query, variables = {}) => {
    const call = parseCall(Buffer.from(JSON.stringify({ query, variables })));
    assert.equal(call.refused, undefined, query);
    return issueReads(githubSchema(), call.doc, call.op, call.coerced?.coerced ?? {}, run);
  };
  const own = { own: true, other: null };
  const none = { own: false, other: null };
  // Its own issue: by number, inline or in a variable, under an alias, through fragments.
  assert.deepEqual(
    reads('{ repository(owner: "org", name: "repo") { issue(number: 7) { title } } }'),
    own,
  );
  assert.deepEqual(
    reads(
      `query($o: String!, $n: Int!) { r: repository(owner: $o, name: "Repo") {
        i: issueOrPullRequest(number: $n) { ... on Issue { ...I } ... on PullRequest { title } } } }
      fragment I on Issue { title body labels(first: 5) { nodes { name } }
        comments(first: 10) { nodes { body author { login } } } }`,
      { o: "Org", n: 7 },
    ),
    own,
  );
  // Nothing of issues: a pull request, the repository, the viewer, `__typename` of a node.
  assert.deepEqual(
    reads('{ repository(owner: "org", name: "repo") { pullRequest(number: 7) { title } } }'),
    none,
  );
  assert.deepEqual(reads("{ viewer { login } }"), none);
  assert.deepEqual(reads('{ node(id: "x") { __typename } }'), none);
  assert.deepEqual(reads('{ node(id: "x") { ... on PullRequest { title } } }'), none);
  assert.deepEqual(
    reads('{ search(query: "deckhand", type: REPOSITORY, first: 1) { repositoryCount } }'),
    none,
  );
  // Any other issue: another number, another repository, a list, a count, a search, a node, a
  // fragment on an interface Issue implements, and what its own issue links to.
  for (const [query, field] of [
    ['{ repository(owner: "org", name: "repo") { issue(number: 8) { title } } }', "issue"],
    ['{ repository(owner: "other", name: "repo") { issue(number: 7) { title } } }', "issue"],
    [
      '{ repository(owner: "org", name: "repo") { issues(first: 5) { nodes { title } } } }',
      "issues",
    ],
    ['{ repository(owner: "org", name: "repo") { issues { totalCount } } }', "issues"],
    ['{ search(query: "x", type: ISSUE, first: 5) { issueCount } }', "search"],
    ['{ node(id: "I_1") { ... on Issue { title } } }', "node"],
    ['{ nodes(ids: ["I_1"]) { ... on Closable { closed } } }', "nodes"],
    ['{ node(id: "I_1") { id } }', "node"],
    [
      '{ repository(owner: "org", name: "repo") { issue(number: 7) { parent { title } } } }',
      "parent",
    ],
    [
      '{ repository(owner: "org", name: "repo") { issue(number: 7) { comments(first: 1) { nodes { issue { title } } } } } }',
      "issue",
    ],
    [
      '{ repository(owner: "org", name: "repo") { pullRequest(number: 7) { closingIssuesReferences(first: 5) { nodes { title } } } } }',
      "closingIssuesReferences",
    ],
    [
      '{ repository(owner: "org", name: "repo") { issue(number: 7) { title } other: issue(number: 8) { title } } }',
      "issue",
    ],
  ]) {
    const found = reads(query);
    assert.equal(found.other, field, query);
  }
  // A run whose issue is unknown reads none.
  const unknown = { ...run, issue: null };
  const call = parseCall(
    Buffer.from(
      JSON.stringify({
        query: '{ repository(owner: "org", name: "repo") { issue(number: 7) { title } } }',
      }),
    ),
  );
  assert.equal(issueReads(githubSchema(), call.doc, call.op, {}, unknown).other, "issue");
});

test("a run without read:issues: the GraphQL checks refuse another issue, say its own is read", async () => {
  const checks = createGraphqlChecks({ nodes: async () => [], checkWrite: async () => null });
  const run = { repo: "org/repo", issue: 7, caps: ["pull"] };
  const own = await checks.check(
    run,
    Buffer.from(
      JSON.stringify({
        query: '{ repository(owner: "org", name: "repo") { issue(number: 7) { title } } }',
      }),
    ),
  );
  assert.equal(own.ownIssue, true);
  const other = await checks.check(
    run,
    Buffer.from(
      JSON.stringify({
        query: '{ repository(owner: "org", name: "repo") { issues(first: 1) { totalCount } } }',
      }),
    ),
  );
  assert.equal(other.refused.status, 403);
  assert.equal(
    other.refused.message,
    "issues: this run's capabilities don't give `read:issues`, so it reads its own issue only, as repository(owner:, name:) { issue(number: 7) }",
  );
  // With read:issues, nothing to check: every issue is its token's.
  const all = await checks.check(
    { ...run, caps: ["pull", "read:issues"] },
    Buffer.from(
      JSON.stringify({
        query: '{ repository(owner: "org", name: "repo") { issues(first: 1) { totalCount } } }',
      }),
    ),
  );
  assert.equal(all.refused, undefined);
  assert.equal(all.ownIssue, false);
});

test("issueReads: other issues' comments, refused once the token reads issues; a pull request's go", () => {
  const run = { repo: "org/repo", issue: 7, caps: ["pull", "read:pulls"] };
  const reads = (query) => {
    const call = parseCall(Buffer.from(JSON.stringify({ query })));
    assert.equal(call.refused, undefined, query);
    return issueReads(githubSchema(), call.doc, call.op, {}, run);
  };
  const own = '{ repository(owner: "org", name: "repo") { issue(number: 7) { title } } }';
  for (const [query, field] of [
    [
      `{ repository(owner: "org", name: "repo") { issue(number: 7) { title } }
        user(login: "maintainer") { issueComments(last: 100) { nodes { body url } } } }`,
      "issueComments",
    ],
    [
      `{ repository(owner: "org", name: "repo") { issue(number: 7) {
        author { ... on User { issueComments(last: 100) { nodes { body } } } } } } }`,
      "issueComments",
    ],
    [
      `{ repository(owner: "org", name: "repo") { issue(number: 7) { title }
        pullRequest(number: 9) { comments(first: 5) { nodes { body } } } } }`,
      "comments",
    ],
  ]) {
    assert.equal(reads(query).other, field, query);
  }
  // Its own issue's comments, and a pull request's without its own issue: GitHub decides.
  assert.deepEqual(reads(own), { own: true, other: null });
  assert.deepEqual(
    reads(
      '{ repository(owner: "org", name: "repo") { pullRequest(number: 9) { comments(first: 5) { nodes { body } } } } }',
    ),
    { own: false, other: null },
  );
});

test("issueReads: a mutation's answer names what it wrote to, nothing else of issues", () => {
  const run = { repo: "org/repo", issue: 7, caps: ["pull"] };
  const reads = (query) => {
    const call = parseCall(Buffer.from(JSON.stringify({ query })));
    assert.equal(call.refused, undefined, query);
    return issueReads(githubSchema(), call.doc, call.op, {}, run).other;
  };
  // gh's: what each wrote.
  for (const query of [
    'mutation { addComment(input: {subjectId: "I_7", body: "x"}) { commentEdge { node { url } } } }',
    'mutation { createIssue(input: {repositoryId: "R_1", title: "t"}) { issue { id url } } }',
    'mutation { addReaction(input: {subjectId: "I_7", content: THUMBS_UP}) { reaction { content } subject { id } } }',
    'mutation { updateIssueComment(input: {id: "IC_1", body: "x"}) { issueComment { body } } }',
  ]) {
    assert.equal(reads(query), null, query);
  }
  for (const [query, field] of [
    [
      `mutation { addReaction(input: {subjectId: "I_7", content: THUMBS_UP}) { subject {
        ... on Issue { repository { issues(first: 100) { nodes { title body } } } } } } }`,
      "repository",
    ],
    // The issue it wrote to may be a sub-issue it can't read: named, never read.
    [
      `mutation { addReaction(input: {subjectId: "I_8", content: THUMBS_UP}) { subject {
        ... on Issue { title body comments(first: 100) { nodes { body } } } } } }`,
      "title",
    ],
    ['mutation { updateIssue(input: {id: "I_8", body: "x"}) { issue { body } } }', "body"],
    [
      `mutation { addComment(input: {subjectId: "I_7", body: "x"}) { subject { ... on Issue {
        parent { title } } } } }`,
      "parent",
    ],
    [
      `mutation { addComment(input: {subjectId: "I_7", body: "x"}) { commentEdge { node {
        author { ... on User { issueComments(last: 5) { nodes { body } } } } } } } }`,
      "issueComments",
    ],
  ]) {
    assert.equal(reads(query), field, query);
  }
});

test("a run without read:issues: the GraphQL checks refuse a mutation whose answer reads other issues", async () => {
  const checks = createGraphqlChecks({
    nodes: async () => [
      { __typename: "Issue", number: 7, repository: { nameWithOwner: "org/repo" } },
    ],
    checkWrite: async () => null,
  });
  const run = { repo: "org/repo", issue: 7, caps: ["pull"] };
  const call = (query) => checks.check(run, Buffer.from(JSON.stringify({ query })));
  const leaky = await call(
    `mutation { addReaction(input: {subjectId: "I_7", content: THUMBS_UP}) { subject {
      ... on Issue { repository { issues(first: 100) { nodes { title } } } } } } }`,
  );
  assert.equal(leaky.refused.status, 403);
  assert.match(
    leaky.refused.message,
    /^repository: this run's capabilities don't give `read:issues`, so a mutation's answer may only name/,
  );
  const plain = await call(
    'mutation { addReaction(input: {subjectId: "I_7", content: THUMBS_UP}) { reaction { content } } }',
  );
  assert.equal(plain.refused, undefined);
  assert.equal(plain.write, true);
});

test("issueReads: project items, refused once the token reads issues but its own issue's and an added item's id", () => {
  const run = { repo: "org/repo", issue: 7, caps: ["pull", "read:pulls"] };
  const reads = (query) => {
    const call = parseCall(Buffer.from(JSON.stringify({ query })));
    assert.equal(call.refused, undefined, query);
    return issueReads(githubSchema(), call.doc, call.op, {}, run).other;
  };
  const titles = `items(first: 100) { nodes { fieldValueByName(name: "Title") {
    ... on ProjectV2ItemFieldTextValue { text } } } }`;
  for (const [query, field] of [
    [
      `{ repository(owner: "org", name: "repo") { issue(number: 7) { title }
        projectsV2(first: 5) { nodes { ${titles} } } } }`,
      "items",
    ],
    [
      `{ repository(owner: "org", name: "repo") { issue(number: 7) {
        projectItems(first: 5) { nodes { project { ${titles} } } } } } }`,
      "items",
    ],
    [
      `mutation { addComment(input: {subjectId: "I_7", body: "x"}) { commentEdge { node {
        repository { projectsV2(first: 5) { nodes { ${titles} } } } } } } }`,
      "items",
    ],
    [
      'mutation { addProjectV2ItemById(input: {projectId: "P_1", contentId: "I_7"}) { item { content { ... on Issue { title } } } } }',
      "content",
    ],
  ]) {
    assert.equal(reads(query), field, query);
  }
  // gh issue view's project items, and gh project item-add's answer: through.
  assert.equal(
    reads(`{ repository(owner: "org", name: "repo") { issue(number: 7) { title
      projectItems(first: 100) { nodes { id project { id title }
        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue {
          optionId name } } } } } } }`),
    null,
  );
  assert.equal(
    reads(
      'mutation { addProjectV2ItemById(input: {projectId: "P_1", contentId: "I_7"}) { item { id } } }',
    ),
    null,
  );
  // Without its own issue in the query, the token reads no issue: GitHub decides.
  assert.equal(
    reads(
      `{ repository(owner: "org", name: "repo") { projectsV2(first: 5) { nodes { ${titles} } } } }`,
    ),
    null,
  );
});
