// The orchestrator's metrics (listener/metrics.mjs, #654): the runs, the queue and its slots,
// the deliveries, and its calls to the other services.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistry } from "../lib/metrics.mjs";
import { AGENTS } from "../listener/agents/index.mjs";
import { createHttp } from "../listener/http.mjs";
import {
  deliveryResult,
  KINDS,
  OUTCOMES,
  modeLabel,
  orchestratorMetrics,
  pickupSlots,
  queuedReasons,
  runKind,
  serviceCallMetrics,
  statusLabel,
} from "../listener/metrics.mjs";
import { BUILT_IN } from "../listener/modes.mjs";
import { testConfig } from "./helpers.mjs";

// The samples of `text` (no comments), each line as it is.
const samples = (text) => text.split("\n").filter((line) => line && !line.startsWith("#"));
const sample = (text, prefix) => samples(text).find((line) => line.startsWith(`${prefix} `));

test("runKind: what started a run, from its record", () => {
  assert.equal(runKind({}), "work");
  assert.equal(runKind({ light: true }), "light");
  assert.equal(runKind({ reason: "review" }), "review");
  assert.equal(runKind({ reason: "ci" }), "review");
  assert.equal(runKind({ reason: "review-fix" }), "fix");
  assert.equal(runKind({ reason: "ci-fix" }), "ci-fix");
  assert.equal(runKind({ reason: "conflict", light: false }), "conflict");
  // An auto-picked run, whatever else it is.
  assert.equal(runKind({ autoPickup: true, reason: "review-fix" }), "auto-pickup");
  // A repo's own mode is "custom": its name is the repo's.
  assert.equal(modeLabel("brainstorm"), "brainstorm");
  assert.equal(modeLabel("triage"), "custom");
});

test("statusLabel: the usual statuses as they are, the others by class, none as error", () => {
  assert.equal(statusLabel(200), "200");
  assert.equal(statusLabel(503), "503");
  assert.equal(statusLabel(418), "4xx");
  assert.equal(statusLabel(504), "5xx");
  assert.equal(statusLabel(null), "error");
});

test("deliveryResult: refused whatever else it touched, taken past the checks, else ignored", () => {
  assert.equal(deliveryResult({ event: "pull_request", refused: true }), "refused");
  assert.equal(deliveryResult({ event: "issue_comment", item: true }), "taken");
  assert.equal(deliveryResult({ event: "issue_comment" }), "ignored");
  assert.equal(deliveryResult({ event: "issues" }), "taken");
  assert.equal(deliveryResult({ event: "status", ci: true }), "taken");
  assert.equal(deliveryResult({ event: "status" }), "ignored");
  assert.equal(deliveryResult({ event: "ping" }), "ignored");
});

test("queuedReasons: a slot, the repo's own cap, the pause, the waits", () => {
  const task = (repo, fields) => ({ repo, pending: [{}], running: false, ready: true, ...fields });
  const tasks = [
    // Running: not queued, but holds its repo's one place.
    task("org/capped", { running: true, pending: [] }),
    task("org/capped", { settings: { maxParallel: 1 } }),
    task("org/other"),
    task("org/other", { ready: false }),
    // Nothing queued.
    task("org/other", { pending: [] }),
    // A repo's cap at MAX_PARALLEL holds nothing back of its own: it waits for a slot.
    task("org/capped", { settings: { maxParallel: 3 } }),
    // Auto-picked: waits for one of AUTO_PICKUP_SLOTS, the one a picked run holds, whatever
    // other slot is free.
    task("org/picked", { pending: [{ autoPickup: true }] }),
    task("org/picked", { running: true, pending: [], live: { record: { autoPickup: true } } }),
  ];
  const waits = [{ blockers: [12] }, { blockers: [], answers: true }, { blockers: [3, 4] }];
  assert.deepEqual(
    Object.fromEntries(queuedReasons(tasks, waits, 3, 1).map(([l, n]) => [l.reason, n])),
    {
      slot: 2,
      repo: 1,
      pickup: 1,
      pause: 1,
      after: 2,
      answers: 1,
    },
  );
  const reasons = (list, reserved) =>
    Object.fromEntries(queuedReasons(list, [], 3, reserved).map(([l, n]) => [l.reason, n]));
  // Without reserved slots an auto-picked task is one like the others (startable()).
  assert.equal(reasons(tasks, 0).slot, 3);
  // Its reserved slot free (no picked run): it would start, so it waits as a `slot`, which
  // DeckhandQueueStuck watches; two reserved, one held: the same.
  const free = tasks.filter((t) => !t.live);
  assert.deepEqual([reasons(free, 1).slot, reasons(free, 1).pickup], [3, 0]);
  assert.deepEqual([reasons(tasks, 2).slot, reasons(tasks, 2).pickup], [3, 0]);
});

