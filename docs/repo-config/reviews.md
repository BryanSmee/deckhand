# Per-repo config: reviews

Part of the [`.deckhand.yaml` reference](../repo-config.md): Deckhand's reviews of pull
requests (`review`), the reviewers it asks, CI before the review, and auto-merge.

### Reviews

The built-in review reads a pull request and posts **one GitHub review**, in three sections,
then a rating out of 10 and a verdict. It never pushes, edits code or creates issues: its
token only reads, and Deckhand posts the review.

- **Must fix**: what is wrong in this pull request (an acceptance criterion not met, a claim
  the code contradicts, a security hole, a bug the change introduces, a missing test for a
  decision it makes), grouped by severity (`critical`, `high`, `medium`, `low`), each with its
  file and line and a suggested fix. These are the findings: they block, cap the rating, and
  go to the fix run, as below.
- **Follow-ups**: real problems that aren't this pull request's to fix: a bug in code it
  didn't change, duplication with code it didn't touch, a refactor or an improvement beyond
  the issue. Each has a title and a short description. They **never block**, never cap the
  rating, and the fix run leaves them alone. **Once the pull request is merged**, Deckhand
  files each one as an issue labelled `follow-up` (the label is created if the repository
  doesn't have it), whose body links the pull request ("Follow-up of #5") and the review it
  came from, then lists them in one comment on the pull request. The same title in several
  reviews of the pull request is filed once, and one an issue labelled `follow-up` already has
  is linked instead; each merge files its follow-ups once, across redeliveries and restarts
  (the orchestrator's store, `reviews`), from its reviews and from those GitHub refused, posted as plain
  comments (only the comments Deckhand posted them as, recorded in the orchestrator's store, `reviews`).
  A pull request closed without a merge files none, and a merge files at most 10 (the rest
  listed by title in the comment). The issue's body says the text is a review model's
  output, to check against the code, and quotes it. The review is told not to list again a
  follow-up an earlier review of Deckhand's listed. **`follow_ups: false`** turns the filing
  off (the review's prompt, its Follow-ups section and the fix run's message say they are left
  to the maintainer): the repository's config is read again from the default branch at the merge, and a
  `review` block that is gone, or a config with errors, files nothing either.
  **`follow_ups_auto_pickup: true`** labels the issues it files for auto-pickup too, for
  whoever merged the pull request (see [Auto-pickup](issues.md#auto-pickup)).
- **Comments**: remarks that aren't defects (a naming choice, a question, a suggestion, a
  nit), each marked **blocking** or **note**. A note never blocks nor caps the rating; the fix
  run applies it only when it is cheap and in scope, and a note alone never starts one. Nits
  are notes, not low findings. A blocking comment blocks like a finding, **whatever
  `max_allowed_severity` says** (the reviewer marked it on purpose), caps the rating at 8, and
  goes to the fix run.

<!-- onboarding: skip: How Deckhand reads a review's reply (its markdown, its `json deckhand-review` block) is in docs/repo-config/reviews.md in Deckhand's source. -->

How a review's items are read. A comment's kind is read in bold, italics, backticks, brackets or
parentheses, or bare before a separator (`blocking: …`). A blocking comment put under Must fix
blocks as one under Comments does, and a note there is posted under Comments and keeps the review's
own verdict. A comment whose kind can't be read is posted as **unclear**, and so is an item under
Must fix that is no finding: when the review's own verdict asks for changes, it blocks as a blocking
comment does (it may be why), and the fix run is told to treat it as blocking; with the review's
"comment", it is posted as a note and doesn't block, nor does the fix run treat it as blocking. A
deeper heading stays in its section (`### 🟠 High (1)` under Must fix, as Deckhand posts them); any
other heading after the review's own (`## Checks`, `## Blocking comments`) ends it. Under it, a
finding or a comment still reads as one (a blocking one blocks), nothing is a follow-up, and
anything else is no item but keeps the review's own "request changes". A review's verdict reads
"comment" on follow-ups and notes alone only when its Must fix section says `None.` and everything
under Must fix and Comments could be read. Only a bullet with its title in bold is a follow-up, and
not one that says there is none: `None.`, `- No follow-ups.` or `- **None found**` files nothing. An
item under the wrong heading is never filed, but posted under Comments: a blocking comment there (`-
**blocking** …`, in any form Comments reads) blocks as one under Comments does; a note stays a note
and keeps the review's own verdict; a finding (`- high: …`) there, and any other bullet without a
bold title, is posted as **unclear** (above).

A reply in the format from before the sections (a `## Findings` list, as a repository's own
`review.instructions` may still ask for) reads as must-fix findings, and so do the reviews
Deckhand posted before them, when the dashboard's Fix reads one back.

The review also ends its reply with the same review as JSON, in a `json deckhand-review`
fenced block: its findings (`severity`, `path`, `line`, `text`), follow-ups (`title`, …) and
comments (`blocking: true|false`, …) as typed fields, with its `rating` and `verdict`.
Deckhand reads the review from that block first, so none of the markdown rules above has to
guess, and the markdown is only what people read (Deckhand posts the review from the block's
items, in the sections above). A reply without the block (a repository's own prompt, a session
from before it) is read from its markdown as above. A block that doesn't validate (not JSON, an
unknown severity, a missing field, a path without its line) is logged, and the markdown read
instead, with the review's own "request changes" (the block's or the markdown's) kept whatever
the rest says. So is a block that says less than its markdown: one that blocks less or doesn't
request changes where the markdown does, rates the pull request higher, has fewer findings at
any severity and above, fewer blocking comments or fewer follow-ups, or has nothing as severe
at the place of one of the markdown's findings or blocking comments. Where both ask for
changes, the block decides whether that verdict reads "comment" (on tolerated findings, or on
follow-ups and notes alone), however unsure the markdown read alone would be.

<!-- onboarding: end -->

- **Claims and acceptance criteria first.** Before security, the review lists the
  acceptance criteria of the issue the pull request closes (and the decisions settled in
  its thread) and the claims of the pull request's description (what it changes, adds or
  tests, the checks it ran), and checks each against the code. A criterion not met, or met
  only in part, and a claim the code contradicts are **high** findings; a claim it can't
  verify (a check it can't run) is said in the summary, not filed as a finding.
- **A plausibility bar for findings.** Each Must fix finding names the concrete, plausible
  situation that triggers it, in how the repository is used and deployed. An edge case that
  needs contrived conditions (several unlikely events at once, a trusted party acting against
  itself, a value no caller produces) is a note under Comments, with its trigger, or left out,
  and so are hardening and theoretical cases: they never block. Security keeps its bar: input
  an untrusted party controls (a webhook, a pull request's diff, a fork, a sandbox) is
  plausible by definition. Severities weigh the trigger's likelihood as well as its impact
  (medium is an edge case a user or operator can plausibly hit; low a real defect with a
  plausible trigger and a small cost); unsure between two, the review picks the higher one for
  security and data loss, otherwise the one the likelihood supports. A repository's
  `review.instructions` can tighten or loosen the bar (say, "report every edge case" for a
  library whose callers are anyone).
- **The rating follows the findings**: at most 3/10 with a critical finding, 5 with a high
  one, 8 with a medium one or a blocking comment; 10 only with no finding above low. Deckhand caps the rating
  it posts by these numbers, whatever the review wrote; below the cap, it is shown as
  written.

- **Off by default.** Without a `review` block nothing reviews a pull request, and `/mode
review` gets the "unknown mode" reply. `review: true` (or a block without `on`, or
  `on: manual`) turns on `/mode review` alone.
- **By itself** with `on: ready`: when a pull request is marked ready for review, or opened as
  ready, if it is on a branch of the repository (never a fork's) and was opened by Deckhand
  or by an allowed user (`users`). Other bots' (Dependabot's, say) are skipped by Deckhand's
  default [`review.rego`](policies.md#the-default-policies), which the operator's `policy/review.rego`
  in the grants folder replaces. Each head commit is reviewed by
  itself once, across redeliveries and restarts: to review it again after new pushes,
  comment `/mode review`. A [policy](policies.md#policies) can skip it (`deny_review`).
- **`/mode review`** on a pull request, from an allowed user, reviews it now; what the comment
  adds is what the review should look at. On an issue it is refused, with a reply.
- **The verdict on GitHub**: changes requested when there is a critical, high or medium
  finding or a blocking comment, a comment otherwise (follow-ups and notes alone included,
  whose "request changes" verdict, should the review write one, reads "comment" when its Must
  fix section says `None.` and everything under it and Comments could be read, as under
  Comments above); the verdict in the review's text says "request changes" then
  too, whatever the review wrote. It never approves: that stays the maintainer's. GitHub
  doesn't let the App request changes on its own pull requests: those get a comment review, the
  verdict in its text. A reply whose format Deckhand can't read is posted as a comment
  review, as it is. An automatic review in the fix loop, or the one that decides an
  auto-merge, may tolerate medium findings (`max_allowed_severity`, under Auto-merge): its
  prompt says so before it starts.
- **No loops**: without `fix`, the review starts no run. To act on it, comment with the trigger
  ("Deckhand, fix the high findings").
- **`fix: true`**: a review that requests changes (a critical, high or medium finding, above
  `max_allowed_severity`, or a blocking comment) on Deckhand's own pull request, linked to the
  issue it worked on, starts a work run in that issue's session. Its message is the review's
  findings, all of them (medium and low too), and its comments, with the instruction to fix
  each finding and blocking comment or say why not, to apply a note only when it is cheap and
  in scope, rerun the checks and push; the follow-ups are only counted there, as Deckhand files
  them after the merge; it pushes like any work run, and replies on the pull request. A finding
  it can't fix because the change the issue needs is one only you can make (a file it may not
  edit, a write Deckhand refuses) is a question instead: its reply asks, and the loop stops at
  the needs-input label. A change only a finding asks for is never asked: it is left, and said
  why. Not while the issue
  has a run going or queued (a maintainer's comment came first) or the pull request or its
  issue has the needs-input label. With `merge`, once it is over, Deckhand reviews the
  commit it pushed (a review that starts by itself, so `deny_review` applies), which decides
  the merge; without `merge`, `fix: true` stops there, as one fix run leaves nothing for
  another review to start.
- **`fix: <n>`**: the same, as a loop of up to `n` fix runs (1 to the operator's
  `MAX_FIX_ROUNDS`, 5 by default; `true` is 1). Round 1 is review, fix, review; each later
  round is fix, review, the fix run told which round it is and, from the second on, that the
  earlier fix didn't clear the findings. Each fix run's push is reviewed, with or without
  `merge`. The loop stops when:
  - **the threshold is met**: the last review has no finding above `max_allowed_severity`
    (`low`, the default: no critical, high or medium finding; `medium`: no critical or high
    one) and no blocking comment. That review is posted as a comment and starts no fix run;
  - **the rounds run out**: after `n` fix runs, the last review still has findings above it
    or a blocking comment. A "No more fix runs" comment names their severities (and the
    blocking comments) and the number of fix runs (with `merge`, the "Not merged
    automatically" comment says it instead);
  - **a fix ends badly**: it failed or pushed nothing (its push isn't reviewed), or a
    [policy](policies.md#policies) refused the fix (`deny_fix`, a comment says why) or the review after
    it (`deny_review`);
  - **something else takes over**: the issue has a run going or queued, or the needs-input
    label.

  A [rebase run](issues.md#conflicts)'s push is reviewed too, using no round.

  **Bounded**: `n` fix runs and `n` reviews after them at most per pull request (`fix: true`
  without `merge`: one fix run, no review after it), each counted
  in the orchestrator's store (`reviews`) before it is queued, across restarts: the fix's push doesn't start a
  review by itself (only turning ready does, and Deckhand's review of it), and a later
  review (`/mode review`) starts no fix past the count. Other pull requests' reviews, and
  reviews that only comment, start nothing. To act again, comment with the trigger, or use
  the dashboard's buttons (below). A `/mode review` a maintainer asks for isn't part of the
  loop: it tolerates nothing, and may start a fix run while rounds are left.

- **From the dashboard**: once a pull request's loop is over (rounds out, stopped, fixed, CI
  failed, or clean), its task page offers, in its Review loop section:
  - **Review** (Shift R): a review of its head now, even a head already reviewed. It is the
    dashboard's `/mode review`: the App comments "Review from the dashboard by @you" on the
    pull request, then the review runs as that comment's would.
  - **Fix** (Shift F), with `fix` on, on a pull request ready for review, when the last review
    left findings above `max_allowed_severity`: one fix run on the findings of the App's
    latest review on the pull request, read back from GitHub, with the loop's message. A round
    left (a fix that failed or pushed nothing) is used; with the rounds used up, each click
    grants one round more, never a new loop. The App comments "Fix round 4 from the dashboard
    by @you: 2 high findings left" (edited to say so if it is refused after that), and the
    fix's push is reviewed like any round's, even with `fix: true` and no `merge`; with
    `merge`, that review decides the auto-merge again. The round is counted in the orchestrator's store (`reviews`)
    before the run is queued: a second click or a restart starts no second one. Only on
    Deckhand's own open pull request linked to its issue, with nothing running or queued, no
    needs-input label, the loop not going on (no review, CI or checks awaited), and GitHub's
    latest review the loop's last; `deny_fix` applies, its refusal shown on the dashboard.

  A review a maintainer asks for (`/mode review`, or Review) is listed in the pull request's
  history as the latest round, its blocking findings counted with the loop's own tolerance
  (`max_allowed_severity` with `fix` or auto-merge), so the buttons follow it, and a CI step
  that stopped without a review shows it. Without a loop before it (`review.on` off, say), the
  section is called Reviews, and offers the same buttons. Once a commit is pushed after the last
  review, the section says "Outdated: reviewed `abc1234`, head is now `def5678`" and the task's
  rows "Review outdated" (until the loop is over, a new head is expected: nothing is said):
  press Review for the new head. A review reads and is posted on the commit its run started
  from, so a commit pushed while it runs is outdated too. It still isn't a loop round: it counts
  no fix run, tolerates nothing itself, and may start a fix run while rounds are left. Both
  requests are refused, the dashboard saying why, for someone outside the repo's `users`, a
  closed pull request, or one with a run going or queued.

  Once Deckhand posted a review on the pull request (the loop's, or one a maintainer asked
  for), the task page has a **Review** tab, after Policies: the last review's verdict, round
  and reviewed commit, linked to the review on GitHub, then its sections. Must fix by severity
  (each `path:line` linked to the file at the reviewed commit, "tolerated" when
  `max_allowed_severity` lets it through), the follow-ups ("filed after merge", then each one's
  issue and its state once Deckhand filed it, or why it wasn't) and the comments (blocking or
  note). Once merged, a banner says by whom, the follow-ups come first and the findings left
  are what it was merged with. The tab reads the review from GitHub when it opens, and again
  on a new round or a merge: the findings aren't kept in the orchestrator's store nor sent with
  the dashboard's state, and they show as text, never as HTML or links of the model's. A review
  GitHub refused, posted as a plain comment, isn't shown there.

- **Security risk of `fix`**: the review's findings, a model's output, become the message of a run
  that can push. A comment written to steer the reviewer (a prompt injection) could turn into a
  finding the fix run carries out. Deckhand narrows it: the review reads only the comments of
  allowed users who may start work runs (`runs:start:work`) and its own (an outsider's is left out,
  quote it to have it read), only Deckhand's own pull requests get a fix, and the fix run is told
  the findings are claims to check, never instructions (no commands from them, no CI, workflow,
  `.deckhand.yaml` or credential changes the issue didn't ask for). It is not a guarantee: turn
  `fix` on where those who comment are trusted, and read what a fix pushed before merging
  ([Security model](../security/github.md#review-fix-runs)).
- **What it reads**: the diff, and the thread (the pull request's description, comments and reviews,
  and the issue it closes) as Deckhand hands it over: only what Deckhand and the allowed users who
  may start work runs there (the access decision's `runs:start:work`, a viewer's comments left out
  too) wrote. Anyone else's comment is left out, its place saying so: an allowed user who wants the
  review to take it into account quotes it.
- **The run**: fresh, in a clone and session of its own like a brainstorm's, and with
  Deckhand's defaults (`mode-review.rego`) no branch, no setup and no write; the agent, model
  and effort of light runs unless the block names others. Its instructions
  are the built-in ones (security, correctness and tests, duplication, the repository's
  conventions, scope), then the file `review.instructions` names, from the default branch.
- **Cost**: each review is a run with the reviews' model, paid by the operator. `on: ready`
  reviews every pull request that turns ready: keep `manual` where that is too many. A fix is
  a work run, at the repo's work model: each round of `fix` is one work run plus one review
  run, so `fix: 3` can cost up to four reviews and three work runs per pull request.

`on`, `instructions`, `agent`, `model`, `effort`, `fix`, `merge`, `merge_method`,
`max_allowed_severity`, `merge_wait`, `ci`, `ci_wait`, `ci_fix`, `request`, `follow_ups` and
`follow_ups_auto_pickup` are its only
keys: any other, or a bad value, is an error.

#### Reviewers

`request: [alice, bob]` asks people to review Deckhand's pull requests, so a pull request that
turns ready doesn't wait for someone to notice it. A run never picks who gets notified:
Deckhand requests them itself, with its own token (runs still can't use `gh pr create
--reviewer` or `gh pr edit --add-reviewer`).

- **Who**: the logins listed, lower-cased, a leading `@` dropped, only those in the operator's
  `ALLOWED_USERS` (the others are ignored, with a warning in the config check). Never a team
  (`org/team` is an error), never the pull request's author.
- **When**: Deckhand's own pull request (opened by the App, on a branch of the repository)
  turns ready (marked ready, or opened as ready), and again when a run that pushed to it
  ends well while it is ready (a fix run, a CI fix run, a conflict rebase, a follow-up a
  maintainer asked for): what they reviewed changed. A run that pushed nothing, failed, was
  stopped or stopped to ask (its `WIP:` commit is unfinished work) asks nobody. Each head commit
  is decided once, across redeliveries and restarts (in the orchestrator's store): requested, refused by
  a rule, or refused by GitHub (`422`). A failure (GitHub's `5xx`, a `policy error`) is asked
  again at the next delivery or run's end.
- **Independent of the review**: it works with `review: { request: […] }` alone (which also
  turns on `/mode review`), with or without `on: ready`, `fix` or `merge`.
- **A [policy](policies.md#policies) can refuse it** (`deny_request_review`), keyed on the mode of the
  run that opened the pull request (a later follow-up in another mode doesn't change it).
  [Deckhand's default](policies.md#the-default-policies) requests them on
  work runs' pull requests, and on those of the repository's own modes it allows
  (`allow_request_review`).
- **GitHub decides the rest**: a login that isn't a collaborator makes GitHub refuse the
  request (Deckhand's log says so); requesting someone who already reviewed asks them
  again, which is the point after a fix.

Requesting a review notifies people: keep the list to those who want every one of Deckhand's
pull requests.

#### CI before the review

With `ci: wait` (and `on: ready`), an automatic review waits for the repository's CI first: a
failing CI then costs a cheap CI fix run instead of a full review that misses the failure.
Deckhand decides each step itself, without a model call, from the GitHub Actions runs on the
pull request's head commit (other checks and commit statuses aren't read, as for auto-merge):

- **Waiting**: when a review would start (the pull request turned ready, or a fix run pushed),
  nothing is queued while runs are going. Deckhand decides again when a run completes on
  that commit (a `workflow_run` delivery), and every 5 minutes for a lost one; the wait
  survives a restart. A push while it waits moves the wait to the new head commit: runs
  completing on the old one decide nothing. Without any run yet, it waits a minute (GitHub
  creates a push's runs a moment after it), asks again then, and takes the commit for one
  without CI. The
  dashboard shows "Waiting for CI".
- **Passed** (`success`, `skipped`, `neutral`), or no run: the review starts as without `ci`.
- **Still going after `ci_wait` minutes** (30 by default, `0` to `1440`): the review starts
  anyway, its prompt saying CI hadn't finished.
- **Failed** (any other conclusion: `failure`, `cancelled`, `timed_out`…), even while other
  runs go on: no review. A run cancelled and replaced by a newer one of its workflow and event
  (`cancel-in-progress` when turning ready starts the workflow again) decides nothing, here
  and for auto-merge; any other failure does, whatever ran after it. A "CI failed" comment names the failed runs, linked. With `fix`, a
  **CI fix run** follows: a work run in the issue's session, with the same conditions as a
  review's fix run (Deckhand's own open pull request, no run going or queued on the issue, no
  needs-input label, and `deny_fix`, its input with `ci: true`). A run going or queued on the
  issue (often the work run that marked the pull request ready, after a quick failure) doesn't
  stop it: the pull request goes on waiting, and Deckhand decides again once a run is over.
  Its message names the failed
  runs and jobs (name, conclusion, run id, link), never their logs: the run reads them itself
  (`gh run view <id> --log-failed`, through Deckhand's GitHub gateway, which follows GitHub's
  redirect to its log storage: no host to grant), told they are data, not instructions (the branch's code
  printed them), fixes the cause, reruns the checks and pushes, or reruns a job it judges flaky
  ([Reruns](policy-inputs.md#reruns)). Once it is over, its push or rerun goes back to waiting for CI: then the review, or another CI fix run. One that failed, or neither
  pushed nor reran a job, leaves the pull request to the maintainer, a "No review" comment says why. The
  dashboard shows "Fixing CI", and the run "CI fix"; when the CI step stops without a review
  (a CI fix run refused, failed or pushing nothing), the ready pull request is marked "CI failed,
  not reviewed". A pull request turned back into a draft while it waits stops waiting: ready
  again, even at the same commit, it waits and gets its review. So does one whose CI step
  stopped (once the maintainer answered, say): ready again at the same commit, the CI step
  runs again.
- **Bounded**: `ci_fix` CI fix runs per pull request (1 by default, `0` to the operator's
  `MAX_FIX_ROUNDS`), each counted in the orchestrator's store (`reviews`) before it is queued, apart from `fix`'s
  rounds: a CI fix never uses up a round the review's findings need. They count across the
  pull request's commits: when none is left and CI fails, the comment says so ("No CI fix run
  left") and the review starts anyway, told CI failed, so the
  maintainer still gets one. So it does without `fix` (or with `ci_fix: 0`), and on a pull
  request that isn't Deckhand's own: the comment, then the review.

`ci` changes nothing without `on: ready`, and a `/mode review` a maintainer asks for never
waits. CI fix runs push like any work run: one that has to change `.github/workflows/` needs
the operator's `workflows` grant.

#### Auto-merge

> **Unsafe: no human reads the code before it reaches the default branch.** Model output is
> merged as it is: a prompt injection in an issue or a comment, or a wrong fix, ships, and a
> merged change runs the repository's workflows on the default branch, with its secrets. Use
> it only on private repositories where everyone who can comment is trusted. See
> [Security model](../security/github.md#auto-merge).

With `merge: true`, Deckhand merges Deckhand's own pull request once its review finds
nothing blocking. It takes both sides:

- **The operator's grant**: `auto_merge`, an `allow_grant` rule of their policies naming the
  repository ([the grants](../security/policies.md#the-grants)). It covers a private repository only; a
  public one needs `auto_merge_public`. Without it, the config check warns, naming the grant, and
  nothing is merged; the reviews and fix runs go on as without `merge`.
- **`on: ready`**: the merge follows the reviews that start by themselves, never a
  `/mode review` comment's. Without it, the config check warns and nothing is merged.

**The flow**, all in Deckhand (never in a sandbox, whose token can't merge):

1. The pull request turns ready, and the review runs as usual.
2. Nothing blocking (no critical, high or medium finding, medium allowed with
   `max_allowed_severity`, below, and no blocking comment): the merge, after the gates below.
   Its follow-ups are filed as issues once it is merged, as after any merge (see Reviews).
3. Blocking findings, with `fix`: the fix loop runs as usual (see Reviews). The review that
   ends it decides the merge (without `fix`, the first review decides it): it merges only
   with nothing blocking, as in step 2.
4. **A review that requests changes never merges**: posted on GitHub as "request changes", or
   whose verdict says "request changes" (the review may ask for it with only low findings), it
   leaves the pull request to the maintainer with a "Not merged automatically" comment.
5. Anything else leaves the pull request to the maintainer, with a comment saying why: a review
   that still blocks, a fix run that failed or pushed nothing, a gate that refuses, a GitHub
   call that fails, a merge GitHub refuses. **Bounded**: at most `fix`'s number of fix runs
   and a review after each, and one merge decision per pull request, kept in the orchestrator's store (`reviews`)
   across restarts.

**`max_allowed_severity: medium`** lets every automatic review in the fix loop, and the one
that decides the merge, have medium findings: its prompt tells it so (medium findings still
reported, and still capping the rating at 8, but its verdict "comment" and its summary saying
they don't block), the review is posted as a comment rather than "request changes" (a
"request changes" verdict on medium findings only reads "comment" too, should the review
write one anyway), starts no fix run, and merges, the medium findings left as its comments
for the maintainer. So with `fix` too, a review with only medium (and low) findings spends no
fix run on them: the loop stops there. Without `merge`, it is the fix loop's threshold alone.
Critical and high findings always block, and so do blocking comments; a "request changes"
verdict with only low findings still does. `low`, the default: any medium finding blocks.
Follow-ups and notes never block a merge.

**The gates**, asked of GitHub right before the merge; each refusal is a comment:

- the pull request is Deckhand's own, on a branch of the repository (not a fork's), linked to
  its issue; it is open, not a draft, and neither it nor its issue has the needs-input label;
  its issue has no run going or queued;
- its head is still the commit the review read;
- the repository is private, or the grant is `auto_merge_public`, as GitHub says at that moment;
- it changes none of the files Deckhand trusts: `.deckhand.yaml`, `.deckhand/`, `.github/`
  (in any case: a workflow there may use secrets with `workflow_secrets`), any `CODEOWNERS`, and the files the config names (`instructions`, `dockerfile`,
  `review.instructions`, the modes' instructions),
  renames included. Merging those by itself would let a run widen its own config: such a
  pull request always waits for a human. GitHub lists 3000 changed files at most: a pull
  request with more than it lists is refused;
- `mergeable_state` is `clean`, and its GitHub Actions runs on the head commit are finished
  with none failed (read with the App's `actions: read`; no new permission). A failed run
  refuses at once, naming it; `dirty` (a conflict) or `behind` too. `unstable` with every
  Actions run passed means a check or commit status that isn't an Actions run (an external
  CI, a bot's status) is pending or failing: the App can't read those, so that refuses too,
  saying so;
- its branch isn't behind its base (`GET /compare`), even without branch protection: its
  checks didn't run with the base's latest commits. Refused at once;
- last, the operator's and the repository's [policies](policies.md#policies) (`deny_merge`): any message
  refuses the merge, and the comment quotes it.

**Checks still running.** The review's push (or the fix run's) starts CI at the same time as
the review, so CI longer than the review is still going when it ends. When Actions runs still
going are all that stands in the way (`mergeable_state` `clean`, `unstable`, `blocked` or
still `unknown`), nothing is posted: the pull request waits, in the orchestrator's store, `reviews` (across
restarts), and the gates are asked again each time an Actions run completes on the reviewed
commit (the App's `workflow_run` deliveries), and every 5 minutes for a lost delivery. They
merge it once every run passed and it is `clean`, or refuse it as above. After `merge_wait`
minutes (60 by default) with runs still going, it is refused once: "its checks didn't finish
in time". `merge_wait: 0` refuses at once, as before. A push after the review still refuses
it, and it is still one decision per pull request.

The merge is `PUT /pulls/{n}/merge` with the reviewed commit as `sha`, so a push after the
review makes GitHub refuse it. A comment then says Deckhand merged it, and why; the dashboard
shows "Merged by Deckhand" on its task and in the graph, a red "Auto-merge: no human review"
badge on the repository, and a red box at the top of its config panel. Deckhand logs a
warning at start for each of its policy files that grants auto-merge. The issue is closed by the
pull request's `Closes #n`, as for any merge.
