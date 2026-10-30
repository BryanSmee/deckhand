// A run's REST writes (github-writes.mjs): classified, their target's kind resolved from GitHub,
// held to their mode's ceiling (modes.mjs) and the policies' `deny_github`. GraphQL's are
// github-graphql.test.mjs's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { createComments } from "../listener/comments.mjs";
import { createGithubGateway } from "../listener/github-gateway.mjs";
import {
  aboveCeiling,
  classify,
  createReadChecks,
  createWriteChecks,
  runTraits,
} from "../listener/github-writes.mjs";
import { ceilingOf, MODES } from "../listener/modes.mjs";
import { builtInPolicies, createPolicies, opaRunner } from "../listener/policies.mjs";
import { policyEngine, sandboxAt, serve, tempDir, hasOpa } from "./helpers.mjs";

const json = (value) => Buffer.from(JSON.stringify(value));

// When the tests' runs sent their creates, and GitHub's time `s` seconds from then.
const START = Date.parse("2026-10-29T10:00:00Z");
const at = (s) => new Date(START + s * 1000).toISOString();
const BOT = () => "deckhand[bot]";

// The real `opa`, when the PATH has it (the listener's image does).
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
    // An issue's comment by its id, checked against those the run posted; a review's, never.
    [
      "PATCH",
      "repos/org/repo/issues/comments/5",
      { body: "x" },
      { actions: ["edit"], target: { comment: 5 } },
    ],
    [
      "DELETE",
      "repos/org/repo/issues/comments/5",
      null,
      { actions: ["delete"], target: { comment: 5 } },
    ],
    [
      "PATCH",
      "repos/org/repo/pulls/comments/5",
      { body: "x" },
      { actions: ["edit"], target: { kind: "comment" } },
    ],
    // Reactions: on an issue or pull request, or on a comment, whose issue is looked up.
    [
      "POST",
      "repos/org/repo/issues/12/reactions",
      { content: "+1" },
      { actions: ["react"], target: { number: 12 } },
    ],
    [
      "DELETE",
      "repos/org/repo/issues/12/reactions/77",
      null,
      { actions: ["unreact"], target: { number: 12 } },
    ],
    [
      "POST",
      "repos/org/repo/issues/comments/5/reactions",
      { content: "eyes" },
      { actions: ["react"], target: { reacted: { id: 5, type: "issue" } } },
    ],
    [
      "DELETE",
      "repos/org/repo/pulls/comments/5/reactions/77",
      null,
      { actions: ["unreact"], target: { reacted: { id: 5, type: "review" } } },
    ],
    ["POST", "repos/org/repo/pulls/3/reviews", { event: "APPROVE" }, { actions: ["review"] }],
    // A reply in a review thread, on its pull request; a review comment outside one stays a review.
    [
      "POST",
      "repos/org/repo/pulls/3/comments/4/replies",
      { body: "x" },
      { actions: ["reply"], target: { number: 3 }, fields: ["body"] },
    ],
    ["POST", "repos/org/repo/pulls/3/comments", { body: "x" }, { actions: ["review"] }],
    [
      "POST",
      "repos/org/repo/pulls/3/comments",
      { body: "x", in_reply_to: 4 },
      { actions: ["review"] },
    ],
    ["PATCH", "repos/org/repo/pulls/3/comments/4/replies", { body: "x" }, { actions: ["review"] }],
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
  // A reply names its thread's comment, and gets the token pull requests' writes get.
  const reply = classify("POST", "repos/org/repo/pulls/3/comments/4/replies", json({ body: "x" }));
  assert.deepEqual(reply.thread, { comment: 4 });
  assert.deepEqual(reply.permissions, { pull_requests: "write" });
  assert.equal(reply.pull, undefined);
  assert.equal(
    classify("PUT", "repos/org/repo/issues/12/labels", json(["a"])).change.labels_set,
    true,
  );
  // A reaction's subject, as the run's own are kept.
  for (const [method, path, body, reaction] of [
    ["POST", "issues/3/reactions", { content: "+1" }, { subject: "issue:3", content: "+1" }],
    ["DELETE", "issues/3/reactions/9", null, { subject: "issue:3", id: 9 }],
    [
      "POST",
      "issues/comments/5/reactions",
      { content: "eyes" },
      { subject: "issue_comment:5", content: "eyes" },
    ],
    ["DELETE", "pulls/comments/5/reactions/9", null, { subject: "review_comment:5", id: 9 }],
  ]) {
    const body_ = body === null ? Buffer.alloc(0) : json(body);
    assert.deepEqual(classify(method, `repos/org/repo/${path}`, body_).reaction, reaction, path);
  }
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
  // It edits and deletes the comments it posted; another's are refused before (checkWrite()).
  assert.deepEqual(aboveCeiling(work, "created_comment", ["edit", "delete"]), []);
  assert.deepEqual(aboveCeiling(work, "comment", ["edit"]), ["edit"]);
  // Review threads: its own pull requests' only.
  const threads = ["reply", "resolve", "unresolve"];
  assert.deepEqual(aboveCeiling(work, "own_pr", threads), []);
  assert.deepEqual(aboveCeiling(work, "pr", threads), threads);
  const brainstorm = ceilingOf("brainstorm", true);
  assert.deepEqual(aboveCeiling(brainstorm, "created_comment", ["edit"]), ["edit"]);
  assert.deepEqual(aboveCeiling(brainstorm, "other_issue", ["comment"]), []);
  assert.deepEqual(aboveCeiling(brainstorm, "own_issue", ["label"]), ["label"]);
  assert.deepEqual(ceilingOf("stop", true), brainstorm);
  assert.deepEqual(aboveCeiling(ceilingOf("idea", true), "new_issue", ["create"]), []);
  assert.deepEqual(aboveCeiling(ceilingOf("bug", true), "own_issue", ["edit"]), ["edit"]);
  assert.deepEqual(ceilingOf("discussion", true), { new_issue: ["create"] });
  // Projects: a work run's issue, pull requests, sub-issues and filed issues; a brainstorm's
  // filed issues; nothing else's (issue #454).
  for (const kind of ["own_issue", "own_pr", "sub_issue", "created_issue"]) {
    assert.deepEqual(aboveCeiling(work, kind, ["project"]), [], kind);
  }
  assert.deepEqual(aboveCeiling(work, "other_issue", ["project"]), ["project"]);
  assert.deepEqual(aboveCeiling(work, "pr", ["project"]), ["project"]);
  assert.deepEqual(aboveCeiling(brainstorm, "created_issue", ["project"]), []);
  for (const kind of ["own_issue", "sub_issue", "own_pr", "other_issue"]) {
    assert.deepEqual(aboveCeiling(brainstorm, kind, ["project"]), ["project"], kind);
  }
  for (const mode of ["idea", "bug", "discussion"]) {
    assert.ok(!Object.values(ceilingOf(mode, true)).flat().includes("project"), mode);
  }
  // Modes that read write nothing; a repo's light modes neither, its others as work runs.
  for (const mode of ["onboarding", "analyze", "review", "research", "policy"]) {
    assert.deepEqual(ceilingOf(mode, true), {}, mode);
  }
  // Assignees and milestones: a work run's on its issue, pull requests, sub-issues and the issues
  // it files; a brainstorm's milestone on the issues it files only (issue #453).
  for (const kind of ["own_issue", "own_pr", "sub_issue", "created_issue", "new_issue", "new_pr"]) {
    assert.deepEqual(aboveCeiling(work, kind, ["assign", "milestone"]), [], kind);
  }
  assert.deepEqual(aboveCeiling(work, "other_issue", ["assign", "milestone"]), [
    "assign",
    "milestone",
  ]);
  assert.deepEqual(aboveCeiling(work, "pr", ["milestone"]), ["milestone"]);
  assert.deepEqual(aboveCeiling(brainstorm, "created_issue", ["milestone"]), []);
  assert.deepEqual(aboveCeiling(brainstorm, "new_issue", ["create", "milestone"]), []);
  for (const kind of ["own_issue", "sub_issue", "other_issue", "own_pr"]) {
    assert.deepEqual(aboveCeiling(brainstorm, kind, ["milestone"]), ["milestone"], kind);
  }
  for (const mode of ["brainstorm", "idea", "bug", "discussion"]) {
    const { ceiling } = MODES[mode];
    assert.ok(!Object.values(ceiling).flat().includes("assign"), mode);
  }
  assert.deepEqual(ceilingOf("triage", true), {});
  assert.deepEqual(ceilingOf("deploy", false), work);
  assert.deepEqual(ceilingOf(null, false), {});
  // No ceiling holds what stays out of every one.
  for (const [mode, { ceiling = {} }] of Object.entries(MODES)) {
    for (const actions of Object.values(ceiling)) {
      for (const out of ["close", "reopen", "merge", "review", "lock"]) {
        assert.ok(!actions.includes(out), `${mode}: ${out}`);
      }
    }
    // Deleting: only the comments a work run posted (the default policy refuses it).
    for (const [kind, actions] of Object.entries(ceiling)) {
      if (kind !== "created_comment") assert.ok(!actions.includes("delete"), `${mode}: ${kind}`);
    }
    // Review threads: a work run's own pull requests' only.
    for (const [kind, actions] of Object.entries(ceiling)) {
      if (ceiling !== work || kind !== "own_pr") {
        for (const a of ["reply", "resolve", "unresolve"]) {
          assert.ok(!actions.includes(a), `${mode} ${kind}: ${a}`);
        }
      }
    }
    // A label's settings: created only, never edited or deleted.
    assert.deepEqual(aboveCeiling(ceiling, "label", ["edit", "delete"]), ["edit", "delete"], mode);
  }
});

