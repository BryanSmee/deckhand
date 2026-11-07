# Start runs

How to start a run from GitHub, stop it, and pick its mode, agent and model. Read it once the
App is [installed](github-app.md) on a repository. The dashboard starts, queues and stops runs
too: see [The dashboard](dashboard.md).

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
`grants/policy/`: [the grants](../security/policies.md#the-grants),
[Research runs](../security/policies.md#research-runs)).

A repository's own modes, and what each built-in one is for: [Modes](../repo-config/modes.md).

## Stop a run

`/cancel` (the whole first line) stops the issue's running run now, and the task's page on the
dashboard has a **Stop** button that does the same: the run's reply says who stopped it, its
session and pushed commits stay, and the next comment resumes it. On a queued task (waiting for
a slot), `/cancel` and the page's **Remove from queue** drop its queued comments: it is back in
the backlog. With nothing running or queued, `/cancel` gets a reply saying so.

## Commands on the trigger's line

`/mode`, `/after`, `/machine`, `/agent`, `/model`, `/effort` and `/speed` may share the
trigger's line, alone or together (`Deckhand /agent codex /mode brainstorm`), as well as follow
it on lines of their own; anything else on that line and it isn't the trigger. In an inbox entry
(an idea, a bug, a discussion), `/agent`, `/model`, `/effort` and `/speed` may end any line
(`Dark mode /effort high`) outside code blocks and quotes.

Which agent and model a run gets: [Agents and providers](agents.md). `/speed fast`:
[Fast mode](claude-code.md#fast-mode). `/machine`: [Your own machine](machines.md).
