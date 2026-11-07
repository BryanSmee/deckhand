# Container engine

A sandbox has no Docker: it never gets the host's socket, and its hardening (uid 1000, no
capabilities, `no-new-privileges`) rules out running an engine inside it. A repository whose
runs need to build and run images (to check its Dockerfiles, say) can get a **container
engine** instead: a second container the runner starts next to each of its work runs'
sandboxes, on the run's own network, and removes with it. The sandbox gets the `docker` CLI
(with buildx and compose) and `DOCKER_HOST=tcp://engine:2375`; containers it starts with a
published port answer at `engine:<port>`. Nothing in the engine touches the host's Docker,
and it reaches the outside only through the egress proxy, under the run's hosts.

Three steps, all off by default:

1. **Pick a backend**, `SANDBOX_ENGINE` in `.env` or `sandbox_engine` in `config.yaml`:
   - `sysbox` (recommended): `dockerd` under the [Sysbox](https://github.com/nestybox/sysbox)
     runtime, which maps root in the engine to an unprivileged user on the host: no
     `--privileged`, no relaxed seccomp or AppArmor. Linux hosts only (not Docker Desktop):
     install Sysbox from its releases (a `.deb` for Debian and Ubuntu, which restarts Docker),
     then check that `docker info` lists the `sysbox-runc` runtime. Without that runtime,
     runs that would get an engine fail with a reply saying so.
   - `podman`: rootless Podman serving Docker's API. Nothing to install, but the engine runs
     with seccomp and AppArmor unconfined, `/dev/fuse` and `/dev/net/tun`, and Docker's
     default capabilities, which expose more of the host's kernel (see
     [Security model](../security/mounts-and-engine.md#container-engine)). `docker build` uses the classic
     builder there (`DOCKER_BUILDKIT=0`), and some compose features differ.
   - `auto`: Sysbox where `docker info` lists its runtime, else Podman.
2. **Pull its image**: `COMPOSE_PROFILES=engine` in `.env`, then `docker compose pull` (or
   `up -d --build`) pulls or builds both engine images, `deckhand-engine` and
   `deckhand-engine-podman`, the way the `sandbox` service does the base image.
3. **Grant it per repository**: `docker`, in an `allow_grant` rule of your policies that names
   the repository (`grants/policy/grants.rego`, [the grants](../reference/server-folder.md#the-grants): a rule
   for every repository grants it to none), and the repository asks for it with `docker: true` in its
   `.deckhand.yaml` ([Per-repo config](../repo-config.md#container-engine)). Add the registries
   it pulls from to `hosts` in its grants file: Docker Hub is
   `registry-1.docker.io`, `auth.docker.io` and `production.cloudflare.docker.com`; GHCR is
   `ghcr.io` and `pkg-containers.githubusercontent.com` (already allowed). A pull from any
   other registry fails at the proxy.

The engine has the repository's limits (its grant's, else the built-in ones) on top of the
sandbox's, and its storage is a volume of the run's own, removed with it. A repository can
keep that storage between its runs instead (`docker: { cache: true }`): one volume per
repository and backend, `deckhand-engine-cache-<repo>-…-<backend>`, which you remove by hand
to reclaim the space. Runs from a fork's pull request never get an engine, nor runs the
policies don't give the `docker` capability (with Deckhand's defaults, all but work runs and a
repository's own modes: brainstorms, inbox entries…).

To check it on your host: grant a repository, comment on one of its issues asking to
`docker build` its Dockerfile, `docker run` the image with a published port and `curl
engine:<port>`, and `docker compose up` its stack; the run's log on the dashboard starts with
`Container engine: sysbox, fresh storage`. Then `docker ps -a --filter label=deckhand.engine`
and `docker volume ls --filter label=deckhand.engine` are empty once the run is over.

On Kubernetes, the engine is Sysbox's alone, in the sandbox's pod: see
[Container engine on Kubernetes](../kubernetes/components.md#container-engine-on-kubernetes).
