# Per-repo config: workflows

Part of the [`.deckhand.yaml` reference](../repo-config.md): a repository's own
`.deckhand/workflows/`, what Deckhand does with its pull requests, step by step, written as data.
Not GitHub Actions' workflows (`.github/workflows/`, [Workflow files](../repo-config.md#workflow-files)).

## What a workflow is

Deckhand's pull request lifecycle is built-in code that `.deckhand.yaml` switches on and off. A
workflow file says instead which steps follow an event, under which conditions, and what to count
along the way. This version runs one event, `conflict`: what happens when the
[conflict watcher](issues.md#conflicts) finds one of Deckhand's pull requests in conflict with
its base. The review loop moves onto workflows in a later version.

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
  `reason: "conflict"`), and the watcher's own gates (a run going, input awaited, a pair tried
  already) still apply before any workflow starts.
- **Fail closed**: an error in any file, and none of the repository's workflows runs; the
  conflict watcher starts nothing there and says why in its logs and in the dashboard's Sync.
  The onboarding pull request's check lists the errors with their file and line.
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

| Key     | What                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| `on`    | the event, or a list of them: `conflict`. One workflow per event in a repository (see [Triggers](#triggers)) |
| `vars`  | the workflow's state, each name `counter` or `flag` (see [Vars](#vars))                                      |
| `steps` | the steps, in order                                                                                          |

Each step is one of:

| Step                         | What                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run: rebase`                | the conflict run (on `conflict` only): `deny_fix` asked, then a work run that rebases the pull request, or the "No rebase run" comment. The next step waits for the run's end                     |
| `comment: <text>`            | a comment on the pull request, as Deckhand's App (its own reply, like a refusal note: no policy asks about it). Each new event posts it again: a flag (`if: not told`, `set: told`) posts it once |
| `if: <condition>` + `then:`  | the steps under `then` when the condition holds, else those under `else` (optional)                                                                                                               |
| `repeat:` + `max: <var> <n>` | the steps under `repeat` again, at most `n` rounds of counter `<var>`                                                                                                                             |

A `run` or `comment` step may also have an `if:` (and an `else:` list), `count: <counter>` (one
more when the step acts) and `set: <flag>` (set when it acts). A rebase the policies refuse
counts nothing and sets nothing; the steps after it go on.

### Conditions

A fixed vocabulary, checked when the file is read: anything else is an error naming the file and
the line. Combine them with `and`, `or`, `not` and parentheses.

| Condition                          | Holds when                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `severity <= medium`               | the last review's most severe finding compares so (`low` < `medium` < `high` < `critical`; `==`, `!=`, `<`, `<=`, `>`, `>=`). None on `conflict`: no comparison holds |
| `ci == passed`                     | the head commit's CI is `passed`, `failed`, `running` or `none` (`==`, `!=`)                                                                                          |
| `paths("glob", …)`                 | a file the pull request changes matches one of the globs (`*` within a folder, `**` across them)                                                                      |
| `label("name", …)`                 | the pull request has one of the labels (any case)                                                                                                                     |
| `changed("glob", …, since <flag>)` | as `paths()`, but only the files changed since the head the flag was set at; all of them while it isn't set                                                           |
| `rebases < 3`                      | a counter compared with a whole number                                                                                                                                |
| `warned`                           | a flag is set                                                                                                                                                         |

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
stops at the operator's `MAX_FIX_ROUNDS`, whatever its `max`, and after a round that counted
nothing (its counting step's `if` didn't hold).

### Triggers

One workflow per event, checked when the files are read, on their `on` alone: two workflows on
the same event are refused, whatever their conditions, and so is a workflow on `ready` while the
built-in review loop has it (`review.on: ready`). No workflow runs on `ready` yet: it waits for the review loop to move onto them.

## How it runs

- **One instance per pull request and event**, kept in Deckhand's store after each step: an
  update or a handover between orchestrators goes on where the last one stopped.
- **Each pull request stays on the version it started with**: an instance keeps the workflow as
  it was at its first event, and a change on the default branch applies to the pull requests
  that start after it.
- **Each event runs once**: a conflict is the pull request's (head, base) pair, and the same
  pair, from a redelivered webhook or the next check, starts nothing twice. A new pair runs the
  steps again from the top, the vars kept.
- **A step is marked before it acts**: a comment an orchestrator stopped in the middle of counts
  as posted, never posted twice. A rebase step cut off is asked again by the next orchestrator,
  which starts the run unless its pair was tried already (it was queued then): either way, its
  run's end goes on with the next step, which waits for it.
- **A rebase step after a run's end** needs the pull request still in conflict, at a pair not
  tried yet. While GitHub is still computing whether it merges, the step takes nothing and the
  workflow stops there: the next conflict found starts it again.
