// The orchestrator's fencing epoch, as the services it calls check it (#506, docs/services.md):
// each call that changes something carries it (lib/service-client.mjs EPOCH_HEADER), and one
// older than the newest seen is refused (409), so a copy that lost its lease can't act. The
// newest is in the service's store, so that both of its copies refuse the same.
import { Refused } from "./http.mjs";
import { EPOCH_HEADER } from "./service-client.mjs";

export const EPOCH_KEY = "epoch/orchestrator";
// How far ahead of the service's clock an epoch may be: they are the orchestrator's clock until
// #506 (lib/store.mjs nextEpoch()), so one further ahead is no clock's, and kept, it would refuse
// every listener after it until its key were removed from the store by hand.
export const EPOCH_AHEAD_MS = 24 * 3600_000;

// → (req) → resolves once the request's epoch is the newest (kept, compared-and-set so that two
// calls racing keep the higher), else throws a Refused: 400 without one, 409 for a stale one.
// `service`: its name, for the messages.
export function createFence({ store, service, now = Date.now }) {
  return async function fence(req) {
    const epoch = Number(req.headers[EPOCH_HEADER]);
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Refused(400, "no fencing epoch");
    if (epoch > now() + EPOCH_AHEAD_MS) {
      throw new Refused(400, `epoch ${epoch}: further ahead of the ${service}'s clock than a day`);
    }
    for (;;) {
      const newest = (await store.get(EPOCH_KEY)) ?? 0;
      if (epoch < newest) {
        throw new Refused(409, `epoch ${epoch} is stale: ${newest} is the orchestrator's now`);
      }
      if (epoch === newest || (await store.compareAndSet(EPOCH_KEY, newest || null, epoch))) {
        return;
      }
    }
  };
}
