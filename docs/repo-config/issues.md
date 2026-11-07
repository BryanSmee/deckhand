# Per-repo config: issues

Part of the [`.deckhand.yaml` reference](../repo-config.md): how a repository's issues reach
Deckhand and move on, from inboxes, preview deployments, conflicts and projects to open
questions, chats, machines and auto-pickup.

## Inboxes

Places where a maintainer drops something for Claude to handle, without a trigger line.
Only `ALLOWED_USERS` (narrowed by `users`) are answered; others are ignored, like anywhere.
They are light runs, like brainstorms: no branch, no `setup`, the brainstorm model.

- **Ideas and bug reports**: an open issue each (pin them), named by its number. Every
  comment on it is an entry: Claude reads the code, looks for an existing issue, and
  creates one (labelled `idea` or `bug` plus those of the repo that fit, with Problem,
  Proposal, Acceptance criteria and Open questions; a bug also gets its likely cause, a big
  idea sub-issues). Its reply on the inbox links what it created or found, or answers when
  there is nothing to file. Each entry starts a new session: a follow-up is read from the
  inbox's earlier comments. Prompts: `prompts/idea.md`, `prompts/bug.md`.
  The dashboard sends entries too: New request, in its sidebar, opens a form (Idea or Bug
  report, then a repository with that inbox, a title and details), which posts them on the
  inbox issue as the App's comment, ending "From the dashboard by @you", and starts the same
  run.
