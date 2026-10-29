// A run's pull request writes (github-pulls.mjs): `gh pr create`, `edit` and `ready [--undo]`,
// GraphQL or REST, through the write checks (github-writes.mjs, github-graphql.mjs) like any
// write, then held to its own branches, the workflow check and the conflict check, and recorded
// for the dashboard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGraphqlChecks } from "../listener/github-graphql.mjs";
import { createPullChecks, permissionsOf, pullOf } from "../listener/github-pulls.mjs";
import { classify, createWriteChecks } from "../listener/github-writes.mjs";

const json = (value) => Buffer.from(JSON.stringify(value));
const call = (query, input) => json({ query, variables: { input } });

const repo = (name = "Org/Repo") => ({ full_name: name });
// GitHub's pull requests: #7 a draft from the run's branch, #8 from another task's, #9 from a
// fork's branch of the same name, #10 a draft that conflicts with its base, #11 the one a create
// opens.
const PULLS = {
  7: { draft: true, ref: "issue-1-x" },
  8: { draft: true, ref: "issue-2-y" },
  9: { draft: true, ref: "issue-1-x", fork: true },
  10: { draft: true, ref: "issue-1-z", mergeable_state: "dirty" },
  11: { draft: false, ref: "issue-1-x" },
};
function pull(number) {
  const { draft, ref, fork, mergeable_state = "clean" } = PULLS[number];
  return {
    number,
    state: "open",
    draft,
    mergeable_state,
    html_url: `https://github.com/org/repo/pull/${number}`,
    base: { ref: "main", repo: repo() },
    head: { ref, repo: repo(fork ? "mallory/repo" : "Org/Repo") },
  };
}
function fakeLookup() {
  const calls = [];
  const lookup = async (_repo, path) => {
    calls.push(path);
    if (path === "/repos/org/repo/pulls?head=org%3Aissue-1-x&state=open&per_page=1") {
      return [pull(11)];
    }
    const m = /^\/repos\/org\/repo\/(issues|pulls)\/(\d+)(\/parent)?$/.exec(path);
    if (!m) throw new Error(`unexpected look-up ${path}`);
    const n = +m[2];
    if (m[3]) return null;
    if (!PULLS[n]) return n === 1 ? { number: 1, user: { login: "alice" }, labels: [] } : null;
    if (m[1] === "pulls") return pull(n);
    return { number: n, pull_request: {}, user: { login: "deckhand[bot]" }, labels: [] };
  };
  return { lookup, calls };
}

// GitHub's nodes, by ID.
const NODES = {
  R_repo: { __typename: "Repository", nameWithOwner: "Org/Repo" },
  L_bug: { __typename: "Label", name: "bug", repository: { nameWithOwner: "Org/Repo" } },
  ...Object.fromEntries(
    Object.keys(PULLS).map((n) => [
      `PR_${n}`,
      { __typename: "PullRequest", number: +n, repository: { nameWithOwner: "Org/Repo" } },
    ]),
  ),
};

// A work run on issue 1, whose branches are issue-1-*.
const run = (mode = "work", issue = 1) => ({
  repo: "org/repo",
  mode,
  push: mode === "work",
  issue,
  base: "main",
  branches: mode === "work" ? ["issue-1-*"] : [],
  created: [],
});

// The checks, REST's and GraphQL's, with what the workflow check was asked and what was recorded.
function checks({ why = null } = {}) {
  const { lookup, calls } = fakeLookup();
  const checked = [];
  const recorded = [];
  const pulls = createPullChecks({
    lookup,
    checkWorkflows: async (...args) => {
      checked.push(args);
      if (why instanceof Error) throw why;
      return why;
    },
    record: (r, pr, readyAt) => recorded.push([r, pr.number, readyAt]),
    now: () => 1000,
  });
  const writes = createWriteChecks({ lookup, pulls });
  const graphql = createGraphqlChecks({
    nodes: async (_repo, ids) => ids.map((id) => NODES[id] ?? null),
    checkWrite: writes.checkWrite,
  });
  const rest = (r, method, path, body) => writes.check(r, { method, path, body: json(body) });
  return { rest, graphql: graphql.check, writes, checked, recorded, calls };
}

// gh's own calls (cli/cli: api/queries_pr.go, pkg/cmd/pr/shared/editable_http.go).
const GH_CREATE =
  "mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }";
const GH_CREATE_METADATA =
  "mutation PullRequestCreateMetadata($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { clientMutationId } }";
