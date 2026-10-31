// A run's files, in the broker's store as blobs (#505), rather than in a volume shared with the
// sandbox, which a cluster would need ReadWriteMany storage for (#393), or in one copy's memory:
// either copy of the broker answers a sandbox's call, and finds them.
//
//   - the inbox: the agent's messages, which the runner appends (POST /runs/:id/inbox) as it
//     appends them to its own file, from the same offset, so the blob is always a prefix of it.
//     The sandbox reads it from a byte offset it keeps (GET /run/inbox?from=<byte>,
//     ../sandbox/deckhand-inbox): a long poll that goes to either copy gets every line once;
//   - the egress proxy's CA and the run's digest, put once before the sandbox starts, fetched
//     once at its start;
//   - its screenshots (PUT /run/shots/<file>), each one on the `runs` stream for the
//     orchestrator, which copies it into the folder GET /shots/<folder>/ serves, then deletes it
//     here. Their sizes stay counted against the run's cap.
import { isImage, MAX_SHOT, MAX_SHOTS, readCapped, SHOT_FOLDER, SHOT_NAME } from "../lib/shots.mjs";

// The most one inbox read answers: whole lines only, so a longer one comes alone.
export const MAX_READ = 1024 * 1024;

// How long GET /run/inbox waits for a line: under the sandbox's own timeout (deckhand-inbox).
export const POLL_MS = 25_000;
// How often a waiting poll reads the store again: the line may come through the other copy.
export const POLL_EVERY_MS = 250;

// The files a sandbox may fetch, by the name it asks for.
export const FILES = ["ca", "digest"];

const inboxKey = (id) => `inbox:${id}`;
// How many bytes of the runner's file the inbox blob holds: the store redacts blobs (a token
// in a comment), so the blob's own length isn't the runner's offset.
const takenKey = (id) => `inbox-taken:${id}`;
const fileKey = (id, name) => `file:${id}:${name}`;
const shotKey = (folder, name) => `shot:${folder}/${name}`;
const sizesKey = (folder) => `shots:${folder}`;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// The whole lines of `data` (a blob read from an offset), up to MAX_READ, or the first line
// alone when it is longer: empty when none is whole yet.
export function wholeLines(data) {
  if (!data.length) return data;
  const within = data.lastIndexOf(10, MAX_READ - 1);
  const end = within !== -1 ? within : data.indexOf(10);
  return data.subarray(0, end + 1);
}

// `store`: lib/store.mjs's; `runs`: runs.mjs's, for the screenshots' events.
export function createFiles({ store, runs, now = Date.now, sleep = realSleep, ttlMs }) {
  // Folder → name → the bytes its upload in flight reserved: counted against MAX_SHOTS. This
  // copy's only: two uploads of one run through two copies at once may pass the cap by one
  // screenshot's size.
  const pending = new Map();

  // The runner's append (POST /runs/:id/inbox): `data`, its file's bytes from `offset`. The
  // blob takes what it doesn't have yet: the same bytes sent again (an answer lost) add
  // nothing. → { length } (of the runner's file the blob has taken), or { length, gap: true }
  // when it has less than `offset` (the runner sends from `length` again). Counted apart from
  // the blob, which the store redacts: the sandbox reads the blob's own offsets, the runner
  // its file's. Whole lines each time (the runner appends one message at a time), so a
  // redaction never splits one.
  async function appendInbox(id, offset, data) {
    const before = await store.get(takenKey(id));
    const have = before ?? 0;
    if (offset > have) return { length: have, gap: true };
    const rest = data.subarray(have - offset);
    // Another copy took this append meanwhile: from what it has now.
    if (!(await store.compareAndSet(takenKey(id), before, have + rest.length, { ttlMs }))) {
      return appendInbox(id, offset, data);
    }
    if (rest.length) await store.appendBlob(inboxKey(id), rest);
    else if (have === 0) await store.putBlob(inboxKey(id), Buffer.alloc(0));
    return { length: have + rest.length };
  }

  // The inbox's whole lines after byte `from`: empty when none came within `timeout` ms, null
  // when the run has none. `signal`: the sandbox went away.
  async function pollInbox(id, from, { timeout = POLL_MS, signal } = {}) {
    const until = now() + timeout;
    for (;;) {
      const data = await store.readBlob(inboxKey(id), { offset: from });
      if (data === null) return null;
      const lines = wholeLines(data);
      if (lines.length || signal?.aborted || now() >= until) return lines;
      await sleep(Math.min(POLL_EVERY_MS, until - now()));
    }
  }

  const putFile = (id, name, data) => store.putBlob(fileKey(id, name), data);
  const getFile = (id, name) => (FILES.includes(name) ? store.readBlob(fileKey(id, name)) : null);

  // An upload of `name` into the run's folder (`record.shots`): read whole (it is capped),
  // checked, kept, then said on the stream. → { status, message? }.
  async function putShot(req, record, name) {
    if (!SHOT_NAME.test(name))
      return { status: 400, message: "only .png, .jpg, .jpeg and .webp files" };
    const folder = record.shots;
    if (!folder || !SHOT_FOLDER.test(folder)) {
      return { status: 403, message: "this run has no screenshots" };
    }
    // One upload of a name at a time (the watcher's and gh's may meet): a second one is told
    // to come back (409, which deckhand-files retries), never held in memory beside it.
    const inFlight = pending.get(folder) ?? new Map();
    if (inFlight.has(name)) return { status: 409, message: `${name} is being uploaded already` };
    const sizes = (await store.get(sizesKey(folder))) ?? {};
    let used = 0;
    for (const [other, bytes] of Object.entries(sizes)) if (other !== name) used += bytes;
    for (const bytes of inFlight.values()) used += bytes;
    const room = Math.min(MAX_SHOT, MAX_SHOTS - used);
    const tooBig = { status: 413, message: `over ${MAX_SHOT} bytes, or the run's ${MAX_SHOTS}` };
    const declared = Number(req.headers["content-length"]);
    if (declared > room || room <= 0) return tooBig;
    const reserved = Number.isSafeInteger(declared) ? declared : room;
    inFlight.set(name, reserved);
    pending.set(folder, inFlight);
    try {
      const body = await readCapped(req, reserved);
      if (body === null) return tooBig;
      if (!isImage(name, body)) {
        return { status: 415, message: `not a ${SHOT_NAME.exec(name)[1].toUpperCase()} file` };
      }
      await store.putBlob(shotKey(folder, name), body);
      for (;;) {
        const before = await store.get(sizesKey(folder));
        const after = { ...before, [name]: body.length };
        if (await store.compareAndSet(sizesKey(folder), before, after, { ttlMs })) break;
      }
      await runs.event("shot", record.id, { folder, name, size: body.length });
    } finally {
      inFlight.delete(name);
      if (!inFlight.size) pending.delete(folder);
    }
    return { status: 204 };
  }

  const shotOk = (folder, name) => SHOT_FOLDER.test(folder) && SHOT_NAME.test(name);
  const getShot = (folder, name) =>
    shotOk(folder, name) ? store.readBlob(shotKey(folder, name)) : null;
  const deleteShot = (folder, name) =>
    shotOk(folder, name) ? store.deleteBlob(shotKey(folder, name)) : false;

  // A run's inbox and files, once it ended. Its screenshots wait for the orchestrator.
  async function remove(id) {
    await store.deleteBlob(inboxKey(id));
    await store.delete(takenKey(id));
    for (const name of FILES) await store.deleteBlob(fileKey(id, name));
  }

  return { appendInbox, pollInbox, putFile, getFile, putShot, getShot, deleteShot, remove };
}
