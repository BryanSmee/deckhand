# Setting up Deckhand

Deckhand runs on your own server with your own private GitHub App and your own Claude
credential. You need Docker Engine 26 or later with the compose plugin, and an HTTPS address
that GitHub can reach (your reverse proxy, or a tunnel) forwarding to the listener's port.

## 1. Start the listener

```sh
cp .env.example .env
# ALLOWED_USERS: the GitHub logins allowed to start runs (required: no start without it)
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY
# Optional: the other settings in a file you can commit (see Settings below); then
# uncomment its line under the listener's volumes in compose.yaml
cp config.example.yaml config.yaml
docker compose pull
docker compose up -d
docker compose logs listener
```

Compose runs three images, published for each release (`DECKHAND_VERSION`, default
`latest`): the listener's, the egress proxy's (the only way out of the sandboxes' internal
network, see [Security model](security.md)), and the base sandbox image runs start from
(the `sandbox` service only pulls it and exits). A repository can bring its own image
`FROM` that base: see [Per-repo config](repo-config.md). The listener publishes port 8080
(`PORT` to change it); point your reverse proxy at it.

To build the images from this checkout instead: `docker compose up -d --build`.

## 2. Create the GitHub App

The logs print a one-time setup link: `…/setup?token=…`. Open it through your public
address (for example `https://deckhand.example.com/setup?token=…`):

1. Check the public URL (detected from your browser's address, or `PUBLIC_URL`), pick the
   App's name, and the organization that should own it (empty: your personal account).
2. GitHub shows the App with its permissions and events. Create it.
3. GitHub sends you back to the listener, which stores the App's ID, private key and
   webhook secret in its data volume (`/data/app.json`, readable by the listener only), then
   on to the App's installation page: pick the repositories Deckhand may work on. Each one
   without a `.deckhand.yaml` gets an onboarding issue (see Onboarding below).

Once an App is stored, `/setup` is closed. To start over, delete `/data/app.json` from the
`data` volume and restart the listener.

What the App asks for:

| Permissions                                     | Events                                        |
| ----------------------------------------------- | --------------------------------------------- |
| Issues, Pull requests, Contents: read and write | `issues`, `issue_comment`, `pull_request`     |
| Deployments, Discussions: read and write        | `pull_request_review`                         |
| Actions, Metadata: read                         | `pull_request_review_comment`, `workflow_run` |
|                                                 | `discussion`, `discussion_comment`            |
|                                                 | `push`                                        |

An App created before Deckhand answered discussions lacks the `discussion` events and the
Discussions permission: add them in the App's settings (_Permissions & events_), then accept
the new permissions on its installation. Everything else works without them. `push` only
tells the dashboard's repository list that a default branch changed; an App without it
(created before the list) sees a config pushed straight to the default branch within half an
hour, and one merged through a pull request at once.

An App created before `/after` lacks the `issues` event: turn on **Issues** under _Subscribe
to events_ in its settings. Without it, a comment waiting for an issue (`/after #77`) still
starts, at the listener's next check of what it waits for (every 15 minutes, and at each
start), rather than at once; a pull request that merges is seen either way. Issues opened with an **Open questions** section aren't labelled
`NEEDS_INPUT_LABEL`, answering them doesn't take the label off unless a run starts, and the
dashboard only sees the label change when the listener restarts.

## 3. Use it

On an issue of an installed repository, an allowed user comments `Deckhand` (the
whole first line, any case or punctuation; the rest are instructions). The sandbox opens the
branch `issue-<n>-<slug>` and a draft pull request, and Claude's final message comes back as a
comment from the App's bot.
`Deckhand` then a `/mode brainstorm` line (or `Deckhand /mode brainstorm`) discusses the issue
without code; `/stop` wraps it up.

