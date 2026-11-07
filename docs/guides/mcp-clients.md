# MCP clients

Deckhand is an MCP server too, at `<PUBLIC_URL>/mcp`: an MCP client (Claude Code, Codex,
Cursor…) reads what the dashboard shows you, as you, and acts as you would there. Connect one
when you'd rather ask your own agent about your runs than open the dashboard; a machine's
driver connects the same way ([Your own machine](machines.md)). In Claude Code:

```sh
claude mcp add --transport http deckhand https://deckhand.example.com/mcp
```

then `/mcp` in Claude Code, **Authenticate**: your browser opens Deckhand's sign-in (GitHub, as
for the dashboard, skipped when you are signed in already) and a page naming the client and
what it asks for; **Allow** sends you back to it. Other clients take the same URL, as a
"Streamable HTTP" server with OAuth. Settings › MCP clients lists the clients you connected,
with **Revoke**; signing out of the dashboard signs them out too. Behind a reverse proxy, the
public URL (`PUBLIC_URL`) must be the address clients connect to: the sign-in's metadata names
it, and a browser page from another origin is refused.

## Read tools

Its read tools need the `deckhand:read` scope:

| Tool           | What it gives                                                                                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_repos`   | The repositories you see, whether each is set up, and its backlog's size                                                                                                                                                                                               |
| `list_tasks`   | The board's tasks, 25 at a time (`limit` up to 100, `cursor`, a page's `next`, for the one after it, which tasks starting or moving meanwhile don't shift; `repo`, `state` to narrow them): each issue or pull request, its state, its runs and how the last one ended |
| `list_runs`    | A task's runs (`task`: `owner/repo#12`, `owner/repo#pr-12`), the newest first: id, mode, agent and model, start, duration, outcome                                                                                                                                     |
| `get_run_log`  | A run's log as text, a page at a time (64 KB of the log by default, `limit` up to 1 MB; `from` for another page): the newest page first, from the start of the line it would cut when that is near                                                                     |
| `get_schedule` | The runs going, the queue in its run order, what waits for which issues, the lanes, and the backlog (`repo`: its open issues; else counts)                                                                                                                             |

## Write tools

