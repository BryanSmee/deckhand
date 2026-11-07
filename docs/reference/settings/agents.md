# Agents and models

Which agents run, on which provider and credential, with which model and effort, and where a
run goes when its provider fails. The credentials are the models service's alone: no sandbox
ever holds one. Setting each up: [Agents and providers](../../guides/agents.md) (and its
[models and efforts](../../guides/agents.md#models-and-efforts), and
[the credentials folder](../../guides/agents.md#the-credentials-folder) of the plans' logins),
[Claude Code](../../guides/claude-code.md), [Codex](../../guides/codex.md),
[Antigravity CLI](../../guides/antigravity.md) and [Fallbacks](../../guides/fallbacks.md).

## Credentials and providers

- **`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`** · secret, `.env` only\
  Claude credential, the models service's alone, which adds it to the sandboxes' API calls (`ANTHROPIC_AUTH_TOKEN`: a gateway's). With several, runs take the gateway's, then the plan's, then the key ([Agents](../../guides/agents.md)).
- **`ANTHROPIC_BASE_URL`** · `anthropic_base_url` · default: `https://api.anthropic.com`\
  Where the models service sends the sandboxes' API calls: a [gateway](../../guides/claude-code.md#through-a-gateway), say.
- **`OPENAI_API_KEY`** · secret, `.env` only\
  Codex's OpenAI API key, the models service's alone, which adds it to the sandboxes' API calls.
- **`CODEX_AUTH_FILE`** · `.env` only\
  Or a ChatGPT plan's login: its `auth.json`, held and refreshed by the models service. Default: `/data/credentials/codex-auth.json` when it exists (see [The credentials folder](../../guides/agents.md#the-credentials-folder)); a file elsewhere must be readable there.
- **`OPENAI_BASE_URL`** · `openai_base_url` · default: `https://api.openai.com/v1`\
  Where the models service sends Codex's API calls.
- **`GEMINI_API_KEY`** · secret, `.env` only\
  The Antigravity CLI's Gemini API key, the models service's alone, which adds it to the sandboxes' API calls.
- **`AGY_AUTH_FILE`** · `.env` only\
  Or a Google AI plan's login: its token file, held and refreshed by the models service. Default: `/data/credentials/agy-auth.json` when it exists (see [The credentials folder](../../guides/agents.md#the-credentials-folder)); a file elsewhere must be readable there.
- **`GEMINI_BASE_URL`** · `gemini_base_url` · default: `https://generativelanguage.googleapis.com`\
  Where the models service sends the Antigravity CLI's API calls when using `GEMINI_API_KEY`.
- **`OPENROUTER_API_KEY`** · secret, `.env` only\
  OpenRouter key of `claude@openrouter`, added by the models service to those runs' API calls.
- **`OPENROUTER_BASE_URL`** · `openrouter_base_url` · default: `https://openrouter.ai/api`\
  Where the models service sends the API calls of `claude@openrouter` runs.

## Agents, models and efforts

- **`SANDBOX_AGENT`, `BRAINSTORM_AGENT`** · `sandbox_agent`, `brainstorm_agent` · default: `claude`, `SANDBOX_AGENT`\
  The agent of work runs, and of brainstorms, inbox entries and discussions: `claude`, `codex` (see [Codex](../../guides/codex.md)) or `antigravity` (see [Antigravity CLI](../../guides/antigravity.md)).
- **`SANDBOX_MODEL`, `SANDBOX_EFFORT`** · `sandbox_model`, `sandbox_effort` · default: `best`, `medium`\
  Defaults; a comment's `/model` and `/effort` lines override them ([Models and efforts](../../guides/agents.md#models-and-efforts)).
- **`BRAINSTORM_MODEL`, `BRAINSTORM_EFFORT`** · `brainstorm_model`, `brainstorm_effort` · default: `SANDBOX_MODEL`, `SANDBOX_EFFORT`\
  The same for brainstorms, inbox entries and discussions.
- **`SANDBOX_FAST_MODE`** · `sandbox_fast_mode` · default: off\
  `allowed`: `/speed fast` turns on Claude Code's fast mode, which costs more (see [Fast mode](../../guides/claude-code.md#fast-mode)).
- **`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`** · `anthropic_default_opus_model`, `anthropic_default_sonnet_model`, `anthropic_default_haiku_model` · default: Claude Code's\
  The models `opus`, `sonnet` and `haiku` stand for in the sandboxes (a gateway's names).
- **`CODEX_BEST_MODEL`, `CODEX_BALANCED_MODEL`, `CODEX_FAST_MODEL`** · `codex_best_model`, `codex_balanced_model`, `codex_fast_model` · default: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`\
  The models the tiers `best`, `balanced` and `fast` stand for with Codex.
- **`AGY_BEST_MODEL`, `AGY_BALANCED_MODEL`, `AGY_FAST_MODEL`** · `agy_best_model`, `agy_balanced_model`, `agy_fast_model` · default: `gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-3.8-flash-medium`\
  The models the tiers `best`, `balanced` and `fast` stand for with the Antigravity CLI.

## Fallbacks

- **`FALLBACKS`** · `fallbacks` · default: none\
  Where a run goes when its provider fails, in order: `claude@anthropic` (or `:plan`, `:key`), `claude@openrouter`, `codex@openai`, `antigravity@google` (see [Fallbacks](../../guides/fallbacks.md)).
- **`OPENROUTER_OPUS_MODEL`, `OPENROUTER_SONNET_MODEL`, `OPENROUTER_HAIKU_MODEL`** · `openrouter_opus_model`, `openrouter_sonnet_model`, `openrouter_haiku_model` · default: `ANTHROPIC_DEFAULT_*_MODEL`\
  What `opus`, `sonnet` and `haiku` stand for on `claude@openrouter` (OpenRouter's names).
- **`CLAUDE_FALLBACK_MODEL`** · `claude_fallback_model` · default: none\
  Claude Code's own `--fallback-model`, when the run's model is overloaded: a tier or a model's name.

## Versions

- **`CLAUDE_CODE_VERSION`** · `claude_code_version` · default: `2.1.300`\
  Claude Code version the sandboxes install on first use.
- **`CODEX_VERSION`** · `codex_version` · default: `0.162.1`\
  Codex version the sandboxes install on first use.
- **`AGY_VERSION`** · `agy_version` · default: `1.4.0`\
  Antigravity CLI version the sandboxes install on first use.
- **`AGY_SHA256`** · `agy_sha256` · default: `1.4.0`'s\
  Sha256 of the Antigravity CLI's tarballs, `x64:<hex>,arm64:<hex>`: set it whenever you change `AGY_VERSION`, from the release's assets.
