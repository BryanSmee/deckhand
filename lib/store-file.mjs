// The store's file backend (store.mjs has the interface): for the Compose test server and a
// single node. One mutex orders every call; keys, leases and the streams' consumers live in one
// JSON file written whole or not at all (state.json); a stream is an append-only file of one
// event per line, and each consumer's offset is kept with the rest; a blob is a file of its own.
// Without `dir`, nothing is written: the same store in memory.
//
// `apart`: prefixes whose keys are each a file of their own, not in state.json: a map of
// thousands of items (the runs' summaries, #618) would make state.json, which every lease
// renewal writes whole, megabytes, and a change to one item (a title, #691) would write all of
// them again. Those are read from their file at each call, and listed from the files' names, a
// folder per prefix (keys/<prefix>/, #773): listing one map reads none of the others' names. One
// written with a TTL is in state.json all the same: a file's name can't say when it expires. One
// a release before kept in state.json, or right in keys/, goes to its folder when its user says
// (moveApart()).
//
// Several processes on the node may share a folder: a service's two copies (the orchestrator's,
// one acting and one waiting for its lease, #506), or one that starts while the last one drains.
// Each call holds the folder's lock (state.lock) for its few synchronous steps, reads state.json
// again when another process wrote it since, and the new lines of a stream another appended to.
// Calls made while one runs go together, under one lock, state.json written once for them all.
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "./files.mjs";
import { leaseTtl, listing, named } from "./store-checks.mjs";

// A name as a file name: nothing in it can climb out of its folder.
// `~` is escaped too: it only ever marks a name too long to be kept whole (a run's file deep in
// its repository), cut and followed by its hash, under the file systems' 255 bytes. Blob
// storage's folder names its files the same way (blobs.mjs).
const FILE_NAME_MAX = 200;
export function fileName(name) {
  const encoded = encodeURIComponent(name).replace(/\./g, "%2E").replace(/~/g, "%7E");
  if (encoded.length <= FILE_NAME_MAX) return encoded;
  const hash = createHash("sha256").update(name).digest("hex");
  return `${encoded.slice(0, FILE_NAME_MAX - hash.length - 1).replace(/%[0-9A-F]?$/, "")}~${hash}`;
}

// The values handed out are copies: a caller changing one changes nothing stored.
const copy = (value) => (value === undefined ? null : structuredClone(value));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const expiry = (ttlMs, now) => (ttlMs ? now + ttlMs : null);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const live = (entry, now) => !!entry && (entry.expiresAt === null || entry.expiresAt > now);

// A lock older than this is a crashed process's: a call holds it for a few synchronous steps.
const LOCK_STALE_MS = 10_000;
// The most lines of events dropped (ack()'s `drop`) a stream's file keeps before it is rewritten.
const DROPPED_MAX = 100;
const stale = (path) => Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;

