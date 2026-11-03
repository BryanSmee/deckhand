// What the listener is busy with, for /status (http.mjs): running runs, reaction updates still
// on their way to GitHub; `idle` when none is. Reactions are tracked here
// (track()) as runs end and queued comments are dropped.
import { entryOf } from "./agents/index.mjs";
import { AUTHS } from "./agents/credentials.mjs";
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
// container engine of runs granted `docker` (SANDBOX_ENGINE as set, "auto" unresolved),
// the egress proxy and how many hosts the grants folder grants in all, whether that folder
// reads without errors, which Claude credentials are set and which one runs use first
// (claudeSetup()), and who may sign in on which repos. Nothing secret: every signed-in
// user gets it, so the grants' errors are named by file only. `load`: the
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
    grants: grantsHealth(errors),
    claude: claudeSetup(config),
    allowedUsers: config.users,
    allowedRepos: config.repos,
  };
}

// The Claude credentials an entry can name that are set (config.credentials: "plan", "key"),
// the one runs take unless they name one (AUTHS: "gateway" too, or null), and those FALLBACKS
// names (`claude@anthropic:key` → "key"), in its order. Their names only, never their values.
function claudeSetup(config) {
  const fallbacks = (config.fallbacks ?? [])
    .map(entryOf)
    .filter((e) => e?.agent === "claude" && e.provider === "anthropic" && e.credential)
    .map((e) => e.credential);
  return {
    set: config.credentials?.["claude@anthropic"]?.set ?? [],
    default: AUTHS[config.claudeCredential] ?? null,
    fallbacks,
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
// folder), null when there are several or none is named. Their messages stay out: they quote
// the files' values (mount roots on the host, YAML lines), and every signed-in user gets this,
// whichever repos they see. A repo's config panel shows its own (repos.mjs grantsErrorView()),
// the orchestrator's logs all of them.
function grantsHealth(errors) {
  if (!errors.length) return { ok: true, file: null, message: null };
  // "": the folder itself (grants.mjs walkGrants()), not a file to name.
  const named = [...new Set(errors.map((e) => (e instanceof GrantsError && e.file) || null))];
  const files = named.filter(Boolean);
  const unnamed = named.length > files.length;
  const what = [
    ...(files.length ? [`${files.join(", ")} ${files.length === 1 ? "has" : "have"} errors`] : []),
    ...(unnamed ? ["the grants folder has errors"] : []),
  ];
  return {
    ok: false,
    file: files.length === 1 && !unnamed ? files[0] : null,
    message: `${what.join("; ")} (a repository's config panel says what)`,
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

  // Queued comments don't count: they are saved as they come (saveQueue()), running sandboxes go on without
  // the listener (restoreRuns()), and brainstorms between replies are restored from
  // the store's `brainstorms` and their volume. Nothing needs to drain before a restart. `sees(repo)`:
  // which repos' runs and queues are listed (a signed-in user's, http.mjs); `idle` is
  // the whole listener's either way.
  function status(sees = () => true) {
    const active = ctx.runs.filter((r) => r.status === "running");
    const reasons = (shown) => [
      ...active
        .filter((r) => shown(r.repo ?? parseKey(r.key)?.repo))
        .map((r) => `${r.kind} run ${r.key} since ${new Date(r.startedAt).toISOString()}`),
      ...(inflight.size ? [`${inflight.size} reaction update(s) in flight`] : []),
    ];
    return {
      version: ctx.server.version,
      startedAt: ctx.server.startedAt,
      idle: ctx.running === 0 && !reasons(() => true).length,
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
