# The services

Who holds which secret, what a hole in each service gives, and the networks between them. Part of the [Security overview](../security.md).

Deckhand runs as services, split by the secret each one holds and what each one can reach
(#499, [services.md](../services.md)): each secret is in one service, and the only one the internet
reaches holds neither the App's key, the agents' credentials nor the Docker socket. Each service
takes from each caller only the endpoints that caller needs ([Service tokens](tokens.md#service-tokens)),
and shares a network only with the services it calls or is called by
([The services' networks](#the-services-networks)). Their diagram, with the trust boundaries
(public, internal, the runs' networks), is in [services.md](../services.md). What a hole in each one
gives:

| Service                                         | Holds                                                                                   | A hole in it gives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [edge](webhooks-and-sign-in.md#edge)            | the webhook secret, the session key, the OAuth client's                                 | forged deliveries and sessions (any allowed user's dashboard); through the github service, reads, the redeliveries and /setup's conversion (refused once an App is held) only: no token minted, no write                                                                                                                                                                                                                                                                                                                                  |
| [orchestrator](#the-orchestrator)               | nothing secret                                                                          | what it decides: runs started (each spec checked again by the runner against the grants), the App's writes through the github service, a run's first tokens with the claims it picks; no way out but the services it calls; no sandbox calls it (the egress proxy asks its egress policy)                                                                                                                                                                                                                                                 |
| [runner](#the-runner-service)                   | the Docker socket or the Kubernetes API; blob storage's key pair (`BLOB_URL`), when set | with Docker, the host (the socket is root on it), and with it every service's secrets on that host (the App's key, the signing key, the agents' credentials, in their volumes); on Kubernetes, the sandboxes' namespace (with the services in another, only the registry's pull Secret of theirs, [Namespaces](../kubernetes.md#namespaces)); with blob storage set, its bucket (or folder), to read, overwrite or delete. Beyond that key pair, it holds no credential itself                                                            |
| [broker](#the-broker-service)                   | the tokens' signing key; blob storage's key pair (`BLOB_URL`), when set                 | every live run's inbox and digest, so it can direct their agents; tokens with any claims for a live run, handed to its sandbox at renewal, and so pushes through it to any repository the App is installed on (any branch but the default, as the push policies allow) and any of the operator's agent credentials; the `runs` stream the orchestrator reads (run ends, screenshots); with blob storage set, its bucket (or folder), to read, overwrite or delete. Outside a live run's own network (or pod), none of its tokens is taken |
| [github](#the-github-service)                   | the App's key, its installation tokens                                                  | the App, on every repository it is installed on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [models](models.md#the-models-service)          | the operator's agent credentials                                                        | those credentials                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [policy](../architecture.md#the-policy-service) | nothing secret                                                                          | wrong decisions for its callers: a run's capabilities, the grants the runner checks every spec against again, the runs' writes and pushes; no network but its callers', so nothing else                                                                                                                                                                                                                                                                                                                                                   |
| [egress proxy](network.md#network)              | Deckhand's CA                                                                           | the runs' traffic, and the hosts they are granted; every live run's tokens, used as its own sandbox (it is the one vouching for it), and so their pushes, writes and agent calls                                                                                                                                                                                                                                                                                                                                                          |

The runs reach none of them directly: only the egress proxy is on their networks (on
Kubernetes, the only pods the NetworkPolicy lets them reach), and it relays their calls to the
github service, the models service and the broker, vouching for the sandbox each came from. No
sandbox calls the orchestrator: the proxy asks its egress policy about their connections.

## The orchestrator

Everything else is the **orchestrator**'s (`orchestrator/server.mjs`, #506): deliveries become
tasks, the queue, the runs' lives (started through the runner, their replies, reactions and labels
through the github service), what it starts by itself (reviews, fixes, auto-merge…), the
dashboard's data, and the egress policy the proxy asks. It **holds no secret**: none of its
settings is one (`test/networks.test.mjs` reads `compose.yaml`'s environments), and no secret's
volume is mounted in it; its `data` volume holds its store's folder alone, and with Redis as
its store it has no volume (#619). It **has no way
out**: every network it is on is internal ([The services' networks](#the-services-networks)).
Its ports: the services port (8083: the runner's `POST /runs/:run/tokens`, edge's `/edge/*`)
and the egress policy's (8082, the egress proxy's). None is published. It runs as `node`
(uid 1000, #536), on a read-only root filesystem, without capabilities: it writes its store's
folder alone (nothing with Redis), and reads the server folder and the mount roots you grant as that user.

- **One copy acts.** Two may run: the acting one holds the store's lease `orchestrator`
  (`lib/active.mjs`, 15 seconds, `LEASE_SECONDS`, renewed every third of its life); the other
  arms no timer and reads no stream until it takes the lease, its services port answering its
  probes alone (`/health`, and `/ready` 503) and `503` to every call. On SIGTERM the
  acting copy saves its state and releases the lease, which the other takes in about a second;
  on a crash, once it expires. A copy that loses its lease while acting exits.
- **Fencing.** Each new holder gets a higher epoch (at least the time in ms), sent with every
  call to the github service, the runner and the broker (`x-deckhand-epoch`), which keep the
  newest they have seen in their store and refuse an older one (`409`, `lib/fence.mjs`; one
  more than a day ahead of their clock, `400`). The github service fences every call that
  changes something, the broker every call but a `GET` (new in #506), the runner every call but
  its lookups for the egress policy and its log reads, which write nothing. So a copy that lost
  its lease (paused, say, and woken after the other took over) can't post a reply, start or stop
  a run, end one at the broker or have a token signed.
- **Idempotency.** An event the next copy handles again does nothing twice: a reply carries a
  key by its run and kind (`<run>:reply`), which the github service keeps a day with its answer;
  a run's start is keyed by its run's id at the runner; and a delivery handled whose
  acknowledgement was lost is noted by its GUID in the orchestrator's store
  (`deliveries/handled/<guid>`, an hour) and skipped.

## The runner service

The host's Docker socket is root on the host, and the Kubernetes API's credentials can start
any pod in the sandboxes' namespace (`KUBERNETES_NAMESPACE`; with the services in a namespace
of their own, `KUBERNETES_SERVICES_NAMESPACE`, its Role there reads no Secret but the
registry's pull Secret, so none of the services' keys, and that namespace may enforce Pod
Security `restricted`, [Namespaces](../kubernetes.md#namespaces)): only the runner service holds either (`runner/`, #503,
[architecture.md](../architecture.md#the-runner-service)). Edge, which the internet reaches
(webhooks, the dashboard), has neither, nor does the orchestrator: a hole in either doesn't give
the host. What the runner
does, it does for its callers, each endpoint naming which (`runner/service.mjs` `ROUTES`, checked
with their service tokens first, below):

| Caller       | May                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| orchestrator | start, follow, message, stop and remove sandboxes, and a chat's session volumes; build images, install agents, prepare caches; write and remove logs; and, for the egress policy, ask where an address is, the egress proxy's addresses, whether a sandbox installs its agent, and read a run's inbox and files, and read a run's log, for the dashboard's live view too, which edge passes on (unfenced: a copy still draining answers the proxy) |
| models       | have the Antigravity login refreshed: it sends the token file, never a container to run                                                                                                                                                                                                                                                                                                                                                            |

None can act on a container or a network that isn't one of this deployment's runs: the runner
stops, follows and removes only the sandboxes it lists by their labels (`deckhand.owner`,
`deckhand.run`), their engines, volumes, pods and Secrets only when their own labels say they are
that run's, a sandbox's run must be its own (`<name>-<ms>`), and a network goes only when its
labels say it is that run's (a start removes only the one it made). Session volumes go only for
a chat's reset or deletion (`DELETE /sessions/<name>?task=<key>`): the key must be a chat's
(`<repo>#chat-<16 hex digits>`), the name its sandbox's (`runner/spec-check.mjs`
`chatSandbox()`), with no sandbox of that name left, and only that sandbox's session volumes
labelled as this deployment's sessions (`deckhand.owner`, `deckhand.role=session`; on Docker,
one without labels, made before session volumes had them, goes by its name alone): an issue's
are never removed. Those labels name the deployment by its prefix (`NAME_PREFIX`), so a runner
first claims its prefix on the engine, or in the sandboxes' namespace
(`listener/runner/deployment.mjs`). It does this with a marker: a volume, or a Secret,
`<prefix>-deployment`, labelled with an ID that the deployment keeps in the runner's store. The
first runner to claim the prefix makes the marker, and the marker never changes after that. A
runner whose ID isn't the marker's takes no call (503), says why in its log and its `/health`,
and asks again at the next call. So two deployments that share a prefix on one engine can't
reach each other's sandboxes, volumes or networks: the second one doesn't run at all. None can name a container's
image, mounts or capabilities beyond a sandbox spec
(`listener/sandbox-spec.mjs`), which the runner turns into Docker's options: `--cap-drop ALL`, `no-new-privileges`, the operator's limits and a user. And it
checks the spec again first, against the grants folder it reads itself and the operator's
policies it asks the policy service itself ([the grants](../reference/server-folder.md#the-grants): `runner/spec-check.mjs`):
the sandbox's user, no capability, the base image or the run's repository's own, the task's own
sandbox name (from its `deckhand.task`) and exactly its session volumes, the agents' volumes
read-only and the repository's own caches, plain volume names and paths (nothing Docker would
read as another option), host paths resolved again (`..`, symlinks, in its own filesystem: mount
each granted root on the runner too) inside a root granted to that repository, read-only unless
granted read-write, an engine only with the `docker` grant, the operator's limits for the repository
(its engine's too), its task's label only, and no environment variable that would change what
its own docker CLI does (`LD_*`, `DOCKER_*`, `SSL_CERT_*`, `PATH`…: one list, which the CLI keeps
its own values for, `listener/runner/docker.mjs` `cliName()`). A cache volume is prepared (as
root, to hand it to the sandbox's user) only in the base image or the repository's own, at plain
paths. A repo image builds only with the `dockerfile` grant (a branch's with
`branch_docker_images`), from what the runner decides: the default branch's files unless a
branch's is asked and granted, the Dockerfile's blob as the github service says it (`GET
/blobs/…`), the hosts the grants give (`runner/builds.mjs`). A compromised orchestrator can
still start a run, but not one it names as root on the host.

The runner holds no GitHub credential either: a
build's context starts from the repository's tarball, which it gets from the
[github service](#the-github-service) (`GET /tarballs/<owner>/<repo>[/<ref>]` and a file's
blob id, `GET /blobs/…`, the runner's only routes there, for an allowed repository, its names,
path and ref checked before they make an API path), never from the orchestrator, which can't serve
it files of its own (#502): a compromised orchestrator can't make an image build run its
own files on the host. A run's first tokens come from the
orchestrator (`POST /runs/<run>/tokens`, only while that run starts), which has the broker sign
them with its own claims: the runner can't choose what a run's tokens allow. Every orchestrator call carries its
fencing epoch: an older one than the newest the runner saw is refused (`409`).

On Docker, the runner and the orchestrator share one internal network (`runner` in
`compose.yaml`, `RUNNER_SUBNET`), which nothing else is on and which has no way out; the runner
is on no other but `runner-models`, `broker-runner`, `github-runner` and `policy-runner`, below.
Each tells its caller by the subnet a call arrives on (`SERVICE_NETWORKS`): the runner takes the
orchestrator there and the models service on `runner-models`; the orchestrator's services port
takes the runner there and edge on `edge-orchestrator` alone. The runner has one more network, to the broker service alone (`broker-runner`): its
own service tokens, the runs' inboxes and files it copies there. It checks its callers' tokens
with the broker's public keys (the `service-keys` volume, read-only).

## The github service

The GitHub App's private key mints installation tokens for every repository the App is installed
on: only the github service holds it (`github/`, #502, [architecture.md](../architecture.md#the-github-service)),
in its own volume (`github-key`, `APP_DIR`: `app.json`, owner-only; a Secret on Kubernetes), never
in its store nor in another service's. Edge, which the internet reaches, keeps the App's
names, its webhook secret and its OAuth client's (`app.json` in its own volume, `edge-data`),
never the key; the orchestrator gets the App's public parts from edge (`GET /app`), nothing
secret. Its installation tokens stay in the service: the runs' calls go on with a token minted
for that call (below), edge's and the orchestrator's own with one they never get.

What each caller may do (`github/service.mjs` `ROUTES`, checked with their service tokens first):

| Caller       | May                                                                                                                                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| proxy        | the sandboxes' calls: the [GitHub gateway](github.md#the-github-gateway) (`/relay/<host>/…`) and the git gateway (`/git/…`), the network (or pod) they came from vouched for (`X-Deckhand-Sandbox`), their own credential passed on apart (`X-Deckhand-Run-Authorization`)                                                 |
| orchestrator | its own GitHub calls, reads and writes, as a repository's installation (`/as/<owner>/<repo>/<path>`), GraphQL, as the App (`/as-app/…`: reads only); the runs it starts and ends (`/runs/<id>`), its reactions, the events; the sandboxes' calls it relays                                                                 |
| edge         | reads: `GET`s as a repository's installation, as the App or one installation (the repositories it lists), GraphQL without a mutation (or a subscription), the App's public parts; the App's one write, a delivery's redelivery (never a token minted, the webhook changed or an installation removed); /setup's conversion |
| runner       | a repository's tarball and a file's blob id, nothing else of GitHub's                                                                                                                                                                                                                                                      |

Edge calls as edge, from its own network (`github-edge`): its one write is a delivery's
redelivery (`POST /as-app/app/hook/deliveries/:id/attempts`), and /setup's conversion is its
(`POST /app/manifest`). Every
orchestrator call that changes something carries its fencing epoch, refused when stale (`409`),
so that a copy that lost its lease writes nothing; and a write may carry an idempotency key
(`Idempotency-Key`: a run's reply has `<run>:reply`), which the service keeps a day with its
answer, in its store: asked again, through either copy, it isn't made twice, its first answer
given again. A write GitHub refused isn't kept: asked again, it is tried again.

**What a run did** is in the service's store, so that both copies agree on it: the
orchestrator tells the service of each run as its sandbox's network is known (`PUT /runs/<id>`:
its repository, mode, issue, branches, capabilities, the network or pod its tokens are bound to,
whom its writes may assign), and its end (`DELETE`). The issues it created, the comments it
posted, the reactions it added and the workflow runs it reran are changed with compare-and-set
(`github/runs.mjs` `update()`), a rerun counted against `MAX_RERUNS` on the latest state as its
slot is taken; and each is kept before GitHub's answer ends for the sandbox (`settle`,
`listener/upstream.mjs`), so that its next call sees it, whichever copy takes it. The orchestrator's
own reactions are noted there before GitHub is asked (`PUT /reactions`). The limit of 16 calls in flight per run is a set of slots in the
store, one per call, taken and given back with compare-and-set, renewed while its call goes on
and lapsing a minute after a copy stops renewing it (a crash), what GitHub advertised to a run's git is shared too (a fetch's pack
request may reach the other copy), and the pushes, a run's notes and the pull requests runs
change reach the orchestrator as events it acknowledges. Each copy keeps its own installation
tokens and git mirrors: caches only.

**Its networks**, with Docker: one per caller, internal, each with a fixed subnet the service
tells its callers by (`SERVICE_NETWORKS`: `github-orchestrator`, `github-edge`,
`github-proxy`, `github-runner`), its own to the broker (`broker-github`) and to the policy
service (`policy-github`), and its way out to GitHub, `github-out`, which nothing else is on:
on a network its callers are on too, its name would resolve there, and their calls would arrive
on no caller's network. Beyond GitHub's API and git, it reads one public page there:
githubstatus.com's summary, every 5 minutes, with no token nor anything of Deckhand's in the
call (`github/status.mjs`, #681), for the Server page.

**The key.** A new App's key never reaches edge: /setup has the service convert the manifest's code
(`POST /app/manifest`, edge alone), which keeps the key and answers with the rest. GitHub
converts a code once: the rest is kept beside the key for an hour (`setup.json`), so that an
edge that didn't get the answer gets it by asking again with the same code (its /setup
callback loaded again), and goes then. No other way in: the service takes no key from another
service (#820).

**The operator's credentials** (the agents' keys, the plans' logins) are no service's but the
models service's (#504): the github service redacts them from the runs' writes without
holding them, by their **fingerprints** (`lib/fingerprints.mjs`): the orchestrator relays the
models service's, a salted SHA-256 of each whole credential, with its length and 12 bits of a rolling hash that
finds the candidates quickly (only 12: that hash is linear, and the whole of it would spare
someone reading the store most of the work of guessing a short credential whose start is known) (`PUT /fingerprints`, again when a login is refreshed), and the gateway
redacts each part of a write of that length whose hashes match.
Never a hash of one of its parts: parts that overlap would give a credential away a character at
a time, from what is known of its shape. So a credential cut short in a write isn't found, where
`redact()` would find it down to 16 characters: the cost of the service not holding it.

## The broker service

The broker (`broker/`, #505) is the only service holding the **signing key** of the
[run tokens](tokens.md#run-tokens) and of the [service tokens](tokens.md#service-tokens): `run-token.key` in its
own volume (`broker-keys`, owner-only, made on first start), never in its store nor another
service's. Every other service checks those tokens offline with its public keys (`GET /keys`,
and the `service-keys` volume it alone writes), and none can sign one. Its store holds the live
runs (their claims, the network or pod their tokens are bound to), their inbox, CA, digest,
the screenshots' names (the screenshots themselves are in blob storage, `BLOB_URL`, or in the
store without it: [Run files](../architecture.md#run-files)), and the `runs` stream the orchestrator
reads; the tokens it signed only sealed, with a key derived from its signing key
(`broker/seal.mjs`), which it answers the orchestrator alone, for redaction (`POST
/runs/:id/secrets`).

**What each caller may do** (`broker/http.mjs` `ROUTES`): the orchestrator the live runs, their end,
the stream, the screenshots it moves there from an older release's folder and those retention
removes; a run's first tokens, which it asks for when the runner
asks it (their claims are the orchestrator's, never the runner's), and a live run's tokens, to
redact its output once it took it over (`POST /runs/:id/secrets`, #617); the runner the runs' inboxes
and files it copies there; the proxy the sandboxes' calls about their own run. Each
orchestrator call but a `GET` carries its fencing epoch, refused when stale (`409`, #506): a copy
that lost its lease ends no run and gets no token signed, nor read. The models service asks it whether
a run still goes, and its agent's provider (`GET /runs/:id`). Edge, on `broker-edge`, reads a
screenshot (`GET /shots/<folder>/<file>`, which it serves to anyone, #609), nothing else. The
other services get their own service tokens there and nothing else.

A hole in the broker has every live run's inbox and digest: the inbox is the agent's input
(`sandbox/entrypoint.sh` feeds `deckhand-inbox` to it), so it can write messages into every
running agent, and it can forge the `runs` stream the orchestrator reads (run ends,
screenshots), and the screenshots edge serves. And it signs any token: the services check that a run token names a live run
and the sandbox the call came from, but take what it may do from its claims (the git gateway
its `repo` and `branches`, the models service its `agent`). So a token it signs for a live run,
with other claims, and hands that run's sandbox at its next renewal (`POST /run/token`) pushes
through it to any repository the App is installed on (any branch but the default, as the push
policies allow), and reaches any of the operator's agent credentials. Outside a live run's
sandbox, though, a token is only taken where it is bound: a run's from
its own sandbox's network (or pod), which the proxy vouches for, a service's from its caller's
own network to the service it calls. The broker is on none of those: with Docker, only on one
network per caller (`broker-orchestrator`, `broker-edge`, `broker-proxy`, `broker-runner`,
`broker-models`, `broker-github`), internal, with no way out, where the service on the other
side takes no call that arrives from the broker's address as another caller's; on Kubernetes,
NetworkPolicies keep it there, and both copies mount the same key's Secret
([On Kubernetes](kubernetes.md#on-kubernetes)). With Compose, one copy runs
([architecture.md](../architecture.md#the-broker-service)).

## Blob storage

Blob storage (`BLOB_URL`, [Blob storage](../guides/blob-storage.md), #604) holds what the runner and the
broker keep and will never change again: the runs' closed log segments (`logs/`) and their
screenshots (`shots/`). Its key pair (`BLOB_ACCESS_KEY_ID`, `BLOB_SECRET_ACCESS_KEY`, or their
`_FILE` forms) is **the runner's and the broker's alone**: no other service's environment,
volume or Secret holds it (`test/networks.test.mjs` reads `compose.yaml`'s, and
`test/kubernetes-manifests.test.mjs` the manifests'), and neither service puts it in its store
(refused in a value, redacted from a blob), its log or blob storage itself (redacted from what it
writes there, `lib/blobs.mjs`). It is never in `BLOB_URL`, which refuses it there, and a secret
key shorter than 16 characters, which redaction couldn't tell from ordinary text, stops the
service.

**What a leaked key reaches**: that bucket (or prefix), to read, overwrite and delete, and
nothing else when the key is allowed that bucket alone ([What a server needs](../guides/blob-storage.md#what-a-server-needs)).
What is there was redacted before it was written: the logs as every run log is (the operator's
credentials, the run's tokens and its GitHub tokens, [Output](mounts-and-engine.md#output)), the screenshots are
what the agents saved, which edge serves to anyone with their link anyway. Overwriting a log's
segment changes what the dashboard shows of a finished run, and deleting one or a screenshot
loses it: no run, token, key or credential of Deckhand's is there to take. A copy whose segment
measures otherwise once moved leaves it in the store rather than trust it.

**Why the orchestrator and edge never hold it**: the orchestrator holds no secret at all (#506),
and edge, the only service the internet reaches, only its own three. Neither needs it: the
dashboard reads a run's log through the runner (`GET /logs/<run>`, which answers from the store
or with a ranged GET) and a screenshot through the broker (`GET /shots/…`, streamed through edge),
so a hole in either reads the logs and screenshots those calls give, never the bucket. The
runner and the broker are already where those blobs live: they write them, so their key adds no
reach beyond the blobs they hold.

With Compose, the runner and the broker reach Garage (the `garage` profile) over a network each
(`blobs-runner`, `blobs-broker`), internal, with Garage alone on the other side; a server elsewhere
needs a way out for both, which an override of the operator's adds ([A server outside Compose](../guides/blob-storage.md#a-server-outside-compose)).
On Kubernetes, `components/blobs` lets them out to its address alone (`deckhand-blobs`,
[On Kubernetes](kubernetes.md#on-kubernetes)).

## The services' networks

The runs' networks hold the egress proxy and the sandboxes only:
from a sandbox, every service is reached through the proxy, which vouches for the sandbox
(`X-Deckhand-Sandbox`), never directly. Two services share a network only when one calls the
other, and a service is on no network it doesn't call or isn't called over, but its way out
when it needs one (webhooks, GitHub, the agents' APIs, registries, the granted hosts).
`test/networks.test.mjs` reads `compose.yaml` and fails otherwise, checks that the broker's, the
runner's, the models service's and the github service's `SERVICE_NETWORKS` name each caller's own
network, and checks which containers the runner joins to a run's network. The broker, the github
service, the models service and edge are on none of them (#505, #502, #504, #506). Nor is
the orchestrator: no sandbox calls it.

**The models service's table** (`models/http.mjs` `ROUTES`): the proxy the sandboxes' agent calls
(`/anthropic/`, `/openai/`, `/google/`, `/relay/<host>/`), with the network it vouches they came
from; the orchestrator which credentials it holds (names), their fingerprints, a run's API state
and the `models` stream. It is on networks of its own with each: `models-proxy`,
`models-orchestrator`, internal, with fixed subnets it tells them by (`SERVICE_NETWORKS`); and on
`broker-models` and `runner-models` to the services it calls, and its way out to the agents'
APIs, `models-out`, with nothing else on it ([The models service](models.md#the-models-service)). Not
`default`, where its callers are: Docker's DNS answers a name with its address on a network that
isn't internal first, and a call arriving there names no caller. The networks test checks that a
service and each of its callers share only the network `SERVICE_NETWORKS` names.

The runner is on one network, `runner`, internal and shared with the orchestrator alone, with a
fixed subnet each tells its caller by (`SERVICE_NETWORKS`, [The runner service](#the-runner-service)),
and on `runner-models`, the models service's, for the Antigravity login's refresh.
The policy service (#501), with Docker Compose, is on three others, internal (no way out):
`policy`, shared with the orchestrator alone, `policy-github`, shared with the github service alone
(the runs' writes and pushes), and `policy-runner`, shared with the runner alone, which asks
it [the grants](../reference/server-folder.md#the-grants) (`GET /policies` and `POST /evaluate` only, never `/capabilities`,
`/access` or `/check`). Compose doesn't set its `SERVICE_NETWORKS`: its table still names what each
caller may call. The orchestrator's service tokens come
from the broker service, as every other's, and the broker publishes the public key the
policy service and the runner check them with (`SERVICE_KEYS_DIR`, the `service-keys` volume,
which only the broker writes).

Edge and the orchestrator (#506) are two services, each with its own networks to the broker,
the github service and each other: no network is theirs together but `edge-orchestrator`.
**Edge** is on `edge-out`, its way in and out (the published port, browsers, GitHub's sign-in),
a network of its own rather than the proxy's `default`; `edge-orchestrator` (internal,
`EDGE_ORCHESTRATOR_SUBNET`); `broker-edge` (its service tokens) and `github-edge` (/setup's
conversion, the redeliveries, the App's reads). **The orchestrator** has no way out: every network
it is on is internal (`broker-orchestrator`, `runner`, `github-orchestrator`, `policy`,
`models-orchestrator`, `edge-orchestrator`, and `orchestrator-proxy`, where the egress proxy asks
its egress policy). So a hole in the orchestrator reaches the internet
only through the services it calls, and a hole in edge reaches the orchestrator only through the
ports [Edge](webhooks-and-sign-in.md#edge) lists.

To check it by hand, from inside a running sandbox (`docker exec -it <sandbox> sh`), for each
service (`<service>:<port>`, as `compose.yaml` names them):

```sh
# Called directly: no route, the run's network is internal and the service isn't on it.
curl -m 5 --noproxy '*' http://<service>:<port>/    # fails: no such host, or a timeout
# Through the proxy: refused, unless it is one the proxy relays the run's calls to.
curl -m 5 http://<service>:<port>/                  # 403 from Deckhand's egress proxy
```

And from another service's container, a call with no token, or with a token of the wrong
service, is refused (`401`, `403`), whatever the endpoint.

## Edge's and the orchestrator's data

**Edge's volume** (`edge-data`, its `/data`) holds its three secrets: whoever reads it can sign
deliveries as GitHub and sign in users, but not act as the App (its key is the github
service's). The files holding secrets are the owner's only (`0600`):

| File          | What                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.json`    | the App's names, its webhook secret and its OAuth client's (never its key)                                                                                                                                                         |
| `session.key` | signs dashboard sessions                                                                                                                                                                                                           |
| `store/`      | its store: the delivery ids taken, each login's session epoch, MCP clients' registrations and their tokens' hashes, the redeliveries' state and their poller's lease, the `deliveries` stream (what people wrote, without secrets) |

**The orchestrator's volume** (`data`) holds its store's folder alone (#619), and with Redis as
its store there is none. It holds nothing that signs deliveries or sessions, nor any run's token
(the broker answers those, #617); whoever reads it reads the queue and what the runs did. The
files holding what people wrote are the owner's only (`0600`):

| File               | What                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store/state.json` | the store's keys: the queued comments, with their authors; each running run's state (`runs/<id>`, gone once it's over); its lease and fencing epoch; the deliveries it handled; the users' chats and their agents' requests for more permissions ([Chats](policies.md#chats)) |
| `store/keys/`      | the runs' summaries and the items of its maps (a file each, a folder per map): their comments' text, the comments waiting for other issues (`/after`) and their authors, issue titles                                                                                         |

What the orchestrator kept in files of its own before (the waits' comments, the queue, the live
runs' states, the runs' summaries with the text of the comments a run acted on, #615–#619) is in
the store now: whoever reads the store reads it (its folder, or Redis's user and network), never
with a secret (`storable()`).

**The store** (`STORE_URL`: a folder by default, Redis #509) never holds a secret. Each
service's refuses a value or an event holding one it knows, a GitHub token or a private key
(`lib/store.mjs` `withoutSecrets()`): edge's refuses its webhook secret, OAuth client secret and
session key. What people wrote (a delivery's payload, a queued comment, one waiting for other
issues) is kept with them redacted (`storable()`), rather than refused whole. A comment that
waits (`/after`) was in a file of its own, `waits.json`, the owner's only (`0600`); in the store
(#616), what keeps it is the store's own access: its folder, its file in its folder of `keys/` the owner's only, or
Redis's user and network (docs/guides/store.md). The file backend (`lib/store-file.mjs`) may
be shared by several processes on one node: two copies of a service on one volume
(`docker compose up -d --scale orchestrator=2`, or edge), or one starting while the last
drains. Each call holds the folder's lock (`state.lock`, taken over once 10 seconds stale, one process at a time), reads
`state.json` again when another process wrote it, and a stream's new lines. Copies on several
nodes need Redis.

The runs' signing key is the broker service's alone, in its own volume (`broker-keys`), with
its store (`broker-store`: the live runs, the hashes of their tokens, their inbox and files):
neither is edge's nor the orchestrator's. The App's key is the github service's alone, in its
own volume (`github-key`), with its store and git mirrors (`github-data`: the runs' state, the
orchestrator's reactions, the idempotency keys and their answers, the newest orchestrator epoch
it saw).

The agents' credentials are the models service's alone: its environment, and the credentials
folder, a folder on the host mounted read only there (`./credentials` by default) whose
`codex-auth.json` and `agy-auth.json` (or the files `CODEX_AUTH_FILE` and `AGY_AUTH_FILE` point
at) are account-wide logins. Keep it out of git and readable by root alone, like `.env`. The
refreshed logins are in the models service's store (`models-store`), sealed with the key in its
own volume (`models-keys`): whoever reads both has the plans.

Run logs, which the runner keeps in its own volume ([The runner's data](#the-runners-data)),
have the operator's credentials, the run's tokens and its GitHub tokens redacted (see
[The Claude credential](models.md#the-claude-credential)): the orchestrator redacts each line before it
sends it. Their summaries (`summaries/<run>` in the orchestrator's store, a GitHub token or private key
in their text redacted) hold what the log's first line does, the run's comments included, and its screenshots' folder. Both, and the screenshots (at
the broker, which removes them when the orchestrator asks), go after `LOG_RETENTION_DAYS` (90
by default).

### The runner's data

The runner's volume (`runner-data`, its `/data`) holds its store: the runs' logs (redacted as
above), their events, the newest orchestrator epoch it saw and its lease; nothing that signs or
opens anything. Its `runs/` folder holds each running run's inbox (the comments it got, their
authors' text), the egress proxy's CA certificate and a run analysis's digest, which the broker
has a copy of for the sandbox, both removed when the run ends. Whoever reads them reads what the
dashboard shows of the runs.
