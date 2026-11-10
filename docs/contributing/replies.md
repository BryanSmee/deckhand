# Replies, reactions and labels

A run's reply counts once GitHub took it (`comments.mjs` `reply()` and `answer()`, a
discussion's included). A 5xx or a rate limit is tried again three times, over about two
minutes; a reply refused with a 422 (too long, most likely) goes again cut to its first 20 000
characters, with a link to the run on the dashboard for the rest. A reply still refused ends the
run as `error`: its comments get 👎, and the dashboard's summary says `The reply couldn't be
posted: <status>`. An orchestrator restarting before then posts it again (`live.replied` is still
false).

A work run's reply goes on its task's open pull request (draft or ready, as `pulls.mjs` knows
it) once there is one, whether its comment came from the issue or from that pull request
(`runs.mjs` `post()`, #1053): the questions, the decisions and what changed stay in one thread.
Its `replyTo` (the run's and its record's) becomes the pull request's number, saved before the
reply is posted, so that the next orchestrator, after a handover, posts it there too rather than
on the issue (an idempotency key is per path). The issue then gets a short comment of its own
(`pointTo()`, its key `<run id>:issue-note`): `Waiting for your input on #<pr>` or `Replied on #<pr>`, linking the reply; one that doesn't ask also quotes the reply's first line (`summaryOf()`: up to
200 characters, headings skipped), which `prompts/sandbox.md` asks to say what changed and what
was decided. A run that couldn't start (a `RunError`) or gave up on GitHub being unavailable
still says so where its comment was (`live.asked`), with no pointer: it posted no reply. A task without a pull request yet gets its reply where its
comment was, and no pointer. Reviews, brainstorms, inbox entries, discussions, chats and any run
without `push` (`answersOnly()`) reply where they did. The `needs-input` label stays on the
issue; ticking the boxes of the reply on the pull request answers it (`work.mjs` `ticked()`
matches the task's `replyTo`, the asking run's), as does a comment on the issue.

A run that stops to ask (its final message starts with `<!-- needs-input -->`, see
`prompts/sandbox.md`, or has it on a line of its own before its first numbered line: a run that
put a translated heading first, `asksInput()`) shows as `needs-input` on the dashboard and labels
the issue or pull request `NEEDS_INPUT_LABEL` (default `needs-input`) until the next run
starts. A run asks too when its work is done but a step only the maintainer can take still
blocks the merge (a write Deckhand refused, a file it may not edit, a secret to add; issue #551):
its pull request stays ready, and each blocker is a question (`Done, carry on` / `Drop it`). A
fix run (`review.fix`) asks the same of a finding whose fix the issue needs but it may not
make, which ends the loop as waiting for input rather than leaving the finding for the next
review (a change only a finding asks for is left, never asked). Its questions stop waiting
earlier when nobody will answer them. `dismissals.mjs` `setAside()` then keeps them aside in
the store's `dismissed` while that run is the task's last:

- someone other than the App's bot takes the label off the task's issue or pull request: an
  `issues` or `pull_request` `unlabeled` delivery, or, for an issue's label taken off unheard (edge
  or the orchestrator down), the label's listing at start (every page of it, and the issue itself
  asked once more before anything is set aside, since a listing read page by page can miss one
  that moved: one still open and labelled keeps its `inputs` entry; it lists issues only, so a
  pull request's task keeps asking until its next run or its close). The listing takes an issue
  missing from it for one whose label came off: renaming `NEEDS_INPUT_LABEL` sets aside the
  questions of the runs that asked under the old name. The bot's own removals don't count: a
  run starting, or a comment that takes the label off and starts nothing, answers none of the
  questions. Putting the label back asks again: an issue's `inputs` entry newer than the
  set-aside, or a pull request's `labeled` delivery from someone other than the bot, which
  takes the entry back;
- the issue or its pull request closes or merges: its `closed` delivery, or, for one the
  orchestrator didn't hear, a check at start of GitHub's `closed_at` against when the run ended. A
  pull request closed without merging sets aside only its own task's questions, not those of
  the issue it would have closed. A run that asks after the close (a comment on a closed issue
  starts one) still waits, and so does one that asked after a redelivered delivery's own time
  (`closed_at`, `merged_at`, or `updated_at` for a label). A redelivery is also checked
  against the issue or pull request as it is now (`replayedIssue()`, `replayedPull()`): a label
  or close action it no longer matches (the label put back since, or taken off; reopened since,
  or closed) is an edit, which moves nothing. An `issues` redelivery whose issue can't be looked
  up (a 5xx, a rate limit) is handled as sent but for the questions, which it leaves as they
  are: its close still reaches the titles, the waits and the backlog. A pull request's is
  replayed with the pull request as it is now, so its time is the original payload's
  (`replayed_updated_at`). A label put back on a closed pull request takes nothing back. An
  issue left open when its pull request merges keeps the label its run put, which then no
  longer holds the task; open questions in the issue's body still do.

