---
name: deckhand-server-folder
description: Step 3 of setting up Deckhand. Makes the server folder (server/config.yaml and its grants) from server.example, puts the user's GitHub login in allowed_users, the repositories in allowed_repos, and the agent in sandbox_agent. Use alone to check or change who may start runs and on which repositories.
---

# Deckhand: the server folder

`server/` (mounted at `/etc/deckhand`) holds every setting but the secrets, and in `grants/`
what each repository gets beyond a bare sandbox. Deckhand fails closed: with nobody in
`allowed_users`, nothing starts. The references: `docs/reference/server-folder.md`,
`docs/reference/settings/access.md`, `docs/guides/repositories.md#which-repositories`.

Run from the Deckhand folder (step 1, `deckhand-prerequisites`, finds it). Nothing here is a
secret: read and edit `server/config.yaml` with the file tools. `.env` stays closed: check its
names with the helper, never its values:

```sh
sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env check <NAME>...
```

Write it out in full in each command: the shell keeps no variable from one command to the
next.

## 1. The folder

`test -d server || cp -r server.example server`. An existing `server/` is the user's: change
only the keys below, and show each change.

## 2. Who may start runs: `allowed_users`

The login: `gh api user --jq .login` (or ask, without `gh`). Read `allowed_users` in
`server/config.yaml`:

- It has the login: done.
- Empty (`[]`): set it to `[<login>]`. Others can be added later, each a GitHub login; anyone
  listed may start runs on every allowed repository, with the user's credential.

`sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env check ALLOWED_USERS ALLOWED_REPOS`: a name `set` in `.env` wins over the file. Tell the
user, and ask them to check (in their editor, not here) that `.env`'s value has their login, or
to empty that line so the file's applies.

## 3. Which repositories: `allowed_repos`

Empty allows every repository the App is installed on, whoever installed it. Ask which
repositories Deckhand may work on, and write them as `owner/repo`, or `owner/*` for every
repository of an account (`docs/guides/repositories.md#which-repositories`: `*`, `*/*` or a
bare owner refuse to start). Recommend setting it: the user's own account
(`[<login>/*]`) is the usual first answer, and it must be set before the App is ever made
public for several organizations (`docs/guides/github-app.md#installing-it-on-several-organizations`).

## 4. The agent: `sandbox_agent`

`claude` by default. With only Codex's or the Antigravity CLI's credential (step 2,
`deckhand-credentials`: `sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env check CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY`,
and `ls credentials`), set it to `codex` or `antigravity`.

## 5. The rest

Leave the other settings and `grants/` as they are: they grant nothing beyond a bare sandbox
until the user changes them (`docs/reference/server-folder.md#the-grants`). `public_url` is
step 4's (`deckhand-endpoint`).

Settings are read at start only (`docs/reference/settings.md#how-settings-are-read`): when
Deckhand is already running, changes take `docker compose restart`, and the orchestrator's log
(`docker compose logs orchestrator | tail -n 20`) names a setting it refuses.
