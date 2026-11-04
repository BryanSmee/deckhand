// The orchestrator's metrics (#654), on its registry (../lib/metrics.mjs): the runs' lives, the
// queue and its slots, the deliveries, the checks it makes on its own, and its calls to the
// other services. What only the acting copy knows (the queue, the running runs) is collected at
// each scrape, from it alone: the waiting copy has no samples of those.
import { performance } from "node:perf_hooks";
import { AGENTS } from "./agents/index.mjs";
import { repoAllowed } from "./config.mjs";
import { APP_EVENTS } from "./github-app.mjs";
import { BUILT_IN } from "./modes.mjs";
import { pickedTask } from "./tasks.mjs";

// A run's length, in seconds: from under a minute to hours.
export const RUN_BUCKETS = [30, 60, 120, 300, 600, 900, 1800, 2700, 3600, 5400, 7200, 14400, 28800];

// How a run ends, as its `done (…)` line says (runs.mjs finish()).
export const OUTCOMES = ["ok", "needs-input", "error", "cancelled"];

// What started a run (runKind()).
export const KINDS = ["work", "light", "review", "fix", "ci-fix", "conflict", "auto-pickup"];

// Why a comment waits rather than runs (queuedReasons()): a free slot, its repo's own
// max_parallel, one of AUTO_PICKUP_SLOTS (an auto-picked task, which takes no other slot), the
// pause that makes a burst one run, other issues ("/after"), the answers to its issue's open
// questions once they are done.
export const QUEUED = ["slot", "repo", "pickup", "pause", "after", "answers"];

// What became of a delivery (deliveryResult()).
export const DELIVERY_RESULTS = ["taken", "ignored", "refused"];

// A conflict check of one pull request (conflicts.mjs checkPull()).
export const CONFLICT_RESULTS = ["started", "clean", "pending", "refused", "skipped", "error"];

// A review that requests changes, and its fix round (reviews.mjs queueFix()).
export const FIX_RESULTS = ["started", "refused", "exhausted", "skipped", "error"];

// The services the orchestrator calls, as their clients name them.
export const CALLEES = ["broker", "runner", "github", "models", "policy"];

// A built-in mode as it is; a repo's own (`modes:`) is "custom": their names are the repos'.
export const modeLabel = (mode) => (BUILT_IN.has(mode) ? mode : "custom");

// What started a run, from its record (runlog.mjs newRecord()): a sweep's auto-pickup, one of the
// review loop's steps, a conflict's rebase, else a comment's work or light run.
export function runKind(record) {
  if (record.autoPickup) return "auto-pickup";
  switch (record.reason) {
    case "review":
    case "ci":
      return "review";
    case "review-fix":
      return "fix";
    case "ci-fix":
      return "ci-fix";
    case "conflict":
      return "conflict";
  }
  return record.light ? "light" : "work";
}

// A call's answer as a label: the usual statuses as they are, the others by class (5xx), and
// "error" for no answer at all (refused, reset, timed out).
const STATUSES = new Set([200, 201, 202, 204, 400, 401, 403, 404, 409, 413, 429, 500, 502, 503]);
export function statusLabel(status) {
  if (typeof status !== "number") return "error";
  return STATUSES.has(status) ? String(status) : `${Math.floor(status / 100)}xx`;
}

// Whether a call is a long poll (`?wait=`, the broker's and the models service's event
// streams): counted, but its duration is the wait's, not the service's.
const longPoll = (url) => /[?&]wait=/.test(String(url));

// The orchestrator's calls to the other services: `deckhand_service_calls_total{callee,
// status}` and `deckhand_service_call_duration_seconds{callee}`, each try counted (a service
// away answers 503, tried again: lib/service-client.mjs), timed until its answer's headers.
export function serviceCallMetrics(registry, { now = () => performance.now() } = {}) {
  const calls = registry.counter(
    "deckhand_service_calls_total",
    "The orchestrator's calls to the other services, each try, by its answer's status (error: none).",
    { labels: ["callee", "status"], values: { callee: CALLEES } },
  );
  const durations = registry.histogram(
    "deckhand_service_call_duration_seconds",
    "How long the other services take to answer the orchestrator's calls (long polls left out).",
    { labels: ["callee"], values: { callee: CALLEES } },
  );

  function observe(callee, status, seconds = null) {
    calls.inc({ callee, status: statusLabel(status) });
    if (seconds !== null) durations.observe({ callee }, seconds);
  }

  // `fetch`, measured: what the service clients take in place of the global one.
  function measured(callee, fetch = globalThis.fetch) {
    return async (url, options) => {
      const start = now();
      const timed = () => (longPoll(url) ? null : (now() - start) / 1000);
      try {
        const res = await fetch(url, options);
        observe(callee, res.status, timed());
        return res;
      } catch (error) {
        observe(callee, null, timed());
        throw error;
      }
    };
  }

  // For a client of its own (lib/broker-client.mjs `observe`): (status or null, path, ms).
  const observer = (callee) => (status, path, ms) =>
    observe(callee, status, longPoll(path) ? null : ms / 1000);

  return { observe, fetch: measured, observer };
}

