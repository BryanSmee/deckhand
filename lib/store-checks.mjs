// The arguments both store backends check the same way (store-file.mjs, store-redis.mjs): one
// copy of the rules, so the two can't drift apart. Not in store.mjs, which imports the backends.

// A stream's or a blob's name: some text. An empty one would name their folder.
export function named(name) {
  if (typeof name !== "string" || !name) throw new TypeError(`not a name: ${JSON.stringify(name)}`);
  return name;
}

// keys()'s prefix and page size: some text (empty: every key), and how many at most.
export function listing(prefix, count) {
  if (typeof prefix !== "string") throw new TypeError(`not a prefix: ${JSON.stringify(prefix)}`);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new TypeError(`a page's count: a positive integer, not ${count}`);
  }
}

// A lease's lifetime: without one, it would never be live, and two holders would both think
// they hold it.
export function leaseTtl(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`a lease's ttlMs: a positive number, not ${ttlMs}`);
  }
  return ttlMs;
}
