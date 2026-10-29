import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createOrder } from "../listener/order.mjs";
import { newTask, createTasks } from "../listener/tasks.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

test("move: the queue as it starts now, with the task moved; it survives a restart", (t) => {
  const path = join(tempDir(t), "order.json");
  const order = createOrder({ path });
  const queue = ["org/app#1", "org/app#2", "org/app#3"];
  order.move("org/app#3", { first: true }, queue);
  assert.deepEqual(order.keys(), ["org/app#3", "org/app#1", "org/app#2"]);
  // Down one: before the one after next, all of them placed already.
  order.move("org/app#1", { before: null }, order.keys());
  assert.deepEqual(createOrder({ path }).keys(), ["org/app#3", "org/app#2", "org/app#1"]);
  // Before another, whatever its spelling.
  order.move("org/app#1", { before: "Org/App#2" }, order.keys());
  assert.deepEqual(createOrder({ path }).keys(), ["org/app#3", "org/app#1", "org/app#2"]);
  assert.deepEqual(
    [...order.ranks()],
    [
      ["org/app#3", 0],
      ["org/app#1", 1],
      ["org/app#2", 2],
    ],
  );
});

test("drop and keep: a task that started or whose comments went leaves; respell", (t) => {
  const path = join(tempDir(t), "order.json");
  const order = createOrder({ path });
  order.move("Org/App#2", { first: true }, ["org/app#1", "Org/App#2", "org/app#3"]);
  order.drop("org/app#1");
  assert.deepEqual(order.keys(), ["Org/App#2", "org/app#3"]);
  order.keep(["org/app#3", "org/app#9"]);
  assert.deepEqual(createOrder({ path }).keys(), ["org/app#3"]);
  order.move("Org/App#2", { first: true }, ["org/app#3", "Org/App#2"]);
  order.respell((repo) => repo.toLowerCase());
  assert.deepEqual(createOrder({ path }).keys(), ["org/app#2", "org/app#3"]);
});

// Tasks as tasks.mjs keeps them, each ready with one comment queued at `at`, and a scheduler
// that records what it starts.
function scheduler({ max = 1, order = createOrder(), queued = [] } = {}) {
  const tasks = new Map();
  const started = [];
  const ctx = {
    config: testConfig({ MAX_PARALLEL: String(max) }),
    log: () => {},
    skip: () => false,
    tasks,
    order,
    running: 0,
    run: (task) => {
      task.running = true;
      ctx.running++;
      // As runs.mjs run() does.
      order.drop(`${task.repo}#${task.id}`);
      started.push(`#${task.id}`);
    },
  };
  for (const { repo = "org/app", id, at, mode = "work", cap, ready = true } of queued) {
    const task = newTask({ repo, id: String(id), kind: "issue", number: id });
    if (cap) task.settings = { maxParallel: cap };
    task.pending.push({ mode, queuedAt: at });
    task.ready = ready;
    tasks.set(`${repo}#${id}`, task);
  }
  const free = () => {
    const task = [...tasks.values()].find((t) => t.running);
    task.running = false;
    task.pending = [];
    ctx.running--;
  };
  return { ...createTasks(ctx), started, tasks, free, order };
}

test("schedule: brainstorms first, then the placed tasks, then the others by when they were queued", () => {
  // #1's key is the Map's first, but it was queued last: queue time wins.
  const s = scheduler({
    max: 1,
    queued: [
      { id: 1, at: 50 },
      { id: 2, at: 10 },
      { id: 3, at: 20 },
      { id: 4, at: 30 },
      { id: 5, at: 40, mode: "brainstorm" },
    ],
  });
  s.order.move("org/app#4", { first: true }, ["org/app#2", "org/app#3", "org/app#4"]);
  assert.deepEqual(
    s.queueOrder().map((t) => `#${t.id}`),
    ["#5", "#4", "#2", "#3", "#1"],
  );
  for (let i = 0; i < 5; i++) {
    s.schedule();
    s.free();
  }
  assert.deepEqual(s.started, ["#5", "#4", "#2", "#3", "#1"]);
});

test("schedule: A, B, C queued, C moved first: C, then A, then B; each leaves the order", () => {
  const s = scheduler({
    queued: [
      { id: 1, at: 1 },
      { id: 2, at: 2 },
      { id: 3, at: 3 },
    ],
  });
  const keys = () => s.queueOrder().map((t) => `org/app#${t.id}`);
  s.order.move("org/app#3", { first: true }, keys());
  // A key left behind (comments dropped some other way) goes at the next schedule().
  s.order.move("org/app#7", { before: null }, s.order.keys());
  s.schedule();
  assert.deepEqual(s.started, ["#3"]);
  s.free();
  s.schedule();
  s.free();
  s.schedule();
  assert.deepEqual(s.started, ["#3", "#1", "#2"]);
  assert.deepEqual(s.order.keys(), []);
});

test("schedule: a task whose repo is at its max_parallel is skipped, not blocking the next", () => {
  const s = scheduler({
    max: 2,
    queued: [
      { repo: "org/busy", id: 1, at: 1, cap: 1 },
      { repo: "org/busy", id: 2, at: 2, cap: 1 },
      { id: 3, at: 3 },
      { id: 4, at: 4, ready: false },
    ],
  });
  s.order.move("org/busy#2", { first: true }, ["org/busy#1", "org/busy#2", "org/app#3"]);
  s.schedule();
  // #2 is first, its repo then full: #1 waits, #3 starts; #4 is still in its pause.
  assert.deepEqual(s.started, ["#2", "#3"]);
});
