# Services (target)

Where the listener is headed once it is split (#499, its parts #500 to #509). Today the policy
service (#501, [architecture.md](architecture.md#the-policy-service)) and the broker (#505) are
out, beside the egress proxy; the rest is still one process, the listener:
[architecture.md](architecture.md) describes what runs now.

The split follows who holds which secret and who can reach what. The only service the internet
reaches holds neither the App's key, the operator's agent credentials nor the Docker socket, and
each secret lives in one service.

```mermaid
flowchart LR
  web(("GitHub webhooks<br/>browsers"))
  gh[("GitHub")]
  ai[("agents' APIs")]
  hosts[("granted hosts")]

  subgraph public [Public]
    edge["edge<br/>webhooks, API, UI<br/>🔑 webhook secret, session key"]
  end

  subgraph internal [Internal]
    orch["orchestrator<br/>events, tasks, queue, reviews"]
    runner["runner<br/>sandboxes, images, logs<br/>🔑 Docker socket / Kubernetes API"]
    broker["broker<br/>tokens, runs' endpoints<br/>🔑 signing key"]
    github["github<br/>REST, GraphQL and git gateway<br/>🔑 App key"]
    models["models<br/>agents' API relay<br/>🔑 operator's credentials"]
    policy["policy<br/>opa, no network"]
  end

  subgraph runs ["Runs' networks"]
    sandbox["sandbox"]
    proxy["proxy<br/>egress"]
  end

  web --> edge
  edge --> orch
  edge --> github
  orch --> runner
  orch --> broker
  runner --> broker
  runner -. tarballs .-> github
  edge -. run logs .-> runner
  orch --> github
  orch --> policy
  runner -. starts .-> sandbox
  sandbox --> proxy
  proxy --> github
  proxy --> models
  proxy --> broker
  proxy --> hosts
  github --> policy
  broker --> policy
  github --> gh
  models --> ai
  models -. refresh .-> runner
```

| Service      | Holds                                     | Owns (its own store)                    | Reached by                                                                                                              |
| ------------ | ----------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| edge         | webhook secret, session key, OAuth client | sessions                                | the internet, browsers                                                                                                  |
| orchestrator | nothing secret                            | queue, waits, tasks, history, decisions | edge                                                                                                                    |
| runner       | Docker socket or Kubernetes API           | containers, networks, run logs          | orchestrator, models (the plan logins' refresh only), edge (the run's log, for the dashboard)                           |
| broker       | the tokens' signing key                   | live runs, run files                    | orchestrator, runner (a run's first token), proxy (sandboxes), every service that calls another (its own service token) |
| github       | the App's key, installation tokens        | each run's issues, reactions, pushes    | edge, orchestrator, proxy, runner (the repo's tarball, for build contexts and previews)                                 |
| models       | the operator's agent credentials          | plan logins                             | proxy                                                                                                                   |
| policy       | nothing secret                            | nothing (reads the policy folders)      | github, orchestrator, broker                                                                                            |
| proxy        | Deckhand's CA                             | the egress cache                        | sandboxes                                                                                                               |

The broker also serves the endpoints a sandbox calls about its own run: its token's renewal, its
inbox and files (`broker/`, #505). A run's progress and its questions still come from its
log, which the runner follows: nothing for a sandbox to call yet. The egress policy stays with
the listener until the runner moves out (#503): it answers by the address a connection comes
from, which only the runner can tell, and gives the proxy the network it vouches for to the
broker. Every service that calls another also calls it for its own service token (#500), which the
diagram leaves out; the policy service calls none, and checks the tokens it gets offline. The dotted
arrows are narrow: the runner fetches a repository's tarball from the github service for build
contexts and preview hooks (the App's key stays there), edge reads a run's log from the runner for
the dashboard's live view, and models has the runner start the plan logins' refresh.

## Upgrades without downtime

A run calls the proxy, the broker, the github, models and policy services while it runs, never
the orchestrator or the runner: sandboxes run detached, and their events wait in the store's
streams until the orchestrator acknowledges them.

| Service                      | Copies                           | On an update                                                                                                                                                       |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| policy                       | 2, active                        | no state: the new copy starts, the old one drains                                                                                                                  |
| github, models, broker, edge | 2, active                        | shared state in the store; the new copy starts, the old one drains (models: up to 10 minutes, an agent call's length)                                              |
| orchestrator, runner         | 2, active/passive                | the old copy releases its lease on SIGTERM, the new one takes it at once and restores from the store: about a second                                               |
| proxy                        | 1, and a second during an update | both on every run's network under the same name; the new copy takes new connections, the old one drains up to 10 minutes, an agent call's length, as models (#500) |

Every agent call goes through the proxy to the models service, so the proxy's drain has to last as
long as the models service's. A single proxy can't: the next one only starts once it exits, and the
agents' CLIs, git and `gh` don't try a refused connection again (only `deckhand-files` and
`deckhand-inbox` do), so a long drain would refuse every sandbox's new connections that long. A
second copy during an update removes that limit (#500): it takes the new connections while the old
one drains, as long as an agent call lasts. On Kubernetes, that's a Deployment's rolling update (one
replica, `maxSurge: 1`, `maxUnavailable: 0`).

**On Docker Compose**, every service runs as one copy (the test server): Compose stops a container
before it starts the next, so an update is a wait rather than a handover. The proxy waits 5 minutes
for a service that refuses its connection (#507), enough for a service's drain and the next one's
start, but not for the models service's 10 minutes: a new agent call made more than 5 minutes before
its drain ends gives up before the next copy starts, and fails; those made in its last 5 minutes
wait and go through. A proxy update drains for 25 s only (#507), then cuts the agent calls still
going. Until the split, the proxy waits for a restarting listener instead of failing, for every call
a sandbox makes to it (#511). Two copies on Kubernetes have none of these gaps.

Active/passive is safe because state is saved as it changes (#508), each lease holder gets a
higher fencing epoch that the github service, the runner and the broker check, events are
acknowledged once handled, and side effects carry idempotency keys (#506). The store is the
file backend on one node, Redis on several (#509).

### Draining

Every service is to drain the same way on SIGTERM (`lib/drain.mjs` `drainOnSigterm()`): it stops
accepting connections, finishes those in flight within its grace period, then exits. The proxy,
the policy service and the broker (30 s, over an inbox's long poll) use it so far (the policy
service's and the broker's `/ready` answer 503 from then on, for a readiness probe); the listener
keeps its own handler (`listener/server.mjs`), and each service uses
`drainOnSigterm()` as it moves out. With two
copies and a rolling update that starts the new copy first, an upgrade fails no call: the new
copy takes the connections the old one no longer accepts.

### The policy service

The first service out of the listener (#501): long-lived `opa` servers behind a small HTTP service
(`policy-service/`), with no network but its callers', no secret and no state. Its callers send
a repository's policy files with each decision (it can't read GitHub); it reads the operator's
from the grants folder, mounted read-only. Any copy answers any decision the same way, so two copies
on Kubernetes are a Deployment with a readiness probe on `/ready` and `maxUnavailable: 0`: the new
copy starts, the old one drains (25 s) with its decisions in flight
(`test/policy-service.test.mjs`). With Docker Compose it is one copy, and the listener waits up
to 30 s for a restarting one rather than refusing its decisions.

### The proxy's handover

The proxy runs as **one copy, and a second during an update**: no permanent second copy is
needed.

1. The new copy starts and joins every run's network under the same name (`egress`). It takes
   the new connections once ready: it answers `GET /ready` (plain HTTP, the readiness probe's).
2. The old one, out of rotation, takes no new connection and drains for as long as an agent
   call lasts (`DRAIN_SECONDS=600`): an agent's stream through it goes on to its end, then the
   old copy exits (`test/proxy-handover.test.mjs`).

On Kubernetes, that's a Deployment with one replica, `strategy: RollingUpdate`, `maxSurge: 1`,
`maxUnavailable: 0`, a readiness probe on `/ready`, and `terminationGracePeriodSeconds` covering
the drain (630 for a 600 s drain, #396).

With Docker Compose, which stops a container before it starts the next, nothing changes: the
proxy drains for 25 s (`DRAIN_SECONDS`' default, under its `stop_grace_period` of 30 s), and the
gap stays (above). The Compose test server keeps it.

## What limits a leaked token

- **Run tokens** (#493): **where**, the services are reachable from the runs' networks only
  through the proxy, so a token leaked to the internet opens nothing; **who**, it is bound to
  its sandbox's network, which the proxy vouches for, so another sandbox can't replay it; **how
  long**, valid for 15 minutes, then renewable only from its own sandbox, by the one the
  sandbox holds, within a 7-day grace (`RENEW_GRACE_MS`, so a broker away for a while doesn't
  end the run), and nothing once its network is removed. The agent's own token,
  which its CLI reads once at start and can't renew, lasts the run instead (7 days at most), bound
  the same way and for the agents' endpoints alone (security.md, Run tokens).
- **Service tokens** (#500, security.md, Service tokens): signed by the broker, with `sub` (the
  caller) and `aud` (the service called), 15 minutes, and bound to the caller: its pod's service
  account on Kubernetes, the network a call arrives on with Docker (one network per caller and
  callee).
- **What each caller may do**: each service accepts from each caller only what it needs, in
  one table per service. The github service lets edge read, never mint a token or write: a
  compromised edge, already inside the internal network, gets no more.
- **The network has to be closed**: with Docker, only the proxy sits on the runs' networks (a
  test reads `compose.yaml`); on Kubernetes, NetworkPolicies need a network plugin that enforces
  them (#396).

## Rules

- **No shared database**: each service keeps its own state through one store interface
  (`lib/store.mjs`: keys with TTLs, atomic operations, leases with a fencing epoch, acknowledged
  streams, blobs; its file backend for one node, `lib/store-file.mjs`, #500; Redis on several,
  `lib/store-redis.mjs`, #509: [setup.md](setup.md#the-store)), and
  passes its changes to those that need them as store streams, acknowledged once handled, so a
  handover loses none. The broker streams run starts, ends and progress; edge, verified events; the
  orchestrator, task updates for the dashboard; the runner, run events (started, ended, exit code;
  logs go to the store's blobs); models, the plans' usage for edge.
- **Secrets never go in the store** but encrypted by their own service, with a key only it
  holds: the plan logins the models service refreshes, for example (#504). The App's key, the
  signing key and the agents' credentials stay in their service's own secret or volume, never in
  the store (#509). With Redis on several nodes, every service that uses the store could read
  them otherwise.
- **Shared code** in `lib/`, copied into each image: no npm package in it, so "no runtime
  dependencies" holds per service. The github service keeps the listener's one exception,
  graphql-js, bundled at build (`listener/vendor/`).
- **Sandboxes outlive an update**: an endpoint that moves to another service first answers, for a
  while, with where to go instead (`docs/architecture.md`, Restarts).
- **The security rules of `AGENTS.md` hold per service.**
- **The UI** stays in edge: static files from the dashboard's build, on the same origin as its
  API.
