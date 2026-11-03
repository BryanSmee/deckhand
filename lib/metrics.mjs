// Prometheus metrics (#651, #652): every service's registry of counters, gauges and histograms,
// rendered in the text exposition format, and served on a port of its own (METRICS_PORT) apart
// from the service ports: GET /metrics alone, no token, so nothing secret goes in it. No
// dependency, as the services carry none.
//
// Names are `deckhand_<…>`, units in the name (`_seconds`, `_bytes`), counters ending `_total`.
// Labels are bounded: a metric declares its label names, and may declare each one's values; a
// value outside them, or a new series past MAX_SERIES of a metric, is folded into `other` and
// logged once, so a bug can't make series without bound. A metric whose labels' values are all
// declared may set its own cap (`maxSeries`), their product, so that no caller reaches it. Never a run, issue, request or delivery
// ID: those stay fields of the log lines (log.mjs).
import { createServer } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { ConfigError, readSomeSettings } from "./settings.mjs";

export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// The most series a metric keeps: past it, a new one is the `other` series.
export const MAX_SERIES = 200;
export const OTHER = "other";

// How long a scrape waits for a collect(): one that doesn't answer by then (a store away) is left
// out of it, the others' samples sent all the same.
export const COLLECT_MS = 2000;

// Seconds, for the durations' histograms: from a few milliseconds to a long run.
export const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

const NAME = /^deckhand_[a-z][a-z0-9_]*$/;
const LABEL = /^[a-z][a-z0-9_]*$/;

// METRICS_PORT's text → a port, or null (empty: off). 0: one the OS picks, as for PORT (the
// tests').
export function metricsPort(text, label = "METRICS_PORT") {
  if (text == null || String(text).trim() === "") return null;
  const port = Number(String(text).trim());
  if (!/^\d+$/.test(String(text).trim()) || port > 65535) {
    throw new ConfigError(`${label}: expected a port, or empty for none, got ${text}`);
  }
  return port;
}

// METRICS_PORT as a settings table holds it (lib/settings.mjs; the listener's SETTINGS too).
export const METRICS_PORT_SETTING = {
  default: null,
  parse: (text, { label }) => metricsPort(text, label),
};

// METRICS_PORT for the services that read nothing else of config.yaml (the broker; the policy
// service reads it with its grants folder): the environment's, else the file's `metrics_port`,
// else none.
export const metricsPortOf = (env, read = undefined) =>
  readSomeSettings(env, { METRICS_PORT: METRICS_PORT_SETTING }, { read }).METRICS_PORT;

// A sample's value as the format writes it.
function number(value) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

const escapeHelp = (text) => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const escapeValue = (text) =>
  text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

// `{a="x",b="y"}`, or nothing without labels.
function labelText(names, values, extra = "") {
  const pairs = names.map((name, i) => `${name}="${escapeValue(values[i])}"`);
  if (extra) pairs.push(extra);
  return pairs.length ? `{${pairs.join(",")}}` : "";
}

// `inc(labels, by)` or `inc(by)`: an unlabelled metric's calls skip the labels.
const args = (labels, value, fallback) =>
  labels !== null && typeof labels === "object"
    ? [labels, value ?? fallback]
    : [{}, labels ?? fallback];