The task then shows as `done`, and the run keeps its `needs-input` outcome.

An issue can wait for answers without a run stopping to ask: inbox runs file issues with an **Open
questions** section, and people write some by hand. When an allowed user or the App's bot opens an
issue whose `## Open questions` section asks something (its first paragraph isn't "None"), the
orchestrator labels it. So settled questions don't stay there: a brainstorm's wrap-up moves them,
with their answers, to a **Decisions** section and leaves "None" alone when nothing is left
(`prompts/brainstorm.md`). An edit to Open questions adds or removes the label as it now reads:
ticked boxes are answers, so a section where every question has an option ticked (`- [x]`,
`allTicked()`) and none is free text no longer asks, and the edit that ticks the last one takes the
label off and releases what waited for the answers, as a comment would; unticking them labels it
again (`stillAsks()`). Only an allowed user's ticks answer: the App's bot's (a run ticking its own
picks) and those of someone the orchestrator doesn't act for (not allowed, or narrowed out by the
repo's `users`) answer nothing. An issue the bot opens is labelled all the same, at open and by the
backlog read below. An edit that leaves a section fully ticked without taking the label off (the
bot's, someone not allowed, a refusal in `applyInput()`) marks the issue's entry in the store's
`inputs` (`ignoredTicks`) until an allowed user's edit; on the bot's issues and marked ones,
`wait_for_answers` goes by the label, which only an allowed user's edit takes off. Its limit: an
edit whose delivery was missed (edge down, and never redelivered) isn't marked, so its ticks count
for `wait_for_answers` (the label still shows it waits). A closed issue's edit doesn't list it
again. The backlog read lists a fully ticked issue that still carries the label. An allowed user's
comment on a labelled issue or pull request takes the label off: they answered. The dashboard lists
the open issues carrying the label as `needs-input`, with a run or not (the store's `inputs`, kept
by `issues` deliveries, whoever adds or removes the label, and one lookup per repo when the
orchestrator starts); a closed issue leaves the list.

The graph's backlog read (`work.mjs`, at most once per 30 seconds a repo, or after an
`issues` delivery; every configured repo's, at most once per 5 minutes, while the Overview
asks for the backlog counts) catches what those
missed: an App without the `issues` event, or a label call that failed. An open issue of an
allowed user or the App's bot, with no task on the dashboard, whose body has open questions
but which isn't listed gets the label and the list, as an `issues opened` delivery would have
given it, unless its timeline shows the label was taken off once (answered, by hand or by a
run starting): that issue is left alone, and remembered until the orchestrator restarts. At each
start the orchestrator also reads the App's settings (`GET /app`) and logs a warning naming any
event of `APP_EVENTS` it isn't subscribed to.

