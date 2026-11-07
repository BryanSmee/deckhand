# Logs and health checks

Where each service's log lines go, how to read them or send them to a collector, and how
Compose checks that each service is up. Start here when a run doesn't start, or a service
doesn't come up; what the lines don't count, the services' [metrics](metrics.md) do.

Each service writes its own lines to stdout, one per event: its runs' output never goes there
(the runner keeps it, the dashboard shows it). Every line goes through the same redaction as the
runs' output first, GitHub's and Deckhand's own token shapes and the service's own secrets (the
App's key, the session key, the agents' credentials): once logs leave the host, a leaked token is
hard to get back.

## Format and level

Two settings, in `.env` (`compose.yaml` passes them to every service):

| Setting      | Default                                    | What                                                      |
| ------------ | ------------------------------------------ | --------------------------------------------------------- |
| `LOG_FORMAT` | `text` with `compose.yaml`, `json` without | `text` for `docker compose logs`, `json` for a collector  |
| `LOG_LEVEL`  | `info`                                     | `debug`, `info`, `warn` or `error`: the lines below it go |

`text` reads as before: the time and the message, the level when it isn't `info`, then the
fields that apply (`request=… repo=… issue=… run=…`). `json` is one object a line (spread out
here):

```json
{
  "ts": "2026-11-02T10:00:00.000Z",
  "level": "info",
  "service": "orchestrator",
  "msg": "acme/api#42: cancelled by alice",
  "request": "4f1c2a9e0b7d6e35",
  "repo": "acme/api",
  "issue": 42,
  "run": "dh-acme-api-42-1762077600000"
}
```

- `ts`, `level`, `service` and `msg` are on every line; `repo`, `issue` (an issue, pull request
  or discussion number) and `run` when the line is about one.
- `request`: edge gives each webhook and dashboard request an ID, and every service it reaches
  (the orchestrator, then the runner, the github service, the broker, the models and policy
  services) logs it, as the call carries it (the `x-deckhand-request` header). One search
  follows a webhook across them. A call that comes with none (a timer, a sandbox's own call) gets
  one of its own there.

## With Compose

With Compose, Docker keeps each container's lines in its `json-file` driver, rotated: five files
of 10 MB each per container (`compose.yaml`'s `x-logging`, which every service uses), the
oldest dropped first, so a long-running deployment never fills the disk with them. Read them
with `docker compose logs`: `docker compose logs -f --since 1h orchestrator runner` follows
two services, `docker compose logs --tail 200` shows the last lines of each.

## To a collector

On Kubernetes, the services log JSON (their default, `LOG_FORMAT` unset), which the
node's agent (Promtail, Alloy, Fluent Bit) sends to Loki or VictoriaLogs as it is. With Docker,
`LOG_FORMAT=json` in `.env` and one of Docker's logging drivers do the same. Deckhand ships no
collector. With Loki:

- Keep labels to what the cluster or the driver adds (namespace, pod or container, service).
  Leave `repo`, `issue`, `run` and `request` as JSON fields to filter on, never labels: each run
  would make a new label value, and Loki slows down with too many.
- Filter on them in the query: `{container="runner"} | json | run="dh-acme-api-42-…"`, or
  `{namespace="deckhand"} | json | request="4f1c2a9e0b7d6e35"` for one webhook everywhere.
- Error rates for alerts come from the lines: `sum by (container)
(count_over_time({namespace="deckhand"} | json | level="error" [5m]))`. What the lines don't
  count, the services' [metrics](metrics.md) do.

To send the lines to your own stack with Docker, a `compose.override.yaml` beside
`compose.yaml` (Compose reads it with `docker compose up -d`, no flag needed) gives each service
another driver: `fluentd`, `gelf`, `journald`, `loki` (Grafana's plugin, installed on the host
first) or any other. A driver other than `json-file` takes none of its options;
`docker compose logs` still reads the lines, from the local copy Docker keeps beside any driver
(its dual logging, unless `cache-disabled`). With GELF, say:

```yaml
# compose.override.yaml: an anchor is a file's own, so this one names each service again.
x-logging: &logging
  driver: gelf
  options:
    gelf-address: udp://graylog.example.com:12201
    tag: "{{.Name}}"

services:
  edge: { logging: *logging }
  orchestrator: { logging: *logging }
  runner: { logging: *logging }
  broker: { logging: *logging }
  github: { logging: *logging }
  models: { logging: *logging }
  policy: { logging: *logging }
  egress: { logging: *logging }
```

## Health checks

Every service in `compose.yaml` has a health check, which calls its own `/ready` (or `/health`)
with `node -e "fetch(…)"`, which every image can run: once a second while it starts, then every
30 s. `docker compose ps` shows each one `healthy`, `starting` or `unhealthy`. A service starts
only once those it needs at its start are healthy (`depends_on` with
`condition: service_healthy`; one it calls only later, it calls again until that one answers):
the broker first, whose public keys the others check service tokens with, then the policy
service, the github and models services, edge and the runner, and the orchestrator last.

The orchestrator's and the runner's check `/health`, which a copy waiting for the lease answers
too (its `/ready` is 503 until it acts, [Two copies](two-copies.md)); the others' check `/ready`,
which turns 503 once a stopping copy drains (and answers 503 on edge, the github and models
services and the egress proxy until the broker has answered them,
[Services](../contributing/services.md)). Docker
doesn't restart an unhealthy container by itself: its logs say why.
