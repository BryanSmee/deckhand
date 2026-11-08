# Inside each service

What each service beside edge and the orchestrator holds, decides and keeps: the policy service,
the broker, the runner, the github service and the models service. How they fit together is in
[services.md](services.md), how each one updates without downtime in [upgrades.md](upgrades.md).

## The policy service

Every policy decision goes to the policy service (`policy-service/`, #501), a container of its own
beside the orchestrator ([services.md](services.md)): the orchestrator starts no `opa`.
`listener/policies.mjs` keeps what a decision means (its input, which layers are asked, what a
refusal says) and reads a repository's `.deckhand/policy/` from GitHub, which it sends with each
call; the service reads Deckhand's policies (its image) and the operator's (the grants folder,
mounted read-only), and answers four calls, each with a service token
(`policy-service/service.mjs`). The runner may call the first two, for the operator's
[grants](../reference/server-folder.md#the-grants) (`grant`, the operator's layer alone), never the others:

- `GET /policies`: the operator's layer as it reads it now, Deckhand's files and the
  operator's, for the dashboard's Policies tab and `/mode policy`; the orchestrator keeps Deckhand's
  files from it, and checks the operator's are the ones it reads in its own grants folder;
- `POST /evaluate`: a decision's rules on its input, the repository's files sent, each layer's allow
  and deny. The orchestrator reads the operator's folder itself and sends a digest of the operator's
  layer (`lib/policy-files.mjs`), required of every caller, which the service refuses when its own
  is another; the orchestrator then asks `GET /policies` again (a copy of another version) and tries
  once more. So a decision is one call, attributed to the files it was evaluated on. Deckhand's
  files are kept 30 s (`DEFAULTS_MS`), then asked again: a `merge` or `fix` only they allow is
  decided without a call, so a service updated to other defaults is seen within that time;
- `POST /capabilities`: what runs get as they start (#495), the capabilities' rules on several
  inputs in one query (a run's, or each mode of a config page), the digest sent as for a
  decision: for each input and layer, the whole rules' allow and deny, and each file's own,
  which `listener/policies.mjs` turns into what was allowed and denied, and by which file;
- `POST /access`: who may do what (#730), the orchestrator's alone: the access rules' sets
  (`allow_access`, `deny_access`), evaluated as the capabilities' are, for a login on a
  repository or server-wide (`listener/policies.mjs` `access()`);
- `POST /check`: a layer's compile errors, the config checks'.

Its engine (`policy-service/engine.mjs`) keeps a few long-lived `opa run --server`
(`policy-service/opa.mjs`), each with one policy set loaded at its start (the operator's layer,
with or without one repository's), on a Unix socket in its own temp folder. A set is checked
first with `opa check` and the restricted capabilities file, then served, each file's
capabilities' rules renamed apart with their union beside them (`lib/policy-files.mjs`
`byFile()`), so that one server answers both what a file decided and every rule that reads the
whole set; a set that doesn't
compile is remembered as such until its files change. A decision is one query of its set's
server, cut after 2 s (which cancels it in `opa`); an edit of the operator's policies makes a
new set, whose server starts at the next decision, and the least recently used idle servers
stop past 8. It keeps no state: any copy answers any decision.

On SIGTERM it drains (`lib/drain.mjs`, 25 s, compose's `stop_grace_period` is 30 s): `/ready`
answers 503, the decisions in flight finish, then its servers stop. The orchestrator's client
(`policy-client.mjs`) tries a call again while the service refuses its connection or answers
503, for 30 s, so a restart of the service delays decisions rather than refusing them (with
two copies and a rolling update, the next copy takes them at once); after that, or for any other
failure, the decision is refused with a `policy error` (fail closed).

## The broker service

The broker service (`broker/`, #505) is the only one holding the tokens' signing key
(`run-token.key`, in its own volume `broker-keys`): it signs a run's first tokens with the claims
the orchestrator decided (`POST /runs/:id/tokens`, which the orchestrator asks for once the runner
says the sandbox's network or pod exists), renews them for their own sandbox only
(`POST /run/token`, through the egress proxy), and signs every service's own service tokens, for the
caller its network (or pod's service account) proves (`broker/callers.mjs`). Every other service
checks those tokens offline with its public keys (`GET /keys`, the `service-keys` volume). Its store
holds the live runs (`broker/runs.mjs`: their claims, where their tokens are bound, a run's end),
their files ([Run files](restarts.md#run-files)) and the `runs` stream the orchestrator reads and
acknowledges (`broker-service.mjs` `consume()`); the models service asks it whether a run still
goes. Its API (`broker/http.mjs` `ROUTES`) names the callers of each endpoint, and each orchestrator
call but a `GET` carries its fencing epoch. What each caller may do, and what a hole in it gives:
[The broker service](../security/services.md#the-broker-service) in the security model.

**The broker service's own update.** Compose runs one copy, which drains on SIGTERM for 30 s
(`DRAIN_SECONDS`: the inboxes' long polls, uploads in flight), then the next one starts on the same
store and key: the proxy waits for it meanwhile, as for the orchestrator (`proxy/wait.mjs`). On
Kubernetes (`deploy/kubernetes/broker.yaml`, both mounting the key's Secret), two copies on one
store, both active: a rolling update starts the new one first, then the old one, out of rotation
(`/ready` answers `503`), drains. Either copy would answer any call: the live runs, their files and
their events are in the store, so a run ended through one renews through neither, and an inbox read
through one goes on from the same offset through the other.

## The runner service

The runner (`runner/`, #503) is the only service with the host's Docker socket, or the Kubernetes
API's credentials: neither edge nor the orchestrator has them. It runs the backends
(`listener/runner/`: Docker or Kubernetes, the runs' networks, inboxes and engines), builds repo
images and installs agents (`listener/images.mjs`), runs the Antigravity login's refresh, and keeps
the runs' logs and events. What decides a sandbox's spec (`sandbox-spec.mjs`: image, environment,
limits, volumes, no backend option) stays with the orchestrator (`preparation.mjs`, `runs.mjs`),
which hands it over whole, and the runner checks it against the grants again (`spec-check.mjs`): the
grants folder, which it reads itself, and what the operator's policies grant the repository, which
it asks the policy service itself (`grants.mjs` `grantsBy()`, the operator's layer only: no
repository's files), for an engine (`docker`) and an image build (`dockerfile`,
`branch_docker_images`: `builds.mjs`); the runner holds no GitHub credential: a build context starts
from the repo's tarball, which it gets from the github service (`GET /tarballs/…`), an image's
tag hashes the Dockerfile's blob the github service read (`GET /blobs/…`), and a branch's image
is built only at a commit the github service says is the repository's own (`GET /commits/…`:
`github-forks.mjs` `ownCommit()`), never a fork's. The orchestrator talks to
it through `runner/client.mjs`.

Its API (`runner/service.mjs`) names the callers of each endpoint (`ROUTES`), each with its own
service token ([Service tokens](../security/tokens.md#service-tokens)): the orchestrator starts, follows, talks to and
removes sandboxes and writes and reads their logs (`GET /logs/<run>`, `stream()` reading it from an
offset, for the dashboard's live view, which the orchestrator relays to edge as it streams); it also
asks, for the egress policy that stays with it, where an address is, the egress proxy's addresses
and a sandbox's install,: reads that aren't fenced (`UNFENCED`, `GET /logs/:id` among them: they
write nothing), so a copy still draining answers them; the models service (#504) has the Antigravity
login refreshed, sending the token file, never a container's spec, over a network of its own
(`runner-models`). Edge calls none of it. The runner takes its callers from the network each reaches
it on (`SERVICE_NETWORKS`, `orchestrator=<subnet>,models=<subnet>`). The runner gets its own tokens
from the broker service over a network of its own (`broker-runner`), and checks its callers' with
the broker's public keys (`SERVICE_KEYS_DIR`, read-only, as the policy service does).

- **A run's start** is keyed by its id: asked again (a lost answer, a handover), it finds the
  sandbox and starts nothing; one a copy left halfway (its network, no sandbox) is done again,
  and one whose sandbox already runs is recorded as started, with the container engine read back
  from its sidecar (the backend's `engine()`), as the metrics count it.
  The run's first tokens come from the orchestrator once its network or pod exists (`POST
/runs/<run>/tokens` on the orchestrator's services port, only for a run being started), which has
  the broker service sign them with the claims it decided (`sandbox-spec.mjs` `tokenEnv()`): the
  runner never chooses what a run's tokens allow. They go in the sandbox's environment, by name.
  Its inbox, CA and digest the runner copies to the broker service before the sandbox starts, and
  the inbox again as it changes (`listener/runner/inbox.mjs` `mirror`).
- **Its output** comes as NDJSON (`GET /sandboxes/<name>/output`), from the lines the orchestrator
  read already: the stream ends when the sandbox does, or when the runner stops, and the
  orchestrator follows again from where it was, as when `docker logs` ended.
- **Its log** is in segments in the runner's store, the closed ones moved to blob storage when
  `BLOB_URL` is set ([A run's log](run-logs.md#a-runs-log)), written by appends that name the offset
  they go at: one sent again is taken once, one at another offset refused with the log's size, which
  the writer goes on from. The orchestrator writes a line at once and sends it as it can (in order,
  tried again while the runner is away), and saves a run's state only once what it read is at the
  runner, so that the lines it skips after a restart are there.
- **Its events** (started; ended, with its exit code) go to a stream of the runner's store,
  which the orchestrator reads and acknowledges (`run-events.mjs`): none is lost while either
  restarts. An exit code that isn't 0 is a note in the run's log.
- **The orchestrator's fencing epoch** (`x-deckhand-epoch`) comes with each of its calls but the
  unfenced reads: the newest one seen is in the runner's store, and an older one is refused (`409`),
  so a copy that lost its lease without noticing can't start or stop a run. The epoch is its lease's
  (`lib/active.mjs`, `lib/store.mjs` `acquire()`): each new holder's is higher than every one before
  it, and at least the time in ms. The github service and the broker check it the same way (the
  broker since #506, on every orchestrator call but a GET). The runner refuses one more than a day
  ahead of its own clock (`400`). Should an epoch have run ahead anyway (a clock), the next one is
  refused until that time: removing the `epoch/orchestrator` key from the runner's store (its file
  under `runner-data`'s `store/`, or the key in Redis) with the runners stopped lets it in.

**Two copies, active/passive** (`lib/active.mjs`): the one holding the runner's lease in the
store answers; the other answers `503` (and `/ready` says so, the readiness probe's), which
callers try again on the next copy (`lib/service-client.mjs`). On SIGTERM the active copy ends
the output streams and log reads it serves (their callers come back), lets its other calls
finish (an image's build), then releases the lease, and the waiting copy takes it at once (it
asks every 250 ms). On a crash, or a store that no longer answers it, the lease expires
(15 s) and the other copy takes over; the stopped one, by its own clock, no longer acts. Either
copy finds the sandboxes again by their labels, and the logs and events in the store: the file
store for one node, Redis for copies on several (`STORE_URL`, docs/guides/store.md). The
runs' inboxes are files of its own volume (`runner-data`'s `runs/` folder), which it copies to the
broker service as they change (the broker serves them): two copies on several nodes need that
folder shared. With Docker Compose, one copy runs: an update is a wait
of the runner's calls, which the orchestrator waits for (30 minutes for a run's, 3 s, then the last
answer, for the egress policy's questions about a sandbox's address and the proxy's; once one
found it away, the next ones go by the last answers for a second, so that one answer of the
policy waits 3 s at most, under the proxy's 5 s for it). With no last
answer (an orchestrator copy that took over while the runner was away), or none that can say
(a proxy recreated meanwhile, not among the last addresses), the egress policy answers `503`
rather than "no run there" or "not the proxy", and the proxy asks again, as for an orchestrator
restarting (#936). An answer of the runner's with an error status is its word: no place there.

## The github service

The github service (`github/`, #502) is the only one holding the GitHub App's key: edge keeps the
webhook secret and the OAuth client's, the orchestrator only the App's public parts (which it reads
from edge, `GET /app`), never the key. It runs the gateways (`listener/github-gateway.mjs`,
`git-gateway.mjs`, `github-writes.mjs`, `github-graphql.mjs`, `github-forks.mjs`,
`github-pulls.mjs`, with `github-app.mjs`'s installation tokens), and makes edge's and the
orchestrator's own GitHub calls. Its API (`github/service.mjs`) names the callers of each endpoint
(`ROUTES`): the proxy the sandboxes' calls, `/relay/<host>/…` and `/git/…`, with the network they
came from vouched for; the orchestrator its calls as a repository's installation
(`/as/<owner>/<repo>/<GitHub's path>`, GitHub's answer passed on with its status in
`X-GitHub-Status`), GraphQL, as the App and one installation, the runs and their end, its reactions
and the service's events; edge the same reads, never a write (a GraphQL mutation refused), but
/setup's conversion of a manifest code (`POST /app/manifest`) and the redeliveries
(`POST /as-app/app/hook/deliveries/:id/attempts`); the runner a repository's tarball and a file's
blob id; the orchestrator GitHub's own status as it last read it (`GET /status`,
`github/status.mjs`). The orchestrator calls through `github/client.mjs` (`app()`: `request()`,
`asApp()`, `asInstallation()`, `identity()`).

- **A run** is told to the service once its sandbox's network or pod is known (`broker.mjs`
  `issue()`, `restore()`: `gateway.put()`), with what its gateways check (its repository, mode,
  issue, branches, capabilities, the network its tokens are bound to, whom its writes may assign),
  and its end (`revoke()`). What it does there is the service's, in its store (`github/runs.mjs`):
  the issues it created, the comments it posted, its reactions and reruns, changed with
  compare-and-set, kept before GitHub's answer ends for the sandbox (`upstream.mjs` `forward()`'s
  `settle`), read by the orchestrator at the run's end (its reruns, for the CI step). Its pushes,
  the lines the gateways add to its log and the pull requests it changed come to the orchestrator as
  the service's events (`GET /events`, acknowledged once handled: `consume()`), as the broker's do.
- **Two copies** may run on one store: a run's state, its calls in flight (a slot each, renewed
  while it goes on), what GitHub advertised to its git, the orchestrator's reactions, the fencing
  epoch and the idempotency keys are there; installation tokens and git mirrors are each copy's
  cache. Every orchestrator call that changes something carries its epoch (`lib/fence.mjs`, as the
  runner's), and a write may carry an idempotency key, made once however often it is asked: a run's
  reply carries `<run>:reply` (`comments.mjs` `reply()`).
- **GitHub's hiccups** (#680): a `500`, `502`, `503` or `504`, or no answer at all, is tried
  again after 1 s, 3 s and 9 s (or GitHub's `retry-after`), each retry logged once, for a call
  that may be repeated: a `GET` or `HEAD`, a `PUT` or `PATCH` but a merge, never a `POST` or
  `DELETE` (`github-app.mjs` `request()`, `repeatable()`). A secondary rate limit (a `403` or
  `429` that says so) is waited for as GitHub says, a minute when it doesn't, up to a minute
  and three times, whatever the method: it isn't a failed try. What still fails is answered as
  GitHub left it. A run whose start it stops (its `.deckhand.yaml` unread, say:
  `GitHubUnavailable`, `github.mjs`) ends as `error`, its log and summary saying GitHub's
  status, method and path, and its comments go back in the queue, 👀 kept, for a run 1, 5 then
  15 minutes later (`runs.mjs` `githubDown()`, `GITHUB_REQUEUE_MS`); after those, its reply
  says GitHub failed. When it was a `5xx` (or a reply GitHub kept refusing with one), its
  summary, log and reply also say what GitHub's status page reported then (#943, `github.mjs`
  `incidentNote()`): its open incidents (linked in the reply), none, or its description. Nothing
  is said when the github service can't tell: not read, off github.com, or read more than 15
  minutes before. A comment whose admission it stops (`tasks.mjs` `admit()`, which reads
  `.deckhand.yaml` before anything is queued, #939) is held rather than dropped, in the
  orchestrator's `admissions` map so that a handover keeps it, and admitted again 1, 5 then 15
  minutes later (`holdAdmission()`, `ADMIT_RETRY_MS`), or at once behind a later comment on its
  task, which waits for it; after those, a trigger's reply says GitHub failed.
- **The App's key**: edge's /setup has the service convert a new App's manifest code
  (`POST /app/manifest`), so a key never reaches edge or the orchestrator.

## The models service

The models service (`models/`, #504) is the only one holding the operator's agent credentials: its
environment and the credentials folder (read-only), and the plans' logins it refreshes, sealed in
its store with a key only it holds (`models/logins.mjs`). It serves the agents' API endpoints
(`models/upstream.mjs`, `anthropic.mjs`, `openai.mjs`, `google.mjs`) and the plans' logins
(`chatgpt.mjs`, `antigravity-login.mjs`, whose refresh the runner runs in a container of its own).
Its API (`models/http.mjs` `ROUTES`) names the callers of each endpoint: the egress proxy the
sandboxes' agent calls (`/anthropic/`, `/openai/`, `/google/`, `/relay/<host>/`), with the network
it vouches they came from, and the orchestrator the credentials' names (`GET /credentials`, before
its settings are read) and fingerprints (`GET /fingerprints`, for redaction), a run's API state
(`GET /runs/:id/api`, for its reply and fallbacks at its end), the plans' usage (`GET /usage`, the
dashboard's bars, below) and the `models` stream (the calls it refused a run, a line each in its
log).

- **A call** carries the run's agent token, checked offline with the broker's public keys
  (`models/runs.mjs`): its `agent` claim (a run never gets another agent's credential), from its
  own sandbox, for a run the broker says still goes (`GET /runs/:id`, every 30 s at most per
  run). The service swaps it for the operator's credential and streams the answer back.
- **The plans' usage** (`models/usage.mjs`, #486) is read from the plan's answers to the runs'
  calls (their rate limit headers; never an API key's, a gateway's or OpenRouter's) and, while a
  dashboard is open, from the plans' own usage calls: the orchestrator asks `GET /usage?poll=1`
  every 15 s at most while api/state is read (`listener/models-service.mjs` `plans()`), and the
  models service asks a plan no run read lately, every 5 minutes at most for every copy (a lease
  in the store), 30 minutes after a failed call, which is only logged; never again (until a restart)
  after Claude's refuses its token, which a `claude setup-token` token's missing `user:profile`
  scope makes the usual case, and not while a ChatGPT login is due for a refresh (the poll doesn't
  refresh it); the Antigravity CLI's, its plan's only reading, refreshes its hour-long login
  when due, once an hour at most for every copy (`usage:<plan>:refresh`). Readings are in the store,
  `usage:<plan>`, written when a percent, a reset or a limit changes, or once a minute. A 429
  marks its window full until its reset. api/state's `plans` has only their numbers and times,
  and only when a plan is set; they update only when runs use the plan or a dashboard is open.
- **Two copies** may run on one store, both active: a plan's refresh token is single-use, so a
  refresh is a lease in the store (one copy refreshes, the other waits for its result), and a
  run's API state is there by the run's id. A run has 16 calls in flight at most per copy.
- **Its update** drains for as long as an agent call lasts (`DRAIN_SECONDS`, 600): a stopping
  copy refuses new calls (`/ready` answers `503`) and lets those in flight finish, so no turn is
  cut. With Compose, one copy runs, and a new call waits for the next one only as long as the
  proxy waits (5 minutes, [upgrades.md](upgrades.md#upgrades-without-downtime)).

What each caller may do, and the credentials' fingerprints:
[The models service](../security/models.md#the-models-service) in the security model.
