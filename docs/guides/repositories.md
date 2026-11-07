# Repositories and onboarding

Which repositories Deckhand works on, and how each one gets its own `.deckhand.yaml`. Read it
before you install the App on more repositories, or on every repository of an account.

## Onboarding

When the App is installed on a repository (at creation, or added to the
installation later) that has no `.deckhand.yaml` on its default branch, the orchestrator opens an
issue there, "Set up Deckhand for this repository", labelled `deckhand-onboarding`. Claude
reads the repository and replies with a proposed `.deckhand.yaml` (and a Dockerfile or
instructions file when needed), each key with its reason, within what you allow. Comments on
the issue change the proposal, with a read-only token: nothing is pushed. A comment whose
first line is `Deckhand` (or `/mode work`) confirms it: Claude opens a pull request with
only the agreed files, and the orchestrator checks the branch's config and adds any errors or
warnings to its reply. Merge it, and the next runs use the config. See
[Onboarding](../repo-config.md#onboarding).

Only installations by someone in `ALLOWED_USERS`, on repositories `ALLOWED_REPOS` lets
through, open an issue; the others are skipped, with the reason in the orchestrator's logs. A
repository gets one onboarding issue, ever (kept in the orchestrator's [store](store.md)), so reinstalling the
App opens no second one. `ONBOARDING=off` turns the automatic issue off; a `/mode onboarding`
comment on any issue starts the same conversation by hand, for repositories installed
before, or skipped. The dashboard's **Repositories** page lists them and starts it with a
button (see [Repositories](dashboard.md#repositories) on the dashboard).

## Which repositories

`ALLOWED_REPOS` names repositories as `owner/repo`, and `owner/*` allows every repository of
that account or organization: `ALLOWED_REPOS=BryanSmee/*,MyOrg/api`. Names ignore case, and
the owner is compared whole (`bryansmee/*` doesn't allow `BryanSmeeX/…`). Anything else
(`*`, `*/*`, a bare `owner`, `own*/repo`, `owner/re*`) refuses to start, so a typo fails
closed. With a wildcard:

- a new repository of that account is allowed as soon as the App is installed on it, with no
  edit or restart;
- if the App is public, keep `ALLOWED_REPOS` set: empty, every account that installs the App
  gets through (only `ALLOWED_USERS` start runs, but their repositories show on the
  dashboard and their webhooks reach edge);
- remove the entry when the account is renamed or deleted: someone else could register its
  name and install the App;
- grants don't follow: a sandbox's hosts, mounts and limits still come from
  `grants/default.yaml` and `grants/<owner>/<repo>.yaml`, one repository at a time.

## A repository's own config

A repository can also declare inboxes in its `.deckhand.yaml`: an ideas issue and a bug
reports issue, where every comment of an allowed user becomes a labelled GitHub issue (or an
answer), and a GitHub Discussions category (for example "Ask Claude") where Claude answers
allowed users' questions. See [Inboxes](../repo-config/issues.md#inboxes).

Each repository can add a `.deckhand.yaml` on its default branch: its own users (narrowing
`ALLOWED_USERS`), trigger word, models, parallel cap, setup command, instructions,
Dockerfile and caches. See [Per-repo config](../repo-config.md). A Dockerfile and host mounts
only take effect once you grant them to that repository in your grants folder (the Dockerfile
in its policies: [the grants](../reference/server-folder.md#the-grants); mounts in
its YAML: [Security model](../security/policies.md#the-grants-folder)), which is also where you
list the hosts its sandboxes may reach (see
[Where a sandbox's hosts come from](../security/network.md#where-a-sandboxs-hosts-come-from)).