const GH_UPDATE =
  "mutation PullRequestUpdate($input:UpdatePullRequestInput!){updatePullRequest(input: $input){clientMutationId}}";
const GH_LABEL =
  "mutation LabelAdd($input:AddLabelsToLabelableInput!){addLabelsToLabelable(input: $input){__typename}}";
const GH_READY =
  "mutation PullRequestReadyForReview($input:MarkPullRequestReadyForReviewInput!){markPullRequestReadyForReview(input: $input){pullRequest{id}}}";
const GH_DRAFT =
  "mutation ConvertPullRequestToDraft($input:ConvertPullRequestToDraftInput!){convertPullRequestToDraft(input: $input){pullRequest{id}}}";

const CREATE = {
  repositoryId: "R_repo",
  baseRefName: "main",
  headRefName: "issue-1-x",
  title: "Fix it",
  body: "Closes #1",
  draft: true,
};

test("gh pr create, edit, ready and ready --undo: a work run's own pull request, every flag the ceiling holds", async () => {
  const { graphql, checked } = checks();
  const work = run();
  const cases = [
    [GH_CREATE, CREATE, { pull_requests: "write" }, [{ number: null, head: "issue-1-x" }]],
    // --label and --milestone after a create: labels are in the ceiling, a milestone isn't.
    [
      GH_CREATE_METADATA,
      { pullRequestId: "PR_7", labelIds: ["L_bug"] },
      { pull_requests: "write" },
    ],
    [
      GH_UPDATE,
      { pullRequestId: "PR_7", title: "Final", body: "Closes #1", baseRefName: "release" },
      { pull_requests: "write" },
    ],
    [GH_LABEL, { labelableId: "PR_7", labelIds: ["L_bug"] }, {}, []],
    [GH_READY, { pullRequestId: "PR_7" }, { contents: "write" }],
    [GH_DRAFT, { pullRequestId: "PR_7" }, { contents: "write" }],
  ];
  for (const [query, input, permissions, pulls] of cases) {
    const out = await graphql(work, call(query, input));
    assert.equal(out.refused, undefined, `${query}: ${out.refused?.message}`);
    assert.equal(out.write, true);
    assert.deepEqual(out.permissions, permissions, query);
    const want = pulls ?? [{ number: 7, head: null }];
    assert.deepEqual(
      out.pulls.map(({ number, head }) => ({ number, head })),
      want,
      query,
    );
  }
  // Each of them but the label checked its workflows, merged with the base it will have.
  assert.deepEqual(checked, [
    ["org/repo", "issue-1-x", "main"],
    ["org/repo", "issue-1-x", "main"],
    ["org/repo", "issue-1-x", "release"],
    ["org/repo", "issue-1-x", "main"],
    ["org/repo", "issue-1-x", "main"],
    ["org/repo", "issue-1-x", "main"],
  ]);
  const milestone = await graphql(
    work,
    call(GH_CREATE_METADATA, { pullRequestId: "PR_7", milestoneId: "M_1" }),
  );
  assert.match(milestone.refused.message, /can't milestone/);
});

test("REST's creates and edits: the same checks, with a token that writes pull requests", async () => {
  const { rest, checked } = checks();
  const work = run();
  const create = { title: "T", head: "issue-1-x", base: "main", body: "B", draft: true };
  assert.equal(await rest(work, "POST", "repos/org/repo/pulls", create), null);
  assert.equal(await rest(work, "PATCH", "repos/org/repo/pulls/7", { title: "T" }), null);
  assert.deepEqual(checked, [
    ["org/repo", "issue-1-x", "main"],
    ["org/repo", "issue-1-x", "main"],
  ]);
  const written = classify("POST", "repos/org/repo/pulls", json(create));
  assert.deepEqual(written.permissions, { pull_requests: "write" });
  assert.deepEqual(written.pull, { head: "issue-1-x", base: "main", draft: true });
  assert.deepEqual(pullOf(written), { key: null, number: null, head: "issue-1-x", ready: true });
  // An issue's path on a pull request edits it as the issue: its token's issues are enough.
  assert.equal(classify("PATCH", "repos/org/repo/issues/7", json({ title: "T" })).pull, undefined);
  assert.deepEqual(permissionsOf([written, { permissions: { contents: "write" } }, {}]), {
    pull_requests: "write",
    contents: "write",
  });
});

test("refused: another branch, a fork's head, a create that names more than its branch", async () => {
  const { rest, graphql } = checks();
  const work = run();
  const refused = [
    [
      rest(work, "POST", "repos/org/repo/pulls", { title: "T", head: "issue-2-y", base: "main" }),
      /issue-2-y is not this run's branch/,
    ],
    [
      rest(work, "POST", "repos/org/repo/pulls", {
        title: "T",
        head: "mallory:issue-1-x",
        base: "main",
      }),
      /from a branch of its own repository only/,
    ],
    // An issue turned into a pull request, a head in another repository.
    [
      rest(work, "POST", "repos/org/repo/pulls", { issue: 3, head: "issue-1-x", base: "main" }),
      /without its issue/,
    ],
    [
      rest(work, "POST", "repos/org/repo/pulls", {
        title: "T",
        head: "issue-1-x",
        head_repo: "mallory/repo",
        base: "main",
      }),
      /without its head_repo/,
    ],
    [rest(work, "PATCH", "repos/org/repo/pulls/8", { title: "T" }), /can't edit on pr #8/],
    [rest(work, "PATCH", "repos/org/repo/pulls/9", { title: "T" }), /can't edit on pr #9/],
    [
      graphql(work, call(GH_CREATE, { ...CREATE, headRefName: "issue-2-y" })),
      /issue-2-y is not this run's branch/,
    ],
    [
      graphql(work, call(GH_CREATE, { ...CREATE, headRepositoryId: "R_repo" })),
      /set createPullRequest's headRepositoryId/,
    ],
    [graphql(work, call(GH_READY, { pullRequestId: "PR_8" })), /can't ready on pr #8/],
    [graphql(work, call(GH_DRAFT, { pullRequestId: "PR_8" })), /can't draft on pr #8/],
    [
      graphql(work, call(GH_UPDATE, { pullRequestId: "PR_8", title: "mine now" })),
      /can't edit on pr #8/,
    ],
  ];
  for (const [pending, why] of refused) {
    const out = await pending;
    const got = out?.refused ?? out;
    assert.ok(got?.message, String(why));
    assert.match(got.message, why);
    assert.equal(got.status, 403);
  }
  // A run on a fork's pull request: it may comment on it and label it, not ready or edit it with
  // a token that writes pull requests.
  const onFork = run("work", 9);
  assert.equal(
    (await graphql(onFork, call(GH_LABEL, { labelableId: "PR_9", labelIds: ["L_bug"] }))).refused,
    undefined,
  );
  const ready = await graphql(onFork, call(GH_READY, { pullRequestId: "PR_9" }));
  assert.match(ready.refused.message, /#9's branch, issue-1-x, is not this run's/);
  assert.match(
    (await rest(onFork, "PATCH", "repos/org/repo/pulls/9", { title: "T" })).message,
    /#9's branch/,
  );
});

test("outside work runs, and reviews, approvals and merges from any run: refused", async () => {
  const { rest, graphql } = checks();
  for (const mode of ["brainstorm", "stop", "idea", "bug", "discussion", "review", "onboarding"]) {
    const light = run(mode);
    assert.match(
      (await graphql(light, call(GH_READY, { pullRequestId: "PR_7" }))).refused.message,
      /ceiling/,
      mode,
    );
    assert.match((await graphql(light, call(GH_CREATE, CREATE))).refused.message, /ceiling/, mode);
    assert.match(
      (await rest(light, "PATCH", "repos/org/repo/pulls/7", { title: "T" })).message,
      /ceiling/,
      mode,
    );
  }
  const work = run();
  for (const [method, path, body] of [
    ["POST", "repos/org/repo/pulls/7/reviews", { event: "APPROVE" }],
    ["POST", "repos/org/repo/pulls/7/reviews/1/events", { event: "APPROVE" }],
    ["POST", "repos/org/repo/pulls/7/requested_reviewers", { reviewers: ["a"] }],
    ["PUT", "repos/org/repo/pulls/7/merge", {}],
  ]) {
    assert.match((await rest(work, method, path, body)).message, /can't (review|merge) here/, path);
  }
  for (const name of [
    "addPullRequestReview",
    "submitPullRequestReview",
    "mergePullRequest",
    "enablePullRequestAutoMerge",
    "requestReviews",
    "dismissPullRequestReview",
  ]) {
    const query = `mutation { ${name}(input: {pullRequestId: "PR_7"}) { clientMutationId } }`;
    const out = await graphql(work, json({ query }));
    assert.ok(out.refused, name);
  }
});

test("ready with conflicts isn't ready; back to draft is fine", async () => {
  const { graphql, checked } = checks();
  const work = run();
  const ready = await graphql(work, call(GH_READY, { pullRequestId: "PR_10" }));
  assert.equal(ready.refused.status, 409);
  assert.match(ready.refused.message, /#10 conflicts with main: rebase on origin\/main first/);
  assert.deepEqual(checked, []);
  assert.equal(
    (await graphql(work, call(GH_DRAFT, { pullRequestId: "PR_10" }))).refused,
    undefined,
  );
});

test("allow_workflows: a branch whose workflows fail merged with its base is neither opened, edited, readied nor drafted", async () => {
  const why = "workflow files …: .github/workflows/ci.yml (merged with main): mentions `secrets`";
  const { rest, graphql, checked } = checks({ why });
  const work = run();
  for (const [query, input] of [
    [GH_CREATE, CREATE],
    [GH_UPDATE, { pullRequestId: "PR_7", title: "T" }],
    [GH_LABEL, { labelableId: "PR_7", labelIds: ["L_bug"] }],
    [GH_READY, { pullRequestId: "PR_7" }],
    [GH_DRAFT, { pullRequestId: "PR_7" }],
  ]) {
    const out = await graphql(work, call(query, input));
    assert.equal(out.refused?.status, 422, query);
    assert.ok(out.refused.message.endsWith(`: ${why}`), out.refused.message);
  }
  assert.equal(checked.length, 5);
  // A comment runs none of the branch's workflows: not checked.
  assert.equal(await rest(work, "POST", "repos/org/repo/issues/7/comments", { body: "x" }), null);
  assert.equal(checked.length, 5);
  // A check that fails refuses, rather than skip it.
  const broken = checks({ why: new Error("git fetch: down") });
  const out = await broken.graphql(work, call(GH_READY, { pullRequestId: "PR_7" }));
  assert.equal(out.refused.status, 502);
});

test("the dashboard is told of each change that went on, at once", async () => {
  const { writes, recorded, calls } = checks();
  const work = run();
  const at = 0;
  const answer = (value) => json(value);
  // gh pr create: the pull request found by its branch, opened ready.
  writes.answered(
    work,
    {
      graphql: true,
      creates: [],
      pulls: [{ key: "createPullRequest", number: null, head: "issue-1-x", ready: true }],
      at,
    },
    200,
    answer({ data: { createPullRequest: { pullRequest: { id: "PR_11" } } } }),
  );
  // gh pr ready on #7, which GitHub still has as a draft: no readyAt. An edit: none either.
  writes.answered(
    work,
    { graphql: true, pulls: [{ key: "m", number: 7, head: null, ready: true }], at },
    200,
    answer({ data: { m: {} } }),
  );
  writes.answered(
    work,
    { graphql: true, pulls: [{ key: "u", number: 11, head: null, ready: false }], at },
    200,
    answer({ data: { u: {} } }),
  );
  // A REST create: its answer is the pull request.
  const created = { ...pull(11), number: 12 };
  writes.answered(
    work,
    {
      method: "POST",
      path: "repos/org/repo/pulls",
      body: json({}),
      graphql: false,
      pulls: [
        pullOf(classify("POST", "repos/org/repo/pulls", json({ head: "issue-1-x", base: "main" }))),
      ],
      at,
    },
    201,
    answer(created),
  );
  // What didn't go on: a field that failed, a refused REST write.
  writes.answered(
    work,
    { graphql: true, pulls: [{ key: "m", number: 7, ready: true }], at },
    200,
    answer({ data: { m: null }, errors: [{}] }),
  );
  writes.answered(
    work,
    {
      graphql: false,
      method: "PATCH",
      path: "repos/org/repo/pulls/7",
      body: json({}),
      pulls: [{ key: null, number: 7 }],
      at,
    },
    422,
    answer({}),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Each as its look-up answers: in any order.
  recorded.sort((a, b) => a[1] - b[1] || (a[2] ?? 0) - (b[2] ?? 0));
  assert.deepEqual(recorded, [
    ["org/repo", 7, null],
    ["org/repo", 11, null],
    ["org/repo", 11, 1000],
    ["org/repo", 12, 1000],
  ]);
  assert.ok(calls.includes("/repos/org/repo/pulls?head=org%3Aissue-1-x&state=open&per_page=1"));
});
