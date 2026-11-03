// The run order (issue #413): which queued task starts next when a slot frees. The maintainer
// places queued tasks from the dashboard (POST …/order, work.mjs); tasks.mjs queueOrder()
// starts the placed ones first, in this order, then the others in the order they were queued.
// Brainstorms (light runs) still go before all of them. A key leaves once its task starts a
// run or its queued comments are dropped (runs.mjs). Kept in the store (lib/store-map.mjs:
// `order`) by lowercase task key (one entry whatever the spelling of its repo, spelling.mjs),
// each with its place as a number (`rank`): a task moved changes its own alone, between its
// neighbours'.
import { respelled, taskId } from "./spelling.mjs";

// A file from before the store had its entries in order, without ranks: storeMap()'s `moved`.
export const ranked = (entries) => entries.map(([id, entry], i) => [id, { ...entry, rank: i }]);

// `order`: the Map it is kept in (storeMap()'s), taskId(key) → { key, rank }: `key` as last
// spelled. Its own order is no task's: the ranks are.
export function createOrder({ order = new Map() } = {}) {
  const sorted = () => [...order].sort(([, a], [, b]) => a.rank - b.rank);

  // Writes `keys` as the whole order, if it changed: the entries that keep their place keep
  // their rank (the longest run of them still in order), the others get one between their
  // neighbours'. None left between two (one moved there again and again): every rank anew.
  function write(keys) {
    const ids = keys.map(taskId);
    const now = sorted().map(([id]) => id);
    if (ids.length === now.length && ids.every((id, i) => now[i] === id)) return;
    const was = new Map(order);
    const kept = inOrder(ids.map((id) => was.get(id)?.rank));
    const ranks = ids.map((id, i) => (kept.has(i) ? was.get(id).rank : null));
    for (let i = 0; i < ranks.length; i++) {
      if (ranks[i] !== null) continue;
      const low = i ? ranks[i - 1] : null;
      const high = ranks.slice(i + 1).find((rank) => rank !== null) ?? null;
      if (low === null) ranks[i] = (high ?? 1) - 1;
      else ranks[i] = high === null ? low + 1 : (low + high) / 2;
    }
    const tight = ranks.some((rank, i) => i && rank <= ranks[i - 1]);
    for (const id of now) if (!ids.includes(id)) order.delete(id);
    for (const [i, id] of ids.entries()) {
      const entry = { key: was.get(id)?.key ?? keys[i], rank: tight ? i : ranks[i] };
      if (JSON.stringify(was.get(id)) !== JSON.stringify(entry)) order.set(id, entry);
    }
  }

  // Task `key` goes right before `before` or right after `after` (keys), first (`first`) or
  // last (none of them). `current`: the queued tasks' keys in the order they start now, all of
  // them placed with it: moving one past a task nobody placed keeps the rest where they were.
  function move(key, { before = null, after = null, first = false } = {}, current = []) {
    const keys = current.filter((k) => taskId(k) !== taskId(key));
    const find = (k) => keys.findIndex((q) => taskId(q) === taskId(k));
    let at = -1;
    if (first) at = 0;
    else if (before) at = find(before);
    else if (after) at = find(after) < 0 ? -1 : find(after) + 1;
    keys.splice(at < 0 ? keys.length : at, 0, key);
    write(keys);
  }

  // Its run started, or its queued comments were dropped.
  function drop(key) {
    order.delete(taskId(key));
  }

  // Only the keys of `queued` (the tasks with comments waiting for a run) stay.
  function keep(queued) {
    const ids = new Set(queued.map(taskId));
    write(keys().filter((key) => ids.has(taskId(key))));
  }

  // The placed tasks' keys, in order.
  function keys() {
    return sorted().map(([, entry]) => entry.key);
  }

  // taskId → its place (0 first), for the placed tasks.
  function ranks() {
    return new Map(sorted().map(([id], i) => [id, i]));
  }

  function respell(spelled) {
    for (const [id, entry] of order) {
      const key = respelled(entry.key, spelled);
      if (key !== entry.key) order.set(id, { ...entry, key });
    }
  }

  return {
    move,
    drop,
    keep,
    ranks,
    respell,
    keys,
  };
}

// The indices of the longest run of `ranks` that increases (undefined: none, never in it).
function inOrder(ranks) {
  const best = ranks.map(() => ({ length: 0, from: -1 }));
  let end = -1;
  for (const [i, rank] of ranks.entries()) {
    if (rank === undefined) continue;
    best[i] = { length: 1, from: -1 };
    for (let j = 0; j < i; j++) {
      if (ranks[j] !== undefined && ranks[j] < rank && best[j].length + 1 > best[i].length) {
        best[i] = { length: best[j].length + 1, from: j };
      }
    }
    if (end < 0 || best[i].length > best[end].length) end = i;
  }
  const kept = new Set();
  for (let i = end; i >= 0; i = best[i].from) kept.add(i);
  return kept;
}
