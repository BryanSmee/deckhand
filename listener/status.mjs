// What the listener is busy with, for /status (http.mjs): running runs, reaction updates still
// on their way to GitHub, preview hooks; `idle` when none is. Reactions are tracked here
// (track()) as runs end and queued comments are dropped.
import { parseKey } from "./events.mjs";

// Which Deckhand runs and since when, for api/state and /status. DECKHAND_VERSION: the release
// (a git tag), edge-<short sha> for a push to main, "dev" from source. DECKHAND_SOURCE: the
// repository the image was built from, where the dashboard links the version ("" without
// one: a fork's images link to the fork). `now`: injected by the tests.
export function serverInfo(env, now = Date.now) {
  return {
    version: env.DECKHAND_VERSION || "dev",
    startedAt: now(),
    node: process.version,
    source: (env.DECKHAND_SOURCE || "").replace(/\/+$/, ""),
  };
}

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createStatus(ctx) {
  const { tasks } = ctx;

  // Reaction updates still on their way to GitHub once a run is over (see cleanUp()).
  const inflight = new Set();

  function track(promise) {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  }

  // Queued comments don't count: they are saved (saveQueue()), running sandboxes go on without
  // the listener (restoreRuns()), and brainstorms between replies are restored from
  // brainstorms.json and their volume. Nothing needs to drain before a restart. `sees(repo)`:
  // which repos' runs, hooks and queues are listed (a signed-in user's, http.mjs); `idle` is
  // the whole listener's either way.
  function status(sees = () => true) {
    const active = ctx.runs.filter((r) => r.status === "running");
    const previews = ctx.previews.status();
    const reasons = (shown) => [
      ...active
        .filter((r) => shown(r.repo ?? parseKey(r.key)?.repo))
        .map((r) => `${r.kind} run ${r.key} since ${new Date(r.startedAt).toISOString()}`),
      ...(inflight.size ? [`${inflight.size} reaction update(s) in flight`] : []),
      // A preview hook may be deploying: a restart waits for it too.
      ...previews
        .filter((h) => shown(h.repo))
        .map(
          (h) =>
            `preview hook ${h.repo} (${h.event}) ${h.state} since ${new Date(h.since).toISOString()}`,
        ),
    ];
    return {
      version: ctx.server.version,
      startedAt: ctx.server.startedAt,
      idle: ctx.running === 0 && !reasons(() => true).length,
      previews: previews.filter((h) => sees(h.repo)),
      reasons: reasons(sees),
      setUp: ctx.app !== null,
      queued: [...tasks.values()]
        .filter((t) => sees(t.repo))
        .reduce((n, t) => n + t.pending.length, 0),
      now: Date.now(),
    };
  }

  return { track, status };
}
