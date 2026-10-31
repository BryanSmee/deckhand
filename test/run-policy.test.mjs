// The decision before a run a person starts (run-policy.mjs): its input, the refusal's reply,
// and Deckhand's policy/run.rego with the real opa.
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtInPolicies, createPolicies, opaRunner } from "../listener/policies.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import {
  createRunPolicy,
  personStarted,
  readTarget,
  runInput,
  runRefusedText,
  runTrigger,
  targetOf,
} from "../listener/run-policy.mjs";
import { createTaskModes } from "../listener/task-modes.mjs";
import { hasOpa, tempDir, testConfig } from "./helpers.mjs";

const config = testConfig();
const MODES = "modes:\n  plan:\n    instructions: .deckhand/plan.md\n    session: fresh\n";
const { settings } = parseRepoConfig(MODES, config);

// A comment by alice on org/repo#12, the issue itself unless `fields` say otherwise.
const itemOf = (fields = {}) => ({
  repo: "Org/Repo",
  id: "12",
  kind: "issue",
  number: 12,
  replyTo: 12,
  author: "alice",
  base: "main",
  settings,
  ...fields,
});

test("targetOf and runTrigger: where the comment is, and what started it", () => {
  assert.deepEqual(targetOf(itemOf()), { kind: "issue", number: 12 });
  // A comment on the pull request that closes the issue: the issue's task, the pull request's.
  assert.deepEqual(targetOf(itemOf({ replyTo: 30 })), { kind: "pr", number: 30 });
  assert.deepEqual(targetOf(itemOf({ kind: "pr", id: "pr-30", number: 30, replyTo: 30 })), {
    kind: "pr",
    number: 30,
  });
  const discussion = itemOf({ kind: "discussion", id: "discussion-4", number: 4, replyTo: 4 });
  assert.deepEqual(targetOf(discussion), { kind: "discussion", number: 4 });
  assert.equal(runTrigger(itemOf({ trigger: "work" })), "comment");
  assert.equal(runTrigger(itemOf({ trigger: "work", dashboard: true })), "dashboard");
  assert.equal(runTrigger(itemOf({ trigger: "idea", dashboard: true })), "inbox");
  assert.equal(runTrigger(itemOf({ trigger: "bug" })), "inbox");
  assert.equal(runTrigger(itemOf({ trigger: "discussion" })), "discussion");
  // The listener's own runs and an onboarding issue's aren't asked.
  assert.equal(personStarted(itemOf()), true);
  assert.equal(personStarted(itemOf({ reason: "conflict" })), false);
  assert.equal(personStarted(itemOf({ author: undefined })), false);
});

test("readTarget and runInput: the target's labels and author, a pull request's branches", async () => {
  const calls = [];
  const github = async (repo, method, path) => {
    calls.push(path);
    if (path === "/repos/Org/Repo/issues/12") {
      return Response.json({ labels: [{ name: "internal" }], user: { login: "bob" } });
    }
    if (path === "/repos/Org/Repo/pulls/30") {
      return Response.json({
        labels: [],
        user: { login: "deckhand[bot]" },
        draft: true,
        base: { ref: "main" },
        head: { ref: "issue-12-x" },
      });
    }
    return new Response("{}", { status: 404 });
  };
  const graphql = async (repo, query, variables) => {
    calls.push(`graphql ${variables.number}`);
    return {
      repository: {
        discussion: { author: { login: "carol" }, labels: { nodes: [{ name: "q" }] } },
      },
    };
  };
  const now = () => Date.parse("2026-10-30T10:00:00Z");
  const issue = itemOf({ trigger: "work" });
  const read = await readTarget({ github, graphql }, issue.repo, targetOf(issue));
  assert.deepEqual(runInput(issue, "work", read, now), {
    decision: "run",
    time: "2026-10-30T10:00:00.000Z",
    repo: "org/repo",
    mode: "work",
    custom_mode: false,
    light: false,
    fresh: false,
    trigger: "comment",
    sender: "alice",
    target: { kind: "issue", number: 12, labels: ["internal"], author: "bob" },
    issue: 12,
    pr: null,
  });
  const onPull = itemOf({ replyTo: 30, modeLine: "plan", dashboard: true });
  const pr = runInput(
    onPull,
    "plan",
    await readTarget({ github, graphql }, "Org/Repo", targetOf(onPull)),
    now,
  );
  assert.deepEqual(
    [pr.custom_mode, pr.fresh, pr.light, pr.trigger, pr.issue, pr.target, pr.pr],
    [
      true,
      true,
      false,
      "dashboard",
      12,
      { kind: "pr", number: 30, labels: [], author: "deckhand[bot]" },
      { draft: true, base: "main", head: "issue-12-x" },
    ],
  );
  const d = itemOf({ kind: "discussion", id: "discussion-4", number: 4, replyTo: 4 });
  const talk = runInput(
    d,
    "discussion",
    await readTarget({ github, graphql }, "Org/Repo", targetOf(d)),
    now,
  );
  assert.deepEqual(
    [talk.light, talk.issue, talk.target],
    [true, null, { kind: "discussion", number: 4, labels: ["q"], author: "carol" }],
  );
  assert.deepEqual(calls, ["/repos/Org/Repo/issues/12", "/repos/Org/Repo/pulls/30", "graphql 4"]);
  await assert.rejects(
    readTarget({ github, graphql }, "Org/Repo", { kind: "issue", number: 99 }),
    /404/,
  );
});

