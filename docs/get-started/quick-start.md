# Quick start

A first run in about 15 minutes, with Docker Compose. [Install with Compose](../guides/install.md) and the other guides have
the details of each step and the rest: other agents, two copies of each service, metrics;
[Server settings](../reference/settings.md) has every setting. On a cluster, see [Deckhand on Kubernetes](../kubernetes.md).

## What you need

- A server with Docker Engine 26 or later and the compose plugin, and Node 20 or later for the
  `deckhand` command (Linux, macOS or WSL2).
- An HTTPS address GitHub can reach (your reverse proxy, or a tunnel), forwarding to edge's
  port, 8080. A home server or a laptop has none: [a stable tunnel](../guides/tunnels.md)
  gives it one (Tailscale Funnel, a cloudflared named tunnel or an ngrok static domain).
- A GitHub account or organization to own the App, and a repository to try it on.
- A Claude credential: a token from `claude setup-token` (your Claude plan) or an
  `ANTHROPIC_API_KEY`. A plan is usually licensed to one person: for a team, use an API key
  ([why](../guides/install.md#a-plan-or-an-api-key)).

## 1. Configure

```sh
git clone https://github.com/BryanSmee/deckhand.git
cd deckhand
cp .env.example .env
cp -r server.example server
```

- In `.env`, set `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. The secrets stay there.
- In `server/config.yaml`, put your GitHub login in `allowed_users`. Nobody else can start a
  run, and with nobody there, nothing starts.

The `server/` folder holds every other setting, and in `server/grants/` what each repository
gets beyond a bare sandbox (hosts, a Dockerfile, mounts). It grants nothing until you change it:
leave it for now ([The server folder](../reference/server-folder.md)).

## 2. Start

```sh
node cli/deckhand.mjs up
docker compose logs edge
```

`deckhand up` pins the latest release in `.env` (`DECKHAND_VERSION`), moves the checkout to its
tag so `compose.yaml` matches it, pulls every image (the sandbox's too) and starts the services.
Edge's logs print a one-time setup link, `…/setup?token=…`.

## 3. Create the GitHub App

Open the setup link through your public address, for example
`https://deckhand.example.com/setup?token=…`:

1. Check the public URL, pick the App's name, and the organization that owns it (empty: your
   own account).
2. GitHub shows the App with its permissions and events, filled in for you. Create it.
3. GitHub then sends you to the App's installation page: pick the repositories Deckhand may
   work on.

The App is private, so it installs only on the account that owns it. For repositories in
several organizations, see
[Installing it on several organizations](../guides/github-app.md#installing-it-on-several-organizations).

Each repository without a `.deckhand.yaml` gets an onboarding issue, where Claude proposes one.
You can leave it for later: a repository works without it.

## 4. First run

On an issue of one of those repositories, comment:

```text
Deckhand
```

The comment gets a 👀. The first run installs Claude Code (once, into a volume), then works.
Open your public address to follow it on the dashboard, signed in with GitHub. When it is done,
the issue has a reply from the App's bot, and the branch `issue-<n>-<slug>` a draft pull
request. Comment again on the issue or the pull request to continue the same session.

## When it doesn't start

- **No 👀 on the comment:** GitHub didn't reach edge, or ignored you. Look at the App's
  _Advanced_ tab on GitHub (its recent deliveries), and at `docker compose logs edge
orchestrator`: a login missing from `allowed_users` is logged there.
- **👀, then 👎:** the run failed. The dashboard's page for the issue has its log.

[Logs](../guides/logs.md) and [Health checks](../guides/logs.md#health-checks) have more.

## Next

- [Core ideas](core-ideas.md): runs, modes, the server folder, sandboxes and services.
- [Comment commands](../reference/comment-commands.md): `Deckhand`, `/mode`, `/model`, `/after`…
- [Per-repo config](../repo-config.md): a repository's own `.deckhand.yaml`.
- [Security model](../security.md): read it before you install Deckhand on a repository other
  people write to.
- [Updating](../guides/updating.md): `node cli/deckhand.mjs update`, at any time.
