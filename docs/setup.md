# Setting up Deckhand

Deckhand runs on your own server with your own private GitHub App and your own Claude
credential. You need Docker Engine 26 or later with the compose plugin, and an HTTPS address
that GitHub can reach (your reverse proxy, or a tunnel) forwarding to the listener's port.

## 1. Start the listener

```sh
cp .env.example .env
# ALLOWED_USERS: the GitHub logins allowed to start runs (required: no start without it)
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY
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
   on to the App's installation page: pick the repositories Deckhand may work on.

Once an App is stored, `/setup` is closed. To start over, delete `/data/app.json` from the
`data` volume and restart the listener.

What the App asks for:

| Permissions                                     | Events                                        |
| ----------------------------------------------- | --------------------------------------------- |
| Issues, Pull requests, Contents: read and write | `issue_comment`, `pull_request`               |
| Deployments, Discussions: read and write        | `pull_request_review`                         |
| Actions, Metadata: read                         | `pull_request_review_comment`, `workflow_run` |
|                                                 | `discussion`, `discussion_comment`            |

An App created before Deckhand answered discussions lacks the last two events and the
Discussions permission: add them in the App's settings (_Permissions & events_), then accept
the new permissions on its installation. Everything else works without them.

## 3. Use it

On an issue of an installed repository, an allowed user comments `Claude work on this`
(first line; the rest are instructions). The sandbox opens the branch `issue-<n>-<slug>` and
a draft pull request, and Claude's final message comes back as a comment from the App's bot.
`Claude let's brainstorm this` discusses the issue without code; `/stop` wraps it up.

A repository can also declare inboxes in its `.deckhand.yaml`: an ideas issue and a bug
reports issue, where every comment of an allowed user becomes a labelled GitHub issue (or an
answer), and a GitHub Discussions category (for example "Ask Claude") where Claude answers
allowed users' questions. See [Inboxes](repo-config.md#inboxes).

Each repository can add a `.deckhand.yaml` on its default branch: its own users (narrowing
`ALLOWED_USERS`), trigger lines, models, parallel cap, setup command, instructions,
Dockerfile, caches and preview hook. See [Per-repo config](repo-config.md).

## 4. The dashboard

Open the listener's public address (`/`) and sign in with GitHub: the App's sign-in
(user-to-server OAuth) tells the listener who you are, and only `ALLOWED_USERS` get in; anyone
else sees who they are signed in as and a refusal. The token GitHub returns is only used to
read your login, then revoked; the session is a signed cookie valid for 7 days, checked
against `ALLOWED_USERS` on every request (the key is `/data/session.key`). `/status` also
answers calls from inside the container (`docker compose exec listener …`) without a session.

Apps created by `/setup` before the dashboard had sign-in have no callback URL: on the App's
page on GitHub (Settings → Developer settings → GitHub Apps → your App → General), add
`<public URL>/auth/callback` under **Callback URL** and save. `DASHBOARD_PASSWORD` is no
longer used.

The dashboard lists every issue, pull request and discussion Deckhand worked on, grouped by project (the
repository's owner) and repository, with filters by repository and state. Each shows its
listener's state:

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

Pick one to see its latest run's log live (and the next runs as they start), or an earlier
run. On a phone, the list and the log take the whole screen in turn.

## Settings

All in `.env`, read by `compose.yaml`:

| Setting                                                                               | Default                        | What                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| `ALLOWED_USERS`                                                                       | none: required                 | GitHub logins that can start runs                                    |
| `ALLOWED_REPOS`                                                                       | all where the App is installed | narrows the repos (`owner/repo`, comma-separated)                    |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`                                       |                                | Claude credential passed to each sandbox                             |
| `PUBLIC_URL`                                                                          | stored by `/setup`             | the listener's public address                                        |
| `CLAUDE_CODE_VERSION`                                                                 | `2.1.300`                      | Claude Code version the sandboxes install on first use               |
| `SANDBOX_MODEL`, `SANDBOX_EFFORT`                                                     | `opus`, `medium`               | defaults; a comment's `/model` and `/effort` lines override them     |
| `MAX_PARALLEL`                                                                        | `2`                            | sandboxes running at once (a repo's `max_parallel` within it)        |
| `ALLOWED_HOSTS`                                                                       | none                           | hosts every sandbox may reach besides Anthropic and GitHub           |
| `SANDBOX_CPUS`, `SANDBOX_MEMORY`, `SANDBOX_PIDS`                                      | `2`, `4g`, `2048`              | each sandbox's limits (per repo: the grants file)                    |
| `GRANTS_FILE`                                                                         | `/etc/deckhand/grants.yaml`    | what you grant each repo: hosts, host mounts, limits                 |
| `EGRESS_PROXY`                                                                        | `http://egress:3128`           | the egress proxy, as sandboxes reach it                              |
| `INSTALL_NETWORK`                                                                     | `bridge`                       | network of the Claude Code install container (needs npm)             |
| `TRIGGER`, `BRAINSTORM_TRIGGER`, `BRAINSTORM_STOP`                                    | `Claude work on this`…         | trigger lines                                                        |
| `NEEDS_INPUT_LABEL`                                                                   | `needs-input`                  | label while a run waits for answers (empty: none)                    |
| `DOCKER_SOCKET`                                                                       | `/var/run/docker.sock`         | the host's Docker socket, as preview hooks mount it                  |
| `DECKHAND_VERSION`                                                                    | `latest`                       | the release compose runs (`1.2.3`, `1.2`): see [Updating](#updating) |
| `DECKHAND_REGISTRY`                                                                   | `ghcr.io/bryansmee`            | where compose pulls the images from                                  |
| `SANDBOX_NETWORK`, `SHOTS_VOLUME`, `RUNS_VOLUME`, `CLAUDE_CODE_VOLUME`, `NAME_PREFIX` | `deckhand-…`                   | names of what the listener creates on Docker                         |

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
  call, and get back an installation token limited to the run's repository, with
  contents, issues and pull requests (read and write), actions and metadata (read);
  discussions too (read and write) for runs answering a discussion, and only those.
  Installation tokens last an hour; the broker renews them before that, so a run can go on
  for hours.
- Git pushes over HTTPS; commits and comments come from the App's bot
  (`<app>[bot]`, identity set through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`).

Claude Code is not part of any image: before the first run that needs it, the listener
installs the pinned `CLAUDE_CODE_VERSION` into the `deckhand-claude-code` volume, in a
container of its own, and later runs reuse it.

## Isolation

Sandboxes run without capabilities and with CPU, memory and pids limits, get no host path
unless you grant one, and reach only Anthropic, GitHub and the hosts you or the repository
allow, through the egress proxy. See [Security model](security.md): the grants file, host
mounts, the mandatory hosts, and what isn't covered.

Upgrading from a version whose `deckhand-sandboxes` network wasn't internal: stop the stack,
`docker network rm deckhand-sandboxes`, and start it again so compose creates it internal.
Until then the listener refuses to start runs.
