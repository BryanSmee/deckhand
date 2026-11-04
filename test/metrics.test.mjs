import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTENT_TYPE,
  createRegistry,
  leaseMetric,
  metricsPort,
  metricsPortOf,
  metricsServer,
  processMetrics,
  startMetrics,
  STATUS_LABELS,
  statusLabel,
} from "../lib/metrics.mjs";
import { ConfigError } from "../lib/settings.mjs";
import { listening } from "./helpers.mjs";

// What the guard logged, and a registry logging there.
function recorded(options = {}) {
  const lines = [];
  const log = (line) => lines.push(line);
  return { lines, registry: createRegistry({ log, ...options }) };
}

// The sample lines of a rendering, without HELP and TYPE.
const samples = (text) => text.split("\n").filter((line) => line && !line.startsWith("#"));

test("statusLabel: the usual statuses as they are, the others by class, none as unreachable", () => {
  assert.equal(statusLabel(200), "200");
  assert.equal(statusLabel(429), "429");
  assert.equal(statusLabel(503), "503");
  assert.equal(statusLabel(529), "529");
  assert.equal(statusLabel(418), "4xx");
  assert.equal(statusLabel(505), "5xx");
  assert.equal(statusLabel(101), "1xx");
  assert.equal(statusLabel(null), "unreachable");
  assert.equal(statusLabel(undefined), "unreachable");
  assert.equal(statusLabel(999), "other");
  assert.equal(statusLabel("200"), "other");
  // Every label it gives an HTTP status is one of the declared values.
  for (let code = 100; code < 600; code++) assert.ok(STATUS_LABELS.includes(statusLabel(code)));
});

test("a counter renders its help, type and series, and only grows", async () => {
  const { registry, lines } = recorded();
  const runs = registry.counter("deckhand_runs_total", "Runs ended.", {
    labels: ["mode", "outcome"],
  });
  runs.inc({ mode: "work", outcome: "done" });
  runs.inc({ mode: "work", outcome: "done" }, 2);
  runs.inc({ mode: "light", outcome: "error" });
  runs.inc({ mode: "work", outcome: "done" }, -1);
  assert.equal(
    await registry.render(),
    [
      "# HELP deckhand_runs_total Runs ended.",
      "# TYPE deckhand_runs_total counter",
      'deckhand_runs_total{mode="work",outcome="done"} 3',
      'deckhand_runs_total{mode="light",outcome="error"} 1',
      "",
    ].join("\n"),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /a counter only grows/);
});

test("an unlabelled metric starts at 0 and skips the labels in its calls", async () => {
  const { registry } = recorded();
  const counter = registry.counter("deckhand_ticks_total", "Ticks.");
  const gauge = registry.gauge("deckhand_depth", "Depth.");
  assert.deepEqual(samples(await registry.render()), [
    "deckhand_ticks_total 0",
    "deckhand_depth 0",
  ]);
  counter.inc();
  counter.inc(4);
  gauge.set(7);
  gauge.dec(2);
  gauge.inc();
  assert.deepEqual(samples(await registry.render()), [
    "deckhand_ticks_total 5",
    "deckhand_depth 6",
  ]);
});

test("help text and label values are escaped; special values written as the format says", async () => {
  const { registry } = recorded();
  registry.gauge("deckhand_odd", 'A back\\slash\nand a "quote".', { labels: ["why"] });
  const gauge = registry.gauge("deckhand_values", "Values.", { labels: ["v"] });
  gauge.set({ v: 'a "b"\\c\nd' }, 1.5);
  gauge.set({ v: "nan" }, NaN);
  gauge.set({ v: "inf" }, Infinity);
  gauge.set({ v: "-inf" }, -Infinity);
  const text = await registry.render();
  assert.ok(text.includes('# HELP deckhand_odd A back\\\\slash\\nand a "quote".\n'));
  assert.deepEqual(samples(text), [
    'deckhand_values{v="a \\"b\\"\\\\c\\nd"} 1.5',
    'deckhand_values{v="nan"} NaN',
    'deckhand_values{v="inf"} +Inf',
    'deckhand_values{v="-inf"} -Inf',
  ]);
});

