// The store every service keeps its state in (#499, docs/services.md, Rules): no shared
// database, each service its own keys, through this one interface, so that two copies of a
// service can share it and one taking over from the other loses nothing. Every method is async,
// so that a backend across the network (Redis, #509) has the same one:
//
//   get(key)                                 the value, or null (none, or expired)
//   set(key, value, { ttlMs })               any JSON value; `ttlMs`: it expires after that
//   delete(key)                              whether there was one
//   setIfAbsent(key, value, { ttlMs })       whether it was set: false when there is one
//   compareAndSet(key, expected, value, { ttlMs })
//                                            set only while the value is `expected` (the same
//                                            JSON; null: none), whether it was
//   increment(key, by = 1, { ttlMs })        the new number (from 0; `ttlMs` when created)
//
//   acquire(name, holder, { ttlMs })         a lease, { holder, epoch, expiresAt }, or null while
//                                            another holder's lasts. Each new holder gets a
//                                            higher epoch than every one before it (the fencing
//                                            epoch the other services check). It is at least
//                                            the time in ms: a store that lost its last writes
//                                            (a crash, a failover) doesn't hand one out twice.
//                                            The holder asking again gets its own back, renewed
//   renew(name, holder, epoch, { ttlMs })    the lease renewed, or null once it is lost (expired,
//                                            released, another epoch): acquire it again then
//   release(name, holder, epoch)             whether it was this holder's: the next one takes it
//                                            at once
//   lease(name)                              the live lease, or null
//
//   append(stream, event, { maxLength })     the event's id, increasing; `maxLength`: only the
//                                            last that many are kept
//   read(stream, consumer, { count })        [{ id, event }], the oldest first: what `consumer`
//                                            hasn't acknowledged. Read again until it is, so a
//                                            copy that stops before handling one loses nothing
//   ack(stream, consumer, ids)               how many were acknowledged: only events read count,
//                                            one not read yet stays to read
//
// A consumer is read by one reader at a time, and nothing hands an event to one reader rather
// than another: every read returns all it hasn't acknowledged. So a service whose copies take
// turns (the orchestrator, the runner: active/passive) reads under one name, by the copy holding
// its lease only, and the next holder takes up what was left; copies all active that each need
// every event (edge's dashboards) read under a name each. A backend with consumer groups
// (Redis's XREADGROUP, #509) keeps to this: one group and one reader per consumer, its pending
// events read first.
//
//   putBlob(key, data)                       a blob (a run's log, its files): a Buffer or text
//   appendBlob(key, data)                    added at its end (created when missing)
//   readBlob(key, { offset })                its bytes from `offset`, or null when there is none
//   deleteBlob(key)                          whether there was one
//
//   close()
//
// Secrets never go in it but encrypted, with a key only their service holds: with Redis on
// several nodes, every service using it could read them otherwise. The App's key, the signing
// key and the agents' credentials never go in it at all: openStore()'s `secrets`, those its
// service knows, are refused in the values and events it writes, as is any private key or
// GitHub token; in its blobs, they are redacted.
import { fileURLToPath } from "node:url";
import { redact, REDACTED } from "./redact.mjs";
import { fileStore } from "./store-file.mjs";
import { redisStore } from "./store-redis.mjs";

// The store a service's STORE_URL names: `file:///data/store` (a folder, one node),
// `redis://[user:password@]host:6379[/db]` or `rediss://` (TLS: several nodes, #509; `?prefix=`
// before its keys, `deckhand:` by default), `memory:` (nothing kept, the tests'). `password`:
// Redis's, when it isn't in the URL (REDIS_PASSWORD). `secrets`: a function returning the
// secrets the service knows. `now`: the clock, in the tests.
export function openStore(url, { now, password, secrets = () => [] } = {}) {
  const parsed = new URL(url);
  let store;
  if (parsed.protocol === "memory:") store = fileStore({ now });
  // A path's own characters (a space…), not their URL escapes.
  else if (parsed.protocol === "file:") store = fileStore({ dir: fileURLToPath(parsed), now });
  else if (parsed.protocol === "redis:" || parsed.protocol === "rediss:") {
    const prefix = parsed.searchParams.get("prefix") ?? undefined;
    store = redisStore({ url, password, prefix, now });
  } else {
    throw new Error(
      `STORE_URL: ${parsed.protocol} isn't a store (file:, redis:, rediss: or memory:)`,
    );
  }
  return withoutSecrets(store, secrets);
}

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
// The same, to its end (or the text's), for storable().
const PRIVATE_KEY_BLOCK = new RegExp(
  `${PRIVATE_KEY.source}[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`,
  "g",
);

// Whether withoutSecrets() refuses `data`, and why it would.
function refused(data, secrets) {
  const text = JSON.stringify(data) ?? "";
  return PRIVATE_KEY.test(text) || redact(text, secrets) !== text;
}

// `data` as withoutSecrets() takes it, from the same rules: each of its strings (keys too)
// without `secrets`, GitHub tokens or private keys. For a value holding text people wrote (a
// queued comment that pastes a token by mistake): saved without it, rather than refused whole.
// What only shows across two strings, once they are JSON, is redacted in the JSON itself.
export function storable(data, secrets = []) {
  const scrub = (value) => {
    if (typeof value === "string") {
      return redact(value, secrets).replace(PRIVATE_KEY_BLOCK, REDACTED);
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrub(v)]));
    }
    return value;
  };
  const clean = scrub(data);
  if (!refused(clean, secrets)) return clean;
  const text = redact(JSON.stringify(clean), secrets).replace(PRIVATE_KEY_BLOCK, REDACTED);
  return JSON.parse(text);
}

// `store`, refusing to write a value or an event holding one of `secrets()` (or a part of one
// long enough to count, as redact() finds them), a private key or a GitHub token: the write
// throws, nothing is written. A blob (a run's log, its files) is what a run printed or made,
// which may well hold a test fixture's private key: the secrets and GitHub tokens in it are
// redacted instead, and the rest is kept. Each write on its own: a writer appending a log in
// pieces appends whole lines (runs.mjs redacts a run's output line by line), so that a secret
// isn't split across two.
export function withoutSecrets(store, secrets) {
  const value = (what, data) => {
    if (refused(data, secrets())) throw new Error(`${what}: a secret can't go in the store`);
  };
  // Bytes as latin1: one character per byte, so a secret shows whatever the encoding around
  // it, and the bytes around it come back as they were.
  const blob = (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("latin1") : String(data);
    const clean = redact(text, secrets());
    if (clean === text) return data;
    return Buffer.isBuffer(data) ? Buffer.from(clean, "latin1") : clean;
  };
  const checked =
    (fn, check) =>
    async (...args) => {
      check(...args);
      return fn(...args);
    };
  return {
    ...store,
    set: checked(store.set, (key, data) => value(key, data)),
    setIfAbsent: checked(store.setIfAbsent, (key, data) => value(key, data)),
    compareAndSet: checked(store.compareAndSet, (key, expected, data) => value(key, data)),
    append: checked(store.append, (stream, event) => value(stream, event)),
    putBlob: async (key, data) => store.putBlob(key, blob(data)),
    appendBlob: async (key, data) => store.appendBlob(key, blob(data)),
  };
}
