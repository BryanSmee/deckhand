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
  are extra instructions. Once started, any comment continues the session. The listener
  creates the issue's branch at the base's head and links it to the issue when it has none
  (`listener/linked-branch.mjs`, `TASK_BRANCH`); the sandbox checks it out, or creates it
  when none was linked, and opens the draft pull request (`sandbox/draft-pr.sh`).
- **On its pull request**: any comment, review or review comment continues the same session
  (a pull request whose head branch is in the repository; a fork's is a task of its own).
- **Anywhere**: `/model fast` or `/effort high` lines pick the model or thinking effort for
  that run (defaults: `SANDBOX_MODEL`, `SANDBOX_EFFORT`). A model is a tier, `best`,
  `balanced` or `fast`, that the run's agent maps to one of its models (see [Agents](#agents)),
  or a model's own name (`sonnet`, `claude-opus-5-5`). `/agent codex` (or
  `claude@openrouter`) picks the agent, and the issue's later runs stay on it; see
  [Picking an agent with `/agent`](#picking-an-agent-with-agent). `/speed fast` turns on
  Claude Code's fast mode (Opus, faster output, a higher price), `/speed normal` drops it or
  a repo's mode's `speed: fast`: `speedFor()` (`agents/select.mjs`) runs it at normal speed
  when the operator (`SANDBOX_FAST_MODE`) or the repo (`fast_mode: false`) turned it off, the
  agent has no `speeds` with `fast` or the provider isn't its default, and on its `best` tier
  when the model isn't one fast mode takes; the footer says which (`record.speedNote`). The
  sandbox gets `SANDBOX_SPEED`, which `claude.sh` turns into `--settings '{"fastMode": true}'`
  (see [Fast mode](setup.md#fast-mode)). These lines may also follow
  the trigger on its first line (`Deckhand /agent codex /effort high`): `splitTrigger()` moves
  each to a line of its own, for `takeOptions()`, and a value it would refuse (`/effort huge`)
  makes the line no trigger at all. Inbox entries (ideas, bugs, discussions) have no trigger
  line: `/model`, `/effort`, `/speed` and `/agent` may end any of their lines instead
  (`Do X /effort high`, `entry()`), outside code blocks and `>` quotes; a run with a refused
  value stays text.
- **Later**: `/after #77` (or `/after #77 #80`), with a trigger or `/mode` line, holds the
  comment back; see [Waiting for other issues](#waiting-for-other-issues).

A comment that arrives while its issue's run is working goes to that run: after the usual
pause (so a burst is one message), the listener writes it to the run's inbox (in the agent's
input format, `TASK_INPUT=stream` in `sandbox/entrypoint.sh`), and the agent sees it after its
current tool call; the run's final message is still the one reply and covers it. `/model`,
`/effort`, `/speed` and `/agent` cannot change a live process: they apply to the next run, and the reply says so.
Comments the run cannot take (a trigger that switches between work and brainstorm, a wrap-up,
or one arriving once the agent's input is closed, or any for an agent that takes no messages
mid-run) wait for a follow-up run.
Inbox entries (the ideas and bugs inboxes, from GitHub or the dashboard's New request) are
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
and goes before queued work. `/stop` ends it: Claude files the follow-up issues the maintainer kept (proposed
under Follow-ups along the way), posts a summary and updates the issue's description (settled questions in a Decisions section, Open questions keeping what is left),
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
the repo's. No clone (`SANDBOX_NO_CLONE`), no GitHub token (the broker's `NO_TOKEN`,
which the GitHub gateway refuses: GitHub's hosts aren't relayed for it, and it reads public
GitHub anonymously through a tunnel), the base image, no setup, caches, mounts, engine, CA or
screenshots, and volumes of its own
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

The base sandbox image holds the harness (`sandbox/`'s scripts, `prompts/sandbox.md`, the
agents' files) and a read-only copy of Deckhand's own source, the version it was built from,
in `/usr/local/share/deckhand/src`: `docs/`, `prompts/`, `sandbox/`, `listener/`,
`server.example/`, `compose.yaml`, `AGENTS.md`, `README.md` and a `VERSION` file (the
release's `DECKHAND_VERSION`), without `dashboard/` or `test/`. Onboarding checks its proposal
against it (the base image's tools, how `setup` and `caches` run) rather than guessing, and
repo images built `FROM` the base image inherit it. It needs no network access or token, and
can't run ahead of the operator's release as GitHub's `main` can.

### Replies, reactions and labels

A run's reply counts once GitHub took it (`comments.mjs` `reply()` and `answer()`, a
discussion's included). A 5xx or a rate limit is tried again three times, over about two
minutes; a reply refused with a 422 (too long, most likely) goes again cut to its first 20 000
characters, with a link to the run on the dashboard for the rest. A reply still refused ends the
run as `error`: its comments get 👎, and the dashboard's summary says "The reply couldn't be
posted: <status>". A listener restarting before then posts it again (`live.replied` is still
false).

A run that stops to ask (its final message starts with `<!-- needs-input -->`, see
`prompts/sandbox.md`) shows as `needs-input` on the dashboard and labels the issue or pull
request `NEEDS_INPUT_LABEL` (default `needs-input`) until the next run starts.

An issue can wait for answers without a run stopping to ask: inbox runs file issues with an
**Open questions** section, and people write some by hand. When an allowed user or the App's bot
opens an issue whose `## Open questions` section asks something (its first paragraph isn't
"None"), the listener labels it. So settled questions don't stay there: a brainstorm's wrap-up
moves them, with their answers, to a **Decisions** section and leaves "None" alone when nothing
is left (`prompts/brainstorm.md`). An edit to Open questions adds or removes the label as it now
reads: ticked boxes are answers, so a section where every question has an option ticked (`- [x]`,
`allTicked()`) and none is free text no longer asks, and the edit that ticks the last one takes
the label off and releases what waited for the answers, as a comment would; unticking them labels
it again (`stillAsks()`). Only an allowed user's ticks answer: the App's bot's (a run ticking its
own picks) and those of someone the listener doesn't act for (not allowed, or narrowed out by the
repo's `users`) answer nothing. An issue the bot opens is labelled all the same, at open and by
the backlog read below. An edit that leaves a section fully ticked without taking the label off
(the bot's, someone not allowed, a refusal in `applyInput()`) marks the issue's entry in
`inputs.json` (`ignoredTicks`) until an allowed user's edit; on the bot's issues and marked ones,
`wait_for_answers` goes by the label, which only an allowed user's edit takes off. Its limit: an
edit made while the listener was down isn't marked, so its ticks count for `wait_for_answers`
(the label still shows it waits). A closed issue's edit doesn't list it again. The backlog read
lists a fully ticked issue that still carries the label. An allowed user's comment on a labelled
issue or pull request takes the label off: they answered. The dashboard lists the open issues
carrying the label as `needs-input`, with a run or not (`inputs.json`, kept by `issues`
deliveries, whoever adds or removes the label, and one lookup per repo when the listener starts);
a closed issue leaves the list.

The graph's backlog read (`work.mjs`, at most once per 30 seconds a repo, or after an
`issues` delivery; every configured repo's, at most once per 5 minutes, while the Overview
asks for the backlog counts) catches what those
missed: an App without the `issues` event, or a label call that failed. An open issue of an
allowed user or the App's bot, with no task on the dashboard, whose body has open questions
but which isn't listed gets the label and the list, as an `issues opened` delivery would have
given it, unless its timeline shows the label was taken off once (answered, by hand or by a
run starting): that issue is left alone, and remembered until the listener restarts. At each
start the listener also reads the App's settings (`GET /app`) and logs a warning naming any
event of `APP_EVENTS` it isn't subscribed to.

With the repo's `wait_for_answers` (on by default, `docs/repo-config.md`), the label holds work
back. `tasks.mjs` `admit()` reads it from the comment's payload: a trigger comment with no text
besides its command lines (`saysMore()`), asking for work or a non-light mode of the repo, on an
issue labelled for its body's questions that its ticked boxes don't all answer (and whose last
run didn't stop to ask), starts nothing; the App replies how to answer and swaps its 👀 for the
needs-input reaction. `applyInput()` (`questions.mjs`) leaves the label on for that comment, and
light runs don't take it off when they start. A comment that waited (`/after`) asks GitHub for
the issue's labels before it starts (`resume()`): still labelled, its wait stays with no issues
left and `answers: true`, shown as `needs-input`, until an `unlabeled` delivery or the periodic
check starts it (`waits.mjs` `answered()`). The dashboard's `act()` refuses Start and Queue
without the answers (`409`) only then, and `api/state` carries `waitForAnswers` with a task's
questions so the graph doesn't open the form when it is off.

The questions themselves have one format, set once in `prompts/sandbox.md` (the other prompts
point to it): numbered, an optional `**Title**:`, options as an indented task list with one
`(recommended)`. `parseQuestions()` (`questions.mjs`) reads them, all or nothing: a section in
another shape comes as its markdown only (`items: null`). A task waiting for input carries
them in `api/state` (`questions`): from the reply of its last run when that run stopped to ask
(kept on the run, and read again from its log after a restart), else from its issue's body
(kept in `inputs.json` with the entry, from the `issues` deliveries and the startup lookup).

The dashboard answers them too (`work.mjs` `answer`, `answers.mjs`): a task waiting for input
shows its questions as a form (one option per question, the one ticked on GitHub picked in
advance, else the recommended one, and a note), or as written
with one text box when they aren't in the set format. Sending checks what the work area does
(signed in, same origin, the user allowed by the operator and the repo) and posts one App
comment, "Answers from @user, from the dashboard:", that lists every answer under its
question and which ones are still open. A run's questions: that comment is queued as the
reply that continues its session, as an allowed user's would be. An issue's: App comments
don't take the label off, so the listener does, once every question has an answer; nothing
starts until a trigger comment or the work area says so.

Boxes ticked in a run's reply answer it the same way: an `issue_comment` `edited` delivery, by an
allowed user, of the App's comment that starts with `<!-- needs-input -->`, that ticks an option
of every question (`questions.mjs` `tickedReply()`, none free text) goes through the same
`answer` (`work.mjs` `ticked()`), its comment saying "ticked in the run's questions". Only for
the questions of the task's latest run still waiting (titles, texts and options alike): ticking
an older reply, or the boxes again once the run went on, starts nothing. The boxes the run's
reply came with are the agent's (the task's questions, parsed from the run's text, have them
`checked`): each question needs a box ticked since, which is the answer sent, so agreeing with
the agent's own tick takes the dashboard's form or a comment. The form picks ticks in advance
only for an issue's questions.

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

A pull request whose review-and-fix loop is over (`review.loop` in `api/state`) shows **Review**
and, ready for review with blocking findings left and `review.fix` on, **Fix** in its page's
Review loop section (`reviewOffers()`). `POST /api/repos/<owner>/<repo>/review { number, action }`
(`work.mjs`) checks the repo's users and config, the pull request open and nothing running or
queued on it, posts the App's comment on the pull request and queues the run itself: Review as
`/mode review` would; Fix (not on a draft) through `reviews.mjs` `startFix()`, which refuses
while the loop goes on, on the findings of the App's latest review read back from GitHub
(`latestReview()`), one round more than `review.fix` when they are used up (`grantedTo` in
`reviews.json`, saved before the run is queued).

A failed or interrupted task stops asking for attention (Waiting on you, the Failed tile, the
Error chip, its repository card's "failed" count) once its issue is closed or its pull request
merged or closed: what can't run again shouldn't ask to. It keeps its state, runs and page.
For an open one, **Dismiss** (on its Waiting on you row and its page; the last run `error`,
`interrupted` or `cancelled`) does the same: `POST /api/repos/<owner>/<repo>/dismiss { runId }`
(`work.mjs` `dismiss`, the repo's users, the task's latest run only) keeps `task key → { runId,
by, at }` in `dismissed.json` (`dismissals.mjs`), and `board.mjs` marks the task `dismissed: {
by, at }` while that run is still its last and it still ended so. Any new run shows it again;
the stale entry is dropped on the next start. `{ runId, undo: true }` takes it back. Nothing is
posted on GitHub: it only matters to the dashboard.

When every slot is taken (`MAX_PARALLEL`, or a repo's `max_parallel`), the **run order**
decides which queued task starts next (issue #413). `tasks.mjs` `queueOrder()` sorts the tasks
waiting for a slot: light runs (brainstorms, the repo's light modes) first, then those the
maintainer placed, in the order `order.json` keeps (`order.mjs`, by lowercase task key,
respelled at start with the rest), then the others by when their first pending comment was
queued (`queuedAt`, kept in `queue.json` through a restart). `schedule()` hands the ready ones
to `startable()` in that order, which still skips a task whose repo is at its cap and starts the
next. `POST /api/repos/<owner>/<repo>/order { key, before?: key, after?: key, first?: true }`
(`work.mjs` `reorder`, the repo's users, a queued task of the repo that isn't light; `before` and
`after` another of the repo's, none of them: last) writes the whole current order with the task
moved, so moving one past tasks nobody placed keeps them where they were. Move down sends
`after`: the task goes right after the next of its repo's (another repo's tasks between them
come up before it), not to the end of the line. A key leaves the order when its run starts or
its queued comments are dropped (`runs.mjs`); `schedule()` drops any other key of a task with no
comments left or a run going, and so does the start, after `loadQueue()` (`queue.json` is only
written when the listener stops, so a crash loses the comments but not their keys). `api/state`
gives each queued task its `position` (1 next to start, among the tasks of every repo the user
sees: the places don't tell of the others) and `startsFirst` for a light one; the board's Queued
tab and the graph's badges show it, and reorder from there. A move shows at once: the dashboard
moves the whole line as `order.mjs` does (`graphModel.ts` `inLine()`).

The dashboard's New request (Idea, Bug report) sends ideas and bug reports to a repo's inbox:
`POST /api/repos/<owner>/<repo>/inbox { kind: "idea" | "bug", text }` (`work.mjs`
`sendToInbox`; the dialog's title, a blank line, then its details) posts the text on the inbox issue as the App's comment ("From the dashboard by
@user", without the marker: it is an entry, not a reply), then queues the item a comment there
would (`events.mjs` `inboxItem()`), with the signed-in user as its author. `api/state`'s
`inboxes` says which inbox issues and discussions category each repo read so far has, so the
form offers only those repos and inboxes.

The board groups each chain of waiting issues (connected by `edges`) into a lane, and names it
from `api/state`'s `lanes` (`lanes.mjs`, by the key of an issue in it): a name a maintainer
typed for the lane (`user`, `POST /api/repos/<owner>/<repo>/lane { keys, name }`, kept on each
of the lane's issues, "" takes it off), else the title of its parent (`parent`): the one a
`plan` laid it out under, else its parent issue on GitHub (`GET …/issues/<n>/parent`, asked
for each open issue on the board at most once an hour, so sub-issues started one by one or
laid out before count too), else the repo's inbox issue it is (`inbox`). The latest typed
name wins across a lane's issues. A lane nothing names is "#18 and 3 more" (the dashboard's
`lanes.ts`). They are kept in `lanes.json`; the entry of a closed issue, or of one the
listener never heard of, goes 90 days after it was last set.

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
user's when its tag checks (`<!-- deckhand-from:user:<hmac> -->`, an HMAC of the user and the
text, with a key derived from the App's webhook secret), those ending with the marker as
Deckhand's answers, and any other App post (a run's) as the App's. The marker and tags are
taken out of what a user writes (`events.mjs` `unmarked()`) before it is posted.

**Analyze runs**, also in New request, starts a run that reads a selection of a repository's past
runs and replies with what would make sessions faster or more reliable (`analysis.mjs`). The
form picks the repository (those `api/state` shows the user), how many recent runs (10 by
default, 50 at most), their kinds (`taskMode`: work, brainstorm, idea, bug, discussion, the
repo's own modes…; never research: [Security model](security.md#research-runs)) and outcomes (ok, error, needs-input, interrupted, cancelled). As the
selection changes, `GET /api/repos/<owner>/<repo>/analyze?count=&kinds=&outcomes=` says how
many finished runs of that repository match, and about how many tokens their digest is
(its size ÷ 4); the form warns that the run uses the operator's Claude budget. `POST` (the
same path, `{ count, kinds, outcomes }`, `analysis.mjs` `startAnalysis()`) refuses an empty
selection, a count over 50, or a selection no run matches, with the checks of the inbox's
form. It creates an issue "Run analysis: last N runs (…)", labelled `analysis` (created if
missing), listing the selection and the run ids, then queues an item with the `analyze`
trigger on it, as the user's, carrying those ids and whether GitHub said the repository is
private (checked again when the run starts): a public one's digest leaves out the listener's notes, setup output and failed
tools' outputs. No comment can ask for that mode.

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
`digest.md` (`TASK_DIGEST`, fetched from the broker like the egress CA: [Run files](#run-files)),
and gone with the run. Agent logs
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

### A run's log

A run's log (`logs/<run>.log`) holds the listener's own lines and the sandbox's output as it
came. The listener also writes a `phase` line at each change of the run's part, with when it
started (`runlog.mjs` `enterPhase()`, its state saved for a restart): `setup` as the run
begins, `image` while the repo's image builds (then `setup` again: the sandbox starts after
the build), `work` at the agent's first event, `push` at a shell command that runs `git push` or
`gh pr create|edit|ready|merge` as a command of its own (not one quoted in a `grep`), and
`work` again at the next other tool call, `wrap-up` after its final answer. A phase whose line
wouldn't fit under `RUN_LOG_MAX_MB` isn't written. Logs from before phases have none, and read as one Work section.

The run's record keeps its phase too, for the dashboard's task state (`board.mjs`
`runState()`): `scheduled` from the moment the run leaves the queue (`setup`: its settings,
sandbox, clone and the repo's `setup`), `building-image` while the image builds (a step of
its scheduling, then `scheduled` again), `working` from the agent's first event on. The
record is saved with the live run, so a restart during setup still shows it `scheduled`;
a record saved before records kept their phase takes its log's. The dashboard's states are all
listed in `board.mjs` (`STATES`, and the comment above it) and in [setup](setup.md) (The
dashboard); `in-review`, between the runs of a review loop, is in Reviews below.

The dashboard times slow steps from `at` lines (`{"type":"listener","event":"at","at":…}`).
The runner follows the sandbox with `docker logs --follow --timestamps` (`runner.follow()`
hands each line Docker's time, without the stamp, after a restart too; Docker also stamps
each 16 KiB part of a longer line inside it, moby/moby#37681, and those stamps go too). Before an agent line
with a tool call or a tool result, `runs.mjs` writes an `at` line with that time, so the agent's
line stays as it printed it; text lines get none. An image build's output is written by whole
lines (`buildOutput()`), with an `at` line, at the listener's time, before each step's first
line. Logs from before `at` lines have none, and show no times.

The log stream (`stream()`) reads lines in order (`reader()`): in the image phase, BuildKit's
plain progress (`#12 [build 5/9] RUN npm ci`, `#12 CACHED`, `#12 DONE 41.2s`,
`#12 ERROR: …`) comes as `step` entries, one when a step starts and one each time its status
changes, and its output as `raw` entries with the step's number; the lines of no step
(BuildKit's error summary) stay `raw`. An `at` line gives no entry: its time goes on the next
line's `tool`, `output` and starting `step` entries (`at`, ms). `dashboard/src/types.ts`
`Entry` is the contract.

## Around the runs

- **GitHub**: the operator's private App, created at `/setup` and stored in the data volume.
  The listener calls GitHub with installation tokens; sandboxes get none. A sandbox holds a
  secret that dies with the run (`broker.mjs`), which its `gh` and git hand out as their
  token; the egress proxy decrypts its calls to GitHub's hosts (with Deckhand's CA, which
  every run but research trusts) and relays them to the GitHub gateway (`github-gateway.mjs`,
  on `BROKER_PORT`, only on the runs' networks), with the address of the sandbox they came
  from, which the listener believes from the proxy alone. The gateway finds the run by its
  secret (bound to that address) or, without one, by its sandbox's address (never its
  engine's); refuses finished, foreign,
  research and push calls and a review's reads of its thread; refuses a work run that isn't a
  fork's what would bring a fork's code (`github-forks.mjs`: a fork's repository, a fork's
  pull request's head, a commit that isn't the repository's, by git, the API, an archive, a
  page (any other of the repository's refused) or a file, Actions logs fetched from where
  GitHub redirects them (`ACTIONS_LOGS`, no credential sent there), GitHub's content hosts
  (`*.githubusercontent.com`) relayed too for such a run and sent on without a token; no branch
  it pushes reaching a fork's objects (the git gateway); its clone is whole, as a blob fetched
  by its id is refused to it);
  redacts every write's body
  (`redact()`, the run's and operator's secrets) and notes it in the run's log; holds each
  REST write to its mode's ceiling and the policies' `deny_github` (`github-writes.mjs`, its
  target's kind looked up with the listener's token); parses and validates its GraphQL
  against GitHub's pinned schema and holds each mutation field to the same checks, its node
  IDs looked up likewise, forwarding the document printed again (`github-graphql.mjs`); and
  sends the call on with a token limited to the run's repo and mode (`permissionsFor()`, read
  only but for a write that passed: `readsOf()`), streaming the
  answer back (`upstream.mjs` `forward()`). The CA certifies GitHub for this
  (`proxy/authority.mjs` `EXCLUDED` keeps only the agents' providers): no sandbox's GitHub
  traffic carries a token any more, so a leaked CA key opens none, and a CA from before,
  whose name constraints excluded GitHub, is made again on the proxy's next start. Those
  tokens only read the code: pushes go
  through the git gateway on the same port, which only lets through the run's own branches
  (and, for a repository granted `allow_workflows`, workflow files that only read and name no
  secret, checked against a mirror of the repository in the data volume),
  and `gh pr create`, `gh pr edit` and `gh pr ready [--undo]` are GraphQL writes like any
  other, which the work mode's ceiling holds for the run's own pull requests only: then
  `github-pulls.mjs` checks the pull request's head is one of the run's branches, its workflow
  files (for a repository granted `allow_workflows`, as a push's) and its conflicts before
  ready, and the one call goes on with the token it needs besides (`pull_requests: write` to
  open or edit one, `contents: write` to ready or draft it), which no other call gets: no
  sandbox can approve or merge one. Light runs can't push or change a pull request.
- **Dashboard**: `GET /` shows every repo's issues and pull requests, their state and live
  logs, to `ALLOWED_USERS` signed in with GitHub through the App, built from `dashboard/`.
  `GET /status` says what is going on, to them and to calls from inside the container.
  Both say which Deckhand runs and since when (`server` in `api/state`, `version` and
  `startedAt` in `/status`, from `status.mjs` `serverInfo()`): the Repositories page shows
  it, the version linked to its commit or release under `DECKHAND_SOURCE`. `GET api/server`
  says how it is set up (`status.mjs` `serverSetup()`), for Settings › Server: the container
  engine, the egress proxy and how many hosts the grants folder grants, whether that folder
  reads without errors (the files to fix, never their errors, which quote mount roots: a repo's config panel shows its own), which Claude credentials are set, which one runs use first and which ones `FALLBACKS` names (variable names only), `ALLOWED_USERS` and `ALLOWED_REPOS`. It scans the grants folder, so
  the page reads it when it opens rather than at each poll.
- **Screenshots**: `GET /shots/<token>/<file>` serves the screenshots runs save for their
  pull requests: GitHub cannot take image uploads through its API, so they need a public URL.
  Sandboxes upload them through the broker ([Run files](#run-files)).
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

The `pull_request` webhook doesn't fire when a base branch moves, so `conflicts.mjs` polls,
and checks a repo soon (`soon()`) when its default branch moved: a pull request merged into it
or a push to it (`repos.mjs` `refreshFor()`, the deliveries that also refresh the repository
list), or Deckhand's own auto-merge, which no delivery precedes. After
`CONFLICT_MERGE_DELAY_MS` (30 s), while GitHub computes `mergeable` again, the repo is due
whatever its interval and a pass runs, after the one under way if any; every trigger during
the wait shares it. The opt-in, `ALLOWED_REPOS` and the `(head, base)` pairs apply as for a
tick, and polling stays the fallback for bases that move without a delivery.
Every minute it takes the open pull requests `pulls.mjs` knows as tasks', in the repos whose
`.deckhand.yaml` sets `conflicts.check_minutes` (never more often than
`CONFLICT_CHECK_MINUTES`; `0` stops it), and asks GitHub whether each still merges. One in
conflict, whose task has no run going or queued and no needs-input label, gets a work item as
if from a comment (`trigger: "work"`, no comment, no sender, `reason: "conflict"`), queued in
its task's session through `tasks.accept()`. The `(head, base)` commits of each attempt are
kept in `conflicts.json`, so the same pair never starts a second run, even after a restart.

The dashboard's Sync runs the same pass at once (`check()`), with every opted-in repo due
whatever its interval, and resets their next check as a tick does. During a tick, it waits for
it, then checks the repos the tick left (not due), so no repo is checked twice and none is
left out; another check meanwhile shares that. It resolves to the rebase runs it started, the
errors of the repos it couldn't check (Sync's `error`) and the pull requests GitHub hadn't
computed yet, which are left to the next tick (their repo is due at once) rather than
making Sync wait. The listener's own sync at start doesn't run it: the first tick after a
restart checks every repo anyway, once the queue is restored.

## Reviews

A repo whose `.deckhand.yaml` has a `review` block gets the built-in `review` mode
(`modes.mjs`: light, fresh, a read-only token). `/mode review` on a pull request starts one;
with `review.on: ready`, `reviews.mjs` also starts one from a `pull_request` delivery
(`ready_for_review`, or `opened` when not a draft) for a pull request on a branch of the repo,
opened by the App or an allowed user. It is a work item as if from a comment (`trigger:
"review"`, no comment, `reason: "review"`), on the task of the issue the pull request closes
or the pull request's own. Each pull request's reviewed head commit is kept in
`reviews.json`, so a redelivery, a restart or the same commit again starts none. Its thread
is a file in the run's inbox (`TASK_DIGEST`, `reviewThread()`, written by `preparation.mjs`):
the pull request's and its issue's, with what users outside the allowlist wrote left out. The run's
final message follows `prompts/review.md`'s format; `runs.mjs` hands it to `postReview()`,
which posts one GitHub review with the listener's token: findings grouped by severity, the
rating (capped by the most severe finding, `parseReview()`), `REQUEST_CHANGES` and a
"request changes" verdict on a critical, high or medium finding and `COMMENT` otherwise (never
`APPROVE`), and a comment review with the raw text when the format can't be read. An automatic
review in a fix loop (`review.fix`), or deciding an auto-merge, may tolerate medium findings (`review.max_allowed_severity`,
`reviews.tolerance()`): those post as `COMMENT`. `runs.mjs` works that tolerance out at launch
too, and `reviewPrompt()` fills `prompts/review.md`'s verdict rule with it (`<blocking>`,
`<tolerated>`, from `reviews.mjs`'s `blockingSeverities()`); the tolerance at post time is
the one that counts, should the settings change during the run.

With `review.fix`, once the review's run is torn down (so it no longer makes the task busy),
`runs.mjs` hands, without waiting for it, the posted review to `reviews.settle()`, whose `fix()`: a review that requests changes on the
App's own pull request, linked to its issue, queues a work item on the issue's task
(`trigger: "work"`, `sender: null`, `reason: "review-fix"`, its `round` of `rounds`), its text
the findings fenced off as untrusted claims (`fixMessage()`), as
`conflicts.mjs` does for a rebase. `fixes` in `reviews.json`, counted before the item is
queued, bounds it to `review.fix`'s rounds (`fixedAt` alone, in an entry from before them, is
one). A review with nothing above `max_allowed_severity` (`tolerance()`) starts none, and
without auto-merge a review that still requests changes once the rounds ran out comments so
(`roundsOut()`).

With `review.merge` and the operator's `allow_auto_merge` (`grants.mjs`
`autoMergeProblems()`), `settle()` goes on, for a review that started by itself (an item with
`reason: "review"`, not a `/mode review` comment's) and started no fix run: `autoMerge()`
re-reads the repo's settings and grant, records `mergeAt` (one decision per pull request),
checks `mergeBlockers()` and the gates (`mergeRefusal()`: the pull request, its labels, its
head, the repository's visibility and merge methods, its changed files against
`trustedFile()`, `mergeable_state`, its Actions runs, last the policies' `deny_merge`), then merges with the listener's token at
the reviewed head (`PUT /pulls/{n}/merge` with `sha`) or comments why not. When only Actions
runs still going stand in the way (`mergeRefusal()`'s `pending`), `decide()` clears `mergeAt`
and keeps `waiting` ({ sha, since, review, … }) in `reviews.json` instead: `checksDone()`, on a
`workflow_run` `completed` delivery for that sha (`http.mjs`), and `tick()`, every 5 minutes,
decide again (`recheck()`, one at a time per pull request), until `review.merge_wait` minutes
after `since`, when the pull request is refused. `waiting` stays saved until such a decision
ends (an in-memory map keeps it to one at a time), so a listener stopped meanwhile asks again,
and a GitHub call failing then waits for the next try. A merge is recorded
on the task's pull request (`pulls.mjs`, `autoMerged`) for the dashboard. A fix run's end
(an item with `reason: "review-fix"`, in `cleanUp()`) calls `reviews.fixed()`: in
auto-merge mode or with more than one round (`fix: true` without `merge` stops at its fix run),
one more review of what it pushed, once per fix run (`reviewedFixes`;
`rereviewAt` in an old entry), whose end starts the next round or stops the loop
(`settle()`), or, in auto-merge mode, a comment when it failed or pushed nothing. At start,
`server.mjs` logs a warning for each repository granted `allow_auto_merge`.

With `review.ci: wait`, every automatic review goes through `reviewAfterCi()` first
(`consider()`, `reviewFix()`, and the end of a CI fix run): it keeps `ciWaiting` ({ sha, since,
base, author }) in `reviews.json` and decides with `ciDecide()` (one at a time per pull request,
a promise chain), again on a `workflow_run` `completed` delivery for that sha (`checksDone()`),
on a `pull_request` `synchronize` (`pushed()`, which moves the wait to the new head) and from
`tick()`. `ciState()` sorts the head commit's Actions runs into `failed`, `running`, `passed`
or `none`, the same rule `mergeRefusal()` uses. Passed, none (after a minute's grace), or
`review.ci_wait` gone: `queueReview()`, the item's `ciNote` (why CI hadn't passed) going to
`reviewPrompt()`. Failed: `ciFailed()` comments, then queues a work item (`reason: "ci-fix"`,
its `round` of `rounds`) whose text is `ciFixMessage()` (failed runs and jobs, read from
`/actions/runs/{id}/jobs`, no logs), counted in `ciFixes` before it is queued; out of rounds,
or no CI fix possible, the review anyway. A CI fix run's end (`cleanUp()`) calls `ciFixed()`,
once per run (`ciSettled`): its push goes back to `reviewAfterCi()`, or a comment says it
failed or pushed nothing. `reviewLoop()` shows `ci` while `ciWaiting` and `ci-fix` while that
run is queued, running or settling, and `ci-failed` once the CI step stopped without a review
(`ciStopped`, cleared when a review is queued). A CI fix run waits for the issue's task to be
free: `ciFailed()` keeps `ciWaiting` while it is busy, and `runEnded()`, called by `cleanUp()`
after every run, decides again. A wait dropped (closed, a draft again) sets `ciDropped` to the
head it never reviewed, and a stopped CI step keeps its head in `ciStopped.sha`: `consider()`
skips neither head as reviewed already.

The dashboard follows the loop. Before `startFix()`, `settle()` appends each automatic review
to its pull request's `rounds` in `reviews.json` (`recordRound()`): `{ round, at, head,
counts: { critical, high, medium, low }, blocking }`, `round` the fix runs before it (0 for the
first review), `blocking` the findings above the tolerance, counts only, never the findings'
text, with `fixRounds`, what `review.fix` allows. An entry from before has none, and shows no
loop. `reviewLoop()` derives where the loop is from that entry and the reason of the task's
run going or queued (`board.mjs`, the task's pull request from `pulls.mjs`, as `reviews.json`
is keyed by the pull request): `reviewing` or `fixing` while a review or fix run is queued or
running, `checks` while the auto-merge is `waiting`, then `clean` (nothing blocking),
`rounds-out` (the review after the last fix run still blocks), `fixed` (`fix: true` without
`merge`: by design nothing reviews its one fix run, `unreviewedFix`) or `stopped` (it blocks,
and no fix run follows). The step on its way is kept as `next` from when it is queued
(`nextAt`) until `settle()` or `fixed()` decided what follows its run, GitHub calls included:
while the task's last run is that step's own (started after `nextAt`) and over, the loop is
still there; an earlier run of the same kind isn't, when the step queued since never ran
(cancelled, refused). At start, after the runs going and the queue are back, `forgetSteps()`
drops the `next` of pull requests with no review or fix run reattached or queued
(`stepsGoing()`, a CI fix run's `next: "ci-fix"` too): a listener stopped while it decided never
will. While `consider()` (from
its settings read on), `settle()` or `fixed()` decide (policies and GitHub calls), an
in-memory mark says so too (`deciding()`, the entry's `deciding`), so a pull request turning
ready is in review before its review is queued. The board takes the loop's step from the
task's run going or its queued items, whichever is the loop's (the work run that marked the
pull request ready may still run), and a task with a maintainer's comment queued beside the
loop's step stays `queued`. The dashboard's ready notification is one per `readyAt` and loop
end. `api/state` sends it as the task's `review` ({ loop, round, rounds, history }). Between the loop's runs (its next one queued, or the checks), the task's state is
`in-review` instead of `queued` or `done`; a running run keeps its own. The dashboard lists it
as running, not ready, until the loop ends: then a ready row whose loop ended blocking says
what it left ("2 high findings left after 3 fix rounds"), and the task's page lists each
round's counts, marking those whose blocking count didn't go down. The listener's behaviour
doesn't change: the loop still runs all its rounds.

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
instead. A backlog issue whose last run was cancelled, failed or interrupted keeps its node on
the graph, and once the backlog lists it, the node moves like its card there (`movable()` in
`graphModel.ts`): the same `start`, `queue` or `plan`, no route of its own. Between the backlog
and the graph, a Brainstorm column lists the repo's brainstorms (active, idle, wrapping up),
which leave the graph unless an arrow touches them: a backlog issue dropped there starts a
brainstorm, a brainstorm dropped on the graph starts work (and ends the brainstorm), dropped
back on the backlog it stops (`stop`, what a `/stop` comment does: the wrap-up run). Each has a
button too.

A backlog issue with open sub-issues (its card says how many, from the issue list's
`sub_issues_summary`) brings its whole tree along (`plan`, `plans.mjs`): the listener reads its
sub-issues, all levels down, and each one's "blocked by" links, then holds or starts each issue
in the mode picked. A sub-issue with nothing open to wait for starts; the others wait for all
their blockers (open issues of the repo, in the tree or not; those of another repository are
left out, and the reply says so), and for what their parent is blocked by; a parent waits for
all its open sub-issues, and runs last, to finish the epic or close it. Dropped next to an
issue, the tree's first issues wait for that one. A blocker reached through another is left
out (#11 waits for #12, not for #12's own blockers too). Sub-issues closed as completed are
skipped. A parent "blocked by" its own sub-issues (an epic by its tasks) already waits for
them: those links are left out, and not passed down. One closed without being done, running or
queued, with open questions, a loop in the links (through the waits already there too), or a
tree over 30 open issues (`MAX_TREE`) refuses the whole drop before anything is posted. If
GitHub fails halfway through the comments, the reply says which issues are laid out and which
aren't. Each issue gets the App's comment ("Queued from the dashboard by @alice as part of
#10, after #12"), and a sub-issue unblocks the next once it is done, as for `/after`: its pull
request merged, so the next one builds on it.

The backlog is served from the last read and
read again in the background once it is 30 seconds old or an `issues` delivery made it stale
(only a repo with no read yet waits for GitHub), and the dashboard keeps each repo's last one
in memory, so coming back to the graph or a repo's tab shows it at once. The listener writes
each action on the issue as the App's comment, which reactions follow like a trigger
comment's, and queues the work (`accept()`) or holds it (`waits.hold()`) itself: the App's
own comments never reach `admit()`. The checks are `resume()`'s, see
[security.md](security.md#the-dashboards-actions).

The Overview's repository cards get each configured repo's backlog count from the same reads
(`GET /api/repos?backlog=1`, `work.mjs counts()`): the last read's at once, read again in the
background once it is 5 minutes old (`COUNT_MS`), so listing never waits for GitHub. `more`
says the read was one full page (100 issues and pull requests), when the count may be short.
The other pages poll the list without `backlog` and cost no read.

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

A restart delays the runs' calls rather than failing them (#507). Everything a sandbox calls
during a run reaches the listener's broker port: GitHub and git, the agents' APIs (through the
egress proxy, which relays them), the inbox and the run's files (directly). On SIGTERM the
listener closes its ports: the dashboard's and webhooks' at once (a delivery missed meanwhile
comes back through `redeliveries.mjs`), and the broker's drains (`drain.mjs`): it takes no new
connection, the calls in flight finish (agents' streams, pushes, `gh` calls, inbox long polls),
each connection closing once its answer is sent, and the listener exits once they are all done,
or after 280 s, a little before compose's `stop_grace_period` (5 minutes) ends. The egress
proxy waits for the next listener meanwhile (`proxy/wait.mjs`): a connection the listener
refused, or that failed before it was made (reset while connecting, its name unknown while its
container is gone), never reached it, so the proxy tries again, with a growing delay (0.25 s
doubling up to 5 s), for up to 90 s before it answers `502` (or, for the policy it asks for each
connection, refuses the host). That holds for any method, a push or a POST included: a request
is only sent once a connection is made, and never sent again (a listener that dies with it gives
the sandbox a `502`). The inbox and the run's files, which don't go through the proxy, try again
on their own (`deckhand-inbox`, `deckhand-files`). The proxy drains on SIGTERM too, with the same
grace: no new tunnel, the open ones finish, and the decrypted ones close once their requests are
answered.

With one copy of each (compose), the next listener only starts once the previous one has
exited: the wait covers the drain and the next start when they take less than 90 s together. A
call that comes while a long one (an agent's stream) holds the old listener longer fails as
before once its 90 s are up; two copies handing over (#499) close that gap.

Running sandboxes outlive an update: they keep their image, and its scripts, until they end.
So an endpoint that sandboxes call is never just removed: for a while it answers with what to
do instead, which the old scripts print. The broker's old `/pr/` routes (gone in #407) answer
410 with the `gh` command that works now (`broker-http.mjs`, until no sandbox from before
#407 can still run).

### Run files

A run's inbox, the egress proxy's CA and the run's digest stay in the listener's runs folder
(`runner/inbox.mjs`, `<dataDir>/runs/<run>/`), and its screenshots in `shots/<token>/`; no
sandbox mounts either (#393): a volume shared with sandboxes on other machines would need
ReadWriteMany storage. They travel through the broker's port instead (`run-files.mjs`), with
the run's secret, from its own sandbox only, like its GitHub calls:

| Call                         | From the sandbox                                                                                                                             | Answer                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /run/inbox?from=<byte>` | `deckhand-inbox`, the agent's input (`TASK_INBOX` is this URL)                                                                               | the whole lines after that offset (at most 1 MiB, a longer line alone), waiting up to 25 s for one (`204` without); `deckhand-inbox` adds what it read |
| `GET /run/ca`, `/run/digest` | `deckhand-files get`, once at start (`DECKHAND_CA`, `TASK_DIGEST`)                                                                           | the file, which `entrypoint.sh` keeps in `/tmp/deckhand` and names in the same variable; the run stops if it can't fetch it                            |
| `PUT /run/shots/<file>`      | `deckhand-files shots`: at the agent's Stop hook, on each push (the hook after `git push`, `pre-push`), before each `gh` call, and every 3 s | `204`; a name GET /shots doesn't serve (`400`), a file that isn't the PNG, JPEG or WebP it says (`415`), over 10 MB or the run's 100 MB (`413`)        |

The inbox file is the truth: a restarted listener answers from the same offset, so the agent
gets every line once. The sandbox keeps `SCREENSHOT_DIR` (`/tmp/screenshots`) in its own
filesystem. The agent's CLI replaces the entrypoint, which has no step after it: the agents'
Stop hook (`sandbox-draft-pr hook`, after each turn, before its result line) is the last
upload, and the 3 s watcher covers what saves files outside a turn. A refusal for the file
(its name, size or type: `400`, `413`, `415`) is final until it changes, and said on
stderr by the next `gh` call or push, where the agent reads it, even when the watcher or a
hook (whose stderr is only the run's log) met it first; any other is tried again. Fetching
the CA or digest at start retries a 401, 403 or 5xx for a minute; only a 404 fails at once.
Uploads in flight reserve their size, so parallel ones can't pass the run's cap together,
and a name has one at a time: a second gets `409`, tried again later. The hooks upload last
(an `EXIT` trap in `draft-pr.sh`, which sets `DECKHAND_SHOTS_SKIP` so its own `gh` calls
don't), and every caller within 20 s: opening the draft pull request keeps the hook's 60 s.
Sandboxes from before #393 still mount the `runs` and `screenshots` volumes, which is why
compose keeps them at the same paths.

The dashboard's run list comes back from the runs' summaries (`logs/<run>.json`, written
when a run ends): a log is read only for a run without one (from before summaries, or a
listener that died mid-run), which then gets one: in full up to 64 MB, else its first line and
its last 4 MB, with a warning in the listener's log. A log that can't be read is left out of
the list, logged. The list is held newest first with an index by id, and both lose the runs
`history.mjs` removes, at start and daily: those older than `LOG_RETENTION_DAYS`, but for a
running run and the latest run of a task still queued, in a brainstorm, waiting or waiting
for input.

### Missed deliveries

GitHub never retries a failed webhook delivery by itself: one sent while the listener is down
or restarting, answered `503` while it stops or while its places for unverified bodies are
full, or cut by a reverse proxy, is lost unless it is redelivered. `redeliveries.mjs` lists
the App's deliveries with its JWT (`GET /app/hook/deliveries`, newest first, by cursor) at
start, every 5 minutes, and from the dashboard's Sync (`POST /api/sync`, once per 30 seconds),
back to the last scan (less 10 minutes, at most 3 days, GitHub's retention), kept in
`redeliveries.json`. Each GUID none of whose attempts succeeded, whose latest attempt couldn't
connect, timed out or got a 5xx, is redelivered (`POST …/attempts`), once: the GUIDs asked for
are kept 3 days, and a 4xx is the listener's own refusal (a bad signature), which would come
again. A redelivery keeps its GUID: one the same listener process did handle (`http.mjs`
`firstTime()`, its last 500 GUIDs, in memory) is neither asked for nor handled twice. A
delivery GitHub recorded as failed (a timeout, say) that a listener since restarted did handle
is redelivered and handled again; the listener answers `202` as soon as it has the body, so
GitHub rarely times one out. Comments come back oldest first, whatever their age. A
redelivered `pull_request` delivery (`redeliveries.mjs` `redelivered()`, the GUIDs it asked
for) is handled as its pull request is now (`events.mjs` `replayedPull()`): its payload is as
old as the failed attempt, maybe older than deliveries handled since. Its current state is
recorded, and an action the pull request no longer matches (ready since merged) becomes
`edited`, so nothing turns ready, closes or starts a review from it.

At start and from the dashboard's Sync, the scan goes with the open pull requests' states read
again (`pulls.mjs` `resync()`), through `sync.mjs`. The dashboard's then runs a conflict pass
(`conflicts.mjs` `check()`, see Conflicts) after `resync()`, so a pull request merged or closed
meanwhile isn't checked. The last one's result is kept in memory and sent in `api/state`
(`lastSync`): when it ended, who asked (`null` for the listener at start), how many
deliveries were asked again, pull requests changed and rebase runs started (`conflicts`, 0 at
start), and the error of a part that failed (the other parts' counts are kept). `POST /api/sync`
answers the same record, `502` when it failed.

A delivery whose handling throws (`dispatch()`) is logged with its event and action; the
listener goes on with the next one. GitHub got its `202` already, so it isn't redelivered.

Pull request states don't hang on deliveries alone: the listener records the changes it makes
for runs (`github-pulls.mjs`: ready, draft, opened, edited) in `pulls.json` at once (the
`ready_for_review` delivery that follows keeps its `readyAt`: one notification), and asks
GitHub about every open pull request it knows again at start and from Sync
(`pulls.mjs` `resync()`), so a `ready_for_review`, merge or close older than the redelivery
window still shows.

A task's pull request also carries its size and commit count (`additions`, `deletions`,
`changedFiles`, `commits`), as the last pull request object that had them said: deliveries
(`synchronize` included, a push to its branch) and single lookups have them, listings don't,
so `fill()` asks once for the size of a task's pull request that has none, whatever its state
(a closed one's never changes), and `resync()` for an open one. A run records its last
push GitHub took (`branch`, `lastPushAt` on its record): the git gateway reads GitHub's
report for the refs it updated and tells the broker's entry for the run (`watchPushes()`,
`restart.mjs`), whose record is saved with the run, so a restart keeps them.

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
  `release-install`, which checks the tarball against the sha256 `AGY_SHA256` pins, the
  login refresh the listener runs, hooks, progress filter and `text.jq`, which joins an
  answer's text deltas into one `deckhand.text` line).
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

The rest of the listener reads only those events: `runs.mjs` the results (the reply, its
duration, needs-input), `runlog.mjs` all of them (the dashboard's entries). Logs keep the
agent's raw lines and each run's first line names its agent (`claude` for logs from before
the seam), so old logs still render. The reply's footer and the listener's messages name the
run's agent (`displayName`).

### Providers and fallbacks

An agent calls a provider: Claude Code `anthropic` (the operator's `ANTHROPIC_BASE_URL`) or
`openrouter`, Codex `openai`, the Antigravity CLI `google` (each agent's `providers` and `defaultProvider`; `env(config,
secret, provider, credential)` gives the variables for one). Sandboxes always call the
listener: the broker keeps each run's provider and credential (`broker.provide()`), and the
listener's endpoint (`anthropic.mjs`) forwards to that provider's URL with its credential. The
endpoints also keep the provider's last status on the run (`apiStatus`), and the Anthropic one
when a plan's limit resets, from its 429 (`apiReset`).

A provider can have credentials an entry names (its `credentials`): Claude Code's `anthropic`
has `plan` (`CLAUDE_CODE_OAUTH_TOKEN`) and `key` (`ANTHROPIC_API_KEY`), written
`claude@anthropic:key`. Without a name, a run takes the default credential (`credentialName()`):
a gateway's token, then the plan, already paid for, then the key. The endpoint holds every
credential set (`named`) and picks the run's, in its header (`Bearer` for the plan, `x-api-key`
for the key); the sandbox gets the run's secret in that credential's variable, so Claude Code's
auth mode matches. `config.credentials` lists the ones set and which is the default, for
`/agent` and for `resolved()`, which names an entry's credential (`claude@anthropic` →
`claude@anthropic:plan`), so the default isn't tried twice. A run's record keeps the entry's
named credential (`credential`, null for the default: the footer and sticky fallbacks read
it) and, for the dashboard, the one it actually runs on (`auth`: `plan`, `key` or `gateway`,
from `authOf()`; null off Anthropic), written in its log's first line so it survives a restart.

The operator's `FALLBACKS` lists `agent@provider` (or `agent@provider:credential`) entries in
order. When a run ends with an
error result, `runs.mjs` asks `providerError()` (`agents/index.mjs`) whether the provider failed
it: the result's text (`API Error: 529`, `unexpected status 429`, overloaded, rate limit, quota,
invalid key) or the endpoint's last status (429, 529, 402, 401, 403, 5xx). If so, and an entry
the run's chain hasn't been on is left (`nextFallback()`, `agents/select.mjs`), no reply is posted: the run's
comments go back in the queue, each carrying a `fallback` marker (the next entry, the one that
failed, why, the entries tried, its last message), so it survives a restart like any queued
comment. The next run takes its entry from the marker (`entryFor()`):

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

| Module                                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.mjs`                                                      | Wiring: settings, the GitHub App, `ctx`, the modules; starts the servers, restores runs, handles SIGTERM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `config.mjs`, `yaml.mjs`                                          | The operator's settings (environment and `config.yaml`), one `SETTINGS` table: each one's type, default and parser; the YAML subset both config files use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `http.mjs`, `deliveries.mjs`                                      | The public server: webhook deliveries, the dashboard and its API, `/status`, screenshots; the places for unverified bodies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `redeliveries.mjs`                                                | Deliveries GitHub couldn't hand over, found in the App's delivery list and redelivered once (`redeliveries.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `sync.mjs`                                                        | The last catch-up with GitHub (redeliveries, pull requests, conflicts), for `api/state`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `broker-http.mjs`                                                 | The broker's server, on the runs' networks: egress answers, GitHub, git, ready for review, the agents' API calls, the runs' files (`run-files.mjs`); the sandbox the proxy names.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `status.mjs`                                                      | `/status`: running runs, reaction updates in flight (`track()`), preview hooks; whether the listener is idle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tasks.mjs`                                                       | One queue per issue: admission (`admit()`, `resume()`, open questions), the pause, delivery to a running session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `task-modes.mjs`                                                  | Which mode a queued comment runs in: trigger and `/mode` lines, brainstorms, the issue's current mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `runs.mjs`                                                        | A run from start to reply: settings and agent (`begin()`), the sandbox, its output, cancel, reply, reactions, label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `preparation.mjs`                                                 | Before a run's sandbox starts: its branches, mode instructions, image, agent, caches, screenshots, egress cache, digest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `linked-branch.mjs`                                               | A work run's issue branch, created at the base's head and linked to the issue before its sandbox starts, within `deny_link_branch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `access.mjs`                                                      | What a run may reach from the operator's grants: hosts, mounts (checked twice), limits, the egress cache, an engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sandbox-spec.mjs`                                                | What a run starts, described for any runner: image, environment, user, limits, capabilities and volumes (`kind`: agent, session, cache, mount), no backend options. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `footer.mjs`                                                      | The line under each reply: agent, provider, model, effort, speed, duration, the next step. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `restart.mjs`                                                     | `queue.json` and `logs/<run>.live.json`: what a listener leaves to the next one, and picking it up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `brainstorms.mjs`                                                 | Each issue's brainstorm (`brainstorms.json`) and repo mode (`modes.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `comments.mjs`                                                    | Replies (comments, discussion threads), reactions (the listener's, noted in `reactions.json`: a run never removes them), labels (`hasLabel`, `ensureLabel`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `questions.mjs`, `inputs.mjs`                                     | Open questions → the needs-input label (`applyInput()`), parsed questions; the issues waiting for input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `answers.mjs`                                                     | Answers to a task's open questions from the dashboard: checked, and the comment that stands for them. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `prompts.mjs`                                                     | What the agent reads: each run's prompt and first message, comments delivered mid-run. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `agents/`                                                         | Each agent's specifics: install, env, hosts, session, tiers, `normalize()` ([Agents](#agents)); `common.mjs`: what they write the same way; `select.mjs`: a run's agent, provider, model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `modes.mjs`                                                       | Built-in modes, one `MODES` table: light, fresh, inbox, their token's permissions, the dashboard's kind, their prompt; a repo's own (`customMode()`). Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `runlog.mjs`                                                      | Run logs and records: the list rebuilt after a restart, the dashboard's entries per line, the live stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `history.mjs`                                                     | Retention: the logs, summaries and screenshots of runs older than `LOG_RETENTION_DAYS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `analysis.mjs`                                                    | Run analyses (the dashboard's Analyze): the runs picked, their digest, the analysis's issue and run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `events.mjs`                                                      | Deliveries → work items, trigger, `/mode` and `/after` lines, task keys (`taskKey`, `parseKey`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `repo-config.mjs`                                                 | `.deckhand.yaml`, read from the default branch and parsed, one `KEYS` table: each key's field, default, parser and row on the dashboard's config panel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `repo-settings.mjs`                                               | Each repo's settings as last read: its `users` for the dashboard, `wait_for_answers`, inboxes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `repo-check.mjs`                                                  | The checks a dashboard action makes on a repo and user before acting as a comment would.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `grants.mjs`, `egress.mjs`, `subnets.mjs`                         | The operator's grants (hosts, mounts, limits), the egress policy and the proxy's CA; the runs' subnets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `github-app.mjs`, `github.mjs`                                    | The App's tokens and calls; `createGitHub()`, `getJson`, `paginate`, `graphql` and the stores' lookups on top.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `broker.mjs`, `git-gateway.mjs`                                   | The runs' secrets, each for its own sandbox only; their pushes, to the run's own branches only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `github-forks.mjs`                                                | What a work run that isn't a fork's may fetch through the GitHub gateway: no fork's repository, pull request head or commit, by git, the API, an archive, a page, a raw file, a workflow's artifacts or logs, or GraphQL (`Blob`, a fork's repository, an unnamed one's files), nor, through the git gateway, a branch pushed to reach a fork's objects (`git-mirror.mjs` `connect()`); a fork's run gets a clone of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `github-gateway.mjs`                                              | The sandboxes' GitHub calls, relayed by the egress proxy: the run's token in place of its secret, writes redacted, a review's thread reads refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `github-writes.mjs`                                               | The REST writes the GitHub gateway relays: classified, their target's kind read from GitHub, held to the mode's ceiling (`modes.mjs` `ceilingOf()`) and the policies' `deny_github`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `github-graphql.mjs`, `github-graphql-worker.mjs`, `vendor/`      | The GraphQL the GitHub gateway relays: parsed with graphql-js (bundled at image build), validated against GitHub's pinned schema in a worker (`github-graphql-worker.mjs`), each mutation field a write for `github-writes.mjs`, printed again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `git-mirror.mjs`, `workflow-check.mjs`                            | The git gateway's mirrors of the repositories granted `allow_workflows` or whose work runs push: the connectivity check of a work run's push against the repository's own objects, and the checks on the workflow files a granted repository's pushes change (a strict YAML subset).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `github-pulls.mjs`                                                | A run's own pull requests' writes (`gh pr create`, `edit`, `ready`): from its branches, their workflow files and conflicts checked, the token they need, the dashboard's record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `anthropic.mjs`, `openai.mjs`, `upstream.mjs`                     | The sandboxes' Claude and OpenAI API calls, with the operator's credential; what both endpoints share (`createApiProxy()`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `chatgpt.mjs`                                                     | A ChatGPT plan's login for Codex, held and refreshed by the listener alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `google.mjs`, `antigravity-login.mjs`                             | The Antigravity CLI's calls (`/google/` with `GEMINI_API_KEY`, or `/relay/` from the egress proxy with the plan's access token); its Google AI plan login, held by the listener and refreshed by `agy` in a container of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `secrets.mjs`, `redact.mjs`                                       | The operator's secrets and the runs' GitHub tokens, redacted from replies, logs and GitHub writes (whole, parts of 16 characters or more, GitHub token shapes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `setup.mjs`, `auth.mjs`                                           | `/setup` (creating the App) and signing in with GitHub.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docker.mjs`, `runner/`                                           | The docker CLI and its shared arguments (labels, hardening, limits, mounts); the runner `RUNNER` picks (`runner/index.mjs`: Docker, or Kubernetes), with its sandboxes (`runner/docker.mjs`, which turns a spec into `docker run` options, composed of `inbox.mjs` (its files, served by `run-files.mjs`), `networks.mjs`, `volumes.mjs` (container engines, `engine.mjs`, and their storage) and `gc.mjs` (`relink()`)), its images and volumes (`runner/images.mjs`) and its short containers (`runner/jobs.mjs`: agent installs, cache chowns, the Antigravity login refresh, preview hooks). The Kubernetes runner (`runner/kubernetes.mjs`, through the API with `runner/kube-api.mjs`) has the same interface, with a pod, a Secret and claims per run, and its images and volumes in `runner/kube-images.mjs` (repo images built by BuildKit with `runner/buildkit.mjs` and pushed to a registry, `runner/registry.mjs`; agents' installs and caches as claims); both read a sandbox's output with `runner/lines.mjs`. No other module calls `docker`. |
| `images.mjs`, `checkout.mjs`                                      | Repo images (tags, hashes, pruning), the agent's install, caches, on the runner's images and jobs; checkouts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `onboarding.mjs`, `previews.mjs`                                  | Onboarding issues and their run; preview hooks (`previewHook()`) and their queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `conflicts.mjs`                                                   | The conflict watcher: open task pull requests in conflict get a rebase run (`conflicts.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `projects.mjs`                                                    | A repository's issues on its granted projects (v2) (`projects:`): added, and their field set when a work run starts, and with the pull request closing them when it turns ready and when it merges.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `reviews.mjs`                                                     | Pull request reviews: the ready pull requests that get one (`reviews.json`), the GitHub review posted from the run's final message, its fix run and auto-merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `reviewers.mjs`                                                   | The reviewers a repo's `review.request` names, requested on Deckhand's pull request when it turns ready and after a run moved its head (`requested.json`), within `deny_request_review`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `policies.mjs`                                                    | Rules as code: the operator's (`GRANTS_DIR/policy/`) and the repos' (`.deckhand/policy/`) Rego policies, merged by file name and evaluated by `opa` (no environment, no network, a timeout), fail closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `waits.mjs`                                                       | Comments waiting for other issues to be done (`/after`, `waits.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `work.mjs`                                                        | The graph's work area: the backlog, starting or queueing issues, answers, reruns, dismissals, inbox entries, lane names, analyses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `order.mjs`                                                       | The run order: which queued task starts next when a slot frees, as the maintainer placed them (`order.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dismissals.mjs`                                                  | Failed runs dismissed from the dashboard, while each is its task's last (`dismissed.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lanes.mjs`                                                       | The board's lanes' names: typed on the dashboard, a plan's or GitHub's parent, or an inbox (`lanes.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `plans.mjs`                                                       | A parent issue dropped on the graph: its sub-issues' tree, all levels down, and what each waits for from their "blocked by" links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `discussions.mjs`                                                 | Discussions from the dashboard: started, their thread read, replies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `board.mjs`, `titles.mjs`, `pulls.mjs`, `repos.mjs`, `static.mjs` | The dashboard's tasks, titles and closed states, pull requests, repository list and files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `repo-view.mjs`                                                   | A repository's config as the dashboard shows it: what its runs get, from the runs' own checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `store.mjs`, `html.mjs`, `web.mjs`                                | Shared helpers: JSON state files and Maps (`persistentMap`); HTML pages; the API's `apiRoute`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
