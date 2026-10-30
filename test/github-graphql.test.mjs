// A run's GraphQL (github-graphql.mjs): parsed and validated against GitHub's pinned schema,
// queries passed on, each mutation field classified from the nodes GitHub resolves its IDs to,
// then held to the same checks as REST writes (github-writes.mjs), and printed again.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGraphqlChecks,
  createValidator,
  githubSchema,
  lookupNodes,
  MAX_FIELDS,
  MAX_QUERY,
  MAX_TOKENS,
  MUTATIONS,
  parseCall,
  restName,
} from "../listener/github-graphql.mjs";
import { classify, createWriteChecks } from "../listener/github-writes.mjs";
import { policyEngine } from "./helpers.mjs";

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
  IC_1: { __typename: "IssueComment", repository: { nameWithOwner: "Org/Repo" } },
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
  L_idea: { __typename: "Label", name: "idea", repository: { nameWithOwner: "Org/Repo" } },
  L_bug: { __typename: "Label", name: "bug", repository: { nameWithOwner: "Org/Repo" } },
  L_needs: { __typename: "Label", name: "needs-input", repository: { nameWithOwner: "Org/Repo" } },
  L_o: { __typename: "Label", name: "idea", repository: { nameWithOwner: "org/other" } },
  U_1: { __typename: "User" },
};

// GitHub's REST answers the write checks look up (github-writes.mjs resolve()): #1 the run's,
// #2 a sub-issue of it, #3 someone else's, #4 someone else's closed, #5 the bot's (one a run
// created, when its `created` says so), #6 a sub-issue waiting for answers, #7 a pull request.
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
  7: { number: 7, pull_request: {}, user: { login: "deckhand[bot]" }, labels: [] },
};
// The comments, by their id: both the bot's.
const COMMENTS = {
  3000000001: {
    user: { login: "deckhand[bot]" },
    issue_url: "https://api.github.com/repos/Org/Repo/issues/1",
  },
  3000000009: {
    user: { login: "deckhand[bot]" },
    issue_url: "https://api.github.com/repos/Org/Repo/issues/1",
  },
};
async function lookup(repo, path) {
  const comment = /^\/repos\/org\/repo\/issues\/comments\/(\d+)$/.exec(path);
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
});

