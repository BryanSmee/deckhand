# What the services hold

Three services hold Deckhand's secrets: the github service the App's key, the broker the runs' signing key, the models service your agents' credentials. This page says what each one keeps, what to back up and which networks it is on, then how a sandbox reaches GitHub and its agent without any of them. Read it before you back up a deployment, or change its networks.

## The github service

The github service (`github/`, its own image) is the only one holding the GitHub App's key and
its installation tokens: the orchestrator's GitHub calls (replies, labels, reviews, the
dashboard's data), edge's (`/setup`'s conversion of the App's manifest, the redeliveries), the sandboxes' (relayed by the egress proxy: [How sandboxes reach
GitHub](#how-sandboxes-reach-github)) and the runner's tarballs all go through it, each caller
reaching it over an internal network of its own, which it tells them apart by
(`SERVICE_NETWORKS`). Its key is in the `github-key` volume, which no other service mounts: back
it up. Two copies may run side by side on one store (Redis, [The store](store.md)): a run's
state, its calls in flight and the idempotency keys are there, each copy's installation tokens
and git mirrors its own cache. Every push is saved in its
`/tmp` while checked (up to 2 GiB each, one per run): a size-limited tmpfs keeps them off the
host disk (`tmpfs` in `compose.yaml`, commented out).

## The broker service

The broker (`broker/`, its own image) is the only service holding the key that signs the runs'
tokens and the services' own: edge, the orchestrator, the runner and the egress proxy check them
with its public keys alone. It also keeps the live runs, their inbox, CA and digest in its store,
and their screenshots in blob storage (`BLOB_URL`, else its store too), which edge serves from it
(the `broker-store` volume), and serves what a sandbox calls about its own run, through the
egress proxy: its token's renewal, its inbox, its files. Its key is in the `broker-keys`
volume, which no other service mounts: back it up with the orchestrator's `data` volume.

The orchestrator, edge, the proxy and the runner each reach it over an internal network of their
own (`broker-orchestrator`, `broker-edge`, `broker-proxy`, `broker-runner`), and it tells them
apart by that network (`SERVICE_NETWORKS`): their subnets are fixed in `compose.yaml`,
`10.231.250.0/28`, `10.231.250.208/28`, `10.231.250.16/28` and `10.231.250.32/28`; set
`BROKER_ORCHESTRATOR_SUBNET`, `BROKER_EDGE_SUBNET`, `BROKER_PROXY_SUBNET` and
`BROKER_RUNNER_SUBNET` in `.env` if the host already uses them. The models service and the
github service have theirs, `broker-models` (`BROKER_MODELS_SUBNET`, `10.231.250.64/28`) and
`broker-github` (`BROKER_GITHUB_SUBNET`, `10.231.250.176/28`). Each of the orchestrator's calls
but a GET carries its lease's epoch, and the broker refuses one older than the newest it has
seen ([Two copies](two-copies.md)).

## The models service

The models service (`models/`, its own image) is the only one holding your agents' credentials:
the keys and tokens in `.env` (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) go to its
environment, and the plans' logins in [the credentials folder](agents.md#the-credentials-folder) are
mounted there, read only. The sandboxes' agents call their APIs through it, by the egress proxy,
which sends it their calls (`MODELS_SERVICE_URL`); the orchestrator asks it which credentials it
holds, by name, before it reads its own settings (it waits for it at start), and never sees
their values. The providers' addresses (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
`GEMINI_BASE_URL`, `OPENROUTER_BASE_URL`) are its settings too, in `.env` or `config.yaml`.

