// Runs' logs (#503): the runner owns them, as blobs of its store (`logs/<run>`), so either copy
// serves them, the dashboard's live view included. The orchestrator writes them (its lines, the
// agent's as it reads them, an image's build) by appends that name the offset they go at: one
// sent again after a lost answer, or a handover, is taken once (append()). Reads go on from an
// offset, waiting a little for more (read()), as a log is followed while its run goes on.
//
// A log is written in segments (#607), so that the closed ones can leave the store (#608) while
// the run goes on: `logs/<run>/<n>`, and an index (`logs/<run>/index`, a value of the store's:
// { segments: [{ at, size, where }], open }), the closed segments' first bytes and sizes, and the
// first byte of the open one, the last. Only the open one is appended to. It closes at a step of
// the run (an append marked `step`: a phase's first line, ../listener/runlog.mjs enterPhase()),
// at `segmentMax` (LOG_SEGMENT_MB), and at the run's end (an append marked `close`), by
// compare-and-sets of the index, so that two copies handing over agree on where it ended: one
// marks it `closing`, then one measures it and records its size (closeOpen()). Callers only
// ever see offsets in the whole log. A log written before segments (`logs/<run>`, one blob, no
// index) reads as one closed segment, and is still appended to as it was (a run in flight
// through the update).
//
// With blob storage (BLOB_URL, #608), each closed segment leaves the store (moveOne()): copied
// there under the same key and measured, then the index points at it (`where: "blobs"`, one
// compare-and-set), then it is deleted from the store. It is in one place or the other at every
// step, and a read takes the index first, so none misses it. Each closing is noted in a stream of
// the store's (MOVES), read by the copy holding the runner's lease (moves.start()): at once, every
// few minutes, and with a growing delay while blob storage fails. A move cut short (a crash, a
// handover) is done again from the start, which does no harm, and the note acknowledged only once
// it is done. A log of the old shape stays in the store, until retention.

// A run's id: what runs.mjs names logs after ("<sandbox>-<ms>"). Nothing that climbs out.
const ID = /^\w[\w.-]{0,199}$/;

// The most one read() answers, so that a 200 MB log is sent in parts.
export const MAX_READ = 4 * 1024 * 1024;

export class LogConflict extends Error {
  constructor(size) {
    super(`the log is ${size} bytes long`);
    this.size = size;
  }
}

export const validLogId = (id) => typeof id === "string" && ID.test(id);

// A log without an index: one open segment, from its first byte.
const EMPTY = { segments: [], open: 0 };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const NONE = Buffer.alloc(0);

// The closed segments still to move, a note each ({ id, n, size }), and their one reader.
export const MOVES = "log-moves";
const MOVER = "runner";
// A look for segments left in the store (a move cut short, blob storage away): this often while
// blob storage answers; while it fails, after RETRY_MS, doubled at each failure, MAX_RETRY_MS at
// most.
export const PASS_MS = 5 * 60_000;
export const RETRY_MS = 30_000;
export const MAX_RETRY_MS = 30 * 60_000;
// The notes read at a time, and the most counted for /health.
const BATCH = 100;
const COUNTED = 100_000;

// What the runner's /health says while closed segments wait for blob storage (moves.waiting()):
// how many and how big, so that an operator sees Redis fill up before it is full. Null when none.
export function waitingWarning(waiting) {
  if (!waiting) return null;
  const { segments, bytes } = waiting;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `${segments} closed log segment${segments === 1 ? "" : "s"} (${mb} MB) wait in the store: blob storage fails, tried again with a growing delay (the runner's log says why)`;
}

