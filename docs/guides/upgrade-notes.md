# Upgrade notes

What an update changed that may need a step of yours: read the notes of the changes you haven't
run yet before you [update](updating.md). Most need nothing; each says what does. The newest come
first, then the older ones: the policies' (allow rules, per-mode policies, the grants) and the
grants folder's.

## Upgrading: the workflow editor's `repo:config:write` (#1042)

A repository's config page has an Editor tab: a workflow of `.deckhand/workflows/` edited beside
its graph, tried on a past pull request, and saved as a pull request the App opens. Saving needs a
new action, `repo:config:write`. Deckhand's `access-roles.rego` gives it to `admin`; Deckhand's
default `access.rego` (`*` for every login) to everyone signed in. What changes for you: nothing,
unless your grants folder has an `access-roles.rego` of its own (a copy of Deckhand's roles): add
`repo:config:write` to the roles that should save workflows there, or leave it out and nobody
does (the editor's checks and dry runs only need `repo:config:read`). The App writes through its
existing `contents` and `pull_requests` permissions: nothing to accept on GitHub.

## Upgrading: the sandbox image's contract label (#980)

The base sandbox image now carries a `deckhand.sandbox-api` label, the number of the contract
between the services and its scripts, and a run is refused before it starts when its base
image's number is lower than the services' (or missing), saying what to run, rather than
failing later without a word. What changes for you: pull the sandbox image with the services,
as `docker compose pull` does (`docker compose build sandbox` from source); on Kubernetes,
`SANDBOX_IMAGE` has to be this release's, as [Updating](../kubernetes/updating.md) already
says. A sandbox image of yours (a mirror) has to be this release's or newer. Repository images
built `FROM` the base inherit the label: they need nothing.

## Upgrading: /status from inside edge's container (#1019)

A call of `/status` from edge's own loopback without a forwarding header no longer goes without
a session: a reverse proxy that adds none would have opened it to anyone. A script or check that
read it from inside edge's container (`docker compose exec edge wget -qO- localhost:8080/status`,
say) now gets `401`: call `docker compose exec edge node edge/status.mjs` instead (`kubectl exec`
on Kubernetes), which sends the token edge's session key gives. Nothing else changes.

## Upgrading from v0.0.x (v0.1.0)

v0.0.1 and v0.0.2 ran one `listener` image; v0.1.0 is the first release of the services (edge,
the orchestrator, the runner, the broker, the github, models and policy services, the egress
proxy). Nothing carries over from a v0.0.x install, and nothing moves its state: install
v0.1.0 as a new one. The `deckhand-listener` images are no longer published. What to do:

1. **Let its runs end**: `docker ps --filter label=deckhand.run` lists the sandboxes still
   running; wait for them (or `/cancel` them).
2. **Remove it**, from the folder of its `compose.yaml`: `docker compose down -v`. Its volumes
   (the App's credentials, the queue, the runs' logs, the screenshots) go with it: the new
   orchestrator's `data` volume has the old one's name, and would start on what v0.0.x left there.
   Keep a copy of a run's log you want first.
3. **Install v0.1.0** from a checkout of its tag, as [Install with Compose](install.md) says:
   a new `.env` from `.env.example` (`ALLOWED_HOSTS`, the sandbox limits and the old
   `listener`'s settings are gone: see [Hosts in the grants folder alone](#upgrading-hosts-in-the-grants-folder-alone)
   and [The sandbox limits](#upgrading-allowed_hosts-and-the-sandbox-limits)), and a server
   folder from `server.example/` (your `grants.yaml` becomes `server/grants/`: see
   [A grants folder](#upgrading-a-grants-folder)); a repository's Dockerfile and branch images
   now need a grant of your policies ([Upgrading the grants](#upgrading-the-grants-498)).
4. **Create the App again** with `/setup`: the old one's key went with its volume. Delete the
   old App in GitHub's settings (Developer settings, GitHub Apps) once the new one is installed.

The other notes on this page are the steps between v0.0.2 and v0.1.0, for those who followed
`edge`: a fresh install needs none of them.

## Upgrading: the orchestrator without a volume (#619)

The orchestrator writes nothing beside its [store](store.md) now: the queue, its lease, its
maps, the live runs' states and the runs' summaries are all there (#615–#618), the screenshots at
the broker (#609). With the file store (`file:///data/store`, the default), its `data` volume
holds the store's folder alone; with Redis it needs no volume at all, runs on a read-only root,
and its copies go to any node. What changes for you:

- **The first start after the update needs the old volume**, mounted as before: the one-time
  moves of #609 and #615–#618 still run there, reading what a release before left in `/data`
  (the maps' `<name>.json`, `logs/<run>.live.json` and `.queued.json`, `logs/<run>.json` and
  `.summary.json`, `shots/`). On Compose and Kubernetes' base, it stays mounted: nothing to do.
  With Redis (the `redis` component, Helm's `store: redis`, or your own override), this release
  no longer mounts it: keep it mounted for that first start whatever the release before, as
  that one goes on writing there while it runs (`logs/<run>.summary.json`, a summary its store
  refused at a run's end; `logs/<run>.queued.json`, a task's queue it couldn't write), which
  this release reads only from there: without it, those runs leave the dashboard's history and
  those comments are lost. Once it started, its log says what it moved, and the volume holds
  nothing but what it names as no longer read (`ls -A /data`); the next update of the
  Deployment drops the mount. With kustomize, the claim and a patch for that one update, in an
  overlay around yours: the `redis` component no longer renders the claim, so an apply that
  prunes (`kubectl apply --prune`, Argo CD or Flux with pruning on) would delete it during the
  update itself, before that start, and the patch would mount nothing. Rendered again, it stays
  (around yours, as the component's deletion comes after the resources of its own overlay):

  ```yaml
  # orchestrator-data.yaml: the claim as the release before made it, rendered again for this
  # one update (your overlay's storage class, if it set one).
  apiVersion: v1
  kind: PersistentVolumeClaim
  metadata:
    name: orchestrator-data
    namespace: deckhand
  spec:
    accessModes: [ReadWriteMany]
    resources:
      requests:
        storage: 5Gi
  ```

  ```yaml
  # kustomization.yaml, beside it: your overlay (with components/redis) as its resource.
  resources:
    - ../your-overlay
    - orchestrator-data.yaml
  patches:
    # For the first start on this release alone: the old claim, mounted again (#619).
    - patch: |
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: orchestrator
          namespace: deckhand
        spec:
          template:
            spec:
              containers:
                - name: orchestrator
                  volumeMounts:
                    - name: data
                      mountPath: /data
              volumes:
                - name: data
                  persistentVolumeClaim:
                    claimName: orchestrator-data
  ```

  With Helm (`store: redis`), the same once `helm upgrade` is done, on the Deployment it made
  (the claim is kept: `helm.sh/resource-policy: keep`). The copies it started meanwhile, without
  the volume, move nothing and remove nothing of it: the patched ones do. The next
  `helm upgrade` drops the mount again:

  ```sh
  kubectl -n deckhand patch deployment orchestrator --type json -p '[
    {"op": "add", "path": "/spec/template/spec/volumes/-",
     "value": {"name": "data", "persistentVolumeClaim": {"claimName": "orchestrator-data"}}},
    {"op": "add", "path": "/spec/template/spec/containers/0/volumeMounts/-",
     "value": {"name": "data", "mountPath": "/data"}}]'
  ```

  With Compose and your own Redis override, leave the `data` volume in its `volumes` for that
  start, and take it out after.

  On Kubernetes, applying your own overlay again after that start, a pruning apply deletes the
  claim: what you want then, the start having moved what it held. To keep it longer (or if you
  prune and can't render it again), mark it before the update, for Argo CD or for Flux:

  ```sh
  kubectl -n deckhand annotate pvc orchestrator-data argocd.argoproj.io/sync-options=Prune=false
  kubectl -n deckhand annotate pvc orchestrator-data kustomize.toolkit.fluxcd.io/prune=disabled
  ```

- **The older moves are gone**: a listener's `queue.json` (from before the store), its App's
  credentials (`app.json` with its key, `session.key`, `sessions.json`, `redeliveries.json`,
  handed to the github service and edge), its `reactions.json` (the github service's since
  #458), and the run logs it kept itself before the runner service (`logs/<run>.log`, #503). An
  install that still has any of those in `/data` (one that never ran a release with the
  services, #557, or the runner service) updates first to the last release before #619
  (following `edge`: an image built before #619), lets the orchestrator start once there, then
  updates to this one. This release doesn't read them, and edge and the github service no longer take
  an App handed over (their `PUT /app`, #820): their comments, credentials and logs would be
  left out.
- **The screenshots' volume is gone from Compose** (`SHOTS_VOLUME`, `deckhand-screenshots`, at
  `/data/shots`): the broker has kept the screenshots since #609. An install from before #609
  whose screenshots are still there goes through the release before #619 first, or mounts that
  volume at `/data/shots` for one start (a `compose.override.yaml`). On Kubernetes, the
  `orchestrator-screenshots` claim is gone from the base and the chart
  (`persistence.sizes.orchestrator-screenshots`).
- **What is left in `/data`**: once moved, the orchestrator removes the emptied `logs/` and
  `shots/`, and names in its log anything else beside the store that nothing reads any more (never
  a filesystem's own `lost+found`), in
  `logs/` too (a run log from before the runner service, `logs/<run>.log`), as in
  `/data holds run-token.key, which no longer is read: remove it`. Remove them then. Once the
  orchestrator has started once on this release, the screenshots' volume can go, and with Redis
  its `data` volume too. Compose: `docker volume rm deckhand-screenshots`, and
  `docker volume rm <project>_data` (`docker volume ls` names it). Kubernetes:
  `kubectl -n deckhand delete pvc orchestrator-screenshots`, and `orchestrator-data`. A
  `kubectl apply -k` without pruning doesn't delete a claim it no longer renders, and the
  chart's carry `helm.sh/resource-policy: keep`: a `helm upgrade` leaves them too. An apply that
  prunes deletes them (the screenshots' claim at the update: the release before moved what it
  held at its own start, #609), but for a claim marked as above.
- **A summary the store refuses at a run's end** is no longer kept in
  `logs/<run>.summary.json`: the run's end tries the store again every 5 seconds until it lands,
  the run keeping its sandbox, its state, its task and its parallel slot meanwhile (the status
  page lists it among the orchestrator's warnings, `/ready` counts it as `ending`, #821: a
  store that refuses it for good, a file it can't write or a Redis ACL without `summaries/`,
  shows there until fixed, and the next try then ends the run). A copy that stops first leaves
  the run as it is, for the next copy to end again. Those a release before left are moved at
  the next start.
- **At start**, the orchestrator checks that it can write the whole `/data` only while a
  release before left something there beside the store (#536's check), or while the store's
  folder isn't made yet (a new volume, or an empty one a root orchestrator made: the chown hint
  as before); else the store's folder alone, and nothing when its store is elsewhere and `/data`
  is empty.

## Upgrading: access control (#725)

Nothing to do: Deckhand's `policy/access.rego` gives every login of `ALLOWED_USERS` every
action, on every repository and server-wide, as before. `ALLOWED_USERS` still decides who signs
in, uses MCP and comments, and a repository's `users` still narrows it. The policy service
answers the dashboard now too ([Access](../security/webhooks-and-sign-in.md#access)): with it away, the dashboard shows
no repository within about 30 seconds, until it is back.

To give some people some actions on some repositories only, write a `policy/access.rego` in the
grants folder: it replaces Deckhand's, so each login then has the actions of its bindings alone,
and a login of `ALLOWED_USERS` no binding names signs in to an empty dashboard. Bindings name
logins, repository patterns (`owner/repo`, `owner/*`, `*/*`) and a role
([Access](../repo-config/policies.md#access)):

| Role       | May                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------- |
| `viewer`   | see the repository's tasks and runs (`tasks:read`), not their live logs                   |
| `member`   | a viewer's, the live logs, start runs in every mode, cancel, rerun and answer them        |
| `admin`    | a member's, and read the repository's config, grants and policies (`repo:config:read`)    |
| `operator` | Settings › Server and › Access, the services' health, the plans' usage, Sync (`server:*`) |

<!-- migration access.rego: test/access-rules.test.mjs evaluates this block with the real opa -->

```rego
# server/grants/policy/access.rego
package deckhand

bindings := [
  # You: everything, everywhere. `operator` is server-wide only: bind it beside another role.
  {"users": ["alice"], "repos": ["*/*"], "role": "admin"},
  {"users": ["alice"], "role": "operator"},
  # A teammate who works on acme's repositories, without their configs.
  {"users": ["bob"], "repos": ["acme/*"], "role": "member"},
  # Someone who follows one project's progress, and its live logs.
  {"users": ["carol"], "repos": ["acme/web"], "role": "viewer"},
  {"users": ["carol"], "repos": ["acme/web"], "actions": ["logs:read"]},
  # A contractor who may start reviews only, on one repository.
  {"users": ["dan"], "repos": ["acme/api"], "role": "viewer"},
  {"users": ["dan"], "repos": ["acme/api"], "actions": ["runs:start:review"]},
]
```

Keep a binding for yourself: without `server:read`, nobody sees Settings › Access, nor the
server's setup. Then open **Settings › Access** to check who has what: an edit of the folder's
policies holds at the next request. Other rules of yours can give or deny actions besides the
bindings (a `deny_access` for every repository), and a repository's maintainers can take
actions away on theirs with `deny_access` in its `.deckhand/policy/`, never give any
([Access](../repo-config/policies.md#access)).

## Upgrading: `+scan` for Redis's user (#614)

With Redis as [the store](store.md), the orchestrator now lists keys by prefix (`SCAN`) at its
start: the maps it keeps one key per item (#615, #616), its live runs' states (#617). A
`deckhand` user written from this page before #614 has no `+scan`: the orchestrator then stops
at its start with `NOPERM … 'scan'` in its log. Add it before you update, in `redis.conf` (the
line of the user the orchestrator signs in as, as in [The store](store.md)) or at once on the
running Redis, as a user allowed `ACL` (the one you administer it with: `default` is off
there). `ACL SETUSER` adds to the user's rules, keeping the others:

```sh
redis-cli --user <admin> --askpass ACL SETUSER deckhand +scan
redis-cli --user <admin> --askpass ACL SAVE   # only with an aclfile: it writes the users there
```

`ACL SETUSER` alone is lost when Redis restarts on a `redis.conf` without it: change the file
too. On Kubernetes, the `redis` component and the Helm chart write their users again each time
Redis starts, edge's, the orchestrator's and the runner's with `+scan`: nothing to do there.

Edge lists its keys too, to count the signed-in users of `deckhand_sessions_active` (#822): with a
user per service, give edge's `+scan` the same way (`ACL SETUSER edge +scan`). Without it, only
that gauge is left out of edge's metrics, with `NOPERM … 'scan'` in its log.

## Upgrading: the orchestrator's state in its store (#615, #616)

The orchestrator kept its state in JSON files in its data volume (`/data`). They go to its
[store](store.md) now: those that hold data alone, `titles.json`, `closed.json`, `pulls.json`,
`dismissed.json`, `order.json`, `onboarding.json`, `lanes.json`, `modes.json`, `conflicts.json`,
`dry-runs.json` and `requested.json` (#615); and those behind timers and comments,
`waits.json` (the comments waiting for other issues, `/after`), `inputs.json`, `reviews.json`,
`brainstorms.json`, `decisions.json` and `picks.json` (#616). Nothing to do: at its first start after the update, the
orchestrator writes each file's items to the store (those it doesn't have yet), then removes the
file, and its log says so (`titles: 120 item(s) moved to the store from /data/titles.json`). A
crash midway moves them again at the next start, the same values. A file it can't read (another user's,
or cut short) is left where it is, and its log says why. Fix its owner (`chown`, `chmod`), and it is moved at
the next start, filling only what the store lacks. Remove one cut short rather than edit it:
an edited file counts as written after the store's items, and replaces them. `reactions.json`, which the
github service took over before (#458), was removed once handed over; since #619 it is no longer
read: go through a release before it first ([#619](#upgrading-the-orchestrator-without-a-volume-619)).

With Redis as the store, these items are Redis keys under the store's prefix
(`deckhand:titles/…`): plan for a few thousand more. While the store is away, the orchestrator
goes on from what it has in memory and tries its writes again every few seconds; its `/ready`
says how many wait (`{"ok": true, "waiting": 3}`), and a copy that stops waits 10 seconds for
them before it lets its lease go.

The comments waiting in `waits.json` were the owner's only (`0600`); in the store, what keeps
them is the store's own access (its folder, or Redis's user and network, above).

Going back to an earlier release: it doesn't read the store's items, and starts from empty
files (the titles are asked of GitHub again, the run order and the lanes' names are lost; from
before #616, the waits, the review loops' counts and the brainstorms too).
Updating again after that (#690): a file that release wrote after this one last started (its
modification time later, on the orchestrator's clock: the store keeps when each map was last
loaded, `store-maps/<name>`) is newer than the store's items, and its items replace those of the
same key (a `null` one deletes it: an issue reopened), so what that release changed (a dismissal,
an onboarding issue, a wait) holds. The
store's other items are kept: that release started without them rather than deleted them. The
run order is the exception: its file replaces it whole, as its ranks don't mix with the store's.
A file it never wrote (nothing of that kind changed while it ran) leaves the store's items as
they were before going back. An orchestrator from before #690 that already had the store kept no
such time. If you go back from one of those to a release from before the store, then update
again, the files only fill what the store lacks, as at the first update.

## Upgrading: a folder per map in the file store (#773)

With the file store, the runs' summaries and the maps' items were all files right in the store's
`keys/` folder, so listing one map (at start, or the dashboard's history) read the names of all
of them. Each map has a folder of its own in `keys/` now (`keys/summaries%2F/`,
`keys/titles%2F/`, …). Nothing to do: once the orchestrator holds its lease, before it reads the
runs and the maps, it moves the files left right in `keys/` to their folders, in the same step
and log line as the items below. With Redis, nothing changes.

The folders are made once the orchestrator holds its lease, at its first write in each: a copy
of the release before, still acting meanwhile, never sees them.

Going back to an earlier release that keeps them right in `keys/` (one from `main` between #687
and #773): it takes the folders for keys' files, and fails to start. Roll back only with a copy
of the store's folder from before the update, put back in place of this one.

## Upgrading: the maps' items a file each (#691)

With the file store, the items of the orchestrator's maps (above) were keys in its `state.json`,
written whole at each change of any of them. Each is a file of its own in the store's `keys/`
now, as the runs' summaries are. Nothing to do: once the orchestrator holds its lease, so once
the copy of the release before let it go, it moves those left in `state.json` to their files,
and its log says so (`The store: 840 item(s) moved to their own files, a folder per map`). One it
can't write stops the start there, said in its log and tried again every 5 seconds; nothing is
lost meanwhile. Not before the lease: the release before, still acting, would delete none of
them from their files. With Redis, nothing changes.

Going back to an earlier release: it reads the maps' items from `state.json` alone, and starts
without them: the comments waiting for other issues (`/after`), the review loops' counts, the
brainstorms, the picks, the decisions, the run order and the lanes'
names are lost, and the titles, closed states and pull requests asked of GitHub again. Roll back
with nothing waiting, or keep a copy of the store's folder from before the update and put it
back.

## Upgrading: a live run's state in the store (#617)

The orchestrator keeps each running run's state in its store (`runs/<id>`), no longer in
`logs/<run>.live.json` in its `data` volume, and never with the run's tokens: a copy taking over
asks the broker for them (`POST /runs/:id/secrets`). At its first start, the orchestrator moves
each `logs/<run>.live.json` left there to the store, tells the broker the tokens it held, and
removes it; a `logs/<run>.queued.json` (a task's queue a run's end couldn't write to the store)
is read with the queue and removed once the queue is written. A `logs/<run>.live.json` that
isn't a run's state (unreadable, or missing its `id`, `task` or `record`) is no live run's: it
is set aside as `logs/<run>.live.json.bad`, logged once (`<file>: not a run's state, set aside
as <file>.bad`), then named at each start among what the volume holds that nothing reads any
more, until it is removed (one already there is kept: the next is `.bad.2`, and so on). A file
that can't be renamed stays where it is, logged at each start (`<file>: not a run's state, left
there: <why>`). Look at it, then remove it.
Nothing else to do, but:

- **Update the broker with the orchestrator** (the same release, as compose and the manifests
  do). An older broker refuses that call: the orchestrator asks again until it answers, and the
  restored runs' output is redacted of their tokens by their shape meanwhile.
- **Going back to an earlier release** loses the runs going then: it looks for their state in
  `logs/`, finds none, and closes their sandboxes' input. Roll back with no run going.

## Upgrading: the runs' summaries in the store (#618)

The dashboard's run history came from the runs' summaries in the orchestrator's volume
(`logs/<run>.json`). They are in its store now (`summaries/<run>`, [The store](store.md)), so
a copy taking over on another node finds them there. Nothing to do: at its first start, the
orchestrator writes those left in `logs/` to its store, then removes them (`Run summaries: <n>
moved from /data/logs to the store` in its log), before the dashboard lists the runs: about a
second for 4,500 with the file store or Redis. A file that isn't a summary (unreadable, or
another run's) is left out of the history and set aside as `logs/<file>.bad`, logged once
(`Listing the run of <file>: not a run's summary, set aside as <file>.bad`), then named at each
start among what the volume holds that nothing reads any more, until it is removed (one already
there is kept: the next is `.bad.2`, and so on). A file that can't be renamed stays where it is,
logged at each start. Look at it, then remove it. One the store didn't take stays for the next start, and so did a summary the store
refused at a run's end (`logs/<run>.summary.json`, moved at the next start): since #619, the
run's end tries the store again instead. The run logs left there from before the runner service
were moved as before, until #619.

## Upgrading: the paths from before the services are gone (#567)

The orchestrator no longer answers sandboxes: its broker port (8081) and the `listener` name are
gone, with what kept sandboxes, proxies and runs of earlier releases working. Sandboxes call the
broker, the github and the models service by their own names, through the egress proxy. What
changes for you:

- **Running sandboxes**: deploy only once none started by the earlier release still runs. One
  calls `http://listener:8081`, which nothing answers any more: its pushes, GitHub calls, agent
  calls and inbox fail. `docker ps --filter label=deckhand.run` on the server lists the running
  ones: wait for them to end (or `/cancel` them) first. On Kubernetes, the sandbox pods
  (`deckhand.role=sandbox`).
- **Kubernetes NetworkPolicy**: sandboxes may reach the egress proxy alone now. A policy that
  also lets them reach the orchestrator on 8081, as these docs said before, is refused, and no
  run starts until it names the proxy's port only ([What the manifests set up, and why](../kubernetes/isolation.md#what-the-manifests-set-up-and-why)). The
  orchestrator's Service named `listener` can go.
- **Settings no longer read**: `BROKER_URL` and `BROKER_PORT` (the orchestrator, the runner, the
  egress proxy), `RELAY_URL` (the egress proxy) and `RUNS_VOLUME`. Remove them from your `.env`,
  compose overrides or Deployments: they are ignored. The egress proxy's `BROKER_SERVICE_URL`,
  `GITHUB_SERVICE_URL` and `MODELS_SERVICE_URL` now default to compose's names, and its
  `POLICY_URL` to `http://orchestrator:8082/egress`.
- **The `runs` volume** (`deckhand-runs` by default) is no longer mounted: the runner keeps the
  runs' inboxes in its own (`runner-data`). Once no sandbox of the earlier release runs, remove
  it: `docker volume rm deckhand-runs`.
- **The listener's keys**: a `run-token.key` or `run-token.pub` left in the orchestrator's data
  volume is no longer read. Delete them.

## Upgrading: the orchestrator runs as `node` (#536)

The orchestrator ran as root, though it holds no Docker socket since the runner service (#503).
It now runs as the `node` user (uid 1000), with a read-only root filesystem and no capabilities,
as edge does. What changes for you:

- **Its volumes** (`data`, and the screenshots', `deckhand-screenshots` by default) were written
  as root: the orchestrator can't write them now, and refuses to start, listing what it can't
  write. Hand them over once, with the orchestrator stopped, instead of the usual update:

  ```sh
  docker compose pull
  docker compose stop orchestrator
  docker compose run --rm --no-deps --user root --cap-add CHOWN --entrypoint chown orchestrator -R 1000:1000 /data
  docker compose up -d
  ```

  - **Stop it first.** The orchestrator of the earlier release runs as root and saves its
    store every few seconds: left running, it makes `store/`'s files root's again right after
    the `chown`. The sandboxes keep running meanwhile, as in any update. If you already ran
    `docker compose up -d` and the new orchestrator refuses to start, the same four commands
    apply.
  - **The `chown`** runs a short container of the orchestrator's new image as root, with both
    volumes mounted (the screenshots' at `/data/shots`), and nothing else. It keeps the
    service's settings, so `--cap-add CHOWN` gives back the one capability `chown` needs:
    without it, root gets `Operation not permitted`. Keep `-R`: the files in the volume are
    root's too. The orchestrator checks the volume at start, so a file left behind is named
    rather than failing later, but for the screenshots themselves (`shots/<run>/`, not read
    at every start): one left root's fails only when it is served.

  New volumes are the `node` user's from the start.

- **On Kubernetes**, the orchestrator's pod refuses to start the same way on a claim the
  earlier release wrote. A rolling update would start the new pod beside the old one, still
  root, so: scale the orchestrator to 0, give its pod the security context in
  [What the manifests set up, and why](../kubernetes/isolation.md#what-the-manifests-set-up-and-why) (`fsGroup: 1000` hands its claims over as they are
  mounted, or a one-time `chown` init container where the storage ignores `fsGroup`), then
  update its image and scale it back.

- **Your server folder** (`config.yaml`, the grants folder and its `policy/`) is read as uid
  1000, as the policy service already reads it: the usual `0644` files and `0755` folders are.
  A `config.yaml` it can't read stops it at start, with `EACCES`.
- **The mount roots you grant** are resolved as uid 1000 too: a root, or a folder above it,
  that uid 1000 can't search makes every mount a repo asks for in it refused ("doesn't exist,
  or the listener can't see it"), not mounted. Make them searchable (`o+x` on the folders).

## Upgrading: the preview hook is gone (#574)

Deckhand no longer runs a repository's `preview.command` on its pull requests' events: the hook
held the host's Docker socket, so it was root on the host. What changes for you:

- **A `.deckhand.yaml` with `preview`**: its runs go on. The key is ignored, with a warning in
  the run's log and on the dashboard's config page (`preview: removed, ignored`); its
  maintainers can remove it. It no longer stops runs, nor auto-merge, nor a run on the
  Kubernetes runner.
- **The grants `preview` and `acknowledge_automerge_and_preview_is_highly_dangerous`** are no
  longer asked of your policies: a rule that still names them grants nothing, and is harmless.
  Remove them from `policy/` when you next edit it. The old YAML keys `allow_preview` and
  `acknowledge_automerge_and_preview_is_highly_dangerous` still load, ignored, with a warning
  in the orchestrator's log at start.
- **The runner's `previews/` folder**, in its volume (`runner-data`), is no longer written: the
  hooks' logs were there. You can delete it.
- **`DOCKER_SOCKET`** now only says where compose mounts the host's socket into the runner:
  nothing mounts it into another container.
- **To deploy previews**, add a webhook to the repository (or to an App of your own) for its
  `pull_request` events (and `workflow_run`, to deploy once CI has passed), pointed at a small
  HTTPS server of yours that checks the webhook's secret and deploys
  ([Preview deployments](../repo-config/issues.md#preview-deployments)). It gets what the hook got, with
  only the access you give it.

## Upgrading: the runner network's subnet (#543)

The `runner` network, between the orchestrator and the runner, took `172.31.253.0/24` by
default, inside Docker's default address pools, where it could clash with another network on
the host. Its default is `10.231.250.48/28` now. Only a deployment that followed `edge` while the
runner service had the old default (#530 to #543, no release) created the network on it. Compose
doesn't always move it to the new subnet:

- **Created by Compose 2.31 or later**: `docker compose up -d` sees that it changed, stops the
  orchestrator and the runner, recreates the network on the new subnet, and starts them again.
- **Created by an earlier Compose**: the network carries no hash of its settings, so every
  Compose, 2.31 and 5 included, keeps it as it is. It stays on `172.31.253.0/24` while the
  orchestrator's and the runner's `SERVICE_NETWORKS` name the new subnet, so they refuse each
  other's calls and no run starts.

Either keep the old subnet, where it doesn't clash on your host: `RUNNER_SUBNET=172.31.253.0/24`
in `.env`. Or take the new one once, whatever Compose's version: `docker compose down`, then
`docker compose up -d` (`down` removes the project's networks, not its volumes; the sandboxes
keep running, as in any update). `docker network inspect <project>_runner` shows the subnet the
network has.

## Upgrading the grants (#498)

The yes-or-no grants left the grants folder's YAML for your policies: each old key in
`default.yaml` or `<owner>/<repo>.yaml` is now an error, which stops that repository's runs (or
every run, in `default.yaml`) until you move it. Its message gives the rule to write. Write one
`allow_grant` rule per set of repositories in the grants folder's `policy/`
([the grants](../reference/server-folder.md#the-grants)), then remove the keys:

| Old key (grants YAML)                                                    | Grant (`input.grant`)                                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `allow_dockerfile: true`                                                 | `dockerfile`                                                                                  |
| `allow_branch_docker_images: true`                                       | `branch_docker_images`                                                                        |
| `allow_docker: true`                                                     | `docker` (one repository at a time)                                                           |
| `allow_research: true`                                                   | `research`                                                                                    |
| `allow_workflows: true`                                                  | `workflows` (one repository at a time)                                                        |
| `allow_auto_merge: true`                                                 | `auto_merge` (one repository at a time)                                                       |
| `allow_auto_merge: public`                                               | `auto_merge_public` (one repository at a time)                                                |
| any of them `: false`                                                    | none: remove the key                                                                          |
| `allow_preview`, `acknowledge_automerge_and_preview_is_highly_dangerous` | none: the preview hook is gone ([#574](#upgrading-the-preview-hook-is-gone-574)), remove them |

```yaml
# server/grants/acme/api.yaml, before
hosts: [pypi.org]
allow_dockerfile: true
allow_docker: true
```

```rego
# server/grants/policy/grants.rego, after (and hosts: [pypi.org] alone in acme/api.yaml)
package deckhand

allow_grant if {
  input.repo.name == "acme/api"
  input.grant in {"dockerfile", "docker"}
}
```

`input.repo.name` is lower case. A `true` key of `default.yaml` becomes a rule without
`input.repo.name`, for the grants that may go to every repository (`dockerfile`,
`branch_docker_images`, `research`); the others were never valid there. A `false` key
granted nothing, and nothing is granted by default now: remove it, never write a rule for it. In
a repository's own file, where it kept a grant of `default.yaml`'s from that repository, write a
`deny_grant` rule naming it instead, if a rule of yours grants it to every repository. Each
key's error says which applies. `hosts`, `cached_hosts`, `mounts`, `limits` and
`allow_projects` stay in the YAML. The runner now asks the policy service too: take the new
`compose.yaml` (or add an internal `policy-runner` network to your `runner` and `policy`
services).

A repository's `.deckhand.yaml` mode with `light: true` is an error too (`light: false` a
warning): its runs get what its policies give them now ([Modes](../repo-config/modes.md#modes)), and
Deckhand's `mode-work.rego` gives every repository mode work's writes as the ceiling. Its
maintainers remove it, and in `.deckhand/policy/` give the mode an `allow_capabilities` rule
without `push`, and `allow_github` and `allow_push` rules that leave it out: a rule on
`input.custom_mode` alone now gives a former comment-only mode work's writes (issues, pull
requests, labels, sub-issues). Such a mode's runs, without `push`, still move no project item and
set no needs-input label when they stop to ask, as before. What is decided before a run's
capabilities treats every repository mode as work now: its runs queue in work's order rather
than before work runs, a comment in it takes the issue's needs-input label off, and
`wait_for_answers` holds it back.

`light` is gone from every policy input too (`allow_run`, `allow_github`, `allow_push`,
`allow_link_branch`, `allow_request_review`): a rule reading `input.light`, yours or a
repository's, now sees it undefined without an error (`deny_… if input.light` denies nothing,
`not input.light` holds for every run). The config check warns of each file that reads it;
rewrite it on `input.mode`, or on what `allow_capabilities` gives.

## Upgrading: runs' reads of checks and projects

Runs' reads of checks and projects are new to `allow_github` and `deny_github`
(`action: "read_checks"` or `"read_projects"`, without a `target` or `change`). A deny rule of
yours written for writes that refuses whatever isn't in a list (`not input.target.kind in {…}`)
now refuses those reads too: guard it with `not input.action in {"read_checks",
"read_projects"}` ([Reading CI's checks](../repo-config/policy-inputs.md#reading-cis-checks)). `/mode policy` on
a pull request shows whether one does.

## Upgrading: allow rules

With allow rules ([Policies](../repo-config/policies.md#policies)), a decision is allowed only
when an `allow_*` rule matches, and Deckhand's `policy/allow.rego` allows each one, so nothing
changes for the built-in modes. A `policy/allow.rego` of yours in the grants folder replaces
it: keep its rules unless you mean to refuse. A repository's `.deckhand/policy/` is now a layer
of its own: its files no longer replace yours or Deckhand's by name (one that did, to broaden a
default, now only adds its deny rules: move the broadening to your grants folder), and its own
`modes:` get nothing until it allows them (`allow_github`, `allow_link_branch`,
`allow_request_review`). Rewrite the policies of repositories with their own modes in the same
release; their onboarding check and Policies tab say what no longer applies, as they do a
repository file that doesn't start with its `package` line (after comments only), now refused.

## Upgrading: per-mode policies (#496)

The modes' write ceilings built into Deckhand's
code are gone. A run's GitHub writes, its reads of checks and projects, and its pushes (a new
decision, `push`: [the push input](../repo-config/policy-inputs.md#the-push-input)) now need an allow rule
(`allow_github`, `allow_push`), which Deckhand's `policy/mode-<mode>.rego` files give each
mode as its ceiling did, with the refusals of the old per-feature files
([the default policies](../repo-config/policies.md#the-default-policies)); `allow.rego` no longer allows
`github`. Without policies, every write and push is refused. **A `policy/allow.rego` of yours
that kept `allow_github := true`** (as the note above said to) now allows every write of every
mode, an inbox entry's or a review's included, with no ceiling left to cap it: remove that
rule, and add no `allow_push := true`, unless you mean every mode to write or push all that
the built-in checks don't refuse. The orchestrator's log at start and each repository's
Policies tab warn of such a rule. Deckhand no longer ships
`github.rego` or the `gh-*.rego` files but `gh-checks.rego`, `gh-linked-branch.rego` and
`gh-reviewers.rego`: a file of yours in the grants folder that replaced one of the others by
name (to broaden a feature, say) now replaces nothing and only adds its rules beside the
`mode-<mode>.rego` files. To broaden a mode, replace its file instead (a copy of
`mode-work.rego` without its rule on `assign`, say). A repository's own `modes:` that push need
its `allow_push` too, as they need its `allow_github` to write.

## Upgrading: a grants folder

Upgrading from a version with a single grants file (`GRANTS_FILE`, `grants.yaml`): the
orchestrator reads a folder now, `GRANTS_DIR`, and refuses to start while `GRANTS_FILE` is set.
Move each `owner/repo:` entry to its own file, `owner/repo.yaml`, with its keys one level
up; `"*"` becomes `default.yaml`. Then mount the folder instead of the file
(`server/grants/`, see [the server folder](../reference/server-folder.md)) and remove `GRANTS_FILE`. For example:

```yaml
# grants.yaml, before
acme/api:
  hosts: [pypi.org]
```

```yaml
# server/grants/acme/api.yaml, after
hosts: [pypi.org]
```

## Upgrading: the Dockerfile and branch images granted

Upgrading from a version where a repository's `.deckhand.yaml` alone decided its Dockerfile
and branch images: grant them in your policies, for each repository that uses them (or every
one: a rule without `input.repo.name`), with `dockerfile` and `branch_docker_images`
([Upgrading the grants](#upgrading-the-grants-498)). Until then that repository's runs stop
with a reply naming the missing grant (the orchestrator's logs say why), and `allow_branch_docker_images` in its `.deckhand.yaml` is
ignored with a warning in the run's log.

## Upgrading: `ALLOWED_HOSTS` and the sandbox limits

Upgrading from a version with `ALLOWED_HOSTS` or `SANDBOX_CPUS`, `SANDBOX_MEMORY`,
`SANDBOX_PIDS`: what every sandbox gets is in the grants folder now, read at each run, and
the orchestrator refuses to start while any of them is set (in `.env` or `config.yaml`, where
`allowed_hosts: []` counts too). Move them to `grants/default.yaml`, then remove them:

```sh
# .env, before
ALLOWED_HOSTS=registry.npmjs.org,*.pypi.org
SANDBOX_MEMORY=8g
```

```yaml
# server/grants/default.yaml, after
hosts: [registry.npmjs.org, "*.pypi.org"]
limits: { memory: 8g }
```

## Upgrading: hosts in the grants folder alone

Upgrading from a version where a repository's `.deckhand.yaml` could add `hosts`: only the
grants folder lists hosts now (see
[Where a sandbox's hosts come from](../security/network.md#where-a-sandboxs-hosts-come-from)). A
repository's `hosts` are ignored with a warning, and a grants file still saying
`allow_repo_hosts` has an error that stops that repository's runs (or every run, in
`default.yaml`) until you remove it. Copy the hosts those repositories listed into their
grants file, `hosts: [...]` in `grants/<owner>/<repo>.yaml`, then remove `allow_repo_hosts`.
