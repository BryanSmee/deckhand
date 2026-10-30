// The branch the listener creates at the base's head and links to a work run's issue
// (linked-branch.mjs), and Deckhand's default policy for it (policy/gh-linked-branch.rego).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { branchName, createLinkedBranches } from "../listener/linked-branch.mjs";
import { builtInPolicies, createPolicies, opaRunner } from "../listener/policies.mjs";
import { policyEngine, tempDir, hasOpa } from "./helpers.mjs";

// A work run on org/repo#12, from main: `live` over it.
const taskOf = (live = {}, task = {}) => ({
  repo: "Org/Repo",
  base: "main",
  kind: "issue",
  number: 12,
  ...task,
  live: {
    key: "Org/Repo#12",
    mode: "work",
    light: false,
    fork: false,
    secret: "s",
    branches: ["issue-12-*"],
    ...live,
  },
});

// A linker on a fake GitHub where org/repo#12 is "Café : bientôt" and its branches are
// `branches`; `linked`: what createLinkedBranch answers (an Error: GraphQL's errors; null: no
// linked branch).
// `run`: the broker's run; `policies`: policies.mjs's, none by default.
function linker({
  branches = [],
  linked,
  run = { mode: "work", push: true, reason: null },
  policies = null,
  issue = {},
} = {}) {
  const calls = [];
  const notes = [];
  const logs = [];
  const decided = [];
  // Any spelling of the repo's name: GitHub's is case-insensitive.
  const github = async (repo, method, spelled) => {
    calls.push(`${method} ${spelled}`);
    const path = spelled.replace(/^\/repos\/org\/repo/i, "/repos/Org/Repo");
    if (path === "/repos/Org/Repo/git/matching-refs/heads/issue-12-") {
      return Response.json(branches.map((b) => ({ ref: `refs/heads/${b}` })));
    }
    if (path === "/repos/Org/Repo/issues/12") {
      return Response.json({
        node_id: "I_12",
        title: "Café : bientôt",
        labels: [{ name: "bug" }],
        ...issue,
      });
    }
    if (path === "/repos/Org/Repo/git/ref/heads/main") {
      return Response.json({ object: { sha: "base-sha" } });
    }
    if (path === "/repos/Org/Repo") return Response.json({ node_id: "R_1" });
    return new Response("{}", { status: 404 });
  };
  const mutations = [];
  const graphql = async (repo, query, variables) => {
    mutations.push({ repo, query, variables });
    if (linked instanceof Error) throw linked;
    if (linked === null) return { createLinkedBranch: { linkedBranch: null } };
    return {
      createLinkedBranch: {
        linkedBranch: { ref: { name: linked ?? variables.input.name } },
      },
    };
  };
  const linkedBranches = createLinkedBranches({
    github,
    graphql,
    policies,
    runOf: (secret) => (secret === "s" ? run : null),
    decided: (key, entry) => decided.push({ key, ...entry }),
    log: (line) => logs.push(line),
  });
  const link = (task = taskOf()) => linkedBranches.link(task, (m) => notes.push(m));
  return { link, calls, mutations, notes, logs, decided };
}

test("branchName: draft-pr.sh's slug, from the title", () => {
  assert.equal(branchName(12, "Café : bientôt"), "issue-12-cafe-bientot");
  assert.equal(branchName(3, "修复登录"), "issue-3-task");
  assert.equal(branchName(3, "🔥 !"), "issue-3-task");
  const long = branchName(4, `${"a".repeat(49)} b c`);
  assert.equal(long, `issue-4-${"a".repeat(49)}`);
  // The same as the sandbox's own slug().
  const script = readFileSync(join(import.meta.dirname, "..", "sandbox", "draft-pr.sh"), "utf8");
  const slug = /^slug\(\) \{[^]*?^\}$/m.exec(script)[0];
  for (const title of [
    "Café : bientôt",
    "Link a run's branch (`gh issue develop`)",
    "x".repeat(80),
  ]) {
    const shell = spawnSync("bash", ["-c", `${slug}\nslug <<< "$T"`], {
      env: { ...process.env, T: title },
      encoding: "utf8",
    }).stdout;
    assert.equal(branchName(1, title), `issue-1-${shell}`);
  }
});

