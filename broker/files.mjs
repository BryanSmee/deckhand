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
//   - its screenshots (PUT /run/shots/<file>), written once into blob storage (#609,
//     ../lib/blobs.mjs: the store's own blobs without BLOB_URL), served from there (GET
//     /shots/<folder>/<file>, which edge passes on), and each one said on the `runs` stream. A
//     folder's names and sizes stay in the store (shotsKey()): the run's cap, and what retention
//     deletes once the orchestrator asks (DELETE /shots/<folder>), as blob storage lists nothing.
import { storeBlobs } from "../lib/blobs.mjs";
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
const fileKey = (id, name) => `file:${id}:${name}`;
// A screenshot in blob storage; where the release before kept it in the store, until the
// orchestrator copied it away (one uploaded during the update may still be there).
const shotKey = (folder, name) => `shots/${folder}/${name}`;
const legacyShotKey = (folder, name) => `shot:${folder}/${name}`;
// A folder's names → sizes: kept as long as its screenshots are.
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

// `store`: lib/store.mjs's; `blobs`: lib/blobs.mjs's, for the screenshots (the store's own
// blobs by default); `runs`: runs.mjs's, for the screenshots' events.
export function createFiles({
  store,
  blobs = storeBlobs(store),
  runs,
  now = Date.now,
  sleep = realSleep,
}) {
  // Folder → name → the bytes its upload in flight reserved: counted against MAX_SHOTS. This
  // copy's only: two uploads of one run through two copies at once may pass the cap by one
  // screenshot's size.
  const pending = new Map();

  // The runner's append (POST /runs/:id/inbox): `data`, its file's bytes from `offset`, in one
  // atomic step of the store (appendBlobAt()): the same bytes sent again (an answer lost, or a
  // retry through the other copy) add nothing, and a later one first is refused. → { length },
  // or { length, gap: true } when the blob is shorter than `offset` (the runner sends from
  // `length` again). The blob is the runner's file byte for byte: the runner redacts its lines
  // before it writes them (runner/inbox.mjs), and the store refuses what it would redact.
  const appendInbox = (id, offset, data) => store.appendBlobAt(inboxKey(id), offset, data);

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
      await keep(folder, name, body);
      await runs.event("shot", record.id, { folder, name, size: body.length });
    } finally {
      inFlight.delete(name);
      if (!inFlight.size) pending.delete(folder);
    }
    return { status: 204 };
  }

  // Its name in the folder's sizes first, then the file: a name whose file never came is
  // deleted all the same, a file the sizes don't name never would be.
  async function keep(folder, name, body) {
    for (;;) {
      const before = await store.get(sizesKey(folder));
      const after = { ...before, [name]: body.length };
      if (await store.compareAndSet(sizesKey(folder), before, after)) break;
    }
    await blobs.put(shotKey(folder, name), body);
  }

  const shotOk = (folder, name) => SHOT_FOLDER.test(folder) && SHOT_NAME.test(name);

  // A screenshot the orchestrator kept before the broker did (PUT /shots/<folder>/<file>, its
  // move at start): checked as an upload is, but the run's cap, which it passed then.
  // → { status, message? }.
  async function moveShot(req, folder, name) {
    if (!shotOk(folder, name)) return { status: 400, message: "not a screenshot's name" };
    const body = await readCapped(req, MAX_SHOT);
    if (body === null) return { status: 413, message: `over ${MAX_SHOT} bytes` };
    if (!isImage(name, body)) return { status: 415, message: "not an image" };
    await keep(folder, name, body);
    return { status: 204 };
  }

  async function getShot(folder, name) {
    if (!shotOk(folder, name)) return null;
    return (
      (await blobs.read(shotKey(folder, name))) ??
      (await store.readBlob(legacyShotKey(folder, name)))
    );
  }

  // A run's screenshots, once retention removes it (DELETE /shots/<folder>). → how many.
  async function removeShots(folder) {
    if (!SHOT_FOLDER.test(folder)) return 0;
    const names = Object.keys((await store.get(sizesKey(folder))) ?? {});
    for (const name of names) {
      await blobs.delete(shotKey(folder, name));
      await store.deleteBlob(legacyShotKey(folder, name));
    }
    await store.delete(sizesKey(folder));
    return names.length;
  }

  // A run's inbox and files, once it ended. Its screenshots stay, for the links to them.
  async function remove(id) {
    await store.deleteBlob(inboxKey(id));
    for (const name of FILES) await store.deleteBlob(fileKey(id, name));
  }

  return {
    appendInbox,
    pollInbox,
    putFile,
    getFile,
    putShot,
    moveShot,
    getShot,
    removeShots,
    remove,
  };
}
