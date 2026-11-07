# Services and networks

How Deckhand's services ([Services](../../contributing/services.md)) find and trust each other, and what
`compose.yaml` runs. Edge, the orchestrator, the runner, the policy service and the egress proxy
read these, and the github, broker and models services their own. `compose.yaml` doesn't take
most of them from `.env`: it sets some itself, to match the services and volumes it defines, and
leaves the others to their defaults. To change one, set its key in `config.yaml` when it has
one, or else set it in the service's `environment`, for example in a `compose.override.yaml`.
Those marked `.env` are compose's own, read from `.env`. What each service holds:
[What the services hold](../../guides/services.md).

## The release compose runs

- **`DECKHAND_VERSION`** · `.env` only (compose's) · default: `latest`\
  The release compose runs (`1.2.3`, `1.2`), or `edge` to follow `main`: see [Updating](../../guides/updating.md).
- **`DECKHAND_REGISTRY`** · `.env` only (compose's) · default: `ghcr.io/bryansmee`\
  Where compose pulls the images from.
- **`PORT`** · `.env` only (compose's) · default: `8080`\
  The host port compose publishes edge on.
- **`DECKHAND_VERSION`** (in the image) · environment only · default: set when the image is built\
  The version the dashboard shows.
- **`DECKHAND_SOURCE`** (in the image) · environment only · default: set when the image is built; empty from source\
  The repository the image was built from: the dashboard links the version to its commit or release there.

## Files and folders

- **`CONFIG_FILE`** · environment only · default: `/etc/deckhand/config.yaml`\
  The settings file, `config.yaml` of [the server folder](../server-folder.md); set on purpose, it has to exist.
- **`GRANTS_DIR`** · `grants_dir` · default: `/etc/deckhand/grants`\
  What you grant each repo, one file each: hosts, cached hosts, host mounts, limits, projects; and your policies in `policy/`, with the grants (Dockerfile, engine…: [the grants](../server-folder.md#the-grants)) (the server folder's). The runner must read the same folder: it checks every sandbox spec and build against it again, and the grants with the policy service (`compose.yaml` gives it the orchestrator's).
- **`GRANTS_DIR`** (policy service) · environment only · default: `/etc/deckhand/grants`\
  Where the policy service reads your policies (`policy/*.rego`), found as the orchestrator finds it: the environment's, else `config.yaml`'s `grants_dir`, else the default. Both must read the same files there: the orchestrator reads its own and refuses every policy decision when the service's are others (none included), and logs why at start.
- **`DASHBOARD_DIR`** · environment only · default: the image's `dashboard/dist`\
  The built dashboard edge serves.
- **`KEY_DIR`** (broker) · environment only · default: `/keys`\
  The folder of the broker's signing key, `run-token.key`, made on first start (the `broker-keys` volume): back it up, or every running sandbox's token is refused once it is gone.
- **`APP_DIR`** (github service) · environment only · default: `/app-key`\
  The folder of the App's credentials, its key with them (`app.json`, the `github-key` volume): back it up.
- **`SERVICE_KEYS_DIR`** (broker, policy service, runner) · environment only · default: broker: none, not published; policy service: `/keys`; runner: `/service-keys`\
  Where the broker writes its public key (`<kid>.pem`) and the policy service and the runner read it, to check their callers' service tokens offline (the `service-keys` volume); compose sets it.

The services' state, `DATA_DIR` and each one's `STORE_URL`: [The store](store.md).

## Addresses and ports

- **`PORT`** (in the containers) · environment only · default: `8080`, egress proxy: `3128`, policy service: `8181`\
  Port edge, the runner, the policy service and the proxy listen on (the orchestrator has none: its ports are `POLICY_PORT` and `SERVICES_PORT`); the `PORT` above only changes the published one.
- **`PORT`** (broker) · environment only · default: `8081`\
  The port the broker listens on.
- **`PORT`** (models service) · environment only · default: `8080`\
  The port it listens on.
- **`SERVICES_PORT`** · environment only · default: `8083`\
  The orchestrator's services port, where the runner calls it (a run's first tokens) and edge passes the dashboard's API on, on the networks they share.
- **`INTERNAL_PORT`** (edge) · environment only · default: `8083`\
  The port the orchestrator calls edge on (the deliveries' stream, the App's public parts), on their network alone; never `PORT`'s, which the internet reaches.
- **`POLICY_PORT`** · environment only · default: `8082`\
  Port of the egress policy the proxy asks about each connection: open until the orchestrator exits.
- **`RUNNER_URL`** · environment only · default: `http://runner:8080`\
  The [runner service](../../contributing/each-service.md#the-runner-service), as the orchestrator calls it; several, comma-separated, for its copies, tried in turn.
- **`EDGE_URL`** (orchestrator) · environment only · default: `http://edge:8083`\
  Edge's internal port: where the orchestrator reads the deliveries' stream and the App's public parts; compose sets it.
- **`ORCHESTRATOR_URL`** (edge) · environment only · default: `http://orchestrator:8083`\
  The orchestrator's services port, where edge passes the dashboard's API, `/status` and the screenshots on; compose sets it.
- **`ORCHESTRATOR_URL`** (runner) · environment only · default: `http://orchestrator:8083`\
  The orchestrator's services port, where the runner gets a run's first tokens.
- **`BROKER_SERVICE_URL`** · environment only · default: `http://broker:8081`\
  The [broker service](../../guides/services.md#the-broker-service), where the orchestrator asks for the runs' tokens, and edge and the orchestrator for their own service tokens; compose sets it.
- **`BROKER_SERVICE_URL`** (runner) · environment only · default: `http://broker:8081`\
  The [broker service](../../guides/services.md#the-broker-service), where the runner asks for its service tokens and copies the runs' inboxes and files.
- **`BROKER_SERVICE_URL`** (egress proxy) · environment only · default: `http://broker:8081`\
  The broker service, one URL, where the proxy sends what a sandbox calls about its own run (`/run/…` on `http://broker:8081`, the name sandboxes call it by: its token's renewal, its inbox and files) with its own service token, and asks for that token; compose sets it.
- **`GITHUB_SERVICE_URL`** (runner) · environment only · default: `http://github:8080`\
  Where the runner gets the repos' tarballs: the github service.
- **`GITHUB_SERVICE_URL`** (edge, orchestrator, runner, egress proxy) · environment only · default: `http://github:8080`\
  The github service, which holds the App's key: the orchestrator's GitHub calls, edge's (`/setup`'s conversion, the redeliveries), the runner's tarballs, the sandboxes' GitHub calls and pushes (`/git/…` on `http://github:8080`, the name sandboxes call it by; one URL for the proxy).
- **`MODELS_SERVICE_URL`** · environment only · default: `http://models:8080`\
  The [models service](../../guides/services.md#the-models-service), comma-separated for its copies: where the orchestrator asks which agents' credentials it holds and their fingerprints (waiting for both at start) and a run's API state; compose sets it.
- **`MODELS_SERVICE_URL`** (egress proxy) · environment only · default: `http://models:8080`\
  The models service, one URL (not comma-separated: the proxy stops at start otherwise; several copies go behind one address), where the proxy sends the sandboxes' agent calls (`/anthropic/`, `/openai/`, `/google/` on `http://models:8080`, the name sandboxes call it by, and the hosts relayed for an agent) with its own service token; compose sets it.
- **`BROKER_SERVICE_URL`, `RUNNER_URL`, `SERVICE_KEYS_DIR`** (models service) · environment only · default: `http://broker:8081`, `http://runner:8080`, `/service-keys`\
  The broker (its service tokens, whether a run goes), the runner (the Antigravity login's refresh), and the broker's public keys, which its callers' service tokens are checked with.
- **`POLICY_SERVICE_URL`** · environment only · default: `http://policy:8181`\
  The [policy service](../../contributing/services.md), which evaluates every policy decision, the config checks and the Policies tab; compose sets it. A decision waits up to 30 s for a service that refuses its connection (restarting), then refuses.
- **`EGRESS_PROXY`** · environment only · default: `http://egress:3128`\
  The egress proxy, as sandboxes reach it; compose sets it.

## Who calls whom

Each service takes calls only from the services that may make them, told apart by the network a
call arrives on (Docker) or the caller's service account (Kubernetes): see
[The services' networks](../../security/services.md#the-services-networks).

- **`SERVICE_NETWORKS`** · environment only · default: none: no call taken\
  Which network each calling service is on, by its subnet (on the orchestrator `runner=…,edge=…`; on the runner `orchestrator=…,models=…`): a call from elsewhere, or with another's token, is refused; `none` where the network can't tell (Kubernetes, with NetworkPolicies and the callers' service accounts: [What the manifests set up, and why](../../kubernetes/isolation.md#what-the-manifests-set-up-and-why)). Compose sets them from `RUNNER_SUBNET`, `EDGE_ORCHESTRATOR_SUBNET` and `RUNNER_MODELS_SUBNET`.
- **`SERVICE_NETWORKS`** (edge) · environment only · default: none: no call taken\
  The orchestrator's network to edge's internal port, `orchestrator=<subnet>`; compose sets it from `EDGE_ORCHESTRATOR_SUBNET`; `none` on Kubernetes.
- **`SERVICE_NETWORKS`** (policy service) · environment only · default: none: not checked\
  The subnet of each caller's network, `orchestrator=172.30.2.0/24,…`: a call is refused unless it arrives on its token's caller's network. Compose leaves it unset: its table still names what the orchestrator, the github service and the runner, each on a network of its own, may call.
- **`SERVICE_NETWORKS`** (broker) · environment only · default: none; compose sets it\
  With Docker, who calls the broker, by the network a call arrives on: `orchestrator=<subnet>,edge=<subnet>,proxy=<subnet>,runner=<subnet>,models=<subnet>,github=<subnet>`, each caller's own network to the broker; this or `SERVICE_ACCOUNTS` is required.
- **`SERVICE_NETWORKS`** (github service) · environment only · default: none: it doesn't start; compose sets it\
  Each caller's network, `service=subnet`; `none` on Kubernetes.
- **`SERVICE_NETWORKS`** (models service) · environment only · default: none: no call taken (`none` on Kubernetes)\
  Who calls it, by the network a call arrives on: `proxy=<subnet>,orchestrator=<subnet>`; compose sets it.
- **`SERVICE_ACCOUNTS`** (broker) · environment only · default: none\
  On Kubernetes, who calls the broker, by its pod's service account: `orchestrator=<namespace>:<name>,edge=<namespace>:<name>,proxy=<namespace>:<name>,runner=<namespace>:<name>,models=<namespace>:<name>,github=<namespace>:<name>`.
- **`SERVICE_ACCOUNT_TOKEN_FILE`** (edge, orchestrator, egress proxy, runner, github, models) · environment only · default: none\
  On Kubernetes, the pod's service account token projected for the broker (audience `deckhand-broker`), which proves to it who calls (see [kubernetes.md](../../kubernetes.md)).

## Compose's networks

Their subnets, in `.env`: change one when it overlaps one of the host's networks.

- **`RUNNER_SUBNET`** (compose) · default: `10.231.250.48/28`\
  The subnet of the network the orchestrator and the runner share (`runner`) (`.env`), should it overlap one of the host's.
- **`EDGE_ORCHESTRATOR_SUBNET`** (compose) · default: `10.231.250.192/28`\
  The subnet of the network edge and the orchestrator share (`edge-orchestrator`), should it overlap one of the host's.
- **`BROKER_ORCHESTRATOR_SUBNET`, `BROKER_EDGE_SUBNET`, `BROKER_PROXY_SUBNET`, `BROKER_RUNNER_SUBNET`, `BROKER_MODELS_SUBNET`** (`.env`) · default: `10.231.250.0/28`, `10.231.250.208/28`, `10.231.250.16/28`, `10.231.250.32/28`, `10.231.250.64/28`\
  The subnets of compose's networks between the broker and its callers, which `SERVICE_NETWORKS` names: change them in `.env` if they clash with one of the host's.
- **`GITHUB_ORCHESTRATOR_SUBNET`, `GITHUB_EDGE_SUBNET`, `GITHUB_PROXY_SUBNET`, `GITHUB_RUNNER_SUBNET`, `BROKER_GITHUB_SUBNET`** (`.env`) · default: `10.231.250.128/28`, `10.231.250.224/28`, `10.231.250.144/28`, `10.231.250.160/28`, `10.231.250.176/28`\
  The github service's networks.
- **`MODELS_PROXY_SUBNET`, `MODELS_ORCHESTRATOR_SUBNET`, `RUNNER_MODELS_SUBNET`** (`.env`) · default: `10.231.250.80/28`, `10.231.250.96/28`, `10.231.250.112/28`\
  The subnets of the models service's networks to its callers and to the runner, which tell them apart.

## Stopping and handing over

How long each service lets its calls finish when it stops, and the orchestrator's lease
([Running two copies](../../guides/two-copies.md)).

- **`LEASE_SECONDS`** (orchestrator) · environment only · default: `15`\
  How long the acting copy's lease lasts, renewed every third of it: a crashed copy's is taken by the waiting one once it expires; a stopping one releases it at once (see [Two copies](../../guides/two-copies.md)).
- **`DRAIN_SECONDS`** (edge) · environment only · default: `25`\
  How long a stopping copy lets its requests finish (a live log), under compose's `stop_grace_period` of 30 s.
- **`DRAIN_SECONDS`** (runner) · environment only · default: `280`\
  How long a stopping runner lets its calls in flight finish (an image's build) before it releases its lease; its output streams end at once.
- **`DRAIN_SECONDS`** (broker) · environment only · default: `30`\
  How long a stopping broker lets its calls finish (an inbox's long poll lasts 25 s), under its `stop_grace_period`.
- **`DRAIN_SECONDS`** (github service) · environment only · default: `280`\
  How long a stopping copy lets its calls finish (pushes, clones).
- **`DRAIN_SECONDS`** (models service) · environment only · default: `600`\
  How long a stopping copy lets the agents' calls in flight finish.
- **`DRAIN_SECONDS`** (egress proxy) · environment only · default: `25`\
  How long a stopping proxy lets its open connections finish, then cuts them: short with one copy (compose), whose stop refuses new connections until the next one starts; `600`, an agent call's length, where a second copy takes them meanwhile (Kubernetes, [The proxy's handover](../../contributing/upgrades.md#the-proxys-handover)); under its `stop_grace_period` or `terminationGracePeriodSeconds`.

## The egress proxy

- **`POLICY_URL`** (egress proxy) · environment only · default: `http://orchestrator:8082/egress`\
  Where the proxy asks whether a sandbox may reach a host: the orchestrator's `POLICY_PORT` (Kubernetes: with 8082 on the orchestrator's Service).
- **`EGRESS_CONTAINER`** (runner) · environment only · default: labelled `deckhand.role=egress`\
  The egress proxy's container, which the runner joins to each run's network; by default, the one in the runner's compose project.
- **`EGRESS_CACHE_DIR`** (egress proxy) · environment only · default: `/cache`\
  Where the proxy keeps the [egress cache](../../security/network.md#the-egress-cache) and its CA (`ca/`, the `egress-cache` volume).
- **`EGRESS_CACHE_MAX`** (egress proxy) · environment only · default: `10g`\
  The egress cache's size, in bytes or with `k`, `m`, `g`, `t`; the least recently used answers go beyond it; `0`: no cache.
- **`EGRESS_CACHE_ENTRY_MAX`** (egress proxy) · environment only · default: `1g`\
  The largest answer it keeps.

Which hosts it caches is a grant, `cached_hosts`: [Download cache](../../guides/download-cache.md).
