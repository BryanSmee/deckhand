// A Map kept in the store one key per item, `<name>/<key>` (#615): the orchestrator's state maps,
// which a copy taking the lease reads back whole. Its callers use it as a Map: set(), delete()
// and clear() change it at once, and write what they changed alone, in the background. Nothing
// to save: a value changed in place isn't seen, set() it again.
//
// Writes go in order per key, and a later one replaces one of the same key still waiting (or
// being tried again): the store ends with the last. One that fails is tried again every
// `retryMs` until it is done, or `held()` says the lease is lost (another copy acts, from what
// the store has). waiting() counts the keys not written yet (the orchestrator's /ready says
// it), settled() resolves once there are none (a copy that stops waits for it before it lets
// its lease go).
//
// A write ordered after something else (`after`, a promise: the queue written with the comment a
// wait releases, say) waits for it, and so does every later write of that key: a copy killed in
// between leaves the store with what came first, never with the second change alone. written(key)
// resolves once that key's writes are done (the queue written after a wait, the other way round).
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { freshKeys, storable, values } from "./store.mjs";

// What a delete waits as, in the queue of writes.
const DELETE = Symbol("delete");

// Loads map `name` from `store`. `file`: its JSON file from before the store (lib/files.mjs
// persistentMap(), now gone), moved first, then removed (one it can't read is left, and said:
// legacyItems()). Moved twice, nothing changes: a crash in between moves the same values again.
// `moved(entries)`: its [key, value] pairs as they go to the store (a position the file only kept
// by its order, say). Loaded, its items are in no particular order: the store lists keys so.
// `secrets()`: what its values are written without, as storable() has them (people's text: a
// title, a comment).
//
// Which copy wins (#690): the store keeps when this release last loaded the map (`store-maps/
// <name>`). A file written after that (its mtime later) is an earlier release's, gone back to
// and left since: its items replace the store's of the same key, which are older. Any other
// file (the first move, or one left unreadable then and fixed since, older than what the store
// has) only fills the store's gaps. `replace`: a file that wins replaces the whole map, the
// store's other items deleted (the run order, whose ranks don't mix); without it, those are
// kept, the earlier release having started without them rather than deleted them.
export async function storeMap(
  store,
  name,
  {
    file = null,
    moved = (entries) => entries,
    replace = false,
    secrets = () => [],
    held = () => true,
    retryMs = 5000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    log = () => {},
  } = {},
) {
  const prefix = `${name}/`;
  const stamp = `store-maps/${name}`;
  const legacy = file && legacyItems(file, log);
  if (legacy) {
    const loaded = await store.get(stamp);
    const newer = loaded !== null && legacy.mtimeMs > loaded;
    // Without null (closed.json's open issues): the store keeps none, as set() refuses it. In a
    // newer file, it says the item is none now (an issue reopened): the store's is deleted.
    const none = ([, value]) => value === null || value === undefined;
    const entries = moved(legacy.items.filter((item) => !none(item)));
    const stale = newer ? legacy.items.filter(none).map(([key]) => prefix + key) : [];
    if (newer && replace) {
      const keep = new Set(entries.map(([key]) => prefix + key));
      for await (const keys of freshKeys(store, prefix)) {
        stale.push(...keys.filter((key) => !keep.has(key)));
      }
    }
    const write = newer ? "set" : "setIfAbsent";
    // All at once: the file backend writes them in one go (store-file.mjs exclusive()).
    await Promise.all([
      ...entries.map(([key, value]) => store[write](prefix + key, storable(value, secrets()))),
      ...stale.map((key) => store.delete(key)),
    ]);
    log(
      `${name}: ${entries.length} item(s) moved to the store from ${file}` +
        (newer ? ", newer than the store's" : ""),
    );
    rmSync(file, { force: true });
  }
  // After the move: a file written before this is older than the store's copy.
  if (file) await store.set(stamp, now());
  const entries = [];
  for await (const [key, value] of values(store, prefix)) {
    entries.push([key.slice(prefix.length), value]);
  }

  // key → the value to write next (DELETE: none), not begun yet.
  const waiting = new Map();
  // Keys being written now.
  const busy = new Set();
  const idle = [];

  // Keys whose write failed, said once until one is written.
  const failing = new Set();
  // key → what its next write waits for (`after`), until it is settled.
  const gates = new Map();
  // key → written(key)'s callers, resolved once the key is neither waiting nor busy.
  const watchers = new Map();

  async function write(key) {
    busy.add(key);
    while (waiting.has(key)) {
      // A gate set while this one was awaited (a later ordered write) is awaited too.
      while (gates.has(key)) {
        const gate = gates.get(key);
        await gate.catch(() => {});
        if (gates.get(key) === gate) gates.delete(key);
      }
      const value = waiting.get(key);
      waiting.delete(key);
      while (held()) {
        try {
          if (value === DELETE) await store.delete(prefix + key);
          else await store.set(prefix + key, value);
          if (failing.delete(key)) log(`${name}/${key}: written`);
          break;
        } catch (error) {
          if (!failing.has(key)) log(`${name}/${key}: ${error.message ?? error}, trying again`);
          failing.add(key);
          await sleep(retryMs);
          // A later write of the key replaces this one.
          if (waiting.has(key)) break;
        }
      }
    }
    busy.delete(key);
    for (const resolve of watchers.get(key) ?? []) resolve();
    watchers.delete(key);
    if (!busy.size) for (const resolve of idle.splice(0)) resolve();
  }

  function queue(key, value, after) {
    if (after) {
      const before = gates.get(key);
      gates.set(key, before ? Promise.all([before, after]) : Promise.resolve(after));
    }
    waiting.set(key, value);
    if (!busy.has(key)) write(key);
  }

  const map = new Map();
  // Map's own methods, for what doesn't write.
  const own = {
    set: Map.prototype.set.bind(map),
    delete: Map.prototype.delete.bind(map),
  };
  for (const [key, value] of entries) own.set(key, value);
  return Object.assign(map, {
    // Not null: the store keeps none (values() skips it), so it wouldn't read back. Nor
    // undefined: the store refuses it, and its write would be tried again for ever. `after`:
    // what its write waits for (above).
    set(key, value, { after } = {}) {
      if (value === null || value === undefined) {
        throw new TypeError(`${name}/${key}: ${value} isn't a value to keep, delete() it`);
      }
      own.set(key, value);
      // A copy, as it is now: written later, it is still this value.
      queue(String(key), storable(value, secrets()), after);
      return map;
    },
    delete(key, { after } = {}) {
      if (!own.delete(key)) return false;
      queue(String(key), DELETE, after);
      return true;
    },
    clear() {
      for (const key of [...map.keys()]) map.delete(key);
    },
    // Once `key`'s writes so far are done (or given up, the lease lost).
    written(key) {
      key = String(key);
      if (!busy.has(key) && !waiting.has(key)) return Promise.resolve();
      return new Promise((resolve) => watchers.set(key, [...(watchers.get(key) ?? []), resolve]));
    },
    // How many keys aren't written yet.
    waiting: () => new Set([...waiting.keys(), ...busy]).size,
    // Once every write is done (or given up, the lease lost).
    settled: () => (busy.size ? new Promise((resolve) => idle.push(resolve)) : Promise.resolve()),
  });
}

