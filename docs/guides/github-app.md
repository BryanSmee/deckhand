# Create the GitHub App

Deckhand acts on GitHub as a private GitHub App of your own, which `/setup` creates for you.
You need this page once, right after the [first start](install.md#start-deckhand), and again
when an update asks the App for a permission it didn't have.

Edge's logs print a one-time setup link: `…/setup?token=…`. Open it through your public
address (for example `https://deckhand.example.com/setup?token=…`):

1. Check the public URL (detected from your browser's address, or `PUBLIC_URL`), pick the
   App's name, and the organization that should own it (empty: your personal account).
2. GitHub shows the App with its permissions and events. Create it.
3. GitHub sends you back to edge, which has the github service turn GitHub's answer
   into the App's credentials: the **private key stays in the github service**, in its own
   volume (`github-key`, `/app-key/app.json`, readable by that service only); edge keeps
   the App's ID, its webhook secret and its OAuth client's in its own volume
   (`edge-data`, `/data/app.json`), and gives the orchestrator the App's public parts alone
   (its ID, slug, owner, bot). Then on to the App's installation page: pick the repositories Deckhand
   may work on. Each one without a `.deckhand.yaml` gets an onboarding issue (see
   [Onboarding](repositories.md#onboarding)).

Once an App is stored, `/setup` is closed. To start over, delete `/data/app.json` from the
`edge-data` volume and `app.json` from the `github-key` volume, and restart edge and the github
service. Back up the `github-key` and `edge-data` volumes with the `data` one: without the
first, Deckhand can't act as the App; without the second, it can't check GitHub's webhooks or
sign anyone in.

What the App asks for:

| Permissions                                     | Events                                        |
| ----------------------------------------------- | --------------------------------------------- |
| Issues, Pull requests, Contents: read and write | `issues`, `issue_comment`, `pull_request`     |
| Deployments, Discussions: read and write        | `pull_request_review`                         |
| Workflows, Actions: read and write              | `pull_request_review_comment`, `workflow_run` |
| Checks, Commit statuses, Metadata: read         | `discussion`, `discussion_comment`            |
| Organization projects: read and write           | `push`, `repository`, `check_suite`, `status` |

## Permissions added later

These permissions came with later features. An App created before one of them lacks it, which
only matters once you use the feature: each paragraph says what to add.

Workflows lets the git gateway push changes to `.github/workflows/`, for the repositories
your policies grant `workflows` only ([security model](../security.md#github-actions-on-deckhands-branches)):
every other token is narrowed to what it's for and never carries it. An App created before
then lacks it, which only matters once you grant `workflows`: add **Workflows: read and
write** in the App's settings (_Permissions & events_), then accept the new permission on its
installation. Until then every push of a granted repository is refused, its runs' first one
included, with a message saying so. Read what the grant opens before setting it: the gateway
refuses a pushed workflow that may write or names a secret, and what it doesn't check is
listed there.

Actions: read lets runs read their pull request's CI runs and logs; write, rerun the failed
jobs of their own pull request's head (`gh run rerun --failed`), a call the GitHub gateway
checks first ([repository config](../repo-config/policy-inputs.md#reruns)): the sandbox's own token only
reads them. An App created before reruns has Actions: read only: set it to **read and
write** in the App's settings, then accept it on each installation. Until then a run's rerun
is refused with a message naming the permission, and everything else works.

Organization projects lets the orchestrator move a repository's issues on an organization's
project (v2), and its runs add their issues and pull requests there, for the repositories
whose grants file lists the project in `allow_projects` only
([Projects](../repo-config/issues.md#projects)). An App created before then lacks it, which only
matters once you grant a project: add **Organization projects: read and write** under
_Organization permissions_ in the App's settings, then accept it on the organization's
installation. Until then, the orchestrator's moves fail (said in its log and the run's) and a
run's project writes are refused with a message naming the permission; nothing else
changes. A GitHub App can't reach a project owned by a user account.

Checks and Commit statuses let runs read what CI says of a commit beyond GitHub Actions
(other services' check runs, commit statuses: `gh pr checks`), and the dashboard shows them in
each pull request's CI status; the `check_suite` and `status` events keep that status current. An App created before then lacks
them: add **Checks: read** and **Commit statuses: read** in its settings, turn on **Check
suite** and **Status** under _Subscribe to events_, then accept the new permissions on each
installation ([below](#when-the-app-needs-a-new-permission)). Until then, where a commit
has checks, a run's `gh pr checks`, and `gh pr view` without `--json` (it shows them), fail
with a message naming the permissions, and the dashboard's CI status counts GitHub Actions
only; everything else works as before.

## When the App needs a new permission

A Deckhand update can ask the App for a permission it didn't have when you created it
(`APP_PERMISSIONS` in `listener/github-app.mjs`, the table above). GitHub never adds one by
itself, and an installation only gets it once an owner of its account accepts it:

1. Open the App's settings (the dashboard's **Settings › Server › GitHub App › App
   settings**), _Permissions & events_, set the permission to the level the table says, and
   save.
2. On each installation's page (**configure ↗** beside its account, which reads **accept new
   permissions ↗** while it lacks one), review and accept the new permissions.

At start, and each time it lists the repositories again (every 5 minutes while the dashboard
is open, or its **Refresh**), the orchestrator reads the App's settings again. It logs, once each,
the permissions the App lacks (with the address of its settings) and, for each installation,
those it hasn't accepted yet (with the address of its page). The dashboard's GitHub App card
shows the same: a _Missing in its settings_ row for the App's events and permissions, and
what each installation lacks beside it.

Until then, the permissions a feature added later are optional (`OPTIONAL_PERMISSIONS`:
`actions`, `checks`, `statuses` and `organization_projects` for now): a run's token goes without one its installation lacks, and the GitHub
gateway refuses its repository's calls that need it with a `Deckhand:` message naming the permission and
the page that accepts it, instead of every token failing. The others are required: a token
asking for `issues`, `contents` or `pull_requests` that the installation lacks fails, as
before. An installation's permissions are read again within 5 minutes of a change, at once
when GitHub tells Deckhand the new ones were accepted.

## Apps created before an event

An App created before Deckhand answered discussions lacks the `discussion` events and the
Discussions permission: add them in the App's settings (_Permissions & events_), then accept
the new permissions on its installation. Everything else works without them. `push` only
tells the dashboard's repository list and the conflict watcher that a default branch changed;
an App without it (created before the list) sees a config pushed straight to the default
branch within half an hour, and one merged through a pull request at once.

An App created before Deckhand followed repositories' changes lacks the `repository` event: turn
on **Repository** under _Subscribe to events_ in its settings. Without it, a repository deleted,
transferred or made private keeps what the access decisions last read of it (whether it is
private, its policy listing) up to a minute, or up to an hour while GitHub fails, rather than
being read again at once ([Security model](../security.md), Fail closed), and another branch made
the default in its settings isn't followed by a conflict check of its open pull requests until
the next poll. A repository removed
from the installation needs no event of its own.

An App created before `/after` lacks the `issues` event: turn on **Issues** under _Subscribe
to events_ in its settings. Without it, a comment waiting for an issue (`/after #77`) still
starts at once when a pull request that closes the issue (`Closes #77`) is merged into the
default branch, when a run on the issue ends, or on any comment on it: the orchestrator then
asks GitHub about the issue. An issue closed by hand, with nothing else happening to it, is
only seen at the orchestrator's next check of every wait (`WAITS_CHECK_MINUTES`, 5 minutes by
default, and at each start). Issues opened with an **Open questions** section aren't labelled
`NEEDS_INPUT_LABEL` until the graph page reads the repo's open issues, answering them doesn't
take the label off unless a run starts, and the dashboard only sees the label change when the
orchestrator restarts. The orchestrator logs a warning at start and with each listing of the
repositories naming the events the App misses (once, until that changes), with the address of
its settings.
