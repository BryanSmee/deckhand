# Per-repo config: `.deckhand.yaml`

Each repository can tune its runs with a `.deckhand.yaml` file at its root. Without one, its
runs use the operator's settings and the base image.

The listener always reads it from the repository's **default branch**, at every run: a
change on a branch or in a pull request has no effect until it is merged, so nobody can
change a run's permissions from the code it runs on. The file can only **narrow** the
operator's settings (users, parallel runs), never widen them.

A file with errors stops the repository's runs: the reply to a trigger comment (or a
`/mode` line) lists them.
Unknown keys and users the operator doesn't allow are only warnings, shown in the run's log
on the dashboard.

## Onboarding

When the App is installed on a repository without this file, the listener opens an
onboarding issue there (see [Setting up](setup.md#3-use-it)), and Claude proposes the file
in its comments: it reads the repository (package managers, CI workflows, `AGENTS.md`, test
and lint commands, services) and gives each key a reason, within the users and mount roots
the operator allows, and names the hosts to ask the operator for. Each comment on the issue goes on in that conversation, with a
read-only token. Claude may suggest inboxes; they are created only if you agree.

The trigger line (`Deckhand`) or `/mode work` confirms: a work run on the issue's branch
writes only the agreed files and marks its pull request ready. The listener then reads the
branch's `.deckhand.yaml` as it would on the default branch, checks that the files it names
are there, and adds its errors and warnings to the reply, so a broken config isn't merged by
mistake.

`/mode onboarding` on any issue starts the same conversation. Its prompt is
`prompts/onboarding.md`, followed by this page.

## Example

```yaml
# .deckhand.yaml (read from the default branch)

# Who may start runs here: only narrows the operator's ALLOWED_USERS.
users: [alice, bob]

# The first line of a comment that starts a run, compared loosely ("@Deckhand:" matches).
trigger: Deckhand

# The agent of work runs and of light ones, among those the operator configured (see Agent).
agent: claude
brainstorm_agent: claude

# Defaults; a comment's /model and /effort lines still override them.
model: opus
effort: high
brainstorm_model: sonnet
brainstorm_effort: medium

# false: no fast mode here (/speed fast), even if the operator allows it.
fast_mode: false

# Runs of this repo at once, within the operator's MAX_PARALLEL.
max_parallel: 1

# Run in the clone before Claude starts, on every work run (not for brainstorms).
setup: |
  npm ci
  npm run db:start

# Project instructions, added to the generic ones (path in the repo, default branch).
instructions: docs/agents.md

# The image runs start from: a Dockerfile FROM the base image (see below). Only with the
# operator's allow_dockerfile grant.
dockerfile: .deckhand/Dockerfile

# A container engine next to work runs' sandbox, for docker build, run and compose (see
# below). Only with the operator's allow_docker grant. `docker: true` starts it empty.
docker:
  cache: true # keep its images and layers between this repo's runs

# Kept between runs: one Docker volume per path, for this repo only.
caches:
  - /home/node/.npm
  - /home/node/.cache/ms-playwright

# The repo's own modes, started with a "/mode <name>" line (see Modes below).
modes:
  audit:
    instructions: .deckhand/audit.md # path in the repo, default branch
    light: true # comments only: no branch, no setup, a read-only token
    session: issue # issue: kept, like a brainstorm | fresh: a new one each time
    agent: codex # only if the operator configured it
    model: balanced
    effort: medium
  hotfix:
    instructions: .deckhand/hotfix.md
    speed: fast # Claude Code's fast mode, without a /speed line: see Modes below

# Review pull requests: one GitHub review with severities, a rating and a verdict (see
# Reviews below). Off without the block; `review: true` for "/mode review" only.
review:
  on: ready # a pull request marked ready (or opened as ready) | manual: "/mode review" only
  instructions: .deckhand/review.md # optional, added to the built-in review prompt
  model: best # default: brainstorm_model, brainstorm_effort
  effort: high
  fix: true # one work run that addresses a review requesting changes, once per pull request

# Where ideas, bug reports and questions go (see Inboxes below).
inbox:
  ideas: 3 # issue number
  bugs: 4 # issue number
  discussions: Ask Claude # GitHub Discussions category

# Run on pull_request and workflow_run deliveries (see below).
preview:
  command: ./deploy/preview.sh
  image: docker:27-cli
  timeout_minutes: 30

# Rebase this repo's open Deckhand pull requests that conflict with their base (see below).
conflicts:
  check_minutes: 15

# Start work on an issue with open questions only once they are answered (see below).
wait_for_answers: true
```

## Keys

| Key                                     | Default                                 | What                                                                                                                         |
| --------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `users`                                 | `ALLOWED_USERS`                         | GitHub logins that may start runs here; those not in `ALLOWED_USERS` are ignored                                             |
| `trigger`                               | `TRIGGER`                               | the whole first line of a comment that starts a run; `/mode` picks another mode                                              |
| `agent`, `brainstorm_agent`             | `SANDBOX_AGENT`, `BRAINSTORM_AGENT`     | the agent of work runs, and of brainstorms, inbox entries and discussions (see Agent)                                        |
| `model`, `effort`                       | `SANDBOX_MODEL`, `SANDBOX_EFFORT`       | work runs' model (`best`, `balanced`, `fast` or a name) and effort (`low` … `max`)                                           |
| `brainstorm_model`, `brainstorm_effort` | `BRAINSTORM_MODEL`, `BRAINSTORM_EFFORT` | the same for brainstorms, inbox entries and discussions                                                                      |
| `fast_mode`                             | `SANDBOX_FAST_MODE`                     | `false`: `/speed fast` and a mode's `speed: fast` run at normal speed here; `true` can't turn it on when the operator hasn't |
| `max_parallel`                          | `MAX_PARALLEL`                          | runs of this repo at once; capped by `MAX_PARALLEL`                                                                          |
| `setup`                                 | none                                    | shell command run in `/workspace` before the agent, on work runs                                                             |
| `instructions`                          | none                                    | Markdown file of the repo, appended to the agent's instructions                                                              |
| `dockerfile`                            | none: the base image                    | Dockerfile of the repo for its runs' image; needs the operator's `allow_dockerfile`                                          |
| `docker`                                | none                                    | a container engine for work runs (`true`, or `cache: true`); needs `allow_docker`                                            |
| `caches`                                | none                                    | absolute paths in the sandbox kept in a volume per repo and path                                                             |
| `mounts`                                | none                                    | host paths requested (`- path: /nfs/work/api`, `read_only`); only under granted roots                                        |
| `modes.<name>`                          | none                                    | the repo's own modes, picked with `/mode <name>` (see Modes)                                                                 |
| `review.on`                             | none: off; `manual` with the block      | `ready`: a pull request that turns ready gets a review; `manual`: `/mode review` only                                        |
| `review.instructions`                   | none                                    | Markdown file of the repo, added to the built-in review prompt                                                               |
| `review.agent`, `.model`, `.effort`     | `brainstorm_agent`, `_model`, `_effort` | the reviews' agent, model and effort (see Reviews)                                                                           |
| `review.fix`                            | `false`                                 | a review that requests changes starts one work run that addresses it (see Reviews)                                           |
| `inbox.ideas`, `inbox.bugs`             | none                                    | issue numbers whose comments are ideas or bug reports to file (see Inboxes)                                                  |
| `inbox.discussions`                     | none                                    | GitHub Discussions category whose discussions Claude answers (see Inboxes)                                                   |
| `preview.command`                       | none                                    | preview hook command (`preview: ./x.sh` works too); needs the operator's `allow_preview`                                     |
| `preview.image`                         | the repo's image                        | image the hook runs in; it needs a Docker client                                                                             |
| `preview.timeout_minutes`               | `30`                                    | the hook is stopped after that (120 at most)                                                                                 |
| `conflicts.check_minutes`               | none: off                               | minutes between conflict checks; at least `CONFLICT_CHECK_MINUTES` (see Conflicts)                                           |
| `wait_for_answers`                      | `true`                                  | an issue's work runs wait until its open questions are answered (see Open questions)                                         |

## Network and mounts

Sandboxes reach the outside through an egress proxy only: Anthropic's API, GitHub and the
hosts the operator grants the repository in their grants folder (`hosts` in
`grants/default.yaml` for every repository, `grants/<owner>/<repo>.yaml` for this one).
Anything else is refused with a `403` saying so. This file has no `hosts`: anyone who can
push to the default branch could otherwise open the sandbox's network, so only the operator
lists them (one here is ignored, with a warning). The same goes for `cached_hosts`, those of
them whose answers (HTTPS too) the egress proxy keeps for every run
([The egress cache](security.md#the-egress-cache)). Ask the operator for the registries and
APIs the repository needs; the onboarding issue lists them. See
[Where a sandbox's hosts come from](security.md#where-a-sandboxs-hosts-come-from).

A `mounts` entry is only a request: it is mounted when the operator grants the repository a
root holding it, after resolving `..` and symlinks. Otherwise the run stops and the reply
says which path was refused and why. See [Security model](security.md).

### YAML

The listener has no dependencies, so it reads the part of YAML a config needs: mappings,
lists (block and `[a, b]`), `{ a: 1 }` on one line, quoted and plain values, `|` and `>`
blocks, comments. Anchors, aliases, tags and several documents in one file are refused
with the line number.

## Workflow files

A run's pushes can't add or change files under `.github/workflows/` unless the operator grants
the repository `allow_workflows` in its own grants file (`grants/<owner>/<repo>.yaml`). With the
grant, the git gateway reads each workflow file a push changes from the default branch's before
GitHub gets it, and refuses the push, naming the file and the rule, unless the workflow:

- has a top-level `permissions:` of `read-all`, `{}` or scopes set to `read` or `none`, and no
  `write` scope or expression in a job's `permissions:` either;
- doesn't mention `secrets` anywhere (`secrets.X`, `toJSON(secrets)`, `secrets: inherit`…);
- has no job with an `environment:`;
- calls no reusable workflow from another repository or ref (`uses: owner/repo/…@ref`); one of
  this repository's (`uses: ./.github/workflows/x.yml`) must pass these rules too;
- keeps to a strict YAML subset: no anchors, aliases, tags, merge keys, duplicate keys or
  several documents, and no plain or quoted value or flow collection over several lines (use
  `|` or `>` blocks).

The same goes for the branch's merge with the default branch and with its pull requests' bases,
which GitHub runs a pull request's workflows from, checked again when the pull request is
opened, edited, marked ready or turned back into a draft: a workflow that doesn't merge cleanly
refuses the push until the branch is rebased on the default branch. Workflows the default
branch already has, and deleted ones, aren't checked. A workflow that needs more (a deploy, a
secret) is the maintainers' to write. See [GitHub Actions on Deckhand's
branches](security.md#github-actions-on-deckhands-branches).

## Images

Every run starts from an image:

- **The base image** (`SANDBOX_IMAGE`, `deckhand-sandbox`): the harness only: `git`, `gh`
  (through the token broker), `jq`, `ripgrep`, Node 26, Playwright with Chromium, the
  entrypoint and the draft pull request hooks. No project toolchain, and **no Claude Code**:
  before the first run that needs it, the listener installs the pinned
  `CLAUDE_CODE_VERSION` in a short container of its own, into the shared
  `deckhand-claude-code` volume; later runs reuse it.
- **The repo's image**, when `dockerfile` is set and the operator's grants set
  `allow_dockerfile: true` for the repository (otherwise its runs stop, and the reply says
  so): built `FROM` the base image, by the listener, from the default branch, with normal
  network access (not through the egress proxy: install the toolchain there rather than in
  `setup`). Name the base with a build argument, so the operator's image name isn't written
  in the repo:

  ```dockerfile
  # .deckhand/Dockerfile: a Python project
  ARG DECKHAND_BASE=deckhand-sandbox
  FROM $DECKHAND_BASE
  USER root
  RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
      && rm -rf /var/lib/apt/lists/*
  USER node
  ```

  Keep `USER node` at the end: sandboxes run as uid 1000 (`--user 1000:1000`) whatever the
  image says, so what the image installs for its user must belong to `node`.

The build context is the repository at the default branch (downloaded from GitHub), so the
Dockerfile can `COPY` files from it. The image is tagged
`deckhand-repo-<owner>-<repo>-<repo hash>:<hash>`: the repo's hash keeps repos whose names
read alike (`acme/x.y`, `acme/x-y`) apart, and the tag's covers the repo, the base image and
the Dockerfile: the listener builds again when either changes, and otherwise reuses the
image. It keeps the three most recent tags per repo and removes older ones, the default
branch's newest first among those kept, and the tags of the name from before the repo hash. While an image builds, the run shows "building image" on the
dashboard, and the build log is in the run's log. A failed build fails the run, with a
reply on GitHub.

Only the Dockerfile's own content is hashed: a change in a file it copies builds a new
image once the Dockerfile changes, or the base image does.

**Branch images.** When the operator's grants set `allow_branch_docker_images: true`
for the repository (it is not a key of `.deckhand.yaml`: one there is ignored, with a
warning), a run triggered from a pull request (a comment or review on it) uses the
Dockerfile of the pull request's head commit, with that commit as the build context. Its
image is tagged `deckhand-repo-<owner>-<repo>-<repo hash>:branch-<hash>`, the hash covering the commit
too: each new commit builds again (Docker's layer cache helps), and the default branch never
runs on an image a branch built. Never for a pull request from a fork: those use the default
branch's image. Builds run on the host's Docker, so operators only grant this to
repositories whose branches they trust like the default branch.

## Container engine

A sandbox has no Docker of its own, so a change to a Dockerfile or a compose file would ship
untested. With `docker: true`, each work run gets a container engine next to its sandbox
(set up by the operator: [Setup](setup.md#container-engine)), and the sandbox the `docker`
CLI with buildx and compose, pointed at it (`DOCKER_HOST=tcp://engine:2375`). The agent's
prompt says whether its run has an engine, and whether it answered:

```sh
docker build -t app .
docker run -d -p 8080:8080 app
curl engine:8080/health    # published ports answer on the engine, not localhost
docker compose up -d
```

- **The grant**: only when the operator sets `allow_docker: true` in this repository's file
  of the grants folder; `docker` without it is an error that stops the runs, like
  `dockerfile`. With the grant but no engine set up (`SANDBOX_ENGINE`), runs start without
  one, and their log says so.
- **The network**: the engine pulls and its containers connect through the egress proxy,
  under the run's hosts. Ask the operator to grant the registries you pull from: Docker Hub is
  `registry-1.docker.io`, `auth.docker.io` and `production.cloudflare.docker.com`; GHCR is
  `ghcr.io` (its blobs come from `*.githubusercontent.com`, always allowed).
- **Its storage** starts empty and goes with the run. `docker: { cache: true }` keeps it in
  a volume per repository instead, so images and layers are pulled and built once; a second
  run of the repository at the same time gets fresh storage (an engine locks its own).
- **Its limits** are the repository's, as the sandbox's.
- **Not for** brainstorms, inbox entries, discussions or light modes, nor for comments on a
  pull request from a fork.
- **Podman**: when the operator runs Podman rather than Sysbox, `docker build` uses the
  classic builder (`DOCKER_BUILDKIT=0`), and some buildx and compose features differ.

## Caches

Each path in `caches` gets a named Docker volume per repo and path
(`deckhand-cache-<owner>-<repo>-<path>-<hash>`), mounted at that path in every run of the
repo. Package manager caches are the usual use: `/home/node/.npm`, `/home/node/.cache/pip`,
`/home/node/.local/share/pnpm`. A new volume is handed to the sandbox's user. Paths the
sandbox mounts itself are refused, and so is a host mount's target there: `/workspace`,
`/screenshots`, `/deckhand` (the run's inbox), and each agent's session and install
(`/home/node/.claude` and `/opt/claude-code`, `/home/node/.codex` and `/opt/codex`,
`/home/node/.gemini` and `/opt/antigravity`), with what is inside or above them. Runs with a
comment from a pull request from a fork get no caches, and their host mounts are read-only:
their code could leave something there that the repo's later runs would run.

## Setup and light runs

`setup` runs with `bash -c` in the clone, after the task's branch is checked out and before
Claude starts, on every work run (a follow-up comment starts a new container). Its output
goes to the run's log. If it fails, the run goes on and Claude is told. The clone is kept
between an issue's runs, but each starts clean: on the branch it was on if that is one of the
repository's own (the task's, a pull request's from the repository) with all its commits
pushed, else the default branch, with uncommitted changes stashed and ignored files removed
(`git clean -ffdx`, so `node_modules` too). Setup reinstalls what it needs, from the caches.
Git hooks and local git settings (`.git/hooks`, `.git/config` beyond the remote and branches)
are reset too: set them up in `setup` if the repository needs them.

Brainstorms are light runs: no branch, no setup command, so the answer comes quickly. So
are the repo's modes with `light: true`.

## Agent

`agent` picks what runs the repository's work: `claude` (Claude Code), `codex` (OpenAI's
Codex) or `antigravity` (Google's Antigravity CLI, with a Gemini API key or on the operator's
Google AI plan),
`brainstorm_agent` that of its light runs (brainstorms, inbox entries, discussions),
and a mode's `agent` that of the mode. Without them, the operator's `SANDBOX_AGENT` and
`BRAINSTORM_AGENT` (a light mode takes `brainstorm_agent`, a full one `agent`).

Only an agent the operator has configured: one it holds a credential for, or its default. Any
other name is an error, listed in the reply, and nothing runs:

```text
agent: the operator hasn't configured codex (configured: claude)
```

Models are the agent's: `best`, `balanced` and `fast` work with each. A model name of another
agent's (`model: opus` with `agent: codex` or `agent: antigravity`) stops the run, and the reply
says why. The Antigravity CLI's models carry their effort in their name
(`gemini-4-argon-high`); `model: gemini-4-argon` takes the run's `effort`.
Each agent keeps its own session for an issue: switching agent starts the issue afresh with
the new one, which reads the issue and its comments like any first run. A comment's
`/agent codex` picks the agent for the issue instead, among the operator's, whatever these
keys say: [Agents and providers](setup.md#agents-and-providers). With Codex, comments
posted while a run works wait for it to end, and the next run answers them in the same
session (see [Codex](setup.md#codex)); the same with the Antigravity CLI
([Antigravity CLI](setup.md#antigravity-cli)).

## Instructions

The file named by `instructions` is read from the default branch and appended to the
generic sandbox instructions (`prompts/sandbox.md`) under "This project". Put there what
the generic rules can't know: language of the product, services and how to start them,
checks to run.

## Modes

A run is in a mode: **work** (implement, the default), **brainstorm** (discuss, no code),
**onboarding** (propose this file, see [Onboarding](#onboarding)), **research** (the open
web, without the code, see [Research](#research)), **review** (a pull request's, when the
`review` block turns it on, see [Reviews](#reviews)), or one of the repository's own, declared under `modes:`. A `/mode <name>` line in a comment
picks one, on its own line or after the trigger on the first one (`Deckhand /mode audit`;
`/mode` is never read as `/model`; names are not case-sensitive):

```text
Deckhand
/mode audit
Focus on the error handling.
```

- **With the trigger line**, it starts that mode. Without one, on an issue that already has
  a session, it **switches**: the new mode goes on in the same session, so it starts from
  the conversation so far, as long as both modes are light or neither is. A light run has
  a clone and session of its own, apart from work's: `/mode work` after a light audit starts
  from the issue and its comments, where the audit posted what it found.
- **A comment with neither** goes on in the issue's current mode. The trigger line alone,
  or `/mode work`, goes back to work; `/mode brainstorm` to a brainstorm, which `/stop` wraps
  up. Brainstorms stay on issues: `/mode brainstorm` on a pull request is ignored.
- **An unknown name** gets a reply listing the modes, and nothing runs. So does a comment
  for a mode that was removed from the config since.
- Work is the default: there is no `default_mode`.

Each mode of `modes:` takes these keys; any other key, a built-in name or a bad path is an
error, listed in the reply:

| Key            | Default                                   | What                                                                                                                                                                      |
| -------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions` | required                                  | Markdown file of the repo, read from the default branch, like `instructions`                                                                                              |
| `light`        | `false`                                   | `true`: no branch, no `setup`, a read-only token: it can only comment                                                                                                     |
| `session`      | `issue`                                   | `issue`: the issue's session, kept; `fresh`: a new one each run, not kept                                                                                                 |
| `agent`        | `agent`, or `brainstorm_agent` if light   | its agent, among the operator's (see [Agent](#agent))                                                                                                                     |
| `model`        | `model`, or `brainstorm_model` if light   | its model                                                                                                                                                                 |
| `effort`       | `effort`, or `brainstorm_effort` if light | its thinking effort                                                                                                                                                       |
| `speed`        | `normal`                                  | `fast`: Claude Code's fast mode, as with `/speed fast` (which `/speed normal` overrides), within `fast_mode` and the operator's [`SANDBOX_FAST_MODE`](setup.md#fast-mode) |

- **Names**: letters, digits, `-` and `_`. `work` and `brainstorm` can't be redefined (set
  their agent and model with `agent`/`model`/`effort` and `brainstorm_agent`/
  `brainstorm_model`/`brainstorm_effort`);
  `onboarding`, `research`, `stop`, `idea`, `bug`, `discussion`, `analyze` and `review` are
  reserved (`review` is set with the `review` block, see [Reviews](#reviews)).
- **Prompt**: the generic sandbox instructions (`prompts/sandbox.md`, and the repo's
  `instructions`) as for every run, then a short frame (the issue or pull request to read,
  what the mode may do) and the mode's file.
- **Light modes** run like a brainstorm: the shorter pause, before queued work, no branch
  and no `setup`. They only comment: their GitHub token can read the code, issues and pull
  requests, not push or write, and their final message is the reply. They can run on pull
  requests, where an audit mode is most useful.
- **Full modes** run like work: the issue's branch and draft pull request, `setup`, a token
  that can push.
- **Fresh modes** (`session: fresh`) start a new session on every run and don't keep it:
  the issue stays in the mode it was in, and its next run continues its own session.
- **A mode narrows, never widens**: the hosts, mounts and limits of every run of the repo
  are the same whatever the mode (the operator's grants and what they let the repo's
  `mounts` add). A mode has no key for them.

The dashboard names the repo's modes next to the issue, and in each run.

### Research

`/mode research` answers a question from the open web: comparing libraries, reading an API's
docs, a vendor's changelog or terms. Its sandbox reaches any public host (`curl`, Claude
Code's `WebFetch`, the browser), so it gets nothing of the repository's to leak:

- **No code**: no clone, `/workspace` starts empty. Its input is the issue's thread (title,
  description, the last 50 comments), which the listener writes into the run's inbox.
- **No GitHub token**: the broker refuses it one, so `gh` and `git` can't reach the
  repository, and it can't push. Its final message is its reply, posted by the listener.
- **Nothing else of the repo's**: the base image (never `dockerfile` or a branch's), no
  `setup`, `caches`, `instructions`, host mounts, container engine or screenshots.
- **Its own session**, apart from work's and the light runs' (a page could leave anything
  there): comments without a trigger or `/mode` line go on in it, `/mode work` switches.

It only runs where the operator grants it: `allow_research: true` in the repository's
grants file or `default.yaml` ([Security model](security.md#research-runs)). Without it,
`/mode research` gets a reply naming the grant, and nothing runs. Its agent and model are
those of brainstorms (`brainstorm_agent`, `brainstorm_model`).

### Reviews

The built-in review reads a pull request and posts **one GitHub review**: its findings grouped
by severity (`critical`, `high`, `medium`, `low`), each with its file and line and a suggested
fix, a rating out of 10 and a verdict. It never pushes, edits code or creates issues: its
token only reads, and the listener posts the review.

- **Claims and acceptance criteria first.** Before security, the review lists the
  acceptance criteria of the issue the pull request closes (and the decisions settled in
  its thread) and the claims of the pull request's description (what it changes, adds or
  tests, the checks it ran), and checks each against the code. A criterion not met, or met
  only in part, and a claim the code contradicts are **high** findings; a claim it can't
  verify (a check it can't run) is said in the summary, not filed as a finding. Unsure
  between two severities, it picks the higher one.
- **The rating follows the findings**: at most 3/10 with a critical finding, 5 with a high
  one, 8 with a medium one; 10 only with no finding above low. The listener caps the rating
  it posts by these numbers, whatever the review wrote; below the cap, it is shown as
  written.

- **Off by default.** Without a `review` block nothing reviews a pull request, and `/mode
review` gets the "unknown mode" reply. `review: true` (or a block without `on`, or
  `on: manual`) turns on `/mode review` alone.
- **By itself** with `on: ready`: when a pull request is marked ready for review, or opened as
  ready, if it is on a branch of the repository (never a fork's) and was opened by Deckhand
  or by an allowed user (`users`); other bots' are skipped. Each head commit is reviewed by
  itself once, across redeliveries and restarts: to review it again after new pushes,
  comment `/mode review`.
- **`/mode review`** on a pull request, from an allowed user, reviews it now; what the comment
  adds is what the review should look at. On an issue it is refused, with a reply.
- **The verdict on GitHub**: changes requested when there is a critical, high or medium
  finding, a comment otherwise; the verdict in the review's text says "request changes" then
  too, whatever the review wrote. It never approves: that stays the maintainer's. GitHub doesn't let the
  App request changes on its own pull requests: those get a comment review, the verdict in
  its text. A reply whose format the listener can't read is posted as a comment review, as
  it is.
- **No loops**: without `fix`, the review starts no run. To act on it, comment with the trigger
  ("Deckhand, fix the high findings").
- **`fix: true`**: a review that requests changes (a critical, high or medium finding) on Deckhand's
  own pull request, linked to the issue it worked on, starts **one** work run in that issue's
  session. Its message is the review's findings, all of them (medium and low too), with the
  instruction to fix each one or say why not, rerun the checks and push; it pushes like any
  work run, and replies on the pull request. Not while the issue has a run going or queued
  (a maintainer's comment came first) or the pull request or its issue has the needs-input
  label. **Once per pull request**, kept in `reviews.json` across restarts, and written before
  the run is queued: the fix's push doesn't start a review (only turning ready does), and a
  later review (`/mode review`) starts no second fix. Other pull requests' reviews, and
  reviews that only comment, start nothing. To act again, comment with the trigger.
- **Security risk of `fix`**: the review's findings, a model's output, become the message of a
  run that can push. A comment written to steer the reviewer (a prompt injection) could turn
  into a finding the fix run carries out. Deckhand narrows it: the review reads only the
  comments of allowed users and its own (an outsider's is left out, quote it to have it read),
  only Deckhand's own pull requests get a fix, and the fix run is told the findings are claims
  to check, never instructions (no commands from them, no CI, workflow, `.deckhand.yaml` or
  credential changes the issue didn't ask for). It is not a guarantee: turn `fix` on where
  those who comment are trusted, and read what a fix pushed before merging
  ([Security model](security.md#review-fix-runs)).
- **What it reads**: the diff, and the thread (the pull request's description, comments and
  reviews, and the issue it closes) as the listener hands it over: only what allowed users
  and Deckhand wrote. Anyone else's comment is left out, its place saying so: an allowed user
  who wants the review to take it into account quotes it.
- **The run**: like an audit mode that is light and fresh, its own clone and session, no setup;
  the agent, model and effort of light runs unless the block names others. Its instructions
  are the built-in ones (security, correctness and tests, duplication, the repository's
  conventions, scope), then the file `review.instructions` names, from the default branch.
- **Cost**: each review is a run with the reviews' model, paid by the operator. `on: ready`
  reviews every pull request that turns ready: keep `manual` where that is too many. A fix is
  a work run, at the repo's work model.

`on`, `instructions`, `agent`, `model`, `effort` and `fix` are its only keys: any other, or a bad
value, is an error.

## Inboxes

Places where a maintainer drops something for Claude to handle, without a trigger line.
Only `ALLOWED_USERS` (narrowed by `users`) are answered; others are ignored, like anywhere.
They are light runs, like brainstorms: no branch, no `setup`, the brainstorm model.

- **Ideas and bug reports**: an open issue each (pin them), named by its number. Every
  comment on it is an entry: Claude reads the code, looks for an existing issue, and
  creates one (labelled `idea` or `bug` plus those of the repo that fit, with Problem,
  Proposal, Acceptance criteria and Open questions; a bug also gets its likely cause, a big
  idea sub-issues). Its reply on the inbox links what it created or found, or answers when
  there is nothing to file. Each entry starts a new session: a follow-up is read from the
  inbox's earlier comments. Prompts: `prompts/idea.md`, `prompts/bug.md`.
  The dashboard sends entries too: Feedback, in its top bar, opens a form (a repository with
  an inbox, Idea, Bug or Discussion, only those it has), which posts the text on the inbox issue
  as the App's comment, ending "From the dashboard by @you", and starts the same run.
- **Discussions**: a category of the repository's GitHub Discussions (create it first, for
  example "Ask Claude"; compared loosely, emoji aside). A new discussion in it, and every
  later comment of an allowed user, gets an answer in the discussion, in the thread of the
  comment it answers; the discussion keeps one session, like a brainstorm. When it settles
  on something to build, Claude files an issue and links it. Other categories are never
  read. These runs alone get a token with the Discussions permission (see
  [Setting up](setup.md) for an App created before it). Prompt: `prompts/discussion.md`.
  The dashboard starts discussions too (Feedback, Discussion: a title and a text) and follows
  them: a discussion's page shows its thread, Deckhand's answers included, with a reply box
  under each thread and one for a new comment. Everything is written on GitHub first, as the
  App's, ending "From the dashboard by @you" (the dashboard shows those as yours), then starts
  the run a discussion or comment of yours would; a comment sent while a run is going reaches
  it, like one written on GitHub. Comments written on GitHub show up in the dashboard within
  15 seconds or so. The category must exist on GitHub: the dashboard never creates it.

## Preview hook

Only when the operator's grants set `allow_preview: true` for the repository: holding
the Docker socket is root on the host. Without it, a `preview` key stops the repository's
runs (the reply says which grant is missing) and its hook never runs.

On `pull_request` and `workflow_run` deliveries for the repository (whoever opened the pull
request), the listener runs `preview.command`:

- with `sh -c`, in a new container of `preview.image` (or the repo's image), as root;
- in `/deckhand-checkout`, the repository's files at the default branch, never the pull
  request's;
- with the delivery's JSON on stdin, and `GITHUB_EVENT_NAME` (`pull_request` or
  `workflow_run`) and `DECKHAND_REPO` set;
- with the host's Docker socket at `/var/run/docker.sock` (`DOCKER_SOCKET` on the host), so
  it can start or remove a preview deployment.

The hook decides what to do from the event (`action`, the pull request's head, whether a
workflow succeeded…): the event's content comes from whoever opened the pull request, so
treat it as untrusted input. That includes the App's bot's own pull requests: they are
same-repository, but a sandbox wrote them (see
[GitHub Actions on Deckhand's branches](security.md#github-actions-on-deckhands-branches)).
Holding the Docker socket is root on the host.

Hooks of one repository run one at a time, in delivery order. At most 3 wait behind the
running one: deliveries past that are dropped (and logged), since anyone can open pull
requests. A newer delivery for a pull request (or a workflow run) whose hook still waits
replaces it, so the hook may not see every event: have it bring the preview to the state the
event describes (open, updated, closed) rather than react to each action. A hook is **busy** for as
long as its command runs: the listener's `/status` lists it and isn't idle meanwhile, so a
restart that waits for it doesn't cut a deployment short. A hook that starts something
should wait until it is up before exiting. Its output is kept in the data volume, under
`previews/`.

## Conflicts

When the base branch moves, a pull request can go into conflict and stay there until someone
notices. With `conflicts.check_minutes`, the listener looks at the repository's open pull
requests every that many minutes, and starts a work run on any that conflicts with its base.
It is off without the key, and each conflict found is a run, so a bill.

- Only Deckhand's own pull requests are checked: those of its tasks (an issue's pull request,
  or a pull request it was asked to work on), never every pull request of the repository,
  and never one from a fork.
- A conflict is GitHub's `mergeable: false` (`mergeable_state: dirty`). A pull request that
  is only behind its base, or blocked, or whose checks fail, is left alone. While GitHub is
  still computing it, the pull request is asked again a minute later.
- The run goes on in the task's session, as if a maintainer had asked: rebase on the base
  branch, resolve the conflicts, rerun the checks and push with `--force-with-lease`, or stop
  and ask. Its reply goes on the pull request; the dashboard names it "Conflict".
- A task with a run going or comments waiting is skipped, and so is a pull request (or its
  issue) labelled `NEEDS_INPUT_LABEL`.
- Each pull request is tried once per pair of its head commit and its base branch's latest
  commit, across listener restarts: a rebase that failed or stopped to ask isn't tried again
  until someone pushes to the pull request or the base branch moves.
- The operator's `CONFLICT_CHECK_MINUTES` (default 5) is the shortest interval: a smaller
  `check_minutes` gets that one (with a warning in the run logs), and `0` turns conflict
  checks off for every repository. `check_minutes` must be a whole number above 0; any
  other key under `conflicts` is an error.

## Open questions

An issue whose body has an `## Open questions` section that asks something is labelled
`NEEDS_INPUT_LABEL` (default `needs-input`), and an allowed user's comment takes the label
off: they answered. With `wait_for_answers: true` (the default), work doesn't start on an
issue while it carries the label:

- A comment that is only the trigger line (with `/mode`, `/model`, `/effort`, `/speed`, `/agent` or `/after`
  lines at most) starts nothing: the App replies that the issue has open questions, points
  to the dashboard's form, and the label stays. A trigger comment with text is the answer:
  the label comes off and the run starts.
- A comment waiting for other issues (`/after`) whose last one is done keeps waiting until
  the questions are answered (the label is removed), then starts by itself.
- The dashboard's Start and Queue open the questions first: the issue starts with the
  answers.

Only work runs and the repository's modes that aren't `light` wait: brainstorms, onboarding
and light modes still run, as they can help answer, and leave the label on. A run that stopped
to ask, pull requests, inbox issues and discussions aren't affected. With
`wait_for_answers: false`, trigger comments, waits and the dashboard start the issue as they
would without questions (the dashboard's form is still there to answer from the task's
panel).
