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
//                                            epoch the other services check); the holder asking
//                                            again gets its own back, renewed
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
//   ack(stream, consumer, ids)               how many were acknowledged
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
// several nodes, every service using it could read them otherwise.
import { fileStore } from "./store-file.mjs";

// The store a service's STORE_URL names: `file:///data/store` (a folder, one node), `memory:`
// (nothing kept, the tests'). `now`: the clock, in the tests.
export function openStore(url, { now } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol === "memory:") return fileStore({ now });
  if (parsed.protocol === "file:") return fileStore({ dir: parsed.pathname, now });
  throw new Error(`STORE_URL: ${parsed.protocol} isn't a store (file: or memory:)`);
}