test("pickupSlots: used by picked tasks, lent to the others past their share, the rest free", () => {
  const slots = (fields) =>
    Object.fromEntries(pickupSlots(fields).map(([{ state }, n]) => [state, n]));
  // 5 in all, 2 reserved: 3 other runs fit without borrowing.
  assert.deepEqual(slots({ reserved: 2, maxParallel: 5, used: 1, others: 3 }), {
    used: 1,
    lent: 0,
    free: 1,
  });
  // 4 others: one runs in a reserved slot nobody picked.
  assert.deepEqual(slots({ reserved: 2, maxParallel: 5, used: 0, others: 4 }), {
    used: 0,
    lent: 1,
    free: 1,
  });
  // Picks past the reserved slots count as the reserved ones only.
  assert.deepEqual(slots({ reserved: 2, maxParallel: 5, used: 3, others: 5 }), {
    used: 2,
    lent: 0,
    free: 0,
  });
  assert.deepEqual(slots({ reserved: 0, maxParallel: 5, used: 0, others: 5 }), {
    used: 0,
    lent: 0,
    free: 0,
  });
});

test("orchestratorMetrics: the runs' lives counted, the queue's gauges from the acting copy alone", async () => {
  const registry = createRegistry();
  let ctx = null;
  const metrics = orchestratorMetrics(registry, { ctx: () => ctx });
  // Waiting for the lease: no state, no samples of it.
  const waiting = await registry.render();
  assert.match(waiting, /# TYPE deckhand_runs_queued gauge/);
  assert.equal(sample(waiting, "deckhand_runs_running"), undefined);
  assert.equal(sample(waiting, "deckhand_max_parallel"), undefined);
  // The runs' counters at 0 before any run, every series: an increase() counts the first one.
  assert.equal(
    sample(waiting, 'deckhand_runs_finished_total{mode="work",outcome="error"}'),
    'deckhand_runs_finished_total{mode="work",outcome="error"} 0',
  );
  assert.equal(
    sample(
      waiting,
      'deckhand_runs_started_total{mode="custom",agent="antigravity",kind="auto-pickup"}',
    ),
    'deckhand_runs_started_total{mode="custom",agent="antigravity",kind="auto-pickup"} 0',
  );
  const series = (name) => samples(waiting).filter((line) => line.startsWith(`${name}{`)).length;
  const modes = BUILT_IN.size + 1;
  assert.equal(series("deckhand_runs_finished_total"), modes * OUTCOMES.length);
  assert.equal(
    series("deckhand_runs_started_total"),
    modes * Object.keys(AGENTS).length * KINDS.length,
  );
  // An agent outside AGENTS folds into its own label alone, the series' cap leaving room.
  const other = createRegistry({ log: () => {} });
  orchestratorMetrics(other, { ctx: () => null }).runStarted({
    mode: "work",
    record: { agent: "someone", light: false },
  });
  assert.match(
    await other.render(),
    /deckhand_runs_started_total\{mode="work",agent="other",kind="work"\} 1/,
  );
  assert.doesNotMatch(waiting, /="other"/);

  const record = { agent: "claude", startedAt: 1_000_000, light: false, reason: "review-fix" };
  const live = { mode: "work", record };
  metrics.runStarted(live);
  record.status = "needs-input";
  metrics.runFinished(live, 1_000_000 + 90_000);
  metrics.runStarted({ mode: "triage", record: { agent: "codex", light: true } });
  metrics.delivery("issue_comment", "refused");
  metrics.conflictCheck("clean");
  metrics.fixRound("exhausted");
  metrics.waitChecked();

  const config = testConfig({ MAX_PARALLEL: "4", AUTO_PICKUP_SLOTS: "1" });
  ctx = {
    running: 1,
    config,
    tasks: new Map([
      ["org/repo#1", { repo: "org/repo", running: true, pending: [], live: { record: {} } }],
      ["org/repo#2", { repo: "org/repo", running: false, ready: true, pending: [{}] }],
    ]),
    waits: { list: () => [{ blockers: [1] }] },
    pickedCount: () => 0,
  };
  const text = await registry.render();
  assert.equal(
    sample(text, 'deckhand_runs_started_total{mode="work",agent="claude",kind="fix"}'),
    'deckhand_runs_started_total{mode="work",agent="claude",kind="fix"} 1',
  );
  assert.ok(sample(text, 'deckhand_runs_started_total{mode="custom",agent="codex",kind="light"}'));
  assert.ok(sample(text, 'deckhand_runs_finished_total{mode="work",outcome="needs-input"}'));
  assert.equal(
    sample(text, 'deckhand_run_duration_seconds_sum{mode="work",outcome="needs-input"}'),
    'deckhand_run_duration_seconds_sum{mode="work",outcome="needs-input"} 90',
  );
  assert.ok(
    sample(
      text,
      'deckhand_run_duration_seconds_bucket{mode="work",outcome="needs-input",le="120"}',
    ).endsWith(" 1"),
  );
  assert.ok(
    sample(
      text,
      'deckhand_run_duration_seconds_bucket{mode="work",outcome="needs-input",le="60"}',
    ).endsWith(" 0"),
  );
  assert.ok(
    sample(text, 'deckhand_deliveries_processed_total{event="issue_comment",result="refused"}'),
  );
  assert.ok(sample(text, 'deckhand_conflict_checks_total{result="clean"}'));
  assert.ok(sample(text, 'deckhand_fix_rounds_total{result="exhausted"}'));
  assert.equal(sample(text, "deckhand_waits_checked_total"), "deckhand_waits_checked_total 1");
  assert.equal(sample(text, "deckhand_runs_running"), "deckhand_runs_running 1");
  assert.equal(sample(text, "deckhand_max_parallel"), "deckhand_max_parallel 4");
  assert.equal(
    sample(text, 'deckhand_runs_queued{reason="slot"}'),
    'deckhand_runs_queued{reason="slot"} 1',
  );
  assert.equal(
    sample(text, 'deckhand_runs_queued{reason="after"}'),
    'deckhand_runs_queued{reason="after"} 1',
  );
  assert.equal(
    sample(text, 'deckhand_auto_pickup_slots{state="free"}'),
    'deckhand_auto_pickup_slots{state="free"} 1',
  );
});

test("serviceCallMetrics: each try counted by status, timed but for long polls", async () => {
  const registry = createRegistry();
  let time = 0;
  const calls = serviceCallMetrics(registry, { now: () => time });
  const fetch = calls.fetch("runner", async (url) => {
    time += 250;
    if (url.endsWith("/down")) throw new TypeError("fetch failed");
    return new Response("{}", { status: url.endsWith("/away") ? 503 : 200 });
  });
  assert.equal((await fetch("http://runner/sandboxes")).status, 200);
  assert.equal((await fetch("http://runner/away")).status, 503);
  await assert.rejects(fetch("http://runner/down"), /fetch failed/);
  // The broker's own client (lib/broker-client.mjs `observe`), and a long poll: counted only.
  calls.observer("broker")(200, "/events?wait=20000", 20_000);
  calls.observer("broker")(null, "/tokens", 40);
  const text = await registry.render();
  for (const [labels, n] of [
    ['callee="runner",status="200"', 1],
    ['callee="runner",status="503"', 1],
    ['callee="runner",status="error"', 1],
    ['callee="broker",status="200"', 1],
    ['callee="broker",status="error"', 1],
  ]) {
    assert.equal(
      sample(text, `deckhand_service_calls_total{${labels}}`),
      `deckhand_service_calls_total{${labels}} ${n}`,
    );
  }
  assert.equal(
    sample(text, 'deckhand_service_call_duration_seconds_count{callee="runner"}'),
    'deckhand_service_call_duration_seconds_count{callee="runner"} 3',
  );
  assert.equal(
    sample(text, 'deckhand_service_call_duration_seconds_sum{callee="runner"}'),
    'deckhand_service_call_duration_seconds_sum{callee="runner"} 0.75',
  );
  // The long poll left out of the broker's.
  assert.equal(
    sample(text, 'deckhand_service_call_duration_seconds_sum{callee="broker"}'),
    'deckhand_service_call_duration_seconds_sum{callee="broker"} 0.04',
  );
});

test("deliveries: refused by the operator's checks, taken as a work item, ignored otherwise", async () => {
  const counted = [];
  const config = testConfig({ ALLOWED_REPOS: "org/repo" });
  const ctx = {
    config,
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    app: { remember: () => {}, identity: () => ({ name: "deckhand[bot]" }) },
    repoList: { refresh: () => {} },
    pulls: { record: () => false, ciChanged: async () => {} },
    titles: { setClosed: () => {} },
    waits: { recheck: async () => null, closed: async () => {}, merged: async () => null },
    admit: async () => {},
    metrics: { delivery: (event, result) => counted.push(`${event} ${result}`) },
  };
  const http = createHttp(ctx);
  const comment = (login, repo = "org/repo", type = "User") => ({
    action: "created",
    installation: { id: 1 },
    repository: { full_name: repo, default_branch: "main" },
    issue: { number: 7, title: "An issue" },
    comment: { id: 70, body: "@deckhand work", user: { login, type } },
    sender: { login },
  });
  await http.deliver({ event: "issue_comment", payload: comment("alice") });
  await http.deliver({ event: "issue_comment", payload: comment("mallory") });
  await http.deliver({ event: "issue_comment", payload: comment("alice", "org/elsewhere") });
  await http.deliver({
    event: "issue_comment",
    payload: comment("deckhand[bot]", "org/repo", "Bot"),
  });
  await http.deliver({ event: "ping", payload: { zen: "Keep it simple." } });
  // Whatever the event, a repository out of ALLOWED_REPOS, or no installation, is refused: its
  // handlers return before any skip() says so.
  const elsewhere = { installation: { id: 1 }, repository: { full_name: "org/elsewhere" } };
  for (const [event, payload] of [
    ["issues", { ...elsewhere, action: "labeled", issue: { number: 7 } }],
    ["push", { ...elsewhere, ref: "refs/heads/main" }],
    ["workflow_run", { ...elsewhere, action: "completed", workflow_run: { head_sha: "abc" } }],
    ["pull_request", { ...elsewhere, action: "labeled", pull_request: { number: 8 } }],
    ["issue_comment", { ...comment("alice"), installation: undefined }],
  ]) {
    await http.deliver({ event, payload });
  }
  await http.deliver({
    event: "pull_request",
    payload: { ...elsewhere, action: "closed", pull_request: { number: 8 } },
    redelivered: true,
  });
  assert.deepEqual(counted, [
    "issue_comment taken",
    "issue_comment refused",
    "issue_comment refused",
    "issue_comment ignored",
    "ping ignored",
    "issues refused",
    "push refused",
    "workflow_run refused",
    "pull_request refused",
    "issue_comment refused",
    "pull_request refused",
  ]);
});
