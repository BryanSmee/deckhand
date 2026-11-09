# Updating

How to take a new release, or follow `main`, and what happens to the runs going meanwhile. Read
it before your first update, then the [upgrade notes](upgrade-notes.md) of what changed since
yours.

Each release is a git tag (`v1.2.3`) that publishes the images, tagged `1.2.3`, `1.2`
and `latest`. Each commit of `main` whose checks pass publishes them too, tagged `edge`.

## With the deckhand command

`cli/deckhand.mjs` (attached to each release as `deckhand.mjs` too: one file, Node 20 or later,
on Linux, macOS and WSL2) updates a Compose install from the folder of its `compose.yaml` and
`.env` (or `--dir <folder>`):

```sh
node cli/deckhand.mjs update          # the latest release
node cli/deckhand.mjs update 1.2.3    # a release of your choice, or edge
```

It lists the [upgrade notes](upgrade-notes.md) the new release added since the one `.env` pins
(each with its link: read them before you go on) and asks before it changes anything (`--yes`
skips the question, in a script). Then it moves `compose.yaml` to that release: a git checkout
goes to its tag (refused with local changes: yours belong in `compose.override.yaml`), any other
folder gets the tag's file, the old one kept as `compose.yaml.bak`. Last, it pins the release in
`.env`, pulls every image, the sandbox's included, and runs `docker compose up -d`.

`node cli/deckhand.mjs up` starts the release `.env` pins as it is, pulling its images first;
with `DECKHAND_VERSION=latest` (or none), it pins the latest release the same way. Run either
again after a failed pull: nothing is lost in between.

Why a pinned release: with `latest`, which release runs is whatever the last pull got, and an
updater that follows running containers (Watchtower) never pulls the sandbox image, as compose's
`sandbox` service exits at once. Runs then start from a base image older than the services.

## With docker compose

Without the command, update the way you update other compose services:

```sh
docker compose pull
docker compose up -d
```

- **`latest`** (the default in `.env.example`): the two commands above take the newest release.
  Watchtower can run them for you, but pulls neither the sandbox image nor a new
  `compose.yaml`: run `docker compose pull sandbox` after it.
- **A pinned version**: set `DECKHAND_VERSION=1.2.3` in `.env`, change it to update (by
  hand, with Renovate's docker-compose or regex manager, or with `deckhand update`), then the
  same two commands.
- **`edge`**: set `DECKHAND_VERSION=edge` in `.env` to follow `main`, unreleased and for
  amd64 only (the tag has nothing to do with the edge service).
  It is built once the repository's checks pass on `main`'s newest commit: a commit whose checks
  fail gets no image, and `edge` stays on the last one that passed (a newer commit cancels the
  build in progress, so a burst of merges builds once). The dashboard shows the commit it runs
  as `edge-<short sha>`. The same two
  commands (or Watchtower) update it, or `deckhand update edge`, which moves `compose.yaml` to
  `main`'s too.

## While it updates

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
The policy service restarts in a few seconds and holds nothing: the decisions the orchestrator
asks meanwhile (a run's GitHub write, a merge) wait for it, up to 30 seconds, rather than being
refused.

The policy service reads your server folder as the `node` user (uid 1000): your grants folder and
its `policy/` must be readable by that user (the usual `0644` files and `0755` folders are), or
every policy decision is refused, and the orchestrator's log says why at start.
