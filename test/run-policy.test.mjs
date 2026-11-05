// The decision before a run a person starts (run-policy.mjs): its input, the refusal's reply,
// and Deckhand's policy/run.rego with the real opa.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPolicies, SHIPPED_RUN_SHA256 } from "../listener/policies.mjs";
import { createPermissions } from "../listener/permissions.mjs";
import { builtInPolicies } from "../policy-service/engine.mjs";
import { opaBinary } from "../policy-service/opa.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import {
  createRunPolicy,
  defaultRun,
  personStarted,
  readTarget,
  runInput,
  runRefusedText,
  runTrigger,
  targetOf,
} from "../listener/run-policy.mjs";
import { createTaskModes } from "../listener/task-modes.mjs";
import { createTasks } from "../listener/tasks.mjs";
import { createWaits } from "../listener/waits.mjs";
import {
  MEMBER,
  VIEWER,
  hasOpa,
  localService,
  permissionsOf,
  policyEngineOf,
  tempDir,
  testConfig,
} from "./helpers.mjs";

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
    fresh: false,
    trigger: "comment",
    continues: false,
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
    [pr.custom_mode, pr.fresh, "light" in pr, pr.trigger, pr.issue, pr.target, pr.pr],
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
    ["light" in talk, talk.issue, talk.target],
    [false, null, { kind: "discussion", number: 4, labels: ["q"], author: "carol" }],
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
async function asked(
  fields,
  decide,
  { brainstorm = null, policies = { decide }, issueModes = new Map(), reads = [] } = {},
) {
  const replies = [];
  const kept = [];
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
    policies,
    github: async (repo, method, path) => {
      reads.push(path);
      return Response.json({ labels: [], user: { login: "bob" }, base: { ref: "main" }, head: {} });
    },
    runner: { hasSession: async () => false },
    onboarded: { isIssue: () => true },
  };
  const { modeOf } = createTaskModes(ctx);
  const item = itemOf(fields);
  const mode = await modeOf(item, "Org/Repo#12", "deckhand-org-repo-12");
  return { mode, replies, kept, issueModes, ended, item };
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
    [
      12,
      "No `plan` run: the policies refuse it: `policy error: x.rego:3: oops`. Post the comment again once it is fixed.",
    ],
  ]);
});

