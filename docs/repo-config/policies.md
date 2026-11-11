# Per-repo config: policies

Part of the [`.deckhand.yaml` reference](../repo-config.md): a repository's own
`.deckhand/policy/`, the capabilities and access they decide, Deckhand's default policies, and
their dry run on the dashboard. Each decision's `input` is in
[Policy inputs](policy-inputs.md).

## Policies

Rules of your own, written as code in [Rego](https://www.openpolicyagent.org/docs/policy-language)
(Open Policy Agent), for what the built-in gates don't cover: "a human merges any pull
request over 400 lines", "nothing under `migrations/` is merged by itself", "a medium finding
in payments code blocks". They run after every built-in gate, which they never pass. **A
decision is allowed when an allow rule matches and no deny rule does**: a deny always wins.

```rego
# .deckhand/policy/merge.rego (default branch)
package deckhand

deny_merge contains msg if {
  input.pr.additions + input.pr.deletions > 400
  msg := "more than 400 changed lines: a human merges this one"
}

deny_merge contains msg if {
  some f in input.pr.files
  startswith(f.path, "migrations/")
  msg := sprintf("it changes %s: migrations wait for a human", [f.path])
}

deny_merge contains msg if {
  some f in input.review.findings
  f.severity == "medium"
  startswith(f.path, "src/payments/")
  msg := sprintf("medium finding in payments code: %s:%d", [f.path, f.line])
}

deny_merge contains "labelled do-not-merge" if "do-not-merge" in input.pr.labels
```

**The files**: every `*.rego` file of `.deckhand/policy/` on the default branch (not its
subfolders), in package `deckhand`; a file in another package is a library its layer's files
can import. **Two layers**, evaluated together by Deckhand's policy service (one `opa` with both
layers loaded, never another repository's), the repository's packages moved under
`deckhand_repository` (its `data.` references too): neither can define the other's rules. A
repository's file must start with `package …`, after comments only, and use `sprintf()`, not
template strings (`$"…"`):

- **The operator's**: [Deckhand's defaults](#the-default-policies), in the policy service's image,
  under the operator's grants folder `policy/` ([security model](../security/policies.md#policies)), where
  a file **with the same name** replaces Deckhand's (one with only `package deckhand` drops it).
  Its allow rules are the ceiling: Deckhand's `allow.rego` allows Deckhand's own decisions,
  each `mode-<mode>.rego` what a mode's runs get and do.
- **The repository's**: its deny rules apply to every run; its allow rules count only for its
  own `modes:` (`custom_mode`), whose runs need **the operator's allow and its own**. Its allow
  rule for a built-in mode's run is ignored (for `merge`, `review` and `fix`, a config check
  error). Its file named as one of Deckhand's or the operator's replaces nothing (a warning).

When only Deckhand's files apply, allowing the decision and none defining its deny rule, the
policy service isn't asked (and the task's page keeps nothing); for `run`, Deckhand decides as
`run.rego` would. The repository's folder is listed once, then
again after a push to its default branch (or 10 minutes).

<!-- modes.rego: test/linked-branch.test.mjs evaluates this block with the real opa -->

```rego
# .deckhand/policy/modes.rego
package deckhand

# The repository's modes `plan` and `docs` run, write and push; `plan` links a branch.
allow_run if input.mode in {"plan", "docs"}

allow_github if input.mode in {"plan", "docs"}

allow_push if input.mode in {"plan", "docs"}

allow_link_branch if input.mode == "plan"

deny_github contains "review threads stay open here" if input.action == "resolve"
```

