# Updating

Change the tag in `images:` and `SANDBOX_IMAGE`, then `kubectl apply -k .`. Every service updates
without stopping
([Upgrades without downtime](../contributing/upgrades.md#upgrades-without-downtime)): a rolling
update starts the next copy before the old one stops (`maxUnavailable: 0`, `maxSurge: 1`), which
drains within its grace period. The orchestrator's and the runner's copies hand their lease over:
the old one releases it on SIGTERM and the new one takes it at once. Running sandboxes go on. An
update may have a step of its own ([Updating](../guides/updating.md), its "Upgrading:" sections): the
orchestrator's volumes, for example
([#619](../guides/upgrade-notes.md#upgrading-the-orchestrator-without-a-volume-619)).

Every service has a liveness probe on `/health`: a process that stops answering is restarted
after a minute. Edge, the github and models services and the egress proxy answer `/ready` only
once the broker has answered them (edge and the github and models services its keys and their
service tokens, the proxy its service tokens): a new pod may not get out for a
few seconds after it starts (k3s's kube-router applies its NetworkPolicies then), and the calls
it took meanwhile would fail. The orchestrator's and the
runner's readiness is `/health` too, not `/ready`, as Compose's health checks
([Health checks](../guides/logs.md#health-checks)): `/ready` answers on the acting copy alone, and the
next copy only acts once the old one has stopped, so a rolling update waiting for it never ends.
Both copies sit behind their Service; the waiting one answers `503` with the connection closed
(and opens no egress policy port), so a caller's next try reaches the copy that acts.

The egress proxy runs one copy, and a second during an update: its old copy drains for 600 s, as
long as an agent's call lasts, after a 10 s pause that lets the Service stop sending it new
connections (agents, git and `gh` don't try a refused one again). Two at all times would each
make their own CA in its volume, which the sandboxes trust one of.
