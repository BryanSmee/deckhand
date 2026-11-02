// GET /health, the same answer from every service (#560): { ok, startedAt, version }, and the
// few fields a service already sent beside them (the github service's `app`, the runner's
// `active`). Unauthenticated, for the probes and the orchestrator's status page
// (../listener/health.mjs): a start time and a version say nothing, and it must not grow more.

// What a service answers with, taken as it starts. DECKHAND_VERSION: the release its image
// was built from ("dev" from source), as the listener's own (../listener/status.mjs).
export function healthInfo(env = process.env, now = Date.now) {
  return { startedAt: now(), version: env.DECKHAND_VERSION || "dev" };
}

// The answer's body: `extra`, the service's own fields, never anything else.
export const healthAnswer = ({ startedAt, version }, extra = {}) => ({
  ok: true,
  startedAt,
  version,
  ...extra,
});
