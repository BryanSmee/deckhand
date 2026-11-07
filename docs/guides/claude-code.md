# Claude Code

Claude Code (`claude`) is Deckhand's default agent. It runs on a Claude plan (`CLAUDE_CODE_OAUTH_TOKEN`), an Anthropic API key (`ANTHROPIC_API_KEY`) or a gateway's token (`ANTHROPIC_AUTH_TOKEN`): which one runs first, and how a run picks another, is in [Agents and providers](agents.md). This page has what is Claude Code's own: a gateway such as OpenRouter, and fast mode. To go on through OpenRouter only when Anthropic fails, see [Fallbacks](fallbacks.md).

## Through a gateway

Claude Code can go through an Anthropic-compatible gateway instead of Anthropic:
[OpenRouter](https://openrouter.ai), your company's LLM gateway. Sandboxes still call the
models service, which forwards their calls to `ANTHROPIC_BASE_URL` with your credential: they never
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
over them anyway, as in Claude Code. A `claude@anthropic:plan` or `:key` entry in `FALLBACKS`
would send them to the gateway; `/agent` can't pick them while a gateway is the default. `SANDBOX_MODEL`, `BRAINSTORM_MODEL`, a repository's
`model` and a comment's `/model` line take the gateway's names too (`/model openai/gpt-5`).

Claude Code is built for Claude models: others, through a gateway, are uneven at its tool
calls (edits, long sessions, thinking), and a run can stop halfway or misuse a tool. Try a
model on a small issue before giving it real work. Restart the models service and the
orchestrator after changing these settings; switching back to Anthropic is emptying `anthropic_base_url` and setting your
Anthropic credential.

## Fast mode

Claude Code's fast mode runs the same Opus model with output up to about 2.5× faster, at a
higher price per token (about twice Opus's). It is for work that can't wait, like a critical
fix: a `/speed fast` line in a comment (or ending its trigger line or an inbox entry's line)
asks for it, `/speed normal` drops it, and a repository's mode may ask for it by default
(`speed: fast`, see [Modes](../repo-config/modes.md#modes)). It is off until you allow it:

```yaml
# server/config.yaml
sandbox_fast_mode: allowed
```

A repository's `fast_mode: false` turns it off there; it can't turn it on when you haven't.
A run that asks for it and can't have it runs at normal speed, and the reply's footer says
why: you haven't allowed it, the repository turned it off, the agent has none (Codex, the
Antigravity CLI) or the provider is OpenRouter (`claude@openrouter`). Fast mode is Opus only:
`/speed fast` with `/model balanced` or `/model fast` runs on `best` instead, and the footer
says so. A `/speed` sent while a run goes on applies to the next run, like `/model`. A fast
run's footer reads `🤖 Claude opus · high effort · fast · 4 min`, and the dashboard and the
run's log show `fast` too, so you can see which runs cost more.

What it needs from your credential:

- **An API key** (`ANTHROPIC_API_KEY`): billed per token at the fast price. An admin of your
  organization must allow fast mode in the Console's Claude Code preferences, else the API
  refuses it and Claude Code goes on at normal speed (the footer then says the agent couldn't
  turn fast mode on).
- **A plan** (`CLAUDE_CODE_OAUTH_TOKEN`): not through Deckhand. Claude Code asks
  `api.anthropic.com` whether the account may use fast mode with the token itself, which
  sandboxes never hold (the models service adds it to their API calls), so the answer is no and
  the run goes on at normal speed, saying so in its footer.
- **A gateway** (`ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex, Foundry): usually not available;
  Claude Code then runs at normal speed.

Turning it on in a session that already has context bills that whole context once, uncached,
at the fast price: a `/speed fast` on a long issue's session costs more than on a new one.
