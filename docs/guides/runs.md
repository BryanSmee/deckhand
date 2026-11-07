# Start runs

How to start a run from GitHub, stop it, and pick its mode, agent and model. Read it once the App is installed on a repository.

On an issue of an installed repository, an allowed user comments `Deckhand` (the
whole first line, any case or punctuation; the rest are instructions). The sandbox opens the
branch `issue-<n>-<slug>` and a draft pull request, and Claude's final message comes back as a
comment from the App's bot.
`Deckhand` then a `/mode brainstorm` line (or `Deckhand /mode brainstorm`) discusses the issue
without code; `/stop` wraps it up. `/cancel` (the whole first line) stops the issue's running
run now, and the task's page on the dashboard has a **Stop** button that does the same: the
run's reply says who stopped it, its session and pushed commits stay, and the next comment
resumes it. On a queued task (waiting for a slot), `/cancel` and the page's **Remove from queue**
drop its queued comments: it is back in the backlog. With nothing running or queued, `/cancel`
gets a reply saying so.
`/mode`, `/after`, `/machine`, `/agent`, `/model`, `/effort` and `/speed` may share the trigger's line, alone or
together (`Deckhand /agent codex /mode brainstorm`), as well as follow it on lines of their
own; anything else on that line and it isn't the trigger. In an inbox entry (an idea, a bug, a
discussion), `/agent`, `/model`, `/effort` and `/speed` may end any line (`Dark mode /effort high`)
outside code blocks and quotes.
`Deckhand /mode research` answers a question from the open web, without the repository's
code or a GitHub token, once your policies grant the repository `research` (an `allow_grant`
rule in `grants/policy/`: [the grants](../security.md#the-grants), [Research runs](../security.md#research-runs)).