// The [key, value] pairs of a map's file from before the store (`items`) and when it was last
// written (`mtimeMs`), or null: none, or one that can't
// be read or isn't a map's (its owner another user, cut short by a crash), which is left where it
// is, and said, rather than removed with what it holds.
function legacyItems(file, log) {
  let text, mtimeMs;
  try {
    text = readFileSync(file, "utf8");
    ({ mtimeMs } = statSync(file));
  } catch (error) {
    if (error.code !== "ENOENT")
      log(`${file}: not moved to the store, left as it is: ${error.message}`);
    return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    log(`${file}: not moved to the store, left as it is: ${error.message}`);
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    log(`${file}: not moved to the store, left as it is: not a map`);
    return null;
  }
  return { items: Object.entries(value), mtimeMs };
}

// Several maps, as storeMap() loads them, each one's options with `shared`'s: { name: map }.
// `dir`: the folder of their files from before the store, `<name>.json`. waiting() and
// settled() as each map's, for all of them.
export async function storeMaps(store, specs, { dir = null, ...shared } = {}) {
  const maps = {};
  for (const [name, options] of Object.entries(specs)) {
    const file = dir ? join(dir, `${name}.json`) : null;
    maps[name] = await storeMap(store, name, { file, ...shared, ...options });
  }
  const all = Object.values(maps);
  return {
    maps,
    waiting: () => all.reduce((n, map) => n + map.waiting(), 0),
    settled: () => Promise.all(all.map((map) => map.settled())),
  };
}