// The checks, with the writes they held and the IDs they looked up.
function checks({ checkWrite, needsInputLabel = () => null, policies = null } = {}) {
  const writes = [];
  const asked = [];
  // The REST look-ups the write checks made.
  const looked = [];
  const real = createWriteChecks({
    needsInputLabel,
    lookup: (repo, path) => (looked.push(path), lookup(repo, path)),
    bot: () => "deckhand[bot]",
    policies,
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
  // Without its label, an idea run's create is above its ceiling.
  const bare = await check(
    idea,
    call(GH_CREATE, { input: { repositoryId: "R_repo", title: "T" } }),
  );
  assert.match(bare.refused.message, /^createIssue: .*idea label/);

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
  // Someone else's issue, and a label set on its own: above a brainstorm's ceiling.
  const other = await check(brainstorm, call(GH_EDIT, { input: { id: "I_3", body: "x" } }));
  assert.match(other.refused.message, /can't edit on other_issue #3/);
  const labelled = await check(
    brainstorm,
    call(GH_EDIT, { input: { id: "I_1", labelIds: ["L_bug"] } }),
  );
  assert.match(labelled.refused.message, /can't label/);
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
  // Above a brainstorm's ceiling on its own issue (edit, comment, link only).
  for (const [input, action] of [
    [{ milestoneId: null }, /can't milestone/],
    [{ assigneeIds: null }, /can't assign/],
    [{ labelIds: null }, /can't label/],
  ]) {
    assert.match((await check(run("brainstorm"), edit(input))).refused.message, action);
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
  const { check, writes } = checks();
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
  // The same with the variable naming another's issue: the fragment's field refuses the call.
  const refused = await check(work, call(doc, { id: "I_3" }));
  assert.match(refused.refused.message, /^b: .*can't comment on other_issue #3/);
  // An inline fragment, and a field aliased as another one's name.
  const inline = `mutation { ... on Mutation { createIssue: addComment(input: { subjectId: "I_3", body: "x" }) { clientMutationId } } }`;
  assert.match((await check(work, call(inline))).refused.message, /^createIssue: .*other_issue #3/);
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
  // Above a brainstorm's ceiling, its own or not.
  const brainstorm = { ...run("brainstorm"), created: work.created };
  assert.match(
    (await check(brainstorm, call(GH_COMMENT_EDIT, { input: { id: "IC_own", body: "x" } }))).refused
      .message,
    /can't edit on created_comment #1 \(its ceiling\)/,
  );
  // An issue isn't a comment.
  assert.match(
    (await check(work, call(GH_COMMENT_EDIT, { input: { id: "I_1", body: "x" } }))).refused.message,
    /updateIssueComment on a Issue/,
  );
});

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
  // Reactions to a comment: refused as REST refuses them.
  const react = await check(
    work,
    call(
      'mutation { addReaction(input: { subjectId: "IC_1", content: HEART }) { clientMutationId } }',
    ),
  );
  assert.equal(react.refused.status, 403);
  assert.match(react.refused.message, /can't react here \(its ceiling\)/);
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
  // The target goes through the ceiling: someone else's issue isn't a work run's to link.
  assert.match(
    (await check(work, link("addBlockedBy", "I_3", "I_2"))).refused.message,
    /can't link on other_issue #3/,
  );
  // Nor is anything an analysis's.
  assert.match(
    (await check(run("analyze"), link("addBlockedBy", "I_2", "I_3"))).refused.message,
    /its ceiling/,
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

test("createLabel: a label of the run's repository, the same write as REST's, for the modes whose ceiling holds it", async () => {
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
  // Light modes, reviews and analyses write no label.
  for (const mode of ["review", "analyze", "onboarding", "discussion", "plan"]) {
    const out = await check(run(mode), call(GH_LABEL, { input }));
    assert.match(out.refused?.message ?? "", /its ceiling/, mode);
  }
  // Only in the run's repository.
  for (const repositoryId of ["R_other", "I_1", "R_404"]) {
    const out = await check(run("work"), call(GH_LABEL, { input: { ...input, repositoryId } }));
    assert.equal(out.refused?.status, 403, repositoryId);
  }
  // A label's settings are in no ceiling: no mutation changes them.
  for (const name of ["updateLabel", "deleteLabel"]) {
    const out = await check(
      run("work"),
      call(`mutation { ${name}(input: { id: "L_idea" }) { clientMutationId } }`),
    );
    assert.match(out.refused.message, new RegExp(`doesn't let a run send ${name}`));
  }
});

test("a work run labels its sub-issues and the issues it created over GraphQL as over REST, not another's issue", async () => {
  const { check, writes } = checks();
  const work = run("work");
  const add =
    'mutation { addLabelsToLabelable(input: { labelableId: "ID", labelIds: ["L_bug"] }) { clientMutationId } }';
  const remove =
    'mutation { removeLabelsFromLabelable(input: { labelableId: "ID", labelIds: ["L_idea"] }) { clientMutationId } }';
  for (const query of [add, remove]) {
    assert.equal((await check(work, call(query.replace("ID", "I_2")))).refused, undefined);
    const other = await check(work, call(query.replace("ID", "I_3")));
    assert.match(other.refused.message, /can't label on other_issue #3/);
  }
  // #5, once GitHub answered the run's create with it.
  const filed = { ...work, created: [{ number: 5, at: Date.parse("2026-01-01T00:00:00Z") }] };
  assert.equal((await check(work, call(add.replace("ID", "I_5")))).refused?.status, 403);
  assert.equal((await check(filed, call(add.replace("ID", "I_5")))).refused, undefined);
  assert.equal((await check(filed, call(remove.replace("ID", "I_5")))).refused, undefined);
  const set = await check(work, call(GH_EDIT, { input: { id: "I_2", labelIds: ["L_bug"] } }));
  assert.equal(set.refused, undefined);
  assert.deepEqual(writes.at(-1).actions, ["label"]);
});

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

test("deny_github over GraphQL: the run's mode, whether it is the repo's own, light, and its reason", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "gh-x.rego": "package deckhand\n" },
    messages: (input) =>
      input.custom_mode && input.reason === "conflict" ? ["not in a rebase"] : [],
  });
  const { check } = checks({ policies });
  const comment = call(GH_COMMENT, { input: { subjectId: "I_1", body: "x" } });
  assert.equal((await check(run("work", 1, { reason: "review-fix" }), comment)).write, true);
  assert.deepEqual(
    [evals.at(-1).mode, evals.at(-1).custom_mode, evals.at(-1).light, evals.at(-1).reason],
    ["work", false, false, "review-fix"],
  );
  assert.equal((await check(run("brainstorm"), comment)).write, true);
  assert.deepEqual(
    [evals.at(-1).custom_mode, evals.at(-1).light, evals.at(-1).reason],
    [false, true, null],
  );
  // A repo's own mode, not light: a work run's ceiling, and the policies know it is one.
  const plan = run("plan", 1, { push: true, reason: "conflict" });
  const refused = await check(plan, comment);
  assert.equal(refused.refused.status, 403);
  assert.match(refused.refused.message, /the policies refuse it \(deny_github\): not in a rebase/);
  assert.deepEqual(
    [evals.at(-1).mode, evals.at(-1).custom_mode, evals.at(-1).light],
    ["plan", true, false],
  );
});
