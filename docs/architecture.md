# How the listener works

The listener (`listener/`) receives the GitHub App's webhooks, runs an agent (Claude Code, Codex or the Antigravity CLI, see
[Agents](#agents)) in a sandbox container (`sandbox/`) for issue, pull request and discussion
comments, one container and one set of volumes per issue, and posts the agent's final message
back as a comment. This page is
the map: what a comment turns into, and which module does what. Setup is in
[setup.md](setup.md), the per-repo file in [repo-config.md](repo-config.md), the security
model in [security.md](security.md).

## From a comment to a reply

- **On an issue**: `Deckhand` (`TRIGGER`) as the first line starts the work; the other lines
  are extra instructions. Once started, any comment continues the session. The sandbox opens
  the branch and draft pull request (`sandbox/draft-pr.sh`).
- **On its pull request**: any comment, review or review comment continues the same session
  (a pull request whose head branch is in the repository; a fork's is a task of its own).
- **Anywhere**: `/model fast` or `/effort high` lines pick the model or thinking effort for
  that run (defaults: `SANDBOX_MODEL`, `SANDBOX_EFFORT`). A model is a tier, `best`,
  `balanced` or `fast`, that the run's agent maps to one of its models (see [Agents](#agents)),
  or a model's own name (`sonnet`, `claude-opus-5-5`). `/agent codex` (or
  `claude@openrouter`) picks the agent, and the issue's later runs stay on it; see
  [Picking an agent with `/agent`](#picking-an-agent-with-agent). These lines may also follow
  the trigger on its first line (`Deckhand /agent codex /effort high`): `splitTrigger()` moves
  each to a line of its own, for `takeOptions()`, and a value it would refuse (`/effort huge`)
  makes the line no trigger at all. Inbox entries (ideas, bugs, discussions) have no trigger
  line: `/model`, `/effort` and `/agent` may end any of their lines instead (`Do X /effort
high`, `entry()`), and a run with a refused value stays text.
- **Later**: `/after #77` (or `/after #77 #80`), with a trigger or `/mode` line, holds the
  comment back; see [Waiting for other issues](#waiting-for-other-issues).

A comment that arrives while its issue's run is working goes to that run: after the usual
pause (so a burst is one message), the listener writes it to the run's inbox (in the agent's
input format, `TASK_INPUT=stream` in `sandbox/entrypoint.sh`), and the agent sees it after its
current tool call; the run's final message is still the one reply and covers it. `/model`,
`/effort` and `/agent` cannot change a live process: they apply to the next run, and the reply says so.
Comments the run cannot take (a trigger that switches between work and brainstorm, a wrap-up,
or one arriving once the agent's input is closed, or any for an agent that takes no messages
mid-run) wait for a follow-up run.
Inbox entries (the ideas and bugs inboxes, from GitHub or the dashboard's Feedback form) are
the exception: each is a run of its own (`entryRun()` in `modes.mjs`), never batched with the
next entry nor delivered to a running one, so each gets its own prompt and reply. A burst runs
one entry after another under the inbox's task. A repo's `fresh` modes and discussions keep
the usual batching.

## How a run ends

At each result the agent gives, the comments waiting for it go to its inbox, or the inbox
closes and the agent exits: its last result is the reply, posted once its sandbox exits
(`follow()`, `finish()`). Headless Claude Code runs with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`
(`sandbox/agents/claude.sh`), and the prompt tells the agent to wait for its work in the
foreground: an agent that ends its turn with background work left gives an early result, and
may go on with a turn per background task, or never exit. As a safety net, a result with the
inbox closed marks the run `answered` (saved state) and starts a 2-minute timer
(`runs.mjs` `linger()`, `ANSWER_GRACE_MS`); any output restarts it, and a listener that
restarts starts it again. If the sandbox is still running, silent, when it fires, the listener
writes an `ended` line to the run's log ("Stopped at … after its answer" on the dashboard),
stops the sandbox and ends the run as usual, with its last result as the reply.

### Brainstorms

`Deckhand` then `/mode brainstorm` (or `Deckhand /mode brainstorm` on one line) starts a
brainstorm instead: Claude discusses the issue (`prompts/brainstorm.md`) without writing
code, and each later comment on the issue is the next message of that conversation. A
brainstorm run starts light (`SANDBOX_LIGHT`) after a short pause (`BRAINSTORM_DEBOUNCE_MS`)
and goes before queued work. `/stop` ends it: Claude posts a summary and updates the issue's
description (settled questions in a Decisions section, Open questions keeping what is left),
then comments no longer reach it until a trigger line. After
`BRAINSTORM_IDLE_MINUTES` (10) without a comment it shows as idle; a comment then restores it
from the issue's session volume. `Deckhand` or `/mode work` afterwards implements in a session
of its own, which starts from the issue: the brainstorm's comments and the description its
wrap-up updated. Light runs (brainstorms, onboarding, the repo's light modes) never share a
writable volume with the issue's work runs: they have their own clone and session
(`<name>-light-workspace`, `<name>-light-claude`), no caches, and host mounts read-only, so
nothing they leave behind (git hooks, Claude settings) runs with a work run's token. Issues
only.

### Modes

A `/mode <name>` line picks a mode: work, brainstorm or one of the repo's own (its config's
`modes:`), with the trigger line, or alone on an issue that has a session, which then goes on
in the new mode with its conversation so far. A repo's mode brings its own instructions,
model and effort; a light one runs like a brainstorm and only comments (its token only
reads), a fresh one starts a new session each time. Comments without a trigger or `/mode`
line go on in the issue's current mode (`modes.json`).

`/mode research` (repos granted `allow_research`) is a built-in light mode for the open web
(`OPEN` in `modes.mjs`): any public host (`researchAccess()` in `access.mjs`), and nothing of
the repo's. No clone (`SANDBOX_NO_CLONE`), no token (the broker's `NO_TOKEN`), the base
image, no setup, caches, mounts, engine, CA or screenshots, and volumes of its own
(`<name>-research-…`). Its input is the issue's thread, which `preparation.mjs`
(`threadDigest()`) writes into the run's inbox like an analysis's digest; its output, its
reply (`prompts/research.md`).

### Inboxes and discussions

A repo's config may name an ideas issue, a bugs issue and a discussions category. Every
comment on those issues is an entry, answered in a fresh session (`prompts/idea.md`,
`prompts/bug.md`); each discussion in the category is a conversation of its own, like a
brainstorm (`prompts/discussion.md`). No trigger line there.

### Onboarding

Installing the App on a repo without a `.deckhand.yaml` (an `installation` or
`installation_repositories` delivery, sent to every App) opens an onboarding issue there and
starts the `onboarding` mode on it: a light conversation like a brainstorm, with a read-only
token, where Claude proposes the file (`prompts/onboarding.md`). Comments go on in it; the
trigger line or `/mode work` opens the pull request, and the reply says what the listener
makes of the branch's config. `/mode onboarding` starts it on any issue.

### Replies, reactions and labels

A run that stops to ask (its final message starts with `<!-- needs-input -->`, see
`prompts/sandbox.md`) shows as `needs-input` on the dashboard and labels the issue or pull
request `NEEDS_INPUT_LABEL` (default `needs-input`) until the next run starts.

An issue can wait for answers without a run stopping to ask: inbox runs file issues with an
**Open questions** section, and people write some by hand. When an allowed user or the App's
bot opens an issue whose `## Open questions` section asks something (its first paragraph isn't
"None"), the listener labels it. So settled questions don't stay there: a brainstorm's wrap-up
moves them, with their answers, to a **Decisions** section and leaves "None" alone when nothing
is left (`prompts/brainstorm.md`). An edit to Open questions adds or removes the label as it now
reads. An allowed user's comment on a labelled issue or pull request takes the label off: they
answered. The dashboard lists the open issues carrying the label as `needs-input`, with a run
or not (`inputs.json`, kept by `issues` deliveries, whoever adds or removes the label, and one
lookup per repo when the listener starts); a closed issue leaves the list.

The graph's backlog read (`work.mjs`, at most once per 30 seconds a repo, or after an
`issues` delivery) catches what those
missed: an App without the `issues` event, or a label call that failed. An open issue of an
allowed user or the App's bot, with no task on the dashboard, whose body has open questions
but which isn't listed gets the label and the list, as an `issues opened` delivery would have
given it, unless its timeline shows the label was taken off once (answered, by hand or by a
run starting): that issue is left alone, and remembered until the listener restarts. At each
start the listener also reads the App's settings (`GET /app`) and logs a warning naming any
event of `APP_EVENTS` it isn't subscribed to.

With the repo's `wait_for_answers` (on by default, `docs/repo-config.md`), the label holds
work back. `tasks.mjs` `admit()` reads it from the comment's payload: a trigger comment with
no text besides its command lines (`saysMore()`), asking for work or a non-light mode of the
repo, on an issue labelled for its body's questions (and whose last run didn't stop to ask),
starts nothing; the App replies how to answer and swaps its 👀 for the needs-input reaction.
`applyInput()` (`questions.mjs`) leaves the label on for that comment, and light runs don't take it
off when they start. A comment that waited (`/after`) asks GitHub for the issue's labels
before it starts (`resume()`): still labelled, its wait stays with no issues left and
`answers: true`, shown as `needs-input`, until an `unlabeled` delivery or the periodic check
starts it (`waits.mjs` `answered()`). The dashboard's `act()` refuses Start and Queue without
the answers (`409`) only then, and `api/state` carries `waitForAnswers` with a task's
questions so the graph doesn't open the form when it is off.