test("a histogram's buckets are cumulative, with +Inf, a sum and a count", async () => {
  const { registry } = recorded();
  const took = registry.histogram("deckhand_took_seconds", "How long.", {
    labels: ["step"],
    buckets: [1, 0.1, 10],
  });
  took.observe({ step: "clone" }, 0.05);
  took.observe({ step: "clone" }, 0.1);
  took.observe({ step: "clone" }, 5);
  took.observe({ step: "clone" }, 60);
  const text = await registry.render();
  assert.match(text, /# TYPE deckhand_took_seconds histogram\n/);
  assert.deepEqual(samples(text), [
    'deckhand_took_seconds_bucket{step="clone",le="0.1"} 2',
    'deckhand_took_seconds_bucket{step="clone",le="1"} 2',
    'deckhand_took_seconds_bucket{step="clone",le="10"} 3',
    'deckhand_took_seconds_bucket{step="clone",le="+Inf"} 4',
    'deckhand_took_seconds_sum{step="clone"} 65.15',
    'deckhand_took_seconds_count{step="clone"} 4',
  ]);
});

test("an unlabelled histogram renders its empty buckets from the start, and times", async () => {
  const { registry } = recorded();
  const took = registry.histogram("deckhand_scan_seconds", "A scan.", { buckets: [1] });
  assert.deepEqual(samples(await registry.render()), [
    'deckhand_scan_seconds_bucket{le="1"} 0',
    'deckhand_scan_seconds_bucket{le="+Inf"} 0',
    "deckhand_scan_seconds_sum 0",
    "deckhand_scan_seconds_count 0",
  ]);
  took.startTimer()();
  assert.match(await registry.render(), /deckhand_scan_seconds_bucket\{le="1"\} 1\n/);
});

test("names, label names and buckets are checked as they are declared", () => {
  const { registry } = recorded();
  assert.throws(() => registry.gauge("runs", "x"), /deckhand_/);
  assert.throws(() => registry.gauge("deckhand_Runs", "x"), /deckhand_/);
  assert.throws(() => registry.counter("deckhand_runs", "x"), /_total/);
  assert.throws(() => registry.gauge("deckhand_x", "x", { labels: ["Bad"] }), /label/);
  assert.throws(() => registry.histogram("deckhand_h", "x", { labels: ["le"] }), /label/);
  assert.throws(() => registry.histogram("deckhand_h2", "x", { buckets: [] }), /buckets/);
  // Never a label per run, issue, request, delivery, repository… (#651): a series each.
  for (const label of ["run", "issue", "request", "delivery", "repo", "host", "run_id", "id"]) {
    assert.throws(
      () => registry.counter(`deckhand_by_${label}_total`, "x", { labels: [label] }),
      /unbounded/,
      label,
    );
  }
  // A word ending with one is a label all the same.
  registry.counter("deckhand_by_reason_total", "x", { labels: ["reason", "valid"] });
  registry.gauge("deckhand_once", "x");
  assert.throws(() => registry.gauge("deckhand_once", "x"), /twice/);
  // A histogram's samples are named after it: no other metric may take those names.
  registry.histogram("deckhand_took_seconds", "x");
  assert.throws(() => registry.gauge("deckhand_took_seconds_count", "x"), /another metric's/);
  assert.throws(() => registry.gauge("deckhand_took_seconds_bucket", "x"), /another metric's/);
  registry.gauge("deckhand_wait_sum", "x");
  assert.throws(() => registry.histogram("deckhand_wait", "x"), /deckhand_wait_sum/);
});

test("a value that isn't a number is ignored, logged once", async () => {
  const { registry, lines } = recorded();
  const gauge = registry.gauge("deckhand_g", "G.");
  const counter = registry.counter("deckhand_c_total", "C.");
  const took = registry.histogram("deckhand_h_seconds", "H.", { buckets: [1] });
  registry.gauge("deckhand_collected", "Collected.", {
    labels: ["k"],
    collect: () => [
      [{ k: "a" }, "3"],
      [{ k: "b" }, 4],
    ],
  });
  gauge.set(2);
  gauge.set("5");
  gauge.inc(undefined);
  gauge.inc(null);
  counter.inc("1");
  took.observe("0.5");
  const text = await registry.render();
  assert.deepEqual(
    samples(text).filter((l) => !l.startsWith("deckhand_h_")),
    ["deckhand_g 4", "deckhand_c_total 0", 'deckhand_collected{k="b"} 4'],
  );
  assert.match(text, /^deckhand_h_seconds_count 0$/m);
  assert.equal(lines.filter((l) => /a sample is a number/.test(l)).length, 4);
});

test("a value outside its label's declared set is counted as other, logged once", async () => {
  const { registry, lines } = recorded();
  const runs = registry.counter("deckhand_ended_total", "Ended.", {
    labels: ["outcome"],
    values: { outcome: ["done", "error"] },
  });
  runs.inc({ outcome: "done" });
  runs.inc({ outcome: "dh-acme-api-42-1762077600000" });
  runs.inc({ outcome: "dh-acme-api-43-1762077600000" });
  assert.deepEqual(samples(await registry.render()), [
    'deckhand_ended_total{outcome="done"} 1',
    'deckhand_ended_total{outcome="other"} 2',
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /deckhand_ended_total: outcome="dh-acme-api-42-.*other/);
});

test("past the cap of series, new ones go to one other series, logged once", async () => {
  const { registry, lines } = recorded({ maxSeries: 3 });
  const calls = registry.counter("deckhand_calls_total", "Calls.", { labels: ["route", "status"] });
  for (let i = 0; i < 10; i++) calls.inc({ route: `/r${i}`, status: 200 });
  calls.inc({ route: "/r0", status: 200 });
  const text = await registry.render();
  assert.deepEqual(samples(text), [
    'deckhand_calls_total{route="/r0",status="200"} 2',
    'deckhand_calls_total{route="/r1",status="200"} 1',
    'deckhand_calls_total{route="/r2",status="200"} 1',
    'deckhand_calls_total{route="other",status="other"} 7',
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /over 3 series/);
});

test("a metric's own cap: its series kept past the registry's, up to it", async () => {
  const { registry, lines } = recorded({ maxSeries: 3 });
  const calls = registry.counter("deckhand_own_total", "Calls.", {
    labels: ["route"],
    maxSeries: 5,
  });
  for (let i = 0; i < 6; i++) calls.inc({ route: `/r${i}` });
  assert.deepEqual(samples(await registry.render()), [
    'deckhand_own_total{route="/r0"} 1',
    'deckhand_own_total{route="/r1"} 1',
    'deckhand_own_total{route="/r2"} 1',
    'deckhand_own_total{route="/r3"} 1',
    'deckhand_own_total{route="/r4"} 1',
    'deckhand_own_total{route="other"} 1',
  ]);
  assert.match(lines[0], /over 5 series/);
});

test("an undeclared label is dropped and a missing one empty, each logged once", async () => {
  const { registry, lines } = recorded();
  const gauge = registry.gauge("deckhand_g", "G.", { labels: ["a"] });
  gauge.set({ a: "x", run: "dh-1" }, 1);
  gauge.set({ a: "y", run: "dh-2" }, 2);
  gauge.set({}, 3);
  assert.deepEqual(samples(await registry.render()), [
    'deckhand_g{a="x"} 1',
    'deckhand_g{a="y"} 2',
    'deckhand_g{a=""} 3',
  ]);
  assert.deepEqual(lines, ["Metrics: deckhand_g: no label run, dropped"]);
});

test("a collected gauge is asked at each scrape, guarded, and left out when it fails", async () => {
  const { registry, lines } = recorded();
  let depth = 2;
  let failing = false;
  registry.gauge("deckhand_queue", "Queued.", {
    labels: ["mode"],
    values: { mode: ["work"] },
    collect: async () => {
      if (failing) throw new Error("store away");
      return [
        [{ mode: "work" }, depth],
        [{ mode: "x" }, 1],
        [{ mode: "y" }, 1],
      ];
    },
  });
  registry.gauge("deckhand_after", "After.", { collect: () => 9 });
  assert.deepEqual(samples(await registry.render()), [
    'deckhand_queue{mode="work"} 2',
    'deckhand_queue{mode="other"} 2',
    "deckhand_after 9",
  ]);
  depth = 5;
  assert.ok((await registry.render()).includes('deckhand_queue{mode="work"} 5\n'));
  failing = true;
  assert.deepEqual(samples(await registry.render()), ["deckhand_after 9"]);
  await registry.render();
  assert.equal(lines.filter((line) => /store away/.test(line)).length, 1);
});

test("a collect() that never answers is left out of the scrape, the rest sent at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // What's pending runs: the collectors' promises, the renders' awaits (setImmediate isn't mocked).
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const { registry, lines } = recorded({ collectMs: 2000 });
  registry.gauge("deckhand_build", "Build.").set(1);
  registry.gauge("deckhand_queue", "Never answers.", { collect: () => new Promise(() => {}) });
  let asked = 0;
  registry.gauge("deckhand_slow", "Answers in a second.", {
    collect: () => new Promise((resolve) => setTimeout(() => resolve(++asked), 1000)),
  });
  registry.gauge("deckhand_lease", "Answers at once.", { collect: () => 1 });
  const done = [];
  const renders = [registry.render(), registry.render()];
  renders.forEach((render, i) => render.then((text) => (done[i] = text)));
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(done, [], "waiting for the one that doesn't answer");
  // Asked together, not in turn: one collectMs from the start ends both scrapes, the slow one's
  // second included.
  t.mock.timers.tick(1000);
  await settle();
  const [first, second] = done;
  for (const text of [first, second]) {
    assert.deepEqual(
      samples(text).sort(),
      ["deckhand_build 1", "deckhand_lease 1", `deckhand_slow ${text === first ? 1 : 2}`].sort(),
    );
    assert.match(text, /# TYPE deckhand_queue gauge\n# HELP deckhand_slow/);
  }
  assert.deepEqual(lines, [
    "Metrics: deckhand_queue: collecting it failed, left out: no answer within 2 s",
  ]);
});

test("the process's metrics and the lease's, from what they are given", async () => {
  const { registry } = recorded();
  const monitor = { count: 10, percentile: () => 45e6, reset() {}, enable() {}, disable() {} };
  const proc = {
    memoryUsage: { rss: () => 123456 },
    cpuUsage: () => ({ user: 1_500_000, system: 500_000 }),
    uptime: () => 10,
    getActiveResourcesInfo: () => ["TCPServerWrap", "Timeout", "Timeout"],
  };
  processMetrics(registry, { proc, monitor, now: () => 1_000_000_000 });
  let held = false;
  const lease = leaseMetric(registry, { runner: () => held });
  const before = samples(await registry.render());
  assert.deepEqual(before, [
    "deckhand_process_resident_memory_bytes 123456",
    "deckhand_process_cpu_seconds_total 2",
    "deckhand_process_start_time_seconds 999990",
    "deckhand_process_event_loop_lag_seconds 0.025",
    "deckhand_process_open_handles 3",
    'deckhand_lease_held{lease="runner"} 0',
    'deckhand_lease_takeovers_total{lease="runner"} 0',
  ]);
  held = true;
  lease.taken();
  const after = await registry.render();
  assert.ok(after.includes('deckhand_lease_held{lease="runner"} 1\n'));
  assert.ok(after.includes('deckhand_lease_takeovers_total{lease="runner"} 1\n'));
});

test("the event loop's lag keeps its last value when a window has no samples", async () => {
  const { registry } = recorded();
  let at = 0;
  let resets = 0;
  const monitor = {
    count: 3,
    percentile: () => 24e6,
    reset: () => (resets++, (monitor.count = 0)),
  };
  processMetrics(registry, { monitor, now: () => at, windowMs: 10_000 });
  const lag = async () =>
    samples(await registry.render()).find((l) => l.startsWith("deckhand_process_event_loop_lag"));
  assert.equal(await lag(), "deckhand_process_event_loop_lag_seconds 0.004");
  at = 10_000;
  assert.equal(await lag(), "deckhand_process_event_loop_lag_seconds 0.004");
  assert.equal(resets, 1);
  assert.equal(await lag(), "deckhand_process_event_loop_lag_seconds 0.004");
});

test("METRICS_PORT: empty is none, a port is one, anything else refused", () => {
  assert.equal(metricsPort(undefined), null);
  assert.equal(metricsPort(""), null);
  assert.equal(metricsPort(" 9464 "), 9464);
  assert.equal(metricsPort("0"), 0);
  for (const bad of ["65536", "abc", "94.6", "-1"]) {
    assert.throws(() => metricsPort(bad), ConfigError, bad);
  }
  assert.throws(() => metricsPort("x", "config.yaml: metrics_port"), {
    message: /^config\.yaml: metrics_port: expected a port/,
  });
});

test("the metrics port answers GET and HEAD /metrics, and refuses everything else", async (t) => {
  const { registry } = recorded();
  registry.gauge("deckhand_up", "Up.").set(1);
  const server = metricsServer(registry);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${await listening(server)}`;
  const got = await fetch(`${base}/metrics`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), CONTENT_TYPE);
  assert.equal(got.headers.get("cache-control"), "no-store");
  assert.match(await got.text(), /^deckhand_up 1$/m);
  const head = await fetch(`${base}/metrics`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${base}/metrics?x=1`)).status, 200);
  for (const path of ["/", "/health", "/ready", "/metrics/", "/metricsx", "/api/state"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(await res.text(), /deckhand_/, path);
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await fetch(`${base}/metrics`, { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  }
});

test("startMetrics serves the build info and the process's metrics on its port", async (t) => {
  const lines = [];
  const metrics = startMetrics({
    service: "broker",
    port: 0,
    env: { DECKHAND_VERSION: "1.2.3" },
    log: (line) => lines.push(line),
  });
  t.after(() => metrics.stop());
  await new Promise((resolve) => metrics.server.once("listening", resolve));
  const text = await (
    await fetch(`http://127.0.0.1:${metrics.server.address().port}/metrics`)
  ).text();
  assert.match(text, /^deckhand_build_info\{service="broker",version="1\.2\.3"\} 1$/m);
  for (const name of [
    "deckhand_process_resident_memory_bytes",
    "deckhand_process_cpu_seconds_total",
    "deckhand_process_start_time_seconds",
    "deckhand_process_event_loop_lag_seconds",
    "deckhand_process_open_handles",
  ]) {
    assert.match(text, new RegExp(`^${name} \\d`, "m"), name);
  }
  assert.ok(lines.some((line) => /^Metrics on :\d+\/metrics$/.test(line)));
});

test("startMetrics without a port keeps its registry, listens nowhere and samples nothing", async (t) => {
  let enabled = false;
  const monitor = { count: 0, enable: () => (enabled = true), disable() {}, reset() {} };
  const metrics = startMetrics({ service: "edge", port: null, env: {}, monitor });
  t.after(() => metrics.stop());
  assert.equal(metrics.server, null);
  assert.equal(enabled, false);
  const text = await metrics.registry.render();
  assert.match(text, /deckhand_build_info\{service="edge",version="dev"\} 1/);
  assert.doesNotMatch(text, /deckhand_process_/);
});

test("metricsPortOf: the environment, else config.yaml's metrics_port, else none", () => {
  const files = { "/etc/deckhand/config.yaml": "allowed_users: [a]\nmetrics_port: 9464\n" };
  const read = (path) => {
    if (path in files) return files[path];
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
  assert.equal(metricsPortOf({}, read), 9464);
  assert.equal(metricsPortOf({ METRICS_PORT: "" }, read), 9464);
  assert.equal(metricsPortOf({ METRICS_PORT: "9500" }, read), 9500);
  // No file: none, unless CONFIG_FILE names one.
  assert.equal(
    metricsPortOf({ CONFIG_FILE: "" }, () => read("/nowhere")),
    null,
  );
  assert.throws(() => metricsPortOf({ CONFIG_FILE: "/srv/c.yaml" }, read), ConfigError);
  files["/srv/c.yaml"] = "metrics_port: web\n";
  assert.throws(() => metricsPortOf({ CONFIG_FILE: "/srv/c.yaml" }, read), {
    message: /^\/srv\/c\.yaml: metrics_port: expected a port/,
  });
  // One of another type is refused, as the listener refuses it, not left out unsaid.
  for (const value of ["[9464]", "true", "{ port: 9464 }"]) {
    files["/srv/c.yaml"] = `metrics_port: ${value}\n`;
    assert.throws(() => metricsPortOf({ CONFIG_FILE: "/srv/c.yaml" }, read), {
      message: /^\/srv\/c\.yaml: metrics_port: expected a value/,
    });
  }
  files["/srv/c.yaml"] = "grants_dir: /g\n";
  assert.equal(metricsPortOf({ CONFIG_FILE: "/srv/c.yaml" }, read), null);
  files["/srv/c.yaml"] = "a: [\n";
  assert.throws(() => metricsPortOf({ CONFIG_FILE: "/srv/c.yaml" }, read), ConfigError);
});

test("a metrics port it can't listen on stops the service", async (t) => {
  const taken = metricsServer(createRegistry());
  t.after(() => taken.close());
  const port = await listening(taken);
  const errors = [];
  const log = Object.assign(() => {}, { error: (line) => errors.push(line) });
  const exited = new Promise((resolve) => {
    const metrics = startMetrics({ service: "runner", port, env: {}, log, exit: resolve });
    t.after(() => metrics.stop());
  });
  assert.equal(await exited, 1);
  assert.match(errors[0], new RegExp(`^Metrics: port ${port}: .*EADDRINUSE`));
});
