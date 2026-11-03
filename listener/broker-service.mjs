// The orchestrator's calls to the broker service (../broker/, #505), which alone holds the tokens'
// signing key: the runs' first tokens and their end (broker.mjs `issuer`), the public keys the
// listener checks tokens with, each run's inbox and files (runner/inbox.mjs `mirror`), the
// broker's `runs` stream, read and acknowledged (consume()), and the runs' screenshots, which the
// broker keeps (#609): removed with their run, and moved there from an older release's folder. The orchestrator's (#506), with its fencing
// epoch; edge and the github service take its keys from it too.
import { createPublicKey } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { MAX_SHOT, SHOT_FOLDER, SHOT_NAME } from "../lib/shots.mjs";
import { EPOCH_HEADER } from "../lib/service-client.mjs";

// How often the public keys are read again (a key rotated), and how soon after a failure.
const KEYS_EVERY_MS = 5 * 60_000;
const RETRY_MS = 5_000;
const KEYS_AGAIN_MS = 30_000;

// The most of a run's inbox one append sends: under the broker's limit (INBOX_MAX, 8 MiB).
export const INBOX_CHUNK = 1024 * 1024;

const enc = encodeURIComponent;

// A regular file's bytes, or null for anything else (a link, a FIFO, a file linked twice, gone,
// over `max` bytes). O_NONBLOCK: a FIFO would otherwise block the open until something writes it.
function regularFile(path, max) {
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    return stat.isFile() && stat.nlink === 1 && stat.size <= max ? readFileSync(fd) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// `caller`: lib/broker-client.mjs createBrokerCaller()'s.
// `epoch()`: the orchestrator's fencing epoch, on each of its calls but a GET (#506); null for
// a service that has none (edge, the github service: they only read the keys).
export function createBrokerService({
  caller: unfenced,
  epoch = () => null,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const caller = {
    ...unfenced,
    call(method, path, options = {}) {
      const fenced = method === "GET" ? null : epoch();
      if (fenced == null) return unfenced.call(method, path, options);
      return unfenced.call(method, path, {
        ...options,
        headers: { ...options.headers, [EPOCH_HEADER]: String(fenced) },
      });
    },
  };
  // kid → public key: the broker's keys.
  let keys = new Map();
  let stopped = false;
  const timers = new Set();
  function later(fn, ms) {
    if (stopped) return;
    const timer = setTimer(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  }

  async function ok(res, what) {
    if (res.status >= 200 && res.status < 300) return res;
    let message = res.body.toString("utf8");
    try {
      message = res.json()?.message ?? message;
    } catch {
      // Not JSON: as it is.
    }
    const error = new Error(`the broker service refused ${what}: ${res.status} ${message}`);
    error.status = res.status;
    throw error;
  }

  async function readKeys() {
    const res = await ok(await caller.request("GET", "/keys"), "its keys");
    const { run } = res.json();
    keys = new Map(run.map(({ kid, pem }) => [kid, createPublicKey(pem)]));
  }

  // The keys read again when a token names one this listener doesn't know (the broker's key
  // changed): at most every KEYS_AGAIN_MS, so a forged kid can't make it ask in a loop.
  let askedAt = -Infinity;
  let asking = null;
  function unknownKey() {
    if (asking) return asking;
    if (Date.now() - askedAt < KEYS_AGAIN_MS) return Promise.resolve();
    askedAt = Date.now();
    asking = readKeys()
      .catch((error) => log(`Broker: its keys (${error.message})`))
      .finally(() => (asking = null));
    return asking;
  }

  async function refreshKeys() {
    try {
      await readKeys();
      later(refreshKeys, KEYS_EVERY_MS);
    } catch (error) {
      log(`Broker: its keys (${error.message}), asking again`);
      later(refreshKeys, RETRY_MS);
    }
  }

  // Runs whose end the broker hasn't heard yet: told again until it has.
  const ending = new Set();
  async function end(id) {
    ending.add(id);
    try {
      await ok(await caller.call("DELETE", `/runs/${enc(id)}`), `the end of ${id}`);
      ending.delete(id);
    } catch (error) {
      log(`Broker: run ${id} ended, not heard yet (${error.message}), telling it again`);
      later(() => ending.has(id) && end(id).catch(() => {}), RETRY_MS);
    }
  }

  const issuer = {
    async issue(id, fields) {
      const res = await ok(
        await caller.call("POST", `/runs/${enc(id)}/tokens`, { body: fields }),
        "the run's tokens",
      );
      return res.json();
    },
    async put(id, fields) {
      await ok(await caller.call("PUT", `/runs/${enc(id)}`, { body: fields }), `run ${id}`);
    },
    end,
  };

  // The runs the broker has that the listener doesn't (it ended while the listener was down):
  // ended there too. `known()`: the ids of the runs going, asked once the broker answered, so a
  // run that got its tokens meanwhile is among them.
  async function reconcile(known) {
    const res = await ok(await caller.call("GET", "/runs"), "its runs");
    const ids = new Set(known());
    for (const id of res.json().runs) if (!ids.has(id)) await end(id);
  }

  // --- The runs' inboxes and files (runner/inbox.mjs `mirror`) ---------------------------

  // run → { synced: bytes the broker has, chain, retry }
  const inboxes = new Map();

  // The proxy's CA and the digest, before the sandbox starts: it fetches them first thing.
  async function files(run, found) {
    for (const [name, data] of Object.entries(found)) {
      if (data == null) continue;
      await ok(
        await caller.call("PUT", `/runs/${enc(run)}/files/${name}`, { body: Buffer.from(data) }),
        `the run's ${name}`,
      );
    }
  }

  // What the runner's inbox file has past what the broker has: appended there, in order, from
  // the same offset (`bytesFrom(offset)` → its bytes from there, null once it is gone). A
  // failure is tried again a little later, and a later change catches up with it all.
  // → resolves once the broker has it, or rejects when it refused it.
  function sync(run, bytesFrom) {
    const state = inboxes.get(run) ?? { synced: 0, known: false, chain: Promise.resolve() };
    inboxes.set(run, state);
    const post = (offset, body) =>
      caller.call("POST", `/runs/${enc(run)}/inbox?offset=${offset}`, { body });
    const step = async () => {
      if (inboxes.get(run) !== state) return;
      const all = bytesFrom(0);
      if (all === null) return;
      // A restarted listener first asks what the broker has (nothing sent past its end: a
      // 409 with its length), rather than send the whole file again.
      if (!state.known) {
        const res = await post(all.length, Buffer.alloc(0));
        if (res.status !== 409) await ok(res, "the run's inbox");
        state.synced = res.json().length;
        state.known = true;
      }
      // Then what it lacks, in parts under the broker's limit, each ending on a line.
      while (state.synced < all.length) {
        const data = all.subarray(state.synced, state.synced + INBOX_CHUNK);
        const cut = state.synced + data.length < all.length ? data.lastIndexOf(10) + 1 : 0;
        const res = await post(state.synced, cut > 0 ? data.subarray(0, cut) : data);
        // The broker has less (a store lost, another broker): from what it has.
        if (res.status !== 409) await ok(res, "the run's inbox");
        state.synced = res.json().length;
      }
    };
    const done = state.chain.then(step);
    state.chain = done.catch((error) => {
      log(`Broker: run ${run}'s inbox (${error.message}), trying again`);
      // Unless the run ended meanwhile (forget()).
      later(() => inboxes.get(run) === state && sync(run, bytesFrom).catch(() => {}), RETRY_MS);
    });
    return done;
  }

  const forget = (run) => inboxes.delete(run);

  // --- The broker's stream ---------------------------------------------------------------

  // The `runs` stream, read and acknowledged event by event: started, renewed, ended, shot (the
  // broker keeps the screenshot, #609). `handlers`: type → (event) → a promise, done once it is
  // handled. An event whose handling fails is read again (not acknowledged).
  let consuming = null;
  function consume({ handlers = {} } = {}) {
    const handle = handlers;
    consuming ??= (async () => {
      while (!stopped) {
        try {
          const res = await ok(
            await caller.call("GET", "/events?wait=20000", { timeout: 40_000 }),
            "its events",
          );
          const done = [];
          for (const { id, event } of res.json().events) {
            try {
              await handle[event?.type]?.(event);
              done.push(id);
            } catch (error) {
              log(
                `Broker: its ${event?.type} event for ${event?.run} (${error.message}), read again`,
              );
            }
          }
          if (done.length)
            await ok(await caller.call("POST", "/events/ack", { body: { ids: done } }), "an ack");
          if (done.length < res.json().events.length) await sleep(RETRY_MS);
        } catch (error) {
          if (stopped) break;
          log(`Broker: its events (${error.message}), asking again`);
          await sleep(RETRY_MS);
        }
      }
    })();
    return consuming;
  }

  // --- The screenshots (#609) ----------------------------------------------------------

  // A run's screenshots, as retention removes it (history.mjs).
  async function removeShots(folder) {
    await ok(await caller.call("DELETE", `/shots/${enc(folder)}`), `the screenshots of ${folder}`);
  }

  // The screenshots an orchestrator kept itself before the broker did (`shotsDir`, its shots/
  // folder): each folder's sent to the broker, file by file, then removed. A file the broker
  // refuses (not an image, too big) goes with its folder; a failure of the broker's throws, the folder
  // kept, for persist() to try again. Only regular files, opened without following a link: the
  // sandboxes of older releases wrote these folders (a link there could name any file of the
  // orchestrator's). `drop(folder, mtimeMs)`: a folder removed without sending it (one retention
  // would have removed). → how many folders were moved.
  async function moveShots(shotsDir, { drop = () => false } = {}) {
    let folders;
    try {
      folders = readdirSync(shotsDir).filter((folder) => SHOT_FOLDER.test(folder));
    } catch {
      return 0;
    }
    if (!folders.length) return 0;
    log(`Screenshots: ${folders.length} folder(s) kept here, sent to the broker`);
    let moved = 0;
    for (const folder of folders) {
      const dir = join(shotsDir, folder);
      let names = [];
      try {
        const found = lstatSync(dir);
        if (found.isDirectory() && !drop(folder, found.mtimeMs)) {
          names = readdirSync(dir).filter((n) => SHOT_NAME.test(n));
        }
      } catch {
        // Gone meanwhile.
      }
      for (const name of names) {
        const data = regularFile(join(dir, name), MAX_SHOT);
        if (data === null) continue;
        const res = await caller.call("PUT", `/shots/${folder}/${enc(name)}`, { body: data });
        // Only what the broker says of the file itself: a broker of the release before, which
        // has no such route (403, 404), keeps the folder here.
        if ([400, 413, 415].includes(res.status)) {
          log(`Screenshots: ${folder}/${name} refused by the broker (${res.status}), dropped`);
        } else await ok(res, `screenshot ${folder}/${name}`);
      }
      if (names.length) moved++;
      rmSync(dir, { recursive: true, force: true });
    }
    log(`Screenshots: ${moved} folder(s) moved to the broker, the rest removed`);
    return moved;
  }

  // A pause, cut short by stop(): what waits on one then sees `stopped` and ends.
  const sleeping = new Set();
  const sleep = (ms) =>
    new Promise((resolve) => {
      if (stopped) return resolve();
      sleeping.add(resolve);
      later(() => (sleeping.delete(resolve), resolve()), ms);
    });

  // `fn()` until it resolves, again a little later each time it fails (`what` in the log):
  // what a restarted listener tells the broker of the runs it picked up.
  function persist(what, fn) {
    return fn().catch((error) => {
      if (stopped) return;
      log(`Broker: ${what} (${error.message}), trying again`);
      return sleep(RETRY_MS).then(() => !stopped && persist(what, fn));
    });
  }

  return {
    issuer,
    keys: () => keys,
    // The same, for the service tokens it signs (services-http.mjs).
    serviceKeys: () => keys,
    unknownKey,
    async start() {
      caller.start();
      await refreshKeys();
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimer(timer);
      timers.clear();
      for (const resolve of sleeping) resolve();
      sleeping.clear();
      caller.stop();
    },
    reconcile,
    persist,
    mirror: { files, sync, forget },
    consume,
    removeShots,
    moveShots,
    readKeys,
  };
}