**Onboarding.** When the App is installed on a repository (at creation, or added to the
installation later) that has no `.deckhand.yaml` on its default branch, the listener opens an
issue there, "Set up Deckhand for this repository", labelled `deckhand-onboarding`. Claude
reads the repository and replies with a proposed `.deckhand.yaml` (and a Dockerfile or
instructions file when needed), each key with its reason, within what you allow. Comments on
the issue change the proposal, with a read-only token: nothing is pushed. A comment whose
first line is `Deckhand` (or `/mode work`) confirms it: Claude opens a pull request with
only the agreed files, and the listener checks the branch's config and adds any errors or
warnings to its reply. Merge it, and the next runs use the config. See
[Onboarding](repo-config.md#onboarding).

Only installations by someone in `ALLOWED_USERS`, on repositories `ALLOWED_REPOS` lets
through, open an issue; the others are skipped, with the reason in the listener's logs. A
repository gets one onboarding issue, ever (`/data/onboarding.json`), so reinstalling the App
opens no second one. `ONBOARDING=off` turns the automatic issue off; a `/mode onboarding`
comment on any issue starts the same conversation by hand, for repositories installed
before, or skipped. The dashboard's **Repositories** page lists them and starts it with a
button (see [the dashboard](#4-the-dashboard)).

A repository can also declare inboxes in its `.deckhand.yaml`: an ideas issue and a bug
reports issue, where every comment of an allowed user becomes a labelled GitHub issue (or an
answer), and a GitHub Discussions category (for example "Ask Claude") where Claude answers
allowed users' questions. See [Inboxes](repo-config.md#inboxes).

Each repository can add a `.deckhand.yaml` on its default branch: its own users (narrowing
`ALLOWED_USERS`), trigger word, models, parallel cap, setup command, instructions,
Dockerfile, caches and preview hook. See [Per-repo config](repo-config.md). A Dockerfile, a
preview hook, extra hosts and host mounts only take effect once you grant them to that
repository in your grants file (see [Security model](security.md#the-grants-file)).

## 4. The dashboard

Open the listener's public address (`/`) and sign in with GitHub: the App's sign-in
(user-to-server OAuth) tells the listener who you are, and only `ALLOWED_USERS` get in; anyone
else sees who they are signed in as and a refusal. The token GitHub returns is only used to
read your login, then revoked; the session is a signed cookie valid for 7 days, checked
against `ALLOWED_USERS` on every request (the key is `/data/session.key`). `/status` also
answers calls from inside the container (`docker compose exec listener …`) without a session.

Apps created by `/setup` before the dashboard had sign-in have no callback URL: on the App's
page on GitHub (Settings → Developer settings → GitHub Apps → your App → General), add
`<public URL>/auth/callback` under **Callback URL** and save.

The dashboard lists every issue, pull request and discussion Deckhand worked on, by title,
with a tab per repository (the most recently active first; each counts its running tasks and
those waiting for you) and chips by state: running (queued and `/after` waits too), needs input (a brainstorm waiting for your
comment too), ready for review, done, error. Titles come with the webhooks; for tasks from before the dashboard
had them, the listener asks GitHub once and keeps them in `titles.json` in its data volume.

Each task also links to its pull request (the one that closes its issue, or the pull request
itself), with a badge for its state: draft, ready for review, merged or closed. The
`pull_request` webhooks keep it current, in `pulls.json`; for tasks from before, the listener
looks through each repository's 100 most recently updated pull requests once per start. The
**Ready for review** chip lists the pull requests waiting for you, and the tab's title counts
them ("(2) Deckhand"). **Notify me** (top right) asks your browser for notifications: while a
dashboard tab is open, a pull request that turns ready for review raises one, which opens it
when clicked.

**Graph** (top right, `#/graph`, or `#/graph/<owner>/<repo>` for one tab) draws the same
tasks as a graph: an arrow goes from an issue to each one waiting for it (`/after`), drawn left
to right (top to bottom on a phone), and the issues a task waits for show even when Deckhand
never worked on them. Issues with no arrow stand in a grid below. A node is gray while it
waits or nothing runs, outlined in orange when it needs your input, blue while it runs, red
after an error (dashed red arrows: what waits for it keeps waiting), filled orange when its
pull request is ready for review, and green once implemented: the issue closed as completed,
or its pull request merged. Whether an issue is closed comes with the `issues` and
`pull_request` webhooks; the rest is asked of GitHub with its title, kept in `closed.json`,
and what was open is asked again once per start. A node opens its task; one Deckhand never
worked on opens on GitHub.

Each task shows its listener's state:

| State             | What                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `queued`          | comments wait for a run (a free slot, or the running one)               |
| `building image`  | a run waits for the repository's image to build                         |
| `working`         | a run is in progress                                                    |
| `stopping`        | a brainstorm is wrapping up (`/stop`)                                   |
| `needs input`     | the last run stopped to ask; the issue has the label                    |
| `brainstorm`      | a brainstorm waits for your next comment                                |
| `idle brainstorm` | no comment for a while; the next one restores the session               |
| `done`, `error`   | how the last run ended (`interrupted`: a restart came before its start) |

Pick one to see the first line of its last reply and its latest run's log live (and the
next runs as they start), or an earlier run. The address keeps the tab, task and run, so a
link opens the same view. On a phone, the list and the log take the whole screen in turn.

**Repositories** (top right, with the count of those not onboarded) lists every repository
the App is installed on that `ALLOWED_REPOS` lets through, archived ones aside: `configured`
(its default branch has a `.deckhand.yaml`), `onboarding` (with a link to its onboarding
issue) or `not onboarded`. **Start onboarding** on a `not onboarded` row opens its onboarding
issue as an installation would, mentioning you, and starts the conversation: the way to
onboard repositories installed before onboarding existed, by someone not in `ALLOWED_USERS`,
or with `ONBOARDING=off`. A repository with issues disabled shows why it can't be onboarded.
A repository shows `invalid config` when no run starts there: its `.deckhand.yaml` has
errors, or asks for what the operator's grants file refuses (a `dockerfile` or `preview`
without its grant, `hosts` without `allow_repo_hosts`, a mount outside the granted roots), or
the grants file itself has errors. The list is cached: the installations' repositories are
read again every 5 minutes, each configuration every 30 minutes, or at once after a push or a
merged pull request on its default branch. The grants file is checked at each load, so editing
it shows at once. **Refresh** reads everything again, in case a webhook was missed.

A repository's name opens its configuration, read from its default branch then: what stops
its runs (errors, and what it asks for that the operator doesn't grant) and its warnings first, then
what its runs get (each value from the repository, from the operator, or refused), its entry
in the grants file, and the raw file. Anyone signed in to the dashboard sees it, grants
included. Its **Refresh** reads it again (at most every 5 seconds); changing it is a commit on
the default branch.

## Settings

Each setting can come from the environment (`.env`, read by `compose.yaml`) or from
`config.yaml`, a file you can commit in your deployment's repository and review line by line.
Secrets (the Claude credential) stay in `.env`; the App's are in `/data/app.json`.

- **Keys:** each setting's environment variable in lowercase (`ALLOWED_USERS` →
  `allowed_users`), lists as YAML lists, `onboarding` as `true` or `false`.
- **Precedence:** an environment variable that is set and not empty wins, then
  `config.yaml`, then the default below. `NEEDS_INPUT_LABEL` is the exception: set and
  empty in `.env`, it still wins (no label); `needs_input_label: ""` does the same in the file.
- **Read at start only:** restart the listener (`docker compose restart listener`) after an
  edit. Unlike the grants file, it isn't read again.
- **Fail closed:** an unknown key, a value of the wrong type, a bad value or a secret in the
  file stops the listener, naming the key (`/etc/deckhand/config.yaml: max_parallel:
expected a whole number of sandboxes, got lots`). The file is optional; `ALLOWED_USERS`
  is required from one or the other.

The listener reads `/etc/deckhand/config.yaml` (`CONFIG_FILE` to change it). Copy
`config.example.yaml` to `config.yaml` and uncomment its line in `compose.yaml`'s `volumes`:

```yaml
# config.yaml
allowed_users: [alice, bob]
allowed_repos: [acme/api, acme/web]
allowed_hosts:
  - registry.npmjs.org
  - "*.pypi.org"
trigger: Deckhand
sandbox_model: opus
sandbox_effort: medium
brainstorm_model: sonnet
max_parallel: 2
sandbox_cpus: 2
sandbox_memory: 4g
sandbox_pids: 2048
conflict_check_minutes: 5
onboarding: true
needs_input_label: needs-input
```

| Setting                                          | `config.yaml` key                                | Default                            | What                                                                            |
| ------------------------------------------------ | ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------- |
| `ALLOWED_USERS`                                  | `allowed_users`                                  | none: required                     | GitHub logins that can start runs                                               |
| `ALLOWED_REPOS`                                  | `allowed_repos`                                  | all where the App is installed     | narrows the repos (`owner/repo`, comma-separated in `.env`)                     |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`  | none: a secret, `.env` only                      |                                    | Claude credential passed to each sandbox                                        |
| `PUBLIC_URL`                                     | `public_url`                                     | stored by `/setup`                 | the listener's public address                                                   |
| `PORT`                                           | none: compose's                                  | `8080`                             | the host port compose publishes the listener on                                 |
| `CLAUDE_CODE_VERSION`                            | `claude_code_version`                            | `2.1.300`                          | Claude Code version the sandboxes install on first use                          |
| `SANDBOX_MODEL`, `SANDBOX_EFFORT`                | `sandbox_model`, `sandbox_effort`                | `opus`, `medium`                   | defaults; a comment's `/model` and `/effort` lines override them                |
| `BRAINSTORM_MODEL`, `BRAINSTORM_EFFORT`          | `brainstorm_model`, `brainstorm_effort`          | `SANDBOX_MODEL`, `SANDBOX_EFFORT`  | the same for brainstorms, inbox entries and discussions                         |
| `BRAINSTORM_IDLE_MINUTES`                        | `brainstorm_idle_minutes`                        | `10`                               | minutes without a comment before a brainstorm shows as idle                     |
| `MAX_PARALLEL`                                   | `max_parallel`                                   | `2`                                | sandboxes running at once (a repo's `max_parallel` within it)                   |
| `ALLOWED_HOSTS`                                  | `allowed_hosts`                                  | none                               | hosts every sandbox may reach besides Anthropic and GitHub                      |
| `SANDBOX_CPUS`, `SANDBOX_MEMORY`, `SANDBOX_PIDS` | `sandbox_cpus`, `sandbox_memory`, `sandbox_pids` | `2`, `4g`, `2048`                  | each sandbox's limits (per repo: the grants file)                               |
| `TRIGGER`                                        | `trigger`                                        | `Deckhand`                         | first line of a comment that starts a run                                       |
| `ONBOARDING`                                     | `onboarding`                                     | on                                 | `off`: no onboarding issue when the App is installed on a repo without a config |
| `NEEDS_INPUT_LABEL`                              | `needs_input_label`                              | `needs-input`                      | label while a run or an issue waits for answers (empty: none)                   |
| `CONFLICT_CHECK_MINUTES`                         | `conflict_check_minutes`                         | `5`                                | shortest interval of a repo's `conflicts.check_minutes`; `0` turns it off       |
| `NAME_PREFIX`, `CLAUDE_CODE_VOLUME`              | `name_prefix`, `claude_code_volume`              | `deckhand`, `deckhand-claude-code` | names of what the listener creates on Docker                                    |
| `DOCKER_SOCKET`                                  | none: compose's                                  | `/var/run/docker.sock`             | the host's Docker socket, as preview hooks mount it                             |
| `DECKHAND_VERSION`                               | none: compose's                                  | `latest`                           | the release compose runs (`1.2.3`, `1.2`): see [Updating](#updating)            |
| `DECKHAND_REGISTRY`                              | none: compose's                                  | `ghcr.io/bryansmee`                | where compose pulls the images from                                             |
| `SANDBOX_NETWORK`, `SHOTS_VOLUME`, `RUNS_VOLUME` | none: compose's                                  | `deckhand-…`                       | names of the network and volumes compose creates and the listener uses          |

### Advanced settings

The listener and the egress proxy also read these. `compose.yaml` doesn't take them from
`.env`: it sets some itself, to match the services and volumes it defines, and leaves the
others to their defaults. To change one, set its key in `config.yaml` when it has one, or
else set it in the service's `environment`, for example in a `compose.override.yaml`.

| Setting                           | Key                        | Default                                        | What                                                                                                      |
| --------------------------------- | -------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GRANTS_FILE`                     | `grants_file`              | `/etc/deckhand/grants.yaml`                    | what you grant each repo: hosts, host mounts, limits, preview hook, Dockerfile (`compose.yaml` mounts it) |
| `INSTALL_NETWORK`                 | `install_network`          | `bridge`                                       | network of the Claude Code install container (needs npm)                                                  |
| `DEBOUNCE_MS`                     | `debounce_ms`              | `15000`                                        | pause after a comment before its run starts, so that comments posted together go in one run               |
| `BRAINSTORM_DEBOUNCE_MS`          | `brainstorm_debounce_ms`   | `3000`                                         | the same before a light run (brainstorms, onboarding, light modes)                                        |
| `DATA_DIR`                        | none                       | `/data`                                        | the listener's state: the App's credentials, logs, queue, runs (the `data` volume)                        |
| `DASHBOARD_DIR`                   | none                       | the image's `dashboard/dist`                   | the built dashboard the listener serves                                                                   |
| `SANDBOX_IMAGE`                   | none                       | `<NAME_PREFIX>-sandbox`                        | the base image runs start from; compose sets the release's                                                |
| `BROKER_PORT`                     | none                       | `8081`                                         | port of the token broker, git gateway and egress policy, on the sandboxes' network                        |
| `BROKER_URL`                      | none                       | `http://listener:<BROKER_PORT>`                | the broker, as sandboxes reach it; compose sets it                                                        |
| `EGRESS_PROXY`                    | none                       | `http://egress:3128`                           | the egress proxy, as sandboxes reach it; compose sets it                                                  |
| `POLICY_URL` (egress proxy)       | none                       | `http://listener:8081/egress`                  | where the proxy asks whether a sandbox may reach a host; compose sets it                                  |
| `PORT` (in the containers)        | none                       | `8080`, egress proxy: `3128`                   | port the listener and the proxy listen on; the `PORT` above only changes the published one                |
| `GITHUB_URL`, `GITHUB_API`        | `github_url`, `github_api` | `https://github.com`, `https://api.github.com` | GitHub's web and API addresses, always allowed through the egress proxy                                   |
| `CONFIG_FILE`                     | none                       | `/etc/deckhand/config.yaml`                    | the settings file above; set on purpose, it has to exist                                                  |
| `DECKHAND_VERSION` (in the image) | none                       | set when the image is built                    | the version the dashboard shows                                                                           |

## Updating

Each release is a git tag (`v1.2.3`) that publishes the three images, tagged `1.2.3`, `1.2`
and `latest`. There is no built-in updater: update the way you update other compose
services.

```sh
docker compose pull
docker compose up -d
```

- **`latest`** (the default): the two commands above take the newest release. Watchtower
  can run them for you.
- **A pinned version**: set `DECKHAND_VERSION=1.2.3` in `.env`, change it to update (by
  hand, or with Renovate's docker-compose or regex manager), then the same two commands.

You can update at any time, runs in progress included. The listener stops within its grace
period without waiting for them: it starts no new run, saves the comments still waiting for
one, and the sandboxes keep running. The new listener finds them again by their Docker
labels, delivers the comments that arrive meanwhile, and posts each run's final reply once,
even for a run that finished while no listener was there. Queued comments are then handled.
A new base image rebuilds a repository's own image on its next run (see
[Per-repo config](repo-config.md)); running sandboxes keep the image they started with.

## How sandboxes reach GitHub

No sandbox gets a long-lived token, an SSH key or the host's git configuration:

- Each run gets a random secret, valid while the run lasts.
- Its git credential helper and `gh` wrapper send that secret to the listener's token
  broker (port 8081, on the `deckhand-sandboxes` network only, not published) on every
  call, and get back an installation token limited to the run's repository, with issues
  and pull requests (read and write), contents, actions and metadata (read); discussions
  too (read and write) for runs answering a discussion, and only those. Installation tokens
  last an hour; the broker renews them before that, so a run can go on for hours.
- Git fetches from GitHub over HTTPS with that token, and pushes through the listener's git
  gateway (same port, with the run's secret), which pushes the run's own branch only (its
  issue's `issue-<n>-*`, or its pull request's head), never the default one, with a token of
  its own (see [Security model](security.md#the-default-branch)). The
  listener also marks a run's pull request ready for review (`gh pr ready`), which that
  token can't. Commits
  and comments come from the App's bot (`<app>[bot]`, identity set through `GIT_AUTHOR_*`
  and `GIT_COMMITTER_*`).

Claude Code is not part of any image: before the first run that needs it, the listener
installs the pinned `CLAUDE_CODE_VERSION` into the `deckhand-claude-code` volume, in a
container of its own, and later runs reuse it, read-only.

## Isolation

Sandboxes run without capabilities and with CPU, memory and pids limits, get no host path
unless you grant one, and reach only Anthropic, GitHub and the hosts you or the repository
allow, through the egress proxy. See [Security model](security.md): the grants file, host
mounts, the mandatory hosts, and what isn't covered.

Upgrading from a version whose `deckhand-sandboxes` network wasn't internal: stop the stack,
`docker network rm deckhand-sandboxes`, and start it again so compose creates it internal.
Until then the listener refuses to start runs.

Upgrading from a version where a repository's `.deckhand.yaml` alone decided its preview
hook, Dockerfile and branch images: grant them in your grants file, for each repository
that uses them (or every one, under `"*"`), with `allow_preview: true`,
`allow_dockerfile: true` and `allow_branch_docker_images: true`. Until then that
repository's runs stop with a reply naming the missing grant, its preview hook doesn't run
(the listener's logs say why), and `allow_branch_docker_images` in its `.deckhand.yaml` is
ignored with a warning in the run's log.
