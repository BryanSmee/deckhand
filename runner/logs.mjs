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

export function createLogs({ store, segmentMax = 8 * 1024 * 1024, timers = globalThis }) {
  const checked = (id) => {
    if (!validLogId(id)) throw new TypeError(`not a run's id: ${JSON.stringify(id)}`);
    return id;
  };
  const legacyKey = (id) => `logs/${checked(id)}`;
  const indexKey = (id) => `logs/${checked(id)}/index`;
  const segmentKey = (id, n, place) => (place?.legacy ? legacyKey(id) : `logs/${checked(id)}/${n}`);
  const chains = new Map(); // id → its last append: one at a time per log
  const waiting = new Map(); // id → the reads waiting for more

  // Where the log is: { stored (the index as kept, null for none), index, openSize, size }, or a
  // log of the old shape as one closed segment ({ legacy: true, … }). Asked each time, not
  // kept: the other copy may have written since (a handover). A closing left half done (the
  // other copy stalled, or gone) is finished first. The index is read again after the open
  // segment's size: a segment closed in between would have that size be another's.
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
  async function finishClosing(id, stored) {
    const { closing: _, ...index } = stored;
    const size = (await store.blobSize(segmentKey(id, index.segments.length))) ?? 0;
    const segments = [...index.segments, { at: index.open, size, where: "store" }];
    const next = size ? { segments, open: index.open + size } : index;
    await store.compareAndSet(indexKey(id), stored, next);
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
      return { size, data: (await store.readBlob(segmentKey(id, n, place), part)) ?? NONE };
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

  // Every segment, the open one, the old shape's blob and the index (retention, history.mjs).
  async function remove(id) {
    const count = ((await store.get(indexKey(id)))?.segments.length ?? 0) + 1;
    let had = false;
    for (let n = 0; n < count; n++) had = (await store.deleteBlob(segmentKey(id, n))) || had;
    had = (await store.deleteBlob(legacyKey(id))) || had;
    return (await store.delete(indexKey(id))) || had;
  }

  return { append, read, remove, size: sizeOf };
}
