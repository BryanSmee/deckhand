# How Deckhand's services work together

Deckhand receives the GitHub App's webhooks, runs an agent (Claude Code, Codex or the Antigravity
CLI, see [Agents](agents.md#agents)) in a sandbox container (`sandbox/`) for issue, pull request and
discussion comments, one container and one set of volumes per issue, and posts the agent's final
message back as a comment. Two services share the work: **edge** (`edge/`), the only one the
internet reaches, takes the webhooks, `/setup`, sign-in and the dashboard's files, and passes the
dashboard's API on; **the orchestrator** (`orchestrator/server.mjs`) does the rest: the queue, the
runs' lives, what the dashboard shows. Beside them: the runner service (`runner/`,
[The runner service](each-service.md#the-runner-service)), the only one with the Docker socket,
which runs the sandboxes; the broker (`broker/`), the github service (`github/`), the models service
(`models/`), the policy service (`policy-service/`) and the egress proxy (`proxy/`). This page is
the map, what a comment turns into; the pages beside it follow a run through the rest:

- [How a run ends](runs.md): brainstorms, chats, modes, inboxes and onboarding;
  [Replies, reactions and labels](replies.md); [A run's log](run-logs.md).
- [Around the runs](queue.md): GitHub, the sandbox and the queue around a run, conflicts,
  waiting for other issues, stopping a run; [Reviews](reviews.md);
  [External runs](external-runs.md), on a user's machine.
- [Restarts](restarts.md): what the store keeps so that a copy killed at any moment leaves the
  next one the same, the runs in flight, the run files, missed deliveries.
- [Agents](agents.md): Claude Code, Codex and the Antigravity CLI behind one seam, providers and
  fallbacks.
- [Modules](modules.md): which module does what.

Setup is in the [guides](../guides/install.md) and [Server settings](../reference/settings.md), the per-repo file in [repo-config.md](../repo-config.md),
the security model in [security.md](../security.md), the services and their updates in
[services.md](services.md).

## Edge and the orchestrator

Both run modules of `listener/`, which has no entry point of its own any more.

- **Edge** (`edge/server.mjs`, image `deckhand-edge`): its public server (`edge/http.mjs`:
  `POST /webhook`, its HMAC checked, with the places for unverified bodies of
  `listener/deliveries.mjs`; `/setup`, `listener/setup.mjs`; sign-in and sessions,
  `listener/auth.mjs`; MCP clients' sign-in and `/mcp`, `edge/oauth.mjs`; the dashboard's files,
  `listener/static.mjs`; `/health`), the passing on of the dashboard's API, `/status` and `/mcp`
  (with the client's login and scopes) to the orchestrator (`edge/forward.mjs`) and of the
  screenshots to the broker (`edge/shots.mjs`), its internal port for the orchestrator
  (`edge/internal.mjs`: the `deliveries` stream, the App's public parts, the "From the dashboard by"
  tags, a redeliveries' scan) and the redeliveries' poller (`listener/redeliveries.mjs`). It holds
  the webhook secret, the session key and the OAuth client's, in its own volume (`edge-data`), and
  its store.
- **The orchestrator** (`orchestrator/server.mjs`, image `deckhand-orchestrator`): the other modules
  this page names, but those the runner and github services run. It reads the verified deliveries
  from edge's stream (`listener/http-deliveries.mjs` `deliver()`), answers what edge passes on on its services
  port (`listener/services-http.mjs`, `/edge/…`: the dashboard's API, `/status`, and `/mcp`'s tools,
  `listener/mcp.mjs`) and the proxy's questions on the egress policy's port
  (`egress-http.mjs`, 8082). It holds no secret, keeps the `data` volume (its state, its store: the
  queue, its lease), and is on no run's network: no sandbox calls it.

How a delivery goes from one to the other, the orchestrator's two copies and their handover:
[upgrades.md](upgrades.md#edge-and-the-orchestrator). What each holds and may call:
[Edge](../security/webhooks-and-sign-in.md#edge) and [The orchestrator](../security/services.md#the-orchestrator) in the security model.

## From a comment to a reply

- **On an issue**: `Deckhand` (`TRIGGER`) as the first line starts the work; the other lines
  are extra instructions. Once started, any comment continues the session. The orchestrator
  creates the issue's branch at the base's head and links it to the issue when it has none
  (`listener/linked-branch.mjs`, `TASK_BRANCH`); the sandbox checks it out, or creates it
  when none was linked, and opens the draft pull request (`sandbox/draft-pr.sh`).
- **On its pull request**: any comment, review or review comment continues the same session
  (a pull request whose head branch is in the repository; a fork's is a task of its own).
- **Anywhere**: `/model fast` or `/effort high` lines pick the model or thinking effort for that run
  (defaults: `SANDBOX_MODEL`, `SANDBOX_EFFORT`). A model is a tier, `best`, `balanced` or `fast`,
  that the run's agent maps to one of its models (see [Agents](agents.md#agents)), or a model's own
  name (`sonnet`, `claude-opus-5-5`). `/agent codex` (or `claude@openrouter`) picks the agent, and
  the issue's later runs stay on it; see
  [Picking an agent with `/agent`](agents.md#picking-an-agent-with-agent). `/speed fast` turns on
  Claude Code's fast mode (Opus, faster output, a higher price), `/speed normal` drops it or a
  repo's mode's `speed: fast`: `speedFor()` (`agents/select.mjs`) runs it at normal speed when the
  operator (`SANDBOX_FAST_MODE`) or the repo (`fast_mode: false`) turned it off, the agent has no
  `speeds` with `fast` or the provider isn't its default, and on its `best` tier when the model
  isn't one fast mode takes; the footer says which (`record.speedNote`). The sandbox gets
  `SANDBOX_SPEED`, which `claude.sh` turns into `--settings '{"fastMode": true}'` (see
  [Fast mode](../guides/claude-code.md#fast-mode)). These lines may also follow the trigger on its first line
  (`Deckhand /agent codex /effort high`): `splitTrigger()` moves each to a line of its own, for
  `takeOptions()`, and a value it would refuse (`/effort huge`) makes the line no trigger at all.
  Inbox entries (ideas, bugs, discussions) have no trigger line: `/model`, `/effort`, `/speed` and
  `/agent` may end any of their lines instead (`Do X /effort high`, `entry()`), outside code blocks
  and `>` quotes; a run with a refused value stays text.
- **Later**: `/after #77` (or `/after #77 #80`), with a trigger or `/mode` line, holds the
  comment back; see [Waiting for other issues](queue.md#waiting-for-other-issues).

A comment that arrives while its issue's run is working goes to that run: after the usual pause (so
a burst is one message), the orchestrator writes it to the run's inbox (in the agent's input format,
`TASK_INPUT=stream` in `sandbox/entrypoint.sh`), and the agent sees it after its current tool call;
the run's final message is still the one reply and covers it. `/model`, `/effort`, `/speed` and
`/agent` cannot change a live process: they apply to the next run, and the reply says so. Comments
the run cannot take (a trigger that switches between work and brainstorm, a wrap-up, or one arriving
once the agent's input is closed, or any for an agent that takes no messages mid-run) wait for a
follow-up run. Inbox entries (the ideas and bugs inboxes, from GitHub or the dashboard's New
request) are the exception: each is a run of its own (`entryRun()` in `modes.mjs`), never batched
with the next entry nor delivered to a running one, so each gets its own prompt and reply. A burst
runs one entry after another under the inbox's task. A repo's `fresh` modes and discussions keep the
usual batching.
