# Restarts

The orchestrator can restart at any time (an update is `docker compose pull && up -d`), or
stop without warning (a crash, an OOM kill). Sandboxes run detached, through the runner
service, which outlives the orchestrator (and the orchestrator it), and what drives the
orchestrator's decisions is saved as it changes, never only on SIGTERM (#508), so that a copy
killed at any moment leaves the next one the same as one that stopped. All of it is in its store,
nothing in a file of its own (#613, #619): with the file store, its `data` volume holds the
store's folder alone; with Redis, it has no volume, runs with a read-only root, and a copy on any
node takes over:

- **the queue**: the comments waiting for a run, in the store (`lib/store.mjs`, key `queue`),
  written whole whenever it changes (`restart.mjs` `saveQueue()`: a comment accepted, taken by a run
  or a running session, dropped, cancelled, put back by a run's end), with each task's `next`
  (`/model`, `/effort` for its next run) and the 👀 each comment got (saved once GitHub answers, the
  comment itself at once; on SIGTERM, those on their way are waited for, 10 s at most). Each comment
  has a `queueId` (one saved before them gets one as it comes back), and is loaded once whatever
  holds it. Its strings go there without the operator's secrets, GitHub tokens or private keys
  (`lib/store.mjs` `storable()`, from the same rules the store refuses a write by): a comment
  holding one by mistake is saved without it, and the whole queue still is. A run's end whose queue
  write fails keeps the queue in memory and tries again every 5 s (`removeLive()`, `QUEUE_RETRY_MS`)
  until it lands or the copy stops, the run holding its task meanwhile (no other run starts for it);
  its state is removed only after that write, so a copy that stops first leaves the next one the
  comments in the run's state. A `logs/<run>.queued.json` a release before #617 left (its way of
  keeping a task's queue when the store refused it) is read with the queue at the next start and
  removed after the next write that succeeds;
- **the runs**: each run's state in the store, key `runs/<id>` (`saveLive()`), an external run's
  too ([External runs](external-runs.md#external-runs)), at its start, a
  comment delivered, a phase, a result, a push, its reply; and, within a second
  (`saveLiveSoon()`), the lines of its output read so far; listed at the takeover
  (`restoreRuns()`). Never the run's tokens (#617): the next copy asks the broker service for
  those still valid (`POST /runs/:id/secrets`, its renewed ones included) and keeps them in
  memory only, to redact the run's output, asking again on each `renewed` event of the broker's
  stream. A `logs/<run>.live.json` a release before #617 left is moved there at the next start,
  its tokens dropped (the broker service is told them once, and keeps them sealed), then removed;
- **the timers, as deadlines**: a task's pause before its run (or before the comments go to its
  running session) is `dueAt`, saved with the queue; a run's silent-end grace (`ANSWER_GRACE_MS`) is
  `graceUntil`, saved with the run (re-armed once the follow has skipped the lines read before, its
  whole grace until then: the runner's `onCaughtUp()`, unless a new line pushed it back first; one
  that passed while no copy acted gets 10 s more for what the sandbox wrote meanwhile, which pushes
  it back); a brainstorm's idle time was already `deadline` (the store's `brainstorms`). The
  `setTimeout`s stay, and are re-armed from the deadline at start: what was left of it, or at once
  when it passed. The waits' checks (`WAITS_CHECK_MINUTES`) run at every start anyway, and the
  reviews' waits for CI or a merge keep when they began (the store's `reviews`), from which their
  next tick decides;
- **the maps that hold data alone** (titles, closed states, pull requests, dismissals, the run
  order, the onboarded repos, the lanes' names, the issues' modes, the rebase attempts, the last
  dry runs, the reviewers requested, #615): in the store, one key per item, `<map>/<key>`
  (`lib/store-map.mjs` `storeMap()`), read back whole once the copy holds the lease, before
  anything is restored. Its callers use a Map: each `set()` or `delete()` writes its own key
  alone, in order per key, a later write replacing one of the same key still waiting; one that
  fails is tried again every 5 s until it lands or the lease is lost (`/ready` says how many
  wait; a copy that stops waits for them, 10 s at most). Their values go without the
  operator's secrets, as the queue's (`storable()`): an issue's title is people's text. The run
  order keeps a rank per task, a moved task's between its neighbours', since the store lists
  keys in no order. At the first start after the update, each map's JSON file in `/data` is
  written there (the items the store doesn't have yet), then removed;
- **the maps behind timers and comments** (#616): the waits (`waits`), the issues waiting for
  input (`inputs`), the review loops (`reviews`), the brainstorms (`brainstorms`), the policy
  decisions (`decisions`), the auto-picks that are over (`picks`), the users' machines
  (`machines`) and the issues routed to them (`routes`), kept the same way, moved
  the same way from their JSON files at the first start after the update. Their deadlines are
  data (`deadline`, `since`, `ciWaiting`), armed again by the copy that loads them. The
  comments a wait holds go without a secret (`storable()`); what keeps them is the store's own
  access (docs/guides/store.md, its Redis ACL), not a file's mode.

What a release before kept in `/data` is moved at the first start after the update (the moves
above; the screenshots, `shots/`, to the broker, #609), so that start needs the old volume. The
older moves are gone (#619: a listener's `queue.json`, its App's credentials, `reactions.json`, the
run logs it kept itself): an install that still has those goes through a release before #619
first ([Upgrading: the orchestrator without a volume (#619)](../guides/upgrade-notes.md#upgrading-the-orchestrator-without-a-volume-619)). Once moved, the
emptied `logs/` and `shots/` are removed, and anything else beside the store is named in a
warning, for the operator to remove.

A comment moves from the queue to a run's state in that order: the run's state is written, then the
queue without it (`restart.mjs` `take()`, for a run's start and a running session's comments: until
a write of the run's state that has it succeeds, every write of the queue, another task's or a 👀's,
still has it, once); and back the other way at a run's end, or a restored run whose sandbox never
started (the queue with the comments put back, then the run's state removed, `runs.mjs`
`teardown()`). A copy killed between the two writes finds the comment in both, and leaves it to the
run (`loadQueue()`, by `queueId`): never in neither. A change that writes one of the maps above and
the queue orders its two writes the same way, by `storeMap()`'s `after` (a write of a key that waits
for a promise, the key's later writes too) and `written(key)`:

- **a wait released** (its issues done, or its questions answered: `waits.mjs` `releasing()`):
  the comment queued and the queue written (`restart.mjs` `queueWritten()`, tried again while
  the store is away), then the wait deleted. Killed in between, the next copy finds both, and
  drops the wait whose comment (its `queueId`, given when it began to wait) is queued or
  running (`waits.mjs` `dedupe()`);
- **a queued comment moved to a wait** (the dashboard's Queue after…, `work.mjs` `requeue()`):
  the wait written (`hold()` resolves once it is), then the queue without the comment
  (`restart.mjs` `park()` keeps it in the queue's writes until then). Killed in between, the
  next copy finds both, and leaves the comment to the wait: `loadQueue()` drops the queueIds the
  wait keeps (`unqueued`);
- **a brainstorm ended** by the comment that starts work or another mode (`brainstorms.mjs`
  `end()`): the comment queued and the queue written, then the brainstorm deleted. Killed in
  between, the comment is queued and the brainstorm still there, as if it hadn't come yet.

A run's start takes its task's
`next` and saves the queue without it, so a restart mid-run doesn't hand it to the next run too.

Restoring is one path (`restart.mjs`), the same at a start after a stop, after a crash, and for
a copy taking over from another (#506): `unifySpellings()`, `restoreRuns()` (the runs' states:
their tokens work again, comments find them), `loadQueue()` (the tasks rebuilt from the store,
their deadlines re-armed), then `reattach()`. They run once the copy holds the `orchestrator`
lease (`lib/active.mjs`): a copy that starts while another acts waits for it, opening only its
probes (`/ready` answers 503), and restores nothing until then. On SIGTERM the acting copy starts
no more runs, stops its timers, refuses edge's and the runner's calls (503: they ask again),
stops reading the streams (the deliveries being handled are acknowledged first), waits for the
writes under way, then **releases the lease**: the waiting copy takes it at once (about a
second). After a crash the lease expires (15 s, `LEASE_SECONDS`) and the waiting copy takes it
then; with one copy (Compose's default), the next one takes it as it starts. A copy that loses
its lease while acting exits. Each holder's epoch fences the copy before it (Fencing in
[upgrades.md](upgrades.md#edge-and-the-orchestrator)).

The next copy finds the sandboxes by their labels, follows their output from where the previous one
stopped (a copy killed within a second of reading some lines reads them again, and its log has them
twice), and posts each reply once. A recreated container isn't on the networks the old one was
joined to: the new copy has the runner join the egress proxy to the running sandboxes' networks
first (`runner.relink()`), and again every minute, for a proxy recreated on its own; the networks,
container engines and engine volumes of runs that are gone are removed then. A sandbox the
orchestrator started itself while it was still finding the previous copy's is its own, never taken
for a leftover. Queued comments whose author or repository is no longer allowed are dropped then;
each run checks its comments' authors against the repository's `users` again when it begins, and so
does the next copy for comments queued for a run still going.

Webhooks no longer reach the orchestrator: edge takes them, and puts each verified delivery on
the `deliveries` stream of its store before it answers `202`. The orchestrator reads that stream
(`edge/client.mjs` `consume()`), handles each delivery (`listener/http.mjs` `deliver()`, which
resolves once what it admitted is done) and acknowledges it then; one handled whose
acknowledgement was lost is taken once (`deliveries/handled/<guid>` in its store, an hour). So a
delivery that arrives while the orchestrator restarts waits in the stream, and the next copy
reads it from the last acknowledged event.

**Edge's own restart.** Edge keeps nothing in memory that matters: its deliveries' GUIDs, the
sessions' epochs and the redeliveries' state are in its store. On SIGTERM it takes no new
connection, lets the requests in flight finish (`DRAIN_SECONDS`, 25 s; a live log streams until
the browser reconnects), hands the redeliveries' poller's lease (`edge/redeliveries`) to the
other copy, then exits. A delivery it refuses meanwhile, or that reaches no copy, gets `503` (or
no answer), which GitHub marks failed and the next scan redelivers ([Missed
deliveries](#missed-deliveries)). Two copies, both active on one store, take over each other's
requests: a rolling update starts the new one first ([Running two copies](../guides/two-copies.md)). The
orchestrator away (handing over), edge waits for it up to 15 s on each call it passes on, then
answers `503`.

A restart delays the runs' calls rather than failing them (#507, #511). Nothing a sandbox calls
during a run reaches the orchestrator: it calls the services by their own names
(`lib/services.mjs` `SANDBOX_URLS`: `http://broker:8081`, `http://github:8080`,
`http://models:8080`), which only the egress proxy reads (a sandbox resolves none), two ways:

- **relayed**: GitHub's API and git's fetches (`gh`, `git clone`), and the hosts an agent has
  relayed (`relayed` in `agents/`, Antigravity's Google endpoints), whose HTTPS the proxy
  decrypts and sends to the github service's `/relay/<host>/` (GitHub's, the policy's
  `service: "github"`) or the models service's (an agent's, `models: true`);
- **forwarded**: plain HTTP to a service's name (none is in the sandbox's `NO_PROXY`): the
  agents' APIs set to the models service's (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
  `GOOGLE_GEMINI_BASE_URL`), pushes to the github service's git gateway (`DECKHAND_GIT_URL`,
  `pushInsteadOf` in `entrypoint.sh`), the run token's renewal, the inbox and the run's files to
  the broker's (`DECKHAND_BROKER_URL`). The proxy asks the policy whether that client may reach
  the name (a running sandbox or its engine: `forward=1`; never as a tunnel), and sends the
  request to its own URL for that service (`BROKER_SERVICE_URL`, `GITHUB_SERVICE_URL`,
  `MODELS_SERVICE_URL`), on the paths that service takes from sandboxes only (`/run/`, `/git/`;
  `/anthropic/`, `/openai/`, `/google/`).

Either way the proxy's own service token goes with the call, the sandbox's credential moved to
`x-deckhand-run-token` (the broker's, the models service's) or `x-deckhand-run-authorization`
(the github service's), and the network the policy gave for the sandbox in `x-deckhand-sandbox`,
which the run's tokens are bound to. The orchestrator's restart doesn't touch these calls, and
the models service drains for as long as an agent call lasts, 10 minutes
([upgrades.md](upgrades.md#the-models-service)). The orchestrator asks the models service which
credentials it holds before it reads its settings: it waits for it at start.

The egress policy, which the proxy asks about every sandbox connection (to any host), has a port
of its own (`POLICY_PORT`, 8082). On SIGTERM the orchestrator answers edge's and the runner's
calls on its services port with `503` (they ask the next copy); once its lease is released, it
ends the dashboard's open streams (their pages reconnect, through edge, to the next copy), and
closes the egress policy's port last, its answers in flight sent (5 s at most), so that the
proxy's next questions are refused and waited for rather than cut.

The egress proxy waits for the next copy meanwhile (`proxy/wait.mjs`): a connection the
orchestrator refused (a waiting copy refuses them all), or that failed before it was made (reset
while connecting, its name unknown while its container is gone), never reached it, and a `503`
(the policy can't tell yet who asks: the runner away, #936) or the policy's answer not coming
within 5 s decided nothing either, so the proxy
tries again, with a growing delay (0.25 s doubling up to 5 s), for up to 5 minutes before it
refuses the host. With one copy of each (compose), the next orchestrator only starts once the
previous one has exited; with two, both are on the proxy's network under the name
`orchestrator`, and the proxy tries the address Docker's DNS gives until the acting copy takes
it. A service it forwards to is waited for the same way, for any method, a POST included: a
request is only sent once a connection is made, and never sent again (a copy that dies with it
gives the sandbox a `502`). Every agent's CLI sends an `http://` base URL through `HTTP_PROXY`
(checked against Claude Code 2.1.300, Codex 0.162.1 and agy 1.4.0), as do git and Node's `fetch`
(with `NODE_USE_ENV_PROXY`).

The egress proxy drains on SIGTERM too, for 25 s (compose's `stop_grace_period` for it is 30 s):
no new tunnel, the requests in flight finish, and the decrypted tunnels close once their
requests are answered. Its grace is short on purpose: the next proxy only starts once it exited,
and the sandboxes' new connections are refused meanwhile, with nothing to try them again. A raw
tunnel is never known to be idle, so one still open at the end is cut, and so is an agent's
answer still streaming through the proxy to the models service after 25 s: an update to the
proxy's image may fail a turn, where the orchestrator's update only delays it.

Running sandboxes outlive an update: they keep their image, and its scripts, until they end.
So an endpoint that sandboxes call is kept across one update: the sandboxes in flight while it
happens still find what they call after it. Once a release no longer calls an endpoint, the
next one may remove it: its last callers were started before the release that stopped calling
it, and none of them may still run when the next one is deployed (`docker ps --filter
label=deckhand.run` on the server lists the running sandboxes). That is one of the three
cases of [Runs in flight](#runs-in-flight).

A run's tokens outlive a restart: the broker service (`broker/`) signs them, with a key only it
holds, and keeps the live runs in its store; they name the run by its id, which the run's state in
the orchestrator's store keeps (`runs/<id>`, without its tokens), so the next copy of the
orchestrator checks them with the broker's public keys as the last one did, and tells the broker the
runs it picked up go on (`PUT /runs/:id`, with their claims: a run whose end the broker missed while
no copy acted is ended there, `GET /runs`). It asks the broker for each one's tokens still valid
(`POST /runs/:id/secrets`, the orchestrator's alone and fenced by its epoch), which it redacts from
the run's output; the broker keeps every token it signs sealed for that (#617). A renewal
(`POST /run/token`) goes through the egress proxy to the broker service, which the orchestrator's
restart doesn't stop (the proxy still asks the orchestrator's egress policy about the call first,
and waits for it); `deckhand-token` gives up on one after 30 s (`curl --max-time 30`) and asks again
every 30 s; a token that expired meanwhile still renews, from its own sandbox, for 7 days
(`RENEW_GRACE_MS`), and the renewed one is bound where it was.

## Runs in flight

An update never waits for the runs (#441). A change to what the services and the sandbox agree
on, the contract, meets three kinds of runs that started, or start, under another release:

- **Running sandboxes under the new services.** They keep their image, its scripts
  (`entrypoint.sh`, `deckhand-token`, `deckhand-files`, `deckhand-inbox`, the agents' hooks)
  and the variables they started with, and call the new services with them: an endpoint they
  call is kept one update (above), an answer they read keeps its old form as long.
- **New runs on an older sandbox image.** The services' images and the sandbox's are pulled
  separately. Compose's `sandbox` service exits as soon as it starts (`entrypoint: ["true"]`),
  so an updater that follows running containers never pulls it; and a release builds its
  images in parallel (`.github/workflows/release-workflow.yml`'s matrix), so one may be
  published before another. A repository's image is built from the base it finds
  (`listener/images.mjs` `imageTag()` hashes the base's id, so it is rebuilt once the base is
  pulled, not before). A new run then gets the new services' variables in the old image's
  scripts: #393 passed `DECKHAND_CA` as a broker URL, which an older entrypoint read as a file
  that didn't exist, so it trusted no CA and the run failed at its first GitHub call through
  the proxy, on TLS.
- **Runs the next orchestrator picks up.** Their state in the store (`runs/<id>`), their
  tokens' claims (`ver`, [security.md](../security.md)) and what the broker, the egress proxy and
  the gateways decide for them were written under the old release's rules: a decision the new
  one makes for every run (decrypting a host, say) reaches runs whose sandbox was started
  without what it needs (the CA).

A pull request that touches the contract (the variables a run starts with, the endpoints a
sandbox calls, the egress proxy's answers, a run's saved state, the claims, the sandbox's
scripts) says under a "Runs in flight" heading which runs, if any, break and how, and picks
one of:

- a shim on the services' side: the old endpoint or answer kept for one update, or answering
  with where to go;
- a fallback in the sandbox's scripts that reads both the old form and the new;
- a check that fails a run at its start with what to run (`docker compose pull sandbox`), when
  neither side can bridge the change;
- a one-time recovery the operator runs, written in the pull request.

Whichever it is, a run that can't work stops at its start with a message, never later on an
error that doesn't say why.

**Finding the runs an update broke** (Docker; `deckhand.owner` is `NAME_PREFIX`'s value,
`deckhand` by default). Pull the base image with the rest, then list the running sandboxes,
their image and when they started:

```sh
docker compose pull && docker compose up -d
docker ps --filter label=deckhand.owner=deckhand --filter label=deckhand.run \
  --format '{{.Names}}  {{.Image}}  {{.RunningFor}}'
```

A sandbox whose image lacks what the change added (a script, a variable it reads) is one of
them: `docker exec <name> sh -c 'command -v <script>'` tells. Stop each with the dashboard's
**Stop** or a `/cancel` comment on its issue ([Stopping a run](queue.md#stopping-a-run): its reply
says who stopped it, its session and pushed commits are kept), then comment on the issue
again: the next comment resumes it, on the new image.

## Run files

A run's inbox, the egress proxy's CA and the run's digest are the broker service's
(`broker/files.mjs`, #505), blobs in its store, copied there by the runner from its runs folder as
they change (`listener/runner/inbox.mjs` `mirror`), and its screenshots are the broker's too, in
blob storage (`BLOB_URL`, or its store without it, #609); no sandbox mounts either (#393): a volume
shared with sandboxes on other machines would need ReadWriteMany storage. The sandbox calls the
broker service for them, through the egress proxy, with the run token, from its own sandbox only
(the proxy vouches for its network, `x-deckhand-sandbox`, with its own service token):

| Call                         | From the sandbox                                                                                                                             | Answer                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /run/inbox?from=<byte>` | `deckhand-inbox`, the agent's input (`TASK_INBOX` is this URL)                                                                               | the whole lines after that offset (at most 1 MiB, a longer line alone), waiting up to 25 s for one (`204` without); `deckhand-inbox` adds what it read |
| `GET /run/ca`, `/run/digest` | `deckhand-files get`, once at start (`DECKHAND_CA`, `TASK_DIGEST`)                                                                           | the file, which `entrypoint.sh` keeps in `/tmp/deckhand` and names in the same variable; the run stops if it can't fetch it                            |
| `PUT /run/shots/<file>`      | `deckhand-files shots`: at the agent's Stop hook, on each push (the hook after `git push`, `pre-push`), before each `gh` call, and every 3 s | `204`; a name GET /shots doesn't serve (`400`), a file that isn't the PNG, JPEG or WebP it says (`415`), over 10 MB or the run's 100 MB (`413`)        |
| `POST /run/permissions`      | `deckhand-permissions`, a chat's agent asking for more (`TASK_PERMISSIONS` is this URL; #479)                                                | `202` with the request's id, said on the `runs` stream; a run that isn't a chat's `403`, past 50 requests `429`                                        |
| `GET /run/permissions/<id>`  | `deckhand-permissions`, waiting for the answer                                                                                               | `{ state, message }` once the orchestrator answered, waiting up to 25 s for it (`204` without); another run's request `404`                            |

The runner's inbox file (`runner/inbox.mjs`, `<dataDir>/runs/<run>/`) is the truth, and the broker's
blob a copy of it: the CA and digest are put there before the sandbox starts (or the start fails),
and each change of the inbox is appended from the offset the broker has
(`POST /runs/:id/inbox?offset=`, `broker-service.mjs` `sync()`). Each append is one atomic step of
the store (`appendBlobAt()`: a Lua script on Redis, under the file backend's lock), which skips what
the blob already has and refuses a write past its end, so a retry, a lost answer or two copies
taking writes out of order never lose, repeat or reorder a line, and a write the store failed leaves
nothing. The blob is the file byte for byte: the runner redacts a token's shape in a message before
it writes it, and the store refuses an append it would redact rather than make the two differ: the
broker's own key (its own part, not the PEM armour every key shares, so a message quoting
`-----BEGIN PRIVATE KEY-----` goes through), which holds up that run's inbox from there, as it
should never be in a comment. The same bytes sent again add nothing, a broker away gets them once it
is back, and a restarted runner sends what the broker doesn't have. So either copy of the broker, or
one restarted, answers from the same offset, and the agent gets every line once. A screenshot is
written once into blob storage (`shots/<token>/<file>`), its name and size in the broker's store
(`shots:<token>`: the run's cap, and what retention deletes, as blob storage lists nothing), and
goes on the broker's `runs` stream, which the orchestrator reads and acknowledges (`GET /events`,
`consume()`) without copying anything. Edge serves it to anyone (`GET /shots/<token>/<file>`,
`edge/shots.mjs`), from the broker, with its service token, streamed through as the broker reads it
in parts (256 KiB at a time), so neither holds a whole file for a reader; the orchestrator stays out
of it. It stays past the run's end, for the links to it, until retention removes its run
(`history.mjs`: `DELETE /shots/<token>` at the broker, as the runner removes the log). An
orchestrator of a release before #609 kept them in its `shots/` folder: at its start, the
orchestrator sends each folder there to the broker, file by file (`PUT /shots/<token>/<file>`,
regular files only, never through a link), then removes it (`moveShots()`), so the links of replies
posted before still work; a folder no run names, older than `LOG_RETENTION_DAYS`, is removed
instead, as retention removed those, and a younger one is noted in the orchestrator's store
(`history/unnamed-shots`), for retention to remove at the broker once it is past the days. One
uploaded to a broker of the release before and not copied yet is still served from its store, and
adopted when the orchestrator reads its `shot` event (`POST /shots/<token>/<file>`: moved into blob
storage, its name kept for good, where that broker's record of it expired in a day). The sandbox
keeps `SCREENSHOT_DIR` (`/tmp/screenshots`) in its own filesystem. The agent's CLI replaces the
entrypoint, which has no step after it: the agents' Stop hook (`sandbox-draft-pr hook`, after each
turn, before its result line) is the last upload, and the 3 s watcher covers what saves files
outside a turn. A refusal for the file (its name, size or type: `400`, `413`, `415`) is final until
it changes, and said on stderr by the next `gh` call or push, where the agent reads it, even when
the watcher or a hook (whose stderr is only the run's log) met it first; any other is tried again.
Fetching the CA or digest at start retries a 401, 403 or 5xx for a minute; only a 404 fails at once.
Uploads in flight reserve their size, so parallel ones can't pass the run's cap together, and a name
has one at a time: a second gets `409`, tried again later. The hooks upload last (an `EXIT` trap in
`draft-pr.sh`, which sets `DECKHAND_SHOTS_SKIP` so its own `gh` calls don't), and every caller
within 20 s: opening the draft pull request keeps the hook's 60 s.

The dashboard's run list comes back from the runs' summaries (`summaries/<run>` in the
orchestrator's store, written when a run ends, listed at the lease's takeover: the same after a
handover or a crash; those an older release kept in `logs/<run>.json` or `logs/<run>.summary.json`
moved there first); a run still live is listed from its saved state. A summary the store doesn't
take at the run's end is tried again every 5 s (`runs.mjs` `summarySaved()`, `QUEUE_RETRY_MS`) until
it lands, the run keeping its sandbox, its state and its task meanwhile: kept nowhere else since
#619. A copy that stops first leaves the run as it is, for the next copy to end again. Such a run
holds its task and a parallel slot, as one whose queue write or state's removal waits
(`removeLive()`), which a store refusing it for good (a summary file it can't write, a Redis ACL
without `summaries/`) would make last: not given up, as an hour's outage looks the same and the
summary is kept nowhere else, but said (#821, `restart.mjs` `endWait()`): the orchestrator's
`/ready` counts them (`ending`), the dashboard's status page lists each among the orchestrator's
warnings (what waits, since when, the store's error), its metrics count them
(`deckhand_runs_ending`, which `DeckhandRunsEndingStuck` alerts on after 15 min, #861), and the log
says it again every 10 min. A restored run takes comments once the runner says its inbox is still
open, waited for 10 s at start, later if the runner is away. The list is held newest first with an
index by id, and both lose the runs `history.mjs` removes, at start and daily: those older than
`LOG_RETENTION_DAYS`, but for a running run and the latest run of a task still queued, in a
brainstorm, waiting or waiting for input. The orchestrator's state decides which those are, so the
orchestrator decides, and has the runner remove their logs, then deletes their summaries' keys: a
run whose log the runner didn't remove, or whose summary's key the store didn't delete, stays listed
until the next day's try.

## Missed deliveries

GitHub never retries a failed webhook delivery by itself: one sent while edge is down or restarting,
answered `503` while it stops, while its places for unverified bodies are full or while its store is
away, or cut by a reverse proxy, is lost unless it is redelivered. The redeliveries are edge's
(`listener/redeliveries.mjs`, run by `edge/server.mjs`), on the one copy holding the
`edge/redeliveries` lease of its store (`lib/active.mjs`; the other takes it once that one stops, or
15 s after a crash). That copy lists the App's deliveries with its JWT (`GET /app/hook/deliveries`,
through the github service as the App, newest first, by cursor) as it takes the lease, then every 5
minutes; the dashboard's Sync (`POST /api/sync`, once per 30 seconds) and the orchestrator's start
ask edge for a scan too (`POST /redeliveries/scan` on edge's internal port, which either copy
answers). A scan goes back to the last one (less 10 minutes, at most 3 days, GitHub's retention),
whose time is kept in edge's store (`redeliveries/scanned`). Each GUID none of whose attempts
succeeded, whose latest attempt couldn't connect, timed out or got a 5xx, is redelivered
(`POST …/attempts`), once: the GUIDs asked for are kept in the store 3 days
(`redeliveries/asked/<guid>`, set if absent, so two copies never ask twice), and a 4xx is edge's own
refusal (a bad signature), which would come again. A redelivery keeps its GUID: a delivery edge took
is kept as `deliveries/<guid>` in its store (set if absent, a day; a mark left by a copy that died
taking it is taken again a minute on), so one it took already, by either copy and across restarts,
is neither asked for nor put on the stream twice. Edge answers `202` as soon as the delivery is on
the stream, so GitHub rarely times one out. Comments come back oldest first, whatever their age. A
redelivered `pull_request` delivery (`redeliveries.mjs` `redelivered()`, the GUIDs it asked for) is
handled as its pull request is now (`events.mjs` `replayedPull()`): its payload is as old as the
failed attempt, maybe older than deliveries handled since. Its current state is recorded, and an
action the pull request no longer matches (ready since merged) becomes `edited`, so nothing turns
ready, closes or starts a review from it.

At the orchestrator's start and from the dashboard's Sync, the scan edge makes goes with the open
pull requests' states read again (`pulls.mjs` `resync()`), through `sync.mjs`. The dashboard's then
runs a conflict pass (`conflicts.mjs` `check()`, see Conflicts) after `resync()`, so a pull request
merged or closed meanwhile isn't checked. The last one's result is kept in memory and sent in
`api/state` (`lastSync`): when it ended, who asked (`null` for the orchestrator at start), how many
deliveries were asked again, pull requests changed and rebase runs started (`conflicts`, 0 at
start), and the error of a part that failed (the other parts' counts are kept). `POST /api/sync`
answers the same record, `502` when it failed.

A delivery whose handling throws (`dispatch()`) is logged with its event and action; the
orchestrator acknowledges it and goes on with the next one. GitHub got its `202` already, so it
isn't redelivered.

Pull request states don't hang on deliveries alone: the orchestrator records the changes it makes
for runs (`github-pulls.mjs`: ready, draft, opened, edited) in the store's `pulls` at once (the
`ready_for_review` delivery that follows keeps its `readyAt`: one notification), and asks
GitHub about every open pull request it knows again at start and from Sync
(`pulls.mjs` `resync()`), so a `ready_for_review`, merge or close older than the redelivery
window still shows.

A task's pull request also carries its size and commit count (`additions`, `deletions`,
`changedFiles`, `commits`), as the last pull request object that had them said: deliveries
(`synchronize` included, a push to its branch) and single lookups have them, listings don't,
so `fill()` asks once for the size of a task's pull request that has none, whatever its state
(a closed one's never changes), and `resync()` for an open one. A run records its last
push GitHub took (`branch`, `lastPushAt` on its record): the git gateway reads GitHub's
report for the refs it updated and tells the broker's entry for the run (`watchPushes()`,
`restart.mjs`), whose record is saved with the run, so a restart keeps them.

A task's pull request carries its `head` commit too, and what CI says of it (`ci`:
`{ sha, state, runs }`, #436), decided by the rule auto-merge uses (`ci.mjs` `ciState()`) over the
commit's Actions runs, check runs and commit statuses (`commitCi()`; one GitHub refuses, an
installation that hasn't accepted `checks` or `statuses`, is left out; any other failure, a rate
limit's 403 included, records nothing, rather than CI without that part; each list is read page by
page). A `workflow_run`, `check_suite` or `status` delivery for the head of an open pull request
reads it again (`ciChanged()`, one read at a time per task, one more after those that came
meanwhile, a failed one included), without holding the delivery's place among those the orchestrator
handles at once; one for any other commit (an older head) changes nothing. A new head (from a
delivery no older, by its `updated_at`, than the one that set the last) resets it to `none` and
reads it at once: the delivery that said it changed may have been handled before the pull request's
own. `check_suite` and `status` are `QUIET_EVENTS` (`github-app.mjs`): edge passes on only what
`ciDelivery()` reads of them (`quietPayload()`), for allowed repositories, without their GUID or a
log line, and at most one per commit the orchestrator hasn't read yet (`ciWaitingKey()`, cleared
when it reads it: its handling reads the commit's CI after the ones left out), so they never crowd
the stream. The orchestrator handles them without a log line, and the redeliveries skip them:
`resync()` starts, once it resolved and four at a time, a read of the CI of each open pull request
not settled for its head (never read, `none`, still running, or whose last read failed, `ciFailed`:
a 5xx or a rate limit records nothing), at start; a user's Sync reads every open one's again
(`allCi`), for a delivery lost on a settled head. A merged or closed one keeps the last CI known.