// The deliveries of a state the orchestrator follows rather than a comment: issues and pull
// requests (titles, waits, questions, reviews), CI's runs, pushes (the default branches), the
// App's installations (onboarding). A comment is taken only as a work item.
const FOLLOWED = new Set([
  "issues",
  "pull_request",
  "workflow_run",
  "push",
  "installation",
  "installation_repositories",
]);

// What became of a delivery (http.mjs deliver()): `refused` by the operator's checks (a repo
// out of ALLOWED_REPOS, an author out of ALLOWED_USERS, not from an installation), whatever
// else it touched; `taken` when it got past them as a comment for a run (`item`), a state
// the orchestrator follows, or CI's (`ci`, the dashboard's); `ignored` otherwise (a comment that
// asks nothing, a bot's, a ping).
// Whether the operator's checks refuse delivery `p` whatever its event: not from an installation
// of the App, or about a repository out of ALLOWED_REPOS (fail closed, as every handler of it
// is). A ping is the webhook's own, from no installation. Its author's check is the work item's
// (events.mjs workItem(), REFUSED).
export function operatorRefuses(config, event, p) {
  if (event === "ping") return false;
  if (!p?.installation?.id) return true;
  const repo = p.repository?.full_name;
  return !!repo && !repoAllowed(config, repo);
}

export function deliveryResult({ event, refused = false, item = false, ci = false }) {
  if (refused) return "refused";
  return item || ci || FOLLOWED.has(event) ? "taken" : "ignored";
}

// Why each task with comments queued waits, and the waits for other issues: [[{ reason }, n]].
// `tasks`: ctx.tasks' values; `waits`: waits.mjs list()'s; `reserved`: AUTO_PICKUP_SLOTS.
export function queuedReasons(tasks, waits, maxParallel, reserved = 0) {
  const counts = new Map(QUEUED.map((reason) => [reason, 0]));
  const add = (reason) => counts.set(reason, counts.get(reason) + 1);
  const runningIn = new Map();
  for (const t of tasks) if (t.running) runningIn.set(t.repo, (runningIn.get(t.repo) ?? 0) + 1);
  for (const t of tasks) {
    if (t.running || !t.pending.length) continue;
    if (!t.ready) add("pause");
    else {
      // Held back by a cap of its own repo's below MAX_PARALLEL (repo-config.mjs startable()).
      const cap = t.settings?.maxParallel ?? maxParallel;
      if (cap < maxParallel && (runningIn.get(t.repo) ?? 0) >= cap) add("repo");
      // Its reserved slots alone (repo-config.mjs startable()): free ones elsewhere aren't its.
      else add(reserved > 0 && pickedTask(t) ? "pickup" : "slot");
    }
  }
  for (const w of waits) add(w.answers ? "answers" : "after");
  return [...counts].map(([reason, n]) => [{ reason }, n]);
}

// AUTO_PICKUP_SLOTS by state: used (auto-picked tasks hold them: tasks.mjs pickedCount()), lent
// (taken by other runs while no auto-picked task waits: repo-config.mjs startable()), free.
export function pickupSlots({ reserved, maxParallel, used, others }) {
  const held = Math.min(reserved, used);
  const lent = Math.max(0, Math.min(reserved - held, others - (maxParallel - reserved)));
  return [
    [{ state: "used" }, held],
    [{ state: "lent" }, lent],
    [{ state: "free" }, reserved - held - lent],
  ];
}

