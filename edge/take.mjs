// A delivery taken once (#506, #1032): whichever way it came, a webhook edge verified (http.mjs)
// or one it read through the App's API (pull.mjs). Its GUID is set-if-absent in edge's store,
// which both copies share, so one GitHub sends twice, that reaches both, or that came both ways,
// goes on once; then it goes on the `deliveries` stream the orchestrator reads (internal.mjs).
import { quietPayload } from "../listener/events.mjs";
import { QUIET_EVENTS } from "../listener/github-app.mjs";
import { storable } from "../lib/store.mjs";
import { logContext } from "../lib/log.mjs";
import { ciWaitingKey, DELIVERIES } from "./internal.mjs";

// The most deliveries the stream keeps unread (far more than a handover leaves); one the
// orchestrator acknowledged goes from it at once (internal.mjs).
const STREAM_MAX = 10_000;

// A delivery's GUID, as the store keeps it: { taking: at } while it goes on the stream, then
// { kept: at }, for a day. A redelivery of one taken (by hand, or GitHub's own) comes within that;
// the redeliveries' poller only asks for those GitHub never saw taken.
const deliveryKey = (id) => `deliveries/${id}`;
const DELIVERY_TTL_MS = 24 * 3600_000;
// How long a commit's mark (internal.mjs ciWaitingKey()) lasts, should its entry be lost.
const CI_WAITING_TTL_MS = 10 * 60_000;
// A delivery still being taken after this was lost on its way to the stream (a copy that died,
// a store that failed twice): taken again.
const TAKING_MS = 60_000;

// Whether edge took the delivery with this GUID (the redeliveries ask it, ../listener/
// redeliveries.mjs `handled`, and the pull mode's poller): kept, or being taken now.
export async function takenDelivery(store, id, now = Date.now) {
  const mark = await store.get(deliveryKey(id));
  return !!mark && (mark.kept != null || now() - (mark.taking ?? 0) < TAKING_MS);
}

// Marks it as being taken, once: false when another copy (or GitHub's second send) has it.
async function startTaking(store, id, now) {
  const key = deliveryKey(id);
  const mark = { taking: now() };
  if (await store.setIfAbsent(key, mark, { ttlMs: DELIVERY_TTL_MS })) return true;
  const found = await store.get(key);
  if (!found || found.kept != null || now() - (found.taking ?? 0) < TAKING_MS) return false;
  return store.compareAndSet(key, found, mark, { ttlMs: DELIVERY_TTL_MS });
}

// `redeliveries`: ../listener/redeliveries.mjs's (redelivered()); `secrets()`: kept out of the
// store. → take({ event, id, payload, redelivered }): resolves to what the metrics count it as
// (metrics.mjs WEBHOOK_RESULTS: accepted, duplicate, ignored), or throws when the store couldn't
// keep it (its GUID left free for the next try).
export function createTaker({ config, store, redeliveries, secrets, log = () => {}, now }) {
  return async function take({ event, id: guid, payload, redelivered = false }) {
    // A commit's CI changed (github-app.mjs QUIET_EVENTS): no log line, nor a place in the
    // store's delivery ids, so taken without its GUID.
    const quiet = QUIET_EVENTS.has(event);
    const id = (!quiet && guid) || null;
    let waiting = null;
    if (quiet) {
      // Only what the orchestrator reads of it, for an allowed repo, and one waiting per commit.
      payload = quietPayload(config, event, payload);
      if (!payload) return "ignored";
      const { full_name } = payload.repository;
      const sha = payload.sha ?? payload.check_suite.head_sha;
      waiting = ciWaitingKey(full_name, sha);
      if (!(await store.setIfAbsent(waiting, { at: now() }, { ttlMs: CI_WAITING_TTL_MS }))) {
        return "duplicate";
      }
    }
    // Deliveries without a GUID are taken.
    if (id && !(await startTaking(store, id, now))) {
      log(`Delivery ${id} again: already handled`);
      return "duplicate";
    }
    try {
      redelivered ||= id ? await redeliveries.redelivered(id) : false;
      // What people wrote may hold a token pasted by mistake: kept without it, as the queue is.
      // With its request's ID: the orchestrator's lines about it carry it too.
      const { request } = logContext();
      const entry = storable({ id, event, payload, redelivered, request, at: now() }, secrets());
      await store.append(DELIVERIES, entry, { maxLength: STREAM_MAX });
    } catch (error) {
      // Not taken after all: GitHub's redelivery, or the next scan's, is. A mark the store
      // couldn't remove either is taken again once a minute old.
      if (id) await store.delete(deliveryKey(id)).catch(() => false);
      if (waiting) await store.delete(waiting).catch(() => false);
      throw error;
    }
    // On the stream: taken, whatever this write does. Refused now, GitHub would send it again,
    // and its mark, left "taking", would let that second one through a minute on.
    if (id) {
      await store
        .set(deliveryKey(id), { kept: now() }, { ttlMs: DELIVERY_TTL_MS })
        .catch((error) =>
          log(`Delivery ${id}: its mark (${error.message ?? error}), kept as taking`),
        );
    }
    if (!quiet) log(`Passed on: ${event} ${payload?.action ?? ""} (${id ?? "no id"})`);
    return "accepted";
  };
}