Its write tools need the `deckhand:work` scope, and act as you would on the dashboard: the same
checks (your access on the repository, its `users`, the issue's state, its open questions), and
the same App comment on the issue, in your name. Clients mark them as tools that change things,
so they ask before calling them:

| Tool       | What it does                                                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rerun`    | A task's last run again (`runId`), when it failed, was interrupted or stopped: the dashboard's **Rerun**                                                                                                                                                                                                                          |
| `schedule` | An issue of `repo` (`number`) as dragging it on the graph does, or the task page's **Stop**: `action` `start`, `queue` (waits for issue `after`), `plan` (a parent issue and its sub-issues, after `after` if given), `dequeue` (stops waiting) or `cancel` (stops its run or drops its queued comments; `pr` for a pull request) |

## Machine tools

A machine's driver asks for the `deckhand:machine` scope, which no client gets unless it asks
for it: its tools register one of your own computers and claim the issues routed to it
(machines, #594: a `runs-on:<label>` label or a `/machine` comment,
[repo-config/issues.md](../repo-config/issues.md#routing-an-issue-to-a-machine)). An agent then runs there on its
own, with your files, credentials and network: Deckhand suggests settings and enforces none
there.

| Tool                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register_machine`   | Registers a machine (`name`, unique among yours; `labels`; `capacity`, 1 by default; `repos`, `owner/name` or `owner/*`), or again under the same name: its id, and the repositories offered to it now                                                                                                                                                                                                                                                     |
| `heartbeat`          | Says the machine (`machine`, its id) is there, every 30 s: it is online while its last heartbeat is under 90 s old, and its claims' leases (2 min) are renewed, those of `runs` alone when given; returns its claims                                                                                                                                                                                                                                       |
| `claim`              | Waits up to 25 s for the next task routed to the machine and claims it (`agent`, `model` and `effort`: what it runs, for the run's record; `agentVersion`, `sandbox`, `permissionMode`, `suggestedSettings`: how, as the machine reports it): repository, issue, branch, mode, prompt and message (`resume`: its session goes on), the URL to clone and the hosts its agent's sandbox may reach, or none. The claim is a run on the dashboard from then on |
| `post_events`        | Sends the claimed run's agent output (`lines`, its stream-json lines; `from`, how many it sent before): its log on the dashboard. At a result line, the comments waiting go to `next_message`, or its inbox closes                                                                                                                                                                                                                                         |
| `next_message`       | Waits up to 25 s for the comments that reach the run (`from`, how many it read): messages for its agent, or `closed` once no more will come                                                                                                                                                                                                                                                                                                                |
| `ask`                | Ends the run waiting for input: `question` posted on the issue as the App, the issue labelled, as a sandbox run that asks (`branch` and `sha`: as `finish`'s, its pull request left a draft)                                                                                                                                                                                                                                                               |
| `finish`             | Ends the run (`outcome` `ok`, `error` or `needs-input`): `reply` posted as the App, then what follows any run (the review's fix loop, a CI fix, the queue). `branch` and `sha`: the issue's branch you pushed and its head, whose draft pull request the App opens first (`ready`: ready for review)                                                                                                                                                       |
| `approve_permission` | For Claude Code's `--permission-prompt-tool`: asks you whether the run's agent may make a tool call (`tool_name`, `input`, `tool_use_id`), on the dashboard and in a comment on the issue; waits up to 25 s for your answer (`pending`: ask again with the same `tool_use_id`)                                                                                                                                                                             |
| `release`            | Gives a claim (`run`) back: its run ends as interrupted, the issue told, and its comments wait again for this machine, as after a lease that runs out                                                                                                                                                                                                                                                                                                      |
| `unregister_machine` | Removes the machine, as its **Remove** in Settings › MCP clients does: its claims end                                                                                                                                                                                                                                                                                                                                                                      |

The run tools (`claim` and those after it) take the `protocol` the driver speaks (1 now): an
update of Deckhand keeps taking the previous one, so a driver has an update's time to follow.

A machine run's agent that has to ask for a permission (one its settings neither allow nor deny)
asks you through `approve_permission` (#600): the task's page shows the tool and its input, and
a comment on the issue mentions you. Answer **Allow once**, **Allow for this run** (that tool's
later calls in the run are allowed without asking) or **Deny** there, or comment `/allow`,
`/allow run` or `/deny` on the issue (with the request's id, `/allow a1b2c3`, while several
wait). Only your answer counts, anyone else's is ignored; none within `CHAT_PERMISSION_TIMEOUT`
(10 minutes) denies it. Deckhand only relays and records these: what the machine allows or
denies without asking is its own settings'.

The machine pushes with your own git, to the issue's branch in the repository itself (`claim`'s
`branch`, `issue-<n>-<slug>`), then names it in `finish` with the commit it pushed: Deckhand
checks the branch is the issue's, on the repository (never a fork), at that commit, and the App
opens the draft pull request (`Closes #<n>`), or finds the one it opened, so its review and fix
loop run as for a sandbox's; a fix round pushes to the same branch. The dashboard shows it as
your machine's, and Deckhand's default policy never merges it by itself
([`machines.rego`](../repo-config/policies.md#machinesrego)).

A repository is offered to a machine only when the operator's policies grant it `machines`
([security.md](../security/policies.md#the-grants)) and its `.deckhand.yaml` has a `machines:` block
([repo-config/issues.md](../repo-config/issues.md#machines)), and only where you may start runs.

## Scopes

A client gets `deckhand:read` and `deckhand:work` by default; the sign-in page lists them, and a client asking for
`deckhand:read` alone gets the read tools only. What the dashboard refuses (an issue running
already, a run that didn't fail, an action your access lacks) is the tool's error, with the
dashboard's message.

Each shows what your access shows you on the dashboard, nothing of the repositories you don't
see. A run's log can hold what its agent read (issues, command output, web pages): your
client's model reads it as data, which the tool's description tells it, but treat a log as you
would any text from the repository.
