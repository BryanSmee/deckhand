# Sandboxes and the runner

Where the runs' sandboxes run, their networks' subnets, the container engine some of them get,
and the names and images Deckhand creates. What a sandbox may reach and use (hosts, mounts,
CPUs, memory) is a grant, not a setting: [The grants folder](../server-folder.md#the-grants-folder).
Setting the engine up: [Container engine](../../guides/container-engine.md); a cluster:
[Deckhand on Kubernetes](../../kubernetes.md).

## Settings

- **`SANDBOX_SUBNETS`, `SANDBOX_SUBNET_SIZE`** · `sandbox_subnets`, `sandbox_subnet_size` · default: none (Docker's pools), `28`\
  An IPv4 range the runs' networks take their subnets from, in blocks of that size ([Sandbox networks](#sandbox-networks)).
- **`SANDBOX_ENGINE`** · `sandbox_engine` · default: none\
  The container engine runs of repositories granted `docker` get: `sysbox`, `podman` or `auto` (see [Container engine](../../guides/container-engine.md)).
- **`NAME_PREFIX`, `CLAUDE_CODE_VOLUME`, `CODEX_VOLUME`, `AGY_VOLUME`** · `name_prefix`, `claude_code_volume`, `codex_volume`, `agy_volume` · default: `deckhand`, `deckhand-claude-code`, `deckhand-codex`, `deckhand-antigravity`\
  Names of what Deckhand creates on Docker (the Antigravity CLI's login is refreshed in `<AGY_VOLUME>-login`); each deployment on one engine needs its own `NAME_PREFIX` ([why](../../security/services.md#the-runner-service)).
- **`DOCKER_SOCKET`** · `.env` only (compose's) · default: `/var/run/docker.sock`\
  The host's Docker socket, which compose mounts into the runner.
- **`RUNNER`** · `runner` · default: `docker`\
  Where sandboxes run: `docker`, the host's Docker, or `kubernetes`, pods of the cluster the runner runs in (see [kubernetes.md](../../kubernetes.md)); another value stops the orchestrator and the runner at start, saying so.
- **`INSTALL_NETWORK`** · `install_network` · default: `bridge`\
  Network of the agents' install containers (they need npm and GitHub's releases), and of the Antigravity CLI's login refresh.
- **`SANDBOX_IMAGE`** · environment only · default: `<NAME_PREFIX>-sandbox`\
  The base image runs start from; compose sets the release's.
- **`ENGINE_IMAGE`, `ENGINE_PODMAN_IMAGE`** · environment only · default: `<NAME_PREFIX>-engine`, `<NAME_PREFIX>-engine-podman`\
  The [container engine](../../guides/container-engine.md)'s images, for Sysbox and for Podman; compose sets the release's.

## Sandbox networks

Each running sandbox has a Docker network of its own (see
[Security model](../../security/network.md#network)). By default Docker takes their subnets from its default
address pools, which hold about 30 networks shared with your other projects: past that, runs
fail to start with `all predefined address pools have been fully subnetted` (or `could not
find an available, non-overlapping IPv4 address pool`). Set aside a range of your own instead,
`SANDBOX_SUBNETS=10.200.0.0/16` (`sandbox_subnets` in `config.yaml`): Deckhand cuts it
into blocks of `SANDBOX_SUBNET_SIZE` (`/28` by default, 16 addresses: 4096 networks in a
`/16`) and gives each run's network the lowest block no network on the host uses, so your
other projects keep Docker's pools. Pick a range none of your networks or LANs use, inside
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` or `100.64.0.0/10`: Deckhand refuses to
start with any other (a public range would make other runs' sandboxes look like public hosts
to the egress proxy). When it is
full, runs fail to start with an error naming `SANDBOX_SUBNETS`: set a larger range or a lower
`MAX_PARALLEL`.

The alternative changes the whole daemon, your other projects' networks included: give Docker
more, smaller networks in `/etc/docker/daemon.json`, then restart Docker. The setting replaces
Docker's own pools, so list those first and add yours after them, for example
`"default-address-pools": [{"base": "172.16.0.0/12", "size": 16}, {"base": "192.168.0.0/16", "size": 20}, {"base": "10.200.0.0/16", "size": 28}]`
(the last one: 4096 networks of 16 addresses).

## On Kubernetes

- **`KUBERNETES_NAMESPACE`** · `kubernetes_namespace` · default: the runner's own\
  The sandboxes' namespace: the [Kubernetes runner](../../kubernetes.md)'s sandbox and install pods, their Secrets and claims.
- **`KUBERNETES_SERVICES_NAMESPACE`** · `kubernetes_services_namespace` · default: `KUBERNETES_NAMESPACE`\
  The services' namespace, the runner's own: the egress proxy's Service, BuildKit and the registry's pull Secret ([Namespaces](../../kubernetes.md#namespaces)).
- **`KUBERNETES_PENDING_MINUTES`** · `kubernetes_pending_minutes` · default: `10`\
  How long a sandbox's pod may stay Pending (no room, an image it can't pull) before its run fails, with the reason in its reply; and how long each pod's network gate waits for its NetworkPolicies to apply ([kubernetes.md](../../kubernetes.md#the-network-gate)).
- **`KUBERNETES_STORAGE_CLASS`** · `kubernetes_storage_class` · default: the cluster's default\
  The storage class of the issues' session claims.
- **`KUBERNETES_SESSION_SIZE`** · `kubernetes_session_size` · default: `10Gi`\
  The size of each session claim (an issue's clone, and its agent's session).
- **`KUBERNETES_REGISTRY`** · `kubernetes_registry` · default: none: no repo images\
  The registry repo images are pushed to and the nodes pull from, with an optional path (`registry.example.com/deckhand`); see [Repo images on Kubernetes](../../kubernetes.md#repo-images-on-kubernetes).
- **`KUBERNETES_REGISTRY_SECRET`** · `kubernetes_registry_secret` · default: none; required with `KUBERNETES_REGISTRY`\
  A `kubernetes.io/dockerconfigjson` Secret of the namespace, with credentials the registry requires to pull, push and delete: the nodes pull repo images and the agents' installs with it, and the runner and BuildKit push and prune with it.
- **`KUBERNETES_BUILDKIT`** · `kubernetes_buildkit` · default: `tcp://buildkitd:1234`\
  The BuildKit daemon that builds repo images (`buildctl --addr`); its host is the name of its Service in the namespace.
- **`KUBERNETES_REGISTRY_HOSTS`** · `kubernetes_registry_hosts` · default: none\
  More hosts the BuildKit daemon may reach while it builds (a registry's token service or layer storage Deckhand doesn't know), as a grant's `hosts` are written; see [Repo images on Kubernetes](../../kubernetes.md#repo-images-on-kubernetes).
- **`KUBERNETES_CACHE_STORAGE_CLASS`** · `kubernetes_cache_storage_class` · default: none: no caches\
  A `ReadWriteMany` storage class for the repos' cache claims (`caches`), which concurrent runs mount.
- **`KUBERNETES_CACHE_SIZE`** · `kubernetes_cache_size` · default: `10Gi`\
  The size of each cache claim.
- **`KUBERNETES_AGENT_STORAGE_CLASS`** · `kubernetes_agent_storage_class` · default: `KUBERNETES_CACHE_STORAGE_CLASS`\
  A `ReadWriteMany` storage class for the agents' claims, installed once per version; none (and no claim made beforehand): each run installs its agent in an init container.
- **`KUBERNETES_AGENT_SIZE`** · `kubernetes_agent_size` · default: `5Gi`\
  The size of each agent's claim.
- **`KUBERNETES_ENGINE_RUNTIME_CLASS`** · `kubernetes_engine_runtime_class` · default: none: no container engine on Kubernetes\
  Sysbox's RuntimeClass (`sysbox-runc`), under which runs granted a container engine get one ([Container engine on Kubernetes](../../kubernetes.md#container-engine-on-kubernetes)).
- **`KUBERNETES_ENGINE_SIZE`** · `kubernetes_engine_size` · default: `20Gi`\
  How much a container engine's storage may take on Kubernetes, an `emptyDir` per run.
- **`KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT`** · environment only · default: set by Kubernetes in every pod\
  Where the Kubernetes runner reaches the API server.
