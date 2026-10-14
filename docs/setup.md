# Setting up Deckhand

Deckhand runs on your own server with your own private GitHub App and your own Claude
credential. You need Docker with the compose plugin, and an HTTPS address that GitHub can
reach (your reverse proxy, or a tunnel) forwarding to the listener's port.

## 1. Start the listener

```sh
cp .env.example .env
# ALLOWED_USERS: the GitHub logins allowed to start runs (required: no start without it)
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY
docker compose up -d --build
docker compose logs listener
```

`docker compose up` builds two images: the listener's and the sandbox image it starts runs
from (the `sandbox` service only builds it and exits). The listener publishes port 8080
(`PORT` to change it); point your reverse proxy at it.

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
| Deployments: read and write                     | `pull_request_review`                         |
| Actions, Metadata: read                         | `pull_request_review_comment`, `workflow_run` |

## 3. Use it

On an issue of an installed repository, an allowed user comments `Claude work on this`
(first line; the rest are instructions). The sandbox opens the branch `issue-<n>-<slug>` and
a draft pull request, and Claude's final message comes back as a comment from the App's bot.
`Claude let's brainstorm this` discusses the issue without code; `/stop` wraps it up.

## Settings

All in `.env`, read by `compose.yaml`:

| Setting                                                                                 | Default                        | What                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `ALLOWED_USERS`                                                                         | none: required                 | GitHub logins that can start runs                                |
| `ALLOWED_REPOS`                                                                         | all where the App is installed | narrows the repos (`owner/repo`, comma-separated)                |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`                                         |                                | Claude credential passed to each sandbox                         |
| `PUBLIC_URL`                                                                            | stored by `/setup`             | the listener's public address                                    |
| `DASHBOARD_PASSWORD`                                                                    | empty: no dashboard            | password of the dashboard at `/` (any user name)                 |
| `CLAUDE_CODE_VERSION`                                                                   | `2.1.300`                      | Claude Code version the sandboxes install on first use           |
| `SANDBOX_MODEL`, `SANDBOX_EFFORT`                                                       | `opus`, `medium`               | defaults; a comment's `/model` and `/effort` lines override them |
| `MAX_PARALLEL`                                                                          | `2`                            | sandboxes running at once                                        |
| `TRIGGER`, `BRAINSTORM_TRIGGER`, `BRAINSTORM_STOP`                                      | `Claude work on this`…         | trigger lines                                                    |
| `NEEDS_INPUT_LABEL`                                                                     | `needs-input`                  | label while a run waits for answers (empty: none)                |
| `SANDBOX_IMAGE`, `SANDBOX_NETWORK`, `SHOTS_VOLUME`, `CLAUDE_CODE_VOLUME`, `NAME_PREFIX` | `deckhand-…`                   | names of what the listener creates on Docker                     |

## How sandboxes reach GitHub

No sandbox gets a long-lived token, an SSH key or the host's git configuration:

- Each run gets a random secret, valid while the run lasts.
- Its git credential helper and `gh` wrapper send that secret to the listener's token
  broker (port 8081, on the `deckhand-sandboxes` network only, not published) on every
  call, and get back an installation token limited to the run's repository, with
  contents, issues and pull requests (read and write), actions and metadata (read).
  Installation tokens last an hour; the broker renews them before that, so a run can go on
  for hours.
- Git pushes over HTTPS; commits and comments come from the App's bot
  (`<app>[bot]`, identity set through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`).

Claude Code is not part of any image: the first run installs the pinned
`CLAUDE_CODE_VERSION` into the `deckhand-claude-code` volume, and later runs reuse it.
