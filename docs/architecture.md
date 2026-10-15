# How the listener works

The listener (`listener/`) receives the GitHub App's webhooks, runs Claude Code in a sandbox
container (`sandbox/`) for issue, pull request and discussion comments, one container and one
set of volumes per issue, and posts Claude's final message back as a comment. This page is
the map: what a comment turns into, and which module does what. Setup is in
[setup.md](setup.md), the per-repo file in [repo-config.md](repo-config.md), the security
model in [security.md](security.md).

## From a comment to a reply

- **On an issue**: `Deckhand` (`TRIGGER`) as the first line starts the work; the other lines
  are extra instructions. Once started, any comment continues the session. The sandbox opens
  the branch and draft pull request (`sandbox/draft-pr.sh`).
- **On its pull request**: any comment, review or review comment continues the same session.
- **Anywhere**: `/model sonnet` or `/effort high` lines pick the model or thinking effort for
  that run (defaults: `SANDBOX_MODEL`, `SANDBOX_EFFORT`).

A comment that arrives while its issue's run is working goes to that run: after the usual
pause (so a burst is one message), the listener writes it to the run's inbox (stream-json
input, `TASK_INPUT=stream` in `sandbox/entrypoint.sh`), and Claude sees it after its current
tool call; the run's final message is still the one reply and covers it. `/model` and
`/effort` cannot change a live process: they apply to the next run, and the reply says so.
Comments the run cannot take (a trigger that switches between work and brainstorm, a wrap-up,
or one arriving once Claude's input is closed) wait for a follow-up run.

### Brainstorms

`Deckhand` then `/mode brainstorm` (or `Deckhand /mode brainstorm` on one line) starts a
brainstorm instead: Claude discusses the issue (`prompts/brainstorm.md`) without writing
code, and each later comment on the issue is the next message of that conversation. A
brainstorm run starts light (`SANDBOX_LIGHT`) after a short pause (`BRAINSTORM_DEBOUNCE_MS`)
and goes before queued work. `/stop` ends it: Claude posts a summary and updates the issue's
description, then comments no longer reach it until a trigger line. After
`BRAINSTORM_IDLE_MINUTES` (10) without a comment it shows as idle; a comment then restores it
from the issue's session volume. `Deckhand` or `/mode work` afterwards implements in the same
session, so the decisions carry over. Issues only.

### Modes

A `/mode <name>` line picks a mode: work, brainstorm or one of the repo's own (its config's
`modes:`), with the trigger line, or alone on an issue that has a session, which then goes on
in the new mode with its conversation so far. A repo's mode brings its own instructions,
model and effort; a light one runs like a brainstorm and only comments (its token only
reads), a fresh one starts a new session each time. Comments without a trigger or `/mode`
line go on in the issue's current mode (`modes.json`).

### Inboxes and discussions

A repo's config may name an ideas issue, a bugs issue and a discussions category. Every
comment on those issues is an entry, answered in a fresh session (`prompts/idea.md`,
`prompts/bug.md`); each discussion in the category is a conversation of its own, like a
brainstorm (`prompts/discussion.md`). No trigger line there.

### Onboarding

Installing the App on a repo without a `.deckhand.yaml` (an `installation` or
`installation_repositories` delivery, sent to every App) opens an onboarding issue there and
starts the `onboarding` mode on it: a light conversation like a brainstorm, with a read-only
token, where Claude proposes the file (`prompts/onboarding.md`). Comments go on in it; the
trigger line or `/mode work` opens the pull request, and the reply says what the listener
makes of the branch's config. `/mode onboarding` starts it on any issue.

### Replies, reactions and labels

A run that stops to ask (its final message starts with `<!-- needs-input -->`, see
`prompts/sandbox.md`) shows as `needs-input` on the dashboard and labels the issue or pull
request `NEEDS_INPUT_LABEL` (default `needs-input`) until the next run starts.

Reactions on the triggering comment follow its run: 👀 when it is received, then 🚀 (done),
😕 (needs input) or 👎 (error) once the run that handled it is over.

## Around the runs

