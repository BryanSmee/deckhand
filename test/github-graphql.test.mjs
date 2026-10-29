// A run's GraphQL (github-graphql.mjs): parsed and validated against GitHub's pinned schema,
// queries passed on, each mutation field classified from the nodes GitHub resolves its IDs to,
// then held to the same checks as REST writes (github-writes.mjs), and printed again.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGraphqlChecks,
  githubSchema,
  lookupNodes,
  MUTATIONS,
  parseCall,
} from "../listener/github-graphql.mjs";
import { createWriteChecks } from "../listener/github-writes.mjs";

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
  I_o: {
    __typename: "Issue",
    number: 1,
    databaseId: 201,
    repository: { nameWithOwner: "org/other" },
  },
  PR_7: { __typename: "PullRequest", number: 7, repository: { nameWithOwner: "Org/Repo" } },
  IC_1: { __typename: "IssueComment" },
  L_idea: { __typename: "Label", name: "idea", repository: { nameWithOwner: "Org/Repo" } },
  L_bug: { __typename: "Label", name: "bug", repository: { nameWithOwner: "Org/Repo" } },
  L_o: { __typename: "Label", name: "idea", repository: { nameWithOwner: "org/other" } },
  U_1: { __typename: "User" },
};

// GitHub's REST answers the write checks look up (github-writes.mjs resolve()): #1 the run's,
// #2 a sub-issue of it, #3 someone else's, #7 a pull request.
const ISSUES = {
  1: { number: 1, user: { login: "alice" }, labels: [] },
  2: { number: 2, user: { login: "bob" }, labels: [{ name: "idea" }] },
  3: { number: 3, user: { login: "bob" }, labels: [] },
  7: { number: 7, pull_request: {}, user: { login: "deckhand[bot]" }, labels: [] },
};
async function lookup(repo, path) {
  const m = /^\/repos\/org\/repo\/(issues|pulls)\/(\d+)(\/parent|\/sub_issues.*)?$/.exec(path);
  if (!m) throw new Error(`unexpected look-up ${path}`);
  const n = +m[2];
  if (m[3] === "/parent") {
    return n === 2 ? { number: 1, repository_url: "https://api.github.com/repos/Org/Repo" } : null;
  }
  if (m[3]) return [];
  if (m[1] === "pulls") return { head: { ref: "issue-1-x", repo: { full_name: "Org/Repo" } } };
  return ISSUES[n] ?? null;
}

const run = (mode, issue = 1) => ({
  repo: "org/repo",
  mode,
  push: mode === "work",
  issue,
  base: "main",
  branches: mode === "work" ? ["issue-1-*"] : [],
  created: [],
});

// The checks, with the writes they held and the IDs they looked up.
function checks({ checkWrite } = {}) {
  const writes = [];
  const asked = [];
  const real = createWriteChecks({ lookup, bot: () => "deckhand[bot]" }).checkWrite;
  const { check } = createGraphqlChecks({
    nodes: async (repo, ids) => (asked.push([repo, ids]), ids.map((id) => NODES[id] ?? null)),
    checkWrite: async (r, write) => (writes.push(write), (checkWrite ?? real)(r, write)),
  });
  return { check, writes, asked };
}

// gh's own calls (cli/cli: api/queries_issue.go, pkg/cmd/issue/…).
const GH_CREATE =
  "mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { id url } } }";
const GH_COMMENT =
  "mutation CommentCreate($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { url } } } }";
const GH_EDIT =
  "mutation IssueUpdate($input: UpdateIssueInput!) { updateIssue(input: $input) { __typename } }";

test("the pinned schema is GitHub's, with the mutations Deckhand classifies", () => {
  const fields = githubSchema().getMutationType().getFields();
  for (const name of Object.keys(MUTATIONS)) {
    assert.ok(fields[name], name);
    const input = fields[name].args.find((a) => a.name === "input").type.ofType.getFields();
    for (const field of [MUTATIONS[name].target, ...MUTATIONS[name].fields]) {
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
  // A document too long to read.
  const long = call(`{ ${"viewer { login } ".repeat(20_000)} }`);
  assert.match((await check(run("work"), long)).refused.message, /doesn't parse/);
  assert.deepEqual(asked, []);
});

test("parseCall picks the operation GitHub runs: by its name, among several", () => {
  const doc = "query A { viewer { login } } mutation B { __typename }";
  assert.equal(parseCall(call(doc, null, "B")).op.operation, "mutation");
  assert.equal(parseCall(call(doc, null, "A")).op.operation, "query");
});

test("gh issue create, comment and edit: classified from GitHub's nodes, checked as REST writes", async () => {
  const { check, writes, asked } = checks();
  const idea = run("idea", null);
  const created = await check(
    idea,
    call(GH_CREATE, {
      input: { repositoryId: "R_repo", title: "T", body: "B", labelIds: ["L_idea"] },
    }),
  );
  assert.equal(created.write, true);
  assert.deepEqual(created.creates, ["createIssue"]);
  assert.deepEqual(asked, [["org/repo", ["R_repo", "L_idea"]]]);
  assert.deepEqual(writes[0], {
    repo: "org/repo",
    actions: ["create"],
    target: { kind: "new_issue" },
    change: { fields: ["title", "body", "labelIds"], labels_added: ["idea"], labels_removed: [] },
  });
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
  assert.match(away.refused.message, /only to its own repository/);
  // A create in another repository.
  const elsewhere = await check(
    run("work"),
    call(GH_CREATE, { input: { repositoryId: "R_other", title: "T" } }),
  );
  assert.match(elsewhere.refused.message, /only to its own repository/);
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
  // A field set to null is GitHub's "not set": no refusal for it.
  const nulls = await check(
    work,
    call(GH_CREATE, { input: { repositoryId: "R_repo", title: "T", projectIds: null } }),
  );
  assert.equal(nulls.write, true);
  // Only __typename: nothing written, nothing looked up.
  assert.equal((await check(work, call("mutation { __typename }"))).write, false);
});

test("targets come from GitHub's nodes: a missing one, a wrong type, another repo's label", async () => {
  const { check } = checks();
  const work = run("work");
  const cases = [
    [GH_COMMENT, { input: { subjectId: "I_404", body: "x" } }, 404, /subjectId isn't there/],
    [GH_COMMENT, { input: { subjectId: "U_1", body: "x" } }, 403, /on a User/],
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
  // Someone else's issue as the child, another repo's, the run's own issue.
  for (const child of ["I_3", "I_o", "I_1"]) {
    assert.match(
      (await check(brainstorm, link("I_1", child))).refused.message,
      /links only/,
      child,
    );
  }
  assert.match(
    (await check(brainstorm, link("I_1", "I_2", ", replaceParent: true"))).refused.message,
    /replace_parent/,
  );
  assert.match((await check(brainstorm, link("I_1", "PR_7"))).refused.message, /isn't an issue/);
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
