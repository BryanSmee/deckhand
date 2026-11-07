# The store

Where each service keeps its state: `file://`, a folder in its volume, or `redis://`, for copies
on several nodes. `compose.yaml` sets them; change one in that service's `environment` (a
`compose.override.yaml`). Choosing a backend, configuring Redis and its users, and what the run
history takes: [The store](../../guides/store.md).

## Settings

- **`STORE_URL`** · environment only · default: `file://<DATA_DIR>/store`\
  The service's [store](../../guides/store.md): the orchestrator's queue, its lease and fencing epoch, the deliveries it handled, its maps, the live runs' states, the runs' summaries (all of its state, #619); edge's (below); the runner's logs, events and lease. `file://` for one node (several copies on it included), `redis://` for copies on several.
- **`STORE_URL`** (edge) · environment only · default: `file:///data/store`\
  Edge's store (the `edge-data` volume): the deliveries taken (a day), the sessions' epochs, the redeliveries' state and lease, the deliveries' stream to the orchestrator; `redis://…` for two copies on several nodes, with `REDIS_PASSWORD`.
- **`STORE_URL`** (broker) · environment only · default: `file:///data/store`\
  The broker's store: the live runs, their files and events (the `broker-store` volume); `redis://…` for two copies on several nodes, with `REDIS_PASSWORD` (see [The store](../../guides/store.md)).
- **`STORE_URL`** (github service) · environment only · default: `file:///data/store`\
  Its store (the `github-data` volume): the runs' state, the orchestrator's reactions, the idempotency keys; `redis://…` for two copies on several nodes.
- **`STORE_URL`, `KEY_DIR`** (models service) · environment only · default: `file://<DATA_DIR>/store`, `/keys`\
  Its store (the plans' refreshed logins, sealed, the runs' API state), and the folder of the key they are sealed with (`models.key`, made on first start).
- **`DATA_DIR`** · environment only · default: `/data`\
  The orchestrator's state (its store: the queue, the runs' summaries: the `data` volume), edge's (the App's credentials but its key, the session key, its store: `edge-data`), and the runner's (its store, the runs' inboxes, in its `runs/` folder: `runner-data`).

`REDIS_PASSWORD`, beside a `redis://` `STORE_URL`, is the password of its user when it isn't in
the URL, and `NODE_EXTRA_CA_CERTS` the PEM file of a private CA a `rediss://` server's
certificate is checked against ([The store](../../guides/store.md)).