- **GitHub**: the operator's private App, created at `/setup` and stored in the data volume.
  The listener calls GitHub with installation tokens; sandboxes get none up front and ask the
  broker (`BROKER_PORT`, only on the sandboxes' network) for a fresh token limited to their
  repo, with a secret that dies with the run. Those tokens only read the code: pushes go
  through the git gateway on the same port, which never lets one reach the default branch.
- **Dashboard**: `GET /` shows every repo's issues and pull requests, their state and live
  logs, to `ALLOWED_USERS` signed in with GitHub through the App, built from `dashboard/`.
  `GET /status` says what is going on, to them and to calls from inside the container.
- **Screenshots**: `GET /shots/<token>/<file>` serves the screenshots runs save for their
  pull requests: GitHub cannot take image uploads through its API, so they need a public URL.
- **Per-repo config**: each repo may bring a `.deckhand.yaml` on its default branch: its own
  trigger word, models, parallel cap and users (only narrowing the operator's), a setup
  command and extra instructions for the sandbox, a Dockerfile `FROM` the base image, cache
  volumes, and a preview hook run on `pull_request` and `workflow_run` deliveries. A config
  with errors stops runs, and the reply says why.
- **Isolation**: sandboxes run with no capabilities, `no-new-privileges` and CPU, memory and
  pids limits, on an internal network (checked before each run) whose only way out is the
  egress proxy (`proxy/proxy.mjs`): it asks the broker's port, for each connection, whether
  the sandbox at that address may reach that host. Host mounts only happen under roots the
  operator grants the repo (`GRANTS_FILE`).
- **Who may run**: only comments from `ALLOWED_USERS`, on repos where the App is installed
  (narrowed by `ALLOWED_REPOS` if set), are acted on: the sandbox runs without permission
  prompts and can push.

## Restarts

The listener can restart at any time (an update is `docker compose pull && up -d`).
Sandboxes run detached, through the runner (`runner/docker.mjs`): on SIGTERM the listener
starts no more runs and saves the comments still waiting for one to `queue.json`; each run's
state is in `logs/<run>.live.json` all along. The next listener reads both, finds the
sandboxes by their labels, follows their output from where the previous one stopped, and
posts each reply once.

## Modules

`server.mjs` only wires the listener together. The stateful modules are `createX(ctx)`
factories sharing one `ctx` object (the settings, the GitHub App, the tasks, the runs, the
services); each reads `ctx` when it is called rather than when it is created, so a module can
call one created after it: a finished run (`runs.mjs`) schedules the next one (`tasks.mjs`),
which starts runs.

| Module                                                            | What it does                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `server.mjs`                                                      | Settings, the GitHub App, `ctx`, the modules; starts the servers, restores runs, handles SIGTERM. |
| `http.mjs`                                                        | Webhook deliveries, dashboard and its API, `/status`, screenshots; the broker's egress answers.   |
| `tasks.mjs`                                                       | One queue per issue: which mode a comment asks for, the pause, delivery to a running session.     |
| `runs.mjs`                                                        | A run from start to reply: settings, image, grants, the sandbox, its output, reactions, label.    |
| `restart.mjs`                                                     | `queue.json` and `logs/<run>.live.json`: what a listener leaves to the next one; `/status`.       |
| `brainstorms.mjs`                                                 | Each issue's brainstorm (`brainstorms.json`) and repo mode (`modes.json`).                        |
| `comments.mjs`                                                    | Replies (comments, discussion threads), reactions, the needs-input label.                         |
| `prompts.mjs`                                                     | What Claude reads: each run's prompt and first message, comments delivered mid-run. Pure.         |
| `modes.mjs`                                                       | Built-in modes: light, fresh, their token's permissions, the dashboard's kind. Pure.              |
| `runlog.mjs`                                                      | Run logs: the list rebuilt after a restart, the dashboard's entries per line, the live stream.    |
| `events.mjs`                                                      | Deliveries → work items, trigger and `/mode` lines, pull request states. Pure.                    |
| `repo-config.mjs`, `yaml.mjs`                                     | `.deckhand.yaml`, read from the default branch and parsed.                                        |
| `grants.mjs`, `egress.mjs`                                        | The operator's grants (hosts, mounts, limits) and the egress policy.                              |
| `github-app.mjs`, `broker.mjs`, `git-gateway.mjs`                 | The App's tokens; the sandboxes' token broker; their pushes, never to the default branch.         |
| `setup.mjs`, `auth.mjs`                                           | `/setup` (creating the App) and signing in with GitHub.                                           |
| `images.mjs`, `checkout.mjs`, `runner/`                           | Repo images, Claude Code's install, caches; checkouts; the Docker runner.                         |
| `onboarding.mjs`, `previews.mjs`                                  | Onboarding issues; preview hooks.                                                                 |
| `board.mjs`, `titles.mjs`, `pulls.mjs`, `repos.mjs`, `static.mjs` | The dashboard's tasks, titles, pull requests, repository list and files.                          |