// What tells a file's writes apart: a rename (writeFileAtomic()) gives it another inode.
function signature(path) {
  try {
    const { ino, size, mtimeMs } = statSync(path);
    return `${ino}:${size}:${mtimeMs}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// `writeJson`: how state.json is written (the tests count or fail its writes); `readdir`: how a
// folder is listed (the tests see which).
export function fileStore({
  dir = null,
  now = Date.now,
  sleep = defaultSleep,
  writeJson = writeJsonAtomic,
  apart = [],
  readdir = readdirSync,
} = {}) {
  const statePath = dir && join(dir, "state.json");
  const lockPath = dir && join(dir, "state.lock");
  const apartDir = dir && apart.length ? join(dir, "keys") : null;
  if (dir) {
    mkdirSync(join(dir, "streams"), { recursive: true });
    mkdirSync(join(dir, "blobs"), { recursive: true });
  }
  // A key's prefix: the longest of `apart` it starts with. Its folder: the prefix as a file name,
  // "%" for "" (a name no prefix's gives). A key is never its prefix alone (a map's items have a
  // name after it, store-map.mjs): its file would be named as that folder, right in keys/. The
  // folders are made at the first write in them, not at open: a copy of a release before #773
  // still acting (this one waiting for its lease) lists keys/ whole, and would read a folder
  // there as a key's file, and fail.
  function prefixOf(key) {
    let found = null;
    if (apartDir)
      for (const p of apart) if (key.startsWith(p) && p.length >= (found?.length ?? 0)) found = p;
    return found;
  }
  const folderOf = (prefix) => join(apartDir, fileName(prefix) || "%");
  if (apartDir) mkdirSync(apartDir, { recursive: true });
  // key → { value, expiresAt }
  let keys = new Map();
  // name → { holder, epoch, expiresAt }: kept once released (holder null), for its epoch.
  let leases = new Map();
  // stream → consumer → { offset, acked: [ids past the offset], read: the last id read }
  let consumers = new Map();
  // stream → the first id kept, once `maxLength` trimmed it: the lines before it in its file,
  // not yet rewritten, are skipped when it is read again.
  let firsts = new Map();
  // stream → its next id, saved before its file is rewritten: a file every event was dropped
  // from, or all but one still pending, no longer says it.
  let nexts = new Map();
  // stream → how many times its file was rewritten: a rename may hand the next file the inode the
  // last one freed, so its inode alone doesn't tell another process the file is a new one.
  let gens = new Map();
  // stream → { next, events: [{ id, event }], lines, bytes, ino }, read on first use
  const streams = new Map();
  const blobs = new Map(); // in memory only
  // state.json as this process last read or wrote it: another's write since changes it.
  let seen;

  function load() {
    seen = signature(statePath);
    const saved = (seen && readState()) ?? {};
    keys = new Map(Object.entries(saved.keys ?? {}));
    leases = new Map(Object.entries(saved.leases ?? {}));
    consumers = new Map(
      Object.entries(saved.consumers ?? {}).map(([s, c]) => [s, new Map(Object.entries(c))]),
    );
    firsts = new Map(Object.entries(saved.firsts ?? {}));
    nexts = new Map(Object.entries(saved.nexts ?? {}));
    gens = new Map(Object.entries(saved.gens ?? {}));
  }
  // state.json's value. One this process can't read (another user's, EACCES) is thrown, never
  // taken for an empty state, which the next save() would write over for good (#536); one
  // gone since its signature, or not JSON, is nothing kept, as before.
  function readState() {
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  if (statePath) load();
  else seen = null;

  // What another process wrote since this one's last call: the state, read again whole, and
  // the streams' new lines (a stream rewritten by a trim, or cut, read again whole).
  function refresh() {
    if (!statePath) return;
    if (signature(statePath) !== seen) load();
    for (const [name, found] of streams) {
      let stat;
      try {
        stat = statSync(found.path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        stat = null;
      }
      if (!stat) {
        if (found.bytes) streams.delete(name);
        continue;
      }
      if (
        (gens.get(name) ?? 0) !== found.gen ||
        stat.ino !== found.ino ||
        stat.size < found.bytes
      ) {
        streams.delete(name);
      } else if (stat.size > found.bytes) readLines(name, found, stat.size);
    }
  }

  // Within a batch of calls (exclusive()), state.json is written once, after the last: save()
  // only notes that it has to be.
  let batching = false;
  let dirty = false;
  function save() {
    if (batching) dirty = true;
    else writeState();
  }
  function writeState() {
    const at = now();
    for (const [key, entry] of keys) if (!live(entry, at)) keys.delete(key);
    if (!statePath) return;
    // The service's own: its queue holds comments' text and authors (the orchestrator's), say.
    writeJson(
      statePath,
      {
        keys: Object.fromEntries(keys),
        leases: Object.fromEntries(leases),
        firsts: Object.fromEntries(firsts),
        nexts: Object.fromEntries(nexts),
        gens: Object.fromEntries(gens),
        consumers: Object.fromEntries([...consumers].map(([s, c]) => [s, Object.fromEntries(c)])),
      },
      { mode: 0o600 },
    );
    seen = signature(statePath);
  }

  // The folder's lock, between processes: taken, or waited for. Each holder's is its own token,
  // so that it only ever removes its own. One a crashed process left is taken over once stale.
  const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  async function lock() {
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        writeSync(fd, token);
        closeSync(fd);
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      try {
        if (stale(lockPath) && takeOver()) continue;
      } catch (error) {
        // Gone meanwhile: released, or taken over by another process first.
        if (error.code !== "ENOENT") throw error;
        continue;
      }
      await sleep(2);
    }
  }
  // A stale lock's takeover, one process at a time (state.lock.takeover, its own lock): the lock
  // is looked at again under it, so a lock another process took over and made anew meanwhile is
  // never removed. Whether this process removed the stale one.
  function takeOver() {
    const takeoverPath = `${lockPath}.takeover`;
    try {
      closeSync(openSync(takeoverPath, "wx", 0o600));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // One a process crashed holding: removed, for the next look.
      if (stale(takeoverPath)) rmSync(takeoverPath, { force: true });
      return false;
    }
    try {
      if (!stale(lockPath)) return false;
      rmSync(lockPath, { force: true });
      return true;
    } finally {
      rmSync(takeoverPath, { force: true });
    }
  }

  function unlock() {
    try {
      if (readFileSync(lockPath, "utf8") === token) rmSync(lockPath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  // One call at a time, each to its end: a backend across the network gets the same from its
  // own atomic commands. With a folder, under its lock, after what other processes wrote. The
  // calls made while another runs wait together, and run one after the other under one lock,
  // state.json written once after them, before any of them resolves: a burst of writes (a map's
  // items, store-map.mjs) costs one write of the file, not one each, and none is acknowledged
  // before it is on disk.
  let queue = Promise.resolve();
  let waiting = null;
  function exclusive(fn, { locked = true } = {}) {
    if (!dir || !locked) {
      const result = queue.then(fn);
      queue = result.catch(() => {});
      return result;
    }
    const call = { fn };
    const result = new Promise((resolve, reject) => Object.assign(call, { resolve, reject }));
    if (waiting) {
      waiting.push(call);
      return result;
    }
    const calls = (waiting = [call]);
    // Whatever throws outside the calls themselves (the lock, reading the state again, giving the
    // lock back) fails the batch's calls, and only them: the queue goes on with the next.
    queue = queue
      .then(async () => {
        if (waiting === calls) waiting = null;
        await lock();
        let failed = null;
        try {
          refresh();
          batching = true;
          dirty = false;
          for (const c of calls) {
            const before = dirty;
            dirty = false;
            try {
              c.value = c.fn();
            } catch (error) {
              c.error = error;
            }
            c.wrote = dirty;
            dirty ||= before;
          }
          batching = false;
          try {
            if (dirty) writeState();
          } catch (error) {
            failed = error;
          }
        } finally {
          batching = false;
          dirty = false;
          unlock();
        }
        for (const c of calls) {
          if (c.error) c.reject(c.error);
          else if (failed && c.wrote) c.reject(failed);
          else c.resolve(c.value);
        }
      })
      .catch((error) => {
        for (const c of calls) c.reject(error);
      });
    return result;
  }

  const isApart = (key) => prefixOf(key) !== null;
  const apartPath = (key) => join(folderOf(prefixOf(key)), fileName(key));
  // Its path to be written: its folder made first, once per process (never removed).
  const made = new Set();
  function apartTarget(key) {
    const folder = folderOf(prefixOf(key));
    if (!made.has(folder)) {
      mkdirSync(folder, { recursive: true });
      made.add(folder);
    }
    return join(folder, fileName(key));
  }
  // A key's file: { key, value }, or null. A name cut and hashed (fileName()) is another key's
  // only if the hashes meet.
  function readApart(path, key = null) {
    let found;
    try {
      found = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
    if (key !== null && found?.key !== key) return null;
    return { value: found.value, expiresAt: null };
  }

  // A key under `apart` is in a file of its own while it doesn't expire, so that listing them
  // reads no file (apartKeys()); with a TTL, it is in state.json, as any other. In one place
  // at a time: a write to one removes it from the other.
  const entry = (key) => {
    const found = keys.get(key);
    if (found || !isApart(key)) return live(found, now()) ? found : null;
    return readApart(apartPath(key), key);
  };
  // `found`: { value, expiresAt }, written where its key goes.
  function write(key, found) {
    if (isApart(key) && found.expiresAt === null) {
      writeJsonAtomic(apartTarget(key), { key, value: found.value }, { mode: 0o600 });
      if (keys.delete(key)) save();
      return;
    }
    if (isApart(key)) rmSync(apartPath(key), { force: true });
    keys.set(key, found);
    save();
  }
  function remove(key) {
    if (isApart(key)) rmSync(apartPath(key), { force: true });
    if (keys.delete(key) || !isApart(key)) save();
  }
  function put(key, value, ttlMs) {
    if (value === undefined) throw new TypeError(`${key}: undefined isn't a value`);
    write(key, { value: copy(value), expiresAt: expiry(ttlMs, now()) });
  }
  // The keys under `apart` that state.json holds without a TTL (a release before kept them
  // there), each to its file, then state.json written without them, under the lock; and the
  // files right in keys/ (a release before #773 kept them there, no folder per prefix), each to
  // its prefix's folder; how many. Only once no process that doesn't know them apart writes
  // them any more (the orchestrator: once it holds the lease, its copy before gone): that one's
  // delete would leave the file. Should a write fail, the call fails, and they are still in
  // state.json, which entry() reads first: the same values, moved by the next call.
  function moveApart() {
    if (!apartDir) return 0;
    const moved = [...keys].filter(([key, found]) => isApart(key) && found.expiresAt === null);
    const filed = moveIntoFolders();
    if (!moved.length) return filed;
    for (const [key, found] of moved) {
      writeJsonAtomic(apartTarget(key), { key, value: found.value }, { mode: 0o600 });
    }
    for (const [key] of moved) keys.delete(key);
    try {
      writeState();
    } catch (error) {
      for (const [key, found] of moved) keys.set(key, found);
      throw error;
    }
    return moved.length + filed;
  }
  // The files right in keys/, each renamed into its prefix's folder; one whose folder has its key
  // already (written since) removed. Their writes' temporary files (a `.`) are left as they are.
  // Once moved, keys/ holds the folders alone: a listing of a few names, nothing more to move.
  function moveIntoFolders() {
    let count = 0;
    for (const file of readdir(apartDir, { withFileTypes: true })) {
      if (!file.isFile() || file.name.includes(".")) continue;
      const key = file.name.includes("~") ? keyOf(apartDir, file.name) : decoded(file.name);
      if (typeof key !== "string" || !isApart(key)) continue;
      const from = join(apartDir, file.name);
      if (existsSync(apartPath(key))) rmSync(from, { force: true });
      else renameSync(from, apartTarget(key));
      count++;
    }
    return count;
  }

  // The keys under `prefix` in keys/: only the folders of the prefixes of `apart` that may have
  // some, each key in the one of its own prefix (prefixOf()). From their files' names
  // (fileName() is decodeURIComponent()'s reverse), none read but those cut and hashed (a `~`),
  // for theirs. Their writes' temporary files have a `.`, which no name has.
  function apartKeys(prefix) {
    // Those under `prefix`, and the longest `prefix` is under: its keys' folder, none of the
    // shorter ones'.
    const above = prefixOf(prefix);
    const folders = new Set(apart.filter((p) => p.startsWith(prefix)));
    if (above !== null) folders.add(above);
    return [...folders].flatMap((p) => {
      const folder = folderOf(p);
      return listFolder(folder)
        .filter((name) => !name.includes("."))
        .map((name) => (name.includes("~") ? keyOf(folder, name) : decoded(name)))
        .filter((key) => typeof key === "string" && key.startsWith(prefix) && prefixOf(key) === p);
    });
  }
  function listFolder(folder) {
    try {
      return readdir(folder);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  // A file's name as its key, null for one no fileName() gives (a stray file).
  function decoded(name) {
    try {
      return decodeURIComponent(name);
    } catch {
      return null;
    }
  }
  // A hashed name's key, from its file.
  function keyOf(folder, name) {
    try {
      return JSON.parse(readFileSync(join(folder, name), "utf8")).key;
    } catch {
      return null;
    }
  }

  // The stream's file, read once, then its new lines as they come (refresh()): a line cut
  // short by a crash mid-append is dropped, and cut from the file before the next one is added.
  function stream(name) {
    let found = streams.get(named(name));
    if (found) return found;
    found = { next: 1, events: [], lines: 0, bytes: 0, ino: null, gen: gens.get(name) ?? 0 };
    const path = dir && join(dir, "streams", `${fileName(name)}.jsonl`);
    found.path = path;
    if (path && existsSync(path)) readLines(name, found, statSync(path).size);
    // Its file may no longer hold its last events (dropped, ack()'s `drop`, while an earlier one
    // is still pending): its ids go on from the next one state.json saved, never one handed out.
    found.next = Math.max(found.next, nexts.get(name) ?? 1, firsts.get(name) ?? 1);
    streams.set(name, found);
    return found;
  }

  // The lines of a stream's file past what `found` has read, up to `size` bytes.
  function readLines(name, found, size) {
    const fd = openSync(found.path, "r");
    let text;
    try {
      found.ino = fstatSync(fd).ino;
      const data = Buffer.alloc(size - found.bytes);
      let read = 0;
      while (read < data.length) {
        const n = readSync(fd, data, read, data.length - read, found.bytes + read);
        if (!n) break;
        read += n;
      }
      text = data.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const whole = text.lastIndexOf("\n") + 1;
    const kept = Buffer.byteLength(text.slice(0, whole));
    if (whole < text.length) truncateSync(found.path, found.bytes + kept);
    found.bytes += kept;
    const first = firsts.get(name) ?? 0;
    for (const line of text.slice(0, whole).split("\n")) {
      if (!line) continue;
      const { id, event } = JSON.parse(line);
      if (id >= first) found.events.push({ id, event });
      found.next = Math.max(found.next, id + 1);
      found.lines++;
    }
  }

  function consumerOf(name, consumer) {
    named(name);
    named(consumer);
    if (!consumers.has(name)) consumers.set(name, new Map());
    const all = consumers.get(name);
    if (!all.has(consumer)) all.set(consumer, { offset: 0, acked: [], read: 0 });
    const state = all.get(consumer);
    state.read ??= state.offset;
    return state;
  }

  // Only the last `maxLength` events: the first kept is saved at once, and the file rewritten
  // once it holds twice as many lines.
  function trim(name, found, maxLength) {
    if (!maxLength || found.events.length <= maxLength) return;
    found.events = found.events.slice(-maxLength);
    firsts.set(name, found.events[0].id);
    save();
    if (found.path && found.lines >= 2 * maxLength) rewrite(name, found);
  }

  // `drop`: a stream of one consumer, whose events go once it acknowledged them, from memory
  // and, once its file holds DROPPED_MAX lines more than it keeps, from the file too.
  function dropAcked(name, state) {
    const found = stream(name);
    const acked = new Set(state.acked);
    found.events = found.events.filter((e) => e.id > state.offset && !acked.has(e.id));
    if ((firsts.get(name) ?? 0) <= state.offset) firsts.set(name, state.offset + 1);
    if (found.path && found.lines - found.events.length >= DROPPED_MAX) rewrite(name, found);
  }

  // The stream's file as `found` keeps it; its next id saved first, which the file may lose.
  function rewrite(name, found) {
    nexts.set(name, found.next);
    found.gen = (gens.get(name) ?? 0) + 1;
    gens.set(name, found.gen);
    save();
    writeFileAtomic(found.path, found.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    found.lines = found.events.length;
    const stat = statSync(found.path);
    found.bytes = stat.size;
    found.ino = stat.ino;
  }

  const blobPath = (key) => dir && join(dir, "blobs", fileName(key));
  const bytes = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(String(data)));

  return {
    get: (key) => exclusive(() => copy(entry(key)?.value)),
    set: (key, value, { ttlMs } = {}) => exclusive(() => void put(key, value, ttlMs)),
    delete: (key) =>
      exclusive(() => {
        const had = !!entry(key);
        remove(key);
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
    // Its keys sorted, the cursor the last one listed: a key there from the first page to the
    // last is listed once, whatever was added or deleted between them. Each page sorts the
    // prefix's keys again: fine for a node's few thousand.
    keys: (prefix, { cursor = null, count = 1000 } = {}) =>
      exclusive(() => {
        listing(prefix, count);
        const at = now();
        // A key both in state.json and in its file (a moveApart() that failed midway), listed
        // once.
        const found = [
          ...new Set(
            [...keys]
              .filter(([key, entry]) => key.startsWith(prefix) && live(entry, at))
              .map(([key]) => key)
              .concat(apartDir ? apartKeys(prefix) : []),
          ),
        ]
          .filter((key) => cursor === null || key > cursor)
          .sort((a, b) => (a < b ? -1 : 1));
        const page = found.slice(0, count);
        return { keys: page, cursor: found.length > count ? page.at(-1) : null };
      }),
    increment: (key, by = 1, { ttlMs } = {}) =>
      exclusive(() => {
        const found = entry(key);
        if (found && typeof found.value !== "number") throw new TypeError(`${key} isn't a number`);
        const value = (found?.value ?? 0) + by;
        write(key, { value, expiresAt: found ? found.expiresAt : expiry(ttlMs, now()) });
        return value;
      }),

    acquire: (name, holder, { ttlMs } = {}) =>
      exclusive(() => {
        leaseTtl(ttlMs);
        const at = now();
        const held = leases.get(name);
        if (held?.holder && held.expiresAt > at && held.holder !== holder) return null;
        // At least the time in ms, as Redis's (store-redis.mjs): a state file a crash took back
        // to an older one can't bring back an epoch already handed out.
        const epoch =
          held?.holder === holder && held.expiresAt > at
            ? held.epoch
            : Math.max((held?.epoch ?? 0) + 1, at);
        const lease = { holder, epoch, expiresAt: at + ttlMs };
        leases.set(name, lease);
        save();
        return { ...lease };
      }),
    renew: (name, holder, epoch, { ttlMs } = {}) =>
      exclusive(() => {
        leaseTtl(ttlMs);
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
          const line = `${JSON.stringify(record)}\n`;
          appendFileSync(found.path, line);
          found.lines++;
          found.bytes += Buffer.byteLength(line);
          found.ino ??= statSync(found.path).ino;
        }
        found.events.push(record);
        found.next++;
        trim(name, found, maxLength);
        return String(record.id);
      }),
    read: (name, consumer, { count = 100 } = {}) =>
      exclusive(() => {
        const state = consumerOf(name, consumer);
        const done = new Set(state.acked);
        const out = [];
        let last = state.read;
        for (const { id, event } of stream(name).events) {
          if (id <= state.offset || done.has(id)) continue;
          out.push({ id: String(id), event: copy(event) });
          last = Math.max(last, id);
          if (out.length >= count) break;
        }
        // What was read can be acknowledged; the rest can't until it is, as with Redis's
        // consumer groups.
        if (last > state.read) {
          state.read = last;
          save();
        }
        return out;
      }),
    ack: (name, consumer, ids, { drop = false } = {}) =>
      exclusive(() => {
        const state = consumerOf(name, consumer);
        const known = new Set(stream(name).events.map((e) => e.id));
        const done = new Set(state.acked);
        let count = 0;
        for (const id of ids.map(Number)) {
          if (id <= state.offset || id > state.read || done.has(id) || !known.has(id)) continue;
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
        if (drop) dropAcked(name, state);
        save();
        return count;
      }),

    putBlob: (key, data) =>
      exclusive(() => {
        named(key);
        if (dir) writeFileAtomic(blobPath(key), bytes(data));
        else blobs.set(key, Buffer.from(bytes(data)));
      }),
    appendBlob: (key, data) =>
      exclusive(() => {
        named(key);
        if (dir) appendFileSync(blobPath(key), bytes(data));
        else blobs.set(key, Buffer.concat([blobs.get(key) ?? Buffer.alloc(0), bytes(data)]));
      }),
    appendBlobAt: (key, at, data) =>
      exclusive(() => {
        named(key);
        const path = blobPath(key);
        const have = dir
          ? existsSync(path)
            ? statSync(path).size
            : 0
          : (blobs.get(key)?.length ?? 0);
        if (at > have) return { length: have, gap: true };
        const rest = bytes(data).subarray(have - at);
        if (dir) appendFileSync(path, rest);
        else blobs.set(key, Buffer.concat([blobs.get(key) ?? Buffer.alloc(0), rest]));
        return { length: have + rest.length };
      }),
    readBlob: (key, { offset = 0, length = Infinity } = {}) =>
      exclusive(() => {
        named(key);
        if (!dir) {
          return blobs.has(key)
            ? Buffer.from(blobs.get(key).subarray(offset, offset + length))
            : null;
        }
        let fd;
        try {
          fd = openSync(blobPath(key), "r");
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
        // From the offset only: a log read as it grows isn't read whole each time.
        try {
          const data = Buffer.alloc(Math.max(0, Math.min(length, fstatSync(fd).size - offset)));
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
    blobSize: (key) =>
      exclusive(() => {
        named(key);
        if (!dir) return blobs.has(key) ? blobs.get(key).length : null;
        try {
          return statSync(blobPath(key)).size;
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      }),
    deleteBlob: (key) =>
      exclusive(() => {
        named(key);
        if (!dir) return blobs.delete(key);
        const path = blobPath(key);
        const had = existsSync(path) && statSync(path).isFile();
        rmSync(path, { force: true });
        return had;
      }),

    // Not in store.mjs's interface: the file backend's alone (Redis has nothing to move).
    moveApart: () => exclusive(() => moveApart()),

    // The calls before it done: nothing of its own to write or let go.
    close: () => exclusive(() => {}, { locked: false }),
  };
}