test("runRefusedText: the messages quoted as code", () => {
  assert.equal(
    runRefusedText("work", ["only @lead starts work runs", "not on `Fridays`"]),
    "No `work` run: the policies refuse it: `only @lead starts work runs`, `not on 'Fridays'`.",
  );
});

// task-modes.mjs's modeOf() with `policies` (decide() as policies.mjs's), for a comment
// `fields` on org/repo#12: the mode, the replies, the decisions kept and the issue's state.
async function asked(fields, decide, { brainstorm = null } = {}) {
  const replies = [];
  const kept = [];
  const issueModes = new Map();
  const ended = [];
  const ctx = {
    config,
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    issueModes,
    brainstorms: {
      get: () => brainstorm,
      end: (key) => ended.push(key),
      stop: (key) => ended.push(`stop ${key}`),
      activate: () => null,
    },
    answer: async (item, text) => replies.push([item.replyTo, text]),
    decisions: { record: (key, entry) => kept.push([key, entry]) },
    policies: { decide },
    github: async (repo, method, path) =>
      Response.json({ labels: [], user: { login: "bob" }, base: { ref: "main" }, head: {} }),
    runner: { hasSession: async () => false },
    onboarded: { isIssue: () => true },
  };
  const { modeOf } = createTaskModes(ctx);
  const mode = await modeOf(itemOf(fields), "Org/Repo#12", "deckhand-org-repo-12");
  return { mode, replies, kept, issueModes, ended };
}

test("a run the policies refuse: no mode, nothing changed on the issue, a reply quoting them", async () => {
  const inputs = [];
  const refusing = async (rule, repo, ref, input) => {
    inputs.push([rule, repo, ref, await input()]);
    return {
      applied: true,
      messages: ["no work runs on internal issues"],
      layers: [{ layer: "operator", allow: true, denies: ["no work runs on internal issues"] }],
      input: { version: 1 },
    };
  };
  const refused = await asked({ trigger: "work" }, refusing);
  assert.equal(refused.mode, null);
  assert.deepEqual(refused.replies, [
    [12, "No `work` run: the policies refuse it: `no work runs on internal issues`."],
  ]);
  // The brainstorm it would have ended goes on.
  assert.deepEqual(refused.ended, []);
  assert.equal(inputs[0][0], "deny_run");
  assert.equal(inputs[0][2], "main");
  assert.equal(inputs[0][3].mode, "work");
  // Kept for the task's page, as the other decisions.
  assert.equal(refused.kept.length, 1);
  assert.deepEqual(
    [refused.kept[0][0], refused.kept[0][1].decision, refused.kept[0][1].rule],
    ["Org/Repo#12", "run", "deny_run"],
  );
  assert.equal(refused.kept[0][1].denied, true);
  // A brainstorm's wrap-up refused: the brainstorm isn't stopped.
  const stop = await asked({ trigger: "stop" }, refusing, { brainstorm: { status: "active" } });
  assert.deepEqual([stop.mode, stop.ended], [null, []]);
  // A policy error refuses too, saying so.
  const failing = async () => ({ applied: true, messages: ["policy error: x.rego:3: oops"] });
  const error = await asked({ trigger: "work", modeLine: "plan" }, failing);
  assert.equal(error.mode, null);
  assert.deepEqual(error.replies, [
    [12, "No `plan` run: the policies refuse it: `policy error: x.rego:3: oops`."],
  ]);
});

