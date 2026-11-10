# Updating

How to take a new release, or follow `main`, and what happens to the runs going meanwhile. Read
it before your first update, then the [upgrade notes](upgrade-notes.md) of what changed since
yours.

Each release is a git tag (`v1.2.3`) that publishes the images, tagged `1.2.3`, `1.2`
and `latest`. Each commit of `main` whose checks pass publishes them too, tagged `edge`. There is no built-in updater: update the way you update other compose
services.

```sh
docker compose pull
docker compose up -d
```

- **`latest`** (the default): the two commands above take the newest release.
- **A pinned version**: set `DECKHAND_VERSION=1.2.3` in `.env`, change it to update (by
  hand, or with Renovate's docker-compose or regex manager), then the same two commands.
- **`edge`**: set `DECKHAND_VERSION=edge` in `.env` to follow `main`, unreleased and for
  amd64 only (the tag has nothing to do with the edge service).
  It is built once the repository's checks pass on `main`'s newest commit: a commit whose checks
  fail gets no image, and `edge` stays on the last one that passed (a newer commit cancels the
  build in progress, so a burst of merges builds once). The dashboard shows the commit it runs
  as `edge-<short sha>`. The same two
  commands update it.

`docker compose pull` pulls the base image sandboxes run from too (the `sandbox` service), and
with the `engine` profile (`COMPOSE_PROFILES=engine` in `.env`) the
[container engine](container-engine.md)'s two images. Those services exit as soon as they start
(they are only there to pull or build their images), so an updater that only follows running
containers, such as Watchtower, never pulls them: the services update, the sandbox image stays
behind, and new runs start the old image's scripts with the new services' variables, which can
fail them ([#441](https://github.com/BryanSmee/deckhand/issues/441)). A repository's own image is
rebuilt only once the new base is pulled, since its tag hashes the base's id.

To update on a schedule, run the two commands from your Deckhand folder rather than Watchtower,
from cron for instance (`docker compose` reads `.env` from the folder it runs in):

```sh
# crontab -e: every night at 04:17
17 4 * * * cd /srv/deckhand && docker compose pull --quiet && docker compose up -d
```

If you keep Watchtower for the services, schedule `docker compose pull sandbox` beside it (and
`docker compose pull engine engine-podman` with the `engine` profile), in that folder, at least as
often as Watchtower checks, so that the base image follows the services.

To check which version runs and that a restart happened, open the dashboard's Repositories
page: its toolbar shows the version (linked to its commit or release), the orchestrator's uptime
and its Node version, as in "Deckhand edge-1713fa6 · up 3 d 4 h · Node 26.1.0". `/status`
returns the same `version` and `startedAt` for scripts.

You can update at any time, runs in progress included. The orchestrator and the runner stop
within their grace periods without waiting for them: the orchestrator starts no new run, saves the comments still waiting for
one, and the sandboxes keep running. The new orchestrator finds them again by their Docker
labels, delivers the comments that arrive meanwhile, and posts each run's final reply once,
even for a run that finished while no orchestrator was there. Queued comments are then handled.
Edge takes GitHub's webhooks meanwhile: they wait in its store until the orchestrator reads
them, so none is lost. With two copies of each, an update stops nothing ([Two copies](two-copies.md)).
A new base image rebuilds a repository's own image on its next run (see
[Per-repo config](../repo-config.md)); running sandboxes keep the image they started with.
A base image older than the services (its `deckhand.sandbox-api` label lower than theirs) runs
nothing: each run is refused at its start with "the sandbox image … is older than Deckhand's
services: run docker compose pull sandbox", so pull it with the rest.
The policy service restarts in a few seconds and holds nothing: the decisions the orchestrator
asks meanwhile (a run's GitHub write, a merge) wait for it, up to 30 seconds, rather than being
refused.

The policy service reads your server folder as the `node` user (uid 1000): your grants folder and
its `policy/` must be readable by that user (the usual `0644` files and `0755` folders are), or
every policy decision is refused, and the orchestrator's log says why at start.