- **Discussions**: a category of the repository's GitHub Discussions (create it first, for
  example "Ask Claude"; compared loosely, emoji aside). A new discussion in it, and every
  later comment of an allowed user, gets an answer in the discussion, in the thread of the
  comment it answers; the discussion keeps one session, like a brainstorm. When it settles
  on something to build, Claude files an issue and links it. Other categories are never
  read. These runs alone get a token with the Discussions permission (see
  [Create the GitHub App](../guides/github-app.md#apps-created-before-an-event) for an App created before it). Prompt: `prompts/discussion.md`.
  The dashboard starts discussions too (New request, Discussion: a title and details) and follows
  them: a discussion's page shows its thread, Deckhand's answers included, with a reply box
  under each thread and one for a new comment. Everything is written on GitHub first, as the
  App's, ending "From the dashboard by @you" (the dashboard shows those as yours), then starts
  the run a discussion or comment of yours would; a comment sent while a run is going reaches
  it, like one written on GitHub. Comments written on GitHub show up in the dashboard within
  15 seconds or so. The category must exist on GitHub: the dashboard never creates it.

## Preview deployments

Deckhand no longer runs a preview hook (#574): it held the host's Docker socket, so it was root
on the host. A `preview` key left in `.deckhand.yaml` is ignored, with a warning in the run's
log and on the config page (`preview: removed, ignored`); the repository's runs go on.

To deploy a preview of each pull request, add a webhook to the repository (Settings ›
Webhooks) for its `pull_request` events (and `workflow_run`, to deploy once CI has passed),
pointed at a small HTTPS server of your own that checks the webhook's secret and deploys. It
gets the deliveries the hook got, with only the access you give it. Treat what an event says
as untrusted input: whoever opened the pull request wrote it, the App's bot's own pull
requests included (a sandbox wrote them, see
[GitHub Actions on Deckhand's branches](../security/github.md#github-actions-on-deckhands-branches)).

## Conflicts

When the base branch moves, a pull request can go into conflict and stay there until someone
notices. With `conflicts.check_minutes`, Deckhand looks at the repository's open pull
requests every that many minutes, and starts a work run on any that conflicts with its base.
It is off without the key, and each conflict found is a run, so a bill.

- Only Deckhand's own pull requests are checked: those of its tasks (an issue's pull request,
  or a pull request it was asked to work on), never every pull request of the repository,
  and never one from a fork.
- A conflict is GitHub's `mergeable: false` (`mergeable_state: dirty`). A pull request that
  is only behind its base, or blocked, or whose checks fail, is left alone. While GitHub is
  still computing it, the pull request is asked again a minute later.
- The run goes on in the task's session, as if a maintainer had asked: rebase on the base
  branch, resolve the conflicts, rerun the checks and push with `--force-with-lease`, or stop
  and ask. Its reply goes on the pull request; the dashboard names it "Conflict".
- Skipped: a task with a run going or comments waiting, a review loop deciding a step or
  waiting for CI, a pull request (or its issue) labelled `NEEDS_INPUT_LABEL`.
- Each pull request is tried once per pair of its head commit and its base branch's latest
  commit, across restarts: a rebase that failed or stopped to ask isn't tried again
  until someone pushes to the pull request or the base branch moves.
- A conflict run is a fix run too: the [policies](policies.md#policies) are asked first (`deny_fix`,
  with [`reason: "conflict"`](policy-inputs.md#the-review-and-fix-input)). A refusal starts nothing: a "No
  rebase run" comment on the pull request quotes the messages, and the pair counts as tried,
  so it isn't asked again until a push or a new base commit. Refused again for the same
  messages, it isn't said again. A policy error refuses too, except when GitHub couldn't be
  read (the policies, the pull request's files): then nothing starts and nothing is kept, and
  the next check asks again. Without a policy that defines
  `deny_fix` (Deckhand's defaults don't), conflict runs start as before.
- The operator's `CONFLICT_CHECK_MINUTES` (default 5) is the shortest interval: a smaller
  `check_minutes` gets that one (with a warning in the run logs), and `0` turns conflict
  checks off for every repository. `check_minutes` must be a whole number above 0; any
  other key under `conflicts` is an error.
- A merge into the default branch checks the repo's open pull requests about 30 seconds
  later, whatever the interval: a pull request merged on GitHub, a push to the default branch
  (when the App gets `push` events) or Deckhand's own auto-merge. Other base branches wait for
  the interval.
- The dashboard's **Sync** checks now, whatever the interval: for when you see a pull request
  in conflict. It follows the same rules (the opt-in,
  one try per pair, busy and needs-input tasks skipped, `deny_fix`) and says how many rebase runs it
  started. A pull request GitHub is still computing is checked a minute later, as above.

## Projects

Teams that track work on a GitHub project (v2) can have Deckhand move its issues there.
Two things go together:

- **The operator grants the project** in the repository's grants file:
  `allow_projects: [acme/3]` in `grants/<owner>/<repo>.yaml` (never `default.yaml`), as
  `<organization>/<number>`, the number in the project's URL
  (`https://github.com/orgs/acme/projects/3`). A project is outside every repository, so
  only the operator says which repository may write it. Without the grant, nothing is
  written to any project.
- **The repository says what to move**, with `projects:` in its `.deckhand.yaml`:

```yaml
projects:
  - project: acme/3
    field: Status # a single select field of the project, Status by default
    start: In progress
    ready: In review
    merged: Done
```

Deckhand then moves the items, with the App's own token:

- **`start`**: when a work run starts on the issue (a work run, or one of the repository's
  modes; not a brainstorm or any light run), once its checks let it start (a run
  refused, for its config's errors or its agent say, moves nothing), the issue is added to the
  project if it isn't there yet, and its field set to that option. A later work run on it
  sets it again, but for one asked from its pull request (a review's fix run, a comment
  there) and any once its pull request is ready or merged: the issue then stays where the
  pull request's steps put it.
- **`ready`**: when a pull request that closes the issue (`Closes #12`, from a branch of the
  repository, never a fork's, into the default branch, opened by one of the repository's `users` or by Deckhand's bot)
  is opened ready or marked ready for review: the issue and the pull request, which is added
  too.
- **`merged`**: when that pull request merges: both again.

Each step is optional: one without an option moves nothing at that step. Options are matched
by name, whatever their case. A `.deckhand.yaml` with errors moves nothing. A project the
grant doesn't list, a field or an option that isn't there, or a GitHub error never stops a
run: the move is skipped, said in Deckhand's log and the run's, and the dashboard's config
panel names the projects the grant lacks. A task on a pull request with no issue isn't on any
project.

Runs only **add** items, to a granted project: a work run its issue, its pull request, its
issue's sub-issues and the issues it files (`gh project item-add <number> --owner <org>
--url <url>`, or `gh issue create --project`; not `gh issue edit` or `gh pr edit --add-project`, whose update with empty classic `projectIds` stays refused), a brainstorm the issues it files. They never set an
item's fields, remove or archive items, or change the project. This is the `project` action
of [the GitHub input](policy-inputs.md#the-github-input); a repository's own modes don't add items unless its
policies allow them (`allow_github`, [the default policies](policies.md#the-default-policies)).

Projects need the App's **Organization projects: Read and write** permission, accepted on the
organization's installation ([Create the GitHub App](../guides/github-app.md#permissions-added-later)); a project owned by a user can't be reached by
a GitHub App at all.

## Open questions

An issue whose body has an `## Open questions` section (or `Questions ouvertes`,
`Preguntas abiertas`, `Offene Fragen`, `Perguntas abertas`, `Domande aperte`) that asks
something (it doesn't start with "None", nor is its first line a translation of it alone,
such as `Aucune.` or `Keine offenen Fragen`) is labelled
`NEEDS_INPUT_LABEL` (default `needs-input`), and an allowed user's comment takes the label
off: they answered. Ticking the boxes in the section answers too: once every question has an
option ticked (`- [x]`), the label comes off as for a comment, and unticking them puts it
back. A free-text question (no options) still needs a comment. Only an allowed user's ticks
answer: those of the App's bot (a run ticking its own picks) or of someone not allowed leave
the label on. An answer, a comment's or ticks', also needs the [`runs:manage`](policies.md#access) action
there, as the dashboard's answers do: a viewer's leaves the label on and is no answer for
`wait_for_answers` (nothing is said). A run that stopped to ask goes on the same way when an allowed user ticks an
option of every question in its reply (the boxes it came ticked with are the agent's). With
`wait_for_answers: true` (the default), work doesn't start on an issue while it carries the
label, unless an allowed user ticked an option of every question:

- A comment that is only the trigger line (with `/mode`, `/model`, `/effort`, `/speed`, `/agent` or `/after`
  lines at most) starts nothing: the App replies that the issue has open questions, points
  to the dashboard's form, and the label stays. A trigger comment with text is the answer:
  the label comes off and the run starts. Its author needs `runs:manage` for that too:
  without it, the comment is held back as a trigger line alone, its reply saying that the
  answers need someone with that action.
- A comment waiting for other issues (`/after`) whose last one is done keeps waiting until
  the questions are answered (the label is removed, or every box ticked), then starts by
  itself.
- The dashboard's Start and Queue open the questions first: the issue starts with the
  answers.

Only work runs and the repository's modes wait: brainstorms, onboarding and the other light
runs still run, as they can help answer, and leave the label on. A run that stopped
to ask, pull requests, inbox issues and discussions aren't affected. With
`wait_for_answers: false`, trigger comments, waits and the dashboard start the issue as they
would without questions (the dashboard's form is still there to answer from the task's
panel).

## Chats

Deckhand's users may chat with the agent about this repository from the dashboard, without an
issue ([Chats](../guides/chats.md)): a chat runs in this repository's image, with its grants and
its setup (not its caches), in volumes of its own, and writes nothing to GitHub. The users in
`users` may chat here; `chats` lowers how many chats each may keep:

```yaml
chats:
  per_user: 1 # at most CHATS_PER_USER; 0: no new chat here
```

It counts a user's chats on every repository, when they create one here: with `per_user: 1`, a
user who has a chat elsewhere already can't create one here. Chats already created stay.

Each chat's owner may narrow what its sandbox gets from the dashboard, with its permissions
profile ([security.md](../security/policies.md#chats)): never beyond what `policy/mode-chat.rego` (and this
repository's `.deckhand/policy/`), this file and the operator's grants give a chat. A
`deny_github` or `deny_capabilities` rule sees a chat's runs with `mode: "chat"`.

## Machines

A user's own computer may take this repository's tasks (Unreal Engine, a GPU, licensed tools
the sandbox lacks): its driver, an MCP client signed in as its owner, registers it with its
labels, its capacity and the repositories it takes ([MCP clients](../guides/mcp-clients.md)). Both
sides must opt in before this repository is offered to one:

- the operator's policies grant it `machines` ([the grants](../reference/server-folder.md#the-grants)), nothing
  by default;
- this file has a `machines:` block, which may narrow the machines it takes to those with one
  of its labels (never wider than the grant):

```yaml
machines: true # any machine of a user who may start runs here
```

```yaml
machines:
  labels: [unreal] # only machines labelled unreal, and only on that label
```

A label is letters, digits, `.`, `_` and `-`, compared in lower case. Without the grant, the
config page says the block is offered to no machine; an error in the block leaves it off. A
machine is offered the repository only while its owner is in `ALLOWED_USERS` and may start work
runs here (`runs:start:work`, and `users`): never more than its owner may do on the dashboard.
Machines read this block again a minute after their last read of it: a block added, changed or
removed is seen a minute later at most.

An agent runs on that machine on its own, with its owner's files, credentials and network:
Deckhand suggests settings and enforces none there ([security.md](../security/webhooks-and-sign-in.md#machines)).

### Routing an issue to a machine

With the block, an issue runs on its owner's machines instead of a sandbox when it has a
`runs-on:<label>` label (the machines with that label of whoever last added it, an allowed user
who may start work runs, as auto-pickup checks its labeller), or after a `/machine <name or
label>` line (its author's; alone, it starts nothing). `/machine none` sends it back to
sandboxes, until a `/machine <label>` routes it again (a label added later doesn't); only its owner moves it. A machine claims it within its own capacity, never a
`MAX_PARALLEL` or auto-pickup slot (the sweep skips `runs-on` issues), and keeps it: the next
runs go there, in the same session. Closing the issue ends its route and drops the comments waiting for its owner (a `runs-on`
label still on routes it again). Other users' comments wait on the task's page until its
owner delivers them; Deckhand's own (a review's fix round, a CI fix) don't. When the agent
there asks for a permission, the App's comment says so, and the owner answers with `/allow`,
`/allow run` or `/deny` (or on the task's page): anyone else's answer is ignored
([MCP clients](../guides/mcp-clients.md)).

The App opens the pull request from the branch the machine pushed, which Deckhand's default
`machines.rego` never auto-merges.

## Auto-pickup

`auto_pickup: true` opts the repository in to the operator's auto-pickup
([Auto-pickup](../guides/auto-pickup.md)): its open issues labelled `AUTO_PICKUP_LABEL`
(`auto-pickup` by default) are started by Deckhand itself, oldest created first across
every repository that opted in, in `work` mode, in the slots the operator reserves
(`AUTO_PICKUP_SLOTS`). Without those slots (the default), or without this key, nothing is
picked. Like the rest of this file, only the default branch's says it, and `max_parallel`
still caps the repository's runs, auto-picked ones included.

An issue is skipped, and the next one picked, while it has something live on the dashboard,
the needs-input label (see Open questions), an open issue it is "blocked by", or an open pull
request of Deckhand's, and any issue with a `runs-on:<label>` label, `machines:` or not. The run is for the person who last added the label: one who isn't in
`users` (or `ALLOWED_USERS`), or a bot, starts nothing. Nor does an issue whose title or
description anyone but an allowed user changed at any point after the label went on. Such an
issue keeps the label, and the App comments once to say why; an allowed user adds the label
again once the issue is checked.

Once picked, the App comments who the run is for (and edits the comment when the run doesn't
start), then the label comes off. A run that fails or is stopped isn't picked again until
someone adds the label back. A `deny_run` rule sees these runs with `trigger: "auto-pickup"`
and the labeller as `sender` ([The run input](policy-inputs.md#the-run-input)).

### Deckhand's own follow-ups

A label the App's bot added starts nothing (a run's writes go out as the App, and a run may
have read anyone's comment), with one exception: **`review.follow_ups_auto_pickup: true`**
(off by default, with `auto_pickup: true` and the operator's slots; without them, a warning).
The follow-ups Deckhand files once a pull request is merged (see Reviews) then get the
`AUTO_PICKUP_LABEL` along with `follow-up`, and are picked like any labelled issue, as the work
of **the person who merged the pull request**: they saw the follow-ups in its review.

- Only a merge by an allowed user counts. A pull request Deckhand merged itself
  (`review.merge`), or one a bot or someone outside `users` merged, files its follow-ups
  without the label, and the follow-ups comment on the pull request says why. The merger must
  still be in `users` when the issue is picked.
- Only the issues filed in that pass: a follow-up an issue already had is linked, not
  labelled. A review recorded after the merge files its own the same way.
- Deckhand keeps a record of each issue it labelled (who merged, the label's time), for 90
  days from that labelling, and the App's `labeled` event counts only when it matches one. Any other labelling by the App's bot
  is refused, with the usual "Not picked automatically" comment.
- Everything else holds as for a person's label: an issue edited after it was filed by anyone
  but an allowed user waits for the label to be added again, and needs-input, "blocked by",
  live runs and `max_parallel` all apply. The App's comment says the label was added by
  Deckhand for a follow-up of the pull request, merged by whoever the run is for.