The questions themselves have one format, set once in `prompts/sandbox.md` (the other prompts
point to it): numbered, an optional `**Title**:`, options as an indented task list with one
`(recommended)`. `parseQuestions()` (`questions.mjs`) reads them, all or nothing: a section in
another shape comes as its markdown only (`items: null`). A task waiting for input carries
them in `api/state` (`questions`): from the reply of its last run when that run stopped to ask
(kept on the run, and read again from its log after a restart), else from its issue's body
(kept in `inputs.json` with the entry, from the `issues` deliveries and the startup lookup).

The dashboard answers them too (`work.mjs` `answer`, `answers.mjs`): a task waiting for input
shows its questions as a form (one option per question, the recommended one ticked in
advance, and a note), or as written
with one text box when they aren't in the set format. Sending checks what the work area does
(signed in, same origin, the user allowed by the operator and the repo) and posts one App
comment, "Answers from @user, from the dashboard:", that lists every answer under its
question and which ones are still open. A run's questions: that comment is queued as the
reply that continues its session, as an allowed user's would be. An issue's: App comments
don't take the label off, so the listener does, once every question has an answer; nothing
starts until a trigger comment or the work area says so.

On the graph, an issue waiting for answers moves like a waiting one, but its questions come
first: dragging it (or its Start and "After…" buttons) opens them, and the start or queue goes
only once every one has an answer, in one App comment that carries both (`then` on the answer
request). The run that starts reads them. Started or queued without answers, it is refused.

