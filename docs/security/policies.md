# Policies and capabilities

What the operator grants a repository, and how the policies decide what each run may do. Part of the [Security overview](../security.md).

## The grants folder

What you give a repository beyond what every sandbox gets lives in the grants folder
(`GRANTS_DIR`, `grants/` in the server folder): its hosts, cached hosts, projects, mounts and
limits, a file per repository and `default.yaml` for every one, and your policies in `policy/`,
which hold [the grants](#the-grants) (a Dockerfile, an engine, research, workflows, auto-merge).
Its layout, every key and how errors stop runs:
[The server folder and grants](../reference/server-folder.md#the-grants-folder). It is read again
at each run, and a file with errors grants its repository nothing (a broken `default.yaml`,
nobody anything): it fails closed.

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

**Dockerfiles** are the most powerful thing a `.deckhand.yaml` asks for: a Dockerfile is built on the
host's Docker with its network (on Kubernetes, by the cluster's BuildKit daemon, through the
egress proxy with the repo's hosts only, and pushed to the operator's registry; the runner
refuses to build unless NetworkPolicies make the proxy the daemon's only way out, but that
the daemon's own pulls use the proxy rests on its Deployment's `HTTPS_PROXY`, which the
runner can't see. The registry has to require credentials to pull, push and delete (Deckhand doesn't start with `KUBERNETES_REGISTRY` and no `KUBERNETES_REGISTRY_SECRET`): a repo image runs in its repository's sandboxes, so whoever could push over its tag would run code with that repository's grant, and it holds what its Dockerfile copied of the checkout, which any sandbox that could pull it would read:
[Repo images on Kubernetes](../kubernetes/components.md#repo-images-on-kubernetes)). A repository whose config has `dockerfile`
without the `dockerfile` grant doesn't get it: its runs stop and the reply on the issue says
which grant is missing, like refused mounts. Grant it to repositories whose default branch you
trust as much as the host itself. `branch_docker_images`
is a grant too, not a `.deckhand.yaml` key: it lets anyone who can push a branch of the
repository change what is built.

### The grants

What a repository may do beyond hosts, mounts, limits and projects (a Dockerfile, a container
engine, research runs, workflow pushes, auto-merge, machines) is a `grant` decision of your
policies, asked for each repository and each grant, at each run: the list and how to write the
rules are in [The grants](../reference/server-folder.md#the-grants). What holds whatever the
rules say:

- **Nothing by default**: Deckhand's default policies have no `allow_grant` rule.
- **One repository at a time** for the riskiest (`docker`, `workflows`, `workflow_secrets`,
  `auto_merge`, `auto_merge_public`): a rule that also grants one to `*/*` or `<owner>/*` gives
  it to none, a best-effort check.
- **Yours only**: a repository's own `.deckhand/policy/` never grants itself anything.
- **Fail closed**: when the policies can't be evaluated, the repository gets nothing.
- **The runner asks too**, and checks every sandbox spec and image build against them, whatever
  the orchestrator says ([The runner service](services.md#the-runner-service)).

## Policies

[Policies](../repo-config/policies.md#policies) are Rego rules that allow and refuse a decision: `run`, a
run a person asks for (a comment, the dashboard, an inbox entry, a discussion), before it is
queued; `merge`, the last gate of an auto-merge; `review`, a review that starts by itself; `fix`, a review's fix
run, a CI fix run or a conflict's rebase run; `link_branch`, the branch the orchestrator links to a
work run's issue ([The default branch](github.md#the-default-branch)); `request_review`, the reviewers
the orchestrator requests on Deckhand's ready pull request (`review.request`, allowed users only,
never a team, and never at a run's request); `github`, a run's write to GitHub (REST, or a
GraphQL mutation's field), and its reads of CI's checks and of projects, after the gateway's
built-in checks: [The GitHub gateway](github.md#the-github-gateway); `push`, each branch a run's push
updates, after the git gateway's: [The default branch](github.md#the-default-branch); `grant`, each of a
repository's [grants](#the-grants), your layer's alone. Each has two rules: `allow_<decision>` and
`deny_<decision>`; what a run gets as it starts has two of its own ([Capabilities](#capabilities)). **A decision is allowed when an allow rule matches and no deny rule does**:
a deny always wins, and with no allow rule matching it is refused, so an empty or replaced file
refuses rather than opens, and a new decision starts closed.

They come in **two layers**, evaluated together by the policy service (#501, below) in one
query of one `opa` (as before allow rules: a built-in mode pays nothing extra), each in a
namespace of its own:

- **The operator's**: Deckhand ships its own in the policy service's image
  ([the default policies](../repo-config/policies.md#the-default-policies): `allow.rego`, which allows the
  orchestrator's own decisions (`merge`, `review`, `fix`, `link_branch`, `request_review`),
  `run.rego`, which allows each mode where it makes sense (brainstorms and onboarding on issues
  only), a `mode-<mode>.rego` per mode for what its runs get, write and push
  (`allow_capabilities`, `allow_github`, `allow_push`), a `gh-<feature>.rego` for a feature
  that isn't a mode's (`gh-checks.rego`, `gh-linked-branch.rego`, `gh-reviewers.rego`), and
  `review.rego` and `machines.rego`), which hold without any setup. Yours are the `*.rego` files of `policy/` in the grants folder, which the policy service
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
- **Each call to the service is authenticated**: a [service token](tokens.md#service-tokens) the
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
  list it (no answer, a 5xx, a rate limit), it keeps the last listing up to an hour old (a push
  forgets it, and the log says when it is used). Any other failure, such as a plain 403 or the
  github service's own refusal, refuses at once and forgets the last listing. An orchestrator
  that hasn't listed it in that hour, since its start or since a push, refuses then, as every
  other decision does at once. For `merge`, the pull request then waits for
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
  their rules saw in the store's `decisions`, each string redacted like the messages, the whole cut to
  8 KB, for the task's page on the dashboard.

## Capabilities

What a run's sandbox gets is decided once, as it starts, by the policies
([Per-repo config](../repo-config/policies.md#capabilities)): `allow_capabilities` gives names,
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
| `docker`           | a [container engine](mounts-and-engine.md#container-engine)            | `pull`               | `docker`                    | `docker`               | the orchestrator at start (never for a fork's pull request)                            |
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
  a branch's too). The reads are the token's permissions ([Tokens](github.md#the-github-gateway)), and
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
[The GitHub gateway](github.md#the-github-gateway)), and what its token reads follows its capabilities.
A mode keeps only where its runs' volumes are (its own, or the issue's) and whose agent and model
they default to, never what they may do.

## Chats

A chat's sandbox gets what the policies give a `chat` run (`policy/mode-chat.rego`, and the
repository's `.deckhand/policy/` deny rules, which see `mode: "chat"`), with the repository's
config and your grants, as any run ([Capabilities](#capabilities)); see
[The dashboard's actions](webhooks-and-sign-in.md#the-dashboards-actions) for who reaches one. Its owner may narrow
that, never widen it, with the chat's **permissions profile** (`listener/profiles.mjs`, #478),
edited as toggles in the chat's panel (never as policy text: policies stay files of your grants
folder and of the repository's default branch):

- **GitHub**: one level, read only for now. A chat writes nothing to GitHub whatever the
  policies allow it: a profile asking for comments or pushes is refused, and so is `push`; the
  GitHub gateway refuses every write of a chat's run (a REST write, a GraphQL mutation), even
  one an `allow_github` rule of yours allows, and `deny_github` still sees `mode: "chat"`.
- **Capabilities**: those a `chat` run gets, each on or off (`docker`, the container engine, is
  one, offered only when the repository is granted one and asks for it, and you set
  `SANDBOX_ENGINE`). `pull` stays on: a
  chat works in its clone. One turned off takes what needs it along.
- **Network**: which of the hosts you grant the repository it reaches, all of them by default.
  The hosts every run needs (the agent's API, GitHub) aren't the profile's; a host your grants
  don't list can't be added.
- **Mounts**: which of the repository's granted mounts it gets, read-only (a chat doesn't push;
  a read-write one is refused, from a read-only grant all the more).

`POST /api/chats/<id>/permissions` saves a profile only within its **ceiling**: what a `chat`
run of the repository would get now (the policies on its default branch, its `.deckhand.yaml`,
your grants). What goes beyond it (an unknown host, the engine without its grant, a read-write
mount, a level above read) is refused with a `422` listing each, never dropped quietly. At every
start (`preparation.mjs`), the saved profile is narrowed again to the ceiling of that day: a
grant or a policy removed since narrows it silently, and nothing it says ever adds to what the
policies and grants give. A sandbox going keeps what it started with; the panel says so and
offers "Restart now", which stops it once its agent has answered, its session kept.

**Enforced in a sandbox, advisory on a machine.** In a sandbox, what the profile leaves out isn't
in the run: its capabilities are its tokens' `caps` claim, which the GitHub gateway holds its
reads to (no `read:issues`, no issue at all); its hosts are the egress proxy's for the run; its
mounts and engine aren't in the spec the runner runs (which the runner still checks against your
grants). On a user's own machine (a chat there is #601), Deckhand enforces nothing: the same
profile would only narrow the Claude Code settings the driver suggests, and the panel would say
it is advisory there.

**Asking for more** (#479). A chat's agent that hits a wall asks its owner rather than only
saying so: `deckhand-permissions` in the sandbox, an MCP server with one tool,
`request_permission { kind: host | github | engine | mount, value, reason }` (a CLI of the same
name for an agent without MCP, which the chat's prompt mentions), added for a chat's run alone.
It holds no token: it calls the broker with the run token, as `deckhand-inbox` does.

- **Only a chat's run asks.** The broker takes `POST /run/permissions` from a run whose token
  says `mode: "chat"` alone (another run is refused with a `403`: an issue's run has no profile
  to widen, its capabilities are decided at its start), from its own sandbox, at most 50 times a
  run; its answer is read with the same run's token only (another run's gets a `404`). The
  orchestrator answers it (`PUT /runs/:id/permissions/:request`), nobody else.
- **Never beyond the ceiling.** The orchestrator (`listener/requests.mjs`) checks each request
  against the chat's ceiling of the moment (`profiles.mjs` `requestVerdict()`). What the
  policies, the repository's config or your grants don't give it (a host you don't grant the
  repository, the engine without its grant, a mount it isn't granted, a GitHub write) is refused
  at once, without asking anyone, the reason told to the agent: you widen it, in the grants
  folder, by hand. What the sandbox has already is granted at once; so is what its profile
  allows but its sandbox lacks (a profile changed since it started).
- **The owner answers the rest.** It shows in the conversation as a card (what, the agent's
  reason, when it applies) with Approve once, Approve for this chat and Deny, for the chat's
  owner alone (`POST /api/chats/<id>/requests/<request>`). An approval is checked against the
  ceiling again first. "For this chat" saves it in the profile (within the ceiling, as a save
  from the panel); "once" keeps it for the sandbox going, or for its next start alone. Nobody
  answering within `CHAT_PERMISSION_TIMEOUT` (10 minutes, at most 60) denies it, and so does the
  run ending. At most 3 of a run's requests wait at once.
- **When it applies.** An approved host is added to the run's hosts at once: the egress proxy
  asks the orchestrator about every connection, so the next one reaches it, without a restart.
  The engine and a mount are in the sandbox's spec: they apply when it starts again, which the
  answer tells the agent (the owner restarts it from the chat's panel, its session kept).
- **The reason is shown, not trusted.** What the agent writes in `reason` is put on one line,
  cut to 200 characters and redacted (your agents' credentials, token shapes), as the
  policies' messages are, and the dashboard shows it as text: never HTML, never Markdown.

**Where its data lives.** A chat is its owner's alone, from start to end: only they list it,
message it, read its logs and answer its requests (see
[The dashboard's actions](webhooks-and-sign-in.md#the-dashboards-actions)). What it keeps:

- **The chat itself**, in the orchestrator's store (`chats`: its owner, repository, agent,
  model, effort, title, permissions profile and times), and its messages not delivered yet in
  the store's queue, as any queued comment: whoever reads the store reads them
  ([Edge's and the orchestrator's data](services.md#edges-and-the-orchestrators-data)).
- **Its clone and its agent's session**, in volumes of its own, named after the sandbox of its task
  (`<repo>#chat-<id>`), never an issue's: kept between its sandbox's starts, gone at a reset
  or a deletion, which the runner does for a chat's key alone
  ([The runner service](services.md#the-runner-service)).
- **Its conversation**, in its runs' logs and summaries (the runner's volume and the
  orchestrator's store, redacted as any run's), and the messages its sandbox got in its inbox
  (the runner's volume, `runner-data`, its `runs/` folder, and the broker's store), both removed
  when that run ends. Its latest run's log stays while the chat is kept,
  past `LOG_RETENTION_DAYS`; a deletion removes all of them.
- **Its requests for more permissions**, in the broker's store for two hours at most and in the
  orchestrator's (`permission-requests`, its agent's reason redacted) until a day after their
  answer, or until the chat is deleted.

Nothing of it goes to GitHub: a chat posts no comment, reaction or label, and its answers stay in
its log. Its conversation still leaves the deployment the way any run's does: to the agent's API,
through the models service, and to whatever host its profile lets its sandbox reach.

## Research runs

A run in the research mode (`/mode research`, [Per-repo config](../repo-config/modes.md#research))
reaches the open internet, which no other run does: the only other way is `hosts: ["*"]` in
a repository's grants file, which opens it for every run of that repository, next to its
code and a token. A research run is one prompt-injected page away from sending whatever it
holds to any host, so it holds almost nothing:

| What                           | A research run                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Hosts                          | any public one (`*`); private addresses only for the mandatory hosts, not the grant's       |
| The repository's code          | none: no clone, `/workspace` starts empty                                                   |
| GitHub                         | public pages and API, anonymously; the GitHub and git gateways refuse it                    |
| Other runs' secrets            | useless: a secret only works from its own run's sandbox ([Tokens](tokens.md#tokens))        |
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
  networks, whatever its range (see [Network](network.md#network)), so the orchestrator's ports,
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