The plans' refreshed logins are in its store (the `models-store` volume, or Redis with
`STORE_URL`), sealed with a key made on its first start, `models.key` in the `models-keys`
volume (`KEY_DIR`), which no other service mounts: back up both. A store or a key the service
can't read its logins from (the volume lost, a new `models.key`, `STORE_URL` moved to Redis)
starts each plan again from its file, which it never writes: the ChatGPT plan's refresh token in
it was spent by the first refresh, so **sign in again** (`codex login`, [With a ChatGPT
plan](codex.md#with-a-chatgpt-plan)) when you change either; the Google AI plan's may still work, or
needs a new sign-in too. Two copies may run side by side on one store (Kubernetes): a login is
refreshed by one of them at a time. **Every copy must mount the same `models.key`** (one volume,
or one Kubernetes Secret holding the file, never one per pod): a copy whose key isn't the one a
login was sealed with refuses it, saying so in its log and in runs' errors, rather than replace
the other copy's refreshed login with the file's spent one. Its fingerprints' salt comes from the
key too, so copies with one key give the orchestrator one set.

The proxy and the orchestrator each reach it over an internal network of their own
(`models-proxy`, `models-orchestrator`), and it tells them apart by that network
(`SERVICE_NETWORKS`, `10.231.250.80/28` and `10.231.250.96/28`: `MODELS_PROXY_SUBNET` and
`MODELS_ORCHESTRATOR_SUBNET` in `.env` if the host already uses them); it reaches the broker
over `broker-models` (`BROKER_MODELS_SUBNET`, `10.231.250.64/28`) and the runner, which runs the
Antigravity login's refresh, over `runner-models` (`RUNNER_MODELS_SUBNET`, `10.231.250.112/28`).
On Kubernetes, `SERVICE_NETWORKS=none`: NetworkPolicies and the pods' service accounts tell
callers apart there.

Stopping it lets the agents' calls in flight finish, for up to 10 minutes (`DRAIN_SECONDS`,
600; compose's `stop_grace_period` is 630 s): an update waits for the turns going, and new calls
wait at the proxy, 5 minutes at most ([services](../services.md#the-models-service)).

## How sandboxes reach GitHub

No sandbox gets a GitHub token, an SSH key or the host's git configuration:

- Each run gets a run token, bound to its sandbox and renewed while the run lasts.
- Its git credential helper and `gh` wrapper (`GH_TOKEN`) hand out that token in place of a
  GitHub token. The egress proxy relays every call to GitHub (`GITHUB_URL`'s and `GITHUB_API`'s
  hosts) to the github service's GitHub gateway (never reached from a run's network but through
  the proxy, which vouches for the sandbox's network there), which sends it on with an
  installation token limited to the run's repository,
  which the sandbox never sees, and redacts secrets from what it writes (see
  [The GitHub gateway](../security/github.md#the-github-gateway)). A run's token only reads: contents,
  issues, pull requests, actions, checks, commit statuses and metadata (discussion runs their
  discussions too). Each write the gateway checked and the policies allowed gets a token of its
  own, with only the write permission it needs (`issues: write` for a comment, `pull_requests:
write` to open or edit a pull request…): see [Tokens](../security/tokens.md#tokens). Installation tokens last an hour; the gateway renews them before
  that, so a run can go on for hours. Every run but a research one trusts the egress
  proxy's CA, which certifies GitHub's hosts for the relay.
- Git fetches from GitHub over HTTPS through the GitHub gateway, and pushes through the github
  service's git gateway (to `http://github:8080`, the name the proxy sends there, with the run
  token), which pushes the run's own branch only (its
  issue's `issue-<n>-*`, or its pull request's head), never the default one, with a token of
  its own (see [Security model](../security/github.md#the-default-branch)): contents only, and
  workflows too for a repository granted `workflows`. A run's
  `gh pr create`, `edit` and `ready` go through the GitHub gateway like its other calls, for
  its own pull requests only, with a token that writes them for that one checked call: no
  other call's token writes pull requests. Commits
  and comments come from the App's bot (`<app>[bot]`, identity set through `GIT_AUTHOR_*`
  and `GIT_COMMITTER_*`).

The branches and pull requests a sandbox pushes run the repository's GitHub Actions like
anyone's, with its secrets and a `GITHUB_TOKEN`. Before installing the App on a repository,
set its default workflow permissions to read-only and keep deploy secrets behind
environments with required reviewers: see
[GitHub Actions on Deckhand's branches](../security/github.md#github-actions-on-deckhands-branches).

Nor does a sandbox get your Claude credential. Its Claude Code calls the broker's address
(`ANTHROPIC_BASE_URL=<broker>/anthropic`, which the egress proxy sends to the models service)
with the run's agent token where the credential would be; the models service checks the token,
puts your credential in its place and forwards the call

to Anthropic, streaming the answer back (see [Security model](../security/tokens.md#tokens)). Codex
does the same with `OPENAI_BASE_URL=<broker>/openai` and your `OPENAI_API_KEY`, and the
Antigravity CLI with `GOOGLE_GEMINI_BASE_URL=<broker>/google` and your `GEMINI_API_KEY`, or
through the egress proxy with a Google AI plan's login (see
[Antigravity CLI](antigravity.md)).

No agent is part of any image: before the first run that needs it, the runner installs the
pinned `CLAUDE_CODE_VERSION` into the `deckhand-claude-code` volume (Codex: `CODEX_VERSION`,
`deckhand-codex`; the Antigravity CLI: `AGY_VERSION`, `deckhand-antigravity`, its release's
tarball checked against the sha256 `AGY_SHA256` pins), in a container of its own, and later
runs reuse it, read-only. npm packages install with `--ignore-scripts`; only the agent's own
package then runs its install script (Claude Code's puts its native binary in place), never a
dependency's.

## Isolation

Sandboxes run without capabilities and with CPU, memory and pids limits, get no host path
unless you grant one, and reach only Anthropic, GitHub and the hosts you grant in the grants
folder, through the egress proxy. A [container engine](container-engine.md), when you grant one,
runs next to the sandbox rather than in it. See [Security model](../security.md): the grants folder, host
mounts, the mandatory hosts, and what isn't covered.
