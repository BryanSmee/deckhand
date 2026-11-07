# On Kubernetes

Part of the [Security overview](../security.md): the rules of the other pages, on a cluster.

`deploy/kubernetes/` ([kubernetes.md](../kubernetes.md)) keeps each rule of the other pages, in
Kubernetes' terms:

| Rule                                                        | With Docker Compose                                                                           | On Kubernetes                                                                                                                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Docker socket, or the API's credentials, in one service | the runner alone mounts the socket                                                            | the runner's pods alone mount their ServiceAccount's token (`automountServiceAccountToken: false` on the others but the broker's, which reviews tokens), for Roles in two namespaces, nothing cluster-wide         |
| Each secret in its service alone                            | its own volume or environment                                                                 | its own Secret, mounted read only by its pods alone: edge's, the github service's, the broker's key, the models service's credentials and key; the orchestrator mounts none                                        |
| Who calls a service                                         | one internal network per caller and callee (`SERVICE_NETWORKS`)                               | one NetworkPolicy per service letting in its callers' pods alone (`CALLS`), default deny in both namespaces; `SERVICE_NETWORKS=none`                                                                               |
| A service token bound to its caller                         | the network it arrives on                                                                     | the pod's service account: a token projected for the broker (audience `deckhand-broker`), reviewed by the API server (`SERVICE_ACCOUNTS`)                                                                          |
| Sandboxes reach the egress proxy alone                      | each run's internal network, the proxy alone on it                                            | their namespace's NetworkPolicies, which the runner checks before every run (`isolationProblem()`); no DNS server, the proxy's address in `hostAliases`                                                            |
| No way out but the services' own                            | internal networks, a way out for edge, the github and models services, the proxy              | egress rules: 443 for edge, the github and models services, the API server's addresses alone for the runner and the broker, any public host for the proxy (not the private ranges), nothing for the policy service |
| Hardened containers                                         | `cap_drop: ALL`, `no-new-privileges`, uid 1000, read-only roots                               | the same in each pod's security context; the sandboxes' namespace enforces Pod Security `restricted`, and every sandbox pod meets it                                                                               |
| The broker's public key, read only                          | the `service-keys` volume, which the broker writes                                            | a ConfigMap the operator makes beside the signing key's Secret: no volume shared between services                                                                                                                  |
| Blob storage's key pair, the runner's and the broker's      | their environment alone (`BLOB_*`)                                                            | `components/blobs`: the `deckhand-blobs` Secret, mounted read only by their pods alone (`BLOB_*_FILE`), `BLOB_URL` from a ConfigMap no other pod reads, a NetworkPolicy out to its address alone                   |
| The metrics port, the scraper's alone                       | off; on, a network of each service's with the scraper alone ([Metrics](../guides/metrics.md)) | `deckhand-metrics`: every service's 9464 from the monitoring namespace alone, never the sandboxes', which the network probe tries it from ([kubernetes.md](../kubernetes.md#metrics))                              |

**NetworkPolicies need a network plugin that enforces them** (Calico, Cilium, k3s's own). One
that doesn't (Flannel alone) takes them and enforces nothing: a sandbox could then call the
services directly, the orchestrator's services port among them, and get what only the runner
may. The runner checks that the policies are there before every run, and that the cluster
applies them with a probe pod labelled as a sandbox each time it takes its lease, refusing every
run when the probe reaches anything but the egress proxy, another sandbox-labelled pod
listening beside it included
([kubernetes.md](../kubernetes.md#the-network-probe)); `deploy/kubernetes/check-isolation.sh`
checks it by hand, another sandbox's pod among what it must not reach. Some plugins apply a new pod's policies a moment after it starts (kube-router):
every pod of the sandboxes' namespace, the probe's included, first waits in an init container
until the API server and the DNS are out of reach and the proxy answers, and fails past
`KUBERNETES_PENDING_MINUTES` ([kubernetes.md](../kubernetes.md#the-network-gate)). Each service's
own ingress policy is a second line: with the sandboxes' policies gone, a sandbox reaches edge's
public port alone.

**The API server** is no pod: the runner's and the broker's way to it is an `ipBlock` of its
addresses, which the operator sets (`deckhand-api-server`, [kubernetes.md](../kubernetes.md#install)),
and which reaches nothing until then. With `buildkit`, the runner also reaches any address on 443
(the registries). With `blobs`, the runner and the broker reach blob storage's address and port
(`deckhand-blobs`, a placeholder that reaches nothing until set, [kubernetes.md](../kubernetes.md#blob-storage)).

**What isn't covered**: a service
mesh that rewrites source addresses breaks the orchestrator's check of the proxy's calls (by its
pods' addresses), and refuses them: run Deckhand's namespaces outside it.