test("a work run's issue without a branch: created at the base's head and linked", async () => {
  const l = linker();
  assert.equal(await l.link(), "issue-12-cafe-bientot");
  assert.deepEqual(l.mutations.length, 1);
  assert.match(l.mutations[0].query, /createLinkedBranch/);
  assert.deepEqual(l.mutations[0].variables.input, {
    issueId: "I_12",
    oid: "base-sha",
    name: "issue-12-cafe-bientot",
    repositoryId: "R_1",
  });
  assert.deepEqual(l.notes, [
    "Branch issue-12-cafe-bientot created at main's head and linked to #12",
  ]);
  // Without policies, nothing to keep.
  assert.deepEqual(l.decided, []);
});

test("a base branch with a slash is read by its ref's path", async () => {
  const l = linker();
  await l.link(taskOf({}, { base: "release/1 x" }));
  assert.ok(l.calls.includes("GET /repos/Org/Repo/git/ref/heads/release/1%20x"));
});

test("an issue that has a branch already, a fix or conflict run's, gets no other", async () => {
  // Its one branch is the sandbox's, whatever the title says now: an earlier link whose run
  // never started included.
  const l = linker({ branches: ["issue-12-old-title", "issue-120-other", "feat"] });
  assert.equal(await l.link(), "issue-12-old-title");
  assert.deepEqual(l.mutations, []);
  assert.deepEqual(l.notes, []);
  // Several: the sandbox picks by its own name.
  const several = linker({ branches: ["issue-12-a", "issue-12-b"] });
  assert.equal(await several.link(), null);
  assert.deepEqual(several.mutations, []);
  // issue-12- matches no longer prefix's branch: "issue-12-" alone isn't one of its.
  const other = linker({ branches: ["issue-12-"] });
  assert.equal(await other.link(), "issue-12-cafe-bientot");
});

// TASK_BRANCH lets a repo's own mode open a branch and draft (draft-pr.sh): only one the
// policies let the listener link, never an existing one they weren't asked about.
test("a repo's own mode on an issue that has a branch gets none, and no policy is asked", async (t) => {
  const policy = policyEngine(t, {
    files: { "branches.rego": 'package deckhand\ndeny_link_branch contains "x" if false\n' },
  });
  const run = { mode: "plan", push: true, reason: null };
  const l = linker({ branches: ["issue-12-pushed"], run, policies: policy.engine });
  assert.equal(await l.link(taskOf({ mode: "plan" }, { repo: "org/repo" })), null);
  assert.deepEqual([l.mutations, policy.evals, l.decided], [[], [], []]);
  // Without a branch, the policies decide: allowed here, so linked.
  const none = linker({ run, policies: policy.engine });
  assert.equal(
    await none.link(taskOf({ mode: "plan" }, { repo: "org/repo" })),
    "issue-12-cafe-bientot",
  );
  assert.deepEqual(
    policy.evals.map((e) => [e.rule, e.mode]),
    [["deny_link_branch", "plan"]],
  );
});

test("no link for a light run, a fork's, a pull request, or a run that can't push its branch", async () => {
  for (const task of [
    taskOf({ light: true }),
    taskOf({ fork: true }),
    taskOf({ branches: [] }),
    taskOf({ branches: ["feat"] }),
    taskOf({}, { kind: "pr" }),
  ]) {
    const l = linker();
    assert.equal(await l.link(task), null);
    assert.deepEqual(l.calls, []);
  }
  const unknown = linker({ run: null });
  assert.equal(await unknown.link(), null);
  const light = linker({ run: { mode: "work", push: false } });
  assert.equal(await light.link(), null);
  assert.deepEqual([...unknown.calls, ...light.calls], []);
  // A pull request's number, as an issue's: nothing.
  const pr = linker({ issue: { pull_request: {} } });
  assert.equal(await pr.link(), null);
  assert.deepEqual(pr.mutations, []);
});

