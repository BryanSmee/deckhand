# The server folder and grants

Everything you configure but the secrets is in one folder, which `compose.yaml` mounts
read-only at `/etc/deckhand` in the services that read it: `./server` by default (`DECKHAND_SERVER_DIR`
in `.env` to move it). Keep it in git, in your deployment's own repository, so each change is
a reviewed commit:

```
server/                   # → /etc/deckhand, read-only
  config.yaml             # your settings (config.yaml below); .env overrides each key
  grants/
    default.yaml          # what every repository gets: hosts, limits
    acme/api.yaml         # what acme/api gets, one file per repository
    policy/grants.rego    # your policies: the grants (a Dockerfile, an engine…)
```

[`server.example/`](../../server.example) is one to copy: `config.yaml` with the usual
settings, and a grants folder that grants nothing until you uncomment it (rename
`your-org/your-repo.yaml` to a repository of yours). Both parts are optional: without
`config.yaml`, settings come from `.env`; without `grants/`, no repository gets more than
a sandbox. A missing folder is created empty by Docker.

Deckhand only reads it: getting it onto the host is yours. A checkout next to `compose.yaml`
pulled on the host (or by a cron job, git-sync or your CI) works:

```sh
git clone git@github.com:acme/deckhand-config.git
echo DECKHAND_SERVER_DIR=./deckhand-config/server >> .env
docker compose up -d
```

The grants are read again at each run, so a pull applies to the next run; `config.yaml` is
read at start, so restart the services after changing it (`docker compose restart`). Whoever can change the folder can
grant root on the host: protect it like the deployment itself, with `CODEOWNERS` giving each
team its own repositories' grants (see [Security model](../security/policies.md#the-grants-folder)).

## `config.yaml`

Your settings, read at start: every key, and how `.env` overrides it, in
[Server settings](settings.md). [`server.example/config.yaml`](../../server.example/config.yaml)
has the usual ones.

## The grants folder

