# Setting up Deckhand

Deckhand runs on your own server with your own private GitHub App and your own Claude
credential (or OpenAI key, for [Codex](#codex)). You need Docker Engine 26 or later with the compose plugin, and an HTTPS address
that GitHub can reach (your reverse proxy, or a tunnel) forwarding to edge's port.

## 1. Start Deckhand

```sh
cp .env.example .env
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY (or a gateway's
#   ANTHROPIC_AUTH_TOKEN: see Through a gateway below), or OPENAI_API_KEY for Codex (see
#   Codex below): the secrets stay in .env
cp -r server.example server
# server/config.yaml: allowed_users, the GitHub logins allowed to start runs (required: no
#   start without it), and the other settings; server/grants/: what you grant each
#   repository. See The server folder below.
docker compose pull
docker compose up -d
docker compose logs edge
```

Compose runs nine images, published for each release (`DECKHAND_VERSION`, default
`latest`): edge's (the only one the internet reaches: GitHub's webhooks, `/setup`, sign-in and
the dashboard's files), the orchestrator's (the queue, the runs and the dashboard's data,
behind edge), the runner's (the only one with the Docker socket: it starts the
sandboxes, [architecture](architecture.md#the-runner-service)), the broker's (the only service
holding the key that signs the runs' tokens, see [The broker service](#the-broker-service)), the
github service's (the only one holding the GitHub App's key, see
[The github service](#the-github-service)), the models service's (the only one holding your agents' credentials, see
[The models service](#the-models-service)), the policy service's (which evaluates the
[policies](security.md#policies), on internal networks shared with the orchestrator alone, the
github service alone and the runner alone), the egress proxy's (the only way out of the sandboxes' internal
networks, see [Security model](security.md)), and the base sandbox image runs start from (the
`sandbox` service only pulls it and exits); with the `engine` profile, the
[container engine](#container-engine)'s two images too. A repository can bring its own image
`FROM` that base: see [Per-repo config](repo-config.md). Edge publishes port 8080
(`PORT` to change it), on a network of its own (`edge-out`); point your reverse proxy at it.

To build the images from this checkout instead: `docker compose up -d --build`. Updating is
`docker compose pull` and `docker compose up -d` again ([Updating](#updating)).

**A plan's credential** (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`, for Codex
a ChatGPT plan's login from `codex login`, or for the Antigravity CLI a Google AI plan's login,
both in [the credentials folder](#the-credentials-folder)) works, and the orchestrator's and the
models service's logs warn about it at each start. A subscription (Claude Pro/Max, a ChatGPT plan, Google AI Pro/Ultra) is
usually licensed to one person, and Google's terms may not allow a plan to drive a bot at all. Serving a team, or repositories other people write to, may
break your provider's terms: check them before you do. You are responsible for how your
Deckhand uses your credential. For teams, use an API key.

## 2. Create the GitHub App

The logs print a one-time setup link: `…/setup?token=…`. Open it through your public
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
   may work on. Each one without a `.deckhand.yaml` gets an onboarding issue (see Onboarding
   below).

Once an App is stored, `/setup` is closed. To start over, delete `/data/app.json` from the
`edge-data` volume and `app.json` from the `github-key` volume, and restart edge and the github
service. Back up the `github-key` and `edge-data` volumes with the `data` one: without the
first, Deckhand can't act as the App; without the second, it can't check GitHub's webhooks or
sign anyone in.

What the App asks for:

| Permissions | Events |
| Issues, Pull requests, Contents: read and write | `issues`, `issue_comment`, `pull_request` |
| Deployments, Discussions: read and write | `pull_request_review` |
| Workflows, Actions: read and write | `pull_request_review_comment`, `workflow_run` |
| Checks, Commit statuses, Metadata: read | `discussion`, `discussion_comment` |
| Organization projects: read and write | `push`, `check_suite`, `status` |

An App created before Deckhand answered discussions lacks the `discussion` events and the
Discussions permission: add them in the App's settings (_Permissions & events_), then accept
the new permissions on its installation. Everything else works without them. `push` only
tells the dashboard's repository list and the conflict watcher that a default branch changed;
an App without it (created before the list) sees a config pushed straight to the default
branch within half an hour, and one merged through a pull request at once.

Workflows lets the git gateway push changes to `.github/workflows/`, for the repositories
your policies grant `workflows` only ([security model](security.md#github-actions-on-deckhands-branches)):
every other token is narrowed to what it's for and never carries it. An App created before
then lacks it, which only matters once you grant `workflows`: add **Workflows: read and
write** in the App's settings (_Permissions & events_), then accept the new permission on its
installation. Until then every push of a granted repository is refused, its runs' first one
included, with a message saying so. Read what the grant opens before setting it: the gateway
refuses a pushed workflow that may write or names a secret, and what it doesn't check is
listed there.

Actions: read lets runs read their pull request's CI runs and logs; write, rerun the failed
jobs of their own pull request's head (`gh run rerun --failed`), a call the GitHub gateway
checks first ([repository config](repo-config.md#reruns)): the sandbox's own token only
reads them. An App created before reruns has Actions: read only: set it to **read and
write** in the App's settings, then accept it on each installation. Until then a run's rerun
is refused with a message naming the permission, and everything else works.

Organization projects lets the orchestrator move a repository's issues on an organization's
project (v2), and its runs add their issues and pull requests there, for the repositories
whose grants file lists the project in `allow_projects` only
([Projects](repo-config.md#projects)). An App created before then lacks it, which only
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

Upgrading: runs' reads of checks and projects are new to `allow_github` and `deny_github`
(`action: "read_checks"` or `"read_projects"`, without a `target` or `change`). A deny rule of
yours written for writes that refuses whatever isn't in a list (`not input.target.kind in {…}`)
now refuses those reads too: guard it with `not input.action in {"read_checks",
"read_projects"}` ([Reading CI's checks](repo-config.md#reading-cis-checks)). `/mode policy` on
a pull request shows whether one does.

Upgrading to allow rules ([Policies](repo-config.md#policies)): a decision is now allowed only
when an `allow_*` rule matches, and Deckhand's `policy/allow.rego` allows each one, so nothing
changes for the built-in modes. A `policy/allow.rego` of yours in the grants folder replaces
it: keep its rules unless you mean to refuse. A repository's `.deckhand/policy/` is now a layer
of its own: its files no longer replace yours or Deckhand's by name (one that did, to broaden a
default, now only adds its deny rules: move the broadening to your grants folder), and its own
`modes:` get nothing until it allows them (`allow_github`, `allow_link_branch`,
`allow_request_review`). Rewrite the policies of repositories with their own modes in the same
release; their onboarding check and Policies tab say what no longer applies, as they do a
repository file that doesn't start with its `package` line (after comments only), now refused.

Upgrading to per-mode policies (issue #496): the modes' write ceilings built into Deckhand's
code are gone. A run's GitHub writes, its reads of checks and projects, and its pushes (a new
decision, `push`: [the push input](repo-config.md#the-push-input)) now need an allow rule
(`allow_github`, `allow_push`), which Deckhand's `policy/mode-<mode>.rego` files give each
mode as its ceiling did, with the refusals of the old per-feature files
([the default policies](repo-config.md#the-default-policies)); `allow.rego` no longer allows
`github`. Without policies, every write and push is refused. **A `policy/allow.rego` of yours
that kept `allow_github := true`** (as the note above said to) now allows every write of every
mode, an inbox entry's or a review's included, with no ceiling left to cap it: remove that
rule, and add no `allow_push := true`, unless you mean every mode to write or push all that
the built-in checks don't refuse. The orchestrator's log at start and each repository's
Policies tab warn of such a rule. Deckhand no longer ships
`github.rego` or the `gh-*.rego` files but `gh-checks.rego`, `gh-linked-branch.rego` and
`gh-reviewers.rego`: a file of yours in the grants folder that replaced one of the others by
name (to broaden a feature, say) now replaces nothing and only adds its rules beside the
`mode-<mode>.rego` files. To broaden a mode, replace its file instead (a copy of
`mode-work.rego` without its rule on `assign`, say). A repository's own `modes:` that push need
its `allow_push` too, as they need its `allow_github` to write.

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

### When the App needs a new permission

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

## 3. Use it

On an issue of an installed repository, an allowed user comments `Deckhand` (the
whole first line, any case or punctuation; the rest are instructions). The sandbox opens the
branch `issue-<n>-<slug>` and a draft pull request, and Claude's final message comes back as a
comment from the App's bot.
`Deckhand` then a `/mode brainstorm` line (or `Deckhand /mode brainstorm`) discusses the issue
without code; `/stop` wraps it up. `/cancel` (the whole first line) stops the issue's running
run now, and the task's page on the dashboard has a **Stop** button that does the same: the
run's reply says who stopped it, its session and pushed commits stay, and the next comment
resumes it. On a queued task (waiting for a slot), `/cancel` and the page's **Remove from queue**
drop its queued comments: it is back in the backlog. With nothing running or queued, `/cancel`
gets a reply saying so.
`/mode`, `/after`, `/agent`, `/model`, `/effort` and `/speed` may share the trigger's line, alone or
together (`Deckhand /agent codex /mode brainstorm`), as well as follow it on lines of their
own; anything else on that line and it isn't the trigger. In an inbox entry (an idea, a bug, a
discussion), `/agent`, `/model`, `/effort` and `/speed` may end any line (`Dark mode /effort high`)
outside code blocks and quotes.
`Deckhand /mode research` answers a question from the open web, without the repository's
code or a GitHub token, once your policies grant the repository `research` (an `allow_grant`
rule in `grants/policy/`: [the grants](security.md#the-grants), [Research runs](security.md#research-runs)).

**Onboarding.** When the App is installed on a repository (at creation, or added to the
installation later) that has no `.deckhand.yaml` on its default branch, the orchestrator opens an
issue there, "Set up Deckhand for this repository", labelled `deckhand-onboarding`. Claude
reads the repository and replies with a proposed `.deckhand.yaml` (and a Dockerfile or
instructions file when needed), each key with its reason, within what you allow. Comments on
the issue change the proposal, with a read-only token: nothing is pushed. A comment whose
first line is `Deckhand` (or `/mode work`) confirms it: Claude opens a pull request with
only the agreed files, and the orchestrator checks the branch's config and adds any errors or
warnings to its reply. Merge it, and the next runs use the config. See
[Onboarding](repo-config.md#onboarding).

Only installations by someone in `ALLOWED_USERS`, on repositories `ALLOWED_REPOS` lets
through, open an issue; the others are skipped, with the reason in the orchestrator's logs. A
repository gets one onboarding issue, ever (kept in the orchestrator's [store](#the-store)), so reinstalling the App
opens no second one. `ONBOARDING=off` turns the automatic issue off; a `/mode onboarding`
comment on any issue starts the same conversation by hand, for repositories installed
before, or skipped. The dashboard's **Repositories** page lists them and starts it with a
button (see [the dashboard](#4-the-dashboard)).

### Which repositories

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

A repository can also declare inboxes in its `.deckhand.yaml`: an ideas issue and a bug
reports issue, where every comment of an allowed user becomes a labelled GitHub issue (or an
answer), and a GitHub Discussions category (for example "Ask Claude") where Claude answers
allowed users' questions. See [Inboxes](repo-config.md#inboxes).

Each repository can add a `.deckhand.yaml` on its default branch: its own users (narrowing
`ALLOWED_USERS`), trigger word, models, parallel cap, setup command, instructions,
Dockerfile and caches. See [Per-repo config](repo-config.md). A Dockerfile and host mounts
only take effect once you grant them to that repository in your grants folder (the Dockerfile
in its policies: [the grants](security.md#the-grants); mounts in
its YAML: [Security model](security.md#the-grants-folder)), which is also where you
list the hosts its sandboxes may reach (see
[Where a sandbox's hosts come from](security.md#where-a-sandboxs-hosts-come-from)).

## 4. The dashboard

Open edge's public address (`/`) and sign in with GitHub: the App's sign-in
(user-to-server OAuth) tells edge who you are, and only `ALLOWED_USERS` get in; anyone
else sees who they are signed in as and a refusal. The token GitHub returns is only used to
read your login, then revoked; the session is a signed cookie valid for 7 days, checked
against `ALLOWED_USERS` on every request (the key is `/data/session.key` in the `edge-data`
volume). Signing out ends all your sessions, in every browser, on both of edge's copies. Edge
serves the dashboard's files and passes its API on to the orchestrator, which answers it, with
your login. A repository's tasks and logs show to the users in its
own `users` (see [Security model](security.md#the-dashboard)). `/status` also answers calls
from inside edge's container (`docker compose exec edge …`) without a session, but not
those a reverse proxy forwarded.

Apps created by `/setup` before the dashboard had sign-in have no callback URL: on the App's
page on GitHub (Settings → Developer settings → GitHub Apps → your App → General), add
`<public URL>/auth/callback` under **Callback URL** and save.

The dashboard opens on the **Overview** (`#/`): how many runs are going (of the run slots, and
the queue), how many tasks wait on you, how many pull requests are ready for review and how
many runs failed, each a link to the tasks under that chip; then what waits on you across
repositories, oldest first, each with its one action (Answer its questions, Reply to a
brainstorm, Review the pull request, Rerun what failed); and a card per repository, with its
config's status, its tasks by state, its backlog and lanes, and its board (or Onboard for a
repository that isn't onboarded yet). Its **Tasks** view (`#/tasks`) lists every repository's
tasks.

The dashboard lists every issue, pull request and discussion Deckhand worked on, by title,
with a tab per repository (the most recently active first; each counts its running tasks and
those waiting for you) and chips by state: running (queued and `/after` waits too, and a pull request in review: between the runs of
its review-and-fix loop, `review.fix`), needs input (a brainstorm waiting for your
comment too), ready for review (once that loop is over; a loop that left blocking findings says
how many), done, error. Titles come with the webhooks; for tasks from before the dashboard
had them, the orchestrator asks GitHub once and keeps them in its [store](#the-store).

Each task also links to its pull request (the one that closes its issue, or the pull request
itself), with a badge for its state: draft, ready for review, merged or closed, and an icon
for what CI says of its latest commit: running, failed (a red cross) or passed (a green check),
over its GitHub Actions runs, other services' check runs and commit statuses. Its title lists
them; in the task's header and the Overview's **Ready for review** rows it links to the failed
run, else the pull request's Checks tab. The
`pull_request` webhooks keep it current, in the orchestrator's store, and so do the changes Deckhand
lets through for runs (a run's `gh pr ready`); for tasks from before, the orchestrator looks through each
repository's 100 most recently updated pull requests once per start, and asks again about the
open ones at each start, so one that changed while it was down shows its current state. The
**Ready for review** chip lists the pull requests waiting for you, and the tab's title counts
them ("(2) Deckhand"). **Notify me when ready** (in the sidebar), or **Settings › Preferences**,
asks your browser for notifications: while a dashboard tab is open, a pull request that turns
ready for review raises one, and so do a run that needs your answers and, once turned on
there, a run that failed; each opens its task when clicked. Preferences also keeps the
theme, density, motion, start page, board and run log choices and the keyboard shortcuts, in
this browser only.

GitHub doesn't retry a webhook it couldn't deliver (edge down or restarting, a
reverse proxy or tunnel timing out, an outage on GitHub's side). Edge reads the App's
**Recent Deliveries** itself at start and every 5 minutes (one of its copies, the one holding
the store's lease `edge/redeliveries`), and asks GitHub to redeliver each
one that failed, once, within GitHub's 3 days: a comment posted meanwhile still gets its run,
whatever its age. The App needs no extra permission or event for that: an App can always read
its own deliveries. **Sync** (in the top bar, after the running and queued counts) does it
now, asks GitHub about the open pull requests' states again, and checks them for conflicts
in the repos that opted in (`conflicts.check_minutes`, see repo-config.md), starting a rebase
run for each one in conflict: for when GitHub is unstable, or you just merged into a base
branch, and you'd rather not wait.

**Board** (Tasks | Board in a repository's header, `#/<owner>/<repo>/board`; the old
`#/graph` addresses lead there) draws the repository's tasks as a graph: an arrow goes from an
issue to each one waiting for it (`/after`), left to right, and the issues a task waits for
show even when Deckhand never worked on them. Issues with no arrow stand in a column below.
Each node says its number, its state and its title, in its state's colour (the legend floats on
the canvas): a border when it needs looking at (running, needs you, ready for review, error;
dashed red arrows: what waits for an error keeps waiting), dimmed once done (implemented: the
issue closed as completed, or its pull request merged). Whether an issue is closed comes with
the `issues` and `pull_request` webhooks; the rest is asked of GitHub with its title, kept in
the orchestrator's store, and what was open is asked again once per start. A node opens its task; one
Deckhand never worked on opens on GitHub. The toolbar zooms the graph and fits it to the
screen. **Lanes** shows each chain as a row instead (top to bottom on a phone, where it is the
default), named after its parent issue, its inbox, or the name you give it with its pencil
button; others are "#18 and 3 more". Your browser keeps the choice. The board has no
All-repositories view: All has the Overview instead.

By default the board leaves closed issues out: implemented and closed as not planned, with
their arrows, so what still needs something stays on top. An issue whose only blocker is hidden
stands in the column. A closed issue stays while an issue that waited for it is running. **Show
closed** brings them back; your browser keeps the choice. Runs on the ideas and bugs inboxes and
discussions are never drawn: they have no pull request and no `/after`. Only the issues drawn
can be queued after.

Beside the graph, the **work queue** (a sheet at the bottom on a phone) has five tabs.
**Backlog** lists the open issues with nothing live (running, queued, waiting, brainstorming or
needing input): drop one on the graph to start it (in the mode picked in **Start in**, in the
page's header), on a node to queue it after that one; one with sub-issues brings them along.
An issue whose last run was stopped, failed or interrupted keeps its node on the graph; once it
is back in the backlog (at its next read), drag the node as you would its card (in the open to
start it, onto another node to queue it after that one). A `done` issue's node and a pull request's stay where they
are.
**Brainstorm** lists the issues being brainstormed, with their state; they leave the graph
unless an arrow touches them. Drop a backlog issue on the Brainstorm tab to brainstorm it, a
brainstorm on the graph to start work on it (the brainstorm ends), or on the Backlog tab to stop
it: the wrap-up a `/stop` comment runs, its summary posted and the issue updated. Once it is
over, the issue is back in the backlog. **Waiting** lists the issues waiting for others: drag
one's node away to end its wait, onto another node to wait for that one. **Answers** lists those
waiting for your answers: starting or queueing one asks its open questions first. **Queued**
lists the tasks waiting for a free slot, in the order they start (the **run order**): drag a card
above or below another to move it, or use its **Run next**, **Move up** and **Move down**
buttons. On the graph, a queued node shows its place ("2nd"), and dragging it onto another queued
node's left or right edge moves it before or after that one (dropped in the open, it stays).
An issue's queued task can also leave the line: **Queue after…** (or a drop of its card or node
on the middle of another node, or anywhere on a node that isn't queued) makes it wait for that
issue instead, as `/after` does: its last trigger (or `/mode`) comment waits, in its mode,
with the text of every comment its author queued (another's are dropped, the App's comment
says so). **Back to backlog** (or a drop of its card on the
Backlog tab) drops its queued comments. Neither while a run is going on it: a comment queued
behind that run waits for it. A task queued with replies to its last run only can't wait: take
it out of the queue, then queue it after the issue.
Brainstorms always start before work runs and don't move. A task whose repository is at its
`max_parallel` is skipped, and the next one starts: the order is a priority, not a strict line.
Tasks you never moved go after the ones you did, in the order they were queued. Each card has
a button for each drag (on a phone, its first one and a menu for the rest), for phones and
keyboards. While you drag, the graph outlines the node a drop would queue after and says what
letting go does ("Queue #31 after #19"); each action shows at once as a dashed node
("Starting…"). Each action is written on the issue as the App's comment.

Each task shows its state in the orchestrator:

| State | What |
| `queued` | comments wait for a run (a free slot, or the running one) |
| `scheduled` | a run left the queue; its sandbox is set up, its agent not started yet |
| `building image` | a run waits for the repository's image to build (a step of scheduling) |
| `in review` | between the runs of its pull request's review-and-fix loop (`review.fix`) |
| `waiting` | a comment waits for other issues to be done (`/after #12`) |
| `working` | the run's agent is at work |
| `stopping` | a brainstorm is wrapping up (`/stop`) |
| `needs input` | the last run stopped to ask; the issue has the label |
| `brainstorm` | a brainstorm waits for your next comment |
| `idle brainstorm` | no comment for a while; the next one restores the session |
| `done`, `error` | how the last run ended (`interrupted`: a restart came before its start) |
| `cancelled` | someone stopped its last run (`/cancel` or the dashboard's Stop) |

Pick one to see the first line of its last reply and its latest run's log live (and the
next runs as they start), or an earlier run. The address keeps the tab, task and run, so a
link opens the same view. On a phone, the list and the log take the whole screen in turn.

**Repositories** (top right, with the count of those not onboarded) lists every repository
the App is installed on that `ALLOWED_REPOS` lets through, archived ones aside: `configured`
(its default branch has a `.deckhand.yaml`), `onboarding` (with a link to its onboarding
issue) or `not onboarded`. **Start onboarding** on a `not onboarded` row opens its onboarding
issue as an installation would, mentioning you, and starts the conversation: the way to
onboard repositories installed before onboarding existed, by someone not in `ALLOWED_USERS`,
or with `ONBOARDING=off`. A repository with issues disabled shows why it can't be onboarded.
A repository shows `invalid config` when no run starts there: its `.deckhand.yaml` has
errors, or asks for what the operator's grants refuse (a `dockerfile` or `docker`
without its grant, a mount outside the granted roots), or
its grants have errors (its own file, or the folder's `default.yaml` and layout, for every
repository, or the operator's policies that can't be evaluated). The list is cached: the installations' repositories are
read again every 5 minutes, each configuration every 30 minutes, or at once after a push or a
merged pull request on its default branch. The grants folder is checked at each load, so
editing it shows at once. **Refresh** reads everything again, in case a webhook was missed.
**Manage App**, next to it, links to the App on GitHub (in a new tab): **Add or remove
repositories** opens the page that installs it on an account or configures an installation
(that installation's own page when there is only one), and **App settings** its permissions,
events and webhook (under the organization that owns it, or your own settings). GitHub decides
who may change them: someone who doesn't own the App sees its 404 or a read-only page. With no
repository yet, the empty list links to the install page too.

A repository's name opens its configuration, read from its default branch then: what stops
its runs (errors, and what it asks for that the operator doesn't grant) and its warnings first, then
what its runs get (each value from the repository, from the operator, or refused), its grant
(each yes-or-no grant by name, `dockerfile`, `docker`…, with the policy files that have
`allow_grant` rules) and the files of the grants folder it comes from (or the file to fix, when
it has errors), its Capabilities tab (for each mode, what a run gets, the file that decided each
capability and what stops it), and the raw file. Anyone signed in to the dashboard sees it, grants
included. Its **Refresh** reads it again (at most every 5 seconds); changing it is a commit on
the default branch.

## The server folder

Everything you configure but the secrets is in one folder, which `compose.yaml` mounts
read-only at `/etc/deckhand` in the services that read it: `./server` by default (`DECKHAND_SERVER_DIR`
in `.env` to move it). Keep it in git, in your deployment's own repository, so each change is
a reviewed commit:

```
server/                   # → /etc/deckhand, read-only
  config.yaml             # your settings (Settings below); .env overrides each key
  grants/
    default.yaml          # what every repository gets: hosts, limits
    acme/api.yaml         # what acme/api gets, one file per repository
    policy/grants.rego    # your policies: the grants (a Dockerfile, an engine…)
```

[`server.example/`](../server.example) is one to copy: `config.yaml` with the usual
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
team its own repositories' grants (see [Security model](security.md#the-grants-folder)).

## The credentials folder

The plans' logins (see [With a ChatGPT plan](#with-a-chatgpt-plan) and
[With a Google AI plan](#with-a-google-ai-plan)) can't go in the server folder: they are
account-wide credentials, and would end up in git. They have a folder of their own, which
`compose.yaml` mounts read only at `/data/credentials` in the models service alone:
`./credentials` by default (`DECKHAND_CREDENTIALS_DIR` in `.env` to move it). Keep it out of git
(this repository's `.gitignore` does) and readable by the models service alone, which runs as the
`node` user (uid 1000), not root. Create it before the models service starts, or Docker creates
it empty and owned by root, where the service can't read it:

```sh
mkdir -m 700 credentials && sudo chown 1000 credentials
# each login you put there: owned by uid 1000 too, mode 600
```

```
credentials/              # → /data/credentials, read only, in the models service
  codex-auth.json         # a ChatGPT plan's login, for Codex
  agy-auth.json           # a Google AI plan's login, for the Antigravity CLI
```

A file there, under its name, turns that login on at start: no setting needed.
`CODEX_AUTH_FILE` or `AGY_AUTH_FILE`, when set, points at another file instead, which the models
service must be able to read. The models service never writes it: each refresh's new tokens go
in its store, sealed with a key of its own (see [The models service](#the-models-service)), and
it uses them until the file changes. To sign in again, replace the file: the next call takes the
new login. Only the models service mounts the folder.

## Settings

Each setting can come from the environment (`.env`, read by `compose.yaml`) or from
`config.yaml` in [the server folder](#the-server-folder), a file you commit in your
deployment's repository and review line by line.
Secrets (the Claude credential, `OPENAI_API_KEY`, `GEMINI_API_KEY`) stay in `.env`; the App's are in edge's `edge-data` volume (`/data/app.json`: its webhook and OAuth secrets) and the github service's `github-key` volume (its key).

- **Keys:** each setting's environment variable in lowercase (`ALLOWED_USERS` →
  `allowed_users`), lists as YAML lists, `onboarding` as `true` or `false`.
- **Precedence:** an environment variable that is set and not empty wins, then
  `config.yaml`, then the default below. `NEEDS_INPUT_LABEL` is the exception: set and
  empty in `.env`, it still wins (no label); `needs_input_label: ""` does the same in the file.
- **Read at start only:** restart the services (`docker compose restart`) after an
  edit. Unlike the grants folder, it isn't read again.
- **Fail closed:** an unknown key, a value of the wrong type, a bad value or a secret in the
  file stops the service reading it, naming the key (`/etc/deckhand/config.yaml: max_parallel:
expected a whole number of sandboxes, got lots`). The file is optional; `ALLOWED_USERS`
  is required from one or the other.

Edge and the orchestrator read `/etc/deckhand/config.yaml` (`CONFIG_FILE` to change it): `config.yaml`
in [the server folder](#the-server-folder), for example:

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
[Where a sandbox's hosts come from](security.md#where-a-sandboxs-hosts-come-from)).

| Setting                                                                                           | `config.yaml` key                                                                                 | Default                                                                      | What                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_USERS`                                                                                   | `allowed_users`                                                                                   | none: required                                                               | GitHub logins that can start runs and sign in to the dashboard (edge and the orchestrator both read it)                                                                                                                                            |
| `ALLOWED_REPOS`                                                                                   | `allowed_repos`                                                                                   | all where the App is installed                                               | narrows the repos (`owner/repo`, or `owner/*` for every repo of an account, comma-separated in `.env`; see [Which repositories](#which-repositories)); edge reads it too, to pass on CI's deliveries for those repos only                          |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`                          | none: a secret, `.env` only                                                                       |                                                                              | Claude credential, the models service's alone, which adds it to the sandboxes' API calls (`ANTHROPIC_AUTH_TOKEN`: a gateway's). With several, runs take the gateway's, then the plan's, then the key ([Agents](#agents-and-providers))             |
| `ANTHROPIC_BASE_URL`                                                                              | `anthropic_base_url`                                                                              | `https://api.anthropic.com`                                                  | where the models service sends the sandboxes' API calls: a [gateway](#through-a-gateway), say                                                                                                                                                      |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `anthropic_default_opus_model`, `anthropic_default_sonnet_model`, `anthropic_default_haiku_model` | Claude Code's                                                                | the models `opus`, `sonnet` and `haiku` stand for in the sandboxes (a gateway's names)                                                                                                                                                             |
| `SANDBOX_AGENT`, `BRAINSTORM_AGENT`                                                               | `sandbox_agent`, `brainstorm_agent`                                                               | `claude`, `SANDBOX_AGENT`                                                    | the agent of work runs, and of brainstorms, inbox entries and discussions: `claude`, `codex` (see [Codex](#codex)) or `antigravity` (see [Antigravity CLI](#antigravity-cli))                                                                      |
| `OPENAI_API_KEY`                                                                                  | none: a secret, `.env` only                                                                       |                                                                              | Codex's OpenAI API key, the models service's alone, which adds it to the sandboxes' API calls                                                                                                                                                      |
| `CODEX_AUTH_FILE`                                                                                 | none: `.env` only                                                                                 |                                                                              | or a ChatGPT plan's login: its `auth.json`, held and refreshed by the models service. Default: `/data/credentials/codex-auth.json` when it exists (see [The credentials folder](#the-credentials-folder)); a file elsewhere must be readable there |
| `OPENAI_BASE_URL`                                                                                 | `openai_base_url`                                                                                 | `https://api.openai.com/v1`                                                  | where the models service sends Codex's API calls                                                                                                                                                                                                   |
| `CODEX_BEST_MODEL`, `CODEX_BALANCED_MODEL`, `CODEX_FAST_MODEL`                                    | `codex_best_model`, `codex_balanced_model`, `codex_fast_model`                                    | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`                                   | the models the tiers `best`, `balanced` and `fast` stand for with Codex                                                                                                                                                                            |
| `GEMINI_API_KEY`                                                                                  | none: a secret, `.env` only                                                                       |                                                                              | the Antigravity CLI's Gemini API key, the models service's alone, which adds it to the sandboxes' API calls                                                                                                                                        |
| `AGY_AUTH_FILE`                                                                                   | none: `.env` only                                                                                 |                                                                              | or a Google AI plan's login: its token file, held and refreshed by the models service. Default: `/data/credentials/agy-auth.json` when it exists (see [The credentials folder](#the-credentials-folder)); a file elsewhere must be readable there  |
| `GEMINI_BASE_URL`                                                                                 | `gemini_base_url`                                                                                 | `https://generativelanguage.googleapis.com`                                  | where the models service sends the Antigravity CLI's API calls when using `GEMINI_API_KEY`                                                                                                                                                         |
| `AGY_BEST_MODEL`, `AGY_BALANCED_MODEL`, `AGY_FAST_MODEL`                                          | `agy_best_model`, `agy_balanced_model`, `agy_fast_model`                                          | `gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-3.8-flash-medium`    | the models the tiers `best`, `balanced` and `fast` stand for with the Antigravity CLI                                                                                                                                                              |
| `FALLBACKS`                                                                                       | `fallbacks`                                                                                       | none                                                                         | where a run goes when its provider fails, in order: `claude@anthropic` (or `:plan`, `:key`), `claude@openrouter`, `codex@openai`, `antigravity@google` (see [Fallbacks](#fallbacks))                                                               |
| `OPENROUTER_API_KEY`                                                                              | none: a secret, `.env` only                                                                       |                                                                              | OpenRouter key of `claude@openrouter`, added by the models service to those runs' API calls                                                                                                                                                        |
| `OPENROUTER_BASE_URL`                                                                             | `openrouter_base_url`                                                                             | `https://openrouter.ai/api`                                                  | where the models service sends the API calls of `claude@openrouter` runs                                                                                                                                                                           |
| `OPENROUTER_OPUS_MODEL`, `OPENROUTER_SONNET_MODEL`, `OPENROUTER_HAIKU_MODEL`                      | `openrouter_opus_model`, `openrouter_sonnet_model`, `openrouter_haiku_model`                      | `ANTHROPIC_DEFAULT_*_MODEL`                                                  | what `opus`, `sonnet` and `haiku` stand for on `claude@openrouter` (OpenRouter's names)                                                                                                                                                            |
| `CLAUDE_FALLBACK_MODEL`                                                                           | `claude_fallback_model`                                                                           | none                                                                         | Claude Code's own `--fallback-model`, when the run's model is overloaded: a tier or a model's name                                                                                                                                                 |
| `PUBLIC_URL`                                                                                      | `public_url`                                                                                      | stored by `/setup`                                                           | edge's public address                                                                                                                                                                                                                              |
| `PORT`                                                                                            | none: compose's                                                                                   | `8080`                                                                       | the host port compose publishes edge on                                                                                                                                                                                                            |
| `CLAUDE_CODE_VERSION`                                                                             | `claude_code_version`                                                                             | `2.1.300`                                                                    | Claude Code version the sandboxes install on first use                                                                                                                                                                                             |
| `AGY_VERSION`                                                                                     | `agy_version`                                                                                     | `1.4.0`                                                                      | Antigravity CLI version the sandboxes install on first use                                                                                                                                                                                         |
| `AGY_SHA256`                                                                                      | `agy_sha256`                                                                                      | `1.4.0`'s                                                                    | sha256 of the Antigravity CLI's tarballs, `x64:<hex>,arm64:<hex>`: set it whenever you change `AGY_VERSION`, from the release's assets                                                                                                             |
| `CODEX_VERSION`                                                                                   | `codex_version`                                                                                   | `0.162.1`                                                                    | Codex version the sandboxes install on first use                                                                                                                                                                                                   |
| `SANDBOX_MODEL`, `SANDBOX_EFFORT`                                                                 | `sandbox_model`, `sandbox_effort`                                                                 | `best`, `medium`                                                             | defaults; a comment's `/model` and `/effort` lines override them (models: below the table)                                                                                                                                                         |
| `BRAINSTORM_MODEL`, `BRAINSTORM_EFFORT`                                                           | `brainstorm_model`, `brainstorm_effort`                                                           | `SANDBOX_MODEL`, `SANDBOX_EFFORT`                                            | the same for brainstorms, inbox entries and discussions                                                                                                                                                                                            |
| `SANDBOX_FAST_MODE`                                                                               | `sandbox_fast_mode`                                                                               | off                                                                          | `allowed`: `/speed fast` turns on Claude Code's fast mode, which costs more (see [Fast mode](#fast-mode))                                                                                                                                          |
| `BRAINSTORM_IDLE_MINUTES`                                                                         | `brainstorm_idle_minutes`                                                                         | `10`                                                                         | minutes without a comment before a brainstorm shows as idle                                                                                                                                                                                        |
| `MAX_PARALLEL`                                                                                    | `max_parallel`                                                                                    | `2`                                                                          | sandboxes running at once (a repo's `max_parallel` within it)                                                                                                                                                                                      |
| `AUTO_PICKUP_SLOTS`                                                                               | `auto_pickup_slots`                                                                               | `0` (off)                                                                    | slots within `MAX_PARALLEL` for the issues the orchestrator starts by itself (below MAX_PARALLEL; [Auto-pickup](#auto-pickup))                                                                                                                     |
| `AUTO_PICKUP_LABEL`                                                                               | `auto_pickup_label`                                                                               | `auto-pickup`                                                                | the label that asks for it                                                                                                                                                                                                                         |
| `SANDBOX_SUBNETS`, `SANDBOX_SUBNET_SIZE`                                                          | `sandbox_subnets`, `sandbox_subnet_size`                                                          | none (Docker's pools), `28`                                                  | an IPv4 range the runs' networks take their subnets from, in blocks of that size (below the table)                                                                                                                                                 |
| `SANDBOX_ENGINE`                                                                                  | `sandbox_engine`                                                                                  | none                                                                         | the container engine runs of repositories granted `docker` get: `sysbox`, `podman` or `auto` (see [Container engine](#container-engine))                                                                                                           |
| `TRIGGER`                                                                                         | `trigger`                                                                                         | `Deckhand`                                                                   | first line of a comment that starts a run                                                                                                                                                                                                          |
| `ONBOARDING`                                                                                      | `onboarding`                                                                                      | on                                                                           | `off`: no onboarding issue when the App is installed on a repo without a config                                                                                                                                                                    |
| `NEEDS_INPUT_LABEL`                                                                               | `needs_input_label`                                                                               | `needs-input`                                                                | label while a run or an issue waits for answers (empty: none)                                                                                                                                                                                      |
| `CONFLICT_CHECK_MINUTES`                                                                          | `conflict_check_minutes`                                                                          | `5`                                                                          | shortest interval of a repo's `conflicts.check_minutes`; `0` turns it off                                                                                                                                                                          |
| `MAX_FIX_ROUNDS`                                                                                  | `max_fix_rounds`                                                                                  | `5`                                                                          | most fix runs a repo's `review.fix` may ask for per pull request (each is a work run plus a review run)                                                                                                                                            |
| `WAITS_CHECK_MINUTES`                                                                             | `waits_check_minutes`                                                                             | `5`                                                                          | how often comments waiting for other issues (`/after`) ask GitHub again                                                                                                                                                                            |
| `RUN_LOG_MAX_MB`                                                                                  | `run_log_max_mb`                                                                                  | `200`                                                                        | megabytes a run's log may hold: a run whose output passes it is stopped and fails, the rest of its output not kept (see below)                                                                                                                     |
| `LOG_SEGMENT_MB`                                                                                  | `log_segment_mb`                                                                                  | `8`                                                                          | megabytes of a run's log the runner keeps in one segment at most: a segment also closes at each step of the run (see below)                                                                                                                        |
| `LOG_RETENTION_DAYS`                                                                              | `log_retention_days`                                                                              | `90`                                                                         | days a run's log, its summary and its screenshots are kept; `0` keeps them forever (see below)                                                                                                                                                     |
| `NAME_PREFIX`, `CLAUDE_CODE_VOLUME`, `CODEX_VOLUME`, `AGY_VOLUME`                                 | `name_prefix`, `claude_code_volume`, `codex_volume`, `agy_volume`                                 | `deckhand`, `deckhand-claude-code`, `deckhand-codex`, `deckhand-antigravity` | names of what Deckhand creates on Docker (the Antigravity CLI's login is refreshed in `<AGY_VOLUME>-login`)                                                                                                                                        |
| `DOCKER_SOCKET`                                                                                   | none: compose's                                                                                   | `/var/run/docker.sock`                                                       | the host's Docker socket, which compose mounts into the runner                                                                                                                                                                                     |
| `DECKHAND_VERSION`                                                                                | none: compose's                                                                                   | `latest`                                                                     | the release compose runs (`1.2.3`, `1.2`), or `edge` to follow `main`: see [Updating](#updating)                                                                                                                                                   |
| `DECKHAND_REGISTRY`                                                                               | none: compose's                                                                                   | `ghcr.io/bryansmee`                                                          | where compose pulls the images from                                                                                                                                                                                                                |
| `SHOTS_VOLUME`                                                                                    | none: compose's                                                                                   | `deckhand-screenshots`                                                       | name of the screenshots volume compose creates and mounts into the orchestrator only: what it kept before the broker did (#609), moved to the broker at its start                                                                                  |

Each running sandbox has a Docker network of its own (see
[Security model](security.md#network)). By default Docker takes their subnets from its default
address pools, which hold about 30 networks shared with your other projects: past that, runs
fail to start with `all predefined address pools have been fully subnetted` (or `could not
find an available, non-overlapping IPv4 address pool`). Set aside a range of your own instead,
`SANDBOX_SUBNETS=10.200.0.0/16` (`sandbox_subnets` in `config.yaml`): Deckhand cuts it
into blocks of `SANDBOX_SUBNET_SIZE` (`/28` by default, 16 addresses: 4096 networks in a
`/16`) and gives each run's network the lowest block no network on the host uses, so your
other projects keep Docker's pools. Pick a range none of your networks or LANs use, inside
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` or `100.64.0.0/10`: Deckhand refuses to
start with any other (a public range would make other runs' sandboxes look like public hosts
to the egress proxy). When it is
full, runs fail to start with an error naming `SANDBOX_SUBNETS`: set a larger range or a lower
`MAX_PARALLEL`.

The alternative changes the whole daemon, your other projects' networks included: give Docker
more, smaller networks in `/etc/docker/daemon.json`, then restart Docker. The setting replaces
Docker's own pools, so list those first and add yours after them, for example
`"default-address-pools": [{"base": "172.16.0.0/12", "size": 16}, {"base": "192.168.0.0/16", "size": 20}, {"base": "10.200.0.0/16", "size": 28}]`
(the last one: 4096 networks of 16 addresses).

Each run leaves its log in `logs/<run>.log` on the data volume (the agent's whole output, often
a few MB), a summary in the orchestrator's store (`summaries/<run>`, what the dashboard lists
after a restart or a handover, so the orchestrator doesn't read the logs to start: [The
store](#the-store)), and the broker keeps its screenshots (in blob
storage, or its store without it: [Blob storage](#blob-storage)). At start and then daily, the
orchestrator removes those of runs older than `LOG_RETENTION_DAYS` (90 days by default), the
screenshots through the broker, and they leave the dashboard. It keeps a run still going, and the latest run of a
task that is queued, in a brainstorm, waiting (`/after`) or waiting for input, whatever its
age. Screenshots linked from older pull requests and comments stop showing once their run is
removed: set a longer retention, or `0`, to keep them.

A run's output can't fill the data volume: once its log would pass `RUN_LOG_MAX_MB` (200 MB
by default), nothing more of it is written, its sandbox is stopped and the run fails, with a
note in its log and a reply that says why. A single line over 1 MB (no newline in sight) is
cut there, `… (line cut)` at its end, and the rest of it dropped up to its newline. It can't
be turned off (`0` is refused): it is what keeps a run from filling the volume.

The runner keeps a run's log in its store in segments, each closed at a step of the run (its
setup, image build, work, pushes, wrap-up) or at `LOG_SEGMENT_MB` (8 MB by default), whichever
comes first: only the last one is still written to.

A model, in `SANDBOX_MODEL`, `BRAINSTORM_MODEL`, a repository's `model` or a comment's
`/model`, is a tier the run's agent maps to one of its models, `best`, `balanced` or `fast`
(Claude Code: `opus`, `sonnet`, `haiku`, which `ANTHROPIC_DEFAULT_*_MODEL` can point
elsewhere; Codex: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, or `CODEX_*_MODEL`; the
Antigravity CLI: `gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-3.8-flash-medium`, or
`AGY_*_MODEL`), or a model's own name (`sonnet`, `claude-opus-5-5`, `gpt-6.1-sol`,
`gemini-4-argon`). Efforts (`low` to `max`) are the same for all three; the Antigravity CLI's
models carry theirs in their name (`-low`, `-medium`, `-high`), so a name without one takes the
run's (`xhigh` and `max`: `-high`). A run whose model belongs to another agent (`/model opus` on a Codex run)
doesn't start: the reply says why.

### Auto-pickup

An issue nobody starts can wait for months. With `AUTO_PICKUP_SLOTS` above 0 (and below
`MAX_PARALLEL`, which it comes out of), the orchestrator starts the open issues labelled
`AUTO_PICKUP_LABEL` (`auto-pickup`) by itself, oldest created first across the repositories
whose `.deckhand.yaml` says `auto_pickup: true` ([repo-config.md](repo-config.md#auto-pickup)),
in `work` mode, as many at once as there are slots. It looks every 5 minutes, a few seconds
after the label is added (an `issues` delivery), and as soon as a run ends or a queued
auto-picked issue is cancelled.

- **The slots.** Auto-picked runs never take more than `AUTO_PICKUP_SLOTS`. The other runs
  (comments, the dashboard, reviews) borrow those slots while no auto-picked issue waits: with
  `MAX_PARALLEL=3` and `AUTO_PICKUP_SLOTS=1`, three triggered runs may go at once. Once an
  issue is picked, they keep to 2, and it starts as soon as a slot frees. A repository's
  `max_parallel` counts auto-picked runs too: an issue of a repository at its own cap isn't
  picked, and one picked before its repo filled up holds no slot while it waits for it.
  What follows a picked run on its task holds the reserved slot too, until the picked work is
  done: queued during the picked run or behind it, the answer to its questions while it waits
  for one, and its pull request's review loop (review, fixes, CI, conflicts) until the loop is
  over, between its steps too (waiting for CI, its next step on its way). People's comments
  then are in the slot as well, and the next issue isn't picked meanwhile. The slot is free
  once the loop is over, the picked run left no loop going nor questions, its questions are set
  aside, the issue closed or its pull request merged or closed. When a sweep then gives it to
  the next issue, the pick is over for good: what comes next on the task is a run like any
  other, and a loop its draft starts later doesn't take the slot back, a reopened issue
  neither. The policies still see those runs as started by the listener or by the comment.
  A pick that asked keeps its slot until its questions are answered or set aside (the
  needs-input label taken off, the issue closed), picks from before an update included: the
  dashboard's line under the run slots shows such slots as held between runs ("1 auto-pickup
  slot (1 held between runs)"), and no issue is picked for them meanwhile.
- **What is skipped.** An issue with something live on the dashboard (running, queued,
  waiting, asking), the needs-input label (`NEEDS_INPUT_LABEL`), an open issue it is "blocked
  by", or an open pull request of Deckhand's for it; the next one is picked instead.
- **Who it runs for.** The person who last added the label, from the issue's events: they must
  be in `ALLOWED_USERS` and the repository's `users`, or nothing starts (a label a bot added
  either). The label vouches for the issue as it was then: a title or description changed
  since by anyone but an allowed user (the App's bot included) holds it until the label is
  added again ([security.md](security.md#auto-pickup)). The run is theirs for the policies
  (`sender`, `trigger: "auto-pickup"`: a `deny_run` rule can refuse it,
  [The run input](repo-config.md#the-run-input)).
- **Once picked.** The App comments on the issue, then the label comes off and the run is
  queued. A failed or stopped run isn't picked again: add the label back to retry. An issue
  held by who added the label, or by an edit since, keeps it, and the App says why once.

The dashboard marks auto-picked tasks with a bolt (named "Auto-pickup" for screen readers and
on hover). Its run slots' meter keeps the reserved slots last: dashed while free, teal while an
auto-picked run holds one, blue and still dashed while a standard run borrows it. The line under
it says how they are used ("1 auto-pickup slot (1 in use)", "… (free)").

### Fast mode

Claude Code's fast mode runs the same Opus model with output up to about 2.5× faster, at a
higher price per token (about twice Opus's). It is for work that can't wait, like a critical
fix: a `/speed fast` line in a comment (or ending its trigger line or an inbox entry's line)
asks for it, `/speed normal` drops it, and a repository's mode may ask for it by default
(`speed: fast`, see [Modes](repo-config.md#modes)). It is off until you allow it:

```yaml
# server/config.yaml
sandbox_fast_mode: allowed
```

A repository's `fast_mode: false` turns it off there; it can't turn it on when you haven't.
A run that asks for it and can't have it runs at normal speed, and the reply's footer says
why: you haven't allowed it, the repository turned it off, the agent has none (Codex, the
Antigravity CLI) or the provider is OpenRouter (`claude@openrouter`). Fast mode is Opus only:
`/speed fast` with `/model balanced` or `/model fast` runs on `best` instead, and the footer
says so. A `/speed` sent while a run goes on applies to the next run, like `/model`. A fast
run's footer reads `🤖 Claude opus · high effort · fast · 4 min`, and the dashboard and the
run's log show `fast` too, so you can see which runs cost more.

What it needs from your credential:

- **An API key** (`ANTHROPIC_API_KEY`): billed per token at the fast price. An admin of your
  organization must allow fast mode in the Console's Claude Code preferences, else the API
  refuses it and Claude Code goes on at normal speed (the footer then says the agent couldn't
  turn fast mode on).
- **A plan** (`CLAUDE_CODE_OAUTH_TOKEN`): not through Deckhand. Claude Code asks
  `api.anthropic.com` whether the account may use fast mode with the token itself, which
  sandboxes never hold (the models service adds it to their API calls), so the answer is no and
  the run goes on at normal speed, saying so in its footer.
- **A gateway** (`ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex, Foundry): usually not available;
  Claude Code then runs at normal speed.

Turning it on in a session that already has context bills that whole context once, uncached,
at the fast price: a `/speed fast` on a long issue's session costs more than on a new one.

### Agents and providers

Deckhand runs three agents, Claude Code (`claude`), Codex (`codex`) and the Antigravity CLI
(`antigravity`), from one sandbox image: each installs on first use into a volume of its own.
An agent calls a provider; its calls go through the [models service](#the-models-service), which
adds your credential and forwards them, so none of these needs a host in the grants folder (only GitHub's, which every
run has, and the Antigravity CLI's own, which its runs have).

| Entry | Agent and provider | Credential (`.env`) | The models service calls |
| `claude@anthropic` | Claude Code on Anthropic, or [a gateway](#through-a-gateway) | `CLAUDE_CODE_OAUTH_TOKEN` (a plan's), `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL` (`api.anthropic.com`) |
| `claude@openrouter` | Claude Code through OpenRouter, as a [fallback](#fallbacks) | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` (`openrouter.ai`) |
| `codex@openai` | [Codex](#codex) on OpenAI | `OPENAI_API_KEY`, or `CODEX_AUTH_FILE` (a ChatGPT plan's login) | `OPENAI_BASE_URL` (`api.openai.com`), or ChatGPT's Codex backend with a plan |
| `antigravity@google` | [Antigravity CLI](#antigravity-cli) on Google | `GEMINI_API_KEY`, or `AGY_AUTH_FILE` (a Google AI Pro/Ultra plan's login) | `GEMINI_BASE_URL` (`generativelanguage.googleapis.com`), or `daily-cloudcode-pa.googleapis.com` and `www.googleapis.com` (handed over by the egress proxy) with a plan |

With several Claude credentials set, runs take `ANTHROPIC_AUTH_TOKEN` (a gateway's) first,
then a plan's `CLAUDE_CODE_OAUTH_TOKEN`, already paid for, then `ANTHROPIC_API_KEY`, billed
per token. An entry can name the credential it runs on: `claude@anthropic:plan`
(`CLAUDE_CODE_OAUTH_TOKEN`) or `claude@anthropic:key` (`ANTHROPIC_API_KEY`), for a
[fallback](#fallbacks) from the plan to the key, or a comment's `/agent claude@anthropic:key`.
`claude@anthropic` alone is the default credential.

**Which credential a run used:** the dashboard tags each Claude run on `anthropic` by its
model, in the run's outcome (and on a discussion's page): "Plan" (`CLAUDE_CODE_OAUTH_TOKEN`),
"API key" (`ANTHROPIC_API_KEY`) or "Gateway" (`ANTHROPIC_AUTH_TOKEN`), whether the run named
it or took the default. Settings › Server says which Claude credentials are set and which one
runs use first: "Plan first, then API key as fallback" when `FALLBACKS` names
`claude@anthropic:key`, "Plan · API key also set" when only `/agent` can pick it. The reply's footer names the
credential only when the entry names one, or after a fallback.

What runs an issue, first match wins:

1. A comment's `/agent <entry>` line (`/agent codex`, `/agent claude@openrouter`; an agent
   alone is on its default provider, `/agent claude@anthropic:key` on that credential), among
   the agents you have a credential for, the credentials you set (unless a gateway's token
   is the default), and the entries of `FALLBACKS`. Anything else gets a reply naming what is configured, and nothing
   runs. A picked agent doesn't fall back: when its provider fails, the run ends with the
   error. The issue's later runs stay with it until another `/agent`; `/agent default` goes
   back to the next rule. When it changes the agent, the new one starts a session of its own,
   handed the branch and the previous agent's last message.
2. The [fallback](#fallbacks) a run whose provider failed went to, and later runs of the issue.
3. The repository's `agent` (per mode, or `brainstorm_agent`: [Per-repo config](repo-config.md#agent)),
   among the agents you configured.
4. Your `SANDBOX_AGENT` (`BRAINSTORM_AGENT` for light runs), `claude` by default.

### Through a gateway

Claude Code can go through an Anthropic-compatible gateway instead of Anthropic:
[OpenRouter](https://openrouter.ai), your company's LLM gateway. Sandboxes still call the
models service, which forwards their calls to `ANTHROPIC_BASE_URL` with your credential: they never
reach the gateway themselves, so it needs no host in the grants folder. Only you set it; a
repository's config can't. With OpenRouter, in `.env`:

```sh
ANTHROPIC_AUTH_TOKEN=sk-or-v1-…   # your OpenRouter key, sent as Authorization: Bearer
```

and in `config.yaml`:

```yaml
anthropic_base_url: https://openrouter.ai/api
# What opus, sonnet and haiku mean (haiku runs Claude Code's background tasks).
anthropic_default_opus_model: anthropic/claude-opus-4.1
anthropic_default_sonnet_model: anthropic/claude-sonnet-4.5
anthropic_default_haiku_model: anthropic/claude-haiku-4.5
sandbox_model: opus
```

Leave `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` empty: `ANTHROPIC_AUTH_TOKEN` wins
over them anyway, as in Claude Code. A `claude@anthropic:plan` or `:key` entry in `FALLBACKS`
would send them to the gateway; `/agent` can't pick them while a gateway is the default. `SANDBOX_MODEL`, `BRAINSTORM_MODEL`, a repository's
`model` and a comment's `/model` line take the gateway's names too (`/model openai/gpt-5`).

Claude Code is built for Claude models: others, through a gateway, are uneven at its tool
calls (edits, long sessions, thinking), and a run can stop halfway or misuse a tool. Try a
model on a small issue before giving it real work. Restart the models service and the
orchestrator after changing these settings; switching back to Anthropic is emptying `anthropic_base_url` and setting your
Anthropic credential.

### Codex

Deckhand can run [Codex](https://github.com/openai/codex) (OpenAI's CLI) instead of Claude
Code, with an OpenAI API key (or [a ChatGPT plan](#with-a-chatgpt-plan)). In `.env`:

```sh
OPENAI_API_KEY=sk-proj-…
```

and in `config.yaml`, to make it the default:

```yaml
sandbox_agent: codex # brainstorm_agent follows unless you set it
sandbox_model: best # gpt-6-astra; balanced and fast are gpt-6.1-sol and gpt-6-luna
```

Or keep Claude Code as the default and let repositories pick Codex: with both a Claude
credential and `OPENAI_API_KEY` set, a repository's `.deckhand.yaml` may say `agent: codex`
(per repository, or per mode: [Per-repo config](repo-config.md#agent)). A repository can only
pick an agent you have a credential for, or the one you chose as default. `SANDBOX_AGENT=codex`
without `OPENAI_API_KEY` (or a ChatGPT plan's login) stops the orchestrator at start.

As with Claude Code, the key never enters a sandbox: Codex calls the models service
(`OPENAI_BASE_URL=<broker>/openai`, which the egress proxy sends there) with the run's agent
token as its key, and the models service forwards the call to OpenAI (or your `OPENAI_BASE_URL`) with yours. The sandbox turns off
Codex's analytics, update check and plugins, so it needs no host besides GitHub's: not
`api.openai.com`, and not `api.anthropic.com` either.

What differs from Claude Code:

- **Comments that arrive mid-run** wait for the run to end: `codex exec` takes no more input
  once started. The next run starts right after and resumes the same session
  (`codex exec resume --last`), so nothing is dropped, only answered in a second reply.
- **Sessions** are in a volume per issue, `<sandbox>-codex` (`~/.codex`), apart from Claude
  Code's: a repository that switches agent starts the issue afresh with the other one.
- **Instructions:** Deckhand's rules and the repository's `instructions` file go to
  `~/.codex/AGENTS.md`; Codex reads the repository's own `AGENTS.md` itself.
- **Draft pull request:** Codex's hooks call the same `sandbox-draft-pr hook` after a push and
  when it stops.
- **Its own sandbox is off** (`--dangerously-bypass-approvals-and-sandbox`): the container is
  the sandbox, as with Claude Code.

#### With a ChatGPT plan

Instead of an API key, Codex can run on a ChatGPT plan's login. Its refresh token is
single-use and rotated on every refresh, so only one copy may be in use: the models service
holds it, refreshes it and adds the plan's access token to the sandboxes' calls, which go to
ChatGPT's Codex backend (`chatgpt.com/backend-api/codex`). No sandbox gets it.

1. Sign in for Deckhand alone, in a fresh Codex home (any machine with Codex):

   ```sh
   export CODEX_HOME=$(mktemp -d)
   codex login --device-auth
   ```

2. Move its `auth.json` into [the credentials folder](#the-credentials-folder) on the
   host (next to `compose.yaml`), then delete that home without `codex logout`,
   which would revoke the login:

   ```sh
   mv "$CODEX_HOME/auth.json" credentials/codex-auth.json
   rm -r "$CODEX_HOME"
   ```

3. Restart the models service, then the orchestrator (`docker compose restart models orchestrator`):
   the file turns the login on.

The models service logs `Codex: a ChatGPT plan's login, from /data/credentials/codex-auth.json`
at start, or why it can't use it. It refreshes the access token 5 minutes before it expires,
once for all runs, and keeps the new tokens in its store, sealed (the file stays as you wrote
it). Don't use that `auth.json` anywhere else: a refresh elsewhere spends the token the models
service holds. When the login is spent (revoked, or refreshed elsewhere), runs fail with "run
`codex login` again": repeat the steps above; the models service reads the new file without a
restart. `OPENAI_API_KEY`, when set too, wins.

A plan is licensed to one person: the orchestrator's log warns about it at each start (see
[1. Start Deckhand](#1-start-deckhand)).

### Antigravity CLI

Deckhand can run Google's [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli)
(`agy`), with a Gemini API key (or [a Google AI plan](#with-a-google-ai-plan)). In `.env`:

```sh
GEMINI_API_KEY=AIza…
```

and in `config.yaml`, to make it the default (or let repositories pick it, as with [Codex](#codex)):

```yaml
sandbox_agent: antigravity
sandbox_model: best # gemini-4-argon-high; balanced and fast: gemini-4-argon-medium, gemini-3.8-flash-medium
```

On a key, `agy` 1.4.0 doesn't list Gemini 4 Argon yet
([google-antigravity/antigravity-cli#1228](https://github.com/google-antigravity/antigravity-cli/issues/1228)):
the sandbox declares it as a custom model in `agy`'s settings, and passes an Argon tier's
effort as `--effort` (`gemini-4-argon-high` runs `--model gemini-4-argon --effort high`). The
other models (`agy models`) need nothing.

`SANDBOX_AGENT=antigravity` without `GEMINI_API_KEY` (or a Google AI plan's login) stops the
orchestrator at start.

As with Claude Code and Codex, the key never enters a sandbox: `agy` calls the models service
(`GOOGLE_GEMINI_BASE_URL=<broker>/google`) with the run's agent token in `GEMINI_API_KEY` (and
`modelProvider: "gemini"` in its settings), and the models service forwards the call to Google (or
your `GEMINI_BASE_URL`) with yours.

What differs from Claude Code, as for Codex:

- **Comments that arrive mid-run** wait for the run to end: `agy -p` takes no more input. The
  next run resumes the same conversation (`agy --conversation <id>`).
- **Sessions** are in a volume per issue, `<sandbox>-antigravity` (`~/.gemini`).
- **Instructions:** Deckhand's rules and the repository's `instructions` file go to
  `~/.gemini/AGENTS.md`; `agy` reads the repository's own `AGENTS.md` itself.
- **Draft pull request:** a `Stop` hook in `agy`'s user-level hooks (`~/.gemini/config/hooks.json`,
  not the repository's `.agents/hooks.json`), and again once it exits.
- **A failed command** shows as any other in the run's log: `agy`'s output doesn't say a
  command failed.

#### With a Google AI plan

Instead of an API key, the Antigravity CLI can run on a Google AI Pro or Ultra plan's login,
which gives it Gemini 4 Argon (and the plan's other models: `agy models` lists them). Only
`agy` takes such a plan: Gemini CLI and the gateways need an API key.

Google's terms may not allow a plan, licensed to one person, to drive an automated bot:
check them before you set this up. The orchestrator's log warns about it at each start.

On a plan, `agy` has no setting to send its calls to the models service, so its login is kept out
of the sandboxes another way. The models service holds it; each sandbox gets a token file whose
access token is the run's agent token. For these runs only, the egress proxy decrypts the two
hosts that carry the token (`daily-cloudcode-pa.googleapis.com`, `www.googleapis.com`) and hands
each request to the models service, which checks the token, puts the plan's access token in its place and sends the
call on, on the paths `agy` uses only. `agy`'s telemetry (`play.googleapis.com`, which carries
the token too) is refused; its feature flags (`antigravity-unleash.goog`) and your avatar
(`lh3.googleusercontent.com`, which its eligibility check fetches) go through untouched. See
[Security model](security.md#the-antigravity-clis-login).

1. Sign in once, for Deckhand alone, in a container (any machine with Docker; the image is
   Deckhand's sandbox image, which has what `agy` needs):

   ```sh
   docker volume create agy-sign-in
   docker run --rm -it --user 0 --entrypoint deckhand-install-antigravity \
     -e AGY_VERSION=1.4.0 \
     -e AGY_SHA256=x64:fd96967583c1eed94733c039638fa59b71ddbd823c75ebc8dd0e677463565aad,arm64:cf953adcc69f87d00d71f97c3f35dc723a8669a350accf9a199df781f0523f56 \
     -v deckhand-antigravity:/opt/antigravity ghcr.io/bryansmee/deckhand-sandbox
   docker run --rm -it --entrypoint /opt/antigravity/1.4.0/bin/agy \
     -v deckhand-antigravity:/opt/antigravity:ro -v agy-sign-in:/home/node/.gemini \
     ghcr.io/bryansmee/deckhand-sandbox
   ```

   `agy` prints a sign-in address: open it, sign in with the plan's Google account, paste the
   code back, then `/quit`.

2. Write the token file it left into [the credentials folder](#the-credentials-folder) on
   the host (next to `compose.yaml`), then remove that volume:

   ```sh
   docker run --rm -v agy-sign-in:/g ghcr.io/bryansmee/deckhand-sandbox \
     cat /g/antigravity-cli/antigravity-oauth-token > credentials/agy-auth.json
   docker volume rm agy-sign-in
   ```

3. In `config.yaml`, to make it the default (or let repositories pick it, as with [Codex](#codex)):

   ```yaml
   sandbox_agent: antigravity
   sandbox_model: best # gemini-4-argon-high; balanced and fast: gemini-4-argon-medium, gemini-3.8-flash-medium
   ```

Then restart the models service and the orchestrator. The models service logs `Antigravity CLI: a
Google AI plan's login, from /data/credentials/agy-auth.json` at start, or why it can't use it.
When the access token is within 5 minutes of its expiry, it has `agy` refresh it: the runner runs
`agy models` in a short container of the sandbox image, on a volume of its own
(`<AGY_VOLUME>-login`), outside the runs' networks (`INSTALL_NETWORK`, as the installs; on
Kubernetes, a pod of its own: [Agents on Kubernetes](kubernetes.md#agents-on-kubernetes)), once
for all runs, and the models service keeps the new token in its store, sealed. When Google refuses
the refresh (the login was revoked), runs fail with "sign in with `agy` again": repeat the steps
above; the models service reads the new file without a restart. `GEMINI_API_KEY`, when set too, wins.

The egress proxy needs its CA for these runs, cache on or off (it makes it at its first
start, in its volume): a run stops when the proxy has none.

### Plan usage

With a plan (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_FILE`, `AGY_AUTH_FILE`), the dashboard shows
how much of it the runs have used: a thin bar per limit window (a Claude plan's 5-hour and
weekly limits, a ChatGPT plan's, the Antigravity CLI's per model), at the right of the page
header on a wide screen, each plan's most used window in the phone's top bar, and all of them,
with their resets, in the phone's repositories sheet and Settings › Server. A bar turns orange
from 75 %, red at 100 % or while the plan's limit is reached (a 429, until its reset), and
hatched when it was read before its window reset (its number no longer holds). Nothing shows
without a plan, nor before the first reading.

The numbers come from the models service, which holds the plans (`models/usage.mjs`):

- **From the runs' own calls**, at no cost: the rate limit headers of the plan's answers
  (`anthropic-ratelimit-unified-*` for Claude, `x-codex-primary-*` and `x-codex-secondary-*`
  for Codex). Only the plan's: runs on an API key, a gateway or OpenRouter change nothing.
- **By asking the plan, while a dashboard is open**: ChatGPT's and the Antigravity CLI's quota
  calls (the only source for the Antigravity CLI, whose answers carry none), each plan at most
  every 5 minutes, and only when no run read it lately. These calls aren't documented and may
  change: one that fails is only logged in the models service's log, the bars keep their last
  reading, and it is asked again 30 minutes later. A ChatGPT login due for a refresh (it lasts
  days) isn't polled: an idle dashboard never spends its refresh token; the next run's call
  refreshes it. The Antigravity CLI's quota call is its plan's only reading and its login lasts
  an hour, so while a dashboard is open its poll refreshes the login when due (a short `agy`
  container, as a run's refresh), at most once an hour.
- **Claude's plan is read from the runs' calls alone** with a `claude setup-token` token: its
  OAuth usage call needs the `user:profile` scope, which such a token doesn't have. The models
  service tries it once, logs `Claude's usage call refused (… user:profile …): not asked again`,
  and doesn't ask again until it restarts. So the Claude bars show the 5-hour and weekly
  limits, not the weekly limits per model that only that call gives.

So the bars stay as they were while no run uses the plan and no dashboard is open: a reading
older than 15 minutes says when it was taken. Only percentages and times reach the dashboard,
nothing of the credential.

### Fallbacks

When the model's API fails, a run can go on elsewhere instead of ending with "Claude stopped
with an error". List where, in order, as `agent@provider` (`agent` alone is its default
provider), or `agent@provider:credential` for one of the provider's credentials:

| Entry | What | Needs |
| `claude@anthropic` | Claude Code on your `ANTHROPIC_BASE_URL` (Anthropic, unless a gateway) | a Claude credential |
| `claude@anthropic:plan` | The same, on your Claude plan | `CLAUDE_CODE_OAUTH_TOKEN` |
| `claude@anthropic:key` | The same, on your Anthropic API key | `ANTHROPIC_API_KEY` |
| `claude@openrouter` | Claude Code through OpenRouter, at `OPENROUTER_BASE_URL` | `OPENROUTER_API_KEY` |
| `codex@openai` | Codex on your `OPENAI_BASE_URL` (OpenAI), or on a ChatGPT plan | `OPENAI_API_KEY` or `CODEX_AUTH_FILE` |
| `antigravity@google` | The Antigravity CLI on your `GEMINI_BASE_URL` (Google), or on a Google AI plan | `GEMINI_API_KEY` or `AGY_AUTH_FILE` |

In `.env`, the credentials, and in `config.yaml`:

```yaml
fallbacks: [claude@openrouter, codex@openai]
# OpenRouter's names for what opus, sonnet and haiku mean there.
openrouter_opus_model: anthropic/claude-opus-4.1
openrouter_sonnet_model: anthropic/claude-sonnet-4.5
openrouter_haiku_model: anthropic/claude-haiku-4.5
```

A plan first, then its API key, then OpenRouter:

```yaml
# .env: CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY, both. Runs start on the plan.
fallbacks: [claude@anthropic:key, claude@openrouter]
```

An entry without its credential (`claude@anthropic:key` without `ANTHROPIC_API_KEY`), or a
credential Deckhand doesn't have, stops the orchestrator at start. Without `FALLBACKS`, nothing
changes: a run whose provider fails ends with an error, as before.

**Which errors count:** only the provider's. The run's agent ended with an error that says
overloaded (529), rate limited (429), a usage limit or quota reached (402, a plan's limit, no
credit left), invalid or expired credentials (401, 403), or a server error (5xx), in its
message or as the last answer Deckhand got from the provider. A failing test, a task the
agent gave up on or any other error ends the run as before. A plan's usage limit
counts: with a Claude plan first and its API key (`claude@anthropic:key`) or OpenRouter after
it, runs go on, paid per token, only on the entries you list.

**What happens:** the run's comments are queued again for the first entry the run hasn't
been on yet, each entry at most once (the run's own included, wherever it is in the list:
`claude@anthropic` is the same as `claude@anthropic:plan` when the plan is the default). The
same agent on another provider, or on another credential of it, continues its session. Another agent starts a new session,
handed the task, the branch and the previous agent's last message; it works in the same clone,
so it sees what was left uncommitted. The run's log on the dashboard says where it switched
and why, and the reply's footer names the agent and provider that answered:
`🤖 Codex (openai) gpt-6-astra · medium effort · 3 min · fell back from Claude (anthropic): overloaded (529)`,
`🤖 Claude (anthropic, API key) opus · high effort · 3 min · fell back from Claude (anthropic, plan): quota reached`.
When no entry is left, the run ends with the error.

**Later runs** of the issue stay on the entry that took over, as long as it is in `FALLBACKS`:
switching back would continue the session of the agent that failed, without what the other
one did. A fallback from a plan to its API key (`claude@anthropic` on the plan, or `:plan`,
then `claude@anthropic:key`) is the exception: the same session goes on either way, so later
runs stay on the key only until the plan's limit resets, then go back to the plan. The reset
is the one Anthropic's rate limit headers give, else Claude Code's message ("You've hit your
session limit · resets 1:10pm (UTC)"), else 5 hours later, a plan's usage window. A fallback
from the plan to another provider or agent sticks like any other.

A model's own name (`/model claude-opus-5-5`) may mean nothing on another provider: use
tiers (`best`) with fallbacks. A Claude model on a run that falls back to Codex runs Codex's
login (`UNAUTHENTICATED`, `PERMISSION_DENIED`) count as the
login (`UNAUTHENTICATED`, `PERMISSION_DENIED`, "Eligibility check failed") count as the
provider's errors.

Claude Code also has a fallback of its own, within one provider: `CLAUDE_FALLBACK_MODEL`
(`claude_fallback_model: sonnet`) is the model it switches to when the run's model is
overloaded, before its provider counts as failed.

### Advanced settings

Edge, the orchestrator, the runner, the policy service and the egress proxy also read these. `compose.yaml` doesn't take them from
`.env`: it sets some itself, to match the services and volumes it defines, and leaves the
others to their defaults. To change one, set its key in `config.yaml` when it has one, or
else set it in the service's `environment`, for example in a `compose.override.yaml`.

| Setting                                                                                                                            | Key                               | Default                                                                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRANTS_DIR`                                                                                                                       | `grants_dir`                      | `/etc/deckhand/grants`                                                                                  | what you grant each repo, one file each: hosts, cached hosts, host mounts, limits, projects; and your policies in `policy/`, with the grants (Dockerfile, engine…: [the grants](security.md#the-grants)) (the server folder's). The runner must read the same folder: it checks every sandbox spec and build against it again, and the grants with the policy service (`compose.yaml` gives it the orchestrator's)                                                              |
| `INSTALL_NETWORK`                                                                                                                  | `install_network`                 | `bridge`                                                                                                | network of the agents' install containers (they need npm and GitHub's releases), and of the Antigravity CLI's login refresh                                                                                                                                                                                                                                                                                                                                                     |
| `RUNNER`                                                                                                                           | `runner`                          | `docker`                                                                                                | where sandboxes run: `docker`, the host's Docker, or `kubernetes`, pods of the cluster the runner runs in (see [kubernetes.md](kubernetes.md)); another value stops the orchestrator and the runner at start, saying so                                                                                                                                                                                                                                                         |
| `KUBERNETES_NAMESPACE`                                                                                                             | `kubernetes_namespace`            | the runner's own                                                                                        | the sandboxes' namespace: the [Kubernetes runner](kubernetes.md)'s sandbox and install pods, their Secrets and claims                                                                                                                                                                                                                                                                                                                                                           |
| `KUBERNETES_SERVICES_NAMESPACE`                                                                                                    | `kubernetes_services_namespace`   | `KUBERNETES_NAMESPACE`                                                                                  | the services' namespace, the runner's own: the egress proxy's Service, BuildKit and the registry's pull Secret ([Namespaces](kubernetes.md#namespaces))                                                                                                                                                                                                                                                                                                                         |
| `KUBERNETES_PENDING_MINUTES`                                                                                                       | `kubernetes_pending_minutes`      | `10`                                                                                                    | how long a sandbox's pod may stay Pending (no room, an image it can't pull) before its run fails, with the reason in its reply; and how long each pod's network gate waits for its NetworkPolicies to apply ([kubernetes.md](kubernetes.md#the-network-gate))                                                                                                                                                                                                                   |
| `KUBERNETES_STORAGE_CLASS`                                                                                                         | `kubernetes_storage_class`        | the cluster's default                                                                                   | the storage class of the issues' session claims                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `KUBERNETES_SESSION_SIZE`                                                                                                          | `kubernetes_session_size`         | `10Gi`                                                                                                  | the size of each session claim (an issue's clone, and its agent's session)                                                                                                                                                                                                                                                                                                                                                                                                      |
| `KUBERNETES_REGISTRY`                                                                                                              | `kubernetes_registry`             | none: no repo images                                                                                    | the registry repo images are pushed to and the nodes pull from, with an optional path (`registry.example.com/deckhand`); see [Repo images on Kubernetes](kubernetes.md#repo-images-on-kubernetes)                                                                                                                                                                                                                                                                               |
| `KUBERNETES_REGISTRY_SECRET`                                                                                                       | `kubernetes_registry_secret`      | none; required with `KUBERNETES_REGISTRY`                                                               | a `kubernetes.io/dockerconfigjson` Secret of the namespace, with credentials the registry requires to pull, push and delete: the nodes pull repo images and the agents' installs with it, and the runner and BuildKit push and prune with it                                                                                                                                                                                                                                    |
| `KUBERNETES_BUILDKIT`                                                                                                              | `kubernetes_buildkit`             | `tcp://buildkitd:1234`                                                                                  | the BuildKit daemon that builds repo images (`buildctl --addr`); its host is the name of its Service in the namespace                                                                                                                                                                                                                                                                                                                                                           |
| `KUBERNETES_REGISTRY_HOSTS`                                                                                                        | `kubernetes_registry_hosts`       | none                                                                                                    | more hosts the BuildKit daemon may reach while it builds (a registry's token service or layer storage Deckhand doesn't know), as a grant's `hosts` are written; see [Repo images on Kubernetes](kubernetes.md#repo-images-on-kubernetes)                                                                                                                                                                                                                                        |
| `KUBERNETES_CACHE_STORAGE_CLASS`                                                                                                   | `kubernetes_cache_storage_class`  | none: no caches                                                                                         | a `ReadWriteMany` storage class for the repos' cache claims (`caches`), which concurrent runs mount                                                                                                                                                                                                                                                                                                                                                                             |
| `KUBERNETES_CACHE_SIZE`                                                                                                            | `kubernetes_cache_size`           | `10Gi`                                                                                                  | the size of each cache claim                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `KUBERNETES_AGENT_STORAGE_CLASS`                                                                                                   | `kubernetes_agent_storage_class`  | `KUBERNETES_CACHE_STORAGE_CLASS`                                                                        | a `ReadWriteMany` storage class for the agents' claims, installed once per version; none (and no claim made beforehand): each run installs its agent in an init container                                                                                                                                                                                                                                                                                                       |
| `KUBERNETES_AGENT_SIZE`                                                                                                            | `kubernetes_agent_size`           | `5Gi`                                                                                                   | the size of each agent's claim                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `KUBERNETES_ENGINE_RUNTIME_CLASS`                                                                                                  | `kubernetes_engine_runtime_class` | none: no container engine on Kubernetes                                                                 | Sysbox's RuntimeClass (`sysbox-runc`), under which runs granted a container engine get one ([Container engine on Kubernetes](kubernetes.md#container-engine-on-kubernetes))                                                                                                                                                                                                                                                                                                     |
| `KUBERNETES_ENGINE_SIZE`                                                                                                           | `kubernetes_engine_size`          | `20Gi`                                                                                                  | how much a container engine's storage may take on Kubernetes, an `emptyDir` per run                                                                                                                                                                                                                                                                                                                                                                                             |
| `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT`                                                                               | none: the cluster's               | set by Kubernetes in every pod                                                                          | where the Kubernetes runner reaches the API server                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DEBOUNCE_MS`                                                                                                                      | `debounce_ms`                     | `15000`                                                                                                 | pause after a comment before its run starts, so that comments posted together go in one run                                                                                                                                                                                                                                                                                                                                                                                     |
| `BRAINSTORM_DEBOUNCE_MS`                                                                                                           | `brainstorm_debounce_ms`          | `3000`                                                                                                  | the same before a light run (brainstorms, onboarding, inbox entries…)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CONFLICT_MERGE_DELAY_MS`                                                                                                          | `conflict_merge_delay_ms`         | `30000`                                                                                                 | pause after a repo's default branch moved before its pull requests' conflicts are checked, while GitHub computes them again                                                                                                                                                                                                                                                                                                                                                     |
| `DATA_DIR`                                                                                                                         | none                              | `/data`                                                                                                 | the orchestrator's state (its store: the queue, the runs' summaries: the `data` volume), edge's (the App's credentials but its key, the session key, its store: `edge-data`), and the runner's (its store, the runs' inboxes: `runner-data` and `runs`)                                                                                                                                                                                                                         |
| `DASHBOARD_DIR`                                                                                                                    | none                              | the image's `dashboard/dist`                                                                            | the built dashboard edge serves                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SANDBOX_IMAGE`                                                                                                                    | none                              | `<NAME_PREFIX>-sandbox`                                                                                 | the base image runs start from; compose sets the release's                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ENGINE_IMAGE`, `ENGINE_PODMAN_IMAGE`                                                                                              | none                              | `<NAME_PREFIX>-engine`, `<NAME_PREFIX>-engine-podman`                                                   | the [container engine](#container-engine)'s images, for Sysbox and for Podman; compose sets the release's                                                                                                                                                                                                                                                                                                                                                                       |
| `POLICY_PORT`                                                                                                                      | none                              | `8082`                                                                                                  | port of the egress policy the proxy asks about each connection: open until the orchestrator exits                                                                                                                                                                                                                                                                                                                                                                               |
| `RUNNER_URL`                                                                                                                       | none                              | `http://runner:8080`                                                                                    | the [runner service](architecture.md#the-runner-service), as the orchestrator calls it; several, comma-separated, for its copies, tried in turn                                                                                                                                                                                                                                                                                                                                 |
| `SERVICES_PORT`                                                                                                                    | none                              | `8083`                                                                                                  | the orchestrator's services port, where the runner calls it (a run's first tokens) and edge passes the dashboard's API on, on the networks they share                                                                                                                                                                                                                                                                                                                           |
| `SERVICE_NETWORKS`                                                                                                                 | none                              | none: no call taken                                                                                     | which network each calling service is on, by its subnet (on the orchestrator `runner=…,edge=…`; on the runner `orchestrator=…,models=…`): a call from elsewhere, or with another's token, is refused; `none` where the network can't tell (Kubernetes, with NetworkPolicies and the callers' service accounts: [kubernetes.md](kubernetes.md#what-the-manifests-set-up-and-why)). Compose sets them from `RUNNER_SUBNET`, `EDGE_ORCHESTRATOR_SUBNET` and `RUNNER_MODELS_SUBNET` |
| `RUNNER_SUBNET` (compose)                                                                                                          | none                              | `10.231.250.48/28`                                                                                      | the subnet of the network the orchestrator and the runner share (`runner`) (`.env`), should it overlap one of the host's                                                                                                                                                                                                                                                                                                                                                        |
| `EDGE_ORCHESTRATOR_SUBNET` (compose)                                                                                               | none                              | `10.231.250.192/28`                                                                                     | the subnet of the network edge and the orchestrator share (`edge-orchestrator`), should it overlap one of the host's                                                                                                                                                                                                                                                                                                                                                            |
| `STORE_URL`                                                                                                                        | none                              | `file://<DATA_DIR>/store`                                                                               | the service's [store](#the-store): the orchestrator's queue, its lease and fencing epoch, the runs' summaries; edge's (below); the runner's logs, events and lease. `file://` for one node (several copies on it included), `redis://` for copies on several                                                                                                                                                                                                                    |
| `LEASE_SECONDS` (orchestrator)                                                                                                     | none                              | `15`                                                                                                    | how long the acting copy's lease lasts, renewed every third of it: a crashed copy's is taken by the waiting one once it expires; a stopping one releases it at once (see [Two copies](#two-copies))                                                                                                                                                                                                                                                                             |
| `EDGE_URL` (orchestrator)                                                                                                          | none                              | `http://edge:8083`                                                                                      | edge's internal port: where the orchestrator reads the deliveries' stream and the App's public parts; compose sets it                                                                                                                                                                                                                                                                                                                                                           |
| `INTERNAL_PORT` (edge)                                                                                                             | none                              | `8083`                                                                                                  | the port the orchestrator calls edge on (the deliveries' stream, the App's public parts), on their network alone; never `PORT`'s, which the internet reaches                                                                                                                                                                                                                                                                                                                    |
| `ORCHESTRATOR_URL` (edge)                                                                                                          | none                              | `http://orchestrator:8083`                                                                              | the orchestrator's services port, where edge passes the dashboard's API, `/status` and the screenshots on; compose sets it                                                                                                                                                                                                                                                                                                                                                      |
| `SERVICE_NETWORKS` (edge)                                                                                                          | none                              | none: no call taken                                                                                     | the orchestrator's network to edge's internal port, `orchestrator=<subnet>`; compose sets it from `EDGE_ORCHESTRATOR_SUBNET`; `none` on Kubernetes                                                                                                                                                                                                                                                                                                                              |
| `STORE_URL` (edge)                                                                                                                 | none                              | `file:///data/store`                                                                                    | edge's store (the `edge-data` volume): the deliveries taken (a day), the sessions' epochs, the redeliveries' state and lease, the deliveries' stream to the orchestrator; `redis://…` for two copies on several nodes, with `REDIS_PASSWORD`                                                                                                                                                                                                                                    |
| `DRAIN_SECONDS` (edge)                                                                                                             | none                              | `25`                                                                                                    | how long a stopping copy lets its requests finish (a live log), under compose's `stop_grace_period` of 30 s                                                                                                                                                                                                                                                                                                                                                                     |
| `BROKER_SERVICE_URL` (runner)                                                                                                      | none                              | `http://broker:8081`                                                                                    | the [broker service](#the-broker-service), where the runner asks for its service tokens and copies the runs' inboxes and files                                                                                                                                                                                                                                                                                                                                                  |
| `ORCHESTRATOR_URL` (runner)                                                                                                        | none                              | `http://orchestrator:8083`                                                                              | the orchestrator's services port, where the runner gets a run's first tokens                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GITHUB_SERVICE_URL` (runner)                                                                                                      | none                              | `http://github:8080`                                                                                    | where the runner gets the repos' tarballs: the github service                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DRAIN_SECONDS` (runner)                                                                                                           | none                              | `280`                                                                                                   | how long a stopping runner lets its calls in flight finish (an image's build) before it releases its lease; its output streams end at once                                                                                                                                                                                                                                                                                                                                      |
| `EGRESS_PROXY`                                                                                                                     | none                              | `http://egress:3128`                                                                                    | the egress proxy, as sandboxes reach it; compose sets it                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POLICY_SERVICE_URL`                                                                                                               | none                              | `http://policy:8181`                                                                                    | the [policy service](services.md), which evaluates every policy decision, the config checks and the Policies tab; compose sets it. A decision waits up to 30 s for a service that refuses its connection (restarting), then refuses                                                                                                                                                                                                                                             |
| `SERVICE_KEYS_DIR` (broker, policy service, runner)                                                                                | none                              | broker: none, not published; policy service: `/keys`; runner: `/service-keys`                           | where the broker writes its public key (`<kid>.pem`) and the policy service and the runner read it, to check their callers' service tokens offline (the `service-keys` volume); compose sets it                                                                                                                                                                                                                                                                                 |
| `GRANTS_DIR` (policy service)                                                                                                      | none                              | `/etc/deckhand/grants`                                                                                  | where the policy service reads your policies (`policy/*.rego`), found as the orchestrator finds it: the environment's, else `config.yaml`'s `grants_dir`, else the default. Both must read the same files there: the orchestrator reads its own and refuses every policy decision when the service's are others (none included), and logs why at start                                                                                                                          |
| `SERVICE_NETWORKS` (policy service)                                                                                                | none                              | none: not checked                                                                                       | the subnet of each caller's network, `orchestrator=172.30.2.0/24,…`: a call is refused unless it arrives on its token's caller's network. Compose leaves it unset: its table still names what the orchestrator, the github service and the runner, each on a network of its own, may call                                                                                                                                                                                       |
| `EGRESS_CONTAINER` (runner)                                                                                                        | none                              | labelled `deckhand.role=egress`                                                                         | the egress proxy's container, which the runner joins to each run's network; by default, the one in the runner's compose project                                                                                                                                                                                                                                                                                                                                                 |
| `POLICY_URL` (egress proxy)                                                                                                        | none                              | `http://orchestrator:8082/egress`                                                                       | where the proxy asks whether a sandbox may reach a host: the orchestrator's `POLICY_PORT` (Kubernetes: with 8082 on the orchestrator's Service)                                                                                                                                                                                                                                                                                                                                 |
| `EGRESS_CACHE_DIR` (egress proxy)                                                                                                  | none                              | `/cache`                                                                                                | where the proxy keeps the [egress cache](security.md#the-egress-cache) and its CA (`ca/`, the `egress-cache` volume)                                                                                                                                                                                                                                                                                                                                                            |
| `EGRESS_CACHE_MAX` (egress proxy)                                                                                                  | none                              | `10g`                                                                                                   | the egress cache's size, in bytes or with `k`, `m`, `g`, `t`; the least recently used answers go beyond it; `0`: no cache                                                                                                                                                                                                                                                                                                                                                       |
| `EGRESS_CACHE_ENTRY_MAX` (egress proxy)                                                                                            | none                              | `1g`                                                                                                    | the largest answer it keeps                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DRAIN_SECONDS` (egress proxy)                                                                                                     | none                              | `25`                                                                                                    | how long a stopping proxy lets its open connections finish, then cuts them: short with one copy (compose), whose stop refuses new connections until the next one starts; `600`, an agent call's length, where a second copy takes them meanwhile (Kubernetes, [services.md](services.md#the-proxys-handover)); under its `stop_grace_period` or `terminationGracePeriodSeconds`                                                                                                 |
| `PORT` (in the containers)                                                                                                         | none                              | `8080`, egress proxy: `3128`, policy service: `8181`                                                    | port edge, the runner, the policy service and the proxy listen on (the orchestrator has none: its ports are `POLICY_PORT` and `SERVICES_PORT`); the `PORT` above only changes the published one                                                                                                                                                                                                                                                                                 |
| `GITHUB_URL`, `GITHUB_API`                                                                                                         | `github_url`, `github_api`        | `https://github.com`, `https://api.github.com`                                                          | GitHub's web and API addresses, always allowed through the egress proxy                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CONFIG_FILE`                                                                                                                      | none                              | `/etc/deckhand/config.yaml`                                                                             | the settings file above; set on purpose, it has to exist                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BROKER_SERVICE_URL`                                                                                                               | none                              | `http://broker:8081`                                                                                    | the [broker service](#the-broker-service), where the orchestrator asks for the runs' tokens, and edge and the orchestrator for their own service tokens; compose sets it                                                                                                                                                                                                                                                                                                        |
| `BROKER_SERVICE_URL` (egress proxy)                                                                                                | none                              | `http://broker:8081`                                                                                    | the broker service, one URL, where the proxy sends what a sandbox calls about its own run (`/run/…` on `http://broker:8081`, the name sandboxes call it by: its token's renewal, its inbox and files) with its own service token, and asks for that token; compose sets it                                                                                                                                                                                                      |
| `MODELS_SERVICE_URL`                                                                                                               | none                              | `http://models:8080`                                                                                    | the [models service](#the-models-service), comma-separated for its copies: where the orchestrator asks which agents' credentials it holds and their fingerprints (waiting for both at start) and a run's API state; compose sets it                                                                                                                                                                                                                                             |
| `MODELS_SERVICE_URL` (egress proxy)                                                                                                | none                              | `http://models:8080`                                                                                    | the models service, one URL (not comma-separated: the proxy stops at start otherwise; several copies go behind one address), where the proxy sends the sandboxes' agent calls (`/anthropic/`, `/openai/`, `/google/` on `http://models:8080`, the name sandboxes call it by, and the hosts relayed for an agent) with its own service token; compose sets it                                                                                                                    |
| `SERVICE_ACCOUNT_TOKEN_FILE` (edge, orchestrator, egress proxy, runner, github, models)                                            | none                              | none                                                                                                    | on Kubernetes, the pod's service account token projected for the broker (audience `deckhand-broker`), which proves to it who calls (see [kubernetes.md](kubernetes.md))                                                                                                                                                                                                                                                                                                         |
| `SERVICE_NETWORKS` (broker)                                                                                                        | none                              | none; compose sets it                                                                                   | with Docker, who calls the broker, by the network a call arrives on: `orchestrator=<subnet>,edge=<subnet>,proxy=<subnet>,runner=<subnet>,models=<subnet>,github=<subnet>`, each caller's own network to the broker; this or `SERVICE_ACCOUNTS` is required                                                                                                                                                                                                                      |
| `SERVICE_ACCOUNTS` (broker)                                                                                                        | none                              | none                                                                                                    | on Kubernetes, who calls the broker, by its pod's service account: `orchestrator=<namespace>:<name>,edge=<namespace>:<name>,proxy=<namespace>:<name>,runner=<namespace>:<name>,models=<namespace>:<name>,github=<namespace>:<name>`                                                                                                                                                                                                                                             |
| `STORE_URL` (broker)                                                                                                               | none                              | `file:///data/store`                                                                                    | the broker's store: the live runs, their files and events (the `broker-store` volume); `redis://…` for two copies on several nodes, with `REDIS_PASSWORD` (see [The store](#the-store))                                                                                                                                                                                                                                                                                         |
| `BLOB_URL` (runner, broker)                                                                                                        | none                              | none: the blobs stay in the store                                                                       | the service's [blob storage](#blob-storage), for the blobs that will never change again: `s3://<bucket>[/<prefix>]?endpoint=https://…&region=…` or `file:///<folder>`; checked at start, a setting that fails stops the service                                                                                                                                                                                                                                                 |
| `BLOB_ACCESS_KEY_ID`, `BLOB_SECRET_ACCESS_KEY` (runner, broker)                                                                    | none                              | none                                                                                                    | the S3 key pair of `BLOB_URL`, never in the URL; `BLOB_ACCESS_KEY_ID_FILE` and `BLOB_SECRET_ACCESS_KEY_FILE` name files holding them instead (a Kubernetes Secret's)                                                                                                                                                                                                                                                                                                            |
| `KEY_DIR` (broker)                                                                                                                 | none                              | `/keys`                                                                                                 | the folder of the broker's signing key, `run-token.key`, made on first start (the `broker-keys` volume): back it up, or every running sandbox's token is refused once it is gone                                                                                                                                                                                                                                                                                                |
| `DRAIN_SECONDS` (broker)                                                                                                           | none                              | `30`                                                                                                    | how long a stopping broker lets its calls finish (an inbox's long poll lasts 25 s), under its `stop_grace_period`                                                                                                                                                                                                                                                                                                                                                               |
| `PORT` (broker)                                                                                                                    | none                              | `8081`                                                                                                  | the port the broker listens on                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GITHUB_SERVICE_URL` (edge, orchestrator, runner, egress proxy)                                                                    | none                              | `http://github:8080`                                                                                    | the github service, which holds the App's key: the orchestrator's GitHub calls, edge's (`/setup`'s conversion, the redeliveries), the runner's tarballs, the sandboxes' GitHub calls and pushes (`/git/…` on `http://github:8080`, the name sandboxes call it by; one URL for the proxy)                                                                                                                                                                                        |
| `APP_DIR` (github service)                                                                                                         | none                              | `/app-key`                                                                                              | the folder of the App's credentials, its key with them (`app.json`, the `github-key` volume): back it up                                                                                                                                                                                                                                                                                                                                                                        |
| `STORE_URL` (github service)                                                                                                       | none                              | `file:///data/store`                                                                                    | its store (the `github-data` volume): the runs' state, the orchestrator's reactions, the idempotency keys; `redis://…` for two copies on several nodes                                                                                                                                                                                                                                                                                                                          |
| `SERVICE_NETWORKS` (github service)                                                                                                | none                              | none: it doesn't start; compose sets it                                                                 | each caller's network, `service=subnet`; `none` on Kubernetes                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DRAIN_SECONDS` (github service)                                                                                                   | none                              | `280`                                                                                                   | how long a stopping copy lets its calls finish (pushes, clones)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GITHUB_ORCHESTRATOR_SUBNET`, `GITHUB_EDGE_SUBNET`, `GITHUB_PROXY_SUBNET`, `GITHUB_RUNNER_SUBNET`, `BROKER_GITHUB_SUBNET` (`.env`) | none                              | `10.231.250.128/28`, `10.231.250.224/28`, `10.231.250.144/28`, `10.231.250.160/28`, `10.231.250.176/28` | the github service's networks                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SERVICE_NETWORKS` (models service)                                                                                                | none                              | none: no call taken (`none` on Kubernetes)                                                              | who calls it, by the network a call arrives on: `proxy=<subnet>,orchestrator=<subnet>`; compose sets it                                                                                                                                                                                                                                                                                                                                                                         |
| `STORE_URL`, `KEY_DIR` (models service)                                                                                            | none                              | `file://<DATA_DIR>/store`, `/keys`                                                                      | its store (the plans' refreshed logins, sealed, the runs' API state), and the folder of the key they are sealed with (`models.key`, made on first start)                                                                                                                                                                                                                                                                                                                        |
| `BROKER_SERVICE_URL`, `RUNNER_URL`, `SERVICE_KEYS_DIR` (models service)                                                            | none                              | `http://broker:8081`, `http://runner:8080`, `/service-keys`                                             | the broker (its service tokens, whether a run goes), the runner (the Antigravity login's refresh), and the broker's public keys, which its callers' service tokens are checked with                                                                                                                                                                                                                                                                                             |
| `DRAIN_SECONDS` (models service)                                                                                                   | none                              | `600`                                                                                                   | how long a stopping copy lets the agents' calls in flight finish                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PORT` (models service)                                                                                                            | none                              | `8080`                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `BROKER_ORCHESTRATOR_SUBNET`, `BROKER_EDGE_SUBNET`, `BROKER_PROXY_SUBNET`, `BROKER_RUNNER_SUBNET`, `BROKER_MODELS_SUBNET` (`.env`) | none                              | `10.231.250.0/28`, `10.231.250.208/28`, `10.231.250.16/28`, `10.231.250.32/28`, `10.231.250.64/28`      | the subnets of compose's networks between the broker and its callers, which `SERVICE_NETWORKS` names: change them in `.env` if they clash with one of the host's                                                                                                                                                                                                                                                                                                                |
| `MODELS_PROXY_SUBNET`, `MODELS_ORCHESTRATOR_SUBNET`, `RUNNER_MODELS_SUBNET` (`.env`)                                               | none                              | `10.231.250.80/28`, `10.231.250.96/28`, `10.231.250.112/28`                                             | the subnets of the models service's networks to its callers and to the runner, which tell them apart                                                                                                                                                                                                                                                                                                                                                                            |
| `DECKHAND_VERSION` (in the image)                                                                                                  | none                              | set when the image is built                                                                             | the version the dashboard shows                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DECKHAND_SOURCE` (in the image)                                                                                                   | none                              | set when the image is built; empty from source                                                          | the repository the image was built from: the dashboard links the version to its commit or release there                                                                                                                                                                                                                                                                                                                                                                         |

## Logs

Each service writes its own lines to stdout, one per event: its runs' output never goes there
(the runner keeps it, the dashboard shows it). Every line goes through the same redaction as the
runs' output first, GitHub's and Deckhand's own token shapes and the service's own secrets (the
App's key, the session key, the agents' credentials): once logs leave the host, a leaked token is
hard to get back.

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

With Compose, Docker keeps each container's lines in its `json-file` driver, rotated: five files
of 10 MB each per container (`compose.yaml`'s `x-logging`, which every service uses), the
oldest dropped first, so a long-running deployment never fills the disk with them. Read them
with `docker compose logs`: `docker compose logs -f --since 1h orchestrator runner` follows
two services, `docker compose logs --tail 200` shows the last lines of each.

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
  count, the services' [metrics](#metrics) do.

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

## Metrics

Every service (edge, the orchestrator, the runner, the broker, the github, models and policy
services, the egress proxy) serves Prometheus metrics, in its text format, for Prometheus or
VictoriaMetrics to scrape. Off by default: set the port and each service listens on it.

| Setting                        | `config.yaml` key | Default    | What                                                                                                  |
| ------------------------------ | ----------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `METRICS_PORT`                 | `metrics_port`    | none (off) | the port each service but the egress proxy serves `GET /metrics` on, `9464` say; empty: none          |
| `EGRESS_METRICS_PORT` (`.env`) | none              | none (off) | the egress proxy's: `compose.yaml` passes it as the proxy's `METRICS_PORT`, which sandboxes reach too |

- **A port of its own**, apart from the service ports: `GET /metrics` alone (any other path is
  404), with no token, so nothing secret goes in it. `compose.yaml` passes `.env`'s
  `METRICS_PORT` to every service but the egress proxy, and publishes none: your scraper joins
  a network of each service's ([With Compose](#with-compose)). Every service but the egress proxy reads `metrics_port`
  in `config.yaml` too (the broker mounts the server folder for it alone).
- **The egress proxy's is a setting of its own**, `EGRESS_METRICS_PORT`, as every sandbox
  reaches the proxy, and so its metrics port: they would read its memory, CPU and event loop
  lag, which other runs' traffic moves ([security.md](security.md#not-covered)). It reads
  its environment alone, never `config.yaml`. On Kubernetes, where the sandboxes reach its
  proxy port alone, the manifests give it `METRICS_PORT` as every service
  ([kubernetes.md](kubernetes.md#metrics)).
- **What every service says from the start**: `deckhand_build_info{service, version}` (always
  1), and its process's `deckhand_process_resident_memory_bytes`,
  `deckhand_process_cpu_seconds_total`, `deckhand_process_start_time_seconds`,
  `deckhand_process_event_loop_lag_seconds` (p99 over the last 10 s or more) and
  `deckhand_process_open_handles`. Where two copies share a lease (the orchestrator, the runner,
  edge's redeliveries' poller), `deckhand_lease_held{lease}` is 1 on the copy holding it, 0 on
  the one waiting: both answer, and what only the acting copy knows comes from it alone.
  `deckhand_lease_takeovers_total{lease}` counts the times a copy took it (at its start, from
  the other copy, again after losing it): a steady rate is copies taking it from each other, a
  store too slow for their renewals.
- **The models service's**: the agents' API calls that go through it with your credentials.
  - `deckhand_model_calls_total{provider, agent, status}`: `provider` anthropic, openrouter,
    openai or google; `agent` claude, codex or antigravity; `status` the answer's class (`2xx`,
    `4xx`, `5xx`…), with `429` (a rate or plan limit) and `529` (Anthropic overloaded) apart,
    `unreachable` (no answer) or `credential` (not sent: a plan's login that can't be used or
    refreshed). `deckhand_model_call_duration_seconds{provider}` is a call's length, its answer
    streamed whole; `deckhand_model_streams_interrupted_total{provider}` counts the answers the
    provider cut short (its connection lost, or no byte for 10 minutes), not those the agent gave
    up on.
  - `deckhand_model_tokens_total{provider, direction}`: the tokens a successful answer says it
    used, `direction` `input` (not read from the cache), `output`, `cache_read` and
    `cache_write` (Anthropic's alone). An answer, or one line of a stream, over 4 MB isn't read.
  - `deckhand_plan_usage_ratio{provider, window}`: how much of each plan's window the runs used
    (0 to 1), what the dashboard's bars show: `5h`, `7d`… for Claude and ChatGPT, a model's for
    the Antigravity CLI; 0 once a window's reset has passed.
  - `deckhand_plan_login_refreshes_total{provider, result}`: the ChatGPT (`openai`) and Google AI
    (`google`) plans' logins it refreshed, `ok`, `refused` (sign in again) or `failed`, counted
    by the copy that refreshed.
  - `deckhand_model_fallbacks_total{from, to}` comes from the orchestrator, which decides them:
    a run whose provider failed, put back for the next entry of `FALLBACKS`
    (`agent@provider[:credential]`).
- **The egress proxy's**: every connection a sandbox, a container engine, a build or an agent's
  install makes (a CONNECT, or a plain HTTP request), and the runs' calls it passes on.

  | Metric                                                           | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
  | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `deckhand_egress_connections_total{source, decision, reason}`    | `source`: `sandbox`, `engine`, `build`, `install`, `none` (no run at that address) or `unknown` (the policy didn't answer); `decision`: `allowed` (`reason` `granted`) or `denied`, `reason` then `not_granted`, `blocked` (the agent's), `no_run`, `no_build`, `not_forwarded` (a service's name, for a build or a tunnel), `private_address`, `unresolved`, `no_relay` (a relayed host with no CA or service) or `policy_error`. Never the host: a denied one is in the proxy's and the orchestrator's log lines |
  | `deckhand_egress_bytes_total{source, direction}`                 | bytes between the clients and the proxy, `out` (sent by the client) and `in`, counted as they go: a long tunnel's too                                                                                                                                                                                                                                                                                                                                                                                              |
  | `deckhand_egress_connections_open{source}`                       | client connections open (a kept-alive one carries several requests)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
  | `deckhand_egress_policy_duration_seconds`                        | how long the orchestrator's egress policy took, a histogram by `result`: `answered`, or `failed` (`policy_error`), whose time includes the wait for a restarting orchestrator (up to 5 minutes)                                                                                                                                                                                                                                                                                                                    |
  | `deckhand_egress_cache_requests_total{result}`                   | requests to `cached_hosts`: `hit`, `revalidated` (the host said it hadn't changed), `miss`, `stored` (a miss kept), `bypassed` (credentials, a range, a body, `no-store`)                                                                                                                                                                                                                                                                                                                                          |
  | `deckhand_egress_cache_bytes`, `deckhand_egress_cache_max_bytes` | the cache's size, kept and being written, and its limit (`EGRESS_CACHE_MAX`; 0 when it is off)                                                                                                                                                                                                                                                                                                                                                                                                                     |
  | `deckhand_egress_gateway_calls_total{target, status}`            | the runs' calls passed on to the `broker`, `github` and `models` services, by the answer's status, or `unreachable`                                                                                                                                                                                                                                                                                                                                                                                                |

- **Bounded labels**: never a run, issue, request or delivery ID, which stay fields of the
  [log lines](#logs): a metric declaring such a label (`run`, `issue`, `repo`, `host`, `…_id`:
  `lib/metrics.mjs` `UNBOUNDED_LABELS`) doesn't start its service. A label value outside those its metric declares, or a series past 200 of
  one metric, is counted as `other`, and the service logs it once.

### With Compose

A `compose.override.yaml` beside `compose.yaml` (read by `docker compose up -d`, no
flag needed) puts each service on a network of its own with your scraper: one network for all of
them would let each reach the others, which their networks keep apart
([security.md](security.md#the-services-networks)). Each is internal, with no way out, and nothing
is published. On them, the scraper reaches the services' other ports too: their `/health`, and
calls they refuse without a caller's service token (or, on the orchestrator's egress policy
port, the proxy's address). With Prometheus, in the same project:

```yaml
# compose.override.yaml: each service's metrics on a network shared with the scraper alone.
services:
  edge:
    networks: [metrics-edge]
  orchestrator:
    networks: [metrics-orchestrator]
  runner:
    networks: [metrics-runner]
  broker:
    networks: [metrics-broker]
  github:
    networks: [metrics-github]
  models:
    networks: [metrics-models]
  policy:
    networks: [metrics-policy]
  # Scraped with EGRESS_METRICS_PORT=9464 alone.
  egress:
    networks: [metrics-egress]
  prometheus:
    image: prom/prometheus:v3.15.1
    restart: unless-stopped
    ports: ["127.0.0.1:9090:9090"]
    configs:
      - source: prometheus
        target: /etc/prometheus/prometheus.yml
    # Its UI's (and its remote write's) network, then each service's.
    networks:
      - prometheus
      - metrics-edge
      - metrics-orchestrator
      - metrics-runner
      - metrics-broker
      - metrics-github
      - metrics-models
      - metrics-policy
      - metrics-egress
    volumes: [prometheus:/prometheus]

networks:
  prometheus:
  metrics-edge: { internal: true }
  metrics-orchestrator: { internal: true }
  metrics-runner: { internal: true }
  metrics-broker: { internal: true }
  metrics-github: { internal: true }
  metrics-models: { internal: true }
  metrics-policy: { internal: true }
  metrics-egress: { internal: true }

volumes:
  prometheus:

configs:
  prometheus:
    content: |
      scrape_configs:
        - job_name: deckhand
          static_configs:
            - targets: [edge:9464, runner:9464, broker:9464, github:9464]
            - targets: [models:9464, policy:9464, egress:9464]
          # Each copy of the orchestrator, `--scale orchestrator=2` too: its name resolves to
          # every one (deckhand_lease_held says which acts).
          dns_sd_configs:
            - names: [orchestrator]
              type: A
              port: 9464
```

`METRICS_PORT=9464` (and `EGRESS_METRICS_PORT=9464` for the proxy's) in `.env`, then
`docker compose up -d`. A scraper of another Compose project joins the same networks as
`external: true`, by their names in this one (`deckhand_metrics-edge`…); vmagent takes the same
scrape config.

### The orchestrator's

| Metric                                               | What                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deckhand_runs_started_total{mode, agent, kind}`     | runs past their settings (the `running` log line). `mode`: a built-in one, or `custom` for a repo's own; `kind`: `work`, `light`, `review`, `fix` (a review's fix round), `ci-fix`, `conflict` (a rebase), `auto-pickup`                                                                                                                                                                                      |
| `deckhand_runs_finished_total{mode, outcome}`        | runs ended, `outcome` as their `done (…)` line says: `ok`, `needs-input`, `error`, `cancelled` (a run failing before it started counts as `error`)                                                                                                                                                                                                                                                            |
| `deckhand_run_duration_seconds{mode, outcome}`       | a histogram of the same runs' length, from leaving the queue to their end (30 s to 8 h buckets)                                                                                                                                                                                                                                                                                                               |
| `deckhand_runs_running`                              | runs going: their sandbox started, or being prepared                                                                                                                                                                                                                                                                                                                                                          |
| `deckhand_runs_queued{reason}`                       | tasks waiting: for a free `slot`, for their `repo`'s own `max_parallel`, for one of `AUTO_PICKUP_SLOTS` while auto-picked runs hold them all (`pickup`: an auto-picked task takes no other slot; with one of them free, it waits as a `slot`), in the `pause` that makes a burst of comments one run, for other issues (`after`, "/after #12"), for the `answers` to their open questions once those are done |
| `deckhand_max_parallel`                              | `MAX_PARALLEL`                                                                                                                                                                                                                                                                                                                                                                                                |
| `deckhand_auto_pickup_slots{state}`                  | `AUTO_PICKUP_SLOTS`: `used` by auto-picked tasks, `lent` to other runs while no auto-picked task waits, `free`                                                                                                                                                                                                                                                                                                |
| `deckhand_deliveries_processed_total{event, result}` | verified deliveries: `taken` (a comment for a run, past the operator's checks, or a state it follows: issues, pull requests, CI, pushes, installations), `ignored` (a comment that asks nothing, a bot's, a ping), or `refused` by the operator's checks (a repo out of `ALLOWED_REPOS`, an author out of `ALLOWED_USERS`, not from an installation of the App), whatever the event                           |
| `deckhand_conflict_checks_total{result}`             | pull requests asked whether they still merge (`conflicts.check_minutes`): `started` (a rebase run), `clean`, `pending` (GitHub doesn't know yet), `refused` (the policies), `skipped` (a run going, input awaited, that head and base tried already), `error`                                                                                                                                                 |
| `deckhand_fix_rounds_total{result}`                  | reviews requesting changes: a fix run `started`, `refused` by the policies, `exhausted` (its rounds used up), `skipped` (a run going, input awaited, a Fix from the dashboard being started…), or `error`                                                                                                                                                                                                     |
| `deckhand_waits_checked_total`                       | issues asked of GitHub for the comments waiting for them                                                                                                                                                                                                                                                                                                                                                      |
| `deckhand_service_calls_total{callee, status}`       | its calls to the `broker`, `runner`, `github`, `models` and `policy` services, each try (a service away answers `503`, and is tried again), by status: the usual codes as they are, others by class (`5xx`), `error` for no answer                                                                                                                                                                            |
| `deckhand_service_call_duration_seconds{callee}`     | how long those take to answer (until the answer's headers; the broker's, to its end), the event streams' long polls left out: a slow service shows here first                                                                                                                                                                                                                                                 |

The runs, the queue and the slots are the acting copy's alone: the waiting one has no samples of
those (`deckhand_lease_held` 0), and its counters stay at 0 until it takes over. A run that a
copy picks up after a handover counts as started on the copy that started it, and as finished on
the one that saw it end: sum them over both.

### The broker's

The tokens it signs, renews and refuses (`broker/metrics.mjs`). Each copy counts what it
answered: add the copies up, but for `deckhand_runs_live`, their shared store's (take the max).

| Metric                          | Labels   | What                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deckhand_tokens_issued_total`  | `kind`   | tokens signed: `run` (a run's first, and each renewal that signs a new one), `agent` (a run's agent token, at its start), `service` (one per service a service's token is for)                                                                                                                                                                                        |
| `deckhand_token_renewals_total` | `result` | sandboxes' renewals: `renewed` (a new token), `again` (the one signed less than a minute before), `refused`                                                                                                                                                                                                                                                           |
| `deckhand_tokens_refused_total` | `reason` | tokens refused, a run's or a service's: `expired`, `invalid` (none, not one, another key's or another service's), `run_over` (its run ended, or isn't held), `wrong_sandbox` (a run token from another sandbox), `unknown_caller` (a service token from another service's network, or asked from none's), `not_allowed` (an endpoint, a token a service may not have) |
| `deckhand_runs_live`            |          | the live runs the broker holds (a run whose record expired, its end never said, no longer counts)                                                                                                                                                                                                                                                                     |
| `deckhand_inbox_polls_open`     |          | the sandboxes' inbox long polls this copy holds open                                                                                                                                                                                                                                                                                                                  |

### The policy service's

Its decisions and the operator's policies (`policy-service/metrics.mjs`). Each copy counts what
it answered: add the copies up.

| Metric                             | Labels             | What                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deckhand_policy_decisions_total`  | `policy`, `result` | decisions evaluated. `policy`: the decision (`run`, `merge`, `review`, `fix`, `link_branch`, `request_review`, `github`, `push`, `grant`), or `capabilities` (what a run gets as it starts). `result`: `allow`, `deny`, or `error` (the policies don't compile, took over 2 s, gave a rule the wrong type), which the caller refuses; the capabilities' `allow` is "evaluated"   |
| `deckhand_policy_decision_seconds` | `policy`           | how long opa took on a decision, once its set was loaded: cut at 2 s, so the top buckets are the ones to watch                                                                                                                                                                                                                                                                   |
| `deckhand_policy_reloads_total`    | `result`           | loads of the operator's policies (the first a decision reads, then each change to `policy/` in the grants folder): `ok`, or `error` (they can't be read or don't compile), checked with an `opa check` of their own when `METRICS_PORT` is set. There is no last good set to fall back on: until they are fixed, every decision is refused, as [security.md](security.md) has it |

### Edge's

What reaches Deckhand from outside (`edge/metrics.mjs`). Each copy counts its own requests:
add the copies up.

| Metric                                   | Labels            | What                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deckhand_webhooks_received_total`       | `event`, `result` | GitHub's deliveries. `result`: `accepted`, `duplicate` (taken already, by this copy or the other), `ignored` (not JSON, CI of a repo not allowed), `bad_signature`, `refused` (no App yet, or stopping), `too_large`, `busy`, `unread` (cut short, too slow), `failed` (the store away)                                                |
| `deckhand_webhooks_redelivered_total`    |                   | failed deliveries edge asked GitHub to send again, on the copy holding the poller's lease                                                                                                                                                                                                                                              |
| `deckhand_http_requests_total`           | `route`, `status` | requests on the public port: the dashboard's pages, files and API, sign-in, `/webhook`, `/status`… `route` is its pattern (`/api/runs/:id/stream`), never the path; `other` for one edge doesn't serve. `status` is its class (`2xx`, `4xx`…), as anyone can get a 401 or a 400 on any route; `none`: the client left before an answer |
| `deckhand_http_request_duration_seconds` | `route`           | how long they took, to the answer's end: a live log's whole life                                                                                                                                                                                                                                                                       |
| `deckhand_sign_ins_total`                | `result`          | `allowed`, `refused` (not in `ALLOWED_USERS`), `expired` (back from GitHub without its state), `cancelled` (Cancel on GitHub's page), `failed` (GitHub refused the code, didn't say who it was, or didn't answer)                                                                                                                      |
| `deckhand_sessions_active`               |                   | users signed in who used the dashboard in the last 15 minutes, on either copy: both say the same (take the max, not the sum)                                                                                                                                                                                                           |
| `deckhand_log_streams_open`              |                   | runs' live logs this copy streams to a browser                                                                                                                                                                                                                                                                                         |

`event` is one of the events GitHub sends the App, `other` for any other name: the header comes
before the signature is checked, so what the internet writes there never makes a series.

### The runner's

| Metric                                             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deckhand_sandboxes_running{engine}`               | sandboxes running (on Kubernetes, Pending pods too), by the container engine their run has: `none`, `sysbox`, `podman`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `deckhand_sandbox_start_seconds{runner}`           | a histogram (1 s to 20 min buckets) from a start asked to its sandbox running: on Docker until `docker run` returns (the agent is installed before, by a call of its own), on Kubernetes until the pod leaves Pending (its image's pull, its agent's install in its init container, its network gate). Only the copy that started it times it                                                                                                                                                                                                 |
| `deckhand_sandboxes_failed_to_start_total{reason}` | starts that failed: `refused` (the runner's spec check), `not_isolated` (Kubernetes: the sandboxes' NetworkPolicies missing, or not enforced as the network probe found), `isolation_unknown` (the probe couldn't tell), Pending past `KUBERNETES_PENDING_MINUTES` because `unschedulable` (no node with the room), `image_pull`, `agent_install` (its init container's install failed or outlasted the wait), `network_gate` (its NetworkPolicies never applied), `pending` (another reason: a volume), `error` (Docker's errors, the API's) |
| `deckhand_network_isolated`                        | Kubernetes: 1 when the network probe last found a sandbox reaches the egress proxy alone, 0 when it reached something else, which refuses every run; absent before its first verdict, and on Docker. The alert to have                                                                                                                                                                                                                                                                                                                        |
| `deckhand_network_probes_total{result}`            | network probes: `isolated`, `reached` (a leak: runs refused), `unknown` (it couldn't tell: the proxy not ready, its pod not ending; the next run's start probes again)                                                                                                                                                                                                                                                                                                                                                                        |
| `deckhand_network_probe_seconds`                   | a histogram of how long a probe took, its pod's start included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `deckhand_image_builds_total{runner, result}`      | repo images built, `ok` or `error` (a build refused before it runs, the builder not isolated on Kubernetes, is an `error` too; an image already built is reused, not counted)                                                                                                                                                                                                                                                                                                                                                                 |
| `deckhand_image_build_seconds`                     | a histogram (5 s to 1 h buckets) of those builds' length, failed ones too                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `deckhand_image_prunes_total{result}`              | old tags a build prunes: `deleted`, `kept` (a sandbox still runs it, tried again at the next prune), `failed` (Docker or the registry refused: logged)                                                                                                                                                                                                                                                                                                                                                                                        |
| `deckhand_agent_installs_total{agent, result}`     | agents installed into their shared volume, once per version, `ok` or `error`; none on Kubernetes without a claim for it, where each sandbox installs its own                                                                                                                                                                                                                                                                                                                                                                                  |

Its sandboxes and the probe's verdict are the acting copy's alone: the waiting one has no samples
of those. Its lease is `deckhand_lease_held{lease="runner"}`.

### The github service's

Where GitHub's limits show: the one service holding the App's key (`github/metrics.mjs`). Each
copy counts its own calls: add the copies' counters up, and take the lowest of their rate limits.

| Metric                                      | Labels             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deckhand_github_api_calls_total`           | `caller`, `status` | calls to GitHub's API. `caller`: the service the call was made for (`orchestrator`, `edge`, `runner`, `proxy` for the runs' gateway), with the installation lookups and tokens it needed; `github`, its own. `status`: GitHub's, `error` for none (a call the sandbox gave up on first too)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `deckhand_github_api_call_duration_seconds` | `caller`           | how long GitHub took to answer, to its headers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `deckhand_github_rate_limit_remaining`      | `resource`         | calls left in the rate limit (`core`, `graphql`, `search`), the lowest of the installations' (and the App's own) as GitHub's latest answers said, a call without a token left out: the earliest warning that runs are about to stall. None until an answer said, nor past its reset                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `deckhand_github_rate_limit_limit`          | `resource`         | the calls that lowest limit allows in its window (5000 an hour, more on GitHub Enterprise Cloud), as GitHub's `x-ratelimit-limit` said: `remaining / limit` is the share left of the key with the fewest calls left, close to the lowest share (another installation's larger window may have less of it left)                                                                                                                                                                                                                                                                                                                                                                                         |
| `deckhand_github_rate_limit_reset_seconds`  | `resource`         | seconds until that lowest limit starts again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `deckhand_git_operations_total`             | `op`, `result`     | `op`: `clone` (a mirror's first fetch; an empty repository's mirror stays empty, so each of its pushes counts one), `mirror_update`, `fetch` (a sandbox's fetch or clone, relayed, once whatever its requests: `ok` when its whole pack came, `refused` when Deckhand refused one of its requests (a fork's objects, too many calls at once), `failed` when GitHub answered one with an error (a 404 for a misspelt repository, an `ERR` for an object it doesn't have), or its answer was cut short; an `ls-remote` or a fetch with nothing new brings no pack, and isn't counted), `push`. `result`: `ok`, `refused` (by Deckhand), `rejected` (by GitHub: a branch protection, a ruleset), `failed` |
| `deckhand_pushes_refused_total`             | `reason`           | `default_branch`, `branch` (not the run's, or not a branch), `run` (one that can't push, or not there), `policies` (`deny_push`), `workflows` (a workflow file that writes or names a secret), `fork` (a fork's objects), `error` (not checked)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `deckhand_mirror_bytes`                     |                    | the git mirrors on its volume (the repos granted `workflows`, and work runs' pushes checked for a fork's objects), read at most once a minute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

A protected branch is Deckhand's own refusal of the default branch (`default_branch`); GitHub's
branch protections and rulesets refusing a push it let through are `git_operations_total`'s
`rejected`.

### The dashboard

`deploy/grafana/deckhand.json` is a Grafana dashboard of these metrics, its data source a
variable of its own (`Data source`, any Prometheus or VictoriaMetrics one): import it (Dashboards,
New, Import), or provision it. Its rows:

- **Runs**: those going and queued (by why) against `MAX_PARALLEL`, started by mode, kind and
  agent, ended by outcome, their duration, the share of errors over a day.
- **Webhooks and GitHub**: the deliveries edge received and the orchestrator took, GitHub's rate
  limit left (its share of the window, by resource), the API calls by status and their time, the
  git operations and the pushes refused.
- **Models**: the agents' calls by provider and status, the fallbacks, the plans' usage, the
  tokens, the calls' length, the streams cut short and the logins refreshed.
- **Egress**: the connections denied by why and allowed by source, the traffic, the cache's
  requests and size against `EGRESS_CACHE_MAX`, the egress policy's time and the gateway's failed
  calls.
- **Sandboxes and images**: the network probe's verdict, the sandboxes running by engine and
  their start time, the starts failed by why, the probes, the image builds and their time.
- **Services**: each copy's memory, CPU and event loop lag (by the `service` its
  `deckhand_build_info` says), the leases and their takeovers, the orchestrator's failed calls
  to the other services, and the version each copy runs.

With the chart, `metrics.dashboard.enabled` ships it as a ConfigMap for Grafana's sidecar
([kubernetes.md](kubernetes.md#metrics)). With Compose, Grafana provisions it from a folder:

```yaml
# compose.override.yaml, beside the Prometheus above.
services:
  grafana:
    image: grafana/grafana:12.3.0
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]
    networks: [prometheus]
    configs:
      - source: grafana-datasource
        target: /etc/grafana/provisioning/datasources/prometheus.yaml
      - source: grafana-dashboards
        target: /etc/grafana/provisioning/dashboards/deckhand.yaml
    volumes:
      - ./deploy/grafana:/var/lib/grafana/dashboards/deckhand:ro
      - grafana:/var/lib/grafana

volumes:
  grafana:

configs:
  grafana-datasource:
    content: |
      apiVersion: 1
      datasources:
        - { name: Prometheus, type: prometheus, url: "http://prometheus:9090", isDefault: true }
  grafana-dashboards:
    content: |
      apiVersion: 1
      providers:
        - { name: deckhand, options: { path: /var/lib/grafana/dashboards/deckhand } }
```

(`./deploy/grafana` from a clone of this repository, at your release's tag; or a copy of the
file in a folder of yours.)

### Alerts

`deploy/alerts/deckhand.yaml` holds Prometheus alerting rules, for Prometheus (`rule_files`) or
vmalert (`-rule`); with the chart, `metrics.rules.enabled` ships them as a `PrometheusRule` (or,
with `metrics.rules.kind: VMRule`, VictoriaMetrics') ([kubernetes.md](kubernetes.md#metrics)).
Each has a `severity` label, `critical`, `warning` or `info`, for your Alertmanager's routes.
`DeckhandServiceDown` reads the `up` of the targets of job `deckhand`, as the scrape config above
and the chart's ServiceMonitor name them: with a job of another name (an annotation-based
`kubernetes-pods`, say), change its selector (the chart's `metrics.rules.job`). They assume one Deckhand per Prometheus: their
sums and maxima take every target's series, so two installs scraped by one (staging and
production, say) need their copies of the file, each selecting its own (a `namespace` matcher). Their
thresholds are starting points: copy the file to tune them, and keep its tests
(`deckhand.test.yaml`, `promtool test rules`) beside it. With the Prometheus above, the file in
its configs too:

```yaml
configs:
  prometheus:
    content: |
      rule_files: [/etc/prometheus/deckhand-alerts.yaml]
      scrape_configs: …
  prometheus-alerts:
    file: ./deploy/alerts/deckhand.yaml
```

and `- { source: prometheus-alerts, target: /etc/prometheus/deckhand-alerts.yaml }` in its
service's `configs`. As it is, the alerts show on Prometheus' Alerts page alone: to be told of
them, point it at your Alertmanager too (`alerting: { alertmanagers: [{ static_configs:
[{ targets: [alertmanager:9093] }] }] }` in the same config).

| Alert                            | Severity | When                                                                                                                                                                                                | What to do                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DeckhandNetworkNotIsolated`     | critical | Kubernetes: the network probe found a sandbox reaching more than the egress proxy (`deckhand_network_isolated` 0)                                                                                   | every run is refused until it is fixed: the sandboxes' NetworkPolicies are missing, or the cluster's network plugin doesn't enforce them. Run `deploy/kubernetes/check-isolation.sh` ([kubernetes.md](kubernetes.md#the-network-probe)); the next run's start probes again                                                                                                                                        |
| `DeckhandServiceDown`            | critical | a target of job `deckhand` hasn't answered its metrics port for 5 minutes, for as long as it stays down                                                                                             | its logs say why (`docker compose logs <service>`, `kubectl logs --previous`): a setting it refuses at start, the store or the broker away, its memory limit. A copy a rollout replaced leaves the scrape targets and doesn't fire it, nor does a service no target is left for (the orchestrator's copies found by DNS, all stopped; a pod Pending): `DeckhandServiceMissing` and `DeckhandNoLeaseHolder` say so |
| `DeckhandServiceMissing`         | critical | no copy of the broker, the github, models or policy service has answered for 5 minutes (no `deckhand_build_info` of its `service`): on Kubernetes its pods Pending or gone, which leave the targets | every run needs them: `kubectl get pods` (Pending: no node with the room; none: its Deployment scaled down), `docker compose ps`. The services with a lease are `DeckhandNoLeaseHolder`'s; the egress proxy isn't watched, its metrics port being off by default with Compose                                                                                                                                     |
| `DeckhandNoLeaseHolder`          | critical | no copy holds the `orchestrator`, `runner` or `edge/redeliveries` lease for 2 minutes: every copy answering waits, or none answers at all                                                           | no run starts (orchestrator), no sandbox starts (runner), or no failed delivery is asked again (edge). Check the copies run, then that [the store](#the-store), which holds the lease, is reachable, then their logs                                                                                                                                                                                              |
| `DeckhandRunsFailing`            | warning  | over a quarter of the runs that ended in the last hour, 3 at least, ended in an error, for 15 minutes                                                                                               | the orchestrator's `done (error …)` lines and the runs' logs on the dashboard say why: an agent's credential, an image build, a sandbox's start, the policies refusing what the runs need                                                                                                                                                                                                                         |
| `DeckhandGitHubRateLimitLow`     | warning  | under 10 % of a GitHub rate limit (`core`, `graphql`) left for 5 minutes, the lowest installation's or the App's; not `search`, a minute's 30 calls that come back a minute later                   | runs stall once it is spent, until `deckhand_github_rate_limit_reset_seconds`. `deckhand_github_api_calls_total` by `caller` says who spends it: lower `MAX_PARALLEL`, or `conflicts.check_minutes` for many open pull requests                                                                                                                                                                                   |
| `DeckhandModelsLimited`          | warning  | over 10 % of the calls to a provider answered 429 (a rate or plan limit) or 529 (Anthropic overloaded), 15 minutes                                                                                  | a plan used up shows on the dashboard's bars (`deckhand_plan_usage_ratio`): lower `MAX_PARALLEL`, or set `FALLBACKS` to another provider. 529s pass on their own                                                                                                                                                                                                                                                  |
| `DeckhandQueueStuck`             | warning  | tasks waited for a free slot for 15 minutes with fewer runs going than `MAX_PARALLEL` (an auto-picked task waiting while its own slots are all held, `pickup`, doesn't count)                       | the orchestrator's log says why its runs don't start: the runner, the policy service or the broker away (`deckhand_service_calls_total`), or its store                                                                                                                                                                                                                                                            |
| `DeckhandSandboxesStuckStarting` | warning  | Kubernetes: a sandbox given up on after staying Pending past `KUBERNETES_PENDING_MINUTES`, in the last 30 minutes                                                                                   | its `reason` says why: `unschedulable` (no node with the room: the nodes, or `KUBERNETES_*` requests), `image_pull` (the registry, its pull Secret), `agent_install`, `network_gate` (the network plugin), `pending`. `kubectl describe pod` in the sandboxes' namespace says more                                                                                                                                |
| `DeckhandSandboxStartsSlow`      | info     | one start in ten took over 5 minutes in the last hour, for 15 minutes                                                                                                                               | a large image pulled on each node, a slow registry, a cluster adding a node for each sandbox: pre-pull the image, or keep a node warm                                                                                                                                                                                                                                                                             |
| `DeckhandEgressCacheFull`        | info     | the egress cache has held 95 % of `EGRESS_CACHE_MAX` for an hour                                                                                                                                    | it evicts the least recently used answers, which is fine until what the runs fetch no longer fits: if its misses grow (`deckhand_egress_cache_requests_total`), raise `EGRESS_CACHE_MAX` and the volume under it                                                                                                                                                                                                  |

## Health checks

Every service in `compose.yaml` has a health check, which calls its own `/ready` (or `/health`)
with `node -e "fetch(…)"`, which every image can run: once a second while it starts, then every
30 s. `docker compose ps` shows each one `healthy`, `starting` or `unhealthy`. A service starts
only once those it needs at its start are healthy (`depends_on` with
`condition: service_healthy`; one it calls only later, it calls again until that one answers):
the broker first, whose public keys the others check service tokens with, then the policy
service, the github and models services, edge and the runner, and the orchestrator last.

The orchestrator's and the runner's check `/health`, which a copy waiting for the lease answers
too (its `/ready` is 503 until it acts, [Two copies](#two-copies)); the others' check `/ready`,
which turns 503 once a stopping copy drains (and answers 503 on edge, the github and models
services and the egress proxy until the broker has answered them,
[services.md](services.md)). Docker
doesn't restart an unhealthy container by itself: its logs say why.

## Updating

Each release is a git tag (`v1.2.3`) that publishes the images, tagged `1.2.3`, `1.2`
and `latest`. Each commit of `main` whose checks pass publishes them too, tagged `edge`. There is no built-in updater: update the way you update other compose
services.

```sh
docker compose pull
docker compose up -d
```

- **`latest`** (the default): the two commands above take the newest release. Watchtower
  can run them for you.
- **A pinned version**: set `DECKHAND_VERSION=1.2.3` in `.env`, change it to update (by
  hand, or with Renovate's docker-compose or regex manager), then the same two commands.
- **`edge`**: set `DECKHAND_VERSION=edge` in `.env` to follow `main`, unreleased and for
  amd64 only (the tag has nothing to do with the edge service).
  It is built once the repository's checks pass on `main`'s newest commit: a commit whose checks
  fail gets no image, and `edge` stays on the last one that passed (a newer commit cancels the
  build in progress, so a burst of merges builds once). The dashboard shows the commit it runs
  as `edge-<short sha>`. The same two
  commands (or Watchtower) update it.

To check which version runs and that a restart happened, open the dashboard's Repositories
page: its toolbar shows the version (linked to its commit or release), the orchestrator's uptime
and its Node version, as in "Deckhand edge-1713fa6 · up 3 d 4 h · Node 26.1.0". `/status`
returns the same `version` and `startedAt` for scripts.

You can update at any time, runs in progress included. The orchestrator and the runner stop
within their grace periods without waiting for them: the orchestrator starts no new run, saves the comments still waiting for
one, and the sandboxes keep running. The new orchestrator finds them again by their Docker
labels, delivers the comments that arrive meanwhile, and posts each run's final reply once,
even for a run that finished while no orchestrator was there. Queued comments are then handled.
Edge takes GitHub's webhooks meanwhile: they wait in its store until the orchestrator reads
them, so none is lost. With two copies of each, an update stops nothing ([Two copies](#two-copies)).
A new base image rebuilds a repository's own image on its next run (see
[Per-repo config](repo-config.md)); running sandboxes keep the image they started with.
The policy service restarts in a few seconds and holds nothing: the decisions the orchestrator
asks meanwhile (a run's GitHub write, a merge) wait for it, up to 30 seconds, rather than being
refused.

The policy service reads your server folder as the `node` user (uid 1000): your grants folder and
its `policy/` must be readable by that user (the usual `0644` files and `0755` folders are), or
every policy decision is refused, and the orchestrator's log says why at start.

### Upgrading: `+scan` for Redis's user (#614)

With Redis as [the store](#the-store), the orchestrator now lists keys by prefix (`SCAN`) at its
start: the maps it keeps one key per item (#615, #616), its live runs' states (#617). A
`deckhand` user written from this page before #614 has no `+scan`: the orchestrator then stops
at its start with `NOPERM … 'scan'` in its log. Add it before you update, in `redis.conf` (the
`user deckhand …` line, as in [The store](#the-store)) or at once on the running Redis, as a
user allowed `ACL` (the one you administer it with: `default` is off there). `ACL SETUSER` adds
to the user's rules, keeping the others:

```sh
redis-cli --user <admin> --askpass ACL SETUSER deckhand +scan
redis-cli --user <admin> --askpass ACL SAVE   # only with an aclfile: it writes the users there
```

`ACL SETUSER` alone is lost when Redis restarts on a `redis.conf` without it: change the file
too. On Kubernetes, the `redis` component and the Helm chart write their users again each time
Redis starts, the orchestrator's with `+scan`: nothing to do there.

### Upgrading: the orchestrator's state in its store (#615, #616)

The orchestrator kept its state in JSON files in its data volume (`/data`). They go to its
[store](#the-store) now: those that hold data alone, `titles.json`, `closed.json`, `pulls.json`,
`dismissed.json`, `order.json`, `onboarding.json`, `lanes.json`, `modes.json`, `conflicts.json`,
`dry-runs.json` and `requested.json` (#615); and those behind timers and comments,
`waits.json` (the comments waiting for other issues, `/after`), `inputs.json`, `reviews.json`,
`brainstorms.json`, `decisions.json` and `picks.json` (#616). Nothing to do: at its first start after the update, the
orchestrator writes each file's items to the store (those it doesn't have yet), then removes the
file, and its log says so (`titles: 120 item(s) moved to the store from /data/titles.json`). A
crash midway moves them again at the next start, the same values. A file it can't read (another user's,
or cut short) is left where it is, and its log says why. Fix its owner (`chown`, `chmod`), and it is moved at
the next start, filling only what the store lacks. Remove one cut short rather than edit it:
an edited file counts as written after the store's items, and replaces them. `reactions.json`, which the
github service took over before (#458), is removed once handed over.

With Redis as the store, these items are Redis keys under the store's prefix
(`deckhand:titles/…`): plan for a few thousand more. While the store is away, the orchestrator
goes on from what it has in memory and tries its writes again every few seconds; its `/ready`
says how many wait (`{"ok": true, "waiting": 3}`), and a copy that stops waits 10 seconds for
them before it lets its lease go.

The comments waiting in `waits.json` were the owner's only (`0600`); in the store, what keeps
them is the store's own access (its folder, or Redis's user and network, above).

Going back to an earlier release: it doesn't read the store's items, and starts from empty
files (the titles are asked of GitHub again, the run order and the lanes' names are lost; from
before #616, the waits, the review loops' counts and the brainstorms too).
Updating again after that (#690): a file that release wrote after this one last started (its
modification time later, on the orchestrator's clock: the store keeps when each map was last
loaded, `store-maps/<name>`) is newer than the store's items, and its items replace those of the
same key (a `null` one deletes it: an issue reopened), so what that release changed (a dismissal,
an onboarding issue, a wait) holds. The
store's other items are kept: that release started without them rather than deleted them. The
run order is the exception: its file replaces it whole, as its ranks don't mix with the store's.
A file it never wrote (nothing of that kind changed while it ran) leaves the store's items as
they were before going back. An orchestrator from before #690 that already had the store kept no
such time. If you go back from one of those to a release from before the store, then update
again, the files only fill what the store lacks, as at the first update.

### Upgrading: the maps' items a file each (#691)

With the file store, the items of the orchestrator's maps (above) were keys in its `state.json`,
written whole at each change of any of them. Each is a file of its own in the store's `keys/`
now, as the runs' summaries are. Nothing to do: once the orchestrator holds its lease, so once
the copy of the release before let it go, it moves those left in `state.json` to their files,
and its log says so (`The store: 840 item(s) moved out of its state file, a file each`). One it
can't write stops the start there, said in its log and tried again every 5 seconds; nothing is
lost meanwhile. Not before the lease: the release before, still acting, would delete none of
them from their files. With Redis, nothing changes.

Going back to an earlier release: it reads the maps' items from `state.json` alone, and starts
without them: the comments waiting for other issues (`/after`), the review loops' counts, the
brainstorms, the picks, the decisions, the run order and the lanes'
names are lost, and the titles, closed states and pull requests asked of GitHub again. Roll back
with nothing waiting, or keep a copy of the store's folder from before the update and put it
back.

### Upgrading: a live run's state in the store (#617)

The orchestrator keeps each running run's state in its store (`runs/<id>`), no longer in
`logs/<run>.live.json` in its `data` volume, and never with the run's tokens: a copy taking over
asks the broker for them (`POST /runs/:id/secrets`). At its first start, the orchestrator moves
each `logs/<run>.live.json` left there to the store, tells the broker the tokens it held, and
removes it; a `logs/<run>.queued.json` (a task's queue a run's end couldn't write to the store)
is read with the queue and removed once the queue is written. A `logs/<run>.live.json` that
isn't a run's state (unreadable, or missing its `id`, `task` or `record`) is no live run's: it
is left where it is, logged at each start (`<file>: not a run's state, left there`), and that
run's log is summarized and sent to the runner as an ended run's. Look at it, then remove it.
Nothing else to do, but:

- **Update the broker with the orchestrator** (the same release, as compose and the manifests
  do). An older broker refuses that call: the orchestrator asks again until it answers, and the
  restored runs' output is redacted of their tokens by their shape meanwhile.
- **Going back to an earlier release** loses the runs going then: it looks for their state in
  `logs/`, finds none, and closes their sandboxes' input. Roll back with no run going.

### Upgrading: the runs' summaries in the store (#618)

The dashboard's run history came from the runs' summaries in the orchestrator's volume
(`logs/<run>.json`). They are in its store now (`summaries/<run>`, [The store](#the-store)), so
a copy taking over on another node finds them there. Nothing to do: at its first start, the
orchestrator writes those left in `logs/` to its store, then removes them (`Run summaries: <n>
moved from /data/logs to the store` in its log), before the dashboard lists the runs: about a
second for 4,500 with the file store or Redis. A file that isn't a summary is logged (`Listing
the run of <file>: not a run's summary`) and left in `logs/`, out of the history, as it was
before; one the store didn't take stays for the next start, and so does a summary the store
refuses at a run's end (`logs/<run>.summary.json`, moved at the next start). The run logs left
there from before the runner service are moved as before.

### Upgrading: the paths from before the services are gone (#567)

The orchestrator no longer answers sandboxes: its broker port (8081) and the `listener` name are
gone, with what kept sandboxes, proxies and runs of earlier releases working. Sandboxes call the
broker, the github and the models service by their own names, through the egress proxy. What
changes for you:

- **Running sandboxes**: deploy only once none started by the earlier release still runs. One
  calls `http://listener:8081`, which nothing answers any more: its pushes, GitHub calls, agent
  calls and inbox fail. `docker ps --filter label=deckhand.run` on the server lists the running
  ones: wait for them to end (or `/cancel` them) first. On Kubernetes, the sandbox pods
  (`deckhand.role=sandbox`).
- **Kubernetes NetworkPolicy**: sandboxes may reach the egress proxy alone now. A policy that
  also lets them reach the orchestrator on 8081, as these docs said before, is refused, and no
  run starts until it names the proxy's port only ([kubernetes.md](kubernetes.md#what-the-manifests-set-up-and-why)). The
  orchestrator's Service named `listener` can go.
- **Settings no longer read**: `BROKER_URL` and `BROKER_PORT` (the orchestrator, the runner, the
  egress proxy), `RELAY_URL` (the egress proxy) and `RUNS_VOLUME`. Remove them from your `.env`,
  compose overrides or Deployments: they are ignored. The egress proxy's `BROKER_SERVICE_URL`,
  `GITHUB_SERVICE_URL` and `MODELS_SERVICE_URL` now default to compose's names, and its
  `POLICY_URL` to `http://orchestrator:8082/egress`.
- **The `runs` volume** (`deckhand-runs` by default) is no longer mounted: the runner keeps the
  runs' inboxes in its own (`runner-data`). Once no sandbox of the earlier release runs, remove
  it: `docker volume rm deckhand-runs`.
- **The listener's keys**: a `run-token.key` or `run-token.pub` left in the orchestrator's data
  volume is no longer read. Delete them.

### Upgrading: the orchestrator runs as `node` (#536)

The orchestrator ran as root, though it holds no Docker socket since the runner service (#503).
It now runs as the `node` user (uid 1000), with a read-only root filesystem and no capabilities,
as edge does. What changes for you:

- **Its volumes** (`data`, and the screenshots', `deckhand-screenshots` by default) were written
  as root: the orchestrator can't write them now, and refuses to start, listing what it can't
  write. Hand them over once, with the orchestrator stopped, instead of the usual update:

  ```sh
  docker compose pull
  docker compose stop orchestrator
  docker compose run --rm --no-deps --user root --cap-add CHOWN --entrypoint chown orchestrator -R 1000:1000 /data
  docker compose up -d
  ```

  - **Stop it first.** The orchestrator of the earlier release runs as root and saves its
    store every few seconds: left running, it makes `store/`'s files root's again right after
    the `chown`. The sandboxes keep running meanwhile, as in any update. If you already ran
    `docker compose up -d` and the new orchestrator refuses to start, the same four commands
    apply.
  - **The `chown`** runs a short container of the orchestrator's new image as root, with both
    volumes mounted (the screenshots' at `/data/shots`), and nothing else. It keeps the
    service's settings, so `--cap-add CHOWN` gives back the one capability `chown` needs:
    without it, root gets `Operation not permitted`. Keep `-R`: the files in the volume are
    root's too. The orchestrator checks the volume at start, so a file left behind is named
    rather than failing later, but for the screenshots themselves (`shots/<run>/`, not read
    at every start): one left root's fails only when it is served.

  New volumes are the `node` user's from the start.

- **On Kubernetes**, the orchestrator's pod refuses to start the same way on a claim the
  earlier release wrote. A rolling update would start the new pod beside the old one, still
  root, so: scale the orchestrator to 0, give its pod the security context in
  [kubernetes.md](kubernetes.md#what-the-manifests-set-up-and-why) (`fsGroup: 1000` hands its claims over as they are
  mounted, or a one-time `chown` init container where the storage ignores `fsGroup`), then
  update its image and scale it back.

- **Your server folder** (`config.yaml`, the grants folder and its `policy/`) is read as uid
  1000, as the policy service already reads it: the usual `0644` files and `0755` folders are.
  A `config.yaml` it can't read stops it at start, with `EACCES`.
- **The mount roots you grant** are resolved as uid 1000 too: a root, or a folder above it,
  that uid 1000 can't search makes every mount a repo asks for in it refused ("doesn't exist,
  or the listener can't see it"), not mounted. Make them searchable (`o+x` on the folders).

### Upgrading: the preview hook is gone (#574)

Deckhand no longer runs a repository's `preview.command` on its pull requests' events: the hook
held the host's Docker socket, so it was root on the host. What changes for you:

- **A `.deckhand.yaml` with `preview`**: its runs go on. The key is ignored, with a warning in
  the run's log and on the dashboard's config page (`preview: removed, ignored`); its
  maintainers can remove it. It no longer stops runs, nor auto-merge, nor a run on the
  Kubernetes runner.
- **The grants `preview` and `acknowledge_automerge_and_preview_is_highly_dangerous`** are no
  longer asked of your policies: a rule that still names them grants nothing, and is harmless.
  Remove them from `policy/` when you next edit it. The old YAML keys `allow_preview` and
  `acknowledge_automerge_and_preview_is_highly_dangerous` still load, ignored, with a warning
  in the orchestrator's log at start.
- **The runner's `previews/` folder**, in its volume (`runner-data`), is no longer written: the
  hooks' logs were there. You can delete it.
- **`DOCKER_SOCKET`** now only says where compose mounts the host's socket into the runner:
  nothing mounts it into another container.
- **To deploy previews**, add a webhook to the repository (or to an App of your own) for its
  `pull_request` events (and `workflow_run`, to deploy once CI has passed), pointed at a small
  HTTPS server of yours that checks the webhook's secret and deploys
  ([Preview deployments](repo-config.md#preview-deployments)). It gets what the hook got, with
  only the access you give it.

### Upgrading: the runner network's subnet (#543)

The `runner` network, between the orchestrator and the runner, took `172.31.253.0/24` by
default, inside Docker's default address pools, where it could clash with another network on
the host. Its default is `10.231.250.48/28` now. Only a deployment that followed `edge` while the
runner service had the old default (#530 to #543, no release) created the network on it. Compose
doesn't always move it to the new subnet:

- **Created by Compose 2.31 or later**: `docker compose up -d` sees that it changed, stops the
  orchestrator and the runner, recreates the network on the new subnet, and starts them again.
- **Created by an earlier Compose**: the network carries no hash of its settings, so every
  Compose, 2.31 and 5 included, keeps it as it is. It stays on `172.31.253.0/24` while the
  orchestrator's and the runner's `SERVICE_NETWORKS` name the new subnet, so they refuse each
  other's calls and no run starts.

Either keep the old subnet, where it doesn't clash on your host: `RUNNER_SUBNET=172.31.253.0/24`
in `.env`. Or take the new one once, whatever Compose's version: `docker compose down`, then
`docker compose up -d` (`down` removes the project's networks, not its volumes; the sandboxes
keep running, as in any update). `docker network inspect <project>_runner` shows the subnet the
network has.

### Upgrading the grants (#498)

The yes-or-no grants left the grants folder's YAML for your policies: each old key in
`default.yaml` or `<owner>/<repo>.yaml` is now an error, which stops that repository's runs (or
every run, in `default.yaml`) until you move it. Its message gives the rule to write. Write one
`allow_grant` rule per set of repositories in the grants folder's `policy/`
([the grants](security.md#the-grants)), then remove the keys:

| Old key (grants YAML) | Grant (`input.grant`) |
| `allow_dockerfile: true` | `dockerfile` |
| `allow_branch_docker_images: true` | `branch_docker_images` |
| `allow_docker: true` | `docker` (one repository at a time) |
| `allow_research: true` | `research` |
| `allow_workflows: true` | `workflows` (one repository at a time) |
| `allow_auto_merge: true` | `auto_merge` (one repository at a time) |
| `allow_auto_merge: public` | `auto_merge_public` (one repository at a time) |
| any of them `: false` | none: remove the key |
| `allow_preview`, `acknowledge_automerge_and_preview_is_highly_dangerous` | none: the preview hook is gone ([#574](#upgrading-the-preview-hook-is-gone-574)), remove them |

```yaml
# server/grants/acme/api.yaml, before
hosts: [pypi.org]
allow_dockerfile: true
allow_docker: true
```

```rego
# server/grants/policy/grants.rego, after (and hosts: [pypi.org] alone in acme/api.yaml)
package deckhand

allow_grant if {
  input.repo.name == "acme/api"
  input.grant in {"dockerfile", "docker"}
}
```

`input.repo.name` is lower case. A `true` key of `default.yaml` becomes a rule without
`input.repo.name`, for the grants that may go to every repository (`dockerfile`,
`branch_docker_images`, `research`); the others were never valid there. A `false` key
granted nothing, and nothing is granted by default now: remove it, never write a rule for it. In
a repository's own file, where it kept a grant of `default.yaml`'s from that repository, write a
`deny_grant` rule naming it instead, if a rule of yours grants it to every repository. Each
key's error says which applies. `hosts`, `cached_hosts`, `mounts`, `limits` and
`allow_projects` stay in the YAML. The runner now asks the policy service too: take the new
`compose.yaml` (or add an internal `policy-runner` network to your `runner` and `policy`
services).

A repository's `.deckhand.yaml` mode with `light: true` is an error too (`light: false` a
warning): its runs get what its policies give them now ([Modes](repo-config.md#modes)), and
Deckhand's `mode-work.rego` gives every repository mode work's writes as the ceiling. Its
maintainers remove it, and in `.deckhand/policy/` give the mode an `allow_capabilities` rule
without `push`, and `allow_github` and `allow_push` rules that leave it out: a rule on
`input.custom_mode` alone now gives a former comment-only mode work's writes (issues, pull
requests, labels, sub-issues). Such a mode's runs, without `push`, still move no project item and
set no needs-input label when they stop to ask, as before. What is decided before a run's
capabilities treats every repository mode as work now: its runs queue in work's order rather
than before work runs, a comment in it takes the issue's needs-input label off, and
`wait_for_answers` holds it back.

`light` is gone from every policy input too (`allow_run`, `allow_github`, `allow_push`,
`allow_link_branch`, `allow_request_review`): a rule reading `input.light`, yours or a
repository's, now sees it undefined without an error (`deny_… if input.light` denies nothing,
`not input.light` holds for every run). The config check warns of each file that reads it;
rewrite it on `input.mode`, or on what `allow_capabilities` gives.

### Two copies

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
reaches the one acting. Copies on several nodes need Redis ([The store](#the-store)).

## The github service

The github service (`github/`, its own image) is the only one holding the GitHub App's key and
its installation tokens: the orchestrator's GitHub calls (replies, labels, reviews, the
dashboard's data), edge's (`/setup`'s conversion of the App's manifest, the redeliveries), the sandboxes' (relayed by the egress proxy: [How sandboxes reach
GitHub](#how-sandboxes-reach-github)) and the runner's tarballs all go through it, each caller
reaching it over an internal network of its own, which it tells them apart by
(`SERVICE_NETWORKS`). Its key is in the `github-key` volume, which no other service mounts: back
it up. Two copies may run side by side on one store (Redis, [The store](#the-store)): a run's
state, its calls in flight and the idempotency keys are there, each copy's installation tokens
and git mirrors its own cache. Pushes of repositories granted `workflows` are saved in its
`/tmp` while checked (up to 2 GiB each, one per run): a size-limited tmpfs keeps them off the
host disk (`tmpfs` in `compose.yaml`, commented out).

## The broker service

The broker (`broker/`, its own image) is the only service holding the key that signs the runs'
tokens and the services' own: edge, the orchestrator, the runner and the egress proxy check them
with its public keys alone. It also keeps the live runs, their inbox, CA and digest in its store,
and their screenshots in blob storage (`BLOB_URL`, else its store too), which edge serves from it
(the `broker-store` volume), and serves what a sandbox calls about its own run, through the
egress proxy: its token's renewal, its inbox, its files. Its key is in the `broker-keys`
volume, which no other service mounts: back it up with the orchestrator's `data` volume.

The orchestrator, edge, the proxy and the runner each reach it over an internal network of their
own (`broker-orchestrator`, `broker-edge`, `broker-proxy`, `broker-runner`), and it tells them
apart by that network (`SERVICE_NETWORKS`): their subnets are fixed in `compose.yaml`,
`10.231.250.0/28`, `10.231.250.208/28`, `10.231.250.16/28` and `10.231.250.32/28`; set
`BROKER_ORCHESTRATOR_SUBNET`, `BROKER_EDGE_SUBNET`, `BROKER_PROXY_SUBNET` and
`BROKER_RUNNER_SUBNET` in `.env` if the host already uses them. The models service and the
github service have theirs, `broker-models` (`BROKER_MODELS_SUBNET`, `10.231.250.64/28`) and
`broker-github` (`BROKER_GITHUB_SUBNET`, `10.231.250.176/28`). Each of the orchestrator's calls
but a GET carries its lease's epoch, and the broker refuses one older than the newest it has
seen ([Two copies](#two-copies)).

## The models service

The models service (`models/`, its own image) is the only one holding your agents' credentials:
the keys and tokens in `.env` (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) go to its
environment, and the plans' logins in [the credentials folder](#the-credentials-folder) are
mounted there, read only. The sandboxes' agents call their APIs through it, by the egress proxy,
which sends it their calls (`MODELS_SERVICE_URL`); the orchestrator asks it which credentials it
holds, by name, before it reads its own settings (it waits for it at start), and never sees
their values. The providers' addresses (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
`GEMINI_BASE_URL`, `OPENROUTER_BASE_URL`) are its settings too, in `.env` or `config.yaml`.

The plans' refreshed logins are in its store (the `models-store` volume, or Redis with
`STORE_URL`), sealed with a key made on its first start, `models.key` in the `models-keys`
volume (`KEY_DIR`), which no other service mounts: back up both. A store or a key the service
can't read its logins from (the volume lost, a new `models.key`, `STORE_URL` moved to Redis)
starts each plan again from its file, which it never writes: the ChatGPT plan's refresh token in
it was spent by the first refresh, so **sign in again** (`codex login`, [With a ChatGPT
plan](#with-a-chatgpt-plan)) when you change either; the Google AI plan's may still work, or
needs a new sign-in too. Two copies may run side by side on one store (Kubernetes): a login is
refreshed by one of them at a time. **Every copy must mount the same `models.key`** (one volume,
or one Kubernetes Secret holding the file, never one per pod): a copy whose key isn't the one a
login was sealed with refuses it, saying so in its log and in runs' errors, rather than replace
the other copy's refreshed login with the file's spent one. Its fingerprints' salt comes from the
key too, so copies with one key give the orchestrator one set.

The proxy and the orchestrator each reach it over an internal network of their own
(`models-proxy`, `models-orchestrator`), and it tells them apart by that network
(`SERVICE_NETWORKS`, `10.231.250.80/28` and `10.231.250.96/28`: `MODELS_PROXY_SUBNET` and
`MODELS_ORCHESTRATOR_SUBNET` in `.env` if the host already uses them); it reaches the broker
over `broker-models` (`BROKER_MODELS_SUBNET`, `10.231.250.64/28`) and the runner, which runs the
Antigravity login's refresh, over `runner-models` (`RUNNER_MODELS_SUBNET`, `10.231.250.112/28`).
On Kubernetes, `SERVICE_NETWORKS=none`: NetworkPolicies and the pods' service accounts tell
callers apart there.

Stopping it lets the agents' calls in flight finish, for up to 10 minutes (`DRAIN_SECONDS`,
600; compose's `stop_grace_period` is 630 s): an update waits for the turns going, and new calls
wait at the proxy, 5 minutes at most ([services](services.md#the-models-service)).

## Kubernetes runner

With `RUNNER=kubernetes`, each run's sandbox is a pod of the cluster the runner service runs
in, rather than a container of the host's Docker. `deploy/kubernetes/` has the manifests (a
kustomize base, with components for Redis and BuildKit), and [kubernetes.md](kubernetes.md)
takes you from an empty cluster to a first run: the requirements (a network plugin that enforces
NetworkPolicies, a storage class, the kubelet's settings), installing, updating, and what the
manifests set up and why.

## The store

Deckhand's services ([services.md](services.md)) keep their state in a store, which each one's
`STORE_URL` names. The broker service keeps its live runs, their files and events there
([The broker service](#the-broker-service)); the runner the runs' logs and events and its lease;
the orchestrator its queue, its lease and its fencing epoch, and the state that holds data alone
(the titles, closed states and pull requests the dashboard shows, the dismissals, the run order,
the onboarded repositories, the lanes' names, the issues' modes, the rebase attempts, the last
dry runs, the reviewers requested) and the runs' summaries, one key per item, so that a change
writes only what changed (the rest of its state in `/data`, for now: #613);
edge the deliveries it took, the sessions' epochs and the deliveries' stream the orchestrator
reads.

- **`file:///data/store`**, a folder in the service's volume: on Docker Compose, and on one
  node. Several processes on that node may share it (two copies of a service, or one starting
  while the last drains): each call holds the folder's lock (`state.lock`, taken over once 10 s
  stale) and reads again what another process wrote. Calls made at once (a burst of
  writes) share one lock and one write of its `state.json`.
- **`redis://[user:password@]host:6379[/db]`**, or **`rediss://`** over TLS: on several nodes
  (a k3s cluster with more than one), where two copies of a service run on different nodes and
  a ReadWriteOnce volume can't be on both. `?prefix=` changes what goes before every key
  (`deckhand:`), for two deployments sharing one Redis. `REDIS_PASSWORD` gives the password
  when it isn't in the URL (from a Kubernetes Secret, say). With `rediss://`, Redis's
  certificate is checked against Node's CAs: a private one (a cluster's own, a self-signed
  certificate) is trusted through `NODE_EXTRA_CA_CERTS`, the path of its PEM file.

The Redis backend speaks to Redis 7 or later (or Valkey) by itself, without a package. Its
leases and keys expire on Redis's clock, so copies on nodes whose clocks drift agree. Each
call is one Lua script, so Redis Cluster isn't supported: run a single primary, with a replica
if you want one. Configure it as follows (`redis.conf`, or the server's arguments):

```conf
# Kept on disk: the keys and the streams' events must outlive a restart of Redis. With
# everysec, a crash loses at most the last second. A lease's epoch is at least Redis's time in
# ms, so a lost write, or a failover to a replica behind (its clock in sync, NTP), never hands
# one out twice.
appendonly yes
appendfsync everysec
# Never evict: an evicted key or event would be lost.
maxmemory-policy noeviction
# No other network than the services' own, and a user allowed the store's commands and keys
# only (those its scripts call included: Redis checks them too). REDIS_PASSWORD, with
# redis://deckhand@redis:6379 as STORE_URL.
user default off
user deckhand on ><a long random password> ~deckhand:* resetchannels -@all +evalsha +eval +time +exists +scan +hmget +hset +del +pexpireat +incr +xadd +xgroup|create +xreadgroup +xack +xdel +xinfo|groups +getrange +strlen +set +append +select +ping +quit
```

The user's key pattern follows the prefix: with `?prefix=team-a:`, it is `~team-a:*`, else
every call is refused with `NOPERM`. `+scan` lists a prefix's keys (a map kept one key per
item, read back whole when a copy takes over): Redis's ACL doesn't hold `SCAN` to the key
pattern, so a user can list the names of other users' keys (never read their values). Give a
deployment that mustn't see another's key names a Redis of its own. `requirepass <a long random password>` (the `default`
user) works too, but leaves it every
command, `FLUSHALL` and `CONFIG` included. A call Redis doesn't answer within 5 seconds fails,
and the next one connects again: a copy that loses Redis learns in time that it can't renew
its lease.

On Kubernetes, `deploy/kubernetes/`'s `redis` component runs it this way, one user per service
([kubernetes.md](kubernetes.md#several-nodes)).

**What the run history takes in it**: the orchestrator keeps each run's summary in its store
(`summaries/<run>`, what the dashboard's history is rebuilt from), until `LOG_RETENTION_DAYS`
(90 by default) removes it with the run's log. A summary is a few KB: the run's details, its
final answer's first lines and the text of the comments it acted on (more for a long comment).
So they take about a summary's size times the runs of those days: 50 runs a day for 90 days are
4,500 summaries, some 20 MB of Redis's memory at 4 KB each. With `0` (forever), they grow with
every run. With the file store, each is a file of its own in its folder (`keys/`), out of its
`state.json`, which every lease renewal (each 5 s) writes whole. Each item of the
orchestrator's maps (a title, a pull request, a lane) is a file of its own there too, so that
changing one writes its file alone ([#691](#upgrading-the-maps-items-a-file-each-691)).

Secrets never go in the store: the App's key, the signing key and the agents' credentials
stay in their service's own secret or volume. A write holding one the service knows, a
private key or a GitHub token is refused in a value or an event (`lib/store.mjs`,
`withoutSecrets()`): with Redis, every service using it could read it otherwise. In a blob (a
run's log, its files), the secrets and GitHub tokens are redacted instead.

## Blob storage

The runner and the broker keep blobs: the runs' logs, a run's files and screenshots. Without
more, they keep them in their store, which with `file://` is disk. With `redis://` it is
Redis's memory, which a run history doesn't fit in for long: each of them then says so at start,
in its log and on the dashboard's status page (Settings › Server). **Blob storage** is a
second place for what will never change again, which each one's `BLOB_URL` names.

**When you need it**: with Redis as the store ([The store](#the-store)), so that the logs and
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

### What a server needs

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

### Garage with Docker Compose

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

### Garage on its own

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

### Amazon S3

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

### A server outside Compose

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

## Container engine

A sandbox has no Docker: it never gets the host's socket, and its hardening (uid 1000, no
capabilities, `no-new-privileges`) rules out running an engine inside it. A repository whose
runs need to build and run images (to check its Dockerfiles, say) can get a **container
engine** instead: a second container the runner starts next to each of its work runs'
sandboxes, on the run's own network, and removes with it. The sandbox gets the `docker` CLI
(with buildx and compose) and `DOCKER_HOST=tcp://engine:2375`; containers it starts with a
published port answer at `engine:<port>`. Nothing in the engine touches the host's Docker,
and it reaches the outside only through the egress proxy, under the run's hosts.

Three steps, all off by default:

1. **Pick a backend**, `SANDBOX_ENGINE` in `.env` or `sandbox_engine` in `config.yaml`:
   - `sysbox` (recommended): `dockerd` under the [Sysbox](https://github.com/nestybox/sysbox)
     runtime, which maps root in the engine to an unprivileged user on the host: no
     `--privileged`, no relaxed seccomp or AppArmor. Linux hosts only (not Docker Desktop):
     install Sysbox from its releases (a `.deb` for Debian and Ubuntu, which restarts Docker),
     then check that `docker info` lists the `sysbox-runc` runtime. Without that runtime,
     runs that would get an engine fail with a reply saying so.
   - `podman`: rootless Podman serving Docker's API. Nothing to install, but the engine runs
     with seccomp and AppArmor unconfined, `/dev/fuse` and `/dev/net/tun`, and Docker's
     default capabilities, which expose more of the host's kernel (see
     [Security model](security.md#container-engine)). `docker build` uses the classic
     builder there (`DOCKER_BUILDKIT=0`), and some compose features differ.
   - `auto`: Sysbox where `docker info` lists its runtime, else Podman.
2. **Pull its image**: `COMPOSE_PROFILES=engine` in `.env`, then `docker compose pull` (or
   `up -d --build`) pulls or builds both engine images, `deckhand-engine` and
   `deckhand-engine-podman`, the way the `sandbox` service does the base image.
3. **Grant it per repository**: `docker`, in an `allow_grant` rule of your policies that names
   the repository (`grants/policy/grants.rego`, [the grants](security.md#the-grants): a rule
   for every repository grants it to none), and the repository asks for it with `docker: true` in its
   `.deckhand.yaml` ([Per-repo config](repo-config.md#container-engine)). Add the registries
   it pulls from to `hosts` in its grants file: Docker Hub is
   `registry-1.docker.io`, `auth.docker.io` and `production.cloudflare.docker.com`; GHCR is
   `ghcr.io` and `pkg-containers.githubusercontent.com` (already allowed). A pull from any
   other registry fails at the proxy.

The engine has the repository's limits (its grant's, else the built-in ones) on top of the
sandbox's, and its storage is a volume of the run's own, removed with it. A repository can
keep that storage between its runs instead (`docker: { cache: true }`): one volume per
repository and backend, `deckhand-engine-cache-<repo>-…-<backend>`, which you remove by hand
to reclaim the space. Runs from a fork's pull request never get an engine, nor runs the
policies don't give the `docker` capability (with Deckhand's defaults, all but work runs and a
repository's own modes: brainstorms, inbox entries…).

To check it on your host: grant a repository, comment on one of its issues asking to
`docker build` its Dockerfile, `docker run` the image with a published port and `curl
engine:<port>`, and `docker compose up` its stack; the run's log on the dashboard starts with
`Container engine: sysbox, fresh storage`. Then `docker ps -a --filter label=deckhand.engine`
and `docker volume ls --filter label=deckhand.engine` are empty once the run is over.

On Kubernetes, the engine is Sysbox's alone, in the sandbox's pod: see
[Container engine on Kubernetes](kubernetes.md#container-engine-on-kubernetes).

## Download cache

Every run downloads its packages again: `apt-get`, `apk add`, `npm ci`, `pip install`, a
toolchain's archive. A repository's `caches` volumes and `docker: { cache: true }` keep
some of that for that repository only. The egress proxy can keep it for every run instead,
for the hosts you list:

```yaml
# server/grants/default.yaml (or grants/<owner>/<repo>.yaml, for one repository)
hosts: [registry.npmjs.org, files.pythonhosted.org, pypi.org]
cached_hosts: [deb.debian.org, dl-cdn.alpinelinux.org, registry.npmjs.org, files.pythonhosted.org]
```

- **Which hosts**: only the grants folder lists them, like `hosts`; a repository's
  `.deckhand.yaml` can't. A cached host must be reachable too (in `hosts`, or mandatory):
  `cached_hosts` alone opens nothing. List public mirrors whose files are the same for
  everyone, not APIs.
- **What is never kept**: a request with a body, `Cookie`, `Range` or a credential-like
  header (`Authorization`, `Private-Token`, `X-Api-Key`…), anything but a `GET` answered
  `200`, and an answer marked `Cache-Control: private` or `no-store`, or larger than `EGRESS_CACHE_ENTRY_MAX` (1 GB). Those go through as before. Cookies an answer
  sets reach that client only. Answers are kept as long as the host says they are fresh,
  then checked again with it.
- **When**: a run's cached hosts are fixed when it starts, from the grants then: a change
  applies to the next runs, not to those already running.
- **Size**: one cache for every repository, in the `egress` service's `egress-cache` volume
  (`deckhand_egress-cache` with compose's default project name), at most `EGRESS_CACHE_MAX`
  (10 GB by default): beyond it, the least recently used answers go. Set it in the `egress`
  service's `environment` ([Advanced settings](#advanced-settings)); `0` turns the cache off.
- **HTTPS**: the proxy decrypts the HTTPS of cached hosts, and only theirs, with a CA it
  makes on its first start and keeps in that volume (`ca/`). Each run whose grant has
  cached hosts trusts that CA (its key never leaves the volume). The agent's hosts and
  GitHub's are never decrypted, and nor are a container engine's connections, which only
  get plain HTTP cached. Removing the volume, or `ca/` in it, and restarting the proxy makes
  a new CA, which the next runs get.

What this implies (the proxy reads cached hosts' traffic, and holds a key sandboxes trust),
and the rules in full: [The egress cache](security.md#the-egress-cache) in the security
model.

To check it: `docker compose logs egress` says `cache on, HTTPS too` at start. Ask two runs
of a repository with a cached host to fetch the same file from it with a `GET` (`curl -s -o
/dev/null -D - https://<host>/<file>`; `curl -I` isn't cached): the second answer says
`x-deckhand-cache: hit`. A run whose grant has cached hosts while the proxy's cache is off
says so in its log on the dashboard (`Egress cache: off for this run`), and
reaches those hosts as before, through a tunnel.

## How sandboxes reach GitHub

No sandbox gets a GitHub token, an SSH key or the host's git configuration:

- Each run gets a run token, bound to its sandbox and renewed while the run lasts.
- Its git credential helper and `gh` wrapper (`GH_TOKEN`) hand out that token in place of a
  GitHub token. The egress proxy relays every call to GitHub (`GITHUB_URL`'s and `GITHUB_API`'s
  hosts) to the github service's GitHub gateway (never reached from a run's network but through
  the proxy, which vouches for the sandbox's network there), which sends it on with an
  installation token limited to the run's repository,
  which the sandbox never sees, and redacts secrets from what it writes (see
  [The GitHub gateway](security.md#the-github-gateway)). A run's token only reads: contents,
  issues, pull requests, actions, checks, commit statuses and metadata (discussion runs their
  discussions too). Each write the gateway checked and the policies allowed gets a token of its
  own, with only the write permission it needs (`issues: write` for a comment, `pull_requests:
write` to open or edit a pull request…): see [Tokens](security.md#tokens). Installation tokens last an hour; the gateway renews them before
  that, so a run can go on for hours. Every run but a research one trusts the egress
  proxy's CA, which certifies GitHub's hosts for the relay.
- Git fetches from GitHub over HTTPS through the GitHub gateway, and pushes through the github
  service's git gateway (to `http://github:8080`, the name the proxy sends there, with the run
  token), which pushes the run's own branch only (its
  issue's `issue-<n>-*`, or its pull request's head), never the default one, with a token of
  its own (see [Security model](security.md#the-default-branch)): contents only, and
  workflows too for a repository granted `workflows`. A run's
  `gh pr create`, `edit` and `ready` go through the GitHub gateway like its other calls, for
  its own pull requests only, with a token that writes them for that one checked call: no
  other call's token writes pull requests. Commits
  and comments come from the App's bot (`<app>[bot]`, identity set through `GIT_AUTHOR_*`
  and `GIT_COMMITTER_*`).

The branches and pull requests a sandbox pushes run the repository's GitHub Actions like
anyone's, with its secrets and a `GITHUB_TOKEN`. Before installing the App on a repository,
set its default workflow permissions to read-only and keep deploy secrets behind
environments with required reviewers: see
[GitHub Actions on Deckhand's branches](security.md#github-actions-on-deckhands-branches).

Nor does a sandbox get your Claude credential. Its Claude Code calls the broker's address
(`ANTHROPIC_BASE_URL=<broker>/anthropic`, which the egress proxy sends to the models service)
with the run's agent token where the credential would be; the models service checks the token,
puts your credential in its place and forwards the call

to Anthropic, streaming the answer back (see [Security model](security.md#tokens)). Codex
does the same with `OPENAI_BASE_URL=<broker>/openai` and your `OPENAI_API_KEY`, and the
Antigravity CLI with `GOOGLE_GEMINI_BASE_URL=<broker>/google` and your `GEMINI_API_KEY`, or
through the egress proxy with a Google AI plan's login (see
[Antigravity CLI](#antigravity-cli)).

No agent is part of any image: before the first run that needs it, the runner installs the
pinned `CLAUDE_CODE_VERSION` into the `deckhand-claude-code` volume (Codex: `CODEX_VERSION`,
`deckhand-codex`; the Antigravity CLI: `AGY_VERSION`, `deckhand-antigravity`, its release's
tarball checked against the sha256 `AGY_SHA256` pins), in a container of its own, and later
runs reuse it, read-only. npm packages install with `--ignore-scripts`; only the agent's own
package then runs its install script (Claude Code's puts its native binary in place), never a
dependency's.

## Isolation

Sandboxes run without capabilities and with CPU, memory and pids limits, get no host path
unless you grant one, and reach only Anthropic, GitHub and the hosts you grant in the grants
folder, through the egress proxy. A [container engine](#container-engine), when you grant one,
runs next to the sandbox rather than in it. See [Security model](security.md): the grants folder, host
mounts, the mandatory hosts, and what isn't covered.

Upgrading from a version with a single grants file (`GRANTS_FILE`, `grants.yaml`): the
orchestrator reads a folder now, `GRANTS_DIR`, and refuses to start while `GRANTS_FILE` is set.
Move each `owner/repo:` entry to its own file, `owner/repo.yaml`, with its keys one level
up; `"*"` becomes `default.yaml`. Then mount the folder instead of the file
(`server/grants/`, see [the server folder](#the-server-folder)) and remove `GRANTS_FILE`. For example:

```yaml
# grants.yaml, before
acme/api:
  hosts: [pypi.org]
```

```yaml
# server/grants/acme/api.yaml, after
hosts: [pypi.org]
```

Upgrading from a version where a repository's `.deckhand.yaml` alone decided its Dockerfile
and branch images: grant them in your policies, for each repository that uses them (or every
one: a rule without `input.repo.name`), with `dockerfile` and `branch_docker_images`
([Upgrading the grants](#upgrading-the-grants-498)). Until then that repository's runs stop
with a reply naming the missing grant (the orchestrator's logs say why), and `allow_branch_docker_images` in its `.deckhand.yaml` is
ignored with a warning in the run's log.

Upgrading from a version with `ALLOWED_HOSTS` or `SANDBOX_CPUS`, `SANDBOX_MEMORY`,
`SANDBOX_PIDS`: what every sandbox gets is in the grants folder now, read at each run, and
the orchestrator refuses to start while any of them is set (in `.env` or `config.yaml`, where
`allowed_hosts: []` counts too). Move them to `grants/default.yaml`, then remove them:

```sh
# .env, before
ALLOWED_HOSTS=registry.npmjs.org,*.pypi.org
SANDBOX_MEMORY=8g
```

```yaml
# server/grants/default.yaml, after
hosts: [registry.npmjs.org, "*.pypi.org"]
limits: { memory: 8g }
```

Upgrading from a version where a repository's `.deckhand.yaml` could add `hosts`: only the
grants folder lists hosts now (see
[Where a sandbox's hosts come from](security.md#where-a-sandboxs-hosts-come-from)). A
repository's `hosts` are ignored with a warning, and a grants file still saying
`allow_repo_hosts` has an error that stops that repository's runs (or every run, in
`default.yaml`) until you remove it. Copy the hosts those repositories listed into their
grants file, `hosts: [...]` in `grants/<owner>/<repo>.yaml`, then remove `allow_repo_hosts`.
