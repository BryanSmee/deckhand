# The GitHub and git gateways

What a run may read and write on GitHub, and push: the default branch, the gateways that add a token to its calls, and the runs that fix reviews and CI. Part of the [Security overview](../security.md).

## The default branch

Deckhand trusts a repository's default branch: its `.deckhand.yaml`, its sandbox
instructions. What that file can ask for beyond a sandbox (mounts, the Dockerfile built on
the host) only happens when your
grants folder allows it for that repository (see [The grants folder](policies.md#the-grants-folder)): with
the App on many repositories, whoever can push one's default branch must not get root on the
host through it. A sandbox that could write to a default branch could still change what
that file asks for, so none can:

- Sandbox tokens (what the [GitHub gateway](#the-github-gateway) adds to a sandbox's calls:
  no sandbox holds one) only **read** the code (`contents: read`). They can't push, write files
  through the API or merge a pull request, whatever the repo's settings.
- Pushes go through the **git gateway** (`listener/git-gateway.mjs`, in the
  [github service](services.md#the-github-service)): the sandbox's git sends them to the broker's address
  (`url.<broker>/git/.pushInsteadOf`), with the run token, and the egress proxy sends them on to
  the github service. The gateway reads the ref updates at the start of the push (at most
  64 KiB of them, within 30 seconds; a refused push's pack is read and dropped for a minute
  at most, so git shows the refusal) and
  forwards it to GitHub with a token of its own only when every one is one of **the run's
  own branches**, and never the default one, looked up from GitHub on each push
  (case-insensitively). A run's branches are set when it starts:
  - a work run on an issue: `issue-<n>-*`, the branch the sandbox opens for issue `n` (named
    from its title, so a glob rather than a fixed name: the title may change);
  - a work run on a pull request, or a comment on an issue's pull request: that pull
    request's head branch, read from GitHub when the run starts, a maintainer's included
    (they asked for the run); none when it is a fork's;
  - a run without the `push` [capability](policies.md#capabilities) (with Deckhand's default policies:
    brainstorms, onboarding, inbox entries, discussions, run analyses, reviews, research):
    none. The broker registers every one as a run that can't push, so the gateway refuses
    it whatever its token, and the same holds for a run a restarted orchestrator picks up again.

  Anything else is refused, whether an update, a force-push or a delete: another issue's
  branch (which that issue's next run checks out), another pull request's (which its author
  may merge without reading it again, or whose Dockerfile a repo with
  the `branch_docker_images` grant would build on the host), long-lived branches such as
  `gh-pages` or `release/*`, tags, signed and compressed pushes. The refusal shows in git's
  output as `[remote rejected] … (Deckhand: …)`.

  Past these checks, each branch a push updates is a `push` decision of the
  [policies](policies.md#policies) (`allow_push`, `deny_push`: [the push input](../repo-config/policy-inputs.md#the-push-input)):
  one refused refuses the whole push. Deckhand's default, `policy/mode-work.rego`, allows work
  runs' pushes and those of a repository's own modes (which need the repository's `allow_push`
  too); without policies, every push is refused. A policy can only
  narrow the checks above: no rule reaches another task's branch or the default one.

- **One branch is created outside the git gateway**: a work run's own, by the orchestrator, as
  the run starts, so its issue's Development sidebar links it (`listener/linked-branch.mjs`,
  GitHub's `createLinkedBranch`, which creates the branch it links: GitHub links no existing
  one). It carries no code the gateway didn't check: the orchestrator creates it at the base
  branch's head, read from GitHub, with the github service's token, never the sandbox's, and only when
  the run may push `issue-<n>-*` (a run with `push`, not one where a fork's code runs), the issue
  has no `issue-<n>-…` branch yet, and the name it gets back matches `issue-<n>-*`. The
  run asks for nothing: no sandbox can create or link a branch through the GitHub gateway
  (`createLinkedBranch` isn't among its known mutations). Its first commit goes through the git
  gateway like any push. Policies may refuse it (`deny_link_branch`, Deckhand's default
  `gh-linked-branch.rego`: work runs only among the built-in modes, a repository's own modes
  once it allows them with `allow_link_branch`); then, or if GitHub refuses, the sandbox creates
  its branch itself, as before.
- The sandbox's `pre-push` hook only gives an earlier, clearer message: the gateway doesn't
  rely on it.
- A sandbox's token only reads pull requests (see [Tokens](tokens.md#tokens)). `gh pr create`,
  `gh pr edit`, `gh pr ready [--undo]` and `gh pr update-branch` (GitHub's `createPullRequest`,
  `updatePullRequest`, `markPullRequestReadyForReview`, `convertPullRequestToDraft`,
  `updatePullRequestBranch`, or REST's `POST` and `PATCH` of `…/pulls` and `PUT
…/pulls/<n>/update-branch`) go through the [GitHub gateway](#the-github-gateway) as any write, with
  every `gh` flag the policies allow: Deckhand's default (`policy/mode-work.rego`) allows them to
  work runs only, for their own pull requests and new ones. Before the policies, whatever they
  say, `listener/github-pulls.mjs` checks that a new pull
  request's head is a branch of the repository the run may push (above), never
  `owner:branch`, another repository's head (`head_repo`, `headRepositoryId`) or an issue
  turned into one (`issue`), and that an existing one's head is too before it is edited,
  readied, drafted or has its branch updated, over any endpoint (`…/issues/<n>` included, whose
  write token has `issues: write`), or its token writes more than an issue's (a run on a
  fork's pull request may still comment on it and label it, not rewrite its author's title
  and description): another task's pull request is refused, and so is opening one from another branch.
  A pull request that conflicts with its base (`mergeable_state: dirty`) is refused ready
  with a 409 until the run rebases it. Only then does that one call get the token it needs
  ([a token per write](tokens.md#tokens)): `pull_requests: write` to open or edit one, `contents: write` to ready
  or draft one or update its branch (GitHub asks an App's token for it), which the sandbox never sees, and which
  carries only the document the gateway checked. Only the head is checked: a run may open
  its pull request into any base branch, which it reaches only when a maintainer merges
  it.
- Updating a pull request's branch (`update_branch`) is the one write to a branch that
  doesn't go through the git gateway: GitHub commits a merge of the base into it. So it is
  held to what the gateway would hold a push to: the head must be one of the run's own
  branches, in its repository (never a fork's), as above; it is a merge only, since a rebase
  (`updateMethod: REBASE`) would rewrite the commits the gateway let through; and it names the
  head it applies to (`expected_head_sha`, `expectedHeadOid`), so GitHub refuses it when the
  branch moved since the run looked. The merge brings nothing of the run's: only the base's
  commits, already on that branch of the repository. Its workflow files still go through the
  same merge check as readying the pull request does ([below](#github-actions-on-deckhands-branches)),
  since the pull request's workflows then run from that merge with a base that may have
  changed since the last push. GitHub refuses an update with conflicts, which the run rebases
  locally as before. Deckhand's default policy for it, `policy/mode-work.rego` (shipped in the
  policy service's image), allows it to work runs, and to a repository's own modes once its
  `.deckhand/policy/` allows them (`allow_github`).

This doesn't depend on GitHub: branch protection and rulesets aren't enforced on private
repositories of free plans. Where they are, a ruleset on the default branch (pull request
required) is still worth adding: it also covers people and other tools. A sandbox's
branches still reach the default branch through pull requests that a maintainer merges:
review those that touch `.deckhand.yaml` or the Dockerfile. The
one exception is [Auto-merge](#auto-merge), where the orchestrator merges, and only with your
per-repository grant.

### GitHub Actions on Deckhand's branches

The gateway controls what a sandbox pushes, not what runs on what it pushes. A branch a
sandbox pushes, and the pull request it opens, are ordinary same-repository events:
workflows triggered `on: push` or `on: pull_request` (most CI) run that branch's code
(`npm test`, build scripts, a Makefile) with the repository's secrets and a `GITHUB_TOKEN`,
and pushes made with an App's token do trigger them. Code a sandbox wrote can then:

- push to the default branch, around the gateway, when that `GITHUB_TOKEN` can write: the
  repository's (or organization's) default workflow permissions are "Read and write" (the
  default for older repositories and organizations), or a workflow asks for
  `contents: write`;
- read any secret those workflows get and send it anywhere: Actions runners aren't behind
  the egress proxy.

By default the workflow files themselves can't change: neither the sandbox's token nor the
gateway's has the `workflows` permission, so GitHub refuses a push that adds or edits one,
and the gateway refuses it first ([Without the grant](#without-the-grant)). What they run can.

**The `workflows` grant** ([the grants](../reference/server-folder.md#the-grants), one repository at a time) lifts that
for one repository: the gateway then pushes the run's branches with a token that also has
`workflows: write`, so a run can add a CI job or bump the Node version of a workflow. That
token is still the gateway's alone: the sandbox's own token never has `workflows`, a run without
`push` never pushes, and a fork's pull request has no branch to push. The grant is asked
again on each push, so taking it back applies to the next one.

It opens more than the workflows a repository already has: `on: push` and `on: pull_request`
run the branch's own workflow files. Unchecked, a workflow the run pushed could ask for
`permissions: contents: write` (a same-repository workflow's `GITHUB_TOKEN` gets what it asks
for, whatever the default workflow permissions say) and push to the default branch around the
gateway, which GitHub's rulesets don't stop on private repositories of a free plan; or name any
repository or organization secret (`${{ secrets.NAME }}`) and send it anywhere: Actions runners
aren't behind the egress proxy.

So the gateway reads the workflow files of a granted repository's pushes before GitHub does.
It keeps a bare mirror of the repository in its data directory (`git-mirrors/`), fetched with
a token that reads before each push; reads the push's pack against it (a push is a thin pack,
its deltas pointing at objects GitHub already has) into a quarantine of its own, so a refused
push leaves nothing behind; and checks each file under `.github/workflows/` that differs from
the default branch's at a pushed branch's tip, and each file that differs from a base's in
the tip's merge (`git merge-tree`) with the default branch and with the base of each open pull
request from that branch: GitHub runs a pull request's workflows from that merge, which can
hold a secret or a write permission the base added after the branch was cut, around a step the
branch edits. A workflow that doesn't merge cleanly refuses the push until the branch is
rebased. A merge's workflows are followed into the reusable workflows they call, as merged,
even when the tip has the same caller: a branch cut from an older default branch can pair its
caller with the base's newer callee. The same merge check runs again before the gateway lets a
run open, edit, ready or draft its pull request (into whatever base it asks for), or
updates its branch, since each runs its workflows from a new merge (`opened`, `edited`,
`ready_for_review`, `converted_to_draft`, `synchronize`).
The push is refused, with git's `[remote rejected]` naming the file and the rule, when
a changed workflow:

- has no top-level `permissions:` (the repository's default would apply, and it may write),
  or a `permissions:`, at the top or in a job, other than `read-all`, `{}` or scopes set to
  `read` or `none`: `write-all`, any `write` scope (`contents`, `actions`, `id-token`,
  `packages`…) and an expression are refused, keys matched without case;
- has a job with an `environment:`: it would read that environment's secrets through a
  workflow it calls, and the deployment it creates may start the `on: deployment` workflows of
  the deployed commit: the maintainers' copies, with their secrets, over the run's code;
- mentions `secrets` anywhere, in a key or a value, YAML escapes decoded: `secrets.X`,
  `secrets[...]`, `toJSON(secrets)`, `secrets: inherit`, and letters that fold to it
  (`ſecrets`, full-width); or has a non-ASCII character inside a `${{ }}` expression, whose
  names GitHub reads without case;
- uses YAML outside the strict subset the gateway reads (`listener/workflow-check.mjs`):
  anchors, aliases, tags, merge keys, several documents, duplicate keys (without case),
  multi-line plain or quoted scalars, flow collections over several lines, and line breaks other
  than `\n` and `\r\n` (NEL, U+2028, U+2029, a lone `\r`) or control characters. Only a space
  or a tab separates, as in YAML: a non-breaking or other Unicode space is text. A file the
  gateway could read differently from GitHub is refused, not guessed at;
- is a symlink or a submodule, isn't UTF-8 text, or is over 512 KiB; so is a `.github` or
  `.github/workflows` that isn't a folder, unless the default branch has the same one.

Workflows identical to the default branch's, files the run deletes and pushes that don't touch
`.github/workflows/` go through, the pack GitHub gets the one the client sent. A mirror that
can't be fetched or a pack that can't be read refuses the push with "try again": it is never
forwarded unchecked. Repositories without the grant: [Without the grant](#without-the-grant).

A checked workflow still runs the branch's code, with a `GITHUB_TOKEN` that reads. A job that
calls a reusable workflow from another repository (or another ref of this one, `uses:
owner/repo/…@ref`) is refused: that file never goes through the gateway, and a job of its with
an `environment:` reads that environment's secrets. One of this repository's (`uses:
./.github/workflows/x.yml`) is checked with the same rules, changed or not, and so are the ones
it calls. The local actions a workflow runs can't read `secrets`. Triggers that run the default
branch's version (`pull_request_target`, `workflow_run`, `schedule`) run the maintainers'
files, not the run's; `workflow_dispatch` runs the file of the ref it is given, which for a
run's branch was checked at its tip. Not checked:

- workflows already on the default branch that run a branch's code with write permissions or
  secrets (true without the grant too: see below);
- self-hosted runners: a workflow picks its runner with `runs-on`, so any self-hosted runner
  the repository can use runs a branch's code;
- configuration variables (`vars`), which any workflow reads: keep secrets out of them;
- a base's later changes: each pull request event a maintainer causes (`labeled`, `reopened`, a
  re-run by hand, a merge queue's `merge_group`…) merges the branch with its base as it is
  then. The branch's next push, and the run opening, editing, readying or drafting its
  pull request, check the merge again, but an event in between, after the base's workflows
  changed, runs a merge nobody checked. Limit environments' deployment branches (below) so that
  such a merge still can't read their secrets.

**The `workflow_secrets` grant** ([the grants](../reference/server-folder.md#the-grants), one repository at a time, #700)
lets a run write the deploy, release and nightly workflows maintainers ask for, which need
secrets. It does nothing without `workflows`, and is asked again on each push too. The rules
above exist because GitHub runs a branch's own copy of a workflow; a workflow it only ever runs
from the **default branch's copy** doesn't have that risk, since that copy only gets there
through a merge a person reviewed. For such a workflow, the gateway lifts three rules: it may
mention `secrets`, give a job an `environment:`, and ask for `write` scopes (still named one by
one under a top-level `permissions:`; `write-all` stays refused). A workflow counts when its
`on:` is a mapping of nothing but:

- `schedule`, which GitHub only runs from the default branch;
- `push` with a `branches:` that lists the repository's default branch alone, by its exact name
  (no glob or other pattern character, no `branches-ignore`, `tags` or `tags-ignore`; `paths`
  and `paths-ignore` are fine). An unfiltered `on: push` runs the branch's own copy, with its
  secrets, as soon as the gateway forwards the push.

Any other trigger keeps the strict rules, and the `[remote rejected]` line names it:
`pull_request` and an unfiltered `push` run the branch's copy; `pull_request_target`,
`workflow_run`, `issue_comment` and the like run the default branch's copy because an outsider
did something (the "pwn request" pattern), out of scope here; `workflow_dispatch` runs the copy
of whatever ref it is given, so anyone with write access could dispatch a run's branch
(`gh workflow run --ref issue-…`), which is only checked at its tip: not allowed in this first
version. A reusable workflow it calls (`uses: ./.github/workflows/x.yml`) has
`on: workflow_call`, so it keeps the strict rules and can't use secrets in this version (inherited
ones too are only read through `secrets.X`): a lifted workflow uses its secrets in its own jobs.
Triggers and `push` filters are compared exactly, case and all: a spelling GitHub might read
differently (`Push`, `brancheſ`) keeps the strict rules. Everything else holds as above: the YAML subset,
symlinks, workflows from elsewhere, non-ASCII expressions, the merges with the pull requests'
bases (none of the lifted workflow's triggers runs such a merge).

The default branch's name is the one the gateway reads for those merges at each push. A
renamed default branch turns a lifted workflow's `push` into a filter on a branch that no longer
exists: GitHub then runs it on nothing, and the next push changing it is checked against the new
name. Such a workflow reaches the default branch only through a person's merge: a pull request
changing a workflow file is never merged by `review.merge` ([Auto-merge](#auto-merge): any file
under `.github/`, matched without case, waits for a human, and the comment says why). Keep
environments' deployment branches limited to the default branch all the same: a second layer, in
case a check is wrong.

The mirrors take a copy of each granted repository in the github service's data volume
(`github-data`); a mirror's first fetch clones the repository, and may take up to an hour. A
push is saved in the github service's temporary directory while it is checked, one push per
run at a time, up to GitHub's 2 GiB. That directory is the github service container's own
writable layer, usually on the same host disk as its data volume: plan for the repositories'
size plus up to 2 GiB per run in parallel, or give the github service's `/tmp` a size-limited
`tmpfs` (commented out in `compose.yaml`) so a full one only refuses pushes.

Where GitHub enforces them, an enforced ruleset on the default branch (a pull request with an
approval, no bypass for the App or GitHub Actions) and environments with required reviewers or
deployment branches limited to the default branch are still worth having: they cover what the
checks don't, above.

The App needs the Workflows permission for it ([Create the GitHub App](../guides/github-app.md#permissions-added-later)):
without it, the gateway refuses every push of that repository, its runs' first one included,
and says so, rather than pushing without it.

This is GitHub's model for any tool or person that pushes branches, not something Deckhand
changes: your workflows are yours to set up. On each repository the App is installed on:

- set **Settings → Actions → General → Workflow permissions** to "Read repository contents
  and packages permissions" (or the organization's default), and give `contents: write`
  only to workflows that don't run a branch's code;
- keep deploy and publishing secrets out of `push` and `pull_request` workflows that run on
  any branch: put them in an
  [environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
  with required reviewers, or limit those workflows to the default branch (with the
  `workflows` grant, the gateway refuses the workflows a run writes that name one, above);
- treat pull requests from the App's bot (`<app>[bot]`) like an outsider's in workflows
  and in your own webhooks ([preview deployments](../repo-config/issues.md#preview-deployments)): they
  are same-repository and look trusted, but their code comes from a sandbox.
- the same goes for `pull_request_target` and `workflow_run` workflows that check out a
  pull request's head: they run it with the default branch's secrets and a token that may
  write.

#### Without the grant

A repository without `workflows` doesn't rest on GitHub refusing its workflow changes (#400).
GitHub checks the commits a push brings, but a fork's are already on GitHub: a network's
objects are kept together, so a push needn't carry a fork's pull request's head
(`refs/pull/<n>/head`) to point a branch at it, and whether GitHub still asks for the
Workflows permission then was never settled. A fork's run may push its pull request's commits
to its branch ([What a fork's code may reach](forks.md#what-a-forks-code-may-reach)), and a branch of
the repository runs its own workflows `on: push`, with the repository's secrets: a fork's
workflow pushed so would get them.

So the gateway reads every push of such a repository too, against the same mirror
(`listener/git-mirror.mjs` `connect()`), and refuses a branch whose commits that the
repository's branches and tags don't already reach change anything under
`.github/workflows/` (without case; a `.github` or `.github/workflows` replaced by a file, a
symlink or a submodule too): added, edited, renamed or deleted, whether the push carries
them or not. A merge counts only what differs from every parent (`git diff-tree -c`), so
merging the default branch into a run's branch passes after it changed a workflow; so does
pointing a branch at a commit the repository's branches already reach. What a fork's run's
push doesn't carry is fetched from GitHub by its id, into the push's quarantine (never the
mirror), to be read; what GitHub doesn't serve either is refused ("couldn't read …"), and so
is a push the gateway can't read ("try again"). The refusal names the files and says the
repository isn't granted `workflows`; nothing reaches GitHub. With the grant, the checks above
apply instead.

Not covered: a branch pointed at an older commit the repository's branches reach, whose
workflows a later commit changed; GitHub runs that older copy on the branch. It is the
repository's own code, as a maintainer's branch is.

## The GitHub gateway

`listener/github-gateway.mjs`, in the [github service](services.md#the-github-service). The egress proxy
relays GitHub's hosts (`GITHUB_API`'s and `GITHUB_URL`'s, `listener/egress.mjs` `githubHosts()`)
to it, as it relays the Antigravity CLI's to the models service: it decrypts their HTTPS with
[Deckhand's CA](network.md#https-and-deckhands-ca), which every run that reaches GitHub trusts, and sends
each request to the github service as `/relay/<host>/<path>` instead of the host
(`GITHUB_SERVICE_URL`). REST, GraphQL, clones and fetches all go there;
tools keep talking to `api.github.com` and `github.com` unchanged. A sandbox has no other way
to GitHub: the proxy never tunnels those hosts for it, and its plain HTTP to them is refused
(but for the two exceptions without a token, below).

- **Its run**: the run token the call carries in place of a GitHub token (`token <token>` from
  `gh`, `Bearer`, or Basic with it as the password from git), checked as above. A call that
  carries none (git's first request, a download with `curl`) is the run's whose sandbox has
  its address; never its engine's, whose builds and containers don't get the token (from
  there, such a call gets `401`). The proxy names the network (or pod) of the sandbox the
  orchestrator's egress policy found at that address, in an `X-Deckhand-Sandbox` header, replacing
  any the client sent (and drops one from every request it doesn't relay), with its own service
  token: the github service believes it from the proxy alone, and binds the run token to it. A token that doesn't check, an
  unknown or finished run's, or any other credential, gets `401`; another sandbox's `403`; a run
  without `pull` (a research run: `readsGitHub()`) `403`, whatever it sends.
- **Pushes** to GitHub's web host (`git-receive-pack`) are refused: they go to the git
  gateway (`pushInsteadOf`), as before.
- **Writes are redacted before GitHub gets them.** The body of every call but a read (`GET`,
  `HEAD`) and a fetch's pack request goes through the same redaction as the run's reply and
  log: the run's tokens (the one the call carries, and any by their shape), the tokens used for
  the run, anything shaped like a GitHub token, and the operator's credentials, which the github
  service holds none of, by their fingerprints ([The github service](services.md#the-github-service)),
  in each string of its JSON (so an escaped character can't split one), replaced in place so
  the rest of the body goes on as it was sent, then as text (a body that isn't JSON; one
  that isn't UTF-8, byte for byte). GraphQL is redacted that way too, its query and variables, inline literals
  included, before it is parsed. A redacted write still goes through, with `[redacted]` in
  place of the secret, and the run's log says so (each call once, 20 at most). A comment,
  an issue edit or a `gh api` write can't publish what the sandbox holds, a mount's content
  that looks like the operator's key say, any more than its reply can. Refused instead of
  read: a write over 16 MiB; a compressed one (`Content-Encoding` other than `identity`,
  `415`), which couldn't be read; a read (`GET`, `HEAD`, `OPTIONS`) that carries a body
  (`400`), which would go on unread (git and `gh` never send one); and a write whose URL (its
  path or query, as sent or percent-decoded) holds one of those secrets: a path names what is
  written, so it isn't rewritten.
- **A review can't read its thread** other than from `TASK_DIGEST` ([Reviews](#reviews)):
  for a review run, the gateway refuses issue and pull request comments, reviews and review
  comments, the timeline and commit comments over REST, under `repos/<owner>/<repo>` or
  `repositories/<id>` (whatever the case or the encoding of the path), the event feeds
  (a repository's, a network's, a user's, an organization's, the public one: their comment and
  review events carry the bodies), issue search (`in:comments` matches comment text, and its
  text matches quote it), any GraphQL call that names `comments`, `reviews`,
  `latestReviews`, `reviewThreads`, `timelineItems`, the `Comment` interface, a comment's or
  review's type, their edit history or `search` (any name that holds "comment", "review",
  "timeline", "contentedit", "search" or "textmatch", whatever its case) (read as text, which refuses more than a parsed document's fields would), and anything on the web host but git's fetches (its pages
  show the comments). Other runs read them.
- **Writes are checked** (`listener/github-writes.mjs`, issue #405): each REST one (anything
  but `GET` and `HEAD` under the API, but GraphQL's and rendering markdown) is classified from
  its method, path and body into actions on a target (`create`, `edit`, `comment`, `label`,
  `link`, `close`…), and its target's kind is looked up on GitHub with the github service's own
  token, never taken from the request: the run's issue, its pull request (by its number, or
  its head on a branch of the repository the run may push: `broker.mjs` `allow()`), a
  sub-issue of its issue (its parent on GitHub, in the same repository), an issue the run
  created (GitHub answered one of the run's own calls with it: a REST create, or GraphQL's
  `createIssue`, which `gh issue create` sends and whose answer the gateway reads for that
  alone: only under the response key of a `createIssue` field it parsed, and only when that
  field selects GitHub's own `issue { url }`, unaliased (an alias such as `url: title` would
  answer with a URL of the run's choosing), since another field could answer under that name
  with any issue; no older than that call; written by the
  App's bot, which files issues for every run and for the orchestrator, so that alone says
  nothing; saved with the run across restarts), another issue
  or pull request. A comment by its id (`…/issues/comments/<id>`, GraphQL's
  `updateIssueComment` and `deleteIssueComment`) must be one the run posted (issue #455): GitHub
  answered one of its own comments with it (REST's `201`, or `addComment`'s
  `commentEdge { node { url } }`, under the same rules on response keys and aliases as
  `createIssue`'s), saved with the run, and it is still the App's bot's on GitHub. Any other,
  the orchestrator's own included (the same bot writes them), is refused before any look-up. A sub-issue link's child, named by its id, must be one the run created or
  one already under its issue, and moving an issue from
  another parent (`replace_parent` with any value but `false`) is refused: a link could
  otherwise take any issue under the run's, where its policies would let it edit. A "blocked by"
  link is a `link` on the blocked issue, and its blocker must be an issue the run created,
  one under its issue, or an open issue of its repository: never a pull request or another
  repository's issue. It orders work (`plans.mjs`), and leaves only a timeline event (and its
  dependency counts) on the blocker, editing nothing else there. A reply in a review thread
  (REST's `POST …/pulls/<n>/comments/<id>/replies`, GraphQL's
  `addPullRequestReviewThreadReply`) is a `reply`, resolving one (`resolveReviewThread`) a
  `resolve`, and opening it again (`unresolveReviewThread`) an `unresolve`, all on the thread's
  pull request: the thread is looked up on GitHub by its first comment, must be on that pull
  request, and its first comment's author (and whether it is the App's bot) goes to the
  policies. Their default (`policy/mode-work.rego`: work runs only, never resolving a person's
  thread; a repository's own modes only once it allows them) ships in the policy service's
  image like Deckhand's other default policies. A new review, or a review comment that answers
  no thread, is refused whatever the policies say. A
  write with a query string is refused unchecked: GitHub may read parameters there too. Then:
  - a write it can't classify and one outside the run's repository are refused before any
    policy runs, and so is every write of a run whose refused writes already cost 100 look-ups
    on GitHub in the last hour (`MAX_REFUSED_LOOKUPS`: they share the orchestrator's rate limit;
    each look-up counts as it is made, and is given back when its write goes on or GitHub or
    the policy service failed), and so are the **built-in checks** that hold whatever a policy says: a link's
    child and blocker (above), a reaction removed only if the run added it, an assignee, a
    project, a pull request's branch ([The default branch](#the-default-branch)), a rerun
    (below), `NEEDS_INPUT_LABEL` (which a run's label writes neither add nor remove on the
    issues it created: taking it off answers their questions; an edit dropping their
    questions section still does). An assignee it adds must be one of the repository's allowed
    users or the App's bot, never Copilot: an assignment notifies them. A reaction's target is
    the comment's issue or pull request, read from GitHub; a run removes only the reactions
    GitHub said it added and hasn't removed since (saved with the run like the issues it
    created, its 100 newest): the App's bot also adds the orchestrator's reactions, which a run
    never removes, on any comment, even where the run's same reaction came first (GitHub keeps
    one per user and content): the orchestrator notes each one before it asks GitHub
    (`PUT /reactions`, in the github service's store; `reactions.json` before, issue #458, no
    longer read since #619). Whatever a policy says, no run writes the repository's
    contents (pushes go through the git gateway) or settings, reviews, or a comment it didn't
    post;
  - an item added to a project (v2) (`addProjectV2ItemById`, issue #454) is a `project` on
    its content. A project is outside every repository, so per-repo config
    can't name one: its project, looked up from its node ID with the orchestrator's token, must
    be one the operator's grants list for the repository (`allow_projects`), or it is refused
    before any policy, which can't reach another. Only that write's token gets
    `organization_projects: write`. In a granted repository, only the runs the policies allow
    `read_projects` (a read, once per run: Deckhand's defaults give it to work runs,
    brainstorms and a repository's modes) read the organization's projects,
    never a review, an inbox entry, a discussion or an
    analysis, which read outsiders' text (the App can't narrow its token to one project: their titles, fields and the
    items it can see, which GitHub redacts for repositories the token doesn't cover). Setting
    an item's fields, removing or archiving it, and the project's settings, fields and views
    are refused: the orchestrator moves the repository's issues itself, from its
    `projects:` ([Projects](../repo-config/issues.md#projects)), on granted projects only;
  - then the policies' **`allow_github` and `deny_github`** ([Policies](policies.md#policies)): the write
    goes on when an allow rule of the operator's matches it (the repository's too for its own
    modes) and no deny rule does. No rule, no write; no policies, every write refused.
    Deckhand's defaults hold what each mode writes, one file per mode
    ([the default policies](../repo-config/policies.md#the-default-policies), [the table](../repo-config/policy-inputs.md#the-github-input)):
    a work run (`policy/mode-work.rego`) writes its own issue, its pull requests (readying,
    drafting them and updating their branch with a merge too), its issue's sub-issues and the
    issues it created (their labels, reactions, projects and milestones too), replies to,
    resolves and unresolves its pull requests' review threads, creates labels, issues, and pull
    requests from its own branches, edits the comments it posted, and reruns the failed GitHub
    Actions jobs of its own pull request's head (below), nothing else: not other issues and
    pull requests. Its deny rules refuse deleting a comment, resolving a person's thread,
    assigning anyone and a rerun past a first. A brainstorm (`mode-brainstorm.rego`) edits and
    reacts on its own issue, files issues and labels, orders and files its follow-ups (a
    "blocked by" link, a project, a milestone), and never comments: the orchestrator posts its
    reply. A grooming (`mode-grooming.rego`, #585) edits and reacts on its own issue,
    files issues and labels, never comments there (but no "blocked by" link, project or
    milestone on the issues it filed, unlike a brainstorm), and comments on the repository's
    other issues; its wrap-up (`grooming-stop`) also edits, labels and closes
    them, as not planned or as a duplicate only (`change.state_reason`): the one default mode
    that writes to issues it didn't create or isn't linked to. Inbox entries (`mode-idea.rego`, `mode-bug.rego`) file issues carrying their label,
    edit those and link the ones they split; discussions (`mode-discussion.rego`) file issues. Onboarding,
    analyses, reviews and research write nothing. No default rule
    allows closing (but a grooming's wrap-up), merging, locking or a label's settings.

  A **rerun** (`POST …/actions/runs/<id>/rerun-failed-jobs`, `…/actions/jobs/<id>/rerun`,
  issue #451; never a whole run's `…/rerun`, cancelling, dispatching, approving a fork's run
  or deleting logs, which no route knows, nor one asking for debug logs, `enable_debug_logging`
  with any value but `false`: they print more of what runs with the repository's secrets, and
  the run reads them) names a workflow run or a job: the gateway looks
  them up and takes the pull request whose head commit that run tested as its target: a run
  that failed (`failure`, `timed_out`, `cancelled`), of a push or a pull request of a branch
  of the repository (not a fork's), whose head commit is still that of an open pull request
  of that branch. That pull request is held to the policies as any target (Deckhand's default
  allows `rerun` on the run's own, `own_pr`, to work runs and a repository's modes), and its branch must be one the run may push (`github-pulls.mjs`). A run of Deckhand's reruns twice at most per
  head commit (`MAX_RERUNS`: a rerun takes a slot once its checks pass, with no await between
  the count and the slot, so calls made at once can't pass it; the slot is saved with the run
  before the call goes out, so a github service restarted meanwhile still counts it, and is freed when GitHub
  refuses it or it never goes out, and counted from GitHub's answer (or from none at all: a
  call whose answer was lost may have gone out, so it counts, fail closed), with the run and commit its check
  resolved, never looked up again, and saved with the run across a restart), and Deckhand's
  default policy (`policy/mode-work.rego`) denies all but a first rerun of each workflow run ([repository config](../repo-config/policy-inputs.md#reruns)). Its token gets `actions: write` for that
  one call; the sandbox's own only reads Actions.

  A refusal (a look-up GitHub fails: `502`, fail closed) answers in GitHub's error shape
  (`{"message": "Deckhand: …"}`, with the policies' reasons), which `gh` prints to the agent,
  and the run's log notes it.

- **GraphQL is parsed** (`listener/github-graphql.mjs`, issue #406), with graphql-js (the
  github service's one runtime package, bundled into a file at image build) and validated against
  GitHub's public schema, pinned in the repository (`listener/vendor/github.graphql`,
  updated on purpose): a call that doesn't parse (or holds over 2,500 tokens or
  64 KiB, refused before validation, whose cost grows with the square of a document's repeated
  fields) or validate, a
  subscription, a document with several operations and no `operationName` naming one, a
  GraphQL `GET` and a query string are refused, as GitHub would otherwise run something
  unchecked. A document with no mutation skips one of the spec's rules, the one on fields
  that can't merge (fragments on distinct types selecting a field of two types, as
  `gh issue view` does): GitHub doesn't apply it, and a query's token only reads. Validation runs in a worker thread (`createValidator()`), never on the github service's
  main thread (its other runs' calls, the orchestrator's and edge's), one document at a time, taken from the
  runs in turn, so one that floods the worker (with as many calls as the gateway lets a run
  have at once) delays itself, not the other runs. A document validated for over 10
  seconds is refused alone (`503`), and the worker started again for the others. A query goes on. A call holds 10 mutation
  fields at most (gh sends one), each response key checked once (GitHub runs it once), and
  the targets of one call looked up once each: a call can't spend the installation's rate
  limit on look-ups. Each field of a mutation, aliases and fragments included, must
  be one of the mutations Deckhand knows, setting only the input fields it checks, whatever their value, `null` too (classic projects,
  a parent or a template at creation, Copilot's assignment, a sub-issue by URL are refused), except the empty fields gh always sends, which set nothing
  (`createIssue`'s `projectIds` as `null` or `[]`, issue #422; one with a project is refused): a mutation
  GitHub adds is refused until Deckhand names it. The node IDs the fields name, inline or in
  their variables (resolved as GitHub resolves them), are looked up with the github service's
  token to a repository, a kind and a number, so the call's own claims say nothing; a node
  outside the run's repository is refused like a missing one, before its type is named; each
  field is then a write as above, held to the built-in checks, `allow_github` and
  `deny_github` with the same input,
  and one refusal refuses the call. What goes on is the document as the gateway parsed it,
  printed again (`print()`), never the call's bytes: GitHub runs exactly what was checked.
  That document is redacted again: a secret spelled with GraphQL's own escapes (`\u0064`)
  only shows once printed, the call's JSON having hidden it.
  A new mutation in GitHub's schema means `npm run schema` in `listener/vendor/`, a reviewed
  diff, and its entry in `MUTATIONS` before any run may send it.

- **CI's results beyond GitHub Actions** (`checks: read`, `statuses: read`): a run reads its
  repository's check runs and suites and commit statuses (`CHECK_READS`: `…/check-runs`,
  `…/check-suites`, `…/status`, `…/statuses`), and a GraphQL call that selects them (a field
  or fragment of their types: `statusCheckRollup`, `checkSuites`, `status`, a check run by its
  node ID; and a fragment on an interface or union one of them may be there, such as
  `node(id:) { ... on UniformResourceLocatable { url } }` or `resource(url:) { url }`, unless it
  selects only `__typename` and `id`), as `gh pr checks` and `gh pr view` do. That is what CI says of each commit: a
  check's name, state, conclusion, links, timestamps, and the title, summary and annotations
  its App wrote; nothing it couldn't already learn by reading the code and running the tests,
  but for what an external service chose to publish there. Neither permission writes: the
  routes that create or rerun a check are writes Deckhand doesn't classify, so refused. Each
  such read is first held to `allow_github` and `deny_github`, with `action: "read_checks"`
  and no target ([Reading CI's checks](../repo-config/policy-inputs.md#reading-cis-checks); Deckhand's
  `policy/gh-checks.rego` allows it in every mode), once per run, the answer kept: its
  input depends on the run only, and `gh pr checks --watch` polls. A refusal refuses the
  call, `gh pr view` without `--json` included. It hides the checks, not whether CI passes:
  a pull request's `mergeStateStatus` (`UNSTABLE`) and search's `status:success|failure|pending`
  qualifier stay readable, as any pull request's state and any search. Without the permissions, the REST reads are
  refused, naming them; a GraphQL read goes on with a token that lacks them, and GitHub's
  refusal of those fields comes back as Deckhand's message (`explained()`).
- **On to GitHub** with a token for the run's repository: what its capabilities read
  (`listener/github-app.mjs` `readsOf()`, and its own issue for a call that reads only that),
  and only for a write that passed these checks the one write permission it needs
  (`listener/github-writes.mjs` `writePermissions()`, [Tokens](tokens.md#tokens)), so no write reaches
  GitHub unchecked (`token …` for the
  API, Basic with `x-access-token` for git, as GitHub expects an App's), the sandbox's `Authorization` and
  cookies dropped. An optional permission its installation hasn't accepted
  (`OPTIONAL_PERMISSIONS`, [When the App needs a new permission](../guides/github-app.md#when-the-app-needs-a-new-permission)) is left
  out of the token, and a call that needs it (`NEEDS`, `listener/github-gateway.mjs`) refused,
  naming it: a required one it lacks fails the token, as GitHub refuses it. A read whose
  permission the run's capabilities don't give (CI without `read:actions`) is refused naming the
  capability, over REST, and GitHub's refusal of those fields explained, over GraphQL.
  `discussions` stays required: only discussion runs read them (`read:discussions`), and their
  token fails without it, as before. The answer streams back as it comes, with the agents' endpoints' limits
  (`lib/upstream.mjs`): a call cut off after 10 minutes without a byte either way, 16
  calls in flight per run.
- **A work run that isn't a fork's gets nothing that would bring a fork's code**: a fork's
  repository, a fork's pull request's head, a commit that isn't its repository's, by git, the
  API, an archive, a page or a raw file ([What a fork's code may
  reach](forks.md#what-a-forks-code-may-reach)).
- **Context repos are fetched, nothing else** (`listener/context-gateway.mjs`, issue #930): the
  other repositories a run reads ([Context repos](../repo-config.md#context-repos)) are decided
  at its start, never from what the sandbox says: those its `.deckhand.yaml` names, the
  operator's `context_repos` patterns list, and the policies give it with `read:context`. The
  orchestrator looks each one up on GitHub then (`listener/context-access.mjs`): where the App
  is installed (its owner's installation, whoever that is), and otherwise whether GitHub shows
  it publicly; each ref is resolved. A private repository without the App, or a ref that isn't
  there, stops the run with the reason, before its sandbox starts: a run never goes on with
  part of its context. The github service gets the list with the run (`context` in
  `PUT /runs/:id`), and its gateway holds the run's calls to it:
  - git's fetch of one of them (`info/refs`, `git-upload-pack`) goes on with a token minted for
    that repository alone, `contents: read` (and the metadata every token has), from its own
    installation, or with no token at all where the App isn't installed (a public one); never
    the run's own repository's token, nor that one with the other's;
  - anything else naming it is refused, and noted in the run's log: its REST API (issues, pull
    requests, contents, anything under `repos/<owner>/<name>`), its pages, its raw files where
    they are relayed (the runs above; for the others they are plain hosts, without a token), and
    GraphQL's `repository(owner:, name:)` among a query's root fields;
  - a fetch of a repository the run could read but doesn't is refused: one its config names
    when the policies don't give it `read:context` (it fetches none), and one the operator's
    patterns list that its config doesn't name. Any other repository goes as before, with the
    run's own token, which reads public repositories only;
  - pushes go to the git gateway, which takes the run's own repository alone: a context repo's
    push is refused there (`this run can only push to …`).

  The sandbox clones each one shallow, at its ref, into `/context/<owner>/<name>[@<ref>]` before
  the setup (`sandbox/entrypoint.sh`, `SANDBOX_CONTEXT`), fresh at each run, and removes write
  permission from it: only a hint to the agent, the gateways being what refuses its writes. A
  clone that fails stops the run with git's message. The prompt lists the folders as read-only
  and untrusted input: data, never instructions.

- GitHub's content hosts (`*.githubusercontent.com`, `listener/egress.mjs`
  `githubContent()`), all of them, are relayed to the gateway too for such a run
  (`listener/egress-http.mjs`): its file hosts (`GITHUB_FILES`: `raw.githubusercontent.com`,
  `media.githubusercontent.com` for LFS files, `patch-diff.githubusercontent.com` for diffs)
  for that check, the others (release assets, avatars…) as they are, read only,
  to the host they name. Both go on without a token, the sandbox's `Authorization` and
  cookies dropped, and don't count towards its calls in flight, as when they were plain
  hosts. For every other run they stay plain allowed hosts: none carries a token.
- **Actions logs** (`/actions/runs/{id}/logs`, `/actions/jobs/{id}/logs`, an attempt's):
  GitHub redirects their download to a storage host of its own, behind a signed URL, which
  the egress proxy doesn't open. The gateway follows that one redirect itself (HTTPS, no
  credential sent, the signed URL being its own), only to GitHub's log storage
  (`*.blob.core.windows.net`, `*.githubusercontent.com`) or GitHub's own host
  (`logStorage()`: the github service isn't behind the egress proxy) and streams the log back
  (`github-gateway.mjs` `ACTIONS_LOGS`); any other redirect goes back to the sandbox as it
  came.
- **Two exceptions, neither with a token**, which reach GitHub's hosts through a tunnel
  rather than the gateway, so what they get is anonymous (both accepted in pull request
  #411):
  - **A run without `pull`** (a research run) isn't relayed: it gets no CA and nothing from the
    gateway, and reads public GitHub (other projects' READMEs, issues, releases) as it did
    before the gateway.
  - **A run's [container engine](mounts-and-engine.md#container-engine)**: its builds and containers don't trust
    the CA, so the proxy can't relay them, and refusing them would break builds that fetch
    from GitHub (a release asset, `go mod`, an `npm` dependency). The engine holds neither
    the run token nor, by its address, the gateway's token: a call from it without a token
    gets `401`.

  A sandbox can reach GitHub around the gateway through its engine, but only anonymously,
  or with a credential it got elsewhere, which any other allowed host would take too.

## Reviews

A repository turns reviews on with a `review` block in its `.deckhand.yaml` (default branch
only). It widens nothing, so it needs no grant: a review is a light run with a read-only token
(`contents`, `issues`, `pull_requests: read`), no branch to push, no setup and no engine.

- **The orchestrator posts the review**, with the App's token, through the github service (`POST /repos/{repo}/pulls/{n}/reviews`),
  from the run's final message. Without `review.fix`, a diff written to talk the agent into
  something can't make it write anything: the most it can do is change the review's text
  (with `fix`, see [Review fix runs](#review-fix-runs)). The review never
  approves (an App's approval may count toward branch protection): it requests changes on a
  critical, high or medium finding or a blocking comment, and comments otherwise (on medium ones too, in the review
  that decides an auto-merge with `review.max_allowed_severity: medium`). A review that requests
  changes, on GitHub or in its verdict, never auto-merges.
- **No sandbox reviews or approves**, a work run's included: their tokens only read pull
  requests ([Tokens](tokens.md#tokens)), so none can approve its own pull request or clear the
  review's request for changes. Only the orchestrator posts reviews, and never an approval.
- **Who gets one by itself** (`review.on: ready`): pull requests on a branch of the
  repository, opened by the App or by a user of `ALLOWED_USERS` and the repo's `users`, when
  they turn ready. Never a fork's, never an outsider's: nobody outside the allowlist can make
  the operator pay for a run. Another bot's (Dependabot, GitHub Actions) only when the
  policies let it: Deckhand's default `policy/review.rego` refuses them (`deny_review`), and
  only a file of that name, the operator's or the repository's maintainers', replaces it. A
  bot that opens a pull request on a branch of the repository was given write access to it.
- **Only allowed users' comments**: the review reads its thread (the pull request's description,
  comments and reviews, and the issue it closes) from a file the orchestrator writes
  (`TASK_DIGEST`), with only what users of `ALLOWED_USERS` and the repo's `users` whose access
  decision gives `runs:start:work` there, and the App itself, wrote: its findings can become a fix
  run's message, so a viewer who may start nothing can't steer one through it. What anyone else
  wrote, another bot included (or someone whose decision failed), is replaced with a line saying it
  was left out; an allowed user who wants it read quotes it in a comment of their own. It can't read
  the thread another way: the [GitHub gateway](#the-github-gateway) refuses a review's calls for
  comments, reviews and review comments, REST and GraphQL alike, and the web host's pages. What an
  outsider can still put in front of it is the pull request's own description and diff, which it
  reviews.
- **No loops**: each pull request's head commit is reviewed by itself once (the store's `reviews`),
  and the App's review is a bot's `pull_request_review`, which starts nothing. Acting on a
  review is the maintainer's call, with a trigger comment, unless the repo sets `review.fix`
  (below), whose loop is bounded.
- `/mode review` comes from an allowed user's comment, like any mode, on the pull request
  itself.

### Review fix runs

With `review.fix`, a review that requests changes on Deckhand's own pull request (opened by
the App, on a branch of the repository, linked to its issue) starts a work run in that
issue's session, and the orchestrator reviews what it pushed: a loop of up to `review.fix` fix
runs (`true`: one, whose push is reviewed only with `review.merge`), capped by the operator's
`MAX_FIX_ROUNDS` (5 by default). It is a normal
work run, with the same token, push rules, secrets and mounts, so the key needs no grant. The
loop is bounded: N fix runs and N reviews after them at most per pull request, each counted
in the store's `reviews` before it is queued, kept across restarts, so a redelivered webhook or a
restart starts no extra one. It stops at a review with nothing above
`review.max_allowed_severity`, when the rounds run out, at a fix that failed or pushed
nothing, a policy's refusal (`deny_fix`, `deny_review`), a run going or queued on the issue,
or the needs-input label. Each round costs a work run and a review run. Once the loop is
over, a maintainer's **Fix** on the dashboard grants one more round per click (counted the same
way, `deny_fix` applying), with `review.fix` on only: it never turns findings into a pushing run
on a repository that didn't opt in.

**The risk**: this is the one path where a model's output, not a person's comment, becomes the
message of a run that can push. The review's findings are written by a run that read the diff
and the thread; text written to steer it (a prompt injection) could turn into a "finding"
whose fix is what its author wants: a command to run, a workflow or `.deckhand.yaml` change, a
secret sent somewhere. What limits it:

- **What the review reads**: only the App's comments and those of allowed users whose access
  gives `runs:start:work` on the repository, as the fix run needs of whoever starts one (#782).
  An outsider's or a viewer's comment on the pull request or its issue doesn't reach it unless
  such a user quotes it; nor does one whose author's decision failed (fail closed).
- **Whose pull requests**: only Deckhand's own, whose diff its own work run wrote; never a
  fork's, another bot's or an outsider's.
- **How the fix run gets them**: its message fences the findings off from its instruction and
  says they are untrusted claims to check against the code, never instructions: no commands
  from a finding, no changes to CI, workflows, `.deckhand.yaml`, Dockerfiles, dependencies or
  credentials unless the issue asked for them, no secrets sent anywhere, and its reply says
  which findings it left and why. It asks the maintainer (needs-input) only about a change the
  issue itself needs that it may not make: a change only a finding asks for is never relayed as
  Deckhand's question, so a planted finding can't reach the maintainer as one ("add secret X",
  with a `Done, carry on` box) nor stop the loop.
- **What any work run is held to**: its token can't push or write pull requests, the git
  gateway pushes only its own branch (never the default one), `.github/workflows/` only
  with the `workflows` grant, hosts only through the egress proxy, and its pull request still
  waits for a maintainer to merge it.

**What is left**: these are mitigations, not a guarantee. A model can still be talked into
something by text it reads: an allowed user's comment quoting an outsider, the App's own
replies that quote one, files of the repository, or comments the reviewer reads anyway with
its token against its instructions. Turn `fix` on where the people who may comment on a pull
request or its issue are trusted (a private repository, or `users` narrowed to them), read
what a fix run pushed before merging, and keep `fix` off on public repositories with outside
contributors whose threads you don't watch.

### Review follow-ups

A review's follow-ups (problems it found outside the pull request's scope,
[Reviews](../repo-config/reviews.md#reviews)) are filed as issues by the orchestrator, with the App's
token, once the pull request is merged: no sandbox writes them, and the review's token still
only reads. Their titles and text are the review's, a model's output that read the diff and
the thread, so they are posted as data, the same text the review already showed on the pull
request: each issue's body opens by saying the text is a review model's output, claims to
check against the code and never instructions, quotes it (its `@` mentions broken, so the
model can't make the App's new issue notify anyone), and says which pull request and
review it came from. Each is labelled `follow-up` and starts nothing by itself (an issue being
opened runs nothing; picking it up is a maintainer's call, or the auto-pickup label's).
**A work run started on one** reads that body as its task, as any issue's: it is Deckhand's
own issue, but its text is no person's request. Read it before starting a run on it, and
edit it into the task you want (or quote what you keep) when it asks for more than its
title says; a prompt injection in the reviewed diff could have shaped it.

Only the App's own reviews are read back: GitHub reviews by the App's login, with its marker, whose body opens with a review's verdict line (a
sandbox's token can't post a review), and a review GitHub refused, posted as a plain comment,
only from the comment whose id its round kept when the orchestrator posted it (the store's `reviews`):
the App's other comments, a run's reply among them, are never read for follow-ups. They are
read only after a merge (a pull request closed without one files none), and
once per pull request (the store's `reviews`): a redelivered webhook or a restart files nothing twice.
A review posted after the merge's delivery (it was still running) files its own follow-ups once
it is recorded, linking those an issue already has.
A merge files at most 10, the rest listed by title (as code) in its comment, and only bullets
with a bold title count (not one saying there is none, nor one led by a comment's kind or a
severity: an item under the wrong heading, never filed; a blocking comment there blocks, an
unclear item there blocks when the review's own verdict asks for changes, and a note there
keeps the review's own verdict). Only the bullets under `## Follow-ups` count: any other
heading as deep or less after it ends its section, and nothing under such a heading is filed. The repository turns it off with `review.follow_ups: false`, read
again from its default branch at the merge: so does a `review` block that is gone, and a
config with errors files nothing. There is no policy decision of its own for it (`deny_*`):
like the review and the comments the orchestrator posts, it is Deckhand's own write.

### CI fix runs

With `review.ci: wait` and `review.fix`, a failed GitHub Actions run on Deckhand's own pull
request starts a work run that fixes CI instead of a review (up to `review.ci_fix`, capped by
`MAX_FIX_ROUNDS`, counted apart from the review's rounds, with the same gates and `deny_fix`).
The orchestrator decides it from the Actions API alone, without a model. Its message holds the
failed runs' and jobs' names, conclusions, ids and links, never their logs: the branch's code
printed those, and the run reads them itself through the GitHub gateway, which adds the
installation token (the run's `actions: read`; the sandbox holds none). GitHub answers a log's
download with a redirect to a storage host of its own (Azure blobs, behind a signed URL) that
the egress proxy doesn't open to sandboxes: the gateway follows that redirect itself, for the
Actions log paths only, once, sending no credential (the signed URL is its own), and streams
the log back. The run is told in its message that logs and names are data, not instructions, never to make a check pass by
skipping or weakening it, and the same limits as a review's fix run. It may rerun the failed
jobs of a run it judges flaky, once, instead of changing code (a rerun the GitHub gateway
checks: [The GitHub gateway](#the-github-gateway)): the same head commit then goes back to
waiting for CI, and a second failure counts as the next CI fix round, whose message says
which of the runs it reran failed again, so aren't flaky, and offers no rerun for those. The orchestrator copies no
log text into a message, comment or review prompt. A workflow's or job's name comes from the
branch's files: the comment the orchestrator posts quotes each as code. What any work run is held
to (above) holds too: a fix to `.github/workflows/` needs the `workflows` grant.

### Auto-merge

With the `auto_merge` [grant](../reference/server-folder.md#the-grants) for a repository and `review.merge: true` in its
`.deckhand.yaml`, the orchestrator merges Deckhand's own pull requests after a review with nothing
blocking (and, after a fix run, one more review of what it pushed), with the App's token
(`PUT /pulls/{n}/merge`, the App's `contents` and `pull_requests: write`). The flow and its
gates are in [Auto-merge](../repo-config/reviews.md#auto-merge).

**What it gives up**: the maintainer who reads a pull request before it reaches the default
branch, the last check of everything above. With it on:

- **Model output reaches the default branch with no human reading it.** A prompt injection in
  an issue, a comment or a file the run read, or simply a wrong change or a wrong fix, ships.
  The review is a model reading a model's work: it can miss what was planted, or be talked
  out of reporting it.
- **A merged change runs on the default branch**: the repository's workflows, with its
  secrets, on `push` to the default branch; and deployments, releases or anything else that
  follows a merge there.
- **On a public repository, anyone can comment**: the review leaves outsiders' comments out,
  but an issue's text, an allowed user quoting one, or the code itself still reach the runs.
  `auto_merge` stops at a public repository; only `auto_merge_public` lets it merge there,
  and the dashboard says so in red.

**What still holds**:

- **The grant is yours, per repository**: a rule giving it to every repository gives it to
  none, a repository's `.deckhand.yaml` can only ask (and its policies can't grant it), and the
  orchestrator logs a warning at start for each policy file of the grants folder that grants it. The dashboard shows a red badge on the repository and a red box in its config
  panel.
- **No sandbox can merge**: their tokens only read code and pull requests ([Tokens](tokens.md#tokens)),
  and the git gateway never pushes the default branch. Only the orchestrator merges, after its
  own checks.
- **A machine's push isn't merged by itself**: its commits never went through the git gateway,
  so Deckhand's `policy/machines.rego` refuses to auto-merge a pull request the App opened from
  one ([Machines](webhooks-and-sign-in.md#machines)), unless the operator's file of that name replaces it.
- **Nothing that widens Deckhand is merged by itself**: a pull request that changes
  `.deckhand.yaml`, `.deckhand/`, `.github/` (in any case), a `CODEOWNERS` or a file the config
  names (the instructions, the Dockerfile) waits for a human, so a run can't grant itself more
  through a merge, nor bring a workflow that reads secrets (`workflow_secrets`) to the default
  branch.
- **What was reviewed is what is merged**: the merge names the reviewed commit, so a push
  after the review fails it; the repository's visibility, `mergeable_state` and its GitHub
  Actions runs are read from GitHub at the merge, not taken from a webhook. A merge waiting
  for its checks (`review.merge_wait`) is decided again when a `workflow_run` delivery says
  one completed, but that delivery only says when to ask: the gates are all read again, and a
  push meanwhile still refuses it.
- **No loop**: `review.fix`'s fix runs and one review after each at most (bounded by the
  operator's `MAX_FIX_ROUNDS`), one merge decision per pull request (the store's `reviews`). Every refusal is a comment on the pull request, every merge too,
  and the dashboard marks each auto-merged task "Merged by Deckhand", so they can be found and
  read afterwards.

Use it only on private repositories where everyone who can open or comment on an issue is
trusted, and whose default branch deploys nothing you couldn't roll back.
