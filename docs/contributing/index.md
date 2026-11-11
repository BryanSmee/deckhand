# Contributing

How Deckhand is built, for those who change it. Running it is in the [guides](../guides/install.md).

How work happens (issues first, one branch and pull request per issue, forks, security reports)
is in [CONTRIBUTING.md](../../CONTRIBUTING.md). The commands (tests, syntax and format checks,
the dashboard, this site, the screenshots), the conventions, the security rules a change must not
weaken and the testing rules are in [AGENTS.md](../../AGENTS.md): they apply to people as much as
to agents.

## How it works

- [Architecture](architecture.md): the map, from a comment to a reply, and the pages that follow
  a run: [how it ends](runs.md), [its replies](replies.md), [its log](run-logs.md),
  [around it](queue.md), [reviews](reviews.md), [external runs](external-runs.md),
  [restarts](restarts.md), [agents](agents.md) and the [modules](modules.md).
- [Services](services.md): which service calls which and holds what, their health, the rules
  they follow; [inside each service](each-service.md); [upgrades without downtime](upgrades.md).
- [Cutting a release](releases.md): the tag, what it publishes, the chart's `appVersion` and the
  notes.
- [Webhook pull mode: the spike](../design/webhook-pull-mode.md): how GitHub treats an App whose
  webhook URL can't be reached, and what pull mode takes from it.

## The dashboard

- [The dashboard's languages](dashboard-languages.md): where the texts are, adding a language.
- [Dashboard redesign](../design/dashboard-redesign.md): the design it follows.

## Testing

- [Checking a cluster end to end](kubernetes-e2e.md): `deploy/kubernetes-e2e/run.sh`, a run from
  start to end on a cluster, every service updated mid-run.
