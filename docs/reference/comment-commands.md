# Comment commands

You drive Deckhand from GitHub comments. The first line of a comment is the command, the rest
are instructions for the agent. Only GitHub logins in `ALLOWED_USERS` (and the repository's own
`users`, when its `.deckhand.yaml` names some) are heard, and what each may do on a repository
is your policies' [access](../repo-config/policies.md#access) rules: anyone else's comments start
nothing, and get no answer.

```text
Deckhand /model best
Add a dark mode to the settings page.
```

## The trigger

`Deckhand` (your `TRIGGER`, or the repository's `trigger`) alone on the first line of a comment
on an issue starts a run there: a sandbox on the branch `issue-<n>-<slug>`, a draft pull
request, and the agent's final message as a comment from the App's bot.

- **The whole first line**, compared loosely: any case or punctuation (`@deckhand:` too). So
  "Deckhand is down" starts nothing.
- **Later comments continue the session**: once an issue has one, any comment on the issue or
  its pull request (reviews and review comments too) goes on in it, without the trigger. A
  burst of comments is one message, and a comment that arrives while the agent works reaches
  the running session (Claude Code; Codex and the Antigravity CLI take it at their next run).
- **On a pull request** of its own (one that closes no issue), the trigger starts a run on its
  branch.
- **Commands may follow it on its line**, each with its value: `Deckhand /agent codex /mode
brainstorm`. Anything else on that line and it isn't the trigger.

What you see while it runs: 👀 on your comment when it is received, then 🚀 (done), 😕
(waiting for your input) or 👎 (an error). A run that needs a decision only you can make asks
numbered questions on the issue, labelled `needs-input` (`NEEDS_INPUT_LABEL`), and your answer
continues the same session.

## Commands

Each command is a line of its own, anywhere in the comment, or follows the trigger on its first
line. When a comment has the same command twice, the last one wins.

| Command                    | What it does                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/mode <name>`             | picks the run's mode: `work`, `brainstorm`, `research`, `onboarding`, `review`, `policy` or one of the repository's own ([Modes](#modes)) |
| `/model <name>`            | the run's model: a tier, `best`, `balanced` or `fast`, or a model's own name ([Models](../guides/agents.md#models-and-efforts))           |
| `/effort <level>`          | the run's thinking effort: `low`, `medium`, `high`, `xhigh` or `max`                                                                      |
| `/speed <speed>`           | `fast` asks for Claude Code's fast mode, `normal` drops it ([Fast mode](../guides/claude-code.md#fast-mode))                              |
| `/agent <entry>`           | the agent, and its provider or credential: `codex`, `claude@openrouter`, `claude@anthropic:key`; `default` goes back ([Agent](#agent))    |
| `/after #12`               | holds the comment back until those issues are done ([Waiting for other issues](#waiting-for-other-issues))                                |
| `/machine <name or label>` | runs the issue on one of your own machines instead of a sandbox; `none` goes back ([Machines](#machines))                                 |
| `/stop`                    | alone on the first line: wraps a brainstorm up                                                                                            |
| `/cancel`                  | alone on the first line: stops the issue's run now ([Stopping a run](#stopping-a-run))                                                    |
| `/allow`, `/deny`          | on the first line: answers a machine run's request for a permission ([Machines](#machines))                                               |

`/model`, `/effort`, `/speed` and `/agent` with a value they don't take (`/effort huge`) stay in
the text, as instructions, and change nothing.

### Modes

A `/mode <name>` line picks the run's mode (names aren't case-sensitive, and `/mode` is never
read as `/model`):

- **`work`**, the default: implement, on the issue's branch, with a pull request.
- **`brainstorm`**: discuss the issue in its comments, without code. `/stop` wraps it up: the
  agent files the follow-up issues you kept and sums up. The trigger line alone, or `/mode work`,
  then implements, in a session of its own that starts from the issue and its comments.
- **`research`**: answers a question from the open web, without the repository's code or a
  GitHub token, once your policies grant the repository `research`
  ([The grants](server-folder.md#the-grants)).
- **`onboarding`**: proposes the repository's `.deckhand.yaml`
  ([Onboarding](../repo-config.md#onboarding)).
- **`review`**: a review of the pull request, when the repository's `review` block turns it on
  ([Reviews](../repo-config/reviews.md#reviews)).
- **`policy`**: a dry run of the policies on the issue, no run
  ([A dry run and the dashboard](../repo-config/policies.md#a-dry-run-and-the-dashboard)).
- **A repository's own**, declared under `modes:` in its `.deckhand.yaml`.

With the trigger line, `/mode` starts that mode. Alone, on an issue that already has a session,
it switches: the new mode goes on in the same conversation when both get the same volumes. An
unknown name gets a reply listing the modes, and nothing runs. The details:
[Modes](../repo-config/modes.md#modes).

### Agent

`/agent <entry>` picks the agent that runs the issue, among those you configured: an agent alone
(`codex`, `antigravity`, `claude`) on its default provider, or an entry of
[Agents and providers](../guides/agents.md) (`claude@openrouter`,
`claude@anthropic:key`). The issue stays with it, without [fallbacks](../guides/fallbacks.md),
until another `/agent`; `/agent default` goes back to the repository's agent or yours. Anything
you haven't configured gets a reply naming what is, and nothing runs. A new agent starts a
session of its own, handed the branch and the previous agent's last message.

A run's model belongs to its agent: `/model opus` on a Codex run doesn't start, and the reply
says why. Tiers (`best`, `balanced`, `fast`) mean something to every agent.

### Waiting for other issues

`/after #77` (`/after #77 #80` for several, issues or pull requests of the same repository)
holds the comment back until those issues are closed as completed, or those pull requests
merged, then runs it as if just posted. Deckhand asks GitHub again every `WAITS_CHECK_MINUTES`.
A new trigger comment starts now instead, and `/after none` cancels the wait. The dashboard
shows what waits for what.

### Stopping a run

`/cancel`, alone on the first line, stops the issue's running run now (a stuck one, say). Its
reply says who stopped it; its session and pushed commits stay, and the next comment resumes
it. On a queued task (waiting for a slot), `/cancel` drops its queued comments: it is back in
the backlog. With nothing running or queued, it gets a reply saying so. The task's page on the
dashboard has the same **Stop** and **Remove from queue** buttons. On an inbox issue, `/cancel`
stops that entry's run.

### Machines

In a repository whose `.deckhand.yaml` has a `machines:` block (and that you grant `machines`),
`/machine <name or label>` runs the issue on one of its author's own machines instead of a
sandbox, as a `runs-on:<label>` label does for whoever added it. Alone, it starts nothing: the
next trigger runs there. `/machine none` sends the issue back to sandboxes
([Routing an issue to a machine](../repo-config/issues.md#routing-an-issue-to-a-machine)).

When the agent on a machine asks for a permission, the App's comment says so, and the machine's
owner answers on the first line of a comment: `/allow` (this call), `/allow run` (that tool's
calls for the rest of the run) or `/deny`, with the request's id while several wait
(`/allow a1b2c3`). Anyone else's answer is ignored; none within `CHAT_PERMISSION_TIMEOUT` denies
it ([MCP clients](../guides/mcp-clients.md#machine-tools)).

## Inboxes and discussions

A comment on a repository's ideas or bugs issue, or a discussion in its discussions category, is
an entry: it needs no trigger, and each is a run of its own with its own reply
([Inboxes](../repo-config/issues.md#inboxes)). `/model`, `/effort`, `/speed` and `/agent` may end
any of its lines (`Dark mode /effort high`), outside code blocks and quotes; `/mode` and
`/after` don't apply there, and stay text.

## Labels

Two labels act like commands, from whoever adds them (an allowed user):

- **`auto-pickup`** (`AUTO_PICKUP_LABEL`) asks Deckhand to start the issue by itself, in the
  slots you set aside, in a repository that turns it on
  ([Auto-pickup](../guides/auto-pickup.md)).
- **`runs-on:<label>`** routes the issue to that person's machines with that label
  ([Machines](#machines)).
