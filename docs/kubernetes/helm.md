# Install with Helm

The chart, `deploy/helm/deckhand/`, renders the base's objects: with its default values, the same
as `kustomize build deploy/kubernetes` (CI checks it, alone and with each component:
`test/helm-chart.test.mjs`), so every Kubernetes page holds for it. Its values do what an
overlay's patches do. Read the [requirements](../kubernetes.md#requirements) first. No chart
repository is published yet: install it from a checkout of this repository at a release.

## 1. Your values

Keep your values in a file of your own:

```yaml
# values.yaml
image:
  tag: v1.2.3 # every service's image, and SANDBOX_IMAGE's
apiServer:
  cidrs: [172.18.0.2/32] # the API server's addresses, kubernetes.md
server:
  config: |
    allowed_users: [your-login]
  grants: # by their path in the grants folder
    default.yaml: |
      hosts: [pypi.org]
    acme/api.yaml: |
      hosts: [api.acme.example]
    policy/grants.rego: |
      package deckhand
      allow_grant if {
        input.repo.name == "acme/api"
        input.grant == "dockerfile"
      }
env: # any other setting of the orchestrator, the runner and the models service
  MAX_PARALLEL: "4"
ingress:
  enabled: true
  className: nginx
  host: deckhand.example.com
  tlsSecretName: deckhand-tls
```