A task whose last run ended in `error`, `interrupted` or `cancelled` shows a **Rerun** button
on its page (`rerunnable` in `api/state`, from `board.mjs`): work on an issue or pull request, in work or
one of the repo's own modes, not brainstorms, discussions or inbox entries. Each run keeps the
comments it ran on (their text, trigger and mode lines) in its log's first line, so a run lost
in a restart can run again too. `POST /api/repos/<owner>/<repo>/rerun { runId }` (`work.mjs`
`rerun`) checks what the work area does, refuses a run that isn't the task's latest or didn't
fail, posts an App comment ("Rerun from the dashboard by @user") where the run replied, and
queues those comments again in the run's mode, with that comment for the reactions. The
issue's session volume carries what the run had done.

The dashboard's top bar (Feedback) sends ideas and bug reports to a repo's inbox:
`POST /api/repos/<owner>/<repo>/inbox { kind: "idea" | "bug", text }` (`work.mjs`
`sendToInbox`) posts the text on the inbox issue as the App's comment ("From the dashboard by
@user", without the marker: it is an entry, not a reply), then queues the item a comment there
would (`events.mjs` `inboxItem()`), with the signed-in user as its author. `api/state`'s
`inboxes` says which inbox issues and discussions category each repo read so far has, so the
form offers only those repos and inboxes.

The same form starts discussions, and a discussion task's page shows its thread
(`discussions.mjs`): `POST /api/repos/<owner>/<repo>/discussions { title, body }` creates the
discussion in the repo's category as the App (GraphQL `createDiscussion`, the category found
among `discussionCategories` with `normalize()`), `POST …/discussions/<n>/comments { text,
replyTo? }` adds the App's comment, in `replyTo`'s thread when given, and
`GET …/discussions/<n>` reads the thread (at most once every 15 seconds per discussion). Each
post ends "From the dashboard by @user"; the run is the item a webhook would have made of a
discussion or comment of that user (`events.mjs` `discussionEntryItem()`), queued with
`accept()`, so a comment sent mid-run reaches the running session. Only discussions in the
repo's category are read or written; the thread shows the App's posts with that line as the
user's, and those with the marker as Deckhand's answers.

**Analyze**, also in the top bar, starts a run that reads a selection of a repository's past
runs and replies with what would make sessions faster or more reliable (`analysis.mjs`). The
form picks the repository (those `api/state` shows the user), how many recent runs (10 by
default, 50 at most), their kinds (`taskMode`: work, brainstorm, idea, bug, discussion, the
repo's own modes…) and outcomes (ok, error, needs-input, interrupted, cancelled). As the
selection changes, `GET /api/repos/<owner>/<repo>/analyze?count=&kinds=&outcomes=` says how
many finished runs of that repository match, and about how many tokens their digest is
(its size ÷ 4); the form warns that the run uses the operator's Claude budget. `POST` (the
same path, `{ count, kinds, outcomes }`, `analysis.mjs` `startAnalysis()`) refuses an empty
selection, a count over 50, or a selection no run matches, with the checks of the inbox's
form. It creates an issue "Run analysis: last N runs (…)", labelled `analysis` (created if
missing), listing the selection and the run ids, then queues an item with the `analyze`
trigger on it, as the user's, carrying those ids. No comment can ask for that mode.

