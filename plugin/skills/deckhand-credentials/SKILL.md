---
name: deckhand-credentials
description: Step 2 of setting up Deckhand. Puts the agent's credential (a Claude plan's token or an Anthropic API key, or Codex's or the Antigravity CLI's key or plan login) in Deckhand's .env or credentials folder, through a hidden prompt in the user's own terminal, so no secret enters the conversation. Use alone to add or replace a credential.
---

# Deckhand: the agent's credential

Deckhand's sandboxes run an agent (Claude Code by default; Codex or the Antigravity CLI) on the
user's own credential, which the models service alone holds. This step puts one in place
**without the value ever passing through the conversation**. The references:
`docs/guides/install.md#a-plan-or-an-api-key`, `docs/guides/claude-code.md`,
`docs/guides/codex.md`, `docs/guides/antigravity.md`, `docs/guides/agents.md#the-credentials-folder`.

Run from the Deckhand folder (step 1, `deckhand-prerequisites`, finds it). The helper:

```sh
ENV="sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env"
```

## Rules

- Never read, `cat`, `grep` the values of, `source`, or edit `.env` with a file tool, nor
  `credentials/`'s files. `deckhand-env check` tells set from empty, names only; `ls -l` and
  `test -s` tell whether a file is there.
- The user types or pastes every secret themselves, in **their own terminal window**, not with
  `!` in this session (its output would enter the conversation). Give them the exact command,
  with the helper's full path expanded, and wait for them to say it's done.
- A secret pasted into the conversation anyway: tell the user to revoke it and make another.

## 1. What is there

```sh
test -f .env || { cp .env.example .env && chmod 600 .env; }
$ENV check CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY CODEX_AUTH_FILE AGY_AUTH_FILE
ls -l credentials 2>/dev/null
```

(`.env.example` holds no secret: copying it is safe.) Any of them set, or `codex-auth.json` or
`agy-auth.json` in `credentials/`: say which agent it gives and ask whether to keep it. Kept:
the step is done.

## 2. Which credential

Ask, with these options (Claude Code first, the default):

1. **Claude plan** (Pro or Max): `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`.
2. **Anthropic API key**: `ANTHROPIC_API_KEY`, from https://console.anthropic.com/.
3. **Codex**, with an OpenAI API key (`OPENAI_API_KEY`) or a ChatGPT plan's login.
4. **The Antigravity CLI**, with a Gemini API key (`GEMINI_API_KEY`) or a Google AI plan's login.

Say it plainly before a plan: a subscription is usually licensed to one person. Serving a team,
or repositories other people write to, may break the provider's terms, and the user is
responsible for how Deckhand uses it. For a team, an API key.

## 3. Setting it

**A token or a key** (options 1, 2, and the API keys of 3 and 4): tell the user to run, in
their own terminal, from the Deckhand folder:

- Claude plan: first `claude setup-token` (it opens the browser and prints a token), copy the
  token, then the line below with `CLAUDE_CODE_OAUTH_TOKEN`.
- Otherwise: copy the key from the provider's console, then the line below with its name.

```sh
cd <the Deckhand folder> && sh <helper's full path> set <NAME>
```

It asks for the value without showing it, and appends `<NAME>=…` to `.env` (compose reads the
last line setting a name). Then check again with `$ENV check <NAME>`: `set`.

**A ChatGPT plan's login** (Codex) or **a Google AI plan's login** (the Antigravity CLI): the
user follows the steps of `docs/guides/codex.md#with-a-chatgpt-plan` or
`docs/guides/antigravity.md#with-a-google-ai-plan` in their own terminal (show them the
section's commands, from the docs in the Deckhand folder): they leave
`credentials/codex-auth.json` or `credentials/agy-auth.json`. Make the folder first, as
`docs/guides/agents.md#the-credentials-folder` says (the models service runs as uid 1000):

```sh
mkdir -m 700 credentials   # then, unless the user is uid 1000 (`id -u`): sudo chown 1000 credentials
```

Then check the file is there (`test -s credentials/<file> && echo present`), never its content,
and that the user ran `chmod 600` and, unless they are uid 1000, `sudo chown 1000` on it.

## 4. The agent

With Codex or the Antigravity CLI and no Claude credential, the server folder must say so:
`sandbox_agent: codex` or `sandbox_agent: antigravity` in `server/config.yaml`. Set it there when
the folder exists (step 3, `deckhand-server-folder`, does otherwise).

When Deckhand is already running (`docker compose ps --status running` lists `models`), the new
credential takes `docker compose up -d models orchestrator` (a credentials-folder file:
`docker compose restart models orchestrator`). A plan's login: the models service says whether
it can use it, naming the file only, in `docker compose logs models | grep -E 'Codex:|Antigravity CLI:'`.
