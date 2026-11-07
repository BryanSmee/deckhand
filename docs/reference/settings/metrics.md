# Logs and metrics

What the services write to stdout, and the port they serve Prometheus metrics on. Reading the
logs: [Logs and health checks](../../guides/logs.md); scraping the metrics, the Grafana
dashboard and the alerts: [Metrics](../../guides/metrics.md), and every metric:
[Metrics by service](../../guides/metrics-list.md).

## Settings

- **`LOG_FORMAT`, `LOG_LEVEL`** · `.env` only · default: `text` with `compose.yaml`, `info`\
  Each service's log lines: `text` or `json`, and the lowest level written ([Logs](../../guides/logs.md#format-and-level)).
- **`METRICS_PORT`** · `metrics_port` · default: none (off)\
  The port each service but the egress proxy serves its Prometheus metrics on, `9464` say ([Metrics](../../guides/metrics.md)).
- **`EGRESS_METRICS_PORT`** · `.env` only · default: none (off)\
  The egress proxy's metrics port, a setting of its own as sandboxes reach the proxy ([Metrics](../../guides/metrics.md)).
