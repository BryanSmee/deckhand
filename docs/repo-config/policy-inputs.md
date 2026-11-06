<!-- onboarding: skip: The policies' inputs, field by field, are in docs/repo-config/policy-inputs.md in Deckhand's source. -->

# Per-repo config: policy inputs

Part of the [`.deckhand.yaml` reference](../repo-config.md): the `input` each decision of the
[policies](policies.md) gets, field by field, to look up while writing a rule.

### The run input

`input` of `deny_run`, asked once per run a person asks for, before it is queued (not
Deckhand's reviews and fix runs): `version`, `decision: "run"`, `time`, `repo` (`"owner/repo"`,
lower case), `mode`, `custom_mode`, `fresh`, `trigger` (`comment`, `dashboard`, `auto-pickup`,
`inbox`, `discussion`), `continues` (`true` for a comment without a trigger or `/mode` line,
going on in the issue's current mode), `sender` (a login), `target` (where the comment is:
`kind`: `issue`, `pr` or `discussion`, `number`, `labels`, `author`), `issue` (the task's, or
`null`) and `pr` (`draft`, `base`, `head`; else `null`). Deckhand's `run.rego` allows every
mode on issues, all but `brainstorm`, `stop` and `onboarding` elsewhere unless the comment
`continues` (the onboarding pull request's comments go on in onboarding). With Deckhand's
files alone and no repository file, Deckhand decides as `run.rego` would, without `opa` or
reading the comment's issue: it only lists the repository's policy folder (kept 10 minutes,
and up to an hour when GitHub can't list it again).

### The merge input

`input` of `deny_merge`, read from GitHub at the merge (the pull request, its files, its
issue, its Actions runs) and the review that decides it (`deny_review` and `deny_fix`
[read most of it](#the-review-and-fix-input)):

| Field               | What                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`           | `1`: the input's format, raised when a field changes meaning or goes.                                                                                                                                                                                                                                                                                                      |
| `decision`          | `"merge"`.                                                                                                                                                                                                                                                                                                                                                                 |
| `time`              | Now, RFC 3339 in UTC (`"2026-10-26T10:00:00.000Z"`): `time.parse_rfc3339_ns(input.time)`.                                                                                                                                                                                                                                                                                  |
| `repo`              | `name` (`"owner/repo"`), `private`, `default_branch`.                                                                                                                                                                                                                                                                                                                      |
| `pr`                | `number`, `author` (a login), `author_type` (GitHub's account type: `User`, `Bot`), `deckhand` (`true` when the App opened it), `external` (the login whose [machine](issues.md#machines) pushed it, the App opening it from there; else `null`), `title`, `labels` (names), `base` and `head` (branches), `head_sha`, `draft`, `additions`, `deletions`, `changed_files`. |
| `pr.files[]`        | `path`, `previous_path` (a rename's, else `null`), `status` (`added`, `modified`, `removed`, `renamed`…), `additions`, `deletions`.                                                                                                                                                                                                                                        |
| `issue`             | The issue the pull request closes: `number`, `title`, `labels` (names).                                                                                                                                                                                                                                                                                                    |
| `review`            | The review that decides the merge: `verdict` (`approve`, `comment`), `rating` (out of 10), `allowed` (`max_allowed_severity`).                                                                                                                                                                                                                                             |
| `review.findings[]` | `severity` (`critical`, `high`, `medium`, `low`), `path` and `line` (`null` when the finding names none), `text`.                                                                                                                                                                                                                                                          |
| `fixed`             | Whether a fix run came before this review (kept for rules from before `fixes`).                                                                                                                                                                                                                                                                                            |
| `fixes`             | How many fix runs came before this review (`review.fix`'s rounds), `0` without any.                                                                                                                                                                                                                                                                                        |
| `checks[]`          | The head commit's GitHub Actions runs: `name`, `status`, `conclusion`; without a run cancelled and replaced by a newer one of its workflow and event.                                                                                                                                                                                                                      |

### The review and fix input

`input` of `deny_review` and `deny_fix`: the [merge input](#the-merge-input)'s `version`,
`time`, `repo`, `pr` (with `pr.files[]`), `issue` and `review`, read from GitHub when the
decision is made (only when a policy applies), with `fixed` and `fixes` (the fix runs so
far), without `checks`:

| Field      | `deny_review`                                                                 | `deny_fix`                                                                                                  |
| ---------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `decision` | `"review"`.                                                                   | `"fix"`.                                                                                                    |
| `issue`    | The issue the pull request closes, or `null` when its description names none. | The issue Deckhand worked on.                                                                               |
| `review`   | `null`: the review hasn't run.                                                | The review that requests changes: `verdict`, `rating`, `allowed`, and its `findings[]`.                     |
| `round`    | none.                                                                         | The fix run this would be: `fixes + 1`.                                                                     |
| `rounds`   | none.                                                                         | How many fix runs `review.fix` allows (`true`: `1`), with the rounds the dashboard's Fix granted.           |
| `ci`       | none.                                                                         | `true` for a [CI fix run](reviews.md#ci-before-the-review), `false` for a review's fix run or a conflict's. |
| `reason`   | none.                                                                         | Why the fix run would start: `"review"`, `"ci"` or `"conflict"`.                                            |

A CI fix run's input has `review: null` (no review ran), `round` and `rounds` counting the CI
fix runs (`review.ci_fix`), and the head commit's `checks[]` as the merge input has them.

A [conflict](issues.md#conflicts)'s rebase run (`reason: "conflict"`) has `review: null` too, and
`round` and `rounds` `null`: it has no rounds. `fixed` and `fixes` count the review's fix runs
so far, and `pr.files[]` is there as for the others. A rule on `input.review.findings`
matches nothing then (`review` is null), so policies written for review fixes refuse what
they refused; one meant for a single kind of fix run checks `input.reason`.

```rego
deny_review contains "work in progress" if "wip" in input.pr.labels

deny_review contains "docs only" if every f in input.pr.files { startswith(f.path, "docs/") }

deny_fix contains msg if {
  some f in input.review.findings
  startswith(f.path, "migrations/")
  msg := sprintf("a finding in %s: migrations are fixed by a human", [f.path])
}

deny_fix contains "conflicts in migrations/ wait for a human" if {
  input.reason == "conflict"
  some f in input.pr.files
  startswith(f.path, "migrations/")
}

deny_fix contains "on hold: no rebase" if {
  input.reason == "conflict"
  "hold" in input.pr.labels
}

deny_fix contains "too large to rebase unattended" if {
  input.reason == "conflict"
  input.pr.additions + input.pr.deletions > 1000
}
```

### The reviewers input

`input` of `deny_request_review`: the [merge input](#the-merge-input)'s `version`, `time`,
`repo`, `pr` (with `pr.files[]`) and `issue`, read from GitHub when the decision is made (only
when a policy applies), with `review: null`, without `fixed`, `fixes` or `checks`, and:

| Field         | What                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decision`    | `"request_review"`.                                                                                                                                                                                                       |
| `reviewers`   | The logins Deckhand would request: `review.request`, those in `ALLOWED_USERS`, without the author.                                                                                                                        |
| `when`        | `"ready"`: the pull request turned ready (or is asked about for the first time); `"fix"`: a run that pushed to it ended well (not a push of someone else's).                                                              |
| `mode`        | The mode of the run that opened the pull request (the newest on its task that could push and had started when GitHub created it): `"work"`, or one of the repository's `modes:`; `null` when Deckhand no longer knows it. |
| `custom_mode` | `true` for a mode of the repository's `modes:`, as in [the GitHub input](#the-github-input).                                                                                                                              |
| `reason`      | Why Deckhand started that run: `"review-fix"`, `"ci-fix"`, `"conflict"`, or `null` for a comment's.                                                                                                                       |

```rego
deny_request_review contains "not on docs-only changes" if {
  every f in input.pr.files { startswith(f.path, "docs/") }
}

deny_request_review contains "the first request only" if input.when == "fix"
```

### The GitHub input

A run's sandbox holds no GitHub token: its calls go through the github service's GitHub gateway
([security model](../security.md)). Each **REST write** (anything but `GET` and `HEAD`, whatever
tool sends it: `gh`, `gh api`, curl) is checked there, in this order:

1. **Classified** from its method, path and body into actions on a target. A write it can't
   classify, one outside the run's repository, and one with a query string (GitHub may read
   parameters there too, which the check wouldn't see) are refused.
2. **Its target's kind is read from GitHub**, never from the request: whether it is the run's
   issue, a pull request (its own when it is the run's, or from a branch the run may push),
   a sub-issue of the run's issue (its parent on GitHub, in the same repository), an issue the
   run created (GitHub answered one of the run's own creates with it, over REST or GraphQL's
   `createIssue`, as `gh issue create` sends, and it is no older than that call). A comment,
   by its id, is one the run posted (`created_comment`) or refused before any look-up: see
   [A run's own comments](policies.md#a-runs-own-comments). A reaction on a comment has the comment's
   issue or pull request for its target, read from GitHub too: see [Reactions](policies.md#reactions).
3. **The built-in checks** that hold whatever a policy says (below: a link's child, a
   reaction's owner, an assignee, a project, a pull request's branch…).
4. **`allow_github` and `deny_github`**, on the input below: the write goes on when an allow
   rule matches it and no deny rule does. Deckhand's defaults allow each mode what it writes,
   one file per mode ([the default policies](policies.md#the-default-policies)); no rule, no write.

A write's target is looked up on GitHub (with Deckhand's token, whose rate limit every run
shares) before the policies are asked: once the writes a rule or a built-in check refused have
cost a run 100 look-ups in the last hour, its next writes are refused (`429`) before any, until
the hour has room again, so a run steered into writes no rule allows can't spend that limit.
Writes that go on, and those GitHub or the policy service failed to check, cost nothing of it.
A GraphQL call's look-up of the node IDs it names counts as one, as its fields' targets do.

A sub-issue link (`POST`, `DELETE` or reordering `…/issues/<parent>/sub_issues`) names two
issues: the parent, its target, and the child, by its id: the child must be an issue the run
created, or one already under the run's issue, and moving an issue from another parent
(`replace_parent` with any value but `false`) is refused. A link can't take someone else's
issue under the run's, where its policies would let it edit it. The issues the App's bot files
for other runs or for Deckhand (an analysis, an onboarding issue) aren't the run's, even
while it runs: only the answers to its own calls say what it created, and they are saved with
the run, so a restart keeps them. A GraphQL answer counts only under the response
key of a `createIssue` field the gateway parsed, selecting GitHub's own `issue { url }`
(unaliased), and the issue must be the App's bot's.

A "blocked by" link (`POST …/issues/<n>/dependencies/blocked_by` with the blocker's
`issue_id`, `DELETE …/issues/<n>/dependencies/blocked_by/<issue_id>`, or GraphQL's
`addBlockedBy` and `removeBlockedBy`) is a `link` too: its target is the blocked issue, held to
the policies as any link's, and its blocker must be an issue the run created, one under the
run's issue, or any open issue of the run's repository (not a pull request, nor another
repository's issue, though GitHub allows those). A REST blocker, named by its id only, is
looked for among the repository's 1,000 newest open issues and pull requests (GitHub lists
them together) past the run's own (GitHub can't
look an issue up by its id); GraphQL's, by its node ID, is looked up wherever it is. A call
without its blocker is refused. Deckhand reads these links to order a plan
([architecture](../architecture.md)): a sub-issue waits on the graph until its blockers close.

A **review thread** is answered with a `reply` (`POST …/pulls/<n>/comments/<id>/replies`, or
GraphQL's `addPullRequestReviewThreadReply`, without a `pullRequestReviewId`: that would put the
reply in a pending review), closed with a `resolve` (`resolveReviewThread`) and opened again
with an `unresolve` (`unresolveReviewThread`). Their target is the thread's pull request, held to
the policies as any write to it: Deckhand's allow only a work run's own. The thread is read from GitHub by
its first comment: it must be on that pull request (REST's path names both, which may
disagree), and its first comment's author goes into the input (`target.thread`). A new review
(`POST …/pulls/<n>/reviews`) and a review comment that answers no thread (`POST
…/pulls/<n>/comments`, `in_reply_to` included) are refused, whatever a policy says.

**Assignees and milestones** (issue #453) are `assign` and `milestone`: those fields of a REST
create or `PATCH`, `…/issues/<n>/assignees`, GraphQL's `assigneeIds` and `milestoneId`, and its
`add`/`removeAssigneesFromAssignable` and `replaceActorsForAssignable` (what `gh` sends, by
login). Whatever the policies say, an assignee a run adds must be an allowed
user or the App's bot (an assignment notifies them), never Copilot (`agentAssignment` is
refused too); removals aren't checked. A milestone must be the repository's, looked up.

**GraphQL** (`gh issue create`, `gh issue comment`, `gh issue edit` and most of `gh`'s own
commands) goes through the same checks, field by field:

1. **Parsed and validated** against GitHub's public schema, pinned in Deckhand
   (`listener/vendor/github.graphql`, updated on purpose): a call that doesn't parse or
   validate, one over 2,500 tokens or 64 KiB (gh's are a few hundred) or 10 mutation
   fields (gh sends one), a subscription, and
   a document with several operations and no `operationName` naming one of them are refused.
   A query isn't held to the rule on fields that can't merge, which GitHub doesn't apply
   either (`gh issue view` selects a `state` of two types from an issue or a pull request); a
   mutation is.
2. **Queries go on.** Each field of a mutation, through its fragments and under any alias,
   must be one Deckhand knows (`createIssue`, `createLabel`, `updateIssue`, `addComment`,
   `updateIssueComment`, `deleteIssueComment`, `addSubIssue`,
   `removeSubIssue`, `reprioritizeSubIssue`, `addBlockedBy`, `removeBlockedBy`,
   `addLabelsToLabelable`,
   `removeLabelsFromLabelable`, `addAssigneesToAssignable`, `removeAssigneesFromAssignable`,
   `replaceActorsForAssignable`,
   `closeIssue`, `reopenIssue`, `addReaction`, `removeReaction`, `addProjectV2ItemById`, `createPullRequest`,
   `updatePullRequest`,
   `markPullRequestReadyForReview`, `convertPullRequestToDraft`,
   `addPullRequestReviewThreadReply`, `resolveReviewThread`, `unresolveReviewThread`,
   `updatePullRequestBranch`, `addProjectV2ItemById`), setting only the
   input fields Deckhand checks (no classic `projectIds`, no `parentIssueId` or `issueTemplate`, a sub-issue by its
   `subIssueId` only): any other is refused before any policy runs, even sent as `null`, which
   GitHub may read as clearing it.
3. **Its targets are GitHub's:** the node IDs it names, inline or in its variables, are looked
   up with Deckhand's token, to a repository, a kind and a number. A create's
   `repositoryId` must be the run's repository, and its labels' IDs labels of it.
4. **Each field is then a write as above**, held to the built-in checks, `allow_github` and
   `deny_github` with the same input. One refusal refuses the whole call, its message starting with the field's
   response key.
5. **What GitHub gets is the document the gateway parsed**, printed again, never the call's
   own bytes: GitHub runs what was checked.

**A pull request's own writes** (`gh pr create`, `gh pr edit`, `gh pr ready [--undo]`,
`gh pr update-branch`, or REST's `POST` and `PATCH` of `…/pulls` and `PUT
…/pulls/<n>/update-branch`) are allowed by Deckhand's defaults to work runs only, for their own
pull requests (`own_pr`) and the ones they open (`new_pr`). Before the policies, whatever they
say: a new one's
head must be a branch of the repository the run may push (not `owner:branch`, another
repository's, or an issue turned into a pull request), an existing one's too before it is
edited (over `…/issues/<n>` too), readied, drafted or has its branch updated, or its token
writes pull requests or contents (a fork's pull request is only commented on and labelled); one
with conflicts isn't made ready; and for a repository granted `workflows`, opening,
editing, labelling, readying, drafting one or updating its branch first checks its workflow
files merged with its base, as a push's are.

**Updating a pull request's branch** (`update_branch`) has GitHub merge the base into it,
without a clone or a force-push. It is a merge only: `gh pr update-branch --rebase`
(`updateMethod: REBASE`, or REST's `update_method`) is refused, since a rebase would rewrite the
commits the git gateway let through. It must name the head it applies to (`expected_head_sha`,
`expectedHeadOid`, which `gh` sends), so GitHub refuses it when the branch moved, and REST's
body may hold nothing else. GitHub refuses one with conflicts: those are still rebased locally
and pushed.

**A token per write.** The token behind a run's calls only reads. A write that passed these
checks gets a token of its own, minted for that call, with the run's reads and only the write
permission it needs: `issues: write` for an issue's (a comment, a label, a link, a reaction,
an assignee, a milestone, a label it creates, a comment it edits), `pull_requests: write` to
open or edit a pull request, or to reply to, resolve or unresolve one of its review threads
(and `issues: write` too when it sets labels, assignees or a milestone), `contents: write` to
ready or draft one, or to update its branch, `actions: write` for a [rerun](#reruns),
`organization_projects: write` for a project's item. The sandbox never holds it.

**An item added to a project (v2)** (GraphQL's `addProjectV2ItemById`, what `gh project
item-add` and `gh issue create --project` send) is a `project` on its content, the target, held
to the policies as any write. Before them, whatever they say, its project (looked up from its
node ID) must be one the operator's grants list for the repository (`allow_projects`): no
policy can reach another. Its token gets `organization_projects: write` for that write alone,
and in a granted repository the runs the policies let read projects (`read_projects`, a read:
[below](#reading-cis-checks); Deckhand's defaults give it to work runs, brainstorms and the
repository's modes) read the organization's projects (`gh` looks a project
up before it adds to it); the others (reviews, inbox entries, discussions, analyses) don't.
Setting an item's fields
(`updateProjectV2ItemFieldValue`), removing or archiving one, and the project's own settings
are refused: [Deckhand moves the items](issues.md#projects).

What each mode writes is its file's, in Deckhand's default policies ([the default
policies](policies.md#the-default-policies)); the repository's settings page on the dashboard shows the
files that apply, the operator's replacing Deckhand's:

| Mode                                          | File                                                             | What Deckhand's default allows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work`, a `modes:` entry                      | [`mode-work.rego`](../../policy/mode-work.rego)                  | its issue, its sub-issues and the issues it created: `edit`, `comment`, `label`, `link`, `react`, `unreact`, `project`, `assign` (denied), `milestone`; its pull requests: the same but `link`, and `ready`, `draft`, `update_branch`, `rerun` (a [rerun](#reruns) of their head's failed jobs); the comments it posted: `edit`, `delete` (denied); new issues and pull requests: `create`, `assign` (denied), `milestone`; labels: `create`; its pull requests' review threads: `reply`, `resolve`, `unresolve` |
| `brainstorm`, `stop`                          | [`mode-brainstorm.rego`](../../policy/mode-brainstorm.rego)      | its issue: `edit`, `link`, `react`, `unreact`; new issues: `create`, `milestone`; labels: `create`; the issues it created: `project`, `milestone`; its sub-issues and the issues it created: a "blocked by" `link`; never a `comment` (denied)                                                                                                                                                                                                                                                                   |
| `idea`, `bug`                                 | [`mode-idea.rego`](../../policy/mode-idea.rego), `mode-bug.rego` | new issues (with the `idea` or `bug` label, denied without) and labels: `create`; the issues it created: `edit` (their bodies naming the others, once filed), `link` (the parents it files)                                                                                                                                                                                                                                                                                                                      |
| `discussion`                                  | [`mode-discussion.rego`](../../policy/mode-discussion.rego)      | new issues: `create`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `onboarding`, `analyze`, `review`, `research` | none                                                             | nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

`react` and `unreact` on an issue or pull request hold for the comments on it too, and
`unreact` only for the reactions the run added ([Reactions](policies.md#reactions)).

A run's label writes neither add nor remove `NEEDS_INPUT_LABEL` on its sub-issues and the issues
it created: taking it off would answer their questions and start what waited for them. That
covers the label only: a run that may edit those issues (a work run, a brainstorm) can still
drop their questions section from the description, which Deckhand takes for an answer too.

No default rule allows closing or reopening (GitHub closes an issue when its pull request
merges), merging, locks, deleting anything but a comment the run posted, or a label's
settings: an operator's allow rule would have to (and a merge's token, which writes issues
only, would still fail at GitHub). Whatever a policy says, the built-in checks refuse reviews
and their comments (but replies in a thread, and resolving it), moving an issue from another
parent, reactions elsewhere (a commit's comment, a review, a discussion) or removing one the
run didn't add, editing or deleting a comment the run didn't post or a review's, assigning
anyone but an allowed user or the App's bot, another repository, the repository's contents
(pushes go through Deckhand's git gateway: [the push input](#the-push-input)) and settings,
and a write the gateway can't classify.

`input` of `allow_github` and `deny_github`:

| Field                                                                                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                                                                             | `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `repo`                                                                                                                | `"owner/repo"`, in lower case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `mode`                                                                                                                | The run's: `work`, `brainstorm`, `stop`, `idea`, `bug`, `discussion`, or one of the repository's `modes:`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `custom_mode`                                                                                                         | `true` for one of the repository's `modes:`, `false` for Deckhand's own: a rule needn't list the built-in modes, which change as Deckhand adds some. It needs the repository's `allow_github` too.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `reason`                                                                                                              | Why Deckhand started the run itself: `"review-fix"` (a review's fix run), `"ci-fix"` (a CI fix run), `"conflict"` (a rebase), `null` for a comment's run. The defaults don't read it: a repository can narrow one of them.                                                                                                                                                                                                                                                                                                                                                                                    |
| `issue`                                                                                                               | The number of the run's issue (or pull request).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `action`                                                                                                              | What the write does: `create`, `edit`, `comment`, `label`, `link`, `assign`, `milestone`, `ready`, `draft`, `delete` (a comment the run posted), `react`, `unreact` (a reaction), `reply`, `resolve`, `unresolve` (a review thread), `update_branch`, `rerun` (failed GitHub Actions jobs: [Reruns](#reruns)), `project` (adding it to a project), `close`, `reopen`, `lock`, `merge`; `read_checks` and `read_projects` for [a run's reads](#reading-cis-checks), which have no `target` or `change`. A write doing several (a `PATCH` of labels and a title) has them all in `actions`, `action` the first. |
| `actions`                                                                                                             | All of them: `close` or `reopen` first, then `label`, `assign`, `milestone`, then `edit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `target.kind`                                                                                                         | Absent for `read_checks` and `read_projects`, as the other `target` and `change` fields. `own_issue`, `own_pr`, `sub_issue`, `created_issue` (one the run created), `other_issue`, `pr`, `new_issue` (an issue it creates), `new_pr` (a pull request it opens), `label` (a label it creates), `created_comment` (a comment the run posted).                                                                                                                                                                                                                                                                   |
| `target.number`                                                                                                       | The issue's or pull request's (for `created_comment`, the one the comment is on), `null` for `new_issue`, `new_pr` and `label`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `target.comment`                                                                                                      | A `created_comment`'s id, or the id of the comment a reaction is on (its target then being the issue or pull request the comment is on). Absent from other targets.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `target.comment_author`, `target.comment_deckhand`                                                                    | A reaction's comment's author (its login), and whether the App's bot wrote it. Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `target.labels`                                                                                                       | Its labels' names, as GitHub has them now (none for a comment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `target.author`                                                                                                       | Its author's login.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `target.thread`                                                                                                       | A `reply`'s, `resolve`'s or `unresolve`'s review thread: `author`, its first comment's author's login, and `deckhand`, whether that is Deckhand's bot (a thread Deckhand's review opened). Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                          |
| `target.run_id`, `target.sha`, `target.event`, `target.workflow`, `target.attempt`, `target.conclusion`, `target.job` | A `rerun`'s workflow run, besides its pull request's fields: see [Reruns](#reruns). Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `change.fields`                                                                                                       | The keys of the write's JSON body (`["title", "body"]`), or a GraphQL mutation's input fields but its target, as REST names them (`labelIds` → `labels`, `assigneeIds`, `actorIds`, `actorLogins` → `assignees`, `milestoneId` → `milestone`, `baseRefName` → `base`, `expectedHeadOid` → `expected_head_sha`, else snake case).                                                                                                                                                                                                                                                                              |
| `change.labels_added`                                                                                                 | The labels it adds (or sets, for a `PUT` or a `PATCH` with `labels`, or creates, for `label`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `change.labels_removed`                                                                                               | The labels it removes: those a `PUT` or a `PATCH` with `labels` leaves out of the issue's, or the one it deletes; `["*"]` when it deletes them all.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `change.sub_issue`                                                                                                    | A link's child: `id`, `number`, `kind` (`sub_issue` or `created_issue`). Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `change.content`                                                                                                      | A reaction's, as REST names it: `+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes` (GraphQL's `THUMBS_UP` is `+1`); for `unreact`, the one the run added. Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `change.blocked_by`                                                                                                   | A "blocked by" link's blocker: `id`, `number`, `kind` (`sub_issue`, `created_issue`, or an open issue's kind as a target's: `own_issue`, `other_issue`). Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `change.project`                                                                                                      | A `project`'s project: `owner` (lower case), `number`, `title`, one the operator grants. Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `change.assignees`                                                                                                    | An `assign`'s: `added` and `removed`, the logins it assigns and unassigns ([Assignees and milestones](policies.md#assignees-and-milestones)). Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `change.milestone`                                                                                                    | A `milestone`'s: `number` and `title`, looked up; `null` when it clears it. Absent from other writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

```json
{
  "version": 1,
  "repo": "owner/repo",
  "mode": "brainstorm",
  "custom_mode": false,
  "reason": null,
  "issue": 12,
  "action": "comment",
  "actions": ["comment"],
  "target": { "kind": "other_issue", "number": 40, "labels": [], "author": "someone" },
  "change": { "fields": ["body"], "labels_added": [], "labels_removed": [] }
}
```

#### Reruns

A work run may rerun the failed jobs of a GitHub Actions run on its own pull request's head
(`gh run rerun <id> --failed` or `--job <id>`): action `rerun`, `actions: write` for that call
only, an optional App permission whose lack the refusal names. Never a whole run, a cancel,
dispatch or approval, nor debug logs (`--debug`, refused whatever the policies say: those logs
print more of what runs with the repository's secrets). The run must have failed, come from a
push or a pull request of the repository's branch, and still be at that pull request's head;
the target is that pull request (`own_pr`), with `run_id`, `sha`, `event`, `workflow`
(`name`, `path`), `attempt` (GitHub's `run_attempt`), `conclusion` and `job` (`id`, `name`, or
`null`). At most twice per head commit and run, whatever the policies say (`MAX_RERUNS`, saved
across a restart). Deckhand's default, `policy/mode-work.rego`, allows reruns to work runs and
the repository's modes it allows, and denies all but a first one (`target.attempt == 1`); the
operator's file of that name broadens it.

#### Reading CI's checks

`allow_github` and `deny_github` also see two reads. `read_checks`: CI's checks beyond Actions
(`gh pr checks`, `gh pr view` without `--json`), over REST or GraphQL, which Deckhand's
`gh-checks.rego` allows in every mode. `read_projects`: whether a run's token reads the
organization's projects, in a repository the operator grants one (`allow_projects`), which
`mode-work.rego` and `mode-brainstorm.rego` allow (a refusal refuses nothing but that read: what
needs it fails at GitHub). Their input is the run's fields, without `target` or `change`,
evaluated once per run and the answer kept (`gh pr checks --watch` polls):

```json
{
  "version": 1,
  "repo": "owner/repo",
  "mode": "work",
  "custom_mode": false,
  "reason": "ci-fix",
  "issue": 12,
  "action": "read_checks",
  "actions": ["read_checks"]
}
```

A deny rule refusing what isn't in a list (`not input.target.kind in {…}`) refuses them too:
guard it with `not input.action in {"read_checks", "read_projects"}`. More (REST paths, GraphQL types,
the permissions, what stays readable): [security model](../security.md#the-github-gateway).

### The push input

A run pushes through Deckhand's git gateway ([security model](../security.md)), never to GitHub
directly. Each push is checked there: only `refs/heads/` branches, never the default branch,
only the run's own (its issue's `issue-<n>-*`, or its pull request's head; a run that may not
push has none), and in a repository granted `workflows` its workflow files. Then each
branch it updates is asked of `allow_push` and `deny_push`: one refused refuses the whole push,
git printing the messages for each ref. Deckhand's default, `mode-work.rego`, allows work runs'
pushes and those of the repository's `modes:` (which need its own `allow_push` too).

`input` of `allow_push` and `deny_push`: the run's fields as in [the GitHub
input](#the-github-input) (`version`, `repo`, `mode`, `custom_mode`, `reason`,
`issue`), and:

| Field            | What                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| `action`         | `"push"`.                                                                    |
| `branch`         | The branch it updates (`issue-12-fix-login`).                                |
| `ref`            | The same, as git names it (`refs/heads/issue-12-fix-login`).                 |
| `created`        | `true` when the push creates the branch.                                     |
| `deleted`        | `true` when it deletes it.                                                   |
| `default_branch` | The repository's default branch, as GitHub has it now (never pushed, above). |

```rego
# .deckhand/policy/push.rego
package deckhand

deny_push contains "a run doesn't delete branches here" if input.deleted
```

### The linked-branch input

A work run's branch shows in its issue's Development sidebar from the run's start, not only
once its pull request says `Closes #n`. GitHub links a branch to an issue only as it creates
it (`createLinkedBranch`, what `gh issue develop` calls), so **Deckhand** does it as a work
run starts, once nothing else can stop the run (its image built, its access checked), before
its sandbox does: when the run may push its issue's branch (`issue-<n>-*`: a run with `push`, not
a fork's) and the issue has no `issue-<n>-…` branch yet. A fix or conflict run's branch, or a
later run's, exists already: nothing is linked then, and for a work run the issue's one branch
is the one the sandbox checks out, even if the title changed since. The branch is named from the issue's
title as the sandbox names it, created at the base branch's head, and the sandbox checks it
out and pushes its first commit through the git gateway as usual (a branch with nothing over
the base and no pull request yet gets that commit whenever a run checks it out). A refusal or
a failure links nothing and fails no run: the sandbox creates the branch itself, unlinked.

`input` of `deny_link_branch`:

| Field         | What                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `version`     | `1`.                                                                                                    |
| `repo`        | `"owner/repo"`, in lower case.                                                                          |
| `mode`        | The run's mode: `work`, one of the repository's `modes:`, or any other the policies give `push`.        |
| `custom_mode` | `true` for one of the repository's `modes:`, as in [the GitHub input](#the-github-input).               |
| `reason`      | Why Deckhand started the run itself (`"review-fix"`, `"ci-fix"`, `"conflict"`), `null` for a comment's. |
| `issue`       | The issue's number.                                                                                     |
| `labels`      | The issue's labels (names).                                                                             |
| `branch`      | The branch it would create: `issue-<n>-<slug of the title>`.                                            |
| `base`        | The base branch.                                                                                        |
| `oid`         | The base branch's head commit, where the branch is created.                                             |

Deckhand's default, `gh-linked-branch.rego`, links work runs' branches only among the built-in
modes:

| Work, fix, conflict | Brainstorm     | Research       | Repository modes                                      |
| ------------------- | -------------- | -------------- | ----------------------------------------------------- |
| ✅ linked           | ❌ (no `push`) | ❌ (no `push`) | ❌ refused until the repository's `allow_link_branch` |

A repository's own mode its `allow_link_branch` lets link one ([example](policies.md#policies)) also gets
its branch checked out and its draft pull request opened by the sandbox, as a work run does,
but only on the run that links it: the policies aren't asked about a branch that exists
already, so its later runs get none.
<!-- onboarding: end -->
