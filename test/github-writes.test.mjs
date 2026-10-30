// A run's REST writes (github-writes.mjs): classified, their target's kind resolved from GitHub,
// held to their mode's ceiling (modes.mjs) and the policies' `deny_github`. GraphQL's are
// github-graphql.test.mjs's.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { createGithubGateway } from "../listener/github-gateway.mjs";
import { aboveCeiling, classify, createWriteChecks } from "../listener/github-writes.mjs";
import { ceilingOf, MODES } from "../listener/modes.mjs";
import { createPolicies, opaRunner } from "../listener/policies.mjs";
import { policyEngine, sandboxAt, serve, tempDir } from "./helpers.mjs";

const json = (value) => Buffer.from(JSON.stringify(value));

// When the tests' runs sent their creates, and GitHub's time `s` seconds from then.
const START = Date.parse("2026-10-29T10:00:00Z");
const at = (s) => new Date(START + s * 1000).toISOString();
const BOT = () => "deckhand[bot]";

test("classify: a write's actions, its target and what it changes", () => {
  const cases = [
    [
      "POST",
      "repos/Org/Repo/issues",
      { title: "T", body: "B", labels: ["idea", { name: "ui" }] },
      {
        repo: "org/repo",
        actions: ["create"],
        target: { kind: "new_issue" },
        change: {
          fields: ["title", "body", "labels"],
          labels_added: ["idea", "ui"],
          labels_removed: [],
        },
      },
    ],
    [
      "PATCH",
      "repos/org/repo/issues/12",
      { body: "x" },
      { actions: ["edit"], target: { number: 12 }, fields: ["body"] },
    ],
    // A state first, labels next, then the rest.
    [
      "PATCH",
      "repos/org/repo/issues/12",
      { state: "closed", state_reason: "completed" },
      { actions: ["close"], target: { number: 12 } },
    ],
    [
      "PATCH",
      "repos/org/repo/pulls/3",
      { labels: ["a"], title: "t" },
      { actions: ["label", "edit"], target: { number: 3 }, labels_added: ["a"] },
    ],
    ["POST", "repos/org/repo/issues/12/comments", { body: "hi" }, { actions: ["comment"] }],
    ["PUT", "repos/org/repo/issues/12/labels", ["a"], { actions: ["label"], labels_added: ["a"] }],
    [
      "DELETE",
      "repos/org/repo/issues/12/labels/needs input",
      null,
      { actions: ["label"], labels_removed: ["needs input"] },
    ],
    ["DELETE", "repos/org/repo/issues/12/labels", null, { labels_removed: ["*"] }],
    ["POST", "repos/org/repo/issues/12/sub_issues", { sub_issue_id: 9 }, { actions: ["link"] }],
    ["DELETE", "repos/org/repo/issues/12/sub_issue", { sub_issue_id: 9 }, { actions: ["link"] }],
    [
      "POST",
      "repos/org/repo/issues/12/dependencies/blocked_by",
      { issue_id: 9 },
      { actions: ["link"], target: { number: 12 } },
    ],
    [
      "DELETE",
      "repos/org/repo/issues/12/dependencies/blocked_by/9",
      null,
      { actions: ["link"], target: { number: 12 } },
    ],
    // Assignees and a milestone are their own actions, on a create too; labels set, a flag.
    [
      "POST",
      "repos/org/repo/issues",
      { title: "T", assignees: ["a"], milestone: 2 },
      { actions: ["create", "assign", "milestone"] },
    ],
    [
      "POST",
      "repos/org/repo/labels",
      { name: "idea" },
      { target: { kind: "label" }, labels_added: ["idea"] },
    ],
    [
      "PATCH",
      "repos/org/repo/issues/comments/5",
      { body: "x" },
      { actions: ["edit"], target: { kind: "comment" } },
    ],
    ["DELETE", "repos/org/repo/issues/comments/5", null, { actions: ["delete"] }],
    ["POST", "repos/org/repo/pulls/3/reviews", { event: "APPROVE" }, { actions: ["review"] }],
    ["POST", "repos/org/repo/pulls/3/comments/4/replies", { body: "x" }, { actions: ["review"] }],
    ["PUT", "repos/org/repo/pulls/3/merge", null, { actions: ["merge"], target: { number: 3 } }],
    ["POST", "repos/org/repo/pulls", { head: "issue-1-x" }, { target: { kind: "new_pr" } }],
    // Spelled another way: its case, a trailing slash.
    ["POST", "repos/org/repo/Issues/12/Comments/", { body: "hi" }, { actions: ["comment"] }],
  ];
  for (const [method, path, body, want] of cases) {
    const got = classify(method, path, body === null ? Buffer.alloc(0) : json(body));
    const label = `${method} ${path}`;
    if (want.repo) assert.deepEqual(got, want, label);
    if (want.actions) assert.deepEqual(got.actions, want.actions, label);
    if (want.target) assert.deepEqual(got.target, want.target, label);
    if (want.fields) assert.deepEqual(got.change.fields, want.fields, label);
    if (want.labels_added) assert.deepEqual(got.change.labels_added, want.labels_added, label);
    if (want.labels_removed)
      assert.deepEqual(got.change.labels_removed, want.labels_removed, label);
  }
  assert.deepEqual(
    classify("POST", "repos/org/repo/issues/12/sub_issues", json({ sub_issue_id: 9 })).child,
    { id: 9, replace_parent: false },
  );
  for (const [method, path, body] of [
    ["POST", "repos/org/repo/issues/12/dependencies/blocked_by", json({ issue_id: "9" })],
    ["DELETE", "repos/org/repo/issues/12/dependencies/blocked_by/9", Buffer.alloc(0)],
  ]) {
    assert.deepEqual(classify(method, path, body).blocker, { id: 9 }, method);
  }
  assert.equal(
    classify("PUT", "repos/org/repo/issues/12/labels", json(["a"])).change.labels_set,
    true,
  );
  // Rendering markdown writes nothing.
  assert.deepEqual(classify("POST", "markdown/raw", Buffer.from("# x")), { read: true });
  // What it can't classify: null.
  for (const [method, path, body] of [
    ["PUT", "repos/org/repo/contents/a.txt", "{}"],
    ["POST", "repos/org/repo/git/refs", "{}"],
    ["POST", "repos/org/repo/dispatches", "{}"],
    ["POST", "repositories/42/issues/1/comments", "{}"],
    ["POST", "user/repos", "{}"],
    ["POST", "repos/org/repo/issues/1/comments", "not json"],
    ["PATCH", "repos/org/repo/issues/1", '"a string"'],
    ["POST", "repos/org/repo/issues/x/comments", "{}"],
    // A link without its child.
    ["POST", "repos/org/repo/issues/1/sub_issues", "{}"],
    ["DELETE", "repos/org/repo/issues/1/sub_issue", '{"sub_issue_id": "x"}'],
    // A blocked-by link without its blocker.
    ["POST", "repos/org/repo/issues/1/dependencies/blocked_by", "{}"],
    ["POST", "repos/org/repo/issues/1/dependencies/blocked_by", '{"issue_id": -3}'],
    ["DELETE", "repos/org/repo/issues/1/dependencies/blocked_by/0", "{}"],
  ]) {
    assert.equal(classify(method, path, Buffer.from(body)), null, `${method} ${path}`);
  }
});