What you give a repository beyond what every sandbox gets lives in `GRANTS_DIR`
(`/etc/deckhand/grants` in the orchestrator and the services that read it: `grants/` in the
[server folder](#the-server-folder-and-grants) `compose.yaml` mounts read-only, with
[`server.example/grants/`](../../server.example/grants) to start from): one file per
repository for its hosts, projects, mounts and limits, `default.yaml` for every repository,
and your policies in `policy/`, which hold [the grants](#the-grants) (a Dockerfile, an engine,
research, workflows, auto-merge). It is optional and read again at each run,
so an edit applies without a restart.

```
grants/
  default.yaml       # every repository
  acme/api.yaml      # acme/api
  acme/web.yaml      # acme/web
  policy/grants.rego # the grants, repository by repository (The grants, below)
  CODEOWNERS         # anything that isn't .yaml is skipped, and dot folders (.git, .github)
```

A repository's file is `<owner>/<repo>.yaml`, matched case-insensitively. It holds what you
grant that repository:

```yaml
# acme/api.yaml
# Reachable by its sandboxes, besides the mandatory hosts and default.yaml's.
hosts: ["*.acme.dev", pypi.org]
# Of the hosts it may reach, those whose answers the egress proxy keeps, HTTPS too (see
# Download cache in the guides), besides default.yaml's.
cached_hosts: [apt.acme.dev]
# Organization projects (v2), <organization>/<number>, its runs add their issues and pull
# requests to, and the orchestrator moves its issues on (see Projects in repo-config/issues.md). Needs the
# App's Organization projects permission. Per repository only.
allow_projects: [acme/3]
# Its own limits; missing ones keep default.yaml's, else the built-in 2 CPUs, 4g, 2048.
limits: { cpus: 4, memory: 8g, pids: 4096 }
# Roots it may mount from (read-only unless read_only: false).
mounts:
  - root: /nfs/work
    read_only: false
  - /srv/datasets
```

`default.yaml` takes the same keys but `mounts` and `allow_projects`, for every repository:

```yaml
# default.yaml
# Hosts every repository's sandboxes may reach, added to its own file's.
hosts: [pypi.org]
# Mirrors every repository's runs download from again and again, cached.
cached_hosts: [deb.debian.org]
# Every sandbox's limits, over the built-in 2 CPUs, 4g and 2048 processes; a repository's
# own file overrides each one.
limits: { memory: 8g }
```

`mounts` and `allow_projects` in `default.yaml` are errors: a root, or a project outside every
repository, for every repository, are too broad to grant by accident, so they are granted one
repository at a time. The yes-or-no keys these files had before #498 (`allow_dockerfile`,
`allow_branch_docker_images`, `allow_docker`, `allow_research`, `allow_workflows`,
`allow_auto_merge`) are errors too, each saying what to do instead: for `true`, the
`allow_grant` rule to write; for `false`, which granted nothing, to remove it
([Upgrading](../guides/upgrade-notes.md#upgrading-the-grants-498)). The preview hook's, `allow_preview` and
`acknowledge_automerge_and_preview_is_highly_dangerous`, are only warnings: the hook is gone,
so they grant nothing ([Upgrading](../guides/upgrade-notes.md#upgrading-the-preview-hook-is-gone-574)).

### Keys

- **`hosts`** · `default.yaml` and a repository's file\
  Hosts its sandboxes may reach through the egress proxy, besides the mandatory ones; both files' add up ([Where a sandbox's hosts come from](../security/network.md#where-a-sandboxs-hosts-come-from)).
- **`cached_hosts`** · `default.yaml` and a repository's file\
  Of the hosts it may reach, those whose answers the egress proxy keeps for every run, HTTPS too ([Download cache](../guides/download-cache.md)).
- **`limits`** · `default.yaml` and a repository's file\
  `cpus`, `memory`, `pids` of each sandbox (and its container engine); a repository's file overrides each one, else `default.yaml`'s, else the built-in 2 CPUs, `4g` and 2048.
- **`mounts`** · a repository's file only\
  Host roots it may mount from, read-only unless `read_only: false` ([Host mounts](../security/mounts-and-engine.md#host-mounts)); its `.deckhand.yaml` names the paths ([Network and mounts](../repo-config.md#network-and-mounts)).
- **`allow_projects`** · a repository's file only\
  Organization projects (v2), `<organization>/<number>`, its runs add their issues and pull requests to, and its issues are moved on ([Projects](../repo-config/issues.md#projects)).

**Errors stop runs, file by file.** A repository's file with errors grants that repository
nothing: its runs stop, with a reply naming the file (the details are in the orchestrator's logs,
not on GitHub), and the dashboard's repositories tab shows it as invalid, with the file and
its errors in its panel. Other repositories keep running. A broken `default.yaml`, or a
`.yaml` file that isn't `default.yaml` or `<owner>/<repo>.yaml` (deeper or at the top, a
`.yml`, a name GitHub doesn't allow, `acme/API.yaml` next to `acme/api.yaml`), stops every
run, and the orchestrator won't start with one. At start, a repository's broken file is logged
and the orchestrator starts anyway.

**Symlinks** are followed while they stay in the folder: one leading outside it is an error,
for that repository when it is its file, for every repository when it is a folder.

Quote patterns starting with `*` (`"*.acme.dev"`): YAML reads a bare `*` as an alias. See
[Where a sandbox's hosts come from](../security/network.md#where-a-sandboxs-hosts-come-from) for how `hosts`
apply.

Who can edit this folder can grant what reaches the host: protect it like the deployment itself,
with `CODEOWNERS` giving each team its own repositories' files
([The grants folder](../security/policies.md#the-grants-folder) in the security model).

### The grants

What a repository may do beyond hosts, mounts, limits and projects is a `grant`
[policy](../security/policies.md#policies) decision of yours, asked for each repository and each grant, at each run
(an edit applies without a restart):

```json
{ "version": 1, "decision": "grant", "grant": "dockerfile", "repo": { "name": "acme/api" } }
```

`input.repo.name` is lower case. The rules are `allow_grant` (a boolean) and `deny_grant` (a set
of reasons): granted when an allow rule matches and no deny rule does. Write them in the grants
folder's `policy/` (`policy/grants.rego`, as
[`server.example/grants/policy/grants.rego`](../../server.example/grants/policy/grants.rego)):

```rego
package deckhand

allow_grant if {
  input.repo.name == "acme/api"
  input.grant in {"dockerfile", "research"}
}
```

| Grant                  | What the repository gets                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `dockerfile`           | its `dockerfile` built on the host's Docker (capability `image:repo`)                                                         |
| `branch_docker_images` | its pull requests' runs build their branch's Dockerfile, never a fork's (`image:branch`)                                      |
| `docker`               | a [container engine](../security/mounts-and-engine.md#container-engine) next to its sandboxes (`docker`)                      |
| `research`             | [research runs](../security/policies.md#research-runs): any public host, without its code (`internet`)                        |
| `workflows`            | its pushes may change `.github/workflows/` ([GitHub Actions](../security/github.md#github-actions-on-deckhands-branches))     |
| `workflow_secrets`     | with `workflows`, its workflows that only run from the default branch may use secrets                                         |
| `auto_merge`           | UNSAFE: `review.merge` merges on a private repository ([Auto-merge](../security/github.md#auto-merge))                        |
| `auto_merge_public`    | the same on a public repository too                                                                                           |
| `machines`             | its tasks may run on its users' own machines, with its `machines:` ([Machines](../security/webhooks-and-sign-in.md#machines)) |

- **Nothing by default**: Deckhand's default policies have no `allow_grant` rule. No rule, no
  grant.
- **One repository at a time**: `docker`, `workflows`, `workflow_secrets`, `auto_merge` and
  `auto_merge_public`
  (an engine, workflow files run with
  the Actions secrets, merges nobody reviewed are too broad to grant every repository by
  accident). The orchestrator asks each of them again for two repositories nobody has: `*/*`, and
  `<owner>/*` under the asked repository's owner (GitHub names have no `*`). A rule that also
  grants it there (one without `input.repo.name`, a `startswith` on the owner, a `glob.match`
  with `*`) gives it to none, and the orchestrator logs why. This is a best-effort check, not a
  guarantee: a rule that doesn't match those two names (`regex.match("^acme/[a-z-]+$", …)`,
  `endswith(input.repo.name, "/api")`) still grants every repository it matches. List each
  `input.repo.name`. The others may go to every repository (a rule without `input.repo.name`).
- **Auto-merge is two grants**: `auto_merge_public` merges on a private repository too, so a
  `deny_grant` keeping a repository out of auto-merge names both:
  `input.grant in {"auto_merge", "auto_merge_public"}`.
- **Yours only**: only the operator's layer (Deckhand's `policy/` under the grants folder's
  `policy/`) is asked. A repository's own `.deckhand/policy/` `allow_grant` or `deny_grant` is
  ignored, and a config check error.
- **Fail closed**: when the policies can't be evaluated (the policy service down, a policy
  error), the repository gets nothing, as with a grants file with errors: no run starts there,
  and the reply says the grants folder has errors.
- **The runner asks too**: it calls the policy service itself (the operator's layer only, no
  repository's files) and checks every sandbox spec (an engine needs `docker`), and image build
  (`dockerfile`, `branch_docker_images`) against these, whatever
  the orchestrator says ([The runner service](../security/services.md#the-runner-service)).
- **Where they show**: a refusal says, for example, "the operator's policies don't grant
  `docker` to this repository (`allow_grant`)". The repository's config page names each grant,
  with the policy files that have `allow_grant` rules, and its Capabilities tab each
  capability's grant. The `/mode policy` dry run doesn't ask them. At start, the orchestrator warns
  for each policy file of the grants folder whose `allow_grant` rules name `auto_merge` or
  `auto_merge_public`.

## Your policies

The grants folder's `policy/` holds your policies, the operator's layer: Rego files the policy
service reads again at each decision, so an edit applies without a restart. Deckhand's own
defaults ship in its image ([The default policies](../repo-config/policies.md#the-default-policies)):
a file of yours with the same name as one of Deckhand's replaces it, any other adds to them.
Your allow rules are the ceiling of every repository; a repository's `.deckhand/policy/` can only
narrow them, except for its own modes ([Policies](../repo-config/policies.md#policies)).

What they decide, and where each is written up:

- **The grants** above (`allow_grant`, `deny_grant`): yours alone.
- **Who may do what** on each repository, through roles and `bindings` (`policy/access.rego`):
  [Access](../repo-config/policies.md#access).
- **What each kind of run gets and writes** (`allow_capabilities`, `allow_github`, `allow_push`),
  a file per mode: [Capabilities](../repo-config/policies.md#capabilities) and
  [The default policies](../repo-config/policies.md#the-default-policies).
- **Runs, merges, reviews and fixes** (`allow_run`, `allow_merge`, `allow_review`, `allow_fix`…),
  and each decision's `input`: [Policy inputs](../repo-config/policy-inputs.md).

The dashboard's Policies tab lists every file of both layers, and `/mode policy` dry-runs them
on an issue ([A dry run and the dashboard](../repo-config/policies.md#a-dry-run-and-the-dashboard)).
How the two layers are evaluated, and why: [Policies](../security/policies.md#policies) in the security
model.
