# Security model

Sandboxes run Claude Code without permission prompts, on issues anyone may have written.
Deckhand assumes that whatever runs inside one may try to read what it shouldn't or send it
out, and limits what it can reach: GitHub tokens for its own repository only (see
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

- Sandbox tokens only **read** the code (`contents: read`). They can't push, write files
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
  - light runs (brainstorms, onboarding, inbox entries, discussions, a repo's light modes):
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
- Marking a pull request ready for review, or back to draft, also takes `contents: write`
  for an App's token (GitHub's `markPullRequestReadyForReview` and
  `convertPullRequestToDraft`). The sandbox's `gh` wrapper sends `gh pr ready [--undo]` to
  the listener instead (`POST /pr/<owner>/<repo>/<number>/ready` or `/draft` on the
  broker's port, `listener/pr-ready.mjs`), with the run's secret. The listener checks that
  the run is live and a work run, that the pull request belongs to the run's repository,
  that its head branch is in that repository too (not a fork) and is one the run may push
  (above): another task's pull request is refused. Then it calls
  that one mutation with a token of its own, which the sandbox never sees. That token does
  nothing else. A pull request that conflicts with its base (`mergeable_state: dirty`) is
  refused ready with a 409 until the run rebases it.

This doesn't depend on GitHub: branch protection and rulesets aren't enforced on private
repositories of free plans. Where they are, a ruleset on the default branch (pull request
required) is still worth adding: it also covers people and other tools. A sandbox's
branches still reach the default branch through pull requests that a maintainer merges:
review those that touch `.deckhand.yaml`, the Dockerfile or the preview hook's script.

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

The workflow files themselves can't change: neither the sandbox's token nor the gateway's
has the `workflows` permission, so GitHub refuses a push that adds or edits one. What they
run can.

This is GitHub's model for any tool or person that pushes branches, not something Deckhand
changes: your workflows are yours to set up. On each repository the App is installed on:

- set **Settings → Actions → General → Workflow permissions** to "Read repository contents
  and packages permissions" (or the organization's default), and give `contents: write`
  only to workflows that don't run a branch's code;
- keep deploy and publishing secrets out of `push` and `pull_request` workflows that run on
  any branch: put them in an
  [environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
  with required reviewers, or limit those workflows to the default branch;
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
the broker then refuses it. The installation tokens a sandbox already got are another matter:

- GitHub makes them valid for **one hour** from when they are minted, and the listener can't
  shorten that. The broker hands out a cached token while it has more than 10 minutes left,
  so a token a sandbox fetched stays valid for up to an hour, including after its run ended.
- Tokens are cached per repository and permission set, and shared by that repository's runs
  with the same permissions: a run may get the very token another run of the same repository
  got before.
- A token only reaches the run's repository, with the sandbox's permissions: it reads the
  code, can't push (pushes go through the gateway, with the run's secret), and can write
  issues and, for work runs only, pull requests (and discussions, for discussion runs)
  there. Onboarding and a repo's light modes only read issues and pull requests.

So what a run copied out (through an allowed host) can be used against its own repository,
with those permissions, for up to an hour. Uninstalling the App, or suspending its
installation, revokes its tokens at once.

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
  it, as `[redacted]`. Only the exact value: an encoded or split one gets through, which is
  why the credential isn't there to begin with.

Codex's `OPENAI_API_KEY` is kept out the same way (`listener/openai.mjs`): a sandbox's Codex
has `<broker>/openai` as its provider's base URL and the run's secret as its key, sent as
`Authorization: Bearer`; the listener checks it, puts your key in its place and forwards the
call to OpenAI (or the operator's `OPENAI_BASE_URL`), under its base path only: a path with
`//host`, a scheme or `..` is refused, so the key can't be sent elsewhere. Both agents'
credentials are redacted
from every run's log and reply, whichever agent ran.

## Mounts

A sandbox only gets Docker named volumes:

| Volume                                               | What                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `<prefix>-<owner>-<repo>-<n>-<hash>-workspace`       | the issue's clone, kept between its runs                          |
| `<prefix>-<owner>-<repo>-<n>-<hash>-claude`          | the issue's Claude session                                        |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-workspace` | the clone of the issue's light runs                               |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-claude`    | the Claude session of its light runs                              |
| `deckhand-claude-code`, **read-only**                | Claude Code, installed by the listener                            |
| `deckhand-cache-<owner>-<repo>-<path>-…`             | the repo's `caches`, its own                                      |
| `deckhand-screenshots`, **its run's folder only**    | screenshots, served under `/shots/<folder>/` (regular files only) |
| `deckhand-runs`, **its run's folder, read-only**     | its inbox: comments that arrive mid-run                           |

`<hash>` (10 hex digits of the repository and task) keeps apart names that would otherwise
be the same, such as `acme/x` pull request 5 and `acme/x-pr` issue 5. Tasks whose session
dates from before it (`<prefix>-<owner>-<repo>-<n>-claude` exists) keep that name and their
volumes, but only when one of the task's own runs had that name (its log is in `logs/`):
otherwise a new task could take over the session and workspace of another repository's task
whose old name is the same.

Light runs (brainstorms, onboarding, inbox entries, discussions, the repo's light modes) read
and comment; work runs push. The git gateway and `gh pr ready` refuse light runs, and their
tokens can't write pull requests. They never share a writable volume: what a light run could
leave in a clone or a session (git hooks, Claude's hooks and settings, code) would otherwise
run in the issue's next work run, with its token. So light runs get their own `-light-` clone and
session, no cache volumes (they run no setup), and granted host paths read-only. A work run
after a brainstorm starts a new session, from the issue and its comments.

Each run mounts only its own folder of the screenshots volume (`volume-subpath`, Docker
Engine 26 or later), named with 24 random hex digits: it can't list or read another run's.
The listener serves only the regular files of that folder: a symbolic link (opened with
`O_NOFOLLOW`), a hard link or a path that resolves elsewhere is a 404, so a run can't link
`/screenshots/a.png` to the listener's own files (`app.json`, its private key).
Its inbox folder is mounted the same way, read-only: the listener writes the comments
delivered to the run there (a file rather than the container's stdin, so a run outlives a
listener restart).

The Claude Code volume is shared by every repository, so it is read-only in sandboxes: a run
that could replace `claude` there would run its code in the next sandbox of any repository,
with that run's broker secret and grants. The listener installs each version before the
first run that needs it, as root, so its files don't belong to the sandboxes' user, uid
1000, either. An install that finds the volume owned by uid 1000 (from an older Deckhand)
takes it over and reinstalls from npm rather than keep what a sandbox could have changed. A
sandbox whose version isn't installed stops with a message instead of installing it.

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
A read-write request under a read-only root is mounted read-only (noted in the run's log). Paths the sandbox uses itself (`/workspace`, `/home/node/.claude`, `/opt/claude-code`,
`/screenshots`) and the repo's `caches` can't be mount targets. Paths are limited to
letters, digits and `./@+-_`.

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
# Its own limits; missing ones keep default.yaml's, else the built-in 2 CPUs, 4g, 2048.
limits: { cpus: 4, memory: 8g, pids: 4096 }
# Roots it may mount from (read-only unless read_only: false).
mounts:
  - root: /nfs/work
    read_only: false
  - /srv/datasets
```

`default.yaml` takes the same keys but `mounts` and `allow_docker`, for every repository:

```yaml
# default.yaml
# The yes-or-no grants (all false by default); a repository's own file overrides each one.
allow_dockerfile: false
# Hosts every repository's sandboxes may reach, added to its own file's.
hosts: [pypi.org]
# Every sandbox's limits, over the built-in 2 CPUs, 4g and 2048 processes; a repository's
# own file overrides each one.
limits: { memory: 8g }
```

`mounts` and `allow_docker` in `default.yaml` are errors: a root or a container engine for
every repository is too broad to grant by accident, so they are granted one repository at a
time.

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

Run logs (`logs/<run>.log`) have the Claude credential and the run's secret redacted (see
[The Claude credential](#the-claude-credential)).

## The dashboard's actions

The dashboard is read-only but for two kinds of POST: starting a repository's onboarding
(`/api/repos/<owner>/<repo>/onboard`) and the graph's work area
(`/api/repos/<owner>/<repo>/work`, `listener/work.mjs`), which starts an issue, queues it
after another (`/after #n`), moves its wait or cancels it (`/after none`), or stops a
brainstorm (`/stop`, refused unless it is active or idle). The work area
starts runs, so it is checked as a comment that waited is (`tasks.resume()`), at each request:

- a signed-in dashboard session, and an `Origin` header naming this listener (its
  `PUBLIC_URL`, or the host the browser asked for): a page elsewhere can't post for a
  signed-in user, on top of the session cookie's `SameSite=Lax`;
- the repository in `ALLOWED_REPOS` (when set) and the App installed on it;
- its `.deckhand.yaml` on the default branch without errors, and a mode it has;
- the user in both `ALLOWED_USERS` and the repository's own `users`;
- an open issue, not a pull request, with no run going or queued (a running issue doesn't
  move), and no wait that would loop back to it.

Each action is written on the issue as the App's comment ("Started from the dashboard by
@alice"), so the issue's history says who started what, as a trigger comment would. The
App's comments are ignored as triggers, so the listener queues or holds the work itself
rather than through a webhook. The backlog (`GET /api/repos/<owner>/<repo>/issues`) lists a
repository's open issues to signed-in users in its `users` (all of them while its config has
errors), from GitHub at most once every 30 seconds per repository.

A failed run's Rerun (`POST /api/repos/<owner>/<repo>/rerun`) passes the same checks, for
the run's issue or pull request, and only for the task's latest run when it ended in `error`
or `interrupted`: it queues the comments that run had already been allowed to act on, as the
signed-in user's, and posts the App's comment saying who asked.

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
  internal, so the range changes addresses, not what a sandbox can reach.
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
  link-local (cloud metadata, `169.254.169.254`), multicast and unspecified addresses are
  always refused, and so is `198.18/15` (benchmarking); private ones (`10/8`, `172.16/12`,
  `192.168/16`, `100.64/10`, `fc00::/7`) only when the host is one you allow by name or
  `*.domain` in the grants folder, never through `*` alone. IPv6 addresses are compared as bytes, and those standing for an
  IPv4 one (`::ffff:0:0/96`, `::ffff:0:0:0/96`, `::/96`, NAT64's `64:ff9b::/96`, 6to4's
  `2002::/16`) are checked as that IPv4 address, so `[::ffff:a9fe:a9fe]` is the metadata
  service too.
- The listener forgets a sandbox's address as soon as it sees the sandbox exit, before
  posting its reply: Docker may give the address to another sandbox, which must not get the
  finished run's hosts.
- Sandboxes get `HTTP_PROXY`, `HTTPS_PROXY` (both cases), `NO_PROXY` (`localhost`, the
  listener) and `NODE_USE_ENV_PROXY=1`: without it, Node's `fetch` ignores the proxy (and
  fails, as nothing else goes out). The Playwright browser gets the proxy as flags. A tool
  that ignores proxy settings fails closed: it has no route out.

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

| Host                      | For                                              |
| ------------------------- | ------------------------------------------------ |
| `api.anthropic.com`       | Claude Code's runs only: WebFetch's domain check |
| `github.com`              | git over HTTPS (`GITHUB_URL`)                    |
| `api.github.com`          | `gh` and the API (`GITHUB_API`)                  |
| `*.githubusercontent.com` | raw files, release downloads, avatars            |
| the listener              | the broker and the agent's API calls, directly   |

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

### Not covered

- **A Podman engine** exposes much more of the host's kernel than a sandbox does: seccomp
  and AppArmor are off, so every system call (`keyctl`, `bpf` where unprivileged use is
  allowed, `userfaultfd`…) and mount is open to code running in it, as are `/dev/fuse` and
  `/dev/net/tun`. A kernel bug reachable that way is a way out of the container. Prefer
  Sysbox, and grant `allow_docker` only to repositories whose default branch you trust.
- **An engine's containers** run what the run builds, with the run's hosts: a repository's
  Dockerfile pulling from a host the run may reach can bring anything in, as its setup
  command can.
- **Image builds** (a repo's `dockerfile`, with `allow_dockerfile`) and the **Claude Code
  install** run with normal network access: they run on the host's Docker, outside the
  sandboxes' networks. Builds run the repo's Dockerfile from its default branch (or its pull
  requests' branches with `allow_branch_docker_images`). A branch's image gets a tag of its
  own (`branch-…`, hashing its commit), so the default branch's runs and preview hooks never
  use an image built from a branch.
- **Preview hooks** (with `allow_preview`) run on Docker's default network with the Docker
  socket.
- **DNS**: Docker's embedded resolver may forward lookups from the internal network to the
  host's resolvers, so a lookup of a made-up name could carry data out to that domain's DNS
  server.
- **The listener and the proxy are on every run's network**: a sandbox reaches the
  listener's two ports (below) and the proxy's, as every other sandbox does, but not the
  other sandboxes behind them.
- **Allowed hosts are trusted entirely**: anything a sandbox can write to on one is a way
  out: its own repository on GitHub, a bucket or paste service behind `*`.
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
