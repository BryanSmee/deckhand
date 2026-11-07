# Metrics

Every service serves Prometheus metrics on a port of its own, 9464 (`METRICS_PORT`, in each
Deployment: [Metrics](../guides/metrics.md) says what they say), for Prometheus or VictoriaMetrics
to scrape:

- **The port**: a container port named `metrics` on each service's pods, the egress proxy's
  too, and the same port on its Service, for a ServiceMonitor's endpoints. Both copies of the
  orchestrator and the runner answer; what only the acting copy knows comes from it alone
  (`deckhand_lease_held` says which).
- **The annotations** on each pod, `prometheus.io/scrape: "true"`, `prometheus.io/port: "9464"`
  and `prometheus.io/path: /metrics`: what annotation-based scrape jobs read, Prometheus'
  `kubernetes-pods` example and VictoriaMetrics' (vmagent's) alike. With one, there is nothing
  else to set up but the namespace below.
- **The NetworkPolicy**, `deckhand-metrics`: the port lets in one namespace's pods alone, your
  scraper's, by its `kubernetes.io/metadata.name`, and nothing else; never the sandboxes', which
  [the network probe](isolation.md#the-network-probe) and `check-isolation.sh` try it from, as every
  other port. The base names `monitoring`: an overlay names yours (if its own policies deny egress,
  let it out to the services' namespace on 9464 too):

  ```yaml
  patches:
    - target: { kind: NetworkPolicy, name: deckhand-metrics }
      patch: |
        - op: replace
          path: /spec/ingress/0/from/0/namespaceSelector/matchLabels/kubernetes.io~1metadata.name
          value: victoria-metrics
  ```

  Not the sandboxes' namespace, nor the services' (its every pod, BuildKit's included): a
  namespace of its own. The chart refuses both.

With the chart, `metrics.namespace` is that namespace and `metrics.port` the port, everywhere the
base says 9464. `metrics.serviceMonitor.enabled` adds a `ServiceMonitor` (the Prometheus Operator's)
or, with `metrics.serviceMonitor.kind: VMServiceScrape`, VictoriaMetrics' operator's, in the
services' namespace: each Service's `metrics` port, with `metrics.serviceMonitor.labels` for your
operator's selector (`release: kube-prometheus-stack`, say) and `.interval`. Its CRD has to be in
the cluster first: off by default. It keeps Deckhand's own `service` label (`honorLabels`), which is
the Service's name already. Its targets' job is `deckhand` (`jobLabel`, the Services'
`app.kubernetes.io/part-of`), which the [alerts](../guides/metrics.md#alerts) select.

The [dashboard](../guides/metrics.md#the-grafana-dashboard) and the [alerts](../guides/metrics.md#alerts) come with the chart
too, both off by default. `metrics.dashboard.enabled` adds a ConfigMap,
`deckhand-grafana-dashboard`, carrying `deploy/grafana/deckhand.json` and the label Grafana's
sidecar loads dashboards by (`metrics.dashboard.labels`, `grafana_dashboard: "1"` as
kube-prometheus-stack's and Grafana's charts look for), in `metrics.dashboard.namespace` (empty: the
services'; one the sidecar searches), with `metrics.dashboard.annotations` for a folder
(`grafana_folder`, by the sidecar's `folderAnnotation`). `metrics.rules.enabled` adds
`deploy/alerts/deckhand.yaml`'s rules as a `PrometheusRule`, or a `VMRule` with
`metrics.rules.kind: VMRule`, with `metrics.rules.labels` for your operator's rule selector; its CRD
has to be in the cluster first. Their `DeckhandServiceDown` selects the job the ServiceMonitor
names, `deckhand`: without `metrics.serviceMonitor`, `metrics.rules.job` says your scrape job's (an
annotation-based `kubernetes-pods`, say), which the chart requires then. With the kustomize base,
the same files go to your monitoring stack as it takes them (a `configMapGenerator` of your
overlay's, say).