// A fake GitHub for the look-ups: issues by number (a `pull_request` field for a pull
// request), pull requests' heads, issues' parents (a number: in the repo; else GitHub's
// parent), issues' sub-issues, the repo's open issues (newest first, by pages of 100), its
// issues' and pull requests' comments and review comments by their id, its milestones.
function fakeLookup({
  issues = {},
  pulls = {},
  parents = {},
  subs = {},
  open = [],
  comments = {},
  reviewComments = {},
  milestones = {},
} = {}) {
  const calls = [];
  const lookup = async (repo, path) => {
    calls.push(path);
    const comment = /^\/repos\/org\/repo\/(issues|pulls)\/comments\/(\d+)$/.exec(path);
    if (comment) return (comment[1] === "pulls" ? reviewComments : comments)[comment[2]] ?? null;
    const milestone = /^\/repos\/org\/repo\/milestones\/(\d+)$/.exec(path);
    if (milestone) return milestones[milestone[1]] ?? null;
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
  milestones: { 3: { number: 3, title: "v1" } },
  // Open: #3, and #8, a pull request, as GitHub's issues list them.
  open: [
    { number: 8, id: 908, pull_request: {} },
    { number: 3, id: 903 },
  ],
  // On #1, alice's and the bot's; on #3, bob's; on another repository's #1.
  comments: {
    // On #2, a sub-issue of the run's.
    21: {
      id: 21,
      user: { login: "alice" },
      issue_url: "https://api.github.com/repos/org/repo/issues/2",
    },
    11: {
      id: 11,
      user: { login: "alice" },
      issue_url: "https://api.github.com/repos/Org/Repo/issues/1",
    },
    12: {
      id: 12,
      user: { login: "deckhand[bot]" },
      issue_url: "https://api.github.com/repos/org/repo/issues/1",
    },
    13: {
      id: 13,
      user: { login: "bob" },
      issue_url: "https://api.github.com/repos/org/repo/issues/3",
    },
    14: {
      id: 14,
      user: { login: "bob" },
      issue_url: "https://api.github.com/repos/org/other/issues/1",
    },
  },
  // On its pull request #7, and on #8, another branch's. Review threads: on #7, Deckhand's
  // review's (40), a person's (41) and a reply in it (42); on #8, another pull request's (43).
  reviewComments: {
    40: {
      id: 40,
      user: { login: "Deckhand[bot]" },
      pull_request_url: "https://api.github.com/repos/Org/Repo/pulls/7",
    },
    41: {
      id: 41,
      user: { login: "alice" },
      pull_request_url: "https://api.github.com/repos/Org/Repo/pulls/7",
    },
    42: {
      id: 42,
      in_reply_to_id: 41,
      user: { login: "deckhand[bot]" },
      pull_request_url: "https://api.github.com/repos/Org/Repo/pulls/7",
    },
    43: {
      id: 43,
      user: { login: "bob" },
      pull_request_url: "https://api.github.com/repos/Org/Repo/pulls/8",
    },
    17: {
      id: 17,
      user: { login: "bob" },
      pull_request_url: "https://api.github.com/repos/org/repo/pulls/7",
    },
    18: {
      id: 18,
      user: { login: "bob" },
      pull_request_url: "https://api.github.com/repos/org/repo/pulls/8",
    },
  },
};
function run(mode, { push = mode === "work", issue = 1, branches = ["issue-1-*"] } = {}) {
  const branch = push ? branches : [];
  return { repo: "org/repo", mode, push, issue, base: "main", branches: branch, created: [] };
}

const write = (method, path, body = {}) => ({ method, path, body: json(body) });

test("a work run writes its issue, its pull requests and its sub-issues, nothing else", async () => {
  const { lookup } = fakeLookup(GITHUB);
  const { check } = createWriteChecks({ needsInputLabel: () => null, lookup });
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
    [write("DELETE", "repos/org/repo/labels/a"), /can't delete on label \(its ceiling\)/],
    [write("PATCH", "repos/org/repo/issues/1", { state: "closed" }), /can't close here/],
    [write("PUT", "repos/org/repo/pulls/7/merge"), /can't merge here/],
    [write("POST", "repos/org/repo/pulls/7/reviews", { event: "APPROVE" }), /can't review here/],
    [
      write("PATCH", "repos/org/repo/issues/comments/5", { body: "x" }),
      /can edit only the comments it posted/,
    ],
    [write("PATCH", "repos/org/repo/pulls/comments/5", { body: "x" }), /can't edit here/],
    [write("POST", "repos/other/repo/issues/1/comments", { body: "x" }), /its own repository/],
    [write("PUT", "repos/org/repo/contents/a", {}), /can't tell what this write does/],
    [write("POST", "repos/org/repo/issues/99/comments", { body: "x" }), /#99 isn't there/],
    // An issue whose parent is another repository's #1 isn't its sub-issue.
    [write("PATCH", "repos/org/repo/issues/4", { body: "x" }), /can't edit on other_issue #4/],
    // Its ceiling holds assignees, but the repository's allowed users only.
    [
      write("POST", "repos/org/repo/issues", { title: "x", assignees: ["a"] }),
      /assigns only the repository's allowed users or its own bot, not @a/,
    ],
    [write("PATCH", "repos/org/repo/issues/3", { milestone: 3 }), /can't milestone on other_issue/],
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
  const { check } = createWriteChecks({ needsInputLabel: () => null, lookup });
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
    needsInputLabel: () => null,
    lookup: async () => {
      throw new Error("down");
    },
  });
  const failed = await broken.check(work, write("POST", "repos/org/repo/issues/1/comments", {}));
  assert.equal(failed.status, 502);
});

test("light runs: brainstorms, inbox entries, discussions and the modes that read", async () => {
  const { check } = createWriteChecks({
    needsInputLabel: () => null,
    lookup: fakeLookup(GITHUB).lookup,
  });
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
  const { answered } = createWriteChecks({
    needsInputLabel: () => null,
    lookup: fakeLookup(GITHUB).lookup,
  });
  const work = run("work");
  let saved = 0;
  work.changed = () => saved++;
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

// GitHub's answers to comments: `gh issue comment`'s GraphQL call (its URL is the web page's,
// `/pull/` on a pull request), whose addComment answers under `addComment` (github-graphql.mjs
// `comments`), and a REST one (its URL is the API's).
const GRAPHQL_COMMENT = {
  method: "POST",
  path: "graphql",
  body: json({
    query:
      "mutation CommentCreate($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { url } } } }",
  }),
  graphql: true,
  comments: ["addComment"],
  at: START,
};
const commented = (id, repo = "Org/Repo", on = "issues/1") =>
  json({
    data: {
      addComment: {
        commentEdge: { node: { url: `https://github.com/${repo}/${on}#issuecomment-${id}` } },
      },
    },
  });
const REST_COMMENT = {
  ...write("POST", "repos/org/repo/issues/7/comments", { body: "x" }),
  at: START,
};
const restComment = (id, repo = "Org/Repo") =>
  json({
    id,
    url: `https://api.github.com/repos/${repo}/issues/comments/${id}`,
    html_url: `https://github.com/${repo}/pull/7#issuecomment-${id}`,
  });

test("the comments a run posted: GitHub's answers to its own comments, REST and GraphQL", () => {
  const { answered } = createWriteChecks({
    needsInputLabel: () => null,
    lookup: fakeLookup(GITHUB).lookup,
  });
  const work = run("work");
  let saved = 0;
  work.changed = () => saved++;
  answered(work, GRAPHQL_COMMENT, 200, commented(3000000001));
  answered(work, GRAPHQL_COMMENT, 200, commented(3000000002, "Org/Repo", "pull/7"));
  answered(work, REST_COMMENT, 201, restComment(3000000003));
  // Again, refused by GitHub, another repository's, a call that posted none (its answer names
  // one all the same), an issue created, not a comment.
  answered(work, GRAPHQL_COMMENT, 200, commented(3000000001));
  answered(work, GRAPHQL_COMMENT, 502, commented(41));
  answered(work, REST_COMMENT, 422, restComment(42));
  answered(work, GRAPHQL_COMMENT, 200, commented(43, "org/other"));
  answered(work, REST_COMMENT, 201, restComment(44, "org/other"));
  answered(work, { ...GRAPHQL_COMMENT, comments: [] }, 200, commented(45));
  answered(work, REST_CREATE, 201, restComment(46));
  answered(
    work,
    GRAPHQL_COMMENT,
    200,
    json({ data: { addComment: { commentEdge: { node: { url: "https://github.com/x" } } } } }),
  );
  // Its issues beside them, which a link's child is looked for among.
  answered(work, GRAPHQL_CREATE, 200, created(30));
  assert.deepEqual(work.created, [
    { comment: 3000000001, at: START },
    { comment: 3000000002, at: START },
    { comment: 3000000003, at: START },
    { number: 30, at: START },
  ]);
  assert.equal(saved, 4);
});

// Comments as GitHub has them: those the tests' runs posted, the listener's (its live progress
// comment, also the bot's) and a person's.
const COMMENTS = {
  3000000001: {
    id: 3000000001,
    user: { login: "deckhand[bot]" },
    issue_url: "https://api.github.com/repos/Org/Repo/issues/1",
  },
  3000000002: {
    id: 3000000002,
    user: { login: "deckhand[bot]" },
    issue_url: "https://api.github.com/repos/Org/Repo/issues/7",
  },
  3000000009: {
    id: 3000000009,
    user: { login: "deckhand[bot]" },
    issue_url: "https://api.github.com/repos/Org/Repo/issues/1",
  },
  3000000010: {
    id: 3000000010,
    user: { login: "alice" },
    issue_url: "https://api.github.com/repos/Org/Repo/issues/1",
  },
};

test("a run edits and deletes the comments it posted, never the listener's, another run's or a person's", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "github.rego": "package deckhand\n" },
  });
  const { lookup, calls } = fakeLookup({ ...GITHUB, comments: COMMENTS });
  const { check, answered } = createWriteChecks({
    lookup,
    bot: BOT,
    needsInputLabel: () => null,
    policies,
  });
  const work = run("work");
  answered(work, GRAPHQL_COMMENT, 200, commented(3000000001));
  answered(work, REST_COMMENT, 201, restComment(3000000002));
  // Its own: edited and deleted, as its ceiling holds (the default policy narrows it below).
  const edit = write("PATCH", "repos/org/repo/issues/comments/3000000001", { body: "fixed" });
  assert.equal(await check(work, edit), null);
  assert.deepEqual(evals.at(-1), {
    rule: "deny_github",
    version: 1,
    repo: "org/repo",
    mode: "work",
    custom_mode: false,
    light: false,
    reason: null,
    issue: 1,
    action: "edit",
    actions: ["edit"],
    target: {
      number: 1,
      comment: 3000000001,
      labels: [],
      author: "deckhand[bot]",
      kind: "created_comment",
    },
    change: { fields: ["body"], labels_added: [], labels_removed: [] },
  });
  assert.equal(
    await check(work, write("DELETE", "repos/org/repo/issues/comments/3000000002")),
    null,
  );
  assert.equal(evals.at(-1).target.number, 7);
  // The listener's, a person's, another run's: refused before any look-up or policy, saying
  // what to send instead.
  const asked = evals.length;
  const looked = calls.length;
  for (const id of [3000000009, 3000000010, 3000000003]) {
    const refused = await check(
      work,
      write("PATCH", `repos/org/repo/issues/comments/${id}`, { body: "x" }),
    );
    assert.equal(refused.status, 403);
    assert.match(refused.message, /can edit only the comments it posted, and this isn't one/);
    assert.match(refused.message, /--edit-last/);
    assert.match(refused.message, /gh api -X PATCH repos\/org\/repo\/issues\/comments\/<id>/);
  }
  const deleted = await check(work, write("DELETE", "repos/org/repo/issues/comments/3000000009"));
  assert.match(deleted.message, /gh api -X DELETE repos\/org\/repo\/issues\/comments\/<id>/);
  assert.equal(evals.length, asked);
  assert.equal(calls.length, looked);
  // Another run's list doesn't hold this one's: each run its own.
  const other = run("work");
  assert.match((await check(other, edit)).message, /only the comments it posted/);
  // One GitHub no longer has (deleted since), or that isn't the bot's: refused.
  work.created.push({ comment: 3000000010, at: START }, { comment: 3000000020, at: START });
  assert.deepEqual(
    await check(work, write("PATCH", "repos/org/repo/issues/comments/3000000010", { body: "x" })),
    { status: 404, message: "comment 3000000010 isn't there" },
  );
  assert.equal(
    (await check(work, write("DELETE", "repos/org/repo/issues/comments/3000000020"))).status,
    404,
  );
  // Above a mode's ceiling: a brainstorm's replies are the listener's, an inbox entry's too.
  for (const mode of ["brainstorm", "idea", "review"]) {
    const light = { ...run(mode), created: [{ comment: 3000000001, at: START }] };
    const refused = await check(light, edit);
    assert.match(refused.message, /can't edit .*\(its ceiling\)/, mode);
  }
  // A review's comments stay refused, whoever wrote them.
  assert.match(
    (await check(work, write("PATCH", "repos/org/repo/pulls/comments/3000000001", { body: "x" })))
      .message,
    /can't edit here/,
  );
});

test(
  "the real opa: Deckhand's gh-own-comments.rego lets work runs edit their comments, and a repo's same-name file lets them delete",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    // Deckhand's own, as the image ships it.
    const rego = builtInPolicies().get("gh-own-comments.rego");
    // The repo's own files (name → text) in its .deckhand/policy/.
    let files = {};
    const policies = createPolicies({
      config: {},
      github: async (repo, method, path) => {
        if (path === "/repos/org/repo/contents/.deckhand/policy?ref=main") {
          return Response.json(
            Object.keys(files).map((name) => ({ type: "file", name, sha: name })),
          );
        }
        const name = path.split("/").pop();
        if (path.startsWith("/repos/org/repo/git/blobs/") && name in files) {
          const content = Buffer.from(files[name]).toString("base64");
          return Response.json({ content, encoding: "base64" });
        }
        return new Response("{}", { status: 404 });
      },
      run: opaRunner(),
      readOperator: () => new Map(),
      readBuiltIn: () => new Map([["gh-own-comments.rego", rego]]),
      tmp: tempDir(t),
      now: (() => {
        let clock = 0;
        // Each decision a day apart: the repo's listing is read again.
        return () => (clock += 86_400_000);
      })(),
    });
    const { check, answered } = createWriteChecks({
      lookup: fakeLookup({ ...GITHUB, comments: COMMENTS }).lookup,
      bot: BOT,
      needsInputLabel: () => null,
      policies,
    });
    const posted = (mode) => {
      const r = run(mode, { push: true });
      answered(r, GRAPHQL_COMMENT, 200, commented(3000000001));
      return r;
    };
    const edit = write("PATCH", "repos/org/repo/issues/comments/3000000001", { body: "x" });
    const remove = write("DELETE", "repos/org/repo/issues/comments/3000000001");
    assert.equal(await check(posted("work"), edit), null);
    assert.deepEqual(await check(posted("work"), remove), {
      status: 403,
      message:
        "the policies refuse it (deny_github): a run doesn't delete its comments unless .deckhand/policy/gh-own-comments.rego lets it: edit yours instead",
    });
    // The repository's own modes: neither, unless it says so.
    assert.match(
      (await check(posted("deploy"), edit)).message,
      /a deploy run doesn't change its comments unless/,
    );
    // Other writes aren't this file's.
    assert.equal(
      await check(posted("deploy"), write("POST", "repos/org/repo/issues/1/comments", {})),
      null,
    );
    // A repository's same-name file replaces it: here, without the rule on deleting.
    files = {
      "gh-own-comments.rego": rego.replace(/\n# A deleted comment[\s\S]*$/, "\n"),
    };
    assert.equal(await check(posted("work"), remove), null);
    assert.match((await check(posted("deploy"), remove)).message, /a deploy run doesn't change/);
  },
);

// GitHub Actions for the reruns' look-ups (issue #451), over fakeLookup(GITHUB): workflow runs
// and jobs by id, and the open pull requests of a branch, with their head commits. #7 is the
// work run's (issue-1-thing at `aaa`), #9 another branch's (`bbb`).
const ACTIONS = {
  runs: {
    100: {
      event: "pull_request",
      head_branch: "issue-1-thing",
      head_sha: "aaa",
      conclusion: "failure",
      run_attempt: 1,
      name: "CI",
      path: ".github/workflows/ci.yml",
    },
    101: {
      event: "push",
      head_branch: "issue-1-thing",
      head_sha: "aaa",
      conclusion: "success",
      run_attempt: 1,
    },
    102: {
      event: "push",
      head_branch: "issue-1-thing",
      head_sha: "old",
      conclusion: "failure",
      run_attempt: 1,
    },
    103: {
      event: "pull_request",
      head_branch: "issue-2-other",
      head_sha: "bbb",
      conclusion: "failure",
      run_attempt: 1,
    },
    104: {
      event: "workflow_dispatch",
      head_branch: "issue-1-thing",
      head_sha: "aaa",
      conclusion: "failure",
      run_attempt: 1,
    },
    105: {
      event: "pull_request",
      head_branch: "issue-1-thing",
      head_sha: "aaa",
      conclusion: "failure",
      run_attempt: 1,
      fork: true,
    },
    106: {
      event: "push",
      head_branch: "issue-1-thing",
      head_sha: "aaa",
      conclusion: null,
      run_attempt: 2,
    },
    107: {
      event: "push",
      head_branch: "issue-1-thing",
      head_sha: "aaa",
      conclusion: "timed_out",
      run_attempt: 2,
      name: "E2E",
      path: ".github/workflows/e2e.yml",
    },
  },
  jobs: {
    500: { run_id: 100, head_sha: "aaa", conclusion: "failure", run_attempt: 1, name: "test" },
    501: { run_id: 100, head_sha: "aaa", conclusion: "success", run_attempt: 1, name: "lint" },
  },
  heads: {
    "issue-1-thing": [{ number: 7, head: { sha: "aaa", repo: { full_name: "Org/Repo" } } }],
    "issue-2-other": [{ number: 9, head: { sha: "bbb", repo: { full_name: "org/repo" } } }],
  },
};
function rerunLookup() {
  const github = {
    ...GITHUB,
    issues: {
      ...GITHUB.issues,
      9: { number: 9, pull_request: {}, user: { login: "bob" }, labels: [] },
    },
    pulls: {
      ...GITHUB.pulls,
      9: { head: { ref: "issue-2-other", repo: { full_name: "org/repo" } } },
    },
  };
  const fake = fakeLookup(github);
  const lookup = async (repo, path) => {
    const m = /^\/repos\/org\/repo\/actions\/(runs|jobs)\/(\d+)$/.exec(path);
    if (m && m[1] === "jobs") return ACTIONS.jobs[m[2]] ?? null;
    if (m) {
      const found = ACTIONS.runs[m[2]];
      if (!found) return null;
      const { fork, ...rest } = found;
      return {
        id: +m[2],
        ...rest,
        head_repository: { full_name: fork ? "mallory/repo" : "Org/Repo" },
      };
    }
    const head = /^\/repos\/org\/repo\/pulls\?head=org%3A([^&]+)&state=open&per_page=100$/.exec(
      path,
    );
    if (head) return ACTIONS.heads[decodeURIComponent(head[1])] ?? [];
    return fake.lookup(repo, path);
  };
  return { lookup, calls: fake.calls };
}

test("classify: reruns of a workflow run's failed jobs and of a job, with actions: write", () => {
  assert.deepEqual(
    classify("POST", "repos/Org/Repo/actions/runs/100/rerun-failed-jobs", json({})),
    {
      repo: "org/repo",
      actions: ["rerun"],
      target: { run_id: 100 },
      permissions: { actions: "write" },
      change: { fields: [], labels_added: [], labels_removed: [] },
    },
  );
  const job = classify(
    "POST",
    "repos/org/repo/actions/jobs/500/rerun",
    json({ enable_debug_logging: true }),
  );
  assert.deepEqual(
    [job.actions, job.target, job.change.fields, job.debug],
    [["rerun"], { job_id: 500 }, ["enable_debug_logging"], true],
  );
  // Debug logs asked for, however GitHub would read it; `false` or none is a plain rerun.
  for (const value of [true, "true", 1, "false", null]) {
    const body = json({ enable_debug_logging: value });
    const got = classify("POST", "repos/org/repo/actions/runs/100/rerun-failed-jobs", body);
    assert.equal(got.debug, true, String(value));
  }
  for (const body of [json({ enable_debug_logging: false }), json({}), Buffer.alloc(0)]) {
    const got = classify("POST", "repos/org/repo/actions/runs/100/rerun-failed-jobs", body);
    assert.equal(got.debug, undefined);
  }
  // Not a whole run's rerun, cancelling, dispatching, approving a fork's run or deleting logs.
  for (const [method, path] of [
    ["POST", "repos/org/repo/actions/runs/100/rerun"],
    ["POST", "repos/org/repo/actions/runs/100/cancel"],
    ["POST", "repos/org/repo/actions/runs/100/force-cancel"],
    ["POST", "repos/org/repo/actions/runs/100/approve"],
    ["POST", "repos/org/repo/actions/workflows/ci.yml/dispatches"],
    ["DELETE", "repos/org/repo/actions/runs/100/logs"],
    ["DELETE", "repos/org/repo/actions/runs/100"],
  ]) {
    assert.equal(classify(method, path, json({})), null, `${method} ${path}`);
  }
});

test("a rerun: the failed runs of its own pull request's head, from GitHub, at most MAX_RERUNS times", async () => {
  const { lookup } = rerunLookup();
  const { check } = createWriteChecks({ needsInputLabel: () => null, lookup });
  const rerun = (id) => write("POST", `repos/org/repo/actions/runs/${id}/rerun-failed-jobs`);
  const job = (id) => write("POST", `repos/org/repo/actions/jobs/${id}/rerun`);
  const work = { ...run("work"), reruns: [] };
  // Each passes, its slot freed again (GitHub refused it, say) before the next.
  const passes = async (r, w) => {
    assert.equal(await check(r, w), null, w.path);
    w.rerun.release();
  };
  await passes(work, rerun(100));
  await passes(work, job(500));
  await passes(work, rerun(107));
  // A fix run on the pull request itself: its own too.
  await passes({ ...run("work", { issue: 7 }), reruns: [] }, rerun(100));
  // No debug logs: refused before any look-up, a job's too.
  for (const w of [
    write("POST", "repos/org/repo/actions/runs/100/rerun-failed-jobs", {
      enable_debug_logging: true,
    }),
    write("POST", "repos/org/repo/actions/jobs/500/rerun", { enable_debug_logging: "true" }),
  ]) {
    assert.deepEqual(await check(work, w), {
      status: 403,
      message: "a run reruns GitHub Actions jobs without debug logs (enable_debug_logging)",
    });
  }
  await passes(
    work,
    write("POST", "repos/org/repo/actions/runs/100/rerun-failed-jobs", {
      enable_debug_logging: false,
    }),
  );
  const refused = [
    [rerun(101), 403, /reruns only the failed .*: workflow run 101 ended with success/],
    [rerun(106), 403, /workflow run 106 hasn't finished/],
    [job(501), 403, /job 501 ended with success/],
    [rerun(102), 403, /old isn't the head of an open pull request of issue-1-thing/],
    [rerun(104), 403, /ran on workflow_dispatch, not a push or a pull request/],
    [rerun(105), 403, /workflow run 105 isn't of a branch of org\/repo/],
    // Another pull request's: above the ceiling.
    [rerun(103), 403, /a work run can't rerun on pr #9 \(its ceiling\)/],
    [rerun(999), 404, /workflow run 999 isn't there/],
    [job(999), 404, /job 999 isn't there/],
    [
      write("POST", "repos/org/repo/actions/runs/100/rerun"),
      403,
      /can't tell what this write does/,
    ],
  ];
  for (const [w, status, why] of refused) {
    const got = await check(work, w);
    assert.equal(got?.status, status, w.path);
    assert.match(got.message, why, w.path);
  }
  // Light runs and the modes without it: their ceiling, before any look-up.
  for (const mode of ["brainstorm", "idea", "review", "ask"]) {
    assert.match((await check(run(mode), rerun(100))).message, /can't rerun here \(its ceiling\)/);
  }
  // Twice per head commit, its workflow runs' and jobs' reruns alike; another commit's don't count.
  const twice = {
    ...work,
    reruns: [
      { run_id: 100, sha: "aaa" },
      { run_id: 107, sha: "aaa" },
    ],
  };
  for (const w of [rerun(100), job(500), rerun(107)]) {
    assert.match(
      (await check(twice, w)).message,
      /a run reruns GitHub Actions jobs at most 2 times per head commit, and it reran or is rerunning 2 on aaa/,
    );
  }
  const before = {
    ...work,
    reruns: [
      { run_id: 90, sha: "old" },
      { run_id: 91, sha: "old" },
    ],
  };
  assert.equal(await check(before, rerun(100)), null);
});

test("a rerun GitHub took is kept on the run, as its check resolved it, without asking again", async () => {
  const { lookup: resolving } = rerunLookup();
  // GitHub can't be read once the check is over: what it resolved is kept all the same.
  let down = false;
  const lookup = (repo, path) => (down ? Promise.reject(new Error("down")) : resolving(repo, path));
  const { check, answered } = createWriteChecks({ needsInputLabel: () => null, lookup });
  const work = { ...run("work"), reruns: [] };
  let saved = 0;
  work.changed = () => saved++;
  const checked = async (path) => {
    const call = { ...write("POST", path), graphql: false, at: START };
    assert.equal(await check(work, call), null, path);
    return call;
  };
  const job = await checked("repos/org/repo/actions/jobs/500/rerun");
  assert.deepEqual([job.rerun.run_id, job.rerun.sha], [100, "aaa"]);
  // Its slot is on the run, saved, before the call goes out: a restart meanwhile still counts it.
  assert.deepEqual(
    work.reruns.map((r) => [r.run_id, r.sha, r.pending]),
    [[100, "aaa", true]],
  );
  assert.equal(saved, 1);
  // Refused by GitHub: not counted, its slot free again.
  const refused = await checked("repos/org/repo/actions/runs/100/rerun-failed-jobs");
  answered(work, refused, 403, json({}));
  // Not answered at all (0: the gateway's lost answer): it may have gone out, so it counts.
  const lost = { ...run("work"), reruns: [] };
  const lostCall = { ...write("POST", "repos/org/repo/actions/runs/100/rerun-failed-jobs") };
  assert.equal(await check(lost, lostCall), null);
  answered(lost, { ...lostCall, graphql: false, at: START }, 0, Buffer.alloc(0));
  assert.deepEqual(lost.reruns, [{ run_id: 100, sha: "aaa", at: START }]);
  const failed = await checked("repos/org/repo/actions/runs/107/rerun-failed-jobs");
  down = true;
  // Kept at once, before the gateway's answer is over.
  answered(work, job, 201, Buffer.alloc(0));
  answered(work, failed, 201, json({}));
  assert.deepEqual(work.reruns, [
    { run_id: 100, sha: "aaa", at: START },
    { run_id: 107, sha: "aaa", at: START },
  ]);
  assert.ok(!work.reruns.some((r) => r.pending));
  // Saved as each slot is taken, settled or freed.
  assert.equal(saved, 6);
  // A refused check holds no slot and sets nothing to keep.
  down = false;
  const other = write("POST", "repos/org/repo/actions/runs/101/rerun-failed-jobs");
  assert.ok(await check(work, other));
  assert.equal(other.rerun, undefined);
  assert.ok(!work.reruns.some((r) => r.pending));
});

test("reruns at the same time: each takes a slot once its checks pass, so the bound holds", async () => {
  const { lookup } = rerunLookup();
  const { check, answered } = createWriteChecks({ needsInputLabel: () => null, lookup });
  // One rerun done on aaa: one slot left, which two workflow runs' reruns ask for at once.
  const work = { ...run("work"), reruns: [{ run_id: 90, sha: "aaa", at: 1 }] };
  const calls = [100, 107].map((id) => ({
    ...write("POST", `repos/org/repo/actions/runs/${id}/rerun-failed-jobs`),
    graphql: false,
    at: START,
  }));
  const got = await Promise.all(calls.map((c) => check(work, c)));
  assert.equal(got.filter((r) => r === null).length, 1);
  assert.match(
    got.find(Boolean).message,
    /at most 2 times per head commit, and it reran or is rerunning 2 on aaa/,
  );
  const [taken] = calls.filter((c) => c.rerun);
  // Still in flight: a third waits for nothing, refused.
  const third = write("POST", "repos/org/repo/actions/jobs/500/rerun");
  assert.match((await check(work, third)).message, /reran or is rerunning 2/);
  // GitHub refused it: the slot is free again.
  answered(work, taken, 422, json({}));
  assert.equal(await check(work, third), null);
});

test("deny_github: a rerun's input, its workflow run and pull request", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "gh-actions-rerun.rego": "package deckhand\n" },
  });
  const { check } = createWriteChecks({
    needsInputLabel: () => null,
    lookup: rerunLookup().lookup,
    policies,
  });
  const work = { ...run("work"), reason: "ci-fix", reruns: [] };
  await check(work, write("POST", "repos/org/repo/actions/jobs/500/rerun"));
  const { version: _, rule: __, ...input } = evals.at(-1);
  assert.deepEqual(input, {
    repo: "org/repo",
    mode: "work",
    custom_mode: false,
    light: false,
    reason: "ci-fix",
    issue: 1,
    action: "rerun",
    actions: ["rerun"],
    target: {
      kind: "own_pr",
      number: 7,
      labels: [],
      author: "deckhand[bot]",
      run_id: 100,
      sha: "aaa",
      event: "pull_request",
      workflow: { name: "CI", path: ".github/workflows/ci.yml" },
      attempt: 1,
      conclusion: "failure",
      job: { id: 500, name: "test" },
    },
    change: { fields: [], labels_added: [], labels_removed: [] },
  });
  await check(work, write("POST", "repos/org/repo/actions/runs/107/rerun-failed-jobs"));
  assert.deepEqual(
    [evals.at(-1).target.attempt, evals.at(-1).target.conclusion, evals.at(-1).target.job],
    [2, "timed_out", null],
  );
});

test("a sub-issue link: its child is one the run created or already under its issue, never moved", async () => {
  const { lookup } = fakeLookup(GITHUB);
  const { check, answered } = createWriteChecks({ needsInputLabel: () => null, lookup, bot: BOT });
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
  const unknown = createWriteChecks({ needsInputLabel: () => null, lookup });
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
  const { check, answered } = createWriteChecks({ needsInputLabel: () => null, lookup, bot: BOT });
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
  const { check } = createWriteChecks({ needsInputLabel: () => null, lookup });
  const block = { issue_id: 903 };
  const w = write("POST", "repos/org/repo/issues/2/dependencies/blocked_by", block);
  assert.equal(await check(run("work"), w), null);
  assert.equal(calls.filter((c) => c.includes("state=open")).length, 3);
  // Past the pages it reads: not found, refused.
  const many = Array.from({ length: 11 }, (_, p) => filler(p * 100)).flat();
  const far = fakeLookup({ ...GITHUB, open: [...many, { number: 3, id: 903 }] });
  const { check: farCheck } = createWriteChecks({
    needsInputLabel: () => null,
    lookup: far.lookup,
  });
  assert.match((await farCheck(run("work"), w)).message, /an open issue of its repository/);
  assert.equal(far.calls.filter((c) => c.includes("state=open")).length, 10);
});

// GitHub's answer to a run's REST reaction: 201 when it added it, 200 when it was there.
const reacted = (id, content, status = 201) => [status, json({ id, content, user: {} })];

test("reactions: a work run's on its issues, pull requests and their comments, nothing else", async () => {
  const { lookup } = fakeLookup(GITHUB);
  const { check } = createWriteChecks({ needsInputLabel: () => null, lookup, bot: BOT });
  const work = run("work");
  const react = (path) => write("POST", `repos/org/repo/${path}/reactions`, { content: "+1" });
  for (const path of [
    "issues/1",
    "issues/7",
    "issues/2",
    "issues/comments/11",
    "issues/comments/12",
    "pulls/comments/17",
  ]) {
    assert.equal(await check(work, react(path)), null, path);
  }
  for (const [path, status, why] of [
    ["issues/3", 403, /can't react on other_issue #3 \(its ceiling\)/],
    ["issues/8", 403, /can't react on pr #8/],
    // A comment's issue is its target: another's, or another repository's.
    ["issues/comments/13", 403, /can't react on other_issue #3/],
    ["pulls/comments/18", 403, /can't react on pr #8/],
    ["issues/comments/14", 404, /comment 14 isn't there/],
    ["issues/comments/99", 404, /comment 99 isn't there/],
    // A review comment by an issue comment's path is another comment.
    ["pulls/comments/11", 404, /comment 11 isn't there/],
  ]) {
    const got = await check(work, react(path));
    assert.equal(got?.status, status, path);
    assert.match(got.message, why, path);
  }
  // A failing look-up: refused, fail closed.
  const { check: down } = createWriteChecks({
    needsInputLabel: () => null,
    lookup: async () => {
      throw new Error("down");
    },
  });
  assert.equal((await down(work, react("issues/comments/11"))).status, 502);
});

test("reactions: a brainstorm's on its issue and its comments; the modes that don't react", async () => {
  const { lookup } = fakeLookup(GITHUB);
  const { check } = createWriteChecks({ needsInputLabel: () => null, lookup, bot: BOT });
  const react = (path) => write("POST", `repos/org/repo/${path}/reactions`, { content: "eyes" });
  for (const mode of ["brainstorm", "stop"]) {
    assert.equal(await check(run(mode), react("issues/1")), null, mode);
    assert.equal(await check(run(mode), react("issues/comments/11")), null, mode);
    assert.match((await check(run(mode), react("issues/2"))).message, /on sub_issue #2/);
    assert.match((await check(run(mode), react("issues/comments/13"))).message, /other_issue #3/);
    assert.match((await check(run(mode), react("pulls/comments/17"))).message, /on pr #7/);
  }
  for (const mode of ["idea", "bug", "discussion", "onboarding", "analyze", "review"]) {
    assert.match((await check(run(mode), react("issues/1"))).message, /its ceiling/, mode);
  }
});

test("reactions: a run removes only those it added, never the listener's", async () => {
  const { lookup } = fakeLookup(GITHUB);
  const { check, answered } = createWriteChecks({ needsInputLabel: () => null, lookup, bot: BOT });
  const work = { ...run("work"), changed: () => saved++ };
  let saved = 0;
  const post = (path, content) => ({
    method: "POST",
    path: `/repos/org/repo/${path}/reactions`,
    body: json({ content }),
    at: START,
  });
  const remove = (path, id) => write("DELETE", `repos/org/repo/${path}/reactions/${id}`);
  // The listener's 👀 on the comment that triggered the run: the same bot's, never the run's.
  assert.deepEqual(await check(work, remove("issues/comments/11", 501)), {
    status: 403,
    message: "a run removes only the reactions it added, never the listener's or anyone else's",
  });
  // The run adds 👀 where the bot had it already (200): still not its own.
  answered(work, post("issues/comments/11", "eyes"), ...reacted(501, "eyes", 200));
  assert.equal((await check(work, remove("issues/comments/11", 501))).status, 403);
  assert.equal(saved, 0);
  // One it added (201) it removes, by its id, on that comment only.
  answered(work, post("issues/comments/11", "+1"), ...reacted(502, "+1"));
  assert.equal(saved, 1);
  assert.deepEqual(work.created, [
    { reaction: { subject: "issue_comment:11", content: "+1", id: 502 }, at: START },
  ]);
  assert.equal(await check(work, remove("issues/comments/11", 502)), null);
  assert.equal((await check(work, remove("issues/comments/12", 502))).status, 403);
  assert.equal((await check(work, remove("issues/1", 502))).status, 403);
  // On its pull request too, and on a review comment.
  answered(work, post("issues/7", "rocket"), ...reacted(503, "rocket"));
  answered(work, post("pulls/comments/17", "heart"), ...reacted(504, "heart"));
  assert.equal(await check(work, remove("issues/7", 503)), null);
  assert.equal(await check(work, remove("pulls/comments/17", 504)), null);
  // Another repository's, a failed one, the same one twice: not kept.
  answered(
    work,
    { ...post("issues/1", "+1"), path: "/repos/org/other/issues/1/reactions" },
    ...reacted(505, "+1"),
  );
  answered(work, post("issues/1", "+1"), 422, json({ message: "Validation Failed" }));
  answered(work, post("issues/7", "rocket"), ...reacted(503, "rocket"));
  assert.equal(work.created.length, 3);
  // Removed (204), it is no longer the run's: the listener's 👀 on that comment since, the
  // same bot's, isn't.
  answered(work, post("issues/comments/12", "eyes"), ...reacted(510, "eyes"));
  const remove510 = remove("issues/comments/12", 510);
  assert.equal(await check(work, remove510), null);
  saved = 0;
  answered(work, { ...remove510, at: START }, 204, Buffer.alloc(0));
  assert.equal(saved, 1);
  assert.equal(
    work.created.some((c) => c.reaction?.id === 510),
    false,
  );
  assert.equal((await check(work, remove510)).status, 403);
  // A removal GitHub refused keeps it.
  answered(work, { ...remove("issues/7", 503), at: START }, 404, json({}));
  assert.equal(await check(work, remove("issues/7", 503)), null);
  // The issues it created are still read apart from its reactions: none to look up here.
  const link = write("POST", "repos/org/repo/issues/1/sub_issues", { sub_issue_id: 999 });
  assert.match((await check(work, link)).message, /links only issues it created/);
});

test("reactions: never one the listener added, on any task's comment, though the run's came first", async () => {
  // The listener's reactions, as server.mjs wires them: its 👀 on a trigger comment of the run's
  // sub-issue #2, which goes to that sub-issue's task, never to the run.
  const posted = [];
  const listener = createComments({
    config: {},
    github: async (repo, method, path) => (
      posted.push(`${method} ${path}`),
      Response.json({ id: 700, content: "eyes" }, { status: 200 })
    ),
    log: () => {},
  });
  const { lookup } = fakeLookup(GITHUB);
  const { check, answered } = createWriteChecks({
    needsInputLabel: () => null,
    lookup,
    bot: BOT,
    listenerReacted: listener.listenerReacted,
  });
  const work = run("work");
  const add = (content) => ({
    method: "POST",
    path: "/repos/org/repo/issues/comments/21/reactions",
    body: json({ content }),
    at: START,
  });
  // The run's 👀 and 👍 land first (201), on #2's comment, which its ceiling holds.
  assert.equal(
    await check(work, write("POST", add("eyes").path.slice(1), { content: "eyes" })),
    null,
  );
  answered(work, add("eyes"), ...reacted(700, "eyes"));
  answered(work, add("+1"), ...reacted(701, "+1"));
  const remove = (id) => write("DELETE", `repos/org/repo/issues/comments/21/reactions/${id}`);
  assert.equal(await check(work, remove(700)), null);
  // The listener takes the comment in for #2's task: GitHub answers its POST with the run's 👀.
  listener.received({ repo: "Org/Repo", comment: { id: 21 } });
  assert.deepEqual(posted, ["POST /repos/Org/Repo/issues/comments/21/reactions"]);
  assert.deepEqual(await check(work, remove(700)), {
    status: 403,
    message: "a run doesn't take off a reaction the listener added there",
  });
  // Its other reaction there is still its own.
  assert.equal(await check(work, remove(701)), null);
  // And one the listener has: never kept as the run's, though GitHub answered the run 201.
  const fresh = run("work");
  listener.received({ repo: "org/repo", comment: { id: 13 } });
  answered(
    fresh,
    { ...add("eyes"), path: "/repos/org/repo/issues/comments/13/reactions" },
    ...reacted(702, "eyes"),
  );
  assert.deepEqual(fresh.created, []);
});

test("reactions: a run keeps its newest ones only", () => {
  const { answered } = createWriteChecks({ needsInputLabel: () => null, lookup: async () => null });
  const work = { ...run("work"), created: [{ number: 30, at: 1 }] };
  for (let id = 1; id <= 105; id++) {
    const post = {
      method: "POST",
      path: "/repos/org/repo/issues/1/reactions",
      body: json({}),
      at: id,
    };
    answered(work, post, ...reacted(id, "+1"));
  }
  const kept = work.created.filter((c) => c.reaction).map((c) => c.reaction.id);
  assert.equal(kept.length, 100);
  assert.deepEqual([kept[0], kept.at(-1)], [6, 105]);
  // Its issues aren't counted with them.
  assert.deepEqual(work.created[0], { number: 30, at: 1 });
});

test("deny_github: its input, and its reasons refusing the write", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "github.rego": "package deckhand\n" },
    messages: (input) =>
      input.mode === "brainstorm" && input.target.kind !== "own_issue"
        ? ["brainstorms write only their own issue", "ask on #1 instead"]
        : [],
  });
  const { check } = createWriteChecks({
    needsInputLabel: () => null,
    lookup: fakeLookup(GITHUB).lookup,
    policies,
  });
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
    custom_mode: false,
    light: true,
    reason: null,
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
  // A work run the listener started itself, and one in the repo's own modes, light or not.
  await check(
    { ...work, reason: "ci-fix" },
    write("PATCH", "repos/org/repo/issues/1", { body: "x" }),
  );
  assert.deepEqual(
    [evals.at(-1).mode, evals.at(-1).custom_mode, evals.at(-1).light, evals.at(-1).reason],
    ["work", false, false, "ci-fix"],
  );
  await check(
    run("plan", { push: true }),
    write("PATCH", "repos/org/repo/issues/1", { body: "x" }),
  );
  assert.deepEqual(
    [evals.at(-1).mode, evals.at(-1).custom_mode, evals.at(-1).light, evals.at(-1).reason],
    ["plan", true, false, null],
  );
  // A reaction's content, and the comment it is on: its author, and whether the bot wrote it.
  const { check: withBot } = createWriteChecks({
    needsInputLabel: () => null,
    lookup: fakeLookup(GITHUB).lookup,
    bot: BOT,
    policies,
  });
  for (const [id, author, deckhand] of [
    [11, "alice", false],
    [12, "deckhand[bot]", true],
  ]) {
    const path = `repos/org/repo/issues/comments/${id}/reactions`;
    assert.equal(await withBot(work, write("POST", path, { content: "eyes" })), null);
    const { action, target, change } = evals.at(-1);
    assert.equal(action, "react");
    assert.deepEqual(target, {
      number: 1,
      labels: ["idea"],
      author: "alice",
      kind: "own_issue",
      comment: id,
      comment_author: author,
      comment_deckhand: deckhand,
    });
    assert.deepEqual(change, {
      fields: ["content"],
      labels_added: [],
      labels_removed: [],
      content: "eyes",
    });
  }
  // A removal's content is the one the run added.
  const reacting = {
    ...work,
    created: [{ reaction: { subject: "issue:7", content: "+1", id: 5 } }],
  };
  await withBot(reacting, write("DELETE", "repos/org/repo/issues/7/reactions/5"));
  assert.equal(evals.at(-1).action, "unreact");
  assert.equal(evals.at(-1).change.content, "+1");
  assert.equal(evals.at(-1).target.comment, undefined);
  // Above the ceiling: refused before any policy runs.
  const asked = evals.length;
  await check(brainstorm, write("PATCH", "repos/org/repo/issues/3", { body: "x" }));
  assert.equal(evals.length, asked);
});

test("a rerun through the gateway: its installation's Actions permission named first, a lost answer counted", async (t) => {
  // An installation without `actions`, then with read only, then with write: what it lacks.
  let has = null;
  const order = [null, "read", "write"];
  const lacking = async (repo, wanted) => {
    const want = wanted.actions;
    if (!want || order.indexOf(has) >= order.indexOf(want)) return null;
    return { missing: [`actions: ${want}`], account: "org", url: null };
  };
  // GitHub takes the rerun and drops the connection before answering.
  const github = await serve(t, (req) => req.socket.destroy());
  const { lookup: resolving } = rerunLookup();
  const looked = [];
  const lookup = (repo, path) => (looked.push(path), resolving(repo, path));
  const broker = createBroker({ sentFrom: sandboxAt() });
  const checks = createWriteChecks({ needsInputLabel: () => null, lookup });
  const gw = createGithubGateway({
    broker,
    app: () => ({ repoToken: async () => ({ token: "t-0123456789abcdef" }), lacking }),
    api: github.url,
    web: "https://github.example",
    checkWrite: checks.check,
    wroteWrite: checks.answered,
  });
  const { url } = await serve(t, (req, res) => gw.handle(req, res));
  const secret = broker.register("org/repo", undefined, { mode: "work", push: true, issue: 1 });
  broker.allow(secret, ["issue-1-*"]);
  const rerun = () =>
    fetch(`${url}/relay/127.0.0.1/repos/org/repo/actions/runs/100/rerun-failed-jobs`, {
      method: "POST",
      headers: { authorization: `token ${secret}` },
      body: "{}",
    });
  // No Actions at all: refused naming it before the checks, which couldn't read the run.
  let res = await rerun();
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /the GitHub App's actions: read permission/);
  assert.deepEqual(looked, []);
  // Read only: checked, then refused naming write.
  has = "read";
  res = await rerun();
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /the GitHub App's actions: write permission/);
  assert.ok(looked.includes("/repos/org/repo/actions/runs/100"));
  const run = broker.runOf(secret);
  assert.deepEqual(run.reruns, []);
  // Write: it goes out, and no answer comes back. GitHub may have taken it: counted.
  has = "write";
  res = await rerun();
  assert.equal(res.status, 502);
  assert.deepEqual(
    run.reruns.map((r) => [r.run_id, r.sha]),
    [[100, "aaa"]],
  );
  assert.ok(!run.reruns.some((r) => r.pending));
});

test("a project write: its project checked against the grants, then in deny_github's input", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "github.rego": "package deckhand\n" },
    messages: (input) => (input.custom_mode ? ["not in this mode"] : []),
  });
  let granted = () => ["acme/3"];
  const { checkWrite } = createWriteChecks({
    needsInputLabel: () => null,
    lookup: fakeLookup(GITHUB).lookup,
    policies,
    projects: (repo) => (assert.equal(repo, "org/repo"), granted()),
  });
  const project = (number, owner = "acme") => ({
    repo: "org/repo",
    actions: ["project"],
    target: { number: 1 },
    project: { owner, number, title: "Roadmap" },
    change: { fields: ["project_id"], labels_added: [], labels_removed: [] },
  });
  assert.equal(await checkWrite(run("work"), project(3)), null);
  assert.deepEqual(evals.at(-1).change.project, { owner: "acme", number: 3, title: "Roadmap" });
  assert.equal(evals.at(-1).action, "project");
  // Not granted: refused before any policy runs.
  const asked = evals.length;
  assert.deepEqual(await checkWrite(run("work"), project(4)), {
    status: 403,
    message:
      "the operator's grants don't let this repository's runs write project acme/4 (allow_projects)",
  });
  assert.equal(evals.length, asked);
  // Grants that can't be read: refused too (fail closed).
  granted = () => {
    throw new Error("broken");
  };
  assert.deepEqual(await checkWrite(run("work"), project(3)), {
    status: 503,
    message: "the operator's grants can't be read",
  });
  // A policy may still refuse a granted one.
  granted = () => ["acme/3"];
  assert.match(
    (await checkWrite(run("plan", { push: true }), project(3))).message,
    /deny_github\): not in this mode/,
  );
});

test("assignees and milestones: the repository's allowed users or the bot, never Copilot; their input", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "github.rego": "package deckhand\n" },
  });
  // #1 is assigned to carol, who isn't an allowed user (anymore).
  const issues = { ...GITHUB.issues, 1: { ...GITHUB.issues[1], assignees: [{ login: "Carol" }] } };
  const { lookup } = fakeLookup({ ...GITHUB, issues });
  const asked = [];
  const { check } = createWriteChecks({
    needsInputLabel: () => null,
    lookup,
    bot: BOT,
    users: (repo) => (asked.push(repo), ["alice", "bob", "copilot"]),
    policies,
  });
  const work = run("work");
  const ok = async (w, change) => {
    assert.equal(await check(work, w), null, `${w.method} ${w.path}`);
    for (const [key, value] of Object.entries(change)) {
      assert.deepEqual(evals.at(-1).change[key], value, `${w.method} ${w.path} ${key}`);
    }
  };
  await ok(write("POST", "repos/org/repo/issues/1/assignees", { assignees: ["Alice"] }), {
    assignees: { added: ["Alice"], removed: [] },
  });
  await ok(write("DELETE", "repos/org/repo/issues/1/assignees", { assignees: ["carol"] }), {
    assignees: { added: [], removed: ["carol"] },
  });
  // Set in place of the issue's: split against GitHub's, so carol kept isn't an assignment.
  await ok(write("PATCH", "repos/org/repo/issues/1", { assignees: ["bob"] }), {
    assignees: { added: ["bob"], removed: ["Carol"] },
  });
  await ok(write("PATCH", "repos/org/repo/issues/1", { assignees: ["carol", "bob"] }), {
    assignees: { added: ["bob"], removed: [] },
  });
  await ok(write("PATCH", "repos/org/repo/issues/1", { assignee: null }), {
    assignees: { added: [], removed: ["Carol"] },
  });
  // The App's bot, on a new issue and a pull request of the run's.
  await ok(write("POST", "repos/org/repo/issues", { title: "T", assignees: ["deckhand[bot]"] }), {
    assignees: { added: ["deckhand[bot]"], removed: [] },
  });
  await ok(write("PATCH", "repos/org/repo/pulls/7", { assignees: ["alice"], milestone: 3 }), {
    assignees: { added: ["alice"], removed: [] },
    milestone: { number: 3, title: "v1" },
  });
  // A milestone looked up, or cleared; absent from writes that don't set it.
  await ok(write("PATCH", "repos/org/repo/issues/2", { milestone: "3" }), {
    milestone: { number: 3, title: "v1" },
  });
  assert.deepEqual(evals.at(-1).actions, ["milestone"]);
  await ok(write("PATCH", "repos/org/repo/issues/2", { milestone: null }), { milestone: null });
  await ok(write("PATCH", "repos/org/repo/issues/2", { body: "x" }), {});
  assert.ok(!("milestone" in evals.at(-1).change) && !("assignees" in evals.at(-1).change));
  assert.ok(asked.every((repo) => repo === "org/repo"));
  // Whatever the policies say: someone else, Copilot (even allowed), a milestone not there.
  const asks = evals.length;
  for (const [w, status, message] of [
    [
      write("POST", "repos/org/repo/issues/1/assignees", { assignees: ["alice", "mallory"] }),
      403,
      "a run assigns only the repository's allowed users or its own bot, not @mallory",
    ],
    [
      write("PATCH", "repos/org/repo/issues/1", { assignees: ["carol", "dave"] }),
      403,
      "a run assigns only the repository's allowed users or its own bot, not @dave",
    ],
    [
      write("POST", "repos/org/repo/issues", { title: "T", assignee: "Copilot" }),
      403,
      "a run doesn't assign Copilot",
    ],
    [write("PATCH", "repos/org/repo/issues/2", { milestone: 9 }), 404, "milestone 9 isn't there"],
  ]) {
    assert.deepEqual(await check(work, w), { status, message }, `${w.method} ${w.path}`);
  }
  assert.equal(evals.length, asks);
  // What it can't read: refused as a write it can't classify.
  for (const body of [{ assignees: "alice" }, { assignees: [1] }, { milestone: "v1" }]) {
    const got = await check(work, write("PATCH", "repos/org/repo/issues/1", body));
    assert.match(got.message, /can't tell what this write does/, JSON.stringify(body));
  }
  // No users known: nobody is assigned but the bot.
  const bare = createWriteChecks({
    needsInputLabel: () => null,
    lookup,
    bot: BOT,
  });
  const alice = write("POST", "repos/org/repo/issues/1/assignees", { assignees: ["alice"] });
  assert.match((await bare.check(work, alice)).message, /not @alice/);
  // A brainstorm: the milestone of the issues it files, nothing else.
  const brainstorm = run("brainstorm");
  assert.equal(
    await bare.check(
      brainstorm,
      write("POST", "repos/org/repo/issues", { title: "T", milestone: 3 }),
    ),
    null,
  );
  for (const w of [
    write("PATCH", "repos/org/repo/issues/1", { milestone: 3 }),
    write("POST", "repos/org/repo/issues", { title: "T", assignees: ["deckhand[bot]"] }),
    write("POST", "repos/org/repo/issues/1/assignees", { assignees: ["deckhand[bot]"] }),
  ]) {
    assert.match((await bare.check(brainstorm, w)).message, /its ceiling/, `${w.method} ${w.path}`);
  }
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
    checkWrite: createWriteChecks({
      needsInputLabel: () => null,
      lookup: fakeLookup(GITHUB).lookup,
      policies,
    }).check,
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

test("runTraits: a repo's own mode, light without push, the listener's reason", () => {
  assert.deepEqual(runTraits(run("work")), { custom_mode: false, light: false, reason: null });
  assert.deepEqual(runTraits({ ...run("brainstorm"), reason: "x" }), {
    custom_mode: false,
    light: true,
    reason: "x",
  });
  // The repo's review block is a built-in mode; a repo's own, light or not; no mode at all.
  assert.equal(runTraits(run("review")).custom_mode, false);
  assert.deepEqual(runTraits(run("ask")), { custom_mode: true, light: true, reason: null });
  assert.equal(runTraits(run("plan", { push: true })).light, false);
  assert.equal(runTraits(run(null)).custom_mode, false);
});

test("read_checks: deny_github asked once per run, its answer kept", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "gh-checks.rego": "package deckhand\n" },
    messages: (input) =>
      input.action === "read_checks" && input.custom_mode ? ["not in the repo's modes"] : [],
  });
  const { checkRead } = createReadChecks({ policies });
  const work = { ...run("work"), reason: "ci-fix" };
  // `gh pr checks --watch`: a poll every few seconds, one evaluation.
  for (let i = 0; i < 5; i++) assert.equal(await checkRead(work, "read_checks"), null);
  assert.equal(evals.length, 1);
  assert.deepEqual(evals[0], {
    rule: "deny_github",
    version: 1,
    repo: "org/repo",
    mode: "work",
    custom_mode: false,
    light: false,
    reason: "ci-fix",
    issue: 1,
    action: "read_checks",
    actions: ["read_checks"],
  });
  const ask = run("ask");
  const refused = {
    status: 403,
    message: "the policies refuse it (deny_github): not in the repo's modes",
  };
  assert.deepEqual(await checkRead(ask, "read_checks"), refused);
  assert.deepEqual(await checkRead(ask, "read_checks"), refused);
  // Each run its own answer; at once, one evaluation too.
  const brainstorm = run("brainstorm");
  await Promise.all([checkRead(brainstorm, "read_checks"), checkRead(brainstorm, "read_checks")]);
  assert.equal(evals.length, 3);
  // Without policies, nothing is refused.
  assert.equal(await createReadChecks({}).checkRead(work, "read_checks"), null);
});

test("read_checks: a failed evaluation refuses that read only, the next one asks again", async (t) => {
  let fails = 1;
  // Not a set of strings: the policies fail closed, "policy error: …", as when GitHub can't list
  // them or opa times out.
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "gh-checks.rego": "package deckhand\n" },
    messages: () => (fails-- > 0 ? 42 : []),
  });
  const { checkRead } = createReadChecks({ policies });
  const work = run("work");
  const failed = await checkRead(work, "read_checks");
  assert.equal(failed.status, 403);
  assert.match(failed.message, /^the policies refuse it \(deny_github\): policy error: /);
  assert.ok(!("failed" in failed));
  assert.equal(await checkRead(work, "read_checks"), null);
  assert.equal(await checkRead(work, "read_checks"), null);
  assert.equal(evals.length, 2);
});

// Deckhand's own default policies (policy/*.rego), as the image ships them.
const builtIn = () => builtInPolicies();

test(
  "the real opa: each of Deckhand's default policies compiles and answers for every kind of mode",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    const files = builtIn();
    assert.ok(files.size);
    const policies = createPolicies({
      config: {},
      github: async () => new Response("{}", { status: 404 }),
      run: opaRunner(),
      readBuiltIn: () => files,
      tmp: tempDir(t),
    });
    assert.deepEqual(await policies.checkOperator(), { errors: [], warnings: [] });
    for (const [name, text] of files) {
      const one = new Map([[name, text]]);
      for (const [mode, light] of [
        ["work", false],
        ["brainstorm", true],
        ["idea", true],
        ["plan", false],
        ["ask", true],
      ]) {
        for (const kind of ["own_issue", "own_pr", "other_issue", "new_issue"]) {
          const messages = await policies.denied("deny_github", "org/repo", one, () => ({
            repo: "org/repo",
            mode,
            custom_mode: !MODES[mode],
            light,
            reason: null,
            issue: 1,
            action: "comment",
            actions: ["comment"],
            target: { kind, number: kind.startsWith("new") ? null : 7, labels: [], author: "a" },
            change: { fields: ["body"], labels_added: [], labels_removed: [] },
          }));
          assert.ok(!messages.some((m) => m.startsWith("policy error")), `${name}: ${messages}`);
        }
      }
    }
  },
);

test(
  "the real opa: Deckhand's github.rego narrows the ceilings as docs/repo-config.md says",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    const docs = readFileSync(join(import.meta.dirname, "..", "docs", "repo-config.md"), "utf8");
    const [, shown] =
      /<!-- github\.rego:[^\n]*-->\n\n```rego\n# policy\/github\.rego\n([\s\S]*?)```/.exec(docs);
    assert.equal(shown, builtIn().get("github.rego"));
    const policies = createPolicies({
      config: {},
      github: async () => new Response("{}", { status: 404 }),
      run: opaRunner(),
      readBuiltIn: () => new Map([["github.rego", builtIn().get("github.rego")]]),
      tmp: tempDir(t),
    });
    const ask = (mode, action, kind, labels_added = [], more = {}) =>
      policies.deny("deny_github", "org/repo", "main", () => ({
        repo: "org/repo",
        mode,
        custom_mode: !MODES[mode],
        light: !["work", "plan"].includes(mode),
        reason: null,
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
    // And puts the issues it filed in a milestone.
    assert.deepEqual(await ask("brainstorm", "milestone", "created_issue"), []);
    assert.deepEqual(await ask("brainstorm", "milestone", "sub_issue"), [
      "a brainstorm writes only its own issue, not #7",
    ]);
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
  "the real opa: Deckhand's gh-actions-rerun.rego allows a first rerun, in work runs only",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    const rerunPolicies = (repo = {}) =>
      createPolicies({
        config: {},
        github: async (_, method, path) => {
          const files = Object.keys(repo);
          if (path === "/repos/org/repo/contents/.deckhand/policy?ref=main" && files.length) {
            return Response.json(files.map((name) => ({ type: "file", name, sha: name })));
          }
          if (path.startsWith("/repos/org/repo/git/blobs/")) {
            const text = repo[path.split("/").pop()];
            return Response.json({
              content: Buffer.from(text).toString("base64"),
              encoding: "base64",
            });
          }
          return new Response("{}", { status: 404 });
        },
        run: opaRunner(),
        readBuiltIn: builtIn,
        tmp: tempDir(t),
      });
    const policies = rerunPolicies();
    const rerun = (mode, attempt, light = false) =>
      policies.deny("deny_github", "org/repo", "main", () => ({
        repo: "org/repo",
        mode,
        custom_mode: !MODES[mode],
        light,
        reason: null,
        issue: 1,
        action: "rerun",
        actions: ["rerun"],
        target: { kind: "own_pr", number: 7, labels: [], author: "a", run_id: 100, attempt },
        change: { fields: [], labels_added: [], labels_removed: [] },
      }));
    assert.deepEqual(await rerun("work", 1), []);
    assert.deepEqual(await rerun("work", 2), [
      "a workflow run is rerun once: run 100 is on its attempt 2",
    ]);
    assert.deepEqual(await rerun("plan", 1), ["plan runs don't rerun GitHub Actions jobs here"]);
    // Through the gateway's checks: a first rerun goes on, a second is refused.
    const { check } = createWriteChecks({
      needsInputLabel: () => null,
      lookup: rerunLookup().lookup,
      policies,
    });
    const work = { ...run("work"), reruns: [] };
    assert.equal(
      await check(work, write("POST", "repos/org/repo/actions/runs/100/rerun-failed-jobs")),
      null,
    );
    assert.match(
      (await check(work, write("POST", "repos/org/repo/actions/runs/107/rerun-failed-jobs")))
        .message,
      /the policies refuse it \(deny_github\): a workflow run is rerun once/,
    );
    // A repository broadens it with its own file of that name, up to the built-in bound.
    const broader = rerunPolicies({ "gh-actions-rerun.rego": "package deckhand\n" });
    const { check: broad } = createWriteChecks({
      needsInputLabel: () => null,
      lookup: rerunLookup().lookup,
      policies: broader,
    });
    const rerun107 = write("POST", "repos/org/repo/actions/runs/107/rerun-failed-jobs");
    assert.equal(await broad(work, rerun107), null);
    assert.equal(await broad({ ...run("plan", { push: true }), reruns: [] }, rerun107), null);
    const twice = { ...work, reruns: [{ sha: "aaa" }, { sha: "aaa" }] };
    assert.match((await broad(twice, rerun107)).message, /at most 2 times/);
  },
);

test(
  "the real opa: policy/gh-update-branch.rego, per mode, and a repository's file of the same name broadening or refusing it",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    const engine = (repoFiles = {}) =>
      createPolicies({
        config: {},
        github: async (repo, method, path) => {
          if (path === "/repos/org/repo/contents/.deckhand/policy?ref=main") {
            const names = Object.keys(repoFiles);
            if (!names.length) return new Response("{}", { status: 404 });
            return Response.json(names.map((name) => ({ type: "file", name, sha: name })));
          }
          const blob = /\/git\/blobs\/(.+)$/.exec(path);
          if (blob) {
            const text = repoFiles[blob[1]];
            return Response.json({
              content: Buffer.from(text).toString("base64"),
              encoding: "base64",
            });
          }
          return new Response("{}", { status: 404 });
        },
        run: opaRunner(),
        // Deckhand's defaults as the image ships them: github.rego beside it.
        readOperator: () => new Map(),
        readBuiltIn: builtIn,
        tmp: tempDir(t),
      });
    const checks = (policies) =>
      createWriteChecks({
        needsInputLabel: () => null,
        lookup: fakeLookup(GITHUB).lookup,
        policies,
      });
    const update = (n) =>
      write("PUT", `repos/org/repo/pulls/${n}/update-branch`, {
        expected_head_sha: "0123456789abcdef0123456789abcdef01234567",
      });
    const work = run("work");
    const deploy = run("deploy", { push: true });
    const { check } = checks(engine());
    // Work runs (fix and conflict runs are work runs): allowed.
    assert.equal(await check(work, update(7)), null);
    // The repository's modes: refused, though their ceiling holds it.
    assert.match(
      (await check(deploy, update(7))).message,
      /a deploy run doesn't update its pull request's branch unless \.deckhand\/policy\/gh-update-branch\.rego lets it/,
    );
    // A repository's file of the same name replaces the default: its modes too…
    const broad = checks(engine({ "gh-update-branch.rego": "package deckhand\n" }));
    assert.equal(await broad.check(deploy, update(7)), null);
    // …but never past the ceiling: a brainstorm, another pull request's branch.
    assert.match((await broad.check(run("brainstorm"), update(7))).message, /its ceiling/);
    assert.match((await broad.check(work, update(8))).message, /can't update_branch on pr #8/);
    // A repository that keeps its history linear refuses it everywhere.
    const linear = `package deckhand

deny_github contains "this repository keeps a linear history: rebase and push instead" if {
  input.action == "update_branch"
}
`;
    const none = checks(engine({ "gh-update-branch.rego": linear }));
    assert.match((await none.check(work, update(7))).message, /keeps a linear history/);
  },
);

test(
  "the real opa: gh-projects.rego lets work runs and brainstorms add items, a repo's modes only once it broadens it",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    const files = builtIn();
    // `repoFiles`: the repository's .deckhand/policy/ on its default branch.
    const ask = (mode, kind, repoFiles = {}, reason = null) => {
      const github = async (repo, method, path) => {
        if (path === "/repos/org/repo/contents/.deckhand/policy?ref=main") {
          const list = Object.keys(repoFiles).map((name) => ({ type: "file", name, sha: name }));
          return Response.json(list);
        }
        if (path.startsWith("/repos/org/repo/git/blobs/")) {
          const text = repoFiles[path.split("/").pop()];
          return Response.json({
            content: Buffer.from(text).toString("base64"),
            encoding: "base64",
          });
        }
        return new Response("{}", { status: 404 });
      };
      const policies = createPolicies({
        config: {},
        github,
        run: opaRunner(),
        readBuiltIn: () => files,
        tmp: tempDir(t),
      });
      return policies.deny("deny_github", "org/repo", "main", () => ({
        repo: "org/repo",
        mode,
        custom_mode: !MODES[mode],
        light: !["work", "plan"].includes(mode),
        reason,
        issue: 1,
        action: "project",
        actions: ["project"],
        target: { kind, number: 7, labels: [], author: "a" },
        change: {
          fields: ["project_id"],
          labels_added: [],
          labels_removed: [],
          project: { owner: "acme", number: 3, title: "Roadmap" },
        },
      }));
    };
    // Work, fix and conflict runs alike.
    for (const reason of [null, "review-fix", "ci-fix", "conflict"]) {
      for (const kind of ["own_issue", "own_pr", "sub_issue", "created_issue"]) {
        assert.deepEqual(await ask("work", kind, {}, reason), [], `${reason} ${kind}`);
      }
    }
    assert.deepEqual(await ask("brainstorm", "created_issue"), []);
    assert.deepEqual(await ask("stop", "created_issue"), []);
    assert.deepEqual(await ask("plan", "own_issue"), [
      "mode plan doesn't add items to projects unless .deckhand/policy/gh-projects.rego allows it",
    ]);
    // The repository's same-name file replaces it: its modes add items too.
    const broadened = { "gh-projects.rego": "package deckhand\n" };
    assert.deepEqual(await ask("plan", "own_issue", broadened), []);
    // A file of another name leaves it in place.
    const other = { "extra.rego": "package deckhand\n" };
    assert.equal((await ask("plan", "own_issue", other)).length, 1);
  },
);

test(
  "the real opa: Deckhand's defaults let every kind of run read checks; a same-name file refuses it",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    const files = builtIn();
    assert.ok(files.has("gh-checks.rego"));
    const engine = (operator = new Map()) =>
      createPolicies({
        config: {},
        github: async () => new Response("{}", { status: 404 }),
        run: opaRunner(),
        readBuiltIn: () => files,
        readOperator: () => operator,
        tmp: tempDir(t),
      });
    const read = (policies, mode, light) =>
      createReadChecks({ policies }).checkRead(
        { ...run(mode, { push: !light }), mode, push: !light },
        "read_checks",
      );
    const kinds = [
      ["work", false],
      ["brainstorm", true],
      ["stop", true],
      ["idea", true],
      ["bug", true],
      ["discussion", true],
      ["review", true],
      ["plan", false],
      ["ask", true],
    ];
    const defaults = engine();
    for (const [mode, light] of kinds) {
      assert.equal(await read(defaults, mode, light), null, mode);
    }
    // The operator's (or a repository's) gh-checks.rego replaces Deckhand's, for one mode or all.
    const narrowed = engine(
      new Map([
        [
          "gh-checks.rego",
          `package deckhand

deny_github contains "repository modes don't read checks" if {
  input.action == "read_checks"
  input.custom_mode
}
`,
        ],
      ]),
    );
    assert.equal(await read(narrowed, "work", false), null);
    assert.deepEqual(await read(narrowed, "plan", false), {
      status: 403,
      message: "the policies refuse it (deny_github): repository modes don't read checks",
    });
  },
);

test(
  "the real opa: a repo narrows label creation to one of its modes",
  { skip: !hasOpa && "no opa on the PATH" },
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
    const { check } = createWriteChecks({
      needsInputLabel: () => null,
      lookup: fakeLookup(GITHUB).lookup,
      policies,
    });
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

test(
  "the real opa: policy/gh-reactions.rego lets work runs and brainstorms react, and a repo's same-name file its own modes",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    const rego = readFileSync(join(import.meta.dirname, "..", "policy", "gh-reactions.rego"));
    const shaOf = (text) => createHash("sha1").update(text).digest("hex");
    // The repo's own files (name → text) in its .deckhand/policy/.
    let files = {};
    const policies = createPolicies({
      config: {},
      github: async (repo, method, path) => {
        if (path === "/repos/org/repo/contents/.deckhand/policy?ref=main") {
          // A file's sha changes with its text, as GitHub's: its blob is read again.
          return Response.json(
            Object.keys(files).map((name) => ({ type: "file", name, sha: shaOf(files[name]) })),
          );
        }
        const sha = path.split("/").pop();
        const name = Object.keys(files).find((n) => shaOf(files[n]) === sha);
        if (path.startsWith("/repos/org/repo/git/blobs/") && name) {
          const content = Buffer.from(files[name]).toString("base64");
          return Response.json({ content, encoding: "base64" });
        }
        return new Response("{}", { status: 404 });
      },
      run: opaRunner(),
      readOperator: () => new Map([["gh-reactions.rego", String(rego)]]),
      tmp: tempDir(t),
      now: (() => {
        let clock = 0;
        // Each decision a day apart: the repo's listing is read again.
        return () => (clock += 86_400_000);
      })(),
    });
    const { check, answered } = createWriteChecks({
      lookup: fakeLookup(GITHUB).lookup,
      bot: BOT,
      needsInputLabel: () => null,
      policies,
    });
    const react = write("POST", "repos/org/repo/issues/comments/11/reactions", {
      content: "+1",
    });
    // A run that added 👍 there, for the removals.
    const reacting = (mode) => {
      const r = run(mode, { push: mode !== "brainstorm" });
      const post = { method: "POST", path: react.path, body: react.body, at: START };
      answered(r, post, ...reacted(9, "+1"));
      return r;
    };
    const remove = write("DELETE", "repos/org/repo/issues/comments/11/reactions/9");
    for (const mode of ["work", "brainstorm", "stop"]) {
      assert.equal(await check(reacting(mode), react), null, mode);
      assert.equal(await check(reacting(mode), remove), null, mode);
    }
    // The repository's own modes: neither, unless it says so.
    for (const w of [react, remove]) {
      assert.deepEqual(await check(reacting("deploy"), w), {
        status: 403,
        message:
          "the policies refuse it (deny_github): a deploy run doesn't react unless .deckhand/policy/gh-reactions.rego lets it",
      });
    }
    // Other writes aren't this file's.
    const comment = write("POST", "repos/org/repo/issues/1/comments", { body: "x" });
    assert.equal(await check(reacting("deploy"), comment), null);
    // A repository's same-name file replaces it: here, one that allows them everywhere.
    files = { "gh-reactions.rego": "package deckhand\n" };
    assert.equal(await check(reacting("deploy"), react), null);
    // Or refuses them altogether.
    files = {
      "gh-reactions.rego":
        'package deckhand\n\ndeny_github contains "no reactions here" if input.action in {"react", "unreact"}\n',
    };
    assert.match((await check(reacting("work"), react)).message, /no reactions here/);
  },
);

test(
  "the real opa: policy/gh-assign-milestone.rego, per mode, and a repository's file of the same name broadening it",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    // The repository's own, docs/repo-config.md's example: work runs assign the issue's author,
    // and set milestones.
    const docs = readFileSync(join(import.meta.dirname, "..", "docs", "repo-config.md"), "utf8");
    const [, broader] =
      /```rego\n# \.deckhand\/policy\/gh-assign-milestone\.rego\n([\s\S]*?)```/.exec(docs);
    const engine = (repoFiles = {}) =>
      createPolicies({
        config: {},
        github: async (repo, method, path) => {
          if (path === "/repos/org/repo/contents/.deckhand/policy?ref=main") {
            const names = Object.keys(repoFiles);
            if (!names.length) return new Response("{}", { status: 404 });
            return Response.json(names.map((name) => ({ type: "file", name, sha: name })));
          }
          const blob = /\/git\/blobs\/(.+)$/.exec(path);
          if (blob) {
            return Response.json({
              content: Buffer.from(repoFiles[blob[1]]).toString("base64"),
              encoding: "base64",
            });
          }
          return new Response("{}", { status: 404 });
        },
        run: opaRunner(),
        readBuiltIn: builtIn,
        tmp: tempDir(t),
      });
    const checks = (policies) =>
      createWriteChecks({
        needsInputLabel: () => null,
        lookup: fakeLookup(GITHUB).lookup,
        bot: BOT,
        users: () => ["alice"],
        policies,
      }).check;
    const check = checks(engine());
    const work = run("work");
    const deploy = run("deploy", { push: true });
    const milestone = (n) => write("PATCH", `repos/org/repo/issues/${n}`, { milestone: 3 });
    const assign = (n, login) =>
      write("POST", `repos/org/repo/issues/${n}/assignees`, { assignees: [login] });
    // Work runs (fix and conflict runs are work runs) set milestones: their issue, pull request,
    // sub-issue. They don't assign.
    for (const n of [1, 7, 2]) assert.equal(await check(work, milestone(n)), null, `#${n}`);
    const noAssign =
      "the policies refuse it (deny_github): a run doesn't assign people unless .deckhand/policy/gh-assign-milestone.rego lets it";
    assert.equal((await check(work, assign(1, "alice"))).message, noAssign);
    // A brainstorm sets the milestone of an issue it files.
    const create = write("POST", "repos/org/repo/issues", { title: "T", milestone: 3 });
    assert.equal(await check(run("brainstorm"), create), null);
    // The repository's modes: refused, though their ceiling holds them.
    assert.equal(
      (await check(deploy, milestone(1))).message,
      "the policies refuse it (deny_github): a deploy run doesn't set milestones unless .deckhand/policy/gh-assign-milestone.rego lets it",
    );
    // A repository's file of the same name replaces the default: the issue's author assigned,
    // and its modes' milestones.
    const broad = checks(engine({ "gh-assign-milestone.rego": broader }));
    assert.equal(await broad(work, assign(1, "alice")), null);
    assert.equal(await broad(deploy, milestone(1)), null);
    assert.match((await broad(work, assign(1, "deckhand[bot]"))).message, /the issue's author/);
    assert.match((await broad(deploy, assign(1, "alice"))).message, /only work runs assign/);
    // Never past the built-in limit (bob isn't an allowed user) or the ceiling.
    assert.match((await broad(work, assign(2, "bob"))).message, /allowed users .* not @bob/);
    assert.match((await broad(run("brainstorm"), milestone(1))).message, /its ceiling/);
    assert.match((await broad(work, milestone(3))).message, /can't milestone on other_issue #3/);
    // Its spelling of a login isn't GitHub's: compared in lower case.
    assert.equal(await broad(work, assign(1, "ALICE")), null);
    // A new issue has no author to compare with: refused, over REST and with any assignee.
    const filed = write("POST", "repos/org/repo/issues", { title: "T", assignees: ["alice"] });
    assert.match((await broad(work, filed)).message, /the issue's author/);
  },
);

test("the needs-input label: a run neither adds nor removes it on its sub-issues and the issues it created", async () => {
  const waiting = [{ name: "Needs-Input" }];
  const { lookup } = fakeLookup({
    ...GITHUB,
    issues: {
      ...GITHUB.issues,
      2: { ...GITHUB.issues[2], labels: waiting },
      30: { ...GITHUB.issues[30], labels: waiting },
    },
  });
  const { check, answered } = createWriteChecks({
    lookup,
    bot: BOT,
    needsInputLabel: () => "needs-input",
  });
  const work = run("work");
  answered(work, GRAPHQL_CREATE, 200, created(30));
  for (const n of [2, 30]) {
    const refused = [
      write("DELETE", `repos/org/repo/issues/${n}/labels/needs-input`),
      write("DELETE", `repos/org/repo/issues/${n}/labels`),
      write("PUT", `repos/org/repo/issues/${n}/labels`, ["ui"]),
      write("PATCH", `repos/org/repo/issues/${n}`, { labels: ["ui"] }),
    ];
    for (const w of refused) {
      const got = await check(work, w);
      assert.equal(got?.status, 403, `${w.method} ${w.path}`);
      assert.match(got.message, /doesn't add or remove needs-input on \w+ #\d+/);
    }
    // Its other labels are the run's, the needs-input label kept.
    const kept = write("PUT", `repos/org/repo/issues/${n}/labels`, ["ui", "needs-input"]);
    assert.equal(await check(work, kept), null);
    assert.equal(
      await check(work, write("POST", `repos/org/repo/issues/${n}/labels`, { labels: ["ui"] })),
      null,
    );
  }
  // Nor added where it isn't.
  const bare = createWriteChecks({
    lookup: fakeLookup(GITHUB).lookup,
    needsInputLabel: () => "needs-input",
  });
  const add = write("POST", "repos/org/repo/issues/2/labels", { labels: ["Needs-Input"] });
  assert.match(
    (await bare.check(work, add)).message,
    /doesn't add or remove needs-input on sub_issue #2/,
  );
  // Its own issue is labelled as before.
  assert.equal(
    await check(work, write("POST", "repos/org/repo/issues/1/labels", { labels: ["needs-input"] })),
    null,
  );
});

test("createWriteChecks: the needs-input label is required, so a caller can't leave it unguarded", () => {
  assert.throws(() => createWriteChecks({ lookup: fakeLookup(GITHUB).lookup }), /needsInputLabel/);
});

// A GraphQL resolveReviewThread on #7's thread whose first comment is `comment`, as
// github-graphql.mjs writeOf() makes it.
const resolveWrite = (comment, number = 7) => ({
  repo: "org/repo",
  actions: ["resolve"],
  target: { number },
  change: { fields: [], labels_added: [], labels_removed: [] },
  thread: { comment },
  permissions: { pull_requests: "write" },
});
const unresolveWrite = (comment) => ({ ...resolveWrite(comment), actions: ["unresolve"] });
const replyTo = (number, comment) =>
  write("POST", `repos/org/repo/pulls/${number}/comments/${comment}/replies`, { body: "Fixed." });

test("review threads: a work run replies to and resolves its own pull request's, by their first comment", async (t) => {
  // The operator's file of the default's name replaces it: the ceiling alone here.
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "gh-review-threads.rego": "package deckhand\n" },
  });
  const { lookup, calls } = fakeLookup(GITHUB);
  const { check, checkWrite } = createWriteChecks({
    needsInputLabel: () => null,
    lookup,
    bot: BOT,
    policies,
  });
  const work = run("work");
  // Deckhand's thread, a person's, and a reply in it, followed up to its first comment.
  for (const [comment, thread] of [
    [40, { author: "Deckhand[bot]", deckhand: true }],
    [41, { author: "alice", deckhand: false }],
    [42, { author: "alice", deckhand: false }],
  ]) {
    assert.equal(await check(work, replyTo(7, comment)), null, `${comment}`);
    const input = evals.at(-1);
    assert.equal(input.action, "reply");
    assert.deepEqual(input.target, {
      number: 7,
      labels: [],
      author: "deckhand[bot]",
      kind: "own_pr",
      thread,
    });
  }
  assert.ok(calls.includes("/repos/org/repo/pulls/comments/41"));
  assert.equal(await checkWrite(work, resolveWrite(41)), null);
  assert.deepEqual(evals.at(-1).target.thread, { author: "alice", deckhand: false });
  assert.equal(evals.at(-1).action, "resolve");
  // A repository's own mode that isn't light: the work ceiling.
  assert.equal(await check(run("deploy", { push: true }), replyTo(7, 40)), null);
  const asked = evals.length;
  const refused = [
    // Another pull request's thread: not the run's.
    [work, replyTo(8, 43), 403, /can't reply on pr #8/],
    [work, resolveWrite(43, 8), 403, /can't resolve on pr #8/],
    // A thread that isn't on the pull request the path names, or isn't there.
    [work, replyTo(7, 43), 404, /#7 has no such review thread/],
    [work, replyTo(7, 99), 404, /#7 has no such review thread/],
    // Modes whose ceiling holds neither.
    [run("brainstorm"), replyTo(7, 40), 403, /a brainstorm run can't reply here/],
    [run("review"), replyTo(7, 40), 403, /a review run can't reply here/],
    [run("triage", { push: false }), replyTo(7, 40), 403, /can't reply here/],
  ];
  for (const [r, w, status, why] of refused) {
    const got = await (w.method ? check(r, w) : checkWrite(r, w));
    assert.ok(got, `${r.mode} ${w.path ?? w.actions}`);
    assert.equal(got.status, status, got.message);
    assert.match(got.message, why);
  }
  // Refused before any policy ran.
  assert.equal(evals.length, asked);
});

test(
  "the real opa: Deckhand's gh-review-threads.rego, per mode, and a file of the same name broadening it",
  { skip: !hasOpa && "no opa on the PATH" },
  async (t) => {
    assert.ok(builtIn().has("gh-review-threads.rego"));
    // The repository's own: only the first rule, its modes kept out.
    const broader = `package deckhand

deny_github contains "only work runs answer review threads" if {
  input.action in {"reply", "resolve", "unresolve"}
  input.custom_mode
}
`;
    const engine = (repoFiles = {}, operator = new Map()) =>
      createPolicies({
        config: {},
        github: async (repo, method, path) => {
          if (path === "/repos/org/repo/contents/.deckhand/policy?ref=main") {
            const names = Object.keys(repoFiles);
            if (!names.length) return new Response("{}", { status: 404 });
            return Response.json(names.map((name) => ({ type: "file", name, sha: name })));
          }
          const blob = /\/git\/blobs\/(.+)$/.exec(path);
          if (blob) {
            const text = repoFiles[blob[1]];
            return Response.json({
              content: Buffer.from(text).toString("base64"),
              encoding: "base64",
            });
          }
          return new Response("{}", { status: 404 });
        },
        run: opaRunner(),
        readBuiltIn: builtIn,
        readOperator: () => operator,
        tmp: tempDir(t),
      });
    const checks = (policies) =>
      createWriteChecks({
        needsInputLabel: () => null,
        lookup: fakeLookup(GITHUB).lookup,
        bot: BOT,
        policies,
      });
    const { check, checkWrite } = checks(engine());
    const work = run("work");
    // Work runs (fix and conflict runs are work runs): reply, and resolve Deckhand's threads.
    assert.equal(await check(work, replyTo(7, 41)), null);
    assert.equal(await checkWrite(work, resolveWrite(40)), null);
    assert.match(
      (await checkWrite(work, resolveWrite(41))).message,
      /resolves only Deckhand's own review threads, not @alice's/,
    );
    // The repository's modes: refused, though their ceiling holds them.
    const deploy = run("deploy", { push: true });
    assert.match(
      (await check(deploy, replyTo(7, 40))).message,
      /a deploy run doesn't answer review threads unless \.deckhand\/policy\/gh-review-threads\.rego lets it/,
    );
    assert.match(
      (await checkWrite(deploy, resolveWrite(40))).message,
      /a deploy run doesn't answer/,
    );
    assert.equal(await checkWrite(work, unresolveWrite(41)), null);
    // A light repository mode: no ceiling, whatever the policy.
    assert.match((await check(run("ask", { push: false }), replyTo(7, 40))).message, /its ceiling/);
    // The operator's file of its name replaces Deckhand's, for every repository.
    const operator = new Map([["gh-review-threads.rego", "package deckhand\n"]]);
    const open = checks(engine({}, operator));
    assert.equal(await open.checkWrite(work, resolveWrite(41)), null);
    assert.equal(await open.check(deploy, replyTo(7, 40)), null);
    // A repository's file of the same name replaces the default: a person's thread resolved.
    const broad = checks(engine({ "gh-review-threads.rego": broader }));
    assert.equal(await broad.checkWrite(work, resolveWrite(41)), null);
    assert.match(
      (await broad.checkWrite(deploy, resolveWrite(41))).message,
      /only work runs answer review threads/,
    );
    // Never past the ceiling: a brainstorm still can't, nor another pull request's thread.
    assert.match((await broad.check(run("brainstorm"), replyTo(7, 40))).message, /its ceiling/);
    assert.match((await broad.check(work, replyTo(8, 43))).message, /can't reply on pr #8/);
  },
);
