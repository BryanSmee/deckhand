// tasks.mjs's pools (#476): the shared pool (MAX_PARALLEL, AUTO_PICKUP_SLOTS, the repos'
// max_parallel) and the chats' (MAX_RUNNING_CHATS), each counted against its own cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startable } from "../listener/repo-config.mjs";
import { countRun, createTasks, newTask, poolOf, runningIn } from "../listener/tasks.mjs";
import { testConfig } from "./helpers.mjs";

// A scheduler on fake runs: `run(task)` counts it in its pool, as runs.mjs does, and `free(key)`
// ends it.
function scheduler(env = {}) {
  const tasks = new Map();
  const started = [];
  const ctx = {
    config: testConfig({ MAX_PARALLEL: "2", MAX_RUNNING_CHATS: "1", ...env }),
    log: () => {},
    skip: () => false,
    tasks,
    running: 0,
    run: (task) => {
      task.running = true;
      countRun(ctx, task, 1);
      started.push(`${task.repo}#${task.id}`);
    },
  };
  const add = (fields, { auto = false, at = 0 } = {}) => {
    const task = newTask({ repo: "org/app", kind: "issue", ...fields });
    task.pending.push({ mode: fields.kind === "chat" ? "chat" : "work", queuedAt: at, auto });
    if (auto) task.pending[0].autoPickup = true;
    task.ready = true;
    tasks.set(`${task.repo}#${task.id}`, task);
    return task;
  };
  const issue = (n, options) => add({ id: String(n), number: n }, options);
  const chat = (id, options) =>
    add({ id: `chat-${id}`, kind: "chat", number: null, owner: "alice", pool: "chats" }, options);
  const free = (key) => {
    const task = tasks.get(key);
    task.running = false;
    task.pending = [];
    countRun(ctx, task, -1);
  };
  return { ...createTasks(ctx), ctx, tasks, started, issue, chat, free };
}

test("a task's pool: a chat's own, any other shared; its owner kept", () => {
  assert.equal(poolOf(newTask({ kind: "issue" })), "shared");
  assert.equal(newTask({ kind: "issue" }).owner, null);
  const chat = newTask({ kind: "chat", owner: "alice", pool: "chats" });
  assert.deepEqual([chat.pool, chat.owner], ["chats", "alice"]);
  // Saved before tasks had a pool: a chat's by its kind.
  assert.equal(poolOf({ kind: "chat" }), "chats");
});

test("with every MAX_PARALLEL slot taken, a chat still starts, within MAX_RUNNING_CHATS", () => {
  const s = scheduler();
  s.issue(1);
  s.issue(2);
  s.issue(3);
  s.chat("a", { at: 1 });
  s.chat("b", { at: 2 });
  s.schedule();
  // Two issues (MAX_PARALLEL), one chat (MAX_RUNNING_CHATS), the oldest message first.
  assert.deepEqual(s.started, ["org/app#1", "org/app#2", "org/app#chat-a"]);
  assert.equal(s.ctx.running, 2);
  assert.equal(runningIn(s.ctx, "chats"), 1);
  // A chat's end frees a chat's slot, never an issue's.
  s.free("org/app#chat-a");
  s.schedule();
  assert.deepEqual(s.started.slice(3), ["org/app#chat-b"]);
  // And an issue's end an issue's.
  s.free("org/app#1");
  s.schedule();
  assert.deepEqual(s.started.slice(4), ["org/app#3"]);
});

test("a chat takes no part in the shared pool: the queue order, a repo's load, its max_parallel", () => {
  const s = scheduler({ MAX_PARALLEL: "3" });
  s.chat("a");
  s.schedule();
  assert.deepEqual(s.started, ["org/app#chat-a"]);
  s.chat("b");
  s.issue(1);
  // The board's queue and a repo's load (auto-pickup.mjs) are the shared pool's.
  assert.deepEqual(
    s.queueOrder().map((t) => t.id),
    ["1"],
  );
  assert.equal(s.repoLoad("org/app"), 1);
  // A repo whose max_parallel is 1 still starts its issue beside its running chat.
  s.tasks.get("org/app#1").settings = { maxParallel: 1 };
  s.schedule();
  assert.deepEqual(s.started, ["org/app#chat-a", "org/app#1"]);
});