`analyze` is a built-in light mode (`modes.mjs`): no branch, no setup, a fresh session, the
model of light runs (`brainstorm_model`), and a token that only reads, so the reply is the
report and the issue stays as its record. When the run starts (`preparation.mjs`
`analysisDigest()`), the listener builds the digest of the runs picked that are still listed
and of that repository: for each, its meta line (kind, agent, model, effort, status,
duration), the listener's notes, setup output that looks wrong (errors, refused hosts), its
tool calls (counts per tool, calls made three times or more, failed ones with their clipped
output) and its final reply, from `format()`'s entries. Each run's part is cut at 24 KB and
the whole at 400 KB, the newest runs first: the older ones beyond the cap are left out and
the digest's header names them. It is redacted, written into the run's inbox folder as
`digest.md` (`TASK_DIGEST`, read-only, like the egress CA), and gone with the run. Agent logs
carry no per-line timestamps, so the digest can't show gaps between steps: the run's
duration and agent time say how long it took. The prompt (`prompts/analyze.md`) asks for
findings ranked by impact, each citing run ids, with a concrete change: a `.deckhand.yaml`
line, a Dockerfile step, a host for the operator to grant, a rule for `AGENTS.md`.

Its cost is the run's: it reads up to ~100,000 tokens of digest (the 400 KB cap) on top of
the repository it looks at, on the light runs' model. Previews cost nothing: they read logs
on the listener, and keep each run's part in memory once built (a finished run's log no
longer changes).

Reactions on the triggering comment follow its run: 👀 when it is received, then 🚀 (done),
😕 (needs input) or 👎 (error) once the run that handled it is over.

## Around the runs