test("the ceilings: what each mode can ever write", () => {
  const work = ceilingOf("work", false);
  assert.deepEqual(aboveCeiling(work, "own_issue", ["edit", "comment", "label"]), []);
  assert.deepEqual(aboveCeiling(work, "own_pr", ["edit", "label"]), []);
  assert.deepEqual(aboveCeiling(work, "sub_issue", ["link", "edit"]), []);
  // It labels its sub-issues and the issues it files, and creates labels.
  assert.deepEqual(aboveCeiling(work, "sub_issue", ["label"]), []);
  assert.deepEqual(aboveCeiling(work, "created_issue", ["label"]), []);
  assert.deepEqual(aboveCeiling(work, "label", ["create"]), []);
  assert.deepEqual(aboveCeiling(work, "other_issue", ["label"]), ["label"]);
  assert.deepEqual(aboveCeiling(work, "other_issue", ["comment"]), ["comment"]);
  assert.deepEqual(aboveCeiling(work, "pr", ["comment"]), ["comment"]);
  assert.deepEqual(aboveCeiling(work, "own_issue", ["close"]), ["close"]);
  const brainstorm = ceilingOf("brainstorm", true);
  assert.deepEqual(aboveCeiling(brainstorm, "other_issue", ["comment"]), []);
  assert.deepEqual(aboveCeiling(brainstorm, "own_issue", ["label"]), ["label"]);
  assert.deepEqual(ceilingOf("stop", true), brainstorm);
  assert.deepEqual(aboveCeiling(ceilingOf("idea", true), "new_issue", ["create"]), []);
  assert.deepEqual(aboveCeiling(ceilingOf("bug", true), "own_issue", ["edit"]), ["edit"]);
  assert.deepEqual(ceilingOf("discussion", true), { new_issue: ["create"] });
  // Modes that read write nothing; a repo's light modes neither, its others as work runs.
  for (const mode of ["onboarding", "analyze", "review", "research", "policy"]) {
    assert.deepEqual(ceilingOf(mode, true), {}, mode);
  }
  assert.deepEqual(ceilingOf("triage", true), {});
  assert.deepEqual(ceilingOf("deploy", false), work);
  assert.deepEqual(ceilingOf(null, false), {});
  // No ceiling holds what stays out of every one.
  for (const [mode, { ceiling = {} }] of Object.entries(MODES)) {
    for (const actions of Object.values(ceiling)) {
      for (const out of ["close", "reopen", "delete", "merge", "review", "assign", "lock"]) {
        assert.ok(!actions.includes(out), `${mode}: ${out}`);
      }
    }
    // A label's settings: created only, never edited or deleted.
    assert.deepEqual(aboveCeiling(ceiling, "label", ["edit", "delete"]), ["edit", "delete"], mode);
  }
});

