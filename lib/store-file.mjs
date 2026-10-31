// The store's file backend (store.mjs has the interface): in-process, for the Compose test
// server and a single node, where each service runs one copy. One mutex orders every call;
// keys, leases and the streams' consumers live in one JSON file written whole or not at all
// (state.json); a stream is an append-only file of one event per line, and each consumer's
// offset is kept with the rest; a blob is a file of its own. Without `dir`, nothing is written:
// the same store in memory.
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { readJson, writeFileAtomic, writeJsonAtomic } from "./files.mjs";

// A name as a file name: nothing in it can climb out of its folder.
const fileName = (name) => encodeURIComponent(name).replace(/\./g, "%2E");

// The values handed out are copies: a caller changing one changes nothing stored.
const copy = (value) => (value === undefined ? null : structuredClone(value));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const expiry = (ttlMs, now) => (ttlMs ? now + ttlMs : null);
const live = (entry, now) => !!entry && (entry.expiresAt === null || entry.expiresAt > now);

export function fileStore({ dir = null, now = Date.now } = {}) {
  const statePath = dir && join(dir, "state.json");
  if (dir) {
    mkdirSync(join(dir, "streams"), { recursive: true });
    mkdirSync(join(dir, "blobs"), { recursive: true });
  }
  const saved = (statePath && readJson(statePath, null)) ?? {};
  // key → { value, expiresAt }
  const keys = new Map(Object.entries(saved.keys ?? {}));
  // name → { holder, epoch, expiresAt }: kept once released (holder null), for its epoch.
  const leases = new Map(Object.entries(saved.leases ?? {}));
  // stream → consumer → { offset, acked: [ids past the offset] }
  const consumers = new Map(
    Object.entries(saved.consumers ?? {}).map(([s, c]) => [s, new Map(Object.entries(c))]),
  );
  const streams = new Map(); // stream → { next, events: [{ id, event }] }, read on first use
  const blobs = new Map(); // in memory only

  function save() {
    const at = now();
    for (const [key, entry] of keys) if (!live(entry, at)) keys.delete(key);
    if (!statePath) return;
    writeJsonAtomic(statePath, {
      keys: Object.fromEntries(keys),
      leases: Object.fromEntries(leases),
      consumers: Object.fromEntries([...consumers].map(([s, c]) => [s, Object.fromEntries(c)])),
    });
  }

  // One call at a time, each to its end: a backend across the network gets the same from its
  // own atomic commands.
  let queue = Promise.resolve();
  function exclusive(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  const entry = (key) => {
    const found = keys.get(key);
    return live(found, now()) ? found : null;
  };
  function put(key, value, ttlMs) {
    if (value === undefined) throw new TypeError(`${key}: undefined isn't a value`);
    keys.set(key, { value: copy(value), expiresAt: expiry(ttlMs, now()) });
    save();
  }

  // The stream's file, read once: a line cut short by a crash mid-append is dropped, and cut
  // from the file before the next one is added.
  function stream(name) {
    let found = streams.get(name);
    if (found) return found;
    found = { next: 1, events: [], lines: 0 };
    const path = dir && join(dir, "streams", `${fileName(name)}.jsonl`);
    if (path && existsSync(path)) {
      const text = readFileSync(path, "utf8");
      const whole = text.lastIndexOf("\n") + 1;
      if (whole < Buffer.byteLength(text))
        truncateSync(path, Buffer.byteLength(text.slice(0, whole)));
      for (const line of text.slice(0, whole).split("\n")) {
        if (!line) continue;
        const { id, event } = JSON.parse(line);
        found.events.push({ id, event });
        found.next = id + 1;
        found.lines++;
      }
    }
    found.path = path;
    streams.set(name, found);
    return found;
  }

  function consumerOf(name, consumer) {
    if (!consumers.has(name)) consumers.set(name, new Map());
    const all = consumers.get(name);
    if (!all.has(consumer)) all.set(consumer, { offset: 0, acked: [] });
    return all.get(consumer);
  }

  // Only the last `maxLength` events, the file rewritten once it holds twice as many lines.
  function trim(found, maxLength) {
    if (!maxLength) return;
    if (found.events.length > maxLength) found.events = found.events.slice(-maxLength);
    if (found.path && found.lines >= 2 * maxLength) {
      writeFileAtomic(found.path, found.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
      found.lines = found.events.length;
    }
  }

  const blobPath = (key) => dir && join(dir, "blobs", fileName(key));
  const bytes = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(String(data)));

  return {
    get: (key) => exclusive(() => copy(entry(key)?.value)),
    set: (key, value, { ttlMs } = {}) => exclusive(() => void put(key, value, ttlMs)),
    delete: (key) =>
      exclusive(() => {
        const had = !!entry(key);
        keys.delete(key);
        save();
        return had;
      }),
    setIfAbsent: (key, value, { ttlMs } = {}) =>
      exclusive(() => {
        if (entry(key)) return false;
        put(key, value, ttlMs);
        return true;
      }),
    compareAndSet: (key, expected, value, { ttlMs } = {}) =>
      exclusive(() => {
        if (!same(entry(key)?.value, expected)) return false;
        put(key, value, ttlMs);
        return true;
      }),
    increment: (key, by = 1, { ttlMs } = {}) =>
      exclusive(() => {
        const found = entry(key);
        if (found && typeof found.value !== "number") throw new TypeError(`${key} isn't a number`);
        const value = (found?.value ?? 0) + by;
        if (found) found.value = value;
        else keys.set(key, { value, expiresAt: expiry(ttlMs, now()) });
        save();
        return value;
      }),

    acquire: (name, holder, { ttlMs }) =>
      exclusive(() => {
        const at = now();
        const held = leases.get(name);
        if (held?.holder && held.expiresAt > at && held.holder !== holder) return null;
        const epoch =
          held?.holder === holder && held.expiresAt > at ? held.epoch : (held?.epoch ?? 0) + 1;
        const lease = { holder, epoch, expiresAt: at + ttlMs };
        leases.set(name, lease);
        save();
        return { ...lease };
      }),
    renew: (name, holder, epoch, { ttlMs }) =>
      exclusive(() => {
        const at = now();
        const held = leases.get(name);
        if (held?.holder !== holder || held.epoch !== epoch || held.expiresAt <= at) return null;
        held.expiresAt = at + ttlMs;
        save();
        return { ...held };
      }),
    release: (name, holder, epoch) =>
      exclusive(() => {
        const held = leases.get(name);
        if (held?.holder !== holder || held.epoch !== epoch || held.expiresAt <= now()) {
          return false;
        }
        leases.set(name, { holder: null, epoch, expiresAt: 0 });
        save();
        return true;
      }),
    lease: (name) =>
      exclusive(() => {
        const held = leases.get(name);
        return held?.holder && held.expiresAt > now() ? { ...held } : null;
      }),

    append: (name, event, { maxLength } = {}) =>
      exclusive(() => {
        const found = stream(name);
        const record = { id: found.next, event: copy(event) };
        if (found.path) {
          appendFileSync(found.path, `${JSON.stringify(record)}\n`);
          found.lines++;
        }
        found.events.push(record);
        found.next++;
        trim(found, maxLength);
        return String(record.id);
      }),
    read: (name, consumer, { count = 100 } = {}) =>
      exclusive(() => {
        const { offset, acked } = consumerOf(name, consumer);
        const done = new Set(acked);
        const out = [];
        for (const { id, event } of stream(name).events) {
          if (id <= offset || done.has(id)) continue;
          out.push({ id: String(id), event: copy(event) });
          if (out.length >= count) break;
        }
        return out;
      }),
    ack: (name, consumer, ids) =>
      exclusive(() => {
        const state = consumerOf(name, consumer);
        const known = new Set(stream(name).events.map((e) => e.id));
        const done = new Set(state.acked);
        let count = 0;
        for (const id of ids.map(Number)) {
          if (id <= state.offset || done.has(id) || !known.has(id)) continue;
          done.add(id);
          count++;
        }
        // The offset moves past every event acknowledged in a row; the rest wait above it.
        const events = stream(name).events;
        let i = events.findIndex((e) => e.id > state.offset);
        while (i >= 0 && i < events.length && done.has(events[i].id)) {
          state.offset = events[i].id;
          done.delete(events[i].id);
          i++;
        }
        state.acked = [...done].filter((id) => id > state.offset).sort((a, b) => a - b);
        save();
        return count;
      }),

    putBlob: (key, data) =>
      exclusive(() => {
        if (dir) writeFileAtomic(blobPath(key), bytes(data));
        else blobs.set(key, Buffer.from(bytes(data)));
      }),
    appendBlob: (key, data) =>
      exclusive(() => {
        if (dir) appendFileSync(blobPath(key), bytes(data));
        else blobs.set(key, Buffer.concat([blobs.get(key) ?? Buffer.alloc(0), bytes(data)]));
      }),
    readBlob: (key, { offset = 0 } = {}) =>
      exclusive(() => {
        if (!dir) return blobs.has(key) ? Buffer.from(blobs.get(key).subarray(offset)) : null;
        let fd;
        try {
          fd = openSync(blobPath(key), "r");
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
        // From the offset only: a log read as it grows isn't read whole each time.
        try {
          const data = Buffer.alloc(Math.max(0, fstatSync(fd).size - offset));
          let read = 0;
          while (read < data.length) {
            const n = readSync(fd, data, read, data.length - read, offset + read);
            if (!n) break;
            read += n;
          }
          return data.subarray(0, read);
        } finally {
          closeSync(fd);
        }
      }),
    deleteBlob: (key) =>
      exclusive(() => {
        if (!dir) return blobs.delete(key);
        const path = blobPath(key);
        const had = existsSync(path) && statSync(path).isFile();
        rmSync(path, { force: true });
        return had;
      }),

    close: () => exclusive(() => {}),
  };
}
