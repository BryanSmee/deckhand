# Setting up Deckhand

Deckhand runs on your own server with your own private GitHub App and your own Claude
credential (or OpenAI key, for [Codex](#codex)). You need Docker Engine 26 or later with the compose plugin, and an HTTPS address
that GitHub can reach (your reverse proxy, or a tunnel) forwarding to the listener's port.

## 1. Start the listener

```sh
cp .env.example .env
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY (or a gateway's
#   ANTHROPIC_AUTH_TOKEN: see Through a gateway below), or OPENAI_API_KEY for Codex (see
#   Codex below): the secrets stay in .env
cp -r server.example server
# server/config.yaml: allowed_users, the GitHub logins allowed to start runs (required: no
#   start without it), and the other settings; server/grants/: what you grant each
#   repository. See The server folder below.
docker compose pull
docker compose up -d
docker compose logs listener
```

Compose runs three images, published for each release (`DECKHAND_VERSION`, default
`latest`): the listener's, the egress proxy's (the only way out of the sandboxes' internal
networks, see [Security model](security.md)), and the base sandbox image runs start from
(the `sandbox` service only pulls it and exits); with the `engine` profile, the
[container engine](#container-engine)'s two images too. A repository can bring its own image
`FROM` that base: see [Per-repo config](repo-config.md). The listener publishes port 8080
(`PORT` to change it); point your reverse proxy at it.

To build the images from this checkout instead: `docker compose up -d --build`.

**A plan's credential** (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`, for Codex
a ChatGPT plan's login from `codex login`, or for the Antigravity CLI a Google AI plan's login,
both in [the credentials folder](#the-credentials-folder)) works, and the listener's log warns about it at each
start. A subscription (Claude Pro/Max, a ChatGPT plan, Google AI Pro/Ultra) is
usually licensed to one person, and Google's terms may not allow a plan to drive a bot at all. Serving a team, or repositories other people write to, may
break your provider's terms: check them before you do. You are responsible for how your
Deckhand uses your credential. For teams, use an API key.

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
starts at once when a pull request that closes the issue (`Closes #77`) is merged into the
default branch, when a run on the issue ends, or on any comment on it: the listener then
asks GitHub about the issue. An issue closed by hand, with nothing else happening to it, is
only seen at the listener's next check of every wait (`WAITS_CHECK_MINUTES`, 5 minutes by
default, and at each start). Issues opened with an **Open questions** section aren't labelled
`NEEDS_INPUT_LABEL` until the graph page reads the repo's open issues, answering them doesn't
take the label off unless a run starts, and the dashboard only sees the label change when the
listener restarts. The listener logs a warning at each start naming the events the App
misses, with the address of its settings.

## 3. Use it

On an issue of an installed repository, an allowed user comments `Deckhand` (the
whole first line, any case or punctuation; the rest are instructions). The sandbox opens the
branch `issue-<n>-<slug>` and a draft pull request, and Claude's final message comes back as a
comment from the App's bot.
`Deckhand` then a `/mode brainstorm` line (or `Deckhand /mode brainstorm`) discusses the issue
without code; `/stop` wraps it up. `/cancel` (the whole first line) stops the issue's running
run now, and the task's page on the dashboard has a **Stop** button that does the same: the
run's reply says who stopped it, its session and pushed commits stay, and the next comment
resumes it. With nothing running, `/cancel` gets a reply saying so.
`/mode`, `/after`, `/agent`, `/model` and `/effort` may share the trigger's line, alone or
together (`Deckhand /agent codex /mode brainstorm`), as well as follow it on lines of their
own; anything else on that line and it isn't the trigger. In an inbox entry (an idea, a bug, a
discussion), `/agent`, `/model` and `/effort` may end any line (`Dark mode /effort high`)
outside code blocks and quotes.
`Deckhand /mode research` answers a question from the open web, without the repository's
code or a GitHub token, once you set `allow_research: true` in the repository's grants file
or `grants/default.yaml` (see [Research runs](security.md#research-runs)).

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
preview hook and host mounts only take effect once you grant them to that repository in your
grants folder (see [Security model](security.md#the-grants-folder)), which is also where you
list the hosts its sandboxes may reach (see
[Where a sandbox's hosts come from](security.md#where-a-sandboxs-hosts-come-from)).

## 4. The dashboard

Open the listener's public address (`/`) and sign in with GitHub: the App's sign-in
(user-to-server OAuth) tells the listener who you are, and only `ALLOWED_USERS` get in; anyone
else sees who they are signed in as and a refusal. The token GitHub returns is only used to
read your login, then revoked; the session is a signed cookie valid for 7 days, checked
against `ALLOWED_USERS` on every request (the key is `/data/session.key`). Signing out ends
all your sessions, in every browser. A repository's tasks and logs show to the users in its
own `users` (see [Security model](security.md#the-dashboard)). `/status` also answers calls
from inside the container (`docker compose exec listener …`) without a session, but not
those a reverse proxy forwarded.

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

By default the graph leaves closed issues out: implemented (closed as completed, or merged)
and closed as not planned, with their arrows, so what still needs something stays on top. An
issue whose only blocker is hidden stands in the grid. A closed issue stays while an issue that
waited for it is running. **Show closed**, by the legend, brings them back; your browser keeps
the choice. Runs on the ideas and bugs inboxes and discussions are never drawn: they have no
pull request and no `/after`. On a repository's tab, only the issues drawn can be queued after.

On a repository's tab the graph is also a work area, with two columns beside it (above it on
a phone). The **backlog** lists the open issues with nothing live (running, queued, waiting,
brainstorming or needing input): drop one on the graph to start it (in the mode picked in
**Start in**), next to a node to queue it after that one. The **Brainstorm** column lists the
issues being brainstormed, with their state; they leave the graph unless an arrow touches
them. Drop a backlog issue on the column to brainstorm it, a brainstorm on the graph to start
work on it (the brainstorm ends), or back on the backlog to stop it: the wrap-up a `/stop`
comment runs, its summary posted and the issue updated. Once it is over, the issue is back in
the backlog. Each card has buttons that do the same, for phones and keyboards. Each action is
written on the issue as the App's comment. On the All tab, the column only lists them.

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
| `cancelled`       | someone stopped its last run (`/cancel` or the dashboard's Stop)        |

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
errors, or asks for what the operator's grants refuse (a `dockerfile` or `preview`
without its grant, a mount outside the granted roots), or
its grants have errors (its own file, or the folder's `default.yaml` and layout, for every
repository). The list is cached: the installations' repositories are
read again every 5 minutes, each configuration every 30 minutes, or at once after a push or a
merged pull request on its default branch. The grants folder is checked at each load, so
editing it shows at once. **Refresh** reads everything again, in case a webhook was missed.
**Manage App**, next to it, links to the App on GitHub (in a new tab): **Add or remove
repositories** opens the page that installs it on an account or configures an installation
(that installation's own page when there is only one), and **App settings** its permissions,
events and webhook (under the organization that owns it, or your own settings). GitHub decides
who may change them: someone who doesn't own the App sees its 404 or a read-only page. With no
repository yet, the empty list links to the install page too.

A repository's name opens its configuration, read from its default branch then: what stops
its runs (errors, and what it asks for that the operator doesn't grant) and its warnings first, then
what its runs get (each value from the repository, from the operator, or refused), its grant
and the files of the grants folder it comes from (or the file to fix, when it has errors), and
the raw file. Anyone signed in to the dashboard sees it, grants
included. Its **Refresh** reads it again (at most every 5 seconds); changing it is a commit on
the default branch.

## The server folder

Everything you configure but the secrets is in one folder, which `compose.yaml` mounts
read-only at `/etc/deckhand` in the listener: `./server` by default (`DECKHAND_SERVER_DIR`
in `.env` to move it). Keep it in git, in your deployment's own repository, so each change is
a reviewed commit:

```
server/                   # → /etc/deckhand, read-only
  config.yaml             # your settings (Settings below); .env overrides each key
  grants/
    default.yaml          # what every repository gets
    acme/api.yaml         # what acme/api gets, one file per repository
```

[`server.example/`](../server.example) is one to copy: `config.yaml` with the usual
settings, and a grants folder that grants nothing until you uncomment it (rename
`your-org/your-repo.yaml` to a repository of yours). Both parts are optional: without
`config.yaml`, settings come from `.env`; without `grants/`, no repository gets more than
a sandbox. A missing folder is created empty by Docker.

Deckhand only reads it: getting it onto the host is yours. A checkout next to `compose.yaml`
pulled on the host (or by a cron job, git-sync or your CI) works:

```sh
git clone git@github.com:acme/deckhand-config.git
echo DECKHAND_SERVER_DIR=./deckhand-config/server >> .env
docker compose up -d
```

The grants are read again at each run, so a pull applies to the next run; `config.yaml` is
read at start, so restart the listener after changing it. Whoever can change the folder can
grant root on the host: protect it like the deployment itself, with `CODEOWNERS` giving each
team its own repositories' grants (see [Security model](security.md#the-grants-folder)).

## The credentials folder

The plans' logins (see [With a ChatGPT plan](#with-a-chatgpt-plan) and
[With a Google AI plan](#with-a-google-ai-plan)) can't go in the server folder: the listener refreshes
them and writes the new tokens back, and they would end up in git. They have a folder of their
own, which `compose.yaml` mounts read-write at `/data/credentials`: `./credentials` by default
(`DECKHAND_CREDENTIALS_DIR` in `.env` to move it). Keep it out of git (this repository's
`.gitignore` does) and readable by you and root alone. Create it before the listener starts,
or Docker creates it empty and owned by root:

```sh
mkdir -m 700 credentials
```

```
credentials/              # → /data/credentials, read-write
  codex-auth.json         # a ChatGPT plan's login, for Codex
  agy-auth.json           # a Google AI plan's login, for the Antigravity CLI
```

A file there, under its name, turns that login on at start: no setting needed.
`CODEX_AUTH_FILE` or `AGY_AUTH_FILE`, when set, points at another file instead, which must be
somewhere the listener can write too (`/data`, not `/etc/deckhand`): the listener checks it
before it refreshes anything, and says so in its log and in runs' errors when it can't. Logins
set up before this folder, `/data/codex-auth.json` with `CODEX_AUTH_FILE` pointing there,
keep working.

## Settings

Each setting can come from the environment (`.env`, read by `compose.yaml`) or from
`config.yaml` in [the server folder](#the-server-folder), a file you commit in your
deployment's repository and review line by line.
Secrets (the Claude credential, `OPENAI_API_KEY`, `GEMINI_API_KEY`) stay in `.env`; the App's are in `/data/app.json`.

- **Keys:** each setting's environment variable in lowercase (`ALLOWED_USERS` →
  `allowed_users`), lists as YAML lists, `onboarding` as `true` or `false`.
- **Precedence:** an environment variable that is set and not empty wins, then
  `config.yaml`, then the default below. `NEEDS_INPUT_LABEL` is the exception: set and
  empty in `.env`, it still wins (no label); `needs_input_label: ""` does the same in the file.
- **Read at start only:** restart the listener (`docker compose restart listener`) after an
  edit. Unlike the grants folder, it isn't read again.
- **Fail closed:** an unknown key, a value of the wrong type, a bad value or a secret in the
  file stops the listener, naming the key (`/etc/deckhand/config.yaml: max_parallel:
expected a whole number of sandboxes, got lots`). The file is optional; `ALLOWED_USERS`
  is required from one or the other.

The listener reads `/etc/deckhand/config.yaml` (`CONFIG_FILE` to change it): `config.yaml`
in [the server folder](#the-server-folder), for example:

```yaml
# server/config.yaml
allowed_users: [alice, bob]
allowed_repos: [acme/api, acme/web]
trigger: Deckhand
sandbox_model: opus
sandbox_effort: medium
brainstorm_model: sonnet
max_parallel: 2
sandbox_subnets: 10.200.0.0/16
conflict_check_minutes: 5
onboarding: true
needs_input_label: needs-input
```

What every sandbox may reach and its limits aren't settings: they go in
`grants/default.yaml`, read at each run (see
[Where a sandbox's hosts come from](security.md#where-a-sandboxs-hosts-come-from)).

| Setting                                                                                           | `config.yaml` key                                                                                 | Default                                                                      | What                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_USERS`                                                                                   | `allowed_users`                                                                                   | none: required                                                               | GitHub logins that can start runs                                                                                                                                                                                                      |
| `ALLOWED_REPOS`                                                                                   | `allowed_repos`                                                                                   | all where the App is installed                                               | narrows the repos (`owner/repo`, comma-separated in `.env`)                                                                                                                                                                            |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`                          | none: a secret, `.env` only                                                                       |                                                                              | Claude credential, added by the listener to the sandboxes' API calls (`ANTHROPIC_AUTH_TOKEN`: a gateway's)                                                                                                                             |
| `ANTHROPIC_BASE_URL`                                                                              | `anthropic_base_url`                                                                              | `https://api.anthropic.com`                                                  | where the listener sends the sandboxes' API calls: a [gateway](#through-a-gateway), say                                                                                                                                                |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `anthropic_default_opus_model`, `anthropic_default_sonnet_model`, `anthropic_default_haiku_model` | Claude Code's                                                                | the models `opus`, `sonnet` and `haiku` stand for in the sandboxes (a gateway's names)                                                                                                                                                 |
| `SANDBOX_AGENT`, `BRAINSTORM_AGENT`                                                               | `sandbox_agent`, `brainstorm_agent`                                                               | `claude`, `SANDBOX_AGENT`                                                    | the agent of work runs, and of brainstorms, inbox entries and discussions: `claude`, `codex` (see [Codex](#codex)) or `antigravity` (see [Antigravity CLI](#antigravity-cli))                                                          |
| `OPENAI_API_KEY`                                                                                  | none: a secret, `.env` only                                                                       |                                                                              | Codex's OpenAI API key, added by the listener to the sandboxes' API calls                                                                                                                                                              |
| `CODEX_AUTH_FILE`                                                                                 | none: `.env` only                                                                                 |                                                                              | or a ChatGPT plan's login: its `auth.json`, held and refreshed by the listener. Default: `/data/credentials/codex-auth.json` when it exists (see [The credentials folder](#the-credentials-folder)); a file elsewhere must be writable |
| `OPENAI_BASE_URL`                                                                                 | `openai_base_url`                                                                                 | `https://api.openai.com/v1`                                                  | where the listener sends Codex's API calls                                                                                                                                                                                             |
| `CODEX_BEST_MODEL`, `CODEX_BALANCED_MODEL`, `CODEX_FAST_MODEL`                                    | `codex_best_model`, `codex_balanced_model`, `codex_fast_model`                                    | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`                                   | the models the tiers `best`, `balanced` and `fast` stand for with Codex                                                                                                                                                                |
| `GEMINI_API_KEY`                                                                                  | none: a secret, `.env` only                                                                       |                                                                              | the Antigravity CLI's Gemini API key, added by the listener to the sandboxes' API calls                                                                                                                                                |
| `AGY_AUTH_FILE`                                                                                   | none: `.env` only                                                                                 |                                                                              | or a Google AI plan's login: its token file, held and refreshed by the listener. Default: `/data/credentials/agy-auth.json` when it exists (see [The credentials folder](#the-credentials-folder)); a file elsewhere must be writable  |
| `GEMINI_BASE_URL`                                                                                 | `gemini_base_url`                                                                                 | `https://generativelanguage.googleapis.com`                                  | where the listener sends the Antigravity CLI's API calls when using `GEMINI_API_KEY`                                                                                                                                                   |
| `AGY_BEST_MODEL`, `AGY_BALANCED_MODEL`, `AGY_FAST_MODEL`                                          | `agy_best_model`, `agy_balanced_model`, `agy_fast_model`                                          | `gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-3.8-flash-medium`    | the models the tiers `best`, `balanced` and `fast` stand for with the Antigravity CLI                                                                                                                                                  |
| `FALLBACKS`                                                                                       | `fallbacks`                                                                                       | none                                                                         | where a run goes when its provider fails, in order: `claude@anthropic`, `claude@openrouter`, `codex@openai`, `antigravity@google` (see [Fallbacks](#fallbacks))                                                                        |
| `OPENROUTER_API_KEY`                                                                              | none: a secret, `.env` only                                                                       |                                                                              | OpenRouter key of `claude@openrouter`, added by the listener to those runs' API calls                                                                                                                                                  |
| `OPENROUTER_BASE_URL`                                                                             | `openrouter_base_url`                                                                             | `https://openrouter.ai/api`                                                  | where the listener sends the API calls of `claude@openrouter` runs                                                                                                                                                                     |
| `OPENROUTER_OPUS_MODEL`, `OPENROUTER_SONNET_MODEL`, `OPENROUTER_HAIKU_MODEL`                      | `openrouter_opus_model`, `openrouter_sonnet_model`, `openrouter_haiku_model`                      | `ANTHROPIC_DEFAULT_*_MODEL`                                                  | what `opus`, `sonnet` and `haiku` stand for on `claude@openrouter` (OpenRouter's names)                                                                                                                                                |
| `CLAUDE_FALLBACK_MODEL`                                                                           | `claude_fallback_model`                                                                           | none                                                                         | Claude Code's own `--fallback-model`, when the run's model is overloaded: a tier or a model's name                                                                                                                                     |
| `PUBLIC_URL`                                                                                      | `public_url`                                                                                      | stored by `/setup`                                                           | the listener's public address                                                                                                                                                                                                          |
| `PORT`                                                                                            | none: compose's                                                                                   | `8080`                                                                       | the host port compose publishes the listener on                                                                                                                                                                                        |
| `CLAUDE_CODE_VERSION`                                                                             | `claude_code_version`                                                                             | `2.1.300`                                                                    | Claude Code version the sandboxes install on first use                                                                                                                                                                                 |
| `AGY_VERSION`                                                                                     | `agy_version`                                                                                     | `1.4.0`                                                                      | Antigravity CLI version the sandboxes install on first use                                                                                                                                                                             |
| `AGY_SHA256`                                                                                      | `agy_sha256`                                                                                      | `1.4.0`'s                                                                    | sha256 of the Antigravity CLI's tarballs, `x64:<hex>,arm64:<hex>`: set it whenever you change `AGY_VERSION`, from the release's assets                                                                                                 |
| `CODEX_VERSION`                                                                                   | `codex_version`                                                                                   | `0.162.1`                                                                    | Codex version the sandboxes install on first use                                                                                                                                                                                       |
| `SANDBOX_MODEL`, `SANDBOX_EFFORT`                                                                 | `sandbox_model`, `sandbox_effort`                                                                 | `best`, `medium`                                                             | defaults; a comment's `/model` and `/effort` lines override them (models: below the table)                                                                                                                                             |
| `BRAINSTORM_MODEL`, `BRAINSTORM_EFFORT`                                                           | `brainstorm_model`, `brainstorm_effort`                                                           | `SANDBOX_MODEL`, `SANDBOX_EFFORT`                                            | the same for brainstorms, inbox entries and discussions                                                                                                                                                                                |
| `BRAINSTORM_IDLE_MINUTES`                                                                         | `brainstorm_idle_minutes`                                                                         | `10`                                                                         | minutes without a comment before a brainstorm shows as idle                                                                                                                                                                            |
| `MAX_PARALLEL`                                                                                    | `max_parallel`                                                                                    | `2`                                                                          | sandboxes running at once (a repo's `max_parallel` within it)                                                                                                                                                                          |
| `SANDBOX_SUBNETS`, `SANDBOX_SUBNET_SIZE`                                                          | `sandbox_subnets`, `sandbox_subnet_size`                                                          | none (Docker's pools), `28`                                                  | an IPv4 range the runs' networks take their subnets from, in blocks of that size (below the table)                                                                                                                                     |
| `SANDBOX_ENGINE`                                                                                  | `sandbox_engine`                                                                                  | none                                                                         | the container engine runs of repositories granted `allow_docker` get: `sysbox`, `podman` or `auto` (see [Container engine](#container-engine))                                                                                         |
| `TRIGGER`                                                                                         | `trigger`                                                                                         | `Deckhand`                                                                   | first line of a comment that starts a run                                                                                                                                                                                              |
| `ONBOARDING`                                                                                      | `onboarding`                                                                                      | on                                                                           | `off`: no onboarding issue when the App is installed on a repo without a config                                                                                                                                                        |
| `NEEDS_INPUT_LABEL`                                                                               | `needs_input_label`                                                                               | `needs-input`                                                                | label while a run or an issue waits for answers (empty: none)                                                                                                                                                                          |
| `CONFLICT_CHECK_MINUTES`                                                                          | `conflict_check_minutes`                                                                          | `5`                                                                          | shortest interval of a repo's `conflicts.check_minutes`; `0` turns it off                                                                                                                                                              |
| `WAITS_CHECK_MINUTES`                                                                             | `waits_check_minutes`                                                                             | `5`                                                                          | how often comments waiting for other issues (`/after`) ask GitHub again                                                                                                                                                                |
| `RUN_LOG_MAX_MB`                                                                                  | `run_log_max_mb`                                                                                  | `200`                                                                        | megabytes a run's log may hold: a run whose output passes it is stopped and fails, the rest of its output not kept (see below)                                                                                                         |
| `LOG_RETENTION_DAYS`                                                                              | `log_retention_days`                                                                              | `90`                                                                         | days a run's log, its summary and its screenshots are kept; `0` keeps them forever (see below)                                                                                                                                         |
| `NAME_PREFIX`, `CLAUDE_CODE_VOLUME`, `CODEX_VOLUME`, `AGY_VOLUME`                                 | `name_prefix`, `claude_code_volume`, `codex_volume`, `agy_volume`                                 | `deckhand`, `deckhand-claude-code`, `deckhand-codex`, `deckhand-antigravity` | names of what the listener creates on Docker (the Antigravity CLI's login is refreshed in `<AGY_VOLUME>-login`)                                                                                                                        |
| `DOCKER_SOCKET`                                                                                   | none: compose's                                                                                   | `/var/run/docker.sock`                                                       | the host's Docker socket, as preview hooks mount it                                                                                                                                                                                    |
| `DECKHAND_VERSION`                                                                                | none: compose's                                                                                   | `latest`                                                                     | the release compose runs (`1.2.3`, `1.2`), or `edge` to follow `main`: see [Updating](#updating)                                                                                                                                       |
| `DECKHAND_REGISTRY`                                                                               | none: compose's                                                                                   | `ghcr.io/bryansmee`                                                          | where compose pulls the images from                                                                                                                                                                                                    |
| `SHOTS_VOLUME`, `RUNS_VOLUME`                                                                     | none: compose's                                                                                   | `deckhand-…`                                                                 | names of the volumes compose creates and the listener uses                                                                                                                                                                             |

Each running sandbox has a Docker network of its own (see
[Security model](security.md#network)). By default Docker takes their subnets from its default
address pools, which hold about 30 networks shared with your other projects: past that, runs
fail to start with `all predefined address pools have been fully subnetted` (or `could not
find an available, non-overlapping IPv4 address pool`). Set aside a range of your own instead,
`SANDBOX_SUBNETS=10.200.0.0/16` (`sandbox_subnets` in `config.yaml`): the listener cuts it
into blocks of `SANDBOX_SUBNET_SIZE` (`/28` by default, 16 addresses: 4096 networks in a
`/16`) and gives each run's network the lowest block no network on the host uses, so your
other projects keep Docker's pools. Pick a range none of your networks or LANs use, inside
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` or `100.64.0.0/10`: the listener refuses to
start with any other (a public range would make other runs' sandboxes look like public hosts
to the egress proxy). When it is
full, runs fail to start with an error naming `SANDBOX_SUBNETS`: set a larger range or a lower
`MAX_PARALLEL`.

The alternative changes the whole daemon, your other projects' networks included: give Docker
more, smaller networks in `/etc/docker/daemon.json`, then restart Docker. The setting replaces
Docker's own pools, so list those first and add yours after them, for example
`"default-address-pools": [{"base": "172.16.0.0/12", "size": 16}, {"base": "192.168.0.0/16", "size": 20}, {"base": "10.200.0.0/16", "size": 28}]`
(the last one: 4096 networks of 16 addresses).

Each run leaves its log in `logs/<run>.log` on the data volume (the agent's whole output, often
a few MB), a summary beside it (`logs/<run>.json`, what the dashboard lists after a restart,
so the listener doesn't read the logs to start) and its screenshots in `shots/`. At start and
then daily, the listener removes those of runs older than `LOG_RETENTION_DAYS` (90 days by
default), and they leave the dashboard. It keeps a run still going, and the latest run of a
task that is queued, in a brainstorm, waiting (`/after`) or waiting for input, whatever its
age. Screenshots linked from older pull requests and comments stop showing once their run is
removed: set a longer retention, or `0`, to keep them.

A run's output can't fill the data volume: once its log would pass `RUN_LOG_MAX_MB` (200 MB
by default), nothing more of it is written, its sandbox is stopped and the run fails, with a
note in its log and a reply that says why. A single line over 1 MB (no newline in sight) is
cut there, `… (line cut)` at its end, and the rest of it dropped up to its newline.

A model, in `SANDBOX_MODEL`, `BRAINSTORM_MODEL`, a repository's `model` or a comment's
`/model`, is a tier the run's agent maps to one of its models, `best`, `balanced` or `fast`
(Claude Code: `opus`, `sonnet`, `haiku`, which `ANTHROPIC_DEFAULT_*_MODEL` can point
elsewhere; Codex: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, or `CODEX_*_MODEL`; the
Antigravity CLI: `gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-3.8-flash-medium`, or
`AGY_*_MODEL`), or a model's own name (`sonnet`, `claude-opus-5-5`, `gpt-6.1-sol`,
`gemini-4-argon`). Efforts (`low` to `max`) are the same for all three; the Antigravity CLI's
models carry theirs in their name (`-low`, `-medium`, `-high`), so a name without one takes the
run's (`xhigh` and `max`: `-high`). A run whose model belongs to another agent (`/model opus` on a Codex run)
doesn't start: the reply says why.

### Agents and providers

Deckhand runs three agents, Claude Code (`claude`), Codex (`codex`) and the Antigravity CLI
(`antigravity`), from one sandbox image: each installs on first use into a volume of its own.
An agent calls a provider; its calls go through the listener, which adds your credential and
forwards them, so none of these needs a host in the grants folder (only GitHub's, which every
run has, and the Antigravity CLI's own, which its runs have).

| Entry                | Agent and provider                                           | Credential (`.env`)                                                                 | The listener calls                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude@anthropic`   | Claude Code on Anthropic, or [a gateway](#through-a-gateway) | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (a plan's) or `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL` (`api.anthropic.com`)                                                                                                                             |
| `claude@openrouter`  | Claude Code through OpenRouter, as a [fallback](#fallbacks)  | `OPENROUTER_API_KEY`                                                                | `OPENROUTER_BASE_URL` (`openrouter.ai`)                                                                                                                                |
| `codex@openai`       | [Codex](#codex) on OpenAI                                    | `OPENAI_API_KEY`, or `CODEX_AUTH_FILE` (a ChatGPT plan's login)                     | `OPENAI_BASE_URL` (`api.openai.com`), or ChatGPT's Codex backend with a plan                                                                                           |
| `antigravity@google` | [Antigravity CLI](#antigravity-cli) on Google                | `GEMINI_API_KEY`, or `AGY_AUTH_FILE` (a Google AI Pro/Ultra plan's login)           | `GEMINI_BASE_URL` (`generativelanguage.googleapis.com`), or `daily-cloudcode-pa.googleapis.com` and `www.googleapis.com` (handed over by the egress proxy) with a plan |

What runs an issue, first match wins:

1. A comment's `/agent <entry>` line (`/agent codex`, `/agent claude@openrouter`; an agent
   alone is on its default provider), among the agents you have a credential for and the
   entries of `FALLBACKS`. Anything else gets a reply naming what is configured, and nothing
   runs. A picked agent doesn't fall back: when its provider fails, the run ends with the
   error. The issue's later runs stay with it until another `/agent`; `/agent default` goes
   back to the next rule. When it changes the agent, the new one starts a session of its own,
   handed the branch and the previous agent's last message.
2. The [fallback](#fallbacks) a run whose provider failed went to, and later runs of the issue.
3. The repository's `agent` (per mode, or `brainstorm_agent`: [Per-repo config](repo-config.md#agent)),
   among the agents you configured.
4. Your `SANDBOX_AGENT` (`BRAINSTORM_AGENT` for light runs), `claude` by default.

### Through a gateway

Claude Code can go through an Anthropic-compatible gateway instead of Anthropic:
[OpenRouter](https://openrouter.ai), your company's LLM gateway. Sandboxes still call the
listener, which forwards their calls to `ANTHROPIC_BASE_URL` with your credential: they never
reach the gateway themselves, so it needs no host in the grants folder. Only you set it; a
repository's config can't. With OpenRouter, in `.env`:

```sh
ANTHROPIC_AUTH_TOKEN=sk-or-v1-…   # your OpenRouter key, sent as Authorization: Bearer
```

and in `config.yaml`:

```yaml
anthropic_base_url: https://openrouter.ai/api
# What opus, sonnet and haiku mean (haiku runs Claude Code's background tasks).
anthropic_default_opus_model: anthropic/claude-opus-4.1
anthropic_default_sonnet_model: anthropic/claude-sonnet-4.5
anthropic_default_haiku_model: anthropic/claude-haiku-4.5
sandbox_model: opus
```

Leave `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` empty: `ANTHROPIC_AUTH_TOKEN` wins
over them anyway, as in Claude Code. `SANDBOX_MODEL`, `BRAINSTORM_MODEL`, a repository's
`model` and a comment's `/model` line take the gateway's names too (`/model openai/gpt-5`).

Claude Code is built for Claude models: others, through a gateway, are uneven at its tool
calls (edits, long sessions, thinking), and a run can stop halfway or misuse a tool. Try a
model on a small issue before giving it real work. Restart the listener after changing these
settings; switching back to Anthropic is emptying `anthropic_base_url` and setting your
Anthropic credential.

### Codex

Deckhand can run [Codex](https://github.com/openai/codex) (OpenAI's CLI) instead of Claude
Code, with an OpenAI API key (or [a ChatGPT plan](#with-a-chatgpt-plan)). In `.env`:

```sh
OPENAI_API_KEY=sk-proj-…
```

and in `config.yaml`, to make it the default:

```yaml
sandbox_agent: codex # brainstorm_agent follows unless you set it
sandbox_model: best # gpt-6-astra; balanced and fast are gpt-6.1-sol and gpt-6-luna
```

Or keep Claude Code as the default and let repositories pick Codex: with both a Claude
credential and `OPENAI_API_KEY` set, a repository's `.deckhand.yaml` may say `agent: codex`
(per repository, or per mode: [Per-repo config](repo-config.md#agent)). A repository can only
pick an agent you have a credential for, or the one you chose as default. `SANDBOX_AGENT=codex`
without `OPENAI_API_KEY` (or a ChatGPT plan's login) stops the listener at start.

As with Claude Code, the key never enters a sandbox: Codex calls the listener
(`OPENAI_BASE_URL=<broker>/openai`) with the run's secret as its key, and the listener
forwards the call to OpenAI (or your `OPENAI_BASE_URL`) with yours. The sandbox turns off
Codex's analytics, update check and plugins, so it needs no host besides GitHub's: not
`api.openai.com`, and not `api.anthropic.com` either.

What differs from Claude Code:

- **Comments that arrive mid-run** wait for the run to end: `codex exec` takes no more input
  once started. The next run starts right after and resumes the same session
  (`codex exec resume --last`), so nothing is dropped, only answered in a second reply.
- **Sessions** are in a volume per issue, `<sandbox>-codex` (`~/.codex`), apart from Claude
  Code's: a repository that switches agent starts the issue afresh with the other one.
- **Instructions:** Deckhand's rules and the repository's `instructions` file go to
  `~/.codex/AGENTS.md`; Codex reads the repository's own `AGENTS.md` itself.
- **Draft pull request:** Codex's hooks call the same `sandbox-draft-pr hook` after a push and
  when it stops.
- **Its own sandbox is off** (`--dangerously-bypass-approvals-and-sandbox`): the container is
  the sandbox, as with Claude Code.

#### With a ChatGPT plan

Instead of an API key, Codex can run on a ChatGPT plan's login. Its refresh token is
single-use and rotated on every refresh, so only one copy may be in use: the listener holds
it, refreshes it and adds the plan's access token to the sandboxes' calls, which go to
ChatGPT's Codex backend (`chatgpt.com/backend-api/codex`). No sandbox gets it.

1. Sign in for Deckhand alone, in a fresh Codex home (any machine with Codex):

   ```sh
   export CODEX_HOME=$(mktemp -d)
   codex login --device-auth
   ```

2. Move its `auth.json` into [the credentials folder](#the-credentials-folder) on the
   listener's host (next to `compose.yaml`), then delete that home without `codex logout`,
   which would revoke the login:

   ```sh
   mv "$CODEX_HOME/auth.json" credentials/codex-auth.json
   rm -r "$CODEX_HOME"
   ```

3. Restart the listener (`docker compose restart listener`): the file turns the login on.

The listener logs `Codex: a ChatGPT plan's login, from /data/credentials/codex-auth.json` at
start, or why
it can't use it. It refreshes the access token 5 minutes before it expires, once for all
runs, and writes the new tokens back to the file. Don't use that `auth.json` anywhere else: a
refresh elsewhere spends the token the listener holds. When the login is spent (revoked,
or refreshed elsewhere), runs fail with "run `codex login` again": repeat the steps above;
the listener reads the new file without a restart. `OPENAI_API_KEY`, when set too, wins.

A plan is licensed to one person: the listener's log warns about it at each start (see
[1. Start the listener](#1-start-the-listener)).

### Antigravity CLI

Deckhand can run Google's [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli)
(`agy`), with a Gemini API key (or [a Google AI plan](#with-a-google-ai-plan)). In `.env`:

```sh
GEMINI_API_KEY=AIza…
```

and in `config.yaml`, to make it the default (or let repositories pick it, as with [Codex](#codex)):

```yaml
sandbox_agent: antigravity
sandbox_model: best # gemini-4-argon-high; balanced and fast: gemini-4-argon-medium, gemini-3.8-flash-medium
```

On a key, `agy` 1.4.0 doesn't list Gemini 4 Argon yet
([google-antigravity/antigravity-cli#1228](https://github.com/google-antigravity/antigravity-cli/issues/1228)):
the sandbox declares it as a custom model in `agy`'s settings, and passes an Argon tier's
effort as `--effort` (`gemini-4-argon-high` runs `--model gemini-4-argon --effort high`). The
other models (`agy models`) need nothing.

`SANDBOX_AGENT=antigravity` without `GEMINI_API_KEY` (or a Google AI plan's login) stops the
listener at start.

As with Claude Code and Codex, the key never enters a sandbox: `agy` calls the listener
(`GOOGLE_GEMINI_BASE_URL=<broker>/google`) with the run's secret in `GEMINI_API_KEY` (and
`modelProvider: "gemini"` in its settings), and the listener forwards the call to Google (or
your `GEMINI_BASE_URL`) with yours.

What differs from Claude Code, as for Codex:

- **Comments that arrive mid-run** wait for the run to end: `agy -p` takes no more input. The
  next run resumes the same conversation (`agy --conversation <id>`).
- **Sessions** are in a volume per issue, `<sandbox>-antigravity` (`~/.gemini`).
- **Instructions:** Deckhand's rules and the repository's `instructions` file go to
  `~/.gemini/AGENTS.md`; `agy` reads the repository's own `AGENTS.md` itself.
- **Draft pull request:** a `Stop` hook in `agy`'s user-level hooks (`~/.gemini/config/hooks.json`,
  not the repository's `.agents/hooks.json`), and again once it exits.
- **A failed command** shows as any other in the run's log: `agy`'s output doesn't say a
  command failed.

#### With a Google AI plan

Instead of an API key, the Antigravity CLI can run on a Google AI Pro or Ultra plan's login,
which gives it Gemini 4 Argon (and the plan's other models: `agy models` lists them). Only
`agy` takes such a plan: Gemini CLI and the gateways need an API key.

Google's terms may not allow a plan, licensed to one person, to drive an automated bot:
check them before you set this up. The listener's log warns about it at each start.

On a plan, `agy` has no setting to send its calls to the listener, so its login is kept out of the
sandboxes another way. The listener holds it; each sandbox gets a token file whose access token
is the run's secret. For these runs only, the egress proxy decrypts the two hosts that carry
the token (`daily-cloudcode-pa.googleapis.com`, `www.googleapis.com`) and hands each request to
the listener, which checks the secret, puts the plan's access token in its place and sends the
call on, on the paths `agy` uses only. `agy`'s telemetry (`play.googleapis.com`, which carries
the token too) is refused; its feature flags (`antigravity-unleash.goog`) and your avatar
(`lh3.googleusercontent.com`, which its eligibility check fetches) go through untouched. See
[Security model](security.md#the-antigravity-clis-login).

1. Sign in once, for Deckhand alone, in a container (any machine with Docker; the image is
   Deckhand's sandbox image, which has what `agy` needs):

   ```sh
   docker volume create agy-sign-in
   docker run --rm -it --user 0 --entrypoint deckhand-install-antigravity \
     -e AGY_VERSION=1.4.0 \
     -e AGY_SHA256=x64:fd96967583c1eed94733c039638fa59b71ddbd823c75ebc8dd0e677463565aad,arm64:cf953adcc69f87d00d71f97c3f35dc723a8669a350accf9a199df781f0523f56 \
     -v deckhand-antigravity:/opt/antigravity ghcr.io/bryansmee/deckhand-sandbox
   docker run --rm -it --entrypoint /opt/antigravity/1.4.0/bin/agy \
     -v deckhand-antigravity:/opt/antigravity:ro -v agy-sign-in:/home/node/.gemini \
     ghcr.io/bryansmee/deckhand-sandbox
   ```

   `agy` prints a sign-in address: open it, sign in with the plan's Google account, paste the
   code back, then `/quit`.

2. Write the token file it left into [the credentials folder](#the-credentials-folder) on
   the listener's host (next to `compose.yaml`), then remove that volume:

   ```sh
   docker run --rm -v agy-sign-in:/g ghcr.io/bryansmee/deckhand-sandbox \
     cat /g/antigravity-cli/antigravity-oauth-token > credentials/agy-auth.json
   docker volume rm agy-sign-in
   ```

3. In `config.yaml`, to make it the default (or let repositories pick it, as with [Codex](#codex)):

   ```yaml
   sandbox_agent: antigravity
   sandbox_model: best # gemini-4-argon-high; balanced and fast: gemini-4-argon-medium, gemini-3.8-flash-medium
   ```

Then restart the listener. It logs `Antigravity CLI: a Google AI plan's login, from
/data/credentials/agy-auth.json` at start, or why it can't use it. When the access token is within 5 minutes of its expiry, the listener has
`agy` refresh it: it runs `agy models` in a short container of the sandbox image, on a volume of
its own (`<AGY_VOLUME>-login`), outside the runs' networks (`INSTALL_NETWORK`, as the installs),
once for all runs, and writes the new token back to the file. When Google refuses the refresh
(the login was revoked), runs fail with "sign in with `agy` again": repeat the steps above; the
listener reads the new file without a restart. `GEMINI_API_KEY`, when set too, wins.

The egress proxy needs its CA for these runs, cache on or off (it makes it at its first
start, in its volume): a run stops when the proxy has none.

### Fallbacks

When the model's API fails, a run can go on elsewhere instead of ending with "Claude stopped
with an error". List where, in order, as `agent@provider` (`agent` alone is its default
provider):

| Entry                | What                                                                           | Needs                                 |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `claude@anthropic`   | Claude Code on your `ANTHROPIC_BASE_URL` (Anthropic, unless a gateway)         | a Claude credential                   |
| `claude@openrouter`  | Claude Code through OpenRouter, at `OPENROUTER_BASE_URL`                       | `OPENROUTER_API_KEY`                  |
| `codex@openai`       | Codex on your `OPENAI_BASE_URL` (OpenAI), or on a ChatGPT plan                 | `OPENAI_API_KEY` or `CODEX_AUTH_FILE` |
| `antigravity@google` | The Antigravity CLI on your `GEMINI_BASE_URL` (Google), or on a Google AI plan | `GEMINI_API_KEY` or `AGY_AUTH_FILE`   |

In `.env`, the credentials, and in `config.yaml`:

```yaml
fallbacks: [claude@openrouter, codex@openai]
# OpenRouter's names for what opus, sonnet and haiku mean there.
openrouter_opus_model: anthropic/claude-opus-4.1
openrouter_sonnet_model: anthropic/claude-sonnet-4.5
openrouter_haiku_model: anthropic/claude-haiku-4.5
```

An entry without its credential stops the listener at start. Without `FALLBACKS`, nothing
changes: a run whose provider fails ends with an error, as before.

**Which errors count:** only the provider's. The run's agent ended with an error that says
overloaded (529), rate limited (429), a usage limit or quota reached (402, a plan's limit, no
credit left), invalid or expired credentials (401, 403), or a server error (5xx), in its
message or as the last answer the listener got from the provider. A failing test, a task the
agent gave up on or any other error ends the run as before. A plan's usage limit
counts: with a Claude plan first and an API key or OpenRouter after it, runs go on, paid per
token, only on the entries you list.

**What happens:** the run's comments are queued again for the first entry the run hasn't
been on yet, each entry at most once (the run's own included, wherever it is in the list). The
same agent on another provider continues its session. Another agent starts a new session,
handed the task, the branch and the previous agent's last message; it works in the same clone,
so it sees what was left uncommitted. The run's log on the dashboard says where it switched
and why, and the reply's footer names the agent and provider that answered:
`🤖 Codex (openai) gpt-6-astra · medium effort · 3 min · fell back from Claude (anthropic): overloaded (529)`.
When no entry is left, the run ends with the error.

**Later runs** of the issue stay on the entry that took over, as long as it is in `FALLBACKS`:
switching back would continue the session of the agent that failed, without what the other
one did.

A model's own name (`/model claude-opus-5-5`) may mean nothing on another provider: use
tiers (`best`) with fallbacks. A Claude model on a run that falls back to Codex runs Codex's
login (`UNAUTHENTICATED`, `PERMISSION_DENIED`) count as the
login (`UNAUTHENTICATED`, `PERMISSION_DENIED`, "Eligibility check failed") count as the
provider's errors.

Claude Code also has a fallback of its own, within one provider: `CLAUDE_FALLBACK_MODEL`
(`claude_fallback_model: sonnet`) is the model it switches to when the run's model is
overloaded, before its provider counts as failed.

### Advanced settings

The listener and the egress proxy also read these. `compose.yaml` doesn't take them from
`.env`: it sets some itself, to match the services and volumes it defines, and leaves the
others to their defaults. To change one, set its key in `config.yaml` when it has one, or
else set it in the service's `environment`, for example in a `compose.override.yaml`.

| Setting                                 | Key                        | Default                                               | What                                                                                                                              |
| --------------------------------------- | -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GRANTS_DIR`                            | `grants_dir`               | `/etc/deckhand/grants`                                | what you grant each repo, one file each: hosts, cached hosts, host mounts, limits, preview hook, Dockerfile (the server folder's) |
| `INSTALL_NETWORK`                       | `install_network`          | `bridge`                                              | network of the agents' install containers (they need npm and GitHub's releases), and of the Antigravity CLI's login refresh       |
| `DEBOUNCE_MS`                           | `debounce_ms`              | `15000`                                               | pause after a comment before its run starts, so that comments posted together go in one run                                       |
| `BRAINSTORM_DEBOUNCE_MS`                | `brainstorm_debounce_ms`   | `3000`                                                | the same before a light run (brainstorms, onboarding, light modes)                                                                |
| `DATA_DIR`                              | none                       | `/data`                                               | the listener's state: the App's credentials, logs, queue, runs (the `data` volume)                                                |
| `DASHBOARD_DIR`                         | none                       | the image's `dashboard/dist`                          | the built dashboard the listener serves                                                                                           |
| `SANDBOX_IMAGE`                         | none                       | `<NAME_PREFIX>-sandbox`                               | the base image runs start from; compose sets the release's                                                                        |
| `ENGINE_IMAGE`, `ENGINE_PODMAN_IMAGE`   | none                       | `<NAME_PREFIX>-engine`, `<NAME_PREFIX>-engine-podman` | the [container engine](#container-engine)'s images, for Sysbox and for Podman; compose sets the release's                         |
| `BROKER_PORT`                           | none                       | `8081`                                                | port of the token broker, git gateway and egress policy, on the runs' networks                                                    |
| `BROKER_URL`                            | none                       | `http://listener:<BROKER_PORT>`                       | the broker, as sandboxes reach it; compose sets it                                                                                |
| `EGRESS_PROXY`                          | none                       | `http://egress:3128`                                  | the egress proxy, as sandboxes reach it; compose sets it                                                                          |
| `LISTENER_CONTAINER`                    | none                       | the container's host name (its id)                    | the listener's container, which joins each run's network                                                                          |
| `EGRESS_CONTAINER`                      | none                       | labelled `deckhand.role=egress`                       | the egress proxy's container, which joins each run's network; by default, the one in the listener's compose project               |
| `POLICY_URL` (egress proxy)             | none                       | `http://listener:8081/egress`                         | where the proxy asks whether a sandbox may reach a host; compose sets it                                                          |
| `RELAY_URL` (egress proxy)              | none                       | `POLICY_URL`'s host, `/relay`                         | where the proxy hands the requests it relays to the listener (the [Antigravity CLI](#antigravity-cli)'s)                          |
| `EGRESS_CACHE_DIR` (egress proxy)       | none                       | `/cache`                                              | where the proxy keeps the [egress cache](security.md#the-egress-cache) and its CA (`ca/`, the `egress-cache` volume)              |
| `EGRESS_CACHE_MAX` (egress proxy)       | none                       | `10g`                                                 | the egress cache's size, in bytes or with `k`, `m`, `g`, `t`; the least recently used answers go beyond it; `0`: no cache         |
| `EGRESS_CACHE_ENTRY_MAX` (egress proxy) | none                       | `1g`                                                  | the largest answer it keeps                                                                                                       |
| `PORT` (in the containers)              | none                       | `8080`, egress proxy: `3128`                          | port the listener and the proxy listen on; the `PORT` above only changes the published one                                        |
| `GITHUB_URL`, `GITHUB_API`              | `github_url`, `github_api` | `https://github.com`, `https://api.github.com`        | GitHub's web and API addresses, always allowed through the egress proxy                                                           |
| `CONFIG_FILE`                           | none                       | `/etc/deckhand/config.yaml`                           | the settings file above; set on purpose, it has to exist                                                                          |
| `DECKHAND_VERSION` (in the image)       | none                       | set when the image is built                           | the version the dashboard shows                                                                                                   |

## Updating

Each release is a git tag (`v1.2.3`) that publishes the images, tagged `1.2.3`, `1.2`
and `latest`. Each push to `main` publishes them too, tagged `edge`. There is no built-in updater: update the way you update other compose
services.

```sh
docker compose pull
docker compose up -d
```

- **`latest`** (the default): the two commands above take the newest release. Watchtower
  can run them for you.
- **A pinned version**: set `DECKHAND_VERSION=1.2.3` in `.env`, change it to update (by
  hand, or with Renovate's docker-compose or regex manager), then the same two commands.
- **`edge`**: set `DECKHAND_VERSION=edge` in `.env` to follow `main`, unreleased and for
  amd64 only. It is built as soon as a push lands (a newer push cancels the build in
  progress, so a burst of merges builds once), and the dashboard shows the commit it runs as
  `edge-<short sha>`. The same two
  commands (or Watchtower) update it.

You can update at any time, runs in progress included. The listener stops within its grace
period without waiting for them: it starts no new run, saves the comments still waiting for
one, and the sandboxes keep running. The new listener finds them again by their Docker
labels, delivers the comments that arrive meanwhile, and posts each run's final reply once,
even for a run that finished while no listener was there. Queued comments are then handled.
A new base image rebuilds a repository's own image on its next run (see
[Per-repo config](repo-config.md)); running sandboxes keep the image they started with.

## Container engine

A sandbox has no Docker: it never gets the host's socket, and its hardening (uid 1000, no
capabilities, `no-new-privileges`) rules out running an engine inside it. A repository whose
runs need to build and run images (to check its Dockerfiles, say) can get a **container
engine** instead: a second container the listener starts next to each of its work runs'
sandboxes, on the run's own network, and removes with it. The sandbox gets the `docker` CLI
(with buildx and compose) and `DOCKER_HOST=tcp://engine:2375`; containers it starts with a
published port answer at `engine:<port>`. Nothing in the engine touches the host's Docker,
and it reaches the outside only through the egress proxy, under the run's hosts.

Three steps, all off by default:

1. **Pick a backend**, `SANDBOX_ENGINE` in `.env` or `sandbox_engine` in `config.yaml`:
   - `sysbox` (recommended): `dockerd` under the [Sysbox](https://github.com/nestybox/sysbox)
     runtime, which maps root in the engine to an unprivileged user on the host: no
     `--privileged`, no relaxed seccomp or AppArmor. Linux hosts only (not Docker Desktop):
     install Sysbox from its releases (a `.deb` for Debian and Ubuntu, which restarts Docker),
     then check that `docker info` lists the `sysbox-runc` runtime. Without that runtime,
     runs that would get an engine fail with a reply saying so.
   - `podman`: rootless Podman serving Docker's API. Nothing to install, but the engine runs
     with seccomp and AppArmor unconfined, `/dev/fuse` and `/dev/net/tun`, and Docker's
     default capabilities, which expose more of the host's kernel (see
     [Security model](security.md#container-engine)). `docker build` uses the classic
     builder there (`DOCKER_BUILDKIT=0`), and some compose features differ.
   - `auto`: Sysbox where `docker info` lists its runtime, else Podman.
2. **Pull its image**: `COMPOSE_PROFILES=engine` in `.env`, then `docker compose pull` (or
   `up -d --build`) pulls or builds both engine images, `deckhand-engine` and
   `deckhand-engine-podman`, the way the `sandbox` service does the base image.
3. **Grant it per repository**: `allow_docker: true` in its file of the grants folder
   (`default.yaml` can't grant it), and the repository asks for it with `docker: true` in its
   `.deckhand.yaml` ([Per-repo config](repo-config.md#container-engine)). Add the registries
   it pulls from to `hosts` in its grants file: Docker Hub is
   `registry-1.docker.io`, `auth.docker.io` and `production.cloudflare.docker.com`; GHCR is
   `ghcr.io` and `pkg-containers.githubusercontent.com` (already allowed). A pull from any
   other registry fails at the proxy.

The engine has the repository's limits (its grant's, else the built-in ones) on top of the
sandbox's, and its storage is a volume of the run's own, removed with it. A repository can
keep that storage between its runs instead (`docker: { cache: true }`): one volume per
repository and backend, `deckhand-engine-cache-<repo>-…-<backend>`, which you remove by hand
to reclaim the space. Runs from a fork's pull request and light runs (brainstorms, inbox
entries) never get an engine.

To check it on your host: grant a repository, comment on one of its issues asking to
`docker build` its Dockerfile, `docker run` the image with a published port and `curl
engine:<port>`, and `docker compose up` its stack; the run's log on the dashboard starts with
`Container engine: sysbox, fresh storage`. Then `docker ps -a --filter label=deckhand.engine`
and `docker volume ls --filter label=deckhand.engine` are empty once the run is over.

## Download cache

Every run downloads its packages again: `apt-get`, `apk add`, `npm ci`, `pip install`, a
toolchain's archive. A repository's `caches` volumes and `docker: { cache: true }` keep
some of that for that repository only. The egress proxy can keep it for every run instead,
for the hosts you list:

```yaml
# server/grants/default.yaml (or grants/<owner>/<repo>.yaml, for one repository)
hosts: [registry.npmjs.org, files.pythonhosted.org, pypi.org]
cached_hosts: [deb.debian.org, dl-cdn.alpinelinux.org, registry.npmjs.org, files.pythonhosted.org]
```

- **Which hosts**: only the grants folder lists them, like `hosts`; a repository's
  `.deckhand.yaml` can't. A cached host must be reachable too (in `hosts`, or mandatory):
  `cached_hosts` alone opens nothing. List public mirrors whose files are the same for
  everyone, not APIs.
- **What is never kept**: a request with `Authorization`, `Cookie` or `Range`, anything but a
  `GET` answered `200`, and an answer marked `Cache-Control: private` or `no-store`, or
  larger than `EGRESS_CACHE_ENTRY_MAX` (1 GB). Those go through as before. Cookies an answer
  sets reach that client only. Answers are kept as long as the host says they are fresh,
  then checked again with it.
- **When**: a run's cached hosts are fixed when it starts, from the grants then: a change
  applies to the next runs, not to those already running.
- **Size**: one cache for every repository, in the `egress` service's `egress-cache` volume
  (`deckhand_egress-cache` with compose's default project name), at most `EGRESS_CACHE_MAX`
  (10 GB by default): beyond it, the least recently used answers go. Set it in the `egress`
  service's `environment` ([Advanced settings](#advanced-settings)); `0` turns the cache off.
- **HTTPS**: the proxy decrypts the HTTPS of cached hosts, and only theirs, with a CA it
  makes on its first start and keeps in that volume (`ca/`). Each run whose grant has
  cached hosts trusts that CA (its key never leaves the volume). The agent's hosts and
  GitHub's are never decrypted, and nor are a container engine's connections, which only
  get plain HTTP cached. Removing the volume, or `ca/` in it, and restarting the proxy makes
  a new CA, which the next runs get.

What this implies (the proxy reads cached hosts' traffic, and holds a key sandboxes trust),
and the rules in full: [The egress cache](security.md#the-egress-cache) in the security
model.

To check it: `docker compose logs egress` says `cache on, HTTPS too` at start. Ask two runs
of a repository with a cached host to fetch the same file from it with a `GET` (`curl -s -o
/dev/null -D - https://<host>/<file>`; `curl -I` isn't cached): the second answer says
`x-deckhand-cache: hit`. A run whose grant has cached hosts while the proxy's cache is off
says so in its log on the dashboard (`Egress cache: off for this run`), and
reaches those hosts as before, through a tunnel.

## How sandboxes reach GitHub

No sandbox gets a long-lived token, an SSH key or the host's git configuration:

- Each run gets a random secret, valid while the run lasts.
- Its git credential helper and `gh` wrapper send that secret to the listener's token
  broker (port 8081, on the runs' networks only, not published) on every
  call, and get back an installation token limited to the run's repository. A work run's
  has issues and pull requests (read and write), contents, actions and metadata (read).
  Brainstorms and inbox runs read pull requests only; discussion runs also write
  discussions, and only those. Onboarding and a repository's own light modes only read. Installation tokens
  last an hour; the broker renews them before that, so a run can go on for hours.
- Git fetches from GitHub over HTTPS with that token, and pushes through the listener's git
  gateway (same port, with the run's secret), which pushes the run's own branch only (its
  issue's `issue-<n>-*`, or its pull request's head), never the default one, with a token of
  its own (see [Security model](security.md#the-default-branch)). The
  listener also marks a run's pull request ready for review (`gh pr ready`), which that
  token can't. Commits
  and comments come from the App's bot (`<app>[bot]`, identity set through `GIT_AUTHOR_*`
  and `GIT_COMMITTER_*`).

The branches and pull requests a sandbox pushes run the repository's GitHub Actions like
anyone's, with its secrets and a `GITHUB_TOKEN`. Before installing the App on a repository,
set its default workflow permissions to read-only and keep deploy secrets behind
environments with required reviewers: see
[GitHub Actions on Deckhand's branches](security.md#github-actions-on-deckhands-branches).

Nor does a sandbox get your Claude credential. Its Claude Code calls the listener (same port,
`ANTHROPIC_BASE_URL=<broker>/anthropic`) with the run's secret where the credential would
be; the listener checks the secret, puts your credential in its place and forwards the call
to Anthropic, streaming the answer back (see [Security model](security.md#tokens)). Codex
does the same with `OPENAI_BASE_URL=<broker>/openai` and your `OPENAI_API_KEY`, and the
Antigravity CLI with `GOOGLE_GEMINI_BASE_URL=<broker>/google` and your `GEMINI_API_KEY`, or
through the egress proxy with a Google AI plan's login (see
[Antigravity CLI](#antigravity-cli)).

No agent is part of any image: before the first run that needs it, the listener installs the
pinned `CLAUDE_CODE_VERSION` into the `deckhand-claude-code` volume (Codex: `CODEX_VERSION`,
`deckhand-codex`; the Antigravity CLI: `AGY_VERSION`, `deckhand-antigravity`, its release's
tarball checked against the sha256 `AGY_SHA256` pins), in a container of its own, and later
runs reuse it, read-only. npm packages install with `--ignore-scripts`; only the agent's own
package then runs its install script (Claude Code's puts its native binary in place), never a
dependency's.

## Isolation

Sandboxes run without capabilities and with CPU, memory and pids limits, get no host path
unless you grant one, and reach only Anthropic, GitHub and the hosts you grant in the grants
folder, through the egress proxy. A [container engine](#container-engine), when you grant one,
runs next to the sandbox rather than in it. See [Security model](security.md): the grants folder, host
mounts, the mandatory hosts, and what isn't covered.

Upgrading from a version where all sandboxes shared the `deckhand-sandboxes` network: runs
started before the update go on (the new listener joins itself and the proxy to that network
again). Once they are over, `docker network rm deckhand-sandboxes`: compose no longer
creates it, and `SANDBOX_NETWORK` is no longer read. Keep the `deckhand.role: egress` label
of `compose.yaml`'s `egress` service if you copied the file: the listener finds the proxy
by it.

Upgrading from a version where `compose.yaml` mounted `config.yaml` and `grants/` one by
one: move them into the server folder (`mkdir -p server && mv config.yaml grants server/`),
and drop their lines from your `compose.yaml` or `compose.override.yaml` if you added them
there; the new `compose.yaml` mounts the folder.

Upgrading from a version with a single grants file (`GRANTS_FILE`, `grants.yaml`): the
listener reads a folder now, `GRANTS_DIR`, and refuses to start while `GRANTS_FILE` is set.
Move each `owner/repo:` entry to its own file, `owner/repo.yaml`, with its keys one level
up; `"*"` becomes `default.yaml`. Then mount the folder instead of the file
(`server/grants/`, see [the server folder](#the-server-folder)) and remove `GRANTS_FILE`. For example:

```yaml
# grants.yaml, before
acme/api:
  hosts: [pypi.org]
  allow_preview: true
```

```yaml
# server/grants/acme/api.yaml, after
hosts: [pypi.org]
allow_preview: true
```

Upgrading from a version where a repository's `.deckhand.yaml` alone decided its preview
hook, Dockerfile and branch images: grant them in your grants folder, for each repository
that uses them (or every one, in `default.yaml`), with `allow_preview: true`,
`allow_dockerfile: true` and `allow_branch_docker_images: true`. Until then that
repository's runs stop with a reply naming the missing grant, its preview hook doesn't run
(the listener's logs say why), and `allow_branch_docker_images` in its `.deckhand.yaml` is
ignored with a warning in the run's log.

Upgrading from a version with `ALLOWED_HOSTS` or `SANDBOX_CPUS`, `SANDBOX_MEMORY`,
`SANDBOX_PIDS`: what every sandbox gets is in the grants folder now, read at each run, and
the listener refuses to start while any of them is set (in `.env` or `config.yaml`, where
`allowed_hosts: []` counts too). Move them to `grants/default.yaml`, then remove them:

```sh
# .env, before
ALLOWED_HOSTS=registry.npmjs.org,*.pypi.org
SANDBOX_MEMORY=8g
```

```yaml
# server/grants/default.yaml, after
hosts: [registry.npmjs.org, "*.pypi.org"]
limits: { memory: 8g }
```

Upgrading from a version where a repository's `.deckhand.yaml` could add `hosts`: only the
grants folder lists hosts now (see
[Where a sandbox's hosts come from](security.md#where-a-sandboxs-hosts-come-from)). A
repository's `hosts` are ignored with a warning, and a grants file still saying
`allow_repo_hosts` has an error that stops that repository's runs (or every run, in
`default.yaml`) until you remove it. Copy the hosts those repositories listed into their
grants file, `hosts: [...]` in `grants/<owner>/<repo>.yaml`, then remove `allow_repo_hosts`.
