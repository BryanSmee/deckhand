# Blob storage

The runner and the broker keep blobs: the runs' logs, a run's files and screenshots. Without
more, they keep them in their store, which with `file://` is disk. With `redis://` it is
Redis's memory, which a run history doesn't fit in for long: each of them then says so at start,
in its log and on the dashboard's status page (Settings › Server). **Blob storage** is a
second place for what will never change again, which each one's `BLOB_URL` names.

You need it with Redis as the store ([The store](store.md)), so that the logs and
screenshots leave Redis's memory. With the file store (Compose's default, one node), you don't:
the blobs are on disk already. It is optional either way: unset, nothing changes.

`BLOB_URL` is one of:

- **`s3://<bucket>[/<prefix>]?endpoint=https://s3.example.com&region=<region>`**: any
  S3-compatible server (Garage, MinIO, a hosted one), through path-style URLs. Deckhand calls
  PUT, ranged GET, HEAD and DELETE on single objects, under `<prefix>/` when there is one.
  `region` is `us-east-1` when left out (Garage's is `garage`). The key pair is
  `BLOB_ACCESS_KEY_ID` and `BLOB_SECRET_ACCESS_KEY`, or `BLOB_ACCESS_KEY_ID_FILE` and
  `BLOB_SECRET_ACCESS_KEY_FILE`, the paths of files holding them (a Kubernetes Secret's): never
  in the URL, which is refused with them. The secret key has 16 characters at least (shorter, it
  couldn't be told apart from ordinary text to redact it, and the service doesn't start): MinIO's
  default `minioadmin` won't do. Give the key access to that bucket alone.
- **`file:///<folder>`**: a folder, for one node (Redis as the store, the blobs on a volume):
  one file per key, directly in it, named as the store names its own blobs' files.
- **unset**: none, the blobs stay in the store, as before.

Only the runner and the broker get these settings: the orchestrator, edge, the github and the
models services never do. The secret key is one of their secrets: their store refuses it in a
value and redacts it from a blob, and their logs and blob storage itself redact it too.

The runner moves each closed segment of a run's log there (a log closes one at each step of
its run, at `LOG_SEGMENT_MB` and at its end), while the run goes on: once they have
moved, the store keeps only the segment still being written and each log's index. Nothing slows
a run's log down while its segments move: closed segments wait in the store for as long as blob
storage takes them slower than the log is written, as when it fails (below). Segments closed
before `BLOB_URL` was set move too: the runner finds them in the logs' indexes the first time it
acts with blob storage. Logs from before segments stay in the store until retention removes
them. Retention
(`LOG_RETENTION_DAYS`) deletes the segments in blob storage too. Don't unset `BLOB_URL` once
segments are there: their logs no longer read. The broker keeps the runs' screenshots there
([#609](https://github.com/BryanSmee/deckhand/issues/609)), written once as they come; retention
deletes them with their run. Its other files (a run's inbox, CA, digest) stay in its store.

When blob storage fails (down, or refusing the key), or the store does, closed segments wait in the store and are
tried again after 30 s, then a delay that doubles each time, up to 30 minutes; the runner's log
says why, and the dashboard's status page counts them and their size, so that you see Redis
fill up before it is full. They move once it answers again.

Each service checks its blob storage as it starts: it writes an object under
`.deckhand-check/`, reads it back and deletes it. When that fails (a wrong key, a bucket that
doesn't exist, a folder it can't write), the service stops with what failed rather than
finding out at a run's end, for instance:

```text
Broker: BLOB_URL (bucket deckhand at https://s3.example.com): can't write an object: S3 put .deckhand-check/1f0c…: 403 InvalidAccessKeyId (the access key isn't known there)
```

## What a server needs

Any S3-compatible server will do, if it takes:

- **PUT**, **ranged GET** (`Range: bytes=…`), **HEAD** and **DELETE** of one object, signed with
  AWS Signature V4 (the payload's hash signed, no chunked uploads), each object written once in
  one PUT (a log's segment, `LOG_SEGMENT_MB`, 8 MB by default; a screenshot, 10 MB at most);
- **path-style URLs**: `https://<endpoint>/<bucket>/<key>`, never `<bucket>.<endpoint>`;
- a missing object answered `404` (a HEAD or GET), not `403`: on Amazon S3, the key needs
  `s3:ListBucket` for that ([below](#amazon-s3)).

No listing, multipart upload, versioning or expiry rule (lifecycle) is needed: retention
(`LOG_RETENTION_DAYS`) deletes what it removes, object by object, and an expiry rule of your own
would delete logs and screenshots the dashboard still links to. Give Deckhand **a bucket of its
own and a key allowed that bucket alone**, to read, write and delete in it: the runner and the
broker share it (logs under `logs/`, screenshots under `shots/`, the start's check under
`.deckhand-check/`), and neither needs anything else of the server. HTTPS for a server outside
your network; plain HTTP is fine on a network of your own (Compose's Garage, below).

Checked against Garage (one node and three, `test/blob-server.test.mjs`, which runs against any
server when `TEST_BLOB_URL`, `TEST_BLOB_ACCESS_KEY_ID` and `TEST_BLOB_SECRET_ACCESS_KEY` name it),
and with Redis as the store (`test/blob-acceptance.test.mjs`, with `TEST_REDIS_URL` too): a
500 MB log keeps one segment in Redis once its moves caught up, and reads back whole.

## Garage with Docker Compose

[Garage](https://garagehq.deuxfleurs.fr) is a small S3-compatible server, made for clusters of a
few self-hosted nodes. `compose.yaml` runs one node of it with the `garage` profile, to try blob
storage or for a single host: its bucket (`deckhand`) and its key are made as it starts, from
the runner's and the broker's own key pair. In `.env`:

```sh
COMPOSE_PROFILES=garage   # beside `engine`, if you use it: COMPOSE_PROFILES=garage,engine
BLOB_URL=s3://deckhand?endpoint=http://garage:3900&region=garage
# A key id and a secret of your own (16 characters at least), for instance:
#   echo "BLOB_ACCESS_KEY_ID=GK$(openssl rand -hex 12)"
#   echo "BLOB_SECRET_ACCESS_KEY=$(openssl rand -hex 32)"
BLOB_ACCESS_KEY_ID=GK…
BLOB_SECRET_ACCESS_KEY=…
```

Then `docker compose up -d` (or `docker compose --profile garage up -d` without
`COMPOSE_PROFILES`): Garage starts first, the runner and the broker check its bucket as they
start, and say `Blob storage: s3, bucket deckhand at http://garage:3900`. Garage is on two
internal networks, one to the runner and one to the broker (`blobs-runner`, `blobs-broker`), no
way out and no published port; its objects stay in the `garage` volume. One node keeps one copy
of each object: back the volume up as you would the stores'. To change the key, change the pair in
`.env`: Garage adds the new key to the bucket as it restarts, and keeps the old one until you
remove it (`docker compose exec garage /garage key delete --yes <old id>`).

## Garage on its own

On a host of its own (one node), or on three for copies on several machines, from Garage's
[releases](https://garagehq.deuxfleurs.fr/download/) or its image (`dxflrs/garage:v2.3.0`).
Each node's `/etc/garage.toml`:

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
# 1 on one node; 3 on three, each object on every node.
replication_factor = 3
rpc_bind_addr = "[::]:3901"
# This node's address, as the others reach it.
rpc_public_addr = "<this node's address>:3901"
# The same on every node: openssl rand -hex 32. It lets a node join the cluster.
rpc_secret = "<64 hex characters>"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
```

Start `garage server` on each node, then, on one of them:

```sh
# Three nodes: the others joined (`garage node id` on each prints its <id>@<address>).
garage node connect <id>@<address>:3901
# Each node's role: its zone and how much it stores (garage status lists the ids).
garage layout assign -z dc1 -c 100G <node id>    # once per node
garage layout apply --version 1
# Deckhand's bucket, and a key allowed it alone.
garage bucket create deckhand
garage key create deckhand        # prints its Key ID and Secret key
garage bucket allow --read --write deckhand --key deckhand
```

`BLOB_URL=s3://deckhand?endpoint=http://<a node>:3900&region=garage`, with that key's id and
secret as `BLOB_ACCESS_KEY_ID` and `BLOB_SECRET_ACCESS_KEY`. Any node answers; put a load
balancer (or a DNS name for all three) in front of them, with TLS when the network isn't yours.
One node alone can skip the layout, the bucket and the key: `garage server --single-node
--default-bucket`, with `GARAGE_DEFAULT_BUCKET`, `GARAGE_DEFAULT_ACCESS_KEY` and
`GARAGE_DEFAULT_SECRET_KEY` in its environment, as `compose.yaml` runs it.

## Amazon S3

A bucket of its own (its region's endpoint, path-style URLs), and an IAM user (or role) whose
policy allows that bucket alone:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<bucket>/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<bucket>"
    }
  ]
}
```

`s3:ListBucket` makes a missing object a `404` rather than a `403` (Deckhand lists nothing).
`BLOB_URL=s3://<bucket>?endpoint=https://s3.<region>.amazonaws.com&region=<region>`, with the
user's access key as `BLOB_ACCESS_KEY_ID` and `BLOB_SECRET_ACCESS_KEY`. Other hosted services
work the same way, with their endpoint and region: a key scoped to one bucket, path-style URLs
(Cloudflare R2's region is `auto`).

## A server outside Compose

The runner and the broker have no way out in `compose.yaml`: every network they are on is
internal. Blob storage elsewhere (a hosted service, Garage on another host) needs one, which a
`compose.override.yaml` beside it adds, a network for each of them:

```yaml
services:
  runner:
    networks: [runner-out]
  broker:
    networks: [broker-out]
networks:
  runner-out:
  broker-out:
```

Compose merges these networks into theirs. One each, not one for both: on a network they shared
with a way out, Docker's DNS would answer the broker's name there first, and the runner's calls
would arrive on no network the broker takes them on. It is a way to any address, not to blob storage
alone, for a service holding the Docker socket (the runner): a firewall rule on the host
(Docker's `DOCKER-USER` chain) can narrow it to the server's address and port. A `file:///`
`BLOB_URL` needs none: mount the folder on both (a volume of its own), never one another service
mounts.
