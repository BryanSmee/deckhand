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
  // Right after another, whatever its spelling: the end of the line stays where it was.
  order.move("org/app#3", { after: "Org/App#2" }, order.keys());
  assert.deepEqual(order.keys(), ["org/app#2", "org/app#3", "org/app#1"]);
  order.move("org/app#3", { first: true }, order.keys());
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
function scheduler({ max = 1, slots = 0, order = createOrder(), queued = [] } = {}) {
  const tasks = new Map();
  const started = [];
  const ctx = {
    config: testConfig({ MAX_PARALLEL: String(max), AUTO_PICKUP_SLOTS: String(slots) }),
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
  const add = ({ repo = "org/app", id, at, mode = "work", cap, ready = true, auto = false }) => {
    const task = newTask({ repo, id: String(id), kind: "issue", number: id });
    if (cap) task.settings = { maxParallel: cap };
    task.pending.push({ mode, queuedAt: at, ...(auto && { autoPickup: true }) });
    task.ready = ready;
    tasks.set(`${repo}#${id}`, task);
  };
  queued.forEach(add);
  // The first running task, or #`id`'s, is over.
  const free = (id = null) => {
    const task = [...tasks.values()].find((t) => t.running && (id === null || t.id === String(id)));
    task.running = false;
    task.pending = [];
    ctx.running--;
  };
  return { ...createTasks(ctx), started, tasks, free, order, add };
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

test("schedule: auto-picked tasks hold the reserved slots alone; the others borrow them while none waits", () => {
  const s = scheduler({
    max: 3,
    slots: 1,
    queued: [
      { id: 1, at: 1 },
      { id: 2, at: 2 },
      { id: 3, at: 3 },
    ],
  });
  // Nothing auto-picked waits: the triggered runs take every slot.
  s.schedule();
  assert.deepEqual(s.started, ["#1", "#2", "#3"]);
  // An issue picked now waits for a slot; a triggered one queued after it waits behind it.
  s.add({ id: 4, at: 4, auto: true });
  s.add({ id: 5, at: 5 });
  s.schedule();
  assert.deepEqual(s.started, ["#1", "#2", "#3"]);
  assert.equal(s.pickedCount(), 1);
  s.free(1);
  s.schedule();
  assert.deepEqual(s.started, ["#1", "#2", "#3", "#4"]);
  // None waits any more: #5 borrows nothing, it takes the next slot.
  s.free(2);
  s.schedule();
  assert.deepEqual(s.started, ["#1", "#2", "#3", "#4", "#5"]);
});

test("schedule: never more auto-picked runs than the reserved slots, nor triggered ones past the rest while one waits", () => {
  const s = scheduler({
    max: 3,
    slots: 1,
    queued: [
      { id: 1, at: 1, auto: true },
      { id: 2, at: 2, auto: true },
      { id: 3, at: 3 },
      { id: 4, at: 4 },
      { id: 5, at: 5 },
    ],
  });
  s.schedule();
  // #1 in the reserved slot, #2 waits for it: the others keep to MAX_PARALLEL - 1.
  assert.deepEqual(s.started, ["#1", "#3", "#4"]);
  // A triggered run's slot goes to the next triggered one: the reserved slot is #1's.
  s.free(3);
  s.schedule();
  assert.deepEqual(s.started, ["#1", "#3", "#4", "#5"]);
  s.free(1);
  s.schedule();
  assert.deepEqual(s.started, ["#1", "#3", "#4", "#5", "#2"]);
});

test("schedule: an auto-picked task its repo's max_parallel holds back keeps neither the slot nor the others", () => {
  const s = scheduler({ max: 3, slots: 1, queued: [{ repo: "org/a", id: 1, at: 1, cap: 1 }] });
  s.schedule();
  assert.deepEqual(s.started, ["#1"]);
  // org/a's one slot is #1's: #2 waits for its repo, not for a slot, and holds none; the
  // others take every slot left, the reserved one included.
  s.add({ repo: "org/a", id: 2, at: 2, cap: 1, auto: true });
  s.add({ repo: "org/b", id: 3, at: 3 });
  s.add({ repo: "org/c", id: 4, at: 4 });
  s.schedule();
  assert.deepEqual(s.started, ["#1", "#3", "#4"]);
  assert.equal(s.pickedCount(), 0);
});

test("schedule: an auto-picked task queued when the slots were turned off runs as any other", () => {
  // Saved with its flag, back after a restart with AUTO_PICKUP_SLOTS at 0.
  const s = scheduler({
    max: 1,
    slots: 0,
    queued: [
      { id: 1, at: 1, auto: true },
      { id: 2, at: 2 },
    ],
  });
  s.schedule();
  assert.deepEqual(s.started, ["#1"]);
  s.free(1);
  s.schedule();
  assert.deepEqual(s.started, ["#1", "#2"]);
});

test("schedule: a task whose run() is still reading its settings keeps its place", () => {
  const s = scheduler({
    max: 2,
    queued: [
      { id: 1, at: 1, ready: false },
      { id: 2, at: 2 },
    ],
  });
  s.order.move("org/app#2", { first: true }, ["org/app#1", "org/app#2"]);
  // run() set it running and waits on the repo's settings: its comments aren't taken yet. Were
  // the listener to stop now, it would go back to the queue, its place with it.
  s.tasks.get("org/app#2").running = true;
  s.schedule();
  assert.deepEqual(s.order.keys(), ["org/app#2", "org/app#1"]);
  // Once its run is live, a schedule() keeps no key of it (runs.mjs dropped it as it started).
  s.tasks.get("org/app#2").live = {};
  s.order.move("org/app#2", { first: true }, s.order.keys());
  s.schedule();
  assert.deepEqual(s.order.keys(), ["org/app#1"]);
});