test("a failure links nothing and fails no run: the log and the run's log say why", async () => {
  const l = linker({ linked: new Error('GraphQL: 200 [{"message":"no"}]') });
  assert.equal(await l.link(), null);
  assert.deepEqual(l.notes, ['Branch not linked to #12: GraphQL: 200 [{"message":"no"}]']);
  assert.match(l.logs[0], /^Org\/Repo#12: linking a branch to #12: GraphQL/);
  // GitHub named it otherwise: not one the run may push.
  const renamed = linker({ linked: "main" });
  assert.equal(await renamed.link(), null);
  assert.deepEqual(renamed.notes, ["Branch not linked to #12: GitHub named the branch main"]);
  // No linked branch in GitHub's answer, and no error: nothing confirmed.
  const none = linker({ linked: null });
  assert.equal(await none.link(), null);
  assert.deepEqual(none.notes, ["Branch not linked to #12: GitHub created no linked branch"]);
});

test("deny_link_branch: its input, a denial links nothing, the decision kept for the task", async (t) => {
  const policy = policyEngine(t, {
    files: { "branches.rego": 'package deckhand\ndeny_link_branch contains "x" if true\n' },
    messages: (input) => (input.labels.includes("bug") ? ["not for bugs"] : []),
  });
  const run = { mode: "plan", push: true, reason: "conflict" };
  const l = linker({ policies: policy.engine, run });
  // policyEngine()'s files are org/repo's.
  const lower = () => taskOf({}, { repo: "org/repo" });
  assert.equal(await l.link(lower()), null);
  assert.deepEqual(l.mutations, []);
  assert.deepEqual(l.notes, ["Branch not linked to #12: not for bugs"]);
  const { rule, ...input } = policy.evals[0];
  assert.equal(rule, "deny_link_branch");
  assert.deepEqual(input, {
    version: 1,
    repo: "org/repo",
    mode: "plan",
    custom_mode: true,
    light: false,
    reason: "conflict",
    issue: 12,
    labels: ["bug"],
    branch: "issue-12-cafe-bientot",
    base: "main",
    oid: "base-sha",
  });
  assert.deepEqual(
    l.decided.map((d) => [d.key, d.decision, d.rule, d.denied, d.messages, d.pr, d.gates.length]),
    [["Org/Repo#12", "link_branch", "deny_link_branch", true, ["not for bugs"], 12, 2]],
  );
  assert.deepEqual(l.decided[0].input, { version: 1, ...input });
  // Allowed: linked, and that kept too.
  const allowed = linker({ policies: policy.engine, issue: { labels: [] } });
  assert.equal(await allowed.link(lower()), "issue-12-cafe-bientot");
  assert.equal(allowed.decided[0].denied, false);
});

// The real `opa`, when the PATH has it (the listener's image does).
test(
  "the real opa: gh-linked-branch.rego links work runs' branches only, and a repo broadens it",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const builtIn = builtInPolicies();
    assert.ok(builtIn.has("gh-linked-branch.rego"));
    // org/repo's own .deckhand/policy/: `repo`, name → text.
    let repo = {};
    const policies = createPolicies({
      config: {},
      github: async (r, method, path) => {
        if (path.startsWith("/repos/org/repo/contents/.deckhand/policy")) {
          return Response.json(
            Object.keys(repo).map((name) => ({ type: "file", name, sha: `${name}:${repo[name]}` })),
          );
        }
        if (path.startsWith("/repos/org/repo/git/blobs/")) {
          const [name] = decodeURIComponent(path.split("/").pop()).split(":");
          return Response.json({ content: Buffer.from(repo[name]).toString("base64") });
        }
        return new Response("{}", { status: 404 });
      },
      run: opaRunner(),
      readBuiltIn: () => builtIn,
      tmp: tempDir(t),
    });
    const deny = (mode, custom_mode, reason = null) =>
      policies.deny("deny_link_branch", "org/repo", "main", () => ({
        repo: "org/repo",
        mode,
        custom_mode,
        light: false,
        reason,
        issue: 12,
        labels: [],
        branch: "issue-12-x",
        base: "main",
        oid: "abc",
      }));
    // Work runs, fix and conflict runs included.
    assert.deepEqual(await deny("work", false), []);
    assert.deepEqual(await deny("work", false, "review-fix"), []);
    assert.deepEqual(await deny("work", false, "conflict"), []);
    // Other built-in modes, and the repo's own.
    assert.deepEqual(await deny("onboarding", false), [
      "onboarding runs don't link a branch to their issue",
    ]);
    assert.deepEqual(await deny("plan", true), [
      "mode plan doesn't link a branch to its issue unless .deckhand/policy/gh-linked-branch.rego allows it",
    ]);
    // The repo's file of the same name replaces it.
    repo = { "gh-linked-branch.rego": "package deckhand\n" };
    policies.forget("org/repo");
    assert.deepEqual(await deny("plan", true), []);
  },
);
