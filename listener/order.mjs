// The run order (issue #413): which queued task starts next when a slot frees. The maintainer
// places queued tasks from the dashboard (POST …/order, work.mjs); tasks.mjs queueOrder()
// starts the placed ones first, in this order, then the others in the order they were queued.
// Brainstorms (light runs) still go before all of them. A key leaves once its task starts a
// run or its queued comments are dropped (runs.mjs). Kept in order.json by lowercase task key
// (one entry whatever the spelling of its repo, spelling.mjs), in order: its keys are never
// numbers, so JSON keeps them as they were set.
import { respelled, taskId } from "./spelling.mjs";
import { persistentMap } from "./store.mjs";

export function createOrder({ path } = {}) {
  // taskId(key) → { key }: `key` as last spelled.
  const order = persistentMap(path);

  // Writes `keys` as the whole order, if it changed.
  function write(keys) {
    const ids = keys.map(taskId);
    const now = [...order.keys()];
    if (ids.length === now.length && ids.every((id, i) => now[i] === id)) return;
    const was = new Map(order);
    order.clear();
    for (const key of keys) order.set(taskId(key), { key: was.get(taskId(key))?.key ?? key });
    order.save();
  }

  // Task `key` goes before `before` (a key), first (`first`) or last (neither). `current`: the
  // queued tasks' keys in the order they start now, all of them placed with it: moving one
  // past a task nobody placed keeps the rest where they were.
  function move(key, { before = null, first = false } = {}, current = []) {
    const keys = current.filter((k) => taskId(k) !== taskId(key));
    const at = first ? 0 : before ? keys.findIndex((k) => taskId(k) === taskId(before)) : -1;
    keys.splice(at < 0 ? keys.length : at, 0, key);
    write(keys);
  }

  // Its run started, or its queued comments were dropped.
  function drop(key) {
    if (order.delete(taskId(key))) order.save();
  }

  // Only the keys of `queued` (the tasks with comments waiting for a run) stay.
  function keep(queued) {
    const ids = new Set(queued.map(taskId));
    write([...order.values()].map((e) => e.key).filter((key) => ids.has(taskId(key))));
  }

  // taskId → its place (0 first), for the placed tasks.
  function ranks() {
    return new Map([...order.keys()].map((id, i) => [id, i]));
  }

  function respell(spelled) {
    let changed = false;
    for (const entry of order.values()) {
      const key = respelled(entry.key, spelled);
      if (key === entry.key) continue;
      entry.key = key;
      changed = true;
    }
    if (changed) order.save();
  }

  return {
    move,
    drop,
    keep,
    ranks,
    respell,
    keys: () => [...order.values()].map((e) => e.key),
  };
}
