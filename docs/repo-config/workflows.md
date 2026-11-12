# Per-repo config: workflows

Part of the [`.deckhand.yaml` reference](../repo-config.md): a repository's own
`.deckhand/workflows/`, what Deckhand does with its pull requests, step by step, written as data.
Not GitHub Actions' workflows (`.github/workflows/`, [Workflow files](../repo-config.md#workflow-files)).

## What a workflow is

Deckhand's pull request lifecycle runs on workflows: each says which steps follow an event,
under which conditions, and what to count along the way. Two events have one:

- `ready`, a pull request that turned ready for review: the [review loop](reviews.md#reviews)
  (CI, review, fix runs, merge). `.deckhand.yaml`'s `review:` block compiles to Deckhand's own
  workflow on it (see [The review loop](#the-review-loop)); a file of the repository's replaces
  it.
- `conflict`, the [conflict watcher](issues.md#conflicts) finding one of Deckhand's pull requests
  in conflict with its base.

```yaml
# .deckhand/workflows/conflicts.yaml (read from the default branch)
on: conflict
vars:
  rebases: counter
  warned: flag
  handed_over: flag
steps:
  - if: label("hold") or paths("migrations/**")
    then:
      - if: not warned
        comment: "This one waits for a maintainer: no rebase run."
        set: warned
    else:
      - if: rebases < 3
        run: rebase
        count: rebases
        else:
          - if: not handed_over
            comment: Three rebase runs already, over to a maintainer.
            set: handed_over
  - if: changed("migrations/**", since warned)
    comment: The rebase touched the migrations, have a look.
```

- **Files**: `.deckhand/workflows/*.yaml` on the default branch, read like
  [the policies](policies.md#policies): listed again when the default branch moves. A `.yml` file
  is ignored, with a warning in the onboarding pull request's check. At most 20 files of 32 KB.
- **A workflow never widens what a run may do.** It only orders the steps: each one still asks
  the [policies](policies.md#policies) as the built-in code does (a rebase run its `deny_fix`, with
  `reason: "conflict"`; a review its `deny_review`), and the built-in gates (a run going, input
  awaited, a pair tried already, a head reviewed already) still apply before any workflow
  starts.
- **Fail closed**: an error in any file, and none of the repository's workflows runs, Deckhand's
  own on `ready` and `conflict` neither: no review starts by itself there (the orchestrator's
  logs say why), and the conflict watcher starts nothing (its logs and the dashboard's Sync say
  why). Pull requests already in Deckhand's own review loop finish it; those in a
  repository's own workflow stop where they are. The onboarding pull request's check
  and the dashboard's Workflow tab list the errors with their file and line.
- **Without a workflow of its own on `conflict`**, `conflicts.check_minutes` runs Deckhand's
  built-in one:

  ```yaml
  on: conflict
  steps:
    - run: rebase
  ```

  A repository's workflow on `conflict` replaces it. The watcher still needs
  `conflicts.check_minutes`: it is what finds the conflicts.

## Format

| Key     | What                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| `on`    | the event, or a list of them: `ready`, `conflict`. One workflow per event in a repository (see [Triggers](#triggers)) |
| `vars`  | the workflow's state, each name `counter` or `flag` (see [Vars](#vars))                                               |
| `steps` | the steps, in order                                                                                                   |

Each step is one of:

| Step                         | What                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run: <step>`                | one of the event's steps (below)                                                                                                                                                                  |
| `comment: <text>`            | a comment on the pull request, as Deckhand's App (its own reply, like a refusal note: no policy asks about it). Each new event posts it again: a flag (`if: not told`, `set: told`) posts it once |
| `if: <condition>` + `then:`  | the steps under `then` when the condition holds, else those under `else` (optional)                                                                                                               |
| `repeat:` + `max: <var> <n>` | the steps under `repeat` again, at most `n` rounds of counter `<var>`                                                                                                                             |

A `run` or `comment` step may also have an `if:` (and an `else:` list), `count: <counter>` (one
more when the step acts) and `set: <flag>` (set when it acts). A step the policies refuse counts
nothing and sets nothing; the steps after it go on.

The steps `run:` names, by event:

| Event      | Step         | What                                                                                                                                                                                                                                                                           |
| ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready`    | `ci`         | [the CI step](reviews.md#ci-before-the-review): the head commit's GitHub Actions runs waited for (`review.ci_wait`), a CI fix run when they fail (`review.ci_fix`, with a `run: fix` step in the workflow). Ends when CI passed, has no run, ran out of time or of CI fix runs |
| `ready`    | `review`     | a review run (`deny_review` asked when the pull request turned ready, and after each fix run)                                                                                                                                                                                  |
| `ready`    | `fix`        | a fix run of the last review's findings, when it requests changes (`deny_fix` asked, a round left, no run going, nobody's input awaited). **No fix run started ends the `repeat` it is in.** Its run's end goes on only when it pushed and `deny_review` allows reviewing it   |
| `ready`    | `merge`      | [the auto-merge](reviews.md#auto-merge) of the last review, decided: its gates, `allow_merge` and the operator's `auto_merge` grant, or the comment saying why not. Without the grant, the `rounds-out` comment instead. Doesn't wait: the steps after it go on                |
| `ready`    | `rounds-out` | not a `run`: `comment: rounds-out` posts Deckhand's own comment saying the last review still requests changes after the fix runs, once per pull request (nothing when it doesn't, or no fix run ran)                                                                           |
| `conflict` | `rebase`     | the conflict run: `deny_fix` asked, then a work run that rebases the pull request, or the "No rebase run" comment                                                                                                                                                              |

Each step but `merge` waits for its run's end (`ci`: its wait) before the next one. A `review`
or `fix` step may name its run's `agent` (one the operator runs), `model` and `effort`, and a
`review` its `instructions` (a file of the repository, trusted as `review.instructions` is: a
pull request that changes it is never auto-merged), over the `review` block's and the
repository's own:

```yaml
- run: review
  agent: codex
  model: best
  effort: high
  instructions: .deckhand/security-review.md
```

### Conditions

A fixed vocabulary, checked when the file is read: anything else is an error naming the file and
the line. Combine them with `and`, `or`, `not` and parentheses.

| Condition                          | Holds when                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `severity <= medium`               | the last review's most severe finding compares so (`none` < `low` < `medium` < `high` < `critical`, `none` a review without findings; `==`, `!=`, `<`, `<=`, `>`, `>=`). Without a review (on `conflict`), no comparison holds |
| `ci == passed`                     | the head commit's CI is `passed`, `failed`, `running` or `none` (`==`, `!=`)                                                                                                                                                   |
| `paths("glob", …)`                 | a file the pull request changes matches one of the globs (`*` within a folder, `**` across them)                                                                                                                               |
| `label("name", …)`                 | the pull request has one of the labels (any case)                                                                                                                                                                              |
| `changed("glob", …, since <flag>)` | as `paths()`, but only the files changed since the head the flag was set at; all of them while it isn't set                                                                                                                    |
| `rebases < 3`                      | a counter compared with a whole number                                                                                                                                                                                         |
| `warned`                           | a flag is set                                                                                                                                                                                                                  |

Quote a condition that holds `: ` (`if: 'changed("a/**", since: done)'`); `since done` needs
none. What a condition reads of GitHub (the files, CI) is read only when one asks.

### Vars

- **Counters** start at 0 and only go up: a step's `count` adds one when it acts.
- **Flags** start unset and are only set, never cleared: each remembers the head commit it was
  set at, for `changed(…, since <flag>)`.
- **One copy per pull request**, never reset: they live as long as the pull request is open,
  across every event of it. A new pull request on the same task starts from nothing.

### Loops

Every loop is bounded: `repeat` needs `max: <counter> <rounds>`, and a step inside it must
`count` that counter, else the file is refused as an unbounded loop. At run time, a loop also
stops at the operator's `MAX_FIX_ROUNDS`, whatever its `max`, after a round that counted
nothing (its counting step's `if` didn't hold), and at a `fix` step that started no fix run.

### Triggers

One workflow per event, checked when the files are read, on their `on` alone: two workflows on
the same event are refused, whatever their conditions, and so is a workflow on `ready` while the
`review` block has it (`review.on: ready`) or without a `review` block (its steps read its
settings).

## The review loop

`review.on: ready` compiles the `review` block to Deckhand's own workflow on `ready`: the steps
the review loop always ran, in the same order. The dashboard's **Workflow** tab (Settings ›
Repositories › a repository) shows it under the graph. With `ci: wait`, `fix: 3` and `merge: true`:

```yaml
# Deckhand's built-in review loop, compiled from the repository's `review:` block.
on: ready
vars:
  fixes: counter
steps:
  - run: ci # review.ci: wait, ci_wait: 30, ci_fix: 1
  - run: review
  - repeat:
      - run: fix # ends the loop when no fix run starts
        count: fixes
      - run: ci # review.ci: wait, ci_wait: 30, ci_fix: 1
      - run: review
    max: fixes 3 # review.fix
  - run: merge # review.merge, with the operator's auto_merge grant
```

Without `ci: wait`, no `ci` steps; without `merge`, `comment: rounds-out` in place of the merge;
with `fix: true` alone (one fix run, no merge), `- run: fix` after the review and nothing
reviewing its push, as before.

**A workflow of the repository's on `ready`** replaces it. Keep the `review` block, without
`on: ready` (`review: true`, or its keys without `on`): its settings still apply
(`max_allowed_severity`, `ci_wait`, `ci_fix`, `merge_method`, `merge_wait`, `follow_ups`, the
reviews' `agent`, `model`, `effort` and `instructions`), and the workflow's steps stand for the
rest: a `run: fix` step for `fix` (its loop's `max` for the rounds), `run: merge` for `merge`
(the operator's `auto_merge` grant still needed), `run: ci` for `ci: wait`. Every step asks the
policies as the built-in loop does: the file orders the steps, never widens what a run may do.

Two reviewers: the loop's, then a second opinion on another agent once nothing blocks, before
the merge:

```yaml
# .deckhand/workflows/review.yaml
on: ready
vars:
  fixes: counter
steps:
  - run: ci
  - run: review
  - repeat:
      - run: fix
        count: fixes
      - run: ci
      - run: review
    max: fixes 3
  - if: severity <= low
    then:
      - run: review
        agent: codex
        model: best
      - run: merge # reads the last review: the second one's
```

A security review when the pull request changes the policies, once per change (again only
when a later push changes them since):

```yaml
# .deckhand/workflows/review.yaml
on: ready
vars:
  fixes: counter
  security: flag
steps:
  - run: review
  - if: 'changed("policy/**", since: security)'
    run: review
    instructions: .deckhand/security-review.md
    set: security
  - repeat:
      - run: fix
        count: fixes
      - run: review
    max: fixes 2
  - run: merge
```

Both at once, in the one workflow a repository has on `ready`. As the fix, `severity` and merge
steps read the last review alone, each review that can block gets its fix loop before another
review comes: the loop's review and its fixes, then the security review and its own (each fix's
push reviewed again for security), then the second reviewer before the merge. A review still
blocking once the fix runs are used up ends it with the rounds-out comment, no further
reviewer asked. A pull request's fix runs are counted across its loops, up to the largest `max`:
these two share their 2.

```yaml
# .deckhand/workflows/review.yaml
on: ready
vars:
  fixes: counter
  security_fixes: counter
  security: flag
steps:
  - run: review
  - repeat:
      - run: fix
        count: fixes
      - run: review
    max: fixes 2
  - if: 'severity <= low and changed("policy/**", since: security)'
    then:
      - run: review
        instructions: .deckhand/security-review.md
        set: security
      - repeat:
          - run: fix
            count: security_fixes
          - run: review
            instructions: .deckhand/security-review.md
        max: security_fixes 2 # fix runs count per pull request: both loops share these 2
  - if: severity <= low # nothing blocking with `max_allowed_severity: low`, the default
    then:
      - run: review
        agent: codex
        model: best
      - run: merge
    else:
      - comment: rounds-out
```

- **The fix and merge steps read the last review**: the one that just ended, or the App's last
  review read back from GitHub when another step came between.
- **A fix a maintainer asks for** (the dashboard's Fix) is one round outside the workflow: its
  push is reviewed (after the `ci` step, with `review.ci: wait`), and the workflow goes on from
  that review.
- **A pull request ready again**, rebased by the conflict watcher, or ready after a CI step that
  reviewed nothing, runs the workflow again from its first step, its vars kept (its fix runs
  counted).

## How it runs

- **One instance per pull request and event**, kept in Deckhand's store after each step: an
  update or a handover between orchestrators goes on where the last one stopped.
- **Each pull request stays on the version it started with**: an instance keeps the workflow as
  it was at its first event, and a change on the default branch applies to the pull requests
  that start after it.
- **Each event runs once**: a conflict is the pull request's (head, base) pair, and the same
  pair, from a redelivered webhook or the next check, starts nothing twice. A new pair runs the
  steps again from the top, the vars kept. On `ready`, a head reviewed already starts nothing
  (as before), and each run's end goes on from the step that started it.
- **A pull request already in the review loop when it moved onto workflows** (an update of
  Deckhand) goes on in Deckhand's own workflow from the step its run or its CI wait is at, its
  fix runs counted as before.
- **A step is marked before it acts**: a comment an orchestrator stopped in the middle of counts
  as posted, never posted twice. A rebase step cut off is asked again by the next orchestrator,
  which starts the run unless its pair was tried already (it was queued then): either way, its
  run's end goes on with the next step, which waits for it.
- **A rebase step after a run's end** needs the pull request still in conflict, at a pair not
  tried yet. While GitHub is still computing whether it merges, the step takes nothing and the
  workflow stops there: the next conflict found starts it again.

## The editor

The dashboard's **Editor** tab (Settings › Repositories › a repository) edits these files without
a checkout:

- **The text beside its graph**, checked as you type by the orchestrator's own parser, with the
  repository's other workflow files beside it, as Deckhand reads them (two triggers for one
  event, and an error in another file, which stops every workflow there, are said too)
  and the operator's agents: each error with its line, the graph drawing the steps, a condition's
  two branches and a `repeat`'s loop. A click on a step moves the text to its line.
- **A dry run**: pick a past pull request whose review loop Deckhand ran (its record is kept 90
  days after its last review), and its history replays through the edited text: its reviews (by
  their most severe finding), its fix runs, a CI step that stopped it, its merge or the merge's
  refusal, and the policies' refusals of its review or fix runs. CI that passed isn't recorded:
  a `ci` step is taken as passed while the history goes on. At the **first step that pull request
  never took** (a second review where it was merged, say), or where its history ends, the replay
  stops and asks what that step ends with (the review finds a medium issue, CI fails, the fix
  pushes nothing…); each pick goes on to the next step. What is certain is decided without
  asking: a fix step after a review with nothing above `max_allowed_severity` starts no fix run,
  a merge after one with something above it is refused. Its conditions read the pull request's
  files and labels on GitHub. Nothing is queued, posted, or asked of the policies: it shows the
  path the workflow takes, not what the policies would decide. A workflow on `conflict` has no
  history to replay (only its last attempt is kept): its dry run asks from the first step.
- **Who runs which version**: how many open pull requests run the workflow at the version on the
  default branch, and how many at an older one. Each keeps its version until it closes, so a
  change applies to the pull requests that start once it is merged.
- **Open a pull request**: Deckhand's App (no agent run) commits the file to a new branch,
  `deckhand-workflow-<name>-<id>`, from the default branch's head, its commit's trailer
  co-authored by you, and opens a pull request saying you saved it. It lands like any other
  change: reviewed, then merged into the default branch, which is the only place workflows are
  read from. A text with errors of its own (its trigger clashing with another file's included)
  isn't saved, nor one over a file that changed on the default branch since you opened it;
  another file's errors are listed, but don't stop it, so two broken files can each be fixed. A
  workflow on `ready` in a repository whose `review.on: ready` runs the built-in loop replaces
  that loop: the same pull request turns `on: ready` in `.deckhand.yaml` to `on: manual`, the
  rest of its `review:` block kept (when the key shares its line with others, in a flow mapping,
  saving says to change it by hand). When
  GitHub refuses the commit or the pull request, the branch is deleted (or its name said, when it
  can't be). Saving needs the `repo:config:write` action
  ([Access](policies.md#access)); reading the files, checking them and dry runs
  `repo:config:read`.
