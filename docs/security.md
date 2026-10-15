# Security model

Sandboxes run Claude Code without permission prompts, on issues anyone may have written.
Deckhand assumes that whatever runs inside one may try to read what it shouldn't or send it
out, and limits what it can reach: GitHub tokens for its own repository only (see
[Setup](setup.md#how-sandboxes-reach-github)), no pushes to its default branch, no host
paths unless you grant them, a restricted network, and no privileges.

## The default branch

Deckhand trusts a repository's default branch: its `.deckhand.yaml` (hosts, the preview
hook, which runs with the Docker socket, the Dockerfile built on the host), its sandbox
instructions. A sandbox that could write to it could grant itself all of that, so none can:

- Sandbox tokens only **read** the code (`contents: read`). They can't push, write files
  through the API or merge a pull request, whatever the repo's settings.
- Pushes go through the listener's **git gateway** (`listener/git-gateway.mjs`), on the
  broker's port: the sandbox's git sends them there (`url.<broker>/git/.pushInsteadOf`),
  with the run's secret. The gateway reads the ref updates at the start of the push and
  forwards it to GitHub with a token of its own only when every one is a branch other than
  the default one, looked up from GitHub on each push (case-insensitively). Tags, the
  default branch (update, force or delete), signed and compressed pushes are refused, and
  the refusal shows in git's output as `[remote rejected] … (Deckhand: …)`. A run whose token
  can't write pull requests (onboarding, a repo's light modes) can't push at all.
- The sandbox's `pre-push` hook only gives an earlier, clearer message: the gateway doesn't
  rely on it.

This doesn't depend on GitHub: branch protection and rulesets aren't enforced on private
repositories of free plans. Where they are, a ruleset on the default branch (pull request
required) is still worth adding: it also covers people and other tools. A sandbox's
branches still reach the default branch through pull requests that a maintainer merges:
review those that touch `.deckhand.yaml`, the Dockerfile or the preview hook's script.

## Mounts

A sandbox only gets Docker named volumes:

| Volume                                            | What                                         |
| ------------------------------------------------- | -------------------------------------------- |
| `<prefix>-<owner>-<repo>-<n>-workspace`           | the issue's clone, kept between its runs     |
| `<prefix>-<owner>-<repo>-<n>-claude`              | the issue's Claude session                   |
| `deckhand-claude-code`, **read-only**             | Claude Code, installed by the listener       |
| `deckhand-cache-<owner>-<repo>-<path>-…`          | the repo's `caches`, its own                 |
| `deckhand-screenshots`, **its run's folder only** | screenshots, served under `/shots/<folder>/` |
| `deckhand-runs`, **its run's folder, read-only**  | its inbox: comments that arrive mid-run      |

Each run mounts only its own folder of the screenshots volume (`volume-subpath`, Docker
Engine 26 or later), named with 24 random hex digits: it can't list or read another run's.
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

1. **You** grant the repository a root in the grants file (below), read-only unless you say
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
The sandbox mounts the resolved path rather than the one asked for, so changing the
requested symlink after the check doesn't redirect the mount. A read-write request under a read-only root is mounted read-only (noted in the run's
log). Paths the sandbox uses itself (`/workspace`, `/home/node/.claude`, `/opt/claude-code`,
`/screenshots`) and the repo's `caches` can't be mount targets. Paths are limited to
letters, digits and `./@+-_`.

**The listener must see each root**, at the same path, to resolve what is asked: mount it
into the listener read-only in `compose.yaml` (`- /nfs/work:/nfs/work:ro`). A root it can't
see grants nothing.

## The grants file

