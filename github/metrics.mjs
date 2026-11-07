// The github service's metrics (#656): the one service holding the App's key, so where GitHub's
// limits show. Its API calls by caller and status, how long they took, the rate limit GitHub's
// answers say is left, the git operations it makes or relays, the pushes it refuses, and the size
// of its git mirrors. Declared on the service's registry (../lib/metrics.mjs), served on
// METRICS_PORT.
//
// The caller is the one the service token named (service.mjs ROUTES), kept for the call's whole
// life (`as(caller, fn)`): what the service asks GitHub on a caller's behalf (an installation's
// lookup, a token) counts as that caller's. `github`: none, its own (the App's check at start).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { STATUS_LABELS, statusLabel } from "../lib/metrics.mjs";
import { keepLast } from "../lib/capped.mjs";

export const CALLERS = ["orchestrator", "edge", "runner", "proxy", "github"];
// The rate limits watched: GitHub has a few more (code_search, actions_runner_registration…)
// which Deckhand doesn't spend.
export const RESOURCES = ["core", "graphql", "search"];

// What the service does with git:
//   clone          a mirror's first fetch, the whole repository (git-mirror.mjs); an empty
//                  repository leaves its mirror empty, so each of its pushes counts a clone
//   mirror_update  a mirror fetched again before a push is checked against it, or a fork's
//                  commits a push points at, fetched beside it (git-mirror.mjs connect())
//   fetch          a sandbox's git fetch or clone relayed to GitHub, once whatever its requests:
//                  ok once its whole pack came (an ls-remote, or a fetch with nothing new,
//                  brings none: not counted), refused or failed at the request that was, a
//                  4xx of GitHub's or an answer cut short failed (github-gateway.mjs)
//   push           a sandbox's push, through the git gateway (git-gateway.mjs)
export const GIT_OPS = ["clone", "mirror_update", "fetch", "push"];
//   ok        done
//   refused   Deckhand refused it (pushes_refused_total says why)
//   rejected  GitHub answered, refusing some of its refs (a branch protection, a ruleset)
//   failed    GitHub (or git) failed, or couldn't be reached
export const GIT_RESULTS = ["ok", "refused", "rejected", "failed"];
// Why the git gateway refused a push:
//   default_branch  to the default branch, which no sandbox pushes
//   branch          not a branch, or one that isn't the run's
//   run             a run that may not push, or not to this repository
//   policies        the policies' deny_push
//   workflows       a workflow file that writes or names a secret (the `workflows` grant), or
//                   any workflow change without that grant
//   fork            a branch reaching objects it doesn't carry, a fork's maybe
//   error           what couldn't be checked (a token, the mirror, a push too large or too slow)
export const PUSH_REASONS = [
  "default_branch",
  "branch",
  "run",
  "policies",
  "workflows",
  "fork",
  "error",
];

// The most rate limits remembered: one per token GitHub answered for, until its reset.
const MAX_LIMITS = 1000;
// How long the mirrors' size is kept between scrapes: walking them reads every file's size.
const MIRROR_MS = 60_000;

// What a call's Authorization makes its rate limit's key: the App's JWT (a new one each minute)
// one key, a token its hash (never kept as is). A repo's tokens share their installation's limit,
// so the lowest of its keys is the installation's latest.
function limitKey(authorization) {
  const value = String(authorization ?? "");
  if (/^Bearer ey/.test(value)) return "app";
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// A header of `headers`: a fetch Response's (get()) or a node:http answer's (an object).
const header = (headers, name) => {
  const value = typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
  return Array.isArray(value) ? value[0] : (value ?? null);
};

// The bytes under `dir`, its symlinks not followed; 0 when there is none.
async function sizeOf(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await sizeOf(path);
    else
      total += await lstat(path).then(
        (s) => s.size,
        () => 0,
      );
  }
  return total;
}

