# How a run ends

At each result the agent gives, the comments waiting for it go to its inbox, or the inbox closes and
the agent exits: its last result is the reply, posted once its sandbox exits (`follow()`,
`finish()`). Headless Claude Code runs with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`
(`sandbox/agents/claude.sh`), and the prompt tells the agent to wait for its work in the foreground:
an agent that ends its turn with background work left gives an early result, and may go on with a
turn per background task, or never exit. As a safety net, a result with the inbox closed marks the
run `answered` (saved state) and starts a 2-minute timer (`run-output.mjs` `linger()`, `ANSWER_GRACE_MS`);
any output restarts it. Its deadline is saved (`graceUntil`): an orchestrator that restarts gives it
its whole grace while its follow skips the output read before, then keeps to that deadline, with at
least 10 s to read what the sandbox wrote while no orchestrator was there (Restarts). If the sandbox
is still running, silent, when it fires, the orchestrator writes an `ended` line to the run's log
("Stopped at … after its answer" on the dashboard), stops the sandbox and ends the run as usual,
with its last result as the reply.

## Brainstorms

`Deckhand` then `/mode brainstorm` (or `Deckhand /mode brainstorm` on one line) starts a brainstorm
instead: Claude discusses the issue (`prompts/brainstorm.md`) without writing code, and each later
comment on the issue is the next message of that conversation. A brainstorm run (without `push` with
Deckhand's default policies: `SANDBOX_LIGHT`) starts after a short pause (`BRAINSTORM_DEBOUNCE_MS`)
and goes before queued work. `/stop` ends it: Claude files the follow-up issues the maintainer kept
(proposed under Follow-ups along the way), posts a summary and updates the issue's description
(settled questions in a Decisions section, Open questions keeping what is left), then comments no
longer reach it until a trigger line. After `BRAINSTORM_IDLE_MINUTES` (10) without a comment it
shows as idle; a comment then restores it from the issue's session volume. `Deckhand` or
`/mode work` afterwards implements in a session of its own, which starts from the issue: the
brainstorm's comments and the description its wrap-up updated. Light runs (the built-in modes with
`volumes` in `modes.mjs`: brainstorms, onboarding, inbox entries, discussions, analyses, reviews,
research) never share a writable volume with the issue's work runs: they have their own clone and
session (`<name>-light-workspace`, `<name>-light-claude`; `<name>-light-push-…` when the policies
give one `push`), no caches without `setup`, and host mounts read-only without `push`, so nothing
they leave behind (git hooks, Claude settings) runs with a work run's token. Issues only.

## Chats

A chat (`listener/chats.mjs`, #476) is a conversation a user starts from the dashboard, on one
repository, without an issue: `POST /api/chats` (`{ repo, agent, model, effort, message }`, all
but `repo` optional) creates it, `POST /api/chats/<id>/messages` sends the next message, `POST
/api/chats/<id>/reset` drops its volumes and session but keeps it, `DELETE /api/chats/<id>`
deletes it, and `GET /api/chats` lists the caller's own. Each is a task of its own, kind
`chat`, keyed `<repo>#chat-<id>` (16 hex digits), so its runs are any run's (`runs.mjs`): its
sandbox, tokens, capabilities, inbox, log and restarts. What differs:

- its task has an `owner` (the chat's, whose task it is alone) and a `pool`, `chats`. Every task has
  both (`tasks.mjs` `newTask()`): the others have no owner and are in `shared`, under
  `MAX_PARALLEL`, `AUTO_PICKUP_SLOTS` and the repos' `max_parallel`; `startable()`
  (`repo-config.mjs`) counts each other pool against its own cap (`chats`: `MAX_RUNNING_CHATS`, 2; a
  task routed to a user's machines, `machines` then `machine:<id>`, which only a machine's claim
  starts: `claims.mjs`), so the auto-pickup sweep and the board's queue only ever see `shared`. Its
  first message starts its sandbox at once (no debounce). Each answer leaves its inbox open
  (`run-output.mjs` `output()`): the next message goes there, and the agent's turns stream like any run's
  log;
- `CHAT_IDLE_MINUTES` (30) after its last message or its run's last answer, whichever came later (a
  message that waited for a slot is answered after it), its inbox closes (`runs.mjs` `rest()`), so
  the agent exits once it has answered, and the sandbox stops after the usual grace if it doesn't.
  The next message starts it again from the chat's volumes, in the same session, as a brainstorm
  resumes (`prompts.mjs` `firstMessage()`, `entrypoint.sh`). An inbox not known open after a restart
  (the runner didn't answer) is closed at the runner all the same. An agent that takes no message
  mid-run (Codex, the Antigravity CLI: `takesMessages` false) answers one run per message instead,
  each a new sandbox in the same session, which exits once it has answered;
- its mode is `chat` (`modes.mjs`, `prompts/chat.md`): volumes apart from the repository's
  issues (`<repo's chat name>-light-…`, a sandbox name of its own), the light runs' agent,
  model and effort unless the chat names its own, and `policy/mode-chat.rego`'s capabilities:
  the code, its reads and the setup, no `push`, no engine, no GitHub write (no `allow_github`),
  no caches (`preparation.mjs`: its workspace is its own and kept);
- nothing goes to GitHub: no reply (`run-replies.mjs` `post()`), no reaction, no label, no project,
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
- a reset or a deletion stops its sandbox (`run-end.mjs` `cancel()`), waits for its end, then has
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
  [Chats](../security/policies.md#chats).
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
chat, what it may do and where its data lives: [Chats](../security/policies.md#chats).

## Modes

A `/mode <name>` line picks a mode: work, brainstorm or one of the repo's own (its config's
`modes:`), with the trigger line, or alone on an issue that has a session, which then goes on in the
new mode with its conversation so far. A repo's mode brings its own instructions, model and effort
(work's by default) and shares the issue's volumes; a fresh one starts a new session each time. What
a mode's runs get, write and push is the policies' only (`allow_capabilities`, `allow_github`,
`allow_push`): a mode itself has no trait for it. A built-in mode's `MODES` entry keeps where its
volumes are (`volumes`: `apart`, `research`) and whose agent and model it defaults to (`defaults`:
`brainstorm`, the light runs'). Comments without a trigger or `/mode` line go on in the issue's
current mode (the store's `modes`).

`/mode research` (repos granted `research`: [the grants](../reference/server-folder.md#the-grants)) is a built-in
mode for the open web (`volumes: "research"` in `modes.mjs`, `internet` alone in
`policy/mode-research.rego`): any public host (`researchAccess()` in `access.mjs`), and nothing of
the repo's. No clone (`SANDBOX_NO_CLONE`), no GitHub token (no `pull` capability,
so the GitHub gateway refuses it: GitHub's hosts aren't relayed for it, and it reads public
GitHub anonymously through a tunnel), the base image, no setup, caches, mounts, engine, CA or
screenshots, and volumes of its own
(`<name>-research-…`). Its input is the issue's thread, which `preparation.mjs`
(`threadDigest()`) writes into the run's inbox like an analysis's digest; its output, its
reply (`prompts/research.md`).

## Inboxes and discussions

A repo's config may name an ideas issue, a bugs issue and a discussions category. Every
comment on those issues is an entry, answered in a fresh session (`prompts/idea.md`,
`prompts/bug.md`); each discussion in the category is a conversation of its own, like a
brainstorm (`prompts/discussion.md`). No trigger line there.

## Onboarding

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