// A fake GitHub for the look-ups: issues by number (a `pull_request` field for a pull
// request), pull requests' heads, issues' parents (a number: in the repo; else GitHub's
// parent), issues' sub-issues, the repo's open issues (newest first, by pages of 100).
function fakeLookup({ issues = {}, pulls = {}, parents = {}, subs = {}, open = [] } = {}) {
  const calls = [];
  const lookup = async (repo, path) => {
    calls.push(path);
    const page = /^\/repos\/org\/repo\/issues\?state=open&per_page=100&page=(\d+)$/.exec(path);
    if (page) return open.slice((page[1] - 1) * 100, page[1] * 100);
    const m =
      /^\/repos\/org\/repo\/(issues|pulls)\/(\d+)(\/parent|\/sub_issues\?per_page=100)?$/.exec(
        path,
      );
    if (!m) throw new Error(`unexpected look-up ${path}`);
    const n = +m[2];
    if (m[3]?.startsWith("/sub_issues")) return subs[n] ?? [];
    if (m[3]) {
      const parent = parents[n];
      if (typeof parent !== "number") return parent ?? null;
      return { number: parent, repository_url: "https://api.github.com/repos/Org/Repo" };
    }
    if (m[1] === "pulls") return pulls[n] ?? null;
    return issues[n] ?? null;
  };
  return { lookup, calls };
}

const GITHUB = {
  issues: {
    1: { number: 1, user: { login: "alice" }, labels: [{ name: "idea" }] },
    2: { number: 2, user: { login: "bob" }, labels: [] },
    3: { number: 3, id: 903, state: "open", user: { login: "bob" }, labels: [] },
    4: { number: 4, user: { login: "bob" }, labels: [] },
    // The bot's: created by the tests' runs, and long before.
    30: { number: 30, id: 900, user: { login: "deckhand[bot]" }, created_at: at(1), labels: [] },
    35: { number: 35, id: 905, user: { login: "deckhand[bot]" }, created_at: at(2), labels: [] },
    31: {
      number: 31,
      id: 901,
      user: { login: "deckhand[bot]" },
      created_at: at(-3600),
      labels: [],
    },
    // The bot's during the run, filed by another run or a dashboard analysis.
    34: { number: 34, id: 904, user: { login: "deckhand[bot]" }, created_at: at(3), labels: [] },
    // A person's, filed during the run.
    50: { number: 50, id: 950, user: { login: "alice" }, created_at: at(4), labels: [] },
    7: { number: 7, pull_request: {}, user: { login: "deckhand[bot]" }, labels: [] },
    8: { number: 8, pull_request: {}, user: { login: "bob" }, labels: [] },
    // Someone else's, closed.
    60: { number: 60, id: 960, state: "closed", user: { login: "bob" }, labels: [] },
  },
  pulls: {
    7: { head: { ref: "issue-1-thing", repo: { full_name: "Org/Repo" } } },
    // Another branch, and one named like the run's but in a fork.
    8: { head: { ref: "issue-1-thing", repo: { full_name: "mallory/repo" } } },
  },
  // #4's parent is another repository's #1.
  parents: {
    2: 1,
    4: { number: 1, repository_url: "https://api.github.com/repos/org/other" },
  },
  subs: { 1: [{ id: 202, number: 2 }] },
  // Open: #3, and #8, a pull request, as GitHub's issues list them.
  open: [
    { number: 8, id: 908, pull_request: {} },
    { number: 3, id: 903 },
  ],
};
function run(mode, { push = mode === "work", issue = 1, branches = ["issue-1-*"] } = {}) {
  const branch = push ? branches : [];
  return { repo: "org/repo", mode, push, issue, base: "main", branches: branch, created: [] };
}

const write = (method, path, body = {}) => ({ method, path, body: json(body) });