// A registry: what a service declares its metrics in, and renders at each scrape. `log`: what
// the label guard warns with, once per metric and reason.
export function createRegistry({
  log = () => {},
  maxSeries = MAX_SERIES,
  collectMs = COLLECT_MS,
} = {}) {
  const warn = log.warn ?? log;
  const metrics = new Map();
  // Every name a sample may take: a histogram's are its _bucket, _sum and _count too.
  const taken = new Set();

  function once(metric, reason, message) {
    if (metric.warned.has(reason)) return;
    metric.warned.add(reason);
    warn(`Metrics: ${metric.name}: ${message}`);
  }

  // The label values of `labels`, guarded, in the declared order, and their series' key.
  function guard(metric, labels, series) {
    for (const name of Object.keys(labels)) {
      if (!metric.labels.includes(name)) once(metric, `label ${name}`, `no label ${name}, dropped`);
    }
    let values = metric.labels.map((name) => {
      const value = labels[name] == null ? "" : String(labels[name]);
      const allowed = metric.values[name];
      if (!allowed || allowed.has(value)) return value;
      once(
        metric,
        `value ${name}`,
        `${name}="${value.slice(0, 100)}" isn't one of its values, counted as ${OTHER} (logged once)`,
      );
      return OTHER;
    });
    let key = JSON.stringify(values);
    const cap = metric.maxSeries ?? maxSeries;
    if (!series.has(key) && series.size >= cap) {
      once(metric, "cap", `over ${cap} series, the next ones counted as ${OTHER} (logged once)`);
      values = metric.labels.map(() => OTHER);
      key = JSON.stringify(values);
    }
    return { key, values };
  }

  // Whether `value` is a number, logged once when it isn't: what isn't would make a sample no
  // scraper reads.
  function numeric(metric, value) {
    if (typeof value === "number") return true;
    once(metric, "not a number", `${typeof value} value ignored: a sample is a number`);
    return false;
  }

  // The series of `labels`, made with `empty()` the first time.
  function seriesOf(metric, labels, empty) {
    const { key, values } = guard(metric, labels, metric.series);
    let entry = metric.series.get(key);
    if (!entry) metric.series.set(key, (entry = { values, value: empty() }));
    return entry;
  }

  function declare(
    type,
    name,
    help,
    { labels = [], values = {}, collect = null, maxSeries: own = null },
  ) {
    if (!NAME.test(name)) throw new Error(`metric ${name}: expected deckhand_<lowercase name>`);
    if (type === "counter" && !name.endsWith("_total"))
      throw new Error(`metric ${name}: a counter's name ends with _total`);
    if (metrics.has(name)) throw new Error(`metric ${name}: declared twice`);
    const names =
      type === "histogram" ? [name, `${name}_bucket`, `${name}_sum`, `${name}_count`] : [name];
    const clash = names.find((n) => taken.has(n));
    if (clash) throw new Error(`metric ${name}: ${clash} is another metric's samples`);
    for (const label of labels) {
      if (!LABEL.test(label) || (type === "histogram" && label === "le"))
        throw new Error(`metric ${name}: label ${label} isn't a label name`);
    }
    const metric = {
      type,
      name,
      help,
      labels,
      values: Object.fromEntries(
        Object.entries(values).map(([label, list]) => [label, new Set(list.map(String))]),
      ),
      collect,
      series: new Map(),
      warned: new Set(),
      maxSeries: own,
    };
    metrics.set(name, metric);
    for (const n of names) taken.add(n);
    return metric;
  }

  function counter(name, help, options = {}) {
    const metric = declare("counter", name, help, options);
    if (!metric.labels.length && !metric.collect) seriesOf(metric, {}, () => 0);
    return {
      inc(labels, by) {
        [labels, by] = args(labels, by, 1);
        if (!numeric(metric, by)) return;
        if (!(by >= 0)) return once(metric, "negative", `inc(${by}) ignored: a counter only grows`);
        seriesOf(metric, labels, () => 0).value += by;
      },
    };
  }

  // `collect()`, when given, makes the gauge's value at each scrape: a number, or a list of
  // [labels, value].
  function gauge(name, help, options = {}) {
    const metric = declare("gauge", name, help, options);
    if (!metric.labels.length && !metric.collect) seriesOf(metric, {}, () => 0);
    return {
      set(labels, value) {
        [labels, value] = args(labels, value, 0);
        if (numeric(metric, value)) seriesOf(metric, labels, () => 0).value = value;
      },
      inc(labels, by) {
        [labels, by] = args(labels, by, 1);
        if (numeric(metric, by)) seriesOf(metric, labels, () => 0).value += by;
      },
      dec(labels, by) {
        [labels, by] = args(labels, by, 1);
        if (numeric(metric, by)) seriesOf(metric, labels, () => 0).value -= by;
      },
    };
  }

  // `buckets`: the upper bounds, fixed for the metric; `+Inf` is added.
  function histogram(name, help, { buckets = SECONDS_BUCKETS, ...options } = {}) {
    const bounds = [...buckets].sort((a, b) => a - b);
    if (!bounds.length || !bounds.every(Number.isFinite))
      throw new Error(`metric ${name}: expected finite buckets`);
    const metric = declare("histogram", name, help, { ...options, collect: null });
    metric.buckets = bounds;
    const empty = () => ({ counts: bounds.map(() => 0), sum: 0, count: 0 });
    if (!metric.labels.length) seriesOf(metric, {}, empty);
    const observe = (labels, value) => {
      [labels, value] = args(labels, value, 0);
      if (!numeric(metric, value)) return;
      const entry = seriesOf(metric, labels, empty).value;
      bounds.forEach((bound, i) => value <= bound && entry.counts[i]++);
      entry.sum += value;
      entry.count++;
    };
    return {
      observe,
      // A duration: the function returned observes the seconds since.
      startTimer(labels = {}) {
        const start = performance.now();
        return () => observe(labels, (performance.now() - start) / 1000);
      },
    };
  }

  // `metric.collect()`, or a rejection once it took `collectMs`.
  function answered(metric) {
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${collectMs / 1000} s`)),
        collectMs,
      );
      timer.unref?.();
    });
    return Promise.race([Promise.resolve().then(metric.collect), late]).finally(() =>
      clearTimeout(timer),
    );
  }

  // A collected metric's series at this scrape, guarded as those set are (duplicates added up).
  async function collected(metric) {
    const result = await answered(metric);
    const series = new Map();
    const list = typeof result === "number" ? [[{}, result]] : (result ?? []);
    for (const [labels, value] of list) {
      if (!numeric(metric, value)) continue;
      const { key, values } = guard(metric, labels ?? {}, series);
      const entry = series.get(key);
      if (entry) entry.value += value;
      else series.set(key, { values, value });
    }
    return series;
  }

  function lines(metric, series) {
    const out = [];
    for (const { values, value } of series.values()) {
      if (metric.type !== "histogram") {
        out.push(`${metric.name}${labelText(metric.labels, values)} ${number(value)}`);
        continue;
      }
      metric.buckets.forEach((bound, i) => {
        const le = `le="${number(bound)}"`;
        out.push(`${metric.name}_bucket${labelText(metric.labels, values, le)} ${value.counts[i]}`);
      });
      out.push(
        `${metric.name}_bucket${labelText(metric.labels, values, 'le="+Inf"')} ${value.count}`,
      );
      out.push(`${metric.name}_sum${labelText(metric.labels, values)} ${number(value.sum)}`);
      out.push(`${metric.name}_count${labelText(metric.labels, values)} ${value.count}`);
    }
    return out;
  }

  // Every metric in the order declared, the collected ones asked all at once. A collect() that
  // fails, or doesn't answer within `collectMs`, leaves its metric's samples out of this scrape,
  // logged once.
  async function render() {
    const all = [...metrics.values()];
    const series = await Promise.all(
      all.map((metric) =>
        metric.collect
          ? collected(metric).catch((error) => {
              once(metric, "collect", `collecting it failed, left out: ${error.message ?? error}`);
              return null;
            })
          : metric.series,
      ),
    );
    const out = [];
    all.forEach((metric, i) => {
      out.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
      out.push(`# TYPE ${metric.name} ${metric.type}`);
      if (series[i]) out.push(...lines(metric, series[i]));
    });
    return out.join("\n") + "\n";
  }

  return { counter, gauge, histogram, render, has: (name) => metrics.has(name) };
}