test("a run the policies allow: its mode, nothing kept; the listener's own runs aren't asked", async () => {
  let calls = 0;
  const allowing = async (rule, repo, ref, input) => {
    calls++;
    await input();
    return { applied: true, messages: [], layers: [], input: {} };
  };
  const work = await asked({ trigger: "work" }, allowing);
  assert.deepEqual(
    [work.mode, work.replies, work.kept, work.ended],
    ["work", [], [], ["Org/Repo#12"]],
  );
  assert.equal(calls, 1);
  // A conflict run (reasons are the listener's) and an onboarding issue's run (no author).
  assert.equal((await asked({ trigger: "work", reason: "conflict" }, allowing)).mode, "work");
  assert.equal(
    (await asked({ modeLine: "onboarding", author: undefined }, allowing)).mode,
    "onboarding",
  );
  assert.equal(calls, 1);
  // Without policies, nothing is asked.
  const allowed = createRunPolicy({ log: () => {} });
  assert.equal(await allowed(itemOf(), "work", "Org/Repo#12"), true);
});

// policy/run.rego's answer for `mode` (custom: one of the repo's) on a `kind` target, with
// Deckhand's defaults only and a repo `.deckhand/policy/` of `repo` files (name → text).
function engine(t, repo = {}) {
  const github = async (name, method, path) => {
    if (path.startsWith("/repos/org/repo/contents/.deckhand/policy")) {
      return Response.json(Object.keys(repo).map((n) => ({ type: "file", name: n, sha: n })));
    }
    if (path.startsWith("/repos/org/repo/git/blobs/")) {
      const text = repo[path.split("/").pop()];
      return Response.json({ content: Buffer.from(text).toString("base64"), encoding: "base64" });
    }
    return new Response("{}", { status: 404 });
  };
  return createPolicies({
    config: {},
    github,
    run: opaRunner(),
    readOperator: () => new Map(),
    readBuiltIn: () => builtInPolicies(),
    tmp: tempDir(t),
  });
}

const runOf =
  (mode, kind, custom = false) =>
  () => ({
    decision: "run",
    repo: "org/repo",
    mode,
    custom_mode: custom,
    light: false,
    fresh: false,
    trigger: "comment",
    sender: "alice",
    target: { kind, number: 7, labels: [], author: "alice" },
    issue: kind === "issue" ? 7 : null,
    pr: kind === "pr" ? { draft: false, base: "main", head: "x" } : null,
  });

test(
  "the real opa: policy/run.rego allows each built-in mode on issues, brainstorm, stop and onboarding nowhere else",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const policies = engine(t);
    const issueOnly = new Set(["brainstorm", "stop", "onboarding"]);
    const builtIn = [
      "work",
      "brainstorm",
      "stop",
      "onboarding",
      "research",
      "review",
      "analyze",
      "idea",
      "bug",
    ];
    for (const mode of builtIn) {
      for (const kind of ["issue", "pr", "discussion"]) {
        const said = await policies.deny("deny_run", "org/repo", "main", runOf(mode, kind));
        const refused = kind !== "issue" && issueOnly.has(mode);
        const where = { pr: "a pull request", discussion: "a discussion" }[kind];
        assert.deepEqual(
          said,
          refused ? [`no rule allows a \`${mode}\` run on ${where}`] : [],
          `${mode} on ${kind}`,
        );
      }
    }
    assert.deepEqual(
      await policies.deny("deny_run", "org/repo", "main", runOf("discussion", "discussion")),
      [],
    );
    // A repository's own mode: the operator's run.rego allows it, the repository's allow is
    // needed too.
    assert.deepEqual(
      await policies.deny("deny_run", "org/repo", "main", runOf("plan", "issue", true)),
      ["no rule of .deckhand/policy/ allows a `plan` run on an issue"],
    );
    const own = engine(t, {
      "run.rego": `package deckhand

allow_run if input.mode == "plan"

deny_run contains "only alice starts work runs" if {
  input.mode == "work"
  input.sender != "alice"
}

deny_run contains "not on internal issues" if "internal" in input.target.labels
`,
    });
    for (const kind of ["issue", "pr"]) {
      assert.deepEqual(
        await own.deny("deny_run", "org/repo", "main", runOf("plan", kind, true)),
        [],
      );
    }
    const bob = () => ({ ...runOf("work", "issue")(), sender: "bob" });
    assert.deepEqual(await own.deny("deny_run", "org/repo", "main", bob), [
      "only alice starts work runs",
    ]);
    const internal = () => {
      const input = runOf("brainstorm", "issue")();
      return { ...input, target: { ...input.target, labels: ["internal"] } };
    };
    assert.deepEqual(await own.deny("deny_run", "org/repo", "main", internal), [
      "not on internal issues",
    ]);
    // The repository's run.rego replaces nothing: brainstorms stay off pull requests.
    assert.deepEqual(await own.deny("deny_run", "org/repo", "main", runOf("brainstorm", "pr")), [
      "no rule allows a `brainstorm` run on a pull request",
    ]);
  },
);
