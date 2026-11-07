# Agents and providers

Deckhand runs three agents, Claude Code (`claude`), Codex (`codex`) and the Antigravity CLI
(`antigravity`), from one sandbox image: each installs on first use into a volume of its own.
An agent calls a provider; its calls go through the [models service](services.md#the-models-service), which
adds your credential and forwards them, so none of these needs a host in the grants folder (only GitHub's, which every
run has, and the Antigravity CLI's own, which its runs have).

| Entry | Agent and provider | Credential (`.env`) | The models service calls |
| `claude@anthropic` | Claude Code on Anthropic, or [a gateway](claude-code.md#through-a-gateway) | `CLAUDE_CODE_OAUTH_TOKEN` (a plan's), `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL` (`api.anthropic.com`) |
| `claude@openrouter` | Claude Code through OpenRouter, as a [fallback](fallbacks.md) | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` (`openrouter.ai`) |
| `codex@openai` | [Codex](codex.md) on OpenAI | `OPENAI_API_KEY`, or `CODEX_AUTH_FILE` (a ChatGPT plan's login) | `OPENAI_BASE_URL` (`api.openai.com`), or ChatGPT's Codex backend with a plan |
| `antigravity@google` | [Antigravity CLI](antigravity.md) on Google | `GEMINI_API_KEY`, or `AGY_AUTH_FILE` (a Google AI Pro/Ultra plan's login) | `GEMINI_BASE_URL` (`generativelanguage.googleapis.com`), or `daily-cloudcode-pa.googleapis.com` and `www.googleapis.com` (handed over by the egress proxy) with a plan |

With several Claude credentials set, runs take `ANTHROPIC_AUTH_TOKEN` (a gateway's) first,
then a plan's `CLAUDE_CODE_OAUTH_TOKEN`, already paid for, then `ANTHROPIC_API_KEY`, billed
per token. An entry can name the credential it runs on: `claude@anthropic:plan`
(`CLAUDE_CODE_OAUTH_TOKEN`) or `claude@anthropic:key` (`ANTHROPIC_API_KEY`), for a
[fallback](fallbacks.md) from the plan to the key, or a comment's `/agent claude@anthropic:key`.
`claude@anthropic` alone is the default credential.

## Which credential a run used

**Which credential a run used:** the dashboard tags each Claude run on `anthropic` by its
model, in the run's outcome (and on a discussion's page): "Plan" (`CLAUDE_CODE_OAUTH_TOKEN`),
"API key" (`ANTHROPIC_API_KEY`) or "Gateway" (`ANTHROPIC_AUTH_TOKEN`), whether the run named
it or took the default. Settings › Server says which Claude credentials are set and which one
runs use first: "Plan first, then API key as fallback" when `FALLBACKS` names
`claude@anthropic:key`, "Plan · API key also set" when only `/agent` can pick it. The reply's footer names the
credential only when the entry names one, or after a fallback.

## What runs an issue

What runs an issue, first match wins:

1. A comment's `/agent <entry>` line (`/agent codex`, `/agent claude@openrouter`; an agent
   alone is on its default provider, `/agent claude@anthropic:key` on that credential), among
   the agents you have a credential for, the credentials you set (unless a gateway's token
   is the default), and the entries of `FALLBACKS`. Anything else gets a reply naming what is configured, and nothing
   runs. A picked agent doesn't fall back: when its provider fails, the run ends with the
   error. The issue's later runs stay with it until another `/agent`; `/agent default` goes
   back to the next rule. When it changes the agent, the new one starts a session of its own,
   handed the branch and the previous agent's last message.
2. The [fallback](fallbacks.md) a run whose provider failed went to, and later runs of the issue.
3. The repository's `agent` (per mode, or `brainstorm_agent`: [Per-repo config](../repo-config.md#agent)),
   among the agents you configured.
4. Your `SANDBOX_AGENT` (`BRAINSTORM_AGENT` for light runs), `claude` by default.

## Models and efforts

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

## The credentials folder

The plans' logins (see [With a ChatGPT plan](codex.md#with-a-chatgpt-plan) and
[With a Google AI plan](antigravity.md#with-a-google-ai-plan)) can't go in the server folder: they are
account-wide credentials, and would end up in git. They have a folder of their own, which
`compose.yaml` mounts read only at `/data/credentials` in the models service alone:
`./credentials` by default (`DECKHAND_CREDENTIALS_DIR` in `.env` to move it). Keep it out of git
(this repository's `.gitignore` does) and readable by the models service alone, which runs as the
`node` user (uid 1000), not root. Create it before the models service starts, or Docker creates
it empty and owned by root, where the service can't read it:

```sh
mkdir -m 700 credentials && sudo chown 1000 credentials
# each login you put there: owned by uid 1000 too, mode 600
```

```
credentials/              # → /data/credentials, read only, in the models service
  codex-auth.json         # a ChatGPT plan's login, for Codex
  agy-auth.json           # a Google AI plan's login, for the Antigravity CLI
```

A file there, under its name, turns that login on at start: no setting needed.
`CODEX_AUTH_FILE` or `AGY_AUTH_FILE`, when set, points at another file instead, which the models
service must be able to read. The models service never writes it: each refresh's new tokens go
in its store, sealed with a key of its own (see [The models service](services.md#the-models-service)), and
it uses them until the file changes. To sign in again, replace the file: the next call takes the
new login. Only the models service mounts the folder.

## Plan usage

With a plan (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_FILE`, `AGY_AUTH_FILE`), the dashboard shows
how much of it the runs have used: a thin bar per limit window (a Claude plan's 5-hour and
weekly limits, a ChatGPT plan's, the Antigravity CLI's per model), at the right of the page
header on a wide screen, each plan's most used window in the phone's top bar, and all of them,
with their resets, in the phone's repositories sheet and Settings › Server. A bar turns orange
from 75 %, red at 100 % or while the plan's limit is reached (a 429, until its reset), and
hatched when it was read before its window reset (its number no longer holds). Nothing shows
without a plan, nor before the first reading.

The numbers come from the models service, which holds the plans (`models/usage.mjs`):

- **From the runs' own calls**, at no cost: the rate limit headers of the plan's answers
  (`anthropic-ratelimit-unified-*` for Claude, `x-codex-primary-*` and `x-codex-secondary-*`
  for Codex). Only the plan's: runs on an API key, a gateway or OpenRouter change nothing.
- **By asking the plan, while a dashboard is open**: ChatGPT's and the Antigravity CLI's quota
  calls (the only source for the Antigravity CLI, whose answers carry none), each plan at most
  every 5 minutes, and only when no run read it lately. These calls aren't documented and may
  change: one that fails is only logged in the models service's log, the bars keep their last
  reading, and it is asked again 30 minutes later. A ChatGPT login due for a refresh (it lasts
  days) isn't polled: an idle dashboard never spends its refresh token; the next run's call
  refreshes it. The Antigravity CLI's quota call is its plan's only reading and its login lasts
  an hour, so while a dashboard is open its poll refreshes the login when due (a short `agy`
  container, as a run's refresh), at most once an hour.
- **Claude's plan is read from the runs' calls alone** with a `claude setup-token` token: its
  OAuth usage call needs the `user:profile` scope, which such a token doesn't have. The models
  service tries it once, logs `Claude's usage call refused (… user:profile …): not asked again`,
  and doesn't ask again until it restarts. So the Claude bars show the 5-hour and weekly
  limits, not the weekly limits per model that only that call gives.

So the bars stay as they were while no run uses the plan and no dashboard is open: a reading
older than 15 minutes says when it was taken. Only percentages and times reach the dashboard,
nothing of the credential.
