# Auto-pickup

An issue nobody starts can wait for months. With `AUTO_PICKUP_SLOTS` above 0 (and below
`MAX_PARALLEL`, which it comes out of), the orchestrator starts the open issues labelled
`AUTO_PICKUP_LABEL` (`auto-pickup`) by itself, oldest created first across the repositories
whose `.deckhand.yaml` says `auto_pickup: true` ([repo-config/issues.md](../repo-config/issues.md#auto-pickup)),
in `work` mode, as many at once as there are slots. It looks every 5 minutes, a few seconds
after the label is added (an `issues` delivery) or one of Deckhand's pull requests is closed or
turned to a draft (a `pull_request` delivery), and as soon as a run ends or a queued
auto-picked issue is cancelled.

- **The slots.** Auto-picked runs never take more than `AUTO_PICKUP_SLOTS`. The other runs
  (comments, the dashboard, reviews) borrow those slots while no auto-picked issue waits: with
  `MAX_PARALLEL=3` and `AUTO_PICKUP_SLOTS=1`, three triggered runs may go at once. Once an
  issue is picked, they keep to 2, and it starts as soon as a slot frees. A repository's
  `max_parallel` counts auto-picked runs too: an issue of a repository at its own cap isn't
  picked, and one picked before its repo filled up holds no slot while it waits for it.
  What follows a picked run on its task holds the reserved slot too, until the picked work is
  done: queued during the picked run or behind it, the answer to its questions while it waits
  for one, and its pull request's review loop (review, fixes, CI, conflicts) until the loop is
  over, between its steps too (waiting for CI, its next step on its way). People's comments
  then are in the slot as well, and the next issue isn't picked meanwhile. The slot is free
  once the loop is over, the picked run left no loop going nor questions, its questions are set
  aside, the issue closed or its pull request merged or closed. When a sweep then gives it to
  the next issue, the pick is over for good: what comes next on the task is a run like any
  other, and a loop its draft starts later doesn't take the slot back, a reopened issue
  neither. The policies still see those runs as started by the listener or by the comment.
  A pick that asked keeps its slot until its questions are answered or set aside (the
  needs-input label taken off, the issue closed), picks from before an update included: the
  dashboard's line under the run slots shows such slots as held between runs ("1 auto-pickup
  slot (1 held between runs)"), and no issue is picked for them meanwhile.
- **What is skipped.** An issue with something live on the dashboard (running, queued,
  waiting, asking), the needs-input label (`NEEDS_INPUT_LABEL`), an open issue it is "blocked
  by", or an open pull request of Deckhand's for it; the next one is picked instead. A
  repository whose `auto_pickup_max_ready` is reached (that many of Deckhand's pull requests
  ready for review, drafts not counted) has none of its issues picked, their labels kept, until
  a merge or a close brings it below: the other repositories' take the slots meanwhile.
- **Who it runs for.** The person who last added the label, from the issue's events: they must
  be in `ALLOWED_USERS` and the repository's `users`, or nothing starts (a label a bot added
  either). The label vouches for the issue as it was then: a title or description changed
  since by anyone but an allowed user (the App's bot included) holds it until the label is
  added again ([security.md](../security/webhooks-and-sign-in.md#auto-pickup)). The run is theirs for the policies
  (`sender`, `trigger: "auto-pickup"`: a `deny_run` rule can refuse it,
  [The run input](../repo-config/policy-inputs.md#the-run-input)).
- **Once picked.** The App comments on the issue, then the label comes off and the run is
  queued. A failed or stopped run isn't picked again: add the label back to retry. An issue
  held by who added the label, or by an edit since, keeps it, and the App says why once.

The dashboard marks auto-picked tasks with a bolt (named "Auto-pickup" for screen readers and
on hover). Its run slots' meter keeps the reserved slots last: dashed while free, teal while an
auto-picked run holds one, blue and still dashed while a standard run borrows it. The line under
it says how they are used ("1 auto-pickup slot (1 in use)", "… (free)").