// `mirrorDir`: the git mirrors (service.mjs's), on the service's volume. → the hooks the
// service and its gateways call: as(caller, fn), fetch (the App's, counted), api(…), git(op,
// result), refused(reason).
export function githubMetrics(
  registry,
  { mirrorDir = null, now = Date.now, fetch = globalThis.fetch } = {},
) {
  const calls = registry.counter(
    "deckhand_github_api_calls_total",
    "Calls to GitHub's API, by the caller they were made for and GitHub's status " +
      "(unreachable: no answer).",
    {
      labels: ["caller", "status"],
      values: { caller: CALLERS, status: STATUS_LABELS },
      maxSeries: (CALLERS.length + 1) * STATUS_LABELS.length,
    },
  );
  const durations = registry.histogram(
    "deckhand_github_api_call_duration_seconds",
    "How long GitHub's API took to answer, to its headers, in seconds.",
    { labels: ["caller"], values: { caller: CALLERS } },
  );
  // resource → key → { remaining, limit, reset (Unix seconds) }, from the latest answer for that
  // key.
  const limits = new Map(RESOURCES.map((r) => [r, new Map()]));
  // The lowest remaining of the keys whose window isn't over, and its reset: [resource, entry].
  function lowest() {
    const seconds = now() / 1000;
    const out = [];
    for (const [resource, keys] of limits) {
      let low = null;
      for (const [key, entry] of keys) {
        if (entry.reset <= seconds) keys.delete(key);
        else if (!low || entry.remaining < low.remaining) low = entry;
      }
      if (low) out.push([resource, low]);
    }
    return out;
  }
  registry.gauge(
    "deckhand_github_rate_limit_remaining",
    "Calls left in GitHub's rate limit, the lowest of the installations' (and the App's), " +
      "as its latest answers said.",
    {
      labels: ["resource"],
      values: { resource: RESOURCES },
      collect: () => lowest().map(([resource, low]) => [{ resource }, low.remaining]),
    },
  );
  // The size of that lowest one's window (5000 an hour, 15000 on Enterprise Cloud…), for an alert
  // on its share left: none when GitHub didn't say. That share is the fewest calls left's, close
  // to the lowest share: a key with a larger window may have less of it left, and more calls.
  registry.gauge(
    "deckhand_github_rate_limit_limit",
    "The calls that lowest rate limit allows in its window, as GitHub said (its share left is that key's, not always the lowest share).",
    {
      labels: ["resource"],
      values: { resource: RESOURCES },
      collect: () =>
        lowest()
          .filter(([, low]) => Number.isFinite(low.limit))
          .map(([resource, low]) => [{ resource }, low.limit]),
    },
  );
  registry.gauge(
    "deckhand_github_rate_limit_reset_seconds",
    "Seconds until that lowest rate limit starts again.",
    {
      labels: ["resource"],
      values: { resource: RESOURCES },
      collect: () =>
        lowest().map(([resource, low]) => [
          { resource },
          Math.max(0, Math.round(low.reset - now() / 1000)),
        ]),
    },
  );
  const gitOps = registry.counter(
    "deckhand_git_operations_total",
    "Git operations: the mirrors' clones and updates, the sandboxes' fetches and pushes, " +
      "by result.",
    { labels: ["op", "result"], values: { op: GIT_OPS, result: GIT_RESULTS } },
  );
  const refusals = registry.counter(
    "deckhand_pushes_refused_total",
    "Pushes the git gateway refused, by why.",
    { labels: ["reason"], values: { reason: PUSH_REASONS } },
  );
  // The last walk, its promise kept: a scrape while one is still going waits for it rather than
  // start another, however long it takes.
  let mirrors = { at: -Infinity, bytes: Promise.resolve(0), walking: false };
  registry.gauge("deckhand_mirror_bytes", "The size of the git mirrors on its volume, in bytes.", {
    collect: () => {
      if (!mirrorDir) return 0;
      if (!mirrors.walking && now() - mirrors.at >= MIRROR_MS) {
        const walk = { at: now(), walking: true };
        walk.bytes = sizeOf(mirrorDir).finally(() => (walk.walking = false));
        mirrors = walk;
      }
      return mirrors.bytes;
    },
  });

  const callers = new AsyncLocalStorage();
  const callerNow = () => callers.getStore() ?? "github";

  function remember(headers, authorization) {
    const resource = header(headers, "x-ratelimit-resource");
    const remaining = Number(header(headers, "x-ratelimit-remaining"));
    const reset = Number(header(headers, "x-ratelimit-reset"));
    const limit = Number(header(headers, "x-ratelimit-limit") ?? NaN);
    const keys = limits.get(resource);
    // A call without a token (/setup's manifest conversion) has the address's limit, 60 an hour:
    // none of the installations' nor the App's.
    if (!authorization) return;
    if (!keys || !Number.isFinite(remaining) || !Number.isFinite(reset)) return;
    const key = limitKey(authorization);
    // The oldest dropped past the cap: a key not heard of since is the least likely the lowest.
    keepLast(keys, key, { remaining, limit, reset }, MAX_LIMITS);
  }

  // A call to GitHub's API answered (`status` null: no answer) after `seconds`, with `headers`
  // (a Response's or node's), sent with `authorization`.
  function api({ status, seconds, headers = null, authorization = null, caller = callerNow() }) {
    calls.inc({ caller, status: statusLabel(status) });
    durations.observe({ caller }, seconds);
    if (headers) remember(headers, authorization);
  }

  // `fetch`, each call counted as an API call of the caller in flight.
  async function counted(url, init = {}) {
    const start = performance.now();
    const seconds = () => (performance.now() - start) / 1000;
    const authorization = header(init.headers, "authorization");
    let answer;
    try {
      answer = await fetch(url, init);
    } catch (error) {
      api({ status: null, seconds: seconds() });
      throw error;
    }
    api({ status: answer.status, seconds: seconds(), headers: answer.headers, authorization });
    return answer;
  }

  return {
    as: (caller, fn) => callers.run(caller, fn),
    fetch: counted,
    api,
    git: (op, result) => gitOps.inc({ op, result }),
    refused: (reason) => refusals.inc({ reason }),
  };
}

// What the service runs with no metrics (its tests'): nothing counted.
export const NO_METRICS = {
  as: (_, fn) => fn(),
  fetch: (...args) => globalThis.fetch(...args),
  api: () => {},
  git: () => {},
  refused: () => {},
};

// Every metric its server declares, and test/metrics-services.test.mjs: githubMetrics()'s alone.
export const declareMetrics = githubMetrics;
