# Fork pull requests

A fork's code is anyone's: what it may reach when an allowed user asks for work on its pull request. Part of the [Security overview](../security.md).

## What a fork's code may reach

Anyone can open a pull request from a fork, and an allowed user may ask for work on it: a
comment on it, or on another of the issue's pull requests, triggers a run whose code then
runs the fork's, through its setup, tests or the agent. Such a run is a fork's run (the
orchestrator looks up each pull request the run's comments came from), and must not reach what
the repository's later runs trust and execute:

- **Container engine**: none, whatever the grant (see [Container engine](mounts-and-engine.md#container-engine)).
- **Caches**: none. A `postinstall` could otherwise leave a tampered package in the
  repository's `~/.npm` volume, which every later work run, on any issue, installs from with
  push access. The run's log says "No caches: a pull request from a fork".
- **Host mounts**: read-only, as for a run without `push` (the log's `Host mount` lines say so).
- **Branch images**: never built from a fork's branch (the `branch_docker_images` grant).

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
  included with the `workflows` grant.

So the [GitHub gateway](github.md#the-github-gateway) refuses a work run that isn't a fork's what would
bring a fork's code (`listener/github-forks.mjs`), reading it included: it can't tell reading
from running. A fork's run, and a run whose capabilities are reads only (no caches, read-only
mounts, no engine, no push), fetch as before. The run's log notes each refusal, and the refusal says why, and that a
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
  and the orchestrator's too.
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
  the `workflows` grant keeps ([GitHub Actions on Deckhand's branches](github.md#github-actions-on-deckhands-branches)), now for
  every repository whose work runs push: a copy of each in the data volume (`git-mirrors/`),
  whose first fetch is a whole clone. A fork's run may push its pull request's commits to its
  branch, as before, unless they change a workflow and the repository isn't granted
  `workflows` ([Without the grant](github.md#without-the-grant)): from then on they are the
  repository's, which the issue's later work runs start from (see [Not covered](not-covered.md#not-covered)).
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
  [Not covered](not-covered.md#not-covered)).

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
  (always, for a run without `push`); `draft-pr.sh` goes back to the issue's branch on the same
  condition. Untracked and ignored files go (`git clean -ffdx`), after a work run's
  uncommitted changes are stashed (`git stash`). Stale worktrees are pruned first, so one
  can't keep a branch from being checked out. The agent is told where the clone was and
  what was stashed, and checks them out again if it needs them, once it has read them.
- Reviews read a pull request in a `git worktree` under `/tmp`, gone with their container, so
  the `-light-` clone never holds a fork's tree.

What it can still reach is in [Not covered](not-covered.md#not-covered).

No volume of the orchestrator's (or edge's) is mounted (#393). A run's files go through the broker
service ([Run files](../architecture.md#run-files)), with the run token, which works
from its own sandbox only ([Run tokens](tokens.md#run-tokens)), and only for its own run's files:

- **Its inbox** (the comments delivered to it), **the egress proxy's CA and its digest**: read
  only, from the broker's store (rather than the container's stdin, so a run
  outlives an orchestrator restart). Another run's token, or one sent from another sandbox, gets
  `403`; none, or a finished run's, `401`.
- **Its screenshots**: uploaded into its own folder at the broker, named with
  24 random hex digits, which it can't list. The broker takes each file after
  checking it: a name `GET /shots` serves (`[\w.-]+` with `.png`, `.jpg`, `.jpeg` or `.webp`),
  content starting the way that type does (so no HTML is served as an image), at most 10 MB a
  file and 100 MB a run. It writes it once into blob storage (one PUT, or one blob of its
  store), so `/shots` (edge's, from the broker) never serves half a file. A research run has no
  folder: refused. The folders an orchestrator of a release before #609 kept are moved to the
  broker at its start, regular files only (no symbolic or hard link, nothing resolving
  elsewhere, each checked again as an upload is): folders from before #393 were written by
  sandboxes.

Each agent's install volume (Claude Code's, Codex's, the Antigravity CLI's) is shared by
every repository, so it is read-only in sandboxes: a run that could replace `claude` there
would run its code in the next sandbox of any repository, with that run's tokens and
grants. The runner installs each version before the first run that needs it, as root, so
its files don't belong to the sandboxes' user, uid 1000, either. A Claude Code install that
finds the volume owned by uid 1000 (from an older Deckhand) takes it over and reinstalls from
npm rather than keep what a sandbox could have changed. A sandbox whose version isn't
installed stops with a message instead of installing it. On Kubernetes, whose Pod Security
`restricted` allows no root, the install runs as uid 1001 instead (a pod of its own into a
shared claim, or each sandbox's init container into an `emptyDir`): still not the sandboxes'
user, and the sandbox mounts it read-only all the same. Through the egress proxy, it reaches
its agent's install hosts only, tunnelled; an init container gets them only while its pod is
Pending, never the run's own hosts, and the sandbox never gets them
([Agents on Kubernetes](../kubernetes.md#agents-on-kubernetes)).

What is installed is pinned: Claude Code and Codex by their npm version, the Antigravity CLI
by the sha256 of its release's tarball (`AGY_SHA256`, the operator's setting, not the
release's own digest, which comes from where the tarball does): a tarball that doesn't match,
or a version without a sha256, isn't installed. npm agents install with `--ignore-scripts`,
then only the agent's own package runs its install script, not its dependencies'. Those
dependencies' versions aren't locked: they are what npm resolves at install time.

No host path is ever mounted by default: no `~/.ssh`, `~/.gitconfig`, Docker socket or
source tree.
