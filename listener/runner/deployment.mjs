// Which deployment a prefix is (#858). What the runner makes is labelled `deckhand.owner:
// <prefix>`, and every check before it lists, follows or removes something goes by that label:
// two deployments on one engine (or one namespace) with the same NAME_PREFIX would pass each
// other's. So each deployment has an ID of its own, kept in the runner's store, and claims its
// prefix with a marker that holds it (a volume on Docker, a Secret on Kubernetes), made once and
// never changed: a runner whose ID isn't the marker's takes no call.
import { randomBytes } from "node:crypto";

// The marker's label holding the ID, and its deckhand.role.
export const DEPLOYMENT = "deckhand.deployment";
export const MARKER_ROLE = "deployment";

const KEY = "deployment";

// The marker's name, on either backend (kubeName() leaves it as it is when it can).
export const markerName = (prefix) => `${prefix}-deployment`;

// This deployment's ID: made by the first copy that asks, the same for every copy after it.
export async function deploymentId(store) {
  await store.setIfAbsent(KEY, randomBytes(8).toString("hex"));
  return store.get(KEY);
}

// The prefix is another deployment's, or the marker isn't Deckhand's: `where` is what they
// share (this engine, the namespace…), `what` names the marker and `remove` says how to remove it.
export class PrefixClash extends Error {}
export function prefixClash(prefix, { where, what, remove }) {
  return new PrefixClash(
    `NAME_PREFIX ${prefix} is another deployment's on ${where}: ${what} doesn't hold this deployment's ID. Give this deployment a NAME_PREFIX of its own; or, when no other deployment uses ${prefix} (this runner's store was made anew), ${remove}, and the runner claims it again`,
  );
}
