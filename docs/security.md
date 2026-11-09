# Security model

Sandboxes run Claude Code without permission prompts, on issues anyone may have written.
Deckhand assumes that whatever runs inside one may try to read what it shouldn't or send it
out, and limits what it can reach: no GitHub token, only calls through a gateway that adds
one for its own repository (see [Tokens](security/tokens.md) and
[How sandboxes reach GitHub](guides/services.md#how-sandboxes-reach-github)), no pushes to its default branch, no host
paths unless you grant them, a restricted network, and no privileges.

This page is the short answer: the trust boundaries, where each secret lives, what a run can
do, and what is yours to get right. The threat model, with the reasoning behind every rule and
what Deckhand accepts or doesn't check, is [split by area](#the-threat-model-by-area) below. To
report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Trust boundaries

Deckhand runs as services split by the secret each one holds and what each one can reach (the
diagram is in [contributing/services.md](contributing/services.md)). Each secret is in one service; each service takes
from each caller only the endpoints that caller needs, and shares a network only with the
services it calls or is called by.

| Boundary     | Reached by                                                   | Holds                                                        |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| edge         | the internet: GitHub's webhooks, the dashboard, MCP clients  | the webhook secret, the session key, the OAuth client's      |
| orchestrator | edge and the services it calls; no sandbox                   | nothing secret: it decides, the others act                   |
| github       | the orchestrator, edge, the egress proxy (the runs' calls)   | the App's key and its installation tokens                    |
| runner       | the orchestrator                                             | the Docker socket or the Kubernetes API                      |
| broker       | the services, the egress proxy (the runs' calls)             | the run tokens' signing key                                  |
| models       | the orchestrator, the egress proxy (the runs' agent calls)   | the operator's agent credentials                             |
| policy       | the orchestrator and the runner; no network but theirs       | nothing secret: it evaluates the operator's and repos' rules |
| egress proxy | every sandbox, on its run's own network                      | Deckhand's CA                                                |
| sandbox      | no one: its run's network is internal, the proxy its one way | a run token for its own run, and its agent's token           |

The runs reach none of the services directly: only the egress proxy is on their networks, and
it relays their calls to the github service, the models service and the broker, vouching for
the sandbox each came from. What a hole in each service gives:
[The services](security/services.md).

## Where the secrets live

| Secret                                       | Where                                                                | Whoever reads it                                      |
| -------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| the App's private key                        | the github service's volume (`github-key`)                           | acts as the App on every repository it is on          |
| the webhook secret, session key, OAuth's     | edge's volume (`edge-data`)                                          | forges deliveries and dashboard sessions              |
| the run tokens' signing key                  | the broker's volume (`broker-keys`)                                  | signs tokens for any live run                         |
| the agents' credentials                      | the models service's environment and credentials folder (read only)  | spends them                                           |
| the plans' refreshed logins                  | the models service's store, sealed with `models.key` (`models-keys`) | needs both the store and the key                      |
| Deckhand's CA key                            | the egress proxy's volume (`egress-cache`)                           | can pose as the hosts the proxy decrypts to sandboxes |
| the Docker socket                            | the runner service alone                                             | root on the host, and so every volume above           |
| blob storage's key pair (`BLOB_URL`), if set | the runner and the broker                                            | reads, overwrites or deletes its bucket               |

No sandbox or image holds any of them, nor any store in the clear: a store refuses a value
holding a secret it knows, and run logs are redacted before they are written. On Kubernetes
each is a Secret of its own, mounted read only by its service's pods alone
([On Kubernetes](security/kubernetes.md)). The volumes and what they hold: [Edge's and the orchestrator's data](security/services.md#edges-and-the-orchestrators-data).

## What a run can do

A run's sandbox holds a **run token**: a 15-minute JWT the broker signs with an Ed25519 key,
renewed while the run goes, bound to its run's network (or pod), and worthless once the run
ends ([Run tokens](security/tokens.md#run-tokens)). Through the egress proxy it may:

- **read** its repository through the [GitHub gateway](security/github.md#the-github-gateway),
  which adds a read-only installation token to the call; never a token of its own;
- **write** to GitHub only what the policies allow it (`allow_github`), each write checked and
  given a token of its own with just that permission;
- **push** its own branches (`issue-<n>-…`, its pull request's), never the default branch,
  through the git gateway ([The default branch](security/github.md#the-default-branch));
- **call its agent's API** with the one credential its run names, which it never sees
  ([The models service](security/models.md#the-models-service));
- **reach** the hosts its repository is granted, and only those
  ([Network](security/network.md#network)).

It can't push to the default branch, merge or review a pull request, write files through the
API, read another repository's code, reach a host path you didn't grant, or reach the
services, the Docker socket or another sandbox. It runs as uid 1000, without capabilities,
with `no-new-privileges` and limits ([Hardening](security/mounts-and-engine.md#hardening)). A
token stolen from it is refused from any other network. What the policies give each run is
decided at its start ([Capabilities](security/policies.md#capabilities)).

Deckhand's default policies keep each mode's writes to its own issue, its pull requests and the
issues it files, but a grooming's ([Grooming](repo-config/modes.md#grooming)): it comments on
the repository's other issues, and its wrap-up edits, labels and closes them, as not planned or
as a duplicate only. Who may start one, and wrap it up, is `runs:start:grooming` and
`runs:start:grooming-stop` ([Access](security/webhooks-and-sign-in.md#access)).

## Your part as the operator

Deckhand fails closed, but some things only you decide:

- **Who gets in.** `ALLOWED_USERS` is the outer gate for the dashboard, MCP clients and
  comments; your policies narrow it per repository ([Access](security/webhooks-and-sign-in.md#access)).
- **What you grant.** Every host you grant is trusted entirely: anything a sandbox can write
  to there is a way out. Give `dockerfile`, `docker`, read-write mounts, `workflows`, research
  and auto-merge only to repositories whose default branch you trust
  ([The grants folder](security/policies.md#the-grants-folder), [The grants](reference/server-folder.md#the-grants)).
- **The host.** The runner's Docker socket is root on the host, and with it every service's
  volumes there; prefer Sysbox to Podman for container engines
  ([Container engine](security/mounts-and-engine.md#container-engine)).
- **The secrets' files.** Keep `.env` and the credentials folder out of git and readable by
  root alone, and the services' volumes as private as the secrets they hold
  ([Edge's and the orchestrator's data](security/services.md#edges-and-the-orchestrators-data)).
- **GitHub's own settings.** Where GitHub enforces them, a ruleset on the default branch and
  environments limited to it are a second layer behind the gateway
  ([GitHub Actions on Deckhand's branches](security/github.md#github-actions-on-deckhands-branches)).
- **Behind a reverse proxy**, restrict `/webhook` to GitHub's `hooks` ranges and let it buffer
  request bodies ([Edge](security/webhooks-and-sign-in.md#edge)).
- **Fork pull requests.** Read what one does before asking for work on it, and ask from that
  pull request ([Fork pull requests](security/forks.md)).

## The threat model, by area

| Page                                                             | What it covers                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [The services](security/services.md)                             | what each service holds and what a hole in it gives, the orchestrator, runner, github and broker services, blob storage, the networks, each one's data |
| [Webhooks and sign-in](security/webhooks-and-sign-in.md)         | edge, who reaches a session, access, the dashboard and its actions, MCP clients, machines                                                              |
| [Tokens](security/tokens.md)                                     | run tokens and service tokens                                                                                                                          |
| [The GitHub and git gateways](security/github.md)                | the default branch, GitHub Actions on Deckhand's branches, the GitHub gateway, reviews, CI fix runs, auto-merge                                        |
| [The egress proxy and hosts](security/network.md)                | the network, the egress cache, Deckhand's CA, where a sandbox's hosts come from                                                                        |
| [Mounts and the container engine](security/mounts-and-engine.md) | volumes, host mounts, hardening, output, container engines                                                                                             |
| [Policies and capabilities](security/policies.md)                | the grants folder and the grants, policies, capabilities, chats, research runs                                                                         |
| [Fork pull requests](security/forks.md)                          | what a fork's code may reach                                                                                                                           |
| [The models service and credentials](security/models.md)         | the models service, the Claude credential, the Antigravity CLI's login, what the API endpoints forward                                                 |
| [On Kubernetes](security/kubernetes.md)                          | each rule in Kubernetes' terms                                                                                                                         |
| [Not covered](security/not-covered.md)                           | what Deckhand accepts or doesn't check, across every area                                                                                              |