test("a work run writes its issue, its pull requests and its sub-issues, nothing else", async () => {
  const { lookup } = fakeLookup(GITHUB);
  const { check } = createWriteChecks({ lookup });
  const work = run("work");
  const allowed = [
    write("PATCH", "repos/org/repo/issues/1", { body: "x" }),
    write("POST", "repos/org/repo/issues/1/comments", { body: "x" }),
    write("POST", "repos/org/repo/issues/1/labels", { labels: ["a"] }),
    write("POST", "repos/org/repo/issues/1/sub_issues", { sub_issue_id: 202 }),
    write("PATCH", "repos/org/repo/pulls/7", { title: "x" }),
    write("POST", "repos/org/repo/issues/7/comments", { body: "x" }),
    write("PATCH", "repos/org/repo/issues/2", { body: "x" }),
    write("POST", "repos/org/repo/issues/2/labels", { labels: ["a"] }),
    write("PATCH", "repos/org/repo/issues/2", { labels: ["a"] }),
    write("DELETE", "repos/org/repo/issues/2/labels/a"),
    write("POST", "repos/org/repo/issues", { title: "x" }),
    write("POST", "repos/org/repo/labels", { name: "a", color: "fff" }),
  ];
  for (const w of allowed) assert.equal(await check(work, w), null, `${w.method} ${w.path}`);
  const refused = [
    [
      write("POST", "repos/org/repo/issues/3/comments", { body: "x" }),
      /can't comment on other_issue #3/,
    ],
    [write("PATCH", "repos/org/repo/issues/3", { body: "x" }), /can't edit on other_issue #3/],
    [write("POST", "repos/org/repo/issues/8/comments", { body: "x" }), /can't comment on pr #8/],
    [
      write("POST", "repos/org/repo/issues/3/labels", { labels: ["a"] }),
      /can't label on other_issue #3/,
    ],
    [
      write("PATCH", "repos/org/repo/labels/a", { color: "fff" }),
      /can't edit on label \(its ceiling\)/,
    ],
    [write("DELETE", "repos/org/repo/labels/a"), /can't delete here/],
    [write("PATCH", "repos/org/repo/issues/1", { state: "closed" }), /can't close here/],
    [write("PUT", "repos/org/repo/pulls/7/merge"), /can't merge here/],
    [write("POST", "repos/org/repo/pulls/7/reviews", { event: "APPROVE" }), /can't review here/],
    [write("PATCH", "repos/org/repo/issues/comments/5", { body: "x" }), /can't edit here/],
    [write("POST", "repos/other/repo/issues/1/comments", { body: "x" }), /its own repository/],
    [write("PUT", "repos/org/repo/contents/a", {}), /can't tell what this write does/],
    [write("POST", "repos/org/repo/issues/99/comments", { body: "x" }), /#99 isn't there/],
    // An issue whose parent is another repository's #1 isn't its sub-issue.
    [write("PATCH", "repos/org/repo/issues/4", { body: "x" }), /can't edit on other_issue #4/],
    [
      write("POST", "repos/org/repo/issues", { title: "x", assignees: ["a"] }),
      /can't create, assign here/,
    ],
  ];
  for (const [w, why] of refused) {
    const got = await check(work, w);
    assert.ok(got, `${w.method} ${w.path}`);
    assert.match(got.message, why);
    assert.equal(got.status, /isn't there/.test(got.message) ? 404 : 403);
  }
});

test("target kinds come from GitHub, never from the request", async () => {
  const { lookup, calls } = fakeLookup(GITHUB);
  const { check } = createWriteChecks({ lookup });
  // Its pull request is by its branch, in its repo: a fork's of the same name isn't its own,
  // and a pull request's own path doesn't make it one.
  const work = run("work");
  assert.equal(await check(work, write("PATCH", "repos/org/repo/pulls/7", { title: "x" })), null);
  assert.match(
    (await check(work, write("PATCH", "repos/org/repo/pulls/8", { title: "x" }))).message,
    /on pr #8/,
  );
  // An issue path naming a pull request is the pull request.
  assert.match(
    (
      await check(
        run("idea"),
        write("POST", "repos/org/repo/issues/7/sub_issues", { sub_issue_id: 5 }),
      )
    ).message,
    /can't link on pr #7/,
  );
  // A sub-issue by its parent on GitHub: the body's sub_issue_id says nothing.
  const brainstorm = run("brainstorm");
  assert.equal(
    await check(brainstorm, write("PATCH", "repos/org/repo/issues/2", { body: "x" })),
    null,
  );
  assert.match(
    (await check(brainstorm, write("PATCH", "repos/org/repo/issues/3", { body: "x", parent: 1 })))
      .message,
    /can't edit on other_issue #3/,
  );
  assert.ok(calls.includes("/repos/org/repo/issues/3/parent"));
  // A write no kind could take isn't looked up.
  const before = calls.length;
  await check(run("review"), write("POST", "repos/org/repo/issues/1/comments", { body: "x" }));
  assert.equal(calls.length, before);
  // A look-up that fails refuses.
  const broken = createWriteChecks({
    lookup: async () => {
      throw new Error("down");
    },
  });
  const failed = await broken.check(work, write("POST", "repos/org/repo/issues/1/comments", {}));
  assert.equal(failed.status, 502);
});

test("light runs: brainstorms, inbox entries, discussions and the modes that read", async () => {
  const { check } = createWriteChecks({ lookup: fakeLookup(GITHUB).lookup });
  const ok = async (mode, w) => assert.equal(await check(run(mode), w), null, `${mode} ${w.path}`);
  const no = async (mode, w) => assert.ok(await check(run(mode), w), `${mode} ${w.path}`);
  await ok("brainstorm", write("PATCH", "repos/org/repo/issues/1", { body: "x" }));
  await ok("brainstorm", write("POST", "repos/org/repo/issues/3/comments", { body: "x" }));
  await ok("brainstorm", write("POST", "repos/org/repo/issues/8/comments", { body: "x" }));
  await ok("stop", write("POST", "repos/org/repo/issues", { title: "x", labels: ["idea"] }));
  await ok("stop", write("POST", "repos/org/repo/labels", { name: "idea" }));
  await no("brainstorm", write("PATCH", "repos/org/repo/issues/3", { body: "x" }));
  await no("brainstorm", write("PATCH", "repos/org/repo/issues/1", { labels: ["x"] }));
  // An inbox entry's issues carry its label: in its ceiling.
  await ok("idea", write("POST", "repos/org/repo/issues", { title: "x", labels: ["Idea", "ui"] }));
  await ok(
    "bug",
    write("POST", "repos/org/repo/issues", { title: "x", labels: [{ name: "bug" }] }),
  );
  for (const labels of [undefined, [], ["ui"], ["bug"]]) {
    const refused = await check(
      run("idea"),
      write("POST", "repos/org/repo/issues", { title: "x", labels }),
    );
    assert.match(
      refused?.message ?? "",
      /idea runs' issues carry the idea label \(their ceiling\)/,
      `${labels}`,
    );
  }
  // Linking under an issue it didn't create: no (sub_issue_links below).
  await no("bug", write("POST", "repos/org/repo/issues/3/sub_issues", { sub_issue_id: 202 }));
  await ok("bug", write("POST", "repos/org/repo/issues/1/comments", { body: "x" }));
  await no("idea", write("PATCH", "repos/org/repo/issues/1", { body: "x" }));
  await ok("discussion", write("POST", "repos/org/repo/issues", { title: "x" }));
  await no("discussion", write("POST", "repos/org/repo/labels", { name: "x" }));
  for (const mode of ["onboarding", "analyze", "review", "triage"]) {
    await no(mode, write("POST", "repos/org/repo/issues/1/comments", { body: "x" }));
    await no(mode, write("POST", "repos/org/repo/issues", { title: "x" }));
  }
});

// GitHub's answers to creates: `gh issue create`'s GraphQL call (its URL is the web page's),
// whose createIssue answers under `createIssue` (github-graphql.mjs `creates`), and a REST one.
const GRAPHQL_CREATE = {
  method: "POST",
  path: "graphql",
  body: json({
    query:
      "mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { id url } } }",
  }),
  graphql: true,
  creates: ["createIssue"],
  at: START,
};
const created = (number, repo = "Org/Repo") =>
  json({
    data: {
      createIssue: { issue: { id: "I_1", url: `https://github.com/${repo}/issues/${number}` } },
    },
  });
const REST_CREATE = { ...write("POST", "repos/org/repo/issues", { title: "x" }), at: START };
const restIssue = (number, repo = "Org/Repo") =>
  json({
    id: 1,
    number,
    url: `https://api.github.com/repos/${repo}/issues/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
  });

test("the issues a run created: GitHub's answers to its own creates, REST and GraphQL", () => {
  const { answered } = createWriteChecks({ lookup: fakeLookup(GITHUB).lookup });
  const work = run("work");
  let saved = 0;
  work.createdChanged = () => saved++;
  answered(work, GRAPHQL_CREATE, 200, created(30));
  answered(work, REST_CREATE, 201, restIssue(35));
  // Again, refused by GitHub, another repository's, not an issue's answer, not a create.
  answered(work, GRAPHQL_CREATE, 200, created(30));
  answered(work, GRAPHQL_CREATE, 502, created(40));
  answered(work, REST_CREATE, 422, restIssue(41));
  answered(work, GRAPHQL_CREATE, 200, created(42, "org/other"));
  answered(work, REST_CREATE, 201, restIssue(43, "org/other"));
  answered(
    work,
    GRAPHQL_CREATE,
    200,
    json({ data: { updateIssue: { issue: { url: "https://github.com/org/repo/issues/44" } } } }),
  );
  answered(work, GRAPHQL_CREATE, 200, Buffer.from("not json"));
  // A call creating none (its answer names one all the same), and one creating two, aliased.
  answered(work, { ...GRAPHQL_CREATE, creates: [] }, 200, created(46));
  answered(
    work,
    { ...GRAPHQL_CREATE, creates: ["a", "b"] },
    200,
    json({
      data: {
        a: { issue: { url: "https://github.com/org/repo/issues/47" } },
        b: { issue: { url: "https://github.com/org/repo/issues/48" } },
      },
    }),
  );
  answered(
    work,
    { ...write("POST", "repos/org/repo/issues/1/comments", {}), at: START },
    201,
    restIssue(45),
  );
  assert.deepEqual(work.created, [
    { number: 30, at: START },
    { number: 35, at: START },
    { number: 47, at: START },
    { number: 48, at: START },
  ]);
  assert.equal(saved, 3);
});

test("a sub-issue link: its child is one the run created or already under its issue, never moved", async () => {
  const { lookup } = fakeLookup(GITHUB);
  const { check, answered } = createWriteChecks({ lookup, bot: BOT });
  const work = run("work");
  const link = (parent, body) => write("POST", `repos/org/repo/issues/${parent}/sub_issues`, body);
  // Any issue of the repo, by its id: refused, and moved from its parent all the more, however
  // replace_parent is spelled.
  assert.match(
    (await check(work, link(1, { sub_issue_id: 9 }))).message,
    /links only issues it created, or those already under its issue/,
  );
  for (const replace_parent of [true, "true", 1, "1", "True", "yes", null, "false", 0]) {
    const moved = await check(work, link(1, { sub_issue_id: 202, replace_parent }));
    assert.match(
      moved?.message ?? "",
      /can't move an issue from another parent \(replace_parent\)/,
      JSON.stringify(replace_parent),
    );
  }
  assert.equal(await check(work, link(1, { sub_issue_id: 202, replace_parent: false })), null);
  // Already under its issue: unlinked, reordered.
  assert.equal(
    await check(work, write("DELETE", "repos/org/repo/issues/1/sub_issue", { sub_issue_id: 202 })),
    null,
  );
  // Created the prompts' way (`gh issue create`, GraphQL), and over REST: linked, then written
  // like a sub-issue.
  answered(work, GRAPHQL_CREATE, 200, created(30));
  answered(work, REST_CREATE, 201, restIssue(35));
  for (const id of [900, 905]) assert.equal(await check(work, link(1, { sub_issue_id: id })), null);
  assert.equal(await check(work, write("PATCH", "repos/org/repo/issues/30", { body: "x" })), null);
  assert.equal(
    await check(work, write("POST", "repos/org/repo/issues/30/labels", { labels: ["a"] })),
    null,
  );
  // The bot's issue another run or an analysis filed meanwhile isn't this run's: the App's
  // authorship says nothing.
  assert.match((await check(work, link(1, { sub_issue_id: 904 }))).message, /links only/);
  assert.match(
    (await check(work, write("PATCH", "repos/org/repo/issues/34", { body: "x" }))).message,
    /can't edit on other_issue #34/,
  );
  // An answer naming an older issue (an aliased field, say) doesn't make it the run's.
  answered(work, GRAPHQL_CREATE, 200, created(31));
  assert.match((await check(work, link(1, { sub_issue_id: 901 }))).message, /links only/);
  assert.match(
    (await check(work, write("PATCH", "repos/org/repo/issues/31", { body: "x" }))).message,
    /other_issue #31/,
  );
  // Nor does a read that aliases a field `createIssue`, naming an issue filed meanwhile by
  // someone or by the bot (github-graphql.mjs names no createIssue field of it); and an issue
  // the bot didn't write is never one the run created.
  const read = (query) => ({ ...GRAPHQL_CREATE, creates: [], body: json({ query }) });
  for (const n of [50, 34]) {
    const before = work.created.length;
    answered(
      work,
      read(
        `query { createIssue: repository(owner: "org", name: "repo") { issue(number: ${n}) { url } } }`,
      ),
      200,
      created(n),
    );
    assert.equal(work.created.length, before, `#${n}`);
  }
  answered(work, GRAPHQL_CREATE, 200, created(50));
  assert.match(
    (await check(work, write("PATCH", "repos/org/repo/issues/50", { title: "x" }))).message,
    /other_issue #50/,
  );
  // Without the App's login, nothing is the run's.
  const unknown = createWriteChecks({ lookup });
  assert.match((await unknown.check(work, link(1, { sub_issue_id: 900 }))).message, /links only/);
  // Another run's creations aren't this one's.
  assert.ok(await check(run("work"), link(1, { sub_issue_id: 900 })));
  // An inbox entry links under the parents it created only, the children it created too.
  const idea = run("idea");
  answered(idea, GRAPHQL_CREATE, 200, created(30));
  answered(idea, GRAPHQL_CREATE, 200, created(35));
  assert.equal(await check(idea, link(30, { sub_issue_id: 905 })), null);
  assert.match((await check(idea, link(3, { sub_issue_id: 905 }))).message, /other_issue #3/);
  assert.match((await check(idea, link(34, { sub_issue_id: 905 }))).message, /other_issue #34/);
  assert.match((await check(idea, link(30, { sub_issue_id: 904 }))).message, /links only issues/);
});

test("a blocked-by link: its blocker one the run created, one under its issue, or an open issue of its repo", async () => {
  const { lookup } = fakeLookup(GITHUB);
  const { check, answered } = createWriteChecks({ lookup, bot: BOT });
  const work = run("work");
  const block = (n, id) =>
    write("POST", `repos/org/repo/issues/${n}/dependencies/blocked_by`, { issue_id: id });
  const unblock = (n, id) =>
    write("DELETE", `repos/org/repo/issues/${n}/dependencies/blocked_by/${id}`);
  // Its sub-issue blocked by an open issue of the repo, its own issue by its sub-issue.
  for (const w of [block(2, 903), unblock(2, 903), block(1, 202), unblock(1, 202)]) {
    assert.equal(await check(work, w), null, `${w.method} ${w.path}`);
  }
  // An issue it created, blocked by another it created.
  answered(work, GRAPHQL_CREATE, 200, created(30));
  answered(work, REST_CREATE, 201, restIssue(35));
  assert.equal(await check(work, block(35, 900)), null);
  // A closed issue it didn't create, a pull request, an id the repo's open issues don't have.
  for (const id of [960, 908, 9]) {
    assert.match(
      (await check(work, block(2, id)))?.message ?? "",
      /an open issue of its repository/,
      String(id),
    );
  }
  // The target goes through the ceiling: someone else's issue isn't a work run's to link.
  assert.match((await check(work, block(3, 202))).message, /can't link on other_issue #3/);
  // An inbox entry links the issues it created, and nothing else.
  const idea = run("idea");
  answered(idea, GRAPHQL_CREATE, 200, created(30));
  answered(idea, GRAPHQL_CREATE, 200, created(35));
  assert.equal(await check(idea, block(35, 900)), null);
  assert.equal(await check(idea, block(35, 903)), null);
  assert.match((await check(idea, block(3, 900))).message, /other_issue #3/);
  assert.match((await check(idea, block(1, 900))).message, /own_issue #1/);
  // Modes whose ceiling holds no link: refused before any look-up.
  for (const mode of ["review", "analyze", "onboarding"]) {
    assert.match((await check(run(mode), block(2, 903))).message, /its ceiling/, mode);
  }
});

test("a blocked-by link's blocker by its id is looked for among the repo's newest open issues", async () => {
  const filler = (from) =>
    Array.from({ length: 100 }, (_, i) => ({ number: 1000 + from + i, id: 5000 + from + i }));
  const open = [...filler(0), ...filler(100), { number: 3, id: 903 }];
  const { lookup, calls } = fakeLookup({ ...GITHUB, open });
  const { check } = createWriteChecks({ lookup });
  const block = { issue_id: 903 };
  const w = write("POST", "repos/org/repo/issues/2/dependencies/blocked_by", block);
  assert.equal(await check(run("work"), w), null);
  assert.equal(calls.filter((c) => c.includes("state=open")).length, 3);
  // Past the pages it reads: not found, refused.
  const many = Array.from({ length: 11 }, (_, p) => filler(p * 100)).flat();
  const far = fakeLookup({ ...GITHUB, open: [...many, { number: 3, id: 903 }] });
  const { check: farCheck } = createWriteChecks({ lookup: far.lookup });
  assert.match((await farCheck(run("work"), w)).message, /an open issue of its repository/);
  assert.equal(far.calls.filter((c) => c.includes("state=open")).length, 10);
});

test("deny_github: its input, and its reasons refusing the write", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "github.rego": "package deckhand\n" },
    messages: (input) =>
      input.mode === "brainstorm" && input.target.kind !== "own_issue"
        ? ["brainstorms write only their own issue", "ask on #1 instead"]
        : [],
  });
  const { check } = createWriteChecks({ lookup: fakeLookup(GITHUB).lookup, policies });
  const brainstorm = run("brainstorm");
  assert.equal(
    await check(brainstorm, write("PATCH", "repos/org/repo/issues/1", { body: "x" })),
    null,
  );
  const refused = await check(
    brainstorm,
    write("POST", "repos/org/repo/issues/3/comments", { body: "x" }),
  );
  assert.deepEqual(refused, {
    status: 403,
    message:
      "the policies refuse it (deny_github): brainstorms write only their own issue; ask on #1 instead",
  });
  assert.deepEqual(evals.at(-1), {
    rule: "deny_github",
    version: 1,
    repo: "org/repo",
    mode: "brainstorm",
    issue: 1,
    action: "comment",
    actions: ["comment"],
    target: { number: 3, labels: [], author: "bob", kind: "other_issue" },
    change: { fields: ["body"], labels_added: [], labels_removed: [] },
  });
  // Labels set in place of the issue's remove those they leave out (#1 has `idea`).
  const work = run("work");
  await check(work, write("PUT", "repos/org/repo/issues/1/labels", ["bug"]));
  assert.deepEqual(evals.at(-1).change, {
    fields: [],
    labels_added: ["bug"],
    labels_removed: ["idea"],
  });
  await check(work, write("PATCH", "repos/org/repo/issues/1", { labels: ["Idea", "ui"] }));
  assert.deepEqual(evals.at(-1).change.labels_removed, []);
  await check(work, write("PATCH", "repos/org/repo/issues/1", { labels: [] }));
  assert.deepEqual(evals.at(-1).change.labels_removed, ["idea"]);
  // A link's child, with its kind.
  await check(work, write("POST", "repos/org/repo/issues/1/sub_issues", { sub_issue_id: 202 }));
  assert.deepEqual(evals.at(-1).change.sub_issue, { id: 202, number: 2, kind: "sub_issue" });
  // A blocked-by link's blocker, with its kind.
  await check(
    work,
    write("POST", "repos/org/repo/issues/2/dependencies/blocked_by", { issue_id: 903 }),
  );
  assert.deepEqual(evals.at(-1).change.blocked_by, { id: 903, number: 3, kind: "other_issue" });
  // Above the ceiling: refused before any policy runs.
  const asked = evals.length;
  await check(brainstorm, write("PATCH", "repos/org/repo/issues/3", { body: "x" }));
  assert.equal(evals.length, asked);
});

test("a policy's refusal reaches the agent through the gateway, in GitHub's error shape", async (t) => {
  const github = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const { engine: policies } = policyEngine(t, {
    operator: { "github.rego": "package deckhand\n" },
    messages: (input) => (input.action === "comment" ? ["no comments today"] : []),
  });
  const broker = createBroker({ sentFrom: sandboxAt() });
  const gw = createGithubGateway({
    broker,
    app: () => ({ repoToken: async () => ({ token: "t-0123456789abcdef" }) }),
    api: github.url,
    web: "https://github.example",
    checkWrite: createWriteChecks({ lookup: fakeLookup(GITHUB).lookup, policies }).check,
  });
  const { url } = await serve(t, (req, res) => gw.handle(req, res));
  const secret = broker.register("org/repo", undefined, { mode: "work", push: true, issue: 1 });
  const notes = [];
  broker.provide(secret, "anthropic", (line) => notes.push(line));
  const post = (path, body) =>
    fetch(`${url}/relay/127.0.0.1${path}`, {
      method: "POST",
      headers: { authorization: `token ${secret}` },
      body: JSON.stringify(body),
    });
  const res = await post("/repos/org/repo/issues/1/comments", { body: "x" });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), {
    message: "Deckhand: the policies refuse it (deny_github): no comments today",
  });
  assert.match(
    notes[0],
    /refused the run's GitHub write POST \/repos\/org\/repo\/issues\/1\/comments: the policies refuse it/,
  );
  assert.equal((await post("/repos/org/repo/issues/1/labels", { labels: ["a"] })).status, 200);
});

// The real `opa`, when the PATH has it (the listener's image does).
let opa = false;
try {
  execFileSync("opa", ["version"], { stdio: "ignore" });
  opa = true;
} catch {}

test(
  "the real opa: the default policy of docs/repo-config.md narrows the ceilings as it says",
  { skip: !opa && "no opa on the PATH" },
  async (t) => {
    const docs = readFileSync(join(import.meta.dirname, "..", "docs", "repo-config.md"), "utf8");
    const [, template] = /<!-- github\.rego:[^\n]*-->\n\n```rego\n([\s\S]*?)```/.exec(docs);
    const policies = createPolicies({
      config: {},
      github: async () => new Response("{}", { status: 404 }),
      run: opaRunner(),
      readOperator: () => new Map([["github.rego", template]]),
      tmp: tempDir(t),
    });
    const ask = (mode, action, kind, labels_added = [], more = {}) =>
      policies.deny("deny_github", "org/repo", "main", () => ({
        repo: "org/repo",
        mode,
        issue: 1,
        action,
        actions: [action],
        target: {
          kind,
          number: kind.startsWith("new") || kind === "label" ? null : 7,
          labels: [],
          author: "a",
        },
        change: { fields: ["body"], labels_added, labels_removed: [], ...more },
      }));
    assert.deepEqual(await ask("brainstorm", "edit", "own_issue"), []);
    assert.deepEqual(await ask("stop", "create", "new_issue", ["idea"]), []);
    assert.deepEqual(await ask("stop", "link", "own_issue"), []);
    assert.deepEqual(await ask("brainstorm", "comment", "other_issue"), [
      "a brainstorm doesn't comment: its final message is posted as its reply",
      "a brainstorm writes only its own issue, not #7",
    ]);
    assert.deepEqual(await ask("brainstorm", "edit", "sub_issue"), [
      "a brainstorm writes only its own issue, not #7",
    ]);
    // But a brainstorm orders its follow-ups: blocked-by links on them, not sub-issue links.
    const blocked_by = { id: 9, number: 9, kind: "other_issue" };
    for (const kind of ["sub_issue", "created_issue"]) {
      assert.deepEqual(await ask("brainstorm", "link", kind, [], { blocked_by }), [], kind);
    }
    assert.deepEqual(await ask("brainstorm", "link", "sub_issue"), [
      "a brainstorm writes only its own issue, not #7",
    ]);
    assert.deepEqual(await ask("brainstorm", "link", "other_issue", [], { blocked_by }), [
      "a brainstorm writes only its own issue, not #7",
    ]);
    assert.deepEqual(await ask("idea", "create", "new_issue", ["idea", "ui"]), []);
    assert.deepEqual(await ask("bug", "create", "label", ["bug"]), []);
    assert.deepEqual(await ask("bug", "link", "other_issue"), []);
    assert.deepEqual(await ask("idea", "create", "new_issue", ["ui"]), [
      "idea entries' issues carry the idea label",
    ]);
    assert.deepEqual(await ask("bug", "comment", "own_issue"), ["bug entries only file issues"]);
    // Work runs and discussions: their ceilings, as they are.
    assert.deepEqual(await ask("work", "comment", "own_pr"), []);
    assert.deepEqual(await ask("work", "create", "label", ["a"]), []);
    assert.deepEqual(await ask("plan", "create", "label", ["a"]), []);
    assert.deepEqual(await ask("work", "label", "sub_issue", ["a"]), []);
    assert.deepEqual(await ask("discussion", "create", "new_issue"), []);
  },
);

test(
  "the real opa: a repo narrows label creation to one of its modes",
  { skip: !opa && "no opa on the PATH" },
  async (t) => {
    const rego = `package deckhand

deny_github contains "only plan runs create labels" if {
  input.target.kind == "label"
  input.mode != "plan"
}
`;
    const policies = createPolicies({
      config: {},
      github: async () => new Response("{}", { status: 404 }),
      run: opaRunner(),
      readOperator: () => new Map([["github.rego", rego]]),
      tmp: tempDir(t),
    });
    const { check } = createWriteChecks({ lookup: fakeLookup(GITHUB).lookup, policies });
    const label = write("POST", "repos/org/repo/labels", { name: "a", color: "fff" });
    assert.equal(await check(run("plan", { push: true }), label), null);
    assert.deepEqual(await check(run("work"), label), {
      status: 403,
      message: "the policies refuse it (deny_github): only plan runs create labels",
    });
    // Labelling its sub-issue is still the work run's.
    const sub = write("POST", "repos/org/repo/issues/2/labels", { labels: ["a"] });
    assert.equal(await check(run("work"), sub), null);
  },
);
