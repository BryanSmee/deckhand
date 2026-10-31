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
  fix: true # a work run that addresses a review requesting changes, then a review of its push;
  #           # a number (1 to the operator's MAX_FIX_ROUNDS, 5 by default) for that many rounds
  # merge: true # UNSAFE, no human review: Deckhand merges its own pull request after a clean
  #             # review; needs the operator's allow_auto_merge (see Auto-merge below)
  # merge_method: squash # squash (default) | merge | rebase
  # max_allowed_severity: low # low (default) | medium: the most severe finding a merge allows
  # merge_wait: 60 # minutes a merge waits for the GitHub Actions runs still going (0 to 1440)
  # ci: wait # the review waits for the head commit's GitHub Actions runs; a failure starts a
  #          # CI fix run instead of a review (see CI before the review below)
  # ci_wait: 30 # minutes it waits before it reviews anyway (0 to 1440)
  # ci_fix: 1 # CI fix runs per pull request, with fix (0 to the operator's MAX_FIX_ROUNDS)
  # request: [alice] # reviewers asked on Deckhand's pull request once it is ready, and again
  #                  # after a fix pushed (see Reviewers below); allowed users only

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

# Move this repo's issues on an organization's project (v2) as their work goes (see Projects
# below). Only projects the operator grants it (allow_projects).
projects:
  - project: acme/3 # https://github.com/orgs/acme/projects/3
    field: Status # a single select field; Status by default
    start: In progress # a work run starts on the issue
    ready: In review # its pull request turns ready for review
    merged: Done # its pull request merges
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
| `review.fix`                            | `false`                                 | a review that requests changes starts a work run that addresses it; `true` or a number of rounds (see Reviews)               |
| `review.merge`                          | `false`                                 | **unsafe**: Deckhand merges its own pull request after a clean review; needs `allow_auto_merge` (see Auto-merge)             |
| `review.merge_method`                   | `squash`                                | how an auto-merge merges: `squash`, `merge` or `rebase`, one the repository allows                                           |
| `review.max_allowed_severity`           | `low`                                   | the most severe finding a review in the fix loop or deciding an auto-merge may have: `low` or `medium` (see Auto-merge)      |
| `review.merge_wait`                     | `60`                                    | minutes an auto-merge waits for the GitHub Actions runs still going on the reviewed commit, `0` to `1440` (see Auto-merge)   |
| `review.ci`                             | `false`                                 | `wait`: an automatic review waits for CI, and a failure starts a CI fix run instead (see CI before the review)               |
| `review.ci_wait`                        | `30`                                    | minutes the review waits for the GitHub Actions runs still going before it starts anyway, `0` to `1440`                      |
| `review.ci_fix`                         | `1`                                     | CI fix runs per pull request, with `review.fix`, `0` to the operator's `MAX_FIX_ROUNDS` (see CI before the review)           |
| `inbox.ideas`, `inbox.bugs`             | none                                    | issue numbers whose comments are ideas or bug reports to file (see Inboxes)                                                  |
| `inbox.discussions`                     | none                                    | GitHub Discussions category whose discussions Claude answers (see Inboxes)                                                   |
| `preview.command`                       | none                                    | preview hook command (`preview: ./x.sh` works too); needs the operator's `allow_preview`                                     |
| `preview.image`                         | the repo's image                        | image the hook runs in; it needs a Docker client                                                                             |
| `preview.timeout_minutes`               | `30`                                    | the hook is stopped after that (120 at most)                                                                                 |
| `conflicts.check_minutes`               | none: off                               | minutes between conflict checks, and one soon after a merge; at least `CONFLICT_CHECK_MINUTES` (see Conflicts)               |
| `wait_for_answers`                      | `true`                                  | an issue's work runs wait until its open questions are answered (see Open questions)                                         |
| `projects`                              | none                                    | organization projects (v2) the listener moves the issues on: `project`, `field`, `start`, `ready`, `merged` (see Projects)   |

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
  (through the listener's GitHub gateway), `jq`, `ripgrep`, Node 26, Playwright with Chromium, the
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
`/tmp/screenshots`, `/tmp/deckhand` (the run's screenshots and files; so `/tmp` itself too),
and each agent's session and install
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

A run is in a mode: **work** (implement, the default), **brainstorm** (discuss, no code;
it files the follow-up issues the maintainer keeps, like inbox entries and discussions),
**onboarding** (propose this file, see [Onboarding](#onboarding)), **research** (the open
web, without the code, see [Research](#research)), **review** (a pull request's, when the
`review` block turns it on, see [Reviews](#reviews)), **policy** (a dry run of the
[policies](#a-dry-run-and-the-dashboard), no run), or one of the repository's own, declared under `modes:`. A `/mode <name>` line in a comment
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
  up. Brainstorms stay on issues ([`run.rego`](#the-run-input)).
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
  `onboarding`, `research`, `stop`, `idea`, `bug`, `discussion`, `analyze`, `review` and
  `policy` are reserved (`review` is set with the `review` block, see [Reviews](#reviews);
  `policy` is a [dry run](#a-dry-run-and-the-dashboard)).
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
- **It runs once the repository allows it**: `allow_run if input.mode == "audit"` in
  `.deckhand/policy/` ([Policies](#policies)).

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
  or by an allowed user (`users`). Other bots' (Dependabot's, say) are skipped by Deckhand's
  default [`review.rego`](#the-default-policies), which the operator's `policy/review.rego`
  in the grants folder replaces. Each head commit is reviewed by
  itself once, across redeliveries and restarts: to review it again after new pushes,
  comment `/mode review`. A [policy](#policies) can skip it (`deny_review`).
- **`/mode review`** on a pull request, from an allowed user, reviews it now; what the comment
  adds is what the review should look at. On an issue it is refused, with a reply.
- **The verdict on GitHub**: changes requested when there is a critical, high or medium
  finding, a comment otherwise; the verdict in the review's text says "request changes" then
  too, whatever the review wrote. It never approves: that stays the maintainer's. GitHub
  doesn't let the App request changes on its own pull requests: those get a comment review, the
  verdict in its text. A reply whose format the listener can't read is posted as a comment
  review, as it is. An automatic review in the fix loop, or the one that decides an
  auto-merge, may tolerate medium findings (`max_allowed_severity`, under Auto-merge): its
  prompt says so before it starts.
- **No loops**: without `fix`, the review starts no run. To act on it, comment with the trigger
  ("Deckhand, fix the high findings").
- **`fix: true`**: a review that requests changes (a critical, high or medium finding, above
  `max_allowed_severity`) on Deckhand's own pull request, linked to the issue it worked on,
  starts a work run in that issue's session. Its message is the review's findings, all of them
  (medium and low too), with the instruction to fix each one or say why not, rerun the checks
  and push; it pushes like any work run, and replies on the pull request. Not while the issue
  has a run going or queued (a maintainer's comment came first) or the pull request or its
  issue has the needs-input label. With `merge`, once it is over, the listener reviews the
  commit it pushed (a review that starts by itself, so `deny_review` applies), which decides
  the merge; without `merge`, `fix: true` stops there, as one fix run leaves nothing for
  another review to start.
- **`fix: <n>`**: the same, as a loop of up to `n` fix runs (1 to the operator's
  `MAX_FIX_ROUNDS`, 5 by default; `true` is 1). Round 1 is review, fix, review; each later
  round is fix, review, the fix run told which round it is and, from the second on, that the
  earlier fix didn't clear the findings. Each fix run's push is reviewed, with or without
  `merge`. The loop stops when:
  - **the threshold is met**: the last review has no finding above `max_allowed_severity`
    (`low`, the default: no critical, high or medium finding; `medium`: no critical or high
    one). That review is posted as a comment and starts no fix run;
  - **the rounds run out**: after `n` fix runs, the last review still has findings above it. A
    "No more fix runs" comment names their severities and the number of fix runs (with
    `merge`, the "Not merged automatically" comment says it instead);
  - **a fix ends badly**: it failed or pushed nothing (its push isn't reviewed), or a
    [policy](#policies) refused the fix (`deny_fix`, a comment says why) or the review after
    it (`deny_review`);
  - **something else takes over**: the issue has a run going or queued, or the needs-input
    label.

  **Bounded**: `n` fix runs and `n` reviews after them at most per pull request (`fix: true`
  without `merge`: one fix run, no review after it), each counted
  in `reviews.json` before it is queued, across restarts: the fix's push doesn't start a
  review by itself (only turning ready does, and the listener's review of it), and a later
  review (`/mode review`) starts no fix past the count. Other pull requests' reviews, and
  reviews that only comment, start nothing. To act again, comment with the trigger, or use
  the dashboard's buttons (below). A `/mode review` a maintainer asks for isn't part of the
  loop: it tolerates nothing, and may start a fix run while rounds are left.

- **From the dashboard**: once a pull request's loop is over (rounds out, stopped, fixed, CI
  failed, or clean), its task page offers, in its Review loop section:
  - **Review** (Shift R): a review of its head now, even a head already reviewed. It is the
    dashboard's `/mode review`: the App comments "Review from the dashboard by @you" on the
    pull request, then the review runs as that comment's would.
  - **Fix** (Shift F), with `fix` on, on a pull request ready for review, when the last review
    left findings above `max_allowed_severity`: one fix run on the findings of the App's
    latest review on the pull request, read back from GitHub, with the loop's message. A round
    left (a fix that failed or pushed nothing) is used; with the rounds used up, each click
    grants one round more, never a new loop. The App comments "Fix round 4 from the dashboard
    by @you: 2 high findings left" (edited to say so if it is refused after that), and the
    fix's push is reviewed like any round's, even with `fix: true` and no `merge`; with
    `merge`, that review decides the auto-merge again. The round is counted in `reviews.json`
    before the run is queued: a second click or a restart starts no second one. Only on
    Deckhand's own open pull request linked to its issue, with nothing running or queued, no
    needs-input label, the loop not going on (no review, CI or checks awaited), and GitHub's
    latest review the loop's last; `deny_fix` applies, its refusal shown on the dashboard.

  A review a maintainer asks for (`/mode review`, or Review) on a pull request whose loop the
  dashboard shows is listed in its history as the latest round, its blocking findings counted
  with the loop's own tolerance (`max_allowed_severity` with `fix` or auto-merge), so the
  buttons follow it, and a CI step that stopped without a review shows it. It still isn't a
  loop round: it counts no fix run, tolerates nothing itself, and may start a fix run while
  rounds are left. Both requests are refused, the dashboard saying why, for someone outside
  the repo's `users`, a closed pull request, or one with a run going or queued.

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
  a work run, at the repo's work model: each round of `fix` is one work run plus one review
  run, so `fix: 3` can cost up to four reviews and three work runs per pull request.

`on`, `instructions`, `agent`, `model`, `effort`, `fix`, `merge`, `merge_method`,
`max_allowed_severity`, `merge_wait`, `ci`, `ci_wait`, `ci_fix` and `request` are its only
keys: any other, or a bad value, is an error.

#### Reviewers

`request: [alice, bob]` asks people to review Deckhand's pull requests, so a pull request that
turns ready doesn't wait for someone to notice it. A run never picks who gets notified: the
listener requests them itself, with its own token (runs still can't use `gh pr create
--reviewer` or `gh pr edit --add-reviewer`).

- **Who**: the logins listed, lower-cased, a leading `@` dropped, only those in the operator's
  `ALLOWED_USERS` (the others are ignored, with a warning in the config check). Never a team
  (`org/team` is an error), never the pull request's author.
- **When**: Deckhand's own pull request (opened by the App, on a branch of the repository)
  turns ready (marked ready, or opened as ready), and again when a run that pushed to it
  ends well while it is ready (a fix run, a CI fix run, a conflict rebase, a follow-up a
  maintainer asked for): what they reviewed changed. A run that pushed nothing, failed, was
  stopped or stopped to ask (its `WIP:` commit is unfinished work) asks nobody. Each head commit
  is decided once, across redeliveries and restarts (`requested.json`): requested, refused by
  a rule, or refused by GitHub (`422`). A failure (GitHub's `5xx`, a `policy error`) is asked
  again at the next delivery or run's end.
- **Independent of the review**: it works with `review: { request: […] }` alone (which also
  turns on `/mode review`), with or without `on: ready`, `fix` or `merge`.
- **A [policy](#policies) can refuse it** (`deny_request_review`), keyed on the mode of the
  run that opened the pull request (a later follow-up in another mode doesn't change it).
  [Deckhand's default](#the-default-policies) requests them on
  work runs' pull requests, and on those of the repository's own modes it allows
  (`allow_request_review`).
- **GitHub decides the rest**: a login that isn't a collaborator makes GitHub refuse the
  request (the listener's log says so); requesting someone who already reviewed asks them
  again, which is the point after a fix.

Requesting a review notifies people: keep the list to those who want every one of Deckhand's
pull requests.

#### CI before the review

With `ci: wait` (and `on: ready`), an automatic review waits for the repository's CI first: a
failing CI then costs a cheap CI fix run instead of a full review that misses the failure. The
listener decides each step itself, without a model call, from the GitHub Actions runs on the
pull request's head commit (other checks and commit statuses aren't read, as for auto-merge):

- **Waiting**: when a review would start (the pull request turned ready, or a fix run pushed),
  nothing is queued while runs are going. The listener decides again when a run completes on
  that commit (a `workflow_run` delivery), and every 5 minutes for a lost one; the wait
  survives a restart. A push while it waits moves the wait to the new head commit: runs
  completing on the old one decide nothing. Without any run yet, it waits a minute (GitHub
  creates a push's runs a moment after it), asks again then, and takes the commit for one
  without CI. The
  dashboard shows "Waiting for CI".
- **Passed** (`success`, `skipped`, `neutral`), or no run: the review starts as without `ci`.
- **Still going after `ci_wait` minutes** (30 by default, `0` to `1440`): the review starts
  anyway, its prompt saying CI hadn't finished.
- **Failed** (any other conclusion: `failure`, `cancelled`, `timed_out`…), even while other
  runs go on: no review. A run cancelled and replaced by a newer one of its workflow and event
  (`cancel-in-progress` when turning ready starts the workflow again) decides nothing, here
  and for auto-merge; any other failure does, whatever ran after it. A "CI failed" comment names the failed runs, linked. With `fix`, a
  **CI fix run** follows: a work run in the issue's session, with the same conditions as a
  review's fix run (Deckhand's own open pull request, no run going or queued on the issue, no
  needs-input label, and `deny_fix`, its input with `ci: true`). A run going or queued on the
  issue (often the work run that marked the pull request ready, after a quick failure) doesn't
  stop it: the pull request goes on waiting, and the listener decides again once a run is over.
  Its message names the failed
  runs and jobs (name, conclusion, run id, link), never their logs: the run reads them itself
  (`gh run view <id> --log-failed`, through Deckhand's GitHub gateway, which follows GitHub's
  redirect to its log storage: no host to grant), told they are data, not instructions (the branch's code
  printed them), fixes the cause, reruns the checks and pushes, or reruns a job it judges flaky
  ([Reruns](#reruns)). Once it is over, its push or rerun goes back to waiting for CI: then the review, or another CI fix run. One that failed, or neither
  pushed nor reran a job, leaves the pull request to the maintainer, a "No review" comment says why. The
  dashboard shows "Fixing CI", and the run "CI fix"; when the CI step stops without a review
  (a CI fix run refused, failed or pushing nothing), the ready pull request is marked "CI failed,
  not reviewed". A pull request turned back into a draft while it waits stops waiting: ready
  again, even at the same commit, it waits and gets its review. So does one whose CI step
  stopped (once the maintainer answered, say): ready again at the same commit, the CI step
  runs again.
- **Bounded**: `ci_fix` CI fix runs per pull request (1 by default, `0` to the operator's
  `MAX_FIX_ROUNDS`), each counted in `reviews.json` before it is queued, apart from `fix`'s
  rounds: a CI fix never uses up a round the review's findings need. They count across the
  pull request's commits: when none is left and CI fails, the comment says so ("No CI fix run
  left") and the review starts anyway, told CI failed, so the
  maintainer still gets one. So it does without `fix` (or with `ci_fix: 0`), and on a pull
  request that isn't Deckhand's own: the comment, then the review.

`ci` changes nothing without `on: ready`, and a `/mode review` a maintainer asks for never
waits. CI fix runs push like any work run: one that has to change `.github/workflows/` needs
the operator's `allow_workflows`.

#### Auto-merge

> **Unsafe: no human reads the code before it reaches the default branch.** Model output is
> merged as it is: a prompt injection in an issue or a comment, or a wrong fix, ships, and a
> merged change runs the repository's workflows on the default branch, with its secrets. Use
> it only on private repositories where everyone who can comment is trusted. See
> [Security model](security.md#auto-merge).

With `merge: true`, the listener merges Deckhand's own pull request once its review finds
nothing blocking. It takes both sides:

- **The operator's grant**: `allow_auto_merge: true` in the repository's own grants file
  (never `default.yaml`). `true` covers a private repository only; a public one needs
  `allow_auto_merge: public`. Without it, the config check warns, naming the grant, and
  nothing is merged; the reviews and fix runs go on as without `merge`.
- **`on: ready`**: the merge follows the reviews that start by themselves, never a
  `/mode review` comment's. Without it, the config check warns and nothing is merged.
- **With a [preview hook](#preview-hook)** granted (`allow_preview`), the operator's
  `acknowledge_automerge_and_preview_is_highly_dangerous: true` too, in the repository's own
  grants file. The hook runs the default branch's files as root on the host, and the
  trusted-files gate below only sees the hook's command line, not what it runs (a script it
  sources, a `Makefile`, `package.json`, a compose file, what its image `COPY`s). With both
  on, an auto-merged change can reach root on the host with nobody reading it. Without the
  acknowledgement, the config check warns, and each review's merge is refused with a comment.

**The flow**, all in the listener (never in a sandbox, whose token can't merge):

1. The pull request turns ready, and the review runs as usual.
2. Nothing blocking (no critical, high or medium finding; medium allowed with
   `max_allowed_severity`, below): the merge, after the gates below.
3. Blocking findings, with `fix`: the fix loop runs as usual (see Reviews). The review that
   ends it decides the merge (without `fix`, the first review decides it): it merges only
   with nothing blocking, as in step 2.
4. **A review that requests changes never merges**: posted on GitHub as "request changes", or
   whose verdict says "request changes" (the review may ask for it with only low findings), it
   leaves the pull request to the maintainer with a "Not merged automatically" comment.
5. Anything else leaves the pull request to the maintainer, with a comment saying why: a review
   that still blocks, a fix run that failed or pushed nothing, a gate that refuses, a GitHub
   call that fails, a merge GitHub refuses. **Bounded**: at most `fix`'s number of fix runs
   and a review after each, and one merge decision per pull request, kept in `reviews.json`
   across restarts.

**`max_allowed_severity: medium`** lets every automatic review in the fix loop, and the one
that decides the merge, have medium findings: its prompt tells it so (medium findings still
reported, and still capping the rating at 8, but its verdict "comment" and its summary saying
they don't block), the review is posted as a comment rather than "request changes" (a
"request changes" verdict on medium findings only reads "comment" too, should the review
write one anyway), starts no fix run, and merges, the medium findings left as its comments
for the maintainer. So with `fix` too, a review with only medium (and low) findings spends no
fix run on them: the loop stops there. Without `merge`, it is the fix loop's threshold alone.
Critical and high findings always block, and a "request changes" verdict with only low
findings still does. `low`, the default: any medium finding blocks.

**The gates**, asked of GitHub right before the merge; each refusal is a comment:

- the pull request is Deckhand's own, on a branch of the repository (not a fork's), linked to
  its issue; it is open, not a draft, and neither it nor its issue has the needs-input label;
  its issue has no run going or queued;
- its head is still the commit the review read;
- the repository is private, or the grant says `public`, as GitHub says at that moment;
- it changes none of the files Deckhand trusts: `.deckhand.yaml`, `.deckhand/`, `.github/`,
  any `CODEOWNERS`, and the files the config names (`instructions`, `dockerfile`, the words of
  the preview hook's command that are paths, `review.instructions`, the modes' instructions),
  renames included. Merging those by itself would let a run widen its own config: such a
  pull request always waits for a human. GitHub lists 3000 changed files at most: a pull
  request with more than it lists is refused;
- a granted preview hook only with the acknowledgement above;
- `mergeable_state` is `clean`, and its GitHub Actions runs on the head commit are finished
  with none failed (read with the App's `actions: read`; no new permission). A failed run
  refuses at once, naming it; `dirty` (a conflict) or `behind` too. `unstable` with every
  Actions run passed means a check or commit status that isn't an Actions run (an external
  CI, a bot's status) is pending or failing: the App can't read those, so that refuses too,
  saying so;
- last, the operator's and the repository's [policies](#policies) (`deny_merge`): any message
  refuses the merge, and the comment quotes it.

**Checks still running.** The review's push (or the fix run's) starts CI at the same time as
the review, so CI longer than the review is still going when it ends. When Actions runs still
going are all that stands in the way (`mergeable_state` `clean`, `unstable`, `blocked` or
still `unknown`), nothing is posted: the pull request waits, in `reviews.json` (across
restarts), and the gates are asked again each time an Actions run completes on the reviewed
commit (the App's `workflow_run` deliveries), and every 5 minutes for a lost delivery. They
merge it once every run passed and it is `clean`, or refuse it as above. After `merge_wait`
minutes (60 by default) with runs still going, it is refused once: "its checks didn't finish
in time". `merge_wait: 0` refuses at once, as before. A push after the review still refuses
it, and it is still one decision per pull request.

The merge is `PUT /pulls/{n}/merge` with the reviewed commit as `sha`, so a push after the
review makes GitHub refuse it. A comment then says Deckhand merged it, and why; the dashboard
shows "Merged by Deckhand" on its task and in the graph, a red "Auto-merge: no human review"
badge on the repository, and a red box at the top of its config panel. The listener logs a
warning at start for each repository granted `allow_auto_merge`. The issue is closed by the
pull request's `Closes #n`, as for any merge.

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
  The dashboard sends entries too: New request, in its sidebar, opens a form (Idea or Bug
  report, then a repository with that inbox, a title and details), which posts them on the
  inbox issue as the App's comment, ending "From the dashboard by @you", and starts the same
  run.
- **Discussions**: a category of the repository's GitHub Discussions (create it first, for
  example "Ask Claude"; compared loosely, emoji aside). A new discussion in it, and every
  later comment of an allowed user, gets an answer in the discussion, in the thread of the
  comment it answers; the discussion keeps one session, like a brainstorm. When it settles
  on something to build, Claude files an issue and links it. Other categories are never
  read. These runs alone get a token with the Discussions permission (see
  [Setting up](setup.md) for an App created before it). Prompt: `prompts/discussion.md`.
  The dashboard starts discussions too (New request, Discussion: a title and details) and follows
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
- A conflict run is a fix run too: the [policies](#policies) are asked first (`deny_fix`,
  with [`reason: "conflict"`](#the-review-and-fix-input)). A refusal starts nothing: a "No
  rebase run" comment on the pull request quotes the messages, and the pair counts as tried,
  so it isn't asked again until a push or a new base commit. Refused again for the same
  messages, it isn't said again. A policy error refuses too, except when GitHub couldn't be
  read (the policies, the pull request's files): then nothing starts and nothing is kept, and
  the next check asks again. Without a policy that defines
  `deny_fix` (Deckhand's defaults don't), conflict runs start as before.
- The operator's `CONFLICT_CHECK_MINUTES` (default 5) is the shortest interval: a smaller
  `check_minutes` gets that one (with a warning in the run logs), and `0` turns conflict
  checks off for every repository. `check_minutes` must be a whole number above 0; any
  other key under `conflicts` is an error.
- A merge into the default branch checks the repo's open pull requests about 30 seconds
  later, whatever the interval: a pull request merged on GitHub, a push to the default branch
  (when the App gets `push` events) or Deckhand's own auto-merge. Other base branches wait for
  the interval.
- The dashboard's **Sync** checks now, whatever the interval: for when you see a pull request
  in conflict. It follows the same rules (the opt-in,
  one try per pair, busy and needs-input tasks skipped, `deny_fix`) and says how many rebase runs it
  started. A pull request GitHub is still computing is checked a minute later, as above.

## Projects

Teams that track work on a GitHub project (v2) can have Deckhand move its issues there.
Two things go together:

- **The operator grants the project** in the repository's grants file:
  `allow_projects: [acme/3]` in `grants/<owner>/<repo>.yaml` (never `default.yaml`), as
  `<organization>/<number>`, the number in the project's URL
  (`https://github.com/orgs/acme/projects/3`). A project is outside every repository, so
  only the operator says which repository may write it. Without the grant, nothing is
  written to any project.
- **The repository says what to move**, with `projects:` in its `.deckhand.yaml`:

```yaml
projects:
  - project: acme/3
    field: Status # a single select field of the project, Status by default
    start: In progress
    ready: In review
    merged: Done
```

The listener then moves the items, with the App's own token:

- **`start`**: when a work run starts on the issue (a work run, or one of the repository's
  modes that isn't light; not a brainstorm or any light run), once its checks let it start (a run
  refused, for its config's errors or its agent say, moves nothing), the issue is added to the
  project if it isn't there yet, and its field set to that option. A later work run on it
  sets it again, but for one asked from its pull request (a review's fix run, a comment
  there) and any once its pull request is ready or merged: the issue then stays where the
  pull request's steps put it.
- **`ready`**: when a pull request that closes the issue (`Closes #12`, from a branch of the
  repository, never a fork's, into the default branch, opened by one of the repository's `users` or by Deckhand's bot)
  is opened ready or marked ready for review: the issue and the pull request, which is added
  too.
- **`merged`**: when that pull request merges: both again.

Each step is optional: one without an option moves nothing at that step. Options are matched
by name, whatever their case. A `.deckhand.yaml` with errors moves nothing. A project the
grant doesn't list, a field or an option that isn't there, or a GitHub error never stops a
run: the move is skipped, said in the listener's log and the run's, and the dashboard's config
panel names the projects the grant lacks. A task on a pull request with no issue isn't on any
project.

Runs only **add** items, to a granted project: a work run its issue, its pull request, its
issue's sub-issues and the issues it files (`gh project item-add <number> --owner <org> --url
<url>`, or `gh issue create --project`; not `gh issue edit` or `gh pr edit --add-project`, whose update with empty classic `projectIds` stays refused), a brainstorm the issues it files. They never set an
item's fields, remove or archive items, or change the project. This is the `project` action
of [the GitHub input](#the-github-input); a repository's own modes don't add items unless its
policies allow them (`allow_github`, [the default policies](#the-default-policies)).

Projects need the App's **Organization projects: Read and write** permission, accepted on the
organization's installation ([setup](setup.md)); a project owned by a user can't be reached by
a GitHub App at all.

## Policies

Rules of your own, written as code in [Rego](https://www.openpolicyagent.org/docs/policy-language)
(Open Policy Agent), for what the built-in gates don't cover: "a human merges any pull
request over 400 lines", "nothing under `migrations/` is merged by itself", "a medium finding
in payments code blocks". They run after every built-in gate, which they never pass. **A
decision is allowed when an allow rule matches and no deny rule does**: a deny always wins.

```rego
# .deckhand/policy/merge.rego (default branch)
package deckhand

deny_merge contains msg if {
  input.pr.additions + input.pr.deletions > 400
  msg := "more than 400 changed lines: a human merges this one"
}

deny_merge contains msg if {
  some f in input.pr.files
  startswith(f.path, "migrations/")
  msg := sprintf("it changes %s: migrations wait for a human", [f.path])
}

deny_merge contains msg if {
  some f in input.review.findings
  f.severity == "medium"
  startswith(f.path, "src/payments/")
  msg := sprintf("medium finding in payments code: %s:%d", [f.path, f.line])
}

deny_merge contains "labelled do-not-merge" if "do-not-merge" in input.pr.labels
```

**The files**: every `*.rego` file of `.deckhand/policy/` on the default branch (not its
subfolders), in package `deckhand`; a file in another package is a library its layer's files
can import. **Two layers**, evaluated by one `opa`, the repository's packages moved under
`deckhand_repository` (its `data.` references too): neither can define the other's rules. A
repository's file must start with `package …`, after comments only, and use `sprintf()`, not
template strings (`$"…"`):

- **The operator's**: [Deckhand's defaults](#the-default-policies), in the listener's image,
  under the operator's grants folder `policy/` ([security model](security.md#policies)), where
  a file **with the same name** replaces Deckhand's (one with only `package deckhand` drops it).
  Its allow rules are the ceiling: Deckhand's `allow.rego` allows every decision.
- **The repository's**: its deny rules apply to every run; its allow rules count only for its
  own `modes:` (`custom_mode`), whose runs need **the operator's allow and its own**. Its allow
  rule for a built-in mode's run is ignored (for `merge`, `review` and `fix`, a config check
  error). Its file named as one of Deckhand's or the operator's replaces nothing (a warning).

When only Deckhand's files apply, allowing the decision and none defining its deny rule, no
`opa` runs (and the task's page keeps nothing); for `run`, the listener decides as `run.rego`
would. The repository's folder is listed once, then
again after a push to its default branch (or 10 minutes).

<!-- modes.rego: test/linked-branch.test.mjs evaluates this block with the real opa -->

```rego
# .deckhand/policy/modes.rego
package deckhand

# The repository's modes `plan` and `docs` run and write; `plan` links a branch.
allow_run if input.mode in {"plan", "docs"}

allow_github if input.mode in {"plan", "docs"}

allow_link_branch if input.mode == "plan"

deny_github contains "review threads stay open here" if input.action == "resolve"
```

**The rules**: two per decision: `allow_<decision>`, true when it allows (`allow_merge if …`),
and `deny_<decision>`, a set of strings, the reasons shown to the maintainer. A decision no
allow rule matches is refused with a reason from its input (`no rule allows \`comment\` on
\`other_issue\` for a \`brainstorm\` run`; `no rule of .deckhand/policy/ allows …` for the
repository's). Seven decisions:

| Rule                  | When                                                                                                                                                                                                | A message does                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deny_run`            | A [run a person asks for](#the-run-input), before it is queued.                                                                                                                                     | Starts nothing: a reply quotes the messages.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `deny_merge`          | An [auto-merge](#auto-merge), after every other gate passed, right before the merge. Only with `review.merge` and its grant.                                                                        | Refuses the merge: the "Not merged automatically" comment quotes the messages (5 at most, 200 characters each).                                                                                                                                                                                                                                                                                                                                                 |
| `deny_review`         | A review that starts by itself ([`review.on: ready`](#reviews)), after its own checks, and the review after each fix run. Never a `/mode review` a maintainer asked for.                            | Skips the review: the listener's log says why, nothing is posted; a policy error (not a rule's message) is asked again 10 seconds later first, then, on a pull request that turned ready, 5 minutes apart, 3 times. After a fix run, the fix loop stops; in auto-merge mode the merge waits for a maintainer, the "Not merged automatically" comment quoting the messages.                                                                                      |
| `deny_fix`            | A [`review.fix`](#reviews) run, a [CI fix run](#ci-before-the-review), or a [conflict](#conflicts)'s rebase run, after its own checks, right before it is queued (`input.reason` tells them apart). | Starts no fix run: a "No fix run" comment on the pull request quotes the messages. With `review.merge`, nothing is merged: the refusal quotes them too. The round isn't used: a later review may start it. A CI fix run refused: the "CI failed" comment ends with "No CI fix run" and the messages, no review runs, and its round isn't used either. A conflict run refused: a "No rebase run" comment quotes them, and that head and base aren't tried again. |
| `deny_link_branch`    | A work run on an issue that has no branch yet, as it starts: the listener creates the run's `issue-<n>-…` branch and [links it to the issue](#the-linked-branch-input).                             | Links no branch: the sandbox creates its branch itself, unlinked, as before, and the run's log quotes the messages.                                                                                                                                                                                                                                                                                                                                             |
| `deny_request_review` | The [reviewers](#reviewers) of `review.request`, before the listener requests them on Deckhand's ready pull request, and again after a fix pushed to it.                                            | Requests nobody at that head commit: the listener's log says why, nothing is posted.                                                                                                                                                                                                                                                                                                                                                                            |
| `deny_github`         | Each write a run makes to GitHub (a comment, an issue edit, a label…), REST or a GraphQL mutation's field, after [its mode's ceiling](#the-github-input).                                           | Refuses the write: GitHub's error shape with the messages, which `gh` prints to the agent, and a line in the run's log.                                                                                                                                                                                                                                                                                                                                         |

Each has its allow rule (`allow_merge`…). Another `allow_*` or `deny_*` rule is reported by the
config check, as probably misspelled. The grants' `allow_*` keys (`allow_auto_merge`…) are
settings, not rules.

**Fail closed**: a policy that doesn't compile, takes more than 2 seconds, or makes an allow
rule anything but a boolean or a deny rule anything but a set of strings refuses the decision,
with a single `policy error: …` reason, whatever the other layer says. So does a policy folder
that GitHub can't list. The onboarding pull request's config check compiles its branch's
policies and reports their errors.

**What a policy can call**: Rego's builtins, without those that read the environment, the
network or the listener's files (`opa.runtime`, `http.send`, `net.*`, `json.match_schema`,
`json.verify_schema`) and `trace`: a policy decides from its input only. `time.now_ns()` works, so "not on Fridays" does.

<!-- onboarding: skip (listener/prompts.mjs leaves the inputs out of the onboarding prompt) -->

### The run input

`input` of `deny_run`, asked once per run a person asks for, before it is queued (not the
listener's reviews and fix runs): `version`, `decision: "run"`, `time`, `repo` (`"owner/repo"`,
lower case), `mode`, `custom_mode`, `light`, `fresh`, `trigger` (`comment`, `dashboard`,
`inbox`, `discussion`), `continues` (`true` for a comment without a trigger or `/mode` line,
going on in the issue's current mode), `sender` (a login), `target` (where the comment is: `kind`: `issue`,
`pr` or `discussion`, `number`, `labels`, `author`), `issue` (the task's, or `null`) and `pr`
(`draft`, `base`, `head`; else `null`). Deckhand's `run.rego` allows every mode on issues, all
but `brainstorm`, `stop` and `onboarding` elsewhere unless the comment `continues` (the onboarding
pull request's comments go on in onboarding). With Deckhand's files alone and no repository
file, the listener decides as `run.rego` would, without `opa` or reading the comment's issue:
it only lists the repository's policy folder (kept 10 minutes, and kept when GitHub can't list
it again).

### The merge input

`input` of `deny_merge`, read from GitHub at the merge (the pull request, its files, its
issue, its Actions runs) and the review that decides it (`deny_review` and `deny_fix`
[read most of it](#the-review-and-fix-input)):

| Field               | What                                                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`           | `1`: the input's format, raised when a field changes meaning or goes.                                                                                                                                                                                    |
| `decision`          | `"merge"`.                                                                                                                                                                                                                                               |
| `time`              | Now, RFC 3339 in UTC (`"2026-10-26T10:00:00.000Z"`): `time.parse_rfc3339_ns(input.time)`.                                                                                                                                                                |
| `repo`              | `name` (`"owner/repo"`), `private`, `default_branch`.                                                                                                                                                                                                    |
| `pr`                | `number`, `author` (a login), `author_type` (GitHub's account type: `User`, `Bot`), `deckhand` (`true` when the App opened it), `title`, `labels` (names), `base` and `head` (branches), `head_sha`, `draft`, `additions`, `deletions`, `changed_files`. |
| `pr.files[]`        | `path`, `previous_path` (a rename's, else `null`), `status` (`added`, `modified`, `removed`, `renamed`…), `additions`, `deletions`.                                                                                                                      |
| `issue`             | The issue the pull request closes: `number`, `title`, `labels` (names).                                                                                                                                                                                  |
| `review`            | The review that decides the merge: `verdict` (`approve`, `comment`), `rating` (out of 10), `allowed` (`max_allowed_severity`).                                                                                                                           |
| `review.findings[]` | `severity` (`critical`, `high`, `medium`, `low`), `path` and `line` (`null` when the finding names none), `text`.                                                                                                                                        |
| `fixed`             | Whether a fix run came before this review (kept for rules from before `fixes`).                                                                                                                                                                          |
| `fixes`             | How many fix runs came before this review (`review.fix`'s rounds), `0` without any.                                                                                                                                                                      |
| `checks[]`          | The head commit's GitHub Actions runs: `name`, `status`, `conclusion`; without a run cancelled and replaced by a newer one of its workflow and event.                                                                                                    |

### The review and fix input

`input` of `deny_review` and `deny_fix`: the [merge input](#the-merge-input)'s `version`,
`time`, `repo`, `pr` (with `pr.files[]`), `issue` and `review`, read from GitHub when the
decision is made (only when a policy applies), with `fixed` and `fixes` (the fix runs so
far), without `checks`:

| Field      | `deny_review`                                                                 | `deny_fix`                                                                                        |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `decision` | `"review"`.                                                                   | `"fix"`.                                                                                          |
| `issue`    | The issue the pull request closes, or `null` when its description names none. | The issue Deckhand worked on.                                                                     |
| `review`   | `null`: the review hasn't run.                                                | The review that requests changes: `verdict`, `rating`, `allowed`, and its `findings[]`.           |
| `round`    | none.                                                                         | The fix run this would be: `fixes + 1`.                                                           |
| `rounds`   | none.                                                                         | How many fix runs `review.fix` allows (`true`: `1`), with the rounds the dashboard's Fix granted. |
| `ci`       | none.                                                                         | `true` for a [CI fix run](#ci-before-the-review), `false` for a review's fix run or a conflict's. |
| `reason`   | none.                                                                         | Why the fix run would start: `"review"`, `"ci"` or `"conflict"`.                                  |

A CI fix run's input has `review: null` (no review ran), `round` and `rounds` counting the CI
fix runs (`review.ci_fix`), and the head commit's `checks[]` as the merge input has them.

A [conflict](#conflicts)'s rebase run (`reason: "conflict"`) has `review: null` too, and
`round` and `rounds` `null`: it has no rounds. `fixed` and `fixes` count the review's fix runs
so far, and `pr.files[]` is there as for the others. A rule on `input.review.findings`
matches nothing then (`review` is null), so policies written for review fixes refuse what
they refused; one meant for a single kind of fix run checks `input.reason`.

```rego
deny_review contains "work in progress" if "wip" in input.pr.labels

deny_review contains "docs only" if every f in input.pr.files { startswith(f.path, "docs/") }

deny_fix contains msg if {
  some f in input.review.findings
  startswith(f.path, "migrations/")
  msg := sprintf("a finding in %s: migrations are fixed by a human", [f.path])
}

deny_fix contains "conflicts in migrations/ wait for a human" if {
  input.reason == "conflict"
  some f in input.pr.files
  startswith(f.path, "migrations/")
}

deny_fix contains "on hold: no rebase" if {
  input.reason == "conflict"
  "hold" in input.pr.labels
}

deny_fix contains "too large to rebase unattended" if {
  input.reason == "conflict"
  input.pr.additions + input.pr.deletions > 1000
}
```

### The reviewers input

`input` of `deny_request_review`: the [merge input](#the-merge-input)'s `version`, `time`,
`repo`, `pr` (with `pr.files[]`) and `issue`, read from GitHub when the decision is made (only
when a policy applies), with `review: null`, without `fixed`, `fixes` or `checks`, and:

| Field         | What                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decision`    | `"request_review"`.                                                                                                                                                                                                           |
| `reviewers`   | The logins the listener would request: `review.request`, those in `ALLOWED_USERS`, without the author.                                                                                                                        |
| `when`        | `"ready"`: the pull request turned ready (or is asked about for the first time); `"fix"`: a run that pushed to it ended well (not a push of someone else's).                                                                  |
| `mode`        | The mode of the run that opened the pull request (the newest on its task that could push and had started when GitHub created it): `"work"`, or one of the repository's `modes:`; `null` when the listener no longer knows it. |
| `custom_mode` | `true` for a mode of the repository's `modes:`, as in [the GitHub input](#the-github-input).                                                                                                                                  |
| `light`       | That run's `light`: always `false`, a light run pushes nothing.                                                                                                                                                               |
| `reason`      | Why the listener started that run: `"review-fix"`, `"ci-fix"`, `"conflict"`, or `null` for a comment's.                                                                                                                       |

```rego
deny_request_review contains "not on docs-only changes" if {
  every f in input.pr.files { startswith(f.path, "docs/") }
}

deny_request_review contains "the first request only" if input.when == "fix"
```

### The GitHub input

A run's sandbox holds no GitHub token: its calls go through the listener's GitHub gateway
([security model](security.md)). Each **REST write** (anything but `GET` and `HEAD`, whatever
tool sends it: `gh`, `gh api`, curl) is checked there, in this order:

1. **Classified** from its method, path and body into actions on a target. A write it can't
   classify, one outside the run's repository, and one with a query string (GitHub may read
   parameters there too, which the check wouldn't see) are refused.
2. **Its target's kind is read from GitHub**, never from the request: whether it is the run's
   issue, a pull request (its own when it is the run's, or from a branch the run may push),
   a sub-issue of the run's issue (its parent on GitHub, in the same repository), an issue the
   run created (GitHub answered one of the run's own creates with it, over REST or GraphQL's
   `createIssue`, as `gh issue create` sends, and it is no older than that call). A comment,
   by its id, is one the run posted (`created_comment`) or refused before any look-up: see
   [A run's own comments](#a-runs-own-comments). A reaction on a comment has the comment's
   issue or pull request for its target, read from GitHub too: see [Reactions](#reactions).
3. **The mode's ceiling**, built into Deckhand: the most a run of that mode can ever write. A
   write above it is refused before any policy runs; no policy can allow more.
4. **`allow_github` and `deny_github`**, on the input below: the policies can only narrow the
   ceiling.

A sub-issue link (`POST`, `DELETE` or reordering `…/issues/<parent>/sub_issues`) names two
issues: the parent, its target, and the child, by its id: the child must be an issue the run
created, or one already under the run's issue, and moving an issue from another parent
(`replace_parent` with any value but `false`) is refused. A link can't take someone else's
issue under the run's, where its ceiling would let it edit it. The issues the App's bot files
for other runs or for the listener (an analysis, an onboarding issue) aren't the run's, even
while it runs: only the answers to its own calls say what it created, and they are saved with
the run, so a listener restart keeps them. A GraphQL answer counts only under the response
key of a `createIssue` field the gateway parsed, selecting GitHub's own `issue { url }`
(unaliased), and the issue must be the App's bot's.

A "blocked by" link (`POST …/issues/<n>/dependencies/blocked_by` with the blocker's
`issue_id`, `DELETE …/issues/<n>/dependencies/blocked_by/<issue_id>`, or GraphQL's
`addBlockedBy` and `removeBlockedBy`) is a `link` too: its target is the blocked issue, held to
the ceiling as any link's, and its blocker must be an issue the run created, one under the
run's issue, or any open issue of the run's repository (not a pull request, nor another
repository's issue, though GitHub allows those). A REST blocker, named by its id only, is
looked for among the repository's 1,000 newest open issues and pull requests (GitHub lists
them together) past the run's own (GitHub can't
look an issue up by its id); GraphQL's, by its node ID, is looked up wherever it is. A call
without its blocker is refused. The listener reads these links to order a plan
([architecture](architecture.md)): a sub-issue waits on the graph until its blockers close.

A **review thread** is answered with a `reply` (`POST …/pulls/<n>/comments/<id>/replies`, or
GraphQL's `addPullRequestReviewThreadReply`, without a `pullRequestReviewId`: that would put the
reply in a pending review), closed with a `resolve` (`resolveReviewThread`) and opened again
with an `unresolve` (`unresolveReviewThread`). Their target is the thread's pull request, held to
the ceiling as any write to it, so only a work run's own. The thread is read from GitHub by
its first comment: it must be on that pull request (REST's path names both, which may
disagree), and its first comment's author goes into the input (`target.thread`). A new review
(`POST …/pulls/<n>/reviews`) and a review comment that answers no thread (`POST
…/pulls/<n>/comments`, `in_reply_to` included) stay in no ceiling.

**Assignees and milestones** (issue #453) are `assign` and `milestone`: those fields of a REST
create or `PATCH`, `…/issues/<n>/assignees`, GraphQL's `assigneeIds` and `milestoneId`, and its
`add`/`removeAssigneesFromAssignable` and `replaceActorsForAssignable` (what `gh` sends, by
login). Past the ceiling, whatever the policies say, an assignee a run adds must be an allowed
user or the App's bot (an assignment notifies them), never Copilot (`agentAssignment` is
refused too); removals aren't checked. A milestone must be the repository's, looked up.

**GraphQL** (`gh issue create`, `gh issue comment`, `gh issue edit` and most of `gh`'s own
commands) goes through the same checks, field by field:

1. **Parsed and validated** against GitHub's public schema, pinned in Deckhand
   (`listener/vendor/github.graphql`, updated on purpose): a call that doesn't parse or
   validate, one over 2,500 tokens or 64 KiB (gh's are a few hundred) or 10 mutation
   fields (gh sends one), a subscription, and
   a document with several operations and no `operationName` naming one of them are refused.
   A query isn't held to the rule on fields that can't merge, which GitHub doesn't apply
   either (`gh issue view` selects a `state` of two types from an issue or a pull request); a
   mutation is.
2. **Queries go on.** Each field of a mutation, through its fragments and under any alias,
   must be one Deckhand knows (`createIssue`, `createLabel`, `updateIssue`, `addComment`,
   `updateIssueComment`, `deleteIssueComment`, `addSubIssue`,
   `removeSubIssue`, `reprioritizeSubIssue`, `addBlockedBy`, `removeBlockedBy`,
   `addLabelsToLabelable`,
   `removeLabelsFromLabelable`, `addAssigneesToAssignable`, `removeAssigneesFromAssignable`,
   `replaceActorsForAssignable`,
   `closeIssue`, `reopenIssue`, `addReaction`, `removeReaction`, `addProjectV2ItemById`, `createPullRequest`,
   `updatePullRequest`,
   `markPullRequestReadyForReview`, `convertPullRequestToDraft`,
   `addPullRequestReviewThreadReply`, `resolveReviewThread`, `unresolveReviewThread`,
   `updatePullRequestBranch`, `addProjectV2ItemById`), setting only the
   input fields Deckhand checks (no classic `projectIds`, no `parentIssueId` or `issueTemplate`, a sub-issue by its
   `subIssueId` only): any other is refused before any policy runs, even sent as `null`, which
   GitHub may read as clearing it.
3. **Its targets are GitHub's:** the node IDs it names, inline or in its variables, are looked
   up with the listener's token, to a repository, a kind and a number. A create's
   `repositoryId` must be the run's repository, and its labels' IDs labels of it.
4. **Each field is then a write as above**, held to the ceiling and `deny_github` with the
   same input. One refusal refuses the whole call, its message starting with the field's
   response key.
5. **What GitHub gets is the document the gateway parsed**, printed again, never the call's
   own bytes: GitHub runs what was checked.

**A pull request's own writes** (`gh pr create`, `gh pr edit`, `gh pr ready [--undo]`,
`gh pr update-branch`, or REST's `POST` and `PATCH` of `…/pulls` and `PUT
…/pulls/<n>/update-branch`) are in a work run's ceiling only, for its own pull requests
(`own_pr`) and the ones it opens (`new_pr`). Past the ceiling, before `deny_github`: a new one's
head must be a branch of the repository the run may push (not `owner:branch`, another
repository's, or an issue turned into a pull request), an existing one's too before it is
edited (over `…/issues/<n>` too), readied, drafted or has its branch updated, or its token
writes pull requests or contents (a fork's pull request is only commented on and labelled); one
with conflicts isn't made ready; and for a repository granted `allow_workflows`, opening,
editing, labelling, readying, drafting one or updating its branch first checks its workflow
files merged with its base, as a push's are.

**Updating a pull request's branch** (`update_branch`) has GitHub merge the base into it,
without a clone or a force-push. It is a merge only: `gh pr update-branch --rebase`
(`updateMethod: REBASE`, or REST's `update_method`) is refused, since a rebase would rewrite the
commits the git gateway let through. It must name the head it applies to (`expected_head_sha`,
`expectedHeadOid`, which `gh` sends), so GitHub refuses it when the branch moved, and REST's
body may hold nothing else. GitHub refuses one with conflicts: those are still rebased locally
and pushed.

The token behind a run's calls only reads, but for a write that passed these checks: a
brainstorm's or an inbox entry's `issues: write` never reaches anything else. A pull request's
own write gets what GitHub needs for it besides: `pull_requests: write` to open or edit one,
or to reply to, resolve or unresolve one of its review threads, `contents: write` to ready or draft one, or to update its branch.

**An item added to a project (v2)** (GraphQL's `addProjectV2ItemById`, what `gh project
item-add` and `gh issue create --project` send) is a `project` on its content, the target, held
to the ceiling as any write. Past the ceiling, before `deny_github`, its project (looked up
from its node ID) must be one the operator's grants list for the repository
(`allow_projects`): no policy can reach another. Its token gets `organization_projects:
write` for that write alone, and in a granted repository the runs whose ceiling holds `project` (work runs, brainstorms, its modes that aren't light) read the organization's projects (`gh` looks a project up before it adds to it); the others (reviews, inbox entries, discussions, analyses) don't. Setting an item's fields
(`updateProjectV2ItemFieldValue`), removing or archiving one, and the project's own settings
are refused: [the listener moves the items](#projects).

| Mode                                                            | Ceiling                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brainstorm`, `stop`                                            | its issue: `edit`, `comment`, `link`, `react`, `unreact`; its sub-issues: `edit`, `comment`, `link`; the issues it created: `edit`, `comment`, `link`, `project`, `milestone`; new issues: `create`, `milestone`; labels: `create`; other issues and pull requests: `comment`                                                                                                                                                                                                         |
| `idea`, `bug`                                                   | new issues (with the `idea` or `bug` label) and labels: `create`; the issues it created: `link` (the parents it files); its issue: `comment`                                                                                                                                                                                                                                                                                                                                          |
| `discussion`                                                    | new issues: `create`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `onboarding`, `analyze`, `review`, `research`, a light `modes:` | nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `work`, a `modes:` entry that isn't light                       | its issue, its sub-issues and the issues it created: `edit`, `comment`, `label`, `link`, `react`, `unreact`, `project`, `assign`, `milestone`; its pull requests: the same but `link`, and `ready`, `draft`, `update_branch`, `rerun` (a [rerun](#reruns) of their head's failed jobs); the comments it posted: `edit`, `delete`; new issues and pull requests: `create`, `assign`, `milestone`; labels: `create`; its pull requests' review threads: `reply`, `resolve`, `unresolve` |

`react` and `unreact` on an issue or pull request hold for the comments on it too, and
`unreact` only for the reactions the run added ([Reactions](#reactions)).

A run's label writes neither add nor remove `NEEDS_INPUT_LABEL` on its sub-issues and the issues
it created: taking it off would answer their questions and start what waited for them. That
covers the label only: a run that may edit those issues (a work run, a brainstorm) can still
drop their questions section from the description, which the listener takes for an answer too.

No ceiling holds closing or reopening (GitHub closes an issue when its pull request merges),
merging, reviews and their comments (but replies in a thread, and resolving it), assignees and milestones but a work run's and a
brainstorm's (above), moving an issue from another parent, locks, reactions elsewhere (a commit's comment, a
review, a discussion) or removing one the run didn't add, editing or deleting a comment the run
didn't post or a review's, deleting anything else, a label's settings, the repository's
contents (pushes go through Deckhand's git gateway) or settings, or another repository.

`input` of `allow_github` and `deny_github`:

| Field                                                                                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`                                                                                                             | `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `repo`                                                                                                                | `"owner/repo"`, in lower case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mode`                                                                                                                | The run's: `work`, `brainstorm`, `stop`, `idea`, `bug`, `discussion`, or one of the repository's `modes:`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `custom_mode`                                                                                                         | `true` for one of the repository's `modes:`, `false` for Deckhand's own: a rule needn't list the built-in modes, which change as Deckhand adds some. It needs the repository's `allow_github` too.                                                                                                                                                                                                                                                                                                                                                           |
| `light`                                                                                                               | The mode's `light`: `true` for a run without a branch (it can't push), `false` for a work run or a repository mode that isn't light.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `reason`                                                                                                              | Why the listener started the run itself: `"review-fix"` (a review's fix run), `"ci-fix"` (a CI fix run), `"conflict"` (a rebase), `null` for a comment's run. The defaults don't read it: a repository can narrow one of them.                                                                                                                                                                                                                                                                                                                               |
| `issue`                                                                                                               | The number of the run's issue (or pull request).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `action`                                                                                                              | What the write does: `create`, `edit`, `comment`, `label`, `link`, `assign`, `milestone`, `ready`, `draft`, `delete` (a comment the run posted), `react`, `unreact` (a reaction), `reply`, `resolve`, `unresolve` (a review thread), `update_branch`, `rerun` (failed GitHub Actions jobs: [Reruns](#reruns)), `project` (adding it to a project); `read_checks` for a [read of CI's checks](#reading-cis-checks), which has no `target` or `change`. A write doing several (a `PATCH` of labels and a title) has them all in `actions`, `action` the first. |
| `actions`                                                                                                             | All of them: `close` or `reopen` first, then `label`, `assign`, `milestone`, then `edit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `target.kind`                                                                                                         | Absent for `read_checks`, as the other `target` and `change` fields. `own_issue`, `own_pr`, `sub_issue`, `created_issue` (one the run created), `other_issue`, `pr`, `new_issue` (an issue it creates), `new_pr` (a pull request it opens), `label` (a label it creates), `created_comment` (a comment the run posted).                                                                                                                                                                                                                                      |
| `target.number`                                                                                                       | The issue's or pull request's (for `created_comment`, the one the comment is on), `null` for `new_issue`, `new_pr` and `label`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `target.comment`                                                                                                      | A `created_comment`'s id, or the id of the comment a reaction is on (its target then being the issue or pull request the comment is on). Absent from other targets.                                                                                                                                                                                                                                                                                                                                                                                          |
| `target.comment_author`, `target.comment_deckhand`                                                                    | A reaction's comment's author (its login), and whether the App's bot wrote it. Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `target.labels`                                                                                                       | Its labels' names, as GitHub has them now (none for a comment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `target.author`                                                                                                       | Its author's login.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `target.thread`                                                                                                       | A `reply`'s, `resolve`'s or `unresolve`'s review thread: `author`, its first comment's author's login, and `deckhand`, whether that is Deckhand's bot (a thread Deckhand's review opened). Absent from other writes.                                                                                                                                                                                                                                                                                                                                         |
| `target.run_id`, `target.sha`, `target.event`, `target.workflow`, `target.attempt`, `target.conclusion`, `target.job` | A `rerun`'s workflow run, besides its pull request's fields: see [Reruns](#reruns). Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `change.fields`                                                                                                       | The keys of the write's JSON body (`["title", "body"]`), or a GraphQL mutation's input fields but its target, as REST names them (`labelIds` → `labels`, `assigneeIds`, `actorIds`, `actorLogins` → `assignees`, `milestoneId` → `milestone`, `baseRefName` → `base`, `expectedHeadOid` → `expected_head_sha`, else snake case).                                                                                                                                                                                                                             |
| `change.labels_added`                                                                                                 | The labels it adds (or sets, for a `PUT` or a `PATCH` with `labels`, or creates, for `label`).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `change.labels_removed`                                                                                               | The labels it removes: those a `PUT` or a `PATCH` with `labels` leaves out of the issue's, or the one it deletes; `["*"]` when it deletes them all.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `change.sub_issue`                                                                                                    | A link's child: `id`, `number`, `kind` (`sub_issue` or `created_issue`). Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `change.content`                                                                                                      | A reaction's, as REST names it: `+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes` (GraphQL's `THUMBS_UP` is `+1`); for `unreact`, the one the run added. Absent from other writes.                                                                                                                                                                                                                                                                                                                                                        |
| `change.blocked_by`                                                                                                   | A "blocked by" link's blocker: `id`, `number`, `kind` (`sub_issue`, `created_issue`, or an open issue's kind as a target's: `own_issue`, `other_issue`). Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                           |
| `change.project`                                                                                                      | A `project`'s project: `owner` (lower case), `number`, `title`, one the operator grants. Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `change.assignees`                                                                                                    | An `assign`'s: `added` and `removed`, the logins it assigns and unassigns ([Assignees and milestones](#assignees-and-milestones)). Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `change.milestone`                                                                                                    | A `milestone`'s: `number` and `title`, looked up; `null` when it clears it. Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

```json
{
  "version": 1,
  "repo": "owner/repo",
  "mode": "brainstorm",
  "custom_mode": false,
  "light": true,
  "reason": null,
  "issue": 12,
  "action": "comment",
  "actions": ["comment"],
  "target": { "kind": "other_issue", "number": 40, "labels": [], "author": "someone" },
  "change": { "fields": ["body"], "labels_added": [], "labels_removed": [] }
}
```

#### Reruns

A work run may rerun the failed jobs of a GitHub Actions run on its own pull request's head
(`gh run rerun <id> --failed` or `--job <id>`): action `rerun`, `actions: write` for that call
only, an optional App permission whose lack the refusal names. Never a whole run, a cancel,
dispatch or approval, nor debug logs (`--debug`, refused whatever the policies say: those logs
print more of what runs with the repository's secrets). The run must have failed, come from a
push or a pull request of the repository's branch, and still be at that pull request's head;
the target is that pull request (`own_pr`), with `run_id`, `sha`, `event`, `workflow`
(`name`, `path`), `attempt` (GitHub's `run_attempt`), `conclusion` and `job` (`id`, `name`, or
`null`). At most twice per head commit and run, whatever the policies say (`MAX_RERUNS`, saved
across a restart). Deckhand's default, `policy/gh-actions-rerun.rego`, allows a first rerun
(`target.attempt == 1`), to work runs and the repository's modes it allows; the operator's file
of that name broadens it.

#### Reading CI's checks

`deny_github` also sees one read, `read_checks`: CI's checks beyond Actions (`gh pr checks`,
`gh pr view` without `--json`), over REST or GraphQL. Its input is the run's fields, without
`target` or `change`, evaluated once per run and the answer kept (`gh pr checks --watch`
polls):

```json
{
  "version": 1,
  "repo": "owner/repo",
  "mode": "work",
  "custom_mode": false,
  "light": false,
  "reason": "ci-fix",
  "issue": 12,
  "action": "read_checks",
  "actions": ["read_checks"]
}
```

A rule refusing what isn't in a list (`not input.target.kind in {…}`) refuses it too: guard it
with `input.action != "read_checks"`, as `github.rego` does. More (REST paths, GraphQL types,
the permissions, what stays readable): [security model](security.md#the-github-gateway).

### The linked-branch input

A work run's branch shows in its issue's Development sidebar from the run's start, not only
once its pull request says `Closes #n`. GitHub links a branch to an issue only as it creates
it (`createLinkedBranch`, what `gh issue develop` calls), so the **listener** does it as a work
run starts, once nothing else can stop the run (its image built, its access checked), before
its sandbox does: when the run may push its issue's branch (`issue-<n>-*`, not a light run nor
a fork's) and the issue has no `issue-<n>-…` branch yet. A fix or conflict run's branch, or a
later run's, exists already: nothing is linked then, and for a work run the issue's one branch
is the one the sandbox checks out, even if the title changed since. The branch is named from the issue's
title as the sandbox names it, created at the base branch's head, and the sandbox checks it
out and pushes its first commit through the git gateway as usual (a branch with nothing over
the base and no pull request yet gets that commit whenever a run checks it out). A refusal or
a failure links nothing and fails no run: the sandbox creates the branch itself, unlinked.

`input` of `deny_link_branch`:

| Field         | What                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `version`     | `1`.                                                                                                        |
| `repo`        | `"owner/repo"`, in lower case.                                                                              |
| `mode`        | The run's mode: `work`, or one of the repository's `modes:` that isn't light.                               |
| `custom_mode` | `true` for one of the repository's `modes:`, as in [the GitHub input](#the-github-input).                   |
| `light`       | `false`: a light run gets no branch.                                                                        |
| `reason`      | Why the listener started the run itself (`"review-fix"`, `"ci-fix"`, `"conflict"`), `null` for a comment's. |
| `issue`       | The issue's number.                                                                                         |
| `labels`      | The issue's labels (names).                                                                                 |
| `branch`      | The branch it would create: `issue-<n>-<slug of the title>`.                                                |
| `base`        | The base branch.                                                                                            |
| `oid`         | The base branch's head commit, where the branch is created.                                                 |

Deckhand's default, `gh-linked-branch.rego`, links work runs' branches only among the built-in
modes:

| Work, fix, conflict | Brainstorm            | Research              | Repository modes                                      |
| ------------------- | --------------------- | --------------------- | ----------------------------------------------------- |
| ✅ linked           | ❌ (no branch: light) | ❌ (no branch: light) | ❌ refused until the repository's `allow_link_branch` |

A repository's own mode its `allow_link_branch` lets link one ([example](#policies)) also gets
its branch checked out and its draft pull request opened by the sandbox, as a work run does,
but only on the run that links it: the policies aren't asked about a branch that exists
already, so its later runs get none.

<!-- onboarding: end -->

### The default policies

The ceilings leave room for what a prompt may need one day; Deckhand's default policies narrow
them to what its prompts ask for. They ship in the listener's image (`policy/` in Deckhand's
repository) and hold without any setup, in the operator's layer, under the operator's files:

- **`allow.rego`** allows every decision (`run`: `run.rego`): the ceilings and the deny rules decide. The
  operator's `policy/allow.rego` replaces it (one without `allow_merge` refuses every
  auto-merge).
- **One file per feature**: `github.rego` for the writes runs have always made (below), and a
  `gh-<feature>.rego` for each `gh` feature added since (`gh-review-threads.rego`, say;
  `gh-linked-branch.rego`, [the linked branch](#the-linked-branch-input)),
  whose defaults its issue gives per kind of run: work runs (work, fix and conflict runs
  share theirs), brainstorms, research (it gets no GitHub token, so it never reaches the
  gateway). The repository's own `modes:` get nothing until it allows them, then what work
  runs get.
- **`review.rego`** for the reviews that start by themselves: it skips other bots' pull
  requests ([below](#reviewrego)), which no allowlist stops, as the allowlist lists people.
- **Broadening one feature**: the operator's file with the same name replaces Deckhand's, for
  every repository (`policy/gh-review-threads.rego` with only `package deckhand` drops that
  feature's refusals). A repository can't broaden one.
- **Broadening stops at the ceiling**: a file can only drop refusals. Past it, the mode's
  built-in ceiling still holds, whatever a policy says: onboarding, analyses, reviews and light
  repository modes write nothing, and inbox entries and discussions never go past their own
  ceilings (filing issues, and for inbox entries linking them).
- **Each default file is evaluated with the real `opa`** by Deckhand's tests, on every kind of
  mode.

| `gh-projects.rego`: the `project` action ([Projects](#projects))           | work, fix, conflict                        | brainstorm                           | research    | repository modes                   |
| -------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------ | ----------- | ---------------------------------- |
| add its issue, pull request, sub-issues, filed issues to a granted project | ✅ allowed                                 | ✅ the issues it files (its ceiling) | ❌ no token | ✅ once the repository allows them |
| set an item's field, remove or archive one                                 | ❌ in no ceiling: the listener moves items | ❌                                   | ❌          | ❌, whatever a policy says         |

A repository's `allow_github` lets its modes that aren't light add items too; its deny rule on
`input.action == "project"` refuses it to every run. Neither reaches a project the grant
doesn't name.

The Policies tab lists them as `deckhand/policy/<name>`, with the operator's file that replaces
one.

The `gh-<feature>.rego` files:

| File                | Rule                          | work, fix, conflict                                                                           | brainstorm      | research      | repository modes                                          |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- | --------------- | ------------- | --------------------------------------------------------- |
| `gh-reviewers.rego` | `deny_request_review`         | ✅ [reviewers](#reviewers) requested when the pull request turns ready, and again after a fix | ❌ (no ceiling) | ❌ (no token) | ✅ once the repository's `allow_request_review`           |
| `gh-checks.rego`    | `deny_github` (`read_checks`) | ✅                                                                                            | ✅              | ❌ (no token) | ✅ once the repository's `allow_github` (refuses nothing) |

Teams are never requested, whatever a policy says: `review.request` takes logins only.

#### review.rego

`review.rego` holds `deny_review` for the reviews that start by themselves
([`review.on: ready`](#reviews)). The allowlist (`users`) lists people, so the built-in gate
only checks a person who opens a pull request; another bot (Dependabot, GitHub Actions) is
stopped here instead:

<!-- review.rego: test/reviews.test.mjs checks this block is in policy/review.rego, and evaluates the next one with the real opa -->

```rego
# policy/review.rego (its rule)
deny_review contains msg if {
  input.pr.author_type == "Bot"
  not input.pr.deckhand
  msg := sprintf("%s is a bot: its pull requests aren't reviewed unless the operator's policy/review.rego lets them", [input.pr.author])
}
```

The operator has a bot's ready pull requests reviewed (never a fork's) with a `review.rego` of
their own in the grants folder's `policy/`, which replaces this one for every repository; a
repository's `.deckhand/policy/review.rego` only adds refusals, as its other files. To review
Dependabot's only:

```rego
# grants folder: policy/review.rego
package deckhand

deny_review contains msg if {
  input.pr.author_type == "Bot"
  not input.pr.deckhand
  input.pr.author != "dependabot[bot]"
  msg := sprintf("%s's pull requests aren't reviewed", [input.pr.author])
}
```

To review every bot's, a file with no rule, its comment naming `author_type` (the config check
warns of a replacement that doesn't, below):

```rego
# grants folder: policy/review.rego: every bot's pull requests are reviewed, whatever its author_type.
package deckhand
```

**Upgrading with a `review.rego` of your own**: an operator's written before this default (a
`deny_review` on wip labels, say) replaces it, and other bots' ready pull requests are then
reviewed, at the operator's cost. The config check warns of one that never names
`author_type`, at the start and on every Policies tab: copy the rule above into it, or name
`author_type` in a comment if bots' pull requests should be reviewed.

`github.rego`, which the operator's file of that name replaces as a whole:

<!-- github.rego: test/github-writes.test.mjs checks this block is policy/github.rego, and evaluates it with the real opa -->

```rego
# policy/github.rego
# Deckhand's default policy for a run's GitHub writes (docs/repo-config.md#the-default-policies):
# the modes' ceilings leave room for what a prompt may need one day, this narrows them to what
# Deckhand's prompts ask for. A grants folder's policy/github.rego replaces it; a repository's
# deny rules only add refusals.
package deckhand

# Brainstorms edit their own issue's description, and file and link their follow-ups: the
# listener posts their replies, so they comment nowhere, and write to no other issue.
deny_github contains msg if {
  input.mode in {"brainstorm", "stop"}
  input.action == "comment"
  msg := "a brainstorm doesn't comment: its final message is posted as its reply"
}

deny_github contains msg if {
  input.mode in {"brainstorm", "stop"}
  input.action != "read_checks"
  not input.target.kind in {"own_issue", "new_issue", "label"}
  not orders_follow_ups
  not files_follow_ups
  msg := sprintf("a brainstorm writes only its own issue, not #%d", [input.target.number])
}

# But it orders its follow-ups: "blocked by" links on its sub-issues and the issues it filed.
orders_follow_ups if {
  input.action == "link"
  input.change.blocked_by
  input.target.kind in {"sub_issue", "created_issue"}
}

# And puts the issues it filed on a granted project (gh-projects.rego, its ceiling).
files_follow_ups if {
  input.action == "project"
  input.target.kind == "created_issue"
}

# And puts the issues it filed in a milestone (their ceiling: nothing else of theirs).
orders_follow_ups if {
  input.actions == ["milestone"]
  input.target.kind == "created_issue"
}

# Inbox entries only file issues (with their label), and link the ones they split.
deny_github contains msg if {
  input.mode in {"idea", "bug"}
  input.action != "read_checks"
  not input.action in {"create", "link"}
  msg := sprintf("%s entries only file issues", [input.mode])
}

deny_github contains msg if {
  input.mode in {"idea", "bug"}
  input.target.kind == "new_issue"
  not input.mode in input.change.labels_added
  msg := sprintf("%s entries' issues carry the %s label", [input.mode, input.mode])
}
```

#### A run's own comments

A work run corrects a comment it posted rather than posting another (issue #455): `PATCH` or
`DELETE …/issues/comments/<id>`, or GraphQL's `updateIssueComment` and `deleteIssueComment`
(`gh issue comment --edit-last`, `--delete-last`, `gh pr comment` likewise). The App's bot
writes every run's comments and the listener's own (its live progress comment, its replies,
its reviews), so a comment's author says nothing: the gateway keeps the comments GitHub said
the run posted, from the answers to its own calls (a REST `201` on `…/issues/<n>/comments`, its
`url`; GraphQL's `addComment`, only under the response key of a field the gateway parsed,
selecting GitHub's own `commentEdge { node { url } }`, unaliased), saved with the run so a
listener restart keeps them. Such a comment, in the run's repository and still the bot's on
GitHub, is a `created_comment`; any other is refused before any look-up or policy: the
listener's, another run's, a person's, a review's. `--edit-last` picks the bot's last comment
on the issue, which may be the listener's: its refusal says to send
`gh api -X PATCH repos/<owner>/<repo>/issues/comments/<id> -f body=…` instead, with the id
that ends the URL gh printed when the run posted it (`#issuecomment-<id>`). An edit's body is
redacted as any write's.

The ceiling holds `edit` and `delete` on `created_comment` for work runs and the repository's
modes that aren't light. Deckhand's default file, `gh-own-comments.rego`, narrows it:

|                              | work, fix, conflict                 | brainstorm                                       | research    | repository modes                    |
| ---------------------------- | ----------------------------------- | ------------------------------------------------ | ----------- | ----------------------------------- |
| `edit` a comment it posted   | ✅ allowed                          | ❌ (its replies are the listener's: its ceiling) | ❌ no token | ✅ once the repository allows them  |
| `delete` a comment it posted | ❌ denied, the operator may broaden | ❌                                               | ❌ no token | ❌ denied, the operator may broaden |

The file ships in the listener's image ([The default policies](#the-default-policies)), so
this holds without any setup. The operator's `policy/gh-own-comments.rego` replaces it for every
repository (a file without the rule on `delete`, say): never past the ceiling. A repository's
own modes edit theirs once its `allow_github` lets them.

#### Reactions

A run acknowledges a comment with a reaction rather than another comment (issue #458): 👀 when
it starts on a maintainer's request, 👍 on a suggestion it applied. `POST …/issues/<n>/reactions`,
`…/issues/comments/<id>/reactions` and `…/pulls/comments/<id>/reactions`, or GraphQL's
`addReaction`, are `react`; `DELETE` of the same paths with the reaction's id, or
`removeReaction`, `unreact`. A comment's reaction is held to the ceiling of the issue or pull
request the comment is on, looked up on GitHub (in the run's repository), and its input names
the comment (`target.comment`, `comment_author`, `comment_deckhand`). Reactions on a commit's comment or a review are refused.

The App's bot adds the listener's reactions too (👀 on a comment that starts a run, then 🚀,
😕 or 👎 when it is over), so a run removes only the reactions GitHub said it added, saved with
the run like the issues it created: a REST `201` (a `200` says the bot had it already), or an
`addReaction` field the gateway parsed whose content the bot hadn't on that subject, which
GitHub ran. A reaction the run removed is no longer its own (the listener may add the same one
since), and it keeps its 100 newest. A reaction the listener added, on any comment of the
repository (whichever task it went to, a waiting `/after`, a held comment's 😕, a finished run's
outcome), is never the run's, even where the run's came first: GitHub keeps one reaction per
user and content, so the listener's `POST` answers with the run's. The listener notes each one
before it asks GitHub, in `reactions.json` (its 5,000 newest), and drops its 👀 once it takes it
off. Any other removal is refused before any policy. One added over GraphQL is removed
with `removeReaction` (REST's `DELETE` names a reaction by an id the gateway didn't keep for it).

Deckhand's default file, `policy/gh-reactions.rego`, narrows the ceiling:

|                                                          | work, fix, conflict | brainstorm                                         | research    | repository modes                   |
| -------------------------------------------------------- | ------------------- | -------------------------------------------------- | ----------- | ---------------------------------- |
| `react` on its issue or pull request, and their comments | ✅ allowed          | ✅ on its own issue and its comments (its ceiling) | ❌ no token | ✅ once the repository allows them |
| `unreact`                                                | ✅ its own only     | ✅ its own only                                    | ❌ no token | ✅ its own only, likewise          |

The file ships in the listener's image ([The default policies](#the-default-policies)), so
this holds without any setup: it refuses nothing, the ceiling decides. A repository's
`allow_github` lets its own modes react, up to their ceiling, and its deny rule refuses
reactions altogether there:

```rego
# .deckhand/policy/reactions.rego
package deckhand

deny_github contains "this repository doesn't let runs react" if {
  input.action in {"react", "unreact"}
}
```

#### Review threads

The ceiling holds `reply`, `resolve` and `unresolve` on a run's own pull request (`own_pr`) for
work runs and the repository's modes that aren't light ([above](#the-github-input)). Deckhand's
default file, `gh-review-threads.rego`, narrows it: resolving hides a thread, so a run resolves
only those Deckhand's review opened, never a person's, which stays open for its author to read
the reply.

|                                 | work, fix, conflict                 | brainstorm      | research    | repository modes                    |
| ------------------------------- | ----------------------------------- | --------------- | ----------- | ----------------------------------- |
| `reply` on its own pull request | ✅ allowed                          | ❌ (no ceiling) | ❌ no token | ✅ once the repository allows them  |
| `resolve` Deckhand's thread     | ✅ allowed                          | ❌ (no ceiling) | ❌ no token | ✅ once the repository allows them  |
| `resolve` a person's thread     | ❌ denied, the operator may broaden | ❌ (no ceiling) | ❌ no token | ❌ denied, the operator may broaden |
| `unresolve` a thread            | ✅ allowed                          | ❌ (no ceiling) | ❌ no token | ✅ once the repository allows them  |

The file ships in the listener's image ([The default policies](#the-default-policies)). The
operator's `policy/gh-review-threads.rego` replaces it for every repository (a copy without the
rule on `resolve` lets work runs resolve anyone's threads): never past the ceiling. A
repository's deny rule narrows it for its runs.

#### Updating a pull request's branch

Deckhand's default file, `gh-update-branch.rego`, refuses nothing: work runs (a maintainer's, a
review's fix run, a conflict's) merge the base into their pull request's branch, and the
repository's own `modes:` once its `allow_github` lets them. A repository's deny rule refusing
`input.action == "update_branch"` keeps its history linear, every run rebasing instead. Nothing
goes past the ceiling: only work runs and the repository's modes that aren't light can update
a branch at all, of their own pull requests only, and with a merge.

| What                                            | work (fix, conflict) | brainstorm      | research      | the repository's `modes:`     |
| ----------------------------------------------- | -------------------- | --------------- | ------------- | ----------------------------- |
| `update_branch` (merge) on its own pull request | allowed              | no (no ceiling) | no (no token) | once the repository allows it |
| rebase                                          | no (built in)        | no              | no            | no (built in)                 |

#### Assignees and milestones

`change.assignees` names logins as the run spelled them (compare with `lower()`; a bot's with
`[bot]`); a list set in place of the target's is split against GitHub's. Deckhand's default,
[`gh-assign-milestone.rego`](../policy/gh-assign-milestone.rego), shipped in the image:

|             | work, fix, conflict                                        | brainstorm               | research    | repository modes                    |
| ----------- | ---------------------------------------------------------- | ------------------------ | ----------- | ----------------------------------- |
| `milestone` | ✅ its issue, pull requests, sub-issues and created issues | ✅ the issues it creates | ❌ no token | ✅ once the repository allows them  |
| `assign`    | ❌ denied, the operator may broaden                        | ❌ (no ceiling)          | ❌ no token | ❌ denied, the operator may broaden |

The operator's file of that name replaces it, never past the ceiling or the limit on
assignees. To let work runs assign the issue's author:

```rego
# grants folder: policy/gh-assign-milestone.rego
package deckhand

deny_github contains "a run assigns only the issue's author" if {
  some login in input.change.assignees.added
  lower(login) != lower(input.target.author)
}

# A new issue has no author yet (null).
deny_github contains "a run assigns only the issue's author" if {
  "assign" in input.actions
  input.target.kind in {"new_issue", "new_pr"}
}

deny_github contains "only work runs assign people" if {
  "assign" in input.actions
  input.mode != "work"
}
```

### A dry run and the dashboard

**`/mode policy`**, commented on a pull request by an allowed user, evaluates the `merge`,
`review`, `fix` and `request_review` decisions on the pull request as it is now, `run` on
sample comments (work, a brainstorm), and `github` on
sample writes (a comment on it by the work run whose pull request it is, one by a brainstorm
of another issue, `issue: null`, and, when the repository has `modes:`, one by a run in the
first of them that isn't light, else the first, `custom_mode: true`), then on a `read_checks` sample, `link_branch` on a
sample (the pull request's head branch, as its work run on the issue it closes would have had it
linked), and replies with each decision's result (refused, with its messages, or allowed), each
layer's `allow_*` and `deny_*` results under it with the files that define them, then the
merge's input and the samples' inputs, in collapsed blocks. The samples' results are labelled as such
and aren't counted as denials. Nothing is
reviewed, fixed or merged, and it is no decision: it debugs a rule without waiting for a pull
request to turn ready. The task's page shows its last one: who asked, when, how many denials,
and a link to the reply. The input is the merge's, read now, with `review: null` (no review
ran); `deny_review` and `deny_fix` get it with their own `decision`, without `checks`,
`deny_fix` with the `round` and `rounds` the next fix run would have (a review's: `reason: "review"`), `deny_request_review`
with its `reviewers`, `when: "ready"` and the run that opened the pull request, as the listener would ask; its "allowed" adds "but nobody would be requested" when the listener wouldn't ask (`review.request` names no allowed user, or it isn't Deckhand's own ready pull request). It works without a `review` block. On an issue, a reply says to comment it on the
pull request.

**The dashboard**: the repository's settings have a Policies tab, next to its config: the
config check's errors first (each linked to its line), each decision's allow and deny rules
per layer and their files (or refused while the check fails), the policy files that apply
(Deckhand's, the operator's replacing some, the repository's read from the default branch:
the rules each defines, whether it compiles), and each file's source. A task's page shows its
pull request's last policy decisions (whether refused, the messages, what each layer said,
when), the last 10 of them; a decision is kept only when a policy was asked, so a repository without
policies shows none. Each lists the built-in gates that passed before the policies were asked
(for a merge: the review's findings and verdict, the head commit, the pull request's state,
no trusted file changed, the checks…), and the newest 3 keep the input the rules saw,
redacted, cut to 8 KB (its changed files first, then the review's findings, then the checks;
marked `truncated`).

## Open questions

An issue whose body has an `## Open questions` section that asks something is labelled
`NEEDS_INPUT_LABEL` (default `needs-input`), and an allowed user's comment takes the label
off: they answered. Ticking the boxes in the section answers too: once every question has an
option ticked (`- [x]`), the label comes off as for a comment, and unticking them puts it
back. A free-text question (no options) still needs a comment. Only an allowed user's ticks
answer: those of the App's bot (a run ticking its own picks) or of someone not allowed leave
the label on. A run that stopped to ask goes on the same way when an allowed user ticks an
option of every question in its reply (the boxes it came ticked with are the agent's). With
`wait_for_answers: true` (the default), work doesn't start on an issue while it carries the
label, unless an allowed user ticked an option of every question:

- A comment that is only the trigger line (with `/mode`, `/model`, `/effort`, `/speed`, `/agent` or `/after`
  lines at most) starts nothing: the App replies that the issue has open questions, points
  to the dashboard's form, and the label stays. A trigger comment with text is the answer:
  the label comes off and the run starts.
- A comment waiting for other issues (`/after`) whose last one is done keeps waiting until
  the questions are answered (the label is removed, or every box ticked), then starts by
  itself.
- The dashboard's Start and Queue open the questions first: the issue starts with the
  answers.

Only work runs and the repository's modes that aren't `light` wait: brainstorms, onboarding
and light modes still run, as they can help answer, and leave the label on. A run that stopped
to ask, pull requests, inbox issues and discussions aren't affected. With
`wait_for_answers: false`, trigger comments, waits and the dashboard start the issue as they
would without questions (the dashboard's form is still there to answer from the task's
panel).
