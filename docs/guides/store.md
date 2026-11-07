# The store

Where each service keeps its state, and how to move it to Redis. With Compose on one host, the
default file store needs nothing from you; you need Redis when copies of a service run on
several nodes.

Deckhand's services ([services.md](../services.md)) keep their state in a store, which each one's
`STORE_URL` names. The broker service keeps its live runs, their files and events there
([The broker service](services.md#the-broker-service)); the runner the runs' logs and events and its lease;
the orchestrator its queue, its lease and its fencing epoch, and the state that holds data alone
(the titles, closed states and pull requests the dashboard shows, the dismissals, the run order,
the onboarded repositories, the lanes' names, the issues' modes, the rebase attempts, the last
dry runs, the reviewers requested), the waits, reviews and brainstorms, the live runs' states and
the runs' summaries, one key per item, so that a change writes only what changed: all of its
state, nothing beside it (#619);
edge the deliveries it took, the sessions' epochs and the deliveries' stream the orchestrator
reads.

- **`file:///data/store`**, a folder in the service's volume: on Docker Compose, and on one
  node. Several processes on that node may share it (two copies of a service, or one starting
  while the last drains): each call holds the folder's lock (`state.lock`, taken over once 10 s
  stale) and reads again what another process wrote. Calls made at once (a burst of
  writes) share one lock and one write of its `state.json`.
- **`redis://[user:password@]host:6379[/db]`**, or **`rediss://`** over TLS: on several nodes
  (a k3s cluster with more than one), where two copies of a service run on different nodes and
  a ReadWriteOnce volume can't be on both. `?prefix=` changes what goes before every key
  (`deckhand:`): each service needs one of its own (below). `REDIS_PASSWORD` gives the password
  when it isn't in the URL (from a Kubernetes Secret, say). With `rediss://`, Redis's
  certificate is checked against Node's CAs: a private one (a cluster's own, a self-signed
  certificate) is trusted through `NODE_EXTRA_CA_CERTS`, the path of its PEM file.

## Configuring Redis

The Redis backend speaks to Redis 7 or later (or Valkey) by itself, without a package. Its
leases and keys expire on Redis's clock, so copies on nodes whose clocks drift agree. Each
call is one Lua script, so Redis Cluster isn't supported: run a single primary, with a replica
if you want one. Configure it as follows (`redis.conf`, or the server's arguments):

```conf
# Kept on disk: the keys and the streams' events must outlive a restart of Redis. With
# everysec, a crash loses at most the last second. A lease's epoch is at least Redis's time in
# ms, so a lost write, or a failover to a replica behind (its clock in sync, NTP), never hands
# one out twice.
appendonly yes
appendfsync everysec
# Never evict: an evicted key or event would be lost.
maxmemory-policy noeviction
# No other network than the services' own, and one user per service, allowed the store's
# commands only (those its scripts call included: Redis checks them too) on its own keys alone.
# Each service's STORE_URL is redis://<service>@redis:6379?prefix=deckhand:<service>:, its
# password in REDIS_PASSWORD.
user default off
user edge on ><edge's password> ~deckhand:edge:* resetchannels -@all +evalsha +eval +time +exists +scan +hmget +hset +del +pexpireat +incr +xadd +xgroup|create +xreadgroup +xack +xdel +xinfo|groups +getrange +strlen +set +append +select +ping +quit
user orchestrator on ><orchestrator's password> ~deckhand:orchestrator:* resetchannels -@all +evalsha +eval +time +exists +scan +hmget +hset +del +pexpireat +incr +xadd +xgroup|create +xreadgroup +xack +xdel +xinfo|groups +getrange +strlen +set +append +select +ping +quit
user runner on ><runner's password> ~deckhand:runner:* resetchannels -@all +evalsha +eval +time +exists +scan +hmget +hset +del +pexpireat +incr +xadd +xgroup|create +xreadgroup +xack +xdel +xinfo|groups +getrange +strlen +set +append +select +ping +quit
user broker on ><broker's password> ~deckhand:broker:* resetchannels -@all +evalsha +eval +time +exists +hmget +hset +del +pexpireat +incr +xadd +xgroup|create +xreadgroup +xack +xdel +xinfo|groups +getrange +strlen +set +append +select +ping +quit
user github on ><github's password> ~deckhand:github:* resetchannels -@all +evalsha +eval +time +exists +hmget +hset +del +pexpireat +incr +xadd +xgroup|create +xreadgroup +xack +xdel +xinfo|groups +getrange +strlen +set +append +select +ping +quit
user models on ><models' password> ~deckhand:models:* resetchannels -@all +evalsha +eval +time +exists +hmget +hset +del +pexpireat +incr +xadd +xgroup|create +xreadgroup +xack +xdel +xinfo|groups +getrange +strlen +set +append +select +ping +quit
```

## Prefixes and users

**Each service needs a prefix of its own**, and so does each deployment sharing one Redis:
their keys aren't told apart otherwise. The github service keeps its runs' state under
`runs/<id>` and `runs/<id>/state` (`github/runs.mjs`), the same keys as the orchestrator's live
runs (`listener/restart.mjs`): on one prefix, each would overwrite the other's, and the
orchestrator, which removes a `runs/<id>` that holds none of its runs' state at every takeover,
would delete the github service's. So never leave two services on the default `deckhand:`:
give each `deckhand:<service>:`, as above and as the Kubernetes component does, and a user of
its own on it. A deployment that put several services on one prefix moves each to its own with
the services stopped: they start with an empty store, as when they first moved to Redis.

**The runner's `deployment` key** is the ID that its prefix's marker holds (`<NAME_PREFIX>-deployment`,
[security.md](../security.md#the-runner-service)). Copy it when you move the runner's store. A
runner that starts with an empty store makes a new ID, and then refuses every call until the
marker is removed: `docker volume rm <NAME_PREFIX>-deployment` on Docker, or
`kubectl -n <sandboxes' namespace> delete secret <NAME_PREFIX>-deployment` on Kubernetes. Remove
it only when no other deployment uses that prefix. The runner then claims the prefix again at its
next call, without a restart.

A user's key pattern follows its service's prefix: with `?prefix=team-a:orchestrator:`, it is
`~team-a:orchestrator:*`, else every call is refused with `NOPERM`. A user per service also
keeps each from reading or writing another's store. `+scan` lists a prefix's keys (a map kept
one key per item, read back whole when a copy takes over; the signed-in users edge counts), and
only edge, the orchestrator and the runner list theirs: Redis's ACL doesn't hold `SCAN` to the key pattern, so a user with it can
list the names of other users' keys (never read their values). Give a deployment that mustn't
see another's key names a Redis of its own. `requirepass <a long random password>` (the
`default` user) works too, but leaves every service every command and key, `FLUSHALL` and
`CONFIG` included. A call Redis doesn't answer within 5 seconds fails,
and the next one connects again: a copy that loses Redis learns in time that it can't renew
its lease.

On Kubernetes, `deploy/kubernetes/`'s `redis` component runs it this way, one user per service
([kubernetes.md](../kubernetes.md#several-nodes)).

## Redis with Compose

With Redis, the orchestrator needs no volume (#619): it writes nothing outside its store, on a
read-only root. On Compose, a `compose.override.yaml` beside `compose.yaml` (Docker Compose 2.24
or later, for `!override`), with the Redis above on a network of its own and its user for the
orchestrator (`ORCHESTRATOR_REDIS_PASSWORD` in `.env`):

```yaml
services:
  orchestrator:
    environment:
      STORE_URL: "redis://orchestrator@redis:6379?prefix=deckhand:orchestrator:"
      REDIS_PASSWORD: ${ORCHESTRATOR_REDIS_PASSWORD}
    networks:
      store:
    # Its data volume gone: the server folder alone (and the mount roots you grant).
    volumes: !override
      - ${DECKHAND_SERVER_DIR:-./server}:/etc/deckhand:ro
  redis:
    networks:
      store:
networks:
  # Redis and its callers alone, no way out.
  store:
    internal: true
```

Its user's key pattern follows that prefix (`~deckhand:orchestrator:*`); another service moved
to Redis gets its own the same way, never the orchestrator's. Coming from a release
before #619, keep the old volume mounted for the first start, which moves what it left there:
[Upgrading: the orchestrator without a volume](upgrade-notes.md#upgrading-the-orchestrator-without-a-volume-619).

## The run history's size

The orchestrator keeps each run's summary in its store
(`summaries/<run>`, what the dashboard's history is rebuilt from), until `LOG_RETENTION_DAYS`
(90 by default) removes it with the run's log. A summary is a few KB: the run's details, its
final answer's first lines and the text of the comments it acted on (more for a long comment).
So they take about a summary's size times the runs of those days: 50 runs a day for 90 days are
4,500 summaries, some 20 MB of Redis's memory at 4 KB each. With `0` (forever), they grow with
every run. With the file store, each is a file of its own in its folder (`keys/summaries%2F/`),
out of its `state.json`, which every lease renewal (each 5 s) writes whole. Each item of the
orchestrator's maps (a title, a pull request, a lane) is a file of its own too, in its map's
folder (`keys/titles%2F/`, …), so that changing one writes its file alone
([#691](upgrade-notes.md#upgrading-the-maps-items-a-file-each-691)), and listing one reads the names in its
folder alone ([#773](upgrade-notes.md#upgrading-a-folder-per-map-in-the-file-store-773)).

## No secrets in the store

Secrets never go in the store: the App's key, the signing key and the agents' credentials
stay in their service's own secret or volume. A write holding one the service knows, a
private key or a GitHub token is refused in a value or an event (`lib/store.mjs`,
`withoutSecrets()`): with Redis, every service using it could read it otherwise. In a blob (a
run's log, its files), the secrets and GitHub tokens are redacted instead.
