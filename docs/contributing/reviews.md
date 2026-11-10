# Reviews

A repo whose `.deckhand.yaml` has a `review` block gets the built-in `review` mode (`modes.mjs`:
volumes of its own, fresh; `policy/mode-review.rego`: no write). `/mode review` on a pull request
starts one; with `review.on: ready`, `reviews.mjs` also starts one from a `pull_request` delivery
(`ready_for_review`, or `opened` when not a draft) for a pull request on a branch of the repo,
opened by the App, an allowed user, or another bot (left to `deny_review`, which Deckhand's
`policy/review.rego` refuses). A policy that fails (a policy error: GitHub couldn't give its input,
`opa` timed out) rather than refuses is asked once more 10 seconds later (`asking()`, the review
after a fix run's too); a `deny_review` still failing then on a pull request that turned ready is
kept as `policyRetry` ({ sha, base, tries }) in the store's `reviews` and asked again at the next
`tick()`s, three times at most (a pull request GitHub can't give then counts as one), unless it was
closed, made a draft or pushed to since. It is a work item as if from a comment
(`trigger: "review"`, no comment, `reason: "review"`), on the task of the issue the pull request
closes or the pull request's own. Each pull request's reviewed head commit is kept in the store's
`reviews`, so a redelivery, a restart or the same commit again starts none. Its thread is a file in
the run's inbox (`TASK_DIGEST`, `reviewThread()`, written by `preparation.mjs`): the pull request's
and its issue's, with what users outside the allowlist wrote left out. The run's final message
follows `prompts/review.md`'s format, its markdown then the same review as a `json deckhand-review`
block that `parseReview()` reads first (`readBlock()`; without one, or one that doesn't validate,
logged, the markdown, `readMarkdown()`); `runs.mjs` hands it to `postReview()`, which posts one
GitHub review as the App (its installation token, through the github service): findings grouped by
severity, the rating (capped by the most severe finding, `parseReview()`), `REQUEST_CHANGES` and a
"request changes" verdict on a critical, high or medium finding and `COMMENT` otherwise (never
`APPROVE`), and a comment review with the raw text when the format can't be read. An automatic
review in a fix loop (`review.fix`), or deciding an auto-merge, may tolerate medium findings
(`review.max_allowed_severity`, `reviews.tolerance()`): those post as `COMMENT`. `runs.mjs` works
that tolerance out at launch too, and `reviewPrompt()` fills `prompts/review.md`'s verdict rule with
it (`<blocking>`, `<tolerated>`, from `review-parse.mjs`'s `blockingSeverities()`); the tolerance at post
time is the one that counts, should the settings change during the run.

With `review.fix`, once the review's run is torn down (so it no longer makes the task busy),
`runs.mjs` hands, without waiting for it, the posted review to `reviews.settle()`, whose `fix()`: a
review that requests changes on the App's own pull request, linked to its issue, queues a work item
on the issue's task (`trigger: "work"`, `sender: null`, `reason: "review-fix"`, its `round` of
`rounds`), its text the findings fenced off as untrusted claims (`fixMessage()`), as `conflicts.mjs`
does for a rebase. `fixes` in the store's `reviews`, counted before the item is queued, bounds it to
`review.fix`'s rounds (`fixedAt` alone, in an entry from before them, is one). A review with nothing
above `max_allowed_severity` (`tolerance()`) starts none, and without auto-merge a review that still
requests changes once the rounds ran out comments so (`roundsOut()`).

With `review.merge` and the operator's `auto_merge` grant (`grants.mjs` `autoMergeProblems()`),
`settle()` goes on, for a review that started by itself (an item with `reason: "review"`, not a
`/mode review` comment's) and started no fix run: `autoMerge()` re-reads the repo's settings and
grant, records `mergeAt` (one decision per pull request), checks `mergeBlockers()` and the gates
(`mergeRefusal()`: the pull request, its labels, its head, the repository's visibility and merge
methods, its changed files against `trustedFile()`, `mergeable_state`, its head compared with its
base's branch now (`GET /compare`, #778: GitHub's `behind` needs branch protection, which the Free
plan's private repositories lack; behind refuses at once, and Deckhand doesn't update the branch,
whose new head would need a review of its own), its Actions runs, last the policies' `deny_merge`),
then merges as the App at the reviewed head (`PUT /pulls/{n}/merge` with `sha`) or comments why not.
When only Actions runs still going stand in the way (`mergeRefusal()`'s `pending`), `decide()`
clears `mergeAt` and keeps `waiting` ({ sha, since, review, … }) in the store's `reviews` instead:
`checksDone()`, on a `workflow_run` `completed` delivery for that sha (`http.mjs`), and `tick()`,
every 5 minutes, decide again (`recheck()`, one at a time per pull request), until
`review.merge_wait` minutes after `since`, when the pull request is refused. `waiting` stays saved
until such a decision ends (an in-memory map keeps it to one at a time), so an orchestrator stopped
meanwhile asks again, and a GitHub call failing then waits for the next try. A merge is recorded on
the task's pull request (`pulls.mjs`, `autoMerged`) for the dashboard. A fix run's end (an item with
`reason: "review-fix"`, in `cleanUp()`) calls `reviews.fixed()`: in auto-merge mode or with more
than one round (`fix: true` without `merge` stops at its fix run), one more review of what it
pushed, once per fix run (`reviewedFixes`; `rereviewAt` in an old entry), whose end starts the next
round or stops the loop (`settle()`), or, in auto-merge mode, a comment when it failed or pushed
nothing. At start, `server.mjs` logs a warning for each policy file of the grants folder whose
`allow_grant` rules name `auto_merge` or `auto_merge_public`.

With `review.ci: wait`, every automatic review goes through `reviewAfterCi()` first (`consider()`,
`reviewFix()`, and the end of a CI fix run): it keeps `ciWaiting` ({ sha, since, base, author }) in
the store's `reviews` and decides with `ciDecide()` (one at a time per pull request, a promise
chain), again on a `workflow_run` `completed` delivery for that sha (`checksDone()`), on a
`pull_request` `synchronize` (`pushed()`, which moves the wait to the new head) and from `tick()`.
`ciState()` (`ci.mjs`, which also sorts check runs and commit statuses, for when they are read)
sorts the head commit's Actions runs into `failed`, `running`, `passed` or `none`, the same rule
`mergeRefusal()` uses. Passed, none (after a minute's grace), or `review.ci_wait` gone:
`queueReview()`, the item's `ciNote` (why CI hadn't passed) going to `reviewPrompt()`. Failed:
`ciFailed()` comments, then queues a work item (`reason: "ci-fix"`, its `round` of `rounds`) whose
text is `ciFixMessage()` (failed runs and jobs, read from `/actions/runs/{id}/jobs`, no logs),
counted in `ciFixes` before it is queued; out of rounds, or no CI fix possible, the review anyway. A
CI fix run's end (`cleanUp()`) calls `ciFixed()`, once per run (`ciSettled`): its push goes back to
`reviewAfterCi()`, or a comment says it failed or pushed nothing. `reviewLoop()` shows `ci` while
`ciWaiting` and `ci-fix` while that run is queued, running or settling, and `ci-failed` once the CI
step stopped without a review (`ciStopped`, cleared when a review is queued). A CI fix run waits for
the issue's task to be free: `ciFailed()` keeps `ciWaiting` while it is busy, and `runEnded()`,
called by `cleanUp()` after every run, decides again. A wait dropped (closed, a draft again) sets
`ciDropped` to the head it never reviewed, and a stopped CI step keeps its head in `ciStopped.sha`:
`consider()` skips neither head as reviewed already.

A conflict run (`reason: "conflict"`, its item's `rebaseFrom` the head it rebases) goes back to
the loop too: its end in `cleanUp()` calls `reviews.rebased()`, which marks the loop
(`deciding()`) at once. On a pull request the loop reviewed (its entry's `head`), still under
`review.on: ready`, open, not waiting for input, whose head moved from `rebaseFrom`, after a run
that ended `ok` (not `error`, `cancelled` or `needs-input`): `deny_review` is asked, then what
the conflict stopped is cleared (`rebaseRetry`, set by `decide()` when `mergeRefusal()` says
`rebase`: `dirty`, a run going, a moved head; by `autoMerge()` on a head moved during the
review; by `queueFix()` when a busy task skipped the loop's fix run; and a `waiting` merge of the
old head), and the new head goes through `reviewAfterCi()`, counting no fix round. Another
`mergeAt` stays. With `ciWaiting`, `ciRecheck()` moves the wait instead. The watcher, for its
part, skips a pull request while `reviews.looping()` says the loop is between steps
(`decisions`, which `settle()`, `fixed()`, `ciFixed()` and `rebased()` set synchronously from
the run's end, or `ciWaiting`), before the pair is kept, so the next check tries again; a merge
`waiting` for checks doesn't hold it. `reviewLoop()` shows `rebasing` while a conflict run is
queued or running on a pull request the loop reviewed (`conflict` is in `LOOP_STEPS`).

The dashboard follows the loop. Before `startFix()`, `settle()` appends each automatic review to its
pull request's `rounds` in the store's `reviews` (`recordRound()`):
`{ round, at, head, counts: { critical, high, medium, low }, blocking }`, `round` the fix runs
before it (0 for the first review), `blocking` the findings above the tolerance, counts only, never
the findings' text, with `fixRounds`, what `review.fix` allows. An entry from before has none, and
shows no loop. `reviewLoop()` derives where the loop is from that entry and the reason of the task's
run going or queued (`board.mjs`, the task's pull request from `pulls.mjs`, as the store's `reviews`
is keyed by the pull request): `reviewing` or `fixing` while a review or fix run is queued or
running, `checks` while the auto-merge is `waiting`, then `clean` (nothing blocking), `rounds-out`
(the review after the last fix run still blocks), `fixed` (`fix: true` without `merge`: by design
nothing reviews its one fix run, `unreviewedFix`) or `stopped` (it blocks, and no fix run follows).
The step on its way is kept as `next` from when it is queued (`nextAt`) until `settle()` or
`fixed()` decided what follows its run, GitHub calls included: while the task's last run is that
step's own (started after `nextAt`) and over, the loop is still there; an earlier run of the same
kind isn't, when the step queued since never ran (cancelled, refused). At start, after the runs
going and the queue are back, `forgetSteps()` drops the `next` of pull requests with no review or
fix run reattached or queued (`stepsGoing()`, a CI fix run's `next: "ci-fix"` too): an orchestrator
stopped while it decided never will. While `consider()` (from its settings read on), `settle()` or
`fixed()` decide (policies and GitHub calls), an in-memory mark says so too (`deciding()`, the
entry's `deciding`), so a pull request turning ready is in review before its review is queued. The
board takes the loop's step from the task's run going or its queued items, whichever is the loop's
(the work run that marked the pull request ready may still run), and a task with a maintainer's
comment queued beside the loop's step stays `queued`. The dashboard's ready notification is one per
`readyAt` and loop end. `api/state` sends it as the task's `review` ({ loop, round, rounds, history
}). Between the loop's runs (its next one queued, or the checks), the task's state is `in-review`
instead of `queued` or `done`; a running run keeps its own. The dashboard lists it as running, not
ready, until the loop ends: then a ready row whose loop ended blocking says what it left ("2 high
findings left after 3 fix rounds"), and the task's page lists each round's counts, marking those
whose blocking count didn't go down. The orchestrator's behaviour doesn't change: the loop still
runs all its rounds.
