# What the manifests set up, and why

The runner checks the cluster before every run and refuses to start one it can't isolate,
saying why. What it expects, and the manifests give it:

- **RBAC** (`rbac.yaml`): a Role for the runner's ServiceAccount in the sandboxes' namespace,
  `create`, `get`, `list` and `delete` on `pods` and `secrets`, `create`, `get` and `delete` on
  `persistentvolumeclaims` (the agents', caches' and sessions'), `get` on `pods/log`, `create` and
  `get` on `pods/attach` (the Antigravity CLI's login refresh,
  [Agents](sandboxes.md#agents-on-kubernetes): Kubernetes checks `create` from 1.35, `get` before),
  and `list` on `events` (why a pod is stuck) and `networkpolicies`; and in the services' namespace,
  `get` on `pods` (BuildKit's), `get` and `list` on `services` (the proxy's Service, and every one
  for [the network probe](#the-network-probe)), `list` on `networkpolicies` and `endpointslices`.
  The `buildkit` component adds `get` on the registry's pull Secret alone
  (`resourceNames: [deckhand-registry]`) and `update` on that Secret's copy in the sandboxes'
  namespace alone (`resourceNames: [deckhand-registry]` too). Nothing cluster-wide but the broker's
  binding to `system:auth-delegator`, which lets it review the tokens its callers present
  (TokenReview is cluster-scoped). Only the runner's and the broker's pods mount their
  ServiceAccount's API token.
- **Service tokens bound to the pod**: each service that calls another gets its own service
  tokens from the broker by presenting a token projected for it (a `serviceAccountToken` volume,
  `audience: deckhand-broker`, `SERVICE_ACCOUNT_TOKEN_FILE`), and the broker tells callers apart
  by their ServiceAccount (`SERVICE_ACCOUNTS`, one each). `SERVICE_NETWORKS=none` on the others:
  every call arrives at a pod's one address, and the NetworkPolicies let in each service's
  callers alone. The services that check tokens offline (the runner, the models and policy
  services) read the broker's public key from the `deckhand-service-keys` ConfigMap, read only:
  the broker publishes none on a cluster (no volume is shared between services).
- **NetworkPolicies** (`network-policies.yaml`, `sandboxes.yaml`): default deny in both namespaces;
  each service lets in its callers alone, on its port, and reaches its callees and DNS alone
  (`lib/services.mjs` `CALLS`, as Compose's networks; `test/kubernetes-manifests.test.mjs` holds
  them to it). Edge alone is reached from outside; edge, the github and models services reach the
  internet on 443, the runner and the broker the API server's addresses alone
  (`deckhand-api-server`, [The API server's addresses](../kubernetes.md#the-api-servers-addresses);
  the runner the registries on 443 too with `buildkit`), and the proxy any host but the private
  ranges (add yours to its policy to grant a host of your network). The policy service reaches
  nothing. Every service's metrics port is your monitoring namespace's alone (`deckhand-metrics`,
  [Metrics](metrics.md#metrics)).
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

- **The egress proxy's Service**, named after the host of `EGRESS_PROXY` (`egress` on 3128, and on
  3129 too with the `engine` component:
  [Container engine on Kubernetes](components.md#container-engine-on-kubernetes)), with a cluster
  IP, and the orchestrator's on 8082 for the proxy's `POLICY_URL`. Sandboxes get no DNS server (a
  lookup fails at once): their pods map the proxy's name to its Service's IP (`hostAliases`). The
  services' names sandboxes call (`http://broker:8081`, `http://github:8080`, `http://models:8080`)
  are the proxy's to read, whatever the services' own Services are named: it sends their calls to
  its `BROKER_SERVICE_URL`, `GITHUB_SERVICE_URL` and `MODELS_SERVICE_URL`. The orchestrator tells
  the proxy's calls by its pods' addresses (the Service's EndpointSlices, which it asks the runner):
  nothing may stand between them that changes the source address (a service mesh's sidecar, say).
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

## The network gate

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

## The network probe

The checks above read what the NetworkPolicies say; a network plugin that ignores them takes them
all the same. So the runner also checks that the cluster applies them: each time it takes its lease
(as it starts, or as its other copy hands over), it starts a probe pod in the sandboxes' namespace,
`<prefix>-network-probe-<random>`, from `SANDBOX_IMAGE`. It has a sandbox's labels
(`deckhand.role: sandbox`), so the sandboxes' policies pick it, meets Pod Security `restricted` as
they do, and holds no Secret, claim or ServiceAccount token. Once its
[network gate](#the-network-gate) has seen its policies apply (a verdict on what the cluster
enforces, not on how fast it applies it), it tries a TCP connection, 3 s at most each, to:

- every port of every Service of the services' namespace, at its cluster IP and at one of its
  pods' addresses (some plugins treat the two differently): edge, the orchestrator, the runner,
  the broker, the github, models and policy services, BuildKit, Redis, whatever else is there,
  their [metrics](metrics.md#metrics) port included, the egress proxy's too;
- with `KUBERNETES_REGISTRY` set, the registry's host and BuildKit's (`KUBERNETES_BUILDKIT`),
  and with `STORE_URL=redis://…`, Redis's, as the runner resolves them, wherever they are;
- the cluster's DNS (the runner's own nameservers, the `kube-dns` Service), TCP and UDP 53:
  sandboxes get no DNS server, but one reached by its address could carry data out in its
  lookups;
- the API server, at the `kubernetes` Service's address (`KUBERNETES_SERVICE_HOST`);
- a public address, `1.1.1.1:443`;
- another pod labelled as a sandbox, on port 8080: a peer pod, `<prefix>-network-peer-<random>`,
  that the runner starts first, with the probe pod's labels and spec (its gate too), and that
  listens there. It is Ready once its port answers from inside it (an exec probe: a kubelet's
  TCP probe comes from the node, which some plugins let through), so a refusal from it is a
  policy's. A plugin that kept the services out of reach but let one pod of the namespace
  reach another would pass every other target. Its gate still reaching the API server or the
  DNS is a verdict too, as the probe pod's.

Every one has to be out of reach, and the egress proxy's Service has to answer, so that a pod with
no network at all doesn't pass as isolated: on `EGRESS_PROXY`'s port, and on the engines' (3129) too
when runs get a [container engine](components.md#container-engine-on-kubernetes) and the Service
publishes it. Any one reached, and the runner refuses every run, the reply on the issue (and the
dashboard) naming what the probe reached: use a plugin that enforces NetworkPolicies (Calico,
Cilium, k3s's kube-router; Flannel alone doesn't). On a plugin that doesn't, the probe pod's gate
never sees the API server or the DNS out of reach: that verdict comes once it gives up, after
`KUBERNETES_PENDING_MINUTES`, the runs meanwhile waiting for it. The probe pod and its peer are
removed whatever they found, and its verdict kept until the NetworkPolicies of either namespace
change (the runner reads them before every run) or the runner takes its lease again: after a change
of plugin, restart it (`kubectl -n deckhand rollout restart deploy/runner`). A probe that couldn't
tell refuses that run alone, and the next one probes again: its pod didn't end within
`KUBERNETES_PENDING_MINUTES` and a minute, say (nor its peer get ready in as long), its peer stopped
listening before it ended, its gate never reached the egress proxy (not ready yet on a fresh
install, its pod evicted), or the probe itself didn't. Each probe's pods have names of their own, so
a runner copy taking over doesn't remove the other's mid-probe; one older than a probe lasts (a
runner stopped mid-probe) is removed at the next probe, and a peer left behind ends by itself by
then (`activeDeadlineSeconds`). Its log lines start with `Network probe:`. The API server's own
addresses, behind the `kubernetes` Service, and the DNS pods' aren't tried: the runner has no right
to read them.
