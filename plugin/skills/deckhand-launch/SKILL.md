---
name: deckhand-launch
description: Step 5 of setting up Deckhand. Starts it with Docker Compose, checks edge through the public address, opens the one-time setup link in the browser (never printing it) so the user creates and installs the GitHub App, then sees a first `Deckhand` comment through to its answer. Use alone to start Deckhand, finish the App's setup, or try a first run.
---

# Deckhand: launch, the GitHub App, a first run

The references: `docs/get-started/quick-start.md`, `docs/guides/github-app.md`,
`docs/guides/runs.md`, `docs/guides/logs.md`. Run from the Deckhand folder. The helpers:

```sh
sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env check <NAME>...
sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-open-setup <public_url>
```

Write them out in full in each command: the shell keeps no variable from one command to the
next.

## Rules

- **The setup link is never printed**: its token creates the App. Never run
  `docker compose logs edge` (or `docker compose logs` of every service) as it is: filter it,
  `docker compose logs edge | grep -v 'setup?token='`. `sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-open-setup` opens it in the browser.
- **The user's clicks stay theirs**: on GitHub, creating the App and installing it grant
  permissions on their account. Say what each page shows and what to pick; they click.
- **Ask before writing to GitHub** (an issue, a comment): show what you'd post first.
- No `.env` read, no secret printed: `sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env check` for names.

## 0. Already done?

When Deckhand answers (`curl -fsS localhost:8080/health`) and has its App (`curl -s localhost:8080/`
doesn't say "no GitHub App yet"), look for the first run an earlier pass of this skill
started, the user's "Try Deckhand" issue (section 5):

```sh
gh search issues "Try Deckhand" --author @me --match title --json url,repository,number
```

For each, `gh api repos/<owner/repo>/issues/<number>/comments --jq '.[] | select(.user.type == "Bot") | .html_url'`
lists the App's replies. One there: the setup is done. Say so, with its link and the public
address, check the public address still answers (section 2's last check), and stop: no new
issue or comment. An issue without a reply yet: follow it as section 5 says, rather than
opening another. None (or no `gh`: ask the user): go on.

## 1. Before starting

Each missing piece is a step skill of its own; run it, then come back:

- a credential: `sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env check CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY`
  or a login in `credentials/` (`deckhand-credentials`);
- a login in `allowed_users` of `server/config.yaml` (`deckhand-server-folder`);
- `public_url` in `server/config.yaml`, or `PUBLIC_URL` set (`deckhand-endpoint`).

## 2. Start

```sh
mkdir -p -m 700 credentials   # before the models service starts, or Docker makes it root's
docker compose pull           # a few minutes the first time
docker compose up -d
docker compose ps
```

On Linux, unless `id -u` says 1000, the user runs `sudo chown 1000 credentials` (the models
service runs as uid 1000, `docs/guides/agents.md#the-credentials-folder`); otherwise its log
warns at each start that it can't read the folder, harmless without a plan's login there.

Then wait for edge, up to two minutes:
`for i in $(seq 24); do curl -fsS localhost:8080/health && break; sleep 5; done` (`PORT` from
`.env` instead of 8080 when the user changed it). A service that keeps restarting: its log,
`docker compose logs <service> | grep -v 'setup?token=' | tail -n 30`, says why (a missing
setting, `allowed_users` empty, a port taken), and `docs/guides/logs.md` the rest.

Then through the public address: `curl -fsS --max-time 10 <public_url>/health` answers `ok`.
Not yet: the tunnel (`deckhand-endpoint`, its section 4) before going on, as GitHub can't
reach edge otherwise.

## 3. The GitHub App

`curl -s localhost:8080/` says "no GitHub App yet" until the App is created. Already created:
skip to section 4.

Before opening the link, tell the user what they'll see and pick:

1. Deckhand's setup page: the public URL (check it is `public_url`), the App's name (any
   free name), and the organization that owns it: empty for their own account, or the
   organization whose repositories Deckhand works on. A private App installs only on its
   owner's account: for several organizations, `docs/guides/github-app.md#installing-it-on-several-organizations`
   afterwards.
2. GitHub's page with the App's permissions and events, filled in: **Create**.
3. GitHub's installation page: pick the repositories Deckhand may work on (those
   `allowed_repos` allows), then **Install**.

Then `sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-open-setup <public_url>`. It prints only what it did. With no browser on this machine
(a server over SSH), it says what the user runs in their own terminal to get the link; never
fetch it for them.

Wait for the user to say it's done, then check: `curl -s localhost:8080/` no longer says "no
GitHub App yet", and `docker compose logs edge github | grep -v 'setup?token=' | tail -n 20`
shows no error. "Setup expired" or "Setup link needed" in the browser: edge restarted since,
and its link changed: `sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-open-setup <public_url>` again.

## 4. The installation

Ask which repository to try it on (`owner/repo`, one the App is installed on), unless
section 0 found one. Each one
without a `.deckhand.yaml` gets an onboarding issue within a minute or so:
`gh issue list -R <owner/repo> --label deckhand-onboarding --state all`. There: the App is
installed and Deckhand hears it. That issue can wait (`docs/guides/repositories.md#onboarding`):
a repository works without a config.

Without `gh`, ask the user to look at the repository's issues. No onboarding issue after a few
minutes (and the repository has no `.deckhand.yaml`): `docker compose logs orchestrator | grep -i onboarding | tail`
says why (an installer out of `allowed_users`, a repository out of `allowed_repos`).

## 5. A first run

A comment whose first line is `Deckhand` starts a run (`docs/reference/comment-commands.md`).
A harmless first one: a brainstorm, which answers in the issue's comments without touching the
code. Propose, and post only once the user agrees (or let them post it themselves):

```sh
gh issue create -R <owner/repo> --title "Try Deckhand" \
  --body "Read this repository and suggest two or three small, useful first issues for Deckhand."
gh issue comment <number> -R <owner/repo> --body "Deckhand /mode brainstorm"
```

(A plain `Deckhand` comment instead works on a branch and opens a draft pull request.)

Then follow it, every 30 seconds or so, for up to 15 minutes (the first run installs the agent
once, into a volume):

- the comment's reactions, `gh api repos/<owner/repo>/issues/comments/<id>/reactions --jq '.[].content'`
  (the id ends the URL `gh issue comment` printed): `eyes` (received), then `rocket` (done),
  `confused` (it asks a question), or `-1` (failed);
- the reply: `gh issue view <number> -R <owner/repo> --comments`;
- live, on the dashboard: `<public_url>`, signed in with GitHub (only `allowed_users` can).

No `eyes` after a minute: GitHub didn't reach edge, or ignored the author. The App's _Advanced_
tab on GitHub lists its recent deliveries; `docker compose logs edge orchestrator | grep -v 'setup?token=' | tail -n 40`
names a login out of `allowed_users`. `-1`: the dashboard's page for the issue has the run's
log. `docs/get-started/quick-start.md#when-it-doesnt-start` has the rest.

Once the reply is there, the setup is done: say so, with the issue's link.
