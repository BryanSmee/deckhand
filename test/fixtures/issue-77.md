## Problem

When the base branch moves, a Deckhand PR can go into conflict and stay there until someone notices and comments. The listener has no timer that looks at PRs. `pulls.mjs` keeps each task's PR (`{ number, url, state, readyAt }`, `listener/pulls.mjs:1-4`) only for the dashboard. The `pull_request` webhook (`listener/events.mjs:255-262`) doesn't fire when the _base_ branch gets new commits, so it can't catch a conflict either.

## Proposal

**Opt-in, per repo**, in `.deckhand.yaml`:

```yaml
conflicts:
  check_minutes: 5 # off when the key is absent
```

Parsed in `listener/repo-config.mjs`, the same way as `preview.timeout_minutes` (whole number above 0, unknown keys are errors), and documented in `docs/repo-config.md`. Each check makes a run, so a run of its own and a bill. I'd also add an operator setting, `CONFLICT_CHECK_MINUTES`: the shortest interval allowed, with `0` turning the feature off. A repo can then slow it down but can't speed it up, in line with "per-repo config only narrows".

**The watcher**: a new `listener/conflicts.mjs`, with an injected clock, `fetch` and `accept`:

- On each tick, for each opted-in repo whose interval is due, take the open PRs from `pulls.mjs` (state `draft` or `ready`: only Deckhand's own tasks, never every PR in the repo). Then read `GET /repos/{repo}/pulls/{n}` and its `mergeable_state`.
- `dirty` means a conflict. `mergeable: null` means GitHub is still computing it: try again on the next tick.
- Skip forks, and tasks that are already running or have a run queued.
- On a conflict, call `tasks.accept()` with a work item for that task (`kind`/`id` as `prItem()` builds them, `listener/events.mjs:281-310`). It carries a message like "This PR conflicts with `<base>`: rebase it on `origin/<base>`, resolve the conflicts, rerun the checks and push with `--force-with-lease`. If it can't be resolved safely, stop and ask." It goes in the existing session, so Claude keeps the task's context. It replies on the PR like any run.
- **No loops**: remember the `(head sha, base sha)` pair of each attempt in a state file next to `pulls.json` (`writeJsonAtomic`). Don't start another run for the same pair: if the rebase failed or stopped with needs-input, wait for a new push or a new base commit. Also skip PRs carrying the needs-input label.
- Item fields that need a sender (the allowlist): the run is internal and only for tasks an allowed user already started. Mark it as from the listener, for example `trigger: "work"` and `sender: null`, plus a `reason: "conflict"` that the dashboard can show.

**Alternative to polling**: subscribe the App to `push` and check the open PRs of a repo when its default branch moves. That's fewer API calls and faster, but it adds an App permission/event and misses deliveries during a restart. I recommend polling as asked, maybe with `push` as a later trigger.

## Acceptance criteria

- [ ] Without `conflicts` in a repo's config, nothing is checked. Invalid values are config errors shown like the others.
- [ ] A repo can't check more often than `CONFLICT_CHECK_MINUTES`, and `0` turns the watcher off for everyone. Tested.
- [ ] With an injected clock and `fetch`: a `dirty` PR starts one work run with the rebase message. `clean`, `unstable`, `blocked` and `mergeable: null` don't. A running or queued task, a fork, or a PR with needs-input isn't touched.
- [ ] The same `(head, base)` pair never starts a second run, across a listener restart. A new head or base commit can start one.
- [ ] Only PRs that `pulls.mjs` knows as a task's open PR are checked.
- [ ] `docs/repo-config.md`, `docs/setup.md` (the operator setting) and `docs/architecture.md` describe it. `node --test` and prettier pass.

## Open questions

1. Operator floor `CONFLICT_CHECK_MINUTES` plus repo opt-in (recommended), or just the repo key?
2. Should "behind the base, no conflict" (`mergeable_state: behind`) also start a rebase? I recommend no: conflicts only, so the feature doesn't run up a bill.
3. Polling as asked (recommended), or the `push` webhook?

From the ideas inbox: https://github.com/BryanSmee/deckhand/issues/15#issuecomment-6191535550
