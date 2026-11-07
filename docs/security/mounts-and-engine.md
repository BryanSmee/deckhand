# Mounts and the container engine

What a sandbox gets on disk, how it is confined, and the container engine a run may have beside it. Part of the [Security overview](../security.md).

## Mounts

A sandbox only gets Docker named volumes:

| Volume                                                          | What                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `<prefix>-<owner>-<repo>-<n>-<hash>-workspace`                  | the issue's clone, kept between its runs                                                                |
| `<prefix>-<owner>-<repo>-<n>-<hash>-fork-workspace`             | the clone of its fork's runs (see [What a fork's code may reach](forks.md#what-a-forks-code-may-reach)) |
| `<prefix>-<owner>-<repo>-<n>-<hash>-<agent>`                    | the issue's agent session (`~/.claude`, `~/.codex`, `~/.gemini`)                                        |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-workspace`            | the clone of the issue's light runs (modes with volumes of their own)                                   |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-<agent>`              | the agent session of its light runs                                                                     |
| `<prefix>-<owner>-<repo>-<n>-<hash>-light-push-workspace`       | the clone of its light runs the policies give `push` (and their `-light-push-<agent>`)                  |
| `<prefix>-<owner>-<repo>-<n>-<hash>-research-…`                 | a research run's own (see [Research runs](policies.md#research-runs))                                   |
| `<prefix>-claude-code`, `-codex`, `-antigravity`, **read-only** | the run's agent, installed by the runner                                                                |
| `<prefix>-cache-<owner>-<repo>-<path>-<hash>`                   | the repo's `caches`, its own                                                                            |

`<agent>` is the run's agent (`claude`, `codex`, `antigravity`), and `<prefix>` the
deployment's `NAME_PREFIX` (`deckhand` by default).

`<hash>` (10 hex digits of the repository and task) keeps apart names that would otherwise
be the same, such as `acme/x` pull request 5 and `acme/x-pr` issue 5. Tasks whose session
dates from before it (`<prefix>-<owner>-<repo>-<n>-claude` exists) keep that name and their
volumes, but only when one of the task's own runs had that name (its log is in `logs/`, so
not once retention removed them all):
otherwise a new task could take over the session and workspace of another repository's task
whose old name is the same.

Light runs (the built-in modes with volumes of their own: brainstorms, onboarding, inbox
entries, discussions, analyses, reviews, research) read and comment (brainstorms, inbox entries
and discussions also create issues); work runs push. What each run gets and writes is its
[capabilities](policies.md#capabilities) and the [policies](policies.md#policies)', whatever its mode: Deckhand's
defaults give light runs neither `push` nor `setup` nor a pull request write, so the git gateway
refuses them. They never share a writable volume with work runs: what a light run could leave in
a clone or a session (git hooks, Claude's hooks and settings, code) would otherwise run in the
issue's next work run, with its token. So light runs get their own `-light-` clone and session
(`-light-push-` when the policies give one `push`; research runs `-research-`), no cache volumes without `setup`, and
granted host paths read-only without `push`. A work run after a brainstorm starts a new session,
from the issue and its comments. A repository's own modes share the issue's volumes, as their
capabilities pick them.

### Host mounts

A host path reaches a sandbox only when **both** sides agree:

1. **You** grant the repository a root in its grants file ([The grants folder](policies.md#the-grants-folder)), read-only unless you say
   `read_only: false`.
2. **The repository** asks for a path under it in its `.deckhand.yaml`:

   ```yaml
   mounts:
     - path: /nfs/work/api
       read_only: false # default true
     - /nfs/work/docs # read-only
   ```

At each run, the orchestrator resolves each requested path (and the runner again) with `realpath` (`..` and every
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
`/workspace`, `/tmp/screenshots` and `/tmp/deckhand` (the run's screenshots and files, kept
in its own filesystem), and each agent's session and
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
owner and group the orchestrator sees. Read-only requests aren't checked this way, so a path
under a directory some sandbox can write could still be swapped in the moment between the
last check and the mount; grant read-write roots that don't hold your read-only ones. A
process outside Deckhand that can write the root can always redirect a mount. If uid 1000 is
also your own user on the host, the directories you own count as writable by sandboxes.
Directories above a root are checked as the orchestrator's container sees them (Docker makes
its `/nfs` root's, whatever the host's is): a sandbox only writes the host's through a granted
root, which the orchestrator sees at the same path, so mount every root into the orchestrator.

**The orchestrator and the runner must see each root**, at the same path, to resolve what is
asked: mount it into both read-only in `compose.yaml` (`- /nfs/work:/nfs/work:ro`). A root they
can't see grants nothing.

## Hardening

Every sandbox runs:

- as `node` (uid 1000), with `--user 1000:1000` whatever the image's `USER` says (a repo
  or branch image ending in `USER root` still runs as uid 1000), `--cap-drop ALL` and
  `--security-opt no-new-privileges`;
- with `--cpus`, `--memory` (and as much `--memory-swap`: no swap on top) and
  `--pids-limit`: `limits` in the repo's grants file, else in `default.yaml`, else 2 CPUs,
  `4g` and 2048 processes.

The containers the runner starts around runs get the same treatment where they can: the
Claude Code install runs as root with only `CHOWN` (to take over an older volume); the one
that hands a new cache volume to uid 1000 keeps only `CHOWN`, without network.

The Docker socket is the runner service's alone ([The runner service](services.md#the-runner-service)).
Neither edge, the orchestrator, nor
any sandbox, nor a container engine gets it. Image builds only run for repositories granted
`dockerfile`.

**Optional: a socket proxy.** The runner only uses the docker CLI, so it can talk to a
socket proxy (for example `tecnativa/docker-socket-proxy`) through `DOCKER_HOST` instead of
the socket itself. It needs: `CONTAINERS`, `IMAGES`, `BUILD`, `VOLUMES`, `NETWORKS`, `POST`
and `DELETE` (`docker run`, `ps`, `logs`, `inspect`, `wait`, `rm`, `cp`, `build`, `image ls/rm`,
`volume create/inspect/ls/rm`, `network create/inspect/connect/disconnect/ls/rm`, and `info`
with a container engine).

### Output

A run's output can't stop the orchestrator, nor fill a data volume:

- A line of output is cut at 1 MB (`… (line cut)` at its end), and the rest of it dropped up
  to its newline. A line the orchestrator fails to handle (a full disk, say) is lost, not the
  orchestrator.
- A run's log holds at most `RUN_LOG_MAX_MB` (200 MB by default, and never unlimited) of the
  sandbox's output. Past it, nothing more of it is written: the sandbox is stopped and the
  run fails, with a note in its log and a reply saying why. The orchestrator's own lines (a few
  notes) are still written. A restarted orchestrator counts what the log already holds, and
  stops the sandbox again if it still runs.

The cap is per run: the logs together can take up to that much for each run kept, until
`LOG_RETENTION_DAYS`.

## Container engine

A run whose repository the operator's policies grant `docker` ([the grants](policies.md#the-grants), one
repository at a time), whose
`.deckhand.yaml` asks for `docker`, and for which the operator set `SANDBOX_ENGINE`, gets a
second container next to its sandbox: an engine serving Docker's API
([Container engine](../guides/container-engine.md)). The sandbox keeps everything above (uid 1000, no
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
  [Not covered](not-covered.md#not-covered).
- **Its limits** are the repository's (`limits` in its grants, else the built-in ones), on top of
  the sandbox's: a run can use twice its limits, half in each container.
- **Its network** is the run's: internal, with the sandbox and the proxy. Its
  address counts as the sandbox's for the egress proxy, so its pulls, its builds' steps and
  its containers reach only the run's hosts, through the proxy (by address: its containers
  can't resolve names on the run's network). Its containers have no other route out.
- **Its API** (`tcp://engine:2375`) has no TLS and no authentication: only the run's own
  network reaches it, and whatever can reach it (the sandbox, the containers it started) is
  the run's own code anyway.
- **Who gets one**: a run the policies give the `docker` [capability](policies.md#capabilities):
  Deckhand's defaults give it to work runs and a repository's own modes (with its own allow
  rule), never to light runs (brainstorms, inbox entries, discussions…). A run with a comment
  from a fork's pull request never does, whatever its grant: a fork's code never runs in an
  engine.
- **Clean-up**: the engine and its run's volume carry the `deckhand.engine` label (not
  `deckhand.run`: an engine is never taken for a sandbox). They go with the run, and the
  orchestrator's check every minute removes those whose run is gone, after a restart too.

On Kubernetes ([kubernetes.md](../kubernetes.md#container-engine-on-kubernetes)), Sysbox alone, and the
sandboxes' namespace stays Pod Security `restricted`:

- **A sidecar in the sandbox's pod**, under Sysbox's RuntimeClass, the pod in a user namespace
  of its own (`hostUsers: false`): `dockerd` runs as root there, an unprivileged user on the
  node, which `restricted` allows from Kubernetes 1.35. Every container's spec keeps the rest of
  it (no privilege gain, every capability dropped, `RuntimeDefault` seccomp), but Sysbox
  applies its own: root in the pod gets its capabilities inside the pod's user namespace, and
  every container of the pod, **the sandbox's included**, runs under Sysbox's syscall filter
  instead of the runtime's default profile (it allows `mount`, `unshare`, `setns`, `keyctl`…,
  which Sysbox traps or confines to the pod). What contains the sandbox there is the pod's user
  namespace, its user (uid 1000) and its having no capability, more than its syscall filter;
  `no-new-privileges` holds on `dockerd` and on all it starts (setuid programs fail in its
  containers). Podman, whose seccomp is unconfined, is refused.
- **No process namespace shared** between the pod's containers, as Sysbox advises: the sandbox
  sees none of the engine's processes, and its entrypoint reaps its own orphans.
- **Its storage** is an `emptyDir`, gone with the pod, at most `KUBERNETES_ENGINE_SIZE`: no
  cache kept between runs.
- **Its address is the sandbox's**: its API listens on the pod's loopback alone
  (`engine` is `127.0.0.1` in the pod), so nothing outside the pod reaches it: not even its
  node, which a NetworkPolicy always lets in. It goes out on the egress
  proxy's engines' port (3129), and so do the containers it runs (the sandbox's docker CLI
  config): the proxy asks the orchestrator with that port's flag, and the orchestrator answers
  as for an engine on Docker (the run's hosts, never decrypted, GitHub tunnelled, or sent on by
  the proxy for an absolute-form `https://` request (see
  [HTTPS and Deckhand's CA](network.md#https-and-deckhands-ca)), without the run's identity), only for a run that has an engine; a run without one, a build or an install
  is refused there. What the sandbox could reach through that port is what it could already
  reach through its engine.
