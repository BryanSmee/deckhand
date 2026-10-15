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
and lint commands, services) and gives each key a reason, within the hosts, users and mount
roots the operator allows. Each comment on the issue goes on in that conversation, with a
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

# Defaults; a comment's /model and /effort lines still override them.
model: opus
effort: high
brainstorm_model: sonnet
brainstorm_effort: medium

# Runs of this repo at once, within the operator's MAX_PARALLEL.
max_parallel: 1

# Run in the clone before Claude starts, on every work run (not for brainstorms).
setup: |
  npm ci
  npm run db:start

# Project instructions, added to the generic ones (path in the repo, default branch).
instructions: docs/agents.md

# The image runs start from: a Dockerfile FROM the base image (see below).
dockerfile: .deckhand/Dockerfile
allow_branch_docker_images: false

# Kept between runs: one Docker volume per path, for this repo only.
caches:
  - /home/node/.npm
  - /home/node/.cache/ms-playwright

# The repo's own modes, started with a "/mode <name>" line (see Modes below).
modes:
  review:
    instructions: .deckhand/review.md # path in the repo, default branch
    light: true # comments only: no branch, no setup, a read-only token
    session: issue # issue: kept, like a brainstorm | fresh: a new one each time
    model: sonnet
    effort: medium

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
```

## Keys

| Key                                     | Default                                 | What                                                                                     |
| --------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `users`                                 | `ALLOWED_USERS`                         | GitHub logins that may start runs here; those not in `ALLOWED_USERS` are ignored         |
| `trigger`                               | `TRIGGER`                               | the whole first line of a comment that starts a run; `/mode` picks another mode          |
| `model`, `effort`                       | `SANDBOX_MODEL`, `SANDBOX_EFFORT`       | work runs' model and thinking effort (`low`, `medium`, `high`, `xhigh`, `max`)           |
| `brainstorm_model`, `brainstorm_effort` | `BRAINSTORM_MODEL`, `BRAINSTORM_EFFORT` | the same for brainstorms, inbox entries and discussions                                  |
| `max_parallel`                          | `MAX_PARALLEL`                          | runs of this repo at once; capped by `MAX_PARALLEL`                                      |
| `setup`                                 | none                                    | shell command run in `/workspace` before Claude, on work runs                            |
| `instructions`                          | none                                    | Markdown file of the repo, appended to Claude's instructions                             |
| `dockerfile`                            | none: the base image                    | Dockerfile of the repo for its runs' image                                               |
| `allow_branch_docker_images`            | `false`                                 | runs on a pull request use the Dockerfile of its branch; never for forks                 |
| `caches`                                | none                                    | absolute paths in the sandbox kept in a volume per repo and path                         |
| `hosts`                                 | none                                    | extra hosts the sandbox may reach (`name`, `"*.domain"`); only if the operator allows it |
| `mounts`                                | none                                    | host paths requested (`- path: /nfs/work/api`, `read_only`); only under granted roots    |
| `modes.<name>`                          | none                                    | the repo's own modes, picked with `/mode <name>` (see Modes)                             |
| `inbox.ideas`, `inbox.bugs`             | none                                    | issue numbers whose comments are ideas or bug reports to file (see Inboxes)              |
| `inbox.discussions`                     | none                                    | GitHub Discussions category whose discussions Claude answers (see Inboxes)               |
| `preview.command`                       | none                                    | preview hook command (a plain string `preview: ./x.sh` works too)                        |
| `preview.image`                         | the repo's image                        | image the hook runs in; it needs a Docker client                                         |
| `preview.timeout_minutes`               | `30`                                    | the hook is stopped after that                                                           |

## Network and mounts

Sandboxes reach the outside through an egress proxy only: Anthropic's API, GitHub, the
operator's `ALLOWED_HOSTS` and what the operator grants the repository, plus the repo's
`hosts` when the operator allows it. Anything else is refused with a `403` saying so. Quote
patterns that start with `*`: YAML reads a bare `*` as an alias.

```yaml
hosts: [registry.npmjs.org, "*.pythonhosted.org", pypi.org]
```

Like `mounts`, `hosts` is a request: anyone who can push to the default branch could
otherwise open the sandbox's network.

- When the operator sets `allow_repo_hosts: true` for the repository in their grants file,
  its `hosts` are added to what its sandboxes reach.
- Otherwise its `hosts` may only list what the operator already allows it (they change
  nothing); any other host stops the runs, and the reply lists it with the file's errors.
  Ask the operator to grant it, or to set `allow_repo_hosts`.
- `"*"` and whole top-level domains (`"*.com"`) are always errors here: only the operator
  can open that much.

The onboarding issue says which case applies. See
[Security model](security.md#a-repositorys-own-hosts).

A `mounts` entry is only a request: it is mounted when the operator grants the repository a
root holding it, after resolving `..` and symlinks. Otherwise the run stops and the reply
says which path was refused and why. See [Security model](security.md).

### YAML

The listener has no dependencies, so it reads the part of YAML a config needs: mappings,
lists (block and `[a, b]`), `{ a: 1 }` on one line, quoted and plain values, `|` and `>`
blocks, comments. Anchors, aliases, tags and several documents in one file are refused
with the line number.

## Images

Every run starts from an image:

- **The base image** (`SANDBOX_IMAGE`, `deckhand-sandbox`): the harness only: `git`, `gh`
  (through the token broker), `jq`, `ripgrep`, Node 22, Playwright with Chromium, the
  entrypoint and the draft pull request hooks. No project toolchain, and **no Claude Code**:
  before the first run that needs it, the listener installs the pinned
  `CLAUDE_CODE_VERSION` in a short container of its own, into the shared
  `deckhand-claude-code` volume; later runs reuse it.
- **The repo's image**, when `dockerfile` is set: built `FROM` the base image, by the
  listener, from the default branch, with normal network access (not through the egress
  proxy: install the toolchain there rather than in `setup`). Name the base with a build argument, so the
  operator's image name isn't written in the repo:

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
Dockerfile can `COPY` files from it. The image is tagged `deckhand-repo-<owner>-<repo>:<hash>`,
the hash covering the base image and the Dockerfile: the listener builds again when either
changes, and otherwise reuses the image. It keeps the three most recent tags per repo and
removes older ones, the default branch's newest first among those kept. While an image builds, the run shows "building image" on the
dashboard, and the build log is in the run's log. A failed build fails the run, with a
reply on GitHub.

Only the Dockerfile's own content is hashed: a change in a file it copies builds a new
image once the Dockerfile changes, or the base image does.

**Branch images.** With `allow_branch_docker_images: true`, a run triggered from a pull
request (a comment or review on it) uses the Dockerfile of the pull request's head commit,
with that commit as the build context. Its image is tagged
`deckhand-repo-<owner>-<repo>:branch-<hash>`, the hash covering the commit too: each new
commit builds again (Docker's layer cache helps), and the default branch never runs on an
image a branch built. Never for a pull request from a fork: those use the
default branch's image. Builds run on the host's Docker, so only turn this on for
repositories whose branches you trust like the default branch.

## Caches

Each path in `caches` gets a named Docker volume per repo and path
(`deckhand-cache-<owner>-<repo>-<path>-<hash>`), mounted at that path in every run of the
repo. Package manager caches are the usual use: `/home/node/.npm`, `/home/node/.cache/pip`,
`/home/node/.local/share/pnpm`. A new volume is handed to the sandbox's user. Paths the
sandbox mounts itself (`/workspace`, `/home/node/.claude`, `/opt/claude-code`,
`/screenshots`) are refused.

## Setup and light runs

`setup` runs with `bash -c` in the clone, after the task's branch is checked out and before
Claude starts, on every work run (a follow-up comment starts a new container). Its output
goes to the run's log. If it fails, the run goes on and Claude is told.

Brainstorms are light runs: no branch, no setup command, so the answer comes quickly. So
are the repo's modes with `light: true`.

## Instructions

The file named by `instructions` is read from the default branch and appended to the
generic sandbox instructions (`prompts/sandbox.md`) under "This project". Put there what
the generic rules can't know: language of the product, services and how to start them,
checks to run.

## Modes

A run is in a mode: **work** (implement, the default), **brainstorm** (discuss, no code),
**onboarding** (propose this file, see [Onboarding](#onboarding)), or one of the repository's own, declared under `modes:`. A `/mode <name>` line in a comment
picks one, on its own line or after the trigger on the first one (`Deckhand /mode review`;
`/mode` is never read as `/model`; names are not case-sensitive):

```text
Deckhand
/mode review
Focus on the error handling.
```

- **With the trigger line**, it starts that mode. Without one, on an issue that already has
  a session, it **switches**: the new mode goes on in the same session, so it starts from
  the conversation so far, as long as both modes are light or neither is. A light run has
  a clone and session of its own, apart from work's: `/mode work` after a light review starts
  from the issue and its comments, where the review posted what it found.
- **A comment with neither** goes on in the issue's current mode. The trigger line alone,
  or `/mode work`, goes back to work; `/mode brainstorm` to a brainstorm, which `/stop` wraps
  up. Brainstorms stay on issues: `/mode brainstorm` on a pull request is ignored.
- **An unknown name** gets a reply listing the modes, and nothing runs. So does a comment
  for a mode that was removed from the config since.
- Work is the default: there is no `default_mode`.

Each mode of `modes:` takes these keys; any other key, a built-in name or a bad path is an
error, listed in the reply:

| Key            | Default                                   | What                                                                         |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `instructions` | required                                  | Markdown file of the repo, read from the default branch, like `instructions` |
| `light`        | `false`                                   | `true`: no branch, no `setup`, a read-only token: it can only comment        |
| `session`      | `issue`                                   | `issue`: the issue's session, kept; `fresh`: a new one each run, not kept    |
| `model`        | `model`, or `brainstorm_model` if light   | its model                                                                    |
| `effort`       | `effort`, or `brainstorm_effort` if light | its thinking effort                                                          |

- **Names**: letters, digits, `-` and `_`. `work` and `brainstorm` can't be redefined (set
  their model with `model`/`effort` and `brainstorm_model`/`brainstorm_effort`);
  `onboarding`, `stop`, `idea`, `bug` and `discussion` are reserved.
- **Prompt**: the generic sandbox instructions (`prompts/sandbox.md`, and the repo's
  `instructions`) as for every run, then a short frame (the issue or pull request to read,
  what the mode may do) and the mode's file.
- **Light modes** run like a brainstorm: the shorter pause, before queued work, no branch
  and no `setup`. They only comment: their GitHub token can read the code, issues and pull
  requests, not push or write, and their final message is the reply. They can run on pull
  requests, where a review mode is most useful.
- **Full modes** run like work: the issue's branch and draft pull request, `setup`, a token
  that can push.
- **Fresh modes** (`session: fresh`) start a new session on every run and don't keep it:
  the issue stays in the mode it was in, and its next run continues its own session.
- **A mode narrows, never widens**: the hosts, mounts and limits of every run of the repo
  are the same whatever the mode (the operator's grants and what they let the repo's
  `hosts` and `mounts` add). A mode has no key for them.

The dashboard names the repo's modes next to the issue, and in each run.

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
- **Discussions**: a category of the repository's GitHub Discussions (create it first, for
  example "Ask Claude"; compared loosely, emoji aside). A new discussion in it, and every
  later comment of an allowed user, gets an answer in the discussion, in the thread of the
  comment it answers; the discussion keeps one session, like a brainstorm. When it settles
  on something to build, Claude files an issue and links it. Other categories are never
  read. These runs alone get a token with the Discussions permission (see
  [Setting up](setup.md) for an App created before it). Prompt: `prompts/discussion.md`.

## Preview hook

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
treat it as untrusted input. Holding the Docker socket is root on the host.

Hooks of one repository run one at a time, in delivery order. At most 3 wait behind the
running one: deliveries past that are dropped (and logged), since anyone can open pull
requests. A newer delivery for a pull request (or a workflow run) whose hook still waits
replaces it, so the hook may not see every event: have it bring the preview to the state the
event describes (open, updated, closed) rather than react to each action. A hook is **busy** for as
long as its command runs: the listener's `/status` lists it and isn't idle meanwhile, so a
restart that waits for it doesn't cut a deployment short. A hook that starts something
should wait until it is up before exiting. Its output is kept in the data volume, under
`previews/`.