**The rules**: two per decision: `allow_<decision>`, true when it allows (`allow_merge if …`),
and `deny_<decision>`, a set of strings, the reasons shown to the maintainer. A decision no
allow rule matches is refused with a reason from its input (`no rule allows \`comment\` on
\`other_issue\` for a \`brainstorm\` run`; `no rule of .deckhand/policy/ allows …` for the
repository's). Eight decisions:

| Rule                  | When                                                                                                                                                                                                                             | A message does                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deny_run`            | A [run a person asks for](policy-inputs.md#the-run-input), before it is queued.                                                                                                                                                  | Starts nothing: a reply quotes the messages.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `deny_merge`          | An [auto-merge](reviews.md#auto-merge), after every other gate passed, right before the merge. Only with `review.merge` and its grant.                                                                                           | Refuses the merge: the "Not merged automatically" comment quotes the messages (5 at most, 200 characters each).                                                                                                                                                                                                                                                                                                                                                 |
| `deny_review`         | A review that starts by itself ([`review.on: ready`](reviews.md#reviews)), after its own checks, and the review after each fix run. Never a `/mode review` a maintainer asked for.                                               | Skips the review: Deckhand's log says why, nothing is posted; a policy error (not a rule's message) is asked again 10 seconds later first, then, on a pull request that turned ready, 5 minutes apart, 3 times. After a fix run, the fix loop stops; in auto-merge mode the merge waits for a maintainer, the "Not merged automatically" comment quoting the messages.                                                                                          |
| `deny_fix`            | A [`review.fix`](reviews.md#reviews) run, a [CI fix run](reviews.md#ci-before-the-review), or a [conflict](issues.md#conflicts)'s rebase run, after its own checks, right before it is queued (`input.reason` tells them apart). | Starts no fix run: a "No fix run" comment on the pull request quotes the messages. With `review.merge`, nothing is merged: the refusal quotes them too. The round isn't used: a later review may start it. A CI fix run refused: the "CI failed" comment ends with "No CI fix run" and the messages, no review runs, and its round isn't used either. A conflict run refused: a "No rebase run" comment quotes them, and that head and base aren't tried again. |
| `deny_link_branch`    | A work run on an issue that has no branch yet, as it starts: Deckhand creates the run's `issue-<n>-…` branch and [links it to the issue](policy-inputs.md#the-linked-branch-input).                                              | Links no branch: the sandbox creates its branch itself, unlinked, as before, and the run's log quotes the messages.                                                                                                                                                                                                                                                                                                                                             |
| `deny_request_review` | The [reviewers](reviews.md#reviewers) of `review.request`, before Deckhand requests them on Deckhand's ready pull request, and again after a fix pushed to it.                                                                   | Requests nobody at that head commit: Deckhand's log says why, nothing is posted.                                                                                                                                                                                                                                                                                                                                                                                |
| `deny_github`         | Each write a run makes to GitHub (a comment, an issue edit, a label…), REST or a GraphQL mutation's field, after [the built-in checks](policy-inputs.md#the-github-input); a run's reads of CI's checks and of projects.         | Refuses the write: GitHub's error shape with the messages, which `gh` prints to the agent, and a line in the run's log.                                                                                                                                                                                                                                                                                                                                         |
| `deny_push`           | Each branch a push updates, after the git gateway's built-in checks ([the push input](policy-inputs.md#the-push-input)).                                                                                                         | Refuses the whole push: git prints the messages for each ref, and a line in Deckhand's log.                                                                                                                                                                                                                                                                                                                                                                     |

Each has its allow rule (`allow_merge`…), and [capabilities](#capabilities) and
[access](#access) two of their own each. Another `allow_*` or `deny_*` rule is reported by the
config check, as probably misspelled. `allow_grant` and `deny_grant`, what the operator grants
the repository ([the grants](../reference/server-folder.md#the-grants)), are the operator's alone: here they are
ignored, and a config check error. So is `allow_access`: a repository's `deny_access` only takes
access away.

**Fail closed**: a policy that doesn't compile, takes more than 2 seconds, or makes an allow
rule anything but a boolean or a deny rule anything but a set of strings refuses the decision,
with a single `policy error: …` reason, whatever the other layer says. So do a policy folder
that GitHub can't list and a policy service that can't be reached. The onboarding pull request's config check compiles its branch's
policies and reports their errors.

**What a policy can call**: Rego's builtins, without those that read the environment, the
network or the service's files (`opa.runtime`, `http.send`, `net.*`, `json.match_schema`,
`json.verify_schema`) and `trace`: a file that calls one doesn't compile, and refuses every
decision of its layer. A policy decides from its input only. `time.now_ns()` works, so "not on Fridays" does.

### Capabilities

What a run's sandbox gets (`pull`, `push`, `setup`, `docker`, `internet`, `read:issues`…: the
[catalogue](../security/policies.md#capabilities)), decided as it starts by `allow_capabilities` (names) and
`deny_capabilities` (`{"capability": …, "reason": …}`) on `repo` (`name`, `private`), `mode`,
`custom_mode`, `issue`, `reason`, `fork`, `trigger` (as the run input's), `command` (the
comment's first line: `work`, `stop`…) and `context_repos` (the repositories its
[`context_repos`](../repo-config.md#context-repos) names, lower case, each once); used if its key
(`setup`, `dockerfile`, `docker`, `context_repos`) asks for it and the operator's [grant](../reference/server-folder.md#the-grants) gives it, and what it needs is used (a deny drops what needs it). Deckhand's `mode-<mode>.rego` give each built-in mode
its own; the repository's `modes:` work's at most, and only what its `.deckhand/policy/` allows too (nothing: refused). The repository's config page, Capabilities tab, shows for each mode what a run gets, the file that decided each capability and what stops it.
The `read:*` are what the run's token reads on GitHub (`read:issues` every issue, `read:pulls`
every pull request, `read:discussions`, `read:actions` CI): without `read:issues`, a run reads its
own issue only. A limit on what a run asks for, not a secret: with `pull`, commit messages may
quote an issue. Here, an audit mode that reads its own issue, pull requests and the code:

```rego
package deckhand

allow_capabilities contains c if {
  input.mode == "audit"
  some c in {"pull", "read:pulls"}
}
```

### Access

Who may do what on which repository, among the people `ALLOWED_USERS` lets in (it still decides
who signs in, uses MCP and comments: access only narrows within it). Asked as
`allow_access` (a set of actions) and `deny_access` (`{"action": …, "reason": …}` objects): a
login has an action when an allow rule of **the operator's** policies gives it and no deny rule
of either layer takes it away. A deny always wins; no allow, a policy error, policies that can't
be read or a policy service away give no action.

**The input**: `version`, `decision: "access"`, `user` (`login`, lower case) and `repo` (`name`,
`"owner/repo"` in lower case, and `private`, `true` unless GitHub says it is public), or
`repo: null` for the server-wide actions. One evaluation per login and repository gives every
action there; its answer is kept a minute for the same policy files, the repository's listed
first (again after a push to its default branch).

**The actions**:

| Action              | On                                                            |
| ------------------- | ------------------------------------------------------------- |
| `tasks:read`        | A repository: its tasks and runs.                             |
| `logs:read`         | A repository: its runs' live logs.                            |
| `runs:start:<mode>` | A repository: starting a run in `<mode>` (its own modes too). |
| `runs:manage`       | A repository: cancelling, rerunning, answering its runs.      |
| `repo:config:read`  | A repository: its configuration and policies.                 |
| `server:read`       | Server-wide (`repo: null`): the server's setup and grants.    |
| `server:sync`       | Server-wide: Sync.                                            |

**Where they are asked**: each dashboard route needs its action (the backlog, its counts in
the repositories list and a discussion's thread `tasks:read`; starting, queueing or laying out work, the inbox, Analyze, a
discussion, onboarding and a chat's creation and messages `runs:start:<mode>` for the mode they start (`chat` for a chat), wrapping a brainstorm up `runs:start:stop` (a grooming's `runs:start:grooming-stop` too); cancelling, rerunning,
answering, Review and Fix, dismissing, lanes and the run order `runs:manage`, and what starts a
run among them (a rerun, Review, Fix, answers a session goes on with) its mode's start too, before
anything is posted; a repository's config and its refresh `repo:config:read`; Settings › Server,
the services' health and the plans' usage `server:read`; Sync, and refreshing the whole
repositories list, `server:sync`). Without `server:read`, the repositories list names only the
installations of the accounts owning a repository the login sees. A comment, an inbox entry or a discussion starts a run
only when its author has `runs:start:<mode>` for the mode it resolves to (else nothing starts,
and nothing is said, as for an author outside the repository's `users`), `/cancel` and an
`/after none` alone need `runs:manage`, an `/after` with a start the start's action, and `/mode policy`
`tasks:read` (each refused without a word), and a comment or ticked boxes answering an issue's
open questions `runs:manage`, as the dashboard's answers (refused, the label stays, its ticks
answer nothing for `wait_for_answers`, and nothing is said); queued work is checked again before it runs (a decision that fails then drops nothing). An auto-pickup label starts work only
when whoever added it, and whoever edited the issue since, have `runs:start:work`. A reviewer
`review.request` names is requested only with `tasks:read`. A repository where a login has no
action at all is hidden from it everywhere: the repositories list, the tasks, inboxes, lanes and
blockers of `api/state`, `/status` and the live logs (`logs:read`); its routes answer as one
outside `ALLOWED_REPOS`. Totals (running, queued, slots) stay, of every repository. The repository's `users` still
narrow it: a login outside them has no action there.

A rule may give, or deny, a prefix ending in `*`: `runs:start:*` (every mode), `runs:*`,
`server:*`, `*` (everything). The server's actions count only server-wide, the others only on
a repository. A pattern asked (`can(login, repo, "runs:start:*")`) means all of it: a deny of
any action it covers (`runs:start:work`) refuses it; `*` asked server-wide is `server:*`.

An action no rule should name (`run:start:work`, `task:read`: neither one of the table's nor a
prefix of theirs) gives nothing, and a deny of it takes nothing away. The checks say it, as
probably misspelled: Deckhand's log at start for the operator's rules, server-wide; a
repository's config panel for both layers' rules on it; and the config check of a pull request's
branch (onboarding's) for the repository's own. Each is asked of the first 100 `ALLOWED_USERS`
logins. A repository's deny of `runs:start:<mode>` for a mode it doesn't have (`runs:start:wrok`:
`runs:start:*` covers it, but no run is in that mode) is said too, by its config panel (its
default branch's `modes:`) and its branch's config check (that branch's): the operator's rules
aren't checked so, as they may name another repository's modes. Only evaluating the rules says
what they name, so a rule that holds for none of those inputs (a binding of a repository not
checked, a login outside `ALLOWED_USERS`) isn't said.

A binding whose `role` is none of `access-roles.rego`'s (`viwer`) gives nothing but its own
`actions`. The same checks of the operator's rules say it, whoever and wherever the binding is
for: `access-roles.rego` answers their input of its own (`check: "roles"`, which no decision
sends) with an action per such role, `deckhand:unknown-role:<role>`. A grants folder's
`access-roles.rego` replaces that rule too: without it, nothing is said.

**Roles and bindings**: Deckhand's `access-roles.rego` defines four roles as action sets, and
gives each login the actions of the `bindings` that match it:

| Role       | Actions                                                    |
| ---------- | ---------------------------------------------------------- |
| `viewer`   | `tasks:read`                                               |
| `member`   | a viewer's, `logs:read`, `runs:start:*`, `runs:manage`     |
| `admin`    | a member's, `repo:config:read`                             |
| `operator` | `server:*` (server-wide only: bind it beside another role) |

Deckhand's `access.rego` gives every action to every login (`allow_access contains "*"`), as
before access had rules. The grants folder's `policy/access.rego` replaces it, usually with
bindings only: each login then has its bindings' actions, and nobody else anything. Bindings
written in a file of another name leave Deckhand's `access.rego` in effect, and its `*` still
gives every login every action: the config check warns of it (at start and on the Policies tab).
So does an operator's `access.rego` that keeps the line `allow_access contains "*"` beside
bindings (a copy of Deckhand's, bindings added below it): give that `*` a condition, or remove
it.

<!-- access.rego: test/access-rules.test.mjs evaluates this block with the real opa -->

```rego
# grants folder: policy/access.rego
package deckhand

bindings := [
  {"users": ["alice"], "repos": ["acme/*"], "role": "viewer"},
  {"users": ["bob"], "repos": ["acme/api", "acme/web"], "role": "member"},
  {"users": ["carol"], "repos": ["*/*"], "role": "admin"},
  {"users": ["carol"], "role": "operator"},
  {"users": ["dan"], "repos": ["acme/api"], "actions": ["logs:read"]},
]
```

A binding names logins (`users`), repositories (`repos`: `owner/repo`, `owner/*` or `*/*`),
both whatever their case, and a `role`, `actions` of its own, or both (it gives their union).
A binding without `repos` (or with an empty list) matches no repository: it is server-wide only
(`{"users": ["x"], "role": "member"}` gives nothing; name `"repos": ["*/*"]` for every
repository). Server-wide, every binding of the login's matches whatever its `repos`, for the
server actions it names (`server:read`, `server:*`); its `*` counts there only when it is
server-wide only or on `*/*`. Other rules of the operator's can
give actions too (`allow_access contains "tasks:read" if not input.repo.private`), and deny
them, on the operator's side for every repository:

```rego
# grants folder: policy/public.rego
package deckhand

deny_access contains {"action": "runs:*", "reason": "no runs on public repositories"} if {
  input.repo.private == false
}
```

or in a repository's `.deckhand/policy/`, for its own (`deny_access contains {"action":
"runs:start:work", "reason": "…"} if input.user.login != "release-bot"`). A repository's
`allow_access` is ignored, a config check error, and its `.deckhand.yaml`'s `users` still
narrows on its own.

**What a repository may narrow**: only its own access, never give any. Its maintainers have two
ways, both read from its default branch (so whoever may push there decides them):

- **`users`** in `.deckhand.yaml`: a login outside them has no action on the repository at all,
  which hides it from them, whatever the operator's bindings say;
- **`deny_access`** in `.deckhand/policy/`: takes some actions away there, for some logins or
  all, with a reason Settings › Access shows the operator. It sees the same input as the
  operator's rules, and its deny wins as theirs does.

<!-- repository deny_access: test/access-rules.test.mjs evaluates this block with the real opa -->

```rego
# .deckhand/policy/access.rego (a repository's)
package deckhand

# Only the release managers start work here; everyone else keeps what the operator gave them.
deny_access contains {"action": "runs:start:work", "reason": "work runs are the release managers'"} if {
  not input.user.login in {"alice", "bob"}
}

# Nobody reads this repository's live logs: its runs read customer data.
deny_access contains {"action": "logs:read", "reason": "logs may hold customer data"}
```

It can't give a login an action the operator's rules don't (its `allow_access` is ignored), nor
reach the server-wide actions (`input.repo` is its own, never null, when its rules are asked) or
another repository's access. A file of its named `access.rego` replaces nothing: its packages are
its own ([Policies](#policies)). Its deny applies from the push to its default branch on. A policy
of its that errs takes every action away on the repository for every login (fail closed), which
hides it from everyone until it is fixed: Deckhand's log says why, and the config check of a
pull request's branch (onboarding's) reports its compile errors before it merges.

### The default policies

Deckhand's default policies say what each kind of run gets and does. They ship in the policy
service's image (`policy/` in Deckhand's repository) and hold without any setup, in the
operator's layer, under the operator's files:

- **`allow.rego`** allows Deckhand's own decisions (`merge`, `review`, `fix`,
  `link_branch`, `request_review`), which the deny rules of the other files narrow. The
  operator's `policy/allow.rego` replaces it (one without `allow_merge` refuses every
  auto-merge).
- **One file per mode**, `mode-<mode>.rego`: what its runs get as they start
  (`allow_capabilities`, [capabilities](#capabilities)), what they write to GitHub
  (`allow_github`, [the GitHub input](policy-inputs.md#the-github-input)) and where they push (`allow_push`,
  [the push input](policy-inputs.md#the-push-input)), with the deny rules that are exceptions with a reason (a
  brainstorm doesn't comment, a run never deletes a comment or resolves a person's thread). Work
  runs (work, fix, CI fix and conflict runs) and the repository's own `modes:` share
  `mode-work.rego`; brainstorms and `/stop` `mode-brainstorm.rego`; groomings and their
  `/stop` `mode-grooming.rego` ([Grooming](modes.md#grooming)); then
  `mode-idea.rego`, `mode-bug.rego`, `mode-discussion.rego`, `mode-onboarding.rego`,
  `mode-analyze.rego`, `mode-review.rego`, `mode-research.rego` (research gets no GitHub token,
  so it never reaches the gateway), `mode-chat.rego` (the dashboard's chats: the code, its setup
  and its reads, no GitHub write and no push). The repository's own `modes:` get nothing until it allows
  them, then at most what work runs get.
- **`context.rego`** refuses `read:context` to a run on a fork's pull request: every mode's file
  but research's gives it ([Context repos](../repo-config.md#context-repos)).
- **One file per feature that isn't a mode's**: `gh-checks.rego` allows `read_checks` in
  every mode, `gh-linked-branch.rego` [the linked branch](policy-inputs.md#the-linked-branch-input),
  `gh-reviewers.rego` the [reviewers](reviews.md#reviewers), and **`run.rego`** [where each mode
  runs](policy-inputs.md#the-run-input).
- **`review.rego`** for the reviews that start by themselves: it skips other bots' pull
  requests ([below](#reviewrego)), which no allowlist stops, as the allowlist lists people.
- **`access.rego`** gives every login every action, and **`access-roles.rego`** the roles
  and the rule that turns the operator's `bindings` into actions ([access](#access)): the
  grants folder's `policy/access.rego` replaces the first, usually with bindings only.
- **Broadening a mode**: the operator's file with the same name replaces Deckhand's, for every
  repository (a copy of `mode-work.rego` without its rule on `assign` lets work runs assign
  people); another file of the operator's adds allow rules beside it. A repository can't
  broaden one. The built-in checks still hold, whatever a policy says ([the GitHub
  input](policy-inputs.md#the-github-input)).
- **Each default file is evaluated with the real `opa`** by Deckhand's tests, on every kind of
  mode, write and target: the built-in modes write what they wrote when these were ceilings
  built into Deckhand.

The Policies tab lists them as `deckhand/policy/<name>`, with the operator's file that replaces
one; the repository's settings show, for each mode, the file that decided each of its
capabilities.

| File                | Rule                                                       | work, fix, conflict                                                                                     | brainstorm                 | research      | repository modes                                |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------- | ------------- | ----------------------------------------------- |
| `gh-reviewers.rego` | `deny_request_review`                                      | ✅ [reviewers](reviews.md#reviewers) requested when the pull request turns ready, and again after a fix | ❌ (opens no pull request) | ❌ (no token) | ✅ once the repository's `allow_request_review` |
| `gh-checks.rego`    | `allow_github` (`read_checks`)                             | ✅                                                                                                      | ✅                         | ❌ (no token) | ✅ once the repository's `allow_github`         |
| `mode-*.rego`       | `allow_github` (`project`, [Projects](issues.md#projects)) | ✅ its issue, pull request, sub-issues, filed issues, to a granted project                              | ✅ the issues it files     | ❌ (no token) | ✅ once the repository's `allow_github`         |

Setting a project item's field, removing or archiving one is refused whatever a policy says:
Deckhand moves items.

Teams are never requested, whatever a policy says: `review.request` takes logins only.

#### review.rego

`review.rego` holds `deny_review` for the reviews that start by themselves
([`review.on: ready`](reviews.md#reviews)). The allowlist (`users`) lists people, so the built-in gate
only checks a person who opens a pull request; another bot (Dependabot, GitHub Actions) is
stopped here instead:

<!-- review.rego: test/reviews.test.mjs checks this block is in policy/review.rego, and evaluates the next one with the real opa -->

```rego
# policy/review.rego (its rule)
deny_review contains msg if {
  input.pr.author_type == "Bot"
  not input.pr.deckhand
  msg := sprintf("%s is a bot: its pull requests aren't reviewed unless the operator's policy/review.rego lets them", [input.pr.author])
}
```

The operator has a bot's ready pull requests reviewed (never a fork's) with a `review.rego` of
their own in the grants folder's `policy/`, which replaces this one for every repository; a
repository's `.deckhand/policy/review.rego` only adds refusals, as its other files. To review
Dependabot's only:

```rego
# grants folder: policy/review.rego
package deckhand

deny_review contains msg if {
  input.pr.author_type == "Bot"
  not input.pr.deckhand
  input.pr.author != "dependabot[bot]"
  msg := sprintf("%s's pull requests aren't reviewed", [input.pr.author])
}
```

To review every bot's, a file with no rule, its comment naming `author_type` (the config check
warns of a replacement that doesn't, below):

```rego
# grants folder: policy/review.rego: every bot's pull requests are reviewed, whatever its author_type.
package deckhand
```

**Upgrading with a `review.rego` of your own**: an operator's written before this default (a
`deny_review` on wip labels, say) replaces it, and other bots' ready pull requests are then
reviewed, at the operator's cost. The config check warns of one that never names
`author_type`, at the start and on every Policies tab: copy the rule above into it, or name
`author_type` in a comment if bots' pull requests should be reviewed.

#### machines.rego

`machines.rego` refuses `deny_merge` for a pull request the App opened from a branch a user's
[machine](issues.md#machines) pushed (`pr.external`): its commits went through none of the git gateway's
checks, so a person merges it. An operator's `policy/machines.rego` with only `package deckhand`
lets `review.merge` merge them; the built-in gates still hold.

```rego
# policy/machines.rego (its rule)
deny_merge contains msg if {
  is_string(input.pr.external)
  msg := sprintf("its commits were pushed from %s's machine, not through Deckhand: a person merges it", [input.pr.external])
}
```

#### A run's own comments

A work run corrects a comment it posted rather than posting another (issue #455): `PATCH` or
`DELETE …/issues/comments/<id>`, or GraphQL's `updateIssueComment` and `deleteIssueComment`
(`gh issue comment --edit-last`, `--delete-last`, `gh pr comment` likewise). The App's bot
writes every run's comments and Deckhand's own (its live progress comment, its replies,
its reviews), so a comment's author says nothing: the gateway keeps the comments GitHub said
the run posted, from the answers to its own calls (a REST `201` on `…/issues/<n>/comments`, its
`url`; GraphQL's `addComment`, only under the response key of a field the gateway parsed,
selecting GitHub's own `commentEdge { node { url } }`, unaliased), saved with the run so a
restart keeps them. Such a comment, in the run's repository and still the bot's on
GitHub, is a `created_comment`; any other is refused before any look-up or policy:
Deckhand's, another run's, a person's, a review's. `--edit-last` picks the bot's last comment
on the issue, which may be Deckhand's: its refusal says to send
`gh api -X PATCH repos/<owner>/<repo>/issues/comments/<id> -f body=…` instead, with the id
that ends the URL gh printed when the run posted it (`#issuecomment-<id>`). An edit's body is
redacted as any write's.

Deckhand's default, `mode-work.rego`, allows `edit` on `created_comment` to work runs and the
repository's modes, and denies `delete`:

|                              | work, fix, conflict                 | brainstorm                               | research    | repository modes                    |
| ---------------------------- | ----------------------------------- | ---------------------------------------- | ----------- | ----------------------------------- |
| `edit` a comment it posted   | ✅ allowed                          | ❌ (its replies are Deckhand's: no rule) | ❌ no token | ✅ once the repository allows them  |
| `delete` a comment it posted | ❌ denied, the operator may broaden | ❌                                       | ❌ no token | ❌ denied, the operator may broaden |

The file ships in the policy service's image ([The default policies](#the-default-policies)), so
this holds without any setup. The operator's `policy/mode-work.rego` replaces it for every
repository (a copy without the rule on `delete`, say). A repository's own modes edit theirs
once its `allow_github` lets them.

#### Reactions

A run acknowledges a comment with a reaction rather than another comment (issue #458): 👀 when
it starts on a maintainer's request, 👍 on a suggestion it applied. `POST …/issues/<n>/reactions`,
`…/issues/comments/<id>/reactions` and `…/pulls/comments/<id>/reactions`, or GraphQL's
`addReaction`, are `react`; `DELETE` of the same paths with the reaction's id, or
`removeReaction`, `unreact`. A comment's reaction is held to the policies as a write on the
issue or pull request the comment is on, looked up on GitHub (in the run's repository), and its input names
the comment (`target.comment`, `comment_author`, `comment_deckhand`). Reactions on a commit's comment or a review are refused.

The App's bot adds Deckhand's reactions too (👀 on a comment that starts a run, then 🚀,
😕 or 👎 when it is over), so a run removes only the reactions GitHub said it added, saved with
the run like the issues it created: a REST `201` (a `200` says the bot had it already), or an
`addReaction` field the gateway parsed whose content the bot hadn't on that subject, which
GitHub ran. A reaction the run removed is no longer its own (Deckhand may add the same one
since), and it keeps its 100 newest. A reaction Deckhand added, on any comment of the
repository (whichever task it went to, a waiting `/after`, a held comment's 😕, a finished run's
outcome), is never the run's, even where the run's came first: GitHub keeps one reaction per
user and content, so Deckhand's `POST` answers with the run's. Deckhand notes each one
before it asks GitHub, in the github service's store, and drops its 👀 once it takes it
off. Any other removal is refused before any policy. One added over GraphQL is removed
with `removeReaction` (REST's `DELETE` names a reaction by an id the gateway didn't keep for it).

Deckhand's defaults allow them in `mode-work.rego` and `mode-brainstorm.rego`:

|                                                          | work, fix, conflict | brainstorm                           | research    | repository modes                   |
| -------------------------------------------------------- | ------------------- | ------------------------------------ | ----------- | ---------------------------------- |
| `react` on its issue or pull request, and their comments | ✅ allowed          | ✅ on its own issue and its comments | ❌ no token | ✅ once the repository allows them |
| `unreact`                                                | ✅ its own only     | ✅ its own only                      | ❌ no token | ✅ its own only, likewise          |

The file ships in the policy service's image ([The default policies](#the-default-policies)), so
this holds without any setup. A repository's `allow_github` lets its own modes react, up to
what `mode-work.rego` allows, and its deny rule refuses
reactions altogether there:

```rego
# .deckhand/policy/reactions.rego
package deckhand

deny_github contains "this repository doesn't let runs react" if {
  input.action in {"react", "unreact"}
}
```

#### Review threads

Deckhand's default, `mode-work.rego`, allows `reply`, `resolve` and `unresolve` on a run's own
pull request (`own_pr`) to work runs and the repository's modes
([above](policy-inputs.md#the-github-input)), and denies resolving a person's thread: resolving hides a
thread, so a run resolves
only those Deckhand's review opened, never a person's, which stays open for its author to read
the reply.

|                                 | work, fix, conflict                 | brainstorm   | research    | repository modes                    |
| ------------------------------- | ----------------------------------- | ------------ | ----------- | ----------------------------------- |
| `reply` on its own pull request | ✅ allowed                          | ❌ (no rule) | ❌ no token | ✅ once the repository allows them  |
| `resolve` Deckhand's thread     | ✅ allowed                          | ❌ (no rule) | ❌ no token | ✅ once the repository allows them  |
| `resolve` a person's thread     | ❌ denied, the operator may broaden | ❌ (no rule) | ❌ no token | ❌ denied, the operator may broaden |
| `unresolve` a thread            | ✅ allowed                          | ❌ (no rule) | ❌ no token | ✅ once the repository allows them  |

The file ships in the policy service's image ([The default policies](#the-default-policies)). The
operator's `policy/mode-work.rego` replaces it for every repository (a copy without the rule on
`resolve` lets work runs resolve anyone's threads). A
repository's deny rule narrows it for its runs.

#### Updating a pull request's branch

Deckhand's default, `mode-work.rego`, allows it to work runs (a maintainer's, a
review's fix run, a conflict's) merge the base into their pull request's branch, and the
repository's own `modes:` once its `allow_github` lets them. A repository's deny rule refusing
`input.action == "update_branch"` keeps its history linear, every run rebasing instead. Nothing
else allows it: only work runs and the repository's modes update a branch,
of their own pull requests only, and with a merge, whatever a policy says.

| What                                            | work (fix, conflict) | brainstorm   | research      | the repository's `modes:`     |
| ----------------------------------------------- | -------------------- | ------------ | ------------- | ----------------------------- |
| `update_branch` (merge) on its own pull request | allowed              | no (no rule) | no (no token) | once the repository allows it |
| rebase                                          | no (built in)        | no           | no            | no (built in)                 |

#### Assignees and milestones

`change.assignees` names logins as the run spelled them (compare with `lower()`; a bot's with
`[bot]`); a list set in place of the target's is split against GitHub's. Deckhand's default,
[`mode-work.rego`](../../policy/mode-work.rego) and [`mode-brainstorm.rego`](../../policy/mode-brainstorm.rego), shipped in the image:

|             | work, fix, conflict                                        | brainstorm               | research    | repository modes                    |
| ----------- | ---------------------------------------------------------- | ------------------------ | ----------- | ----------------------------------- |
| `milestone` | ✅ its issue, pull requests, sub-issues and created issues | ✅ the issues it creates | ❌ no token | ✅ once the repository allows them  |
| `assign`    | ❌ denied, the operator may broaden                        | ❌ (no rule)             | ❌ no token | ❌ denied, the operator may broaden |

The operator's `policy/mode-work.rego`, a copy of Deckhand's without its rule on `assign`, lets
work runs assign people, never past the limit on assignees; a file of the operator's beside it
narrows that. To let work runs assign the issue's author only:

```rego
# grants folder: policy/assign.rego, beside a policy/mode-work.rego without the rule on assign
package deckhand

deny_github contains "a run assigns only the issue's author" if {
  some login in input.change.assignees.added
  lower(login) != lower(input.target.author)
}

# A new issue has no author yet (null).
deny_github contains "a run assigns only the issue's author" if {
  "assign" in input.actions
  input.target.kind in {"new_issue", "new_pr"}
}

deny_github contains "only work runs assign people" if {
  "assign" in input.actions
  input.mode != "work"
}
```

### A dry run and the dashboard

**`/mode policy`**, commented on a pull request by an allowed user, evaluates the `merge`,
`review`, `fix` and `request_review` decisions on the pull request as it is now, `run` on
sample comments (work, a brainstorm), `push` on a sample (the pull request's head branch,
pushed by the work run of the issue it closes), and `github` on
sample writes (a comment on it by the work run whose pull request it is, one by a brainstorm
of another issue, `issue: null`, and, when the repository has `modes:`, one by a run in the
first of them, `custom_mode: true`), then on a `read_checks` sample, `link_branch` on a
sample (the pull request's head branch, as its work run on the issue it closes would have had it
linked), and replies with each decision's result (refused, with its messages, or allowed), each
layer's `allow_*` and `deny_*` results under it with the files that define them, then the
merge's input and the samples' inputs, in collapsed blocks. The samples' results are labelled as such
and aren't counted as denials. Nothing is
reviewed, fixed or merged, and it is no decision: it debugs a rule without waiting for a pull
request to turn ready. The task's page shows its last one: who asked, when, how many denials,
and a link to the reply. The input is the merge's, read now, with `review: null` (no review
ran); `deny_review` and `deny_fix` get it with their own `decision`, without `checks`,
`deny_fix` with the `round` and `rounds` the next fix run would have (a review's: `reason: "review"`), `deny_request_review`
with its `reviewers`, `when: "ready"` and the run that opened the pull request, as Deckhand would ask; its "allowed" adds "but nobody would be requested" when Deckhand wouldn't ask (`review.request` names no allowed user, or it isn't Deckhand's own ready pull request). It works without a `review` block, and doesn't ask `grant` (the config page says the
repository's grants). On an issue, a reply says to comment it on the
pull request.

**The dashboard**: the repository's settings have a Policies tab, next to its config: the
config check's errors first (each linked to its line), each decision's allow and deny rules
per layer and their files (or refused while the check fails), the policy files that apply
(Deckhand's, the operator's replacing some, the repository's read from the default branch:
the rules each defines, whether it compiles), and each file's source. A task's page shows its
pull request's last policy decisions (whether refused, the messages, what each layer said,
when), the last 10 of them; a decision is kept only when a policy was asked, so a repository without
policies shows none. Each lists the built-in gates that passed before the policies were asked
(for a merge: the review's findings and verdict, the head commit, the pull request's state,
no trusted file changed, the checks…), and the newest 3 keep the input the rules saw,
redacted, cut to 8 KB (its changed files first, then the review's findings, then the checks;
marked `truncated`).