// `deckhand_build_info{service, version} 1`: which release each service runs.
export function buildInfo(registry, { service, version }) {
  registry
    .gauge("deckhand_build_info", "The release this service runs, always 1.", {
      labels: ["service", "version"],
    })
    .set({ service, version }, 1);
}

// How often the event loop's monitor samples, in milliseconds: what it measures is the time
// between its samples, this much of which is no delay.
const LOOP_RESOLUTION_MS = 20;

// The event loop's delay over a window of `windowMs` at least: its p99 at the last scrape that
// had samples, the window starting again past it. A function of the scrape, not of a timer.
function loopLag({ monitor, windowMs, now }) {
  let since = now();
  let last = 0;
  return () => {
    if (monitor.count > 0)
      last = Math.max(0, (monitor.percentile(99) - LOOP_RESOLUTION_MS * 1e6) / 1e9);
    if (now() - since >= windowMs) {
      monitor.reset();
      since = now();
    }
    return last;
  };
}

// The process's own: resident memory, CPU seconds, start time, event loop lag, open handles.
// → stop(), which ends the event loop's monitor.
export function processMetrics(
  registry,
  {
    proc = process,
    monitor = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS }),
    windowMs = 10_000,
    now = Date.now,
  } = {},
) {
  monitor.enable?.();
  registry.gauge("deckhand_process_resident_memory_bytes", "Resident memory, in bytes.", {
    collect: () => proc.memoryUsage.rss(),
  });
  registry.counter("deckhand_process_cpu_seconds_total", "CPU time, user and system, in seconds.", {
    collect: () => {
      const { user, system } = proc.cpuUsage();
      return (user + system) / 1e6;
    },
  });
  registry
    .gauge("deckhand_process_start_time_seconds", "When the process started, in Unix seconds.")
    .set(Math.round((now() / 1000 - proc.uptime()) * 1000) / 1000);
  registry.gauge(
    "deckhand_process_event_loop_lag_seconds",
    "The event loop's delay (p99, over the last 10 s or more), in seconds.",
    { collect: loopLag({ monitor, windowMs, now }) },
  );
  registry.gauge(
    "deckhand_process_open_handles",
    "Resources keeping the event loop alive: sockets, timers, files being read.",
    { collect: () => proc.getActiveResourcesInfo().length },
  );
  return { stop: () => monitor.disable?.() };
}

