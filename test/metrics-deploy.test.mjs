// The Grafana dashboard (deploy/grafana) and the alert rules (deploy/alerts), #661: they name
// only metrics the services declare, their datasource is a variable, every alert is documented
// and tested (promtool's tests: CI's kubernetes job), and the chart's copies are the same files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseYaml } from "../lib/yaml.mjs";

const repo = join(import.meta.dirname, "..");
const read = (...path) => readFileSync(join(repo, ...path), "utf8");
const dashboardText = read("deploy", "grafana", "deckhand.json");
const rulesText = read("deploy", "alerts", "deckhand.yaml");
const dashboard = JSON.parse(dashboardText);
const rules = parseYaml(rulesText).groups.flatMap((g) => g.rules);

// Every `"deckhand_…"` a service's code declares (a registry's counter, gauge or histogram).
function declared() {
  const names = new Set();
  const dirs = ["lib", "listener", "edge", "orchestrator", "runner", "broker", "github", "models"];
  for (const dir of [...dirs, "policy-service", "proxy"]) {
    for (const entry of readdirSync(join(repo, dir), { recursive: true })) {
      if (!String(entry).endsWith(".mjs") || String(entry).includes("node_modules")) continue;
      for (const [, name] of read(dir, String(entry)).matchAll(/"(deckhand_[a-z0-9_]+)"/g)) {
        names.add(name);
      }
    }
  }
  return names;
}

// The metrics an expression reads: a histogram's series by its own name.
const used = (expr) =>
  [...expr.matchAll(/\bdeckhand_[a-z0-9_]+/g)].map(([name]) =>
    name.replace(/_(bucket|count|sum)$/, ""),
  );

const targets = dashboard.panels.flatMap((p) => p.targets ?? []);

test("the dashboard and the alerts name only metrics a service declares", () => {
  const names = declared();
  const exprs = [...targets.map((t) => t.expr), ...rules.map((r) => r.expr)];
  const unknown = exprs.flatMap(used).filter((name) => !names.has(name));
  assert.deepEqual([...new Set(unknown)], []);
  // What the issue asks the dashboard to show, each by one of its metrics at least.
  const shown = new Set(targets.flatMap((t) => used(t.expr)));
  for (const name of [
    "deckhand_runs_started_total",
    "deckhand_runs_finished_total",
    "deckhand_run_duration_seconds",
    "deckhand_runs_queued",
    "deckhand_runs_ending",
    "deckhand_max_parallel",
    "deckhand_webhooks_received_total",
    "deckhand_github_rate_limit_remaining",
    "deckhand_model_calls_total",
    "deckhand_model_fallbacks_total",
    "deckhand_plan_usage_ratio",
    "deckhand_egress_connections_total",
    "deckhand_egress_cache_requests_total",
    "deckhand_sandboxes_running",
    "deckhand_sandbox_start_seconds",
    "deckhand_image_builds_total",
    "deckhand_network_isolated",
    "deckhand_process_resident_memory_bytes",
    "deckhand_lease_held",
  ]) {
    assert.ok(shown.has(name), name);
  }
});

test("the dashboard: its datasource a variable, its panels apart", () => {
  const variable = dashboard.templating.list.find((v) => v.name === "datasource");
  assert.equal(variable.type, "datasource");
  assert.equal(variable.query, "prometheus");
  const ds = { type: "prometheus", uid: "${datasource}" };
  const panels = dashboard.panels.filter((p) => p.type !== "row");
  for (const panel of panels) {
    assert.deepEqual(panel.datasource, ds, panel.title);
    for (const target of panel.targets) assert.deepEqual(target.datasource, ds, panel.title);
  }
  const ids = dashboard.panels.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  // No two panels on the same cells, none past the grid's 24 columns.
  const cells = new Set();
  for (const { gridPos: g, title } of dashboard.panels) {
    assert.ok(g.x + g.w <= 24, title);
    for (let x = g.x; x < g.x + g.w; x++) {
      for (let y = g.y; y < g.y + g.h; y++) {
        assert.ok(!cells.has(`${x},${y}`), `${title} overlaps at ${x},${y}`);
        cells.add(`${x},${y}`);
      }
    }
  }
});

test("the alerts: each with a severity and its text, documented, and tested", () => {
  const metrics = read("docs", "guides", "metrics.md");
  const section = metrics.slice(metrics.indexOf("\n## Alerts\n"));
  const tested = new Set(
    parseYaml(read("deploy", "alerts", "deckhand.test.yaml")).tests.flatMap((t) =>
      t.alert_rule_test.filter((a) => a.exp_alerts.length).map((a) => a.alertname),
    ),
  );
  assert.ok(rules.length >= 10);
  for (const rule of rules) {
    assert.match(rule.alert, /^Deckhand[A-Za-z]+$/);
    assert.ok(["critical", "warning", "info"].includes(rule.labels.severity), rule.alert);
    assert.ok(rule.annotations.summary && rule.annotations.description, rule.alert);
    assert.ok(
      section.includes(`\`${rule.alert}\``),
      `${rule.alert} in docs/guides/metrics.md's Alerts`,
    );
    assert.ok(tested.has(rule.alert), `${rule.alert} fires in deckhand.test.yaml`);
  }
});

test("the chart's copies are deploy/'s files", () => {
  const files = ["deploy", "helm", "deckhand", "files"];
  assert.equal(read(...files, "grafana-dashboard.json"), dashboardText);
  assert.equal(read(...files, "alerts.yaml"), rulesText);
});
