# Server settings

Everything you configure as the operator, each setting of `config.yaml` and `.env`, a page per
area. What you grant each repository (hosts, mounts, limits, the yes-or-no grants) isn't a
setting: it is in [the grants folder](server-folder.md#the-grants-folder), read at each run. What
a repository sets for itself is its [`.deckhand.yaml`](../repo-config.md). How to set each area
up is in the guides, which each page links to.

## How settings are read

Each setting can come from the environment (`.env`, read by `compose.yaml`) or from
`config.yaml` in [the server folder](server-folder.md), a file you commit in your
deployment's repository and review line by line.
Secrets (the Claude credential, `OPENAI_API_KEY`, `GEMINI_API_KEY`) stay in `.env`; the App's are in edge's `edge-data` volume (`/data/app.json`: its webhook and OAuth secrets) and the github service's `github-key` volume (its key).

- **Keys:** each setting's environment variable in lowercase (`ALLOWED_USERS` →
  `allowed_users`), lists as YAML lists, `onboarding` as `true` or `false`.
- **Precedence:** an environment variable that is set and not empty wins, then
  `config.yaml`, then the default its page gives. `NEEDS_INPUT_LABEL` is the exception: set and
  empty in `.env`, it still wins (no label); `needs_input_label: ""` does the same in the file.
- **Read at start only:** restart the services (`docker compose restart`) after an
  edit. Unlike the grants folder, it isn't read again.
- **Fail closed:** an unknown key, a value of the wrong type, a bad value or a secret in the
  file stops the service reading it, naming the key (`/etc/deckhand/config.yaml: max_parallel:
expected a whole number of sandboxes, got lots`). The file is optional; `ALLOWED_USERS`
  is required from one or the other.

Edge and the orchestrator read `/etc/deckhand/config.yaml` (`CONFIG_FILE` to change it): `config.yaml`
in [the server folder](server-folder.md), for example:

```yaml
# server/config.yaml
allowed_users: [alice, bob]
allowed_repos: [acme/api, acme/web]
trigger: Deckhand
sandbox_model: opus
sandbox_effort: medium
brainstorm_model: sonnet
max_parallel: 2
sandbox_subnets: 10.200.0.0/16
conflict_check_minutes: 5
onboarding: true
needs_input_label: needs-input
```

What every sandbox may reach and its limits aren't settings: they go in
`grants/default.yaml`, read at each run (see
[Where a sandbox's hosts come from](../security/network.md#where-a-sandboxs-hosts-come-from)).

## Pages

| Page                                              | What it sets                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Access and GitHub](settings/access.md)           | who starts runs (`ALLOWED_USERS`), on which repositories, the trigger, onboarding, the needs-input label, edge's address |
| [Agents and models](settings/agents.md)           | the agents' credentials, models, efforts and versions, gateways, fallbacks, fast mode                                    |
| [Runs and limits](settings/limits.md)             | runs at once, auto-pickup, chats, the waits between checks, the runs' logs and their retention                           |
| [Sandboxes and the runner](settings/sandboxes.md) | the sandboxes' subnets, container engine, names and images, and the Kubernetes runner                                    |
| [The store](settings/store.md)                    | where each service keeps its state: a folder, or Redis                                                                   |
| [Blob storage](settings/blobs.md)                 | where the runs' logs and screenshots go once they no longer change: S3 or a folder                                       |
| [Logs and metrics](settings/metrics.md)           | the services' log lines and Prometheus metrics                                                                           |
| [Services and networks](settings/services.md)     | how the services reach each other: addresses, ports, networks, drains, the egress proxy, the release compose runs        |

## Settings no longer read

A service that finds one of these set refuses to start, or ignores it, saying which: the
[upgrade notes](../guides/upgrade-notes.md) say where each one went.

- `GRANTS_FILE`, a single grants file: the grants folder (`GRANTS_DIR`) replaced it, and the
  orchestrator refuses to start while it is set ([a grants folder](../guides/upgrade-notes.md#upgrading-a-grants-folder)).
- `ALLOWED_HOSTS`, `SANDBOX_CPUS`, `SANDBOX_MEMORY`, `SANDBOX_PIDS`: `hosts` and `limits` in
  `grants/default.yaml`; the orchestrator refuses to start while one is set
  ([the sandbox limits](../guides/upgrade-notes.md#upgrading-allowed_hosts-and-the-sandbox-limits)).
- `BROKER_URL`, `BROKER_PORT`, `RELAY_URL`, `RUNS_VOLUME`: ignored since the services
  ([#567](../guides/upgrade-notes.md#upgrading-the-paths-from-before-the-services-are-gone-567)).