- **GitHub**: the operator's private App, created at `/setup` and stored in the data volume.
  The listener calls GitHub with installation tokens; sandboxes get none up front and ask the
  broker (`BROKER_PORT`, only on the runs' networks) for a fresh token limited to their
  repo, with a secret that dies with the run. Those tokens only read the code: pushes go
  through the git gateway on the same port, which only lets through the run's own branches,
  and `gh pr ready [--undo]` asks the listener on that port to mark the run's pull request
  ready for review (or back to draft), which their tokens can't. Both only take work runs:
  light runs can't push or change a pull request.
- **Dashboard**: `GET /` shows every repo's issues and pull requests, their state and live
  logs, to `ALLOWED_USERS` signed in with GitHub through the App, built from `dashboard/`.
  `GET /status` says what is going on, to them and to calls from inside the container.
- **Screenshots**: `GET /shots/<token>/<file>` serves the screenshots runs save for their
  pull requests: GitHub cannot take image uploads through its API, so they need a public URL.
- **Per-repo config**: each repo may bring a `.deckhand.yaml` on its default branch: its own
  trigger word, models, parallel cap and users (only narrowing the operator's), a setup
  command and extra instructions for the sandbox, a Dockerfile `FROM` the base image, cache
  volumes, a container engine for its work runs, and a preview hook run on `pull_request`
  and `workflow_run` deliveries (the Dockerfile, the engine and the hook only with the
  operator's grant, `grants.mjs`). A config with
  errors stops runs, and the reply says why.
- **Isolation**: sandboxes run with no capabilities, `no-new-privileges` and CPU, memory and
  pids limits, each on an internal network of its own (created with the run, checked, and
  removed with it), shared only with the listener and the egress proxy (`proxy/proxy.mjs`),
  its only way out: the proxy asks the broker's port, for each connection, whether the
  sandbox at that address may reach that host. Sandboxes can't reach each other. Host mounts only happen under roots the
  operator grants the repo (`GRANTS_DIR`, one file per repo).
- **Container engine**: a work run of a repo granted `allow_docker` (with `docker` in its
  config and the operator's `SANDBOX_ENGINE`) gets a second container on its network,
  `engine` (`runner/engine.mjs`: dockerd under Sysbox, or rootless Podman), started before
  the sandbox and removed with it; the sandbox's `docker` CLI talks to it (`DOCKER_HOST`),
  and its address counts as the sandbox's for the egress proxy. Never for light runs or a
  fork's pull request.
- **Who may run**: only comments from `ALLOWED_USERS`, on repos where the App is installed
  (narrowed by `ALLOWED_REPOS` if set), are acted on: the sandbox runs without permission
  prompts and can push.

## Conflicts

The `pull_request` webhook doesn't fire when a base branch moves, so `conflicts.mjs` polls.
Every minute it takes the open pull requests `pulls.mjs` knows as tasks', in the repos whose
`.deckhand.yaml` sets `conflicts.check_minutes` (never more often than
`CONFLICT_CHECK_MINUTES`; `0` stops it), and asks GitHub whether each still merges. One in
conflict, whose task has no run going or queued and no needs-input label, gets a work item as
if from a comment (`trigger: "work"`, no comment, no sender, `reason: "conflict"`), queued in
its task's session through `tasks.accept()`. The `(head, base)` commits of each attempt are
kept in `conflicts.json`, so the same pair never starts a second run, even after a restart.

## Reviews

A repo whose `.deckhand.yaml` has a `review` block gets the built-in `review` mode
(`modes.mjs`: light, fresh, a read-only token). `/mode review` on a pull request starts one;
with `review.on: ready`, `reviews.mjs` also starts one from a `pull_request` delivery
(`ready_for_review`, or `opened` when not a draft) for a pull request on a branch of the repo,
opened by the App or an allowed user. It is a work item as if from a comment (`trigger:
"review"`, no comment, `reason: "review"`), on the task of the issue the pull request closes
or the pull request's own. Each pull request's reviewed head commit is kept in
`reviews.json`, so a redelivery, a restart or the same commit again starts none. The run's
final message follows `prompts/review.md`'s format; `runs.mjs` hands it to `postReview()`,
which posts one GitHub review with the listener's token: findings grouped by severity, the
rating, `REQUEST_CHANGES` on a critical or high finding and `COMMENT` otherwise (never
`APPROVE`), and a comment review with the raw text when the format can't be read.

## Waiting for other issues

`/after #77 #80` (on the trigger line or its own line, same repo only; `events.mjs`
`parseAfter()`) holds a trigger comment back until each of those is done: an issue closed as
completed (or before GitHub recorded reasons), a pull request merged. `waits.mjs` asks GitHub
for their state at once: all done, the comment runs now; one closed without being done (not
planned, a duplicate, a pull request closed unmerged) or missing, it is refused. Otherwise
the comment keeps its 👀, the reply says what it waits for, and the task's one wait (task key
→ the issues left and the comment, as `restart.mjs` saves it) goes to `waits.json`.

An `issues` or `pull_request` `closed` delivery for an allowed repo (`closedItem()`) updates
the waits on it. Any other `issues`, `issue_comment` or `pull_request` delivery about an issue
or pull request waited for, or about the issue a pull request closes (`touchedItems()`), and
the end of a run on one, ask GitHub about that one only (`recheck()`, nothing when no wait is
for it): a pull request merged into the default branch closes its issue without an `issues`
delivery to an App that lacks that event, so its issue is asked about at once, and again 30
seconds later if GitHub hasn't closed it yet (`merged()`). GitHub is also asked about every
wait at each start and every `WAITS_CHECK_MINUTES` (5), so a delivery missed while the
listener was down still counts. When the last one is done, `tasks.resume()`
checks the comment again as `admit()` would (the repo still allowed, its config without
errors, its author still in both allowlists) and queues it through `accept()`, as if just
posted, with its text, `/mode`, `/model` and `/effort`; the reply says which issue made it
start. One closed without being done drops the wait, with a reply saying so. A new trigger or
`/mode` comment without `/after` replaces the wait; `/after` again replaces the list;
`/after none` cancels it. The dashboard shows the task as `waiting`, with what it waits for.

The dashboard's graph does the same by drag and drop (`work.mjs`): on a repo's tab, its open
issues with nothing live (running, queued, waiting, brainstorming, needs input) are a backlog;
one dropped on the graph starts (in the mode picked), dropped next to an issue it waits for
that one; a waiting issue dragged away stops waiting, onto another issue waits for that one
instead. Between the backlog and the graph, a Brainstorm column lists the repo's brainstorms
(active, idle, wrapping up), which leave the graph unless an arrow touches them: a backlog
issue dropped there starts a brainstorm, a brainstorm dropped on the graph starts work (and
ends the brainstorm), dropped back on the backlog it stops (`stop`, what a `/stop` comment
does: the wrap-up run). Each has a button too. The backlog is served from the last read and
read again in the background once it is 30 seconds old or an `issues` delivery made it stale
(only a repo with no read yet waits for GitHub), and the dashboard keeps each repo's last one
in memory, so coming back to the graph or a repo's tab shows it at once. The listener writes
each action on the issue as the App's comment, which reactions follow like a trigger
comment's, and queues the work (`accept()`) or holds it (`waits.hold()`) itself: the App's
own comments never reach `admit()`. The checks are `resume()`'s, see
[security.md](security.md#the-dashboards-actions).

## Stopping a run

`/cancel` (the whole first line of a comment, from an allowed user) or the task page's
**Stop** (`POST /api/repos/<owner>/<repo>/work { action: "cancel", number, pr? }`, with the
work area's checks of the repository and user, and the App's comment "Stopped from the
dashboard by @user") end a run now. `admit()` takes the comment before the queue, so it never
reaches the agent's inbox, and gives it 👍. `runs.mjs` `cancel()` writes a `cancelled` line
(who, when) to the run's log and its saved state, stops its inbox, then
`runner.kill()` (`docker stop -t 10`). The follow loop sees the sandbox exit and `finish()`
ends the run as `cancelled` whatever the exit looked like: a "Stopped by @user" reply with the
usual footer (a run that had `answered` posts that answer, then "Stopped by @user after its
answer"), no fallback, 👀 off its comments, and `cleanUp()` as usual. The session volume
and pushed commits stay, so the next comment resumes it; comments queued for a follow-up run
stay queued. A run still being prepared (its image building) doesn't start its sandbox; a task
with only queued comments loses them instead (409 from the API when there is neither). A
listener restarting between the cancel and the exit reads it from the saved state, stops the
sandbox again if it still runs, and ends it as cancelled rather than queueing its comments
again; the dashboard's list reads it from the log's `cancelled` line. A cancelled run is
`rerunnable`.

## Restarts

The listener can restart at any time (an update is `docker compose pull && up -d`).
Sandboxes run detached, through the runner (`runner/docker.mjs`): on SIGTERM the listener
starts no more runs and saves the comments still waiting for one to `queue.json`; each run's
state is in `logs/<run>.live.json` all along. The next listener reads both, finds the
sandboxes by their labels, follows their output from where the previous one stopped, and
posts each reply once. A recreated container isn't on the networks the old one was joined
to: the new listener joins itself and the egress proxy to the running sandboxes' networks
first (`runner.relink()`), and again every minute, for a proxy recreated on its own; the
networks, container engines and engine volumes of runs that are gone are removed then. Queued comments whose author or repository is no longer allowed are
dropped then; each run checks its comments' authors against the repository's `users` again
when it begins, and so does the next listener for comments queued for a run still going.

The dashboard's run list comes back from the runs' summaries (`logs/<run>.json`, written
when a run ends): a log is read in full only for a run without one (from before summaries, or
a listener that died mid-run), which then gets one. The list is held newest first with an
index by id, and both lose the runs `history.mjs` removes, at start and daily: those older
than `LOG_RETENTION_DAYS`, but for a running run and the latest run of a task still queued,
in a brainstorm, waiting or waiting for input.

## Agents

Three agents, Claude Code (`claude`), Codex (`codex`) and the Antigravity CLI (`antigravity`),
behind a seam that keeps what is each one's own in two files, so another agent is two more files rather than an `if` across the
listener. Which one runs: the repo's mode's `agent`, else the repo's `agent` (or
`brainstorm_agent` for light runs), else the operator's `SANDBOX_AGENT` (`BRAINSTORM_AGENT`).
A repo only picks among the agents the operator configured (`config.agents`: those it has a
credential for, and its defaults), checked when its config is read (`repo-config.mjs`).
`runs.mjs` settles it once the repo's settings are read, at the start of each run
(`resolveEntry()`, `agents/select.mjs`), and keeps it in the run's record:

- **In the sandbox**, `sandbox/agents/<name>.sh`, sourced by `sandbox/entrypoint.sh` for
  `SANDBOX_AGENT` (the listener sets it; `claude` by default). The entrypoint does what every
  agent shares: clone, branch, setup, the instructions (`prompts/sandbox.md` and the
  project's), the follow-up prompts per mode. The script turns that into its CLI's flags and
  files: `agent_check` (installed, on `PATH`), `agent_instructions` (Claude Code:
  `~/.claude/CLAUDE.md`), `agent_mcp` (Playwright), `agent_has_session`, `agent_run` (a new,
  continued or fresh session, its raw output, mid-run messages read from
  `deckhand_messages`) and `agent_interactive`. Its other files are in
  `sandbox/agents/<name>/` (Claude Code: its installer, settings, hooks, progress filter;
  Codex: its installer, hooks, progress filter and `result.jq`, which adds the
  `deckhand.result` line its JSONL lacks; the Antigravity CLI: its installer, through
  `release-install`, which checks the release's digest, the login refresh the listener runs,
  hooks, progress filter and `text.jq`, which joins an answer's text deltas into one
  `deckhand.text` line).
  One base image serves every agent: no CLI is in it, each is installed per version into a
  shared volume.
- **In the listener**, `listener/agents/<name>.mjs`, listed in `listener/agents/index.mjs`:
  - `install(config)`: its volume, mount, version and installer (`images.installAgent()`);
  - `env(config, secret, provider)` and `secrets`: its environment, with the run's secret
    where its credential would be, and the variables redacted from logs and replies;
  - `providers` and `defaultProvider`: where its API calls can go, and the credentials each
    takes (see [Providers and fallbacks](#providers-and-fallbacks));
  - `hosts`: what the egress proxy always lets it reach (`egress.mjs`); `relayed` and
    `blocked`, for an agent whose calls can't be pointed at the listener (the Antigravity
    CLI): the hosts the proxy decrypts and hands to the listener (`google.mjs`), and those it
    refuses, for its runs only;
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
  - `normalize(line)`: a line of its output → Deckhand's own events, `started{model}`,
    `text{text}`, `tool{name, detail}`, `toolOutput{text, error}` and
    `result{ok, text, durationMs}`.

The rest of the listener reads only those events: `runs.mjs` the results (the reply, its
duration, needs-input), `runlog.mjs` all of them (the dashboard's entries). Logs keep the
agent's raw lines and each run's first line names its agent (`claude` for logs from before
the seam), so old logs still render. The reply's footer and the listener's messages name the
run's agent (`displayName`).

### Providers and fallbacks

An agent calls a provider: Claude Code `anthropic` (the operator's `ANTHROPIC_BASE_URL`) or
`openrouter`, Codex `openai`, the Antigravity CLI `google` (each agent's `providers` and `defaultProvider`; `env(config,
secret, provider)` gives the variables for one). Sandboxes always call the listener: the broker
keeps each run's provider (`broker.provide()`), and the listener's endpoint
(`anthropic.mjs`) forwards to that provider's URL with its credential. The endpoints also keep
the provider's last status on the run (`apiStatus`).

The operator's `FALLBACKS` lists `agent@provider` entries in order. When a run ends with an
error result, `runs.mjs` asks `providerError()` (`agents/index.mjs`) whether the provider failed
it: the result's text (`API Error: 529`, `unexpected status 429`, overloaded, rate limit, quota,
invalid key) or the endpoint's last status (429, 529, 402, 401, 403, 5xx). If so, and an entry
the run's chain hasn't been on is left (`nextFallback()`, `agents/select.mjs`), no reply is posted: the run's
comments go back in the queue, each carrying a `fallback` marker (the next entry, the one that
failed, why, the entries tried, its last message), so it survives a restart like any queued
comment. The next run takes its entry from the marker (`entryFor()`):

- **The same agent on another provider** continues the session, told why (`retryNote()`).
- **Another agent** starts a new session (`TASK_SESSION=new`, which the entrypoint never
  continues an older one for), handed the task, the branches and the last message
  (`handoffMessage()`); the workspace volume is the issue's, with what the first agent left.

The run's record keeps `provider` and `fallback`. The reply's footer names the agent and
provider and why it switched; the log's first line says it. Later runs of the task stick to
the entry that took over (`previous.fallback`), as long as it is still in `FALLBACKS`.

### Picking an agent with `/agent`

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

## Modules

`server.mjs` only wires the listener together: its settings, the GitHub App, the shared `ctx`
and the modules, then it starts the servers, restores runs and handles SIGTERM. The stateful
modules are `createX(ctx)` factories sharing one `ctx` object (the settings, the GitHub App,
the tasks, the runs, the services); each reads `ctx` when it is called rather than when it is
created, so a module can call one created after it: a finished run (`runs.mjs`) schedules the
next one (`tasks.mjs`), which starts runs. Others take only what they use, injected, so their
tests fake it.

| Module                                                            | What it does                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.mjs`                                                      | Wiring: settings, the GitHub App, `ctx`, the modules; starts the servers, restores runs, handles SIGTERM.                                                                                                                                            |
| `config.mjs`, `yaml.mjs`                                          | The operator's settings (environment and `config.yaml`), one `SETTINGS` table: each one's type, default and parser; the YAML subset both config files use.                                                                                           |
| `http.mjs`, `deliveries.mjs`                                      | The public server: webhook deliveries, the dashboard and its API, `/status`, screenshots; the places for unverified bodies.                                                                                                                          |
| `broker-http.mjs`                                                 | The broker's server, on the runs' networks: egress answers, tokens, git, ready for review, the agents' API calls.                                                                                                                                    |
| `status.mjs`                                                      | `/status`: running runs, reaction updates in flight (`track()`), preview hooks; whether the listener is idle.                                                                                                                                        |
| `tasks.mjs`                                                       | One queue per issue: admission (`admit()`, `resume()`, open questions), the pause, delivery to a running session.                                                                                                                                    |
| `task-modes.mjs`                                                  | Which mode a queued comment runs in: trigger and `/mode` lines, brainstorms, the issue's current mode.                                                                                                                                               |
| `runs.mjs`                                                        | A run from start to reply: settings and agent (`begin()`), the sandbox, its output, cancel, reply, reactions, label.                                                                                                                                 |
| `preparation.mjs`                                                 | Before a run's sandbox starts: its branches, mode instructions, image, agent, caches, screenshots, egress cache, digest.                                                                                                                             |
| `access.mjs`                                                      | What a run may reach from the operator's grants: hosts, mounts (checked twice), limits, the egress cache, an engine.                                                                                                                                 |
| `sandbox-spec.mjs`                                                | The container a run starts: image, volumes, hardening, environment. Pure.                                                                                                                                                                            |
| `footer.mjs`                                                      | The line under each reply: agent, provider, model, effort, duration, the next step. Pure.                                                                                                                                                            |
| `restart.mjs`                                                     | `queue.json` and `logs/<run>.live.json`: what a listener leaves to the next one, and picking it up.                                                                                                                                                  |
| `brainstorms.mjs`                                                 | Each issue's brainstorm (`brainstorms.json`) and repo mode (`modes.json`).                                                                                                                                                                           |
| `comments.mjs`                                                    | Replies (comments, discussion threads), reactions, labels (`hasLabel`, `ensureLabel`).                                                                                                                                                               |
| `questions.mjs`, `inputs.mjs`                                     | Open questions → the needs-input label (`applyInput()`), parsed questions; the issues waiting for input.                                                                                                                                             |
| `answers.mjs`                                                     | Answers to a task's open questions from the dashboard: checked, and the comment that stands for them. Pure.                                                                                                                                          |
| `prompts.mjs`                                                     | What the agent reads: each run's prompt and first message, comments delivered mid-run. Pure.                                                                                                                                                         |
| `agents/`                                                         | Each agent's specifics: install, env, hosts, session, tiers, `normalize()` ([Agents](#agents)); `common.mjs`: what they write the same way; `select.mjs`: a run's agent, provider, model.                                                            |
| `modes.mjs`                                                       | Built-in modes, one `MODES` table: light, fresh, inbox, their token's permissions, the dashboard's kind, their prompt; a repo's own (`customMode()`). Pure.                                                                                          |
| `runlog.mjs`                                                      | Run logs and records: the list rebuilt after a restart, the dashboard's entries per line, the live stream.                                                                                                                                           |
| `history.mjs`                                                     | Retention: the logs, summaries and screenshots of runs older than `LOG_RETENTION_DAYS`.                                                                                                                                                              |
| `analysis.mjs`                                                    | Run analyses (the dashboard's Analyze): the runs picked, their digest, the analysis's issue and run.                                                                                                                                                 |
| `events.mjs`                                                      | Deliveries → work items, trigger, `/mode` and `/after` lines, task keys (`taskKey`, `parseKey`).                                                                                                                                                     |
| `repo-config.mjs`                                                 | `.deckhand.yaml`, read from the default branch and parsed, one `KEYS` table: each key's field, default, parser and row on the dashboard's config panel.                                                                                              |
| `repo-settings.mjs`                                               | Each repo's settings as last read: its `users` for the dashboard, `wait_for_answers`, inboxes.                                                                                                                                                       |
| `repo-check.mjs`                                                  | The checks a dashboard action makes on a repo and user before acting as a comment would.                                                                                                                                                             |
| `grants.mjs`, `egress.mjs`, `subnets.mjs`                         | The operator's grants (hosts, mounts, limits), the egress policy and the proxy's CA; the runs' subnets.                                                                                                                                              |
| `github-app.mjs`, `github.mjs`                                    | The App's tokens and calls; `createGitHub()`, `getJson`, `paginate`, `graphql` and the stores' lookups on top.                                                                                                                                       |
| `broker.mjs`, `git-gateway.mjs`                                   | The sandboxes' token broker; their pushes, to the run's own branches only.                                                                                                                                                                           |
| `pr-ready.mjs`                                                    | The sandboxes' pull requests marked ready for review or back to draft (`gh pr ready`).                                                                                                                                                               |
| `anthropic.mjs`, `openai.mjs`, `upstream.mjs`                     | The sandboxes' Claude and OpenAI API calls, with the operator's credential; what both endpoints share (`createApiProxy()`).                                                                                                                          |
| `chatgpt.mjs`                                                     | A ChatGPT plan's login for Codex, held and refreshed by the listener alone.                                                                                                                                                                          |
| `google.mjs`, `antigravity-login.mjs`                             | The Antigravity CLI's calls (`/google/` with `GEMINI_API_KEY`, or `/relay/` from the egress proxy with the plan's access token); its Google AI plan login, held by the listener and refreshed by `agy` in a container of its own.                    |
| `secrets.mjs`                                                     | The operator's secrets, redacted from replies and logs.                                                                                                                                                                                              |
| `setup.mjs`, `auth.mjs`                                           | `/setup` (creating the App) and signing in with GitHub.                                                                                                                                                                                              |
| `docker.mjs`, `runner/`                                           | The docker CLI and its shared arguments (labels, hardening, limits); the Docker runner (`runner/docker.mjs`), composed of `inbox.mjs`, `networks.mjs`, `volumes.mjs` (container engines, `engine.mjs`, and their storage) and `gc.mjs` (`relink()`). |
| `images.mjs`, `checkout.mjs`                                      | Repo images, the agent's install, caches; checkouts.                                                                                                                                                                                                 |
| `onboarding.mjs`, `previews.mjs`                                  | Onboarding issues and their run; preview hooks (`previewHook()`) and their queue.                                                                                                                                                                    |
| `conflicts.mjs`                                                   | The conflict watcher: open task pull requests in conflict get a rebase run (`conflicts.json`).                                                                                                                                                       |
| `reviews.mjs`                                                     | Pull request reviews: the ready pull requests that get one (`reviews.json`), and the GitHub review posted from the run's final message.                                                                                                              |
| `waits.mjs`                                                       | Comments waiting for other issues to be done (`/after`, `waits.json`).                                                                                                                                                                               |
| `work.mjs`                                                        | The graph's work area: the backlog, starting or queueing issues, answers, reruns, inbox entries, analyses.                                                                                                                                           |
| `discussions.mjs`                                                 | Discussions from the dashboard: started, their thread read, replies.                                                                                                                                                                                 |
| `board.mjs`, `titles.mjs`, `pulls.mjs`, `repos.mjs`, `static.mjs` | The dashboard's tasks, titles and closed states, pull requests, repository list and files.                                                                                                                                                           |
| `repo-view.mjs`                                                   | A repository's config as the dashboard shows it: what its runs get, from the runs' own checks.                                                                                                                                                       |
| `store.mjs`, `html.mjs`, `web.mjs`                                | Shared helpers: JSON state files and Maps (`persistentMap`); HTML pages; the API's `apiRoute`.                                                                                                                                                       |