// `deckhand_lease_held{lease}`: 1 while this copy holds the lease (lib/active.mjs), else 0, so
// that both copies answer and the waiting one says so. `leases`: { name: () => held }.
export function leaseMetric(registry, leases) {
  registry.gauge("deckhand_lease_held", "1 while this copy holds the lease and acts, else 0.", {
    labels: ["lease"],
    collect: () => Object.entries(leases).map(([lease, held]) => [{ lease }, held() ? 1 : 0]),
  });
}

// The metrics port's server: GET (or HEAD) /metrics, nothing else.
export function metricsServer(registry, { log = () => {} } = {}) {
  return createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/metrics") {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Only /metrics here.\n");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain", allow: "GET, HEAD" });
      return res.end("GET /metrics only.\n");
    }
    let body;
    try {
      body = await registry.render();
    } catch (error) {
      (log.error ?? log)(`Metrics: ${error.stack ?? error}`);
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("Metrics failed.\n");
    }
    res.writeHead(200, { "content-type": CONTENT_TYPE, "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

// A service's metrics: its registry with what every service exposes (build info, and with a
// port the process's), served on `port` when set. Without one, the registry is kept all the same,
// for what the service declares, and the event loop isn't sampled for a page nobody reads. The
// server doesn't keep the process up: it exits as it would without it. A port it can't listen
// on stops the service, as a wrong setting does. `registry`: one the service declared metrics in
// before its settings were read (the orchestrator's calls). → { registry, server, stop }.
export function startMetrics({
  service,
  port,
  env = process.env,
  log = () => {},
  exit = process.exit,
  registry = createRegistry({ log }),
  ...options
}) {
  buildInfo(registry, { service, version: env.DECKHAND_VERSION || "dev" });
  let own = null;
  let server = null;
  if (port != null) {
    own = processMetrics(registry, options);
    server = metricsServer(registry, { log });
    server.on("error", (error) => {
      (log.error ?? log)(`Metrics: port ${port}: ${error.message}`);
      exit(1);
    });
    server.listen(port, () => log(`Metrics on :${server.address().port}/metrics`));
    server.unref();
  }
  return {
    registry,
    server,
    stop() {
      own?.stop();
      server?.close();
    },
  };
}
