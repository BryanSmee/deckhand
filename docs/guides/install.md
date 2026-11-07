# Install with Compose

The full version of the [quick start](../get-started/quick-start.md): what each step does, and
what runs on your server once it is done. Read it when you install Deckhand with Docker
Compose; on a cluster, see [On Kubernetes](#on-kubernetes).

Deckhand runs on your own server with your own private GitHub App and your own Claude
credential (or OpenAI key, for [Codex](codex.md)). You need Docker Engine 26 or later with the
compose plugin, and an HTTPS address that GitHub can reach (your reverse proxy, or a tunnel)
forwarding to edge's port.

## Start Deckhand

```sh
cp .env.example .env
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY (or a gateway's
#   ANTHROPIC_AUTH_TOKEN: see guides/claude-code.md), or OPENAI_API_KEY for Codex (see
#   guides/codex.md): the secrets stay in .env
cp -r server.example server
# server/config.yaml: allowed_users, the GitHub logins allowed to start runs (required: no
#   start without it), and the other settings; server/grants/: what you grant each
#   repository. See settings.md, The server folder.
docker compose pull
docker compose up -d
docker compose logs edge
```

Compose runs nine images, published for each release (`DECKHAND_VERSION`, default
`latest`): edge's (the only one the internet reaches: GitHub's webhooks, `/setup`, sign-in and
the dashboard's files), the orchestrator's (the queue, the runs and the dashboard's data,
behind edge), the runner's (the only one with the Docker socket: it starts the
sandboxes, [architecture](../architecture.md#the-runner-service)), the broker's (the only service
holding the key that signs the runs' tokens, see [The broker service](services.md#the-broker-service)), the
github service's (the only one holding the GitHub App's key, see
[The github service](services.md#the-github-service)), the models service's (the only one holding your agents' credentials, see
[The models service](services.md#the-models-service)), the policy service's (which evaluates the
[policies](../security.md#policies), on internal networks shared with the orchestrator alone, the
github service alone and the runner alone), the egress proxy's (the only way out of the sandboxes' internal
networks, see [Security model](../security.md)), and the base sandbox image runs start from (the
`sandbox` service only pulls it and exits); with the `engine` profile, the
[container engine](container-engine.md)'s two images too. A repository can bring its own image
`FROM` that base: see [Per-repo config](../repo-config.md). Edge publishes port 8080
(`PORT` to change it), on a network of its own (`edge-out`); point your reverse proxy at it.

To build the images from this checkout instead: `docker compose up -d --build`. Updating is
`docker compose pull` and `docker compose up -d` again ([Updating](updating.md)).

## A plan or an API key

A plan's credential (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`, for Codex a ChatGPT
plan's login from `codex login`, or for the Antigravity CLI a Google AI plan's login, both in
[the credentials folder](agents.md#the-credentials-folder)) works, and the orchestrator's and
the models service's logs warn about it at each start. A subscription (Claude Pro/Max, a ChatGPT
plan, Google AI Pro/Ultra) is usually licensed to one person, and Google's terms may not allow a
plan to drive a bot at all. Serving a team, or repositories other people write to, may break
your provider's terms: check them before you do. You are responsible for how your Deckhand uses
your credential. For teams, use an API key.

## On Kubernetes

With `RUNNER=kubernetes`, each run's sandbox is a pod of the cluster the runner service runs
in, rather than a container of the host's Docker. `deploy/kubernetes/` has the manifests (a
kustomize base, with components for Redis and BuildKit), and [Deckhand on Kubernetes](../kubernetes.md)
takes you from an empty cluster to a first run: the requirements (a network plugin that enforces
NetworkPolicies, a storage class, the kubelet's settings), installing, updating, and what the
manifests set up and why.

## Next

- [Create the GitHub App](github-app.md), from the link edge's logs print.
- [Start runs](runs.md) on an issue, and [onboard the repositories](repositories.md).
- [Server settings](../settings.md): every setting, and the server folder.
