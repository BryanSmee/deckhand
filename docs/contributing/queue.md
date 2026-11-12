# Around the runs

- **GitHub**: the operator's own App, created at `/setup` (private, or public across several
  organizations: `ALLOWED_REPOS` decides what it answers), its key in the github service alone
  ([the github service](each-service.md#the-github-service)), which makes the orchestrator's (and
  edge's) GitHub calls with installation tokens neither of them nor a sandbox gets. A sandbox holds
  a run token (`lib/tokens.mjs`): a JWT the broker service (`broker/`, #505) signs with Ed25519, the
  only one holding the key, which every service checks offline with its public keys (`broker.mjs` in
  the orchestrator), bound to the ID of the run's network (or pod), 15 minutes long and renewed by
  the sandbox every 5 with the broker service, through the egress proxy (`POST /run/token`,
  `deckhand-token --renew`, a file on a tmpfs rather than a variable); its `gh` and git hand it out
  as their token ([Run tokens](../security/tokens.md#run-tokens)); the egress proxy decrypts its calls to GitHub's hosts
  (with Deckhand's CA, which every run but research trusts) and relays them to the GitHub gateway
  (`github-gateway.mjs`, in the github service), naming the network (or pod) of the sandbox they
  came from, as the orchestrator's egress policy found it (`runner.locate()`, never its engine's),
  which the service believes from the proxy alone. The gateway finds the run by its token (bound to
  that network) or, without one, by that network; refuses finished, foreign, research and push calls
  and a review's reads of its thread; refuses a work run that isn't a fork's what would bring a
  fork's code (`github-forks.mjs`: a fork's repository, a fork's pull request's head, a commit that
  isn't the repository's, by git, the API, an archive, a page (any other of the repository's
  refused) or a file, Actions logs fetched from where GitHub redirects them (`ACTIONS_LOGS`, no
  credential sent there), GitHub's content hosts (`*.githubusercontent.com`) relayed too for such a
  run and sent on without a token; no branch it pushes reaching a fork's objects (the git gateway);
  its clone is whole, as a blob fetched by its id is refused to it); redacts every write's body
  (`redact()`, the run's tokens, and the operator's credentials by their fingerprints,
  `lib/fingerprints.mjs`) and notes it in the run's log; holds each REST write to its built-in
  checks and the policies' `allow_github` and `deny_github` (`github-writes.mjs`, its target's kind
  looked up with the service's token; Deckhand's defaults allow each mode its writes in
  `policy/mode-<mode>.rego`, and without policies every write is refused); parses and validates its
  GraphQL against GitHub's pinned schema and holds each mutation field to the same checks, its node
  IDs looked up likewise, forwarding the document printed again (`github-graphql.mjs`); and sends
  the call on with a token limited to the run's repo that only reads what its capabilities give
  (`readsOf()`; its own issue alone without `read:issues`), a write that passed getting one with
  only the write permission it needs besides (`github-writes.mjs` `writePermissions()`), streaming
  the answer back (`lib/upstream.mjs` `forward()`). The CA certifies GitHub for this
  (`proxy/authority.mjs` `EXCLUDED` keeps only the agents' providers): no sandbox's GitHub traffic
  carries a token any more, so a leaked CA key opens none. Those tokens only read the code: pushes
  go through the git gateway, the github service's too (the sandboxes push to its name,
  `http://github:8080`, which the proxy sends there), which only lets through the run's own
  branches, each then asked of the policies' `allow_push` and `deny_push` (`pushInput()`; Deckhand's
  default allows work runs'), and, for a repository granted `workflows`, workflow files that only
  read and name no secret (with `workflow_secrets` too, but those only the default branch's copy of
  runs), checked against a mirror of the repository in the github service's volume; `gh pr create`,
  `gh pr edit` and `gh pr ready [--undo]` are GraphQL writes like any other, which Deckhand's
  default policies allow to work runs for their own pull requests only: before them,
  `github-pulls.mjs` checks the pull request's head is one of the run's branches, its workflow files
  (for a repository granted `workflows`, as a push's) and its conflicts before ready, and the one
  call goes on with the token it needs (`pull_requests: write` to open or edit one,
  `contents: write` to ready or draft it), which no other call gets: no sandbox can approve or merge
  one. A run without `push` can't push or change a pull request.
- **Dashboard**: `GET /` shows every repo's issues and pull requests, their state and live logs, to
  `ALLOWED_USERS` signed in with GitHub through the App, built from `dashboard/`. Edge serves its
  files and signs users in; their API calls it passes on to the orchestrator, which answers them
  (`listener/http.mjs`), with the signed-in user. `GET /status` says what is going on, to them and
  to calls from inside edge's container. Both say which Deckhand runs and since when (`server` in
  `api/state`, `version` and `startedAt` in `/status`, from `status.mjs` `serverInfo()`): the
  Repositories page shows it, the version linked to its commit or release under `DECKHAND_SOURCE`.
  `GET api/server` says how it is set up (`status.mjs` `serverSetup()`), for Settings › Server: the
  container engine, the egress proxy and how many hosts the grants folder grants, whether that
  folder reads without errors (the files to fix, never their errors, which quote mount roots: a
  repo's config panel shows its own), which Claude credentials are set, which one runs use first and
  which ones `FALLBACKS` names (variable names only), `ALLOWED_USERS` and `ALLOWED_REPOS`. It scans
  the grants folder, so the page reads it when it opens rather than at each poll.
  `GET api/github-status` (#681, `server:read` too) says what GitHub itself reports, so that a
  problem at GitHub isn't taken for one in Deckhand: githubstatus.com's summary, which the github
  service reads every 5 minutes (`github/status.mjs`, its way out being GitHub's) and keeps in
  memory, never the browser: the indicator (`none`, `minor`, `major`, `critical`) and its
  description, the components Deckhand depends on that aren't operational (API Requests, Webhooks,
  Git Operations, Pull Requests, Issues, Actions), the open incidents with their pages, and when it
  was read. A failed read keeps the last one, with why (`failed`); it never touches the service's
  health. Off github.com (`GITHUB_URL` another), nothing is read. The Server page shows it beside
  the GitHub App, and a `major` or `critical` one on its status card too. `api/state`'s `access`
  says what the signed-in user may do (#732: `permissions.mjs` `dashboard()`): their server-wide
  actions, and on each repo they see, its actions and the modes they may start runs in, so that the
  dashboard shows only the controls the orchestrator wouldn't refuse (`dashboard/src/access.ts`).
  `GET api/access`, for Settings › Access and `server:read` only, says each of `ALLOWED_USERS`'s
  actions, server-wide and on each listed repo, with the files that decided them (`report()`), read
  when the page opens.
- **The services' health** (#560): `GET api/health` says whether each service is `up`,
  `starting` (started less than 5 minutes ago: a restart, an update) or `down` (no answer within
  2 s, a refused connection, a status other than 2xx, `ok: false`), with when it started, its
  version and, when down, why in a word (`timeout`, `refused`, `HTTP 503`): never its URL or
  what it answered beyond that. The orchestrator asks each service's `GET /health` it has a URL
  for (`EDGE_URL`'s internal port, `RUNNER_URL`, `BROKER_SERVICE_URL`, `GITHUB_SERVICE_URL`,
  `MODELS_SERVICE_URL`, `POLICY_SERVICE_URL`, `EGRESS_PROXY`), all at once, and keeps the
  answer 10 s, however many dashboards ask (`health.mjs`); it reports itself from its own start.
  Behind a Kubernetes Service, one ready copy answers: whether it can be reached, not each copy.
  Settings › Server shows it under the listener's status (`dashboard/src/Health.tsx`): [the
  services' diagram](services.md), each service in its state's colour (green, blue, red) and
  words ("up 3 d 4 h", "started 2 min ago", "unreachable: timeout"), with a legend; a list on a
  phone. The page reads it every 15 s while open, the shell every minute, for a dot by
  Deckhand's name (red when a service is down, else blue when one is starting) that opens the
  page.
- **Screenshots**: `GET /shots/<token>/<file>` (edge's, passed on to the broker, which
  keeps them, #609) serves the screenshots runs save for their
  pull requests: GitHub cannot take image uploads through its API, so they need a public URL.
  Sandboxes upload them through the broker ([Run files](restarts.md#run-files)).
- **Per-repo config**: each repo may bring a `.deckhand.yaml` on its default branch: its own
  trigger word, models, parallel cap and users (only narrowing the operator's), a setup
  command and extra instructions for the sandbox, a Dockerfile `FROM` the base image, cache
  volumes and a container engine for its work runs (the Dockerfile and the engine only with
  the operator's grant: an `allow_grant` rule of theirs, `grants.mjs` `GRANTS`). A config with
  errors stops runs, and the reply says why.
- **Isolation**: sandboxes run with no capabilities, `no-new-privileges` and CPU, memory and pids
  limits, each on an internal network of its own (created with the run, checked, and removed with
  it), shared only with the egress proxy (`proxy/proxy.mjs`), its only way out: the proxy asks the
  orchestrator's egress policy, for each connection, whether the sandbox at that address may reach
  that host. Sandboxes can't reach each other. Host mounts only happen under roots the operator
  grants the repo (`GRANTS_DIR`, one file per repo).
- **Container engine**: a run with the `docker` capability, of a repo granted `docker` (with
  `docker` in its config and the operator's `SANDBOX_ENGINE`) gets a second container on its
  network, `engine` (`runner/engine.mjs`: dockerd under Sysbox, or rootless Podman), started before
  the sandbox and removed with it; the sandbox's `docker` CLI talks to it (`DOCKER_HOST`), and its
  address counts as the sandbox's for the egress proxy. On Kubernetes (#573), Sysbox's dockerd is a
  sidecar in the sandbox's pod instead (`runner/kubernetes.mjs`, under
  `KUBERNETES_ENGINE_RUNTIME_CLASS`), which shares the sandbox's address: it reaches the proxy on
  its engines' port (3129), which the proxy tells the policy (`engine=1`). Never for a fork's pull
  request; Deckhand's default policies give it to work runs only.
- **Who may run**: only comments from `ALLOWED_USERS`, on repos where the App is installed
  (narrowed by `ALLOWED_REPOS` if set), are acted on: the sandbox runs without permission
  prompts and can push.

## Conflicts

What a conflict found does is a workflow's (`workflow-engine.mjs`, #1040): the repo's own on
`conflict` (`workflows.mjs`), else the built-in one, a single `run: rebase` step, which is the
rebase run described below. The `(head, base)` pair is the event's id; the engine keeps each pull
request's instance in the store's `workflows`, marks a step started before it acts, and goes on
after a rebase run's end (`conflicts.mjs` `ended()`, from `run-end.mjs`). An instance goes with
its pull request's `closed` delivery (`closed()`), or, when that delivery never came, when a
check reads the pull request closed or a pass finds it no longer its task's open one in
`pulls.mjs` (the engine's `sweep()`).

The `pull_request` webhook doesn't fire when a base branch moves, so `conflicts.mjs` polls, and
checks a repo soon (`soon()`) when its default branch moved: a pull request merged into it or a push
to it, or another branch made the default in the repository's settings (a `repository` `edited`
delivery with `changes.default_branch`) (`repos.mjs` `refreshFor()`, the deliveries that also
refresh the repository list), or Deckhand's own auto-merge, which no delivery precedes. After
`CONFLICT_MERGE_DELAY_MS` (30 s), while GitHub computes `mergeable` again, the repo is due whatever
its interval and a pass runs, after the one under way if any; every trigger during the wait shares
it. The opt-in, `ALLOWED_REPOS` and the `(head, base)` pairs apply as for a tick, and polling stays
the fallback for bases that move without a delivery. Every minute it takes the open pull requests
`pulls.mjs` knows as tasks', in the repos whose `.deckhand.yaml` sets `conflicts.check_minutes`
(never more often than `CONFLICT_CHECK_MINUTES`; `0` stops it), and asks GitHub whether each still
merges. One in conflict, whose task has no run going or queued and no needs-input label, gets a work
item as if from a comment (`trigger: "work"`, no comment, no sender, `reason: "conflict"`), queued
in its task's session through `tasks.accept()`. The `(head, base)` commits of each attempt are kept
in the store's `conflicts`, so the same pair never starts a second run, even after a restart. Before
the item is queued, the repo's policies are asked (`deny_fix`, `reason: "conflict"`, the review and
fix input of `review-merge.mjs` `readPullInput()`, through `policies.mjs` `denyKept()`, which keeps the
decision for the task's page). A refusal queues nothing and is kept as the pair's attempt: a "No
rebase run" comment quotes its messages, and once posted they are kept with it (`said`), so a later
pair refused for the same ones isn't said again (a base that keeps moving says it once). A refusal
because GitHub couldn't be read (`unread`: the policies or the input) keeps no pair, nor a decision
for the task's page (`keepUnread: false`): it is the repo's error for that pass, asked again at the
next check, as any GitHub error there. What each check read is also passed to `pulls.mjs`
(`sawMerge()`), so the dashboard's `pr.conflict` is current for those repos too. In every repo, it
also comes from the `pull_request` deliveries (mostly `mergeable: null`: GitHub computes it after
sending them), from the dashboard's Sync, which reads each open pull request itself
(`resync({ all })`: a listing has no `mergeable`), a few at a time once its answer is sent, and from
`pulls.mjs` `baseMoved()`: the same deliveries and auto-merge that call `soon()` read the repo's
open pull requests again after `CONFLICT_MERGE_DELAY_MS`, and once more later those GitHub hadn't
computed yet, since a base that moves changes it at the same head without a delivery. A read that
says nothing keeps the last value known.

The dashboard's Sync runs the same pass at once (`check()`), with every opted-in repo due
whatever its interval, and resets their next check as a tick does. During a tick, it waits for
it, then checks the repos the tick left (not due), so no repo is checked twice and none is
left out; another check meanwhile shares that. It resolves to the rebase runs it started, the
errors of the repos it couldn't check (Sync's `error`) and the pull requests GitHub hadn't
computed yet, which are left to the next tick (their repo is due at once) rather than
making Sync wait. The orchestrator's own sync at start doesn't run it: the first tick after a
restart checks every repo anyway, once the queue is restored.

## Waiting for other issues

`/after #77 #80` (on the trigger line or its own line, same repo only; `events.mjs`
`parseAfter()`) holds a trigger comment back until each of those is done: an issue closed as
completed (or before GitHub recorded reasons), a pull request merged. `waits.mjs` asks GitHub
for their state at once: all done, the comment runs now; one closed without being done (not
planned, a duplicate, a pull request closed unmerged) or missing, it is refused. Otherwise
the comment keeps its 👀, the reply says what it waits for, and the task's one wait (task key
→ the issues left and the comment, as `restart.mjs` saves it) goes to the store's `waits`.

An `issues` or `pull_request` `closed` delivery for an allowed repo (`closedItem()`) updates
the waits on it. Any other `issues`, `issue_comment` or `pull_request` delivery about an issue
or pull request waited for, or about the issue a pull request closes (`touchedItems()`), and
the end of a run on one, ask GitHub about that one only (`recheck()`, nothing when no wait is
for it): a pull request merged into the default branch closes its issue without an `issues`
delivery to an App that lacks that event, so its issue is asked about at once, and again 30
seconds later if GitHub hasn't closed it yet (`merged()`). GitHub is also asked about every
wait at each start and every `WAITS_CHECK_MINUTES` (5), so a delivery missed (edge down,
never redelivered) still counts. When the last one is done, `tasks.resume()`
checks the comment again as `admit()` would (the repo still allowed, its config without
errors, its author still in both allowlists) and queues it through `accept()`, as if just
posted, with its text, `/mode`, `/model` and `/effort`; the reply says which issue made it
start. One closed without being done drops the wait, with a reply saying so. A new trigger or
`/mode` comment without `/after` replaces the wait; `/after` again replaces the list;
`/after none` cancels it. The dashboard shows the task as `waiting`, with what it waits for.

The dashboard's graph does the same by drag and drop (`work.mjs`): on a repo's tab, its open
issues with nothing live (running, queued, waiting, brainstorming, needs input) are a backlog;
one dropped on the graph starts (in the mode picked), dropped next to an issue it waits for
that one; a waiting issue dragged away stops waiting, onto another issue waits for that one
instead. A backlog issue whose last run was cancelled, failed or interrupted keeps its node on
the graph, and once the backlog lists it, the node moves like its card there (`movable()` in
`graphModel.ts`): the same `start`, `queue` or `plan`, no route of its own. Between the backlog
and the graph, a Brainstorm column lists the repo's brainstorms (active, idle, wrapping up),
which leave the graph unless an arrow touches them: a backlog issue dropped there starts a
brainstorm, a brainstorm dropped on the graph starts work (and ends the brainstorm), dropped
back on the backlog it stops (`stop`, what a `/stop` comment does: the wrap-up run). Each has a
button too.

A backlog issue with open sub-issues (its card says how many, from the issue list's
`sub_issues_summary`) brings its whole tree along (`plan`, `plans.mjs`): the orchestrator reads its
sub-issues, all levels down, and each one's "blocked by" links, then holds or starts each issue
in the mode picked. A sub-issue with nothing open to wait for starts; the others wait for all
their blockers (open issues of the repo, in the tree or not; those of another repository are
left out, and the reply says so), and for what their parent is blocked by; a parent waits for
all its open sub-issues, and runs last, to finish the epic or close it. Dropped next to an
issue, the tree's first issues wait for that one. A blocker reached through another is left
out (#11 waits for #12, not for #12's own blockers too). Sub-issues closed as completed are
skipped. A parent "blocked by" its own sub-issues (an epic by its tasks) already waits for
them: those links are left out, and not passed down. One closed without being done, running or
queued, with open questions, a loop in the links (through the waits already there too), or a
tree over 30 open issues (`MAX_TREE`) refuses the whole drop before anything is posted. If
GitHub fails halfway through the comments, the reply says which issues are laid out and which
aren't. Each issue gets the App's comment ("Queued from the dashboard by @alice as part of
#10, after #12"), and a sub-issue unblocks the next once it is done, as for `/after`: its pull
request merged, so the next one builds on it.

The backlog is served from the last read and
read again in the background once it is 30 seconds old or an `issues` delivery made it stale
(only a repo with no read yet waits for GitHub), and the dashboard keeps each repo's last one
in memory, so coming back to the graph or a repo's tab shows it at once. The orchestrator writes
each action on the issue as the App's comment, which reactions follow like a trigger
comment's, and queues the work (`accept()`) or holds it (`waits.hold()`) itself: the App's
own comments never reach `admit()`. The checks are `resume()`'s, see
[The dashboard's actions](../security/webhooks-and-sign-in.md#the-dashboards-actions).

The Overview's repository cards get each configured repo's backlog count from the same reads
(`GET /api/repos?backlog=1`, `work.mjs counts()`): the last read's at once, read again in the
background once it is 5 minutes old (`COUNT_MS`), so listing never waits for GitHub. `more`
says the read was one full page (100 issues and pull requests), when the count may be short.
The other pages poll the list without `backlog` and cost no read.

## Stopping a run

`/cancel` (the whole first line of a comment, from an allowed user) or the task page's **Stop**
(`POST /api/repos/<owner>/<repo>/work { action: "cancel", number, pr? }`, with the work area's
checks of the repository and user, and the App's comment "Stopped from the dashboard by @user") end
a run now. `admit()` takes the comment before the queue, so it never reaches the agent's inbox, and
gives it 👍. `run-end.mjs` `cancel()` writes a `cancelled` line (who, when) to the run's log and its
saved state, stops its inbox, then `runner.kill()` (`docker stop -t 10`). The follow loop sees the
sandbox exit and `finish()` ends the run as `cancelled` whatever the exit looked like: a "Stopped by
@user" reply with the usual footer (a run that had `answered` posts that answer, then "Stopped by
@user after its answer"), no fallback, 👀 off its comments, and `cleanUp()` as usual. The session
volume and pushed commits stay, so the next trigger resumes it. `cancel()` marks the task stopped
(`stopped.mjs`, the store's `stopped` map: who, when; #1003) before the sandbox goes: until
something asks for a run (`asksForRun()`: a person's trigger or `/mode` line, any dashboard or
MCP action), `modeOf()` skips a comment without a trigger line, `conflicts.mjs` `checkPull()`
skips the pull request (its attempt not kept) and the review loop starts no fix or CI fix run
(the step says why). Comments queued for a follow-up run don't start one: the stopped run's
`teardown()` moves them to the task's `onHold` (`tasks.mjs` `holdStopped()`), saved with the
queue, and the next trigger's `queue()` lifts the mark and queues them first, in its run. A
trigger that came before the run ended lifted it already: nothing is held. A close ends it
(#1009): the `closed` delivery (an issue closed, a pull request merged, which also ends the stop
of the issue it names, whether GitHub closes that issue or not) drops the mark and settles the
held comments, their 👀 off (`tasks.mjs` `forgetStopped()`), and an hourly `forgetClosedStops()`
does the same for tasks closed as `titles.mjs` last heard of them: a close while the stopped run
was ending, or while no copy was listening. Not `pulls.mjs`, whose merged pull request outlives a
reopen of its issue, and not at start, as for a machine's route. A task stopped before the mark
existed has none, as before. A run still being prepared (its image building) doesn't start its sandbox; a task with
only queued comments loses them instead (409 from the API when there is neither). A copy of the
orchestrator restarting between the cancel and the exit reads it from the saved state, stops the
sandbox again if it still runs, and ends it as cancelled rather than queueing its comments again;
the dashboard's list reads it from the log's `cancelled` line. A cancelled run is `rerunnable`.
