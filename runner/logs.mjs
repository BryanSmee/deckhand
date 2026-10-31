// Runs' logs (#503): the runner owns them, as blobs of its store (`logs/<run>`), so either copy
// serves them, the dashboard's live view included. The orchestrator writes them (its lines, the
// agent's as it reads them, an image's build) by appends that name the offset they go at: one
// sent again after a lost answer, or a handover, is taken once (append()). Reads go on from an
// offset, waiting a little for more (read()), as a log is followed while its run goes on.

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

export function createLogs({ store, timers = globalThis }) {
  const key = (id) => {
    if (!validLogId(id)) throw new TypeError(`not a run's id: ${JSON.stringify(id)}`);
    return `logs/${id}`;
  };
  const chains = new Map(); // id → its last append: one at a time per log
  const waiting = new Map(); // id → the reads waiting for more

  // Asked each time, not kept: the other copy may have written since (a handover).
  const sizeOf = async (id) => (await store.blobSize(key(id))) ?? 0;

  // `data` at byte `at`: taken when the log is that long, and taken already when it ends just
  // past it (the same append sent again). Anything else: a LogConflict with its size, which the
  // writer goes on from. → the log's new size.
  function append(id, at, data) {
    const previous = chains.get(id) ?? Promise.resolve();
    const done = previous.then(async () => {
      const size = await sizeOf(id);
      if (at + data.length === size && data.length) return size;
      if (at !== size) throw new LogConflict(size);
      if (!data.length) return size;
      // In one step of the store's, not just of this copy's: two copies handing over (a lease
      // that expired on a stalled one) may both have read this size. The second then finds
      // the same bytes there and adds nothing.
      const written = await store.appendBlobAt(key(id), at, data);
      if (written.gap) throw new LogConflict(written.length);
      wake(id);
      return at + data.length;
    });
    const settled = done.catch(() => {});
    chains.set(id, settled);
    settled.then(() => chains.get(id) === settled && chains.delete(id));
    return done;
  }

  function wake(id) {
    const all = waiting.get(id);
    waiting.delete(id);
    for (const done of all ?? []) done();
  }

  // { size, data }: its bytes from `offset` (MAX_READ at most), waiting up to `wait` ms when
  // there are none yet. A log not written yet reads as empty (size 0).
  async function read(id, { offset = 0, length = MAX_READ, wait = 0, signal } = {}) {
    const take = Math.min(length, MAX_READ);
    const now = async () => {
      const size = await sizeOf(id);
      const data =
        offset < size
          ? ((await store.readBlob(key(id), { offset, length: take })) ?? Buffer.alloc(0))
          : Buffer.alloc(0);
      return { size, data };
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

  const remove = (id) => store.deleteBlob(key(id));

  return { append, read, remove, size: sizeOf };
}
