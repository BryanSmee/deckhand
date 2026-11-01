// The orchestrator's calls to the broker service (../broker/, #505), which alone holds the tokens'
// signing key: the runs' first tokens and their end (broker.mjs `issuer`), the public keys the
// listener checks tokens with, each run's inbox and files (runner/inbox.mjs `mirror`), and the
// broker's `runs` stream, read and acknowledged (consume()). The orchestrator's (#506), with its fencing
// epoch; edge and the github service take its keys from it too.
import { createPublicKey, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHOT_FOLDER, SHOT_NAME } from "../lib/shots.mjs";
import { EPOCH_HEADER } from "../lib/service-client.mjs";

// How often the public keys are read again (a key rotated), and how soon after a failure.
const KEYS_EVERY_MS = 5 * 60_000;
const RETRY_MS = 5_000;
const KEYS_AGAIN_MS = 30_000;

// The most of a run's inbox one append sends: under the broker's limit (INBOX_MAX, 8 MiB).
export const INBOX_CHUNK = 1024 * 1024;

const enc = encodeURIComponent;

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

  // The screenshot an event names, copied into the folder GET /shots/ serves, then deleted at
  // the broker. Written whole, then renamed into place: GET /shots never serves half of one.
  async function copyShot(shotsDir, { folder, name }) {
    if (!SHOT_FOLDER.test(folder ?? "") || !SHOT_NAME.test(name ?? "")) return;
    const path = `/shots/${enc(folder)}/${enc(name)}`;
    const res = await caller.call("GET", path);
    // Copied already (an event read again after its ack was lost).
    if (res.status === 404) return;
    await ok(res, `screenshot ${folder}/${name}`);
    const dir = join(shotsDir, folder);
    mkdirSync(dir, { recursive: true });
    const part = join(dir, `.${randomBytes(6).toString("hex")}.part`);
    try {
      writeFileSync(part, res.body, { mode: 0o644 });
      renameSync(part, join(dir, name));
    } finally {
      rmSync(part, { force: true });
    }
    await ok(await caller.call("DELETE", path), `screenshot ${folder}/${name}`);
  }

  // The `runs` stream, read and acknowledged event by event: started, renewed, ended, shot.
  // `handlers`: type → (event) → a promise, done once it is handled; `shotsDir`: where the
  // screenshots go. An event whose handling fails is read again (not acknowledged).
  let consuming = null;
  function consume({ shotsDir, handlers = {} }) {
    const handle = {
      ...handlers,
      shot: async (event) => {
        await copyShot(shotsDir, event);
        await handlers.shot?.(event);
      },
    };
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
    readKeys,
  };
}
