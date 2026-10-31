// The listener's calls to the broker service (../broker/, #505), which alone holds the tokens'
// signing key: the runs' first tokens and their end (broker.mjs `issuer`), the public keys the
// listener checks tokens with, each run's inbox and files (runner/inbox.mjs `mirror`), the
// sandboxes' calls that reach the listener rather than the broker (relay()), and the broker's
// `runs` stream, read and acknowledged (consume()). It calls as the orchestrator, the runner
// included, until both move out of the listener (#503, #506).
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../lib/files.mjs";
import { SHOT_FOLDER, SHOT_NAME } from "../lib/shots.mjs";
import { keyId, LEGACY_KEY_MS } from "../lib/tokens.mjs";

// The headers the broker reads a sandbox's call by (../broker/http.mjs): the network (or pod)
// it came from, as the listener vouches for it here, and its run token.
export const SANDBOX_HEADER = "x-deckhand-sandbox";
export const RUN_TOKEN_HEADER = "x-deckhand-run-token";

// How often the public keys are read again (a key rotated), and how soon after a failure.
const KEYS_EVERY_MS = 5 * 60_000;
const RETRY_MS = 5_000;

const enc = encodeURIComponent;

// The key the listener signed run tokens with before the broker service (`run-token.key` in its
// data volume, #493): its public part only, kept as `run-token.pub` for as long as one of its
// tokens may still be presented (LEGACY_KEY_MS), the private one removed, so that the signing
// key is in the broker's containers alone. → its PEM, or null.
export function legacyKey(dataDir, { now = Date.now, log = () => {} } = {}) {
  const keyPath = join(dataDir, "run-token.key");
  const pubPath = join(dataDir, "run-token.pub");
  let pem = null;
  try {
    pem = readFileSync(keyPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (pem) {
    const publicKey = createPublicKey(createPrivateKey(pem));
    const saved = readJson(pubPath, null);
    writeJsonAtomic(pubPath, {
      pem: publicKey.export({ type: "spki", format: "pem" }),
      at: saved?.at ?? now(),
    });
    rmSync(keyPath, { force: true });
    log(
      `Broker: run-token.key removed, its public key kept in run-token.pub for the running sandboxes' tokens: the broker service signs them now`,
    );
  }
  const saved = readJson(pubPath, null);
  if (!saved?.pem) return null;
  if (now() - saved.at > LEGACY_KEY_MS) {
    rmSync(pubPath, { force: true });
    return null;
  }
  return saved.pem;
}

// `caller`: lib/broker-client.mjs createBrokerCaller()'s. `legacy`: legacyKey()'s PEM, or null.
export function createBrokerService({
  caller,
  legacy = null,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  // kid → public key: the broker's run keys, and the legacy one from the start.
  let keys = new Map();
  const legacyKeys = new Map();
  if (legacy) {
    const publicKey = createPublicKey(legacy);
    legacyKeys.set(keyId(publicKey), publicKey);
  }
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

  async function refreshKeys() {
    try {
      await readKeys();
      later(refreshKeys, KEYS_EVERY_MS);
    } catch (error) {
      log(`Broker: its keys (${error.message}), asking again`);
      later(refreshKeys, RETRY_MS);
    }
  }

  // The legacy key handed to the broker, for the renewals of the tokens it signed: asked again
  // until it is taken.
  async function importLegacy() {
    if (!legacy) return;
    try {
      await ok(await caller.call("POST", "/keys", { body: { pem: legacy } }), "the old key");
    } catch (error) {
      log(`Broker: handing over the listener's old key (${error.message}), trying again`);
      later(importLegacy, RETRY_MS);
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
  // ended there too. `known`: the ids of the runs going.
  async function reconcile(known) {
    const res = await ok(await caller.call("GET", "/runs"), "its runs");
    const ids = new Set(known);
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
    const state = inboxes.get(run) ?? { synced: 0, chain: Promise.resolve() };
    inboxes.set(run, state);
    const step = async () => {
      if (inboxes.get(run) !== state) return;
      const data = bytesFrom(state.synced);
      if (data === null) return;
      const res = await caller.call("POST", `/runs/${enc(run)}/inbox?offset=${state.synced}`, {
        body: data,
      });
      // The broker has less (a store lost, another broker): from what it has.
      if (res.status === 409) {
        state.synced = res.json().length;
        return step();
      }
      await ok(res, "the run's inbox");
      state.synced = res.json().length;
    };
    const done = state.chain.then(step);
    state.chain = done.catch((error) => {
      log(`Broker: run ${run}'s inbox (${error.message}), trying again`);
      later(() => sync(run, bytesFrom), RETRY_MS);
    });
    return done;
  }

  const forget = (run) => inboxes.delete(run);

  // --- Sandboxes that reach the listener rather than the broker ---------------------------

  // A sandbox's call about its own run (`/run/…`), on to the broker with the network (or pod)
  // `sandbox` the listener found it came from, as the proxy would: a proxy from before the
  // broker service sends them here, and so do sandboxes from before #511, directly. `token`:
  // the run token it sent.
  async function relay(req, res, { sandbox, token }) {
    const kept = ["content-type", "content-length", "transfer-encoding"];
    const answer = await caller.call(req.method, req.url, {
      // As it comes: an upload is counted against the run's cap while it does.
      body: req,
      headers: {
        ...Object.fromEntries(kept.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])),
        [SANDBOX_HEADER]: sandbox ?? "",
        [RUN_TOKEN_HEADER]: token,
      },
      // An inbox's long poll waits 25 s.
      timeout: 60_000,
    });
    const { "content-type": type, "cache-control": cache } = answer.headers;
    res.writeHead(answer.status, {
      ...(type && { "content-type": type }),
      ...(cache && { "cache-control": cache }),
    });
    res.end(answer.body);
  }

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

  const sleep = (ms) => new Promise((resolve) => later(resolve, ms));

  // `fn()` until it resolves, again a little later each time it fails (`what` in the log):
  // what a restarted listener tells the broker of the runs it picked up.
  function persist(what, fn) {
    return fn().catch((error) => {
      if (stopped) return;
      log(`Broker: ${what} (${error.message}), trying again`);
      return sleep(RETRY_MS).then(() => persist(what, fn));
    });
  }

  return {
    issuer,
    keys: () => new Map([...legacyKeys, ...keys]),
    async start() {
      caller.start();
      await refreshKeys();
      await importLegacy();
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimer(timer);
      timers.clear();
      caller.stop();
    },
    reconcile,
    persist,
    mirror: { files, sync, forget },
    relay,
    consume,
    readKeys,
  };
}
