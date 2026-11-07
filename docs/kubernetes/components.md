# Components

## Several nodes

The base keeps each service's store on its own `ReadWriteOnce` claim, which pods on one node
share: each service's copies stay on one node (`podAffinity`), and the file store serves them
both ([The store](../guides/store.md)). For copies on several nodes, add the `redis`
component:

```yaml
components:
  - https://github.com/BryanSmee/deckhand//deploy/kubernetes/components/redis?ref=v1.2.3
```

It runs Valkey (Redis's protocol, `deploy/kubernetes/components/redis/redis.yaml`), kept on disk
(append-only, fsync every second) and never evicting, with one user per service, each allowed the
store's commands on its own keys (`deckhand:<service>:`) alone, and moves every store there. The
users of edge, the orchestrator and the runner can also list their keys (`SCAN`: edge's signed-in
users it counts, the orchestrator's state, the runner's log segments to move to blob storage),
which Redis doesn't hold to a user's keys: they see the other services' key names, never their
values. Make
its Secret first, one password per service (letters and digits): each service's pods read their own
key of it alone, and Redis reads them all, to make its users:

```sh
kubectl -n deckhand create secret generic deckhand-redis $(for s in edge orchestrator runner \
  broker github models; do printf -- '--from-literal=%s=%s ' "$s" "$(openssl rand -hex 24)"; done)
```

Then edge, the orchestrator, the broker, the github and models services keep nothing on disk, and
their copies go to any node: the orchestrator has no volume at all (#619), its `orchestrator-data`
claim gone. The runner's inboxes are still files: its claim becomes `ReadWriteMany`, which your
default storage class has to provide (or a patch giving it a `storageClassName`), so a copy taking
over on another node finds them. Coming from a release before #619, the orchestrator's first start
on this one needs its old claim, which the component no longer mounts, and the claims stay until you
delete them: [Upgrading: the orchestrator without a volume (#619)](../guides/upgrade-notes.md#upgrading-the-orchestrator-without-a-volume-619). The proxy's
copies stay on one node (their CA). Redis's own update is a restart of a few seconds, which the
services wait through.

## Blob storage

With the `redis` component, the runs' logs and screenshots take Redis's memory: the runner and the
broker say so at start, and on the dashboard's status page. [Blob storage](../guides/blob-storage.md)
takes them out of it; the `blobs` component gives it to
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
for those two pods. Blob storage in the cluster (Garage's pods,
[Garage on its own](../guides/blob-storage.md#garage-on-its-own)) is a `podSelector` instead, with a
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

## Repo images on Kubernetes

A repository granted its own image (`dockerfile`, and `branch_docker_images` for a
pull request's branch, under the same rules as on Docker: never a fork's) is built in the
cluster and pushed to a registry, as nodes only pull from one:

- **A registry** (`KUBERNETES_REGISTRY`), reached over HTTPS, that the nodes can pull from. Repo
  images are named `<KUBERNETES_REGISTRY>/<NAME_PREFIX>-repo-<repo>-<hash>`, tagged as on Docker:
  the same base image (its digest in its registry) and Dockerfile reuse a tag, a change builds a new
  one. Old tags are pruned through the registry's API as on Docker (the default branch's newest and
  the newest few kept, never one a pod runs), so it has to allow deletes
  (`REGISTRY_STORAGE_DELETE_ENABLED=true` for the CNCF distribution registry); one that doesn't
  keeps its tags, which the runner logs. A tag whose manifest a kept one shares (an identical build)
  is deleted alone where the registry can, else kept. A tag whose date the runner can't read is
  kept, and logged.
- **A pull Secret** (`KUBERNETES_REGISTRY_SECRET`, required with `KUBERNETES_REGISTRY`: the runner
  doesn't start without it), of type `kubernetes.io/dockerconfigjson`, whose credentials may pull
  from, push to and delete from the registry. The registry has to require them for all three, pulls
  included: sandboxes and builds can reach an in-cluster one, any run's sandbox among them (a
  research run's, a fork's, a repository's without the `dockerfile` grant). A registry that lets
  anyone push would let one run replace another repository's image, which then runs with that
  repository's grant; one that lets anyone pull would let any run read every repository's image,
  which holds whatever its Dockerfile copied of a private checkout. (On Docker, sandboxes can't read
  the host's images.) An in-cluster registry is best also kept out of the sandboxes' reach: a
  NetworkPolicy that lets only the runner, BuildKit and the nodes in. Sandbox pods, install pods and
  init containers pull with this Secret, and the runner reads it (its Role's `get` on `secrets`
  covers it) to push through BuildKit and prune. It lives in the services' namespace; with the
  sandboxes apart, the runner copies it to theirs ([Namespaces](sandboxes.md#namespaces)). It
  replaces the ServiceAccount's own `imagePullSecrets`, which Kubernetes adds only to a pod that
  lists none: when `SANDBOX_IMAGE` comes from a private registry, the Secret has to hold that
  registry's credentials too. For a repository with its own image, `SANDBOX_IMAGE` has to be
  readable through its registry's API as well: the runner reads its digest there (anonymously for a
  public one, such as ghcr.io's releases). Runs on the base image alone don't look it up: the nodes
  pull it as they can.
- **A BuildKit daemon** (`moby/buildkit`, rootless), a Deployment with a Service named after
  `KUBERNETES_BUILDKIT`'s host, in the services' namespace. The runner drives it with `buildctl` (in
  its image), with the checkout as the build's context and `DECKHAND_BASE` as on Docker. Only the
  runner may reach it, and it goes out only through the egress proxy: set `HTTPS_PROXY` and
  `HTTP_PROXY` to `EGRESS_PROXY` in its Deployment, with `NO_PROXY` for an in-cluster registry, and
  give its pods NetworkPolicies that one picks for `Egress` and one for `Ingress`, letting them out
  to the namespace's pods only (the proxy, an in-cluster registry) and to DNS (UDP or TCP port 53,
  no `endPort`), and in only from the namespace's pods (no `namespaceSelector`, never the sandboxes'
  namespace). In one namespace with the sandboxes, those have to be pods that can't be sandboxes
  (the runner's: a peer has to ask for a label sandbox pods don't have, or a `deckhand.role` other
  than `sandbox`, as a sandbox's own policy lets it reach any pod but another sandbox); apart, any
  pod of the services' namespace may be let in. The runner checks them before every build, as it
  checks the sandboxes', and refuses to build otherwise, saying why (the Role's `get` on `pods` and
  `list` on `networkpolicies` and `endpointslices` cover it). The proxy asks the orchestrator about
  the daemon's pod IPs (the endpoints of its Service): while a build runs, they may reach that run's
  hosts (the repo's grant) and the registries of the image and its base, with the hosts those send a
  puller to (Docker Hub's token service and layer storage, ghcr.io's layer storage, the token
  services Deckhand has seen, and `KUBERNETES_REGISTRY_HOSTS`), tunnelled, never decrypted, and
  nothing between builds. A Dockerfile that pulls from another registry (`FROM node:26` in a stage)
  needs that registry's hosts in the repository's grant. Builds of repositories granted other hosts
  wait for each other, in order of arrival, so one repository's Dockerfile never reaches another's
  grant; a build stops after an hour. Its `RUN` steps get the proxy as build arguments
  (`HTTP_PROXY`, `HTTPS_PROXY`).

## Container engine on Kubernetes

A run granted a [container engine](../guides/container-engine.md) gets one on Kubernetes through
[Sysbox](https://github.com/nestybox/sysbox) alone: `dockerd` is a sidecar in the sandbox's pod,
under Sysbox's RuntimeClass, and the pod runs in a user namespace of its own (`hostUsers: false`).
`dockerd` is root there, which Sysbox maps to an unprivileged user on the node, and every
container's spec keeps the rest of Pod Security `restricted` (no privilege gain, every capability
dropped, `RuntimeDefault` seccomp), so the sandboxes' namespace stays `restricted`. Sysbox applies
its own: root in the pod gets its capabilities inside the pod's user namespace whatever the spec
drops, and every container of the pod, the sandbox's too, runs under Sysbox's syscall filter rather
than the runtime's default profile (it allows `mount`, `unshare`, `setns`, `keyctl`…). What contains
them is the user namespace and their capabilities: the sandbox keeps its user (uid 1000) and none.
Podman's engine, whose seccomp is unconfined, is never started there: with `SANDBOX_ENGINE=podman`,
such runs are refused, with a reply naming the runner.

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

- **The `engine` component** (`deploy/kubernetes/components/engine`, in your overlay's `components`;
  `engine.enabled` with the chart): it sets `SANDBOX_ENGINE=sysbox`,
  `KUBERNETES_ENGINE_RUNTIME_CLASS=sysbox-runc` (that RuntimeClass) and `ENGINE_IMAGE` (pin it to
  your version, a reference the nodes can pull, as `SANDBOX_IMAGE` is) in `deckhand-env`, which the
  orchestrator and the runner read, and opens the engines' port below. Without the RuntimeClass,
  runs that would get an engine are refused, as before.
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
