# Security model

Sandboxes run Claude Code without permission prompts, on issues anyone may have written.
Deckhand assumes that whatever runs inside one may try to read what it shouldn't or send it
out, and limits what it can reach: no GitHub token, only calls through a gateway that adds
one for its own repository (see [Tokens](#tokens) and
[Setup](setup.md#how-sandboxes-reach-github)), no pushes to its default branch, no host
paths unless you grant them, a restricted network, and no privileges.

## The services

Deckhand runs as services, split by the secret each one holds and what each one can reach
(#499, [services.md](services.md)): each secret is in one service, and the only one the internet
reaches holds neither the App's key, the agents' credentials nor the Docker socket. Each service
takes from each caller only the endpoints that caller needs ([Service tokens](#service-tokens)),
and shares a network only with the services it calls or is called by
([The services' networks](#the-services-networks)). What a hole in each one gives:

| Service                                      | Holds                                                                                   | A hole in it gives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [edge](#edge)                                | the webhook secret, the session key, the OAuth client's                                 | forged deliveries and sessions (any allowed user's dashboard); through the github service, reads, the redeliveries and /setup's conversion (refused once an App is held) only: no token minted, no write                                                                                                                                                                                                                                                                                                                                  |
| [orchestrator](#the-orchestrator)            | nothing secret                                                                          | what it decides: runs started (each spec checked again by the runner against the grants), the App's writes through the github service, a run's first tokens with the claims it picks; no way out but the services it calls; no sandbox calls it (the egress proxy asks its egress policy)                                                                                                                                                                                                                                                 |
| [runner](#the-runner-service)                | the Docker socket or the Kubernetes API; blob storage's key pair (`BLOB_URL`), when set | with Docker, the host (the socket is root on it), and with it every service's secrets on that host (the App's key, the signing key, the agents' credentials, in their volumes); on Kubernetes, the sandboxes' namespace (with the services in another, only the registry's pull Secret of theirs, [Namespaces](kubernetes.md#namespaces)); with blob storage set, its bucket (or folder), to read, overwrite or delete. Beyond that key pair, it holds no credential itself                                                               |
| [broker](#the-broker-service)                | the tokens' signing key; blob storage's key pair (`BLOB_URL`), when set                 | every live run's inbox and digest, so it can direct their agents; tokens with any claims for a live run, handed to its sandbox at renewal, and so pushes through it to any repository the App is installed on (any branch but the default, as the push policies allow) and any of the operator's agent credentials; the `runs` stream the orchestrator reads (run ends, screenshots); with blob storage set, its bucket (or folder), to read, overwrite or delete. Outside a live run's own network (or pod), none of its tokens is taken |
| [github](#the-github-service)                | the App's key, its installation tokens                                                  | the App, on every repository it is installed on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [models](#the-models-service)                | the operator's agent credentials                                                        | those credentials                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [policy](architecture.md#the-policy-service) | nothing secret                                                                          | wrong decisions for its callers: a run's capabilities, the grants the runner checks every spec against again, the runs' writes and pushes; no network but its callers', so nothing else                                                                                                                                                                                                                                                                                                                                                   |
| [egress proxy](#network)                     | Deckhand's CA                                                                           | the runs' traffic, and the hosts they are granted; every live run's tokens, used as its own sandbox (it is the one vouching for it), and so their pushes, writes and agent calls                                                                                                                                                                                                                                                                                                                                                          |

The runs reach none of them directly: only the egress proxy is on their networks (on
Kubernetes, the only pods the NetworkPolicy lets them reach), and it relays their calls to the
github service, the models service and the broker, vouching for the sandbox each came from. No
sandbox calls the orchestrator: the proxy asks its egress policy about their connections.

## The default branch

Deckhand trusts a repository's default branch: its `.deckhand.yaml`, its sandbox
instructions. What that file can ask for beyond a sandbox (mounts, the Dockerfile built on
the host) only happens when your
grants folder allows it for that repository (see [The grants folder](#the-grants-folder)): with
the App on many repositories, whoever can push one's default branch must not get root on the
host through it. A sandbox that could write to a default branch could still change what
that file asks for, so none can:

- Sandbox tokens (what the [GitHub gateway](#the-github-gateway) adds to a sandbox's calls:
  no sandbox holds one) only **read** the code (`contents: read`). They can't push, write files
  through the API or merge a pull request, whatever the repo's settings.
- Pushes go through the **git gateway** (`listener/git-gateway.mjs`, in the
  [github service](#the-github-service)): the sandbox's git sends them to the broker's address
  (`url.<broker>/git/.pushInsteadOf`), with the run token, and the egress proxy sends them on to
  the github service. The gateway reads the ref updates at the start of the push (at most
  64 KiB of them, within 30 seconds; a refused push's pack is read and dropped for a minute
  at most, so git shows the refusal) and
  forwards it to GitHub with a token of its own only when every one is one of **the run's
  own branches**, and never the default one, looked up from GitHub on each push
  (case-insensitively). A run's branches are set when it starts:
  - a work run on an issue: `issue-<n>-*`, the branch the sandbox opens for issue `n` (named
    from its title, so a glob rather than a fixed name: the title may change);
  - a work run on a pull request, or a comment on an issue's pull request: that pull
    request's head branch, read from GitHub when the run starts, a maintainer's included
    (they asked for the run); none when it is a fork's;
  - a run without the `push` [capability](#capabilities) (with Deckhand's default policies:
    brainstorms, onboarding, inbox entries, discussions, run analyses, reviews, research):
    none. The broker registers every one as a run that can't push, so the gateway refuses
    it whatever its token, and the same holds for a run a restarted orchestrator picks up again.

  Anything else is refused, whether an update, a force-push or a delete: another issue's
  branch (which that issue's next run checks out), another pull request's (which its author
  may merge without reading it again, or whose Dockerfile a repo with
  the `branch_docker_images` grant would build on the host), long-lived branches such as
  `gh-pages` or `release/*`, tags, signed and compressed pushes. The refusal shows in git's
  output as `[remote rejected] … (Deckhand: …)`.

  Past these checks, each branch a push updates is a `push` decision of the
  [policies](#policies) (`allow_push`, `deny_push`: [the push input](repo-config.md#the-push-input)):
  one refused refuses the whole push. Deckhand's default, `policy/mode-work.rego`, allows work
  runs' pushes and those of a repository's own modes (which need the repository's `allow_push`
  too); without policies, every push is refused. A policy can only
  narrow the checks above: no rule reaches another task's branch or the default one.

- **One branch is created outside the git gateway**: a work run's own, by the orchestrator, as
  the run starts, so its issue's Development sidebar links it (`listener/linked-branch.mjs`,
  GitHub's `createLinkedBranch`, which creates the branch it links: GitHub links no existing
  one). It carries no code the gateway didn't check: the orchestrator creates it at the base
  branch's head, read from GitHub, with the github service's token, never the sandbox's, and only when
  the run may push `issue-<n>-*` (a run with `push`, not one where a fork's code runs), the issue
  has no `issue-<n>-…` branch yet, and the name it gets back matches `issue-<n>-*`. The
  run asks for nothing: no sandbox can create or link a branch through the GitHub gateway
  (`createLinkedBranch` isn't among its known mutations). Its first commit goes through the git
  gateway like any push. Policies may refuse it (`deny_link_branch`, Deckhand's default
  `gh-linked-branch.rego`: work runs only among the built-in modes, a repository's own modes
  once it allows them with `allow_link_branch`); then, or if GitHub refuses, the sandbox creates
  its branch itself, as before.
- The sandbox's `pre-push` hook only gives an earlier, clearer message: the gateway doesn't
  rely on it.
- A sandbox's token only reads pull requests (see [Tokens](#tokens)). `gh pr create`,
  `gh pr edit`, `gh pr ready [--undo]` and `gh pr update-branch` (GitHub's `createPullRequest`,
  `updatePullRequest`, `markPullRequestReadyForReview`, `convertPullRequestToDraft`,
  `updatePullRequestBranch`, or REST's `POST` and `PATCH` of `…/pulls` and `PUT
…/pulls/<n>/update-branch`) go through the [GitHub gateway](#the-github-gateway) as any write, with
  every `gh` flag the policies allow: Deckhand's default (`policy/mode-work.rego`) allows them to
  work runs only, for their own pull requests and new ones. Before the policies, whatever they
  say, `listener/github-pulls.mjs` checks that a new pull
  request's head is a branch of the repository the run may push (above), never
  `owner:branch`, another repository's head (`head_repo`, `headRepositoryId`) or an issue
  turned into one (`issue`), and that an existing one's head is too before it is edited,
  readied, drafted or has its branch updated, over any endpoint (`…/issues/<n>` included, whose
  write token has `issues: write`), or its token writes more than an issue's (a run on a
  fork's pull request may still comment on it and label it, not rewrite its author's title
  and description): another task's pull request is refused, and so is opening one from another branch.
  A pull request that conflicts with its base (`mergeable_state: dirty`) is refused ready
  with a 409 until the run rebases it. Only then does that one call get the token it needs
  ([a token per write](#tokens)): `pull_requests: write` to open or edit one, `contents: write` to ready
  or draft one or update its branch (GitHub asks an App's token for it), which the sandbox never sees, and which
  carries only the document the gateway checked. Only the head is checked: a run may open
  its pull request into any base branch, which it reaches only when a maintainer merges
  it.
- Updating a pull request's branch (`update_branch`) is the one write to a branch that
  doesn't go through the git gateway: GitHub commits a merge of the base into it. So it is
  held to what the gateway would hold a push to: the head must be one of the run's own
  branches, in its repository (never a fork's), as above; it is a merge only, since a rebase
  (`updateMethod: REBASE`) would rewrite the commits the gateway let through; and it names the
  head it applies to (`expected_head_sha`, `expectedHeadOid`), so GitHub refuses it when the
  branch moved since the run looked. The merge brings nothing of the run's: only the base's
  commits, already on that branch of the repository. Its workflow files still go through the
  same merge check as readying the pull request does ([below](#github-actions-on-deckhands-branches)),
  since the pull request's workflows then run from that merge with a base that may have
  changed since the last push. GitHub refuses an update with conflicts, which the run rebases
  locally as before. Deckhand's default policy for it, `policy/mode-work.rego` (shipped in the
  policy service's image), allows it to work runs, and to a repository's own modes once its
  `.deckhand/policy/` allows them (`allow_github`).

This doesn't depend on GitHub: branch protection and rulesets aren't enforced on private
repositories of free plans. Where they are, a ruleset on the default branch (pull request
required) is still worth adding: it also covers people and other tools. A sandbox's
branches still reach the default branch through pull requests that a maintainer merges:
review those that touch `.deckhand.yaml` or the Dockerfile. The
one exception is [Auto-merge](#auto-merge), where the orchestrator merges, and only with your
per-repository grant.

### GitHub Actions on Deckhand's branches

The gateway controls what a sandbox pushes, not what runs on what it pushes. A branch a
sandbox pushes, and the pull request it opens, are ordinary same-repository events:
workflows triggered `on: push` or `on: pull_request` (most CI) run that branch's code
(`npm test`, build scripts, a Makefile) with the repository's secrets and a `GITHUB_TOKEN`,
and pushes made with an App's token do trigger them. Code a sandbox wrote can then:

- push to the default branch, around the gateway, when that `GITHUB_TOKEN` can write: the
  repository's (or organization's) default workflow permissions are "Read and write" (the
  default for older repositories and organizations), or a workflow asks for
  `contents: write`;
- read any secret those workflows get and send it anywhere: Actions runners aren't behind
  the egress proxy.

By default the workflow files themselves can't change: neither the sandbox's token nor the
gateway's has the `workflows` permission, so GitHub refuses a push that adds or edits one.
What they run can.

**The `workflows` grant** ([the grants](#the-grants), one repository at a time) lifts that
for one repository: the gateway then pushes the run's branches with a token that also has
`workflows: write`, so a run can add a CI job or bump the Node version of a workflow. That
token is still the gateway's alone: the sandbox's own token never has `workflows`, a run without
`push` never pushes, and a fork's pull request has no branch to push. The grant is asked
again on each push, so taking it back applies to the next one.

It opens more than the workflows a repository already has: `on: push` and `on: pull_request`
run the branch's own workflow files. Unchecked, a workflow the run pushed could ask for
`permissions: contents: write` (a same-repository workflow's `GITHUB_TOKEN` gets what it asks
for, whatever the default workflow permissions say) and push to the default branch around the
gateway, which GitHub's rulesets don't stop on private repositories of a free plan; or name any
repository or organization secret (`${{ secrets.NAME }}`) and send it anywhere: Actions runners
aren't behind the egress proxy.

So the gateway reads the workflow files of a granted repository's pushes before GitHub does.
It keeps a bare mirror of the repository in its data directory (`git-mirrors/`), fetched with
a token that reads before each push; reads the push's pack against it (a push is a thin pack,
its deltas pointing at objects GitHub already has) into a quarantine of its own, so a refused
push leaves nothing behind; and checks each file under `.github/workflows/` that differs from
the default branch's at a pushed branch's tip, and each file that differs from a base's in
the tip's merge (`git merge-tree`) with the default branch and with the base of each open pull
request from that branch: GitHub runs a pull request's workflows from that merge, which can
hold a secret or a write permission the base added after the branch was cut, around a step the
branch edits. A workflow that doesn't merge cleanly refuses the push until the branch is
rebased. A merge's workflows are followed into the reusable workflows they call, as merged,
even when the tip has the same caller: a branch cut from an older default branch can pair its
caller with the base's newer callee. The same merge check runs again before the gateway lets a
run open, edit, ready or draft its pull request (into whatever base it asks for), or
updates its branch, since each runs its workflows from a new merge (`opened`, `edited`,
`ready_for_review`, `converted_to_draft`, `synchronize`).
The push is refused, with git's `[remote rejected]` naming the file and the rule, when
a changed workflow:

- has no top-level `permissions:` (the repository's default would apply, and it may write),
  or a `permissions:`, at the top or in a job, other than `read-all`, `{}` or scopes set to
  `read` or `none`: `write-all`, any `write` scope (`contents`, `actions`, `id-token`,
  `packages`…) and an expression are refused, keys matched without case;
- has a job with an `environment:`: it would read that environment's secrets through a
  workflow it calls, and the deployment it creates may start the `on: deployment` workflows of
  the deployed commit: the maintainers' copies, with their secrets, over the run's code;
- mentions `secrets` anywhere, in a key or a value, YAML escapes decoded: `secrets.X`,
  `secrets[...]`, `toJSON(secrets)`, `secrets: inherit`, and letters that fold to it
  (`ſecrets`, full-width); or has a non-ASCII character inside a `${{ }}` expression, whose
  names GitHub reads without case;
- uses YAML outside the strict subset the gateway reads (`listener/workflow-check.mjs`):
  anchors, aliases, tags, merge keys, several documents, duplicate keys (without case),
  multi-line plain or quoted scalars, flow collections over several lines, and line breaks other
  than `\n` and `\r\n` (NEL, U+2028, U+2029, a lone `\r`) or control characters. Only a space
  or a tab separates, as in YAML: a non-breaking or other Unicode space is text. A file the
  gateway could read differently from GitHub is refused, not guessed at;
- is a symlink or a submodule, isn't UTF-8 text, or is over 512 KiB; so is a `.github` or
  `.github/workflows` that isn't a folder, unless the default branch has the same one.

Workflows identical to the default branch's, files the run deletes and pushes that don't touch
`.github/workflows/` go through, the pack GitHub gets the one the client sent. A mirror that
can't be fetched or a pack that can't be read refuses the push with "try again": it is never
forwarded unchecked. Repositories without the grant don't change: their pushes stream through
unread, and GitHub refuses their workflow changes.

A checked workflow still runs the branch's code, with a `GITHUB_TOKEN` that reads. A job that
calls a reusable workflow from another repository (or another ref of this one, `uses:
owner/repo/…@ref`) is refused: that file never goes through the gateway, and a job of its with
an `environment:` reads that environment's secrets. One of this repository's (`uses:
./.github/workflows/x.yml`) is checked with the same rules, changed or not, and so are the ones
it calls. The local actions a workflow runs can't read `secrets`. Triggers that run the default
branch's version (`pull_request_target`, `workflow_run`, `schedule`) run the maintainers'
files, not the run's; `workflow_dispatch` runs the file of the ref it is given, which for a
run's branch was checked at its tip. Not checked:

- workflows already on the default branch that run a branch's code with write permissions or
  secrets (true without the grant too: see below);
- self-hosted runners: a workflow picks its runner with `runs-on`, so any self-hosted runner
  the repository can use runs a branch's code;
- configuration variables (`vars`), which any workflow reads: keep secrets out of them;
- a base's later changes: each pull request event a maintainer causes (`labeled`, `reopened`, a
  re-run by hand, a merge queue's `merge_group`…) merges the branch with its base as it is
  then. The branch's next push, and the run opening, editing, readying or drafting its
  pull request, check the merge again, but an event in between, after the base's workflows
  changed, runs a merge nobody checked. Limit environments' deployment branches (below) so that
  such a merge still can't read their secrets.

The mirrors take a copy of each granted repository in the github service's data volume
(`github-data`); a mirror's first fetch clones the repository, and may take up to an hour. A
push is saved in the github service's temporary directory while it is checked, one push per
run at a time, up to GitHub's 2 GiB. That directory is the github service container's own
writable layer, usually on the same host disk as its data volume: plan for the repositories'
size plus up to 2 GiB per run in parallel, or give the github service's `/tmp` a size-limited
`tmpfs` (commented out in `compose.yaml`) so a full one only refuses pushes.

Where GitHub enforces them, an enforced ruleset on the default branch (a pull request with an
approval, no bypass for the App or GitHub Actions) and environments with required reviewers or
deployment branches limited to the default branch are still worth having: they cover what the
checks don't, above.

The App needs the Workflows permission for it ([setup](setup.md#2-create-the-github-app)):
without it, the gateway refuses every push of that repository, its runs' first one included,
and says so, rather than pushing without it.

This is GitHub's model for any tool or person that pushes branches, not something Deckhand
changes: your workflows are yours to set up. On each repository the App is installed on:

- set **Settings → Actions → General → Workflow permissions** to "Read repository contents
  and packages permissions" (or the organization's default), and give `contents: write`
  only to workflows that don't run a branch's code;
- keep deploy and publishing secrets out of `push` and `pull_request` workflows that run on
  any branch: put them in an
  [environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
  with required reviewers, or limit those workflows to the default branch (with the
  `workflows` grant, the gateway refuses the workflows a run writes that name one, above);
- treat pull requests from the App's bot (`<app>[bot]`) like an outsider's in workflows
  and in your own webhooks ([preview deployments](repo-config.md#preview-deployments)): they
  are same-repository and look trusted, but their code comes from a sandbox.
- the same goes for `pull_request_target` and `workflow_run` workflows that check out a
  pull request's head: they run it with the default branch's secrets and a token that may
  write.

Not checked yet: whether a sandbox could push the head of a fork's pull request
(`refs/pull/<n>/head`) that changes a workflow, as its own branch, without `workflows`.
Assume it could, and keep secrets away from workflows on `issue-*` branches as above.

## Tokens

### Run tokens

A sandbox holds no credential of the operator's and no GitHub token: it holds **run tokens**
(`lib/tokens.mjs`), JWTs the **broker service** (`broker/`, a container of its own, #505)
signs with an **Ed25519** key that no other service holds. Every service checks their
signature **offline**, with the broker's public keys alone (`GET /keys`): the
[GitHub gateway](#the-github-gateway) and the git gateway (through `listener/broker.mjs`), and the
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
[capabilities](#capabilities), as its start decided them) and `ver`, the claims' format
(a sandbox outlives an orchestrator update; an unknown version is refused). What changes during a
run (the issues it created, the comments it posted, the reactions it added, the workflow runs it
reran) stays with the [github service](#the-github-service), in its store, by the run's id.

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
of the run's tokens still valid, and that last one sealed (AES-256-GCM, under a key derived
from the signing key, `broker/seal.mjs`), so that any copy of the broker can hand it back.
`deckhand-token`
prints the file, so the gh wrapper, git's credential helper, `deckhand-files` and
`deckhand-inbox` read it again for each call: the agent is told never to keep it
(`prompts/sandbox.md`).

**The agent's token.** The agent's API key variable (`CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, the Antigravity CLI's token file)
is read once, when the agent starts, and can't be renewed under it. So the agent gets a token
of its own, for `deckhand:agents`, with the same claims and binding, lasting at most 7 days:
what ends it is the run's end, as its network goes with it. It opens the operator's credential,
at the models service, for that run's agent's calls alone ([What the API endpoints forward](#what-the-api-endpoints-forward)),
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
  only reads what the run's [capabilities](#capabilities) give** (`listener/github-app.mjs`
  `READ_PERMISSIONS`, `readsOf()`), which GitHub enforces: `pull` gives `contents: read`,
  `read:issues` `issues: read`, `read:pulls` `pull_requests: read`, `read:discussions`
  `discussions: read`, `read:actions` `actions`, `checks` and `statuses: read`, and every token
  reads the repository's metadata. A run without `pull` gets nothing from GitHub at all. It
  can't push (pushes go through the git gateway, with the run token). The organization's
  projects only for a run the policies allow `read_projects`, in a repository granted one
  ([Projects](repo-config.md#projects)).
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
  ([The default branch](#the-default-branch)): reviews are refused whatever the policies say,
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

### Edge

The internet reaches one service only: **edge** (`edge/`, #506, [services.md](services.md)).
Compose publishes its port (`PORT`, 8080) on `edge-out`, a network of its own. It serves GitHub's
webhooks (`POST /webhook`), /setup, sign-in and sessions (`listener/auth.mjs`; MCP clients' too,
[MCP clients](#mcp-clients)), the dashboard's
files and `/health`, and passes the rest on to the orchestrator. It holds three secrets and
nothing else: the webhook secret, the session key and the OAuth client's (its id and secret), in
its own volume (`edge-data`, [Edge's and the orchestrator's data](#edges-and-the-orchestrators-data)).
No App key, no agent credential, no Docker socket: a hole in edge can sign deliveries and
sessions, not act as the App or start a sandbox. It runs as `node`, on a read-only root
filesystem, without capabilities.

- **Webhooks.** Until its signature can be checked, a delivery is read in one of a few capped
  places (16, 4 per source address, 5 MB, 10 seconds: `listener/deliveries.mjs`). Its HMAC
  (`X-Hub-Signature-256`) is checked with a constant-time comparison (`listener/events.mjs`
  `verified()`): none, or a wrong one, gets `401`. A verified delivery is **taken once, by its
  GUID** (`X-GitHub-Delivery`), set-if-absent in edge's store (`deliveries/<guid>`, kept a day:
  a redelivery of one taken comes within it), which both copies share: one GitHub sends twice, or that reaches
  both copies, goes on once. It goes on the `deliveries` stream in that store, with the secrets
  edge holds redacted from what people wrote (`storable()`), and only then is answered `202`.
  Once the orchestrator acknowledges it, it goes from the stream, its payload with it (the file
  store rewrites the stream's file once it holds 100 lines of them). `check_suite` and `status`
  deliveries (`QUIET_EVENTS`, which only tell the dashboard a commit's CI changed) are the
  exception: kept to their installation, repository and commit (`quietPayload()`), only for
  the repos `ALLOWED_REPOS` lets through (edge reads it too), they go on without their GUID,
  at most one per commit waiting for the orchestrator (`ci-waiting/<repo>@<sha>`, set-if-absent,
  cleared when the orchestrator reads that entry, kept 10 minutes at most: `edge/internal.mjs`),
  so a busy installation's statuses never crowd out the deliveries that start runs.
  The store away: `503`, its GUID freed, and GitHub marks it failed for the redeliveries to ask
  again. Their poller (the App's one write, `POST /as-app/app/hook/deliveries/:id/attempts` at
  the github service, edge's alone) runs on one copy, the holder of the store's lease
  `edge/redeliveries`.
- **What it passes on** (`edge/forward.mjs`): the dashboard's API (`/api/*`, the live logs
  included) and `/status`, to the orchestrator's services port
  under `/edge/…`, with edge's service token and the signed-in user's login in `x-deckhand-user`
  (or `x-deckhand-local: 1` for a `/status` call from inside edge's container). Edge builds
  those headers itself: of the browser's request, only `content-type`, `accept` and
  `last-event-id` go on, never its cookies nor an `x-deckhand-user` it sent; its Host and Origin
  go as `x-deckhand-host` and `x-deckhand-origin`, so that the orchestrator's same-origin check
  reads what the browser sent. The orchestrator takes the user header from edge's service token
  alone, arriving on `edge-orchestrator` (`listener/services-http.mjs`: `/edge/*` names edge
  only): a browser can't reach the orchestrator, and what it sends edge says nothing of who it
  is, edge's sign-in does. The dashboard stays on edge's origin, with the same CSP and
  `SameSite` cookie. An orchestrator away (handing over to its other copy) is waited for up to
  15 seconds, then `503`.
- **Its internal port** (`INTERNAL_PORT`, 8083, `edge/internal.mjs`) is the orchestrator's alone
  (its service token, from `edge-orchestrator`), never on the published one: the deliveries'
  stream (`GET /events`, `POST /events/ack`), the App's public parts (`GET /app`: its id, slug,
  owner, URLs and bot's id, never a secret), a redeliveries' scan (the dashboard's Sync), and
  the tags of the dashboard's "From the dashboard by @user" lines (`POST /from-tags`). Those
  tags are signed with a key derived from the webhook secret: the orchestrator posts the lines
  and holds no key, and a run, which posts as the App too, can't write a line that shows as a
  user's. A compromised orchestrator can still have edge tag any text as any user's, as it can
  post any comment through the github service.
- **Sessions** ([The dashboard](#the-dashboard)) are signed with the session key; each login's
  epoch is in edge's store (`sessions/<login>`), so a sign-out on either copy ends that login's
  sessions on both.

Two copies may run, both active on one store; a rolling update starts the new one, then the old
one drains (`DRAIN_SECONDS`, 25 seconds) and hands the poller's lease to the other.

### The orchestrator

Everything else is the **orchestrator**'s (`orchestrator/server.mjs`, #506): deliveries become
tasks, the queue, the runs' lives (started through the runner, their replies, reactions and labels
through the github service), what it starts by itself (reviews, fixes, auto-merge…), the
dashboard's data, and the egress policy the proxy asks. It **holds no secret**: none of its
settings is one (`test/networks.test.mjs` reads `compose.yaml`'s environments), and no secret's
volume is mounted in it; its `data` volume holds its state. It **has no way
out**: every network it is on is internal ([The services' networks](#the-services-networks)).
Its ports: the services port (8083: the runner's `POST /runs/:run/tokens`, edge's `/edge/*`)
and the egress policy's (8082, the egress proxy's). None is published. It runs as `node`
(uid 1000, #536), on a read-only root filesystem, without capabilities: it writes its volumes
alone, and reads the server folder and the mount roots you grant as that user.

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

### The runner service

The host's Docker socket is root on the host, and the Kubernetes API's credentials can start
any pod in the sandboxes' namespace (`KUBERNETES_NAMESPACE`; with the services in a namespace
of their own, `KUBERNETES_SERVICES_NAMESPACE`, its Role there reads no Secret but the
registry's pull Secret, so none of the services' keys, and that namespace may enforce Pod
Security `restricted`, [Namespaces](kubernetes.md#namespaces)): only the runner service holds either (`runner/`, #503,
[architecture.md](architecture.md#the-runner-service)). Edge, which the internet reaches
(webhooks, the dashboard), has neither, nor does the orchestrator: a hole in either doesn't give
the host. What the runner
does, it does for its callers, each endpoint naming which (`runner/service.mjs` `ROUTES`, checked
with their service tokens first, below):

| Caller       | May                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| orchestrator | start, follow, message, stop and remove sandboxes; build images, install agents, prepare caches; write and remove logs; and, for the egress policy, ask where an address is, the egress proxy's addresses, whether a sandbox installs its agent, and read a run's inbox and files, and read a run's log, for the dashboard's live view too, which edge passes on (unfenced: a copy still draining answers the proxy) |
| models       | have the Antigravity login refreshed: it sends the token file, never a container to run                                                                                                                                                                                                                                                                                                                              |

None can act on a container or a network that isn't one of this deployment's runs: the runner
stops, follows and removes only the sandboxes it lists by their labels (`deckhand.owner`,
`deckhand.run`), their engines, volumes, pods and Secrets only when their own labels say they are
that run's, a sandbox's run must be its own (`<name>-<ms>`), and a network goes only when its
labels say it is that run's (a start removes only the one it made). None can name a container's
image, mounts or capabilities beyond a sandbox spec
(`listener/sandbox-spec.mjs`), which the runner turns into Docker's options: `--cap-drop ALL`, `no-new-privileges`, the operator's limits and a user. And it
checks the spec again first, against the grants folder it reads itself and the operator's
policies it asks the policy service itself ([the grants](#the-grants): `runner/spec-check.mjs`):
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

### The github service

The GitHub App's private key mints installation tokens for every repository the App is installed
on: only the github service holds it (`github/`, #502, [architecture.md](architecture.md#the-github-service)),
in its own volume (`github-key`, `APP_DIR`: `app.json`, owner-only; a Secret on Kubernetes), never
in its store nor in another service's. Edge, which the internet reaches, keeps the App's
names, its webhook secret and its OAuth client's (`app.json` in its own volume, `edge-data`),
never the key; the orchestrator gets the App's public parts from edge (`GET /app`), nothing
secret. Its installation tokens stay in the service: the runs' calls go on with a token minted
for that call (below), edge's and the orchestrator's own with one they never get.

What each caller may do (`github/service.mjs` `ROUTES`, checked with their service tokens first):

| Caller       | May                                                                                                                                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| proxy        | the sandboxes' calls: the [GitHub gateway](#the-github-gateway) (`/relay/<host>/…`) and the git gateway (`/git/…`), the network (or pod) they came from vouched for (`X-Deckhand-Sandbox`), their own credential passed on apart (`X-Deckhand-Run-Authorization`)                                                          |
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
on no caller's network.

**The key.** A new App's key never reaches edge: /setup has the service convert the manifest's code
(`POST /app/manifest`, edge alone), which keeps the key and answers with the rest. GitHub
converts a code once: the rest is kept beside the key for an hour (`setup.json`), so that an
edge that didn't get the answer gets it by asking again with the same code (its /setup
callback loaded again), and goes then. A refused handover (another App's key there) is said
once in the orchestrator's log, and the key stays in its `app.json` until the operator removes one
of the two.

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

### The broker service

The broker (`broker/`, #505) is the only service holding the **signing key** of the
[run tokens](#run-tokens) and of the [service tokens](#service-tokens): `run-token.key` in its
own volume (`broker-keys`, owner-only, made on first start), never in its store nor another
service's. Every other service checks those tokens offline with its public keys (`GET /keys`,
and the `service-keys` volume it alone writes), and none can sign one. Its store holds the live
runs (their claims, the network or pod their tokens are bound to), their inbox, CA, digest,
the screenshots' names (the screenshots themselves are in blob storage, `BLOB_URL`, or in the
store without it: [Run files](architecture.md#run-files)), and the `runs` stream the orchestrator
reads; the tokens it renewed only sealed, with a key derived from its signing key
(`broker/seal.mjs`).

**What each caller may do** (`broker/http.mjs` `ROUTES`): the orchestrator the live runs, their end,
the stream, the screenshots it moves there from an older release's folder and those retention
removes; a run's first tokens, which it asks for when the runner
asks it (their claims are the orchestrator's, never the runner's); the runner the runs' inboxes
and files it copies there; the proxy the sandboxes' calls about their own run. Each
orchestrator call but a `GET` carries its fencing epoch, refused when stale (`409`, #506): a copy
that lost its lease ends no run and gets no token signed. The models service asks it whether
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
([On Kubernetes](#on-kubernetes)). With Compose, one copy runs
([architecture.md](architecture.md#the-broker-service)).

### Service tokens

Deckhand runs as services (#499, [services.md](services.md)), each one calling
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
  network plugin that enforces them: [On Kubernetes](#on-kubernetes)).

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

### The services' networks

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
APIs, `models-out`, with nothing else on it ([The models service](#the-models-service)). Not
`default`, where its callers are: Docker's DNS answers a name with its address on a network that
isn't internal first, and a call arriving there names no caller. The networks test checks that a
service and each of its callers share only the network `SERVICE_NETWORKS` names.

The runner is on one network, `runner`, internal and shared with the orchestrator alone, with a
fixed subnet each tells its caller by (`SERVICE_NETWORKS`, [The runner service](#the-runner-service)),
and on `runner-models`, the models service's, for the Antigravity login's refresh.
The policy service (#501), with Docker Compose, is on three others, internal (no way out):
`policy`, shared with the orchestrator alone, `policy-github`, shared with the github service alone
(the runs' writes and pushes), and `policy-runner`, shared with the runner alone, which asks
it [the grants](#the-grants) (`GET /policies` and `POST /evaluate` only, never `/capabilities`
or `/check`). Compose doesn't set its `SERVICE_NETWORKS`: its table still names what each
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
ports above ([Edge](#edge)).

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

### The GitHub gateway

`listener/github-gateway.mjs`, in the [github service](#the-github-service). The egress proxy
relays GitHub's hosts (`GITHUB_API`'s and `GITHUB_URL`'s, `listener/egress.mjs` `githubHosts()`)
to it, as it relays the Antigravity CLI's to the models service: it decrypts their HTTPS with
[Deckhand's CA](#https-and-deckhands-ca), which every run that reaches GitHub trusts, and sends
each request to the github service as `/relay/<host>/<path>` instead of the host
(`GITHUB_SERVICE_URL`). REST, GraphQL, clones and fetches all go there;
tools keep talking to `api.github.com` and `github.com` unchanged. A sandbox has no other way
to GitHub: the proxy never tunnels those hosts for it, and its plain HTTP to them is refused
(but for the two exceptions without a token, below).

- **Its run**: the run token the call carries in place of a GitHub token (`token <token>` from
  `gh`, `Bearer`, or Basic with it as the password from git), checked as above. A call that
  carries none (git's first request, a download with `curl`) is the run's whose sandbox has
  its address; never its engine's, whose builds and containers don't get the token (from
  there, such a call gets `401`). The proxy names the network (or pod) of the sandbox the
  orchestrator's egress policy found at that address, in an `X-Deckhand-Sandbox` header, replacing
  any the client sent (and drops one from every request it doesn't relay), with its own service
  token: the github service believes it from the proxy alone, and binds the run token to it. A token that doesn't check, an
  unknown or finished run's, or any other credential, gets `401`; another sandbox's `403`; a run
  without `pull` (a research run: `readsGitHub()`) `403`, whatever it sends.
- **Pushes** to GitHub's web host (`git-receive-pack`) are refused: they go to the git
  gateway (`pushInsteadOf`), as before.
- **Writes are redacted before GitHub gets them.** The body of every call but a read (`GET`,
  `HEAD`) and a fetch's pack request goes through the same redaction as the run's reply and
  log: the run's tokens (the one the call carries, and any by their shape), the tokens used for
  the run, anything shaped like a GitHub token, and the operator's credentials, which the github
  service holds none of, by their fingerprints ([The github service](#the-github-service)),
  in each string of its JSON (so an escaped character can't split one), replaced in place so
  the rest of the body goes on as it was sent, then as text (a body that isn't JSON; one
  that isn't UTF-8, byte for byte). GraphQL is redacted that way too, its query and variables, inline literals
  included, before it is parsed. A redacted write still goes through, with `[redacted]` in
  place of the secret, and the run's log says so (each call once, 20 at most). A comment,
  an issue edit or a `gh api` write can't publish what the sandbox holds, a mount's content
  that looks like the operator's key say, any more than its reply can. Refused instead of
  read: a write over 16 MiB; a compressed one (`Content-Encoding` other than `identity`,
  `415`), which couldn't be read; a read (`GET`, `HEAD`, `OPTIONS`) that carries a body
  (`400`), which would go on unread (git and `gh` never send one); and a write whose URL (its
  path or query, as sent or percent-decoded) holds one of those secrets: a path names what is
  written, so it isn't rewritten.
- **A review can't read its thread** other than from `TASK_DIGEST` ([Reviews](#reviews)):
  for a review run, the gateway refuses issue and pull request comments, reviews and review
  comments, the timeline and commit comments over REST, under `repos/<owner>/<repo>` or
  `repositories/<id>` (whatever the case or the encoding of the path), the event feeds
  (a repository's, a network's, a user's, an organization's, the public one: their comment and
  review events carry the bodies), issue search (`in:comments` matches comment text, and its
  text matches quote it), any GraphQL call that names `comments`, `reviews`,
  `latestReviews`, `reviewThreads`, `timelineItems`, the `Comment` interface, a comment's or
  review's type, their edit history or `search` (any name that holds "comment", "review",
  "timeline", "contentedit", "search" or "textmatch", whatever its case) (read as text, which refuses more than a parsed document's fields would), and anything on the web host but git's fetches (its pages
  show the comments). Other runs read them.
- **Writes are checked** (`listener/github-writes.mjs`, issue #405): each REST one (anything
  but `GET` and `HEAD` under the API, but GraphQL's and rendering markdown) is classified from
  its method, path and body into actions on a target (`create`, `edit`, `comment`, `label`,
  `link`, `close`…), and its target's kind is looked up on GitHub with the github service's own
  token, never taken from the request: the run's issue, its pull request (by its number, or
  its head on a branch of the repository the run may push: `broker.mjs` `allow()`), a
  sub-issue of its issue (its parent on GitHub, in the same repository), an issue the run
  created (GitHub answered one of the run's own calls with it: a REST create, or GraphQL's
  `createIssue`, which `gh issue create` sends and whose answer the gateway reads for that
  alone: only under the response key of a `createIssue` field it parsed, and only when that
  field selects GitHub's own `issue { url }`, unaliased (an alias such as `url: title` would
  answer with a URL of the run's choosing), since another field could answer under that name
  with any issue; no older than that call; written by the
  App's bot, which files issues for every run and for the orchestrator, so that alone says
  nothing; saved with the run across restarts), another issue
  or pull request. A comment by its id (`…/issues/comments/<id>`, GraphQL's
  `updateIssueComment` and `deleteIssueComment`) must be one the run posted (issue #455): GitHub
  answered one of its own comments with it (REST's `201`, or `addComment`'s
  `commentEdge { node { url } }`, under the same rules on response keys and aliases as
  `createIssue`'s), saved with the run, and it is still the App's bot's on GitHub. Any other,
  the orchestrator's own included (the same bot writes them), is refused before any look-up. A sub-issue link's child, named by its id, must be one the run created or
  one already under its issue, and moving an issue from
  another parent (`replace_parent` with any value but `false`) is refused: a link could
  otherwise take any issue under the run's, where its policies would let it edit. A "blocked by"
  link is a `link` on the blocked issue, and its blocker must be an issue the run created,
  one under its issue, or an open issue of its repository: never a pull request or another
  repository's issue. It orders work (`plans.mjs`), and leaves only a timeline event (and its
  dependency counts) on the blocker, editing nothing else there. A reply in a review thread
  (REST's `POST …/pulls/<n>/comments/<id>/replies`, GraphQL's
  `addPullRequestReviewThreadReply`) is a `reply`, resolving one (`resolveReviewThread`) a
  `resolve`, and opening it again (`unresolveReviewThread`) an `unresolve`, all on the thread's
  pull request: the thread is looked up on GitHub by its first comment, must be on that pull
  request, and its first comment's author (and whether it is the App's bot) goes to the
  policies. Their default (`policy/mode-work.rego`: work runs only, never resolving a person's
  thread; a repository's own modes only once it allows them) ships in the policy service's
  image like Deckhand's other default policies. A new review, or a review comment that answers
  no thread, is refused whatever the policies say. A
  write with a query string is refused unchecked: GitHub may read parameters there too. Then:
  - a write it can't classify and one outside the run's repository are refused before any
    policy runs, and so is every write of a run whose refused writes already cost 100 look-ups
    on GitHub in the last hour (`MAX_REFUSED_LOOKUPS`: they share the orchestrator's rate limit;
    each look-up counts as it is made, and is given back when its write goes on or GitHub or
    the policy service failed), and so are the **built-in checks** that hold whatever a policy says: a link's
    child and blocker (above), a reaction removed only if the run added it, an assignee, a
    project, a pull request's branch ([The default branch](#the-default-branch)), a rerun
    (below), `NEEDS_INPUT_LABEL` (which a run's label writes neither add nor remove on the
    issues it created: taking it off answers their questions; an edit dropping their
    questions section still does). An assignee it adds must be one of the repository's allowed
    users or the App's bot, never Copilot: an assignment notifies them. A reaction's target is
    the comment's issue or pull request, read from GitHub; a run removes only the reactions
    GitHub said it added and hasn't removed since (saved with the run like the issues it
    created, its 100 newest): the App's bot also adds the orchestrator's reactions, which a run
    never removes, on any comment, even where the run's same reaction came first (GitHub keeps
    one per user and content): the orchestrator notes each one before it asks GitHub
    (`PUT /reactions`, in the github service's store; `reactions.json` before, issue #458). Whatever a policy says, no run writes the repository's
    contents (pushes go through the git gateway) or settings, reviews, or a comment it didn't
    post;
  - an item added to a project (v2) (`addProjectV2ItemById`, issue #454) is a `project` on
    its content. A project is outside every repository, so per-repo config
    can't name one: its project, looked up from its node ID with the orchestrator's token, must
    be one the operator's grants list for the repository (`allow_projects`), or it is refused
    before any policy, which can't reach another. Only that write's token gets
    `organization_projects: write`. In a granted repository, only the runs the policies allow
    `read_projects` (a read, once per run: Deckhand's defaults give it to work runs,
    brainstorms and a repository's modes) read the organization's projects,
    never a review, an inbox entry, a discussion or an
    analysis, which read outsiders' text (the App can't narrow its token to one project: their titles, fields and the
    items it can see, which GitHub redacts for repositories the token doesn't cover). Setting
    an item's fields, removing or archiving it, and the project's settings, fields and views
    are refused: the orchestrator moves the repository's issues itself, from its
    `projects:` ([Projects](repo-config.md#projects)), on granted projects only;
  - then the policies' **`allow_github` and `deny_github`** ([Policies](#policies)): the write
    goes on when an allow rule of the operator's matches it (the repository's too for its own
    modes) and no deny rule does. No rule, no write; no policies, every write refused.
    Deckhand's defaults hold what each mode writes, one file per mode
    ([the default policies](repo-config.md#the-default-policies), [the table](repo-config.md#the-github-input)):
    a work run (`policy/mode-work.rego`) writes its own issue, its pull requests (readying,
    drafting them and updating their branch with a merge too), its issue's sub-issues and the
    issues it created (their labels, reactions, projects and milestones too), replies to,
    resolves and unresolves its pull requests' review threads, creates labels, issues, and pull
    requests from its own branches, edits the comments it posted, and reruns the failed GitHub
    Actions jobs of its own pull request's head (below), nothing else: not other issues and
    pull requests. Its deny rules refuse deleting a comment, resolving a person's thread,
    assigning anyone and a rerun past a first. A brainstorm (`mode-brainstorm.rego`) edits and
    reacts on its own issue, files issues and labels, orders and files its follow-ups (a
    "blocked by" link, a project, a milestone), and never comments: the orchestrator posts its
    reply. Inbox entries (`mode-idea.rego`, `mode-bug.rego`) file issues carrying their label
    and link the ones they split; discussions (`mode-discussion.rego`) file issues. Onboarding,
    analyses, reviews and research write nothing. No default rule
    allows closing, merging, locking or a label's settings.

  A **rerun** (`POST …/actions/runs/<id>/rerun-failed-jobs`, `…/actions/jobs/<id>/rerun`,
  issue #451; never a whole run's `…/rerun`, cancelling, dispatching, approving a fork's run
  or deleting logs, which no route knows, nor one asking for debug logs, `enable_debug_logging`
  with any value but `false`: they print more of what runs with the repository's secrets, and
  the run reads them) names a workflow run or a job: the gateway looks
  them up and takes the pull request whose head commit that run tested as its target: a run
  that failed (`failure`, `timed_out`, `cancelled`), of a push or a pull request of a branch
  of the repository (not a fork's), whose head commit is still that of an open pull request
  of that branch. That pull request is held to the policies as any target (Deckhand's default
  allows `rerun` on the run's own, `own_pr`, to work runs and a repository's modes), and its branch must be one the run may push (`github-pulls.mjs`). A run of Deckhand's reruns twice at most per
  head commit (`MAX_RERUNS`: a rerun takes a slot once its checks pass, with no await between
  the count and the slot, so calls made at once can't pass it; the slot is saved with the run
  before the call goes out, so a github service restarted meanwhile still counts it, and is freed when GitHub
  refuses it or it never goes out, and counted from GitHub's answer (or from none at all: a
  call whose answer was lost may have gone out, so it counts, fail closed), with the run and commit its check
  resolved, never looked up again, and saved with the run across a restart), and Deckhand's
  default policy (`policy/mode-work.rego`) denies all but a first rerun of each workflow run ([repository config](repo-config.md#reruns)). Its token gets `actions: write` for that
  one call; the sandbox's own only reads Actions.

  A refusal (a look-up GitHub fails: `502`, fail closed) answers in GitHub's error shape
  (`{"message": "Deckhand: …"}`, with the policies' reasons), which `gh` prints to the agent,
  and the run's log notes it.

- **GraphQL is parsed** (`listener/github-graphql.mjs`, issue #406), with graphql-js (the
  github service's one runtime package, bundled into a file at image build) and validated against
  GitHub's public schema, pinned in the repository (`listener/vendor/github.graphql`,
  updated on purpose): a call that doesn't parse (or holds over 2,500 tokens or
  64 KiB, refused before validation, whose cost grows with the square of a document's repeated
  fields) or validate, a
  subscription, a document with several operations and no `operationName` naming one, a
  GraphQL `GET` and a query string are refused, as GitHub would otherwise run something
  unchecked. A document with no mutation skips one of the spec's rules, the one on fields
  that can't merge (fragments on distinct types selecting a field of two types, as
  `gh issue view` does): GitHub doesn't apply it, and a query's token only reads. Validation runs in a worker thread (`createValidator()`), never on the github service's
  main thread (its other runs' calls, the orchestrator's and edge's), one document at a time, taken from the
  runs in turn, so one that floods the worker (with as many calls as the gateway lets a run
  have at once) delays itself, not the other runs. A document validated for over 10
  seconds is refused alone (`503`), and the worker started again for the others. A query goes on. A call holds 10 mutation
  fields at most (gh sends one), each response key checked once (GitHub runs it once), and
  the targets of one call looked up once each: a call can't spend the installation's rate
  limit on look-ups. Each field of a mutation, aliases and fragments included, must
  be one of the mutations Deckhand knows, setting only the input fields it checks, whatever their value, `null` too (classic projects,
  a parent or a template at creation, Copilot's assignment, a sub-issue by URL are refused), except the empty fields gh always sends, which set nothing
  (`createIssue`'s `projectIds` as `null` or `[]`, issue #422; one with a project is refused): a mutation
  GitHub adds is refused until Deckhand names it. The node IDs the fields name, inline or in
  their variables (resolved as GitHub resolves them), are looked up with the github service's
  token to a repository, a kind and a number, so the call's own claims say nothing; a node
  outside the run's repository is refused like a missing one, before its type is named; each
  field is then a write as above, held to the built-in checks, `allow_github` and
  `deny_github` with the same input,
  and one refusal refuses the call. What goes on is the document as the gateway parsed it,
  printed again (`print()`), never the call's bytes: GitHub runs exactly what was checked.
  That document is redacted again: a secret spelled with GraphQL's own escapes (`\u0064`)
  only shows once printed, the call's JSON having hidden it.
  A new mutation in GitHub's schema means `npm run schema` in `listener/vendor/`, a reviewed
  diff, and its entry in `MUTATIONS` before any run may send it.

- **CI's results beyond GitHub Actions** (`checks: read`, `statuses: read`): a run reads its
  repository's check runs and suites and commit statuses (`CHECK_READS`: `…/check-runs`,
  `…/check-suites`, `…/status`, `…/statuses`), and a GraphQL call that selects them (a field
  or fragment of their types: `statusCheckRollup`, `checkSuites`, `status`, a check run by its
  node ID; and a fragment on an interface or union one of them may be there, such as
  `node(id:) { ... on UniformResourceLocatable { url } }` or `resource(url:) { url }`, unless it
  selects only `__typename` and `id`), as `gh pr checks` and `gh pr view` do. That is what CI says of each commit: a
  check's name, state, conclusion, links, timestamps, and the title, summary and annotations
  its App wrote; nothing it couldn't already learn by reading the code and running the tests,
  but for what an external service chose to publish there. Neither permission writes: the
  routes that create or rerun a check are writes Deckhand doesn't classify, so refused. Each
  such read is first held to `allow_github` and `deny_github`, with `action: "read_checks"`
  and no target ([Reading CI's checks](repo-config.md#reading-cis-checks); Deckhand's
  `policy/gh-checks.rego` allows it in every mode), once per run, the answer kept: its
  input depends on the run only, and `gh pr checks --watch` polls. A refusal refuses the
  call, `gh pr view` without `--json` included. It hides the checks, not whether CI passes:
  a pull request's `mergeStateStatus` (`UNSTABLE`) and search's `status:success|failure|pending`
  qualifier stay readable, as any pull request's state and any search. Without the permissions, the REST reads are
  refused, naming them; a GraphQL read goes on with a token that lacks them, and GitHub's
  refusal of those fields comes back as Deckhand's message (`explained()`).
- **On to GitHub** with a token for the run's repository: what its capabilities read
  (`listener/github-app.mjs` `readsOf()`, and its own issue for a call that reads only that),
  and only for a write that passed these checks the one write permission it needs
  (`listener/github-writes.mjs` `writePermissions()`, [Tokens](#tokens)), so no write reaches
  GitHub unchecked (`token …` for the
  API, Basic with `x-access-token` for git, as GitHub expects an App's), the sandbox's `Authorization` and
  cookies dropped. An optional permission its installation hasn't accepted
  (`OPTIONAL_PERMISSIONS`, [setup](setup.md#when-the-app-needs-a-new-permission)) is left
  out of the token, and a call that needs it (`NEEDS`, `listener/github-gateway.mjs`) refused,
  naming it: a required one it lacks fails the token, as GitHub refuses it. A read whose
  permission the run's capabilities don't give (CI without `read:actions`) is refused naming the
  capability, over REST, and GitHub's refusal of those fields explained, over GraphQL.
  `discussions` stays required: only discussion runs read them (`read:discussions`), and their
  token fails without it, as before. The answer streams back as it comes, with the agents' endpoints' limits
  (`lib/upstream.mjs`): a call cut off after 10 minutes without a byte either way, 16
  calls in flight per run.
- **A work run that isn't a fork's gets nothing that would bring a fork's code**: a fork's
  repository, a fork's pull request's head, a commit that isn't its repository's, by git, the
  API, an archive, a page or a raw file ([What a fork's code may
  reach](#what-a-forks-code-may-reach)).
- GitHub's content hosts (`*.githubusercontent.com`, `listener/egress.mjs`
  `githubContent()`), all of them, are relayed to the gateway too for such a run
  (`listener/egress-http.mjs`): its file hosts (`GITHUB_FILES`: `raw.githubusercontent.com`,
  `media.githubusercontent.com` for LFS files, `patch-diff.githubusercontent.com` for diffs)
  for that check, the others (release assets, avatars…) as they are, read only,
  to the host they name. Both go on without a token, the sandbox's `Authorization` and
  cookies dropped, and don't count towards its calls in flight, as when they were plain
  hosts. For every other run they stay plain allowed hosts: none carries a token.
- **Actions logs** (`/actions/runs/{id}/logs`, `/actions/jobs/{id}/logs`, an attempt's):
  GitHub redirects their download to a storage host of its own, behind a signed URL, which
  the egress proxy doesn't open. The gateway follows that one redirect itself (HTTPS, no
  credential sent, the signed URL being its own), only to GitHub's log storage
  (`*.blob.core.windows.net`, `*.githubusercontent.com`) or GitHub's own host
  (`logStorage()`: the github service isn't behind the egress proxy) and streams the log back
  (`github-gateway.mjs` `ACTIONS_LOGS`); any other redirect goes back to the sandbox as it
  came.
- **Two exceptions, neither with a token**, which reach GitHub's hosts through a tunnel
  rather than the gateway, so what they get is anonymous (both accepted in pull request
  #411):
  - **A run without `pull`** (a research run) isn't relayed: it gets no CA and nothing from the
    gateway, and reads public GitHub (other projects' READMEs, issues, releases) as it did
    before the gateway.
  - **A run's [container engine](#container-engine)**: its builds and containers don't trust
    the CA, so the proxy can't relay them, and refusing them would break builds that fetch
    from GitHub (a release asset, `go mod`, an `npm` dependency). The engine holds neither
    the run token nor, by its address, the gateway's token: a call from it without a token
    gets `401`.

  A sandbox can reach GitHub around the gateway through its engine, but only anonymously,
  or with a credential it got elsewhere, which any other allowed host would take too.

### The models service

The operator's agent credentials (Claude, OpenAI and Google keys, a gateway's token, the plans'
logins) are in one service only, the **models service** (`models/`, #504): its environment, and
the plans' files in its credentials folder, mounted read only. Not in edge, the orchestrator, the runner,
the broker or any sandbox (a test reads `compose.yaml`: `test/networks.test.mjs`).

- **Who calls it.** The egress proxy, with the sandboxes' agent calls, and the orchestrator, each
  over a network of its own that only the two of them are on; every call
  carries the caller's [service token](#service-tokens), checked against one table of what each
  caller may do (`models/http.mjs` `ROUTES`): the proxy reaches the agents' endpoints alone; the
  orchestrator also learns which credentials it holds (names only), their fingerprints, a run's
  API state and its stream. It calls the broker (its tokens, whether a run goes) and the runner
  (the Antigravity login's refresh), and the agents' APIs: its only way out.
- **A run's agent token, checked offline.** A sandbox's call arrives with its run's agent token
  (moved by the proxy into `x-deckhand-run-token`, its own service token in `Authorization`)
  and the network (or pod) the proxy vouches it came from (`x-deckhand-sandbox`, from the
  orchestrator's egress policy, as for the broker). The service checks the token with the broker's
  public keys, for the agents' audience, from that network only, for a run the broker says still
  goes (asked every 30 s at most, its last answer kept 10 minutes while it is away), and reads
  its **`agent` claim**: the provider, and the credential of its, the orchestrator chose for the run
  (`claude@anthropic:key`). A Claude Code run's token gets no OpenAI key, nor the plan when it
  names the key.
- **The agents' base URL** is the broker's host (`<broker>/anthropic`, …): the egress proxy
  sends those paths to the models service, and the hosts it relays for the Antigravity CLI on a
  plan too (the egress policy says `models: true`).
- **The plans' logins, in its store, sealed.** A refreshed login (the ChatGPT plan's, the
  Google AI plan's) is kept in the service's store, encrypted with AES-256-GCM under a key only
  its containers hold (`models.key`, in a volume or Secret of its own, the same for every copy: a
  login sealed with another key is refused, never written over: `models/logins.mjs`):
  the store may be Redis, which every service reads (#509). The operator's file is where a login
  starts, never written: the store's login is used until the file's content changes (a new
  sign-in). Their refresh tokens are single-use, so one copy refreshes at a time, holding a
  lease in the store, and the others wait for its result; a refused refresh is saved too, so no
  copy spends the login again until the file is replaced.
- **What the orchestrator learns.** Which credentials are set, by name (its settings need them:
  which agents may run, `FALLBACKS`), and their **fingerprints** for redaction (`GET
/fingerprints`: a salt, each value's length and salted SHA-256, and the salted SHA-256 of
  each of its 16-character parts at fixed offsets, with a 32-bit rolling hash of each part that
  picks the few windows of a run's output worth hashing), never a value. The salt comes from the
  models service's key: every copy, and every restart, gives the same set. It reads them before it
  restores any run, and every minute after. It redacts a credential that shows whole in a run's
  output (whatever `.`, `/`, `=` are next to it), and a run of characters that holds one of its
  parts, whole: any part of a credential 31 characters long or more (a value cut off in an error
  message, #242), glued to other characters or not. A shorter part may get through, where the
  run's own tokens are redacted from 16 characters: the hashes of every 16-character window of a
  credential would give it back one character at a time; those of fixed parts only give back the
  few unknown characters of a part that is mostly known (`sk-ant-api03-` and 3 more), and the
  rest has too many. The credentials never enter a sandbox: this only catches a mistake bringing
  one back.

### The Claude credential

Your `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` outlives everything else a sandbox
could hold, and works for anyone: **no sandbox gets it**. Runs read text anyone may write
(issue and discussion comments, a fork's code), and their final message is posted as is: a
credential in the sandbox's environment could be read by Claude's tools or the repo's setup
and end up in a public comment.

- A sandbox's Claude Code calls the models service instead of Anthropic (`ANTHROPIC_BASE_URL`
  set to `<broker>/anthropic`, which the egress proxy sends there: `models/anthropic.mjs`), with
  the run's agent token in the variable
  your credential would be in, so it keeps its mode (an OAuth token or a gateway's
  `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer`, an API key as `x-api-key`; when you set
  several, `ANTHROPIC_AUTH_TOKEN` wins, then the API key, as in Claude Code).
- The models service refuses an agent token that isn't a live run's, or comes from another
  sandbox, or is another agent's, replaces it with your credential in the header it takes and
  forwards the call to Anthropic (or to the operator's `ANTHROPIC_BASE_URL`, a gateway such as
  OpenRouter), streaming the answer back. Only the
  operator sets that address: a repository can't, since it would send its code and your
  credential elsewhere. A sandbox never reaches the gateway itself, so it needs no host.
- So a run's agent token can call the API with your credential while the run lasts, and nothing
  after: what a run copied out of its sandbox can't.
- The orchestrator redacts the run's tokens from the sandbox's output before writing the run's log
  (what the dashboard shows) and from its reply before posting it, as `[redacted]`: the value,
  or any part of it 16 characters long or more (a value cut off in an error message); a value
  shorter than that isn't redacted (it would be no credential, and would redact ordinary words),
  and an encoded or split one gets through. Your credential, which it doesn't hold, it redacts by
  its fingerprints, whole or a part of 31 characters or more (see
  [The models service](#the-models-service)): which is why the credential isn't there to begin
  with. A JWT's header and the `.eyJ` that starts its payload don't count
  towards those 16 characters: every token its issuer signs shares them, so other JWTs in a
  reply stay readable.
- When the models service can't use an operator's login (a refresh that failed, a file it can't
  read), the sandbox's call and the run's reply get a fixed text per kind ("the operator's
  login for Google can't be refreshed right now", "can't be used", or "was refused, and must
  be signed in again", each followed by "see the models service's log"), never the error
  itself, which could quote the credential file. The details go to its log, redacted.

Codex's `OPENAI_API_KEY` is kept out the same way (`models/openai.mjs`): a sandbox's Codex
has `<broker>/openai` as its provider's base URL and the run's agent token as its key, sent as
`Authorization: Bearer`; the models service checks it, puts your key in its place and forwards the
call to OpenAI (or the operator's `OPENAI_BASE_URL`), under its base path only: a path with
`//host`, a scheme or `..` is refused, so the key can't be sent elsewhere, and only Codex's own
calls go (see [What the API endpoints forward](#what-the-api-endpoints-forward)). Both agents'
credentials are redacted
from every run's log and reply, whichever agent ran.

A ChatGPT plan's login (`CODEX_AUTH_FILE`, `models/chatgpt.mjs`) takes the key's place the
same way, with more reason: its refresh token is account-wide, single-use and rotated on every
refresh, so copies in several sandboxes would also spend each other's. The models service holds
the only copy: it refreshes the access token at `auth.openai.com` (one refresh at a time, for
all runs and every copy of the service), keeps the rotated tokens sealed in its store before
using them (the file is never written), and sends the
sandboxes' calls to ChatGPT's Codex backend (`chatgpt.com/backend-api/codex`) with the access
token and the account's `ChatGPT-Account-ID`, headers a sandbox can't set itself. A sandbox
gets the run's agent token as its key, as with an API key, and nothing of the login. The tokens are
redacted from runs' output too.

Why this way, checked against Codex 0.162.1 (`codex-rs/login`, `model-provider`): with a
ChatGPT login, Codex calls `chatgpt.com/backend-api/codex/responses` with
`Authorization: Bearer <access token>` and `ChatGPT-Account-ID`, the same Responses requests
as with a key (`store: false`, streamed), and refreshes at
`auth.openai.com/oauth/token` 5 minutes before the access token expires. A custom provider
(the sandbox's `deckhand` one) sends those requests with the run's agent token instead, so the
models service only has to swap the headers and the base URL; Codex in the sandbox never knows it
runs on a plan. Codex's own "external tokens" mode (`chatgptAuthTokens`) only exists in its
app server, not `codex exec`, and would still put the access token in the sandbox. Check it
again when you change `CODEX_VERSION`.

### The Antigravity CLI's login

The Antigravity CLI's `GEMINI_API_KEY` is kept out the same way (`models/google.mjs`): a
sandbox's `agy` has `<broker>/google` as `GOOGLE_GEMINI_BASE_URL`, `modelProvider: "gemini"`
in its settings, and the run's agent token as `GEMINI_API_KEY`, sent as `x-goog-api-key`; the
models service checks it, puts your key in its place and forwards the call to
Google (or the operator's `GEMINI_BASE_URL`), for the model calls `agy` makes under `/v1/` and
`/v1beta/` only (see [What the API endpoints forward](#what-the-api-endpoints-forward)).

A Google AI plan's login (`AGY_AUTH_FILE`, `models/antigravity-login.mjs`) is the token file
`agy` writes when you sign in: an access token for about an hour, and a refresh token that
stands for the Google account. Neither enters a sandbox. On a plan, `agy` has no base URL to
point at the models service, and its calls go to Google directly, so it is kept out another way:

- **The sandbox's token file holds the run's agent token** as its access token, with an expiry in
  2099 and a placeholder refresh token (`sandbox/agents/antigravity.sh`): `agy` sends the token
  as it is and never tries to refresh it (checked against agy 1.4.0).
- **The proxy relays the hosts that carry it.** For runs of the Antigravity CLI on a plan
  only (the broker's run says which agent it is), the egress policy marks
  `daily-cloudcode-pa.googleapis.com` and `www.googleapis.com` as relayed: the proxy ends the
  sandbox's TLS with Deckhand's CA (see [HTTPS and Deckhand's CA](#https-and-deckhands-ca)),
  cache on or off, and sends each request to the models service
  (`<MODELS_SERVICE_URL>/relay/<host>/<path>`) instead of the host, never as a tunnel. A path that could
  leave `/relay/<host>/` once parsed (`..`, `%2e`, `\`, or not starting with `/`) gets a
  `400` and never reaches either. The models service
  (`models/google.mjs`) checks the agent token, and that it comes from its own sandbox (the
  network the proxy vouches for),
  refuses any other agent's run, puts the plan's access token in its place and sends the call
  on, streaming the answer back. Only the paths `agy` calls go through
  (`daily-cloudcode-pa.googleapis.com/v1internal:*`, `www.googleapis.com/oauth2/v2/userinfo`):
  the plan's token opens more than the CLI's API, and a sandbox can't reach the rest with it.
- **Refused:** `agy`'s telemetry (`play.googleapis.com`, which carries the token too), whatever
  the grants say, for these runs. `antigravity-unleash.goog` (feature flags, no token) and the
  account's avatar (`lh3.googleusercontent.com`, a public image address) stay a tunnel, as
  every other host: `agy`'s eligibility check fetches the avatar the userinfo call names and
  stops if it can't (#224). Even if `agy` sent its token there, that token is the run's agent token,
  which works nowhere but the models service.
- **The refresh is `agy`'s own**: the models service doesn't reimplement Google's OAuth with a
  client secret taken from the binary. When the access token is within 5 minutes of its expiry (or
  Google refused it), it has the runner run `agy models` (the runner's
  `POST /logins/antigravity/refresh`, which only the models service may call: it never holds the
  Docker socket) in a short container of the sandbox image (no capabilities, as `node`), on a volume
  of its own (`<AGY_VOLUME>-login`), outside the runs' networks, with the login's expiry set in the
  past; it reads back the file `agy` wrote and keeps it sealed in its store. On Kubernetes it is a
  pod of its own (Pod Security `restricted`, no ServiceAccount token, no Secret, `~/.gemini` an
  `emptyDir`): the file goes in on its stdin and comes back on its stdout through the API server's
  `pods/attach`, never in its spec. That stdout is sealed with a one-time key the runner sends first
  on stdin (`listener/runner/kube-seal.mjs`): the container's log on the node, which log agents may
  ship off the cluster, holds only ciphertext, never the login. The egress proxy lets it reach
  Google's OAuth and the CLI's own hosts only, tunnelled (and GitHub's releases while an init
  container installs the CLI, when it has no claim, never once `agy` runs with the login). It is
  removed once it ends, whatever its outcome. One refresh at a time, for all runs and every copy of
  the service. The login's tokens are redacted from runs' output like the other credentials.

What this changes: the proxy reads those two hosts' requests and answers for these runs, as it
does a cached host's, and the run's agent token, which it sees, is worth what it is elsewhere: this
run's calls, until it ends. A sandbox that trusts the CA gains nothing: it reaches the same
hosts, through the same proxy. Check the hosts and paths again when you change `AGY_VERSION`.

`OPENROUTER_API_KEY`, for runs that fall back to Claude Code through OpenRouter
(`claude@openrouter` in `FALLBACKS`), is kept out the same way: such a run's Claude Code gets
the run's agent token as `ANTHROPIC_AUTH_TOKEN`, and the models service's Anthropic endpoint,
which the token's `agent` claim tells which provider the run is on, sends the call to
`OPENROUTER_BASE_URL` with your key. A sandbox can't pick its provider: only the orchestrator sets
it, from `FALLBACKS`, and the broker signs it into the run's tokens. The key is
redacted like the others.

### What the API endpoints forward

A run's agent token opens the operator's credential only for its own agent's calls. The
credentials open far more (files, batches, stored responses, fine-tuning, an organisation's
admin API), shared with every other run and with whatever else the operator uses them for, and
a batch or a cached content would keep billing after the run ends. So each
endpoint forwards a fixed list of methods and paths, what its agent calls, and nothing else:

| Endpoint                        | Runs                                                                               | Forwarded                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/anthropic/` (`anthropic.mjs`) | Claude Code's, on `anthropic` or a provider the operator configured (`openrouter`) | `POST v1/messages`, `POST v1/messages/count_tokens`, `GET v1/models`, `GET v1/models/<id>`                                                         |
| `/openai/` (`openai.mjs`)       | Codex's (`openai`)                                                                 | `POST responses`, `POST responses/compact`, `GET models`, `GET models/<id>`, under the API's base URL or ChatGPT's `backend-api/codex/`            |
| `/google/` (`google.mjs`)       | the Antigravity CLI's (`google`)                                                   | `POST v1beta/models/<name>:generateContent`, `:streamGenerateContent`, `:countTokens`, `GET v1beta/models`, `GET v1beta/models/<name>` (`v1/` too) |
| `/relay/<host>/` (`google.mjs`) | the Antigravity CLI's on a plan                                                    | `POST v1internal:<method>` on `daily-cloudcode-pa.googleapis.com`, `GET oauth2/v2/userinfo` on `www.googleapis.com`                                |

- Anything else answers `404` in the provider's error shape, never reaching the provider, and
  is a line in the run's log ("Deckhand refused the agent's call …"), redacted like the
  sandbox's output: an agent version that needs another path shows up there. Each call is
  noted once (by each copy of the models service), and the first 20 only, then one line saying
  the rest aren't, which the service streams to the orchestrator (its `models` stream): the
  orchestrator's own lines are written even past `RUN_LOG_MAX_MB` (see [Output](#output)), so a sandbox looping
  on refused calls can't grow its log without end. When a new `CLAUDE_CODE_VERSION`,
  `CODEX_VERSION` or `AGY_VERSION` needs another path, add it to the endpoint's list (`ROUTES`, `GEMINI_ROUTES`,
  `RELAYED_PATHS`).
- Each endpoint serves its agent's runs only, from the provider the orchestrator gave the run
  (`broker.provide()`, claimed by its tokens): a Claude Code run's token gets no OpenAI key,
  and a run without a provider gets no credential at all. A run a restarted orchestrator picks up
  whose saved record names no provider gets its agent's default one.
- A run has at most 16 calls in flight through all the endpoints of a copy of the models
  service together (32 with two copies): the next one answers `429` (agents retry those) until
  one ends. A call that gets no byte either way for 10 minutes is cut off: a stalled provider
  doesn't hold the service, which every run shares.
- So a provider's `401` on one of these paths, the only ones a run reaches, is what marks a
  plan's token for a refresh: a sandbox can't force refreshes through some other path.

## On Kubernetes

`deploy/kubernetes/` ([kubernetes.md](kubernetes.md)) keeps each rule above, in Kubernetes'
terms:

| Rule                                                        | With Docker Compose                                                              | On Kubernetes                                                                                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Docker socket, or the API's credentials, in one service | the runner alone mounts the socket                                               | the runner's pods alone mount their ServiceAccount's token (`automountServiceAccountToken: false` on the others but the broker's, which reviews tokens), for Roles in two namespaces, nothing cluster-wide         |
| Each secret in its service alone                            | its own volume or environment                                                    | its own Secret, mounted read only by its pods alone: edge's, the github service's, the broker's key, the models service's credentials and key; the orchestrator mounts none                                        |
| Who calls a service                                         | one internal network per caller and callee (`SERVICE_NETWORKS`)                  | one NetworkPolicy per service letting in its callers' pods alone (`CALLS`), default deny in both namespaces; `SERVICE_NETWORKS=none`                                                                               |
| A service token bound to its caller                         | the network it arrives on                                                        | the pod's service account: a token projected for the broker (audience `deckhand-broker`), reviewed by the API server (`SERVICE_ACCOUNTS`)                                                                          |
| Sandboxes reach the egress proxy alone                      | each run's internal network, the proxy alone on it                               | their namespace's NetworkPolicies, which the runner checks before every run (`isolationProblem()`); no DNS server, the proxy's address in `hostAliases`                                                            |
| No way out but the services' own                            | internal networks, a way out for edge, the github and models services, the proxy | egress rules: 443 for edge, the github and models services, the API server's addresses alone for the runner and the broker, any public host for the proxy (not the private ranges), nothing for the policy service |
| Hardened containers                                         | `cap_drop: ALL`, `no-new-privileges`, uid 1000, read-only roots                  | the same in each pod's security context; the sandboxes' namespace enforces Pod Security `restricted`, and every sandbox pod meets it                                                                               |
| The broker's public key, read only                          | the `service-keys` volume, which the broker writes                               | a ConfigMap the operator makes beside the signing key's Secret: no volume shared between services                                                                                                                  |

**NetworkPolicies need a network plugin that enforces them** (Calico, Cilium, k3s's own). One
that doesn't (Flannel alone) takes them and enforces nothing: a sandbox could then call the
services directly, the orchestrator's services port among them, and get what only the runner
may. The runner checks that the policies are there before every run, and that the cluster
applies them with a probe pod labelled as a sandbox each time it takes its lease, refusing every
run when the probe reaches anything but the egress proxy
([kubernetes.md](kubernetes.md#the-network-probe)); `deploy/kubernetes/check-isolation.sh`
checks it by hand. Some plugins apply a new pod's policies a moment after it starts (kube-router):
every pod of the sandboxes' namespace, the probe's included, first waits in an init container
until the API server and the DNS are out of reach and the proxy answers, and fails past
`KUBERNETES_PENDING_MINUTES` ([kubernetes.md](kubernetes.md#the-network-gate)). Each service's
own ingress policy is a second line: with the sandboxes' policies gone, a sandbox reaches edge's
public port alone.

**The API server** is no pod: the runner's and the broker's way to it is an `ipBlock` of its
addresses, which the operator sets (`deckhand-api-server`, [kubernetes.md](kubernetes.md#install)),
and which reaches nothing until then. With `buildkit`, the runner also reaches any address on 443
(the registries).

**What isn't covered**: a service
mesh that rewrites source addresses breaks the orchestrator's check of the proxy's calls (by its
pods' addresses), and refuses them: run Deckhand's namespaces outside it.

## Mounts

A sandbox only gets Docker named volumes:

| Volume                                                          | What                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `<prefix>-<owner>-<repo>-<n>-<hash>-workspace`                  | the issue's clone, kept between its runs                                                        |
| `<prefix>-<owner>-<repo>-<n>-<hash>-fork-workspace`             | the clone of its fork's runs (see [What a fork's code may reach](#what-a-forks-code-may-reach)) |
| `<prefix>-<owner>-<repo>-<n>-<hash>-<agent>`                    | the issue's agent session (`~/.claude`, `~/.codex`, `~/.gemini`)                                |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-workspace`            | the clone of the issue's light runs (modes with volumes of their own)                           |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-<agent>`              | the agent session of its light runs                                                             |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-push-workspace`       | the clone of its light runs the policies give `push` (and their `-light-push-<agent>`)          |
| `<prefix>-<owner>-<repo>-<n>-<hash>-research-…`                 | a research run's own (see [Research runs](#research-runs))                                      |
| `<prefix>-claude-code`, `-codex`, `-antigravity`, **read-only** | the run's agent, installed by the runner                                                        |
| `<prefix>-cache-<owner>-<repo>-<path>-<hash>`                   | the repo's `caches`, its own                                                                    |

`<agent>` is the run's agent (`claude`, `codex`, `antigravity`), and `<prefix>` the
deployment's `NAME_PREFIX` (`deckhand` by default).

`<hash>` (10 hex digits of the repository and task) keeps apart names that would otherwise
be the same, such as `acme/x` pull request 5 and `acme/x-pr` issue 5. Tasks whose session
dates from before it (`<prefix>-<owner>-<repo>-<n>-claude` exists) keep that name and their
volumes, but only when one of the task's own runs had that name (its log is in `logs/`, so
not once retention removed them all):
otherwise a new task could take over the session and workspace of another repository's task
whose old name is the same.

Light runs (the built-in modes with volumes of their own: brainstorms, onboarding, inbox
entries, discussions, analyses, reviews, research) read and comment (brainstorms, inbox entries
and discussions also create issues); work runs push. What each run gets and writes is its
[capabilities](#capabilities) and the [policies](#policies)', whatever its mode: Deckhand's
defaults give light runs neither `push` nor `setup` nor a pull request write, so the git gateway
refuses them. They never share a writable volume with work runs: what a light run could leave in
a clone or a session (git hooks, Claude's hooks and settings, code) would otherwise run in the
issue's next work run, with its token. So light runs get their own `-light-` clone and session
(`-light-push-` when the policies give one `push`; research runs `-research-`), no cache volumes without `setup`, and
granted host paths read-only without `push`. A work run after a brainstorm starts a new session,
from the issue and its comments. A repository's own modes share the issue's volumes, as their
capabilities pick them.

### What a fork's code may reach

Anyone can open a pull request from a fork, and an allowed user may ask for work on it: a
comment on it, or on another of the issue's pull requests, triggers a run whose code then
runs the fork's, through its setup, tests or the agent. Such a run is a fork's run (the
orchestrator looks up each pull request the run's comments came from), and must not reach what
the repository's later runs trust and execute:

- **Container engine**: none, whatever the grant (see [Container engine](#container-engine)).
- **Caches**: none. A `postinstall` could otherwise leave a tampered package in the
  repository's `~/.npm` volume, which every later work run, on any issue, installs from with
  push access. The run's log says "No caches: a pull request from a fork".
- **Host mounts**: read-only, as for a run without `push` (the log's `Host mount` lines say so).
- **Branch images**: never built from a fork's branch (the `branch_docker_images` grant).

These protections follow what triggered the run, not the code it fetches. A work run started
from an issue, or from one of the repository's own pull requests, isn't a fork's run, yet it
can bring a fork's code in itself: `gh pr checkout <n>`, `git fetch origin
refs/pull/<n>/head`, or a fork's archive or raw files. A prompt injection is enough ("check
that #123 fixes it", #123 being a fork's, in the issue, a linked thread or a pull request's
description). The fork's code would then run with everything a fork's run is denied:

- the repository's **cache volumes**, which every later work run installs from (the clone's
  reset at start, below, cleans the clone, not the caches);
- **host mounts** granted read-write, and the **container engine** if granted;
- the run's **token and push rights**: it can push the run's own branch, workflow changes
  included with the `workflows` grant.

So the [GitHub gateway](#the-github-gateway) refuses a work run that isn't a fork's what would
bring a fork's code (`listener/github-forks.mjs`), reading it included: it can't tell reading
from running. A fork's run, and a run whose capabilities are reads only (no caches, read-only
mounts, no engine, no push), fetch as before. The run's log notes each refusal, and the refusal says why, and that a
comment from an allowed user on the fork's pull request starts a fork's run, which fetches it.

**What it covers, and what it doesn't.** A fork's code is its _tree_: its files, commits and
blobs, and what is made of them (archives, diffs and patches, its workflows' artifacts and
logs). That is what tools fetch to build, test or run a pull request, and what the gateway
refuses, through every way to GitHub a sandbox has (below). Text a fork's author writes
elsewhere (the pull request's description and comments, its commit messages, branch names, its
workflows' check-run summaries, a repository's description) isn't a tree: it is read as any
comment is, data the sandbox's instructions tell the agent never to follow, and no check could
refuse it (`gh pr view` shows the description). An injection that asks the agent to decode and
run such text is no more a fork's code than a script pasted in a comment; the gateway doesn't
see the difference, and doesn't claim to.

- **A fork's repository**: any repository whose source is the run's repository's (a fork of
  it, or of one of its forks), by name or by id (`repositories/<id>`), whatever is read of it:
  git (`gh pr checkout` of a fork's pull request may fetch from there), the API, its pages,
  its files, GraphQL's `repository(owner:, name:)`. Git shows the reason as
  `remote: Deckhand: …`.
- **A fork's pull request's head or merge** in the run's repository (`refs/pull/<n>/…`, the
  pull request looked up on GitHub: its head isn't in the repository): in a fetch (a
  `want-ref`, or a `want` of the commit GitHub advertised under it, which git shows as
  `remote error: Deckhand: …`), an archive (`tarball`, `zipball`, `archive/`), a commit, a
  comparison, a ref parameter (below), raw and LFS files, and its diff and files
  (`gh pr diff`, `pulls/<n>/files`, `pull/<n>.diff` and `patch-diff.githubusercontent.com`,
  where it redirects). Its metadata (`gh pr view`) isn't refused.
- **A commit that isn't the repository's**: GitHub serves any commit of a repository's network
  (its forks') through the repository itself. So a fetch's `want`s, and a commit a call names,
  must be the repository's: a ref of its own pointed at it in what GitHub advertised to the
  run's git (a branch, a tag, a pull request from one of its branches), its default branch has
  it (`compare`), it is a branch's head (`branches-where-head`), or a pull request from one of
  its branches holds it (`commits/<sha>/pulls`: an earlier commit of an open one, one whose
  branch went with its squash-merge; a fork's commit only lists the fork's pull request).
  Anything else, a commit a branch dropped with no pull request or one only a tag reaches, is
  refused rather than looked for (for a minute, without asking GitHub again), and a fetch wanting over 20 objects no ref named is refused at
  once. An id is a possible commit from 4 hex digits (git's shortest abbreviation): a branch
  or tag of the repository named so is looked up first and passes (`cafe`, the tag `2024.1`,
  the branch `2024/q4`: a parameter's whole value, or each prefix of a path, one
  `git/matching-refs` call per kind). A tree and a commit's metadata (`git/trees`,
  `git/commits`) hold no file: not checked.
- **Ref parameters**: any REST, web or file host call's `ref`, `sha`, `head` and `base`
  (every value of each, whatever the path, their case or brackets: `ref[]`; the query split on
  `;` too), rather than a list of the calls that serve a file (`contents`, `readme`, `license`,
  `codeowners/errors`…). A pull request list's `head` and `base` only filter it: not checked
  there. A comparison's sides are refs too: another owner's (`main...someone:branch`) is
  refused, and after the repository's own owner (`main...org:<ref>`, `org:repo:<ref>`), the ref
  is checked as any. A ref spelled as git wouldn't name one (whitespace or a control
  character, `//`, `..`, `@{`, a backslash, a component starting with `.` (`refs/./pull/…`),
  a leading `-`, `/`, `:`, `^` or `~`, a comparison with more than three dots) is refused
  rather than
  taken for a branch, so the check doesn't rest on how GitHub reads it; after a ref, a file's
  own name may hold `..`, `@{` or spaces (`main/a..b.js`).
- **A page of the repository**: on the web host, the checks read the shapes above (archives,
  `raw/`, `blob/`, `tree/`, `blame/`, `commit/`, `compare/`, `pull/<n>`) and let through git's
  own calls and the pages that show no file (its home, issues, pull request lists, releases
  and their assets, tags, branches, labels, milestones, the Actions and workflow lists,
  discussions, the wiki, pulse, graphs, stargazers, watchers, forks, settings); a workflow
  run's pages are its run's (below). Every other page of the repository is refused, fail
  closed: GitHub's pages are many, `blob_excerpt/<id>` serves a blob's lines by its id, and
  code scanning's quote the code a pull request's analysis read.
- **A blob by its id** (`git/blobs/<sha>`, or a fetch's `want` of one): whoever wrote a fork
  can name its blobs (`git hash-object`), and nothing says where one comes from, so such a run
  gets none, its repository's own included: it reads a file with `contents/<path>?ref=` or from
  its clone. That clone is whole (`SANDBOX_FULL_CLONE`, set by `listener/sandbox-spec.mjs`),
  where other runs' are blobless (`--filter=blob:none`), whose checkouts ask for each blob they
  lack: a kept blobless clone (an older Deckhand's) gets every blob it lacks at the start, at
  once (`git fetch --refetch`), before any checkout. What the repository's branches don't reach
  (a local branch or a stash whose commits aren't on them) stays missing: the agent is told how
  many objects, and that this run can't fetch them, rather than a checkout of them failing on a
  refusal later.
- **git LFS's objects** (its batch API, `<repo>.git/info/lfs/…`, whose download links are on
  `github-cloud.githubusercontent.com`): named by their sha256, which whoever wrote a fork
  knows, as a blob's id, so the batch API is refused. An LFS file is read by its branch from
  `media.githubusercontent.com` (checked as raw files are). The sandbox image has no `git-lfs`.
- **What a workflow run made and shows**, which a fork's pull request's workflow writes as it
  likes (its tree zipped, say): its artifacts' and logs' downloads (`actions/artifacts/<id>/…`,
  `actions/runs/<id>/logs`, `actions/jobs/<id>/logs`) and every page of the run
  (`actions/runs/<id>/…`: its workflow file, the fork's own, its summaries, jobs and
  artifacts) are refused unless the run's head repository is the repository itself (looked up
  on GitHub). A run's metadata over the API (`gh run view`) isn't refused. A code scanning
  analysis downloaded as SARIF (`code-scanning/analyses/<id>`, which may quote the code it
  read, a pull request's) is checked by its ref, as any.
- **Lookups**: a run's calls may cause 120 lookups on GitHub a minute (answers already kept
  don't count), whatever host they came by: past that, its calls that need one get `429`
  until the minute is over. The installation's rate limit is the repository's other runs'
  and the orchestrator's too.
- **GraphQL** (`listener/github-forks.mjs` `checkGraphql()`, its fields followed with their
  types through the pinned schema): a fragment on `Blob`, the only type that holds a whole
  file, is refused whatever it names (an expression such as `refs/pull/7/head:a.js` can name a
  fork's), and so is `codeowners(refName:)` (CODEOWNERS' lines at any ref). A repository named
  by `repository(owner:, name:)` (variables resolved) is checked as above: a fork's is refused,
  whatever is asked of it. A repository reached any other way (a pull request's
  `headRepository`, `node`, `search`, `forks`, `parent`) may be a fork, which can't be checked
  before GitHub answers: only its metadata may be asked of it (an allowlist: the
  `RepositoryInfo` interface's fields, ids, settings, the viewer's), not its files
  (`codeOfConduct`, `codeowners`, its templates and guidelines…) nor its tree (`object`,
  `ref`, `releases`…), which are many and grow.
- **GitHub's content hosts**: `raw.githubusercontent.com` serves any file of a public
  repository without a token, a fork's pull request's included
  (`/<owner>/<repo>/refs/pull/<n>/head/<path>`, or a fork's commit through the repository),
  `media.githubusercontent.com` its LFS files by ref the same way (`/media/…`), and
  `patch-diff.githubusercontent.com` its pull requests' diffs
  (`/raw/<owner>/<repo>/pull/<n>.diff`), which carry a new file whole. And they all share one
  CDN, which answers for any of them whatever name the connection was made to: a tunnel to
  `avatars.githubusercontent.com` (or `objects.`) served a fork pull request's raw file when
  asked with `Host: raw.githubusercontent.com`, its SNI `avatars.` or `raw.` alike (checked on
  a public repository). So the egress proxy relays every `*.githubusercontent.com` host to the
  gateway, for a run it checks, never a tunnel: the three file hosts' calls are checked as
  above (a path in another shape is refused), the others' sent on as they are to the host
  they name, whatever `Host` the sandbox wrote, read only, and all without a token, as when
  they were plain hosts. Other CDNs' tenants answered `Host: raw.githubusercontent.com` with
  their own `404` (`pypi.org`, `registry.npmjs.org`).
  Archives come from `codeload.github.com`, where `github.com/<repo>/archive/…` and the API's
  `tarball` and `zipball` redirect: it isn't a mandatory host, and a grant that adds it
  reaches any public repository's archives, around these checks.
- **A branch pointed at a fork's objects**: GitHub keeps a network's objects together, so a
  push needn't carry a commit only a fork has to set a branch to it, nor a new commit's tree
  (a fork's tree, whose id is in any of its commits' metadata), nor a thin pack's delta base;
  that branch would then be advertised as the repository's own to the next fetch. So the git
  gateway reads each push of a work run that isn't a fork's whole and runs git's
  connectivity check against the repository's own objects rather than its network's
  (`listener/git-mirror.mjs` `connect()`): every object its new tips reach must be in the
  push or in the gateway's mirror of the repository's branches and tags (never `refs/pull/*`),
  fetched just before. Else the push is refused, saying which object. That mirror is the one
  the `workflows` grant keeps ([GitHub Actions on Deckhand's branches](#github-actions-on-deckhands-branches)), now for
  every repository whose work runs push: a copy of each in the data volume (`git-mirrors/`),
  whose first fetch is a whole clone. A fork's run may push its pull request's commits to its
  branch, as before: from then on they are the repository's, which the issue's later work runs
  start from (see [Not covered](#not-covered)).
- **Git's paths in any case** (`GIT-UPLOAD-PACK`, `Info/Refs`) are a fetch's, checked as one;
  any other spelling of them is a page, and refused. Git's fetch takes its own methods only,
  for every run: `GET` for its advertisement, `POST` for its pack request; any other would be a
  write streamed past the fetch's checks (`405`).
- **The call the checks read is the one that goes on**: the gateway serves a relayed host only
  as the egress proxy spells it (lowercase, no trailing dot, no port), as a sandbox can reach
  the gateway directly too, where `raw.githubusercontent.com.` would otherwise pass for an
  unchecked content host. The URL parser resolves dot segments, encoded ones too (`%2e%2e`), in
  the URL that goes on; a path whose decoding still holds one (`..%2f`), a backslash or a NUL
  is refused. Headers some front ends route or rewrite by (`X-Original-URL`, `X-Rewrite-URL`,
  `X-Forwarded-Host`, `Forwarded`, `X-HTTP-Method-Override`…) are never passed on.
- **The issue's kept clone**: a fork's run gets a clone of its own (a `-fork-workspace`
  volume, `listener/sandbox-spec.mjs`), so what it checked out (the fork's commits, its
  branch, a stash) never sits in the clone the issue's other work runs start from, where no
  gateway call would be needed to read it. The agent's session stays the issue's (see
  [Not covered](#not-covered)).

A repository's own pull requests (their heads on its branches) are never refused. What a
lookup can't answer (GitHub down, say) is refused, as a `502`: try again. When the run's
repository is itself a fork, its source is checked as the repository is, and its source's
other forks are refused.

Every run, a fork's or not, protects the issue's clone, kept for its next runs: setup and the
agent would otherwise run a fork left checked out there (its `SANDBOX_SETUP` and project
hooks, `.claude/settings.json`, before the model reads anything). Before either starts:

- `.git` loses its hooks and keeps only the config a clone needs (origin, set back to the
  repository's URL and git's default refspec, and its branches): no `core.fsmonitor`, `core.hooksPath`, filter
  drivers or includes that a fork's code could have left, for this start's commands and the
  checkouts after it (`draft-pr.sh`). The `pre-push` hook is copied back.
- The clone goes back to the branch it was on when that tracks a branch of the repository
  (`gh pr checkout` sets a fork's to its URL or to `refs/pull/<n>/head`) and has no commit
  that isn't on the repository (a fork's merged in, not pushed), else the base branch
  (always, for a run without `push`); `draft-pr.sh` goes back to the issue's branch on the same
  condition. Untracked and ignored files go (`git clean -ffdx`), after a work run's
  uncommitted changes are stashed (`git stash`). Stale worktrees are pruned first, so one
  can't keep a branch from being checked out. The agent is told where the clone was and
  what was stashed, and checks them out again if it needs them, once it has read them.
- Reviews read a pull request in a `git worktree` under `/tmp`, gone with their container, so
  the `-light-` clone never holds a fork's tree.

What it can still reach is in [Not covered](#not-covered).

No volume of the orchestrator's (or edge's) is mounted (#393). A run's files go through the broker
service ([Run files](architecture.md#run-files)), with the run token, which works
from its own sandbox only ([Run tokens](#run-tokens)), and only for its own run's files:

- **Its inbox** (the comments delivered to it), **the egress proxy's CA and its digest**: read
  only, from the broker's store (rather than the container's stdin, so a run
  outlives an orchestrator restart). Another run's token, or one sent from another sandbox, gets
  `403`; none, or a finished run's, `401`.
- **Its screenshots**: uploaded into its own folder at the broker, named with
  24 random hex digits, which it can't list. The broker takes each file after
  checking it: a name `GET /shots` serves (`[\w.-]+` with `.png`, `.jpg`, `.jpeg` or `.webp`),
  content starting the way that type does (so no HTML is served as an image), at most 10 MB a
  file and 100 MB a run. It writes it once into blob storage (one PUT, or one blob of its
  store), so `/shots` (edge's, from the broker) never serves half a file. A research run has no
  folder: refused. The folders an orchestrator of a release before #609 kept are moved to the
  broker at its start, regular files only (no symbolic or hard link, nothing resolving
  elsewhere, each checked again as an upload is): folders from before #393 were written by
  sandboxes.

Each agent's install volume (Claude Code's, Codex's, the Antigravity CLI's) is shared by
every repository, so it is read-only in sandboxes: a run that could replace `claude` there
would run its code in the next sandbox of any repository, with that run's tokens and
grants. The runner installs each version before the first run that needs it, as root, so
its files don't belong to the sandboxes' user, uid 1000, either. A Claude Code install that
finds the volume owned by uid 1000 (from an older Deckhand) takes it over and reinstalls from
npm rather than keep what a sandbox could have changed. A sandbox whose version isn't
installed stops with a message instead of installing it. On Kubernetes, whose Pod Security
`restricted` allows no root, the install runs as uid 1001 instead (a pod of its own into a
shared claim, or each sandbox's init container into an `emptyDir`): still not the sandboxes'
user, and the sandbox mounts it read-only all the same. Through the egress proxy, it reaches
its agent's install hosts only, tunnelled; an init container gets them only while its pod is
Pending, never the run's own hosts, and the sandbox never gets them
([Agents on Kubernetes](kubernetes.md#agents-on-kubernetes)).

What is installed is pinned: Claude Code and Codex by their npm version, the Antigravity CLI
by the sha256 of its release's tarball (`AGY_SHA256`, the operator's setting, not the
release's own digest, which comes from where the tarball does): a tarball that doesn't match,
or a version without a sha256, isn't installed. npm agents install with `--ignore-scripts`,
then only the agent's own package runs its install script, not its dependencies'. Those
dependencies' versions aren't locked: they are what npm resolves at install time.

No host path is ever mounted by default: no `~/.ssh`, `~/.gitconfig`, Docker socket or
source tree.

### Host mounts

A host path reaches a sandbox only when **both** sides agree:

1. **You** grant the repository a root in its grants file (below), read-only unless you say
   `read_only: false`.
2. **The repository** asks for a path under it in its `.deckhand.yaml`:

   ```yaml
   mounts:
     - path: /nfs/work/api
       read_only: false # default true
     - /nfs/work/docs # read-only
   ```

At each run, the orchestrator resolves each requested path (and the runner again) with `realpath` (`..` and every
symlink) and checks that the result is the root or inside it. With `/nfs/work` granted:

| Requested                          | Result                                            |
| ---------------------------------- | ------------------------------------------------- |
| `/nfs/work/api`                    | mounted at `/nfs/work/api`                        |
| `/nfs/work/../etc`                 | refused: resolves to `/nfs/etc`, outside the root |
| `/nfs/work/link` → `/etc`          | refused: resolves to `/etc`, outside the root     |
| `/nfs/work/link` → `/nfs/work/api` | mounted from `/nfs/work/api` at `/nfs/work/link`  |
| `/nfs/other`                       | refused                                           |

A refused mount stops the run, and the reply on the issue lists each refused path and why.
A read-write request under a read-only root is mounted read-only (noted in the run's log).

Paths the sandbox mounts itself can't be mount targets, nor anything inside or above them:
`/workspace`, `/tmp/screenshots` and `/tmp/deckhand` (the run's screenshots and files, kept
in its own filesystem), and each agent's session and
install (`/home/node/.claude` and `/opt/claude-code`, `/home/node/.codex` and `/opt/codex`,
`/home/node/.gemini` and `/opt/antigravity`), for every agent, whichever the run has. The
list comes from the agents' definitions, so a new agent's paths are reserved too. Neither
can the repo's `caches`. Paths are limited to letters, digits and `./@+-_`.

**Between the check and the mount.** The sandbox mounts the resolved path rather than the
one asked for, but Docker resolves that path again when the container starts, minutes later
when the run builds an image first. Two things keep a sandbox from redirecting it meanwhile:

- **Resolved again right before `docker run`.** If any mount now resolves elsewhere, or is
  refused, the run stops and the reply says so.
- **Read-write requests are refused when the sandbox can rewrite their path.** Another
  sandbox with a read-write mount could otherwise swap a directory on the way (`/nfs/work/api`
  for a symlink to `/`) after both checks, even when that directory is under another
  repository's root, or above every root. So a read-write path is refused when any directory
  from `/` down to its parent can be written by the sandbox's user, uid 1000 (its owner,
  with or without write permission, since an owner can `chmod` it back; group 1000 with group
  write; or writable by anyone). In a sticky
  directory (`/tmp`), only its owner and the entry's can rename an entry: there it counts
  only when uid 1000 owns either. The mounted directory itself may be writable: its own entry
  lives in its parent. With repo A granted `/nfs/work/api` read-write and repo B `/nfs/work`,
  A's read-write mounts are refused while uid 1000 can write `/nfs/work`: make it (and every
  directory above what you mount) owned by another user and read-only for uid 1000, or ask
  for the path read-only.

What isn't guaranteed: ACLs and NFS server-side permissions aren't read, only the mode bits,
owner and group the orchestrator sees. Read-only requests aren't checked this way, so a path
under a directory some sandbox can write could still be swapped in the moment between the
last check and the mount; grant read-write roots that don't hold your read-only ones. A
process outside Deckhand that can write the root can always redirect a mount. If uid 1000 is
also your own user on the host, the directories you own count as writable by sandboxes.
Directories above a root are checked as the orchestrator's container sees them (Docker makes
its `/nfs` root's, whatever the host's is): a sandbox only writes the host's through a granted
root, which the orchestrator sees at the same path, so mount every root into the orchestrator.

**The orchestrator and the runner must see each root**, at the same path, to resolve what is
asked: mount it into both read-only in `compose.yaml` (`- /nfs/work:/nfs/work:ro`). A root they
can't see grants nothing.

## The grants folder

What you give a repository beyond what every sandbox gets lives in `GRANTS_DIR`
(`/etc/deckhand/grants` in the orchestrator and the services that read it: `grants/` in the
[server folder](setup.md#the-server-folder) `compose.yaml` mounts read-only, with
[`server.example/grants/`](../server.example/grants) to start from): one file per
repository for its hosts, projects, mounts and limits, `default.yaml` for every repository,
and your policies in `policy/`, which hold [the grants](#the-grants) (a Dockerfile, an engine,
research, workflows, auto-merge). It is optional and read again at each run,
so an edit applies without a restart.

```
grants/
  default.yaml       # every repository
  acme/api.yaml      # acme/api
  acme/web.yaml      # acme/web
  policy/grants.rego # the grants, repository by repository (The grants, below)
  CODEOWNERS         # anything that isn't .yaml is skipped, and dot folders (.git, .github)
```

A repository's file is `<owner>/<repo>.yaml`, matched case-insensitively. It holds what you
grant that repository:

```yaml
# acme/api.yaml
# Reachable by its sandboxes, besides the mandatory hosts and default.yaml's.
hosts: ["*.acme.dev", pypi.org]
# Of the hosts it may reach, those whose answers the egress proxy keeps, HTTPS too (see The
# egress cache below), besides default.yaml's.
cached_hosts: [apt.acme.dev]
# Organization projects (v2), <organization>/<number>, its runs add their issues and pull
# requests to, and the orchestrator moves its issues on (see Projects in repo-config.md). Needs the
# App's Organization projects permission. Per repository only.
allow_projects: [acme/3]
# Its own limits; missing ones keep default.yaml's, else the built-in 2 CPUs, 4g, 2048.
limits: { cpus: 4, memory: 8g, pids: 4096 }
# Roots it may mount from (read-only unless read_only: false).
mounts:
  - root: /nfs/work
    read_only: false
  - /srv/datasets
```

`default.yaml` takes the same keys but `mounts` and `allow_projects`, for every repository:

```yaml
# default.yaml
# Hosts every repository's sandboxes may reach, added to its own file's.
hosts: [pypi.org]
# Mirrors every repository's runs download from again and again, cached.
cached_hosts: [deb.debian.org]
# Every sandbox's limits, over the built-in 2 CPUs, 4g and 2048 processes; a repository's
# own file overrides each one.
limits: { memory: 8g }
```

`mounts` and `allow_projects` in `default.yaml` are errors: a root, or a project outside every
repository, for every repository, are too broad to grant by accident, so they are granted one
repository at a time. The yes-or-no keys these files had before #498 (`allow_dockerfile`,
`allow_branch_docker_images`, `allow_docker`, `allow_research`, `allow_workflows`,
`allow_auto_merge`) are errors too, each saying what to do instead: for `true`, the
`allow_grant` rule to write; for `false`, which granted nothing, to remove it
([Upgrading](setup.md#upgrading-the-grants-498)). The preview hook's, `allow_preview` and
`acknowledge_automerge_and_preview_is_highly_dangerous`, are only warnings: the hook is gone,
so they grant nothing ([Upgrading](setup.md#upgrading-the-preview-hook-is-gone-574)).

**Errors stop runs, file by file.** A repository's file with errors grants that repository
nothing: its runs stop, with a reply naming the file (the details are in the orchestrator's logs,
not on GitHub), and the dashboard's repositories tab shows it as invalid, with the file and
its errors in its panel. Other repositories keep running. A broken `default.yaml`, or a
`.yaml` file that isn't `default.yaml` or `<owner>/<repo>.yaml` (deeper or at the top, a
`.yml`, a name GitHub doesn't allow, `acme/API.yaml` next to `acme/api.yaml`), stops every
run, and the orchestrator won't start with one. At start, a repository's broken file is logged
and the orchestrator starts anyway.

**Symlinks** are followed while they stay in the folder: one leading outside it is an error,
for that repository when it is its file, for every repository when it is a folder.

**Who can edit the folder can grant what reaches the host** (a Dockerfile built on its
Docker, a container engine, in `policy/`) and host paths (`mounts`): protect it like the deployment itself. A git checkout works well: reviewed pull
requests, and a `CODEOWNERS` giving each team its own repositories' files, while the
folder's root (`default.yaml`, `CODEOWNERS` itself) stays with you:

```
# CODEOWNERS of your deployment's repository
*                              @acme/platform
/server/grants/acme/api.yaml   @acme/api-team
/server/grants/globex/         @globex/admins
```

`compose.yaml` mounts the server folder read-only into the services that read it; pull it on the host and
the next run reads the change.

Quote patterns starting with `*` (`"*.acme.dev"`): YAML reads a bare `*` as an alias. See
[Where a sandbox's hosts come from](#where-a-sandboxs-hosts-come-from) for how `hosts`
apply.

**Dockerfiles** are the most powerful thing a `.deckhand.yaml` asks for: a Dockerfile is built on the
host's Docker with its network (on Kubernetes, by the cluster's BuildKit daemon, through the
egress proxy with the repo's hosts only, and pushed to the operator's registry; the runner
refuses to build unless NetworkPolicies make the proxy the daemon's only way out, but that
the daemon's own pulls use the proxy rests on its Deployment's `HTTPS_PROXY`, which the
runner can't see. The registry has to require credentials to pull, push and delete (Deckhand doesn't start with `KUBERNETES_REGISTRY` and no `KUBERNETES_REGISTRY_SECRET`): a repo image runs in its repository's sandboxes, so whoever could push over its tag would run code with that repository's grant, and it holds what its Dockerfile copied of the checkout, which any sandbox that could pull it would read:
[Repo images on Kubernetes](kubernetes.md#repo-images-on-kubernetes)). A repository whose config has `dockerfile`
without the `dockerfile` grant doesn't get it: its runs stop and the reply on the issue says
which grant is missing, like refused mounts. Grant it to repositories whose default branch you
trust as much as the host itself. `branch_docker_images`
is a grant too, not a `.deckhand.yaml` key: it lets anyone who can push a branch of the
repository change what is built.

### The grants

What a repository may do beyond hosts, mounts, limits and projects is a `grant`
[policy](#policies) decision of yours, asked for each repository and each grant, at each run
(an edit applies without a restart):

```json
{ "version": 1, "decision": "grant", "grant": "dockerfile", "repo": { "name": "acme/api" } }
```

`input.repo.name` is lower case. The rules are `allow_grant` (a boolean) and `deny_grant` (a set
of reasons): granted when an allow rule matches and no deny rule does. Write them in the grants
folder's `policy/` (`policy/grants.rego`, as
[`server.example/grants/policy/grants.rego`](../server.example/grants/policy/grants.rego)):

```rego
package deckhand

allow_grant if {
  input.repo.name == "acme/api"
  input.grant in {"dockerfile", "research"}
}
```

| Grant                  | What the repository gets                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `dockerfile`           | its `dockerfile` built on the host's Docker (capability `image:repo`)                       |
| `branch_docker_images` | its pull requests' runs build their branch's Dockerfile, never a fork's (`image:branch`)    |
| `docker`               | a [container engine](#container-engine) next to its sandboxes (`docker`)                    |
| `research`             | [research runs](#research-runs): any public host, without its code (`internet`)             |
| `workflows`            | its pushes may change `.github/workflows/` ([above](#github-actions-on-deckhands-branches)) |
| `auto_merge`           | UNSAFE: `review.merge` merges on a private repository ([Auto-merge](#auto-merge))           |
| `auto_merge_public`    | the same on a public repository too                                                         |

- **Nothing by default**: Deckhand's default policies have no `allow_grant` rule. No rule, no
  grant.
- **One repository at a time**: `docker`, `workflows`, `auto_merge` and `auto_merge_public`
  (an engine, workflow files run with
  the Actions secrets, merges nobody reviewed are too broad to grant every repository by
  accident). The orchestrator asks each of them again for two repositories nobody has: `*/*`, and
  `<owner>/*` under the asked repository's owner (GitHub names have no `*`). A rule that also
  grants it there (one without `input.repo.name`, a `startswith` on the owner, a `glob.match`
  with `*`) gives it to none, and the orchestrator logs why. This is a best-effort check, not a
  guarantee: a rule that doesn't match those two names (`regex.match("^acme/[a-z-]+$", …)`,
  `endswith(input.repo.name, "/api")`) still grants every repository it matches. List each
  `input.repo.name`. The others may go to every repository (a rule without `input.repo.name`).
- **Auto-merge is two grants**: `auto_merge_public` merges on a private repository too, so a
  `deny_grant` keeping a repository out of auto-merge names both:
  `input.grant in {"auto_merge", "auto_merge_public"}`.
- **Yours only**: only the operator's layer (Deckhand's `policy/` under the grants folder's
  `policy/`) is asked. A repository's own `.deckhand/policy/` `allow_grant` or `deny_grant` is
  ignored, and a config check error.
- **Fail closed**: when the policies can't be evaluated (the policy service down, a policy
  error), the repository gets nothing, as with a grants file with errors: no run starts there,
  and the reply says the grants folder has errors.
- **The runner asks too**: it calls the policy service itself (the operator's layer only, no
  repository's files) and checks every sandbox spec (an engine needs `docker`), and image build
  (`dockerfile`, `branch_docker_images`) against these, whatever
  the orchestrator says ([The runner service](#the-runner-service)).
- **Where they show**: a refusal says, for example, "the operator's policies don't grant
  `docker` to this repository (`allow_grant`)". The repository's config page names each grant,
  with the policy files that have `allow_grant` rules, and its Capabilities tab each
  capability's grant. The `/mode policy` dry run doesn't ask them. At start, the orchestrator warns
  for each policy file of the grants folder whose `allow_grant` rules name `auto_merge` or
  `auto_merge_public`.

## Who reaches a session

A comment reaches Claude when its author is in `ALLOWED_USERS` and the repository's own
`users`, and those are checked again later, not only when it arrives:

- a comment queued when the orchestrator stops (or crashes) keeps its author in the queue, saved
  in the store as it comes (`store/state.json`): the next orchestrator (or the copy waiting for
  its lease) drops it (and takes its 👀 off) when its author or repository is no longer
  allowed;
- every queued comment is checked again against the repository's `users`, read from its
  default branch, when its run begins (or, for a run still going after a restart, before it
  reaches that run): a `.deckhand.yaml` that removes a user while their comment waits out
  the pause, or behind a busy repository, stops it;
- a comment that waits for other issues (`/after`) is checked again when it starts.

A comment on a pull request goes on in the session of the issue the pull request closes
(`Closes #12` in its description) only when the pull request's head branch is in the
repository, as for the branches a run may push: anyone can open a pull request from a fork
saying `Closes #12`, and an allowed user's comment on it would otherwise go on in issue 12's
session. An issue comment's payload doesn't have the head: the orchestrator trusts the App's own
pull requests (`<slug>[bot]`, Claude's) and looks the others up, whoever opened them
(another App, `github-actions[bot]`, a collaborator). Anything else is the pull request's
own task.

GitHub may send a delivery again (by hand from the App's settings, or after a timeout on its
side): edge takes each delivery id (`X-GitHub-Delivery`) once, in its store, for a day, across
restarts and for both its copies; and the orchestrator handles each once, a delivery it handled
whose acknowledgement was lost included ([Edge](#edge), [The orchestrator](#the-orchestrator)).

### Auto-pickup

With `AUTO_PICKUP_SLOTS` set and a repository's `auto_pickup: true`, a label starts a run
with no comment: the orchestrator picks the open issues labelled `AUTO_PICKUP_LABEL` by itself
(`listener/auto-pickup.mjs`, [setup.md](setup.md#auto-pickup)). The label stands for an
allowed user's trigger comment, so the orchestrator checks what it would check of one, and what
it couldn't see of a label:

- the run is the work of whoever last added the label (the issue's `labeled` events): they
  must be in `ALLOWED_USERS` and the repository's `users`, read from its default branch right
  before the start, and not a bot. Anyone with triage access can add a label: one added by
  someone else starts nothing. When the label's last event the issue lists took it off (a
  picked run's), the labelling that put it back isn't listed yet: nothing starts until it is,
  rather than as the earlier labeller's;
- the label vouches for the issue as it was when it went on. A title changed (a `renamed`
  event) or a description edited (GraphQL's `userContentEdits`) after it, or in the same
  second, by anyone but an allowed user, holds the issue: on a public repository, an
  outsider's issue rewritten once labelled would otherwise run as the labeller's. Every edit
  since the label counts, not only the last one (an allowed user's typo fix doesn't vouch for
  an outsider's rewrite before it). The issue's own last edit (`lastEditedAt`, `editor`) is
  checked too, and a history longer than the 100 edits read holds the issue when the edits
  not read may be since the label: GitHub doesn't document the order it lists them in, so
  either end of the history may be the one left out. Edits by the App's own bot count as
  anyone's (what a run writes may come from any comment): the label has to be added again;
- the run's policies see it as `trigger: "auto-pickup"` with the labeller as `sender`, and a
  `deny_run` rule can refuse it;
- the label comes off before the run is queued, so a run that fails or is refused isn't
  started again and again: a person adds it back. The App never adds it itself: its own
  `labeled` event would make it the labeller, which nothing starts for. An issue held by its
  labelling keeps the label, and the App's comment says why, once per labelling.

## The dashboard

Only `ALLOWED_USERS` sign in. Each repository's tasks, runs and live logs (whose tool output
may hold what a run read) are shown to the users in its own `users` too, as the orchestrator last
read them (for a run or a comment, or for the repositories tab); a repository whose
`.deckhand.yaml` hasn't been read since the orchestrator started is shown to every allowed user
until it is. `/status` lists them the runs and queued comments of those
repositories only. An open live log stops within a second of its viewer leaving the
repository's `users`. Edge checks the session on each request it passes on, not during a
stream: a live log already open goes on after a sign-out until its stream ends or reconnects.
The repositories tab and its configs are shown to every allowed user.

Every answer on edge's port carries `Content-Security-Policy: default-src 'self';
frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`: the dashboard runs its own
scripts only (its build has none inline), and no page can frame it to get a signed-in user to
click Start, Cancel or Rerun, which `SameSite=Lax` would let a sibling domain do. The setup
and sign-in pages narrow it to `default-src 'none'`, their own images, and their style by its
hash.

Edge signs users in and holds their sessions ([Edge](#edge)); the orchestrator, which answers
the dashboard's API, only learns the login edge passes on with its service token. A session is
a signed cookie, valid for 7 days, with the login and its **epoch**. Signing out bumps the
login's epoch, in edge's store (`sessions/<login>`): every session of that login ends, in any
browser, on either copy of edge, including a copied cookie. Removing a user from `ALLOWED_USERS`
and restarting edge also signs them out; rotating `session.key` in edge's volume signs everyone
out.

`/status` answers calls from inside edge's container without a session (edge passes them on as
local, `x-deckhand-local`). A reverse
proxy on the host's network calls from loopback too: a request carrying `Forwarded`,
`X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP` needs a session. If your proxy adds none
of them, keep `/status` from it.

### MCP clients

MCP clients (Claude Code, Codex, an editor) sign in to Deckhand as one of its users, through
edge, which is a small OAuth 2.1 authorization server for the `/mcp` resource, as the
[MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization)
asks (`edge/oauth.mjs`, #481). It signs its users in with GitHub as the dashboard does: no
identity provider of its own, nor a secret beyond edge's three.

- **Discovery.** `/mcp` answers `401` without a valid token, with `WWW-Authenticate: Bearer
resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"` (RFC 9728), which
  names edge as the authorization server (`/.well-known/oauth-authorization-server`, RFC 8414).
  Both point at Deckhand's public URL (`PUBLIC_URL`, else the App's).
- **Registration** (`POST /oauth/register`, RFC 7591): public clients only (no client secret,
  whatever the client asks for), 1 to 5 redirect URIs, each `https://` or `http://` to
  `localhost`, `127.0.0.1` or `[::1]` (on the loopback, any port matches, RFC 8252); a custom
  scheme (`cursor://`) is refused. At most 20 registrations an hour per source address (its /64
  for IPv6), and 300 from all of them together; one no one signs in with is gone after a day.
  What remains: someone with many addresses can still use up the 300 for an hour at a time,
  stopping new clients from registering (those already registered sign in, and refresh,
  as before); and behind a reverse proxy edge sees the proxy's address alone, so every client
  shares one address's 20.
- **Authorization** (`/oauth/authorize`): PKCE with `S256` is required (`plain`, or none, is
  refused); the client and its redirect URI must be registered, else the page says so and sends
  nobody anywhere. Nobody is sent to a client's redirect URI before signing in, an error
  included, and a request refused before the consent page (`response_type`, PKCE, `resource`)
  goes back only to a loopback redirect URI, the user's own machine; for an `https://` one, a
  page says what was refused. Anyone may register a client, so sending someone there unasked
  would be an open redirect (RFC 9700 §4.11.2). A Deny is sent back, once the consent page
  has shown where to. Someone not signed in goes through GitHub (`/auth/login?next=…`, which only
  ever returns to `/oauth/authorize`), and an allowed login then sees a consent page naming the
  client (its own claim), the login it will act as, the scopes and the redirect URI. Only an
  allowed login gets that page, and so a code: a login outside `ALLOWED_USERS` is refused at
  GitHub's callback, as on the dashboard. The consent is a form posted once (its request,
  in edge's store for 10 minutes, bound to the login), from edge's own origin (`Origin`
  checked: the page is served with `Referrer-Policy: same-origin`, under which the browser sends
  it; the session cookie is `SameSite=Lax`); the page can't be framed.
- **Tokens** (`/oauth/token`): the code (5 minutes, once; a code used twice ends the tokens it
  gave; bound to the login's session epoch at the consent, so a sign-out before the exchange
  voids it) with its verifier, its client's id and redirect URI, becomes an opaque access token (an
  hour) and a refresh token (30 days), bound to the login, the client and the resource
  (`<PUBLIC_URL>/mcp`, RFC 8707: a client naming another is refused). A refresh rotates the
  refresh token; one used twice (or two refreshes at once) ends its whole family, the client
  signing in again. Each write of a family's tokens is a compare-and-set on its current value,
  and a revoked family leaves a mark (`mcp/revoked/<id>`, 30 days) its creation checks: a
  refresh, an exchange or a code used twice racing a revocation never brings the family back. A
  refresh may ask for fewer scopes: its access token gets those, its refresh token keeps the
  grant (RFC 6749 §6). Scopes: `deckhand:read` and `deckhand:work` (what a client gets when it
  asks for neither), and `deckhand:machine`, granted only when asked for (machines, #595);
  others (`offline_access`) are ignored.
- **Kept hashed.** Codes, access and refresh tokens are random (256 bits) and kept as their
  SHA-256 in edge's store (`mcp/…`), which its two copies share: they survive a restart and a
  handover, and neither the store nor the logs ever hold one.
- **Every use is checked again**: the token's family still there, its login still in
  `ALLOWED_USERS`, and its session epoch unchanged. Signing out on the dashboard (which ends
  that login's sessions everywhere) ends its MCP clients' tokens too; so does Revoke in
  Settings › MCP clients (the login's own clients, posted from the dashboard's origin), or the
  client's own `POST /oauth/revoke` (RFC 7009). A login keeps 20 clients at most: a 21st ends
  the oldest.
- What a client may then do is its login's, as on the dashboard: `/mcp`'s tools (#482, #483)
  check `ALLOWED_REPOS` and each repository's `users` on every call.

## Edge's and the orchestrator's data

**Edge's volume** (`edge-data`, its `/data`) holds its three secrets: whoever reads it can sign
deliveries as GitHub and sign in users, but not act as the App (its key is the github
service's). The files holding secrets are the owner's only (`0600`):

| File          | What                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.json`    | the App's names, its webhook secret and its OAuth client's (never its key)                                                                                                                                                         |
| `session.key` | signs dashboard sessions                                                                                                                                                                                                           |
| `store/`      | its store: the delivery ids taken, each login's session epoch, MCP clients' registrations and their tokens' hashes, the redeliveries' state and their poller's lease, the `deliveries` stream (what people wrote, without secrets) |

**The orchestrator's volume** (`data`) holds nothing that signs deliveries or sessions; whoever reads it reads the queue and what the runs did, and a running run's
agent token. The files holding one are the owner's only (`0600`):

| File                     | What                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `logs/<run>.live.json`   | a running run's state, with its agent token (gone once it's over)                                                 |
| `store/state.json`       | the store's keys: the queued comments, with their authors; its lease and fencing epoch; the deliveries it handled |
| `logs/<run>.queued.json` | a task's queued comments, kept while the store refused writes                                                     |
| `waits.json`             | comments waiting for other issues (`/after`), with their authors                                                  |

**The store** (`STORE_URL`: a folder by default, Redis #509) never holds a secret. Each
service's refuses a value or an event holding one it knows, a GitHub token or a private key
(`lib/store.mjs` `withoutSecrets()`): edge's refuses its webhook secret, OAuth client secret and
session key. What people wrote (a delivery's payload, a queued comment) is kept with them
redacted (`storable()`), rather than refused whole. The file backend (`lib/store-file.mjs`) may
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
[The Claude credential](#the-claude-credential)): the orchestrator redacts each line before it
sends it. Their summaries (`logs/<run>.json`, the orchestrator's) hold what the log's first line
does, the run's comments included, and its screenshots' folder. Both, and the screenshots (at
the broker, which removes them when the orchestrator asks), go after `LOG_RETENTION_DAYS` (90
by default).

### The runner's data

The runner's volume (`runner-data`, its `/data`) holds its store: the runs' logs (redacted as
above), their events, the newest orchestrator epoch it saw and its lease; nothing that signs or
opens anything. The `runs` volume holds each run's inbox (the comments it got, their authors'
text), the egress proxy's CA certificate and a run analysis's digest. Whoever reads them reads
what the dashboard shows of the runs.

## The dashboard's actions

The dashboard is read-only but for two kinds of POST: starting a repository's onboarding
(`/api/repos/<owner>/<repo>/onboard`) and the graph's work area
(`/api/repos/<owner>/<repo>/work`, `listener/work.mjs`), which starts an issue, queues it
after another (`/after #n`), lays out a parent issue and its sub-issues from their "blocked
by" links (`plan`: each issue of the tree passes the checks below, or nothing is posted; blockers
in another repository are left out), moves its wait or cancels it (`/after none`), or stops a
brainstorm (`/stop`, refused unless it is active or idle), or stops a task's run (`cancel`,
what a `/cancel` comment does: only the repository's half of the checks below applies, as a
run may go on on a closed issue; refused when nothing runs or is queued). The work area
starts runs, so it is checked as a comment that waited is (`tasks.resume()`), at each request:

- a signed-in dashboard session, and an `Origin` header naming this Deckhand (its
  `PUBLIC_URL`, or the host the browser asked edge for, which edge passes on in
  `x-deckhand-origin` and `x-deckhand-host`): a page elsewhere can't post for a
  signed-in user, on top of the session cookie's `SameSite=Lax`;
- the repository in `ALLOWED_REPOS` (when set: by name, or through its owner's `owner/*`)
  and the App installed on it;
- its `.deckhand.yaml` on the default branch without errors, and a mode it has;
- the user in both `ALLOWED_USERS` and the repository's own `users`;
- an open issue, not a pull request, with no run going or queued (a running issue doesn't
  move), and no wait that would loop back to it.

Each action is written on the issue as the App's comment ("Started from the dashboard by
@alice"), so the issue's history says who started what, as a trigger comment would. The
App's comments are ignored as triggers, so the orchestrator queues or holds the work itself
rather than through a webhook. The backlog (`GET /api/repos/<owner>/<repo>/issues`) lists a
repository's open issues to signed-in users in its `users` (all of them while its config has
errors), from GitHub at most once every 30 seconds per repository, or after an `issues`
delivery for it, one read at a time; the dashboard keeps the last one in memory only, not in
the browser's storage. The repository list's backlog counts (`GET /api/repos?backlog=1`, the
Overview) come from the same reads under the same `users` rule (a repository whose `users`
leaves the user out has none). While the list is asked for them, each configured repository
is read again in the background at most once every 5 minutes, which labels open questions as
a board's read does.

A failed run's Rerun (`POST /api/repos/<owner>/<repo>/rerun`) passes the same checks, for
the run's issue or pull request, and only for the task's latest run when it ended in `error`,
`interrupted` or `cancelled`: it queues the comments that run had already been allowed to act on, as the
signed-in user's, and posts the App's comment saying who asked.

A pull request's Review and Fix (`POST /api/repos/<owner>/<repo>/review { number, action }`,
which the dashboard offers once its review-and-fix loop is over) pass the same checks: same origin, the user in
`ALLOWED_USERS` and the repo's `users`, a config without errors, the pull request open and
nothing running or queued on it or its issue, one request at a time per pull request. They
need the repo's `review` block, and Fix its `review.fix`: the opt-in that lets findings become
a pushing run ([Review fix runs](#review-fix-runs)) stays the repository's. Each posts the App's
comment saying who asked before its run is queued. Review queues what `/mode review` would;
Fix reads the App's latest review back from GitHub and goes through the fix loop's own checks
(`startFix()`: Deckhand's own pull request linked to its issue, ready for review, no
needs-input label, the loop not going on, the `deny_fix` policies), one fix run per click,
counted in `reviews.json` before it is queued.

Its Dismiss (`POST /api/repos/<owner>/<repo>/dismiss { runId }`) passes the repository's half
of these checks (same origin, the user in `ALLOWED_USERS` and the repo's `users`, a config
without errors), not the issue's: a closed or busy item may be dismissed, since nothing runs.
It takes only the task's latest run, when it ended in `error`, `interrupted` or `cancelled`. It
is the orchestrator's own state (`dismissed.json`: the run, who dismissed it and when), which only
the dashboard reads; nothing is posted on GitHub. Its Undo (`{ runId, undo: true }`) is open to
any of the repo's users, whoever dismissed it, as the dismissal is.

The same file holds the runs whose questions were set aside (`questions: true`), and those
come from GitHub, not the dashboard: anyone who can take the needs-input label off an issue or
pull request (the repo's triage permission, not `ALLOWED_USERS`) sets aside the questions of
its task's last run, and a close or merge does too. It starts and posts nothing, but it does
change what the dashboard allows for that task, which goes by its `needs-input` state: with
`wait_for_answers`, a Start, Queue or plan from the dashboard is no longer refused with "answer
them first" (`work.mjs` `asking()`), and the run's questions can no longer be answered there,
from its form or by ticking its reply's boxes (`answer()`, `ticked()`). So a label removal by
someone outside `ALLOWED_USERS` can let one of the repo's users start that issue from the
dashboard without answering its run's questions; what starts is still checked as any start is.
This is on purpose: the label is how the maintainer says the questions no longer hold, and the
dashboard follows what it shows (`work.test.mjs`, "wait_for_answers and a run's questions set
aside").
Comment triggers aren't held back for a run's questions either way (`tasks.mjs`
`unanswered()`); an issue's own open questions still go by the label. The label put back asks
again, and so does the dismiss API's `undo` for that run (the dashboard shows no Undo for
these).

An inbox entry sent from the dashboard (`POST /api/repos/<owner>/<repo>/inbox`) passes the
repository's half of these checks (same origin, the user in `ALLOWED_USERS` and the repo's
`users`, a config without errors), and only for an inbox the repo's config names. Its text is
posted on the inbox issue as the App's comment, ending "From the dashboard by @alice", and its
run reads it as that user's entry, as it would read their own comment there.

A lane's name (`POST /api/repos/<owner>/<repo>/lane`) passes the repository's half too, for
keys of that repository's issues and pull requests only. It is the orchestrator's own state
(`lanes.json`), never posted on GitHub nor read by a run: one line of at most 60 characters,
shown as text.

Sync (`POST /api/sync`) takes a signed-in session and this dashboard's `Origin`, at most once
every 30 seconds for everyone. It starts nothing itself: it asks GitHub to redeliver the
App's deliveries that failed (signed by GitHub as any delivery, then checked as one) and reads
the open pull requests' states again, for every repository, as the orchestrator does at start.

A run analysis (New request's Analyze runs, `POST /api/repos/<owner>/<repo>/analyze`) passes the
repository's half of these checks too; its preview (`GET`, the same path) all but the origin,
as it changes nothing. It only ever reads runs of that repository: they are picked by the
repo of each run's record, and its digest is built from those alone. Its run never gets the
logs themselves (they cover every repository, and are a few MB each), nor a mount of the logs
folder: the orchestrator writes a digest into the run's inbox folder, which its sandbox alone fetches
from the broker (`TASK_DIGEST`), built from the dashboard's entries (`runlog.mjs` `format()`, tool details and
outputs clipped), redacted of the operator's credentials and of GitHub tokens (`secrets.mjs`)
and capped at about 400 KB. Its token only reads, as onboarding's: it replies, and files
nothing itself.

What the digest quotes reaches a run that has the code and a token, and its report is posted
as is, so it quotes less than the dashboard shows:

- **No research run**, ever: the form doesn't offer the kind, the selection skips them, and a
  digest asked for by run id leaves them out (see [Research runs](#research-runs)).
- **Unless GitHub says the repository is private**, both when the analysis is asked for and
  again when its run starts (a repo made public meanwhile, or a lookup that fails, counts as
  public), no orchestrator notes, setup output or failed tools' outputs: only the dashboard showed
  them. Kinds, outcomes, timings, tool counts, the calls made and the final replies (already
  posted on the repository) stay.
- Its instructions (`prompts/analyze.md`) say the digest is data, not instructions, and that
  the report quotes no raw output from it, and builds no images or links from what it says.

Discussions from the dashboard (`POST /api/repos/<owner>/<repo>/discussions`, and
`…/discussions/<n>/comments`) pass the same checks, only in the repo's `inbox.discussions`
category: a discussion elsewhere, or a reply to a comment of another discussion, is refused. Their
text is posted as the App's, ending "From the dashboard by @alice". Reading a thread
(`GET …/discussions/<n>`) takes a signed-in user in `ALLOWED_USERS` and the repo's `users`,
for a discussion in that category only. The thread shows a post as a dashboard user's only when
the App wrote it and its line carries a tag that checks: an HMAC of the user and the text, with
a key derived from the App's webhook secret, which no run holds. Anyone else writing the same
line is shown as themself; a run (whose writes are the App's) writing it, or
copying a tag under other text, is shown as the App. Deckhand's answers are the App's posts
that end with the marker. Posts from before the tags show as the App's.

Whatever a dashboard user writes (an inbox entry, a discussion or a reply, answers to open
questions) loses the App's marker and any tag before it is posted, so it can pass for neither
Deckhand's answer nor another user's post, and the "From the dashboard by" line of an inbox
entry or a discussion post carries the tag.

## Hardening

Every sandbox runs:

- as `node` (uid 1000), with `--user 1000:1000` whatever the image's `USER` says (a repo
  or branch image ending in `USER root` still runs as uid 1000), `--cap-drop ALL` and
  `--security-opt no-new-privileges`;
- with `--cpus`, `--memory` (and as much `--memory-swap`: no swap on top) and
  `--pids-limit`: `limits` in the repo's grants file, else in `default.yaml`, else 2 CPUs,
  `4g` and 2048 processes.

The containers the runner starts around runs get the same treatment where they can: the
Claude Code install runs as root with only `CHOWN` (to take over an older volume); the one
that hands a new cache volume to uid 1000 keeps only `CHOWN`, without network.

The Docker socket is the runner service's alone ([The runner service](#the-runner-service)).
Neither edge, the orchestrator, nor
any sandbox, nor a container engine gets it. Image builds only run for repositories granted
`dockerfile`.

**Optional: a socket proxy.** The runner only uses the docker CLI, so it can talk to a
socket proxy (for example `tecnativa/docker-socket-proxy`) through `DOCKER_HOST` instead of
the socket itself. It needs: `CONTAINERS`, `IMAGES`, `BUILD`, `VOLUMES`, `NETWORKS`, `POST`
and `DELETE` (`docker run`, `ps`, `logs`, `inspect`, `wait`, `rm`, `cp`, `build`, `image ls/rm`,
`volume create/inspect/ls/rm`, `network create/inspect/connect/disconnect/ls/rm`, and `info`
with a container engine).

### Output

A run's output can't stop the orchestrator, nor fill a data volume:

- A line of output is cut at 1 MB (`… (line cut)` at its end), and the rest of it dropped up
  to its newline. A line the orchestrator fails to handle (a full disk, say) is lost, not the
  orchestrator.
- A run's log holds at most `RUN_LOG_MAX_MB` (200 MB by default, and never unlimited) of the
  sandbox's output. Past it, nothing more of it is written: the sandbox is stopped and the
  run fails, with a note in its log and a reply saying why. The orchestrator's own lines (a few
  notes) are still written. A restarted orchestrator counts what the log already holds, and
  stops the sandbox again if it still runs.
- At start, a log without its summary (`logs/<run>.json`) is read whole up to 64 MB, else
  only its first line and its last 4 MB. One that can't be read is left out of the run list,
  and logged: no log keeps the orchestrator from starting.

The cap is per run: the logs together can take up to that much for each run kept, until
`LOG_RETENTION_DAYS`.

## Container engine

A run whose repository the operator's policies grant `docker` ([the grants](#the-grants), one
repository at a time), whose
`.deckhand.yaml` asks for `docker`, and for which the operator set `SANDBOX_ENGINE`, gets a
second container next to its sandbox: an engine serving Docker's API
([Setup](setup.md#container-engine)). The sandbox keeps everything above (uid 1000, no
capabilities, `no-new-privileges`, its limits); whatever an engine needs relaxed is relaxed
in the engine only:

- **Never `--privileged`, never the host's Docker socket.** What the agent builds and runs
  stays in the engine's own storage: a volume of the run's own, removed with the run, or the
  repository's cache volume when its config keeps one (`docker: { cache: true }`), which only
  that repository's runs mount, one at a time.
- **Sysbox** (`sysbox`): `dockerd` under the `sysbox-runc` runtime, with Docker's default
  capabilities. Root in the engine is an unprivileged range of user ids on the host (a user
  namespace), and Sysbox virtualises what `dockerd` needs (`/proc`, `/sys`, nested cgroups)
  without relaxing seccomp or AppArmor.
- **Podman** (`podman`): rootless Podman as the image's `podman` user, with Docker's default
  capabilities, seccomp and AppArmor unconfined, SELinux labels off, `/dev/fuse` and
  `/dev/net/tun`: what user namespaces, fuse-overlayfs and its network need. See
  [Not covered](#not-covered).
- **Its limits** are the repository's (`limits` in its grants, else the built-in ones), on top of
  the sandbox's: a run can use twice its limits, half in each container.
- **Its network** is the run's: internal, with the sandbox and the proxy. Its
  address counts as the sandbox's for the egress proxy, so its pulls, its builds' steps and
  its containers reach only the run's hosts, through the proxy (by address: its containers
  can't resolve names on the run's network). Its containers have no other route out.
- **Its API** (`tcp://engine:2375`) has no TLS and no authentication: only the run's own
  network reaches it, and whatever can reach it (the sandbox, the containers it started) is
  the run's own code anyway.
- **Who gets one**: a run the policies give the `docker` [capability](#capabilities):
  Deckhand's defaults give it to work runs and a repository's own modes (with its own allow
  rule), never to light runs (brainstorms, inbox entries, discussions…). A run with a comment
  from a fork's pull request never does, whatever its grant: a fork's code never runs in an
  engine.
- **Clean-up**: the engine and its run's volume carry the `deckhand.engine` label (not
  `deckhand.run`: an engine is never taken for a sandbox). They go with the run, and the
  orchestrator's check every minute removes those whose run is gone, after a restart too.

On Kubernetes ([kubernetes.md](kubernetes.md#container-engine-on-kubernetes)), Sysbox alone, and the
sandboxes' namespace stays Pod Security `restricted`:

- **A sidecar in the sandbox's pod**, under Sysbox's RuntimeClass, the pod in a user namespace
  of its own (`hostUsers: false`): `dockerd` runs as root there, an unprivileged user on the
  node, which `restricted` allows from Kubernetes 1.35. Every container's spec keeps the rest of
  it (no privilege gain, every capability dropped, `RuntimeDefault` seccomp), but Sysbox
  applies its own: root in the pod gets its capabilities inside the pod's user namespace, and
  every container of the pod, **the sandbox's included**, runs under Sysbox's syscall filter
  instead of the runtime's default profile (it allows `mount`, `unshare`, `setns`, `keyctl`…,
  which Sysbox traps or confines to the pod). What contains the sandbox there is the pod's user
  namespace, its user (uid 1000) and its having no capability, more than its syscall filter;
  `no-new-privileges` holds on `dockerd` and on all it starts (setuid programs fail in its
  containers). Podman, whose seccomp is unconfined, is refused.
- **No process namespace shared** between the pod's containers, as Sysbox advises: the sandbox
  sees none of the engine's processes, and its entrypoint reaps its own orphans.
- **Its storage** is an `emptyDir`, gone with the pod, at most `KUBERNETES_ENGINE_SIZE`: no
  cache kept between runs.
- **Its address is the sandbox's**: its API listens on the pod's loopback alone
  (`engine` is `127.0.0.1` in the pod), so nothing outside the pod reaches it: not even its
  node, which a NetworkPolicy always lets in. It goes out on the egress
  proxy's engines' port (3129), and so do the containers it runs (the sandbox's docker CLI
  config): the proxy asks the orchestrator with that port's flag, and the orchestrator answers
  as for an engine on Docker (the run's hosts, never decrypted, GitHub tunnelled, or sent on by
  the proxy for an absolute-form `https://` request (see
  [HTTPS and Deckhand's CA](#https-and-deckhands-ca)), without the run's identity), only for a run that has an engine; a run without one, a build or an install
  is refused there. What the sandbox could reach through that port is what it could already
  reach through its engine.

## Reviews

A repository turns reviews on with a `review` block in its `.deckhand.yaml` (default branch
only). It widens nothing, so it needs no grant: a review is a light run with a read-only token
(`contents`, `issues`, `pull_requests: read`), no branch to push, no setup and no engine.

- **The orchestrator posts the review**, with the App's token, through the github service (`POST /repos/{repo}/pulls/{n}/reviews`),
  from the run's final message. Without `review.fix`, a diff written to talk the agent into
  something can't make it write anything: the most it can do is change the review's text
  (with `fix`, see [Review fix runs](#review-fix-runs)). The review never
  approves (an App's approval may count toward branch protection): it requests changes on a
  critical, high or medium finding or a blocking comment, and comments otherwise (on medium ones too, in the review
  that decides an auto-merge with `review.max_allowed_severity: medium`). A review that requests
  changes, on GitHub or in its verdict, never auto-merges.
- **No sandbox reviews or approves**, a work run's included: their tokens only read pull
  requests ([Tokens](#tokens)), so none can approve its own pull request or clear the
  review's request for changes. Only the orchestrator posts reviews, and never an approval.
- **Who gets one by itself** (`review.on: ready`): pull requests on a branch of the
  repository, opened by the App or by a user of `ALLOWED_USERS` and the repo's `users`, when
  they turn ready. Never a fork's, never an outsider's: nobody outside the allowlist can make
  the operator pay for a run. Another bot's (Dependabot, GitHub Actions) only when the
  policies let it: Deckhand's default `policy/review.rego` refuses them (`deny_review`), and
  only a file of that name, the operator's or the repository's maintainers', replaces it. A
  bot that opens a pull request on a branch of the repository was given write access to it.
- **Only allowed users' comments**: the review reads its thread (the pull request's
  description, comments and reviews, and the issue it closes) from a file the orchestrator writes
  (`TASK_DIGEST`), with only what users of `ALLOWED_USERS` and the repo's `users`, and the App
  itself, wrote. What anyone else wrote, another bot included, is replaced with a line saying
  it was left out; an allowed user who wants it read quotes it in a comment of their own. It
  can't read the thread another way: the [GitHub gateway](#the-github-gateway) refuses a
  review's calls for comments, reviews and review comments, REST and GraphQL alike, and the
  web host's pages. What an outsider can still put in front of it is the pull request's own
  description and diff, which it reviews.
- **No loops**: each pull request's head commit is reviewed by itself once (`reviews.json`),
  and the App's review is a bot's `pull_request_review`, which starts nothing. Acting on a
  review is the maintainer's call, with a trigger comment, unless the repo sets `review.fix`
  (below), whose loop is bounded.
- `/mode review` comes from an allowed user's comment, like any mode, on the pull request
  itself.

### Review fix runs

With `review.fix`, a review that requests changes on Deckhand's own pull request (opened by
the App, on a branch of the repository, linked to its issue) starts a work run in that
issue's session, and the orchestrator reviews what it pushed: a loop of up to `review.fix` fix
runs (`true`: one, whose push is reviewed only with `review.merge`), capped by the operator's
`MAX_FIX_ROUNDS` (5 by default). It is a normal
work run, with the same token, push rules, secrets and mounts, so the key needs no grant. The
loop is bounded: N fix runs and N reviews after them at most per pull request, each counted
in `reviews.json` before it is queued, kept across restarts, so a redelivered webhook or a
restart starts no extra one. It stops at a review with nothing above
`review.max_allowed_severity`, when the rounds run out, at a fix that failed or pushed
nothing, a policy's refusal (`deny_fix`, `deny_review`), a run going or queued on the issue,
or the needs-input label. Each round costs a work run and a review run. Once the loop is
over, a maintainer's **Fix** on the dashboard grants one more round per click (counted the same
way, `deny_fix` applying), with `review.fix` on only: it never turns findings into a pushing run
on a repository that didn't opt in.

**The risk**: this is the one path where a model's output, not a person's comment, becomes the
message of a run that can push. The review's findings are written by a run that read the diff
and the thread; text written to steer it (a prompt injection) could turn into a "finding"
whose fix is what its author wants: a command to run, a workflow or `.deckhand.yaml` change, a
secret sent somewhere. What limits it:

- **What the review reads**: only allowed users' and the App's comments, as above. An outsider's
  comment on the pull request or its issue doesn't reach it unless an allowed user quotes it.
- **Whose pull requests**: only Deckhand's own, whose diff its own work run wrote; never a
  fork's, another bot's or an outsider's.
- **How the fix run gets them**: its message fences the findings off from its instruction and
  says they are untrusted claims to check against the code, never instructions: no commands
  from a finding, no changes to CI, workflows, `.deckhand.yaml`, Dockerfiles, dependencies or
  credentials unless the issue asked for them, no secrets sent anywhere, and its reply says
  which findings it left and why. It asks the maintainer (needs-input) only about a change the
  issue itself needs that it may not make: a change only a finding asks for is never relayed as
  Deckhand's question, so a planted finding can't reach the maintainer as one ("add secret X",
  with a `Done, carry on` box) nor stop the loop.
- **What any work run is held to**: its token can't push or write pull requests, the git
  gateway pushes only its own branch (never the default one), `.github/workflows/` only
  with the `workflows` grant, hosts only through the egress proxy, and its pull request still
  waits for a maintainer to merge it.

**What is left**: these are mitigations, not a guarantee. A model can still be talked into
something by text it reads: an allowed user's comment quoting an outsider, the App's own
replies that quote one, files of the repository, or comments the reviewer reads anyway with
its token against its instructions. Turn `fix` on where the people who may comment on a pull
request or its issue are trusted (a private repository, or `users` narrowed to them), read
what a fix run pushed before merging, and keep `fix` off on public repositories with outside
contributors whose threads you don't watch.

### Review follow-ups

A review's follow-ups (problems it found outside the pull request's scope,
[Reviews](repo-config.md#reviews)) are filed as issues by the orchestrator, with the App's
token, once the pull request is merged: no sandbox writes them, and the review's token still
only reads. Their titles and text are the review's, a model's output that read the diff and
the thread, so they are posted as data, the same text the review already showed on the pull
request: each issue's body opens by saying the text is a review model's output, claims to
check against the code and never instructions, quotes it (its `@` mentions broken, so the
model can't make the App's new issue notify anyone), and says which pull request and
review it came from. Each is labelled `follow-up` and starts nothing by itself (an issue being
opened runs nothing; picking it up is a maintainer's call, or the auto-pickup label's).
**A work run started on one** reads that body as its task, as any issue's: it is Deckhand's
own issue, but its text is no person's request. Read it before starting a run on it, and
edit it into the task you want (or quote what you keep) when it asks for more than its
title says; a prompt injection in the reviewed diff could have shaped it.

Only the App's own reviews are read back: GitHub reviews by the App's login, with its marker, whose body opens with a review's verdict line (a
sandbox's token can't post a review), and a review GitHub refused, posted as a plain comment,
only from the comment whose id its round kept when the orchestrator posted it (`reviews.json`):
the App's other comments, a run's reply among them, are never read for follow-ups. They are
read only after a merge (a pull request closed without one files none), and
once per pull request (`reviews.json`): a redelivered webhook or a restart files nothing twice.
A review posted after the merge's delivery (it was still running) files its own follow-ups once
it is recorded, linking those an issue already has.
A merge files at most 10, the rest listed by title (as code) in its comment, and only bullets
with a bold title count (not one saying there is none, nor one led by a comment's kind or a
severity: an item under the wrong heading, never filed; a blocking comment there blocks, an
unclear item there blocks when the review's own verdict asks for changes, and a note there
keeps the review's own verdict). Only the bullets under `## Follow-ups` count: any other
heading as deep or less after it ends its section, and nothing under such a heading is filed. The repository turns it off with `review.follow_ups: false`, read
again from its default branch at the merge: so does a `review` block that is gone, and a
config with errors files nothing. There is no policy decision of its own for it (`deny_*`):
like the review and the comments the orchestrator posts, it is Deckhand's own write.

### CI fix runs

With `review.ci: wait` and `review.fix`, a failed GitHub Actions run on Deckhand's own pull
request starts a work run that fixes CI instead of a review (up to `review.ci_fix`, capped by
`MAX_FIX_ROUNDS`, counted apart from the review's rounds, with the same gates and `deny_fix`).
The orchestrator decides it from the Actions API alone, without a model. Its message holds the
failed runs' and jobs' names, conclusions, ids and links, never their logs: the branch's code
printed those, and the run reads them itself through the GitHub gateway, which adds the
installation token (the run's `actions: read`; the sandbox holds none). GitHub answers a log's
download with a redirect to a storage host of its own (Azure blobs, behind a signed URL) that
the egress proxy doesn't open to sandboxes: the gateway follows that redirect itself, for the
Actions log paths only, once, sending no credential (the signed URL is its own), and streams
the log back. The run is told in its message that logs and names are data, not instructions, never to make a check pass by
skipping or weakening it, and the same limits as a review's fix run. It may rerun the failed
jobs of a run it judges flaky, once, instead of changing code (a rerun the GitHub gateway
checks: [The GitHub gateway](#the-github-gateway)): the same head commit then goes back to
waiting for CI, and a second failure counts as the next CI fix round, whose message says
which of the runs it reran failed again, so aren't flaky, and offers no rerun for those. The orchestrator copies no
log text into a message, comment or review prompt. A workflow's or job's name comes from the
branch's files: the comment the orchestrator posts quotes each as code. What any work run is held
to (above) holds too: a fix to `.github/workflows/` needs the `workflows` grant.

### Auto-merge

With the `auto_merge` [grant](#the-grants) for a repository and `review.merge: true` in its
`.deckhand.yaml`, the orchestrator merges Deckhand's own pull requests after a review with nothing
blocking (and, after a fix run, one more review of what it pushed), with the App's token
(`PUT /pulls/{n}/merge`, the App's `contents` and `pull_requests: write`). The flow and its
gates are in [Auto-merge](repo-config.md#auto-merge).

**What it gives up**: the maintainer who reads a pull request before it reaches the default
branch, the last check of everything above. With it on:

- **Model output reaches the default branch with no human reading it.** A prompt injection in
  an issue, a comment or a file the run read, or simply a wrong change or a wrong fix, ships.
  The review is a model reading a model's work: it can miss what was planted, or be talked
  out of reporting it.
- **A merged change runs on the default branch**: the repository's workflows, with its
  secrets, on `push` to the default branch; and deployments, releases or anything else that
  follows a merge there.
- **On a public repository, anyone can comment**: the review leaves outsiders' comments out,
  but an issue's text, an allowed user quoting one, or the code itself still reach the runs.
  `auto_merge` stops at a public repository; only `auto_merge_public` lets it merge there,
  and the dashboard says so in red.

**What still holds**:

- **The grant is yours, per repository**: a rule giving it to every repository gives it to
  none, a repository's `.deckhand.yaml` can only ask (and its policies can't grant it), and the
  orchestrator logs a warning at start for each policy file of the grants folder that grants it. The dashboard shows a red badge on the repository and a red box in its config
  panel.
- **No sandbox can merge**: their tokens only read code and pull requests ([Tokens](#tokens)),
  and the git gateway never pushes the default branch. Only the orchestrator merges, after its
  own checks.
- **Nothing that widens Deckhand is merged by itself**: a pull request that changes
  `.deckhand.yaml`, `.deckhand/`, `.github/`, a `CODEOWNERS` or a file the config names (the
  instructions, the Dockerfile) waits for a human, so
  a run can't grant itself more through a merge.
- **What was reviewed is what is merged**: the merge names the reviewed commit, so a push
  after the review fails it; the repository's visibility, `mergeable_state` and its GitHub
  Actions runs are read from GitHub at the merge, not taken from a webhook. A merge waiting
  for its checks (`review.merge_wait`) is decided again when a `workflow_run` delivery says
  one completed, but that delivery only says when to ask: the gates are all read again, and a
  push meanwhile still refuses it.
- **No loop**: `review.fix`'s fix runs and one review after each at most (bounded by the
  operator's `MAX_FIX_ROUNDS`), one merge decision per pull request (`reviews.json`). Every refusal is a comment on the pull request, every merge too,
  and the dashboard marks each auto-merged task "Merged by Deckhand", so they can be found and
  read afterwards.

Use it only on private repositories where everyone who can open or comment on an issue is
trusted, and whose default branch deploys nothing you couldn't roll back.

## Policies

[Policies](repo-config.md#policies) are Rego rules that allow and refuse a decision: `run`, a
run a person asks for (a comment, the dashboard, an inbox entry, a discussion), before it is
queued; `merge`, the last gate of an auto-merge; `review`, a review that starts by itself; `fix`, a review's fix
run, a CI fix run or a conflict's rebase run; `link_branch`, the branch the orchestrator links to a
work run's issue ([The default branch](#the-default-branch)); `request_review`, the reviewers
the orchestrator requests on Deckhand's ready pull request (`review.request`, allowed users only,
never a team, and never at a run's request); `github`, a run's write to GitHub (REST, or a
GraphQL mutation's field), and its reads of CI's checks and of projects, after the gateway's
built-in checks: [The GitHub gateway](#the-github-gateway); `push`, each branch a run's push
updates, after the git gateway's: [The default branch](#the-default-branch); `grant`, each of a
repository's [grants](#the-grants), your layer's alone. Each has two rules: `allow_<decision>` and
`deny_<decision>`; what a run gets as it starts has two of its own ([Capabilities](#capabilities)). **A decision is allowed when an allow rule matches and no deny rule does**:
a deny always wins, and with no allow rule matching it is refused, so an empty or replaced file
refuses rather than opens, and a new decision starts closed.

They come in **two layers**, evaluated together by the policy service (#501, below) in one
query of one `opa` (as before allow rules: a built-in mode pays nothing extra), each in a
namespace of its own:

- **The operator's**: Deckhand ships its own in the policy service's image
  ([the default policies](repo-config.md#the-default-policies): `allow.rego`, which allows the
  orchestrator's own decisions (`merge`, `review`, `fix`, `link_branch`, `request_review`),
  `run.rego`, which allows each mode where it makes sense (brainstorms and onboarding on issues
  only), a `mode-<mode>.rego` per mode for what its runs get, write and push
  (`allow_capabilities`, `allow_github`, `allow_push`), a `gh-<feature>.rego` for a feature
  that isn't a mode's (`gh-checks.rego`, `gh-linked-branch.rego`, `gh-reviewers.rego`), and
  `review.rego`), which hold without any setup. Yours are the `*.rego` files of `policy/` in the grants folder, which the policy service
  mounts read-only and reads again at each decision: one with the same name as Deckhand's
  replaces it, others add to them. **Their allow rules are the ceiling** of every repository: a
  caller sends a repository's files, never yours. The orchestrator reads your folder too and sends,
  with each decision, a digest of the operator's layer it expects: the service refuses a decision
  whose digest isn't its own layer's, and the orchestrator refuses every decision while the service
  reads other files than its own (a grants folder it doesn't mount, or mounts elsewhere, which it
  would read as none), so your rules are never dropped unseen.
- **A repository's**, in `.deckhand/policy/` on its default branch. Its deny rules apply to
  every run of the repository. Its allow rules count only for its own `modes:`, whose runs need
  your allow **and** its own: a repository mode does nothing until its repository allows it,
  within what you allow. Its allow rule for a built-in mode's run is ignored (for `merge`,
  `review` and `fix`, a config check error). Its `allow_grant` and `deny_grant` are ignored, and a
  config check error: only yours decide its grants. A file of its with the name of one of yours, or of
  Deckhand's, replaces nothing.

- **A repository can only narrow what you allow, except for its own modes within it**: its
  policies run after every built-in gate, and their packages are moved under
  `deckhand_repository` before `opa` reads them (a module's rules are all in its package, the
  first statement of its file, after comments; a file whose package isn't there, or with a
  template string, whose expressions aren't read, is refused),
  so they can't define or replace a rule of yours or of your libraries (a helper or a package
  of the same name is its own). Their `data.` references are moved along, so their own
  libraries resolve; one written otherwise only reads yours (never another repository's: an
  `opa` holds one repository's files at most). A compile error in either layer
  refuses the decision, as any policy error. The grants ([`allow_grant`](#the-grants): your layer's alone, a
  repository's rules for them ignored) and the built-in gates stay what they are, so any repository may have policies, with
  no grant: they never drop one of your refusals or a gate's, nor widen what your allow rules
  give (a repository's own mode gets at most what Deckhand's defaults give work runs). If a rule must hold for every repository whatever it
  says, it belongs in your policies, a grant or a built-in gate. One default stands where a
  gate was: `review.rego` skips other bots' pull requests, which the review's allowlist
  (people only) used to stop. Replacing it in your grants folder is how you have those
  reviewed: a `review.rego` that does without a word on `author_type` gets a warning from the
  config check.
- **A pull request can't change them for itself**: they are read from the default branch, and
  `.deckhand/` is among the files Deckhand trusts, so a pull request that changes a policy is
  never merged by itself.
- **They run in the policy service, isolated** (`policy-service/`, #501): a service of its own,
  which holds no secret, keeps no state and has no network but its callers' (with Docker
  Compose, internal networks it shares with the orchestrator alone, the github service alone and the
  runner alone: no way out), running as a
  user, on a read-only filesystem, without capabilities. The orchestrator starts no `opa`. The
  pinned `opa` binary of its image (version and sha256 in `policy-service/Dockerfile`) runs as
  **long-lived servers**, each with one **policy set** loaded at its start (your layer, with or
  without one repository's), listening on a Unix socket in its own temp folder (no port), with
  an empty environment; a few are kept (8, the least recently used idle one stopped first), so
  a decision doesn't start a process. `opa run` takes no capabilities file, so **a set is
  compiled first with `opa check`** and a capabilities file without `opa.runtime` (the
  environment), `http.send`, `net.*` (the network, DNS included), `json.match_schema` and
  `json.verify_schema` (a schema's `$ref` reads a local `file://` path, `allow_net` or not) and
  `trace`, and no host allowed (`allow_net: []`), and **only a set that passes is served**: a
  policy that calls one is refused at load, its decisions with it. A decision's query has
  **2 seconds**: past them it is cut, which cancels its evaluation in `opa`, and the decision is
  refused. A policy decides from its input only: it can't read the service's files, or reach
  anything. The capabilities are the pinned binary's own minus these, so a new `opa` version
  is checked for builtins that read files or the network before it is pinned
  (`test/policies.test.mjs` tries the known ones with the real binary, through the service).
- **Each call to the service is authenticated**: a [service token](#service-tokens) the
  broker signed, checked
  offline with the broker's public key, which the broker publishes in a volume the service
  mounts read-only (`SERVICE_KEYS_DIR`); its table lets the orchestrator, the github service
  and the broker ask it, nobody else. It answers `/health` and `/ready` without one, and they
  say nothing.
- **Their errors too**: what a failure says (opa's error, GitHub's) is cut and redacted like a
  message below: an error may quote what a policy read.
- **What they say is shown, not trusted**: each message is put on one line, cut to 200
  characters, redacted like the runs' output (the operator's secrets, GitHub token shapes),
  quoted as code (no mention, no formatting), and five at most are posted.
- **Fail closed**: a decision no allow rule matches is refused, with a reason saying which
  layer's is missing. A policy that doesn't compile, takes too long, or gives an allow rule
  anything but `true` or `false`, or a deny rule anything but a set of strings, refuses the
  decision with a `policy error: …` reason, whatever the other layer says; so does a policy
  folder that can't be read (yours or GitHub's). For `run`, nothing starts (a reply quotes the
  messages and, for a policy error, says to post the comment again; from the dashboard, the
  action is refused with them), and a run's input that GitHub can't give (the issue, pull
  request or discussion it is on) refuses it too, so a broken policy or `opa` stops every run
  people start in that repository (every repository, for yours): the orchestrator's own runs
  (reviews, fix runs) aren't asked. With Deckhand's files alone and no repository file, the
  orchestrator decides as `run.rego` would, from the comment alone: no `opa`, no read of its issue.
  It only lists the repository's policy folder, as every decision does, and when GitHub can't
  list it, it keeps the last listing up to an hour old (a push forgets it, and the log says when
  it is used): an orchestrator that hasn't listed it in that hour, since its start or since a push,
  refuses then, as every other decision does at once. For `merge`, the pull request then waits for
  a human, as with any refusal; for `review`, the review is skipped (the log says why); for
  `fix`, no fix run starts and a comment says why; for `link_branch`, no branch is linked (the
  sandbox creates it, unlinked); for `request_review`, nobody is asked to review (the log says
  why); for `github`, the run's write is refused, so a broken policy stops every run's writes
  in that repository; for `push`, the whole push is refused. Every run's GitHub write and push
  asks the policy service (no allow rule, no write: Deckhand's `mode-<mode>.rego` files hold
  them), so a policy service that can't be reached stops the runs' writes and pushes in every
  repository. The orchestrator waits up to 30 seconds for one that refuses
  its connection or is draining (an update, a restart), then refuses; so does an `opa` that
  doesn't start (its temp folder unwritable, say). A refusal only
  ever costs a run, a write or a merge, never starts one. Your folder's compile errors are logged at start; a repository's
  appear in its onboarding pull request's config check and its config panel on the dashboard.
- **A dry run decides nothing**: `/mode policy` on a pull request, only from an allowed user
  (like any comment that reaches Deckhand), evaluates the rules and replies with each
  decision's result, what each layer's allow and deny rules said, and the input. Nothing is reviewed, fixed or merged; the task's page keeps who asked, when,
  the denial count and the reply's link, not the input. The input it posts is what GitHub
  already shows that user about the pull request. Your policies' file names and compile
  errors (redacted) appear in the reply and the config panel, not their text.
- **A decision's input is kept redacted**: the newest 3 decisions of a task keep the input
  their rules saw in `decisions.json`, each string redacted like the messages, the whole cut to
  8 KB, for the task's page on the dashboard.

## Capabilities

What a run's sandbox gets is decided once, as it starts, by the policies
([Per-repo config](repo-config.md#capabilities)): `allow_capabilities` gives names,
`deny_capabilities` refuses them with a reason, in the two layers above (a deny always wins; a
repository's allow rules count only for its own `modes:`, which need yours too). The outcome
goes in the run's log, in its saved state and in its tokens' `caps` claim; the dashboard's
Capabilities tab shows each mode's, with the file that decided each one.

**The minimum**, which every run gets whatever the policies say: its sandbox (no capability, no
privilege gain, as any container), the agent's API through the models service, Deckhand's
endpoints for its own run (its token, progress, files, inbox) and its prompt with the text that
triggered it. Nothing of the repository's: no clone, branch, image, setup, caches, mounts,
engine, screenshots or GitHub token (a run without `pull` gets none, whatever its mode), volumes
of its own (`<issue>-bare-…`, a light run's `<issue>-light-bare-…`: no earlier run's clone or
transcript), and only the hosts every run
needs.

| Capability         | Gives                                                                  | Needs                | Asked by (`.deckhand.yaml`) | [Grant](#the-grants)   | Enforced by                                                                            |
| ------------------ | ---------------------------------------------------------------------- | -------------------- | --------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `pull`             | a clone of the repository, its granted hosts and mounts, screenshots   |                      |                             |                        | the orchestrator at start; GitHub (`contents: read`); the gateway (nothing without it) |
| `push`             | its branches (the token's `branches`), its issue's branch and draft PR | `pull`               |                             |                        | the git gateway                                                                        |
| `setup`            | the `setup` command, the repository's caches                           | `pull`               | `setup` or `caches`         |                        | the orchestrator at start                                                              |
| `image:repo`       | the image built from its `dockerfile`                                  | `pull`               | `dockerfile`                | `dockerfile`           | the orchestrator at start                                                              |
| `image:branch`     | on a pull request, the image of its branch's Dockerfile                | `push`, `image:repo` | `dockerfile`                | `branch_docker_images` | the orchestrator at start (never a fork's)                                             |
| `docker`           | a [container engine](#container-engine)                                | `pull`               | `docker`                    | `docker`               | the orchestrator at start (never for a fork's pull request)                            |
| `internet`         | any public host (as [research runs](#research-runs))                   |                      |                             | `research`             | the egress proxy                                                                       |
| `read:issues`      | every issue, lists and search included (without it, its own only)      | `pull`               |                             |                        | GitHub (`issues: read`); the gateway (its own issue only without it)                   |
| `read:pulls`       | every pull request, lists and search included                          | `pull`               |                             |                        | GitHub (`pull_requests: read`)                                                         |
| `read:discussions` | its discussions                                                        | `pull`               |                             |                        | GitHub (`discussions: read`)                                                           |
| `read:actions`     | its GitHub Actions runs and logs, check runs and commit statuses       | `pull`               |                             |                        | GitHub (`actions`, `checks`, `statuses: read`)                                         |

**Greedy**: a capability is used when the policies allow it, when a key of `.deckhand.yaml`
asks for it if it has one, and when its grant gives it if one gates it. Allowed and asked for
but not granted, it stops the run, as before capabilities (but `image:branch`: the run takes the
repository's image). The grants keep gating what they gated.

**Checked in code, whatever a policy says**, so that replacing a default file can't drop them;
a run that fails them doesn't start, and its reply says why:

- **Dependencies**: `setup`, `image:repo`, `push`, `docker` and the `read:*` need `pull`;
  `image:branch` needs `push` and `image:repo` (a policy denying the repository's image denies
  a branch's too). The reads are the token's permissions ([Tokens](#the-github-gateway)), and
  need it: a run without `pull` gets nothing from GitHub at all. A deny narrows: what needs a capability
  denied, not asked for or not granted isn't used either, with a warning (deny `push` to forks'
  runs, and they keep their code and reads, without `image:branch`). A capability whose need no
  allow rule gives refuses the run: the allow rules contradict themselves.
- **Every mode by the policies**: no mode trait drops a capability. The policies decide `push`
  for every mode: a light run (a mode with volumes of its own: brainstorms, inbox entries…)
  they give `push` gets it, its issue's branch included, in volumes of its own that stash
  (`-light-push`), never a work run's.
- **Modes that need the code**: a review (its verdict decides fixes and merges) and a discussion
  (read with its token) don't start without `pull`; a research run doesn't start with it: its
  input is the issue's thread, with nothing of the repository's.
- **What later runs trust**: a run that isn't a fork's and gets `push`, `setup` (caches) or
  `docker` (an engine), whatever its mode, is refused a fork's code at the gateways
  (`github-forks.mjs restricted()`), as work runs always were, and clones whole (its blobs
  can't be fetched one by one). A light run without `push` that is checked so has volumes
  apart from the issue's other light runs (`-light-trusted`), which may fetch a fork's code. A run that doesn't
  stash (no `push`: its reset throws away what is uncommitted) never shares a clone with one that
  does: a work run whose `push` is denied, or a repository's mode given only `pull` and the
  reads, gets `-readonly` (`-readonly-trusted` when the gateways check it: with `setup` or
  `docker`; reads only, it is not checked). Light runs
  and the work runs never share a volume (`-light-bare` and `-bare` without `pull`), so a comment
  without a trigger line, which goes on with work's session only, never goes on with a light
  run's: it looks in every volume a work run may have had. A run that finds, once its
  capabilities are decided, that its volume isn't its mode's starts or continues by what that
  volume holds. A fork's run may
  read it, `push` or not, and gets no caches or engine, and a clone of its own
  (`-fork-workspace`, a light run's too): the issue's other runs never start where a fork's
  code was fetched.
- **A risky combination**: `pull` of a repository GitHub doesn't say is public, with
  `internet`: its private code, untrusted content from any page and a way out, in one run.
  Refused unless an allow rule of **yours** gives `pull+internet` (a repository's can't), and
  said as a warning on its config page even then.
- **The open internet, whatever the mode**: a run with `internet` gets no host mount (what you
  mount may be private, whatever the repository is; its log says what was left out), no caches
  and no engine cache (later runs, other issues' work runs included, run what is there: what a
  page had it write would run with their token, as for a fork's run), session volumes of its own
  (`-open`: whatever a page gets it to write in its clone or the agent's home, hooks or settings,
  never runs in a run without the open internet, nor does its transcript reach one), and is
  never in an analysis's digest, as research runs aren't: what a page made it say would reach a
  run that has the code and a token. Its record keeps its capabilities for that.

**Fail closed**: policies that don't compile, time out, or give `allow_capabilities` anything
but a set of strings or `deny_capabilities` anything but a set of `{"capability", "reason"}`
objects refuse the run with a `policy error: …` reply. Each file's two rules are evaluated
under a name of their own, and their union under theirs, as the policy service loads a set,
so that the dashboard can say which file decided (`lib/policy-files.mjs byFile()`): a rule that
reads `allow_capabilities` still sees the whole set. The whole rules decide, so a rule that isn't renamed (indented, or in a file whose
`package` line has a comment) still counts, shown as from no file. A name the catalogue doesn't
have is a warning, never a capability (a misspelled deny denies nothing): on the Capabilities
tab and in a run's log, and for a repository's rules in its config check and Config tab too; so
is a risky combination's name anywhere but your allow rules.

Deckhand's defaults (`policy/mode-<mode>.rego`) give each built-in mode its capabilities: the
repository's config page, Capabilities tab, shows for each mode what a run gets, the file that
decided each capability and what stops it. With them, only work runs (a maintainer's, fix and
conflict runs) get `push`, `setup` or an engine, and research `internet` alone. `mode-work.rego`
also gives the repository's own modes work's, as your ceiling: they get what their repository's
policies allow within it. Until those allow it something, its runs are refused with a reply
naming the rule to add: started, they would answer without the code their mode expects. What
a run writes to GitHub and where it pushes are the same files' (`allow_github`, `allow_push`:
[The GitHub gateway](#the-github-gateway)), and what its token reads follows its capabilities.
A mode keeps only where its runs' volumes are (its own, or the issue's) and whose agent and model
they default to, never what they may do.

## Research runs

A run in the research mode (`/mode research`, [Per-repo config](repo-config.md#research))
reaches the open internet, which no other run does: the only other way is `hosts: ["*"]` in
a repository's grants file, which opens it for every run of that repository, next to its
code and a token. A research run is one prompt-injected page away from sending whatever it
holds to any host, so it holds almost nothing:

| What                           | A research run                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Hosts                          | any public one (`*`); private addresses only for the mandatory hosts, not the grant's       |
| The repository's code          | none: no clone, `/workspace` starts empty                                                   |
| GitHub                         | public pages and API, anonymously; the GitHub and git gateways refuse it                    |
| Other runs' secrets            | useless: a secret only works from its own run's sandbox ([Tokens](#tokens))                 |
| Input                          | the issue's title, description and last 50 comments, written by the orchestrator (redacted) |
| Output                         | its final message, posted by the orchestrator as the reply; no screenshots folder           |
| Run analyses                   | never in one: what a page made it say would reach a run with the code and a token           |
| Image, setup, caches, mounts   | the base image only; no `setup`, `caches`, host mounts or project `instructions`            |
| Container engine, egress cache | none: no engine, no cached hosts; Deckhand's CA only for the Antigravity CLI on a plan      |
| Volumes                        | `<name>-research-workspace` and its session volume: no other run mounts them                |

- **The grant**: `research` ([the grants](#the-grants)), for one repository or every one; off by
  default. Without it, `/mode research` gets a reply naming it and
  no sandbox starts; it is checked again when the run starts.
- **Private addresses**: `*` never reaches one, nor an address on one of the egress proxy's
  networks, whatever its range (see [Network](#network)), so the orchestrator's ports,
  other runs' sandboxes and engines, and your LAN stay out of reach. Unlike other runs, a research
  run doesn't get the private addresses of the hosts you grant its repository either: an
  internal host next to the open internet would be a way out for what it serves.
- **Its volumes are its own**: whatever a page gets it to write there (hooks, settings) never
  runs in a run that has a token or the code.
- **The agent's credential** works as for any run: the run's agent token reaches the models
  service only, through the proxy, from the run's network, and dies with the run.
- **Search** (Claude Code's `WebSearch`, Codex's `web_search`) runs on the provider's side,
  in the API call through the models service, in every run: it returns results and snippets, not
  pages. Reading the pages, docs and PDFs themselves takes a research run.

## Network

```
sandbox ──(its run's network, internal: no route out)──▶ egress proxy ──▶ allowed hosts
                                                              └──▶ the broker, github and models services
```

- Each run has a **network of its own**, named after the run and labelled with the
  deployment's `NAME_PREFIX`: the runner creates it before the sandbox and removes it with
  the sandbox. Only two containers are on it (three with a
  [container engine](#container-engine)): the sandbox and the egress proxy, which the runner
  joins to it under the name sandboxes call it by (the host of `EGRESS_PROXY`). Sandboxes
  can't reach each other, nor what
  another run's setup started (a dev server, a database).
- That network is **internal**: Docker gives it no route out. The runner creates it with
  `--internal`, checks it (`docker network inspect`) and refuses to start the run otherwise.
  Its subnet comes from Docker's address pools, or from `SANDBOX_SUBNETS` when set (a block
  no other network on the host uses, [Setup](setup.md#settings)): either way the network is
  internal, so the range changes addresses, not what a sandbox can reach. It must lie inside
  `10/8`, `172.16/12`, `192.168/16` or `100.64/10`: Deckhand refuses to start with
  another.
- The runner finds the proxy's container by its `deckhand.role=egress` label, in its own
  compose project (`EGRESS_CONTAINER` to name it instead), and joins no other container to a
  run's network. A new runner joins it again to the running sandboxes' networks when it
  starts, and checks every minute (`docker compose up -d` recreates it without the networks it
  was joined to); networks of this deployment whose run is gone are removed then.
- The **egress proxy** (`proxy/proxy.mjs`, the `egress` service) is on every run's network
  and the outside one. Being on all of them, it is the only path between two runs: it
  connects to the hosts a run may reach only, and to a private address only for a host you
  list by name (below). It handles HTTP `CONNECT` (HTTPS, and anything tunnelled) and plain HTTP
  requests, `https://` ones too (see [HTTPS and Deckhand's CA](#https-and-deckhands-ca)). For
  each one, it asks the orchestrator's egress policy whether the sandbox at that source
  address may reach that host; the orchestrator matches the address to the running sandbox (the
  runner's `docker inspect`) and answers from that run's list. Only the proxy may ask: the
  orchestrator compares
  the caller with the proxy's addresses on all of its networks (`docker inspect`). An unknown address, an unknown host, or an
  orchestrator that doesn't answer: refused, with a `403` saying why.
- The proxy resolves names itself and connects to the address it checked. Loopback,
  link-local (cloud metadata, `169.254.169.254`), `0/8`, multicast and reserved (`224/4` and
  up), IPv6 site-local (`fec0::/10`) and anything that isn't an IP address are always
  refused, and so is `198.18/15` (benchmarking); private ones (`10/8`, `172.16/12`,
  `192.168/16`, `100.64/10`, `fc00::/7`, NAT64's local-use `64:ff9b:1::/48`) only when the
  host is one you allow by name or `*.domain` in the grants folder, never through `*` alone. The same goes for any address in
  a subnet of the networks the proxy is on (read from its interfaces at each connection, so a
  run's network counts as soon as it is joined): other runs' sandboxes and engines, the
  orchestrator, whatever range Docker gave those networks, a public one or a global IPv6 prefix
  included. IPv6 addresses are compared as bytes, and those standing for an
  IPv4 one (`::ffff:0:0/96`, `::ffff:0:0:0/96`, `::/96`, NAT64's `64:ff9b::/96`, 6to4's
  `2002::/16`) are checked as that IPv4 address, so `[::ffff:a9fe:a9fe]` is the metadata
  service too.
- The proxy keeps answers from the hosts you list in `cached_hosts`, and decrypts their
  HTTPS to do so (see [The egress cache](#the-egress-cache)). It also decrypts GitHub's hosts
  and those that carry the Antigravity CLI's token (for its runs only), and hands their
  requests to the github service and the models service, naming the sandbox they came from (see
  [The GitHub gateway](#the-github-gateway) and
  [The Antigravity CLI's login](#the-antigravity-clis-login)). Every other `CONNECT` stays a
  tunnel the proxy can't read.
- The orchestrator stops answering for a run as soon as it sees its sandbox exit, before posting
  its reply, and finds a connection's run by the ID of the network its address is on now,
  never by an address it kept: Docker may give the address to another sandbox, which must not
  get the finished run's hosts.
- The proxy forwards plain HTTP to the services' names sandboxes call (`http://broker:8081`,
  `http://github:8080`, `http://models:8080`: `lib/services.mjs` `SANDBOX_URLS`, the same in
  every release) to its own URL for each (`BROKER_SERVICE_URL`, `GITHUB_SERVICE_URL`,
  `MODELS_SERVICE_URL`), and only on the paths that service takes from sandboxes: the run's
  token and files (`/run/…`) to the broker, pushes (`/git/…`) to the github service, the agents'
  APIs (`/anthropic/`, `/openai/`, `/google/`) to the models service; anything else there is
  `404`. Only once the policy, asked about the name (`forward=1`), allows it: for a running
  sandbox or its engine, never a build or an install's own pod, nor anyone else, and never as a
  tunnel. It names the network (or pod) the policy gave for the sandbox, as for a relayed call.
  The path and query (its URL parsed first: `..`, `%2e`) are set on the service's own URL, never
  parsed as a URL again, so a path such as `//host/x` stays a path on the service and never
  names another host.
- Sandboxes get `HTTP_PROXY`, `HTTPS_PROXY` (both cases), `NO_PROXY` (`localhost`, and the
  run's container engine) and `NODE_USE_ENV_PROXY=1`: without it, Node's `fetch` ignores the proxy (and
  fails, as nothing else goes out). The Playwright browser gets the proxy as flags. A tool
  that ignores proxy settings fails closed: it has no route out.

### The egress cache

Runs download the same packages again and again: `npm ci` from the npm registry,
`apt-get` from a Debian mirror, a toolchain from its release server. For the hosts you list
in `cached_hosts` (in `grants/default.yaml` and `grants/<owner>/<repo>.yaml`, added up like
`hosts`, with the same patterns), the egress proxy keeps the answers on disk, in the
`egress-cache` volume, and serves them to every run: plain HTTP, and HTTPS, which it
decrypts ([below](#https-and-deckhands-ca)). A repository's `.deckhand.yaml`
can't list them (one there is ignored, with a warning): the cache is shared by every run, so
only you say what goes in it. A host in `cached_hosts` must be reachable too (in `hosts`, or
mandatory): `cached_hosts` alone opens nothing.

- **What is kept**: only what is the same for anyone. A `GET` without a body
  (`Content-Length` over 0, any `Transfer-Encoding`, or `Expect`), `Cookie`, `Range` or a
  header whose name looks like a credential (with `auth`, `token`, `key`, `secret`,
  `password` or `credential` in it, or starting with `x-jfrog-`: `Authorization`,
  `Private-Token`, `X-Api-Key`…; npm's `npm-auth-type` and the proxy's own `Proxy-*` aside),
  answered `200` without `Cache-Control: private` or `no-store`, and within
  `EGRESS_CACHE_ENTRY_MAX`. Anything else is forwarded as before.
- **What reaches the host**: on the cache path, only `Accept`, `Accept-Encoding`,
  `Accept-Language` and `User-Agent` go on, with `Host`; to check a kept answer, its own
  `If-None-Match` and `If-Modified-Since`, never the client's. Any other header
  (`X-HTTP-Method-Override`, `X-Forwarded-Host`) is dropped, so it can't shape an answer kept
  for every repository. `Accept-Language` and `User-Agent` aren't in the key (see `Vary`
  below). A request the cache doesn't answer (one checking its own copy when nothing is
  kept, or one sending a header the kept answer varies on) goes on as it is, and its answer
  isn't kept.
- **Connections**: every request the proxy sends to a host, cached or not, gets a new
  connection, never reused: a request whose body a host doesn't read (request smuggling)
  can't put another URL's answer under a key.
- **Cookies and `Vary`**: a cookie the answer sets goes to that client only, never into the
  cache: the request had none, so the answer is the one anyone gets, and CDNs set theirs on
  everything (Cloudflare's `__cf_bm` on npm's registry). `Accept-Encoding` and `Accept` are
  part of the key, with the URL. An answer varying on another header (`Vary: Origin` on
  Alpine's mirror) is kept only when the request didn't send it, and served only to
  requests that don't either; one varying on `*` isn't kept.
- **Freshness**: the host's `Cache-Control` (`s-maxage`, `max-age`, `no-cache`), else its
  `Expires`, else a tenth of the time since its `Last-Modified` (a day at most), else none.
  A fresh answer is served from disk without asking the host; a stale one is checked with
  `If-None-Match` / `If-Modified-Since`, and a `304` serves it. A client's own
  `Cache-Control: no-cache` has it checked too. Each answer says how in an
  `x-deckhand-cache: hit | miss | revalidated` header.
- **Downloads**: the first one is streamed to the client while it is written to a temporary
  file, renamed into place once complete. A client that disconnects, a host that stops
  midway or a body over the per-entry limit leaves nothing behind.
- **Size**: `EGRESS_CACHE_MAX` (10 GB by default) counts the downloads being written too.
  One with a `Content-Length` reserves it as it starts, and the least recently used answers
  are removed to make room for it; one without makes room as it comes. Downloads under way
  take half of it at most (`EGRESS_CACHE_ENTRY_MAX` when that is more): a download read slowly, or dropped before its end, never evicts
  more than that, and one that finds no room goes on to its client without being kept. The
  bodies are counted, not their small metadata files, and a removed answer a client is still
  reading stays on disk until it is done: the volume can go past it by the answers being
  read then. That half holds at any one time: over time, a run that fetches many different
  URLs (a query string changed each time, say) can still push every other repository's
  answers out. The cache stays within its size, not its contents.
  `EGRESS_CACHE_MAX=0` turns the cache off
  ([Setup](setup.md#advanced-settings)).
- **Trust**: plain HTTP can be tampered with on the way, cached or not, and a cached answer
  then reaches every run. Cache only what the client checks itself (apt's signed indexes and
  their package checksums do) or hosts you would trust over plain HTTP anyway.

#### HTTPS and Deckhand's CA

HTTPS reaches the proxy as a `CONNECT` tunnel, which it can't read. For a host in
`cached_hosts` (and the relayed hosts: GitHub's, the Antigravity CLI's), and only then, the
proxy ends the client's TLS itself, with a certificate for that host signed by a CA of its
own, and serves the requests inside through the cache above (or hands them to the service that relays them); what isn't served from it goes on to the host over TLS, which the proxy checks
against Node's trust store. Everything else keeps the raw tunnel, and the client sees the
real server's certificate.

Some clients don't open a tunnel for HTTPS: busybox `wget` (Alpine's) sends the whole URL to the
proxy instead (`GET https://host/path`), unencrypted on the run's network. The proxy takes it as
a `CONNECT` to that host: the same policy answer, and the request goes on to the host over TLS
it checks against Node's trust store, or to the service that relays it. It is cached only where
the host's `CONNECT` would be decrypted, so a container engine's (never decrypted), an agent
provider's (which Deckhand's CA can't vouch for, below) or any with no CA is sent on, never
kept. The proxy reads nothing the client had encrypted: such a client never encrypted it.
(busybox `wget` also shuts its side of the connection down once the request is sent: the proxy
keeps the connection open until it has answered.)

- **The CA** is made by the proxy on its first start (the `openssl` CLI, in its image),
  in its volume (`ca/` in the `egress-cache` volume), and kept across restarts: a new
  volume is a new CA, which the next runs get. It lasts a year, and the proxy makes a new
  one a month before its end (and replaces one from before name constraints, or whose
  constraints still exclude GitHub, below, on its next start): sandboxes get it at their
  next start, and runs going on then lose their cached and relayed hosts' HTTPS (their
  certificates are the old CA's), GitHub's included, until their next run. Its key
  (`ca.key`) never leaves that volume; no sandbox, engine or other service mounts it. Its **name
  constraints** exclude the agents' providers (`anthropic.com`, `openai.com`, `chatgpt.com`
  and their subdomains): a certificate it signs for them fails verification, and the proxy
  never asks for one. Each host's certificate lasts 7 days, and is made again 2 days before
  its end. It exists with the cache off too (`EGRESS_CACHE_MAX` `0`): every run's GitHub
  calls need it.
- **Why GitHub is no longer excluded**: the CA must certify `github.com` and
  `api.github.com` for the proxy to relay them to the [GitHub gateway](#the-github-gateway).
  The exclusion kept a leaked CA key from opening live tokens; since the same change, no
  sandbox's traffic to GitHub carries one, only the run token, which works from its own
  sandbox, through the gateway, while the run lasts. A key that leaks lets its holder read
  and change the GitHub traffic of the sandboxes running then (what they read and write, as
  the proxy does), not act as them elsewhere. `githubusercontent.com` is certifiable too: only
  GitHub's content hosts are relayed, for a work run that isn't a fork's (they carry no
  token), and neither relayed nor decrypted for the others unless you cache them. The
  providers' names stay excluded: the operator's credentials still go there, from the
  models service.
- **Trust in the sandbox**: for every run that reaches GitHub (all but research runs), and
  when its repository's grant has `cached_hosts` or its agent's calls are relayed (the
  Antigravity CLI's), the orchestrator
  asks the proxy for the CA's certificate (public, at `http://egress:3128/deckhand-ca.crt`)
  and puts it in the run's inbox folder, which its sandbox alone fetches from the broker at
  start (a run that can't stops). The sandbox's entrypoint adds it to a
  bundle with the image's own roots, which `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE` and `PIP_CERT` point at, and to
  Chromium's store (`~/.pki/nssdb`, with `certutil`). A tool that reads none of them refuses
  cached hosts' certificates, and fails rather than going round the proxy. When the
  orchestrator can't get the CA (the proxy doesn't answer), the run stops, saying so: it couldn't
  reach GitHub. (A research run, whose GitHub isn't relayed, then has no cached hosts, and
  an Antigravity CLI one on a plan stops.)
- **Never cached**, whatever `cached_hosts` says: the mandatory hosts below, the agent's and
  GitHub's (decrypted only to be relayed to the github service and the models service). Their traffic carries the run
  token, which the cache would refuse anyway. Nor a run's [container engine](#container-engine): its builds and
  containers don't trust the CA, so its connections keep the tunnel, and only plain HTTP is
  cached for them; caching in the engine itself is `docker: { cache: true }`'s.
- **An upstream certificate that doesn't verify** (expired, self-signed, for another name)
  is refused with a `502` saying so: the proxy never passes it on under its own CA. A
  private mirror whose CA isn't a public one can't be cached over HTTPS: leave it out of
  `cached_hosts`.
- A tunnel to a cached host that doesn't start with TLS (SSH on port 443, say) is passed on
  as is.

What this changes: the proxy now reads the requests and answers of the hosts you list in
`cached_hosts`, and holds a key that sandboxes trust for any host but those its name
constraints exclude. It stays acceptable because the proxy only uses it for the hosts you
listed, which are what you would cache anyway (public mirrors, without credentials: a
request with `Authorization`, `Cookie` or another credential-like header is sent on, never
kept); the key never leaves the proxy's volume, which neither sandboxes nor engines can
reach, and the proxy runs read-only, without capabilities; and a sandbox
trusting the CA gains nothing it could use: it reaches the same hosts as before, through
the same proxy. Someone who gets the key (from the host, or the proxy's volume) can
impersonate any other host to the sandboxes running then, for at most the CA's year, GitHub's
included (whose traffic from a sandbox carries no token), but not Anthropic's or OpenAI's
hosts (nor Google's, which the Antigravity CLI's runs relay, are excluded): treat the volume
like edge's data. Removing the volume (or `ca/`
in it) and restarting the proxy makes a new CA.

### Where a sandbox's hosts come from

**Restricted by default**: a sandbox reaches the mandatory hosts (below) and the hosts you
grant its repository, nothing else. You list them in one place per scope, the grants
folder, read again at each run:

| For        | Where                                   | Read        |
| ---------- | --------------------------------------- | ----------- |
| every repo | the mandatory hosts (below)             | built in    |
| every repo | `hosts` in `grants/default.yaml`        | at each run |
| one repo   | `hosts` in `grants/<owner>/<repo>.yaml` | at each run |

They add up: a run of `acme/api` reaches the mandatory hosts, then `default.yaml`'s, then
`acme/api.yaml`'s. Nothing narrows them: a repository's `.deckhand.yaml` has no `hosts` (one
there is ignored, with a warning in the dashboard and the run's log), and a mode has no key
for them, so every run of a repository reaches the same hosts.

Each entry is a host name (`registry.npmjs.org`), `*.domain` (any subdomain, at any depth,
not the domain itself: list both if you need both), or `*` (anything). Any port. An IP
address or a name without a domain (`172.17.0.1`, `cache`) works too: you decide what sits
next to the sandboxes. Hosts you list may resolve to private addresses (`*` alone doesn't
count, see above).

Why not the repository: its `.deckhand.yaml` is written by whoever can push to its default
branch, and a run can open a pull request that someone merges. If its own `hosts` counted, a
sandbox could get its way out by changing that file. A repository says what it needs in its
docs or onboarding issue; you add it to its grants file. The proxy's `403`, the sandbox's
instructions and the dashboard's repository panel all name these files.

**Mandatory hosts**, always allowed:

| Host                         | For                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `api.anthropic.com`          | Claude Code's runs only: WebFetch's domain check                                                      |
| `github.com`                 | git over HTTPS (`GITHUB_URL`), relayed to the [gateway](#the-github-gateway)                          |
| `api.github.com`             | `gh` and the API (`GITHUB_API`), relayed to the [gateway](#the-github-gateway)                        |
| `*.githubusercontent.com`    | raw and LFS files, diffs, release downloads, avatars (relayed for checked runs)                       |
| `broker`, `github`, `models` | the services' names: the run's token and files, pushes, the agent's API calls, forwarded by the proxy |

That list was checked against Claude Code 2.1.300 (the pinned version) by reading the hosts
in its binary. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (set in the image) and the
credential in `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN`, Claude Code sends its API calls to the models service's name (`ANTHROPIC_BASE_URL`, which the proxy forwards to the models service,
see [The Claude credential](#the-claude-credential)) and nothing else but WebFetch's domain
check to `api.anthropic.com`:

- not `platform.claude.com`: it refreshes OAuth credentials stored by `/login`, which a
  sandbox doesn't use (`setup-token` tokens aren't refreshed);
- not `claude.ai` / `claude.com`: interactive login only;
- not the telemetry, error reporting and update hosts (Statsig, Sentry, Datadog,
  `downloads.claude.ai`): non-essential traffic, off.

Check it again when you change `CLAUDE_CODE_VERSION`. A refused host shows up in the
orchestrator's logs (`Egress: refused <host> for <repo>#<n>`).

A Codex run's mandatory hosts are GitHub's and the services' names only: no `api.anthropic.com`,
and no `api.openai.com` either. Checked against Codex 0.162.1 (the pinned `CODEX_VERSION`)
through a proxy that logged every connection: with its calls sent to the models service's name
(`OPENAI_BASE_URL`) and the
settings `sandbox/agents/codex.sh` writes (analytics, update check, plugins, apps and remote
plugins off), it opens none. Without them it reaches `chatgpt.com`, `ab.chatgpt.com`,
`github.com` and `api.github.com` for its plugin marketplace and analytics. Its web search
runs on OpenAI's side, in the API call. Check it again when you change `CODEX_VERSION`.

An Antigravity CLI run's mandatory hosts are GitHub's, the services' names, and `agy`'s own:
`daily-cloudcode-pa.googleapis.com` and `www.googleapis.com` (relayed to the models service, see
[The Antigravity CLI's login](#the-antigravity-clis-login)) and `antigravity-unleash.goog`
(feature flags) and `lh3.googleusercontent.com` (the account's avatar, which its eligibility
check needs). `play.googleapis.com` is refused for its runs, whatever the grants say. Checked against agy 1.4.0 (the pinned `AGY_VERSION`) through a proxy
that logged every connection; its update check is off (`AGY_CLI_DISABLE_AUTO_UPDATE`). Check
it again when you change `AGY_VERSION`.

### Not covered

- **A Podman engine** exposes much more of the host's kernel than a sandbox does: seccomp
  and AppArmor are off, so every system call (`keyctl`, `bpf` where unprivileged use is
  allowed, `userfaultfd`…) and mount is open to code running in it, as are `/dev/fuse` and
  `/dev/net/tun`. A kernel bug reachable that way is a way out of the container. Prefer
  Sysbox, and grant `docker` only to repositories whose default branch you trust.
- **An engine's containers** run what the run builds, with the run's hosts: a repository's
  Dockerfile pulling from a host the run may reach can bring anything in, as its setup
  command can.
- **A fork's code in a work run** can still write to the agent's session (`~/.claude`,
  `~/.codex` or `~/.gemini`) of that run's issue, which its next work run starts with. What
  `.git` keeps besides hooks (objects, refs, the stash, and the branches' `remote` and
  `merge`), enough to make a branch of its own look like one of the repository's, stays in a
  fork's run's own clone (`-fork-workspace`), which only the issue's later fork's runs start
  from. It can also push the run's own branch, its pull request's commits included, which a
  repository granted `branch_docker_images` builds and the issue's later work runs
  fetch as the repository's own. It ran with the same token
  and hosts as the run it would reach, one an allowed user asked for: read what a fork's pull
  request does before asking for work on it (see [What a fork's code may reach](#what-a-forks-code-may-reach)).
- **A fork's pull request only mentioned** (in an issue, or a comment from elsewhere: "check
  out #7 and fix it") isn't seen as a fork's run: the run gets the repository's caches,
  read-write mounts and engine, and the GitHub gateway refuses it the fork's code ([What a
  fork's code may reach](#what-a-forks-code-may-reach)). Not everything goes through the
  gateway, though: the run's container engine reaches GitHub anonymously, around it (the
  exception in [The GitHub gateway](#the-github-gateway)), so a build there can fetch a
  public fork; a `codeload.github.com` grant serves any public repository's archives; and the
  same code anywhere else (another repository, a gist, a package registry the run may reach;
  a granted host whose name leads to GitHub's content CDN, or another of GitHub's own hosts
  granted (`codeload.github.com`, `*.github.com`), whose front ends may answer for one another
  as the content CDN does: a tunnel to either would reach them unchecked; a granted host that
  fetches from GitHub for the sandbox by the repository's own name, as the Go module proxy
  does for `go get github.com/<owner>/<repo>@<sha>` or jsDelivr for `/gh/<owner>/<repo>@<sha>/`:
  GitHub serves a fork's commit through the repository's name, so such a host likely does
  too),
  or written as text (a pull request's description, a comment, a workflow's check-run
  summary), is no fork's tree to any check. Ask for work on a fork's pull request from that
  pull request.
- **Image builds** (a repo's `dockerfile`, with the `dockerfile` grant) and the **Claude Code
  install** run with normal network access: they run on the host's Docker, outside the
  sandboxes' networks. Builds run the repo's Dockerfile from its default branch (or its pull
  requests' branches with `branch_docker_images`). A branch's image gets a tag of its
  own (`branch-…`, hashing its commit), so the default branch's runs never use an image built
  from a branch. A repo's image name and tags hash the repository too
  (`<prefix>-repo-<owner>-<repo>-<hash>`): repositories whose names read alike (`acme/x.y`,
  `acme/x-y`) never run, or prune, each other's image.
- **Deckhand's own source** is in every sandbox, read-only (`/usr/local/share/deckhand/src`,
  for onboarding: see [Onboarding](architecture.md#onboarding)), repo images built from the
  base image included: whoever can steer a run can read it. In a one-operator deployment
  those are the operator's own repositories and users, so it is accepted; it only matters
  while Deckhand's repository is private. It holds no secret: those are in the operator's
  settings and grants folder, never in the image. An image built from an operator's own
  checkout copies these folders as they are on disk: `.dockerignore` leaves out `.env`,
  `*.pem` and `*.key` files anywhere, but nothing else that isn't tracked.
- **DNS**: Docker's embedded resolver may forward lookups from the internal network to the
  host's resolvers, so a lookup of a made-up name could carry data out to that domain's DNS
  server.
- **The proxy is on every run's network**: a sandbox reaches the proxy's port, as every
  other sandbox does, but not the other sandboxes behind it.
- **Allowed hosts are trusted entirely**: anything a sandbox can write to on one is a way
  out: its own repository on GitHub, a bucket or paste service behind `*`.
- **A research run allows every public host**: everything it holds can leave, so it holds
  little (see [Research runs](#research-runs)), but what it does hold can: the issue's
  thread, what it read on the web, and what the agent's provider sends back. Don't grant
  `research` to a repository whose issues hold what must not leave.
- Edge's port (8080: dashboard, webhook) is on no run's network, but a sandbox may reach its
  published address through the proxy, as any host its run may reach; it needs a dashboard
  session (a signed-in allowed user, see [Setup](setup.md#4-the-dashboard)) or the webhook's
  signature. `/status` also answers calls from inside edge's container (see
  [The dashboard](#the-dashboard)).
  Deliveries without a signature or over 5 MB are refused before their body is read (a push
  that large only delays a config's refresh). At most 16 are read at once, 4 per client
  address (per /64 for IPv6), each within 10 seconds and dropped after 2 seconds without
  data. A reader older than a second loses its place to a new delivery when its address's
  share, or edge, is full: GitHub sends a body in milliseconds. When edge is
  full of younger readers, a delivery from an address holding fewer places than another takes
  the oldest place of the address holding the most, so a few clients reopening stalled bodies
  can delay deliveries but not keep them out. Behind a reverse proxy every delivery has the
  proxy's address, so they all share those 4 places: restrict `/webhook` to GitHub's `hooks`
  ranges (`https://api.github.com/meta`) at the proxy, and let it buffer request bodies, to
  keep slow clients away from edge.
