// What the listener is busy with, for /status (http.mjs): running runs, reaction updates still
// on their way to GitHub, preview hooks; `idle` when none is. Reactions are tracked here
// (track()) as runs end and queued comments are dropped.
import { parseKey } from "./events.mjs";
import { GrantsError, grantErrors, loadGrants } from "./grants.mjs";

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

// How this Deckhand is set up, for the dashboard's Settings › Server (GET api/server): the
// container engine of runs granted allow_docker (SANDBOX_ENGINE as set, "auto" unresolved),
// the egress proxy and how many hosts the grants folder grants in all, whether that folder
// reads without errors, and who may sign in on which repos. Nothing secret: every signed-in
// user gets it, and the grants folder's own path is left out of its errors. `load`: the
// grants folder (loadGrants(), read at each call so an edit shows without a restart).
export function serverSetup(config, load = () => loadGrants(config)) {
  let grants = null;
  let errors;
  try {
    grants = load();
    errors = grantErrors(grants);
  } catch (error) {
    errors = [error];
  }
  // The runs' only way out (config.mjs egressProxy): there is no setting to turn it off.
  const proxy = { on: true, hosts: grants ? grantedHosts(grants).size : null };
  return {
    engine: config.engine,
    proxy,
    grants: grantsHealth(config, errors),
    allowedUsers: config.users,
    allowedRepos: config.repos,
  };
}

// Every host default.yaml and the repos' files grant, once each; a file with errors grants
// none (no run of its repo starts).
function grantedHosts(grants) {
  const hosts = new Set(grants.defaults?.hosts ?? []);
  for (const { load } of grants.repos.values()) {
    try {
      for (const host of load().hosts) hosts.add(host);
    } catch {
      // Counted in grantsHealth().
    }
  }
  return hosts;
}

// The grants folder's errors → { ok, file, message }: `file` the one to edit (relative to the
// folder), null when there are several or none is named.
function grantsHealth(config, errors) {
  if (!errors.length) return { ok: true, file: null, message: null };
  const files = new Set(errors.map((e) => e.file ?? null));
  const message = errors
    .map((e) => (e instanceof GrantsError ? e.message : "grants: can't be read"))
    .join("; ")
    .replaceAll(` ${config.grantsDir}`, "");
  return { ok: false, file: files.size === 1 ? [...files][0] : null, message };
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
