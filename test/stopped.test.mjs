// A stopped task (#1003): its mark, what lifts it, and the comments held behind its stopped run
// until a trigger (stopped.mjs, tasks.mjs queue() and holdStopped()).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { asksForRun, createStopped } from "../listener/stopped.mjs";
import { createTasks, newTask } from "../listener/tasks.mjs";
import { testConfig } from "./helpers.mjs";

const config = testConfig();

test("what asks for a run: a person's trigger or /mode line, anything from the dashboard", () => {
  assert.equal(asksForRun({ author: "alice", trigger: "work" }), true);
  assert.equal(asksForRun({ author: "alice", modeLine: "audit" }), true);
  assert.equal(asksForRun({ author: "alice", trigger: "work", autoPickup: true }), true);
  // The dashboard's answers (no trigger line), its Fix (the review loop's reason).
  assert.equal(asksForRun({ author: "alice", dashboard: true }), true);
  assert.equal(asksForRun({ author: "alice", dashboard: true, reason: "review-fix" }), true);
  // A plain comment, the listener's own runs.
  assert.equal(asksForRun({ author: "alice" }), false);
  assert.equal(asksForRun({ trigger: "work", reason: "conflict" }), false);
  assert.equal(asksForRun({ author: "alice", trigger: "work", reason: "ci-fix" }), false);
});

test("the mark: by task, whatever the repo's spelling, with who stopped it and when", () => {
  const map = new Map();
  const stopped = createStopped({ stopped: map });
  stopped.stop("Org/Repo#12", "alice", 5);
  assert.deepEqual([...map], [["org/repo#12", { by: "alice", at: 5 }]]);
  assert.deepEqual(stopped.get("org/repo#12"), { by: "alice", at: 5 });
  assert.equal(stopped.has("org/repo#13"), false);
  assert.equal(stopped.clear("ORG/repo#12"), true);
  assert.equal(stopped.clear("org/repo#12"), false);
  assert.equal(map.size, 0);
});

// createTasks() whose policies allow every run, the agent's session on #12 kept: a plain
// comment would go on in it.
function tasksOf(t) {
  const logs = [];
  const { settings } = parseRepoConfig("", config);
  const ctx = {
    config,
    log: (line) => logs.push(line),
    skip: (why) => {
      logs.push(`skip: ${why}`);
      return null;
    },
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {}, activate: () => null },
    runs: [],
    running: 0,
    run: () => {},
    titles: { set: () => {} },
    received: () => {},
    settle: async () => {},
    saveQueue: () => {},
    runner: { hasSession: async () => true },
    policies: { decide: async () => ({ applied: false, messages: [] }) },
    stopped: createStopped(),
  };
  Object.assign(ctx, createTasks(ctx));
  t.after(() => {
    for (const task of ctx.tasks.values()) clearTimeout(task.timer);
  });
  const item = (text, fields = {}) => ({
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
    replyTo: 12,
    base: "main",
    author: "alice",
    trigger: null,
    modeLine: null,
    text,
    settings,
    ...fields,
  });
  return { ctx, logs, item };
}

test("after a stop: a plain comment starts nothing; a trigger lifts it, the held comments first", async (t) => {
  const { ctx, logs, item } = tasksOf(t);
  const task = newTask({ repo: "org/repo", id: "12", kind: "issue", number: 12, base: "main" });
  ctx.tasks.set("org/repo#12", task);
  task.pending.push({ ...item("Queued during the run."), mode: "work" });
  ctx.stopped.stop("org/repo#12", "bob");
  // The stopped run's end: nothing starts, its follow-up waits.
  assert.equal(ctx.holdStopped(task), 1);
  assert.deepEqual(
    [task.pending, task.onHold.map((i) => i.text)],
    [[], ["Queued during the run."]],
  );
  assert.equal(task.timer, null);
  // A plain comment: skipped, nothing queued, no reply.
  assert.equal(await ctx.accept(item("Still there?")), null);
  assert.ok(logs.includes("skip: #12: its run was stopped, and no trigger line"), logs.join("\n"));
  assert.deepEqual(task.pending, []);
  // A trigger: the stop lifted, the comments held go first, in its run.
  assert.equal(await ctx.accept(item("Go on.", { trigger: "work" })), "work");
  assert.equal(ctx.stopped.has("org/repo#12"), false);
  assert.deepEqual(
    [task.pending.map((i) => i.text), task.onHold],
    [["Queued during the run.", "Go on."], []],
  );
  assert.ok(logs.includes("org/repo#12: no longer stopped"));
});

test("a trigger during the stopped run's end: nothing held, its follow-up starts as before", async (t) => {
  const { ctx, item } = tasksOf(t);
  const task = newTask({ repo: "org/repo", id: "12", kind: "issue", number: 12, base: "main" });
  task.running = true;
  ctx.tasks.set("org/repo#12", task);
  ctx.stopped.stop("org/repo#12", "bob");
  assert.equal(await ctx.accept(item("Go on.", { trigger: "work" })), "work");
  assert.equal(ctx.holdStopped(task), 0);
  assert.deepEqual(
    task.pending.map((i) => i.text),
    ["Go on."],
  );
  // Never stopped: nothing held either.
  const other = newTask({ repo: "org/repo", id: "13", kind: "issue", number: 13, base: "main" });
  other.pending.push(item("x"));
  assert.equal(ctx.holdStopped(other), 0);
});
