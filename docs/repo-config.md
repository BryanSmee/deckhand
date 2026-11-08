# Per-repo config: `.deckhand.yaml`

Each repository can tune its runs with a `.deckhand.yaml` file at its root. Without one, its
runs use the operator's settings and the base image.

Deckhand always reads it from the repository's **default branch**, at every run: a
change on a branch or in a pull request has no effect until it is merged, so nobody can
change a run's permissions from the code it runs on. The file can only **narrow** the
operator's settings (users, parallel runs), never widen them.

A file with errors stops the repository's runs: the reply to a trigger comment (or a
`/mode` line) lists them.
Unknown keys and users the operator doesn't allow are only warnings, shown in the run's log
on the dashboard.

## Onboarding

When the App is installed on a repository without this file, Deckhand opens an
onboarding issue there (see [Onboarding](guides/repositories.md#onboarding)), and Claude proposes the file
in its comments: it reads the repository (package managers, CI workflows, `AGENTS.md`, test
and lint commands, services) and gives each key a reason, within the users and mount roots
the operator allows, and names the hosts to ask the operator for. Each comment on the issue goes on in that conversation, with a
read-only token. Claude may suggest inboxes; they are created only if you agree.

The trigger line (`Deckhand`) or `/mode work` confirms: a work run on the issue's branch
writes only the agreed files and marks its pull request ready. Deckhand then reads the
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

# Replies, issues and pull requests in French; English without it (see Language below).
language: French

# Run in the clone before Claude starts, on every work run (not for brainstorms).
setup: |
  npm ci
  npm run db:start

# Project instructions, added to the generic ones (path in the repo, default branch).
instructions: docs/agents.md

# The image runs start from: a Dockerfile FROM the base image (see below). Only with the
# operator's `dockerfile` grant.
dockerfile: .deckhand/Dockerfile

# A container engine next to work runs' sandbox, for docker build, run and compose (see
# below). Only with the operator's `docker` grant. `docker: true` starts it empty.
docker:
  cache: true # keep its images and layers between this repo's runs

# Kept between runs: one Docker volume per path, for this repo only.
caches:
  - /home/node/.npm
  - /home/node/.cache/ms-playwright

# The repo's own modes, started with a "/mode <name>" line (see repo-config/modes.md).
modes:
  audit:
    instructions: .deckhand/audit.md # path in the repo, default branch
    # what its runs get, write and push: .deckhand/policy/ (see modes.md)
    session: issue # issue: kept, like a brainstorm | fresh: a new one each time
    agent: codex # only if the operator configured it
    model: balanced
    effort: medium
  hotfix:
    instructions: .deckhand/hotfix.md
    speed: fast # Claude Code's fast mode, without a /speed line: see modes.md

# Review pull requests: one GitHub review with severities, a rating and a verdict (see
# repo-config/reviews.md). Off without the block; `review: true` for "/mode review" only.
review:
  on: ready # a pull request marked ready (or opened as ready) | manual: "/mode review" only
  instructions: .deckhand/review.md # optional, added to the built-in review prompt
  model: best # default: brainstorm_model, brainstorm_effort
  effort: high
  fix: true # a work run that addresses a review requesting changes, then a review of its push;
  #           # a number (1 to the operator's MAX_FIX_ROUNDS, 5 by default) for that many rounds
  # merge: true # UNSAFE, no human review: Deckhand merges its own pull request after a clean
  #             # review; needs the operator's `auto_merge` grant (see Auto-merge)
  # merge_method: squash # squash (default) | merge | rebase
  # max_allowed_severity: low # low (default) | medium: the most severe finding a merge allows
  # merge_wait: 60 # minutes a merge waits for the GitHub Actions runs still going (0 to 1440)
  # ci: wait # the review waits for the head commit's GitHub Actions runs; a failure starts a
  #          # CI fix run instead of a review (see CI before the review)
  # ci_wait: 30 # minutes it waits before it reviews anyway (0 to 1440)
  # ci_fix: 1 # CI fix runs per pull request, with fix (0 to the operator's MAX_FIX_ROUNDS)
  # request: [alice] # reviewers asked on Deckhand's pull request once it is ready, and again
  #                  # after a fix pushed (see Reviewers); allowed users only
  # follow_ups: false # don't file the reviews' follow-ups as issues after a merge (on by default)
  # follow_ups_auto_pickup: true # the follow-ups filed get the auto-pickup label too, for
  #                              # whoever merged the pull request (see Auto-pickup in issues.md)

# Where ideas, bug reports and questions go (see Inboxes in repo-config/issues.md).
inbox:
  ideas: 3 # issue number
  bugs: 4 # issue number
  discussions: Ask Claude # GitHub Discussions category

# Rebase this repo's open Deckhand pull requests that conflict with their base (see Conflicts
# in repo-config/issues.md).
conflicts:
  check_minutes: 15

# Start work on an issue with open questions only once they are answered (see Open questions
# in repo-config/issues.md).
wait_for_answers: true

# Start the open issues labelled auto-pickup by themselves, in the operator's reserved slots
# (see Auto-pickup in repo-config/issues.md).
auto_pickup: true
# None picked while 3 of Deckhand's pull requests here wait for review (unset: no limit).
auto_pickup_max_ready: 3

# Move this repo's issues on an organization's project (v2) as their work goes (see Projects in
# repo-config/issues.md). Only projects the operator grants it (allow_projects).
projects:
  - project: acme/3 # https://github.com/orgs/acme/projects/3
    field: Status # a single select field; Status by default
    start: In progress # a work run starts on the issue
    ready: In review # its pull request turns ready for review
    merged: Done # its pull request merges
```

## Keys

| Key                                     | Default                                 | What                                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`                                 | `ALLOWED_USERS`                         | GitHub logins that may start runs here; those not in `ALLOWED_USERS` are ignored                                                                                                     |
| `trigger`                               | `TRIGGER`                               | the whole first line of a comment that starts a run; `/mode` picks another mode                                                                                                      |
| `agent`, `brainstorm_agent`             | `SANDBOX_AGENT`, `BRAINSTORM_AGENT`     | the agent of work runs, and of brainstorms, inbox entries and discussions (see Agent)                                                                                                |
| `model`, `effort`                       | `SANDBOX_MODEL`, `SANDBOX_EFFORT`       | work runs' model (`best`, `balanced`, `fast` or a name) and effort (`low` … `max`)                                                                                                   |
| `brainstorm_model`, `brainstorm_effort` | `BRAINSTORM_MODEL`, `BRAINSTORM_EFFORT` | the same for brainstorms, inbox entries and discussions                                                                                                                              |
| `fast_mode`                             | `SANDBOX_FAST_MODE`                     | `false`: `/speed fast` and a mode's `speed: fast` run at normal speed here; `true` can't turn it on when the operator hasn't                                                         |
| `max_parallel`                          | `MAX_PARALLEL`                          | runs of this repo at once; capped by `MAX_PARALLEL`                                                                                                                                  |
| `chats.per_user`                        | `CHATS_PER_USER`                        | chats a user may keep when they create one here, counted across the repositories; lowers `CHATS_PER_USER`, never raises it (see [Chats](repo-config/issues.md#chats))                |
| `setup`                                 | none                                    | shell command run in `/workspace` before the agent, on work runs and chats                                                                                                           |
| `instructions`                          | none                                    | Markdown file of the repo, appended to the agent's instructions                                                                                                                      |
| `language`                              | none: English                           | the language runs write replies, issues and pull requests in (`French`, `fr`), one line (see Language)                                                                               |
| `dockerfile`                            | none: the base image                    | Dockerfile of the repo for its runs' image; needs the operator's `dockerfile` grant                                                                                                  |
| `docker`                                | none                                    | a container engine for work runs (`true`, or `cache: true`); needs the `docker` grant                                                                                                |
| `caches`                                | none                                    | absolute paths in the sandbox kept in a volume per repo and path                                                                                                                     |
| `mounts`                                | none                                    | host paths requested (`- path: /nfs/work/api`, `read_only`); only under granted roots                                                                                                |
| `modes.<name>`                          | none                                    | the repo's own modes, picked with `/mode <name>` (see [Modes](repo-config/modes.md#modes))                                                                                           |
| `review.on`                             | none: off; `manual` with the block      | `ready`: a pull request that turns ready gets a review; `manual`: `/mode review` only                                                                                                |
| `review.instructions`                   | none                                    | Markdown file of the repo, added to the built-in review prompt                                                                                                                       |
| `review.agent`, `.model`, `.effort`     | `brainstorm_agent`, `_model`, `_effort` | the reviews' agent, model and effort (see [Reviews](repo-config/reviews.md#reviews))                                                                                                 |
| `review.fix`                            | `false`                                 | a review that requests changes starts a work run that addresses it; `true` or a number of rounds (see [Reviews](repo-config/reviews.md#reviews))                                     |
| `review.merge`                          | `false`                                 | **unsafe**: Deckhand merges its own pull request after a clean review; needs `auto_merge` (see [Auto-merge](repo-config/reviews.md#auto-merge))                                      |
| `review.merge_method`                   | `squash`                                | how an auto-merge merges: `squash`, `merge` or `rebase`, one the repository allows                                                                                                   |
| `review.max_allowed_severity`           | `low`                                   | the most severe finding a review in the fix loop or deciding an auto-merge may have: `low` or `medium` (see [Auto-merge](repo-config/reviews.md#auto-merge))                         |
| `review.merge_wait`                     | `60`                                    | minutes an auto-merge waits for the GitHub Actions runs still going on the reviewed commit, `0` to `1440` (see [Auto-merge](repo-config/reviews.md#auto-merge))                      |
| `review.ci`                             | `false`                                 | `wait`: an automatic review waits for CI, and a failure starts a CI fix run instead (see CI before the review)                                                                       |
| `review.ci_wait`                        | `30`                                    | minutes the review waits for the GitHub Actions runs still going before it starts anyway, `0` to `1440`                                                                              |
| `review.ci_fix`                         | `1`                                     | CI fix runs per pull request, with `review.fix`, `0` to the operator's `MAX_FIX_ROUNDS` (see CI before the review)                                                                   |
| `review.follow_ups`                     | `true`                                  | `false`: the reviews' follow-ups aren't filed as issues once a pull request is merged (see [Reviews](repo-config/reviews.md#reviews))                                                |
| `review.follow_ups_auto_pickup`         | `false`                                 | `true`: the follow-ups filed after an allowed user's merge are auto-picked, as that user's work (see [Auto-pickup](repo-config/issues.md#auto-pickup))                               |
| `inbox.ideas`, `inbox.bugs`             | none                                    | issue numbers whose comments are ideas or bug reports to file (see [Inboxes](repo-config/issues.md#inboxes))                                                                         |
| `inbox.discussions`                     | none                                    | GitHub Discussions category whose discussions Claude answers (see [Inboxes](repo-config/issues.md#inboxes))                                                                          |
| `conflicts.check_minutes`               | none: off                               | minutes between conflict checks, and one soon after a merge; at least `CONFLICT_CHECK_MINUTES` (see [Conflicts](repo-config/issues.md#conflicts))                                    |
| `wait_for_answers`                      | `true`                                  | an issue's work runs wait until its open questions are answered (see [Open questions](repo-config/issues.md#open-questions))                                                         |
| `auto_pickup`                           | `false`                                 | `true`: Deckhand starts this repo's open issues labelled `AUTO_PICKUP_LABEL` by itself, in the operator's `AUTO_PICKUP_SLOTS` (see [Auto-pickup](repo-config/issues.md#auto-pickup)) |
| `auto_pickup_max_ready`                 | none: no limit                          | none picked while this repo has that many of Deckhand's pull requests ready for review (see [Auto-pickup](repo-config/issues.md#auto-pickup))                                        |
| `projects`                              | none                                    | organization projects (v2) Deckhand moves the issues on: `project`, `field`, `start`, `ready`, `merged` (see [Projects](repo-config/issues.md#projects))                             |
| `machines`                              | none: off                               | `true`, or `labels: [...]`: its tasks may run on its users' own machines, with the operator's `machines` grant (see [Machines](repo-config/issues.md#machines))                      |

## Network and mounts

Sandboxes reach the outside through an egress proxy only: Anthropic's API, GitHub and the
hosts the operator grants the repository in their grants folder (`hosts` in
`grants/default.yaml` for every repository, `grants/<owner>/<repo>.yaml` for this one).
Anything else is refused with a `403` saying so. This file has no `hosts`: anyone who can
push to the default branch could otherwise open the sandbox's network, so only the operator
lists them (one here is ignored, with a warning). The same goes for `cached_hosts`, those of
them whose answers (HTTPS too) the egress proxy keeps for every run
([The egress cache](security/network.md#the-egress-cache)). Ask the operator for the registries and
APIs the repository needs; the onboarding issue lists them. See
[Where a sandbox's hosts come from](security/network.md#where-a-sandboxs-hosts-come-from).

A `mounts` entry is only a request: it is mounted when the operator grants the repository a
root holding it, after resolving `..` and symlinks. Otherwise the run stops and the reply
says which path was refused and why. See [Security model](security.md).

### YAML

Deckhand has no dependencies, so it reads the part of YAML a config needs: mappings,
lists (block and `[a, b]`), `{ a: 1 }` on one line, quoted and plain values, `|` and `>`
blocks, comments. Anchors, aliases, tags and several documents in one file are refused
with the line number.

## Workflow files

A run's pushes can't add or change files under `.github/workflows/` unless the operator grants
the repository `workflows` ([the grants](reference/server-folder.md#the-grants): an `allow_grant` rule of its policies). With the
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
secret) is the maintainers' to write, unless the operator grants `workflow_secrets` too.

With `workflow_secrets` as well, a workflow GitHub only runs from the default branch's copy may
mention `secrets`, deploy to an `environment:` and ask for `write` scopes (the other rules
above still hold, a top-level `permissions:` included). Its `on:` has nothing but `schedule` and
`push` with a `branches:` naming the default branch alone, exactly:

```yaml
on:
  schedule:
    - cron: "0 3 * * *"
  push:
    branches: [main] # the default branch's exact name; `paths` filters are fine
permissions:
  contents: write
```

Any other trigger (`pull_request`, `workflow_dispatch`, `workflow_call`, `workflow_run`…), an
unfiltered `push`, a pattern or another branch in `branches:`, or `branches-ignore`, `tags`
or `tags-ignore` keeps the rules above, and the refusal names it. A workflow it calls keeps them
too (its `on:` is `workflow_call`), so it can't use secrets in this version: use them in the
lifted workflow's own jobs. Names are compared exactly (`push`, not `Push`). A pull request that
changes a workflow is never merged automatically (`review.merge`). See [GitHub Actions on
Deckhand's branches](security/github.md#github-actions-on-deckhands-branches).

## Images

Every run starts from an image:

- **The base image** (`SANDBOX_IMAGE`, `deckhand-sandbox`): the harness only: `git`, `gh`
  (through the github service's GitHub gateway), `jq`, `ripgrep`, Node 26, Playwright with
  Chromium, `img2webp` (an animated WebP from screenshots), the entrypoint and the draft pull
  request hooks. No project toolchain, and **no Claude Code**:
  before the first run that needs it, Deckhand installs the pinned
  `CLAUDE_CODE_VERSION` in a short container of its own, into the shared
  `deckhand-claude-code` volume; later runs reuse it.
- **The repo's image**, when `dockerfile` is set and the operator's policies grant the
  repository `dockerfile` (otherwise its runs stop, and the reply says
  so): built `FROM` the base image, by Deckhand, from the default branch, with normal
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
the Dockerfile: Deckhand builds again when either changes, and otherwise reuses the
image. It keeps the three most recent tags per repo and removes older ones, the default
branch's newest first among those kept, and the tags of the name from before the repo hash. While an image builds, the run shows "building image" on the
dashboard, and the build log is in the run's log. A failed build fails the run, with a
reply on GitHub.

Only the Dockerfile's own content is hashed: a change in a file it copies builds a new
image once the Dockerfile changes, or the base image does. The image builds only when the
Dockerfile in the downloaded files is the one its tag names. GitHub writes those files with
`git archive`, which applies the repository's `.gitattributes`: CRLF line ends (`eol=crlf`) and
an expanded `$Id$` (`ident`) are undone for the check, but a Dockerfile with `export-subst` or
stored in Git LFS can't build.

**Branch images.** When the operator's policies grant the repository `branch_docker_images`
(it is not a key of `.deckhand.yaml`: one there is ignored, with a
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
(set up by the operator: [Container engine](guides/container-engine.md)), and the sandbox the `docker`
CLI with buildx and compose, pointed at it (`DOCKER_HOST=tcp://engine:2375`). The agent's
prompt says whether its run has an engine, and whether it answered:

```sh
docker build -t app .
docker run -d -p 8080:8080 app
curl engine:8080/health    # published ports answer on the engine, not localhost
docker compose up -d
```

- **The grant**: only when the operator's policies grant this repository `docker` (one
  repository at a time: [the grants](reference/server-folder.md#the-grants)); `docker` without it is an error that stops the runs, like
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
- **Only for runs the policies give the `docker` capability** (Deckhand's defaults: work runs
  and, once its policies allow it, a repository's own modes), never for comments on a pull
  request from a fork.
- **On Kubernetes** ([Container engine on Kubernetes](kubernetes/components.md#container-engine-on-kubernetes)):
  `docker: { cache: true }` is ignored, every run's engine starting empty, and setuid programs
  (`sudo`, `su`, a Dockerfile's `RUN sudo …`) fail in the engine's containers: run such steps
  as root (`USER root`) instead.
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

Brainstorms are light runs: no branch, no setup command, so the answer comes quickly. A
repository's mode skips `setup` when its policies don't give it the `setup`
[capability](repo-config/policies.md#capabilities).

## Agent

`agent` picks what runs the repository's work: `claude` (Claude Code), `codex` (OpenAI's
Codex) or `antigravity` (Google's Antigravity CLI, with a Gemini API key or on the operator's
Google AI plan),
`brainstorm_agent` that of its light runs (brainstorms, inbox entries, discussions),
and a mode's `agent` that of the mode. Without them, the operator's `SANDBOX_AGENT` and
`BRAINSTORM_AGENT` (a repository's mode takes `agent`).

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
keys say: [Agents and providers](guides/agents.md). With Codex, comments
posted while a run works wait for it to end, and the next run answers them in the same
session (see [Codex](guides/codex.md)); the same with the Antigravity CLI
([Antigravity CLI](guides/antigravity.md)).

## Instructions

The file named by `instructions` is read from the default branch and appended to the
generic sandbox instructions (`prompts/sandbox.md`) under "This project". Put there what
the generic rules can't know: language of the product, services and how to start them,
checks to run.

## Language

Runs write in English. `language` (a name or code on one line, up to 40 characters) names
the language they write in for people instead:

```yaml
language: French
```

Every run's prompt then ends with a line asking for it, whatever its mode. The sandbox adds it
again after what it puts past the prompt (a continued session's notes, an agent taking over,
each message resuming a [chat](repo-config/issues.md#chats)), so it stays the last thing the agent reads. It covers
replies, the issues and pull requests a run files, and comments. Code, code comments and
commits stay in English unless the [instructions](#instructions) say otherwise, and so does
what Deckhand reads: the [open questions](repo-config/issues.md#open-questions) markers, and a [review](repo-config/reviews.md#reviews)'s
headings, severities, labels and `Rating:` and `Verdict:` lines. Without the key, nothing is
added: the issue's language doesn't count. It needs no grant.

## More of the reference

The rest of `.deckhand.yaml`, and what a repository's `.deckhand/policy/` decides, have pages
of their own in [`repo-config/`](repo-config/):

- [Modes](repo-config/modes.md): the built-in modes a `/mode` line picks, a repository's own
  (`modes`), and research runs.
- [Reviews](repo-config/reviews.md): Deckhand's reviews of pull requests (`review`), the
  reviewers it asks, CI before the review, and auto-merge.
- [Issues](repo-config/issues.md): inboxes, preview deployments, conflicts, projects, open
  questions, chats, machines and auto-pickup.
- [Policies](repo-config/policies.md): a repository's `.deckhand/policy/`, capabilities,
  access, the default policies, and their dry run on the dashboard.
- [Policy inputs](repo-config/policy-inputs.md): each decision's `input`, field by field, for
  writing a rule.

What a repository's config narrows is the operator's: their [server settings](reference/settings.md)
and [grants folder](reference/server-folder.md). The comments that start and steer runs are in
[Comment commands](reference/comment-commands.md).