With the repo's `wait_for_answers` (on by default, `docs/repo-config/issues.md`), the label holds
work back. `tasks.mjs` `admit()` reads it from the comment's payload: a trigger comment with no text
besides its command lines (`saysMore()`), asking for work or one of the repo's own modes, on an
issue labelled for its body's questions that its ticked boxes don't all answer (and whose last run
didn't stop to ask), starts nothing; the App replies how to answer and swaps its 👀 for the
needs-input reaction. `applyInput()` (`questions.mjs`) leaves the label on for that comment, and
light runs don't take it off when they start. A comment that waited (`/after`) asks GitHub for the
issue's labels before it starts (`resume()`): still labelled, its wait stays with no issues left and
`answers: true`, shown as `needs-input`, until an `unlabeled` delivery or the periodic check starts
it (`waits.mjs` `answered()`). The dashboard's `act()` refuses Start and Queue without the answers
(`409`) only then, and `api/state` carries `waitForAnswers` with a task's questions so the graph
doesn't open the form when it is off.

The questions themselves have one format, set once in `prompts/sandbox.md` (the other prompts
point to it): numbered, an optional `**Title**:` (a question all title is its text), options
as an indented task list with one `(recommended)` or `(recommended: reason)`. Whatever language
a run writes in, the prompt keeps the parts the listener reads in English (the marker, the
`Open questions` heading, `None`, `(recommended)`); the parser also reads a few translations
of them (French, Spanish, German, Portuguese, Italian: hand-written issues, or a run that
translated them anyway, issue #705). A reply's questions under headings it doesn't know are
the first part after the marker when it parses as questions, else the first part whose
questions have options, else the first with free-text questions.
`parseQuestions()` (`questions.mjs`) reads them, all or nothing: a section in another shape
comes as its markdown only (`items: null`). A task waiting for input carries
them in `api/state` (`questions`): from the reply of its run that stopped to ask
(kept on the run, and read again from its log after a restart), else from its issue's body
(kept in the store's `inputs` with the entry, from the `issues` deliveries and the startup lookup).
That run is the task's last, or the last before the runs that keep the label on when they start
(`dismissals.mjs` `askingRun()`): a review of its pull request, whose fix waits for the answers
(#1002), or a light run that only helps answer them. Their answers go on in its session, where
it replied; setting them aside (the label taken off, a close or merge) is about that run too.

The dashboard answers them too (`work.mjs` `answer`, `answers.mjs`): a task waiting for input
shows its questions as a form (one option per question, the one ticked on GitHub picked in
advance, else the recommended one, and a note), or as written
with one text box when they aren't in the set format. Sending checks what the work area does
(signed in, same origin, the user allowed by the operator and the repo) and posts one App
comment, "Answers from @user, from the dashboard:", that lists every answer under its
question and which ones are still open. A run's questions: that comment is queued as the
reply that continues its session, as an allowed user's would be. An issue's: App comments
don't take the label off, so the orchestrator does, once every question has an answer; nothing
starts until a trigger comment or the work area says so.

Boxes ticked in a run's reply answer it the same way: an `issue_comment` `edited` delivery, by an
allowed user, of the App's comment that asks (`<!-- needs-input -->` first, or on a line of its own
before its first numbered line, `asksInput()`), that ticks an option of every question
(`questions.mjs` `tickedReply()`, none free text) goes through the same `answer` (`work.mjs`
`ticked()`), its comment saying "ticked in the run's questions". Only for the questions of the
task's latest run still waiting (titles, texts and options alike): ticking an older reply, or the
boxes again once the run went on, starts nothing. The boxes the run's reply came with are the
agent's (the task's questions, parsed from the run's text, have them `checked`): each question needs
a box ticked since, which is the answer sent, so agreeing with the agent's own tick takes the
dashboard's form or a comment. The form picks ticks in advance only for an issue's questions.

On the graph, an issue waiting for answers moves like a waiting one, but its questions come
first: dragging it (or its Start and "After…" buttons) opens them, and the start or queue goes
only once every one has an answer, in one App comment that carries both (`then` on the answer
request). The run that starts reads them. Started or queued without answers, it is refused.

A task whose last run ended in `error`, `interrupted` or `cancelled` shows a **Rerun** button on its
page (`rerunnable` in `api/state`, from `board.mjs`): work on an issue or pull request, in work or
one of the repo's own modes, not brainstorms, discussions or inbox entries. Each run keeps the
comments it ran on (their text, trigger and mode lines) in its log's first line, so a run lost in a
restart can run again too. `POST /api/repos/<owner>/<repo>/rerun { runId }` (`work.mjs` `rerun`)
checks what the work area does, refuses a run that isn't the task's latest or didn't fail, posts an
App comment ("Rerun from the dashboard by @user") where the run replied, and queues those comments
again in the run's mode, with that comment for the reactions. The issue's session volume carries
what the run had done. An MCP client's `rerun` and `schedule` (`mcp.mjs`) post the same comments,
"from an MCP client" where these say "from the dashboard" (#907), so the issue's readers tell one
from the other.

A pull request whose review-and-fix loop is over (`review.loop` in `api/state`) shows **Review**
and, ready for review with blocking findings left and `review.fix` on, **Fix** in its page's
Review loop section (`reviewOffers()`). `POST /api/repos/<owner>/<repo>/review { number, action }`
(`work.mjs`) checks the repo's users and config, the pull request open and nothing running or
queued on it, posts the App's comment on the pull request and queues the run itself: Review as
`/mode review` would; Fix (not on a draft) through `reviews.mjs` `startFix()`, which refuses
while the loop goes on, on the findings of the App's latest review read back from GitHub
(`latestReview()`), one round more than `review.fix` when they are used up (`grantedTo` in
the store's `reviews`, saved before the run is queued). Each task's pull request in `api/state` has
its head commit (`head`, from its deliveries, `synchronize` included, the start-up listing and
Sync: `pulls.mjs`): the dashboard marks a review outdated when the loop is over and the last
round's `head` differs (`reviewOutdated()`).

Its **Review** tab (`ReviewTab.tsx`) reads `GET /api/review?repo=<owner/repo>&number=<pr>`
(`http.mjs`, `reviews.mjs` `findings()`) when it opens, and again when the task's
`review.history` or its pull request's state changes: the App's latest review read back from
GitHub with the repo's tolerance, as Fix reads it, its follow-ups with the issues
`fileFollowUps()` filed or found for them (`followUpIssues`, by title, and `followUpsRefused`
in the store's `reviews`) and their state now, and who merged it. Never in `api/state` nor the
store: the findings are long, and a model wrote them. A repo the user may not see the tasks of
(`tasks:read`) answers `404`, as a pull request without such a review does.
Each read costs the installation's rate limit a few GitHub calls (#911): the requests asking at
once about one pull request share a read, and a read done is kept 5 s (`REVIEW_MS`) while that
pull request's entry in the store's `reviews` stays the same, so a new round, its merge seen or
its follow-ups filed still read GitHub again at once. A failed read isn't kept.

A failed or interrupted task stops asking for attention (Waiting on you, the Failed tile, the Error
chip, its repository card's "failed" count) once its issue is closed or its pull request merged or
closed: what can't run again shouldn't ask to. It keeps its state, runs and page. For an open one,
**Dismiss** (on its Waiting on you row and its page; the last run `error`, `interrupted` or
`cancelled`) does the same: `POST /api/repos/<owner>/<repo>/dismiss { runId }` (`work.mjs`
`dismiss`, the repo's users, the task's latest run only) keeps `task key → { runId, by, at }` in the
store's `dismissed` (`dismissals.mjs`), and `board.mjs` marks the task `dismissed: { by, at }` while
that run is still its last and it still ended so. Any new run shows it again; the stale entry is
dropped on the next start. `{ runId, undo: true }` takes it back. Nothing is posted on GitHub: it
only matters to the dashboard.

When every slot is taken (`MAX_PARALLEL`, or a repo's `max_parallel`), the **run order** decides
which queued task starts next (issue #413). `tasks.mjs` `queueOrder()` sorts the tasks waiting for a
slot: light runs (the built-in modes with volumes of their own: brainstorms…) first, then those the
maintainer placed, in the order the store's `order` keeps (`order.mjs`, by lowercase task key,
respelled at start with the rest), then the others by when their first pending comment was queued
(`queuedAt`, kept with the queue through a restart). `schedule()` hands the ready ones to
`startable()` in that order, which still skips a task whose repo is at its cap and starts the next.
`POST /api/repos/<owner>/<repo>/order { key, before?: key, after?: key, first?: true }` (`work.mjs`
`reorder`, the repo's users, a queued task of the repo that isn't a light run; `before` and `after`
another of the repo's, none of them: last) writes the whole current order with the task moved, so
moving one past tasks nobody placed keeps them where they were. Move down sends `after`: the task
goes right after the next of its repo's (another repo's tasks between them come up before it), not
to the end of the line. A key leaves the order when its run starts or its queued comments are
dropped (`runs.mjs`); `schedule()` drops any other key of a task with no comments left or a run
going, and so does the start, after `loadQueue()` (the comments it dropped, their author no longer
allowed, leave their keys behind). `api/state` gives each queued task its `position` (1 next to
start, among the tasks of every repo the user sees: the places don't tell of the others) and
`startsFirst` for a light one; the board's Queued tab and the graph's badges show it, and reorder
from there. A move shows at once: the dashboard moves the whole line as `order.mjs` does
(`graphModel.ts` `inLine()`).

The dashboard's New request (Idea, Bug report) sends ideas and bug reports to a repo's inbox:
`POST /api/repos/<owner>/<repo>/inbox { kind: "idea" | "bug", text }` (`work.mjs` `sendToInbox`; the
dialog's title, a blank line, then its details) posts the text on the inbox issue as the App's
comment ("From the dashboard by @user", without the marker: it is an entry, not a reply), then
queues the item a comment there would (`events.mjs` `inboxItem()`), with the signed-in user as its
author. `api/state`'s `inboxes` says which inbox issues and discussions category each repo read so
far has, so the form offers only those repos and inboxes.

The board groups each chain of waiting issues (connected by `edges`) into a lane, and names it
from `api/state`'s `lanes` (`lanes.mjs`, by the key of an issue in it): a name a maintainer
typed for the lane (`user`, `POST /api/repos/<owner>/<repo>/lane { keys, name }`, kept on each
of the lane's issues, "" takes it off), else the title of its parent (`parent`): the one a
`plan` laid it out under, else its parent issue on GitHub (`GET …/issues/<n>/parent`, asked
for each open issue on the board at most once an hour, so sub-issues started one by one or
laid out before count too), else the repo's inbox issue it is (`inbox`). The latest typed
name wins across a lane's issues. A lane nothing names is "#18 and 3 more" (the dashboard's
`lanes.ts`). They are kept in the store's `lanes`; the entry of a closed issue, or of one the
orchestrator never heard of, goes 90 days after it was last set.

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
text, with a key derived from the App's webhook secret, which edge holds: the orchestrator asks
edge for the tags, `POST /from-tags`), those ending with the marker as
Deckhand's answers, and any other App post (a run's) as the App's. The marker and tags are
taken out of what a user writes (`events.mjs` `unmarked()`) before it is posted.

**Analyze runs**, also in New request, starts a run that reads a selection of a repository's past
runs and replies with what would make sessions faster or more reliable (`analysis.mjs`). The form
picks the repository (those `api/state` shows the user), how many recent runs (10 by default, 50 at
most), their kinds (`taskMode`: work, brainstorm, idea, bug, discussion, the repo's own modes…;
never research: [Security model](../security/policies.md#research-runs)) and outcomes (ok, error,
needs-input, interrupted, cancelled). As the selection changes,
`GET /api/repos/<owner>/<repo>/analyze?count=&kinds=&outcomes=` says how many finished runs of that
repository match, and about how many tokens their digest is (its size ÷ 4); the form warns that the
run uses the operator's Claude budget. `POST` (the same path, `{ count, kinds, outcomes }`,
`analysis.mjs` `startAnalysis()`) refuses an empty selection, a count over 50, or a selection no run
matches, with the checks of the inbox's form. It creates an issue "Run analysis: last N runs (…)",
labelled `analysis` (created if missing), listing the selection and the run ids, then queues an item
with the `analyze` trigger on it, as the user's, carrying those ids and whether GitHub said the
repository is private (checked again when the run starts): a public one's digest leaves out the
orchestrator's notes, setup output and failed tools' outputs. No comment can ask for that mode.

`analyze` is a built-in mode with volumes of its own (`modes.mjs`): a fresh session, the model of
light runs (`brainstorm_model`), and, with Deckhand's default policies (`policy/mode-analyze.rego`),
no branch, no setup and a token that only reads, so the reply is the report and the issue stays as
its record. When the run starts (`preparation.mjs` `analysisDigest()`), the orchestrator builds the
digest of the runs picked that are still listed and of that repository: for each, its meta line
(kind, agent, model, effort, status, duration), the orchestrator's notes, setup output that looks
wrong (errors, refused hosts), its tool calls (counts per tool, calls made three times or more,
failed ones with their clipped output) and its final reply, from `format()`'s entries. Each run's
part is cut at 24 KB and the whole at 400 KB, the newest runs first: the older ones beyond the cap
are left out and the digest's header names them. It is redacted, written into the run's inbox folder
as `digest.md` (`TASK_DIGEST`, fetched from the broker like the egress CA:
[Run files](restarts.md#run-files)), and gone with the run. Agent logs carry no per-line timestamps,
so the digest can't show gaps between steps: the run's duration and agent time say how long it took.
The prompt (`prompts/analyze.md`) asks for findings ranked by impact, each citing run ids, with a
concrete change: a `.deckhand.yaml` line, a Dockerfile step, a host for the operator to grant, a
rule for `AGENTS.md`.

Its cost is the run's: it reads up to ~100,000 tokens of digest (the 400 KB cap) on top of
the repository it looks at, on the light runs' model. Previews cost nothing: they read logs
on the orchestrator, and keep each run's part in memory once built (a finished run's log no
longer changes).

Reactions on the triggering comment follow its run: 👀 when it is received, then 🚀 (done),
😕 (needs input) or 👎 (error) once the run that handled it is over.
