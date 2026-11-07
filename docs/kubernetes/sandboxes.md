# Sandboxes on a cluster

## Namespaces

Two settings, which may name one namespace (the default) or two:

- **The sandboxes' namespace** (`KUBERNETES_NAMESPACE`, by default the runner's own): the sandbox
  pods, the agents' install pods and the caches' checks, the runs' Secrets, the sessions', agents'
  and caches' claims, and the sandboxes' NetworkPolicies. The runner also keeps a Secret there,
  `<NAME_PREFIX>-deployment`, labelled `deckhand.role: deployment`. It holds no data, only the
  deployment's ID in a label: it claims the prefix for this deployment
  ([the runner service](../security/services.md#the-runner-service)). Each deployment sharing the namespace
  needs a `NAME_PREFIX` of its own. Nothing else runs there, so it can enforce Pod Security
  `restricted` (`pod-security.kubernetes.io/enforce: restricted` on the namespace), a last line
  should a pod's own spec ever be wrong.
- **The services' namespace** (`KUBERNETES_SERVICES_NAMESPACE`, by default the sandboxes'):
  every service (edge, the orchestrator, the runner itself, the broker, the github, models
  and policy services, the egress proxy), their Secrets, BuildKit (rootless BuildKit can't
  meet `restricted`), an in-cluster registry and the registry's pull Secret. The runner runs
  here too. With the namespaces apart, it reaches BuildKit as
  `<KUBERNETES_BUILDKIT's host>.<services' namespace>.svc`, so the daemon it builds on is the
  one whose NetworkPolicies it checked, wherever it runs (the short name resolves in the
  runner's own namespace).

With two, the runner reads the proxy's Service and EndpointSlices and BuildKit's endpoints, pods and
NetworkPolicies in the services' namespace, and keeps a copy of the registry's pull Secret
(`KUBERNETES_REGISTRY_SECRET`) in the sandboxes', under the same name and labelled
`deckhand.role: registry`, as a pod pulls only with a Secret of its own namespace: made at the first
pod that needs it, brought up to date within a minute of a change. A Secret of that name there that
isn't its copy (both labels, `deckhand.owner` and `deckhand.role: registry`) is neither overwritten
nor used, even when it holds the same credentials: runs are refused, saying so, until it is removed.
The proxy's own NetworkPolicy, in the services' namespace, lets in the sandboxes' namespace's
sandbox and install pods on its port, and whatever of the services' namespace goes out through it
too: BuildKit's pods ([Repo images on Kubernetes](components.md#repo-images-on-kubernetes), their
`HTTPS_PROXY`). A policy that picks the proxy's pods for `Ingress` drops all it doesn't let in, so
leaving them out fails every repo image's build, which the runner's check of BuildKit's own policies
doesn't see (`network-policies.yaml`'s `deckhand-egress` lets them in, with the orchestrator):

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
    # With container engines (components.md, Container engine on Kubernetes): the sandboxes' pods on
    # the engines' port too.
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: deckhand-sandboxes } }
          podSelector: { matchLabels: { deckhand.role: sandbox } }
      ports: [{ port: 3129 }]
```

Install pods reach the proxy by its Service's IP there (`hostAliases`, as sandboxes do), not
through the cluster's DNS, which doesn't know its short name in the sandboxes' namespace.

## Agents on Kubernetes

Each agent (Claude Code, Codex, the Antigravity CLI) is installed once per version into a
claim named after its volume (`CLAUDE_CODE_VOLUME`, `deckhand-claude-code` by default), which
every sandbox mounts read-only, as on Docker:

- **With `KUBERNETES_AGENT_STORAGE_CLASS`** (by default `KUBERNETES_CACHE_STORAGE_CLASS`), a
  `ReadWriteMany` class (NFS, CephFS, EFS…), or a claim of that name made beforehand: the runner
  makes the claim when it is missing, and before the first run of each version a pod of its own
  (`deckhand.role: install`), in the sandboxes' namespace, runs the base image's installer into it,
  then goes. It meets Pod Security `restricted`: it runs as uid 1001, neither root nor the sandbox's
  user, so no sandbox can change what the next one runs, and sandboxes mount the claim read-only. It
  goes out through the egress proxy, which lets it reach its agent's install hosts only (npm's
  registry; GitHub's releases for the Antigravity CLI): its NetworkPolicy has to let it reach the
  proxy (and, in one namespace, the cluster's DNS, as it resolves `egress` there; with the services
  apart, it gets the proxy's IP through `hostAliases` instead).
- **Without either**, each sandbox installs its agent itself, in an init container (uid 1001
  too) that fills an `emptyDir` the sandbox then mounts read-only: no shared storage, but a
  slower start, which counts toward `KUBERNETES_PENDING_MINUTES`. While its pod is still
  Pending (the init container running), the egress proxy lets it reach the agent's install
  hosts only, nothing of the run's own; once the sandbox starts, those hosts are gone again.
  A failed install fails the run, with the installer's output in the run's log.

The Antigravity CLI's plan login ([Antigravity CLI](../guides/antigravity.md)) is refreshed by a pod of
its own, `<NAME_PREFIX>-job-antigravity-refresh`, in the sandboxes' namespace, at the models
service's call (the runner's NetworkPolicy lets it in for that). It meets Pod Security `restricted`
as the sandbox's user, with no ServiceAccount token and no Secret. The runner sends it the token
file on its stdin and reads back the refreshed one from its stdout, through the API server
(`pods/attach`, over WebSocket, `v5.channel.k8s.io`: Kubernetes 1.30 or later), never through its
spec; `~/.gemini` is an `emptyDir` there, no claim. It mounts the agent's claim read-only (or,
without one, installs the CLI in an init container, as sandboxes do: a failed install's last line is
in the refresh's error, which the runs on the login fail with). It is labelled
`deckhand.role: install`, so `deckhand-installs` (`sandboxes.yaml`) covers it: the egress proxy lets
it reach Google's OAuth (`oauth2.googleapis.com`) and the CLI's own hosts only, tunnelled (and
GitHub's releases while its init container installs the CLI, never once `agy` runs). It has 4
minutes in all, the CLI's install included, and never more than what is left of the models service's
5-minute hold on the login, a minute to spare: each try of the service's call says what is left at
that moment (and the service stops asking a runner that doesn't answer, during a handover, once too
little is), and a refresh with under 30 seconds to go isn't started. So no other copy of the service
refreshes the login meanwhile. It is removed once it ends, whatever its outcome.

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
