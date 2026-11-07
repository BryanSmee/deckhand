# Agents

Three agents, Claude Code (`claude`), Codex (`codex`) and the Antigravity CLI (`antigravity`),
behind a seam that keeps what is each one's own in two files, so another agent is two more files
rather than an `if` across the orchestrator. Which one runs: the repo's mode's `agent`, else the
repo's `agent` (or `brainstorm_agent` for light runs), else the operator's `SANDBOX_AGENT`
(`BRAINSTORM_AGENT`). A repo only picks among the agents the operator configured (`config.agents`:
those it has a credential for, and its defaults), checked when its config is read
(`repo-config.mjs`). `runs.mjs` settles it once the repo's settings are read, at the start of each
run (`resolveEntry()`, `agents/select.mjs`), and keeps it in the run's record:

- **In the sandbox**, `sandbox/agents/<name>.sh`, sourced by `sandbox/entrypoint.sh` for
  `SANDBOX_AGENT` (the orchestrator sets it; `claude` by default). The entrypoint does what every
  agent shares: clone, branch, setup, the instructions (`prompts/sandbox.md` and the
  project's), the follow-up prompts per mode. The script turns that into its CLI's flags and
  files: `agent_check` (installed, on `PATH`), `agent_instructions` (Claude Code:
  `~/.claude/CLAUDE.md`), `agent_mcp` (Playwright), `agent_has_session`, `agent_run` (a new,
  continued or fresh session, its raw output, mid-run messages read from
  `deckhand_messages`) and `agent_interactive`. Its other files are in
  `sandbox/agents/<name>/` (Claude Code: its installer, settings, hooks, progress filter;
  Codex: its installer, hooks, progress filter and `result.jq`, which adds the
  `deckhand.result` line its JSONL lacks; the Antigravity CLI: its installer, through
  `release-install`, which checks the tarball against the sha256 `AGY_SHA256` pins, the
  login refresh the orchestrator runs, hooks, progress filter and `text.jq`, which joins an
  answer's text deltas into one `deckhand.text` line).
  One base image serves every agent: no CLI is in it, each is installed per version into a
  shared volume.
- **In the orchestrator**, `listener/agents/<name>.mjs`, listed in `listener/agents/index.mjs`:
  - `install(config)`: its volume, mount, version and installer (`images.installAgent()`);
  - `env(config, secret, provider)` and `secrets`: its environment, with the run's agent token
    where its credential would be, and the variables redacted from logs and replies;
  - `providers` and `defaultProvider`: where its API calls can go, and the credentials each
    takes (see [Providers and fallbacks](#providers-and-fallbacks));
  - `hosts`: what the egress proxy always lets it reach (`egress.mjs`); `relayed` and
    `blocked`, for an agent whose calls can't be pointed at the broker's host (the Antigravity
    CLI): the hosts the proxy decrypts and hands to the models service (`models/google.mjs`),
    and those it refuses, for its runs only;
  - `session`: the volume (`<sandbox>-claude`, `<sandbox>-codex`, `<sandbox>-antigravity`) and
    path of its sessions,
    which `runner.hasSession()` checks;
  - `takesMessages` and `message(text)`: whether comments reach it mid-run, and as what
    (Codex and the Antigravity CLI take none: they wait for the next run, which resumes its
    session);
  - `models` and `efforts`: the tiers and effort levels, in its own names (Claude Code:
    `best` → `opus`, `balanced` → `sonnet`, `fast` → `haiku`; what those mean is the
    operator's `ANTHROPIC_DEFAULT_*_MODEL`; Codex: the pinned version's catalog, or the
    operator's `CODEX_*_MODEL`; the Antigravity CLI: the plan's models, or `AGY_*_MODEL`), and
    `modelProblem(model)`, a model it can't run (another
    agent's), which stops the run with a reply;
  - `speeds` (optional) and `fastModels`: `["normal", "fast"]` when it has a fast mode
    (Claude Code), and the models it takes (`/opus/i`); without it, `/speed fast` runs at
    normal speed;
  - `normalize(line)`: a line of its output → Deckhand's own events, `started{model}`,
    `text{text}`, `tool{name, detail, id, done}`, `toolOutput{text, error, id}` and
    `result{ok, text, durationMs}`, the last and the first with `fastMode` (`on`,
    `cooldown`, `off`) when the agent says it. `id` (optional) pairs a call with its outputs
    in the dashboard, and means an output will follow: until it does, the call shows as in
    progress. So a call that may end with no output gets none, and pairs by order
    (`agents/common.mjs` `idOf()`); `done` marks one that came whole (Codex's edits and
    searches), never in progress. A call with neither (Antigravity's steps) only shows as in
    progress while it is the log's last line. A line that
    `follow()` cut at `MAX_LINE` no longer parses: `normalizer()`'s `cut(line)` may still
    read whose output it held (`cutOutput()`, the id near the line's start), so its call
    stops running.

The rest of the orchestrator reads only those events: `runs.mjs` the results (the reply, its
duration, needs-input), `runlog.mjs` all of them (the dashboard's entries). Logs keep the
agent's raw lines and each run's first line names its agent (`claude` for logs from before
the seam), so old logs still render. The reply's footer and the orchestrator's messages name the
run's agent (`displayName`).

## Providers and fallbacks

An agent calls a provider: Claude Code `anthropic` (the operator's `ANTHROPIC_BASE_URL`) or
`openrouter`, Codex `openai`, the Antigravity CLI `google` (each agent's `providers` and
`defaultProvider`; `env(config, secret, provider, credential)` gives the variables for one).
Sandboxes always call the broker's host, which the egress proxy sends on to the models service
(#504): the orchestrator keeps each run's provider and credential (`broker.provide()`), the broker
signs them into its tokens (their `agent` claim), and the models service's endpoint
(`models/anthropic.mjs`) forwards to that provider's URL with its credential. The endpoints also
keep the provider's last status for the run (`apiStatus`), and the Anthropic one when a plan's limit
resets, from its 429 (`apiReset`), which the orchestrator reads at the run's end
(`models-service.mjs` `apiOf()`).

A provider can have credentials an entry names (its `credentials`): Claude Code's `anthropic` has
`plan` (`CLAUDE_CODE_OAUTH_TOKEN`) and `key` (`ANTHROPIC_API_KEY`), written `claude@anthropic:key`.
Without a name, a run takes the default credential (`credentialName()`): a gateway's token, then the
plan, already paid for, then the key (`agents/credentials.mjs`). The endpoint holds every credential
set (`named`) and picks the run's, in its header (`Bearer` for the plan, `x-api-key` for the key);
the sandbox gets the run's agent token in that credential's variable, so Claude Code's auth mode
matches. `config.credentials` lists the ones set and which is the default, for `/agent` and for
`resolved()`, which names an entry's credential (`claude@anthropic` → `claude@anthropic:plan`), so
the default isn't tried twice. A run's record keeps the entry's named credential (`credential`, null
for the default: the footer and sticky fallbacks read it) and, for the dashboard, the one it
actually runs on (`auth`: `plan`, `key` or `gateway`, from `authOf()`; null off Anthropic), written
in its log's first line so it survives a restart.

The operator's `FALLBACKS` lists `agent@provider` (or `agent@provider:credential`) entries in order.
When a run ends with an error result, `runs.mjs` asks `providerError()` (`agents/index.mjs`) whether
the provider failed it: the result's text (`API Error: 529`, `unexpected status 429`, overloaded,
rate limit, quota, invalid key) or the endpoint's last status (429, 529, 402, 401, 403, 5xx). If so,
and an entry the run's chain hasn't been on is left (`nextFallback()`, `agents/select.mjs`), no
reply is posted: the run's comments go back in the queue, each carrying a `fallback` marker (the
next entry, the one that failed, why, the entries tried, its last message), so it survives a restart
like any queued comment. The next run takes its entry from the marker (`entryFor()`):

- **The same agent on another provider**, or on another credential of it, continues the
  session, told why (`retryNote()`).
- **Another agent** starts a new session (`TASK_SESSION=new`, which the entrypoint never
  continues an older one for), handed the task, the branches and the last message
  (`handoffMessage()`); the workspace volume is the issue's, with what the first agent left.

The run's record keeps `provider`, `credential` and `fallback`. The reply's footer names the
agent, provider and credential and why it switched; the log's first line says it. Later runs of
the task stick to the entry that took over (`previous.fallback`), as long as it is still in
`FALLBACKS`. A fallback from a plan's credential to another credential of the same agent and
provider (the same session) carries `until`: the reset its 429's
`anthropic-ratelimit-unified-reset` gave (`apiReset`), else Claude Code's "resets 1:10pm
(UTC)" (`resetFrom()`), else 5 hours on. From then, later runs go back to the default entry,
on the plan. A fallback to another agent or provider has none: going back would resume the
session that failed.

## Picking an agent with `/agent`

A comment's `/agent <entry>` line (`codex`, `claude@openrouter`; `takeOptions()`) picks the
run's agent and provider among those the operator configured: `config.agents` on their default
provider, and `FALLBACKS` (`pickable()`, `pickProblem()`; anything else stops the run with a
reply). `entryFor()` gives it a `picked` record, and `nextFallback()` returns nothing for it: a
run picked on purpose ends with its provider's error rather than going elsewhere. Later runs of
the task stick to it (`previous.picked`, `{ sticky: true }`) until another `/agent`, or
`/agent default`, which goes back to the settings' agent. When the pick changes the agent from
the previous run's, the run starts a new session with `handoffMessage()`, as after a fallback,
without a failure to report. Like `/model`, an `/agent` that arrives mid-run applies to the
next run.
