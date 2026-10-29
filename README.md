# Deckhand

Deckhand runs Claude Code on your GitHub issues and pull requests. Comment `Deckhand` on an
issue and it starts a sandbox, works on a branch, opens a draft pull request and answers on the
issue when it is done, or stops to ask when only you can decide.

It is self-hosted and bring-your-own-key: you create your own private GitHub App, run your
own server with Docker, and use your own Claude credential. It can run
[Codex](docs/setup.md#codex) instead, with your own OpenAI API key, or Google's
[Antigravity CLI](docs/setup.md#antigravity-cli) with a Gemini API key or on your Google AI
Pro/Ultra plan, for every
repository or for those that pick it. One deployment serves one
operator, across as many repositories as the App is installed on.

## What it does

- **Comment triggers.** On an issue, the first line of a comment is the command and the rest
  are instructions:
  - `Deckhand`: a run in a sandbox, on the branch `issue-<n>-<slug>`, with a draft pull
    request. Once started, any comment on the issue or its pull request (reviews and review
    comments too) continues the same session. The trigger is the whole first line (any case or
    punctuation: `@deckhand:` too), so "Deckhand is down" starts nothing.
  - `Deckhand` then `/mode brainstorm` (on the next line, or the same one): a discussion of
    the issue in its comments, without code. `/stop` wraps it up; `Deckhand` or `/mode work`
    then implements, in a session of its own that starts from the issue and its comments.
  - `/model <name>` and `/effort <level>` lines pick the model (`best`, `balanced`, `fast` or a
    model's name) and thinking effort of that run. `/agent <name>` (`codex`,
    `claude@openrouter`, among those the operator configured) picks the agent: the issue stays
    with it, without fallbacks, until another `/agent` (`/agent default` goes back). Like
    `/mode` and `/after`, they may follow the trigger on its line (`Deckhand /agent codex`).
  - `/mode <name>` picks a mode: `work`, `brainstorm` or one the repository declares in its
    `.deckhand.yaml` (a review that only comments, say). Alone on an issue with a session,
    it switches modes and keeps the conversation (light modes keep theirs apart from work's).
  - `/after #77` (on the trigger line or its own, `/after #77 #80` for several) holds the
    comment back until those issues are closed as completed, or those pull requests merged,
    then runs it as if just posted. A new trigger comment starts now instead; `/after none`
    cancels.
  - `/cancel` alone on its first line stops the issue's run now (a stuck one, say): the reply
    says who stopped it, and the next comment resumes its session. The task's page on the
    dashboard has the same **Stop** button.
- **Onboarding.** Installing the App on a repository without a `.deckhand.yaml` opens an
  issue there where Claude proposes one, grounded in the repository; your comments refine it
  and `Deckhand` turns it into a pull request. `/mode onboarding` starts it on any issue, and
  the dashboard lists the repositories not onboarded yet, with a button that starts it.
- **Live feedback.** The comment gets 👀 when it is received, then 🚀 (done), 😕 (needs
  input) or 👎 (error). A burst of comments is one message, and one that arrives while
  Claude works reaches the running session; an entry on the ideas or bugs inbox is always a
  run of its own, with its own reply. The final message comes back as a comment from the
  App's bot.
- **Needs input.** A run that hits a decision only you can make pushes its work in progress,
  asks numbered questions and labels the issue `needs-input`; your answer continues the same
  session.
- **Inboxes.** An ideas issue and a bug reports issue, where each of your comments becomes a
  filed GitHub issue, and a GitHub Discussions category (for example "Ask Claude") where
  Claude answers questions.
- **Preview hook.** A command of the repository run on `pull_request` and `workflow_run`
  events, to deploy or remove previews.
- **Dashboard.** Every issue, pull request and discussion Deckhand worked on, grouped by
  project and repository, with its state and the live log of its runs, and a graph of what
  waits for what (`/after`). Sign-in with GitHub.

## How it works

```
GitHub ──webhook──▶ listener ──docker──▶ sandbox (one per issue, Claude Code inside)
                     │  ▲                   │
                     │  └─ GitHub gateway ◀─┤  the run's secret, which the listener swaps
                     │                      │  for a token for that repo only
                     │                      └──▶ egress proxy ──▶ allowed hosts only
                     └── dashboard
```

- The **listener** (`listener/`) checks each webhook's signature, the allowlist and the
  trigger line, queues the work and starts one sandbox container per run. It holds the
  Docker socket and the App's private key; no sandbox gets either.
- A **sandbox** (`sandbox/`) is a container from the base image, or the repository's own
  image built `FROM` it. It runs Claude Code with permissions bypassed, in a clone of the
  repository kept between the issue's runs.
- The **egress proxy** (`proxy/`) is the sandboxes' only way out: Anthropic's API, GitHub,
  and the hosts you allow.
- **Prompts** (`prompts/`): the generic sandbox rules, and those of brainstorms, onboarding,
  inboxes and discussions. A repository adds its own instructions through its config.

## Quick start

You need:

- a server with Docker Engine 26 or later and the compose plugin;
- an HTTPS address GitHub can reach (your reverse proxy, or a tunnel), forwarding to the
  listener's port (8080);
- a GitHub account (or organization) to own the App, and the repositories to use it on;
- a Claude credential: a token from `claude setup-token` (your Claude plan) or an
  `ANTHROPIC_API_KEY`; or an Anthropic-compatible gateway such as OpenRouter and its token
  (see [Through a gateway](docs/setup.md#through-a-gateway)).

**1. Configure and start.**

```sh
git clone https://github.com/BryanSmee/deckhand.git
cd deckhand
cp .env.example .env
```

In `.env`, set `ALLOWED_USERS` to your GitHub login (comma-separated for several: nobody
else can start a run, and with none set nothing starts), and `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`. The other settings, and what you grant each repository, go in one
folder you keep in git and `compose.yaml` mounts, `.env` overriding its settings: see
[The server folder](docs/setup.md#the-server-folder). Then:

```sh
cp -r server.example server
docker compose pull
docker compose up -d
docker compose logs listener
```

This pulls the released images (the listener, the egress proxy and the base sandbox image,
at `DECKHAND_VERSION`, by default `latest`) and starts the first two; `docker compose up -d
--build` builds them from your checkout instead. The logs print a one-time setup link,
`…/setup?token=…`.

**2. Create the GitHub App.** Open the setup link through your public address (for example
`https://deckhand.example.com/setup?token=…`). Check the public URL, pick the App's name and
owner, and create it on GitHub: its permissions and events are filled in for you. GitHub
then sends you to the App's installation page: pick the repositories Deckhand may work on.

**3. First run.** On an issue of one of those repositories, comment:

```
Deckhand
```

The comment gets a 👀. The first run installs Claude Code (once, into a volume), then
works: open the listener's address to follow it on the dashboard. When it is done, the issue
has a reply, and the branch `issue-<n>-<slug>` a draft pull request.

[docs/setup.md](docs/setup.md) has the details: what the App asks for, the dashboard's
states, every setting and how sandboxes reach GitHub.

## Per-repo config

A repository can add a `.deckhand.yaml` at its root: its own users (narrowing
`ALLOWED_USERS`), trigger word, models, parallel runs, a setup command, project
instructions, a Dockerfile for its image, caches, host mounts, inboxes and a preview hook.
Its Dockerfile, preview hook and host mounts only count once the operator grants them to it
in its grants file, which also lists the hosts its sandboxes may reach.

```yaml
users: [alice]
model: opus
effort: high
setup: npm ci
instructions: AGENTS.md
dockerfile: .deckhand/Dockerfile
caches: [/home/node/.npm]
```

It is read from the **default branch** only, at every run, and can only narrow what you, the
operator, allow. A repository without one gets an onboarding issue when the App is installed
on it, where Claude proposes the file. See [docs/repo-config.md](docs/repo-config.md).

## Isolation defaults

Out of the box, without any configuration:

- **Network:** each sandbox sits on an internal Docker network of its own, out of the
  others' reach; the egress proxy lets them reach
  `api.anthropic.com`, GitHub and nothing else. You add hosts in the grants folder, for
  every repository (`grants/default.yaml`) or for one (`grants/<owner>/<repo>.yaml`); a
  repository can't add its own (see
  [Where a sandbox's hosts come from](docs/security.md#where-a-sandboxs-hosts-come-from)).
- **Host paths:** none. No `~/.ssh`, `~/.gitconfig`, Docker socket or source tree. A host
  path is only mounted when you grant the repository a root that holds it, and read-only
  unless you say otherwise.
- **Privileges:** containers run as `node` with `--cap-drop ALL`, `no-new-privileges`, and
  CPU, memory and pids limits (2 CPUs, `4g`, 2048 processes; `limits` in the grants folder).
- **GitHub:** no token or SSH key in a sandbox. Its GitHub calls carry a secret that dies
  with the run; the egress proxy relays them to the listener's GitHub gateway, which sends
  them on with an installation token limited to the run's repository, redacts secrets from
  what they write, and keeps a review from reading outsiders' comments. That token only
  reads the code: pushes go through the listener, which refuses the default branch, where
  Deckhand reads its config.

## Security model

Read this before installing Deckhand on a repository.

- **Permissions are bypassed inside a sandbox.** Claude Code runs unattended, without
  permission prompts, on issues and comments other people may have written. Deckhand
  assumes whatever runs in a sandbox may try to read what it shouldn't or send it out, and
  limits what it can reach instead (above).
- **The allowlist decides who starts runs.** Only `ALLOWED_USERS` (narrowed per repository)
  start runs, answer brainstorms or feed inboxes; everyone else, unknown repositories and
  unknown events are ignored. With no allowlist, nothing starts. Webhooks are checked with
  their HMAC signature.
- **The egress proxy decides where data can go.** Every allowed host is trusted entirely:
  anything a sandbox can write to there (its own repository on GitHub, a bucket behind `*`)
  is a way out. Keep the list short.
- **What isn't covered:** image builds, the Claude Code install and preview hooks run
  outside the sandboxes' networks, and preview hooks get the Docker socket (root on the
  host): a repository only gets its own Dockerfile built or preview hook run when its grants
  say so (`allow_dockerfile`, `allow_preview`). DNS lookups may leave the internal networks.

All of it, with the grants folder and the limits of each measure:
[docs/security.md](docs/security.md).

## Updating

Each release (a `v1.2.3` tag) publishes the images to GHCR, tagged `1.2.3`, `1.2` and
`latest`. Update like any compose service, at any time:

```sh
docker compose pull
docker compose up -d
```

Runs in progress keep going while the listener restarts: their sandboxes run detached, and
the new listener finds them by their Docker labels, delivers the comments that arrive
meanwhile and posts each final reply once. Comments still waiting for a run and brainstorms
between replies are kept. Pin a release with `DECKHAND_VERSION` in `.env` (for Renovate), or
leave it on `latest` (for Watchtower). See [Updating](docs/setup.md#updating).

Claude Code's version is pinned by `CLAUDE_CODE_VERSION`: change it in `.env` (or
`claude_code_version` in `config.yaml`) to move to
another one, and the next run installs it. Codex's is `CODEX_VERSION`, the same way, and the
Antigravity CLI's `AGY_VERSION`, with the sha256 of its tarballs in `AGY_SHA256`.

## Claude Code and naming

- Deckhand runs Claude Code; it is not made by or affiliated with Anthropic. Its name,
  images and logo don't use "Claude" or "Anthropic".
- Claude Code is not bundled in any image: the listener installs it on first start, at the
  pinned version, into a Docker volume. So are Codex and the Antigravity CLI, when they run.
- Each operator uses their own `ANTHROPIC_API_KEY` or their own Claude login (a token from
  `claude setup-token`), under their own agreement with Anthropic, and follows Anthropic's
  [Usage Policy](https://www.anthropic.com/legal/aup).

## Development

Node 26; the listener has no dependencies. Tests: `node --test`; syntax: `node --check
listener/server.mjs`, `bash -n` on `sandbox/`'s shell scripts and the tests' fake docker, and `node --check
sandbox/deckhand-inbox` (the list: [AGENTS.md](AGENTS.md#commands)); format: `npx --yes prettier@3 --check .`.
The dashboard (`dashboard/`, Preact + Vite + TypeScript) is built into the listener's image;
locally: `cd dashboard && npm ci && npm test && npm run build`, or `npm run dev` against a
listener on port 8080. See [AGENTS.md](AGENTS.md) for the conventions and security rules.

## Licence

[Apache License 2.0](LICENSE).
