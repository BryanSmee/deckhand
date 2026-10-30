// Reviewers on Deckhand's pull requests (`review.request`): which deliveries ask, who is
// requested, once per head commit, and what the policies' `deny_request_review` sees and
// refuses, Deckhand's default file with the real opa.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { builtInPolicies, createPolicies, opaRunner } from "../listener/policies.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import {
  createReviewers,
  readyPull,
  requestInput,
  reviewersFor,
  runFields,
} from "../listener/reviewers.mjs";
import { policyEngine, tempDir, testConfig } from "./helpers.mjs";

const config = { ...testConfig({ ALLOWED_USERS: "alice,bob" }), bot: "deckhand-app[bot]" };

const opa = (() => {
  try {
    execFileSync("opa", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Deckhand's own pull request #5, closing #12, ready at sha-1.
const PR = {
  number: 5,
  title: "Add a thing",
  state: "open",
  draft: false,
  body: "Closes #12",
  labels: [],
  user: { login: "deckhand-app[bot]", type: "Bot" },
  head: { sha: "sha-1", ref: "issue-12-thing", repo: { full_name: "org/repo" } },
  base: { ref: "main" },
};

const delivery = (action, pr = {}, more = {}) => ({
  action,
  installation: { id: 7 },
  repository: { full_name: "org/repo", default_branch: "trunk" },
  pull_request: { ...PR, ...pr },
  ...more,
});

test("readyPull: Deckhand's own pull request turning ready, on a branch of the repo", () => {
  const found = readyPull(config, "pull_request", delivery("ready_for_review"));
  assert.deepEqual([found.repo, found.base, found.pr.number], ["org/repo", "trunk", 5]);
  assert.ok(readyPull(config, "pull_request", delivery("opened")));
  for (const [what, event, payload] of [
    ["opened as a draft", "pull_request", delivery("opened", { draft: true })],
    ["pushed to", "pull_request", delivery("synchronize")],
    ["a user's", "pull_request", delivery("ready_for_review", { user: { login: "alice" } })],
    ["closed", "pull_request", delivery("ready_for_review", { state: "closed" })],
    [
      "a fork's",
      "pull_request",
      delivery("ready_for_review", { head: { sha: "x", repo: { full_name: "m/repo" } } }),
    ],
    ["no installation", "pull_request", delivery("ready_for_review", {}, { installation: null })],
    ["another event", "issues", delivery("ready_for_review")],
  ]) {
    assert.equal(readyPull(config, event, payload), null, what);
  }
  const elsewhere = { ...config, repos: ["org/other"] };
  assert.equal(readyPull(elsewhere, "pull_request", delivery("ready_for_review")), null);
});

test("reviewersFor: the repo's list, still in ALLOWED_USERS, never the author", () => {
  const settings = { review: { request: ["alice", "bob", "carol"] } };
  assert.deepEqual(reviewersFor(config, settings, PR), ["alice", "bob"]);
  assert.deepEqual(reviewersFor(config, settings, { user: { login: "Bob" } }), ["alice"]);
  assert.deepEqual(reviewersFor(config, { review: null }, PR), []);
  assert.deepEqual(reviewersFor(config, {}, PR), []);
});

test("runFields: the run whose pull request it is, as deny_github's input has it", () => {
  const record = (taskMode, more = {}) => ({ taskMode, light: false, reason: null, ...more });
  assert.deepEqual(runFields(record("work", { reason: "review-fix" })), {
    mode: "work",
    custom_mode: false,
    light: false,
    reason: "review-fix",
  });
  assert.equal(runFields(record("plan")).custom_mode, true);
  assert.deepEqual(runFields(null), { mode: null, custom_mode: false, light: false, reason: null });
});

// A fake GitHub for the reviewers: the pull request (`pull()`, changed as pushes would), the
// repo, its files and issue, and the reviewers' POST, answered `status`.
function fakeGitHub({ pull = () => PR, status = 201 } = {}) {
  const calls = [];
  const github = async (repo, method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/repos/org/repo/pulls/5") return Response.json(pull());
    if (method === "GET" && path === "/repos/org/repo") return Response.json({ private: true });
    if (method === "GET" && path.startsWith("/repos/org/repo/pulls/5/files")) {
      return Response.json(path.endsWith("page=1") ? [{ filename: "a.mjs" }] : []);
    }
    if (method === "GET" && path === "/repos/org/repo/issues/12") {
      return Response.json({ title: "A thing", labels: [{ name: "ui" }] });
    }
    if (method === "POST" && path === "/repos/org/repo/pulls/5/requested_reviewers") {
      return Response.json({}, { status });
    }
    return new Response("{}", { status: 404 });
  };
  const posts = () =>
    calls.filter((c) => c.method === "POST").map((c) => c.body.reviewers.join(","));
  return { github, calls, posts };
}

function setup(t, { yaml = "review:\n  request: [alice, bob]\n", run, ...over } = {}) {
  const gh = fakeGitHub(over);
  const decided = [];
  const logs = [];
  const read = parseRepoConfig(yaml, config);
  const reviewers = createReviewers({
    path: join(tempDir(t), "requested.json"),
    config,
    repoSettings: async () => read,
    github: gh.github,
    runOf: (key) => (key === "org/repo#12" ? (run ?? { taskMode: "work", light: false }) : null),
    policies: over.policies ?? null,
    decided: (repo, pr, entry) => decided.push(entry),
    log: (line) => logs.push(line),
    now: () => 1_800_000_000_000,
  });
  return { reviewers, decided, logs, ...gh };
}

test("ready: the repo's reviewers requested once per head, again after a fix pushed", async (t) => {
  let head = "sha-1";
  const s = setup(t, { pull: () => ({ ...PR, head: { ...PR.head, sha: head } }) });
  assert.deepEqual(await s.reviewers.ready("pull_request", delivery("ready_for_review")), [
    "alice",
    "bob",
  ]);
  // A redelivery, then the run that turned it ready ending at the same head: nothing more.
  assert.equal(await s.reviewers.ready("pull_request", delivery("ready_for_review")), null);
  assert.equal(await s.reviewers.pushed({ repo: "Org/Repo", base: "trunk", number: 5 }), null);
  assert.deepEqual(s.posts(), ["alice,bob"]);
  // A fix run pushed: asked again.
  head = "sha-2";
  await s.reviewers.pushed({ repo: "org/repo", base: "trunk", number: 5 });
  assert.deepEqual(s.posts(), ["alice,bob", "alice,bob"]);
  assert.match(s.logs.at(-1), /org\/repo#pr-5: reviewers requested \(fix\): alice, bob/);
  // Both at once: one request.
  head = "sha-3";
  await Promise.all([
    s.reviewers.pushed({ repo: "org/repo", base: "trunk", number: 5 }),
    s.reviewers.pushed({ repo: "org/repo", base: "trunk", number: 5 }),
  ]);
  assert.equal(s.posts().length, 3);
});

test("ready: nothing requested without review.request, on a draft, or someone else's", async (t) => {
  const none = setup(t, { yaml: "review: true\n" });
  assert.equal(await none.reviewers.ready("pull_request", delivery("ready_for_review")), null);
  // The settings say no: GitHub isn't even asked about the pull request.
  assert.deepEqual(none.calls, []);
  const outside = setup(t, { yaml: "review:\n  request: [carol]\n" });
  assert.equal(await outside.reviewers.ready("pull_request", delivery("ready_for_review")), null);
  assert.deepEqual(outside.calls, []);
  // Turned back to a draft, or no longer Deckhand's, when a run ends: no request.
  const draft = setup(t, { pull: () => ({ ...PR, draft: true }) });
  assert.equal(await draft.reviewers.pushed({ repo: "org/repo", base: "trunk", number: 5 }), null);
  const closed = setup(t, { pull: () => ({ ...PR, state: "closed" }) });
  assert.equal(await closed.reviewers.pushed({ repo: "org/repo", base: "trunk", number: 5 }), null);
  assert.deepEqual([...draft.posts(), ...closed.posts()], []);
  // GitHub refuses (a login that isn't a collaborator): said in the log.
  const refused = setup(t, { status: 422 });
  assert.equal(await refused.reviewers.ready("pull_request", delivery("ready_for_review")), null);
  assert.match(refused.logs.at(-1), /requesting alice, bob: GitHub answered 422/);
});

test("pushed: a ready pull request never asked about counts as turning ready", async (t) => {
  const policy = policyEngine(t, { files: { "r.rego": "package deckhand" }, ref: "trunk" });
  const s = setup(t, { policies: policy.engine });
  await s.reviewers.pushed({ repo: "org/repo", base: "trunk", number: 5 });
  assert.deepEqual(
    policy.evals.map((e) => [e.rule, e.when]),
    [["deny_request_review", "ready"]],
  );
});

test("deny_request_review: its input, a denial requests nothing and is kept for the task's page", async (t) => {
  const policy = policyEngine(t, {
    files: { "r.rego": "package deckhand" },
    ref: "trunk",
    messages: (input) => (input.mode === "plan" ? ["not in plan"] : []),
  });
  const s = setup(t, { policies: policy.engine });
  await s.reviewers.ready("pull_request", delivery("ready_for_review"));
  assert.deepEqual(s.posts(), ["alice,bob"]);
  const [input] = policy.evals;
  assert.deepEqual(
    [input.version, input.decision, input.reviewers, input.when],
    [1, "request_review", ["alice", "bob"], "ready"],
  );
  assert.deepEqual(
    [input.mode, input.custom_mode, input.light, input.reason],
    ["work", false, false, null],
  );
  assert.deepEqual([input.pr.number, input.pr.files[0].path, input.issue.number], [5, "a.mjs", 12]);
  assert.equal(input.review, null);
  assert.deepEqual(
    s.decided.map((d) => [d.decision, d.rule, d.denied, d.pr]),
    [["request_review", "deny_request_review", false, 5]],
  );
  // A repository mode's pull request, refused: nothing posted, the head not asked again.
  const plan = setup(t, { policies: policy.engine, run: { taskMode: "plan", light: false } });
  assert.equal(await plan.reviewers.ready("pull_request", delivery("ready_for_review")), null);
  assert.deepEqual(plan.posts(), []);
  assert.deepEqual(
    plan.decided.map((d) => [d.denied, d.messages]),
    [[true, ["not in plan"]]],
  );
  assert.match(plan.logs.at(-1), /reviewers not requested: not in plan/);
  await plan.reviewers.pushed({ repo: "org/repo", base: "trunk", number: 5 });
  assert.equal(plan.decided.length, 1);
});

test("requestInput: the pull request's input, its reviewers, when, and the run's fields", () => {
  const input = requestInput({
    info: { full_name: "org/repo", private: false, default_branch: "main" },
    pr: PR,
    files: [],
    issue: null,
    reviewers: ["alice"],
    when: "fix",
    run: runFields({ taskMode: "work", light: false, reason: "ci-fix" }),
    now: () => 0,
  });
  assert.deepEqual(
    [input.decision, input.reviewers, input.when, input.mode, input.reason, input.issue],
    ["request_review", ["alice"], "fix", "work", "ci-fix", null],
  );
  assert.ok(!("fixes" in input) && !("checks" in input));
});

// Deckhand's policy/gh-reviewers.rego, with the real opa, on what each kind of run would get.
function defaults(t, operator = new Map()) {
  return createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    run: opaRunner(),
    readBuiltIn: () => new Map([["gh-reviewers.rego", builtInPolicies().get("gh-reviewers.rego")]]),
    readOperator: () => operator,
    tmp: tempDir(t),
  });
}

const asked = (policies, mode, { custom_mode = false, reason = null, when = "ready" } = {}) =>
  policies.deny("deny_request_review", "org/repo", "main", () => ({
    decision: "request_review",
    pr: { number: 5 },
    reviewers: ["alice"],
    when,
    mode,
    custom_mode,
    light: false,
    reason,
  }));

test(
  "the real opa: gh-reviewers.rego requests on work runs' pull requests only",
  { skip: !opa && "no opa on the PATH" },
  async (t) => {
    const policies = defaults(t);
    for (const reason of [null, "review-fix", "ci-fix", "conflict"]) {
      for (const when of ["ready", "fix"]) {
        assert.deepEqual(await asked(policies, "work", { reason, when }), [], `${reason} ${when}`);
      }
    }
    assert.deepEqual(await asked(policies, "plan", { custom_mode: true }), [
      "reviewers aren't requested on the pull requests of the repository's mode plan",
    ]);
    assert.deepEqual(await asked(policies, "brainstorm"), [
      "reviewers are requested only on work runs' pull requests, not on a brainstorm run's",
    ]);
    assert.deepEqual(await asked(policies, null), ["the run whose pull request it is isn't known"]);
    // Broadened: a file of the same name replaces it, the repository's modes then get theirs.
    const broad = defaults(t, new Map([["gh-reviewers.rego", "package deckhand\n"]]));
    assert.deepEqual(await asked(broad, "plan", { custom_mode: true }), []);
  },
);
