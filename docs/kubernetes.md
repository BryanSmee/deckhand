# Deckhand on Kubernetes

`deploy/kubernetes/` runs Deckhand on a cluster: a kustomize base with every service, the
sandboxes in a namespace of their own, and optional components: `redis` (the stores, for
copies on several nodes), `blobs` (blob storage for the logs and screenshots), `buildkit`
(repositories' own images) and `engine` (a container engine for runs). `deploy/helm/deckhand/` is
the same as a Helm chart, with values instead of patches ([Install with Helm](#install-with-helm)).
Each run's sandbox is a pod
(`RUNNER=kubernetes`): runs spread over the cluster's nodes, and `MAX_PARALLEL` still caps how
many run at once. [setup.md](setup.md) has the rest (the GitHub App's permissions, the settings,
the agents): this page is what differs on a cluster.

| Service      | Copies                           | Readiness | Grace (s) | Volumes                                         | Secrets                                                              |
| ------------ | -------------------------------- | --------- | --------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| edge         | 2, both active                   | `/ready`  | 40        | `edge-data` (its store)                         | `deckhand-edge`                                                      |
| orchestrator | 2, active/passive                | `/health` | 300       | `orchestrator-data`, `orchestrator-screenshots` | none                                                                 |
| runner       | 2, active/passive                | `/health` | 300       | `runner-data` (its store, the runs' inboxes)    | none (its ServiceAccount's API token); `deckhand-blobs` with `blobs` |
| broker       | 2, both active                   | `/ready`  | 45        | `broker-store`                                  | `deckhand-broker-key`; `deckhand-blobs` with `blobs`                 |
| github       | 2, both active                   | `/ready`  | 300       | `github-data` (its store, the git mirrors)      | `deckhand-github`                                                    |
| models       | 2, both active                   | `/ready`  | 630       | `models-store`                                  | `deckhand-models`, `-models-key`, `-credentials`                     |
| policy       | 2, both active                   | `/ready`  | 40        | none                                            | none                                                                 |
| egress proxy | 1, and a second during an update | `/ready`  | 630       | `egress-cache` (its cache, its CA)              | none                                                                 |

## Requirements

- **Kubernetes 1.30 or later**, and `kubectl` (its `-k` is kustomize), or Helm 3 or 4 for the
  chart.
- **A network plugin that enforces NetworkPolicies**: Calico, Cilium, or k3s's own (kube-router).
  One that ignores them (Flannel alone, say) takes them and isolates nothing: a sandbox could
  then call the services directly, the orchestrator's run tokens among them. The runner checks
  it itself and refuses every run on a cluster that doesn't
  ([The network probe](#the-network-probe)); `check-isolation.sh` checks it by hand
  ([Install](#install), step 5).
- **A default storage class** for the services' claims (`ReadWriteOnce`), and for the issues'
  session claims (`KUBERNETES_STORAGE_CLASS`). On several nodes, one with `ReadWriteMany` too
  ([Several nodes](#several-nodes)). A sandbox mounts a folder of each session claim
  (`.deckhand-session`), not its root, which a block volume's filesystem fills with
  `lost+found`. Claims made before Deckhand did so (without the annotation
  `deckhand.layout: folder`) are still mounted at their root, where their clone and session
  are. On such a class, delete those whose issue's runs fail on `lost+found` (git's clone:
  `already exists and is not an empty directory`, #643), the issue's `-workspace` claim and
  its agent's: its next run makes them again. Optional: a `ReadWriteMany` class for the agents' and
  caches' claims ([Agents](#agents-on-kubernetes), [Caches](#caches-on-kubernetes)).
- **The kubelet**: a `containerLogMaxSize` above `RUN_LOG_MAX_MB` (the default 10 MiB rotates a
  run's log away, and a runner restarted mid-run then misses or repeats lines: it logs a
  warning), and a `podPidsLimit`, as Kubernetes only limits processes per node (grants'
  `limits.pids` don't apply).
- **An ingress** (or a load balancer) that sends `https://<your host>/` to the `edge` Service's
  port 8080, with TLS: GitHub's webhooks and the dashboard come in there. Edge is the only
  service it may reach.
- **Node 26 on your machine**, for `deploy/kubernetes/secrets.mjs` (the keys and the GitHub App),
  from a checkout of this repository.

## Install

**1. Your overlay.** Keep your settings in a folder of your own (a git repository), whose
`kustomization.yaml` takes the base at a release and replaces what is yours:

```yaml
# kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - https://github.com/BryanSmee/deckhand//deploy/kubernetes?ref=v1.2.3 # or a checkout's path
# components:
#   - https://github.com/BryanSmee/deckhand//deploy/kubernetes/components/redis?ref=v1.2.3

# The release, for every image: the sandboxes' too, below.
images:
  - { name: ghcr.io/bryansmee/deckhand-edge, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-orchestrator, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-runner, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-broker, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-github, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-models, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-policy, newTag: v1.2.3 }
  - { name: ghcr.io/bryansmee/deckhand-egress, newTag: v1.2.3 }

configMapGenerator:
  # The settings the orchestrator, the runner and the models service share: SANDBOX_IMAGE at
  # the same release (a reference the nodes can pull), and any other environment setting.
  - name: deckhand-env
    namespace: deckhand
    behavior: merge
    literals:
      - SANDBOX_IMAGE=ghcr.io/bryansmee/deckhand-sandbox:v1.2.3
  # Your config.yaml and grants folder (server.example/ to start from), one key per file.
  - name: deckhand-server
    namespace: deckhand
    behavior: replace
    files:
      - server/config.yaml
      - server/grants/default.yaml
      - acme-api.yaml=server/grants/acme/api.yaml
      - grants.rego=server/grants/policy/grants.rego

# Where each key goes under /etc/deckhand, in every service that reads the grants (the
# orchestrator, the runner, the github and policy services: they must read the same files).
patches:
  - target: { kind: Deployment, name: orchestrator|runner|github|policy }
    patch: |
      apiVersion: apps/v1
      kind: Deployment
      metadata: { name: any }
      spec:
        template:
          spec:
            volumes:
              - name: server
                projected:
                  sources:
                    - configMap:
                        name: deckhand-server
                        items:
                          - { key: config.yaml, path: config.yaml }
                          - { key: default.yaml, path: grants/default.yaml }
                          - { key: acme-api.yaml, path: grants/acme/api.yaml }
                          - { key: grants.rego, path: grants/policy/grants.rego }
  # The API server's addresses, the runner's and the broker's only way out (step 2).
  - target: { kind: NetworkPolicy, name: deckhand-api-server }
    patch: |
      - op: replace
        path: /spec/egress/0/to
        value:
          - ipBlock: { cidr: 172.18.0.2/32 }
```

`config.yaml`'s `allowed_users` is required, as with Compose: edge and the orchestrator don't
start without it. `config.yaml` is read at start: the pods restart when it changes, as the
ConfigMap's name carries a hash of it: so do the grants, which the services otherwise read
again at each run. Every service that mounts it restarts on an edit of either, the broker too
(for `metrics_port` alone).

**2. The API server's addresses**: the runner (the sandboxes' pods) and the broker (its callers'
TokenReviews) reach the API server and nothing else, through the `deckhand-api-server`
NetworkPolicy. Its address in the base is a placeholder that reaches nothing, so both fail
until your overlay names yours, one `ipBlock` each (the patch above):

```sh
kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{"\n"}{end}'
```

They are the addresses NetworkPolicies see: a call to the `kubernetes` Service's IP is
translated to them first (on 443 or 6443, both let through). Set them again if your control
plane's addresses change. On Cilium, which matches the API server by identity rather than
address, add a `CiliumNetworkPolicy` with `toEntities: [kube-apiserver]` for the runner's and the
broker's pods instead.

Then `kubectl apply -k .` creates both namespaces, the services, their claims, Roles and
NetworkPolicies. The pods wait for their Secrets, next.

**3. The Secrets**, which the base doesn't hold. Each is one service's alone:

```sh
# The broker's signing key, its public key (a ConfigMap, nothing secret, mounted read only by
# the services that check tokens offline), and models.key. Once: new keys would refuse the
# running sandboxes' tokens and the sealed plan logins.
node deploy/kubernetes/secrets.mjs keys | kubectl apply -f -
# Your agents' credentials, the models service's alone (setup.md, Agents and providers).
kubectl -n deckhand create secret generic deckhand-models \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN=<from claude setup-token>
# Optional: the plans' logins (codex-auth.json, agy-auth.json: setup.md#the-credentials-folder).
kubectl -n deckhand create secret generic deckhand-credentials --from-file=codex-auth.json
```

**4. The GitHub App.** On a cluster, edge and the github service read the App's credentials
from Secrets, read only, so `/setup` stays closed. `secrets.mjs app` runs the same manifest flow
from your machine: open the address it prints, create the App on GitHub, and it prints edge's
Secret (the webhook secret, the OAuth client's, a new session key) and the github service's (the
App's key) for `kubectl`:

```sh
node deploy/kubernetes/secrets.mjs app --url https://deckhand.example.com [--org acme] \
  | kubectl apply -f -
```

Then install the App on your repositories (the page it ends on links there). Back up the three
Secrets (`deckhand-edge`, `deckhand-github`, `deckhand-broker-key`) with `deckhand-models-key`:
without them, Deckhand can't act as the App, check GitHub's webhooks, or renew the running
sandboxes' tokens. To change the App, delete `deckhand-edge` and `deckhand-github`, make them
again, and restart edge and the github service (`kubectl -n deckhand rollout restart deploy/edge
deploy/github`).

**5. Check the isolation** once every pod is ready (`kubectl -n deckhand get pods`):

```sh
sh deploy/kubernetes/check-isolation.sh
```

It starts a pod labelled as a sandbox in `deckhand-sandboxes`, tries every port of every service's
pod from there (their [metrics](#metrics) port too), the egress proxy's, and a second sandbox's pod
it starts beside it, listening, and expects the proxy's alone to answer: 3128, and 3129 too when
its Service publishes it (the `engine` component). A plugin that doesn't enforce NetworkPolicies fails it. The runner makes a check of its own as it starts
([The network probe](#the-network-probe)): its log says what it found. Then mention Deckhand on an issue
([setup.md, Use it](setup.md#3-use-it)): its first run starts a sandbox pod.

## Install with Helm

The chart, `deploy/helm/deckhand/`, renders the base's objects: with its default values, the same
as `kustomize build deploy/kubernetes` (CI checks it, alone and with each component:
`test/helm-chart.test.mjs`), so everything on this page holds for it. Its values do what an
overlay's patches do. No chart repository is published yet: install it from a checkout of this
repository at a release. Keep your values in a file of your own:

```yaml
# values.yaml
image:
  tag: v1.2.3 # every service's image, and SANDBOX_IMAGE's
apiServer:
  cidrs: [172.18.0.2/32] # the API server's addresses (Install, step 2)
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

```sh
helm install deckhand deploy/helm/deckhand -f values.yaml
```

The chart makes both namespaces itself, with their Pod Security labels, so its release goes in
another one (your context's, `default`): not `--namespace deckhand --create-namespace`, which
would make `deckhand` without them, and then refuse to make it again. With
`namespaces.create: false`, make them yourself, labelled as `namespaces.yaml` labels them. Then
carry on with [Install](#install)'s steps 3 to 5: the Secrets, the GitHub App and the isolation's
check, as the chart holds no Secret either. The pods wait for them: don't pass `--wait` to the
first install.

| Value                                       | Default                      | What it sets                                                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image.repository`, `image.tag`             | `ghcr.io/bryansmee/deckhand` | every service's image, `<repository>-<service>:<tag>`; the tag is the chart's `appVersion` (`latest`) when empty                                                                                                  |
| `image.sandbox`                             | `<repository>-sandbox:<tag>` | `SANDBOX_IMAGE` ([below](#what-the-manifests-set-up-and-why)), for a mirror of yours                                                                                                                              |
| `namespaces`                                | `deckhand`, `-sandboxes`     | the services' namespace and the sandboxes' ([Namespaces](#namespaces)), two different ones, and whether the chart makes them                                                                                      |
| `server.config`, `server.grants`            | the examples                 | `config.yaml` and the grants folder's files, by their path in it; `--set-file server.config=config.yaml` reads yours                                                                                              |
| `env`                                       | none                         | any other setting in `deckhand-env` ([setup.md](setup.md#settings)); one the other values set (`KUBERNETES_NAMESPACE`, `SANDBOX_IMAGE`…) is refused, naming the value to use                                      |
| `apiServer.cidrs`                           | a placeholder                | the API server's addresses ([Install](#install), step 2)                                                                                                                                                          |
| `store`                                     | `file`                       | `redis` for the `redis` component ([Several nodes](#several-nodes)), with `redis.image`, `redis.size` and `redis.storageClass`                                                                                    |
| `persistence.storageClass`, `.sizes`        | the cluster's default        | the services' claims; with `redis`, `persistence.sharedStorageClass` for the `ReadWriteMany` ones                                                                                                                 |
| `sandboxes.storageClass`, …                 | unset                        | `KUBERNETES_STORAGE_CLASS`, `KUBERNETES_CACHE_STORAGE_CLASS` and `KUBERNETES_AGENT_STORAGE_CLASS` ([Agents](#agents-on-kubernetes), [Caches](#caches-on-kubernetes))                                              |
| `buildkit.enabled`, `registry`              | off                          | the `buildkit` component ([Repo images](#repo-images)): `registry.url` is `KUBERNETES_REGISTRY` (refused without BuildKit), `registry.secretName` its pull Secret                                                 |
| `blobs.enabled`, `.url`, `.to`, `.ports`    | off                          | the `blobs` component ([Blob storage](#blob-storage)): `BLOB_URL` and the `blobs.secretName` Secret (`deckhand-blobs`) for the runner and the broker alone, their way to its address (placeholders until set)     |
| `engine.enabled`, `.image`, `.runtimeClass` | off                          | the `engine` component ([Container engine](#container-engine-on-kubernetes)): `SANDBOX_ENGINE=sysbox`, `ENGINE_IMAGE` (`<repository>-engine:<tag>` when empty), `KUBERNETES_ENGINE_RUNTIME_CLASS` (`sysbox-runc`) |
| `metrics.port`, `.namespace`                | `9464`, `monitoring`         | the services' metrics port, and the only namespace that reaches it ([Metrics](#metrics)); `metrics.serviceMonitor` adds a `ServiceMonitor` or a `VMServiceScrape` for them                                        |
| `ingress`                                   | off                          | an Ingress to edge's port 8080 for `ingress.host`, with `className`, `annotations` (cert-manager's, say) and `tlsSecretName`                                                                                      |

`values.yaml` in the chart says more of each. `store`, `persistence.storageClass`,
`persistence.sharedStorageClass` and `redis.storageClass` are fixed at install: a claim's access
mode and class can't change, so an upgrade that changes them fails on the claims it would
change, and going to `redis` leaves the stores' claims (kept, with what they hold) unused. To
move, scale the services to 0, copy what the claims hold (or let the stores start empty,
losing what they hold: [setup.md](setup.md#the-store)), delete the claims that change, then
upgrade. To update, change `image.tag` and
`helm upgrade deckhand deploy/helm/deckhand -f values.yaml`, from a checkout at the new release:
the services update as [below](#updating). A change of `server` or `env` renames its ConfigMap,
as kustomize's hash does, and the pods that read it restart. The old one stays, as
`kubectl apply -k` leaves kustomize's: an old pod rescheduled while a bad config stalls the
rollout still starts. They pile up, as kustomize's do; delete those no pod names. The base's objects, made by
`kubectl apply -k`, aren't the chart's: Helm refuses to install over them, so pick one, or let
Helm adopt them (the `meta.helm.sh/release-name` and `meta.helm.sh/release-namespace`
annotations and the `app.kubernetes.io/managed-by: Helm` label on each) before the first install.
`helm uninstall` keeps both namespaces and the services' claims (`helm.sh/resource-policy: keep`),
with your Secrets and the stores in them, and the sandboxes' NetworkPolicies: the runner makes the
sandbox pods itself, so a run going on at that moment keeps running, isolated as before, with no
proxy left to reach. Remove those pods (`kubectl -n deckhand-sandboxes delete pods --all`), or
delete both namespaces to remove everything.

## Updating

Change the tag in `images:` and `SANDBOX_IMAGE`, then `kubectl apply -k .`. Every service updates
without stopping ([services.md](services.md#upgrades-without-downtime)): a rolling update starts
the next copy before the old one stops (`maxUnavailable: 0`, `maxSurge: 1`), which drains within
its grace period. The orchestrator's and the runner's copies hand their lease over: the old one
releases it on SIGTERM and the new one takes it at once. Running sandboxes go on.

Every service has a liveness probe on `/health`: a process that stops answering is restarted
after a minute. Edge, the github and models services and the egress proxy answer `/ready` only
once the broker has answered them (edge and the github and models services its keys and their
service tokens, the proxy its service tokens): a new pod may not get out for a
few seconds after it starts (k3s's kube-router applies its NetworkPolicies then), and the calls
it took meanwhile would fail. The orchestrator's and the
runner's readiness is `/health` too, not `/ready`, as Compose's health checks
([setup.md](setup.md#health-checks)): `/ready` answers on the acting copy alone, and the
next copy only acts once the old one has stopped, so a rolling update waiting for it never ends.
Both copies sit behind their Service; the waiting one answers `503` with the connection closed
(and opens no egress policy port), so a caller's next try reaches the copy that acts.

The egress proxy runs one copy, and a second during an update: its old copy drains for 600 s, as
long as an agent's call lasts, after a 10 s pause that lets the Service stop sending it new
connections (agents, git and `gh` don't try a refused one again). Two at all times would each
make their own CA in its volume, which the sandboxes trust one of.

## Checking a cluster end to end

`deploy/kubernetes-e2e/run.sh` deploys the base on a cluster with this checkout's images, GitHub
and Anthropic replaced by fakes in a namespace of their own (`fakes.mjs`: GitHub's API and a
repository over git's smart HTTP, a scripted model, both over HTTPS from a CA the script makes),
then checks one run from start to end:

1. `check-isolation.sh` passes: a sandbox's pod reaches the egress proxy alone, not another sandbox's;
2. a signed comment on an issue, sent to edge, starts a sandbox pod, whose agent (Claude Code, at
   its pinned version) talks to the fake model through the models service;
3. a second comment is sent while the agent works, and every service is updated
   (`kubectl rollout restart`); the fake model keeps the agent working until the last rollout
   is done, each turn a command that calls GitHub through the egress proxy for 20 s
   (`git ls-remote`, and `gh api` through the GitHub gateway, every 2 s);
4. the reply is posted once and names the second comment, so it reached the agent;
5. none of the run's calls failed: no turn's command failed, the fake model got no call twice
   (Claude Code tries a failed API call again by itself), and the run's log has no retry or
   connection error;
6. no sandbox pod is left.

```sh
K3S=k3s deploy/kubernetes-e2e/run.sh   # in a k3s container on Docker, started if missing, then kept
deploy/kubernetes-e2e/run.sh           # on the cluster kubectl points at (images loaded on its nodes)
```

**Use it on a cluster you can throw away**, never on one with Deckhand installed. It installs
Deckhand, with settings and Secrets of its own, in the namespaces `deckhand`,
`deckhand-sandboxes` and `deckhand-e2e`, with the base's ClusterRoleBinding
`deckhand-broker-auth-delegator`, and deletes them when it ends, whatever the outcome. It labels
them `deckhand.e2e=true`, and refuses to start when one of them exists without that label (a
real install's would be overwritten, then deleted), or when the cluster can't say whether it
does. `KEEP=1` leaves them for a look, and the next run deletes them before it starts.

CI renders the overlay on every pull request without a cluster (#676): kubeconform validates it,
and `test/kubernetes-e2e-overlay.test.mjs` checks that it installs nothing outside those
namespaces and that binding, everything labelled, and that each of its patches still finds its
target in the base (kustomize skips one that doesn't, without a word). A change to the base that
breaks the check fails there, before anyone runs it.

It takes about five minutes on k3s, mostly building the images. It needs `docker`, `node` and
`openssl` where it runs, and `kubectl` without `K3S`. With `K3S` (or `PREINSTALL_AGENT=1`) it
puts Claude Code in the agent's claim beforehand ([Agents on Kubernetes](#agents-on-kubernetes)),
so the cluster's pods need no way to npm's registry; otherwise the run installs it through the
egress proxy. No CI job runs it: k3s needs a privileged container. With `K3S`, the k3s container (privileged) stays for the next run, its images loaded: `docker rm -f k3s` removes it.

## Several nodes

The base keeps each service's store on its own `ReadWriteOnce` claim, which pods on one node
share: each service's copies stay on one node (`podAffinity`), and the file store serves them
both (setup.md, [The store](setup.md#the-store)). For copies on several nodes, add the `redis`
component:

```yaml
components:
  - https://github.com/BryanSmee/deckhand//deploy/kubernetes/components/redis?ref=v1.2.3
```

It runs Valkey (Redis's protocol, `deploy/kubernetes/components/redis/redis.yaml`), kept on disk
(append-only, fsync every second) and never evicting, with one user per service, each allowed the
store's commands on its own keys (`deckhand:<service>:`) alone, and moves every store there. The
orchestrator's user can also list its keys (`SCAN`), which Redis doesn't hold to a user's keys:
it sees the other services' key names, never their values. Make
its Secret first, one password per service (letters and digits): each service's pods read their own
key of it alone, and Redis reads them all, to make its users:

```sh
kubectl -n deckhand create secret generic deckhand-redis $(for s in edge orchestrator runner \
  broker github models; do printf -- '--from-literal=%s=%s ' "$s" "$(openssl rand -hex 24)"; done)
```

Then edge, the broker, the github and models services keep nothing on disk, and their copies go
to any node. The orchestrator's state (and the screenshots it kept before #609) and the runner's inboxes are still files
(until #613 moves them to the store): their claims become `ReadWriteMany`, which your default
storage class has to provide (or a patch giving them a `storageClassName`), so a copy taking over
on another node finds them. The proxy's copies stay on one node (their CA). Redis's own update is
a restart of a few seconds, which the services wait through.

## Blob storage

With the `redis` component, the runs' logs and screenshots take Redis's memory: the runner and the
broker say so at start, and on the dashboard's status page. Blob storage (setup.md,
[Blob storage](setup.md#blob-storage)) takes them out of it; the `blobs` component gives it to
the runner and the broker, and to no other service:

```yaml
components:
  - https://github.com/BryanSmee/deckhand//deploy/kubernetes/components/redis?ref=v1.2.3
  - https://github.com/BryanSmee/deckhand//deploy/kubernetes/components/blobs?ref=v1.2.3
patches:
  # BLOB_URL, in a ConfigMap of the runner's and the broker's alone (not deckhand-env, which
  # the orchestrator and the models service read too). A patch, not a generator's merge: the
  # component's ConfigMap isn't there yet when your generators run.
  - target:
      kind: ConfigMap
      name: deckhand-blobs
    patch: |
      - op: replace
        path: /data/BLOB_URL
        value: s3://deckhand?endpoint=https://s3.eu-west-1.amazonaws.com&region=eu-west-1
  # Their way to it: its addresses and port (blobs.yaml), in place of the placeholder.
  - target:
      kind: NetworkPolicy
      name: deckhand-blobs
    patch: |
      - op: replace
        path: /spec/egress/0/to
        value:
          - ipBlock:
              cidr: 0.0.0.0/0
```

with its key pair in a Secret `deckhand-blobs` in `deckhand`, which their pods alone mount, read
only (`BLOB_ACCESS_KEY_ID_FILE` and `BLOB_SECRET_ACCESS_KEY_FILE` name its files):

```sh
kubectl -n deckhand create secret generic deckhand-blobs \
  --from-file=access-key-id=./access-key-id --from-file=secret-access-key=./secret-access-key
```

The placeholders (`BLOB_URL`'s `blobs.invalid`, the policy's `192.0.2.2`) reach nothing: the
two services stop at start, saying what failed, until both are yours. The NetworkPolicy's way out
is the one place to narrow: a hosted service's addresses when it publishes them (Amazon S3's
ranges, `ip-ranges.json`), else `0.0.0.0/0` on 443 as above, which is a way to any HTTPS host
for those two pods. Blob storage in the cluster (Garage's pods, setup.md's
[Garage on its own](setup.md#garage-on-its-own)) is a `podSelector` instead, with a
`namespaceSelector` when it runs in another namespace, and its port (Garage's S3 is on 3900):

```yaml
- op: replace
  path: /spec/egress/0
  value:
    to:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: garage
        podSelector:
          matchLabels:
            app: garage
    ports:
      - port: 3900
        protocol: TCP
```

That namespace's own policies have to let them in. With Helm, `blobs.enabled`, `blobs.url`,
`blobs.secretName`, `blobs.to` (the peers above) and `blobs.ports`.

## Metrics

Every service serves Prometheus metrics on a port of its own, 9464 (`METRICS_PORT`, in each
Deployment: [setup.md](setup.md#metrics) says what they say), for Prometheus or VictoriaMetrics
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
  scraper's, by its `kubernetes.io/metadata.name`, and nothing else; never the sandboxes',
  which [the network probe](#the-network-probe) and `check-isolation.sh` try it from, as every
  other port. The base names `monitoring`: an overlay names yours (if its own policies deny
  egress, let it out to the services' namespace on 9464 too):

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

With the chart, `metrics.namespace` is that namespace and `metrics.port` the port, everywhere
the base says 9464. `metrics.serviceMonitor.enabled` adds a `ServiceMonitor` (the Prometheus
Operator's) or, with `metrics.serviceMonitor.kind: VMServiceScrape`, VictoriaMetrics' operator's,
in the services' namespace: each Service's `metrics` port, with `metrics.serviceMonitor.labels`
for your operator's selector (`release: kube-prometheus-stack`, say) and `.interval`. Its CRD has
to be in the cluster first: off by default. It keeps Deckhand's own `service` label
(`honorLabels`), which is the Service's name already.

## Repo images

A repository granted its own image (`dockerfile`) is built by BuildKit in the cluster and pushed
to your registry ([below](#repo-images-on-kubernetes)). The `buildkit` component runs rootless
BuildKit with the NetworkPolicies the runner checks, and names the registry's pull Secret:

```yaml
components:
  - https://github.com/BryanSmee/deckhand//deploy/kubernetes/components/buildkit?ref=v1.2.3
configMapGenerator:
  - name: deckhand-env
    namespace: deckhand
    behavior: merge
    literals:
      - KUBERNETES_REGISTRY=registry.example.com/deckhand
```

with a `kubernetes.io/dockerconfigjson` Secret `deckhand-registry` in `deckhand`, whose
credentials may pull, push and delete (`kubectl -n deckhand create secret docker-registry
deckhand-registry --docker-server=registry.example.com --docker-username=… --docker-password=…`).
Rootless BuildKit needs neither seccomp nor AppArmor to stop it (it makes user namespaces): the
component lets the services' namespace run it (Pod Security `privileged` enforced there, still
warning of every pod that isn't `restricted`). The sandboxes' namespace stays `restricted`.

## Not supported yet

- **Host mounts** (`mounts`): a run of a repository with some is refused, with a reply naming
  the runner.
- **A repository's own image** (`dockerfile`) without `KUBERNETES_REGISTRY`
  ([Repo images](#repo-images)).

A container engine (`docker`) runs through Sysbox's RuntimeClass:
[Container engine on Kubernetes](#container-engine-on-kubernetes), which also says when a run
that would get one is still refused.

## What the manifests set up, and why

The runner checks the cluster before every run and refuses to start one it can't isolate,
saying why. What it expects, and the manifests give it:

- **RBAC** (`rbac.yaml`): a Role for the runner's ServiceAccount in the sandboxes' namespace,
  `create`, `get`, `list` and `delete` on `pods` and `secrets`, `create`, `get` and `delete` on
  `persistentvolumeclaims` (the agents', caches' and sessions'), `get` on `pods/log`, `create`
  and `get` on `pods/attach` (the Antigravity CLI's login refresh, [Agents](#agents-on-kubernetes):
  Kubernetes checks `create` from 1.35, `get` before), and `list`
  on `events` (why a pod is stuck) and `networkpolicies`; and in the services' namespace, `get`
  on `pods` (BuildKit's), `get` and `list` on `services` (the proxy's Service, and every one
  for [the network probe](#the-network-probe)), `list` on `networkpolicies` and
  `endpointslices`. The `buildkit` component adds `get` on the registry's pull Secret alone
  (`resourceNames: [deckhand-registry]`) and `update` on that Secret's copy in the sandboxes'
  namespace alone (`resourceNames: [deckhand-registry]` too). Nothing cluster-wide but the broker's binding to `system:auth-delegator`,
  which lets it review the tokens its callers present (TokenReview is cluster-scoped). Only the
  runner's and the broker's pods mount their ServiceAccount's API token.
- **Service tokens bound to the pod**: each service that calls another gets its own service
  tokens from the broker by presenting a token projected for it (a `serviceAccountToken` volume,
  `audience: deckhand-broker`, `SERVICE_ACCOUNT_TOKEN_FILE`), and the broker tells callers apart
  by their ServiceAccount (`SERVICE_ACCOUNTS`, one each). `SERVICE_NETWORKS=none` on the others:
  every call arrives at a pod's one address, and the NetworkPolicies let in each service's
  callers alone. The services that check tokens offline (the runner, the models and policy
  services) read the broker's public key from the `deckhand-service-keys` ConfigMap, read only:
  the broker publishes none on a cluster (no volume is shared between services).
- **NetworkPolicies** (`network-policies.yaml`, `sandboxes.yaml`): default deny in both
  namespaces; each service lets in its callers alone, on its port, and reaches its callees and
  DNS alone (`lib/services.mjs` `CALLS`, as Compose's networks; `test/kubernetes-manifests.test.mjs`
  holds them to it). Edge alone is reached from outside; edge, the github and models services
  reach the internet on 443, the runner and the broker the API server's addresses alone
  (`deckhand-api-server`, [Install](#install) step 2; the runner the registries on 443 too with
  `buildkit`), and the proxy any host
  but the private ranges (add yours to its policy to grant a host of your network). The policy
  service reaches nothing. Every service's metrics port is your monitoring namespace's alone
  (`deckhand-metrics`, [Metrics](#metrics)).
- **The sandboxes' NetworkPolicies**: their pods are labelled `deckhand.role: sandbox`. One
  policy has to pick them for both `Ingress` and `Egress`, and none that picks them may let
  anything in, or let them out to anything but the egress proxy's pods, each rule naming the
  proxy's port alone (`EGRESS_PROXY`'s: never the orchestrator's services port, which gives the
  runner's tokens). With the services in their own namespace, each peer names that namespace by
  its `kubernetes.io/metadata.name` and asks for every label of the egress proxy Service's
  `selector`, so it picks no pod the Service doesn't:

  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata: { name: deckhand-sandboxes, namespace: deckhand-sandboxes }
  spec:
    podSelector: { matchLabels: { deckhand.role: sandbox } }
    policyTypes: [Ingress, Egress]
    egress:
      - to:
          - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: deckhand } }
            podSelector: { matchLabels: { app: deckhand-egress } }
        ports: [{ port: 3128 }]
  ```

  In one namespace with the services (`KUBERNETES_SERVICES_NAMESPACE` unset), a peer is a
  `podSelector` alone that never picks a sandbox (no `ipBlock`, no `namespaceSelector`).

- **The egress proxy's Service**, named after the host of `EGRESS_PROXY` (`egress` on 3128, and
  on 3129 too with the `engine` component: [Container engine on Kubernetes](#container-engine-on-kubernetes)),
  with a cluster IP, and the orchestrator's on 8082 for the proxy's `POLICY_URL`. Sandboxes get
  no DNS server (a lookup fails at once): their pods map the proxy's name to its Service's IP
  (`hostAliases`). The services' names sandboxes call (`http://broker:8081`,
  `http://github:8080`, `http://models:8080`) are the proxy's to read, whatever the services'
  own Services are named: it sends their calls to its `BROKER_SERVICE_URL`,
  `GITHUB_SERVICE_URL` and `MODELS_SERVICE_URL`. The orchestrator tells the proxy's calls by
  its pods' addresses (the Service's EndpointSlices, which it asks the runner): nothing may
  stand between them that changes the source address (a service mesh's sidecar, say).
- **Temporary files in memory**: the github service's `/tmp` (the pushes of repositories
  granted `workflows`, up to 2 GiB each, while checked) and the runner's (checkouts for build
  contexts) are 2 GiB tmpfs (`emptyDir` with `medium: Memory`): one that would go over it fails
  with `ENOSPC`, that push or that build alone. A disk `emptyDir` over its `sizeLimit` gets its
  pod evicted instead, cutting every call it serves. A tmpfs is charged to its pod's memory, so
  both pods request 3 GiB (the tmpfs and the process), with the same limit: the scheduler keeps
  the room, the pod's own cgroup bounds it, and node memory pressure evicts other pods first. To
  take two large pushes at once on one copy, raise `sizeLimit`, the request and the limit
  together.
- **No `<SERVICE>_PORT` variables** (`enableServiceLinks: false`): Kubernetes would set
  `POLICY_PORT=tcp://…` from the `policy` Service, which the services read as a setting of
  theirs, and stop at start.
- **Pod security**: every service runs as uid 1000, on a read-only root, without capabilities,
  as Compose runs them (the runner too: it needs root for the Docker socket alone). The
  orchestrator's claims are written by it through `fsGroup: 1000`. A storage class that ignores
  `fsGroup` (`hostPath`, some NFS) leaves a claim an earlier release wrote root's, and the
  orchestrator refuses to start, saying so: hand it over once, with the orchestrator scaled to
  0, by an init container from its image with the same mounts, removed once it has run:
  `runAsUser: 0`, `capabilities: { drop: [ALL], add: [CHOWN] }`,
  `command: [chown, -R, "1000:1000", /data]`.

`SANDBOX_IMAGE` has to be a reference the nodes can pull, from a registry
(`ghcr.io/bryansmee/deckhand-sandbox:<version>`), ideally a version tag or a digest. A `:latest`
or untagged one is pulled again at every start; a node keeps a pinned one. The sandbox image
has to match the orchestrator's version: an older entrypoint doesn't tag its stderr lines, and
its setup output would read as the agent's.

Each sandbox pod meets Pod Security `restricted` (uid 1000, no capability, no privilege gain,
the runtime's seccomp profile), gets no ServiceAccount token, and runs with its grant's CPU and
memory as both its requests and its limits. Its environment is in a Secret of its own, deleted
with the run. An issue's clone and agent session are claims of their own
(`KUBERNETES_STORAGE_CLASS`, `KUBERNETES_SESSION_SIZE`), kept between its runs. A pod that
stays Pending longer than `KUBERNETES_PENDING_MINUTES` (no node with the room, an image it
can't pull) is removed, and its run fails with Kubernetes' reason in its reply.

### The network gate

Some network plugins apply a new pod's NetworkPolicies a moment after it has its address: k3s's
kube-router from the pod's events, and Calico once its agent has programmed the pod, unless its
CNI plugin is set to wait for that (`linuxPolicySetupTimeoutSeconds`). Cilium's CNI plugin waits
for the pod's first policy before its containers start. In between, the pod's traffic isn't
filtered. So every pod the runner makes in the sandboxes' namespace (the sandboxes, the agents'
install pods and jobs, the caches' checks, the network probe) starts with an init container,
`network-gate`, from `SANDBOX_IMAGE`, before anything else of the pod runs. Every half second, it
tries a TCP connection (3 s at most each) to:

- the API server, at the `kubernetes` Service's address (`KUBERNETES_SERVICE_HOST`), and the
  cluster's DNS (the runner's own nameservers, TCP 53): no pod of that namespace may reach them,
  and the runner does, so they answer whatever doesn't filter them;
- the egress proxy, for a pod that goes out through it (not a cache's check, which reaches
  nothing).

It ends once the first are out of reach (refused, or no answer) and the proxy answers: the pod's
rules are in place, not its network merely down. On a plugin that applies them by then, that is
one round, about 3 s (its connections giving up). Otherwise it fails, and its pod with it,
before anything of the run, 30 s before the runner would give up on the pod:
`KUBERNETES_PENDING_MINUTES` after its creation (a cache's check or a job: their own, shorter,
limit). The reply on the issue then says what it still reached (`its NetworkPolicies didn't
apply: still reached the Kubernetes API server (…) after 570 s`), or that the proxy never
answered. Its deadline is a time, read on the node's clock: one far off the runner's leaves the
pod Pending until the runner removes it, its reply saying the gate was still waiting.

What it waits for is one of the pod's rules applied, seen through two addresses its policies
forbid and one they allow; it takes the rest to be applied with them. kube-router applies a pod's
rules together, in one sync of its iptables chains, and Calico and Cilium compute a pod's policy
whole before they program it. A plugin that applied them one rule at a time could leave the
others unapplied a moment more: [the probe](#the-network-probe), which runs after its own gate and
tries every address it knows, would then see them reached more often than not.

### The network probe

The checks above read what the NetworkPolicies say; a network plugin that ignores them takes
them all the same. So the runner also checks that the cluster applies them: each time it takes
its lease (as it starts, or as its other copy hands over), it starts a probe pod in the
sandboxes' namespace, `<prefix>-network-probe-<random>`, from `SANDBOX_IMAGE`. It has a sandbox's labels
(`deckhand.role: sandbox`), so the sandboxes' policies pick it, meets Pod Security
`restricted` as they do, and holds no Secret, claim or ServiceAccount token. Once its
[network gate](#the-network-gate) has seen its policies apply (a verdict on what the cluster
enforces, not on how fast it applies it), it tries a TCP connection, 3 s at most each, to:

- every port of every Service of the services' namespace, at its cluster IP and at one of its
  pods' addresses (some plugins treat the two differently): edge, the orchestrator, the runner,
  the broker, the github, models and policy services, BuildKit, Redis, whatever else is there,
  their [metrics](#metrics) port included, the egress proxy's too;
- with `KUBERNETES_REGISTRY` set, the registry's host and BuildKit's (`KUBERNETES_BUILDKIT`),
  and with `STORE_URL=redis://…`, Redis's, as the runner resolves them, wherever they are;
- the cluster's DNS (the runner's own nameservers, the `kube-dns` Service), TCP and UDP 53:
  sandboxes get no DNS server, but one reached by its address could carry data out in its
  lookups;
- the API server, at the `kubernetes` Service's address (`KUBERNETES_SERVICE_HOST`);
- a public address, `1.1.1.1:443`.

Every one has to be out of reach, and the egress proxy's Service has to answer, so that a pod
with no network at all doesn't pass as isolated: on `EGRESS_PROXY`'s port, and on the engines'
(3129) too when runs get a [container engine](#container-engine-on-kubernetes) and the Service
publishes it. Any one reached, and the runner refuses every
run, the reply on the issue (and the dashboard) naming what the probe reached: use a plugin that
enforces NetworkPolicies (Calico, Cilium, k3s's kube-router; Flannel alone doesn't). On a plugin
that doesn't, the probe pod's gate never sees the API server or the DNS out of reach: that
verdict comes once it gives up, after `KUBERNETES_PENDING_MINUTES`, the runs meanwhile waiting
for it. The probe
pod is removed whatever it found, and its verdict kept until the NetworkPolicies of either
namespace change (the runner reads them before every run) or the runner takes its lease again:
after a change of plugin, restart it (`kubectl -n deckhand rollout restart deploy/runner`). A
probe that couldn't tell refuses that run alone, and the next one probes again: its pod didn't
end within `KUBERNETES_PENDING_MINUTES` and a minute, say, or its gate never reached the egress
proxy (not ready yet on a fresh install, its pod evicted), or the probe itself didn't. Each
probe's pod has a name of its own, so a runner copy taking over doesn't remove the other's
mid-probe; one older than a probe lasts (a runner stopped mid-probe) is removed at the next
probe. Its log lines start with
`Network probe:`. The API server's own addresses, behind the `kubernetes` Service, and the
DNS pods' aren't tried: the runner has no right to read them.

## Namespaces

Two settings, which may name one namespace (the default) or two:

- **The sandboxes' namespace** (`KUBERNETES_NAMESPACE`, by default the runner's own): the
  sandbox pods, the agents' install pods and the caches' checks, the runs' Secrets, the
  sessions', agents' and caches' claims, and the sandboxes' NetworkPolicies. Nothing else
  runs there, so it can enforce Pod Security `restricted`
  (`pod-security.kubernetes.io/enforce: restricted` on the namespace), a last line should a
  pod's own spec ever be wrong.
- **The services' namespace** (`KUBERNETES_SERVICES_NAMESPACE`, by default the sandboxes'):
  every service (edge, the orchestrator, the runner itself, the broker, the github, models
  and policy services, the egress proxy), their Secrets, BuildKit (rootless BuildKit can't
  meet `restricted`), an in-cluster registry and the registry's pull Secret. The runner runs
  here too. With the namespaces apart, it reaches BuildKit as
  `<KUBERNETES_BUILDKIT's host>.<services' namespace>.svc`, so the daemon it builds on is the
  one whose NetworkPolicies it checked, wherever it runs (the short name resolves in the
  runner's own namespace).

With two, the runner reads the proxy's Service and EndpointSlices and BuildKit's endpoints,
pods and NetworkPolicies in the services' namespace, and keeps a copy of the registry's pull
Secret (`KUBERNETES_REGISTRY_SECRET`) in the sandboxes', under the same name and labelled
`deckhand.role: registry`, as a pod pulls only with a Secret of its own namespace: made at the
first pod that needs it, brought up to date within a minute of a change. A Secret of that
name there that isn't its copy (both labels, `deckhand.owner` and `deckhand.role: registry`)
is neither overwritten nor used, even when it holds the same credentials: runs are refused,
saying so, until it is removed. The proxy's
own NetworkPolicy, in the services' namespace, lets in the sandboxes' namespace's sandbox and
install pods on its port, and whatever of the services' namespace goes out through it too:
BuildKit's pods ([below](#repo-images-on-kubernetes), their `HTTPS_PROXY`). A policy that picks
the proxy's pods for `Ingress` drops all it doesn't let in, so leaving them out fails every
repo image's build, which the runner's check of BuildKit's own policies doesn't see
(`network-policies.yaml`'s `deckhand-egress` lets them in, with the orchestrator):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: deckhand-egress-ingress, namespace: deckhand }
spec:
  podSelector: { matchLabels: { app: deckhand-egress } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: deckhand-sandboxes } }
          podSelector:
            matchExpressions: [{ key: deckhand.role, operator: In, values: [sandbox, install] }]
        - podSelector: { matchLabels: { app: buildkitd } } # BuildKit, in this namespace
      ports: [{ port: 3128 }]
    # With container engines (Container engine on Kubernetes below): the sandboxes' pods on
    # the engines' port too.
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: deckhand-sandboxes } }
          podSelector: { matchLabels: { deckhand.role: sandbox } }
      ports: [{ port: 3129 }]
```

Install pods reach the proxy by its Service's IP there (`hostAliases`, as sandboxes do), not
through the cluster's DNS, which doesn't know its short name in the sandboxes' namespace.

## Repo images on Kubernetes

A repository granted its own image (`dockerfile`, and `branch_docker_images` for a
pull request's branch, under the same rules as on Docker: never a fork's) is built in the
cluster and pushed to a registry, as nodes only pull from one:

- **A registry** (`KUBERNETES_REGISTRY`), reached over HTTPS, that the nodes can pull from.
  Repo images are named `<KUBERNETES_REGISTRY>/<NAME_PREFIX>-repo-<repo>-<hash>`, tagged as on
  Docker: the same base image (its digest in its registry) and Dockerfile reuse a tag, a
  change builds a new one. Old tags are pruned through the registry's API as on Docker (the
  default branch's newest and the newest few kept, never one a pod runs), so it has to allow
  deletes (`REGISTRY_STORAGE_DELETE_ENABLED=true` for the CNCF distribution registry); one that
  doesn't keeps its tags, which the runner logs. A tag whose manifest a kept one shares (an
  identical build) is deleted alone where the registry can, else kept. A tag whose date the runner can't read is kept, and logged.
- **A pull Secret** (`KUBERNETES_REGISTRY_SECRET`, required with `KUBERNETES_REGISTRY`: the
  runner doesn't start without it), of type `kubernetes.io/dockerconfigjson`, whose
  credentials may pull from, push to and delete from the registry. The registry has to require them for all three, pulls included: sandboxes and builds can reach an in-cluster one, any run's sandbox among them (a research run's, a fork's, a repository's without the `dockerfile` grant). A registry that lets anyone push would let one run replace another repository's image, which then runs with that repository's grant; one that lets anyone pull would let any run read every repository's image, which holds whatever its Dockerfile copied of a private checkout. (On Docker, sandboxes can't read the host's images.) An in-cluster registry is best also kept out of the sandboxes' reach: a NetworkPolicy that lets only the runner, BuildKit and the nodes in. Sandbox pods, install pods and init containers pull with this Secret,
  and the runner reads it (its Role's `get` on `secrets` covers it) to push through BuildKit
  and prune. It lives in the services' namespace; with the sandboxes apart, the runner copies
  it to theirs ([Namespaces](#namespaces)). It replaces the ServiceAccount's own `imagePullSecrets`, which Kubernetes adds
  only to a pod that lists none: when `SANDBOX_IMAGE` comes from a private registry, the
  Secret has to hold that registry's credentials too. For a repository with its own image,
  `SANDBOX_IMAGE` has to be readable through its registry's API as well: the runner reads
  its digest there (anonymously for a public one, such as ghcr.io's releases). Runs on the
  base image alone don't look it up: the nodes pull it as they can.
- **A BuildKit daemon** (`moby/buildkit`, rootless), a Deployment with a Service named after
  `KUBERNETES_BUILDKIT`'s host, in the services' namespace. The runner drives it with `buildctl`
  (in its image), with the checkout as the build's context and `DECKHAND_BASE` as on Docker.
  Only the runner may reach it, and it goes out only through the egress proxy: set
  `HTTPS_PROXY` and `HTTP_PROXY` to `EGRESS_PROXY` in its Deployment, with `NO_PROXY` for an
  in-cluster registry, and give its pods NetworkPolicies that one picks for `Egress` and one
  for `Ingress`, letting them out to the namespace's pods only (the proxy, an in-cluster
  registry) and to DNS (UDP or TCP port 53, no `endPort`), and in only from the namespace's pods (no `namespaceSelector`, never the sandboxes' namespace). In one namespace with the sandboxes, those have to be pods that can't be sandboxes (the runner's: a peer has to ask for a label sandbox pods don't have, or a `deckhand.role` other than `sandbox`, as a sandbox's own policy lets it reach any pod but another sandbox); apart, any pod of the services' namespace may be let in. The
  runner checks them before every build, as it checks the sandboxes', and refuses to build
  otherwise, saying why (the Role's `get` on `pods` and `list` on `networkpolicies` and
  `endpointslices` cover it). The proxy asks the orchestrator about the daemon's pod IPs (the
  endpoints of its Service): while a build runs, they may reach that run's hosts (the repo's
  grant) and the registries of the image and its base, with the hosts those send a puller to
  (Docker Hub's token service and layer storage, ghcr.io's layer storage, the token services
  Deckhand has seen, and `KUBERNETES_REGISTRY_HOSTS`), tunnelled, never decrypted, and
  nothing between builds. A Dockerfile that pulls from another registry (`FROM node:26` in a
  stage) needs that registry's hosts in the repository's grant. Builds of repositories
  granted other hosts wait for each other, in order of arrival, so one repository's
  Dockerfile never reaches another's grant; a build stops after an hour. Its `RUN` steps get
  the proxy as build arguments (`HTTP_PROXY`, `HTTPS_PROXY`).

## Agents on Kubernetes

Each agent (Claude Code, Codex, the Antigravity CLI) is installed once per version into a
claim named after its volume (`CLAUDE_CODE_VOLUME`, `deckhand-claude-code` by default), which
every sandbox mounts read-only, as on Docker:

- **With `KUBERNETES_AGENT_STORAGE_CLASS`** (by default `KUBERNETES_CACHE_STORAGE_CLASS`), a
  `ReadWriteMany` class (NFS, CephFS, EFS…), or a claim of that name made beforehand: the
  runner makes the claim when it is missing, and before the first run of each version a pod
  of its own (`deckhand.role: install`), in the sandboxes' namespace, runs the base image's installer into it, then goes. It
  meets Pod Security `restricted`: it runs as uid 1001, neither root nor the sandbox's user,
  so no sandbox can change what the next one runs, and sandboxes mount the claim read-only.
  It goes out through the egress proxy, which lets it reach its agent's install hosts only
  (npm's registry; GitHub's releases for the Antigravity CLI): its NetworkPolicy has to let it
  reach the proxy (and, in one namespace, the cluster's DNS, as it resolves `egress` there;
  with the services apart, it gets the proxy's IP through `hostAliases` instead).
- **Without either**, each sandbox installs its agent itself, in an init container (uid 1001
  too) that fills an `emptyDir` the sandbox then mounts read-only: no shared storage, but a
  slower start, which counts toward `KUBERNETES_PENDING_MINUTES`. While its pod is still
  Pending (the init container running), the egress proxy lets it reach the agent's install
  hosts only, nothing of the run's own; once the sandbox starts, those hosts are gone again.
  A failed install fails the run, with the installer's output in the run's log.

The Antigravity CLI's plan login ([setup.md](setup.md#antigravity-cli)) is refreshed by a pod of its
own, `<NAME_PREFIX>-job-antigravity-refresh`, in the sandboxes' namespace, at the models service's
call (the runner's NetworkPolicy lets it in for that). It meets Pod Security `restricted` as the
sandbox's user, with no ServiceAccount token and no Secret. The runner sends it the token file on
its stdin and reads back the refreshed one from its stdout, through the API server (`pods/attach`,
over WebSocket, `v5.channel.k8s.io`: Kubernetes 1.30 or later), never through its spec; `~/.gemini`
is an `emptyDir` there, no claim. It mounts the agent's claim read-only (or, without one, installs
the CLI in an init container, as sandboxes do: a failed install's last line is in the refresh's
error, which the runs on the login fail with). It is labelled `deckhand.role: install`, so
`deckhand-installs` (`sandboxes.yaml`) covers it: the egress proxy lets it reach Google's OAuth
(`oauth2.googleapis.com`) and the CLI's own hosts only, tunnelled (and GitHub's releases while its
init container installs the CLI, never once `agy` runs). It has 4 minutes in all, the CLI's install
included, and never more than what is left of the models service's 5-minute hold on the login, a
minute to spare: each try of the service's call says what is left at that moment (and the service
stops asking a runner that doesn't answer, during a handover, once too little is), and a refresh
with under 30 seconds to go isn't started. So no other copy of the service refreshes the login
meanwhile. It is removed once it ends, whatever its outcome.

What the pod prints to stdout reaches its log on the node (`/var/log/pods`), which a log agent
(Fluent Bit, Promtail, a cloud's own logging) may ship elsewhere before the pod goes. So the
refreshed file never goes there as it is: the runner sends a one-time key first on the pod's
stdin (which no log keeps), and a wrapper of its own in the pod (`node -e`, from
`listener/runner/kube-seal.mjs`) encrypts the refresh's stdout with it (AES-256-GCM). The log
holds only that ciphertext, which nothing but the runner's memory, during that call, can open;
an output that isn't sealed with the key isn't read. Its stderr, which holds no token, stays as
it is.

The shared claims (agents', caches') are written by their pods' users, uid 1001 for the
installs and 1000 for the sandboxes, as the pods' `fsGroup` makes a new claim theirs. That
holds only where the storage class applies `fsGroup`: a CSI driver with `fsGroupPolicy: File`
(its default, `ReadWriteOnceWithFSType`, skips `ReadWriteMany` volumes), or a provisioner whose
new volumes every user can write (NFS with `root_squash` ignores `fsGroup`; EFS needs an access
point). The runner checks it: an install, or a short pod at a cache's first use, that can't
write to its claim fails the run saying so (and a cache's claim is removed, so the next run
makes it again). An agent's claim filled beforehand needs no write: its installer finds the
version there and leaves it as it is.

## Caches on Kubernetes

With `KUBERNETES_CACHE_STORAGE_CLASS`, a `ReadWriteMany` class, a repository's `caches` are
claims of their own (`KUBERNETES_CACHE_SIZE`), one per path, made at the first run that needs
them, kept across its runs and mounted by concurrent ones; the sandbox pod's `fsGroup` makes a
new one its user's (see above for what the class has to do for that). Without it, runs go
without caches, said once in the run's log.

## Container engine on Kubernetes

A run granted a [container engine](setup.md#container-engine) gets one on Kubernetes through
[Sysbox](https://github.com/nestybox/sysbox) alone: `dockerd` is a sidecar in the sandbox's
pod, under Sysbox's RuntimeClass, and the pod runs in a user namespace of its own
(`hostUsers: false`). `dockerd` is root there, which Sysbox maps to an unprivileged user on the
node, and every container's spec keeps the rest of Pod Security `restricted` (no privilege
gain, every capability dropped, `RuntimeDefault` seccomp), so the sandboxes' namespace stays
`restricted`. Sysbox applies its own: root in the pod gets its capabilities inside the pod's
user namespace whatever the spec drops, and every container of the pod, the sandbox's too,
runs under Sysbox's syscall filter rather than the runtime's default profile (it allows
`mount`, `unshare`, `setns`, `keyctl`…). What contains them is the user namespace and their
capabilities: the sandbox keeps its user (uid 1000) and none. Podman's engine, whose seccomp is unconfined, is never started there: with
`SANDBOX_ENGINE=podman`, such runs are refused, with a reply naming the runner.

What it takes:

- **Kubernetes 1.35 or later**, whose Pod Security lets a pod with `hostUsers: false` run as
  root under `restricted`. The namespace's `pod-security.kubernetes.io/enforce-version` has to
  be `latest` (its default) or `v1.35` or later: an older one refuses the pod. The nodes need
  what Kubernetes' user namespaces need (Linux 6.3 or later; containerd 2.0.5 or later, or
  CRI-O), and the Kubernetes versions Sysbox supports.
- **Storage that takes idmapped mounts**: in a pod with `hostUsers: false`, its volumes are
  mounted idmapped, the session claims (`KUBERNETES_STORAGE_CLASS`), the agents' and caches'
  claims among them. A filesystem that can't (NFS, among others) may still let the pod start,
  its owners wrong: on k3s's `nfs-csi`, the sandbox saw its files as `nobody` (65534), and
  wrote new ones root's on the server, writable only because of how that export maps owners.
  The sandbox trusts `/workspace` whoever owns it (git's `safe.directory`, as a new claim's
  root is root's), but files seen as `nobody`'s may not be its to write: expect such runs to
  fail.
  `local-path` and Longhorn keep uid 1000 across runs with and without an engine. Check your
  classes with a pod of that kind before granting `docker`: write a file in an engine's pod,
  then `ls -ln` it there and in a pod without one.
- **Sysbox on the nodes that run engines**, from its installer
  ([Sysbox's guide](https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-k8s.md)):

  ```sh
  kubectl label nodes <node> sysbox-install=yes
  kubectl apply -f https://raw.githubusercontent.com/nestybox/sysbox/master/sysbox-k8s-manifests/sysbox-install.yaml
  ```

  It installs Sysbox (and CRI-O, restarting the kubelet, where containerd is older than
  2.0.5) and makes the `sysbox-runc` RuntimeClass, whose pods only go to the nodes it runs on.

  Or, on containerd 2 (k3s, say), without that installer: install Sysbox on each such node
  from its package, register `sysbox-runc` as a containerd runtime, and make the RuntimeClass
  yourself. On k3s, the runtime goes in
  `/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl` (then restart k3s):

  ```toml
  {{ template "base" . }}

  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.sysbox-runc]
    runtime_type = "io.containerd.runc.v2"
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.sysbox-runc.options]
    BinaryName = "/usr/bin/sysbox-runc"
    SystemdCgroup = true
  ```

  ```yaml
  apiVersion: node.k8s.io/v1
  kind: RuntimeClass
  metadata: { name: sysbox-runc }
  handler: sysbox-runc
  # Only where Sysbox is: label those nodes, or leave this out when every node has it.
  scheduling: { nodeSelector: { sysbox-runtime: running } }
  ```

  Checked that way on k3s 1.36 with containerd 2.3 and Sysbox CE 0.7: `docker run`,
  `docker build` and a published port answering on `engine`, under `restricted:latest`.

- **The `engine` component** (`deploy/kubernetes/components/engine`, in your overlay's
  `components`; `engine.enabled` with the chart): it sets `SANDBOX_ENGINE=sysbox`,
  `KUBERNETES_ENGINE_RUNTIME_CLASS=sysbox-runc` (that RuntimeClass) and `ENGINE_IMAGE` (pin it to your version, a reference the nodes can
  pull, as `SANDBOX_IMAGE` is) in `deckhand-env`, which the orchestrator and the runner read,
  and opens the engines' port below. Without the RuntimeClass, runs that would get an engine
  are refused, as before.
- **The engines' port of the egress proxy**, 3129: the engine shares its sandbox's address, so
  it goes out, and the containers it builds and runs with it, through that port, which tells
  the proxy their connections apart from the sandbox's (never decrypted, as an engine's on
  Docker, and only for a run that has an engine). The proxy's Service publishes 3129 beside
  3128 (the runner refuses to start an engine otherwise, saying so), and both the sandboxes'
  NetworkPolicy (`deckhand-sandboxes`) and the proxy's own (`deckhand-egress`) let it
  through, from the sandboxes alone: the `engine` component adds all three.

  The runner accepts 3129 in the sandboxes' policy only with `KUBERNETES_ENGINE_RUNTIME_CLASS`
  set and `SANDBOX_ENGINE` `sysbox` or `auto`: otherwise a policy that lets 3129 through is
  too wide, and every run is refused.

The engine has the repository's limits on top of the sandbox's (the pod requests both), and
its storage is an `emptyDir` gone with the pod, up to `KUBERNETES_ENGINE_SIZE` (20Gi by
default; past it, the kubelet evicts the pod and the run fails). No engine cache is kept on
Kubernetes: a repository's `docker: { cache: true }` gets fresh storage, said in the run's log.
The pod shares no process namespace between its containers, as Sysbox advises: the sandbox's
entrypoint reaps its orphaned processes itself (`SANDBOX_REAP`), and needs a sandbox image of
this release.

One difference from Docker: `no-new-privileges` (Pod Security `restricted`'s
`allowPrivilegeEscalation: false`) is set on `dockerd` too, and every container and build step
it starts inherits it, so setuid programs (`sudo`, `su`) fail in them. A Dockerfile's `RUN sudo
…`, or a container that switches user that way, works with the Docker runner's engine and fails
here: run such steps as root (`USER root`) instead.

To check it: run a repository's `docker run --rm hello-world` in a granted
issue; the run's log says `Container engine: sysbox, fresh storage`, and
`kubectl get pod -n <sandboxes' namespace> -l deckhand.role=sandbox -o yaml` shows
`runtimeClassName: sysbox-runc` and `hostUsers: false`.
