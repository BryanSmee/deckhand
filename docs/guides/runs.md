# Start runs

How to start a run from GitHub, stop it, and pick its mode, agent and model. Read it once the
App is [installed](github-app.md) on a repository. The dashboard starts, queues and stops runs
too: see [The dashboard](dashboard.md). Every command a comment takes, in one list:
[Comment commands](../reference/comment-commands.md).

## The trigger

On an issue of an installed repository, an allowed user comments `Deckhand` (the whole first
line, any case or punctuation; the rest are instructions). The sandbox opens the branch
`issue-<n>-<slug>` and a draft pull request, and Claude's final message comes back as a comment
from the App's bot. The next comment on the issue or its pull request continues the same
session.

## Modes

`Deckhand` then a `/mode brainstorm` line (or `Deckhand /mode brainstorm`) discusses the issue
without code; `/stop` wraps it up.

`Deckhand /mode research` answers a question from the open web, without the repository's code
or a GitHub token, once your policies grant the repository `research` (an `allow_grant` rule in
`grants/policy/`: [the grants](../reference/server-folder.md#the-grants),
[Research runs](../security/policies.md#research-runs)).

`Deckhand /mode review` on a pull request reviews it, once its repository's `review` block
turns reviews on; the block can also review every pull request marked ready, send a fix run
after a review that asks for changes, and (unsafe, with the operator's `auto_merge` grant) merge
Deckhand's own pull request after a clean one: [Reviews](../repo-config/reviews.md#reviews),
[Auto-merge](../repo-config/reviews.md#auto-merge).

A repository's own modes, and what each built-in one is for: [Modes](../repo-config/modes.md).
Ideas, bug reports and questions without a trigger line: [Inboxes](inboxes.md).

## Stop a run

`/cancel` (the whole first line) stops the issue's running run now, and the task's page on the
dashboard has a **Stop** button that does the same: the run's reply says who stopped it, and its
session and pushed commits stay. A stopped task waits for you: nothing starts on it again until
a trigger comment (or a `/mode` line, or the dashboard's Start, Queue, Rerun or Fix), which
resumes the session. A comment without one is left alone, the conflict watcher starts no rebase
run and the review loop no fix run, and comments that came in during the stopped run wait to go
with that trigger. On a queued task (waiting for a slot), `/cancel` and the page's **Remove from
queue** drop its queued comments: it is back in the backlog. With nothing running or queued,
`/cancel` gets a reply saying so.

## Commands on the trigger's line

`/mode`, `/after`, `/machine`, `/agent`, `/model`, `/effort` and `/speed` may share the
trigger's line, alone or together (`Deckhand /agent codex /mode brainstorm`), as well as follow
it on lines of their own; anything else on that line and it isn't the trigger. In an inbox entry
(an idea, a bug, a discussion), `/agent`, `/model`, `/effort` and `/speed` may end any line
(`Dark mode /effort high`) outside code blocks and quotes.

Which agent and model a run gets: [Agents and providers](agents.md). `/speed fast`:
[Fast mode](claude-code.md#fast-mode). `/machine`: [Your own machine](machines.md).