What you give a repository beyond what every sandbox gets lives in `GRANTS_FILE`
(`/etc/deckhand/grants.yaml` in the listener; mount it from the host, see `compose.yaml`).
It is optional and read again at each run, so an edit applies without a restart. A file
with errors grants nothing: the listener won't start, and runs started after a broken edit
stop (the details are in the listener's logs, not on GitHub).

```yaml
# grants.yaml: one key per repository (owner/repo), and "*" for every repository
"*":
  # The hosts in each repo's own .deckhand.yaml count (default: false). The only key "*"
  # takes: hosts and limits for every repo are ALLOWED_HOSTS and SANDBOX_*.
  allow_repo_hosts: false
acme/api:
  # Reachable by its sandboxes, besides the mandatory hosts and ALLOWED_HOSTS.
  hosts: ["*.acme.dev", pypi.org]
  # Its .deckhand.yaml may add hosts of its own (never "*"); overrides "*" above.
  allow_repo_hosts: true
  # Its own limits; missing ones keep SANDBOX_CPUS, SANDBOX_MEMORY, SANDBOX_PIDS.
  limits: { cpus: 4, memory: 8g, pids: 4096 }
  # Roots it may mount from (read-only unless read_only: false).
  mounts:
    - root: /nfs/work
      read_only: false
    - /srv/datasets
```

Quote patterns starting with `*` (`"*.acme.dev"`, `"*"` as a key): YAML reads a bare `*`
as an alias. See [A repository's own hosts](#a-repositorys-own-hosts) for
`allow_repo_hosts`.

## Hardening

Every sandbox runs:

- as `node` (uid 1000), with `--cap-drop ALL` and `--security-opt no-new-privileges`;
- with `--cpus`, `--memory` (and as much `--memory-swap`: no swap on top) and
  `--pids-limit`: `SANDBOX_CPUS` (2), `SANDBOX_MEMORY` (`4g`), `SANDBOX_PIDS` (2048), or
  the repo's `limits` in the grants file.

The containers the listener starts around runs get the same treatment where they can: the
Claude Code install runs as root with only `CHOWN` (to take over an older volume); the one
that hands a new cache volume to uid 1000 keeps only `CHOWN`, without network.

The Docker socket stays in the listener (and in preview hooks, which a repo's maintainers
configure, see [Per-repo config](repo-config.md#preview-hook)). No sandbox gets it.

**Optional: a socket proxy.** The listener only uses the docker CLI, so it can talk to a
socket proxy (for example `tecnativa/docker-socket-proxy`) through `DOCKER_HOST` instead of
the socket itself. It needs: `CONTAINERS`, `IMAGES`, `BUILD`, `VOLUMES`, `NETWORKS`, `POST`
and `DELETE` (`docker run`, `ps`, `logs`, `inspect`, `wait`, `rm`, `cp`, `build`, `image ls/rm`,
`volume create/inspect/rm`, `network inspect`). Preview hooks still need the real socket
(`DOCKER_SOCKET`): leave `preview` out of your repos' configs if you go this way.

## Network

```
sandbox ──(deckhand-sandboxes, internal: no route out)──▶ egress proxy ──▶ allowed hosts
   └──────────────────────────────────────────────────▶ listener (token broker)
```

- The sandboxes' network is **internal**: Docker gives it no route out. The listener checks
  it (`docker network inspect`) before starting runs and refuses to start any while it
  isn't.
- The **egress proxy** (`proxy/proxy.mjs`, the `egress` service) is on that network and the
  outside one. It handles HTTP `CONNECT` (HTTPS, and anything tunnelled) and plain HTTP
  requests. For each one, it asks the listener whether the sandbox at that source address
  may reach that host; the listener matches the address to the running sandbox (`docker
inspect`) and answers from that run's list. An unknown address, an unknown host, or a
  listener that doesn't answer: refused, with a `403` saying why.
- The proxy resolves names itself and connects to the address it checked. Loopback,
  link-local (cloud metadata, `169.254.169.254`), multicast and unspecified addresses are
  always refused; private ones (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`)
  only when the host is allowed by name or `*.domain`, never through `*` alone. IPv6
  addresses are compared as bytes, and those standing for an IPv4 one (`::ffff:0:0/96`,
  `::/96`, NAT64's `64:ff9b::/96`) are checked as that IPv4 address, so
  `[::ffff:a9fe:a9fe]` is the metadata service too.
- Sandboxes get `HTTP_PROXY`, `HTTPS_PROXY` (both cases), `NO_PROXY` (`localhost`, the
  listener) and `NODE_USE_ENV_PROXY=1`: without it, Node's `fetch` ignores the proxy (and
  fails, as nothing else goes out). The Playwright browser gets the proxy as flags. A tool
  that ignores proxy settings fails closed: it has no route out.

### What a sandbox may reach

**Restricted by default**: the mandatory hosts, plus

- `ALLOWED_HOSTS`: yours, for every repository;
- the repo's `hosts` in the grants file;
- the repo's own `hosts` in its `.deckhand.yaml` (default branch only), **only when you
  allow it** with `allow_repo_hosts: true` in the grants file (see below).

Each entry is a host name (`registry.npmjs.org`), `*.domain` (any subdomain, at any depth,
not the domain itself: list both if you need both), or `*` (anything). Any port.

### A repository's own hosts

A repository's `.deckhand.yaml` is written by whoever can push to its default branch, and
a run can open a pull request that someone merges. If its `hosts` counted on their own, a
sandbox could get its way out by changing that file. So the rule is the same as for
mounts: the repository asks, you decide.

- **Without `allow_repo_hosts`** (the default), a repo's `hosts` can only repeat what you
  already allow it: the mandatory hosts, `ALLOWED_HOSTS` and its `hosts` in the grants file
  (`files.example.com` is fine under a granted `*.example.com`). Any other entry stops its
  runs, and the reply on the issue lists each refused host with the config's other errors.
- **With `allow_repo_hosts: true`** for the repo (or for every repo, under `"*"`), its
  `hosts` are added to what its sandboxes may reach. Give it to repositories whose default
  branch you trust as much as your own grants file: protected, reviewed merges.
- **Never `*` or a whole top-level domain** (`"*.com"`) from a repository, granted or not:
  that is a config error. Only you can open that much, in `ALLOWED_HOSTS` or the grants
  file.

A mode can't change any of this: the hosts of every run of a repo are the same whatever the
mode.

**Mandatory hosts**, always allowed:

| Host                      | For                                                  |
| ------------------------- | ---------------------------------------------------- |
| `api.anthropic.com`       | Claude Code: the API, and WebFetch's domain check    |
| `github.com`              | git over HTTPS (`GITHUB_URL`)                        |
| `api.github.com`          | `gh` and the API (`GITHUB_API`)                      |
| `*.githubusercontent.com` | raw files, release downloads, avatars                |
| the listener              | the token broker, directly on the sandboxes' network |

That list was checked against Claude Code 2.1.300 (the pinned version) by reading the hosts
in its binary. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (set in the image) and the
credential in `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or
`ANTHROPIC_API_KEY`, Claude Code only calls `api.anthropic.com`:

- not `platform.claude.com`: it refreshes OAuth credentials stored by `/login`, which a
  sandbox doesn't use (`setup-token` tokens aren't refreshed);
- not `claude.ai` / `claude.com`: interactive login only;
- not the telemetry, error reporting and update hosts (Statsig, Sentry, Datadog,
  `downloads.claude.ai`): non-essential traffic, off.

Check it again when you change `CLAUDE_CODE_VERSION`. A refused host shows up in the
listener's logs (`Egress: refused <host> for <repo>#<n>`).

### Not covered

- **Image builds** (a repo's `dockerfile`) and the **Claude Code install** run with normal
  network access: they run on the host's Docker, outside the sandboxes' network. Builds run
  the repo's Dockerfile from its default branch (or trusted branches with
  `allow_branch_docker_images`).
- **Preview hooks** run on Docker's default network with the Docker socket.
- **DNS**: Docker's embedded resolver may forward lookups from the internal network to the
  host's resolvers, so a lookup of a made-up name could carry data out to that domain's DNS
  server.
- **Allowed hosts are trusted entirely**: anything a sandbox can write to on one is a way
  out: its own repository on GitHub, a bucket or paste service behind `*`.
- The listener's own port (8080: dashboard, webhook) is reachable from sandboxes; it needs
  a dashboard session (a signed-in allowed user, see [Setup](setup.md#4-the-dashboard)) or
  the webhook's signature. `/status` also answers calls from inside the listener's container.
