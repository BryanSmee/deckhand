# How Deckhand's services work together

Deckhand receives the GitHub App's webhooks, runs an agent (Claude Code, Codex or the
Antigravity CLI, see [Agents](#agents)) in a sandbox container (`sandbox/`) for issue, pull
request and discussion comments, one container and one set of volumes per issue, and posts the
agent's final message back as a comment. Two services share the work:
**edge** (`edge/`), the only one the internet reaches, takes the webhooks, `/setup`, sign-in and
the dashboard's files, and passes the dashboard's API on; **the orchestrator**
(`orchestrator/server.mjs`) does the rest: the queue, the runs' lives, what the dashboard shows.
Beside them: the runner service (`runner/`, [The runner service](#the-runner-service)), the only
one with the Docker socket, which runs the sandboxes; the broker (`broker/`), the github service
(`github/`), the models service (`models/`), the policy service (`policy-service/`) and the
egress proxy (`proxy/`). This page is the map: what a comment turns into, and which module does
what. Setup is in [setup.md](setup.md), the per-repo file in [repo-config.md](repo-config.md),
the security model in [security.md](security.md), the services and their updates in
[services.md](services.md).

## Edge and the orchestrator

Both run modules of `listener/`, which has no entry point of its own any more.

- **Edge** (`edge/server.mjs`, image `deckhand-edge`): its public server (`edge/http.mjs`:
  `POST /webhook`, its HMAC checked, with the places for unverified bodies of
  `listener/deliveries.mjs`; `/setup`, `listener/setup.mjs`; sign-in and sessions,
  `listener/auth.mjs`; the dashboard's files, `listener/static.mjs`; `/health`), the passing on
  of the dashboard's API and `/status` to the orchestrator (`edge/forward.mjs`) and of the
  screenshots to the broker (`edge/shots.mjs`), its internal port for the orchestrator (`edge/internal.mjs`: the
  `deliveries` stream, the App's public parts, the "From the dashboard by" tags, a redeliveries'
  scan) and the redeliveries' poller (`listener/redeliveries.mjs`). It holds the webhook secret,
  the session key and the OAuth client's, in its own volume (`edge-data`), and its store.
- **The orchestrator** (`orchestrator/server.mjs`, image `deckhand-orchestrator`): the other
  modules this page names, but those the runner and github services run. It reads the verified deliveries from edge's stream
  (`listener/http.mjs` `deliver()`), answers what edge passes on on its services port
  (`listener/services-http.mjs`, `/edge/…`) and the proxy's questions on the egress policy's port
  (`egress-http.mjs`, 8082). It holds no secret, keeps the `data` volume (its state, its store:
  the queue, its lease), and is on no run's network: no sandbox calls it.

How a delivery goes from one to the other, the orchestrator's two copies and their handover:
[services.md](services.md#edge-and-the-orchestrator). What each holds and may call:
[Edge](security.md#edge) and [The orchestrator](security.md#the-orchestrator) in security.md.

## From a comment to a reply

- **On an issue**: `Deckhand` (`TRIGGER`) as the first line starts the work; the other lines
  are extra instructions. Once started, any comment continues the session. The orchestrator
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
pause (so a burst is one message), the orchestrator writes it to the run's inbox (in the agent's
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
(`runs.mjs` `linger()`, `ANSWER_GRACE_MS`); any output restarts it. Its deadline is saved (`graceUntil`): an orchestrator that restarts gives it its whole grace while its follow skips the output read before, then keeps to that deadline, with at least 10 s to read what the sandbox wrote while no orchestrator was there (Restarts). If the sandbox is still running, silent, when it fires, the orchestrator
writes an `ended` line to the run's log ("Stopped at … after its answer" on the dashboard),
stops the sandbox and ends the run as usual, with its last result as the reply.

### Brainstorms

`Deckhand` then `/mode brainstorm` (or `Deckhand /mode brainstorm` on one line) starts a
brainstorm instead: Claude discusses the issue (`prompts/brainstorm.md`) without writing
code, and each later comment on the issue is the next message of that conversation. A
brainstorm run (without `push` with Deckhand's default policies: `SANDBOX_LIGHT`) starts after a short pause (`BRAINSTORM_DEBOUNCE_MS`)
and goes before queued work. `/stop` ends it: Claude files the follow-up issues the maintainer kept (proposed
under Follow-ups along the way), posts a summary and updates the issue's description (settled questions in a Decisions section, Open questions keeping what is left),
then comments no longer reach it until a trigger line. After
`BRAINSTORM_IDLE_MINUTES` (10) without a comment it shows as idle; a comment then restores it
from the issue's session volume. `Deckhand` or `/mode work` afterwards implements in a session
of its own, which starts from the issue: the brainstorm's comments and the description its
wrap-up updated. Light runs (the built-in modes with `volumes` in `modes.mjs`: brainstorms, onboarding,
inbox entries, discussions, analyses, reviews, research) never share a writable volume with the
issue's work runs: they have their own clone and session (`<name>-light-workspace`,
`<name>-light-claude`; `<name>-light-push-…` when the policies give one `push`), no caches
without `setup`, and host mounts read-only without `push`, so nothing they leave behind (git
hooks, Claude settings) runs with a work run's token. Issues
only.

### Chats

A chat (`listener/chats.mjs`, #476) is a conversation a user starts from the dashboard, on one
repository, without an issue: `POST /api/chats` (`{ repo, agent, model, effort, message }`, all
but `repo` optional) creates it, `POST /api/chats/<id>/messages` sends the next message, `POST
/api/chats/<id>/reset` drops its volumes and session but keeps it, `DELETE /api/chats/<id>`
deletes it, and `GET /api/chats` lists the caller's own. Each is a task of its own, kind
`chat`, keyed `<repo>#chat-<id>` (16 hex digits), so its runs are any run's (`runs.mjs`): its
sandbox, tokens, capabilities, inbox, log and restarts. What differs:

- its task has an `owner` (the chat's, whose task it is alone) and a `pool`, `chats`. Every
  task has both (`tasks.mjs` `newTask()`): the others have no owner and are in `shared`, under
  `MAX_PARALLEL`, `AUTO_PICKUP_SLOTS` and the repos' `max_parallel`; `startable()`
  (`repo-config.mjs`) counts each other pool against its own cap (`chats`: `MAX_RUNNING_CHATS`,
  2; machines, #594, will add `machine:<id>`), so the auto-pickup sweep and the board's queue
  only ever see `shared`. Its first message starts its sandbox at once (no debounce). Each answer leaves its inbox open (`runs.mjs` `output()`): the
  next message goes there, and the agent's turns stream like any run's log;
- `CHAT_IDLE_MINUTES` (30) after its last message or its run's last answer, whichever came
  later (a message that waited for a slot is answered after it), its inbox closes (`runs.mjs` `rest()`), so
  the agent exits once it has answered, and the sandbox stops after the usual grace if it
  doesn't. The next message starts it again from the chat's volumes, in the same session, as
  a brainstorm resumes (`prompts.mjs` `firstMessage()`, `entrypoint.sh`). An inbox not known
  open after a restart (the runner didn't answer) is closed at the runner all the same. An
  agent that takes no message mid-run (Codex, the Antigravity CLI: `takesMessages` false) answers
  one run per message instead, each a new sandbox in the same session, which exits once it has
  answered;
- its mode is `chat` (`modes.mjs`, `prompts/chat.md`): volumes apart from the repository's
  issues (`<repo's chat name>-light-…`, a sandbox name of its own), the light runs' agent,
  model and effort unless the chat names its own, and `policy/mode-chat.rego`'s capabilities:
  the code, its reads and the setup, no `push`, no engine, no GitHub write (no `allow_github`),
  no caches (`preparation.mjs`: its workspace is its own and kept);
- nothing goes to GitHub: no reply (`runs.mjs` `post()`), no reaction, no label, no project,
  no fallback (its messages would all go to the next entry); an error that stops it is a note
  in its log;
- its owner alone lists it, reads its runs' logs and reaches it (`http.mjs`: the board, `/status`
  and analyses leave its runs out). Its state is in the orchestrator's store (`chats`, one
  value: owner, repository, default branch, agent, model, effort, title, created, last
  message, last reset), which the next copy reads once it holds the lease (`load()`); its queued
  messages and live run are any task's (the store's queue and `runs/<id>`), so a
  restart or a handover keeps them and its sandbox goes on. A chat its owner can no longer
  reach still lists, without its runs, so they can delete it;
- `CHATS_PER_USER` (2) caps the chats a user keeps, counted across the repositories; a
  repository's `chats.per_user` may lower it when a chat is created there;
- a reset or a deletion stops its sandbox (`runs.mjs` `cancel()`), waits for its end, then has
  the runner remove its session volumes (`DELETE /sessions/<name>?task=<key>`, a chat's only:
  `runner/spec-check.mjs` `chatSandbox()`); a deletion removes its runs' logs and summaries too
  (`history.mjs` `removeRun()`);
- every minute (`sweep()`), and at each message, a chat whose owner left `ALLOWED_USERS` or the
  repository's `users` (as last read), or lost `runs:start:chat` there (`permissions.mjs`), is
  stopped; its messages are refused, its volumes stay
  until it is deleted;
- its permissions profile (`listener/profiles.mjs`, #478), kept with it in the store, narrows
  what its runs get: `GET /api/chats/<id>/permissions` answers the profile, its ceiling (what a
  `chat` run of its repository gets now from the policies, the config and the operator's grant)
  and what its next run gets of it; `POST` saves one only within that ceiling (a `422` lists
  what goes beyond it); `POST /api/chats/<id>/restart` rests its sandbox, its session kept, so
  the next message starts with it. Each start narrows it again (`preparation.mjs`): see
  [security.md](security.md#chats).
- its agent asks for more within that ceiling (#479): `deckhand-permissions` in the sandbox (an
  MCP server with one tool, `request_permission`, added for a chat's run only, `TASK_PERMISSIONS`;
  and a CLI for an agent without it) asks the broker (`POST /run/permissions`, a `chat` run's
  token alone, `broker/permissions.mjs`), which says it on its `runs` stream (`permission`). The
  orchestrator (`listener/requests.mjs`, the store's `permission-requests`) checks it against
  the chat's ceiling (`profiles.mjs` `requestVerdict()`): beyond it, refused at once with the
  reason; what the sandbox has, granted; the rest waits for the owner, a card in the
  conversation (`GET /api/chats` lists them as `requests`; `POST
/api/chats/<id>/requests/<request>` with `{ answer: once | chat | deny }`), denied after
  `CHAT_PERMISSION_TIMEOUT`. The answer goes back to the broker (`PUT
/runs/:id/permissions/:request`), where the tool's long poll reads it. An approved host is
  added to the run's hosts at once (the egress proxy asks for each connection); the engine and
  mounts apply at the next start: "for this chat" saves them in the profile, "once" keeps them
  for that start alone (`chats.mjs` `startProfile()`).

The dashboard's Chats page (`dashboard/src/Chats.tsx`, #477) reads `GET /api/chats`, which
also says how many chats the user may keep (`limit`, `CHATS_PER_USER`), the repositories New
chat offers them (`repos`: those the App lists, in `ALLOWED_REPOS`, among whose `users` they
are, with `runs:start:chat`) and the agents it offers (`agents`: what `/agent` may pick). Each
chat lists its messages not delivered yet (`pending`). Its conversation is its runs' logs, read
as any run's (`/api/runs/<id>/stream`): a chat run's first line and its delivered messages are
`message` entries (`runlog.mjs`), the owner's turns, rather than notes. It reads nothing of the
chat's sandbox, so a chat whose agent runs elsewhere (#601) shows the same way. Who reaches a
chat, what it may do and where its data lives: [security.md](security.md#chats).

### Modes

A `/mode <name>` line picks a mode: work, brainstorm or one of the repo's own (its config's
`modes:`), with the trigger line, or alone on an issue that has a session, which then goes on
in the new mode with its conversation so far. A repo's mode brings its own instructions,
model and effort (work's by default) and shares the issue's volumes; a fresh one starts a new
session each time. What a mode's runs get, write and push is the policies' only
(`allow_capabilities`, `allow_github`, `allow_push`): a mode itself has no trait for it. A
built-in mode's `MODES` entry keeps where its volumes are (`volumes`: `apart`, `research`) and
whose agent and model it defaults to (`defaults`: `brainstorm`, the light runs'). Comments without a trigger or `/mode`
line go on in the issue's current mode (the store's `modes`).

`/mode research` (repos granted `research`: [the grants](security.md#the-grants)) is a built-in
mode for the open web (`volumes: "research"` in `modes.mjs`, `internet` alone in
`policy/mode-research.rego`): any public host (`researchAccess()` in `access.mjs`), and nothing of
the repo's. No clone (`SANDBOX_NO_CLONE`), no GitHub token (no `pull` capability,
so the GitHub gateway refuses it: GitHub's hosts aren't relayed for it, and it reads public
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
trigger line or `/mode work` opens the pull request, and the reply says what the orchestrator
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
posted: <status>". An orchestrator restarting before then posts it again (`live.replied` is still
false).

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

An issue can wait for answers without a run stopping to ask: inbox runs file issues with an
**Open questions** section, and people write some by hand. When an allowed user or the App's bot
opens an issue whose `## Open questions` section asks something (its first paragraph isn't
"None"), the orchestrator labels it. So settled questions don't stay there: a brainstorm's wrap-up
moves them, with their answers, to a **Decisions** section and leaves "None" alone when nothing
is left (`prompts/brainstorm.md`). An edit to Open questions adds or removes the label as it now
reads: ticked boxes are answers, so a section where every question has an option ticked (`- [x]`,
`allTicked()`) and none is free text no longer asks, and the edit that ticks the last one takes
the label off and releases what waited for the answers, as a comment would; unticking them labels
it again (`stillAsks()`). Only an allowed user's ticks answer: the App's bot's (a run ticking its
own picks) and those of someone the orchestrator doesn't act for (not allowed, or narrowed out by the
repo's `users`) answer nothing. An issue the bot opens is labelled all the same, at open and by
the backlog read below. An edit that leaves a section fully ticked without taking the label off
(the bot's, someone not allowed, a refusal in `applyInput()`) marks the issue's entry in
the store's `inputs` (`ignoredTicks`) until an allowed user's edit; on the bot's issues and marked ones,
`wait_for_answers` goes by the label, which only an allowed user's edit takes off. Its limit: an
edit whose delivery was missed (edge down, and never redelivered) isn't marked, so its ticks count for `wait_for_answers`
(the label still shows it waits). A closed issue's edit doesn't list it again. The backlog read
lists a fully ticked issue that still carries the label. An allowed user's comment on a labelled
issue or pull request takes the label off: they answered. The dashboard lists the open issues
carrying the label as `needs-input`, with a run or not (the store's `inputs`, kept by `issues`
deliveries, whoever adds or removes the label, and one lookup per repo when the orchestrator starts);
a closed issue leaves the list.

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

With the repo's `wait_for_answers` (on by default, `docs/repo-config.md`), the label holds work
back. `tasks.mjs` `admit()` reads it from the comment's payload: a trigger comment with no text
besides its command lines (`saysMore()`), asking for work or one of the repo's own modes, on an
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
them in `api/state` (`questions`): from the reply of its last run when that run stopped to ask
(kept on the run, and read again from its log after a restart), else from its issue's body
(kept in the store's `inputs` with the entry, from the `issues` deliveries and the startup lookup).

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
the store's `reviews`, saved before the run is queued). Each task's pull request in `api/state` has
its head commit (`head`, from its deliveries, `synchronize` included, the start-up listing and
Sync: `pulls.mjs`): the dashboard marks a review outdated when the loop is over and the last
round's `head` differs (`reviewOutdated()`).

A failed or interrupted task stops asking for attention (Waiting on you, the Failed tile, the
Error chip, its repository card's "failed" count) once its issue is closed or its pull request
merged or closed: what can't run again shouldn't ask to. It keeps its state, runs and page.
For an open one, **Dismiss** (on its Waiting on you row and its page; the last run `error`,
`interrupted` or `cancelled`) does the same: `POST /api/repos/<owner>/<repo>/dismiss { runId }`
(`work.mjs` `dismiss`, the repo's users, the task's latest run only) keeps `task key → { runId,
by, at }` in the store's `dismissed` (`dismissals.mjs`), and `board.mjs` marks the task `dismissed: {
by, at }` while that run is still its last and it still ended so. Any new run shows it again;
the stale entry is dropped on the next start. `{ runId, undo: true }` takes it back. Nothing is
posted on GitHub: it only matters to the dashboard.

When every slot is taken (`MAX_PARALLEL`, or a repo's `max_parallel`), the **run order**
decides which queued task starts next (issue #413). `tasks.mjs` `queueOrder()` sorts the tasks
waiting for a slot: light runs (the built-in modes with volumes of their own: brainstorms…) first, then those the
maintainer placed, in the order the store's `order` keeps (`order.mjs`, by lowercase task key,
respelled at start with the rest), then the others by when their first pending comment was
queued (`queuedAt`, kept with the queue through a restart). `schedule()` hands the ready ones
to `startable()` in that order, which still skips a task whose repo is at its cap and starts the
next. `POST /api/repos/<owner>/<repo>/order { key, before?: key, after?: key, first?: true }`
(`work.mjs` `reorder`, the repo's users, a queued task of the repo that isn't a light run; `before` and
`after` another of the repo's, none of them: last) writes the whole current order with the task
moved, so moving one past tasks nobody placed keeps them where they were. Move down sends
`after`: the task goes right after the next of its repo's (another repo's tasks between them
come up before it), not to the end of the line. A key leaves the order when its run starts or
its queued comments are dropped (`runs.mjs`); `schedule()` drops any other key of a task with no
comments left or a run going, and so does the start, after `loadQueue()` (the comments it
dropped, their author no longer allowed, leave their keys behind). `api/state`
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
private (checked again when the run starts): a public one's digest leaves out the orchestrator's notes, setup output and failed
tools' outputs. No comment can ask for that mode.

`analyze` is a built-in mode with volumes of its own (`modes.mjs`): a fresh session, the
model of light runs (`brainstorm_model`), and, with Deckhand's default policies
(`policy/mode-analyze.rego`), no branch, no setup and a token that only reads, so the reply is the
report and the issue stays as its record. When the run starts (`preparation.mjs`
`analysisDigest()`), the orchestrator builds the digest of the runs picked that are still listed
and of that repository: for each, its meta line (kind, agent, model, effort, status,
duration), the orchestrator's notes, setup output that looks wrong (errors, refused hosts), its
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
on the orchestrator, and keep each run's part in memory once built (a finished run's log no
longer changes).

Reactions on the triggering comment follow its run: 👀 when it is received, then 🚀 (done),
😕 (needs input) or 👎 (error) once the run that handled it is over.

### A run's log

A run's log holds the orchestrator's own lines and the sandbox's output as it came. The runner
service keeps it, as a blob of its store (`logs/<run>`, [The runner
service](#the-runner-service)); the orchestrator writes it there as it goes (`runner/client.mjs`
`openRemote()`), and the dashboard's live view reads it from there. The orchestrator also writes a `phase` line at each change of the run's part, with when it
started (`runlog.mjs` `enterPhase()`, its state saved for a restart): `setup` as the run
begins, `image` while the repo's image builds (then `setup` again: the sandbox starts after
the build), `work` at the agent's first event, `push` at a shell command that runs `git push` or
`gh pr create|edit|ready|merge` as a command of its own (not one quoted in a `grep`), and
`work` again at the next other tool call, `wrap-up` after its final answer. A phase whose line
wouldn't fit under `RUN_LOG_MAX_MB` isn't written. Logs from before phases have none, and read as one Work section.

The runner keeps a log in segments (`runner/logs.mjs`, #607), so that the closed ones can leave
its store while the run goes on: `logs/<run>/<n>`, and an index (`logs/<run>/index`: each closed
segment's first byte, size and where it is, and where the open one, the last, starts). Only the
open one is appended to. It closes at a step of the run (a `phase` line, which the orchestrator
sends at the start of an append of its own, marked `step=1`), at `LOG_SEGMENT_MB` (8 MB by
default), whichever comes first, and at the run's end (an empty append marked `close=1`, from
`teardown()`),
and again when the run's sandbox is removed (`DELETE /sandboxes/<name>?run=<run>`), should an
orchestrator stopped before its close never send it (#664). Closing takes two compare-and-sets of the index: one marks the open segment
`closing`, then whichever copy of the runner gets there first records its size as it is then.
An append reads the index again after its write: a segment marked or closed meanwhile tells it
whether its bytes are inside, and one past a closed segment's end is answered with the log's
size, as a conflict, so two copies handing over never lose or repeat bytes. Callers only ever
see offsets in the whole log: appends name the offset they go at, and a read answers from the
one segment holding its offset (`MAX_READ` at most). A log written before segments
(`logs/<run>`, one blob) reads as one closed segment and is appended to as it was, and an
orchestrator of the release before marks no step: its runs' logs close at the size cap only.

With blob storage (`BLOB_URL`, #608), each closed segment leaves the store: copied there under
the same key and measured (`HEAD`), then the index points at it (`where: "blobs"`, one
compare-and-set), then it is deleted from the store. It is in one place or the other at every
moment, and a read takes the index, then the store's blob or a ranged GET; one that finds the
store's blob gone reads the index again. Each closing is noted in a stream of the runner's store
(`log-moves`, written before the index says the segment is closed, so a copy stopping in between
leaves a note too many, never one too few), which the copy holding the runner's lease reads as
it gets the lease, at each closing, and every five minutes, acknowledging a note once its move is
done: a move cut short after any step is done again from the start, which does no harm. While
blob storage fails, the notes stay, tried again after a delay that doubles from 30 s to 30
minutes, and the runner's `/health` counts them and their bytes (a warning on the dashboard's
status page; the count is kept in its store, so either copy says it, and a segment noted twice
counts once). `/health` answers it from memory, never waiting on the store: the copy acting
knows it from its passes, the other reads it again in the background every 10 s at most. A pass
that fails after its copy lost the lease says nothing of it: that is the next holder's. A copy losing the lease stops its pass at the next note. A segment whose copy
measures otherwise in blob storage (trying again would send the same bytes) is logged and left
in the store, and the notes after it go on. Retention deletes a log's segments in blob storage first, then its index: one that
fails stays for the next day's pass.

Some closed segments have no note (#671): those closed while `BLOB_URL` was unset, and those the
release before the notes closed as it handed over. The first copy acting with blob storage
notes them before its first pass, from the logs' indexes (`logs/<run>/index`, the only values
under `logs/`, listed once): a key of its store (`log-moves/swept`) says it was done, so the
next holder doesn't list them again, and a copy acting without blob storage deletes it, so that
setting `BLOB_URL` again sweeps again. A sweep cut short by the lease going is done again by the
next holder; a segment noted twice moves once.

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
lines (`buildOutput()`), with an `at` line, at the orchestrator's time, before each step's first
line. Logs from before `at` lines have none, and show no times.

The log stream (`stream()`) reads lines in order (`reader()`): in the image phase, BuildKit's
plain progress (`#12 [build 5/9] RUN npm ci`, `#12 CACHED`, `#12 DONE 41.2s`,
`#12 ERROR: …`) comes as `step` entries, one when a step starts and one each time its status
changes, and its output as `raw` entries with the step's number; the lines of no step
(BuildKit's error summary) stay `raw`. An `at` line gives no entry: its time goes on the next
line's `tool`, `output` and starting `step` entries (`at`, ms). `dashboard/src/types.ts`
`Entry` is the contract.

### Hot and cold

The runner and the broker keep blobs in two places (#604). **Hot**, their store (`STORE_URL`, file
or Redis), holds what is still being written: only it appends at an offset in one atomic step
(`appendBlobAt()`), which a live log and an inbox need, as two copies may write at once and a
retry must add nothing. **Cold**, blob storage (`BLOB_URL`, `lib/blobs.mjs`: S3 through
`lib/s3.mjs`, or a folder), holds what will never change again: written in one PUT, read with
ranged GETs, as `readBlob(key, { offset, length })` reads the store, and deleted object by object
by retention. S3 has no append, and an upload in parts can't be read before it completes: a blob
is cold only once closed.

| Blob                         | Service | Hot (the store)                                      | Cold (blob storage)                      |
| ---------------------------- | ------- | ---------------------------------------------------- | ---------------------------------------- |
| a run's log (`logs/<run>/…`) | runner  | its index, and its open segment while it is written  | each closed segment, moved as it closes  |
| a screenshot (`shots/…`)     | broker  | the run's folder's names and sizes (`shots:<token>`) | the file, written once as it is uploaded |
| a run's inbox, CA, digest    | broker  | all of it: appended to while the run goes on         | none: they go with the run's end         |

So once the moves have caught up, the store holds one open segment per live run, however long
the runs: the size Redis needs no longer grows with the history kept (`LOG_RETENTION_DAYS`).
An append never waits on a move: while a log is written faster than blob storage takes its
segments, the closed ones wait in the store, as many as the lag makes, as they do while blob
storage fails. One measurement (`test/blob-acceptance.test.mjs`, #604): a 500 MB log written
as fast as the runner took it, on Redis with Garage on the same machine, peaked at 12 MB in
Redis, and kept 8 MB once its moves caught up; a slower server would let more wait. Without `BLOB_URL`,
the store's own blobs stand in for blob storage (`storeBlobs()`, the same interface), and
nothing moves: an install that never sets it works as before.

**Restarts**: a log's move is three steps, each one a single write (the copy in blob storage,
the index pointing at it, the store's segment deleted), noted before it starts in a stream of
the runner's store (`log-moves`), which the copy holding the runner's lease reads as it gets the
lease: a move cut short at any step, by a restart, a handover or blob storage away, is done
again from its start, and a read finds the segment in one place or the other at every moment
([A run's log](#a-runs-log)). A screenshot's name goes in the store before its file goes to
blob storage, so an upload cut short leaves a name retention deletes, never a file it would
miss: blob storage lists nothing, and needs no listing. Each service checks its blob storage as
it starts (an object written, read back and deleted): a wrong key or bucket stops it there, rather
than at a run's end.

## Around the runs

- **GitHub**: the operator's private App, created at `/setup`, its key in the github service
  alone ([below](#the-github-service)), which makes the orchestrator's (and edge's) GitHub calls
  with installation tokens neither of them nor a sandbox gets. A sandbox holds a
  run token (`lib/tokens.mjs`): a JWT the broker service (`broker/`, #505) signs with Ed25519,
  the only one holding the key, which every service checks offline with its public keys
  (`broker.mjs` in the orchestrator), bound to the ID of the run's network (or pod), 15 minutes
  long and renewed by the sandbox every 5 with the broker service, through the egress proxy
  (`POST /run/token`, `deckhand-token --renew`, a file on a tmpfs rather than a variable); its
  `gh` and git hand it out as their
  token (security.md, Run tokens); the egress proxy decrypts its calls to GitHub's hosts (with Deckhand's CA, which
  every run but research trusts) and relays them to the GitHub gateway (`github-gateway.mjs`,
  in the github service), naming the network (or pod) of the sandbox they came from, as the
  orchestrator's egress policy found it (`runner.locate()`, never its engine's), which the service
  believes from the proxy alone. The gateway finds the run by its token (bound to that network)
  or, without one, by that network; refuses finished, foreign,
  research and push calls and a review's reads of its thread; refuses a work run that isn't a
  fork's what would bring a fork's code (`github-forks.mjs`: a fork's repository, a fork's
  pull request's head, a commit that isn't the repository's, by git, the API, an archive, a
  page (any other of the repository's refused) or a file, Actions logs fetched from where
  GitHub redirects them (`ACTIONS_LOGS`, no credential sent there), GitHub's content hosts
  (`*.githubusercontent.com`) relayed too for such a run and sent on without a token; no branch
  it pushes reaching a fork's objects (the git gateway); its clone is whole, as a blob fetched
  by its id is refused to it);
  redacts every write's body
  (`redact()`, the run's tokens, and the operator's credentials by their fingerprints,
  `lib/fingerprints.mjs`) and notes it in the run's log; holds each
  REST write to its built-in checks and the policies' `allow_github` and `deny_github`
  (`github-writes.mjs`, its target's kind looked up with the service's token; Deckhand's
  defaults allow each mode its writes in `policy/mode-<mode>.rego`, and without policies every
  write is refused); parses and validates its GraphQL
  against GitHub's pinned schema and holds each mutation field to the same checks, its node
  IDs looked up likewise, forwarding the document printed again (`github-graphql.mjs`); and
  sends the call on with a token limited to the run's repo that only reads what its
  capabilities give (`readsOf()`; its own issue alone without `read:issues`), a write that
  passed getting one with only the write permission it needs besides (`github-writes.mjs`
  `writePermissions()`), streaming the
  answer back (`lib/upstream.mjs` `forward()`). The CA certifies GitHub for this
  (`proxy/authority.mjs` `EXCLUDED` keeps only the agents' providers): no sandbox's GitHub
  traffic carries a token any more, so a leaked CA key opens none. Those
  tokens only read the code: pushes go
  through the git gateway, the github service's too (the sandboxes push to its name,
  `http://github:8080`, which the proxy sends there), which only lets through the run's own branches,
  each then asked of the policies' `allow_push` and `deny_push` (`pushInput()`; Deckhand's
  default allows work runs'), and, for a repository granted `workflows`, workflow files
  that only read and name no secret (with `workflow_secrets` too, but those only the default
  branch's copy of runs), checked against a mirror of the repository in the github service's
  volume; `gh pr create`, `gh pr edit` and `gh pr ready [--undo]` are GraphQL writes like any
  other, which Deckhand's default policies allow to work runs for their own pull requests only:
  before them, `github-pulls.mjs` checks the pull request's head is one of the run's branches, its workflow
  files (for a repository granted `workflows`, as a push's) and its conflicts before
  ready, and the one call goes on with the token it needs (`pull_requests: write` to
  open or edit one, `contents: write` to ready or draft it), which no other call gets: no
  sandbox can approve or merge one. A run without `push` can't push or change a pull request.
- **Dashboard**: `GET /` shows every repo's issues and pull requests, their state and live
  logs, to `ALLOWED_USERS` signed in with GitHub through the App, built from `dashboard/`.
  Edge serves its files and signs users in; their API calls it passes on to the orchestrator,
  which answers them (`listener/http.mjs`), with the signed-in user. `GET /status` says what is
  going on, to them and to calls from inside edge's container.
  Both say which Deckhand runs and since when (`server` in `api/state`, `version` and
  `startedAt` in `/status`, from `status.mjs` `serverInfo()`): the Repositories page shows
  it, the version linked to its commit or release under `DECKHAND_SOURCE`. `GET api/server`
  says how it is set up (`status.mjs` `serverSetup()`), for Settings › Server: the container
  engine, the egress proxy and how many hosts the grants folder grants, whether that folder
  reads without errors (the files to fix, never their errors, which quote mount roots: a repo's config panel shows its own), which Claude credentials are set, which one runs use first and which ones `FALLBACKS` names (variable names only), `ALLOWED_USERS` and `ALLOWED_REPOS`. It scans the grants folder, so
  the page reads it when it opens rather than at each poll.
  `api/state`'s `access` says what the signed-in user may do (#732: `permissions.mjs`
  `dashboard()`): their server-wide actions, and on each repo they see, its actions and the
  modes they may start runs in, so that the dashboard shows only the controls the orchestrator
  wouldn't refuse (`dashboard/src/access.ts`). `GET api/access`, for Settings › Access and
  `server:read` only, says each of `ALLOWED_USERS`'s actions, server-wide and on each listed
  repo, with the files that decided them (`report()`), read when the page opens.
- **The services' health** (#560): `GET api/health` says whether each service is `up`,
  `starting` (started less than 5 minutes ago: a restart, an update) or `down` (no answer within
  2 s, a refused connection, a status other than 2xx, `ok: false`), with when it started, its
  version and, when down, why in a word (`timeout`, `refused`, `HTTP 503`): never its URL or
  what it answered beyond that. The orchestrator asks each service's `GET /health` it has a URL
  for (`EDGE_URL`'s internal port, `RUNNER_URL`, `BROKER_SERVICE_URL`, `GITHUB_SERVICE_URL`,
  `MODELS_SERVICE_URL`, `POLICY_SERVICE_URL`, `EGRESS_PROXY`), all at once, and keeps the
  answer 10 s, however many dashboards ask (`health.mjs`); it reports itself from its own start.
  Behind a Kubernetes Service, one ready copy answers: whether it can be reached, not each copy.
  Settings › Server shows it under the listener's status (`dashboard/src/Health.tsx`): [the
  services' diagram](services.md), each service in its state's colour (green, blue, red) and
  words ("up 3 d 4 h", "started 2 min ago", "unreachable: timeout"), with a legend; a list on a
  phone. The page reads it every 15 s while open, the shell every minute, for a dot by
  Deckhand's name (red when a service is down, else blue when one is starting) that opens the
  page.
- **Screenshots**: `GET /shots/<token>/<file>` (edge's, passed on to the broker, which
  keeps them, #609) serves the screenshots runs save for their
  pull requests: GitHub cannot take image uploads through its API, so they need a public URL.
  Sandboxes upload them through the broker ([Run files](#run-files)).
- **Per-repo config**: each repo may bring a `.deckhand.yaml` on its default branch: its own
  trigger word, models, parallel cap and users (only narrowing the operator's), a setup
  command and extra instructions for the sandbox, a Dockerfile `FROM` the base image, cache
  volumes and a container engine for its work runs (the Dockerfile and the engine only with
  the operator's grant: an `allow_grant` rule of theirs, `grants.mjs` `GRANTS`). A config with
  errors stops runs, and the reply says why.
- **Isolation**: sandboxes run with no capabilities, `no-new-privileges` and CPU, memory and
  pids limits, each on an internal network of its own (created with the run, checked, and
  removed with it), shared only with the egress proxy (`proxy/proxy.mjs`), its only way out: the proxy asks the orchestrator's egress policy, for each connection, whether the
  sandbox at that address may reach that host. Sandboxes can't reach each other. Host mounts only happen under roots the
  operator grants the repo (`GRANTS_DIR`, one file per repo).
- **Container engine**: a run with the `docker` capability, of a repo granted `docker` (with `docker` in its
  config and the operator's `SANDBOX_ENGINE`) gets a second container on its network,
  `engine` (`runner/engine.mjs`: dockerd under Sysbox, or rootless Podman), started before
  the sandbox and removed with it; the sandbox's `docker` CLI talks to it (`DOCKER_HOST`),
  and its address counts as the sandbox's for the egress proxy. On Kubernetes (#573), Sysbox's
  dockerd is a sidecar in the sandbox's pod instead (`runner/kubernetes.mjs`, under
  `KUBERNETES_ENGINE_RUNTIME_CLASS`), which shares the sandbox's address: it reaches the proxy on
  its engines' port (3129), which the proxy tells the policy (`engine=1`). Never for a fork's
  pull request; Deckhand's default policies give it to work runs only.
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
kept in the store's `conflicts`, so the same pair never starts a second run, even after a restart.
Before the item is queued, the repo's policies are asked (`deny_fix`, `reason: "conflict"`,
the review and fix input of `reviews.mjs` `readPullInput()`, through `policies.mjs`
`denyKept()`, which keeps the decision for the task's page). A refusal queues nothing and is
kept as the pair's attempt: a "No rebase run" comment quotes its messages, and once posted they
are kept with it (`said`), so a later pair refused for the same ones isn't said again (a base
that keeps moving says it once). A refusal because GitHub couldn't be read (`unread`: the
policies or the input) keeps no pair, nor a decision for the task's page (`keepUnread: false`): it is the repo's error for that pass, asked again at the
next check, as any GitHub error there. What each check read is also passed to `pulls.mjs`
(`sawMerge()`), so the dashboard's `pr.conflict` is current for those repos too. In every repo,
it also comes from the `pull_request` deliveries (mostly `mergeable: null`: GitHub computes it
after sending them), from the dashboard's Sync, which reads each open pull request itself
(`resync({ all })`: a listing has no `mergeable`), a few at a time once its answer is sent, and
from `pulls.mjs` `baseMoved()`: the same deliveries and auto-merge that call `soon()` read the
repo's open pull requests again after `CONFLICT_MERGE_DELAY_MS`, and once more later those
GitHub hadn't computed yet, since a base that moves changes it at the same head without a
delivery. A read that says nothing keeps the
last value known.

The dashboard's Sync runs the same pass at once (`check()`), with every opted-in repo due
whatever its interval, and resets their next check as a tick does. During a tick, it waits for
it, then checks the repos the tick left (not due), so no repo is checked twice and none is
left out; another check meanwhile shares that. It resolves to the rebase runs it started, the
errors of the repos it couldn't check (Sync's `error`) and the pull requests GitHub hadn't
computed yet, which are left to the next tick (their repo is due at once) rather than
making Sync wait. The orchestrator's own sync at start doesn't run it: the first tick after a
restart checks every repo anyway, once the queue is restored.

## Reviews

A repo whose `.deckhand.yaml` has a `review` block gets the built-in `review` mode
(`modes.mjs`: volumes of its own, fresh; `policy/mode-review.rego`: no write). `/mode review` on a pull request starts one;
with `review.on: ready`, `reviews.mjs` also starts one from a `pull_request` delivery
(`ready_for_review`, or `opened` when not a draft) for a pull request on a branch of the repo,
opened by the App, an allowed user, or another bot (left to `deny_review`, which Deckhand's
`policy/review.rego` refuses). A policy that fails (a policy error: GitHub couldn't give
its input, `opa` timed out) rather than refuses is asked once more 10 seconds later
(`asking()`, the review after a fix run's too); a `deny_review` still failing then on a pull request that turned ready
is kept as `policyRetry` ({ sha, base, tries }) in the store's `reviews` and asked again at the next
`tick()`s, three times at most (a pull request GitHub can't give then counts as one), unless
it was closed, made a draft or pushed to since. It is a work item as if from a comment (`trigger:
"review"`, no comment, `reason: "review"`), on the task of the issue the pull request closes
or the pull request's own. Each pull request's reviewed head commit is kept in
the store's `reviews`, so a redelivery, a restart or the same commit again starts none. Its thread
is a file in the run's inbox (`TASK_DIGEST`, `reviewThread()`, written by `preparation.mjs`):
the pull request's and its issue's, with what users outside the allowlist wrote left out. The run's
final message follows `prompts/review.md`'s format; `runs.mjs` hands it to `postReview()`,
which posts one GitHub review as the App (its installation token, through the github service): findings grouped by severity, the
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
`conflicts.mjs` does for a rebase. `fixes` in the store's `reviews`, counted before the item is
queued, bounds it to `review.fix`'s rounds (`fixedAt` alone, in an entry from before them, is
one). A review with nothing above `max_allowed_severity` (`tolerance()`) starts none, and
without auto-merge a review that still requests changes once the rounds ran out comments so
(`roundsOut()`).

With `review.merge` and the operator's `auto_merge` grant (`grants.mjs`
`autoMergeProblems()`), `settle()` goes on, for a review that started by itself (an item with
`reason: "review"`, not a `/mode review` comment's) and started no fix run: `autoMerge()`
re-reads the repo's settings and grant, records `mergeAt` (one decision per pull request),
checks `mergeBlockers()` and the gates (`mergeRefusal()`: the pull request, its labels, its
head, the repository's visibility and merge methods, its changed files against
`trustedFile()`, `mergeable_state`, its Actions runs, last the policies' `deny_merge`), then merges as the App at
the reviewed head (`PUT /pulls/{n}/merge` with `sha`) or comments why not. When only Actions
runs still going stand in the way (`mergeRefusal()`'s `pending`), `decide()` clears `mergeAt`
and keeps `waiting` ({ sha, since, review, … }) in the store's `reviews` instead: `checksDone()`, on a
`workflow_run` `completed` delivery for that sha (`http.mjs`), and `tick()`, every 5 minutes,
decide again (`recheck()`, one at a time per pull request), until `review.merge_wait` minutes
after `since`, when the pull request is refused. `waiting` stays saved until such a decision
ends (an in-memory map keeps it to one at a time), so an orchestrator stopped meanwhile asks again,
and a GitHub call failing then waits for the next try. A merge is recorded
on the task's pull request (`pulls.mjs`, `autoMerged`) for the dashboard. A fix run's end
(an item with `reason: "review-fix"`, in `cleanUp()`) calls `reviews.fixed()`: in
auto-merge mode or with more than one round (`fix: true` without `merge` stops at its fix run),
one more review of what it pushed, once per fix run (`reviewedFixes`;
`rereviewAt` in an old entry), whose end starts the next round or stops the loop
(`settle()`), or, in auto-merge mode, a comment when it failed or pushed nothing. At start,
`server.mjs` logs a warning for each policy file of the grants folder whose `allow_grant` rules
name `auto_merge` or `auto_merge_public`.

With `review.ci: wait`, every automatic review goes through `reviewAfterCi()` first
(`consider()`, `reviewFix()`, and the end of a CI fix run): it keeps `ciWaiting` ({ sha, since,
base, author }) in the store's `reviews` and decides with `ciDecide()` (one at a time per pull request,
a promise chain), again on a `workflow_run` `completed` delivery for that sha (`checksDone()`),
on a `pull_request` `synchronize` (`pushed()`, which moves the wait to the new head) and from
`tick()`. `ciState()` (`ci.mjs`, which also sorts check runs and commit statuses, for when they
are read) sorts the head commit's Actions runs into `failed`, `running`, `passed`
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
to its pull request's `rounds` in the store's `reviews` (`recordRound()`): `{ round, at, head,
counts: { critical, high, medium, low }, blocking }`, `round` the fix runs before it (0 for the
first review), `blocking` the findings above the tolerance, counts only, never the findings'
text, with `fixRounds`, what `review.fix` allows. An entry from before has none, and shows no
loop. `reviewLoop()` derives where the loop is from that entry and the reason of the task's
run going or queued (`board.mjs`, the task's pull request from `pulls.mjs`, as the store's `reviews`
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
(`stepsGoing()`, a CI fix run's `next: "ci-fix"` too): an orchestrator stopped while it decided never
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
round's counts, marking those whose blocking count didn't go down. The orchestrator's behaviour
doesn't change: the loop still runs all its rounds.

## Waiting for other issues

`/after #77 #80` (on the trigger line or its own line, same repo only; `events.mjs`
`parseAfter()`) holds a trigger comment back until each of those is done: an issue closed as
completed (or before GitHub recorded reasons), a pull request merged. `waits.mjs` asks GitHub
for their state at once: all done, the comment runs now; one closed without being done (not
planned, a duplicate, a pull request closed unmerged) or missing, it is refused. Otherwise
the comment keeps its 👀, the reply says what it waits for, and the task's one wait (task key
→ the issues left and the comment, as `restart.mjs` saves it) goes to the store's `waits`.

An `issues` or `pull_request` `closed` delivery for an allowed repo (`closedItem()`) updates
the waits on it. Any other `issues`, `issue_comment` or `pull_request` delivery about an issue
or pull request waited for, or about the issue a pull request closes (`touchedItems()`), and
the end of a run on one, ask GitHub about that one only (`recheck()`, nothing when no wait is
for it): a pull request merged into the default branch closes its issue without an `issues`
delivery to an App that lacks that event, so its issue is asked about at once, and again 30
seconds later if GitHub hasn't closed it yet (`merged()`). GitHub is also asked about every
wait at each start and every `WAITS_CHECK_MINUTES` (5), so a delivery missed (edge down,
never redelivered) still counts. When the last one is done, `tasks.resume()`
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
`sub_issues_summary`) brings its whole tree along (`plan`, `plans.mjs`): the orchestrator reads its
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
in memory, so coming back to the graph or a repo's tab shows it at once. The orchestrator writes
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
copy of the orchestrator restarting between the cancel and the exit reads it from the saved state, stops the
sandbox again if it still runs, and ends it as cancelled rather than queueing its comments
again; the dashboard's list reads it from the log's `cancelled` line. A cancelled run is
`rerunnable`.

## The policy service

Every policy decision goes to the policy service (`policy-service/`, #501), a container of its
own beside the orchestrator ([services.md](services.md)):
the orchestrator starts no `opa`. `listener/policies.mjs` keeps what a decision means (its input, which layers
are asked, what a refusal says) and reads a repository's `.deckhand/policy/` from GitHub, which
it sends with each call; the service reads Deckhand's policies (its image) and the operator's
(the grants folder, mounted read-only), and answers four calls, each with a service token
(`policy-service/service.mjs`). The runner may call the first two, for the operator's
[grants](security.md#the-grants) (`grant`, the operator's layer alone), never the others:

- `GET /policies`: the operator's layer as it reads it now, Deckhand's files and the
  operator's, for the dashboard's Policies tab and `/mode policy`; the orchestrator keeps Deckhand's
  files from it, and checks the operator's are the ones it reads in its own grants folder;
- `POST /evaluate`: a decision's rules on its input, the repository's files sent, each layer's
  allow and deny. The orchestrator reads the operator's folder itself and sends a digest of the
  operator's layer (`lib/policy-files.mjs`), required of every caller, which the service refuses when its own is another;
  the orchestrator then asks `GET /policies` again (a copy of another version) and tries once more.
  So a decision is one call, attributed to the files it was evaluated on. Deckhand's files are
  kept 30 s (`DEFAULTS_MS`), then asked again: a `merge` or `fix` only they allow is decided
  without a call, so a service updated to other defaults is seen within that time;
- `POST /capabilities`: what runs get as they start (#495), the capabilities' rules on several
  inputs in one query (a run's, or each mode of a config page), the digest sent as for a
  decision: for each input and layer, the whole rules' allow and deny, and each file's own,
  which `listener/policies.mjs` turns into what was allowed and denied, and by which file;
- `POST /access`: who may do what (#730), the orchestrator's alone: the access rules' sets
  (`allow_access`, `deny_access`), evaluated as the capabilities' are, for a login on a
  repository or server-wide (`listener/policies.mjs` `access()`);
- `POST /check`: a layer's compile errors, the config checks'.

Its engine (`policy-service/engine.mjs`) keeps a few long-lived `opa run --server`
(`policy-service/opa.mjs`), each with one policy set loaded at its start (the operator's layer,
with or without one repository's), on a Unix socket in its own temp folder. A set is checked
first with `opa check` and the restricted capabilities file, then served, each file's
capabilities' rules renamed apart with their union beside them (`lib/policy-files.mjs`
`byFile()`), so that one server answers both what a file decided and every rule that reads the
whole set; a set that doesn't
compile is remembered as such until its files change. A decision is one query of its set's
server, cut after 2 s (which cancels it in `opa`); an edit of the operator's policies makes a
new set, whose server starts at the next decision, and the least recently used idle servers
stop past 8. It keeps no state: any copy answers any decision.

On SIGTERM it drains (`lib/drain.mjs`, 25 s, compose's `stop_grace_period` is 30 s): `/ready`
answers 503, the decisions in flight finish, then its servers stop. The orchestrator's client
(`policy-client.mjs`) tries a call again while the service refuses its connection or answers
503, for 30 s, so a restart of the service delays decisions rather than refusing them (with
two copies and a rolling update, the next copy takes them at once); after that, or for any other
failure, the decision is refused with a `policy error` (fail closed).

## Restarts

The orchestrator can restart at any time (an update is `docker compose pull && up -d`), or
stop without warning (a crash, an OOM kill). Sandboxes run detached, through the runner
service, which outlives the orchestrator (and the orchestrator it), and what drives the
orchestrator's decisions is saved as it changes, never only on SIGTERM (#508), so that a copy
killed at any moment leaves the next one the same as one that stopped. All of it is in its store,
nothing in a file of its own (#613, #619): with the file store, its `data` volume holds the
store's folder alone; with Redis, it has no volume, runs with a read-only root, and a copy on any
node takes over:

- **the queue**: the comments waiting for a run, in the store (`lib/store.mjs`, key `queue`), written whole whenever it changes
  (`restart.mjs` `saveQueue()`: a comment accepted, taken by a run or a running session,
  dropped, cancelled, put back by a run's end), with each task's `next` (`/model`, `/effort`
  for its next run) and the 👀 each comment got (saved once GitHub answers, the comment itself
  at once; on SIGTERM, those on their way are waited for, 10 s at most). Each comment has a `queueId` (one saved before them gets one as it comes back), and is loaded once whatever holds it. Its strings go there without the operator's secrets, GitHub tokens or private keys (`lib/store.mjs` `storable()`, from the same rules the store refuses a write by): a comment holding one by mistake is saved without it, and the whole queue still is. A run's end whose queue write fails keeps the queue in memory and tries again every 5 s (`removeLive()`, `QUEUE_RETRY_MS`) until it lands or the copy stops, the run holding its task meanwhile (no other run starts for it); its state is removed only after that write, so a copy that stops first leaves the next one the comments in the run's state. A `logs/<run>.queued.json` a release before #617 left (its way of keeping a task's queue when the store refused it) is read with the queue at the next start and removed after the next write that succeeds;
- **the runs**: each run's state in the store, key `runs/<id>` (`saveLive()`), at its start, a
  comment delivered, a phase, a result, a push, its reply; and, within a second
  (`saveLiveSoon()`), the lines of its output read so far; listed at the takeover
  (`restoreRuns()`). Never the run's tokens (#617): the next copy asks the broker service for
  those still valid (`POST /runs/:id/secrets`, its renewed ones included) and keeps them in
  memory only, to redact the run's output, asking again on each `renewed` event of the broker's
  stream. A `logs/<run>.live.json` a release before #617 left is moved there at the next start,
  its tokens dropped (the broker service is told them once, and keeps them sealed), then removed;
- **the timers, as deadlines**: a task's pause before its run (or before the comments go to
  its running session) is `dueAt`, saved with the queue; a run's silent-end grace
  (`ANSWER_GRACE_MS`) is `graceUntil`, saved with the run (re-armed once the follow has skipped the lines read before, its whole grace until then: the runner's `onCaughtUp()`, unless a new line pushed it back first; one that passed while no copy acted gets 10 s more for what the sandbox wrote meanwhile, which pushes it back); a brainstorm's idle time was
  already `deadline` (the store's `brainstorms`). The `setTimeout`s stay, and are re-armed from
  the deadline at start: what was left of it, or at once when it passed. The waits' checks
  (`WAITS_CHECK_MINUTES`) run at every start anyway, and the reviews' waits for CI or a merge
  keep when they began (the store's `reviews`), from which their next tick decides;
- **the maps that hold data alone** (titles, closed states, pull requests, dismissals, the run
  order, the onboarded repos, the lanes' names, the issues' modes, the rebase attempts, the last
  dry runs, the reviewers requested, #615): in the store, one key per item, `<map>/<key>`
  (`lib/store-map.mjs` `storeMap()`), read back whole once the copy holds the lease, before
  anything is restored. Its callers use a Map: each `set()` or `delete()` writes its own key
  alone, in order per key, a later write replacing one of the same key still waiting; one that
  fails is tried again every 5 s until it lands or the lease is lost (`/ready` says how many
  wait; a copy that stops waits for them, 10 s at most). Their values go without the
  operator's secrets, as the queue's (`storable()`): an issue's title is people's text. The run
  order keeps a rank per task, a moved task's between its neighbours', since the store lists
  keys in no order. At the first start after the update, each map's JSON file in `/data` is
  written there (the items the store doesn't have yet), then removed;
- **the maps behind timers and comments** (#616): the waits (`waits`), the issues waiting for
  input (`inputs`), the review loops (`reviews`), the brainstorms (`brainstorms`), the policy
  decisions (`decisions`) and the auto-picks that are over (`picks`), kept the same way, moved
  the same way from their JSON files at the first start after the update. Their deadlines are
  data (`deadline`, `since`, `ciWaiting`), armed again by the copy that loads them. The
  comments a wait holds go without a secret (`storable()`); what keeps them is the store's own
  access (docs/setup.md, its Redis ACL), not a file's mode.

What a release before kept in `/data` is moved at the first start after the update (the moves
above; the screenshots, `shots/`, to the broker, #609), so that start needs the old volume. The
older moves are gone (#619: a listener's `queue.json`, its App's credentials, `reactions.json`, the
run logs it kept itself): an install that still has those goes through a release before #619
first ([setup.md](setup.md#upgrading-the-orchestrator-without-a-volume-619)). Once moved, the
emptied `logs/` and `shots/` are removed, and anything else beside the store is named in a
warning, for the operator to remove.

A comment moves from the queue to a run's state in that order: the run's state is written, then
the queue without it (`restart.mjs` `take()`, for a run's start and a running session's
comments: until a write of the run's state that has it succeeds, every write of the queue,
another task's or a 👀's, still has it, once); and back the other way at a run's end, or a restored run whose sandbox never
started (the queue with the comments put back, then the run's state removed, `runs.mjs`
`teardown()`). A copy killed between the two writes finds the comment in both, and leaves
it to the run (`loadQueue()`, by `queueId`): never in neither. A change that writes one of the
maps above and the queue orders its two writes the same way, by `storeMap()`'s `after` (a write
of a key that waits for a promise, the key's later writes too) and `written(key)`:

- **a wait released** (its issues done, or its questions answered: `waits.mjs` `releasing()`):
  the comment queued and the queue written (`restart.mjs` `queueWritten()`, tried again while
  the store is away), then the wait deleted. Killed in between, the next copy finds both, and
  drops the wait whose comment (its `queueId`, given when it began to wait) is queued or
  running (`waits.mjs` `dedupe()`);
- **a queued comment moved to a wait** (the dashboard's Queue after…, `work.mjs` `requeue()`):
  the wait written (`hold()` resolves once it is), then the queue without the comment
  (`restart.mjs` `park()` keeps it in the queue's writes until then). Killed in between, the
  next copy finds both, and leaves the comment to the wait: `loadQueue()` drops the queueIds the
  wait keeps (`unqueued`);
- **a brainstorm ended** by the comment that starts work or another mode (`brainstorms.mjs`
  `end()`): the comment queued and the queue written, then the brainstorm deleted. Killed in
  between, the comment is queued and the brainstorm still there, as if it hadn't come yet.

A run's start takes its task's
`next` and saves the queue without it, so a restart mid-run doesn't hand it to the next run too.

Restoring is one path (`restart.mjs`), the same at a start after a stop, after a crash, and for
a copy taking over from another (#506): `unifySpellings()`, `restoreRuns()` (the runs' states:
their tokens work again, comments find them), `loadQueue()` (the tasks rebuilt from the store,
their deadlines re-armed), then `reattach()`. They run once the copy holds the `orchestrator`
lease (`lib/active.mjs`): a copy that starts while another acts waits for it, opening only its
probes (`/ready` answers 503), and restores nothing until then. On SIGTERM the acting copy starts
no more runs, stops its timers, refuses edge's and the runner's calls (503: they ask again),
stops reading the streams (the deliveries being handled are acknowledged first), waits for the
writes under way, then **releases the lease**: the waiting copy takes it at once (about a
second). After a crash the lease expires (15 s, `LEASE_SECONDS`) and the waiting copy takes it
then; with one copy (Compose's default), the next one takes it as it starts. A copy that loses
its lease while acting exits. Each holder's epoch fences the copy before it (Fencing in
[services.md](services.md#edge-and-the-orchestrator)).

The next copy finds the sandboxes by their labels, follows their output from where the
previous one stopped (a copy killed within a second of reading some lines reads them again,
and its log has them twice), and posts each reply once. A recreated container isn't on the networks the old one was joined
to: the new copy has the runner join the egress proxy to the running sandboxes' networks first
(`runner.relink()`), and again every minute, for a proxy
recreated on its own; the networks, container engines and engine volumes of runs that are gone
are removed then. A sandbox the orchestrator started itself while it was still finding the
previous copy's is its own, never taken for a leftover. Queued comments whose author or
repository is no longer allowed are dropped then; each run checks its comments' authors against
the repository's `users` again when it begins, and so does the next copy for comments queued
for a run still going.

Webhooks no longer reach the orchestrator: edge takes them, and puts each verified delivery on
the `deliveries` stream of its store before it answers `202`. The orchestrator reads that stream
(`edge/client.mjs` `consume()`), handles each delivery (`listener/http.mjs` `deliver()`, which
resolves once what it admitted is done) and acknowledges it then; one handled whose
acknowledgement was lost is taken once (`deliveries/handled/<guid>` in its store, an hour). So a
delivery that arrives while the orchestrator restarts waits in the stream, and the next copy
reads it from the last acknowledged event.

**Edge's own restart.** Edge keeps nothing in memory that matters: its deliveries' GUIDs, the
sessions' epochs and the redeliveries' state are in its store. On SIGTERM it takes no new
connection, lets the requests in flight finish (`DRAIN_SECONDS`, 25 s; a live log streams until
the browser reconnects), hands the redeliveries' poller's lease (`edge/redeliveries`) to the
other copy, then exits. A delivery it refuses meanwhile, or that reaches no copy, gets `503` (or
no answer), which GitHub marks failed and the next scan redelivers ([Missed
deliveries](#missed-deliveries)). Two copies, both active on one store, take over each other's
requests: a rolling update starts the new one first ([setup.md](setup.md#two-copies)). The
orchestrator away (handing over), edge waits for it up to 15 s on each call it passes on, then
answers `503`.

A restart delays the runs' calls rather than failing them (#507, #511). Nothing a sandbox calls
during a run reaches the orchestrator: it calls the services by their own names
(`lib/services.mjs` `SANDBOX_URLS`: `http://broker:8081`, `http://github:8080`,
`http://models:8080`), which only the egress proxy reads (a sandbox resolves none), two ways:

- **relayed**: GitHub's API and git's fetches (`gh`, `git clone`), and the hosts an agent has
  relayed (`relayed` in `agents/`, Antigravity's Google endpoints), whose HTTPS the proxy
  decrypts and sends to the github service's `/relay/<host>/` (GitHub's, the policy's
  `service: "github"`) or the models service's (an agent's, `models: true`);
- **forwarded**: plain HTTP to a service's name (none is in the sandbox's `NO_PROXY`): the
  agents' APIs set to the models service's (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
  `GOOGLE_GEMINI_BASE_URL`), pushes to the github service's git gateway (`DECKHAND_GIT_URL`,
  `pushInsteadOf` in `entrypoint.sh`), the run token's renewal, the inbox and the run's files to
  the broker's (`DECKHAND_BROKER_URL`). The proxy asks the policy whether that client may reach
  the name (a running sandbox or its engine: `forward=1`; never as a tunnel), and sends the
  request to its own URL for that service (`BROKER_SERVICE_URL`, `GITHUB_SERVICE_URL`,
  `MODELS_SERVICE_URL`), on the paths that service takes from sandboxes only (`/run/`, `/git/`;
  `/anthropic/`, `/openai/`, `/google/`).

Either way the proxy's own service token goes with the call, the sandbox's credential moved to
`x-deckhand-run-token` (the broker's, the models service's) or `x-deckhand-run-authorization`
(the github service's), and the network the policy gave for the sandbox in `x-deckhand-sandbox`,
which the run's tokens are bound to. The orchestrator's restart doesn't touch these calls, and
the models service drains for as long as an agent call lasts, 10 minutes
([services.md](services.md#the-models-service)). The orchestrator asks the models service which
credentials it holds before it reads its settings: it waits for it at start.

The egress policy, which the proxy asks about every sandbox connection (to any host), has a port
of its own (`POLICY_PORT`, 8082). On SIGTERM the orchestrator answers edge's and the runner's
calls on its services port with `503` (they ask the next copy); once its lease is released, it
ends the dashboard's open streams (their pages reconnect, through edge, to the next copy), and
closes the egress policy's port last, its answers in flight sent (5 s at most), so that the
proxy's next questions are refused and waited for rather than cut.

The egress proxy waits for the next copy meanwhile (`proxy/wait.mjs`): a connection the
orchestrator refused (a waiting copy refuses them all), or that failed before it was made (reset
while connecting, its name unknown while its container is gone), never reached it, so the proxy
tries again, with a growing delay (0.25 s doubling up to 5 s), for up to 5 minutes before it
refuses the host. With one copy of each (compose), the next orchestrator only starts once the
previous one has exited; with two, both are on the proxy's network under the name
`orchestrator`, and the proxy tries the address Docker's DNS gives until the acting copy takes
it. A service it forwards to is waited for the same way, for any method, a POST included: a
request is only sent once a connection is made, and never sent again (a copy that dies with it
gives the sandbox a `502`). Every agent's CLI sends an `http://` base URL through `HTTP_PROXY`
(checked against Claude Code 2.1.300, Codex 0.162.1 and agy 1.4.0), as do git and Node's `fetch`
(with `NODE_USE_ENV_PROXY`).

The egress proxy drains on SIGTERM too, for 25 s (compose's `stop_grace_period` for it is 30 s):
no new tunnel, the requests in flight finish, and the decrypted tunnels close once their
requests are answered. Its grace is short on purpose: the next proxy only starts once it exited,
and the sandboxes' new connections are refused meanwhile, with nothing to try them again. A raw
tunnel is never known to be idle, so one still open at the end is cut, and so is an agent's
answer still streaming through the proxy to the models service after 25 s: an update to the
proxy's image may fail a turn, where the orchestrator's update only delays it.

Running sandboxes outlive an update: they keep their image, and its scripts, until they end.
So an endpoint that sandboxes call is kept across one update: the sandboxes in flight while it
happens still find what they call after it. Once a release no longer calls an endpoint, the
next one may remove it: its last callers were started before the release that stopped calling
it, and none of them may still run when the next one is deployed (`docker ps --filter
label=deckhand.run` on the server lists the running sandboxes).

A run's tokens outlive a restart: the broker service (`broker/`) signs them, with a key only it
holds, and keeps the live runs in its store; they name the run by its id, which the run's state
in the orchestrator's store keeps (`runs/<id>`, without its tokens), so the next copy of the
orchestrator checks them with the broker's public keys as the last one did, and tells the broker
the runs it picked up go on (`PUT /runs/:id`, with their claims: a run whose end the broker
missed while no copy acted is ended there, `GET /runs`). It asks the broker for each one's
tokens still valid (`POST /runs/:id/secrets`, the orchestrator's alone and fenced by its epoch),
which it redacts from the run's output; the broker keeps every token it signs sealed for that
(#617). A renewal (`POST /run/token`) goes
through the egress proxy to the broker service, which the orchestrator's restart doesn't stop
(the proxy still asks the orchestrator's egress policy about the call first, and waits for it); `deckhand-token` gives up on
one after 30 s (`curl --max-time 30`) and asks again every 30 s; a token that expired meanwhile
still renews, from its own sandbox, for 7 days (`RENEW_GRACE_MS`), and the renewed one is bound
where it was.

### The broker service

The broker service (`broker/`, #505) is the only one holding the tokens' signing key
(`run-token.key`, in its own volume `broker-keys`): it signs a run's first tokens with the claims
the orchestrator decided (`POST /runs/:id/tokens`, which the orchestrator asks for once the runner
says the sandbox's network or pod exists), renews them for their own sandbox only (`POST
/run/token`, through the egress proxy), and signs every service's own service tokens, for the
caller its network (or pod's service account) proves (`broker/callers.mjs`). Every other service
checks those tokens offline with its public keys (`GET /keys`, the `service-keys` volume). Its
store holds the live runs (`broker/runs.mjs`: their claims, where their tokens are bound, a
run's end), their files ([Run files](#run-files)) and the `runs` stream the orchestrator reads
and acknowledges (`broker-service.mjs` `consume()`); the models service asks it whether a run
still goes. Its API (`broker/http.mjs` `ROUTES`) names the callers of each endpoint, and each
orchestrator call but a `GET` carries its fencing epoch. What each caller may do, and what a hole
in it gives: [The broker service](security.md#the-broker-service) in security.md.

**The broker service's own update.** Compose runs one copy, which drains on SIGTERM for 30 s
(`DRAIN_SECONDS`: the inboxes' long polls, uploads in flight), then the next one starts on the
same store and key: the proxy waits for it meanwhile, as for the orchestrator (`proxy/wait.mjs`). On
Kubernetes (`deploy/kubernetes/broker.yaml`, both mounting the key's Secret), two copies on one
store, both active: a rolling update starts the new one first, then the old one, out of rotation
(`/ready` answers `503`), drains. Either copy would answer any call: the live runs, their files and their events are in the store, so a run
ended through one renews through neither, and an inbox read through one goes on from the same
offset through the other.

### The runner service

The runner (`runner/`, #503) is the only service with the host's Docker socket, or the
Kubernetes API's credentials: neither edge nor the orchestrator has them. It runs the backends
(`listener/runner/`: Docker or Kubernetes, the runs' networks, inboxes and engines),
builds repo images and installs agents (`listener/images.mjs`), runs the Antigravity login's
refresh, and keeps the runs' logs and events. What decides a sandbox's spec (`sandbox-spec.mjs`: image, environment, limits, volumes,
no backend option) stays with the orchestrator (`preparation.mjs`, `runs.mjs`), which hands it over
whole, and the runner checks it against the grants again (`spec-check.mjs`): the grants folder,
which it reads itself, and what the operator's policies grant the repository, which it asks the
policy service itself (`grants.mjs` `grantsBy()`, the operator's layer only: no repository's
files), for an engine (`docker`) and an image build (`dockerfile`, `branch_docker_images`: `builds.mjs`);
the runner holds no GitHub credential: a build context starts from the repo's tarball, which it gets from the github service (`GET /tarballs/…`), and an image's tag
hashes the Dockerfile's blob the github service read (`GET /blobs/…`). The
orchestrator talks to it through `runner/client.mjs`.

Its API (`runner/service.mjs`) names the callers of each endpoint (`ROUTES`), each with its own
service token (docs/security.md, Service tokens): the orchestrator starts, follows, talks to
and removes sandboxes and writes and reads their logs (`GET /logs/<run>`, `stream()` reading it
from an offset, for the dashboard's live view, which the orchestrator relays to edge as it
streams); it also asks, for the egress policy that stays with it, where an address is, the
egress proxy's addresses and a sandbox's install,: reads that aren't fenced (`UNFENCED`, `GET /logs/:id` among them: they write nothing),
so a copy still draining answers them; the models service (#504) has the Antigravity login
refreshed, sending the token file, never a container's spec, over a network of its own
(`runner-models`). Edge calls none of it. The runner takes its callers from the network each
reaches it on (`SERVICE_NETWORKS`, `orchestrator=<subnet>,models=<subnet>`). The runner gets its own tokens from the broker service over
a network of its own (`broker-runner`), and checks its callers' with the broker's public keys
(`SERVICE_KEYS_DIR`, read-only, as the policy service does).

- **A run's start** is keyed by its id: asked again (a lost answer, a handover), it finds the
  sandbox and starts nothing; one a copy left halfway (its network, no sandbox) is done again,
  and one whose sandbox already runs is recorded as started, with the container engine read back
  from its sidecar (the backend's `engine()`), as the metrics count it.
  The run's first tokens come from the orchestrator once its network or pod exists (`POST
/runs/<run>/tokens` on the orchestrator's services port, only for a run being started), which has
  the broker service sign them with the claims it decided (`sandbox-spec.mjs` `tokenEnv()`): the
  runner never chooses what a run's tokens allow. They go in the sandbox's environment, by name.
  Its inbox, CA and digest the runner copies to the broker service before the sandbox starts, and
  the inbox again as it changes (`listener/runner/inbox.mjs` `mirror`).
- **Its output** comes as NDJSON (`GET /sandboxes/<name>/output`), from the lines the orchestrator
  read already: the stream ends when the sandbox does, or when the runner stops, and the
  orchestrator follows again from where it was, as when `docker logs` ended.
- **Its log** is in segments in the runner's store, the closed ones moved to blob storage when
  `BLOB_URL` is set ([A run's log](#a-runs-log)), written by appends that name the offset they go
  at: one sent again is taken once, one at another offset refused with the log's size, which
  the writer goes on from. The orchestrator writes a line at once and sends it as it can (in order,
  tried again while the runner is away), and saves a run's state only once what it read is at
  the runner, so that the lines it skips after a restart are there.
- **Its events** (started; ended, with its exit code) go to a stream of the runner's store,
  which the orchestrator reads and acknowledges (`run-events.mjs`): none is lost while either
  restarts. An exit code that isn't 0 is a note in the run's log.
- **The orchestrator's fencing epoch** (`x-deckhand-epoch`) comes with each of its calls but
  the unfenced reads: the newest one seen is in the runner's store, and an older one is refused
  (`409`), so a copy that lost its lease without noticing can't start or stop a run. The epoch is
  its lease's (`lib/active.mjs`, `lib/store.mjs` `acquire()`): each new holder's is higher than
  every one before it, and at least the time in ms. The github service and the broker check
  it the same way (the broker since #506, on every orchestrator call but a GET). The runner
  refuses one more than a day ahead of its own clock (`400`). Should an epoch have run ahead anyway (a clock), the next one is
  refused until that time: removing the `epoch/orchestrator` key from the runner's store (its file under
  `runner-data`'s `store/`, or the key in Redis) with the runners stopped lets it in.

**Two copies, active/passive** (`lib/active.mjs`): the one holding the runner's lease in the
store answers; the other answers `503` (and `/ready` says so, the readiness probe's), which
callers try again on the next copy (`lib/service-client.mjs`). On SIGTERM the active copy ends
the output streams and log reads it serves (their callers come back), lets its other calls
finish (an image's build), then releases the lease, and the waiting copy takes it at once (it
asks every 250 ms). On a crash, or a store that no longer answers it, the lease expires
(15 s) and the other copy takes over; the stopped one, by its own clock, no longer acts. Either
copy finds the sandboxes again by their labels, and the logs and events in the store: the file
store for one node, Redis for copies on several (`STORE_URL`, docs/setup.md, The store). The
runs' inboxes are files of its `runs` volume, which it copies to the broker service as they change
(the broker serves them): two copies on several nodes need that volume shared. With Docker Compose, one copy runs: an update is a wait
of the runner's calls, which the orchestrator waits for (30 minutes for a run's, 10 s, then the last
answer, for the egress policy's questions about a sandbox's address).

### The github service

The github service (`github/`, #502) is the only one holding the GitHub App's key: edge keeps
the webhook secret and the OAuth client's, the orchestrator only the App's public parts (which
it reads from edge, `GET /app`), never the key. It runs the gateways
(`listener/github-gateway.mjs`, `git-gateway.mjs`, `github-writes.mjs`, `github-graphql.mjs`,
`github-forks.mjs`, `github-pulls.mjs`, with `github-app.mjs`'s installation tokens), and makes
edge's and the orchestrator's own GitHub calls. Its API (`github/service.mjs`) names the callers
of each endpoint (`ROUTES`): the proxy the
sandboxes' calls, `/relay/<host>/…` and `/git/…`, with the network they came from
vouched for; the orchestrator its calls as a repository's installation (`/as/<owner>/<repo>/<GitHub's
path>`, GitHub's answer passed on with its status in `X-GitHub-Status`), GraphQL, as the App and
one installation, the runs and their end, its reactions and the service's events; edge the same
reads, never a write (a GraphQL mutation refused), but /setup's conversion of a manifest code
(`POST /app/manifest`) and the redeliveries (`POST /as-app/app/hook/deliveries/:id/attempts`);
the runner a repository's tarball and a file's
blob id. The orchestrator calls through `github/client.mjs` (`app()`: `request()`, `asApp()`,
`asInstallation()`, `identity()`).

- **A run** is told to the service once its sandbox's network or pod is known (`broker.mjs`
  `issue()`, `restore()`: `gateway.put()`), with what its gateways check (its repository, mode,
  issue, branches, capabilities, the network its tokens are bound to, whom its writes may
  assign), and its end (`revoke()`). What it does there
  is the service's, in its store (`github/runs.mjs`): the issues it created, the comments it
  posted, its reactions and reruns, changed with compare-and-set, kept before GitHub's answer
  ends for the sandbox (`upstream.mjs` `forward()`'s `settle`), read by the orchestrator at the run's
  end (its reruns, for the CI step). Its pushes, the lines the gateways add to its log and the
  pull requests it changed come to the orchestrator as the service's events (`GET /events`,
  acknowledged once handled: `consume()`), as the broker's do.
- **Two copies** may run on one store: a run's state, its calls in flight (a slot each,
  renewed while it goes on), what GitHub advertised to its git, the orchestrator's reactions, the fencing epoch and the
  idempotency keys are there; installation tokens and git mirrors are each copy's cache. Every
  orchestrator call that changes something carries its epoch (`lib/fence.mjs`, as the
  runner's), and a write may carry an idempotency key, made once however often it is asked: a
  run's reply carries `<run>:reply` (`comments.mjs` `reply()`).
- **The App's key**: edge's /setup has the service convert a new App's manifest code
  (`POST /app/manifest`), so a key never reaches edge or the orchestrator.

### The models service

The models service (`models/`, #504) is the only one holding the operator's agent credentials:
its environment and the credentials folder (read-only), and the plans' logins it refreshes,
sealed in its store with a key only it holds (`models/logins.mjs`). It serves the agents' API
endpoints (`models/upstream.mjs`, `anthropic.mjs`, `openai.mjs`, `google.mjs`) and the plans'
logins (`chatgpt.mjs`, `antigravity-login.mjs`, whose refresh the runner runs in a container of
its own). Its API (`models/http.mjs` `ROUTES`) names the callers of each endpoint: the egress
proxy the sandboxes' agent calls (`/anthropic/`, `/openai/`, `/google/`, `/relay/<host>/`), with
the network it vouches they came from, and the orchestrator the credentials' names (`GET /credentials`,
before its settings are read) and fingerprints (`GET /fingerprints`, for redaction), a run's API
state (`GET /runs/:id/api`, for its reply and fallbacks at its end), the plans' usage (`GET
/usage`, the dashboard's bars, below) and the `models` stream (the calls it refused a run, a line
each in its log).

- **A call** carries the run's agent token, checked offline with the broker's public keys
  (`models/runs.mjs`): its `agent` claim (a run never gets another agent's credential), from its
  own sandbox, for a run the broker says still goes (`GET /runs/:id`, every 30 s at most per
  run). The service swaps it for the operator's credential and streams the answer back.
- **The plans' usage** (`models/usage.mjs`, #486) is read from the plan's answers to the runs'
  calls (their rate limit headers; never an API key's, a gateway's or OpenRouter's) and, while a
  dashboard is open, from the plans' own usage calls: the orchestrator asks `GET /usage?poll=1`
  every 15 s at most while api/state is read (`listener/models-service.mjs` `plans()`), and the
  models service asks a plan no run read lately, every 5 minutes at most for every copy (a lease
  in the store), 30 minutes after a failed call, which is only logged; never again (until a restart)
  after Claude's refuses its token, which a `claude setup-token` token's missing `user:profile`
  scope makes the usual case, and not while a ChatGPT login is due for a refresh (the poll doesn't
  refresh it); the Antigravity CLI's, its plan's only reading, refreshes its hour-long login
  when due, once an hour at most for every copy (`usage:<plan>:refresh`). Readings are in the store,
  `usage:<plan>`, written when a percent, a reset or a limit changes, or once a minute. A 429
  marks its window full until its reset. api/state's `plans` has only their numbers and times,
  and only when a plan is set; they update only when runs use the plan or a dashboard is open.
- **Two copies** may run on one store, both active: a plan's refresh token is single-use, so a
  refresh is a lease in the store (one copy refreshes, the other waits for its result), and a
  run's API state is there by the run's id. A run has 16 calls in flight at most per copy.
- **Its update** drains for as long as an agent call lasts (`DRAIN_SECONDS`, 600): a stopping
  copy refuses new calls (`/ready` answers `503`) and lets those in flight finish, so no turn is
  cut. With Compose, one copy runs, and a new call waits for the next one only as long as the
  proxy waits (5 minutes, [services.md](services.md#upgrades-without-downtime)).

What each caller may do, and the credentials' fingerprints:
[The models service](security.md#the-models-service) in security.md.

### Run files

A run's inbox, the egress proxy's CA and the run's digest are the broker service's
(`broker/files.mjs`, #505), blobs in its store, copied there by the runner from its runs folder
as they change (`listener/runner/inbox.mjs` `mirror`), and its screenshots are the broker's too,
in blob storage (`BLOB_URL`, or its store without it, #609); no sandbox mounts either (#393): a volume shared with sandboxes on other
machines would need ReadWriteMany storage. The sandbox calls the broker service for them,
through the egress proxy, with the run token, from its own sandbox only (the proxy vouches for
its network, `x-deckhand-sandbox`, with its own service token):

| Call                         | From the sandbox                                                                                                                             | Answer                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /run/inbox?from=<byte>` | `deckhand-inbox`, the agent's input (`TASK_INBOX` is this URL)                                                                               | the whole lines after that offset (at most 1 MiB, a longer line alone), waiting up to 25 s for one (`204` without); `deckhand-inbox` adds what it read |
| `GET /run/ca`, `/run/digest` | `deckhand-files get`, once at start (`DECKHAND_CA`, `TASK_DIGEST`)                                                                           | the file, which `entrypoint.sh` keeps in `/tmp/deckhand` and names in the same variable; the run stops if it can't fetch it                            |
| `PUT /run/shots/<file>`      | `deckhand-files shots`: at the agent's Stop hook, on each push (the hook after `git push`, `pre-push`), before each `gh` call, and every 3 s | `204`; a name GET /shots doesn't serve (`400`), a file that isn't the PNG, JPEG or WebP it says (`415`), over 10 MB or the run's 100 MB (`413`)        |
| `POST /run/permissions`      | `deckhand-permissions`, a chat's agent asking for more (`TASK_PERMISSIONS` is this URL; #479)                                                | `202` with the request's id, said on the `runs` stream; a run that isn't a chat's `403`, past 50 requests `429`                                        |
| `GET /run/permissions/<id>`  | `deckhand-permissions`, waiting for the answer                                                                                               | `{ state, message }` once the orchestrator answered, waiting up to 25 s for it (`204` without); another run's request `404`                            |

The runner's inbox file (`runner/inbox.mjs`, `<dataDir>/runs/<run>/`) is the truth, and the
broker's blob a copy of it: the CA and digest are put there before the sandbox starts (or the
start fails), and each change of the inbox is appended from the offset the broker has
(`POST /runs/:id/inbox?offset=`, `broker-service.mjs` `sync()`). Each append is one atomic
step of the store (`appendBlobAt()`: a Lua script on Redis, under the file backend's lock),
which skips what the blob already has and refuses a write past its end, so a retry, a lost
answer or two copies taking writes out of order never lose, repeat or reorder a line, and a
write the store failed leaves nothing. The blob is the file byte for byte: the runner redacts
a token's shape in a message before it writes it, and the store refuses an append it
would redact rather than make the two differ: the broker's own key (its own part, not the PEM
armour every key shares, so a message quoting `-----BEGIN PRIVATE KEY-----` goes through), which
holds up that run's inbox from there, as it should never be in a comment. The same bytes sent again add nothing, a broker away gets them once it is back, and a restarted runner sends what the
broker doesn't have. So either copy of
the broker, or one restarted, answers from the same offset, and the agent gets every line once.
A screenshot is written once into blob storage (`shots/<token>/<file>`), its name and size in the
broker's store (`shots:<token>`: the run's cap, and what retention deletes, as blob storage lists
nothing), and goes on the broker's `runs` stream, which the orchestrator reads and acknowledges
(`GET /events`, `consume()`) without copying anything. Edge serves it to anyone
(`GET /shots/<token>/<file>`, `edge/shots.mjs`), from the broker, with its service token, streamed
through as the broker reads it in parts (256 KiB at a time), so neither holds a whole file for a
reader; the orchestrator stays out of it. It stays past the run's end, for the links to it, until retention
removes its run (`history.mjs`: `DELETE /shots/<token>` at the broker, as the runner removes the
log). An orchestrator of a release before #609 kept them in its `shots/` folder: at its start, the
orchestrator sends each folder there to the broker, file by file (`PUT /shots/<token>/<file>`,
regular files only, never through a link), then removes it (`moveShots()`), so the links of
replies posted before still work; a folder no run names, older than `LOG_RETENTION_DAYS`, is
removed instead, as retention removed those, and a younger one is noted in the orchestrator's
store (`history/unnamed-shots`), for retention to remove at the broker once it is past the days.
One uploaded to a broker of the release before and not copied yet is still served from its store,
and adopted when the orchestrator reads its `shot` event (`POST /shots/<token>/<file>`: moved
into blob storage, its name kept for good, where that broker's record of it expired in a day). The sandbox keeps `SCREENSHOT_DIR` (`/tmp/screenshots`) in its own
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

The dashboard's run list comes back from the runs' summaries (`summaries/<run>` in the
orchestrator's store, written when a run ends, listed at the lease's takeover: the same after a
handover or a crash; those an older release kept in `logs/<run>.json` or `logs/<run>.summary.json`
moved there first); a run still live is listed from its saved state. A summary the store doesn't
take at the run's end is tried again every 5 s (`runs.mjs` `summarySaved()`, `QUEUE_RETRY_MS`)
until it lands, the run keeping its sandbox, its state and its task meanwhile: kept nowhere else
since #619. A copy that stops first leaves the run as it is, for the next copy to end again.
Such a run holds its task and a parallel slot, as one whose queue write or state's removal waits
(`removeLive()`), which a store refusing it for good (a summary file it can't write, a Redis ACL
without `summaries/`) would make last: not given up, as an hour's outage looks the same and the
summary is kept nowhere else, but said (#821, `restart.mjs` `endWait()`): the orchestrator's
`/ready` counts them (`ending`), the dashboard's status page lists each among the orchestrator's
warnings (what waits, since when, the store's error), its metrics count them
(`deckhand_runs_ending`, which `DeckhandRunsEndingStuck` alerts on after 15 min, #861), and the
log says it again every 10 min. A restored run takes comments once the runner says its inbox is still open,
waited for 10 s at start, later if the runner is away. The list is held newest first with an index by id,
and both lose the runs `history.mjs` removes, at start and daily: those older than
`LOG_RETENTION_DAYS`, but for a running run and the latest run of a task still queued, in a
brainstorm, waiting or waiting for input. The orchestrator's state decides which those are, so
the orchestrator decides, and has the runner remove their logs, then deletes their summaries'
keys: a run whose log the runner didn't remove, or whose summary's key the store didn't delete,
stays listed until the next day's try.

### Missed deliveries

GitHub never retries a failed webhook delivery by itself: one sent while edge is down or
restarting, answered `503` while it stops, while its places for unverified bodies are full or
while its store is away, or cut by a reverse proxy, is lost unless it is redelivered. The
redeliveries are edge's (`listener/redeliveries.mjs`, run by `edge/server.mjs`), on the one copy
holding the `edge/redeliveries` lease of its store (`lib/active.mjs`; the other takes it once that
one stops, or 15 s after a crash). That copy lists the App's deliveries with its JWT (`GET
/app/hook/deliveries`, through the github service as the App, newest first, by cursor) as it takes
the lease, then every 5 minutes; the dashboard's Sync (`POST /api/sync`, once per 30 seconds) and
the orchestrator's start ask edge for a scan too (`POST /redeliveries/scan` on edge's internal
port, which either copy answers). A scan goes back to the last one (less 10 minutes, at most 3
days, GitHub's retention), whose time is kept in edge's store (`redeliveries/scanned`). Each GUID
none of whose attempts succeeded, whose latest attempt couldn't connect, timed out or got a 5xx,
is redelivered (`POST …/attempts`), once: the GUIDs asked for are kept in the store 3 days
(`redeliveries/asked/<guid>`, set if absent, so two copies never ask twice), and a 4xx is edge's
own refusal (a bad signature), which would come again. A redelivery keeps its GUID: a delivery
edge took is kept as `deliveries/<guid>` in its store (set if absent, a day; a mark left by a copy that died taking it is taken again a minute on), so one it took
already, by either copy and across restarts, is neither asked for nor put on the stream twice.
Edge answers `202` as soon as the delivery is on the stream, so
GitHub rarely times one out. Comments come back oldest first, whatever their age. A
redelivered `pull_request` delivery (`redeliveries.mjs` `redelivered()`, the GUIDs it asked
for) is handled as its pull request is now (`events.mjs` `replayedPull()`): its payload is as
old as the failed attempt, maybe older than deliveries handled since. Its current state is
recorded, and an action the pull request no longer matches (ready since merged) becomes
`edited`, so nothing turns ready, closes or starts a review from it.

At the orchestrator's start and from the dashboard's Sync, the scan edge makes goes with the open pull requests' states read
again (`pulls.mjs` `resync()`), through `sync.mjs`. The dashboard's then runs a conflict pass
(`conflicts.mjs` `check()`, see Conflicts) after `resync()`, so a pull request merged or closed
meanwhile isn't checked. The last one's result is kept in memory and sent in `api/state`
(`lastSync`): when it ended, who asked (`null` for the orchestrator at start), how many
deliveries were asked again, pull requests changed and rebase runs started (`conflicts`, 0 at
start), and the error of a part that failed (the other parts' counts are kept). `POST /api/sync`
answers the same record, `502` when it failed.

A delivery whose handling throws (`dispatch()`) is logged with its event and action; the
orchestrator acknowledges it and goes on with the next one. GitHub got its `202` already, so it
isn't redelivered.

Pull request states don't hang on deliveries alone: the orchestrator records the changes it makes
for runs (`github-pulls.mjs`: ready, draft, opened, edited) in the store's `pulls` at once (the
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

A task's pull request carries its `head` commit too, and what CI says of it (`ci`: `{ sha, state, runs }`, #436),
decided by the rule auto-merge uses (`ci.mjs` `ciState()`) over the commit's Actions runs, check
runs and commit statuses (`commitCi()`; one GitHub refuses, an installation that hasn't accepted
`checks` or `statuses`, is left out; any other failure, a rate limit's 403 included, records nothing, rather than CI without that part; each list is read page by page). A `workflow_run`, `check_suite` or `status` delivery for
the head of an open pull request reads it again (`ciChanged()`, one read at a time per task, one
more after those that came meanwhile, a failed one included), without holding the delivery's
place among those the orchestrator handles at once; one for any other commit (an older head)
changes nothing. A new head (from a delivery no older, by its `updated_at`, than the one that set the last) resets it to `none` and reads it at once: the delivery that said
it changed may have been handled before the pull request's own. `check_suite` and `status` are
`QUIET_EVENTS` (`github-app.mjs`): edge passes on only what `ciDelivery()` reads of them
(`quietPayload()`), for allowed repositories, without their GUID or a log line, and at most one
per commit the orchestrator hasn't read yet (`ciWaitingKey()`, cleared when it reads it: its
handling reads the commit's CI after the ones left out), so they never crowd the stream. The
orchestrator handles them without a log line, and the redeliveries skip them: `resync()`
starts, once it resolved and four at a time, a read of the CI of each open pull request not
settled for its head (never read, `none`, still running, or whose last read failed, `ciFailed`: a 5xx or a rate limit records nothing), at start; a user's Sync reads every open one's again (`allCi`), for a delivery lost on a settled head. A merged or closed one keeps the
last CI known.

## Agents

Three agents, Claude Code (`claude`), Codex (`codex`) and the Antigravity CLI (`antigravity`),
behind a seam that keeps what is each one's own in two files, so another agent is two more files rather than an `if` across the
orchestrator. Which one runs: the repo's mode's `agent`, else the repo's `agent` (or
`brainstorm_agent` for light runs), else the operator's `SANDBOX_AGENT` (`BRAINSTORM_AGENT`).
A repo only picks among the agents the operator configured (`config.agents`: those it has a
credential for, and its defaults), checked when its config is read (`repo-config.mjs`).
`runs.mjs` settles it once the repo's settings are read, at the start of each run
(`resolveEntry()`, `agents/select.mjs`), and keeps it in the run's record:

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

### Providers and fallbacks

An agent calls a provider: Claude Code `anthropic` (the operator's `ANTHROPIC_BASE_URL`) or
`openrouter`, Codex `openai`, the Antigravity CLI `google` (each agent's `providers` and `defaultProvider`; `env(config,
secret, provider, credential)` gives the variables for one). Sandboxes always call the
broker's host, which the egress proxy sends on to the models service (#504): the orchestrator keeps
each run's provider and credential (`broker.provide()`), the broker signs them into its tokens
(their `agent` claim), and the models service's endpoint (`models/anthropic.mjs`) forwards to
that provider's URL with its credential. The endpoints also keep the provider's last status for
the run (`apiStatus`), and the Anthropic one when a plan's limit resets, from its 429
(`apiReset`), which the orchestrator reads at the run's end (`models-service.mjs` `apiOf()`).

A provider can have credentials an entry names (its `credentials`): Claude Code's `anthropic`
has `plan` (`CLAUDE_CODE_OAUTH_TOKEN`) and `key` (`ANTHROPIC_API_KEY`), written
`claude@anthropic:key`. Without a name, a run takes the default credential (`credentialName()`):
a gateway's token, then the plan, already paid for, then the key (`agents/credentials.mjs`). The
endpoint holds every credential set (`named`) and picks the run's, in its header (`Bearer` for the plan, `x-api-key`
for the key); the sandbox gets the run's agent token in that credential's variable, so Claude Code's
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

The services and how they hand over: [services.md](services.md). The modules below are in
`listener/` unless their path says otherwise; edge and the orchestrator each run some of them
([Edge and the orchestrator](#edge-and-the-orchestrator)). What the services share is in `lib/`, which every image copies beside its own code: the YAML
reader and the settings parser, redaction, HTTP helpers, the JSON state files, draining, the
tokens (run and service tokens, what each caller may do) and the store (`lib/store.mjs`, its
file backend `lib/store-file.mjs`, its Redis backend `lib/store-redis.mjs` and the Redis client
`lib/resp.mjs`, the arguments both backends check alike in `lib/store-checks.mjs`; the maps kept there one key per item, `lib/store-map.mjs`), and an S3 client (`lib/s3.mjs`: SigV4 signing, PUT, ranged GET, HEAD and
DELETE, retries on 5xx) for blob storage (`lib/blobs.mjs`, #604: `BLOB_URL`'s S3, folder or
store backends behind one interface, checked at start). Nothing in it imports from `listener/`.

`orchestrator/server.mjs` only wires the orchestrator together: its settings, the GitHub App's
public parts, the shared `ctx` and the modules, then, once it holds its lease, it starts the
servers, restores runs and handles SIGTERM; `edge/server.mjs` does the same for edge. The stateful
modules are `createX(ctx)` factories sharing one `ctx` object (the settings, the GitHub App,
the tasks, the runs, the services); each reads `ctx` when it is called rather than when it is
created, so a module can call one created after it: a finished run (`runs.mjs`) schedules the
next one (`tasks.mjs`), which starts runs. Others take only what they use, injected, so their
tests fake it.

| Module                                                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../orchestrator/server.mjs`                                                                | The orchestrator's entry point: settings, the App's public parts (from edge), `ctx`, the modules; waits for its lease (`lib/active.mjs`), then starts the servers, restores runs, reads edge's stream, and on SIGTERM saves what it holds and releases the lease.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `../edge/server.mjs`                                                                        | Edge's entry point: settings, its store, the App's credentials but the key, sign-in, the redeliveries' poller under its lease (`edge/redeliveries`); starts its public and internal ports, drains on SIGTERM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `../edge/http.mjs`                                                                          | Edge's public server: webhooks (their HMAC, each GUID taken once in its store, put on the `deliveries` stream before `202`), `/setup`, sign-in, the dashboard's files, `/health`, `/ready` (503 as it drains and until the broker has answered it); the screenshots from the broker (`shots.mjs`); the rest passed on to the orchestrator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `../edge/forward.mjs`                                                                       | The dashboard's API and `/status`, passed on to the orchestrator's services port under `/edge/`, with edge's service token, the signed-in user and the browser's Host and Origin; the answer streamed back; an orchestrator handing over waited for, up to 15 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `../edge/internal.mjs`                                                                      | Edge's internal port, the orchestrator's alone: the `deliveries` stream (read, acknowledged), the App's public parts, the "From the dashboard by" tags, a redeliveries' scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `../edge/app.mjs`                                                                           | The App's credentials edge holds (`app.json`: the webhook secret, the OAuth client's, never the key), and the public parts the orchestrator may read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `../edge/client.mjs`                                                                        | Edge as the orchestrator calls it: its stream consumed and acknowledged, the App, the tags, the scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `../edge/oauth.mjs`                                                                         | MCP clients' sign-in (#481): a small OAuth 2.1 authorization server for the `/mcp` resource (RFC 9728 and 8414 metadata, RFC 7591 registration of public clients, capped per source and per hour, PKCE, a consent page, rotating refresh tokens, RFC 7009 revocation) whose users sign in with GitHub as the dashboard's do (`auth.mjs`); tokens and codes kept hashed in edge's store, every check reading `ALLOWED_USERS` and the login's session epoch again; Settings' connected clients (`/api/mcp/clients`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `../edge/shots.mjs`, `lib/shots.mjs`                                                        | The runs' screenshots (#609): `GET /shots/<folder>/<file>`, public, passed on to the broker with edge's service token and streamed back (a path that isn't a screenshot's name a 404, the broker away a 503); the names, sizes and types the broker accepts and edge serves, in `lib/shots.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `services-http.mjs`                                                                         | The orchestrator's services port: the runner's (a run's first tokens, which the broker service signs) and edge's (`/edge/…`: what edge passes on, answered by `http.mjs`), each route for its callers' service tokens alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `run-events.mjs`                                                                            | The runner's run events (a sandbox's end and exit code), read and acknowledged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `../runner/`                                                                                | The runner service: its entry point (`server.mjs`), its API and callers (`service.mjs`), the runs' logs (`logs.mjs`) and events (`events.mjs`), and the client the orchestrator calls it with (`client.mjs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `config.mjs`, `lib/settings.mjs`, `lib/yaml.mjs`                                            | The operator's settings (environment and `config.yaml`), one `SETTINGS` table: each one's type, default and parser; the YAML subset both config files use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `http.mjs`, `deliveries.mjs`                                                                | The orchestrator's: the dashboard's API and `/status`, as edge passes them on with the signed-in user, and the deliveries from edge's stream (`deliver()`); edge's: the places for unverified bodies (`deliveries.mjs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `redeliveries.mjs`                                                                          | Edge's: deliveries GitHub couldn't hand over, found in the App's delivery list and redelivered once, by the copy holding the `edge/redeliveries` lease; its state in edge's store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `sync.mjs`                                                                                  | The last catch-up with GitHub (a redeliveries' scan asked of edge, pull requests, conflicts), for `api/state`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `egress-http.mjs`                                                                           | The orchestrator's egress policy (8082), which the egress proxy asks about each connection: its answers, with the sandbox's network for the services the proxy relays or forwards to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `broker-service.mjs`, `lib/broker-client.mjs`                                               | The calls to the broker service, with a service token for each service the caller is (edge, the orchestrator, the runner): the runs' first tokens and their end, its public keys, the inboxes and files the runner copies there (`mirror`, from the runner service), the `runs` stream read and acknowledged, the runs' screenshots removed with their run and moved there from an older release's `shots/` (`moveShots()`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `../broker/` (`server.mjs`, `runs.mjs`, `files.mjs`, `http.mjs`, `callers.mjs`, `seal.mjs`) | The broker service, its own image: the signing key; the live runs and their tokens in its store, renewed for their own sandbox only; their inbox, CA, digest and screenshots as blobs; the `runs` stream; the services' tokens, to the caller its network (or pod's service account) proves; one table of what each caller may call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `status.mjs`                                                                                | `/status`: running runs, reaction updates in flight (`track()`); whether the orchestrator is idle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `health.mjs`                                                                                | `GET api/health`: each service's `GET /health`, probed at once with a 2 s timeout and kept 10 s, as `up`, `starting` or `down` and why ([Around the runs](#around-the-runs)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tasks.mjs`                                                                                 | One queue per issue: admission (`admit()`, `resume()`, open questions), the pause, delivery to a running session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `task-modes.mjs`                                                                            | Which mode a queued comment runs in: trigger and `/mode` lines, brainstorms, the issue's current mode; then the policies' `allow_run` and `deny_run`, before the mode changes anything.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `permissions.mjs`                                                                           | Who may do what where (#731): the access decision (`policies.mjs` `access()`), narrowed by a repo's `users` as last read, as the dashboard's routes (`web.mjs` `apiRoute()`), `api/state`, `/status`, the log streams, comments, auto-pickup and requested reviewers ask it; `anyAction()`, whether a repo is visible at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `run-policy.mjs`                                                                            | The input of `allow_run` and `deny_run` for a run a person starts (its mode, trigger, sender, and the issue, pull request or discussion its comment is on), and the reply when they refuse it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `runs.mjs`                                                                                  | A run from start to reply: settings and agent (`begin()`), the sandbox, its output, cancel, reply, reactions, label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `capabilities.mjs`                                                                          | The capabilities' catalogue (dependencies, config side, grant, enforcement), the risky combinations, and `outcomeOf()`: what a run gets from the policies' `allow_capabilities` and `deny_capabilities`, its config and grant, at its start and on the config page. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `preparation.mjs`                                                                           | Before a run's sandbox starts: its capabilities, then what they give: its branches, mode instructions, image, agent, caches, screenshots, egress cache, digest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `linked-branch.mjs`                                                                         | A work run's issue branch, created at the base's head and linked to the issue before its sandbox starts, within `deny_link_branch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `access.mjs`                                                                                | What a run may reach from the operator's grants: hosts, mounts (checked twice), limits, the egress cache, an engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sandbox-spec.mjs`                                                                          | What a run starts, described for any runner: image, environment, user, limits, capabilities and volumes (`kind`: agent, session, cache, mount), no backend options. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `footer.mjs`                                                                                | The line under each reply: agent, provider, model, effort, speed, duration, the next step. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `restart.mjs`                                                                               | The queue and the live runs' states (in the store, `runs/<id>`, without their tokens), saved as they change: what a copy of the orchestrator leaves to the next one, and picking it up once the lease is held.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `brainstorms.mjs`                                                                           | Each issue's brainstorm (the store's `brainstorms`) and repo mode (the store's `modes`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `chats.mjs`                                                                                 | Users' chats from the dashboard (the store's `chats`, `/api/chats`): each a task of its own (`<repo>#chat-<id>`), its owner's alone; created within `CHATS_PER_USER`, its messages queued or sent to its inbox, its sandbox stopped `CHAT_IDLE_MINUTES` after the last one or its answer, reset and deleted ([Chats](#chats)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `requests.mjs`                                                                              | Chats' agents' requests for more permissions (the store's `permission-requests`, #479): read from the broker's stream, checked against the chat's ceiling, held for its owner's answer until `CHAT_PERMISSION_TIMEOUT`, answered back to the broker ([Chats](#chats)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `comments.mjs`                                                                              | Replies (comments, discussion threads), reactions (the orchestrator's, noted in the github service's store: a run never removes them), labels (`hasLabel`, `ensureLabel`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `questions.mjs`, `inputs.mjs`                                                               | Open questions → the needs-input label (`applyInput()`), parsed questions; the issues waiting for input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `answers.mjs`                                                                               | Answers to a task's open questions from the dashboard: checked, and the comment that stands for them. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `prompts.mjs`                                                                               | What the agent reads: each run's prompt and first message, comments delivered mid-run. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `agents/`                                                                                   | Each agent's specifics: install, env, hosts, session, tiers, `normalize()` ([Agents](#agents)); `common.mjs`: what they write the same way; `select.mjs`: a run's agent, provider, model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `modes.mjs`                                                                                 | Built-in modes, one `MODES` table: their volumes, their agent defaults, fresh, inbox, the dashboard's kind, their prompt; a repo's own (`customMode()`). What their runs may do is the policies'. Pure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `runlog.mjs`                                                                                | Run logs and records: the list rebuilt from the summaries after a restart (those a release before left in `logs/` moved to the store first), the dashboard's entries per line, the live stream (from the runner).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `history.mjs`                                                                               | Retention: the summaries and screenshots of runs older than `LOG_RETENTION_DAYS`, and their logs, removed by the runner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `analysis.mjs`                                                                              | Run analyses (the dashboard's Analyze): the runs picked, their digest, the analysis's issue and run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `events.mjs`                                                                                | Deliveries → work items, trigger, `/mode` and `/after` lines, task keys (`taskKey`, `parseKey`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `repo-config.mjs`                                                                           | `.deckhand.yaml`, read from the default branch and parsed, one `KEYS` table: each key's field, default, parser and row on the dashboard's config panel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `repo-settings.mjs`                                                                         | Each repo's settings as last read: its `users` for the dashboard, `wait_for_answers`, inboxes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `repo-check.mjs`                                                                            | The checks a dashboard action makes on a repo and user before acting as a comment would.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `grants.mjs`, `egress.mjs`, `lib/subnets.mjs`                                               | The operator's grants (hosts, mounts, limits, projects; the yes-or-no ones, `GRANTS`, asked of their policies' `allow_grant`), the egress policy and the proxy's CA; the runs' subnets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `github-app.mjs`, `github.mjs`                                                              | The App's tokens and calls (the github service's: `../github/`, edge's and the orchestrator's through `github/client.mjs`); `createGitHub()`, `getJson`, `paginate`, `graphql` and the stores' lookups on top.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `broker.mjs`, `lib/tokens.mjs`, `git-gateway.mjs`                                           | The runs' tokens (Ed25519 JWTs, signed by the broker service, checked here offline, each bound to its sandbox's network or pod); their pushes, to the run's own branches only, each branch then asked of the policies' `allow_push` and `deny_push`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `github-forks.mjs`                                                                          | What a work run that isn't a fork's may fetch through the GitHub gateway: no fork's repository, pull request head or commit, by git, the API, an archive, a page, a raw file, a workflow's artifacts or logs, or GraphQL (`Blob`, a fork's repository, an unnamed one's files), nor, through the git gateway, a branch pushed to reach a fork's objects (`git-mirror.mjs` `connect()`); a fork's run gets a clone of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `github-gateway.mjs`                                                                        | The sandboxes' GitHub calls, relayed by the egress proxy: the GitHub token in place of the run token, writes redacted, a review's thread reads refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `github-writes.mjs`                                                                         | The REST writes the GitHub gateway relays: classified, their target's kind read from GitHub, held to the built-in checks and the policies' `allow_github` and `deny_github`; the write permission each one's token needs (`writePermissions()`); the reads the policies decide (`read_checks`, `read_projects`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ci.mjs`                                                                                    | What CI says of a commit (`ciState()`): failed, running or passed, over Actions runs, check runs and commit statuses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `github-graphql.mjs`, `github-graphql-worker.mjs`, `vendor/`                                | The GraphQL the GitHub gateway relays: parsed with graphql-js (bundled at image build), validated against GitHub's pinned schema in a worker (`github-graphql-worker.mjs`), each mutation field a write for `github-writes.mjs`, printed again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `git-mirror.mjs`, `workflow-check.mjs`                                                      | The git gateway's mirrors of the repositories granted `workflows` or whose work runs push: the connectivity check of a work run's push against the repository's own objects, and the checks on the workflow files a granted repository's pushes change (a strict YAML subset).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `github-pulls.mjs`                                                                          | A run's own pull requests' writes (`gh pr create`, `edit`, `ready`): from its branches, their workflow files and conflicts checked, the token they need, the dashboard's record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `models-service.mjs`, `../models/` (`server.mjs`, `http.mjs`, `runs.mjs`, `logins.mjs`)     | The models service (#504), its own image, the only one holding the agents' credentials: the sandboxes' agent calls, from the egress proxy, their agent token checked offline (its `agent` claim, from its own sandbox, for a run the broker says goes) and swapped for the operator's credential; the plans' logins refreshed once for every copy, kept sealed in its store. The orchestrator.s calls to it: the credentials' names (before its settings are read) and fingerprints (for redaction), a run's API state at its end, its `models` stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `../models/anthropic.mjs`, `openai.mjs`, `upstream.mjs`, `lib/upstream.mjs`                 | The sandboxes' Claude and OpenAI API calls, with the operator's credential; what both endpoints share (`createApiProxy()`), and what every service that forwards a call as it streams does (`forward()`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `../models/chatgpt.mjs`, `agents/credentials.mjs`                                           | A ChatGPT plan's login for Codex, held and refreshed by the models service alone; the credentials' names, which the orchestrator's settings read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `../models/google.mjs`, `antigravity-login.mjs`                                             | The Antigravity CLI's calls (`/google/` with `GEMINI_API_KEY`, or `/relay/` from the egress proxy with the plan's access token); its Google AI plan login, held by the models service and refreshed by `agy` in a container the runner starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `secrets.mjs`, `lib/redact.mjs`, `lib/fingerprints.mjs`                                     | The operator's secrets (their fingerprints, from the models service) and the runs' GitHub tokens, redacted from replies, logs and GitHub writes (whole, parts of 16 characters or more, GitHub token shapes); a secret a service doesn't hold, by its fingerprint (a salted SHA-256 of the whole of it, from the service that holds it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `setup.mjs`, `auth.mjs`                                                                     | Edge's: `/setup` (creating the App, its manifest code converted by the github service) and signing in with GitHub, the sessions' epochs in edge's store (a sign-out ends the login's sessions on both copies).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docker.mjs`, `runner/`                                                                     | The docker CLI and its shared arguments (labels, hardening, limits, mounts); the runner `RUNNER` picks (`runner/index.mjs`: Docker, or Kubernetes), with its sandboxes (`runner/docker.mjs`, which turns a spec into `docker run` options, composed of `inbox.mjs` (its files, which the broker service has a copy of), `networks.mjs`, `volumes.mjs` (container engines, `engine.mjs`, and their storage) and `gc.mjs` (`relink()`)), its images and volumes (`runner/images.mjs`) and its short containers (`runner/jobs.mjs`: agent installs, cache chowns, the Antigravity login refresh). The Kubernetes runner (`runner/kubernetes.mjs`, through the API with `runner/kube-api.mjs`) has the same interface, with a pod, a Secret and claims per run, and its images and volumes in `runner/kube-images.mjs` (repo images built by BuildKit with `runner/buildkit.mjs` and pushed to a registry, `runner/registry.mjs`; agents' installs and caches as claims; its one job, the Antigravity login refresh, a pod whose stdin and stdout go through `runner/kube-attach.mjs`, its stdout sealed by `runner/kube-seal.mjs`); both read a sandbox's output with `runner/lines.mjs`. No other module calls `docker`, and only the runner service (`../runner/`) runs these. |
| `runner/deployment.mjs`                                                                     | The deployment's ID, kept in the runner's store, and its claim of its prefix: a marker (a volume on Docker, a Secret on Kubernetes, each backend's `claimPrefix()`) holding it, without which the runner service takes no call (#858).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `images.mjs`, `checkout.mjs`                                                                | Repo images (tags, hashes, pruning), the agent's install, caches, on the runner's images and jobs; checkouts, from the github service's tarball. The runner service's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `onboarding.mjs`                                                                            | Onboarding issues and their run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `auto-pickup.mjs`                                                                           | Auto-pickup: the oldest open issues labelled `AUTO_PICKUP_LABEL` in the repos that opt in, started by the orchestrator itself in `AUTO_PICKUP_SLOTS` (`startable()` keeps those slots theirs), for whoever added the label (for the follow-ups the reviews file with it, whoever merged their pull request).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `conflicts.mjs`                                                                             | The conflict watcher: open task pull requests in conflict get a rebase run (the store's `conflicts`), unless `deny_fix` refuses it (a "No rebase run" comment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `projects.mjs`                                                                              | A repository's issues on its granted projects (v2) (`projects:`): added, and their field set when a work run starts, and with the pull request closing them when it turns ready and when it merges.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `reviews.mjs`                                                                               | Pull request reviews: the ready pull requests that get one (the store's `reviews`), the GitHub review posted from the run's final message, its fix run and auto-merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `reviewers.mjs`                                                                             | The reviewers a repo's `review.request` names, requested on Deckhand's pull request when it turns ready and after a run moved its head (the store's `requested`), within `deny_request_review`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `policies.mjs`, `policy-client.mjs`, `lib/policy-files.mjs`                                 | Rules as code: `allow_*` and `deny_*` Rego rules in two layers, the operator's (Deckhand's `policy/` under `GRANTS_DIR/policy/`, by file name) and a repo's (`.deckhand/policy/`, which the orchestrator reads and sends), each decision's input and what its refusal says, fail closed; evaluated by the policy service (`POLICY_SERVICE_URL`, [The policy service](#the-policy-service)), with a service token; the operator's policy files and their digest, read alike by the orchestrator and the policy service (`lib/policy-files.mjs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `waits.mjs`                                                                                 | Comments waiting for other issues to be done (`/after`, the store's `waits`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `work.mjs`                                                                                  | The graph's work area: the backlog, starting or queueing issues, answers, reruns, dismissals, inbox entries, lane names, analyses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `order.mjs`                                                                                 | The run order: which queued task starts next when a slot frees, as the maintainer placed them (the store's `order`, a rank per task).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dismissals.mjs`                                                                            | Failed runs dismissed from the dashboard, and runs whose questions were set aside (their label taken off, their issue or pull request closed), while each is its task's last (the store's `dismissed`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `picks.mjs`                                                                                 | Auto-picked work that is over (its issue closed, its pull request merged or closed, or the sweep gave its slot away), by task → its last run then: what is queued on the task after that doesn't follow the pick, a reopen included (the store's `picks`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lanes.mjs`                                                                                 | The board's lanes' names: typed on the dashboard, a plan's or GitHub's parent, or an inbox (the store's `lanes`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `plans.mjs`                                                                                 | A parent issue dropped on the graph: its sub-issues' tree, all levels down, and what each waits for from their "blocked by" links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `discussions.mjs`                                                                           | Discussions from the dashboard: started, their thread read, replies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `board.mjs`, `titles.mjs`, `pulls.mjs`, `repos.mjs`                                         | The dashboard's tasks, titles and closed states, pull requests, repository list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `static.mjs`                                                                                | Edge's: the dashboard's files (`dashboard/dist`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `repo-view.mjs`                                                                             | A repository's config as the dashboard shows it: what its runs get, from the runs' own checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `lib/health.mjs`                                                                            | Every service's `GET /health` answer: `{ ok, startedAt, version }` and the fields it already sent (`app`, `active`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lib/services.mjs`, `lib/service-token.mjs`                                                 | The services and which calls which (#499); the service tokens the broker signs for those calls, each bound to its caller's network or pod, and each endpoint's callers (`serviceGuard()`) ([security.md, Service tokens](security.md#service-tokens)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lib/service-client.mjs`, `lib/fence.mjs`                                                   | Calling another service: its URLs, the caller's service token, a service away waited for rather than failed; the orchestrator's fencing epoch on each call, and the check the services called make of it (an older one refused, 409).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lib/active.mjs`                                                                            | Active/passive: of a service's two copies, the one holding its lease in the store acts, the other waits to take over; each holder's epoch higher than every one before it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lib/store.mjs`, `lib/store-file.mjs`, `lib/store-redis.mjs`, `lib/resp.mjs`                | The store (above): its file and Redis backends, the Redis client.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lib/store-checks.mjs`, `lib/store-map.mjs`                                                 | The arguments both store backends check alike; the maps kept in the store one key per item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lib/blobs.mjs`, `lib/s3.mjs`                                                               | Blob storage (`BLOB_URL`: S3, a folder or the store) and the S3 client under it (above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lib/seal.mjs`                                                                              | What a service keeps in the store that is a secret (the broker's last run token, the models service's plan logins), sealed with AES-256-GCM under a key that service alone holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lib/log.mjs`                                                                               | The services' own log lines (#547): one per call, JSON or text (`LOG_FORMAT`), with the request, repository, issue and run they belong to, redacted first; a request's ID passed on from one service to the next.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lib/drain.mjs`                                                                             | Draining a server on SIGTERM, every service's: no new connection, the requests in flight finished, each connection closed once its answer is sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lib/metrics.mjs`                                                                           | Every service's Prometheus metrics (#651, #652): its registry of counters, gauges and histograms, their labels bounded (a value outside those declared, or a series past `MAX_SERIES`, folded into `other`), the text format, `METRICS_PORT`'s server (`GET /metrics` alone, no token), and the metrics every service shares (`buildInfo()`, `processMetrics()`, `leaseMetric()`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `metrics.mjs`                                                                               | The orchestrator's metrics (#654), on that registry: the runs' lives, the queue and its slots, the deliveries, the checks it makes on its own (conflicts, review fix rounds, `/after` waits), model fallbacks, its calls to the other services; what only the acting copy knows, collected at each scrape from it alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `../<service>/metrics.mjs`                                                                  | Each other service's metrics, on the same registry: edge's (`edge/metrics.mjs`, #655), the github service's (#656), the models service's (#657), the egress proxy's (`proxy/`, #658), the runner's (#659), the broker's and the policy service's (#660); what each counts: [setup.md, Metrics](setup.md#metrics).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lib/files.mjs`, `html.mjs`, `web.mjs`, `lib/http.mjs`                                      | Shared helpers: JSON state files written whole; HTML pages; the API's `apiRoute`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
