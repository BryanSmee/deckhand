# External runs

A task routed to a user's machine (#594: `claims.mjs`, a `runs-on:<label>` label or a
`/machine` comment) runs there, not in a sandbox: the machine's driver claims it through `/mcp`
(`claim`) and reports on its run (#597). That run is an **external run** of `runs.mjs`, the same
`task.live` as a sandbox run's, its `external` naming the machine (`{ machine, name, owner }`),
so the dashboard, the log, deliveries, `/cancel` and a run's end are a sandbox run's. What
differs is that Deckhand starts nothing: no runner, broker, models service nor github service
state is asked for it (`runs.mjs` skips them for `live.external`).

- **Start**: at the claim (`claims.mjs` `take()`, then `runs.mjs` `startExternal()`): the
  record of any run (mode, its agent, model and effort as the driver reports them, its
  machine's name in `record.machine`, `start` or `continue` as the claim resumes the session),
  its log's first line, the needs-input label off, its comments' 👀 kept; its state written
  before the comments leave the queue (`restart.mjs` `take()`), the claim with them. The claim's
  work names the URL to clone (`GITHUB_URL`'s) and the hosts a sandbox run of the repository
  reaches (`egress.mjs` `operatorHosts()` with its grant, `ctx.grantOf()`), for the driver's
  suggested settings (#599); how the machine says its agent runs (`claim`'s `agentVersion`,
  `sandbox`, `permissionMode`, `suggestedSettings`, `mcp.mjs` `setupOf()`) is the record's
  `setup`, a note in its log and its reply's footer (`footer.mjs` `setupText()`).
- **Log**: `post_events { run, lines, from }` takes the agent's stream-json lines (1000 a
  call, 1 MB at most: edge's and `mcp.mjs`'s limit for a `deckhand:machine` call, 64 KB for the
  other tools), which the agent's `normalize()` reads as a sandbox's output (`externalLines()`):
  redacted, cut at `RUN_LOG_MAX_MB` (the run then ends as failed), its phases and results. `from`
  is how many lines the driver sent before: those Deckhand has are skipped, so a call sent again
  after a lost answer, or after a handover, is taken once; one past them is refused (409). The
  run's state is written before the call answers.
- **Messages**: a comment that reaches the run (its owner's, or Deckhand's own: others' are
  held, #596) goes to its `outbox` as a sandbox's goes to its inbox (`tasks.mjs` `deliver()`,
  the same `liveMessage()`); `next_message { run, from }` waits up to 25 s for those past
  `from`. At each result line, the comments still in their pause go, or the inbox closes:
  `next_message` then says `closed`, and the agent ends with that result as its answer.
- **Needs-input**: `ask { run, question }` ends the run with `question` as its reply, the
  `<!-- needs-input -->` marker added: the reply, label and questions of a sandbox run that
  asks.
- **End**: `finish { run, outcome, reply }` (`ok`, `error`, or `needs-input` as `ask`) posts
  `reply` as the App (its last result line's text without one), then runs `finish()` and
  `cleanUp()` as for a sandbox run: the reactions, a review's fix loop, a CI fix, the reviewers,
  the waits and the queue. An error has no fallback: the machine runs the agent it has. The
  run's end ends its claim (`teardown()`), which the next `heartbeat` no longer lists.
- **Its pull request** (#598, `machine-pulls.mjs` `openPull()`): the machine pushes the issue's
  branch with its owner's own git, never through the git gateway, and names it in
  `finish { branch, sha, ready }` (or `ask`). Before the run ends, the orchestrator checks it is the
  issue's (`issue-<n>-<slug>`), reads its head from the repository itself (`git/ref/heads/…`: a
  fork's isn't there) and compares it with `sha`; then the App finds its open pull request from that
  branch (one of someone else's, or closing another issue, is refused) or opens the draft
  (`Closes #<n>`), and marks it ready with `ready`. A refusal (400, 409) writes nothing, and the run
  goes on. The pull request is the App's, so the review and its fix loop treat it as any of
  Deckhand's own: a fix round is the issue's task, which sticks to the machine. It is recorded with
  `external: <owner>` (`pulls.mjs`), as is any open pull request of the task a machine's claim
  covers (`claims.mjs` `markPull()`: at the claim and at its end, whatever `finish` names), once
  opened or found, before it is marked ready, kept whatever later deliveries say, for the dashboard
  and the policies' `pr.external` (`externalOf()`, which reads the store's `marks`, one per pull
  request: a newer pull request on the task leaves the older one marked, #947); the run's record
  gets the branch, and `lastPushAt` when its head isn't the one the pull request had at the claim
  (its reviewers asked again), its `synchronize` delivery recorded first or not.
- **Interrupted**: `release`, a lease that runs out (no heartbeat for 2 minutes) or the machine
  removed end the run as `interrupted` (`interruptExternal()`): a comment on the issue says so,
  its comments go back first in the queue with their 👀, for that machine's next claim, which
  resumes the session. `/cancel` or **Stop** ends it as `cancelled` at once, the machine told by
  its next heartbeat.
- **Permission requests** (#600): `approve_permission { run, tool_name, input, tool_use_id }`
  (`claims.mjs` `approve()`) asks the run's owner whether its agent may make a tool call
  (`requests.mjs` `askTool()`): a request of the store's `permission-requests`, as a chat's, with
  `kind: "tool"` and the machine's name, its input's line redacted and cut, its timeout
  `CHAT_PERMISSION_TIMEOUT`; shown on the task in `api/state` (`permissions`) and in a comment on
  the issue. The owner answers on the dashboard (`POST /api/permissions/…`) or with a `/allow`,
  `/allow run` or `/deny` comment (`events.mjs` `parseAnswer()`, `tasks.mjs` hands it to
  `requests.mjs` `fromComment()` before anything is queued); a `run` answer allows that tool's
  later calls in the run at once. The call waits 25 s at most (`settled()`), then says `pending`,
  and the driver calls again with the same `tool_use_id`, which finds the same request (on the
  next copy too: it is in the store); each call renews the claim's lease. The run's end denies
  what still waits. No broker: the answer is read by the call.
- **Only its machine**: every run tool names the machine and the claim's run; another login's
  machine, the owner's other machine or another run is refused (404, as an unknown one), a run
  that ends 409 (`claims.mjs` `going()`).
- **Restarts and handovers**: its state is `runs/<id>`, as any run's, with its outbox and whether
  its inbox is open; its claim and lease are in the queue (#596). The next copy restores both
  (`restoreRun()` asks the runner and broker nothing for it), with a fresh lease, and the
  driver's next call finds its run. A run without its claim ends as interrupted; a claim without
  its run (a copy stopped before the run's state was written) gives its comments back to the
  queue.
- **The driver** (`machine/deckhand-machine.mjs`, #599): one file, no dependency, attached to
  each release, which runs on the owner's machine: `login` (edge's OAuth with
  `deckhand:machine`, a loopback redirect), then `run`: `register_machine`, `heartbeat` every
  30 s with the runs it has (one no longer listed is stopped), `claim` within its capacity. A
  claim's run clones or fetches into `<workspace>/<owner>/<repo>/issue-<n>`, writes its settings
  (`settingsFor()`) and runs `claude -p` with stream-json in and out, its lines batched to
  `post_events`, `next_message`'s comments written to its input, its input closed once the
  inbox is; then it pushes the branch with the owner's git (`--force-with-lease` on GitHub's
  copy as fetched; the clone's hooks never run) and calls `finish` with its `branch` and `sha`
  (#598), `ready` when the run ended well without asking. Claude Code's
  `--permission-prompt-tool` is the driver file itself run as a stdio MCP server
  (`permissions`), which asks the driver over the loopback with the run's secret; the driver
  calls `approve_permission` (#600) until it is answered.
- **Versions**: the run tools take a `protocol` (`claims.mjs` `MACHINE_PROTOCOL`, 1, which
  `claim`'s work says). A copy keeps taking the previous one through the update that moves to the
  next (`MACHINE_PROTOCOLS`), as an endpoint sandboxes call is kept through one update; a driver
  that speaks none of them is told to update.