test("deny_run refuses: its input read from the issue the comment is on, and kept with the decision", async () => {
  const reads = [];
  const refusing = async (rule, repo, ref, input) => ({
    applied: true,
    messages: ["not today"],
    input: await input(),
  });
  const refused = await asked({ trigger: "work" }, refusing, { reads });
  assert.deepEqual(refused.replies, [[12, "No `work` run: the policies refuse it: `not today`."]]);
  assert.deepEqual(reads, ["/repos/Org/Repo/issues/12"]);
  const [[key, kept]] = refused.kept;
  assert.equal(key, "Org/Repo#12");
  assert.deepEqual(
    [kept.decision, kept.rule, kept.denied, kept.messages, kept.input.mode, kept.input.sender],
    ["run", "deny_run", true, ["not today"], "work", "alice"],
  );
  // The dashboard's answer says it too (work.mjs).
  assert.equal(refused.item.refused, "No `work` run: the policies refuse it: `not today`.");
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

// Deckhand's policies as shipped, an opa that records each call (none expected), and a repo
// with no policy file (`repo`: name → text, else).
function shipped(t, repo = {}) {
  const opa = [];
  const github = async (name, method, path) => {
    if (path.startsWith("/repos/Org/Repo/contents/.deckhand/policy")) {
      if (!Object.keys(repo).length) return new Response("{}", { status: 404 });
      return Response.json(Object.keys(repo).map((n) => ({ type: "file", name: n, sha: n })));
    }
    return new Response("{}", { status: 404 });
  };
  const policies = createPolicies({
    config: {},
    github,
    // The policy service, with Deckhand's files: asked for them, never to evaluate.
    service: localService(
      policyEngineOf(t, {
        opa: {
          run: async (args) => (opa.push(args[0]), { code: 2, stdout: "", stderr: "no opa here" }),
          serve: async () => (opa.push("serve"), assert.fail("no opa server")),
        },
        readBuiltIn: () => builtInPolicies(),
      }),
    ),
  });
  return { policies, opa };
}

test("Deckhand's defaults alone: run.rego decided without opa or a GitHub read; a conversation goes on from a pull request", async (t) => {
  const { policies, opa } = shipped(t);
  const reads = [];
  const decide = () => assert.fail("decide() isn't asked");
  const options = (more = {}) => ({ policies, reads, ...more });
  // A work run on the issue, and a work run from the pull request that closes it.
  assert.equal((await asked({ trigger: "work" }, decide, options())).mode, "work");
  assert.equal((await asked({ trigger: "work", replyTo: 30 }, decide, options())).mode, "work");
  // /mode brainstorm on the pull request: refused, said, kept for the task's page.
  const brainstorm = await asked(
    { trigger: "work", modeLine: "brainstorm", replyTo: 30 },
    decide,
    options(),
  );
  assert.equal(brainstorm.mode, null);
  assert.deepEqual(brainstorm.replies, [
    [
      30,
      "No `brainstorm` run: the policies refuse it: `no rule allows a 'brainstorm' run on a pull request`.",
    ],
  ]);
  assert.equal(brainstorm.item.refused, brainstorm.replies[0][1]);
  assert.deepEqual(
    [brainstorm.kept[0][1].decision, brainstorm.kept[0][1].denied, brainstorm.kept[0][1].pr],
    ["run", true, 30],
  );
  // The issue in onboarding: a plain comment on its pull request goes on in it (`continues`),
  // as before; `/mode onboarding` there doesn't start it.
  const onboarding = () => new Map([["Org/Repo#12", "onboarding"]]);
  const goesOn = await asked({ replyTo: 30 }, decide, options({ issueModes: onboarding() }));
  assert.deepEqual([goesOn.mode, goesOn.replies], ["onboarding", []]);
  const started = await asked(
    { modeLine: "onboarding", replyTo: 30 },
    decide,
    options({ issueModes: onboarding() }),
  );
  assert.equal(started.mode, null);
  // A repo's own mode, with no repo file to allow it.
  const plan = await asked({ trigger: "work", modeLine: "plan" }, decide, options());
  assert.match(
    plan.replies[0][1],
    /no rule of \.deckhand\/policy\/ allows a 'plan' run on an issue/,
  );
  // No opa started, no issue or pull request read.
  assert.deepEqual([opa, reads], [[], []]);
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
    service: localService(
      policyEngineOf(t, { opa: opaBinary(), readBuiltIn: () => builtInPolicies() }),
    ),
  });
}

const runOf =
  (mode, kind, custom = false) =>
  () => ({
    decision: "run",
    repo: "org/repo",
    mode,
    custom_mode: custom,
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
    const items = {
      issue: (more) => itemOf(more),
      pr: (more) => itemOf({ replyTo: 30, ...more }),
      discussion: (more) =>
        itemOf({ kind: "discussion", id: "discussion-4", number: 4, replyTo: 4, ...more }),
    };
    for (const mode of [...builtIn, "plan"]) {
      for (const kind of ["issue", "pr", "discussion"]) {
        for (const goesOn of [false, true]) {
          const item = items[kind](goesOn ? {} : { trigger: "work" });
          const input = () => runInput(item, mode, { labels: [], author: "alice", pr: null });
          const said = await policies.deny("deny_run", "org/repo", "main", input);
          const what = `${mode} on ${kind}${goesOn ? ", going on" : ""}`;
          // What the listener decides without opa is what opa says of the file.
          assert.deepEqual(said, defaultRun(item, mode), what);
          if (mode === "plan") continue;
          const refused = kind !== "issue" && !goesOn && issueOnly.has(mode);
          const where = { pr: "a pull request", discussion: "a discussion" }[kind];
          assert.deepEqual(
            said,
            refused ? [`no rule allows a \`${mode}\` run on ${where}`] : [],
            what,
          );
        }
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

test("tasks.mjs accept(): a follow-up waits for the comment before it while the policies decide", async () => {
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  const asks = [];
  const ctx = {
    config: testConfig({ DEBOUNCE_MS: "0" }),
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {} },
    runs: [],
    running: 0,
    run: () => {},
    titles: { set: () => {} },
    received: () => {},
    runner: { hasSession: async () => false },
    answer: async () => {},
    // The first comment's decision is slow; the follow-up's quick.
    policies: {
      decide: async (rule, repo, ref, input) => {
        const { trigger } = await input();
        asks.push(trigger);
        if (asks.length === 1) await slow;
        return { applied: false, messages: [] };
      },
    },
    github: async () => Response.json({ labels: [], user: { login: "bob" } }),
  };
  const { accept } = createTasks(ctx);
  const first = accept(itemOf({ trigger: "work", text: "Fix it." }));
  // No trigger line: it only goes on in a task that exists, which the first creates.
  const second = accept(itemOf({ trigger: null, text: "And the dates." }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Not asked yet: it waits for the first.
  assert.equal(asks.length, 1);
  release();
  await Promise.all([first, second]);
  const task = ctx.tasks.get("Org/Repo#12");
  clearTimeout(task.timer);
  assert.deepEqual(
    task.pending.map((i) => [i.text, i.mode]),
    [
      ["Fix it.", "work"],
      ["And the dates.", "work"],
    ],
  );
});

// createTasks() with the policies saying `messages` to every run: the ctx, and the waits cancelled.
function refusingTasks(messages) {
  const cancelled = [];
  const asked = [];
  const ctx = {
    config: testConfig({ DEBOUNCE_MS: "0" }),
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {} },
    runs: [],
    running: 0,
    run: () => {},
    titles: { set: () => {} },
    received: () => {},
    reply: async () => {},
    answer: async () => {},
    runner: { hasSession: async () => false },
    repoSettings: async () => ({ settings, errors: [] }),
    waits: {
      reserve: () => {},
      release: async (key, replaced) => replaced && cancelled.push(key),
      request: async () => false,
    },
    policies: { decide: async (rule) => (asked.push(rule), { applied: false, messages }) },
    github: async () => Response.json({ labels: [], user: { login: "bob" } }),
  };
  return { ctx, cancelled, asked, ...createTasks(ctx) };
}

test("tasks.mjs admit(): a follow-up whose checks answer first still waits for the comment before it", async () => {
  const payload = (id, body) => ({
    action: "created",
    installation: { id: 7 },
    repository: { full_name: "Org/Repo", default_branch: "main" },
    issue: { number: 12, title: "Twelve" },
    comment: { id, body, user: { login: "alice", type: "User" } },
    sender: { login: "alice" },
  });
  const { ctx, admit } = refusingTasks([]);
  // The first comment's repo settings come back last: a burst of comments, each reading them.
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  const read = ctx.repoSettings;
  let reads = 0;
  ctx.repoSettings = async (...args) => (reads++ === 0 && (await slow), read(...args));
  const first = { repo: "Org/Repo", id: 12, base: "main", trigger: "work", replyTo: 12 };
  const trigger = admit(
    { ...first, kind: "issue" },
    "issue_comment",
    payload(99, "Deckhand\nFix it."),
  );
  // No trigger line: it only goes on in a task that exists, which the first creates.
  const followUp = admit(
    { ...first, trigger: null, kind: "issue" },
    "issue_comment",
    payload(100, "And the dates."),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reads, 1);
  release();
  await Promise.all([trigger, followUp]);
  const task = ctx.tasks.get("Org/Repo#12");
  clearTimeout(task.timer);
  assert.deepEqual(
    task.pending.map((i) => i.text),
    ["Fix it.", "And the dates."],
  );
});

test("tasks.mjs: a refused trigger comment keeps the issue's wait; a refused waiting comment isn't started", async () => {
  const payload = (body) => ({
    action: "created",
    installation: { id: 7 },
    repository: { full_name: "Org/Repo", default_branch: "main" },
    issue: { number: 12, title: "Twelve" },
    comment: { id: 99, body, user: { login: "alice", type: "User" } },
    sender: { login: "alice" },
  });
  const first = { repo: "Org/Repo", base: "main", trigger: "work", replyTo: 12, kind: "issue" };
  const refused = refusingTasks(["not today"]);
  await refused.admit(first, "issue_comment", payload("Deckhand\nShip it."));
  assert.deepEqual(
    [refused.asked, refused.cancelled, refused.ctx.tasks.size],
    [["deny_run"], [], 0],
  );
  const allowed = refusingTasks([]);
  await allowed.admit(first, "issue_comment", payload("Deckhand\nShip it."));
  assert.deepEqual(allowed.cancelled, ["Org/Repo#12"]);
  clearTimeout(allowed.ctx.tasks.get("Org/Repo#12").timer);
  // A comment that waited (/after): refused, resume() says it didn't start (waits.mjs then
  // settles it as stopped, and says nothing of a start).
  const waited = itemOf({ trigger: "work", text: "Ship it.", eyes: true });
  assert.equal(await refused.resume(waited), false);
  const started = await allowed.resume(itemOf({ trigger: "work", text: "Ship it.", eyes: true }));
  assert.equal(started, true);
});

test("Deckhand's defaults alone: GitHub failing to list the repo's policies again keeps its last listing", async (t) => {
  let clock = 0;
  let status = 404;
  const lists = [];
  const policies = createPolicies({
    config: {},
    github: async (repo, method, path) => {
      if (path.includes("/contents/.deckhand/policy")) lists.push(status);
      return new Response("{}", { status });
    },
    service: localService(
      policyEngineOf(t, {
        opa: { run: async () => assert.fail("no opa"), serve: async () => assert.fail("no opa") },
        readBuiltIn: () => builtInPolicies(),
      }),
    ),
    now: () => clock,
  });
  const replies = [];
  const allowed = createRunPolicy({
    policies,
    log: () => {},
    answer: async (item, text) => replies.push(text),
  });
  const work = () => itemOf({ trigger: "work" });
  assert.equal(await allowed(work(), "work", "Org/Repo#12"), true);
  // Past the listing's 10 minutes, GitHub fails: the last listing (none) holds.
  clock = 11 * 60_000;
  status = 502;
  assert.equal(await allowed(work(), "work", "Org/Repo#12"), true);
  assert.deepEqual(lists, [404, 502]);
  assert.deepEqual(replies, []);
  // Other decisions don't take a stale listing: they fail closed.
  await assert.rejects(policies.policiesFor("Org/Repo", "main"), /502/);
  // Nor run, past an hour without a listing: refused, saying to post the comment again.
  clock = 61 * 60_000;
  assert.equal(await allowed(work(), "work", "Org/Repo#12"), false);
  assert.match(replies.at(-1), /policy error: the policies can't be read/);
  replies.length = 0;
  // A listener that never listed it refuses, saying to post the comment again.
  const fresh = createRunPolicy({
    policies: createPolicies({
      config: {},
      github: async () => new Response("{}", { status: 502 }),
      service: localService(
        policyEngineOf(t, {
          opa: { run: async () => ({ code: 2, stdout: "", stderr: "x" }), serve: async () => {} },
          readBuiltIn: () => builtInPolicies(),
        }),
      ),
    }),
    log: () => {},
    answer: async (item, text) => replies.push(text),
  });
  assert.equal(await fresh(work(), "work", "Org/Repo#12"), false);
  assert.match(replies[0], /policy error: the policies can't be read .*Post the comment again/);
});

test("Deckhand's defaults alone, with permissions: GitHub failing on the repository keeps what it last said (#785)", async (t) => {
  let clock = 0;
  let down = false;
  const reads = [];
  const logs = [];
  const policies = createPolicies({
    config: {},
    github: async (repo, method, path) => {
      if (path === "/repos/Org/Repo") reads.push(down ? 502 : 200);
      if (down) return new Response("{}", { status: 502 });
      if (path === "/repos/Org/Repo") {
        return Response.json({ full_name: "Org/Repo", private: true, default_branch: "main" });
      }
      return new Response("{}", { status: 404 });
    },
    service: localService(
      policyEngineOf(t, {
        opa: { run: async () => assert.fail("no opa"), serve: async () => assert.fail("no opa") },
        readBuiltIn: () => builtInPolicies(),
      }),
    ),
    log: (line) => logs.push(line),
    now: () => clock,
  });
  const replies = [];
  const allowed = createRunPolicy({
    policies,
    permissions: createPermissions({ policies }),
    log: () => {},
    answer: async (item, text) => replies.push(text),
  });
  const work = () => itemOf({ trigger: "work" });
  assert.equal(await allowed(work(), "work", "Org/Repo#12"), true);
  // Past what GitHub said of it (60 s) and the listing (10 minutes), GitHub fails: both hold.
  clock = 11 * 60_000;
  down = true;
  assert.equal(await allowed(work(), "work", "Org/Repo#12"), true);
  assert.ok(await policies.can("alice", "Org/Repo", "logs:read"));
  assert.deepEqual(reads.slice(0, 2), [200, 502]);
  assert.ok(logs.some((l) => /Org\/Repo: reading the repository: .*last said kept/.test(l)));
  assert.deepEqual(replies, []);
  // Past an hour: nothing, as every other decision.
  clock = 61 * 60_000;
  assert.equal(await allowed(work(), "work", "Org/Repo#12"), false);
  assert.match((await policies.access("alice", "Org/Repo")).error, /can't be read/);
  // Back: read again. Its push forgets it: GitHub down then gives nothing.
  down = false;
  assert.ok(await policies.can("alice", "Org/Repo", "logs:read"));
  policies.forget("Org/Repo");
  down = true;
  assert.match((await policies.access("alice", "Org/Repo")).error, /can't be read/);
  // Nothing posted for any of it: a refused or undecided author gets no reply.
  assert.deepEqual(replies, []);
});

test("waits.mjs reserve(): a blocker done while a new comment is decided starts nothing until it is released", async (t) => {
  const resumed = [];
  const replies = [];
  const waits = createWaits({
    github: async () => new Response("{}", { status: 404 }),
    reply: async (repo, number, text) => replies.push(text),
    received: () => {},
    settle: async () => {},
    resume: async (item) => (resumed.push(item.text), true),
  });
  const item = itemOf({ trigger: "work", text: "After #7.", comment: { id: 1 } });
  await waits.hold(item, [7]);
  // Replaced: #7 done meanwhile starts nothing, and the wait goes.
  let held = waits.reserve("Org/Repo#12");
  await waits.closed("Org/Repo", 7, "done");
  assert.deepEqual(resumed, []);
  await waits.release("Org/Repo#12", true, "a new comment replaces it", held);
  assert.equal(waits.get("Org/Repo#12"), undefined);
  assert.deepEqual(resumed, []);
  // Refused: what came meanwhile is replayed, the waiting comment starts.
  await waits.hold(item, [7]);
  held = waits.reserve("Org/Repo#12");
  await waits.closed("Org/Repo", 7, "done");
  assert.deepEqual(resumed, []);
  await waits.release("Org/Repo#12", false, null, held);
  assert.deepEqual(resumed, ["After #7."]);
  assert.match(replies.at(-1), /^#7 is done: starting\./);
  // An "/after #9" posted while a comment is decided: a newer wait, which that comment's
  // run doesn't drop. Neither does one with no wait held.
  held = waits.reserve("Org/Repo#12");
  assert.equal(held, null);
  await waits.hold({ ...item, text: "After #9." }, [9]);
  await waits.release("Org/Repo#12", true, "a new comment replaces it", held);
  assert.deepEqual(waits.get("Org/Repo#12").blockers, [9]);
  held = waits.reserve("Org/Repo#12");
  await waits.hold({ ...item, text: "After #10." }, [10]);
  await waits.release("Org/Repo#12", true, "a new comment replaces it", held);
  assert.deepEqual(waits.get("Org/Repo#12").blockers, [10]);
});

test("tasks.mjs: a refused comment whose /after issues are all done keeps the issue's earlier wait", async (t) => {
  const { ctx, admit } = refusingTasks(["not today"]);
  ctx.waits = createWaits({
    // #7 is done; anything else is open.
    github: async (repo, method, path) =>
      Response.json(
        path.endsWith("/issues/7")
          ? { state: "closed", state_reason: "completed" }
          : { state: "open" },
      ),
    reply: async () => {},
    received: () => {},
    settle: async () => {},
    resume: async () => true,
  });
  await ctx.waits.hold(itemOf({ trigger: "work", text: "After #9.", comment: { id: 1 } }), [9]);
  const payload = {
    action: "created",
    installation: { id: 7 },
    repository: { full_name: "Org/Repo", default_branch: "main" },
    issue: { number: 12, title: "Twelve" },
    comment: {
      id: 99,
      body: "Deckhand /after #7\nShip it.",
      user: { login: "alice", type: "User" },
    },
    sender: { login: "alice" },
  };
  const first = { repo: "Org/Repo", base: "main", trigger: "work", replyTo: 12, kind: "issue" };
  await admit(first, "issue_comment", payload);
  assert.deepEqual(ctx.waits.get("Org/Repo#12").blockers, [9]);
  assert.equal(ctx.tasks.size, 0);
});

test("SHIPPED_RUN_SHA256 is policy/run.rego's: the listener decides as the run.rego it ships", () => {
  const text = readFileSync(new URL("../policy/run.rego", import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), SHIPPED_RUN_SHA256);
});

test("access: a run starts only for an author with its mode's start, refused without a reply", async () => {
  const logs = [];
  const replies = [];
  const permissions = permissionsOf({
    alice: { "org/repo": MEMBER },
    bob: { "org/repo": VIEWER },
    carol: { "org/repo": ["runs:start:brainstorm"] },
  });
  const allowed = createRunPolicy({
    permissions,
    log: (line) => logs.push(line),
    answer: async (item, text) => replies.push(text),
  });
  assert.equal(await allowed(itemOf(), "work", "Org/Repo#12"), true);
  const viewer = itemOf({ author: "bob" });
  assert.equal(await allowed(viewer, "work", "Org/Repo#12"), false);
  assert.match(viewer.refused, /bob may not start it here \(`runs:start:work`\)/);
  assert.match(logs.join("\n"), /Org\/Repo#12: work run refused: bob has no runs:start:work here/);
  // The mode it resolves to: a brainstorm, not work.
  assert.equal(await allowed(itemOf({ author: "carol" }), "brainstorm", "Org/Repo#12"), true);
  assert.equal(await allowed(itemOf({ author: "carol" }), "work", "Org/Repo#12"), false);
  // Someone on no repo of the decision's: nothing.
  assert.equal(await allowed(itemOf({ author: "dave" }), "work", "Org/Repo#12"), false);
  // The listener's own runs and an onboarding issue's aren't anyone's.
  assert.equal(await allowed(itemOf({ author: "bob", reason: "conflict" }), "work", "k"), true);
  assert.equal(await allowed(itemOf({ author: undefined }), "onboarding", "k"), true);
  // Nothing said on GitHub: as an author outside the repo's users.
  assert.deepEqual(replies, []);
});

test("access: /cancel stops a run only for an author with runs:manage, and says nothing otherwise", async () => {
  const cancelled = [];
  const replies = [];
  const settled = [];
  const ctx = {
    config: testConfig({ ALLOWED_USERS: "alice,bob" }),
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    runs: [],
    permissions: permissionsOf({ alice: { "org/repo": MEMBER }, bob: { "org/repo": VIEWER } }),
    repoSettings: async () => ({ settings: { users: ["alice", "bob"], modes: {} }, errors: [] }),
    cancel: (key, user) => (cancelled.push([key, user]), "running"),
    settle: async (item, status) => settled.push([item.author, status]),
    reply: async (repo, number, text) => replies.push(text),
  };
  const { admit } = createTasks(ctx);
  const cancel = (login) => {
    const payload = {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "main" },
      issue: { number: 12 },
      comment: { id: 99, body: "/cancel", user: { login, type: "User" } },
      sender: { login },
    };
    return admit({ repo: "org/repo", id: "12", base: "main" }, "issue_comment", payload);
  };
  await cancel("bob");
  assert.deepEqual([cancelled, replies, settled], [[], [], []]);
  await cancel("alice");
  assert.deepEqual(cancelled, [["org/repo#12", "alice"]]);
  assert.deepEqual(settled, [["alice", "acknowledged"]]);
});

test("access: /after and /mode policy do nothing, and say nothing, for an author without the action", async () => {
  const requested = [];
  const replies = [];
  const dryRuns = [];
  const ctx = {
    config: testConfig({ ALLOWED_USERS: "alice,bob,carol" }),
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    runs: [],
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {} },
    permissions: permissionsOf({
      alice: { "org/repo": MEMBER },
      bob: { "org/repo": VIEWER },
      carol: { "org/repo": ["tasks:read", "runs:manage"] },
    }),
    repoSettings: async () => parseRepoConfig("", testConfig({ ALLOWED_USERS: "alice,bob,carol" })),
    // What waits.mjs request() would do: hold, or drop the wait, with a reply.
    waits: {
      request: async (item) => (requested.push([item.author, item.after]), true),
      reserve: () => null,
      release: async () => {},
    },
    reviews: { dryRun: async ({ by }) => (dryRuns.push(by), { text: "No denial.", denials: [] }) },
    reply: async (repo, number, text) => (replies.push(text), null),
  };
  const { admit } = createTasks(ctx);
  const say = (login, body, pr = false) => {
    const payload = {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "main" },
      issue: { number: 12, ...(pr && { pull_request: {} }) },
      comment: { id: 99, body, user: { login, type: "User" } },
      sender: { login },
    };
    const id = pr ? "pr-12" : "12";
    return admit({ repo: "org/repo", id, base: "main" }, "issue_comment", payload);
  };
  // A viewer: no wait held, none dropped.
  await say("bob", "Deckhand /after #7");
  await say("bob", "/after none");
  // A manager may drop a wait, not hold one back with a start.
  await say("carol", "Deckhand /after #7");
  await say("carol", "/after none");
  await say("alice", "Deckhand /after #7");
  assert.deepEqual(
    requested.map(([who]) => who),
    ["carol", "alice"],
  );
  // The dry run's reply says what the policies refuse: not for someone without tasks:read.
  await say("dave", "/mode policy", true);
  await say("bob", "/mode policy", true);
  assert.deepEqual(dryRuns, ["bob"]);
  assert.deepEqual(replies, ["No denial."]);
});

test("access: a start whose decision fails is refused, saying it couldn't be decided", async () => {
  const logs = [];
  const allowed = createRunPolicy({
    permissions: permissionsOf({ alice: { "org/repo": MEMBER } }, { failing: ["alice"] }),
    log: (line) => logs.push(line),
    answer: async () => {},
  });
  const item = itemOf();
  assert.equal(await allowed(item, "work", "Org/Repo#12"), false);
  assert.match(item.refused, /who may start it can't be decided now/);
  assert.match(logs.join("\n"), /alice's runs:start:work can't be decided \(the policies/);
});

test("access: no reply about a run for an author who may not start it, nor any for one with no action", async () => {
  const replies = [];
  const settled = [];
  let errors = [];
  const config = testConfig({ ALLOWED_USERS: "alice,bob,carol" });
  const ctx = {
    config,
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    runs: [],
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {} },
    // alice a member, bob a viewer, carol nothing.
    permissions: permissionsOf({ alice: { "org/repo": MEMBER }, bob: { "org/repo": VIEWER } }),
    // `review: true`: a review a comment may ask for.
    repoSettings: async () => ({ ...parseRepoConfig("review: true\n", config), errors }),
    waits: { request: async () => true, reserve: () => null, release: async () => {} },
    reply: async (repo, number, text) => (replies.push(text), null),
    settle: async (item, status) => settled.push([item.author, status]),
  };
  const { admit } = createTasks(ctx);
  const say = (login, body, issue = {}) => {
    const payload = {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "main" },
      issue: { number: 12, ...issue },
      comment: { id: 99, body, user: { login, type: "User" } },
      sender: { login },
    };
    return admit(
      { repo: "org/repo", id: "12", base: "main", author: login, trigger: "work", replyTo: 12 },
      "issue_comment",
      payload,
    );
  };
  // An issue whose open questions hold work back.
  const asking = {
    body: "Do it.\n\n## Open questions\n\n1. Which one?",
    labels: [{ name: "needs-input" }],
  };
  await say("bob", "Deckhand", asking);
  // An unknown mode.
  await say("bob", "Deckhand\n/mode nope");
  // The config's errors, to someone with no action at all.
  errors = ["`modes` is broken"];
  await say("carol", "Deckhand");
  errors = [];
  // Research without its grant, a review asked on an issue, a mode gone from the config.
  const gone = () => ctx.issueModes.set("org/repo#12", "gone");
  await say("bob", "Deckhand\n/mode research");
  await say("bob", "Deckhand\n/mode review");
  gone();
  await say("bob", "Go on.");
  ctx.issueModes.clear();
  assert.deepEqual([replies, settled], [[], []]);
  // A member gets each of them.
  errors = ["`modes` is broken"];
  await say("alice", "Deckhand");
  errors = [];
  await say("alice", "Deckhand\n/mode nope");
  await say("alice", "Deckhand", asking);
  await say("alice", "Deckhand\n/mode research");
  await say("alice", "Deckhand\n/mode review");
  gone();
  await say("alice", "Go on.");
  assert.equal(replies.length, 6);
  assert.match(replies[0], /has errors/);
  assert.match(replies[1], /Unknown mode `nope`/);
  assert.match(replies[2], /#12 has open questions: nothing starts/);
  assert.match(replies[3], /^Research can't run here/);
  assert.match(replies[4], /^A review is of a pull request/);
  assert.match(replies[5], /The mode `gone` is no longer in/);
});

test("access: a decision that fails starts nothing and says nothing, the log saying it couldn't be decided", async () => {
  const logs = [];
  const replies = [];
  const cancelled = [];
  const config = testConfig({ ALLOWED_USERS: "alice" });
  const ctx = {
    config,
    log: (line) => logs.push(line),
    skip: () => null,
    tasks: new Map(),
    runs: [],
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {} },
    permissions: permissionsOf({ alice: { "org/repo": MEMBER } }, { failing: ["alice"] }),
    // Errors a reply would name, were alice known to see the repo.
    repoSettings: async () => ({ ...parseRepoConfig("", config), errors: ["`modes` is broken"] }),
    waits: { request: async () => true, reserve: () => null, release: async () => {} },
    cancel: (key, user) => (cancelled.push([key, user]), "running"),
    reply: async (repo, number, text) => (replies.push(text), null),
    settle: async () => {},
  };
  const { admit } = createTasks(ctx);
  const say = (body) => {
    const payload = {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "main" },
      issue: { number: 12 },
      comment: { id: 99, body, user: { login: "alice", type: "User" } },
      sender: { login: "alice" },
    };
    return admit(
      { repo: "org/repo", id: "12", base: "main", author: "alice", trigger: "work", replyTo: 12 },
      "issue_comment",
      payload,
    );
  };
  await say("Deckhand");
  await say("/cancel");
  assert.deepEqual([replies, cancelled, ctx.tasks.size], [[], [], 0]);
  // Told apart from a refusal: not "has no action here".
  assert.match(
    logs.join("\n"),
    /org\/repo#12: alice's access can't be decided \(the policies can't be read\)/,
  );
  assert.doesNotMatch(logs.join("\n"), /alice has no/);
});