test("auto-pickup fills no pool but shared: chats never take a reserved slot, nor count as picked", () => {
  const s = scheduler({ MAX_PARALLEL: "2", AUTO_PICKUP_SLOTS: "1", MAX_RUNNING_CHATS: "2" });
  s.chat("a");
  s.chat("b");
  s.issue(1, { auto: true });
  s.issue(2);
  s.schedule();
  assert.deepEqual(s.started.sort(), [
    "org/app#1",
    "org/app#2",
    "org/app#chat-a",
    "org/app#chat-b",
  ]);
  assert.equal(s.pickedCount(), 1);
  // startable() itself: a pool's tasks in their pool's slots alone, the reserved ones auto-picked
  // shared tasks'; a pool without a cap starts nothing.
  const task = (repo, pool = "shared", auto = false) => ({ repo, pool, auto });
  const pools = (caps, running = {}) => ({
    of: (t) => t.pool,
    caps: new Map(Object.entries(caps)),
    running: (pool) => running[pool] ?? 0,
  });
  const ready = [task("org/a", "chats"), task("org/b", "shared", true), task("org/c", "machine:1")];
  const chosen = startable(ready, new Map(), 2, 2, {
    reserved: 1,
    picked: (t) => t.auto,
    waiting: [ready[1]],
    pools: pools({ chats: 1 }),
  });
  assert.deepEqual(
    chosen.map((t) => t.repo),
    ["org/a"],
  );
  assert.deepEqual(
    startable(ready, new Map(), 0, 2, { pools: pools({ chats: 1 }, { chats: 1 }) }).map(
      (t) => t.repo,
    ),
    ["org/b"],
  );
});

test("pickedCount(): a repo's running chat doesn't hold back its queued auto-picked issue's reserved slot", () => {
  const s = scheduler({ MAX_PARALLEL: "3", AUTO_PICKUP_SLOTS: "1", MAX_RUNNING_CHATS: "1" });
  s.chat("a");
  s.schedule();
  assert.deepEqual(s.started, ["org/app#chat-a"]);
  // Queued in a repo whose max_parallel is 1, its chat running: still room for it there.
  const picked = s.issue(1, { auto: true });
  picked.settings = { maxParallel: 1 };
  picked.ready = false;
  assert.equal(s.pickedCount(), 1);
});

test("a chat with an agent that takes no messages mid-run (Codex): its messages wait for its next run", () => {
  const s = scheduler();
  const task = s.chat("a");
  task.running = true;
  task.live = { open: true, mode: "chat", record: { agent: "claude" } };
  assert.equal(s.deliverable(task), 1);
  task.live.record.agent = "codex";
  assert.equal(s.deliverable(task), 0);
});

test("deliver(): a chat's message logged as its owner's (`chat: true`), an issue's comment not", () => {
  const s = scheduler();
  const sent = [];
  Object.assign(s.ctx, { runner: { send: (id, message) => sent.push(id) }, saveLive: () => {} });
  const logged = (task) => {
    const lines = [];
    task.running = true;
    task.pending[0].text = "Run the tests";
    task.live = {
      id: `${task.id}-run`,
      key: task.id,
      open: true,
      mode: task.pending[0].mode,
      record: { agent: "claude" },
      later: {},
      handled: [],
      unanswered: [],
      logFile: { write: (line) => lines.push(JSON.parse(line)) },
    };
    task.next = {};
    assert.equal(s.deliver(task), true);
    return lines.map(({ at: _, ...line }) => line);
  };
  assert.deepEqual(logged(s.chat("a")), [
    { type: "listener", event: "delivered", message: "Run the tests", chat: true },
  ]);
  assert.deepEqual(logged(s.issue(1)), [
    { type: "listener", event: "delivered", message: "Run the tests" },
  ]);
  assert.equal(sent.length, 2);
});
