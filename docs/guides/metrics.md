# Metrics

Every service (edge, the orchestrator, the runner, the broker, the github, models and policy
services, the egress proxy) serves Prometheus metrics, in its text format, for Prometheus or
VictoriaMetrics to scrape, with a Grafana dashboard and alerting rules to go with them. Set them
up when Deckhand runs work others wait for: the alerts tell you when runs fail, stall or can't
start. Off by default: set the port and each service listens on it.

| Setting                        | `config.yaml` key | Default    | What                                                                                                  |
| ------------------------------ | ----------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `METRICS_PORT`                 | `metrics_port`    | none (off) | the port each service but the egress proxy serves `GET /metrics` on, `9464` say; empty: none          |
| `EGRESS_METRICS_PORT` (`.env`) | none              | none (off) | the egress proxy's: `compose.yaml` passes it as the proxy's `METRICS_PORT`, which sandboxes reach too |

- **A port of its own**, apart from the service ports: `GET /metrics` alone (any other path is
  404), with no token, so nothing secret goes in it. `compose.yaml` passes `.env`'s
  `METRICS_PORT` to every service but the egress proxy, and publishes none: your scraper joins
  a network of each service's ([With Compose](#with-compose)). Every service but the egress proxy reads `metrics_port`
  in `config.yaml` too (the broker mounts the server folder for it alone).