// The orchestrator's own: `ctx()` its shared state (server.mjs) once it acts, null before; the
// gauges have no samples then.
export function orchestratorMetrics(registry, { ctx }) {
  const modes = [...BUILT_IN, "custom"];
  const agents = Object.keys(AGENTS);
  const started = registry.counter(
    "deckhand_runs_started_total",
    "Runs started: past their settings, their sandbox being prepared.",
    {
      labels: ["mode", "agent", "kind"],
      values: { mode: modes, agent: agents, kind: KINDS },
      // Every series at 0 from the start (below): their product, past the default cap.
      maxSeries: modes.length * agents.length * KINDS.length,
    },
  );
  const finished = registry.counter("deckhand_runs_finished_total", "Runs ended, by outcome.", {
    labels: ["mode", "outcome"],
    values: { mode: modes, outcome: OUTCOMES },
  });
  // At 0 from the start, every series: a rate needs its first sample, or a copy's first run of
  // each (its first error after an update, say) never counts in an increase().
  for (const mode of modes) {
    for (const outcome of OUTCOMES) finished.inc({ mode, outcome }, 0);
    for (const agent of agents) for (const kind of KINDS) started.inc({ mode, agent, kind }, 0);
  }
  const durations = registry.histogram(
    "deckhand_run_duration_seconds",
    "How long runs take, from leaving the queue to their end, in seconds.",
    {
      labels: ["mode", "outcome"],
      values: { mode: [...BUILT_IN, "custom"], outcome: OUTCOMES },
      buckets: RUN_BUCKETS,
    },
  );
  const deliveries = registry.counter(
    "deckhand_deliveries_processed_total",
    "Verified deliveries handled: taken, ignored, or refused by the operator's checks.",
    {
      labels: ["event", "result"],
      values: {
        event: [...APP_EVENTS, "installation", "installation_repositories", "ping"],
        result: DELIVERY_RESULTS,
      },
    },
  );
  const conflicts = registry.counter(
    "deckhand_conflict_checks_total",
    "Pull requests asked whether they still merge (conflicts.check_minutes), by result.",
    { labels: ["result"], values: { result: CONFLICT_RESULTS } },
  );
  const fixes = registry.counter(
    "deckhand_fix_rounds_total",
    "Reviews requesting changes, and whether a fix run was queued for them.",
    { labels: ["result"], values: { result: FIX_RESULTS } },
  );
  const waits = registry.counter(
    "deckhand_waits_checked_total",
    'Issues asked of GitHub for the comments waiting for them ("/after").',
  );

  const acting = () => ctx() ?? null;
  registry.gauge("deckhand_runs_running", "Runs going: a sandbox started or being prepared.", {
    collect: () => (acting() ? acting().running : []),
  });
  registry.gauge("deckhand_runs_queued", "Tasks whose comments wait for a run, by why.", {
    labels: ["reason"],
    values: { reason: QUEUED },
    collect: () => {
      const c = acting();
      if (!c) return [];
      return queuedReasons(
        [...c.tasks.values()],
        c.waits?.list() ?? [],
        c.config.maxParallel,
        c.config.autoPickupSlots ?? 0,
      );
    },
  });
  registry.gauge("deckhand_max_parallel", "MAX_PARALLEL: the most runs going at once.", {
    collect: () => (acting() ? acting().config.maxParallel : []),
  });
  registry.gauge(
    "deckhand_auto_pickup_slots",
    "AUTO_PICKUP_SLOTS by state: used by auto-picked tasks, lent to other runs, free.",
    {
      labels: ["state"],
      values: { state: ["used", "lent", "free"] },
      collect: () => {
        const c = acting();
        if (!c) return [];
        const others = [...c.tasks.values()].filter((t) => t.running && !pickedTask(t)).length;
        return pickupSlots({
          reserved: c.config.autoPickupSlots ?? 0,
          maxParallel: c.config.maxParallel,
          used: c.pickedCount?.() ?? 0,
          others,
        });
      },
    },
  );

  return {
    // runs.mjs writeHeader(): its `running` line.
    runStarted(live) {
      const { record } = live;
      started.inc({ mode: modeLabel(live.mode), agent: record.agent, kind: runKind(record) });
    },
    // runs.mjs finish(): its `done (…)` line, or its error's.
    runFinished(live, at = Date.now()) {
      const labels = { mode: modeLabel(live.mode), outcome: live.record.status };
      finished.inc(labels);
      if (live.record.startedAt) {
        durations.observe(labels, Math.max(0, (at - live.record.startedAt) / 1000));
      }
    },
    delivery: (event, result) => deliveries.inc({ event, result }),
    conflictCheck: (result) => conflicts.inc({ result }),
    fixRound: (result) => fixes.inc({ result }),
    waitChecked: () => waits.inc(),
  };
}
