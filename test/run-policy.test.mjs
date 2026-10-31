// The decision before a run a person starts (run-policy.mjs): its input, the refusal's reply,
// and Deckhand's policy/run.rego with the real opa.
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtInPolicies, createPolicies, opaRunner } from "../listener/policies.mjs";
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
    run: async (args) => (opa.push(args[0]), { code: 2, stdout: "", stderr: "no opa here" }),
    readOperator: () => new Map(),
    readBuiltIn: () => builtInPolicies(),
    tmp: tempDir(t),
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
    waits: { cancel: (key) => cancelled.push(key), request: async () => false },
    policies: { decide: async (rule) => (asked.push(rule), { applied: false, messages }) },
    github: async () => Response.json({ labels: [], user: { login: "bob" } }),
  };
  return { ctx, cancelled, asked, ...createTasks(ctx) };
}

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
    run: async () => assert.fail("no opa"),
    readOperator: () => new Map(),
    readBuiltIn: () => builtInPolicies(),
    tmp: tempDir(t),
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
  // A listener that never listed it refuses, saying to post the comment again.
  const fresh = createRunPolicy({
    policies: createPolicies({
      config: {},
      github: async () => new Response("{}", { status: 502 }),
      run: async () => ({ code: 2, stdout: "", stderr: "x" }),
      readOperator: () => new Map(),
      readBuiltIn: () => builtInPolicies(),
      tmp: tempDir(t),
    }),
    log: () => {},
    answer: async (item, text) => replies.push(text),
  });
  assert.equal(await fresh(work(), "work", "Org/Repo#12"), false);
  assert.match(replies[0], /policy error: the policies can't be read .*Post the comment again/);
});