// `blobs`: lib/blobs.mjs openBlobs()'s, where closed segments go; null, they stay in the store.
export function createLogs({
  store,
  blobs = null,
  segmentMax = 8 * 1024 * 1024,
  timers = globalThis,
  log = () => {},
}) {
  const checked = (id) => {
    if (!validLogId(id)) throw new TypeError(`not a run's id: ${JSON.stringify(id)}`);
    return id;
  };
  const legacyKey = (id) => `logs/${checked(id)}`;
  const indexKey = (id) => `logs/${checked(id)}/index`;
  const segmentKey = (id, n, place) => (place?.legacy ? legacyKey(id) : `logs/${checked(id)}/${n}`);
  const chains = new Map(); // id → its last append: one at a time per log
  const exclusive = new Map(); // id → its move or removal in flight: one at a time per log
  const waiting = new Map(); // id → the reads waiting for more

  // Where the log is: { stored (the index as kept, null for none), index, openSize, size }, or a
  // log of the old shape as one closed segment ({ legacy: true, … }). Asked each time, not
  // kept: the other copy may have written since (a handover). A closing left half done (the
  // other copy stalled, or gone) is finished first, so a read may write the index too (a
  // compare-and-set finishing what a copy started; GET /logs is unfenced, a draining copy's
  // included). The index is read again after the open segment's size: a segment closed in
  // between would have that size be another's.
  async function locate(id) {
    for (;;) {
      const stored = await store.get(indexKey(id));
      if (stored?.closing) {
        await finishClosing(id, stored);
        continue;
      }
      const index = stored ?? EMPTY;
      const openSize = await store.blobSize(segmentKey(id, index.segments.length));
      if (!stored && openSize === null) {
        const old = await store.blobSize(legacyKey(id));
        if (old !== null) {
          const segments = [{ at: 0, size: old, where: "store" }];
          return { legacy: true, stored, index: { segments, open: old }, openSize: 0, size: old };
        }
      }
      if (same(await store.get(indexKey(id)), stored)) {
        return { stored, index, openSize: openSize ?? 0, size: index.open + (openSize ?? 0) };
      }
    }
  }

  const sizeOf = async (id) => (await locate(id)).size;

  // The open segment closed, unless it is empty. First marked `closing`, then measured: an
  // append that wrote to it before the mark, and reads the index after its write, finds the mark
  // or the size, so it knows whether its bytes are in it (appendOnce()). A compare-and-set that
  // fails is another copy's move: the caller locates the log again either way.
  async function closeOpen(id, { stored, index }) {
    const marked = { ...index, closing: true };
    if (await store.compareAndSet(indexKey(id), stored, marked)) await finishClosing(id, marked);
  }

  // A segment marked `closing`: its size recorded as it is now, by whichever copy gets there.
  // One found empty stays open: nothing wrote to it before the mark.
  // With blob storage, the segment is noted to move before the index says it is closed: a copy
  // stopping in between leaves a note of a segment still open (moveOne() skips it), never a
  // closed segment without one.
  async function finishClosing(id, stored) {
    const { closing: _, ...index } = stored;
    const n = index.segments.length;
    const size = (await store.blobSize(segmentKey(id, n))) ?? 0;
    const segments = [...index.segments, { at: index.open, size, where: "store" }];
    const next = size ? { segments, open: index.open + size } : index;
    if (blobs && size) await store.append(MOVES, { id, n, size });
    if ((await store.compareAndSet(indexKey(id), stored, next)) && blobs && size) moves.kick();
  }

  // `data` at byte `at`: taken when the log is that long, and taken already when it ends just
  // past it (the same append sent again). Anything else: a LogConflict with its size, which the
  // writer goes on from. `step`: it starts a step of the run, so a segment of its own; `close`:
  // the open segment closes after it (the run's end). → the log's new size.
  function append(id, at, data, { step = false, close = false } = {}) {
    checked(id);
    const previous = chains.get(id) ?? Promise.resolve();
    const done = previous.then(async () => {
      const size = await appendOnce(id, at, data, step);
      if (close) {
        const place = await locate(id);
        if (!place.legacy && place.openSize) await closeOpen(id, place);
      }
      return size;
    });
    const settled = done.catch(() => {});
    chains.set(id, settled);
    settled.then(() => chains.get(id) === settled && chains.delete(id));
    return done;
  }

  async function appendOnce(id, at, data, step) {
    for (;;) {
      const place = await locate(id);
      const { index, openSize, size } = place;
      if (at + data.length === size && data.length) return size;
      if (at !== size) throw new LogConflict(size);
      if (!data.length) return size;
      if (place.legacy) {
        // As before segments: in one step of the store's (below).
        const written = await store.appendBlobAt(legacyKey(id), at, data);
        if (written.gap) throw new LogConflict(written.length);
        wake(id);
        return at + data.length;
      }
      if (openSize && (step || openSize + data.length > segmentMax)) {
        await closeOpen(id, place);
        continue;
      }
      // In one step of the store's, not just of this copy's: two copies handing over (a lease
      // that expired on a stalled one) may both have read this size. The second then finds
      // the same bytes there and adds nothing.
      const n = index.segments.length;
      const from = at - index.open;
      const written = await store.appendBlobAt(segmentKey(id, n), from, data);
      if (written.gap) throw new LogConflict((await locate(id)).size);
      // The other copy may have closed this segment meanwhile, measured before these bytes:
      // they are past its end then, in no segment, and the writer goes on from the log's. Not
      // marked closing yet: whoever measures it does so after these bytes.
      let after = await store.get(indexKey(id));
      if (after?.closing) {
        await finishClosing(id, after);
        after = await store.get(indexKey(id));
      }
      // Removed meanwhile (retention): this write made a segment of no index's, which reads
      // and remove() would never find. Taken back, and the writer goes on from an empty log.
      if (!after && n > 0) {
        await store.deleteBlob(segmentKey(id, n));
        throw new LogConflict((await locate(id)).size);
      }
      const closed = after?.segments?.[n];
      if (closed && closed.at === index.open && closed.size < from + data.length) {
        throw new LogConflict((await locate(id)).size);
      }
      wake(id);
      return at + data.length;
    }
  }

  function wake(id) {
    const all = waiting.get(id);
    waiting.delete(id);
    for (const done of all ?? []) done();
  }

  // { size, data }: its bytes from `offset` (MAX_READ at most, from the one segment holding
  // it), waiting up to `wait` ms when there are none yet. A log not written yet reads as empty
  // (size 0).
  async function read(id, { offset = 0, length = MAX_READ, wait = 0, signal } = {}) {
    const take = Math.min(length, MAX_READ);
    const now = async () => {
      for (;;) {
        const place = await locate(id);
        const { index, size } = place;
        if (offset >= size) return { size, data: NONE };
        let n = index.segments.length;
        let start = index.open;
        let end = size;
        if (offset < index.open) {
          n = index.segments.findLastIndex((s) => s.at <= offset);
          ({ at: start } = index.segments[n]);
          end = start + index.segments[n].size;
        }
        const part = { offset: offset - start, length: Math.min(take, end - offset) };
        const data = await readSegment(id, n, place, index.segments[n], part);
        if (data) return { size, data };
        // Moved to blob storage between the index and the read, or removed: the index again.
        if (same(await store.get(indexKey(id)), place.stored)) return { size, data: NONE };
      }
    };
    const first = await now();
    if (first.data.length || !wait || signal?.aborted) return first;
    await new Promise((resolve) => {
      const done = () => {
        timers.clearTimeout(timer);
        waiting.get(id)?.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = timers.setTimeout(done, wait);
      if (!waiting.has(id)) waiting.set(id, new Set());
      waiting.get(id).add(done);
      signal?.addEventListener("abort", done);
    });
    return now();
  }

  // Segment `n`'s bytes `part`, from where the index says it is (`segment`: null for the open
  // one), or null when it isn't there.
  async function readSegment(id, n, place, segment, part) {
    if (segment?.where !== "blobs") return store.readBlob(segmentKey(id, n, place), part);
    if (!blobs) throw new Error(`${segmentKey(id, n)}: in blob storage, and BLOB_URL is unset`);
    return blobs.read(segmentKey(id, n), part);
  }

  // `fn` once the move or removal in flight on that log is done: a removal never runs between a
  // move's copy and its compare-and-set, which would leave a copy in blob storage that no index
  // names. (Two copies handing over could still, both acting a moment: a removal is of a run
  // older than LOG_RETENTION_DAYS, whose segments moved long before.)
  function inTurn(id, fn) {
    const previous = exclusive.get(id) ?? Promise.resolve();
    const done = previous.then(fn);
    const settled = done.catch(() => {});
    exclusive.set(id, settled);
    settled.then(() => exclusive.get(id) === settled && exclusive.delete(id));
    return done;
  }

  // Every segment, in blob storage first (a failure there leaves the log for the next day's
  // pass, history.mjs), then the index, the store's segments and the old shape's blob
  // (retention). The index before the store's segments, counted before: an append landing
  // meanwhile finds it gone, and takes its segment back (appendOnce()), rather than leave one
  // that no index names.
  function remove(id) {
    checked(id);
    return inTurn(id, async () => {
      const stored = await store.get(indexKey(id));
      const count = (stored?.segments.length ?? 0) + 1;
      if (blobs) {
        for (let n = 0; n < count; n++) await blobs.delete(segmentKey(id, n));
      } else if (stored?.segments.some((s) => s.where === "blobs")) {
        throw new Error(`${indexKey(id)}: segments in blob storage, and BLOB_URL is unset`);
      }
      let had = await store.delete(indexKey(id));
      for (let n = 0; n < count; n++) had = (await store.deleteBlob(segmentKey(id, n))) || had;
      return (await store.deleteBlob(legacyKey(id))) || had;
    });
  }

  // Closed segment `n` of log `id` to blob storage: copied, measured there, pointed at, deleted
  // from the store. Each step is done again when found undone, so a move cut short anywhere
  // finishes on the next try. Throws when a step fails (blob storage away): the note stays.
  function moveOne(id, n) {
    return inTurn(id, async () => {
      const key = segmentKey(id, n);
      let stored = await store.get(indexKey(id));
      if (stored?.closing && stored.segments.length === n) {
        await finishClosing(id, stored);
        stored = await store.get(indexKey(id));
      }
      // Removed (retention), or a closing that found it empty: it stayed open, and its next
      // closing notes it again.
      const segment = stored?.segments[n];
      if (!segment) return;
      if (segment.where !== "blobs") {
        // Its own bytes alone: a stalled copy's append may have written past its end (appendOnce()).
        const data = await store.readBlob(key, { offset: 0, length: segment.size });
        if (data?.length !== segment.size) {
          // Another copy's move, done meanwhile (a handover): its last step, in case it stopped.
          if ((await store.get(indexKey(id)))?.segments[n]?.where === "blobs") {
            await store.deleteBlob(key);
            return;
          }
          log(
            `Log segments: ${key} isn't in the store as its index says (${data?.length ?? "none"} of ${segment.size} bytes): left there`,
          );
          return;
        }
        await blobs.put(key, data);
        const size = await blobs.size(key);
        if (size !== segment.size) {
          throw new Error(
            `${key}: ${size ?? "nothing"} bytes in blob storage, ${segment.size} sent`,
          );
        }
        for (;;) {
          const current = await store.get(indexKey(id));
          if (!current?.segments[n]) {
            // Removed meanwhile: its copy goes too.
            await blobs.delete(key);
            return;
          }
          if (current.segments[n].where === "blobs") break;
          const segments = current.segments.map((s, i) => (i === n ? { ...s, where: "blobs" } : s));
          if (await store.compareAndSet(indexKey(id), current, { ...current, segments })) break;
        }
      }
      await store.deleteBlob(key);
    });
  }

  const moves = createMoves({ store, enabled: Boolean(blobs), moveOne, timers, log });

  return { append, read, remove, size: sizeOf, moves };
}

// What moves the closed segments (createLogs()'s `moves`), on the copy holding the runner's
// lease alone: start() when it gets it, stop() when it goes. A pass reads the notes, moves each
// one's segment in order and acknowledges it, and stops at the first failure: blob storage is
// away, tried again after a growing delay. kick(): a segment just closed, a pass soon.
function createMoves({ store, enabled, moveOne, timers, log }) {
  let active = false;
  let timer = null;
  let running = null;
  let again = false;
  let failures = 0;
  let waiting = null; // { segments, bytes } while blob storage fails

  const retryDelay = () => Math.min(RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
  const schedule = (ms) => {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      return pass(); // its promise, which the tests' timers wait for
    }, ms);
    timer.unref?.();
  };

  // → whether every note was done.
  async function once() {
    for (;;) {
      const notes = await store.read(MOVES, MOVER, { count: BATCH });
      if (!notes.length) return;
      for (const { id: note, event } of notes) {
        // Not one of ours (a store shared wrongly): dropped rather than kept for ever.
        if (validLogId(event?.id) && Number.isSafeInteger(event.n) && event.n >= 0) {
          await moveOne(event.id, event.n);
        }
        await store.ack(MOVES, MOVER, [note], { drop: true });
      }
    }
  }

  // Every note left, and the segments they say, counted for /health.
  async function count() {
    const notes = await store.read(MOVES, MOVER, { count: COUNTED });
    const bytes = notes.reduce((sum, { event }) => sum + (Number(event?.size) || 0), 0);
    return { segments: notes.length, bytes };
  }

  function pass() {
    if (!enabled) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        await once();
        if (failures) log("Log segments: blob storage answers again, the waiting ones moved");
        failures = 0;
        waiting = null;
      } catch (error) {
        failures++;
        waiting = await count().catch(() => waiting);
        (log.warn ?? log)(
          `Log segments: can't move them to blob storage (${error.message}); ${waiting?.segments ?? "some"} wait in the store, tried again in ${Math.round(retryDelay() / 1000)} s`,
        );
      } finally {
        running = null;
      }
      if (!active) return;
      if (again && !failures) {
        again = false;
        return pass();
      }
      again = false;
      schedule(failures ? retryDelay() : PASS_MS);
    })();
    return running;
  }

  return {
    // The copy holding the lease: a pass now, for what a copy before it left.
    start() {
      if (!enabled || active) return;
      active = true;
      schedule(0);
    },
    // Its lease gone: no pass after the one in flight, which the next holder does again.
    stop() {
      active = false;
      timers.clearTimeout(timer);
      timer = null;
    },
    // A segment closed: a pass at once, unless blob storage is failing (its delay holds).
    kick() {
      if (!active || failures) return;
      if (running) again = true;
      else schedule(0);
    },
    pass,
    // { segments, bytes } while blob storage fails, null otherwise.
    waiting: () => waiting,
  };
}
