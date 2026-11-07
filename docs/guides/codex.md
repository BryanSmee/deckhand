# Codex

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
(per repository, or per mode: [Per-repo config](../repo-config.md#agent)). A repository can only
pick an agent you have a credential for, or the one you chose as default. `SANDBOX_AGENT=codex`
without `OPENAI_API_KEY` (or a ChatGPT plan's login) stops the orchestrator at start.

As with Claude Code, the key never enters a sandbox: Codex calls the models service
(`OPENAI_BASE_URL=<broker>/openai`, which the egress proxy sends there) with the run's agent
token as its key, and the models service forwards the call to OpenAI (or your `OPENAI_BASE_URL`) with yours. The sandbox turns off
Codex's analytics, update check and plugins, so it needs no host besides GitHub's: not
`api.openai.com`, and not `api.anthropic.com` either.

## What differs from Claude Code

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

## With a ChatGPT plan

Instead of an API key, Codex can run on a ChatGPT plan's login. Its refresh token is
single-use and rotated on every refresh, so only one copy may be in use: the models service
holds it, refreshes it and adds the plan's access token to the sandboxes' calls, which go to
ChatGPT's Codex backend (`chatgpt.com/backend-api/codex`). No sandbox gets it.

1. Sign in for Deckhand alone, in a fresh Codex home (any machine with Codex):

   ```sh
   export CODEX_HOME=$(mktemp -d)
   codex login --device-auth
   ```

2. Move its `auth.json` into [the credentials folder](agents.md#the-credentials-folder) on the
   host (next to `compose.yaml`), then delete that home without `codex logout`,
   which would revoke the login:

   ```sh
   mv "$CODEX_HOME/auth.json" credentials/codex-auth.json
   rm -r "$CODEX_HOME"
   ```

3. Restart the models service, then the orchestrator (`docker compose restart models orchestrator`):
   the file turns the login on.

The models service logs `Codex: a ChatGPT plan's login, from /data/credentials/codex-auth.json`
at start, or why it can't use it. It refreshes the access token 5 minutes before it expires,
once for all runs, and keeps the new tokens in its store, sealed (the file stays as you wrote
it). Don't use that `auth.json` anywhere else: a refresh elsewhere spends the token the models
service holds. When the login is spent (revoked, or refreshed elsewhere), runs fail with "run
`codex login` again": repeat the steps above; the models service reads the new file without a
restart. `OPENAI_API_KEY`, when set too, wins.

A plan is licensed to one person: the orchestrator's log warns about it at each start (see
[A plan or an API key](install.md#a-plan-or-an-api-key)).