`apiServer.cidrs` are [the API server's addresses](../kubernetes.md#the-api-servers-addresses):
until they are yours, the runner and the broker reach nothing. The [values](#the-values) below say
what the others set.

## 2. Install the chart

```sh
helm install deckhand deploy/helm/deckhand -f values.yaml
```

The chart makes both namespaces itself, with their Pod Security labels, so its release goes in
another one (your context's, `default`): not `--namespace deckhand --create-namespace`, which
would make `deckhand` without them, and then refuse to make it again. With
`namespaces.create: false`, make them yourself, labelled as `namespaces.yaml` labels them.

The chart holds no Secret: the pods wait for them, so don't pass `--wait` to the first install,
and [finish the install](finish.md) with the Secrets, the GitHub App and the isolation's check.

## The values

| Value                                       | Default                      | What it sets                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image.repository`, `image.tag`             | `ghcr.io/bryansmee/deckhand` | every service's image, `<repository>-<service>:<tag>`; the tag is the chart's `appVersion` (`latest`) when empty                                                                                                                                                                                         |
| `image.sandbox`                             | `<repository>-sandbox:<tag>` | `SANDBOX_IMAGE` ([Isolation](isolation.md#what-the-manifests-set-up-and-why)), for a mirror of yours                                                                                                                                                                                                     |
| `namespaces`                                | `deckhand`, `-sandboxes`     | the services' namespace and the sandboxes' ([Namespaces](sandboxes.md#namespaces)), two different ones, and whether the chart makes them                                                                                                                                                                 |
| `server.config`, `server.grants`            | the examples                 | `config.yaml` and the grants folder's files, by their path in it; `--set-file server.config=config.yaml` reads yours                                                                                                                                                                                     |
| `env`                                       | none                         | any other setting in `deckhand-env` ([Server settings](../reference/settings.md)); one the other values set (`KUBERNETES_NAMESPACE`, `SANDBOX_IMAGE`…) is refused, naming the value to use                                                                                                               |
| `apiServer.cidrs`                           | a placeholder                | the API server's addresses ([The API server's addresses](../kubernetes.md#the-api-servers-addresses))                                                                                                                                                                                                    |
| `store`                                     | `file`                       | `redis` for the `redis` component ([Several nodes](components.md#several-nodes)), with `redis.image`, `redis.size` and `redis.storageClass`                                                                                                                                                              |
| `persistence.storageClass`, `.sizes`        | the cluster's default        | the services' claims; with `redis`, `persistence.sharedStorageClass` for the `ReadWriteMany` ones                                                                                                                                                                                                        |
| `sandboxes.storageClass`, …                 | unset                        | `KUBERNETES_STORAGE_CLASS`, `KUBERNETES_CACHE_STORAGE_CLASS` and `KUBERNETES_AGENT_STORAGE_CLASS` ([Agents](sandboxes.md#agents-on-kubernetes), [Caches](sandboxes.md#caches-on-kubernetes))                                                                                                             |
| `buildkit.enabled`, `registry`              | off                          | the `buildkit` component ([Repo images](components.md#repo-images)): `registry.url` is `KUBERNETES_REGISTRY` (refused without BuildKit), `registry.secretName` its pull Secret                                                                                                                           |
| `blobs.enabled`, `.url`, `.to`, `.ports`    | off                          | the `blobs` component ([Blob storage](components.md#blob-storage)): `BLOB_URL` and the `blobs.secretName` Secret (`deckhand-blobs`) for the runner and the broker alone, their way to its address (placeholders until set)                                                                               |
| `engine.enabled`, `.image`, `.runtimeClass` | off                          | the `engine` component ([Container engine](components.md#container-engine-on-kubernetes)): `SANDBOX_ENGINE=sysbox`, `ENGINE_IMAGE` (`<repository>-engine:<tag>` when empty), `KUBERNETES_ENGINE_RUNTIME_CLASS` (`sysbox-runc`)                                                                           |
| `metrics.port`, `.namespace`                | `9464`, `monitoring`         | the services' metrics port, and the only namespace that reaches it ([Metrics](metrics.md#metrics)); `metrics.serviceMonitor` adds a `ServiceMonitor` or a `VMServiceScrape` for them; `metrics.dashboard` the Grafana dashboard's ConfigMap and `metrics.rules` the alerts' `PrometheusRule` or `VMRule` |
| `ingress`                                   | off                          | an Ingress to edge's port 8080 for `ingress.host`, with `className`, `annotations` (cert-manager's, say) and `tlsSecretName`                                                                                                                                                                             |

`values.yaml` in the chart says more of each.

## Changing the storage

`store`, `persistence.storageClass`,
`persistence.sharedStorageClass` and `redis.storageClass` are fixed at install: a claim's access
mode and class can't change, so an upgrade that changes them fails on the claims it would
change, and going to `redis` leaves the stores' claims (kept, with what they hold) unused. To
move, scale the services to 0, copy what the claims hold (or let the stores start empty,
losing what they hold: [The store](../guides/store.md)), delete the claims that change, then
upgrade. A runner with an empty store refuses every call until its prefix's marker is removed
(`kubectl -n deckhand-sandboxes delete secret <NAME_PREFIX>-deployment`), unless its
`deployment` key was copied ([The store](../guides/store.md)).

## Updating

To update, change `image.tag` and `helm upgrade deckhand deploy/helm/deckhand -f values.yaml`, from
a checkout at the new release: the services update as with kustomize ([Updating](updating.md)). A
change of `server` or `env` renames its ConfigMap, as kustomize's hash does, and the pods that read
it restart. The old one stays, as `kubectl apply -k` leaves kustomize's: an old pod rescheduled
while a bad config stalls the rollout still starts. They pile up, as kustomize's do; delete those no
pod names.

## Coming from kustomize, and uninstalling

The base's objects, made by
`kubectl apply -k`, aren't the chart's: Helm refuses to install over them, so pick one, or let
Helm adopt them (the `meta.helm.sh/release-name` and `meta.helm.sh/release-namespace`
annotations and the `app.kubernetes.io/managed-by: Helm` label on each) before the first install.
`helm uninstall` keeps both namespaces and the services' claims (`helm.sh/resource-policy: keep`),
with your Secrets and the stores in them, and the sandboxes' NetworkPolicies: the runner makes the
sandbox pods itself, so a run going on at that moment keeps running, isolated as before, with no
proxy left to reach. Remove those pods (`kubectl -n deckhand-sandboxes delete pods --all`), or
delete both namespaces to remove everything.
