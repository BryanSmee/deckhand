# Security model

Sandboxes run Claude Code without permission prompts, on issues anyone may have written.
Deckhand assumes that whatever runs inside one may try to read what it shouldn't or send it
out, and limits what it can reach: no GitHub token, only calls through a gateway that adds
one for its own repository (see [Tokens](#tokens) and
[Setup](setup.md#how-sandboxes-reach-github)), no pushes to its default branch, no host
paths unless you grant them, a restricted network, and no privileges.

## The default branch

Deckhand trusts a repository's default branch: its `.deckhand.yaml`, its sandbox
instructions. What that file can ask for beyond a sandbox (mounts, the preview hook, which
runs with the Docker socket, the Dockerfile built on the host) only happens when your
grants folder allows it for that repository (see [The grants folder](#the-grants-folder)): with
the App on many repositories, whoever can push one's default branch must not get root on the
host through it. A sandbox that could write to a default branch could still change what
that file asks for, so none can:

- Sandbox tokens (what the [GitHub gateway](#the-github-gateway) adds to a sandbox's calls:
  no sandbox holds one) only **read** the code (`contents: read`). They can't push, write files
  through the API or merge a pull request, whatever the repo's settings.
- Pushes go through the listener's **git gateway** (`listener/git-gateway.mjs`), on the
  broker's port: the sandbox's git sends them there (`url.<broker>/git/.pushInsteadOf`),
  with the run's secret. The gateway reads the ref updates at the start of the push (at most
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
  - light runs (brainstorms, onboarding, inbox entries, discussions, run analyses, reviews,
    a repo's light modes):
    none. The broker registers every one as a run that can't push, so the gateway refuses
    it whatever its token, and the same holds for a run a restarted listener picks up again.

  Anything else is refused, whether an update, a force-push or a delete: another issue's
  branch (which that issue's next run checks out), another pull request's (which its author
  may merge without reading it again, or whose Dockerfile a repo with
  `allow_branch_docker_images` would build on the host), long-lived branches such as
  `gh-pages` or `release/*`, tags, signed and compressed pushes. The refusal shows in git's
  output as `[remote rejected] … (Deckhand: …)`.

- The sandbox's `pre-push` hook only gives an earlier, clearer message: the gateway doesn't
  rely on it.
- A sandbox's token only reads pull requests (see [Tokens](#tokens)). `gh pr create`,
  `gh pr edit` and `gh pr ready [--undo]` (GitHub's `createPullRequest`, `updatePullRequest`,
  `markPullRequestReadyForReview`, `convertPullRequestToDraft`, or REST's `POST` and `PATCH`
  of `…/pulls`) go through the [GitHub gateway](#the-github-gateway) as any write, with
  every `gh` flag the ceiling holds, and only a work run's ceiling holds them, for its own
  pull requests and new ones. Then `listener/github-pulls.mjs` checks that a new pull
  request's head is a branch of the repository the run may push (above), never
  `owner:branch`, another repository's head (`head_repo`, `headRepositoryId`) or an issue
  turned into one (`issue`), and that an existing one's head is too before it is edited,
  readied or drafted, over any endpoint (`…/issues/<n>` included, which the run's own
  `issues: write` would reach), or its token writes more than the run's own (a run on a
  fork's pull request may still comment on it and label it, not rewrite its author's title
  and description): another task's pull request is refused, and so is opening one from another branch.
  A pull request that conflicts with its base (`mergeable_state: dirty`) is refused ready
  with a 409 until the run rebases it. Only then does that one call get the token it needs
  besides the mode's: `pull_requests: write` to open or edit one, `contents: write` to ready
  or draft one (GitHub asks an App's token for it), which the sandbox never sees, and which
  carries only the document the gateway checked. Only the head is checked: a run may open
  its pull request into any base branch, which it reaches only when a maintainer merges
  it.

This doesn't depend on GitHub: branch protection and rulesets aren't enforced on private
repositories of free plans. Where they are, a ruleset on the default branch (pull request
required) is still worth adding: it also covers people and other tools. A sandbox's
branches still reach the default branch through pull requests that a maintainer merges:
review those that touch `.deckhand.yaml`, the Dockerfile or the preview hook's script. The
one exception is [Auto-merge](#auto-merge), where the listener merges, and only with your
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
gateway's has the `workflows` permission, so GitHub refuses a push that adds or edits one.
What they run can.

**`allow_workflows`** (a repository's own grants file only, never `default.yaml`) lifts that
for one repository: the gateway then pushes the run's branches with a token that also has
`workflows: write`, so a run can add a CI job or bump the Node version of a workflow. That
token is still the gateway's alone: the sandbox's own token never has `workflows`, light and
research runs never push, and a fork's pull request has no branch to push. The grant is read
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
caller with the base's newer callee. The same merge check runs again before the listener
opens, edits, readies or drafts a run's pull request (into whatever base it asks for), since
each runs its workflows from a new merge (`opened`, `edited`, `ready_for_review`,
`converted_to_draft`).
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
forwarded unchecked. Repositories without the grant don't change: their pushes stream through
unread, and GitHub refuses their workflow changes.

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
  then. The branch's next push, and the listener opening, editing, readying or drafting its
  pull request, check the merge again, but an event in between, after the base's workflows
  changed, runs a merge nobody checked. Limit environments' deployment branches (below) so that
  such a merge still can't read their secrets.

The mirrors take a copy of each granted repository in the data volume; a mirror's first fetch
clones the repository, and may take up to an hour. A push is saved in the listener's temporary
directory while it is checked, one push per run at a time, up to GitHub's 2 GiB. That
directory is the listener container's own writable layer, usually on the same host disk as the
data volume: plan for the repositories' size plus up to 2 GiB per run in parallel, or give
`/tmp` a size-limited `tmpfs` (commented out in `compose.yaml`) so a full one only refuses
pushes.

Where GitHub enforces them, an enforced ruleset on the default branch (a pull request with an
approval, no bypass for the App or GitHub Actions) and environments with required reviewers or
deployment branches limited to the default branch are still worth having: they cover what the
checks don't, above.

The App needs the Workflows permission for it ([setup](setup.md#2-create-the-github-app)):
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
  with required reviewers, or limit those workflows to the default branch (with
  `allow_workflows`, the gateway refuses the workflows a run writes that name one, above);
- treat pull requests from the App's bot (`<app>[bot]`) like an outsider's in workflows
  and in the [preview hook](repo-config.md#preview-hook): they are same-repository and look
  trusted, but their code comes from a sandbox.
- the same goes for `pull_request_target` and `workflow_run` workflows that check out a
  pull request's head: they run it with the default branch's secrets and a token that may
  write.

Not checked yet: whether a sandbox could push the head of a fork's pull request
(`refs/pull/<n>/head`) that changes a workflow, as its own branch, without `workflows`.
Assume it could, and keep secrets away from workflows on `issue-*` branches as above.

## Tokens

A run's secret only lives as long as the run: the listener revokes it when the run ends, and
the broker then refuses it. It also only works from that run's sandbox (or its container
engine): the [GitHub gateway](#the-github-gateway), the git gateway and the agents' API
endpoints `/anthropic/` and
`/openai/` compare the request's source address (for a call the egress proxy relayed, the
address it names, below) with that run's addresses on its networks (`docker inspect`, looked
up once per run and forgotten when its sandbox exits) and answer `403` otherwise. A secret
that leaks, to a research run on the open web say, gets another sandbox neither GitHub, a
push, nor calls on the operator's Claude or OpenAI credential. Google's endpoints still check
the secret alone (#254).

**No sandbox holds a GitHub token.** Its `GH_TOKEN`, `deckhand-token` and git credential
helper hand out the run's secret, and every call to GitHub goes through the listener's GitHub
gateway, which adds the token. In this document, "a sandbox's token" or "a run's token" is
that token: what the gateway sends GitHub for the run's calls, never something the sandbox
can read.

- It is an installation token minted for the run's repository only, with its mode's
  permissions (`listener/modes.mjs` `permissionsFor()`): it reads the code, can't push
  (pushes go through the git gateway, with the run's secret), and can write issues (and
  discussions, for discussion runs) there. Onboarding, run analyses, reviews and a repo's
  light modes only read issues.
- **No sandbox token writes pull requests** (`pull_requests: read`, work runs included), so
  no sandbox can review one: `pull_requests: write` would let a run approve any pull request
  of its repository as the App, its own included, or replace a review mode's request for
  changes (GitHub counts a reviewer's latest review). The gateway adds it to a work run's
  checked writes to its own pull requests alone, opening or editing one, whose document is
  the one it checked ([The default branch](#the-default-branch)): reviews and merges are in
  no ceiling. Comments on a pull request take `issues: write`.
- Tokens are cached per repository and permission set, renewed 10 minutes before their
  end, and shared by that repository's runs with the same permissions. GitHub makes them
  valid for an hour, which the listener can't shorten, but none leaves the listener, so none
  outlives its run in a sandbox: once the run ends, its secret gets nothing. Uninstalling the
  App, or suspending its installation, revokes them at once.

What a run prints doesn't publish one either way: the broker keeps the installation tokens
the gateway used for each run, and the listener redacts them from the run's log (what the
dashboard shows), the run analysis digest and its reply, as `[redacted]`, a defence in depth
now that the sandbox never sees them. Anything shaped like a GitHub token (`ghs_`, `ghp_`,
`gho_`, `ghu_`, `ghr_` followed by 36 characters or more, `github_pat_…`) is redacted too,
wherever it came from: a token a restarted listener no longer lists, or one the agent found
elsewhere.

### The GitHub gateway

`listener/github-gateway.mjs`, on the broker's port. The egress proxy relays GitHub's hosts
(`GITHUB_API`'s and `GITHUB_URL`'s, `listener/egress.mjs` `githubHosts()`) to it, as it relays
the Antigravity CLI's: it decrypts their HTTPS with [Deckhand's CA](#https-and-deckhands-ca),
which every run that reaches GitHub trusts, and sends each request to the listener as
`/relay/<host>/<path>` instead of the host. REST, GraphQL, clones and fetches all go there;
tools keep talking to `api.github.com` and `github.com` unchanged. A sandbox has no other way
to GitHub: the proxy never tunnels those hosts for it, and its plain HTTP to them is refused
(but for the two exceptions without a token, below).

- **Its run**: the secret the call carries in place of a token (`token <secret>` from `gh`,
  `Bearer`, or Basic with it as the password from git), checked as above. A call that
  carries none (git's first request, a download with `curl`) is the run's whose sandbox has
  its address; never its engine's, whose builds and containers don't get the secret (from
  there, such a call gets `401`). The proxy names that address in an `X-Deckhand-Client` header, replacing any
  the client sent (and drops one from every request it doesn't relay), and the listener believes it only from the proxy's own addresses: a
  sandbox that sets it itself is judged by its own address. An unknown or finished run's
  secret, or any other credential, gets `401`; another sandbox's address `403`; a research
  run (`NO_TOKEN`) `403`, whatever it sends.
- **Pushes** to GitHub's web host (`git-receive-pack`) are refused: they go to the git
  gateway (`pushInsteadOf`), as before.
- **Writes are redacted before GitHub gets them.** The body of every call but a read (`GET`,
  `HEAD`) and a fetch's pack request goes through the same redaction as the run's reply and
  log: the run's secret, the operator's credentials (`listener/secrets.mjs`
  `operatorSecrets()`), the tokens used for the run and anything shaped like a GitHub token,
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
  `link`, `close`…), and its target's kind is looked up on GitHub with the listener's own
  token, never taken from the request: the run's issue, its pull request (by its number, or
  its head on a branch of the repository the run may push: `broker.mjs` `allow()`), a
  sub-issue of its issue (its parent on GitHub, in the same repository), an issue the run
  created (GitHub answered one of the run's own calls with it: a REST create, or GraphQL's
  `createIssue`, which `gh issue create` sends and whose answer the gateway reads for that
  alone: only under the response key of a `createIssue` field it parsed, and only when that
  field selects GitHub's own `issue { url }`, unaliased (an alias such as `url: title` would
  answer with a URL of the run's choosing), since another field could answer under that name
  with any issue; no older than that call; written by the
  App's bot, which files issues for every run and for the listener, so that alone says
  nothing; saved with the run across restarts), another issue
  or pull request. A sub-issue link's child, named by its id, must be one the run created or
  one already under its issue, and moving an issue from
  another parent (`replace_parent` with any value but `false`) is refused: a link could
  otherwise take any issue under the run's, where its ceiling lets it edit. A "blocked by"
  link is a `link` on the blocked issue, and its blocker must be an issue the run created,
  one under its issue, or an open issue of its repository: never a pull request or another
  repository's issue. It orders work (`plans.mjs`), and leaves only a timeline event (and its
  dependency counts) on the blocker, editing nothing else there. A
  write with a query string is refused unchecked: GitHub may read parameters there too. Then:
  - a write it can't classify, one outside the run's repository, and one above the **mode's
    ceiling** (`listener/modes.mjs` `ceilingOf()`, built in: [the table](repo-config.md#the-github-input))
    are refused before any policy runs. A work run writes its own issue, its pull requests
    (readying and drafting them too: [The default branch](#the-default-branch)), its issue's
    sub-issues and the issues it created, and creates issues and pull requests from its own
    branches, nothing else: not other issues and pull requests, though its token could. No ceiling holds closing, merging, reviews, deleting,
    the repository's contents or settings; onboarding, analyses, reviews and a repository's
    light modes write nothing. Only a grant could widen a ceiling, and none does yet;
  - then the policies' **`deny_github`** ([Policies](#policies)), which can only narrow it.

  A refusal (a look-up GitHub fails: `502`, fail closed) answers in GitHub's error shape
  (`{"message": "Deckhand: …"}`, with the policies' reasons), which `gh` prints to the agent,
  and the run's log notes it.

- **GraphQL is parsed** (`listener/github-graphql.mjs`, issue #406), with graphql-js (the
  listener's one runtime package, bundled into a file at image build) and validated against
  GitHub's public schema, pinned in the repository (`listener/vendor/github.graphql`,
  updated on purpose): a call that doesn't parse (or holds over 2,500 tokens or
  64 KiB, refused before validation, whose cost grows with the square of a document's repeated
  fields) or validate, a
  subscription, a document with several operations and no `operationName` naming one, a
  GraphQL `GET` and a query string are refused, as GitHub would otherwise run something
  unchecked. A document with no mutation skips one of the spec's rules, the one on fields
  that can't merge (fragments on distinct types selecting a field of two types, as
  `gh issue view` does): GitHub doesn't apply it, and a query's token only reads. Validation runs in a worker thread (`createValidator()`), never on the listener's
  thread (its webhooks, dashboard and REST calls), one document at a time, taken from the
  runs in turn, so one that floods the worker (with as many calls as the gateway lets a run
  have at once) delays itself, not the other runs. A document validated for over 10
  seconds is refused alone (`503`), and the worker started again for the others. A query goes on. A call holds 10 mutation
  fields at most (gh sends one), each response key checked once (GitHub runs it once), and
  the targets of one call looked up once each: a call can't spend the installation's rate
  limit on look-ups. Each field of a mutation, aliases and fragments included, must
  be one of the mutations Deckhand knows, setting only the input fields it checks, whatever their value, `null` too (projects,
  a parent or a template at creation, Copilot's assignment, a sub-issue by URL are refused), except the empty fields gh always sends, which set nothing
  (`createIssue`'s `projectIds` as `null` or `[]`, issue #422; one with a project is refused): a mutation
  GitHub adds is refused until Deckhand names it. The node IDs the fields name, inline or in
  their variables (resolved as GitHub resolves them), are looked up with the listener's
  token to a repository, a kind and a number, so the call's own claims say nothing; a node
  outside the run's repository is refused like a missing one, before its type is named; each
  field is then a write as above, held to the ceiling and `deny_github` with the same input,
  and one refusal refuses the call. What goes on is the document as the gateway parsed it,
  printed again (`print()`), never the call's bytes: GitHub runs exactly what was checked.
  That document is redacted again: a secret spelled with GraphQL's own escapes (`\u0064`)
  only shows once printed, the call's JSON having hidden it.
  A new mutation in GitHub's schema means `npm run schema` in `listener/vendor/`, a reviewed
  diff, and its entry in `MUTATIONS` before any run may send it.

- **On to GitHub** with a token for the run's repository: its mode's permissions only for a
  write that passed these checks (and a pull request's own write's: `pull_requests` or
  `contents`, [The default branch](#the-default-branch)), the same permissions read-only for
  everything else
  (`listener/github-app.mjs` `readsOf()`), so a brainstorm's or an inbox entry's
  `issues: write` reaches only what its ceiling and the policies allowed (`token …` for the
  API, Basic with `x-access-token` for git, as GitHub expects an App's), the sandbox's `Authorization` and
  cookies dropped. The answer streams back as it comes, with the agents' endpoints' limits
  (`listener/upstream.mjs`): a call cut off after 10 minutes without a byte either way, 16
  calls in flight per run.
- **A work run that isn't a fork's gets nothing that would bring a fork's code**: a fork's
  repository, a fork's pull request's head, a commit that isn't its repository's, by git, the
  API, an archive, a page or a raw file ([What a fork's code may
  reach](#what-a-forks-code-may-reach)).
- GitHub's content hosts (`*.githubusercontent.com`, `listener/egress.mjs`
  `githubContent()`), all of them, are relayed to the gateway too for such a run
  (`listener/broker-http.mjs`): its file hosts (`GITHUB_FILES`: `raw.githubusercontent.com`,
  `media.githubusercontent.com` for LFS files, `patch-diff.githubusercontent.com` for diffs)
  for that check, the others (release assets, avatars, Actions logs…) as they are, read only,
  to the host they name. Both go on without a token, the sandbox's `Authorization` and
  cookies dropped, and don't count towards its calls in flight, as when they were plain
  hosts. For every other run they stay plain allowed hosts: none carries a token.
- **Two exceptions, neither with a token**, which reach GitHub's hosts through a tunnel
  rather than the gateway, so what they get is anonymous (both accepted in pull request
  #411):
  - **A research run** (`NO_TOKEN`) isn't relayed: it gets no CA and nothing from the
    gateway, and reads public GitHub (other projects' READMEs, issues, releases) as it did
    before the gateway.
  - **A run's [container engine](#container-engine)**: its builds and containers don't trust
    the CA, so the proxy can't relay them, and refusing them would break builds that fetch
    from GitHub (a release asset, `go mod`, an `npm` dependency). The engine holds neither
    the secret nor, by its address, the gateway's token: a call from it without a secret
    gets `401`.

  A sandbox can reach GitHub around the gateway through its engine, but only anonymously,
  or with a credential it got elsewhere, which any other allowed host would take too.

### The Claude credential

Your `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` outlives everything else a sandbox
could hold, and works for anyone: **no sandbox gets it**. Runs read text anyone may write
(issue and discussion comments, a fork's code), and their final message is posted as is: a
credential in the sandbox's environment could be read by Claude's tools or the repo's setup
and end up in a public comment.

- A sandbox's Claude Code calls the listener instead of Anthropic (`ANTHROPIC_BASE_URL` set
  to `<broker>/anthropic`, `listener/anthropic.mjs`), with the run's secret in the variable
  your credential would be in, so it keeps its mode (an OAuth token or a gateway's
  `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer`, an API key as `x-api-key`; when you set
  several, `ANTHROPIC_AUTH_TOKEN` wins, then the API key, as in Claude Code).
- The listener refuses a secret that isn't a live run's, replaces it with your credential in
  the same header and forwards the call to Anthropic (or to the listener's own
  `ANTHROPIC_BASE_URL`, a gateway such as OpenRouter), streaming the answer back. Only the
  operator sets that address: a repository can't, since it would send its code and your
  credential elsewhere. A sandbox never reaches the gateway itself, so it needs no host.
- So a run's secret can call the API with your credential while the run lasts, and nothing
  after: what a run copied out of its sandbox can't.
- The listener redacts your credential and the run's secret from the sandbox's output
  before writing the run's log (what the dashboard shows) and from its reply before posting
  it, as `[redacted]`. The value, or any part of it 16 characters long or more (a value cut off
  in an error message); a value shorter than that isn't redacted (it would be no credential,
  and would redact ordinary words), and an encoded or split one gets through, which is why
  the credential isn't there to begin with. A JWT's header and the `.eyJ` that starts its payload don't count
  towards those 16 characters: every token its issuer signs shares them, so other JWTs in a
  reply stay readable.
- When the listener can't use an operator's login (a refresh that failed, a file it can't
  read), the sandbox's call and the run's reply get a fixed text per kind ("the operator's
  login for Google can't be refreshed right now", "can't be used", or "was refused, and must
  be signed in again", each followed by "see the listener's log"), never the error itself,
  which could quote the credential file. The details go to the listener's log, redacted.

Codex's `OPENAI_API_KEY` is kept out the same way (`listener/openai.mjs`): a sandbox's Codex
has `<broker>/openai` as its provider's base URL and the run's secret as its key, sent as
`Authorization: Bearer`; the listener checks it, puts your key in its place and forwards the
call to OpenAI (or the operator's `OPENAI_BASE_URL`), under its base path only: a path with
`//host`, a scheme or `..` is refused, so the key can't be sent elsewhere, and only Codex's own
calls go (see [What the API endpoints forward](#what-the-api-endpoints-forward)). Both agents'
credentials are redacted
from every run's log and reply, whichever agent ran.

A ChatGPT plan's login (`CODEX_AUTH_FILE`, `listener/chatgpt.mjs`) takes the key's place the
same way, with more reason: its refresh token is account-wide, single-use and rotated on every
refresh, so copies in several sandboxes would also spend each other's. The listener holds the
only copy: it refreshes the access token at `auth.openai.com` (one refresh at a time, for all
runs), writes the rotated tokens back to the file (`0600`) before using them, and sends the
sandboxes' calls to ChatGPT's Codex backend (`chatgpt.com/backend-api/codex`) with the access
token and the account's `ChatGPT-Account-ID`, headers a sandbox can't set itself. A sandbox
gets the run's secret as its key, as with an API key, and nothing of the login. The tokens are
redacted from runs' output too.

Why this way, checked against Codex 0.162.1 (`codex-rs/login`, `model-provider`): with a
ChatGPT login, Codex calls `chatgpt.com/backend-api/codex/responses` with
`Authorization: Bearer <access token>` and `ChatGPT-Account-ID`, the same Responses requests
as with a key (`store: false`, streamed), and refreshes at
`auth.openai.com/oauth/token` 5 minutes before the access token expires. A custom provider
(the sandbox's `deckhand` one) sends those requests with the run's secret instead, so the
listener only has to swap the headers and the base URL; Codex in the sandbox never knows it
runs on a plan. Codex's own "external tokens" mode (`chatgptAuthTokens`) only exists in its
app server, not `codex exec`, and would still put the access token in the sandbox. Check it
again when you change `CODEX_VERSION`.

### The Antigravity CLI's login

The Antigravity CLI's `GEMINI_API_KEY` is kept out the same way (`listener/google.mjs`): a
sandbox's `agy` has `<broker>/google` as `GOOGLE_GEMINI_BASE_URL`, `modelProvider: "gemini"`
in its settings, and the run's secret as `GEMINI_API_KEY`, sent as `x-goog-api-key`; the
listener checks it against the broker, puts your key in its place and forwards the call to
Google (or the operator's `GEMINI_BASE_URL`), for the model calls `agy` makes under `/v1/` and
`/v1beta/` only (see [What the API endpoints forward](#what-the-api-endpoints-forward)).

A Google AI plan's login (`AGY_AUTH_FILE`, `listener/antigravity-login.mjs`) is the token file
`agy` writes when you sign in: an access token for about an hour, and a refresh token that
stands for the Google account. Neither enters a sandbox. On a plan, `agy` has no base URL to
point at the listener, and its calls go to Google directly, so it is kept out another way:

- **The sandbox's token file holds the run's secret** as its access token, with an expiry in
  2099 and a placeholder refresh token (`sandbox/agents/antigravity.sh`): `agy` sends the token
  as it is and never tries to refresh it (checked against agy 1.4.0).
- **The proxy relays the hosts that carry it.** For runs of the Antigravity CLI on a plan
  only (the broker's run says which agent it is), the egress policy marks
  `daily-cloudcode-pa.googleapis.com` and `www.googleapis.com` as relayed: the proxy ends the
  sandbox's TLS with Deckhand's CA (see [HTTPS and Deckhand's CA](#https-and-deckhands-ca)),
  cache on or off, and sends each request to the listener (`RELAY_URL`,
  `<broker>/relay/<host>/<path>`) instead of the host, never as a tunnel. A path that could
  leave `/relay/<host>/` once parsed (`..`, `%2e`, `\`, or not starting with `/`) gets a
  `400` and never reaches the listener, whose other endpoints (`/egress`) trust the proxy's
  address. The listener
  (`listener/google.mjs`) checks the secret in `Authorization: Bearer` against the broker,
  refuses any other agent's run, puts the plan's access token in its place and sends the call
  on, streaming the answer back. Only the paths `agy` calls go through
  (`daily-cloudcode-pa.googleapis.com/v1internal:*`, `www.googleapis.com/oauth2/v2/userinfo`):
  the plan's token opens more than the CLI's API, and a sandbox can't reach the rest with it.
- **Refused:** `agy`'s telemetry (`play.googleapis.com`, which carries the token too), whatever
  the grants say, for these runs. `antigravity-unleash.goog` (feature flags, no token) and the
  account's avatar (`lh3.googleusercontent.com`, a public image address) stay a tunnel, as
  every other host: `agy`'s eligibility check fetches the avatar the userinfo call names and
  stops if it can't (#224). Even if `agy` sent its token there, that token is the run's secret,
  which works nowhere but the listener.
- **The refresh is `agy`'s own**: the listener doesn't reimplement Google's OAuth with a client
  secret taken from the binary. When the access token is within 5 minutes of its expiry (or
  Google refused it), the listener runs `agy models` in a short container of the sandbox image
  (no capabilities, as `node`), on a volume of its own (`<AGY_VOLUME>-login`), outside the runs'
  networks, with the file's expiry set in the past; it reads back the file `agy` wrote and
  writes it to `AGY_AUTH_FILE` (`0600`). One refresh at a time, for all runs. The login's tokens
  are redacted from runs' output like the other credentials.

What this changes: the proxy reads those two hosts' requests and answers for these runs, as it
does a cached host's, and the run's secret, which it sees, is worth what it is elsewhere: this
run's calls, until it ends. A sandbox that trusts the CA gains nothing: it reaches the same
hosts, through the same proxy. Check the hosts and paths again when you change `AGY_VERSION`.

`OPENROUTER_API_KEY`, for runs that fall back to Claude Code through OpenRouter
(`claude@openrouter` in `FALLBACKS`), is kept out the same way: such a run's Claude Code gets
the run's secret as `ANTHROPIC_AUTH_TOKEN`, and the listener's Anthropic endpoint, which the
broker tells which provider the run is on, sends the call to `OPENROUTER_BASE_URL` with your
key. A sandbox can't pick its provider: only the listener sets it, from `FALLBACKS`. The key is
redacted like the others.

### What the API endpoints forward

A run's secret opens the operator's credential only for its own agent's calls. The
credentials open far more (files, batches, stored responses, fine-tuning, an organisation's
admin API), shared with every other run and with whatever else the operator uses them for, and
a batch or a cached content would keep billing after the run's secret is revoked. So each
endpoint forwards a fixed list of methods and paths, what its agent calls, and nothing else:

| Endpoint                        | Runs                                                                               | Forwarded                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/anthropic/` (`anthropic.mjs`) | Claude Code's, on `anthropic` or a provider the operator configured (`openrouter`) | `POST v1/messages`, `POST v1/messages/count_tokens`, `GET v1/models`, `GET v1/models/<id>`                                                         |
| `/openai/` (`openai.mjs`)       | Codex's (`openai`)                                                                 | `POST responses`, `POST responses/compact`, `GET models`, `GET models/<id>`, under the API's base URL or ChatGPT's `backend-api/codex/`            |
| `/google/` (`google.mjs`)       | the Antigravity CLI's (`google`)                                                   | `POST v1beta/models/<name>:generateContent`, `:streamGenerateContent`, `:countTokens`, `GET v1beta/models`, `GET v1beta/models/<name>` (`v1/` too) |
| `/relay/<host>/` (`google.mjs`) | the Antigravity CLI's on a plan                                                    | `POST v1internal:<method>` on `daily-cloudcode-pa.googleapis.com`, `GET oauth2/v2/userinfo` on `www.googleapis.com`                                |

- Anything else answers `404` in the provider's error shape, never reaching the provider, and
  is a line in the run's log ("Deckhand refused the agent's call …"), redacted like the
  sandbox's output: an agent version that needs another path shows up there. Each call is
  noted once, and the first 20 only, then one line saying the rest aren't: the listener's own
  lines are written even past `RUN_LOG_MAX_MB` (see [Output](#output)), so a sandbox looping
  on refused calls can't grow its log without end. When a new `CLAUDE_CODE_VERSION`,
  `CODEX_VERSION` or `AGY_VERSION` needs another path, add it to the endpoint's list (`ROUTES`, `GEMINI_ROUTES`,
  `RELAYED_PATHS`).
- Each endpoint serves its agent's runs only, from the provider the listener gave the run
  (`broker.provide()`): a Claude Code run's secret gets no OpenAI key, and a run without a
  provider gets no credential at all. A run a restarted listener picks up whose saved record
  names no provider gets its agent's default one.
- A run has at most 16 calls in flight through all the endpoints together: the next one
  answers `429` (agents retry those) until one ends. A call that gets no byte either way for 10
  minutes is cut off: a stalled provider doesn't hold the listener, which every run shares.
- So a provider's `401` on one of these paths, the only ones a run reaches, is what marks a
  plan's token for a refresh: a sandbox can't force refreshes through some other path.

## Mounts

A sandbox only gets Docker named volumes:

| Volume                                                          | What                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `<prefix>-<owner>-<repo>-<n>-<hash>-workspace`                  | the issue's clone, kept between its runs                                                        |
| `<prefix>-<owner>-<repo>-<n>-<hash>-fork-workspace`             | the clone of its fork's runs (see [What a fork's code may reach](#what-a-forks-code-may-reach)) |
| `<prefix>-<owner>-<repo>-<n>-<hash>-<agent>`                    | the issue's agent session (`~/.claude`, `~/.codex`, `~/.gemini`)                                |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-workspace`            | the clone of the issue's light runs                                                             |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-<agent>`              | the agent session of its light runs                                                             |
| `<prefix>-<owner>-<repo>-<n>-<hash>-research-…`                 | a research run's own (see [Research runs](#research-runs))                                      |
| `<prefix>-claude-code`, `-codex`, `-antigravity`, **read-only** | the run's agent, installed by the listener                                                      |
| `<prefix>-cache-<owner>-<repo>-<path>-<hash>`                   | the repo's `caches`, its own                                                                    |
| `<prefix>-screenshots`, **its run's folder only**               | screenshots, served under `/shots/<folder>/` (regular files only)                               |
| `<prefix>-runs`, **its run's folder, read-only**                | its inbox: comments that arrive mid-run                                                         |

`<agent>` is the run's agent (`claude`, `codex`, `antigravity`), and `<prefix>` the
deployment's `NAME_PREFIX` (`deckhand` by default).

`<hash>` (10 hex digits of the repository and task) keeps apart names that would otherwise
be the same, such as `acme/x` pull request 5 and `acme/x-pr` issue 5. Tasks whose session
dates from before it (`<prefix>-<owner>-<repo>-<n>-claude` exists) keep that name and their
volumes, but only when one of the task's own runs had that name (its log is in `logs/`, so
not once retention removed them all):
otherwise a new task could take over the session and workspace of another repository's task
whose old name is the same.

Light runs (brainstorms, onboarding, inbox entries, discussions, the repo's light modes) read
and comment (brainstorms, inbox entries and discussions also create issues); work runs push.
The git gateway refuses light runs, and their ceilings hold no pull request write but a brainstorm's comment. They never share a writable volume: what a light run could
leave in a clone or a session (git hooks, Claude's hooks and settings, code) would otherwise
run in the issue's next work run, with its token. So light runs get their own `-light-` clone and
session, no cache volumes (they run no setup), and granted host paths read-only. A work run
after a brainstorm starts a new session, from the issue and its comments.

### What a fork's code may reach

Anyone can open a pull request from a fork, and an allowed user may ask for work on it: a
comment on it, or on another of the issue's pull requests, triggers a run whose code then
runs the fork's, through its setup, tests or the agent. Such a run is a fork's run (the
listener looks up each pull request the run's comments came from), and must not reach what
the repository's later runs trust and execute:

- **Container engine**: none, whatever the grant (see [Container engine](#container-engine)).
- **Caches**: none. A `postinstall` could otherwise leave a tampered package in the
  repository's `~/.npm` volume, which every later work run, on any issue, installs from with
  push access. The run's log says "No caches: a pull request from a fork".
- **Host mounts**: read-only, as for a light run (the log's `Host mount` lines say so).
- **Branch images**: never built from a fork's branch (`allow_branch_docker_images`).

These protections follow what triggered the run, not the code it fetches. A work run started
from an issue, or from one of the repository's own pull requests, isn't a fork's run, yet it
can bring a fork's code in itself: `gh pr checkout <n>`, `git fetch origin
refs/pull/<n>/head`, or a fork's archive or raw files. A prompt injection is enough ("check
that #123 fixes it", #123 being a fork's, in the issue, a linked thread or a pull request's
description). The fork's code would then run with everything a fork's run is denied:

- the repository's **cache volumes**, which every later work run installs from (the clone's
  reset at start, below, cleans the clone, not the caches);
- **host mounts** granted read-write, and the **container engine** if granted;
- the run's **token and push rights**: it can push the run's own branch, workflow changes
  included with `allow_workflows`.

So the [GitHub gateway](#the-github-gateway) refuses a work run that isn't a fork's what would
bring a fork's code (`listener/github-forks.mjs`), reading it included: it can't tell reading
from running. A fork's run, and a light run (no caches, read-only mounts, no engine, no push),
fetch as before. The run's log notes each refusal, and the refusal says why, and that a
comment from an allowed user on the fork's pull request starts a fork's run, which fetches it.

**What it covers, and what it doesn't.** A fork's code is its _tree_: its files, commits and
blobs, and what is made of them (archives, diffs and patches, its workflows' artifacts and
logs). That is what tools fetch to build, test or run a pull request, and what the gateway
refuses, through every way to GitHub a sandbox has (below). Text a fork's author writes
elsewhere (the pull request's description and comments, its commit messages, branch names, its
workflows' check-run summaries, a repository's description) isn't a tree: it is read as any
comment is, data the sandbox's instructions tell the agent never to follow, and no check could
refuse it (`gh pr view` shows the description). An injection that asks the agent to decode and
run such text is no more a fork's code than a script pasted in a comment; the gateway doesn't
see the difference, and doesn't claim to.

- **A fork's repository**: any repository whose source is the run's repository's (a fork of
  it, or of one of its forks), by name or by id (`repositories/<id>`), whatever is read of it:
  git (`gh pr checkout` of a fork's pull request may fetch from there), the API, its pages,
  its files, GraphQL's `repository(owner:, name:)`. Git shows the reason as
  `remote: Deckhand: …`.
- **A fork's pull request's head or merge** in the run's repository (`refs/pull/<n>/…`, the
  pull request looked up on GitHub: its head isn't in the repository): in a fetch (a
  `want-ref`, or a `want` of the commit GitHub advertised under it, which git shows as
  `remote error: Deckhand: …`), an archive (`tarball`, `zipball`, `archive/`), a commit, a
  comparison, a ref parameter (below), raw and LFS files, and its diff and files
  (`gh pr diff`, `pulls/<n>/files`, `pull/<n>.diff` and `patch-diff.githubusercontent.com`,
  where it redirects). Its metadata (`gh pr view`) isn't refused.
- **A commit that isn't the repository's**: GitHub serves any commit of a repository's network
  (its forks') through the repository itself. So a fetch's `want`s, and a commit a call names,
  must be the repository's: a ref of its own pointed at it in what GitHub advertised to the
  run's git (a branch, a tag, a pull request from one of its branches), its default branch has
  it (`compare`), it is a branch's head (`branches-where-head`), or a pull request from one of
  its branches holds it (`commits/<sha>/pulls`: an earlier commit of an open one, one whose
  branch went with its squash-merge; a fork's commit only lists the fork's pull request).
  Anything else, a commit a branch dropped with no pull request or one only a tag reaches, is
  refused rather than looked for (for a minute, without asking GitHub again), and a fetch wanting over 20 objects no ref named is refused at
  once. An id is a possible commit from 4 hex digits (git's shortest abbreviation): a branch
  or tag of the repository named so is looked up first and passes (`cafe`, the tag `2024.1`,
  the branch `2024/q4`: a parameter's whole value, or each prefix of a path, one
  `git/matching-refs` call per kind). A tree and a commit's metadata (`git/trees`,
  `git/commits`) hold no file: not checked.
- **Ref parameters**: any REST, web or file host call's `ref`, `sha`, `head` and `base`
  (every value of each, whatever the path, their case or brackets: `ref[]`; the query split on
  `;` too), rather than a list of the calls that serve a file (`contents`, `readme`, `license`,
  `codeowners/errors`…). A pull request list's `head` and `base` only filter it: not checked
  there. A comparison's sides are refs too: another owner's (`main...someone:branch`) is
  refused, and after the repository's own owner (`main...org:<ref>`, `org:repo:<ref>`), the ref
  is checked as any. A ref spelled as git wouldn't name one (whitespace or a control
  character, `//`, `..`, `@{`, a backslash, a component starting with `.` (`refs/./pull/…`),
  a leading `-`, `/`, `:`, `^` or `~`, a comparison with more than three dots) is refused
  rather than
  taken for a branch, so the check doesn't rest on how GitHub reads it; after a ref, a file's
  own name may hold `..`, `@{` or spaces (`main/a..b.js`).
- **A page of the repository**: on the web host, the checks read the shapes above (archives,
  `raw/`, `blob/`, `tree/`, `blame/`, `commit/`, `compare/`, `pull/<n>`) and let through git's
  own calls and the pages that show no file (its home, issues, pull request lists, releases
  and their assets, tags, branches, labels, milestones, the Actions and workflow lists,
  discussions, the wiki, pulse, graphs, stargazers, watchers, forks, settings); a workflow
  run's pages are its run's (below). Every other page of the repository is refused, fail
  closed: GitHub's pages are many, `blob_excerpt/<id>` serves a blob's lines by its id, and
  code scanning's quote the code a pull request's analysis read.
- **A blob by its id** (`git/blobs/<sha>`, or a fetch's `want` of one): whoever wrote a fork
  can name its blobs (`git hash-object`), and nothing says where one comes from, so such a run
  gets none, its repository's own included: it reads a file with `contents/<path>?ref=` or from
  its clone. That clone is whole (`SANDBOX_FULL_CLONE`, set by `listener/sandbox-spec.mjs`),
  where other runs' are blobless (`--filter=blob:none`), whose checkouts ask for each blob they
  lack: a kept blobless clone (an older Deckhand's) gets every blob it lacks at the start, at
  once (`git fetch --refetch`), before any checkout. What the repository's branches don't reach
  (a local branch or a stash whose commits aren't on them) stays missing: the agent is told how
  many objects, and that this run can't fetch them, rather than a checkout of them failing on a
  refusal later.
- **git LFS's objects** (its batch API, `<repo>.git/info/lfs/…`, whose download links are on
  `github-cloud.githubusercontent.com`): named by their sha256, which whoever wrote a fork
  knows, as a blob's id, so the batch API is refused. An LFS file is read by its branch from
  `media.githubusercontent.com` (checked as raw files are). The sandbox image has no `git-lfs`.
- **What a workflow run made and shows**, which a fork's pull request's workflow writes as it
  likes (its tree zipped, say): its artifacts' and logs' downloads (`actions/artifacts/<id>/…`,
  `actions/runs/<id>/logs`, `actions/jobs/<id>/logs`) and every page of the run
  (`actions/runs/<id>/…`: its workflow file, the fork's own, its summaries, jobs and
  artifacts) are refused unless the run's head repository is the repository itself (looked up
  on GitHub). A run's metadata over the API (`gh run view`) isn't refused. A code scanning
  analysis downloaded as SARIF (`code-scanning/analyses/<id>`, which may quote the code it
  read, a pull request's) is checked by its ref, as any.
- **Lookups**: a run's calls may cause 120 lookups on GitHub a minute (answers already kept
  don't count), whatever host they came by: past that, its calls that need one get `429`
  until the minute is over. The installation's rate limit is the repository's other runs'
  and the listener's too.
- **GraphQL** (`listener/github-forks.mjs` `checkGraphql()`, its fields followed with their
  types through the pinned schema): a fragment on `Blob`, the only type that holds a whole
  file, is refused whatever it names (an expression such as `refs/pull/7/head:a.js` can name a
  fork's), and so is `codeowners(refName:)` (CODEOWNERS' lines at any ref). A repository named
  by `repository(owner:, name:)` (variables resolved) is checked as above: a fork's is refused,
  whatever is asked of it. A repository reached any other way (a pull request's
  `headRepository`, `node`, `search`, `forks`, `parent`) may be a fork, which can't be checked
  before GitHub answers: only its metadata may be asked of it (an allowlist: the
  `RepositoryInfo` interface's fields, ids, settings, the viewer's), not its files
  (`codeOfConduct`, `codeowners`, its templates and guidelines…) nor its tree (`object`,
  `ref`, `releases`…), which are many and grow.
- **GitHub's content hosts**: `raw.githubusercontent.com` serves any file of a public
  repository without a token, a fork's pull request's included
  (`/<owner>/<repo>/refs/pull/<n>/head/<path>`, or a fork's commit through the repository),
  `media.githubusercontent.com` its LFS files by ref the same way (`/media/…`), and
  `patch-diff.githubusercontent.com` its pull requests' diffs
  (`/raw/<owner>/<repo>/pull/<n>.diff`), which carry a new file whole. And they all share one
  CDN, which answers for any of them whatever name the connection was made to: a tunnel to
  `avatars.githubusercontent.com` (or `objects.`) served a fork pull request's raw file when
  asked with `Host: raw.githubusercontent.com`, its SNI `avatars.` or `raw.` alike (checked on
  a public repository). So the egress proxy relays every `*.githubusercontent.com` host to the
  gateway, for a run it checks, never a tunnel: the three file hosts' calls are checked as
  above (a path in another shape is refused), the others' sent on as they are to the host
  they name, whatever `Host` the sandbox wrote, read only, and all without a token, as when
  they were plain hosts. Other CDNs' tenants answered `Host: raw.githubusercontent.com` with
  their own `404` (`pypi.org`, `registry.npmjs.org`).
  Archives come from `codeload.github.com`, where `github.com/<repo>/archive/…` and the API's
  `tarball` and `zipball` redirect: it isn't a mandatory host, and a grant that adds it
  reaches any public repository's archives, around these checks.
- **A branch pointed at a fork's objects**: GitHub keeps a network's objects together, so a
  push needn't carry a commit only a fork has to set a branch to it, nor a new commit's tree
  (a fork's tree, whose id is in any of its commits' metadata), nor a thin pack's delta base;
  that branch would then be advertised as the repository's own to the next fetch. So the git
  gateway reads each push of a work run that isn't a fork's whole and runs git's
  connectivity check against the repository's own objects rather than its network's
  (`listener/git-mirror.mjs` `connect()`): every object its new tips reach must be in the
  push or in the gateway's mirror of the repository's branches and tags (never `refs/pull/*`),
  fetched just before. Else the push is refused, saying which object. That mirror is the one
  `allow_workflows` keeps ([GitHub Actions on Deckhand's branches](#github-actions-on-deckhands-branches)), now for
  every repository whose work runs push: a copy of each in the data volume (`git-mirrors/`),
  whose first fetch is a whole clone. A fork's run may push its pull request's commits to its
  branch, as before: from then on they are the repository's, which the issue's later work runs
  start from (see [Not covered](#not-covered)).
- **Git's paths in any case** (`GIT-UPLOAD-PACK`, `Info/Refs`) are a fetch's, checked as one;
  any other spelling of them is a page, and refused. Git's fetch takes its own methods only,
  for every run: `GET` for its advertisement, `POST` for its pack request; any other would be a
  write streamed past the fetch's checks (`405`).
- **The call the checks read is the one that goes on**: the gateway serves a relayed host only
  as the egress proxy spells it (lowercase, no trailing dot, no port), as a sandbox can reach
  the gateway directly too, where `raw.githubusercontent.com.` would otherwise pass for an
  unchecked content host. The URL parser resolves dot segments, encoded ones too (`%2e%2e`), in
  the URL that goes on; a path whose decoding still holds one (`..%2f`), a backslash or a NUL
  is refused. Headers some front ends route or rewrite by (`X-Original-URL`, `X-Rewrite-URL`,
  `X-Forwarded-Host`, `Forwarded`, `X-HTTP-Method-Override`…) are never passed on.
- **The issue's kept clone**: a fork's run gets a clone of its own (a `-fork-workspace`
  volume, `listener/sandbox-spec.mjs`), so what it checked out (the fork's commits, its
  branch, a stash) never sits in the clone the issue's other work runs start from, where no
  gateway call would be needed to read it. The agent's session stays the issue's (see
  [Not covered](#not-covered)).

A repository's own pull requests (their heads on its branches) are never refused. What a
lookup can't answer (GitHub down, say) is refused, as a `502`: try again. When the run's
repository is itself a fork, its source is checked as the repository is, and its source's
other forks are refused.

Every run, a fork's or not, protects the issue's clone, kept for its next runs: setup and the
agent would otherwise run a fork left checked out there (its `SANDBOX_SETUP` and project
hooks, `.claude/settings.json`, before the model reads anything). Before either starts:

- `.git` loses its hooks and keeps only the config a clone needs (origin, set back to the
  repository's URL and git's default refspec, and its branches): no `core.fsmonitor`, `core.hooksPath`, filter
  drivers or includes that a fork's code could have left, for this start's commands and the
  checkouts after it (`draft-pr.sh`). The `pre-push` hook is copied back.
- The clone goes back to the branch it was on when that tracks a branch of the repository
  (`gh pr checkout` sets a fork's to its URL or to `refs/pull/<n>/head`) and has no commit
  that isn't on the repository (a fork's merged in, not pushed), else the base branch
  (always, for a light run); `draft-pr.sh` goes back to the issue's branch on the same
  condition. Untracked and ignored files go (`git clean -ffdx`), after a work run's
  uncommitted changes are stashed (`git stash`). Stale worktrees are pruned first, so one
  can't keep a branch from being checked out. The agent is told where the clone was and
  what was stashed, and checks them out again if it needs them, once it has read them.
- Reviews read a pull request in a `git worktree` under `/tmp`, gone with their container, so
  the `-light-` clone never holds a fork's tree.

What it can still reach is in [Not covered](#not-covered).

Each run mounts only its own folder of the screenshots volume (`volume-subpath`, Docker
Engine 26 or later), named with 24 random hex digits: it can't list or read another run's.
The listener serves only the regular files of that folder: a symbolic link (opened with
`O_NOFOLLOW`), a hard link or a path that resolves elsewhere is a 404, so a run can't link
`/screenshots/a.png` to the listener's own files (`app.json`, its private key).
Its inbox folder is mounted the same way, read-only: the listener writes the comments
delivered to the run there (a file rather than the container's stdin, so a run outlives a
listener restart).

Each agent's install volume (Claude Code's, Codex's, the Antigravity CLI's) is shared by
every repository, so it is read-only in sandboxes: a run that could replace `claude` there
would run its code in the next sandbox of any repository, with that run's broker secret and
grants. The listener installs each version before the first run that needs it, as root, so
its files don't belong to the sandboxes' user, uid 1000, either. A Claude Code install that
finds the volume owned by uid 1000 (from an older Deckhand) takes it over and reinstalls from
npm rather than keep what a sandbox could have changed. A sandbox whose version isn't
installed stops with a message instead of installing it.

What is installed is pinned: Claude Code and Codex by their npm version, the Antigravity CLI
by the sha256 of its release's tarball (`AGY_SHA256`, the operator's setting, not the
release's own digest, which comes from where the tarball does): a tarball that doesn't match,
or a version without a sha256, isn't installed. npm agents install with `--ignore-scripts`,
then only the agent's own package runs its install script, not its dependencies'. Those
dependencies' versions aren't locked: they are what npm resolves at install time.

No host path is ever mounted by default: no `~/.ssh`, `~/.gitconfig`, Docker socket or
source tree.

### Host mounts

A host path reaches a sandbox only when **both** sides agree:

1. **You** grant the repository a root in its grants file (below), read-only unless you say
   `read_only: false`.
2. **The repository** asks for a path under it in its `.deckhand.yaml`:

   ```yaml
   mounts:
     - path: /nfs/work/api
       read_only: false # default true
     - /nfs/work/docs # read-only
   ```

At each run, the listener resolves each requested path with `realpath` (`..` and every
symlink) and checks that the result is the root or inside it. With `/nfs/work` granted:

| Requested                          | Result                                            |
| ---------------------------------- | ------------------------------------------------- |
| `/nfs/work/api`                    | mounted at `/nfs/work/api`                        |
| `/nfs/work/../etc`                 | refused: resolves to `/nfs/etc`, outside the root |
| `/nfs/work/link` → `/etc`          | refused: resolves to `/etc`, outside the root     |
| `/nfs/work/link` → `/nfs/work/api` | mounted from `/nfs/work/api` at `/nfs/work/link`  |
| `/nfs/other`                       | refused                                           |

A refused mount stops the run, and the reply on the issue lists each refused path and why.
A read-write request under a read-only root is mounted read-only (noted in the run's log).

Paths the sandbox mounts itself can't be mount targets, nor anything inside or above them:
`/workspace`, `/screenshots`, `/deckhand` (the run's inbox), and each agent's session and
install (`/home/node/.claude` and `/opt/claude-code`, `/home/node/.codex` and `/opt/codex`,
`/home/node/.gemini` and `/opt/antigravity`), for every agent, whichever the run has. The
list comes from the agents' definitions, so a new agent's paths are reserved too. Neither
can the repo's `caches`. Paths are limited to letters, digits and `./@+-_`.

**Between the check and the mount.** The sandbox mounts the resolved path rather than the
one asked for, but Docker resolves that path again when the container starts, minutes later
when the run builds an image first. Two things keep a sandbox from redirecting it meanwhile:

- **Resolved again right before `docker run`.** If any mount now resolves elsewhere, or is
  refused, the run stops and the reply says so.
- **Read-write requests are refused when the sandbox can rewrite their path.** Another
  sandbox with a read-write mount could otherwise swap a directory on the way (`/nfs/work/api`
  for a symlink to `/`) after both checks, even when that directory is under another
  repository's root, or above every root. So a read-write path is refused when any directory
  from `/` down to its parent can be written by the sandbox's user, uid 1000 (its owner,
  with or without write permission, since an owner can `chmod` it back; group 1000 with group
  write; or writable by anyone). In a sticky
  directory (`/tmp`), only its owner and the entry's can rename an entry: there it counts
  only when uid 1000 owns either. The mounted directory itself may be writable: its own entry
  lives in its parent. With repo A granted `/nfs/work/api` read-write and repo B `/nfs/work`,
  A's read-write mounts are refused while uid 1000 can write `/nfs/work`: make it (and every
  directory above what you mount) owned by another user and read-only for uid 1000, or ask
  for the path read-only.

What isn't guaranteed: ACLs and NFS server-side permissions aren't read, only the mode bits,
owner and group the listener sees. Read-only requests aren't checked this way, so a path
under a directory some sandbox can write could still be swapped in the moment between the
last check and the mount; grant read-write roots that don't hold your read-only ones. A
process outside Deckhand that can write the root can always redirect a mount. If uid 1000 is
also your own user on the host, the directories you own count as writable by sandboxes.
Directories above a root are checked as the listener's container sees them (Docker makes its
`/nfs` root's, whatever the host's is): a sandbox only writes the host's through a granted
root, which the listener sees at the same path, so mount every root into the listener.

**The listener must see each root**, at the same path, to resolve what is asked: mount it
into the listener read-only in `compose.yaml` (`- /nfs/work:/nfs/work:ro`). A root it can't
see grants nothing.

## The grants folder

What you give a repository beyond what every sandbox gets lives in `GRANTS_DIR`
(`/etc/deckhand/grants` in the listener: `grants/` in the
[server folder](setup.md#the-server-folder) `compose.yaml` mounts read-only, with
[`server.example/grants/`](../server.example/grants) to start from): one file per
repository, and `default.yaml` for every repository. It is optional and read again at each
run, so an edit applies without a restart.

```
grants/
  default.yaml       # every repository
  acme/api.yaml      # acme/api
  acme/web.yaml      # acme/web
  CODEOWNERS         # anything that isn't .yaml is skipped, and dot folders (.git, .github)
```

A repository's file is `<owner>/<repo>.yaml`, matched case-insensitively. It holds what you
grant that repository:

```yaml
# acme/api.yaml
# Reachable by its sandboxes, besides the mandatory hosts and default.yaml's.
hosts: ["*.acme.dev", pypi.org]
# Of the hosts it may reach, those whose answers the egress proxy keeps, HTTPS too (see The
# egress cache below), besides default.yaml's.
cached_hosts: [apt.acme.dev]
# Its .deckhand.yaml's `preview` hook runs, with the Docker socket: root on the host.
allow_preview: true
# Its .deckhand.yaml's `dockerfile` is built on the host's Docker, with its network.
allow_dockerfile: true
# Runs on its pull requests build the Dockerfile of the pull request's branch (never a
# fork's) rather than the default branch's. Needs allow_dockerfile too.
allow_branch_docker_images: true
# Its work runs get a container engine next to their sandbox (see Container engine below),
# when its .deckhand.yaml asks with `docker` and SANDBOX_ENGINE is set. Per repository only.
allow_docker: true
# `/mode research` runs: any public host, without its code or a GitHub token (see Research
# runs below).
allow_research: true
# Its runs' pushes may add or change files under .github/workflows/: the git gateway's token
# gets `workflows: write`, and the gateway refuses a changed workflow that may write or names a
# secret, checked against a mirror of the repository (see GitHub Actions on Deckhand's
# branches above). Needs the App's Workflows permission, or every push of the repository is
# refused. Per repository only.
allow_workflows: true
# UNSAFE: its .deckhand.yaml's `review.merge` lets the listener merge Deckhand's pull requests
# after a clean review, with no human reading them (see Auto-merge below). `true`: while the
# repository is private; `public`: a public one too. Per repository only.
allow_auto_merge: true
# EVEN MORE UNSAFE: auto-merge in a repository whose preview hook is granted. The hook runs the
# default branch as root on the host, so what an unread merge changes may run as root. Per
# repository only.
acknowledge_automerge_and_preview_is_highly_dangerous: true
# Its own limits; missing ones keep default.yaml's, else the built-in 2 CPUs, 4g, 2048.
limits: { cpus: 4, memory: 8g, pids: 4096 }
# Roots it may mount from (read-only unless read_only: false).
mounts:
  - root: /nfs/work
    read_only: false
  - /srv/datasets
```

`default.yaml` takes the same keys but `mounts`, `allow_docker`, `allow_workflows`,
`allow_auto_merge` and `acknowledge_automerge_and_preview_is_highly_dangerous`, for every
repository:

```yaml
# default.yaml
# The yes-or-no grants (all false by default); a repository's own file overrides each one.
allow_dockerfile: false
# Hosts every repository's sandboxes may reach, added to its own file's.
hosts: [pypi.org]
# Mirrors every repository's runs download from again and again, cached.
cached_hosts: [deb.debian.org]
# Every sandbox's limits, over the built-in 2 CPUs, 4g and 2048 processes; a repository's
# own file overrides each one.
limits: { memory: 8g }
```

`mounts`, `allow_docker`, `allow_workflows`, `allow_auto_merge` and
`acknowledge_automerge_and_preview_is_highly_dangerous` in `default.yaml` are errors: a root, a container engine, workflow files run with the Actions secrets or merges
nobody reviewed, for every repository, are too broad to grant by accident, so they are
granted one repository at a time.

**Errors stop runs, file by file.** A repository's file with errors grants that repository
nothing: its runs stop, with a reply naming the file (the details are in the listener's logs,
not on GitHub), and the dashboard's repositories tab shows it as invalid, with the file and
its errors in its panel. Other repositories keep running. A broken `default.yaml`, or a
`.yaml` file that isn't `default.yaml` or `<owner>/<repo>.yaml` (deeper or at the top, a
`.yml`, a name GitHub doesn't allow, `acme/API.yaml` next to `acme/api.yaml`), stops every
run, and the listener won't start with one. At start, a repository's broken file is logged
and the listener starts anyway.

**Symlinks** are followed while they stay in the folder: one leading outside it is an error,
for that repository when it is its file, for every repository when it is a folder.

**Who can edit the folder can grant root on the host** (`allow_preview`) and host paths
(`mounts`): protect it like the deployment itself. A git checkout works well: reviewed pull
requests, and a `CODEOWNERS` giving each team its own repositories' files, while the
folder's root (`default.yaml`, `CODEOWNERS` itself) stays with you:

```
# CODEOWNERS of your deployment's repository
*                              @acme/platform
/server/grants/acme/api.yaml   @acme/api-team
/server/grants/globex/         @globex/admins
```

`compose.yaml` mounts the server folder read-only into the listener; pull it on the host and
the next run reads the change.

Quote patterns starting with `*` (`"*.acme.dev"`): YAML reads a bare `*` as an alias. See
[Where a sandbox's hosts come from](#where-a-sandboxs-hosts-come-from) for how `hosts`
apply.

**Preview hooks and Dockerfiles** are the most powerful things a `.deckhand.yaml` asks for:
a preview hook holds the Docker socket, so it is root on the host (the App's key in
`/data`, the Claude credential, every repository's volumes); a Dockerfile is built on the
host's Docker with its network. A repository whose config has `preview` without
`allow_preview`, or `dockerfile` without `allow_dockerfile`, gets neither: its runs stop
and the reply on the issue says which grant is missing, like refused mounts, and its preview
hook doesn't run (the listener's logs say why:
`ignored: pull_request: preview hook of <repo> not run: …`). Grant them to repositories
whose default branch you trust as much as the host itself. `allow_branch_docker_images`
is a grant too, not a `.deckhand.yaml` key: it lets anyone who can push a branch of the
repository change what is built.

## Who reaches a session

A comment reaches Claude when its author is in `ALLOWED_USERS` and the repository's own
`users`, and those are checked again later, not only when it arrives:

- a comment queued when the listener stops keeps its author in `queue.json`: the next
  listener drops it (and takes its 👀 off) when its author or repository is no longer
  allowed;
- every queued comment is checked again against the repository's `users`, read from its
  default branch, when its run begins (or, for a run still going after a restart, before it
  reaches that run): a `.deckhand.yaml` that removes a user while their comment waits out
  the pause, or behind a busy repository, stops it;
- a comment that waits for other issues (`/after`) is checked again when it starts.

A comment on a pull request goes on in the session of the issue the pull request closes
(`Closes #12` in its description) only when the pull request's head branch is in the
repository, as for the branches a run may push: anyone can open a pull request from a fork
saying `Closes #12`, and an allowed user's comment on it would otherwise go on in issue 12's
session. An issue comment's payload doesn't have the head: the listener trusts the App's own
pull requests (`<slug>[bot]`, Claude's) and looks the others up, whoever opened them
(another App, `github-actions[bot]`, a collaborator). Anything else is the pull request's
own task.

GitHub may send a delivery again (by hand from the App's settings, or after a timeout on its
side): the listener remembers the last 500 delivery ids (`X-GitHub-Delivery`) and handles
each once. A restart forgets them.

## The dashboard

Only `ALLOWED_USERS` sign in. Each repository's tasks, runs and live logs (whose tool output
may hold what a run read) are shown to the users in its own `users` too, as the listener last
read them (for a run or a comment, or for the repositories tab); a repository whose
`.deckhand.yaml` hasn't been read since the listener started is shown to every allowed user
until it is. `/status` lists them the runs, preview hooks and queued comments of those
repositories only. An open live log stops within a second of its viewer signing out or
leaving the repository's `users`. The repositories tab and its configs are shown to every
allowed user.

Every answer on the listener's port carries `Content-Security-Policy: default-src 'self';
frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`: the dashboard runs its own
scripts only (its build has none inline), and no page can frame it to get a signed-in user to
click Start, Cancel or Rerun, which `SameSite=Lax` would let a sibling domain do. The setup
and sign-in pages narrow it to `default-src 'none'`, their own images, and their style by its
hash.

A session is a signed cookie, valid for 7 days, with the login and its **epoch**. Signing out
bumps the login's epoch (`/data/sessions.json`): every session of that login ends, in any
browser, including a copied cookie. Removing a user from `ALLOWED_USERS` and restarting also
signs them out; rotating `/data/session.key` signs everyone out.

`/status` answers calls from inside the listener's container without a session. A reverse
proxy on the host's network calls from loopback too: a request carrying `Forwarded`,
`X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP` needs a session. If your proxy adds none
of them, keep `/status` from it.

## The listener's data

The data volume (`/data`) holds what the listener keeps; whoever reads it has the App. The
files holding secrets are the owner's only (`0600`):

| File                   | What                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `app.json`             | the App's private key, client and webhook secrets                |
| `session.key`          | signs dashboard sessions                                         |
| `sessions.json`        | each login's session epoch                                       |
| `logs/<run>.live.json` | a running run's state, with its secret (gone once it is over)    |
| `queue.json`           | comments queued when the listener stopped, with their authors    |
| `waits.json`           | comments waiting for other issues (`/after`), with their authors |
| `credentials/`         | the plans' logins, a host folder (`DECKHAND_CREDENTIALS_DIR`)    |

`credentials/` is a folder on the host, mounted read-write (`./credentials` by default): its
`codex-auth.json` and `agy-auth.json` (or the files `CODEX_AUTH_FILE` and `AGY_AUTH_FILE` point
at) are account-wide logins the listener rewrites at each refresh. Keep it out of git and
readable by root alone, like `.env`.

Run logs (`logs/<run>.log`) have the operator's credentials, the run's secret and its GitHub
tokens redacted (see
[The Claude credential](#the-claude-credential)). Their summaries (`logs/<run>.json`) hold
what the log's first line does, the run's comments included, and its screenshots' folder.
Both, and the screenshots, go after `LOG_RETENTION_DAYS` (90 by default).

## The dashboard's actions

The dashboard is read-only but for two kinds of POST: starting a repository's onboarding
(`/api/repos/<owner>/<repo>/onboard`) and the graph's work area
(`/api/repos/<owner>/<repo>/work`, `listener/work.mjs`), which starts an issue, queues it
after another (`/after #n`), lays out a parent issue and its sub-issues from their "blocked
by" links (`plan`: each issue of the tree passes the checks below, or nothing is posted; blockers
in another repository are left out), moves its wait or cancels it (`/after none`), or stops a
brainstorm (`/stop`, refused unless it is active or idle), or stops a task's run (`cancel`,
what a `/cancel` comment does: only the repository's half of the checks below applies, as a
run may go on on a closed issue; refused when nothing runs or is queued). The work area
starts runs, so it is checked as a comment that waited is (`tasks.resume()`), at each request:

- a signed-in dashboard session, and an `Origin` header naming this listener (its
  `PUBLIC_URL`, or the host the browser asked for): a page elsewhere can't post for a
  signed-in user, on top of the session cookie's `SameSite=Lax`;
- the repository in `ALLOWED_REPOS` (when set: by name, or through its owner's `owner/*`)
  and the App installed on it;
- its `.deckhand.yaml` on the default branch without errors, and a mode it has;
- the user in both `ALLOWED_USERS` and the repository's own `users`;
- an open issue, not a pull request, with no run going or queued (a running issue doesn't
  move), and no wait that would loop back to it.

Each action is written on the issue as the App's comment ("Started from the dashboard by
@alice"), so the issue's history says who started what, as a trigger comment would. The
App's comments are ignored as triggers, so the listener queues or holds the work itself
rather than through a webhook. The backlog (`GET /api/repos/<owner>/<repo>/issues`) lists a
repository's open issues to signed-in users in its `users` (all of them while its config has
errors), from GitHub at most once every 30 seconds per repository, or after an `issues`
delivery for it, one read at a time; the dashboard keeps the last one in memory only, not in
the browser's storage. The repository list's backlog counts (`GET /api/repos?backlog=1`, the
Overview) come from the same reads under the same `users` rule (a repository whose `users`
leaves the user out has none). While the list is asked for them, each configured repository
is read again in the background at most once every 5 minutes, which labels open questions as
a board's read does.

A failed run's Rerun (`POST /api/repos/<owner>/<repo>/rerun`) passes the same checks, for
the run's issue or pull request, and only for the task's latest run when it ended in `error`,
`interrupted` or `cancelled`: it queues the comments that run had already been allowed to act on, as the
signed-in user's, and posts the App's comment saying who asked.

Its Dismiss (`POST /api/repos/<owner>/<repo>/dismiss { runId }`) passes the repository's half
of these checks (same origin, the user in `ALLOWED_USERS` and the repo's `users`, a config
without errors), not the issue's: a closed or busy item may be dismissed, since nothing runs.
It takes only the task's latest run, when it ended in `error`, `interrupted` or `cancelled`. It
is the listener's own state (`dismissed.json`: the run, who dismissed it and when), which only
the dashboard reads; nothing is posted on GitHub. Its Undo (`{ runId, undo: true }`) is open to
any of the repo's users, whoever dismissed it, as the dismissal is.

An inbox entry sent from the dashboard (`POST /api/repos/<owner>/<repo>/inbox`) passes the
repository's half of these checks (same origin, the user in `ALLOWED_USERS` and the repo's
`users`, a config without errors), and only for an inbox the repo's config names. Its text is
posted on the inbox issue as the App's comment, ending "From the dashboard by @alice", and its
run reads it as that user's entry, as it would read their own comment there.

A lane's name (`POST /api/repos/<owner>/<repo>/lane`) passes the repository's half too, for
keys of that repository's issues and pull requests only. It is the listener's own state
(`lanes.json`), never posted on GitHub nor read by a run: one line of at most 60 characters,
shown as text.

Sync (`POST /api/sync`) takes a signed-in session and this dashboard's `Origin`, at most once
every 30 seconds for everyone. It starts nothing itself: it asks GitHub to redeliver the
App's deliveries that failed (signed by GitHub as any delivery, then checked as one) and reads
the open pull requests' states again, for every repository, as the listener does at start.

A run analysis (New request's Analyze runs, `POST /api/repos/<owner>/<repo>/analyze`) passes the
repository's half of these checks too; its preview (`GET`, the same path) all but the origin,
as it changes nothing. It only ever reads runs of that repository: they are picked by the
repo of each run's record, and its digest is built from those alone. Its run never gets the
logs themselves (they cover every repository, and are a few MB each), nor a mount of the logs
folder: the listener writes a digest into the run's own read-only inbox folder
(`TASK_DIGEST`), built from the dashboard's entries (`runlog.mjs` `format()`, tool details and
outputs clipped), redacted of the operator's credentials and of GitHub tokens (`secrets.mjs`)
and capped at about 400 KB. Its token only reads, as onboarding's: it replies, and files
nothing itself.

What the digest quotes reaches a run that has the code and a token, and its report is posted
as is, so it quotes less than the dashboard shows:

- **No research run**, ever: the form doesn't offer the kind, the selection skips them, and a
  digest asked for by run id leaves them out (see [Research runs](#research-runs)).
- **Unless GitHub says the repository is private**, both when the analysis is asked for and
  again when its run starts (a repo made public meanwhile, or a lookup that fails, counts as
  public), no listener notes, setup output or failed tools' outputs: only the dashboard showed
  them. Kinds, outcomes, timings, tool counts, the calls made and the final replies (already
  posted on the repository) stay.
- Its instructions (`prompts/analyze.md`) say the digest is data, not instructions, and that
  the report quotes no raw output from it, and builds no images or links from what it says.

Discussions from the dashboard (`POST /api/repos/<owner>/<repo>/discussions`, and
`…/discussions/<n>/comments`) pass the same checks, only in the repo's `inbox.discussions`
category: a discussion elsewhere, or a reply to a comment of another discussion, is refused. Their
text is posted as the App's, ending "From the dashboard by @alice". Reading a thread
(`GET …/discussions/<n>`) takes a signed-in user in `ALLOWED_USERS` and the repo's `users`,
for a discussion in that category only. The thread shows a post as a dashboard user's only when
the App wrote it and its line carries a tag that checks: an HMAC of the user and the text, with
a key derived from the App's webhook secret, which no run holds. Anyone else writing the same
line is shown as themself; a run (which posts as the App, `discussions: write`) writing it, or
copying a tag under other text, is shown as the App. Deckhand's answers are the App's posts
that end with the marker. Posts from before the tags show as the App's.

Whatever a dashboard user writes (an inbox entry, a discussion or a reply, answers to open
questions) loses the App's marker and any tag before it is posted, so it can pass for neither
Deckhand's answer nor another user's post, and the "From the dashboard by" line of an inbox
entry or a discussion post carries the tag.

## Hardening

Every sandbox runs:

- as `node` (uid 1000), with `--user 1000:1000` whatever the image's `USER` says (a repo
  or branch image ending in `USER root` still runs as uid 1000), `--cap-drop ALL` and
  `--security-opt no-new-privileges`;
- with `--cpus`, `--memory` (and as much `--memory-swap`: no swap on top) and
  `--pids-limit`: `limits` in the repo's grants file, else in `default.yaml`, else 2 CPUs,
  `4g` and 2048 processes.

The containers the listener starts around runs get the same treatment where they can: the
Claude Code install runs as root with only `CHOWN` (to take over an older volume); the one
that hands a new cache volume to uid 1000 keeps only `CHOWN`, without network.

The Docker socket stays in the listener (and in preview hooks, which a repo's maintainers
configure and only run with `allow_preview` in its grants file, see
[Per-repo config](repo-config.md#preview-hook)). No sandbox gets it, nor does a container
engine. Image builds only run for repositories granted `allow_dockerfile`.

**Optional: a socket proxy.** The listener only uses the docker CLI, so it can talk to a
socket proxy (for example `tecnativa/docker-socket-proxy`) through `DOCKER_HOST` instead of
the socket itself. It needs: `CONTAINERS`, `IMAGES`, `BUILD`, `VOLUMES`, `NETWORKS`, `POST`
and `DELETE` (`docker run`, `ps`, `logs`, `inspect`, `wait`, `rm`, `cp`, `build`, `image ls/rm`,
`volume create/inspect/ls/rm`, `network create/inspect/connect/disconnect/ls/rm`, and `info`
with a container engine). Preview hooks still need the real socket
(`DOCKER_SOCKET`): leave `preview` out of your repos' configs if you go this way.

### Output

A run's output can't stop the listener, nor fill its data volume:

- A line of output is cut at 1 MB (`… (line cut)` at its end), and the rest of it dropped up
  to its newline. A line the listener fails to handle (a full disk, say) is lost, not the
  listener.
- A run's log holds at most `RUN_LOG_MAX_MB` (200 MB by default, and never unlimited) of the
  sandbox's output. Past it, nothing more of it is written: the sandbox is stopped and the
  run fails, with a note in its log and a reply saying why. The listener's own lines (a few
  notes) are still written. A restarted listener counts what the log already holds, and
  stops the sandbox again if it still runs.
- At start, a log without its summary (`logs/<run>.json`) is read whole up to 64 MB, else
  only its first line and its last 4 MB. One that can't be read is left out of the run list,
  and logged: no log keeps the listener from starting.

The cap is per run: the logs together can take up to that much for each run kept, until
`LOG_RETENTION_DAYS`.

## Container engine

A run whose repository is granted `allow_docker` (its own grants file only), whose
`.deckhand.yaml` asks for `docker`, and for which the operator set `SANDBOX_ENGINE`, gets a
second container next to its sandbox: an engine serving Docker's API
([Setup](setup.md#container-engine)). The sandbox keeps everything above (uid 1000, no
capabilities, `no-new-privileges`, its limits); whatever an engine needs relaxed is relaxed
in the engine only:

- **Never `--privileged`, never the host's Docker socket.** What the agent builds and runs
  stays in the engine's own storage: a volume of the run's own, removed with the run, or the
  repository's cache volume when its config keeps one (`docker: { cache: true }`), which only
  that repository's runs mount, one at a time.
- **Sysbox** (`sysbox`): `dockerd` under the `sysbox-runc` runtime, with Docker's default
  capabilities. Root in the engine is an unprivileged range of user ids on the host (a user
  namespace), and Sysbox virtualises what `dockerd` needs (`/proc`, `/sys`, nested cgroups)
  without relaxing seccomp or AppArmor.
- **Podman** (`podman`): rootless Podman as the image's `podman` user, with Docker's default
  capabilities, seccomp and AppArmor unconfined, SELinux labels off, `/dev/fuse` and
  `/dev/net/tun`: what user namespaces, fuse-overlayfs and its network need. See
  [Not covered](#not-covered).
- **Its limits** are the repository's (`limits` in its grants, else the built-in ones), on top of
  the sandbox's: a run can use twice its limits, half in each container.
- **Its network** is the run's: internal, with the sandbox, the listener and the proxy. Its
  address counts as the sandbox's for the egress proxy, so its pulls, its builds' steps and
  its containers reach only the run's hosts, through the proxy (by address: its containers
  can't resolve names on the run's network). Its containers have no other route out.
- **Its API** (`tcp://engine:2375`) has no TLS and no authentication: only the run's own
  network reaches it, and whatever can reach it (the sandbox, the containers it started) is
  the run's own code anyway.
- **Who gets one**: work runs only. Light runs (brainstorms, inbox entries, discussions,
  light modes) never do, and neither does a run with a comment from a fork's pull request,
  whatever its grant: a fork's code never runs in an engine.
- **Clean-up**: the engine and its run's volume carry the `deckhand.engine` label (not
  `deckhand.run`: an engine is never taken for a sandbox). They go with the run, and the
  listener's check every minute removes those whose run is gone, after a restart too.

## Reviews

A repository turns reviews on with a `review` block in its `.deckhand.yaml` (default branch
only). It widens nothing, so it needs no grant: a review is a light run with a read-only token
(`contents`, `issues`, `pull_requests: read`), no branch to push, no setup and no engine.

- **The listener posts the review**, with its own token (`POST /repos/{repo}/pulls/{n}/reviews`),
  from the run's final message. Without `review.fix`, a diff written to talk the agent into
  something can't make it write anything: the most it can do is change the review's text
  (with `fix`, see [Review fix runs](#review-fix-runs)). The review never
  approves (an App's approval may count toward branch protection): it requests changes on a
  critical, high or medium finding, and comments otherwise (on medium ones too, in the review
  that decides an auto-merge with `review.max_allowed_severity: medium`). A review that requests
  changes, on GitHub or in its verdict, never auto-merges.
- **No sandbox reviews or approves**, a work run's included: their tokens only read pull
  requests ([Tokens](#tokens)), so none can approve its own pull request or clear the
  review's request for changes. Only the listener posts reviews, and never an approval.
- **Who gets one by itself** (`review.on: ready`): pull requests on a branch of the
  repository, opened by the App or by a user of `ALLOWED_USERS` and the repo's `users`, when
  they turn ready. Never a fork's, never another bot's (Dependabot, GitHub Actions), never an
  outsider's: nobody outside the allowlist can make the operator pay for a run.
- **Only allowed users' comments**: the review reads its thread (the pull request's
  description, comments and reviews, and the issue it closes) from a file the listener writes
  (`TASK_DIGEST`), with only what users of `ALLOWED_USERS` and the repo's `users`, and the App
  itself, wrote. What anyone else wrote, another bot included, is replaced with a line saying
  it was left out; an allowed user who wants it read quotes it in a comment of their own. It
  can't read the thread another way: the [GitHub gateway](#the-github-gateway) refuses a
  review's calls for comments, reviews and review comments, REST and GraphQL alike, and the
  web host's pages. What an outsider can still put in front of it is the pull request's own
  description and diff, which it reviews.
- **No loops**: each pull request's head commit is reviewed by itself once (`reviews.json`),
  and the App's review is a bot's `pull_request_review`, which starts nothing. Acting on a
  review is the maintainer's call, with a trigger comment, unless the repo sets `review.fix`
  (below), whose loop is bounded.
- `/mode review` comes from an allowed user's comment, like any mode, on the pull request
  itself.

### Review fix runs

With `review.fix`, a review that requests changes on Deckhand's own pull request (opened by
the App, on a branch of the repository, linked to its issue) starts a work run in that
issue's session, and the listener reviews what it pushed: a loop of up to `review.fix` fix
runs (`true`: one, whose push is reviewed only with `review.merge`), capped by the operator's
`MAX_FIX_ROUNDS` (5 by default). It is a normal
work run, with the same token, push rules, secrets and mounts, so the key needs no grant. The
loop is bounded: N fix runs and N reviews after them at most per pull request, each counted
in `reviews.json` before it is queued, kept across restarts, so a redelivered webhook or a
restart starts no extra one. It stops at a review with nothing above
`review.max_allowed_severity`, when the rounds run out, at a fix that failed or pushed
nothing, a policy's refusal (`deny_fix`, `deny_review`), a run going or queued on the issue,
or the needs-input label. Each round costs a work run and a review run.

**The risk**: this is the one path where a model's output, not a person's comment, becomes the
message of a run that can push. The review's findings are written by a run that read the diff
and the thread; text written to steer it (a prompt injection) could turn into a "finding"
whose fix is what its author wants: a command to run, a workflow or `.deckhand.yaml` change, a
secret sent somewhere. What limits it:

- **What the review reads**: only allowed users' and the App's comments, as above. An outsider's
  comment on the pull request or its issue doesn't reach it unless an allowed user quotes it.
- **Whose pull requests**: only Deckhand's own, whose diff its own work run wrote; never a
  fork's, another bot's or an outsider's.
- **How the fix run gets them**: its message fences the findings off from its instruction and
  says they are untrusted claims to check against the code, never instructions: no commands
  from a finding, no changes to CI, workflows, `.deckhand.yaml`, Dockerfiles, dependencies or
  credentials unless the issue asked for them, no secrets sent anywhere, and its reply says
  which findings it left and why.
- **What any work run is held to**: its token can't push or write pull requests, the git
  gateway pushes only its own branch (never the default one), `.github/workflows/` only
  with `allow_workflows`, hosts only through the egress proxy, and its pull request still
  waits for a maintainer to merge it.

**What is left**: these are mitigations, not a guarantee. A model can still be talked into
something by text it reads: an allowed user's comment quoting an outsider, the App's own
replies that quote one, files of the repository, or comments the reviewer reads anyway with
its token against its instructions. Turn `fix` on where the people who may comment on a pull
request or its issue are trusted (a private repository, or `users` narrowed to them), read
what a fix run pushed before merging, and keep `fix` off on public repositories with outside
contributors whose threads you don't watch.

### Auto-merge

With `allow_auto_merge` in a repository's grants file and `review.merge: true` in its
`.deckhand.yaml`, the listener merges Deckhand's own pull requests after a review with nothing
blocking (and, after a fix run, one more review of what it pushed), with its own token
(`PUT /pulls/{n}/merge`, the App's `contents` and `pull_requests: write`). The flow and its
gates are in [Auto-merge](repo-config.md#auto-merge).

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
  `allow_auto_merge: true` stops at a public repository; only `public` lets it merge there,
  and the dashboard says so in red.

**What still holds**:

- **The grant is yours, per repository**: `default.yaml` can't set it, a repository's
  `.deckhand.yaml` can only ask, and the listener logs a warning at start for each repository
  granted it. The dashboard shows a red badge on the repository and a red box in its config
  panel.
- **No sandbox can merge**: their tokens only read code and pull requests ([Tokens](#tokens)),
  and the git gateway never pushes the default branch. Only the listener merges, after its
  own checks.
- **Nothing that widens Deckhand is merged by itself**: a pull request that changes
  `.deckhand.yaml`, `.deckhand/`, `.github/`, a `CODEOWNERS` or a file the config names (the
  instructions, the Dockerfile, the paths in the preview hook's command) waits for a human, so
  a run can't grant itself more through a merge.
- **Not with a preview hook, unless you say so at length**: the hook runs the default branch's
  files as root on the host, with the Docker socket, and no gate can follow what its command
  runs (a script it sources, a `Makefile`, `package.json`, a compose file, the files its image
  `COPY`s). A repository with a granted hook doesn't auto-merge until its grants file also sets
  `acknowledge_automerge_and_preview_is_highly_dangerous: true`. With it, a prompt injection
  that gets a change merged can run as root on the host on the next pull request: the whole
  deployment, every repository's secrets and the Claude credential. Don't set it.
- **What was reviewed is what is merged**: the merge names the reviewed commit, so a push
  after the review fails it; the repository's visibility, `mergeable_state` and its GitHub
  Actions runs are read from GitHub at the merge, not taken from a webhook. A merge waiting
  for its checks (`review.merge_wait`) is decided again when a `workflow_run` delivery says
  one completed, but that delivery only says when to ask: the gates are all read again, and a
  push meanwhile still refuses it.
- **No loop**: `review.fix`'s fix runs and one review after each at most (bounded by the
  operator's `MAX_FIX_ROUNDS`), one merge decision per pull request (`reviews.json`). Every refusal is a comment on the pull request, every merge too,
  and the dashboard marks each auto-merged task "Merged by Deckhand", so they can be found and
  read afterwards.

Use it only on private repositories where everyone who can open or comment on an issue is
trusted, and whose default branch deploys nothing you couldn't roll back.

## Policies

[Policies](repo-config.md#policies) are Rego rules that refuse a decision (`deny_merge`, the
last gate of an auto-merge; `deny_review`, a review that starts by itself; `deny_fix`, a
review's fix run; `deny_github`, a run's write to GitHub (REST, or a GraphQL mutation's field), under its mode's built-in
ceiling: [The GitHub gateway](#the-github-gateway)). Yours are the `*.rego` files of `policy/` in the grants folder,
read again at each decision: the defaults of every repository. A repository's own are in
`.deckhand/policy/` on its default branch; one with the same name as yours replaces it, others
add to them.

- **They can't widen anything**: they run after every built-in gate and can only add refusals.
  The grants (`allow_auto_merge` and the rest) and the built-in gates stay what they are, so
  any repository may have policies, with no grant: overriding one of yours by its file name
  only drops a refusal you added, never one of Deckhand's. If a rule must hold for every
  repository whatever it says, it belongs in a grant or a built-in gate, not in a default
  policy.
- **A pull request can't change them for itself**: they are read from the default branch, and
  `.deckhand/` is among the files Deckhand trusts, so a pull request that changes a policy is
  never merged by itself.
- **They run in the listener, isolated**: the pinned `opa` binary of the listener's image
  (version and sha256 in `listener/Dockerfile`), one process per decision, with an empty
  environment, a 2-second limit, and a capabilities file without `opa.runtime` (the
  environment), `http.send`, `net.*` (the network, DNS included), `json.match_schema` and
  `json.verify_schema` (a schema's `$ref` reads a local `file://` path, `allow_net` or not) and
  `trace`, and no host allowed (`allow_net: []`). A policy decides from its input only: it
  can't read the listener's secrets or files, or reach anything. The capabilities are the
  pinned binary's own minus these, so a new `opa` version is checked for builtins that read
  files or the network before it is pinned (`test/policies.test.mjs` tries the known ones
  with the real binary).
- **Their errors too**: what a failure says (opa's error, GitHub's) is cut and redacted like a
  message below: an error may quote what a policy read.
- **What they say is shown, not trusted**: each message is put on one line, cut to 200
  characters, redacted like the runs' output (the operator's secrets, GitHub token shapes),
  quoted as code (no mention, no formatting), and five at most are posted.
- **Fail closed**: a policy that doesn't compile, takes too long, or gives anything but a set
  of strings refuses the decision with a `policy error: …` reason; so does a policy folder
  that can't be read (yours or GitHub's). For `deny_merge`, the pull request then waits for a
  human, as with any refusal; for `deny_review`, the review is skipped (the log says why); for
  `deny_fix`, no fix run starts and a comment says why; for `deny_github`, the run's write is
  refused, so a broken policy stops every run's writes in that repository. A refusal only
  ever costs a run, a write or a merge, never starts one. Your folder's compile errors are logged at start; a repository's
  appear in its onboarding pull request's config check and its config panel on the dashboard.
- **A dry run decides nothing**: `/mode policy` on a pull request, only from an allowed user
  (like any comment that reaches Deckhand), evaluates the rules and replies with their results
  and the input. Nothing is reviewed, fixed or merged; the task's page keeps who asked, when,
  the denial count and the reply's link, not the input. The input it posts is what GitHub
  already shows that user about the pull request. Your policies' file names and compile
  errors (redacted) appear in the reply and the config panel, not their text.
- **A decision's input is kept redacted**: the newest 3 decisions of a task keep the input
  their rules saw in `decisions.json`, each string redacted like the messages, the whole cut to
  8 KB, for the task's page on the dashboard.

## Research runs

A run in the research mode (`/mode research`, [Per-repo config](repo-config.md#research))
reaches the open internet, which no other run does: the only other way is `hosts: ["*"]` in
a repository's grants file, which opens it for every run of that repository, next to its
code and a token. A research run is one prompt-injected page away from sending whatever it
holds to any host, so it holds almost nothing:

| What                           | A research run                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Hosts                          | any public one (`*`); private addresses only for the mandatory hosts, not the grant's   |
| The repository's code          | none: no clone, `/workspace` starts empty                                               |
| GitHub                         | public pages and API, anonymously; the GitHub and git gateways refuse it                |
| Other runs' secrets            | useless: a secret only works from its own run's sandbox ([Tokens](#tokens))             |
| Input                          | the issue's title, description and last 50 comments, written by the listener (redacted) |
| Output                         | its final message, posted by the listener as the reply; no screenshots folder           |
| Run analyses                   | never in one: what a page made it say would reach a run with the code and a token       |
| Image, setup, caches, mounts   | the base image only; no `setup`, `caches`, host mounts or project `instructions`        |
| Container engine, egress cache | none: no engine, no cached hosts; Deckhand's CA only for the Antigravity CLI on a plan  |
| Volumes                        | `<name>-research-workspace` and its session volume: no work or light run mounts them    |

- **The grant**: `allow_research: true`, in a repository's file or in `default.yaml` for
  every repository; off by default. Without it, `/mode research` gets a reply naming it and
  no sandbox starts; it is checked again when the run starts.
- **Private addresses**: `*` never reaches one, nor an address on one of the egress proxy's
  networks, whatever its range (see [Network](#network)), so the listener's dashboard port,
  other runs' sandboxes and engines, and your LAN stay out of reach. Unlike other runs, a research
  run doesn't get the private addresses of the hosts you grant its repository either: an
  internal host next to the open internet would be a way out for what it serves.
- **Its volumes are its own**: whatever a page gets it to write there (hooks, settings) never
  runs in a run that has a token or the code.
- **The agent's credential** works as for any run: the run's secret reaches the listener's
  broker port only, on the run's network, and dies with the run.
- **Search** (Claude Code's `WebSearch`, Codex's `web_search`) runs on the provider's side,
  in the API call through the listener, in every run: it returns results and snippets, not
  pages. Reading the pages, docs and PDFs themselves takes a research run.

## Network

```
sandbox ──(its run's network, internal: no route out)──▶ egress proxy ──▶ allowed hosts
   └─────────────────────────────────────────────────▶ listener (broker, Claude's API calls)
```

- Each run has a **network of its own**, named after the run and labelled with the
  deployment's `NAME_PREFIX`: the listener creates it before the sandbox and removes it with
  the sandbox. Only three containers are on it (four with a
  [container engine](#container-engine)): the sandbox, the listener and the egress proxy, which the listener joins to it under the names sandboxes call them by (the host
  names of `BROKER_URL` and `EGRESS_PROXY`). Sandboxes can't reach each other, nor what
  another run's setup started (a dev server, a database).
- That network is **internal**: Docker gives it no route out. The listener creates it with
  `--internal`, checks it (`docker network inspect`) and refuses to start the run otherwise.
  Its subnet comes from Docker's address pools, or from `SANDBOX_SUBNETS` when set (a block
  no other network on the host uses, [Setup](setup.md#settings)): either way the network is
  internal, so the range changes addresses, not what a sandbox can reach. It must lie inside
  `10/8`, `172.16/12`, `192.168/16` or `100.64/10`: the listener refuses to start with
  another.
- The listener finds its own container by its host name (Docker's default: the container's
  id) and the proxy's by its `deckhand.role=egress` label in the same compose project
  (`LISTENER_CONTAINER`, `EGRESS_CONTAINER` to name them instead). A new listener joins
  both again to the running sandboxes' networks when it starts, and checks every minute
  (`docker compose up -d` recreates either without the networks it was joined to); networks
  of this deployment whose run is gone are removed then.
- The **egress proxy** (`proxy/proxy.mjs`, the `egress` service) is on every run's network
  and the outside one. Being on all of them, it is the only path between two runs: it
  connects to the hosts a run may reach only, and to a private address only for a host you
  list by name (below). It handles HTTP `CONNECT` (HTTPS, and anything tunnelled) and plain HTTP
  requests. For each one, it asks the listener whether the sandbox at that source address
  may reach that host; the listener matches the address to the running sandbox (`docker
inspect`) and answers from that run's list. Only the proxy may ask: the listener compares
  the caller with the proxy's addresses on all of its networks (`docker inspect`). An unknown address, an unknown host, or a
  listener that doesn't answer: refused, with a `403` saying why.
- The proxy resolves names itself and connects to the address it checked. Loopback,
  link-local (cloud metadata, `169.254.169.254`), `0/8`, multicast and reserved (`224/4` and
  up), IPv6 site-local (`fec0::/10`) and anything that isn't an IP address are always
  refused, and so is `198.18/15` (benchmarking); private ones (`10/8`, `172.16/12`,
  `192.168/16`, `100.64/10`, `fc00::/7`, NAT64's local-use `64:ff9b:1::/48`) only when the
  host is one you allow by name or `*.domain` in the grants folder, never through `*` alone. The same goes for any address in
  a subnet of the networks the proxy is on (read from its interfaces at each connection, so a
  run's network counts as soon as it is joined): other runs' sandboxes and engines, the
  listener, whatever range Docker gave those networks, a public one or a global IPv6 prefix
  included. IPv6 addresses are compared as bytes, and those standing for an
  IPv4 one (`::ffff:0:0/96`, `::ffff:0:0:0/96`, `::/96`, NAT64's `64:ff9b::/96`, 6to4's
  `2002::/16`) are checked as that IPv4 address, so `[::ffff:a9fe:a9fe]` is the metadata
  service too.
- The proxy keeps answers from the hosts you list in `cached_hosts`, and decrypts their
  HTTPS to do so (see [The egress cache](#the-egress-cache)). It also decrypts GitHub's hosts
  and those that carry the Antigravity CLI's token (for its runs only), and hands their
  requests to the listener, naming the sandbox they came from (see
  [The GitHub gateway](#the-github-gateway) and
  [The Antigravity CLI's login](#the-antigravity-clis-login)). Every other `CONNECT` stays a
  tunnel the proxy can't read.
- The listener forgets a sandbox's address as soon as it sees the sandbox exit, before
  posting its reply: Docker may give the address to another sandbox, which must not get the
  finished run's hosts.
- Sandboxes get `HTTP_PROXY`, `HTTPS_PROXY` (both cases), `NO_PROXY` (`localhost`, the
  listener) and `NODE_USE_ENV_PROXY=1`: without it, Node's `fetch` ignores the proxy (and
  fails, as nothing else goes out). The Playwright browser gets the proxy as flags. A tool
  that ignores proxy settings fails closed: it has no route out.

### The egress cache

Runs download the same packages again and again: `npm ci` from the npm registry,
`apt-get` from a Debian mirror, a toolchain from its release server. For the hosts you list
in `cached_hosts` (in `grants/default.yaml` and `grants/<owner>/<repo>.yaml`, added up like
`hosts`, with the same patterns), the egress proxy keeps the answers on disk, in the
`egress-cache` volume, and serves them to every run: plain HTTP, and HTTPS, which it
decrypts ([below](#https-and-deckhands-ca)). A repository's `.deckhand.yaml`
can't list them (one there is ignored, with a warning): the cache is shared by every run, so
only you say what goes in it. A host in `cached_hosts` must be reachable too (in `hosts`, or
mandatory): `cached_hosts` alone opens nothing.

- **What is kept**: only what is the same for anyone. A `GET` without a body
  (`Content-Length` over 0, any `Transfer-Encoding`, or `Expect`), `Cookie`, `Range` or a
  header whose name looks like a credential (with `auth`, `token`, `key`, `secret`,
  `password` or `credential` in it, or starting with `x-jfrog-`: `Authorization`,
  `Private-Token`, `X-Api-Key`…; npm's `npm-auth-type` and the proxy's own `Proxy-*` aside),
  answered `200` without `Cache-Control: private` or `no-store`, and within
  `EGRESS_CACHE_ENTRY_MAX`. Anything else is forwarded as before.
- **What reaches the host**: on the cache path, only `Accept`, `Accept-Encoding`,
  `Accept-Language` and `User-Agent` go on, with `Host`; to check a kept answer, its own
  `If-None-Match` and `If-Modified-Since`, never the client's. Any other header
  (`X-HTTP-Method-Override`, `X-Forwarded-Host`) is dropped, so it can't shape an answer kept
  for every repository. `Accept-Language` and `User-Agent` aren't in the key (see `Vary`
  below). A request the cache doesn't answer (one checking its own copy when nothing is
  kept, or one sending a header the kept answer varies on) goes on as it is, and its answer
  isn't kept.
- **Connections**: every request the proxy sends to a host, cached or not, gets a new
  connection, never reused: a request whose body a host doesn't read (request smuggling)
  can't put another URL's answer under a key.
- **Cookies and `Vary`**: a cookie the answer sets goes to that client only, never into the
  cache: the request had none, so the answer is the one anyone gets, and CDNs set theirs on
  everything (Cloudflare's `__cf_bm` on npm's registry). `Accept-Encoding` and `Accept` are
  part of the key, with the URL. An answer varying on another header (`Vary: Origin` on
  Alpine's mirror) is kept only when the request didn't send it, and served only to
  requests that don't either; one varying on `*` isn't kept.
- **Freshness**: the host's `Cache-Control` (`s-maxage`, `max-age`, `no-cache`), else its
  `Expires`, else a tenth of the time since its `Last-Modified` (a day at most), else none.
  A fresh answer is served from disk without asking the host; a stale one is checked with
  `If-None-Match` / `If-Modified-Since`, and a `304` serves it. A client's own
  `Cache-Control: no-cache` has it checked too. Each answer says how in an
  `x-deckhand-cache: hit | miss | revalidated` header.
- **Downloads**: the first one is streamed to the client while it is written to a temporary
  file, renamed into place once complete. A client that disconnects, a host that stops
  midway or a body over the per-entry limit leaves nothing behind.
- **Size**: `EGRESS_CACHE_MAX` (10 GB by default) counts the downloads being written too.
  One with a `Content-Length` reserves it as it starts, and the least recently used answers
  are removed to make room for it; one without makes room as it comes. Downloads under way
  take half of it at most (`EGRESS_CACHE_ENTRY_MAX` when that is more): a download read slowly, or dropped before its end, never evicts
  more than that, and one that finds no room goes on to its client without being kept. The
  bodies are counted, not their small metadata files, and a removed answer a client is still
  reading stays on disk until it is done: the volume can go past it by the answers being
  read then. That half holds at any one time: over time, a run that fetches many different
  URLs (a query string changed each time, say) can still push every other repository's
  answers out. The cache stays within its size, not its contents.
  `EGRESS_CACHE_MAX=0` turns the cache off
  ([Setup](setup.md#advanced-settings)).
- **Trust**: plain HTTP can be tampered with on the way, cached or not, and a cached answer
  then reaches every run. Cache only what the client checks itself (apt's signed indexes and
  their package checksums do) or hosts you would trust over plain HTTP anyway.

#### HTTPS and Deckhand's CA

HTTPS reaches the proxy as a `CONNECT` tunnel, which it can't read. For a host in
`cached_hosts` (and the relayed hosts: GitHub's, the Antigravity CLI's), and only then, the
proxy ends the client's TLS itself, with a certificate for that host signed by a CA of its
own, and serves the requests inside through the cache above (or hands them to the listener); what isn't served from it goes on to the host over TLS, which the proxy checks
against Node's trust store. Everything else keeps the raw tunnel, and the client sees the
real server's certificate.

- **The CA** is made by the proxy on its first start (the `openssl` CLI, in its image),
  in its volume (`ca/` in the `egress-cache` volume), and kept across restarts: a new
  volume is a new CA, which the next runs get. It lasts a year, and the proxy makes a new
  one a month before its end (and replaces one from before name constraints, or whose
  constraints still exclude GitHub, below, on its next start): sandboxes get it at their
  next start, and runs going on then lose their cached and relayed hosts' HTTPS (their
  certificates are the old CA's), GitHub's included, until their next run. Its key
  (`ca.key`) never leaves that volume; no sandbox, engine or listener mounts it. Its **name
  constraints** exclude the agents' providers (`anthropic.com`, `openai.com`, `chatgpt.com`
  and their subdomains): a certificate it signs for them fails verification, and the proxy
  never asks for one. Each host's certificate lasts 7 days, and is made again 2 days before
  its end. It exists with the cache off too (`EGRESS_CACHE_MAX` `0`): every run's GitHub
  calls need it.
- **Why GitHub is no longer excluded**: the CA must certify `github.com` and
  `api.github.com` for the proxy to relay them to the [GitHub gateway](#the-github-gateway).
  The exclusion kept a leaked CA key from opening live tokens; since the same change, no
  sandbox's traffic to GitHub carries one, only the run's secret, which works from its own
  sandbox, through the gateway, while the run lasts. A key that leaks lets its holder read
  and change the GitHub traffic of the sandboxes running then (what they read and write, as
  the proxy does), not act as them elsewhere. `githubusercontent.com` is certifiable too: only
  GitHub's content hosts are relayed, for a work run that isn't a fork's (they carry no
  token), and neither relayed nor decrypted for the others unless you cache them. The
  providers' names stay excluded: the operator's credentials still go there, from the
  listener.
- **Trust in the sandbox**: for every run that reaches GitHub (all but research runs), and
  when its repository's grant has `cached_hosts` or its agent's calls are relayed (the
  Antigravity CLI's), the listener
  asks the proxy for the CA's certificate (public, at `http://egress:3128/deckhand-ca.crt`)
  and puts it in the run's read-only inbox folder. The sandbox's entrypoint adds it to a
  bundle with the image's own roots, which `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE` and `PIP_CERT` point at, and to
  Chromium's store (`~/.pki/nssdb`, with `certutil`). A tool that reads none of them refuses
  cached hosts' certificates, and fails rather than going round the proxy. When the
  listener can't get the CA (the proxy doesn't answer), the run stops, saying so: it couldn't
  reach GitHub. (A research run, whose GitHub isn't relayed, then has no cached hosts, and
  an Antigravity CLI one on a plan stops.)
- **Never cached**, whatever `cached_hosts` says: the mandatory hosts below, the agent's and
  GitHub's (decrypted only to be relayed to the listener). Their traffic carries the run's
  secret, which the cache would refuse anyway. Nor a run's [container engine](#container-engine): its builds and
  containers don't trust the CA, so its connections keep the tunnel, and only plain HTTP is
  cached for them; caching in the engine itself is `docker: { cache: true }`'s.
- **An upstream certificate that doesn't verify** (expired, self-signed, for another name)
  is refused with a `502` saying so: the proxy never passes it on under its own CA. A
  private mirror whose CA isn't a public one can't be cached over HTTPS: leave it out of
  `cached_hosts`.
- A tunnel to a cached host that doesn't start with TLS (SSH on port 443, say) is passed on
  as is.

What this changes: the proxy now reads the requests and answers of the hosts you list in
`cached_hosts`, and holds a key that sandboxes trust for any host but those its name
constraints exclude. It stays acceptable because the proxy only uses it for the hosts you
listed, which are what you would cache anyway (public mirrors, without credentials: a
request with `Authorization`, `Cookie` or another credential-like header is sent on, never
kept); the key never leaves the proxy's volume, which neither sandboxes nor engines can
reach, and the proxy runs read-only, without capabilities; and a sandbox
trusting the CA gains nothing it could use: it reaches the same hosts as before, through
the same proxy. Someone who gets the key (from the host, or the proxy's volume) can
impersonate any other host to the sandboxes running then, for at most the CA's year, GitHub's
included (whose traffic from a sandbox carries no token), but not Anthropic's or OpenAI's
hosts (nor Google's, which the Antigravity CLI's runs relay, are excluded): treat the volume
like the listener's data. Removing the volume (or `ca/`
in it) and restarting the proxy makes a new CA.

### Where a sandbox's hosts come from

**Restricted by default**: a sandbox reaches the mandatory hosts (below) and the hosts you
grant its repository, nothing else. You list them in one place per scope, the grants
folder, read again at each run:

| For        | Where                                   | Read        |
| ---------- | --------------------------------------- | ----------- |
| every repo | the mandatory hosts (below)             | built in    |
| every repo | `hosts` in `grants/default.yaml`        | at each run |
| one repo   | `hosts` in `grants/<owner>/<repo>.yaml` | at each run |

They add up: a run of `acme/api` reaches the mandatory hosts, then `default.yaml`'s, then
`acme/api.yaml`'s. Nothing narrows them: a repository's `.deckhand.yaml` has no `hosts` (one
there is ignored, with a warning in the dashboard and the run's log), and a mode has no key
for them, so every run of a repository reaches the same hosts.

Each entry is a host name (`registry.npmjs.org`), `*.domain` (any subdomain, at any depth,
not the domain itself: list both if you need both), or `*` (anything). Any port. An IP
address or a name without a domain (`172.17.0.1`, `listener`) works too: you decide what sits
next to the sandboxes. Hosts you list may resolve to private addresses (`*` alone doesn't
count, see above).

Why not the repository: its `.deckhand.yaml` is written by whoever can push to its default
branch, and a run can open a pull request that someone merges. If its own `hosts` counted, a
sandbox could get its way out by changing that file. A repository says what it needs in its
docs or onboarding issue; you add it to its grants file. The proxy's `403`, the sandbox's
instructions and the dashboard's repository panel all name these files.

**Mandatory hosts**, always allowed:

| Host                      | For                                                                             |
| ------------------------- | ------------------------------------------------------------------------------- |
| `api.anthropic.com`       | Claude Code's runs only: WebFetch's domain check                                |
| `github.com`              | git over HTTPS (`GITHUB_URL`), relayed to the [gateway](#the-github-gateway)    |
| `api.github.com`          | `gh` and the API (`GITHUB_API`), relayed to the [gateway](#the-github-gateway)  |
| `*.githubusercontent.com` | raw and LFS files, diffs, release downloads, avatars (relayed for checked runs) |
| the listener              | the broker and the agent's API calls, directly                                  |

That list was checked against Claude Code 2.1.300 (the pinned version) by reading the hosts
in its binary. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (set in the image) and the
credential in `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN`, Claude Code sends its API calls to the listener (`ANTHROPIC_BASE_URL`,
see [The Claude credential](#the-claude-credential)) and nothing else but WebFetch's domain
check to `api.anthropic.com`:

- not `platform.claude.com`: it refreshes OAuth credentials stored by `/login`, which a
  sandbox doesn't use (`setup-token` tokens aren't refreshed);
- not `claude.ai` / `claude.com`: interactive login only;
- not the telemetry, error reporting and update hosts (Statsig, Sentry, Datadog,
  `downloads.claude.ai`): non-essential traffic, off.

Check it again when you change `CLAUDE_CODE_VERSION`. A refused host shows up in the
listener's logs (`Egress: refused <host> for <repo>#<n>`).

A Codex run's mandatory hosts are GitHub's and the listener only: no `api.anthropic.com`,
and no `api.openai.com` either. Checked against Codex 0.162.1 (the pinned `CODEX_VERSION`)
through a proxy that logged every connection: with its calls sent to the listener and the
settings `sandbox/agents/codex.sh` writes (analytics, update check, plugins, apps and remote
plugins off), it opens none. Without them it reaches `chatgpt.com`, `ab.chatgpt.com`,
`github.com` and `api.github.com` for its plugin marketplace and analytics. Its web search
runs on OpenAI's side, in the API call. Check it again when you change `CODEX_VERSION`.

An Antigravity CLI run's mandatory hosts are GitHub's, the listener, and `agy`'s own:
`daily-cloudcode-pa.googleapis.com` and `www.googleapis.com` (relayed to the listener, see
[The Antigravity CLI's login](#the-antigravity-clis-login)) and `antigravity-unleash.goog`
(feature flags) and `lh3.googleusercontent.com` (the account's avatar, which its eligibility
check needs). `play.googleapis.com` is refused for its runs, whatever the grants say. Checked against agy 1.4.0 (the pinned `AGY_VERSION`) through a proxy
that logged every connection; its update check is off (`AGY_CLI_DISABLE_AUTO_UPDATE`). Check
it again when you change `AGY_VERSION`.

### Not covered

- **A Podman engine** exposes much more of the host's kernel than a sandbox does: seccomp
  and AppArmor are off, so every system call (`keyctl`, `bpf` where unprivileged use is
  allowed, `userfaultfd`…) and mount is open to code running in it, as are `/dev/fuse` and
  `/dev/net/tun`. A kernel bug reachable that way is a way out of the container. Prefer
  Sysbox, and grant `allow_docker` only to repositories whose default branch you trust.
- **An engine's containers** run what the run builds, with the run's hosts: a repository's
  Dockerfile pulling from a host the run may reach can bring anything in, as its setup
  command can.
- **A fork's code in a work run** can still write to the agent's session (`~/.claude`,
  `~/.codex` or `~/.gemini`) of that run's issue, which its next work run starts with. What
  `.git` keeps besides hooks (objects, refs, the stash, and the branches' `remote` and
  `merge`), enough to make a branch of its own look like one of the repository's, stays in a
  fork's run's own clone (`-fork-workspace`), which only the issue's later fork's runs start
  from. It can also push the run's own branch, its pull request's commits included, which a
  repository granted `allow_branch_docker_images` builds and the issue's later work runs
  fetch as the repository's own. It ran with the same token
  and hosts as the run it would reach, one an allowed user asked for: read what a fork's pull
  request does before asking for work on it (see [What a fork's code may reach](#what-a-forks-code-may-reach)).
- **A fork's pull request only mentioned** (in an issue, or a comment from elsewhere: "check
  out #7 and fix it") isn't seen as a fork's run: the run gets the repository's caches,
  read-write mounts and engine, and the GitHub gateway refuses it the fork's code ([What a
  fork's code may reach](#what-a-forks-code-may-reach)). Not everything goes through the
  gateway, though: the run's container engine reaches GitHub anonymously, around it (the
  exception in [The GitHub gateway](#the-github-gateway)), so a build there can fetch a
  public fork; a `codeload.github.com` grant serves any public repository's archives; and the
  same code anywhere else (another repository, a gist, a package registry the run may reach;
  a granted host whose name leads to GitHub's content CDN, or another of GitHub's own hosts
  granted (`codeload.github.com`, `*.github.com`), whose front ends may answer for one another
  as the content CDN does: a tunnel to either would reach them unchecked; a granted host that
  fetches from GitHub for the sandbox by the repository's own name, as the Go module proxy
  does for `go get github.com/<owner>/<repo>@<sha>` or jsDelivr for `/gh/<owner>/<repo>@<sha>/`:
  GitHub serves a fork's commit through the repository's name, so such a host likely does
  too),
  or written as text (a pull request's description, a comment, a workflow's check-run
  summary), is no fork's tree to any check. Ask for work on a fork's pull request from that
  pull request.
- **Image builds** (a repo's `dockerfile`, with `allow_dockerfile`) and the **Claude Code
  install** run with normal network access: they run on the host's Docker, outside the
  sandboxes' networks. Builds run the repo's Dockerfile from its default branch (or its pull
  requests' branches with `allow_branch_docker_images`). A branch's image gets a tag of its
  own (`branch-…`, hashing its commit), so the default branch's runs and preview hooks never
  use an image built from a branch. A repo's image name and tags hash the repository too
  (`<prefix>-repo-<owner>-<repo>-<hash>`): repositories whose names read alike (`acme/x.y`,
  `acme/x-y`) never run, or prune, each other's image, nor do their preview hooks.
- **Preview hooks** (with `allow_preview`) run on Docker's default network with the Docker
  socket.
- **Deckhand's own source** is in every sandbox, read-only (`/usr/local/share/deckhand/src`,
  for onboarding: see [Onboarding](architecture.md#onboarding)), repo images built from the
  base image included: whoever can steer a run can read it. In a one-operator deployment
  those are the operator's own repositories and users, so it is accepted; it only matters
  while Deckhand's repository is private. It holds no secret: those are in the operator's
  settings and grants folder, never in the image. An image built from an operator's own
  checkout copies these folders as they are on disk: `.dockerignore` leaves out `.env`,
  `*.pem` and `*.key` files anywhere, but nothing else that isn't tracked.
- **DNS**: Docker's embedded resolver may forward lookups from the internal network to the
  host's resolvers, so a lookup of a made-up name could carry data out to that domain's DNS
  server.
- **The listener and the proxy are on every run's network**: a sandbox reaches the
  listener's two ports (below) and the proxy's, as every other sandbox does, but not the
  other sandboxes behind them.
- **Allowed hosts are trusted entirely**: anything a sandbox can write to on one is a way
  out: its own repository on GitHub, a bucket or paste service behind `*`.
- **A research run allows every public host**: everything it holds can leave, so it holds
  little (see [Research runs](#research-runs)), but what it does hold can: the issue's
  thread, what it read on the web, and what the agent's provider sends back. Don't grant
  `allow_research` to a repository whose issues hold what must not leave.
- The listener's own port (8080: dashboard, webhook) is reachable from sandboxes; it needs
  a dashboard session (a signed-in allowed user, see [Setup](setup.md#4-the-dashboard)) or
  the webhook's signature. `/status` also answers calls from inside the listener's container
  (see [The dashboard](#the-dashboard)).
  Deliveries without a signature or over 5 MB are refused before their body is read (a push
  that large only delays a config's refresh). At most 16 are read at once, 4 per client
  address (per /64 for IPv6), each within 10 seconds and dropped after 2 seconds without
  data. A reader older than a second loses its place to a new delivery when its address's
  share, or the listener, is full: GitHub sends a body in milliseconds. When the listener is
  full of younger readers, a delivery from an address holding fewer places than another takes
  the oldest place of the address holding the most, so a few clients reopening stalled bodies
  can delay deliveries but not keep them out. Behind a reverse proxy every delivery has the
  proxy's address, so they all share those 4 places: restrict `/webhook` to GitHub's `hooks`
  ranges (`https://api.github.com/meta`) at the proxy, and let it buffer request bodies, to
  keep slow clients away from the listener.