- **The egress proxy's is a setting of its own**, `EGRESS_METRICS_PORT`, as every sandbox
  reaches the proxy, and so its metrics port: they would read its memory, CPU and event loop
  lag, which other runs' traffic moves ([security.md](../security/not-covered.md#not-covered)). It reads
  its environment alone, never `config.yaml`. On Kubernetes, where the sandboxes reach its
  proxy port alone, the manifests give it `METRICS_PORT` as every service
  ([Metrics](../kubernetes/metrics.md#metrics)).

What each metric means, service by service: [Metrics by service](metrics-list.md).

## With Compose

A `compose.override.yaml` beside `compose.yaml` (read by `docker compose up -d`, no
flag needed) puts each service on a network of its own with your scraper: one network for all of
them would let each reach the others, which their networks keep apart
([security.md](../security/services.md#the-services-networks)). Each is internal, with no way out, and nothing
is published. On them, the scraper reaches the services' other ports too: their `/health`, and
calls they refuse without a caller's service token (or, on the orchestrator's egress policy
port, the proxy's address). With Prometheus, in the same project:

```yaml
# compose.override.yaml: each service's metrics on a network shared with the scraper alone.
services:
  edge:
    networks: [metrics-edge]
  orchestrator:
    networks: [metrics-orchestrator]
  runner:
    networks: [metrics-runner]
  broker:
    networks: [metrics-broker]
  github:
    networks: [metrics-github]
  models:
    networks: [metrics-models]
  policy:
    networks: [metrics-policy]
  # Scraped with EGRESS_METRICS_PORT=9464 alone.
  egress:
    networks: [metrics-egress]
  prometheus:
    image: prom/prometheus:v3.15.1
    restart: unless-stopped
    ports: ["127.0.0.1:9090:9090"]
    configs:
      - source: prometheus
        target: /etc/prometheus/prometheus.yml
    # Its UI's (and its remote write's) network, then each service's.
    networks:
      - prometheus
      - metrics-edge
      - metrics-orchestrator
      - metrics-runner
      - metrics-broker
      - metrics-github
      - metrics-models
      - metrics-policy
      - metrics-egress
    volumes: [prometheus:/prometheus]

networks:
  prometheus:
  metrics-edge: { internal: true }
  metrics-orchestrator: { internal: true }
  metrics-runner: { internal: true }
  metrics-broker: { internal: true }
  metrics-github: { internal: true }
  metrics-models: { internal: true }
  metrics-policy: { internal: true }
  metrics-egress: { internal: true }

volumes:
  prometheus:

configs:
  prometheus:
    content: |
      scrape_configs:
        - job_name: deckhand
          static_configs:
            - targets: [edge:9464, runner:9464, broker:9464, github:9464]
            - targets: [models:9464, policy:9464, egress:9464]
          # Each copy of the orchestrator, `--scale orchestrator=2` too: its name resolves to
          # every one (deckhand_lease_held says which acts).
          dns_sd_configs:
            - names: [orchestrator]
              type: A
              port: 9464
```

`METRICS_PORT=9464` (and `EGRESS_METRICS_PORT=9464` for the proxy's) in `.env`, then
`docker compose up -d`. A scraper of another Compose project joins the same networks as
`external: true`, by their names in this one (`deckhand_metrics-edge`…); vmagent takes the same
scrape config.

## The Grafana dashboard

`deploy/grafana/deckhand.json` is a Grafana dashboard of these metrics, its data source a
variable of its own (`Data source`, any Prometheus or VictoriaMetrics one): import it (Dashboards,
New, Import), or provision it. Its rows:

- **Runs**: those going and queued (by why) against `MAX_PARALLEL`, started by mode, kind and
  agent, ended by outcome, their duration, the share of errors over a day.
- **Webhooks and GitHub**: the deliveries edge received and the orchestrator took, GitHub's rate
  limit left (its share of the window, by resource), the API calls by status and their time, the
  git operations and the pushes refused.
- **Models**: the agents' calls by provider and status, the fallbacks, the plans' usage, the
  tokens, the calls' length, the streams cut short and the logins refreshed.
- **Egress**: the connections denied by why and allowed by source, the traffic, the cache's
  requests and size against `EGRESS_CACHE_MAX`, the egress policy's time and the gateway's failed
  calls.
- **Sandboxes and images**: the network probe's verdict, the sandboxes running by engine and
  their start time, the starts failed by why, the probes, the image builds and their time.
- **Services**: each copy's memory, CPU and event loop lag (by the `service` its
  `deckhand_build_info` says), the leases and their takeovers, the orchestrator's failed calls
  to the other services, and the version each copy runs.

With the chart, `metrics.dashboard.enabled` ships it as a ConfigMap for Grafana's sidecar
([Metrics](../kubernetes/metrics.md#metrics)). With Compose, Grafana provisions it from a folder:

```yaml
# compose.override.yaml, beside the Prometheus above.
services:
  grafana:
    image: grafana/grafana:12.3.0
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]
    networks: [prometheus]
    configs:
      - source: grafana-datasource
        target: /etc/grafana/provisioning/datasources/prometheus.yaml
      - source: grafana-dashboards
        target: /etc/grafana/provisioning/dashboards/deckhand.yaml
    volumes:
      - ./deploy/grafana:/var/lib/grafana/dashboards/deckhand:ro
      - grafana:/var/lib/grafana

volumes:
  grafana:

configs:
  grafana-datasource:
    content: |
      apiVersion: 1
      datasources:
        - { name: Prometheus, type: prometheus, url: "http://prometheus:9090", isDefault: true }
  grafana-dashboards:
    content: |
      apiVersion: 1
      providers:
        - { name: deckhand, options: { path: /var/lib/grafana/dashboards/deckhand } }
```

(`./deploy/grafana` from a clone of this repository, at your release's tag; or a copy of the
file in a folder of yours.)

## Alerts

`deploy/alerts/deckhand.yaml` holds Prometheus alerting rules, for Prometheus (`rule_files`) or
vmalert (`-rule`); with the chart, `metrics.rules.enabled` ships them as a `PrometheusRule` (or,
with `metrics.rules.kind: VMRule`, VictoriaMetrics') ([Metrics](../kubernetes/metrics.md#metrics)).
Each has a `severity` label, `critical`, `warning` or `info`, for your Alertmanager's routes.
`DeckhandServiceDown` reads the `up` of the targets of job `deckhand`, as the scrape config above
and the chart's ServiceMonitor name them: with a job of another name (an annotation-based
`kubernetes-pods`, say), change its selector (the chart's `metrics.rules.job`). They assume one Deckhand per Prometheus: their
sums and maxima take every target's series, so two installs scraped by one (staging and
production, say) need their copies of the file, each selecting its own (a `namespace` matcher). Their
thresholds are starting points: copy the file to tune them, and keep its tests
(`deckhand.test.yaml`, `promtool test rules`) beside it. With the Prometheus above, the file in
its configs too:

```yaml
configs:
  prometheus:
    content: |
      rule_files: [/etc/prometheus/deckhand-alerts.yaml]
      scrape_configs: …
  prometheus-alerts:
    file: ./deploy/alerts/deckhand.yaml
```

and `- { source: prometheus-alerts, target: /etc/prometheus/deckhand-alerts.yaml }` in its
service's `configs`. As it is, the alerts show on Prometheus' Alerts page alone: to be told of
them, point it at your Alertmanager too (`alerting: { alertmanagers: [{ static_configs:
[{ targets: [alertmanager:9093] }] }] }` in the same config).

| Alert                            | Severity | When                                                                                                                                                                                                | What to do                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DeckhandNetworkNotIsolated`     | critical | Kubernetes: the network probe found a sandbox reaching more than the egress proxy (`deckhand_network_isolated` 0)                                                                                   | every run is refused until it is fixed: the sandboxes' NetworkPolicies are missing, or the cluster's network plugin doesn't enforce them. Run `deploy/kubernetes/check-isolation.sh` ([The network probe](../kubernetes/isolation.md#the-network-probe)); the next run's start probes again                                                                                                                       |
| `DeckhandServiceDown`            | critical | a target of job `deckhand` hasn't answered its metrics port for 5 minutes, for as long as it stays down                                                                                             | its logs say why (`docker compose logs <service>`, `kubectl logs --previous`): a setting it refuses at start, the store or the broker away, its memory limit. A copy a rollout replaced leaves the scrape targets and doesn't fire it, nor does a service no target is left for (the orchestrator's copies found by DNS, all stopped; a pod Pending): `DeckhandServiceMissing` and `DeckhandNoLeaseHolder` say so |
| `DeckhandServiceMissing`         | critical | no copy of the broker, the github, models or policy service has answered for 5 minutes (no `deckhand_build_info` of its `service`): on Kubernetes its pods Pending or gone, which leave the targets | every run needs them: `kubectl get pods` (Pending: no node with the room; none: its Deployment scaled down), `docker compose ps`. The services with a lease are `DeckhandNoLeaseHolder`'s; the egress proxy isn't watched, its metrics port being off by default with Compose                                                                                                                                     |
| `DeckhandNoLeaseHolder`          | critical | no copy holds the `orchestrator`, `runner` or `edge/redeliveries` lease for 2 minutes: every copy answering waits, or none answers at all                                                           | no run starts (orchestrator), no sandbox starts (runner), or no failed delivery is asked again (edge). Check the copies run, then that [the store](store.md), which holds the lease, is reachable, then their logs                                                                                                                                                                                                |
| `DeckhandRunsFailing`            | warning  | over a quarter of the runs that ended in the last hour, 3 at least, ended in an error, for 15 minutes                                                                                               | the orchestrator's `done (error …)` lines and the runs' logs on the dashboard say why: an agent's credential, an image build, a sandbox's start, the policies refusing what the runs need                                                                                                                                                                                                                         |
| `DeckhandGitHubRateLimitLow`     | warning  | under 10 % of a GitHub rate limit (`core`, `graphql`) left for 5 minutes, the lowest installation's or the App's; not `search`, a minute's 30 calls that come back a minute later                   | runs stall once it is spent, until `deckhand_github_rate_limit_reset_seconds`. `deckhand_github_api_calls_total` by `caller` says who spends it: lower `MAX_PARALLEL`, or `conflicts.check_minutes` for many open pull requests                                                                                                                                                                                   |
| `DeckhandModelsLimited`          | warning  | over 10 % of the calls to a provider answered 429 (a rate or plan limit) or 529 (Anthropic overloaded), 15 minutes                                                                                  | a plan used up shows on the dashboard's bars (`deckhand_plan_usage_ratio`): lower `MAX_PARALLEL`, or set `FALLBACKS` to another provider. 529s pass on their own                                                                                                                                                                                                                                                  |
| `DeckhandQueueStuck`             | warning  | tasks waited for a free slot for 15 minutes with fewer runs going than `MAX_PARALLEL` (an auto-picked task waiting while its own slots are all held, `pickup`, doesn't count)                       | the orchestrator's log says why its runs don't start: the runner, the policy service or the broker away (`deckhand_service_calls_total`), or its store                                                                                                                                                                                                                                                            |
| `DeckhandRunsEndingStuck`        | warning  | runs' ends have waited for the store for 15 minutes (`deckhand_runs_ending`): their summary, the queue's write or their state's removal refused                                                     | each holds its task and a parallel slot. The dashboard's status page (the orchestrator's warnings) and its log say which runs and the store's error: a summary file it can't write (its volume's owner), a Redis ACL without the key, the store away. Once fixed, the next try ends them, with no restart                                                                                                         |
| `DeckhandSandboxesStuckStarting` | warning  | Kubernetes: a sandbox given up on after staying Pending past `KUBERNETES_PENDING_MINUTES`, in the last 30 minutes                                                                                   | its `reason` says why: `unschedulable` (no node with the room: the nodes, or `KUBERNETES_*` requests), `image_pull` (the registry, its pull Secret), `agent_install`, `network_gate` (the network plugin), `pending`. `kubectl describe pod` in the sandboxes' namespace says more                                                                                                                                |
| `DeckhandSandboxStartsSlow`      | info     | one start in ten took over 5 minutes in the last hour, for 15 minutes                                                                                                                               | a large image pulled on each node, a slow registry, a cluster adding a node for each sandbox: pre-pull the image, or keep a node warm                                                                                                                                                                                                                                                                             |
| `DeckhandEgressCacheFull`        | info     | the egress cache has held 95 % of `EGRESS_CACHE_MAX` for an hour                                                                                                                                    | it evicts the least recently used answers, which is fine until what the runs fetch no longer fits: if its misses grow (`deckhand_egress_cache_requests_total`), raise `EGRESS_CACHE_MAX` and the volume under it                                                                                                                                                                                                  |
