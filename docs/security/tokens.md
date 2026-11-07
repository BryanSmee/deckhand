# Tokens

What a sandbox holds instead of a GitHub token or a credential, and how the services prove who they are to one another. Part of the [Security overview](../security.md).

## Run tokens

A sandbox holds no credential of the operator's and no GitHub token: it holds **run tokens**
(`lib/tokens.mjs`), JWTs the **broker service** (`broker/`, a container of its own, #505)
signs with an **Ed25519** key that no other service holds. Every service checks their
signature **offline**, with the broker's public keys alone (`GET /keys`): the
[GitHub gateway](github.md#the-github-gateway) and the git gateway (through `listener/broker.mjs`), and the
models service's agent endpoints (`models/upstream.mjs`, through `models/runs.mjs`) never ask the
broker whether a token is genuine. The github service also checks that its run is one the
orchestrator told it of (`PUT /runs/:id`, in its store); the models service asks the broker whether the run still goes
(`GET /runs/:id`, every 30 s at most per run). No HMAC: a service that can check a token can't mint one, so edge, which
the internet reaches, signs no token (#492). The checks are strict and hand-written on
`node:crypto`:

- the algorithm is **EdDSA, always**: the header's `alg` never picks it, and any other
  (`none`, `HS256`…) is refused;
- `kid` names the key, so a service can hold the old and the new public key while the key
  rotates; an unknown `kid` is refused;
- `aud` is **one string**, the service the token is for: `deckhand:broker` (the gateways, the
  run's files, renewal) or `deckhand:agents` (the agents' API endpoints). A token for one is
  refused by the other;
- `exp` is checked, and a token over 2 KB is never signed (Node takes 16 KB of headers, and
  git's Basic auth adds a third).

The signing key is `run-token.key` in the broker's own volume (`broker-keys`, owner-only,
made on first start; a Secret on Kubernetes), never in the orchestrator's data volume, edge's, nor the
broker's store, so running sandboxes' tokens still check after a restart of either. Removing
it makes a new one: every running sandbox's token is refused from then on.

**Claims.** Only what doesn't change during the run, nothing secret: the sandbox may read them,
to know what it may do. `jti` (the run's id), `repo`, `mode`, `issue`, `fork`, `branches` (what
it may push), `sandbox` (below), `agent` (the provider of the run's agent and the credential of
its the run names, which the models service gives its calls alone: #504), `caps` (its
[capabilities](policies.md#capabilities), as its start decided them) and `ver`, the claims' format
(a sandbox outlives an orchestrator update; an unknown version is refused). What changes during a
run (the issues it created, the comments it posted, the reactions it added, the workflow runs it
reran) stays with the [github service](services.md#the-github-service), in its store, by the run's id.

**Bound to its sandbox.** `sandbox` is the ID of the run's own network (Docker) or of its pod
(Kubernetes). Each service compares it with the ID of the network the call came from, which the
egress proxy names: when it relays or forwards a sandbox's call, it names the network itself
(`X-Deckhand-Sandbox`, the one the orchestrator's egress policy gave it for that connection),
moves the sandbox's credential apart (`X-Deckhand-Run-Token` for the broker and the models
service, `X-Deckhand-Run-Authorization` for the github service) and sends its own service token;
each service believes those headers from the proxy alone, as its service token and the network
it arrived on prove, and the proxy drops what a sandbox sent in them. IDs, not addresses or
names: both are reused, an ID never. A token that leaks, to a research run on the open web say, gets another
sandbox neither GitHub, a push, nor calls on the operator's credentials: `403`. The run's
container engine is on its network, so its calls count as the run's, as they did; no other
container there does (the egress proxy's: `egress-http.mjs` `taskWhere()` checks which
container has the address), so a token can't ride on a call the proxy makes itself. When a run
ends, the orchestrator forgets it and has the runner remove its network (or pod): its tokens are worth nothing
from then on, before their `exp`.

The same lookup finds a connection's run for **the egress policy** and for **GitHub calls
that carry no token** (git's first request, a `curl` download): the runner tells which network
(or pod) the address is on now, and which container has it there, the sandbox or its engine
(`runner.locate()`, `egress-http.mjs` `taskWhere()`); nothing per run is kept, so another
run's engine starting before its sandbox changes nothing for anyone (#517). The runner caches
its answers for a few seconds, and forgets them whenever a network is created or removed or a
container joins one.

**What a push may do** is the git gateway's decision from the token's claims (`repo`,
`branches`, `fork`), not the broker's record. The services still need the run to be one they
know (the github service's store, the broker's record); the network's removal at the run's end
is what refuses its tokens there.

**Lifetime.** The run token lasts **15 minutes**. It is a file on a tmpfs
(`/dev/shm/deckhand/run-token`, `DECKHAND_TOKEN_FILE`) rather than an environment variable,
which a running process never reads again. `sandbox/entrypoint.sh` writes the first one
(signed once the runner knows the network's ID, or the pod's UID, and handed over as
`DECKHAND_RUN_TOKEN`, then unset), renews it once before the run's first call
(`deckhand-token --now`: on Kubernetes it is signed when the pod is created, which may stay
Pending a while, and the broker takes an expired one from its sandbox, below), and starts
`deckhand-token --renew` (its first renewal after 30 seconds when that one failed), which asks
the broker service, through the egress proxy
(`POST /run/token`, presenting the current token) for a new one every 5 minutes and replaces
the file whole; a failure is retried after 30 seconds, so two may fail in a row. The broker
refuses to renew another sandbox's token or an ended run's, and one more than 7 days past its
`exp` (`RENEW_GRACE_MS`): an expired token still renews, from its own sandbox, if it is the one
the sandbox holds (the newest signed for the run, or the last presented; an older one left in a
process's environment is dead once expired), so a broker
away for longer than a token's life doesn't end the run (below). After a restart, the token
renewed is bound where the one presented was, and the one presented is redacted too. A
renewal asked within a minute of the last token signed gets that one back: a process asking in
a loop can't pile up valid tokens. The broker's store holds no token in the clear: the hashes
of the run's tokens still valid, each sealed beside its hash with the run's agent token (AES-256-GCM, under a key derived
from the signing key, `broker/seal.mjs`), so that any copy of the broker can hand the last one
back, and the orchestrator's next copy can redact them all (`POST /runs/:id/secrets`, its
service token alone, with its fencing epoch: a copy that lost its lease gets `409`). That copy
keeps them in memory only: the orchestrator's store has none (#617).
`deckhand-token`
prints the file, so the gh wrapper, git's credential helper, `deckhand-files` and
`deckhand-inbox` read it again for each call: the agent is told never to keep it
(`prompts/sandbox.md`).

**The agent's token.** The agent's API key variable (`CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, the Antigravity CLI's token file)
is read once, when the agent starts, and can't be renewed under it. So the agent gets a token
of its own, for `deckhand:agents`, with the same claims and binding, lasting at most 7 days:
what ends it is the run's end, as its network goes with it. It opens the operator's credential,
at the models service, for that run's agent's calls alone ([What the API endpoints forward](models.md#what-the-api-endpoints-forward)),
and nothing at the gateways.

**The broker unreachable.** Running sandboxes keep working until their token expires, then
their calls fail until it is back, when the next renewal (every 30 seconds by then) brings
them back. The proxy waits for a broker restarting (5 minutes), as for the orchestrator; with two
copies on one store (Kubernetes, Redis #509), an update leaves one answering. A run that ended
is ended at the broker before its network goes (`DELETE /runs/:id`, told again until it is
heard), so either copy refuses its tokens; a record whose end never came expires 8 days after
its last renewal, and its inbox and files go when the orchestrator next lists the runs (at its
start, then every hour).

Both kinds are redacted from runs' output: the run's tokens (its agent's, and the first run
token, saved with its state so a restart redacts the one the sandbox holds), as its secret
was, and every run token by its shape, the header the broker signs each one with, or its
claims and signature alone (the header is the same for all, and its `kid` public): the ones a
sandbox renewed come from the broker service alone, which hands them to nobody else. A
renewed token cut in pieces (its signature alone, or split across two lines) is no longer
redacted, as a token listed whole was by any part of 16 characters; its binding to its
sandbox is what limits a leak. An inbox message shaped like a token is redacted before it
reaches the sandbox.

**No sandbox holds a GitHub token.** Its `GH_TOKEN`, `deckhand-token` and git credential
helper hand out the [run token](#run-tokens), and every call to GitHub goes through the github service's GitHub
gateway, which adds the token. In this document, "a sandbox's token" or "a run's token" is
that token: what the gateway sends GitHub for the run's calls, never something the sandbox
can read.

- It is an installation token minted for the run's repository only, for each call, and **it
  only reads what the run's [capabilities](policies.md#capabilities) give** (`listener/github-app.mjs`
  `READ_PERMISSIONS`, `readsOf()`), which GitHub enforces: `pull` gives `contents: read`,
  `read:issues` `issues: read`, `read:pulls` `pull_requests: read`, `read:discussions`
  `discussions: read`, `read:actions` `actions`, `checks` and `statuses: read`, and every token
  reads the repository's metadata. A run without `pull` gets nothing from GitHub at all. It
  can't push (pushes go through the git gateway, with the run token). The organization's
  projects only for a run the policies allow `read_projects`, in a repository granted one
  ([Projects](../repo-config/issues.md#projects)).
- **A token per write.** Each write the gateway checked and the policies allowed gets a token
  of its own, minted for that call, with the run's reads and only the write permission it
  needs (`listener/github-writes.mjs` `writePermissions()`): `issues: write` for an issue's (a
  comment, a label, a link, a reaction, an assignee, a milestone, a label it creates, a
  comment it edits), `pull_requests: write` to open or edit a pull request or answer one of
  its review threads (and `issues: write` too when it sets labels, assignees or a
  milestone), `contents: write` to ready or draft one or update its branch, `actions: write`
  for a rerun, `organization_projects: write` for a project's item. Anything else the run
  sends gets the read-only token, so nothing unchecked can write.
- **A `read:*` capability is a limit on what a run is given and can ask for, not a promise
  that the rest stays secret.** A run without `read:issues` can't list or read the
  repository's issues, but with `pull` the code's history, commit messages and pull request
  descriptions may quote them, and its prompt holds its own issue's thread.
- **Its own issue, without `read:issues`**: the one case the gateway checks itself. The REST
  paths of its issue and its comments (`/repos/<owner>/<repo>/issues/<n>`, `…/comments`, by
  the repository's name: `ownIssuePath()`, or by its id as GitHub's pagination links name it,
  `repositories/<id>/…`, the id looked up: `ownIssueId()`) and, in GraphQL, `repository(owner:, name:)` naming
  its repository then `issue(number:)` or `issueOrPullRequest(number:)` naming its issue
  (`listener/github-graphql.mjs` `issueReads()`) get a token minted with `issues: read` for
  that call alone, as a checked write gets its write permissions. Any other read of issues is
  refused, saying why: over REST a list, a search, another issue, an issue's events or a
  comment by its id; in GraphQL, any field whose value may be an issue (`node`, `nodes`, a
  connection of issues, `search` but of repositories, users or discussions, a fragment on an
  interface an issue implements), anywhere in the call, below its own issue too (its `parent`,
  sub-issues, a timeline item's `source`); and, in a call that reads its own issue, any other
  issue's comments (`User.issueComments`, a timeline's items, a pull request's conversation) or
  project items, whose field values hold their issue's title, labels and assignees (but its own
  issue's `projectItems`): send those apart, with a token that doesn't read issues.
- **Writes, without `read:issues`**: a write's token writes issues, which reads them all, and
  GitHub answers a write with what it wrote to. So such a run writes to an issue it can't read
  (a sub-issue, another issue the policies let it write to) only by a comment or a reaction, whose answer
  is the comment or the reaction (`listener/github-writes.mjs` `UNREAD`): editing, labelling,
  assigning or closing one is refused, and a "blocked by" link's blocker, like a sub-issue it
  links, unlinks or reorders, must be an issue it created. A mutation's answer may only name the issue or project item it wrote to (its `id`, `number`, `url`),
  hold the comment it wrote, and nothing else of issues, the rest refused the same way.
  A review still never reads its thread (below).
- **No sandbox token writes pull requests** outside those checked writes, so no sandbox can
  review one: `pull_requests: write` would let a run approve any pull request of its
  repository as the App, its own included, or replace a review mode's request for changes
  (GitHub counts a reviewer's latest review). The gateway gives it to a work run's checked
  writes to its own pull requests alone, opening or editing one, or replying to or resolving
  one of its review threads, whose document is the one it checked
  ([The default branch](github.md#the-default-branch)): reviews are refused whatever the policies say,
  and no default rule allows a merge (whose token, writing issues only, would fail at GitHub
  anyway). Comments on a pull request take `issues: write`.
- Tokens are cached per repository and permission set, renewed 10 minutes before their
  end, and shared by that repository's runs with the same permissions. GitHub makes them
  valid for an hour, which Deckhand can't shorten, but none leaves the github service, so none
  outlives its run in a sandbox: once the run ends, its run token gets nothing. Uninstalling the
  App, or suspending its installation, revokes them at once.

What a run prints doesn't publish one either way: the github service sends the orchestrator the
fingerprint of each installation token its gateway used for a run (a `token` event,
`lib/fingerprints.mjs`: never the token), and the orchestrator redacts what matches from the run's
log (what the dashboard shows), the run analysis digest and its reply, as `[redacted]`, a
defence in depth now that the sandbox never sees them. A fingerprint finds a whole token only:
one cut short in the output is left to the shape check. Anything shaped like a GitHub token (`ghs_`, `ghp_`,
`gho_`, `ghu_`, `ghr_` followed by 36 characters or more, `github_pat_…`) is redacted too,
wherever it came from: a token a restarted orchestrator has no fingerprint of any more, or one the
agent found elsewhere.

## Service tokens

Deckhand runs as services (#499, [Services](../contributing/services.md)), each one calling
others: edge the orchestrator, the orchestrator the runner, the proxy the github service, and so
on (`lib/services.mjs` `CALLS`, the one list of who calls whom). Every such call carries a
**service token** (`lib/service-token.mjs`), which the broker signs with the run tokens' key and
mechanism: Ed25519, checked offline with its public key, the same strict checks as above.

- **Claims**: `sub`, the calling service; `aud`, the service called, as
  `deckhand:service:<name>`, so a run token is never a service token nor the other way round;
  `exp`, **15 minutes**; `ver`, the claims' format.
- **Issued to its caller only**: each service asks the broker for its tokens at start and again
  two thirds into their lifetime (`serviceTokens()`, `lib/broker-client.mjs`; a broker away is
  asked again every few seconds while the tokens held last). The broker hands a service tokens
  only for the services `CALLS` says it calls, and only to the service the request proves it
  is, never one it names (`broker/callers.mjs`): the network it arrived on with Docker
  (`SERVICE_NETWORKS`, compose's `broker-orchestrator`, `broker-edge`, `broker-proxy` and the
  others, each a caller's own, internal), its pod's service account on Kubernetes (`SERVICE_ACCOUNTS`, edge and the orchestrator each
  with its own): a token
  projected for the broker alone (audience `deckhand-broker`), which the API server reviews
  (TokenReview). Neither set: the broker doesn't start.
- **Bound to its caller**: with Docker, each service is attached only to the networks of the
  services it calls, **one network per caller and callee**, and the service called checks
  which network a call arrived on (its own address on it, `SERVICE_NETWORKS`:
  `edge=172.30.1.0/24,…`) against `sub`. A token stolen from one service and replayed from
  another arrives on the wrong network: `403`. On Kubernetes, NetworkPolicies do it (with a
  network plugin that enforces them: [On Kubernetes](kubernetes.md#on-kubernetes)).

**What each caller may do.** `aud` isn't enough: each service declares, for each of its
endpoints, which callers may call it, in **one table per service**, checked in code
(`serviceGuard()`) before anything else:

```js
// The github service's (github/service.mjs), in part: edge reads, only the orchestrator writes.
{
  "GET /as/:owner/:repo/*": ["edge", "orchestrator"],
  "POST /as/:owner/:repo/*": ["orchestrator"],
  "GET /tarballs/:owner/:repo/:ref": ["runner"],
}
```

No token, or one that isn't valid for the service (another key, another `aud`, expired):
`401`. A token from another caller's network, a caller the table doesn't name on the endpoint,
or an endpoint that isn't in the table at all: `403`. Where routes overlap (`GET /runs/*` and `GET /runs/:id/secret`), each one that matches must name the caller, whatever their order. A path the URL parser would change (`//host/…`, `..` segments) is refused first (`400`), so a handler that routes on the raw path serves the endpoint the guard allowed. A compromised edge, already on its internal networks, gets what edge needs (a repository's
config, the dashboard's data, the redeliveries), never a minted token or a write but a
redelivery.
