# Per-repo config: `.deckhand.yaml`

Each repository can tune its runs with a `.deckhand.yaml` file at its root. Without one, its
runs use the operator's settings and the base image.

The listener always reads it from the repository's **default branch**, at every run: a
change on a branch or in a pull request has no effect until it is merged, so nobody can
change a run's permissions from the code it runs on. The file can only **narrow** the
operator's settings (users, parallel runs), never widen them.

A file with errors stops the repository's runs: the reply to a trigger comment lists them.
Unknown keys and users the operator doesn't allow are only warnings, shown in the run's log
on the dashboard.

## Example

```yaml
# .deckhand.yaml (read from the default branch)

# Who may start runs here: only narrows the operator's ALLOWED_USERS.
users: [alice, bob]

# Trigger lines (first line of a comment), compared loosely.
triggers:
  work: Claude work on this
  brainstorm: Claude let's brainstorm this
  stop: Claude stop

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

# Run on pull_request and workflow_run deliveries (see below).
preview:
  command: ./deploy/preview.sh
  image: docker:27-cli
  timeout_minutes: 30
```

## Keys

| Key                                     | Default                                            | What                                                                                      |
| --------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `users`                                 | `ALLOWED_USERS`                                    | GitHub logins that may start runs here; those not in `ALLOWED_USERS` are ignored          |
| `triggers.work`, `.brainstorm`, `.stop` | `TRIGGER`, `BRAINSTORM_TRIGGER`, `BRAINSTORM_STOP` | trigger lines                                                                             |
| `model`, `effort`                       | `SANDBOX_MODEL`, `SANDBOX_EFFORT`                  | work runs' model and thinking effort (`low`, `medium`, `high`, `xhigh`, `max`)            |
| `brainstorm_model`, `brainstorm_effort` | `BRAINSTORM_MODEL`, `BRAINSTORM_EFFORT`            | the same for brainstorms                                                                  |
| `max_parallel`                          | `MAX_PARALLEL`                                     | runs of this repo at once; capped by `MAX_PARALLEL`                                       |
| `setup`                                 | none                                               | shell command run in `/workspace` before Claude, on work runs                             |
| `instructions`                          | none                                               | Markdown file of the repo, appended to Claude's instructions                              |
| `dockerfile`                            | none: the base image                               | Dockerfile of the repo for its runs' image                                                |
| `allow_branch_docker_images`            | `false`                                            | runs on a pull request use the Dockerfile of its branch; never for forks                  |
| `caches`                                | none                                               | absolute paths in the sandbox kept in a volume per repo and path                          |
| `hosts`                                 | none                                               | extra hosts the sandbox may reach (`name`, `*.domain`, `*`), for the egress proxy (#3)    |
| `mounts`                                | none                                               | host paths requested (`- path: /nfs/work/api`, `read_only`); granted by the operator (#3) |
| `inbox`                                 | none                                               | issue numbers collecting `ideas`, `bugs` and `discussions` (#5)                           |
| `preview.command`                       | none                                               | preview hook command (a plain string `preview: ./x.sh` works too)                         |
| `preview.image`                         | the repo's image                                   | image the hook runs in; it needs a Docker client                                          |
| `preview.timeout_minutes`               | `30`                                               | the hook is stopped after that                                                            |

`hosts`, `mounts` and `inbox` are read and checked now; the egress proxy and mount rules
(#3) and inbox prompts (#5) use them. Until then a mount request grants nothing.

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
  listener, from the default branch. Name the base with a build argument, so the
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

  Keep `USER node` at the end: Claude Code runs as that user (uid 1000).

The build context is the repository at the default branch (downloaded from GitHub), so the
Dockerfile can `COPY` files from it. The image is tagged `deckhand-repo-<owner>-<repo>:<hash>`,
the hash covering the base image and the Dockerfile: the listener builds again when either
changes, and otherwise reuses the image. It keeps the three most recent tags per repo and
removes older ones. While an image builds, the run shows "building image" on the
dashboard, and the build log is in the run's log. A failed build fails the run, with a
reply on GitHub.

Only the Dockerfile's own content is hashed: a change in a file it copies builds a new
image once the Dockerfile changes, or the base image does.

**Branch images.** With `allow_branch_docker_images: true`, a run triggered from a pull
request (a comment or review on it) uses the Dockerfile of the pull request's head commit,
with that commit as the build context. Never for a pull request from a fork: those use the
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

Brainstorms are light runs: no branch, no setup command, so the answer comes quickly.

## Instructions

The file named by `instructions` is read from the default branch and appended to the
generic sandbox instructions (`prompts/sandbox.md`) under "This project". Put there what
the generic rules can't know: language of the product, services and how to start them,
checks to run.

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

Hooks of one repository run one at a time, in delivery order. A hook is **busy** for as
long as its command runs: the listener's `/status` lists it and isn't idle meanwhile, so a
restart that waits for it doesn't cut a deployment short. A hook that starts something
should wait until it is up before exiting. Its output is kept in the data volume, under
`previews/`.
