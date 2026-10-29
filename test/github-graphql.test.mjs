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
  IC_1: { __typename: "IssueComment", repository: { nameWithOwner: "Org/Repo" } },
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
  // The REST look-ups the write checks made.
  const looked = [];
  const real = createWriteChecks({
    lookup: (repo, path) => (looked.push(path), lookup(repo, path)),
    bot: () => "deckhand[bot]",
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
  const worst = call(`{ ${"a: viewer { login } ".repeat(Math.floor((MAX_TOKENS - 2) / 6))} }`);
  const start = performance.now();
  assert.equal(parseCall(worst).refused, undefined);
  assert.ok(performance.now() - start < 1000);
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
    change: { fields: ["title", "body", "labels"], labels_added: ["idea"], labels_removed: [] },
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
    [GH_CREATE, { repositoryId: "R_repo", title: "T", projectIds: null }, /projectIds/],
    [GH_EDIT, { id: "I_1", issueTypeId: null }, /updateIssue's issueTypeId/],
    [
      "mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { __typename } }",
      { pullRequestId: "PR_7", milestoneId: null },
      /updatePullRequest's milestoneId/,
    ],
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
  const worst = `{ viewer { ... on User { ${"login ".repeat(MAX_TOKENS - 15)} } } }`;
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

// A document that takes the worker a while: one field repeated, with arguments.
const SLOW = `{ viewer { ${"repositories(first: 1) { totalCount } ".repeat(270)} } }`;

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
    ].map(restName),
    ["labels", "assignees", "milestone", "base", "title", "sub_issue_id", "state_reason"],
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
