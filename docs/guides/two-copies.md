# Running two copies

Edge and the orchestrator can each run two copies, so an update stops nothing.

- **Edge's are both active**, on one store: either takes any request, a delivery GitHub sends
  twice (or that reaches both) goes on once, a sign-out ends the login's sessions on both, and
  the redeliveries' poller runs on the copy holding its lease. An update is rolling: the new
  copy starts, the old one drains (`DRAIN_SECONDS`, 25 s) and leaves the poller's lease to the
  other.
- **The orchestrator's are active and passive.** The copy holding the store's lease acts (15 s,
  `LEASE_SECONDS`, renewed every third of it); the other waits for it ("Waiting for the
  orchestrator's lease: another copy acts"), its services port open for its probes alone
  (`/health`; `/ready` is 503 until it acts, which keeps it out of a Kubernetes Service), 503 to
  every call. On SIGTERM the acting copy stops
  its timers and edge's requests (edge asks again, for up to 15 s), acknowledges the deliveries
  it is handling, saves the queue and the runs' state, releases the lease, then closes the
  egress policy's port. The waiting copy takes the lease at once, about a second
  later, rebuilds its tasks from the store and reads on from the last acknowledged delivery. On
  a crash, the lease expires after 15 s and the waiting copy takes it then. A copy that loses
  its lease while acting exits, and restarts as the waiting one.
- **Fencing.** Each new holder of the lease gets a higher epoch, sent with its every call to the
  github service, the runner and the broker (`x-deckhand-epoch`), which refuse one older than
  the newest they have seen (409): a copy that lost its lease writes nothing more. A reply is
  keyed by its run and a run's start by its id, so an event handled again by the next copy does
  nothing twice.

With Compose, one copy of each runs, and an update is a stop then a start. Two copies on one
node work as well: the store's file backend is shared by the processes on one node (each call
holds the folder's lock, `state.lock`), so `docker compose up -d --scale orchestrator=2` gets
the handover above. Both copies answer to the same name there (`orchestrator`, on the proxy's
network): a call that reaches the waiting one is refused, and tried again until it
reaches the one acting. Copies on several nodes need Redis ([The store](store.md)).
