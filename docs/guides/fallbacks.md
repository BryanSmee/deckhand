# Fallbacks

When the model's API fails, a run can go on elsewhere instead of ending with "Claude stopped
with an error". List where, in order, as `agent@provider` (`agent` alone is its default
provider), or `agent@provider:credential` for one of the provider's credentials:

| Entry | What | Needs |
| `claude@anthropic` | Claude Code on your `ANTHROPIC_BASE_URL` (Anthropic, unless a gateway) | a Claude credential |
| `claude@anthropic:plan` | The same, on your Claude plan | `CLAUDE_CODE_OAUTH_TOKEN` |
| `claude@anthropic:key` | The same, on your Anthropic API key | `ANTHROPIC_API_KEY` |
| `claude@openrouter` | Claude Code through OpenRouter, at `OPENROUTER_BASE_URL` | `OPENROUTER_API_KEY` |
| `codex@openai` | Codex on your `OPENAI_BASE_URL` (OpenAI), or on a ChatGPT plan | `OPENAI_API_KEY` or `CODEX_AUTH_FILE` |
| `antigravity@google` | The Antigravity CLI on your `GEMINI_BASE_URL` (Google), or on a Google AI plan | `GEMINI_API_KEY` or `AGY_AUTH_FILE` |

In `.env`, the credentials, and in `config.yaml`:

```yaml
fallbacks: [claude@openrouter, codex@openai]
# OpenRouter's names for what opus, sonnet and haiku mean there.
openrouter_opus_model: anthropic/claude-opus-4.1
openrouter_sonnet_model: anthropic/claude-sonnet-4.5
openrouter_haiku_model: anthropic/claude-haiku-4.5
```

A plan first, then its API key, then OpenRouter:

```yaml
# .env: CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY, both. Runs start on the plan.
fallbacks: [claude@anthropic:key, claude@openrouter]
```

An entry without its credential (`claude@anthropic:key` without `ANTHROPIC_API_KEY`), or a
credential Deckhand doesn't have, stops the orchestrator at start. Without `FALLBACKS`, nothing
changes: a run whose provider fails ends with an error, as before.

## Which errors count

**Which errors count:** only the provider's. The run's agent ended with an error that says
overloaded (529), rate limited (429), a usage limit or quota reached (402, a plan's limit, no
credit left), invalid or expired credentials (401, 403), or a server error (5xx), in its
message or as the last answer Deckhand got from the provider. A failing test, a task the
agent gave up on, Deckhand's own refusal (its egress proxy's, or the models service's for the
run's token: another credential wouldn't get past it either) or any other error ends the run as
before. A plan's usage limit
counts: with a Claude plan first and its API key (`claude@anthropic:key`) or OpenRouter after
it, runs go on, paid per token, only on the entries you list.

## What happens

**What happens:** the run's comments are queued again for the first entry the run hasn't
been on yet, each entry at most once (the run's own included, wherever it is in the list:
`claude@anthropic` is the same as `claude@anthropic:plan` when the plan is the default). The
same agent on another provider, or on another credential of it, continues its session. Another agent starts a new session,
handed the task, the branch and the previous agent's last message; it works in the same clone,
so it sees what was left uncommitted. The run's log on the dashboard says where it switched
and why, and the reply's footer names the agent and provider that answered:
`🤖 Codex (openai) gpt-6-astra · medium effort · 3 min · fell back from Claude (anthropic): overloaded (529)`,
`🤖 Claude (anthropic, API key) opus · high effort · 3 min · fell back from Claude (anthropic, plan): quota reached`.
When no entry is left, the run ends with the error.

## Later runs

**Later runs** of the issue stay on the entry that took over, as long as it is in `FALLBACKS`:
switching back would continue the session of the agent that failed, without what the other
one did. A fallback from a plan to its API key (`claude@anthropic` on the plan, or `:plan`,
then `claude@anthropic:key`) is the exception: the same session goes on either way, so later
runs stay on the key only until the plan's limit resets, then go back to the plan. The reset
is the one Anthropic's rate limit headers give, else Claude Code's message ("You've hit your
session limit · resets 1:10pm (UTC)"), else 5 hours later, a plan's usage window. A fallback
from the plan to another provider or agent sticks like any other.

A model's own name (`/model claude-opus-5-5`) may mean nothing on another provider: use
tiers (`best`) with fallbacks. A Claude model on a run that falls back to Codex runs Codex's
login (`UNAUTHENTICATED`, `PERMISSION_DENIED`) count as the
login (`UNAUTHENTICATED`, `PERMISSION_DENIED`, "Eligibility check failed") count as the
provider's errors.

## Claude Code's own fallback

Claude Code also has a fallback of its own, within one provider: `CLAUDE_FALLBACK_MODEL`
(`claude_fallback_model: sonnet`) is the model it switches to when the run's model is
overloaded, before its provider counts as failed.
