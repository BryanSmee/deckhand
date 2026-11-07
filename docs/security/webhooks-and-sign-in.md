# Webhooks and sign-in

What reaches Deckhand from outside (GitHub's deliveries, the dashboard, MCP clients, machines) and who may do what once in. Part of the [Security overview](../security.md).

## Edge

The internet reaches one service only: **edge** (`edge/`, #506, [services.md](../services.md)).
Compose publishes its port (`PORT`, 8080) on `edge-out`, a network of its own. It serves GitHub's
webhooks (`POST /webhook`), /setup, sign-in and sessions (`listener/auth.mjs`; MCP clients' too,
[MCP clients](#mcp-clients)), the dashboard's
files and `/health`, and passes the rest on to the orchestrator. It holds three secrets and
nothing else: the webhook secret, the session key and the OAuth client's (its id and secret), in
its own volume (`edge-data`, [Edge's and the orchestrator's data](services.md#edges-and-the-orchestrators-data)).
No App key, no agent credential, no Docker socket: a hole in edge can sign deliveries and
sessions, not act as the App or start a sandbox. It runs as `node`, on a read-only root
filesystem, without capabilities.

- **Webhooks.** Until its signature can be checked, a delivery is read in one of a few capped
  places (16, 4 per source address, 5 MB, 10 seconds: `listener/deliveries.mjs`). Its HMAC
  (`X-Hub-Signature-256`) is checked with a constant-time comparison (`listener/events.mjs`
  `verified()`): none, or a wrong one, gets `401`. A verified delivery is **taken once, by its
  GUID** (`X-GitHub-Delivery`), set-if-absent in edge's store (`deliveries/<guid>`, kept a day:
  a redelivery of one taken comes within it), which both copies share: one GitHub sends twice, or that reaches
  both copies, goes on once. It goes on the `deliveries` stream in that store, with the secrets
  edge holds redacted from what people wrote (`storable()`), and only then is answered `202`.
  Once the orchestrator acknowledges it, it goes from the stream, its payload with it (the file
  store rewrites the stream's file once it holds 100 lines of them). `check_suite` and `status`
  deliveries (`QUIET_EVENTS`, which only tell the dashboard a commit's CI changed) are the
  exception: kept to their installation, repository and commit (`quietPayload()`), only for
  the repos `ALLOWED_REPOS` lets through (edge reads it too), they go on without their GUID,
  at most one per commit waiting for the orchestrator (`ci-waiting/<repo>@<sha>`, set-if-absent,
  cleared when the orchestrator reads that entry, kept 10 minutes at most: `edge/internal.mjs`),
  so a busy installation's statuses never crowd out the deliveries that start runs.
  The store away: `503`, its GUID freed, and GitHub marks it failed for the redeliveries to ask
  again. Their poller (the App's one write, `POST /as-app/app/hook/deliveries/:id/attempts` at
  the github service, edge's alone) runs on one copy, the holder of the store's lease
  `edge/redeliveries`.
- **What it passes on** (`edge/forward.mjs`): the dashboard's API (`/api/*`, the live logs
  included) and `/status`, to the orchestrator's services port
  under `/edge/…`, with edge's service token and the signed-in user's login in `x-deckhand-user`
  (or `x-deckhand-local: 1` for a `/status` call from inside edge's container). Edge builds
  those headers itself: of the browser's request, only `content-type`, `accept` and
  `last-event-id` go on, never its cookies nor an `x-deckhand-user` it sent; its Host and Origin
  go as `x-deckhand-host` and `x-deckhand-origin`, so that the orchestrator's same-origin check
  reads what the browser sent. The orchestrator takes the user header from edge's service token
  alone, arriving on `edge-orchestrator` (`listener/services-http.mjs`: `/edge/*` names edge
  only): a browser can't reach the orchestrator, and what it sends edge says nothing of who it
  is, edge's sign-in does. The dashboard stays on edge's origin, with the same CSP and
  `SameSite` cookie. An orchestrator away (handing over to its other copy) is waited for up to
  15 seconds, then `503`.
- **Its internal port** (`INTERNAL_PORT`, 8083, `edge/internal.mjs`) is the orchestrator's alone
  (its service token, from `edge-orchestrator`), never on the published one: the deliveries'
  stream (`GET /events`, `POST /events/ack`), the App's public parts (`GET /app`: its id, slug,
  owner, URLs and bot's id, never a secret), a redeliveries' scan (the dashboard's Sync), and
  the tags of the dashboard's "From the dashboard by @user" lines (`POST /from-tags`). Those
  tags are signed with a key derived from the webhook secret: the orchestrator posts the lines
  and holds no key, and a run, which posts as the App too, can't write a line that shows as a
  user's. A compromised orchestrator can still have edge tag any text as any user's, as it can
  post any comment through the github service.
- **Sessions** ([The dashboard](#the-dashboard)) are signed with the session key; each login's
  epoch is in edge's store (`sessions/<login>`), so a sign-out on either copy ends that login's
  sessions on both.

Two copies may run, both active on one store; a rolling update starts the new one, then the old
one drains (`DRAIN_SECONDS`, 25 seconds) and hands the poller's lease to the other.

## Who reaches a session

A comment reaches Claude when its author is in `ALLOWED_USERS` and the repository's own
`users`, and has the `runs:start:<mode>` [action](#access) for the mode it resolves to
(`runs:manage` for `/cancel`), and those are checked again later, not only when it arrives:

- a comment queued when the orchestrator stops (or crashes) keeps its author in the queue, saved
  in the store as it comes (`store/state.json`): the next orchestrator (or the copy waiting for
  its lease) drops it (and takes its 👀 off) when its author or repository is no longer
  allowed;
- every queued comment is checked again against the repository's `users`, read from its
  default branch, when its run begins (or, for a run still going after a restart, before it
  reaches that run): a `.deckhand.yaml` that removes a user while their comment waits out
  the pause, or behind a busy repository, stops it;
- a comment that waits for other issues (`/after`) is checked again when it starts;
- its author's access is asked again before queued work runs: a refusal drops it, a decision
  that fails (the policy service away) keeps it for the next try.

A comment on a pull request goes on in the session of the issue the pull request closes
(`Closes #12` in its description) only when the pull request's head branch is in the
repository, as for the branches a run may push: anyone can open a pull request from a fork
saying `Closes #12`, and an allowed user's comment on it would otherwise go on in issue 12's
session. An issue comment's payload doesn't have the head: the orchestrator trusts the App's own
pull requests (`<slug>[bot]`, Claude's) and looks the others up, whoever opened them
(another App, `github-actions[bot]`, a collaborator). Anything else is the pull request's
own task.

GitHub may send a delivery again (by hand from the App's settings, or after a timeout on its
side): edge takes each delivery id (`X-GitHub-Delivery`) once, in its store, for a day, across
restarts and for both its copies; and the orchestrator handles each once, a delivery it handled
whose acknowledgement was lost included ([Edge](#edge), [The orchestrator](services.md#the-orchestrator)).

### Auto-pickup

With `AUTO_PICKUP_SLOTS` set and a repository's `auto_pickup: true`, a label starts a run
with no comment: the orchestrator picks the open issues labelled `AUTO_PICKUP_LABEL` by itself
(`listener/auto-pickup.mjs`, [Auto-pickup](../guides/auto-pickup.md)). The label stands for an
allowed user's trigger comment, so the orchestrator checks what it would check of one, and what
it couldn't see of a label:

- the run is the work of whoever last added the label (the issue's `labeled` events): they
  must be in `ALLOWED_USERS` and the repository's `users`, read from its default branch right
  before the start, have `runs:start:work` ([access](#access)), and not be a bot. Anyone with triage access can add a label: one added by
  someone else starts nothing. When the label's last event the issue lists took it off (a
  picked run's), the labelling that put it back isn't listed yet: nothing starts until it is,
  rather than as the earlier labeller's;
- the label vouches for the issue as it was when it went on. A title changed (a `renamed`
  event) or a description edited (GraphQL's `userContentEdits`) after it, or in the same
  second, by anyone but an allowed user with `runs:start:work`, holds the issue: on a public repository, an
  outsider's issue rewritten once labelled would otherwise run as the labeller's. Every edit
  since the label counts, not only the last one (an allowed user's typo fix doesn't vouch for
  an outsider's rewrite before it). The issue's own last edit (`lastEditedAt`, `editor`) is
  checked too, and a history longer than the 100 edits read holds the issue when the edits
  not read may be since the label: GitHub doesn't document the order it lists them in, so
  either end of the history may be the one left out. Edits by the App's own bot count as
  anyone's (what a run writes may come from any comment): the label has to be added again;
- the run's policies see it as `trigger: "auto-pickup"` with the labeller as `sender`, and a
  `deny_run` rule can refuse it;
- the label comes off before the run is queued, so a run that fails or is refused isn't
  started again and again: a person adds it back. The App never adds it itself: its own
  `labeled` event would make it the labeller, which nothing starts for. An issue held by its
  labelling keeps the label, and the App's comment says why, once per labelling;
- one exception, opt-in (`review.follow_ups_auto_pickup`, #677): the follow-ups Deckhand
  files once a pull request is merged by an allowed user carry the label from their creation.
  The App's `labeled` event vouches for nothing by itself: the reviews' store keeps a record
  of each such issue (its number, the merger, the issue's creation time), and a labelling by
  the App counts only when it matches one, the same issue within two seconds
  (`followUpPick()`, `listener/reviews.mjs`). The run is then the merger's, checked against
  `ALLOWED_USERS`, `users` and `runs:start:work` at the pick as any labeller, and the edit check above starts
  from the label's time (the original GitHub lists for an edited description, the App's at
  the issue's creation, isn't an edit since; any later edit of the App's is). A merge by Deckhand itself (`review.merge`), a bot or anyone not
  allowed labels nothing. A run can't forge a record: it would have to file the issue
  through the orchestrator's own merge handling, not a write of its own.

## Access

Who may do what on which repository (#725), among the people Deckhand lets in at all. Three
gates, each narrowing the one before ([Access](../repo-config/policies.md#access) for the rules, the
actions and the roles):

- **`ALLOWED_USERS`, the outer gate**: who signs in to the dashboard, whose MCP clients get a
  token, whose comments reach Deckhand. A login outside it has nothing, whatever a policy says:
  no rule is asked for it.
- **The operator's `allow_access`**: the actions a login has on a repository (`tasks:read`,
  `logs:read`, `runs:start:<mode>`, `runs:manage`, `repo:config:read`) and server-wide
  (`server:read`, `server:sync`), from the policies of your layer alone: Deckhand's
  `access.rego` (every action to every login, the default) or the grants folder's
  `policy/access.rego` that replaces it, usually `bindings` of logins, repository patterns and a
  role (`access-roles.rego`). Only your layer allows: a repository's `allow_access` is ignored
  (a config check error).
- **What narrows it**: `deny_access` rules, yours (for every repository) and those of a
  repository's `.deckhand/policy/` (for its own), take actions away, and a deny always wins; a
  repository's `.deckhand.yaml` `users`, as the orchestrator last read them, leaves a login
  outside them nothing there. Both are read from the default branch, so whoever may push there
  can take access away on that repository, never give it: a repository can't give a login an
  action, nor reach another repository's access or the server-wide actions.

**Trust boundaries.** Access is decided from files only, yours and the repositories' default
branches, never from the dashboard (Settings › Access only shows it) nor from GitHub's roles: a
repository's admin on GitHub has no action in Deckhand that a rule doesn't give, and a login
given `runs:start:work` starts work on a repository whose GitHub permissions it doesn't have
(the run is the App's, as any). Teams aren't read: bindings name logins. The operator's files
are as sensitive as the grants: keep the grants folder in a reviewed repository
([The grants folder](policies.md#the-grants-folder)). The server-wide actions matter as much: `server:read`
shows the server's setup, the grants and who has what (Settings › Server, Settings › Access,
with each deny's reason), and `server:sync` asks GitHub for every repository's failed
deliveries again.

**Hidden repositories.** A repository where a login has no action at all is hidden from it
everywhere: the repositories list, the tasks, inboxes, lanes and blockers of `api/state`,
`/status`, the live logs and MCP clients' tools (`listener/mcp.mjs`). Its routes answer as one outside `ALLOWED_REPOS` (the same
404 and message), so a login can't tell a hidden repository from one that doesn't exist; a
blocker in a repository it doesn't see is "a hidden issue", its title never read for it.
Without `server:read`, the repositories list names only the installations of the accounts
owning a repository the login sees. Totals without names stay (running, queued, slots), of every repository.

**Fail closed.** An unknown login, a repository no rule names, a policy that doesn't compile or
errs, policies that can't be read and a policy service that can't be reached all give no action:
the repository is hidden, a comment starts nothing (and gets no reply), a repository's route
answers as one hidden (the 404 above, the log saying the decision failed), and a server-wide
route answers 503. A failure is never
mistaken for a refusal that sticks: queued work isn't dropped and an auto-pickup label isn't held
for one, they are asked again. So **the dashboard needs the policy service**, as the runs'
writes do: every decision first reads the operator's layer, which the orchestrator asks the
service for again once 30 seconds have passed (`DEFAULTS_MS`), whatever answer is kept, so a
policy service away hides every repository within about 30 seconds, until it is back. Deckhand's default
`access.rego` alone, with no repository policy, is decided without evaluating `opa`, but still
needs the service's listing of its policies. GitHub isn't needed the same way. A decision on a
repository reads what GitHub says of it (its default branch, whether it is private), kept 60
seconds, and lists its policy folder. When GitHub can't answer (no answer, a 5xx, a rate limit,
which a 403 may be too), the decision takes what GitHub last said and the last listing, up to an
hour old, as run decisions do, and the log says so: a short GitHub error refuses nothing. The github
service failing, or out of reach, counts as GitHub failing. Any other answer gives no action at
once, since its listing would read as no policy and drop its deny rules: a 404 (the repository
deleted, or out of the App's reach, which the github service passes on as GitHub said it, its
installation included), any other 403, or the github service's own refusal (no App yet). Such an
answer also forgets what GitHub said before and the last listing, so a hiccup right after it gives
no action either. A push forgets both, and so does a repository removed from the installation
(or out of an installation deleted or suspended), deleted, transferred, renamed or made private
(their `installation_repositories`, `installation` and `repository` deliveries), rather than
waiting for them to expire. A read of either sent before one of those and answered after it
answers that decision alone, never kept, and a hiccup on it gives no action: an answer from before
a repository was made private can't come back once it is forgotten. That holds for a renamed
repository asked by its old name too, when the delivery names the new one before GitHub's first
answer has told Deckhand they are the same repository. An orchestrator that hasn't
read them in that hour, since its start or since a push, gives no action.

**When a change holds.** An edit of your policy files holds at the next decision (the answers
are kept per digest of your files); a repository's own at the push to its default branch, which
forgets its listing; anything else a rule reads (whether GitHub says the repository is private)
once the kept answer is a minute old. A live log asks again each second and ends once
`logs:read` goes. Removing a login from `ALLOWED_USERS` (edge restarted) ends its sessions and
its MCP clients' tokens ([The dashboard](#the-dashboard), [MCP clients](#mcp-clients)).

**Upgrading changes nothing**: Deckhand's `access.rego` gives every allowed user every action,
server views included, as before access had rules; the repositories' `users` narrow as they did.
To narrow, see [Upgrading: access control (#725)](../guides/upgrade-notes.md#upgrading-access-control-725).

## The dashboard

Only `ALLOWED_USERS` sign in, and each sees what [access](#access) gives them. A repository's
tasks and runs need `tasks:read`, its live logs (whose tool output may hold what a run read)
`logs:read`, its config, grants and policies `repo:config:read`; a repository with no action is
hidden. `/status` lists the runs and queued comments of the repositories with `tasks:read`
only. An open live log stops within a second of its viewer losing `logs:read` (leaving the
repository's `users` included). Edge checks the session on each request it passes on, not during
a stream: a live log already open goes on after a sign-out until its stream ends or reconnects.
The dashboard only shows the controls a user's actions allow: what it hides is still refused by
the orchestrator, which decides every request again. A chat's runs and
logs are its owner's alone ([The dashboard's actions](#the-dashboards-actions)).

Every answer on edge's port carries `Content-Security-Policy: default-src 'self';
frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`: the dashboard runs its own
scripts only (its build has none inline), and no page can frame it to get a signed-in user to
click Start, Cancel or Rerun, which `SameSite=Lax` would let a sibling domain do. The setup
and sign-in pages narrow it to `default-src 'none'`, their own images, and their style by its
hash.

Edge signs users in and holds their sessions ([Edge](#edge)); the orchestrator, which answers
the dashboard's API, only learns the login edge passes on with its service token. A session is
a signed cookie, valid for 7 days, with the login and its **epoch**. Signing out bumps the
login's epoch, in edge's store (`sessions/<login>`): every session of that login ends, in any
browser, on either copy of edge, including a copied cookie. Removing a user from `ALLOWED_USERS`
and restarting edge also signs them out; rotating `session.key` in edge's volume signs everyone
out.

`/status` answers calls from inside edge's container without a session (edge passes them on as
local, `x-deckhand-local`). A reverse
proxy on the host's network calls from loopback too: a request carrying `Forwarded`,
`X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP` needs a session. If your proxy adds none
of them, keep `/status` from it.

### MCP clients

MCP clients (Claude Code, Codex, an editor) sign in to Deckhand as one of its users, through
edge, which is a small OAuth 2.1 authorization server for the `/mcp` resource, as the
[MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization)
asks (`edge/oauth.mjs`, #481). It signs its users in with GitHub as the dashboard does: no
identity provider of its own, nor a secret beyond edge's three.

- **Discovery.** `/mcp` answers `401` without a valid token, with `WWW-Authenticate: Bearer
resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"` (RFC 9728), which
  names edge as the authorization server (`/.well-known/oauth-authorization-server`, RFC 8414).
  Both point at Deckhand's public URL (`PUBLIC_URL`, else the App's).
- **Registration** (`POST /oauth/register`, RFC 7591): public clients only (no client secret,
  whatever the client asks for), 1 to 5 redirect URIs, each `https://` or `http://` to
  `localhost`, `127.0.0.1` or `[::1]` (on the loopback, any port matches, RFC 8252); a custom
  scheme (`cursor://`) is refused. At most 20 registrations an hour per source address (its /64
  for IPv6), and 300 from all of them together; one no one signs in with is gone after a day.
  What remains: someone with many addresses can still use up the 300 for an hour at a time,
  stopping new clients from registering (those already registered sign in, and refresh,
  as before); and behind a reverse proxy edge sees the proxy's address alone, so every client
  shares one address's 20.
- **Authorization** (`/oauth/authorize`): PKCE with `S256` is required (`plain`, or none, is
  refused); the client and its redirect URI must be registered, else the page says so and sends
  nobody anywhere. Nobody is sent to a client's redirect URI before signing in, an error
  included, and a request refused before the consent page (`response_type`, PKCE, `resource`)
  goes back only to a loopback redirect URI, the user's own machine; for an `https://` one, a
  page says what was refused. Anyone may register a client, so sending someone there unasked
  would be an open redirect (RFC 9700 §4.11.2). A Deny is sent back, once the consent page
  has shown where to. Someone not signed in goes through GitHub (`/auth/login?next=…`, which only
  ever returns to `/oauth/authorize`), and an allowed login then sees a consent page naming the
  client (its own claim), the login it will act as, the scopes and the redirect URI. Only an
  allowed login gets that page, and so a code: a login outside `ALLOWED_USERS` is refused at
  GitHub's callback, as on the dashboard. The consent is a form posted once (its request,
  in edge's store for 10 minutes, bound to the login), from edge's own origin (`Origin`
  checked: the page is served with `Referrer-Policy: same-origin`, under which the browser sends
  it; the session cookie is `SameSite=Lax`); the page can't be framed.
- **Tokens** (`/oauth/token`): the code (5 minutes, once; a code used twice ends the tokens it
  gave; bound to the login's session epoch at the consent, so a sign-out before the exchange
  voids it) with its verifier, its client's id and redirect URI, becomes an opaque access token (an
  hour) and a refresh token (30 days), bound to the login, the client and the resource
  (`<PUBLIC_URL>/mcp`, RFC 8707: a client naming another is refused). A refresh rotates the
  refresh token; one used twice (or two refreshes at once) ends its whole family, the client
  signing in again. Each write of a family's tokens is a compare-and-set on its current value,
  and a revoked family leaves a mark (`mcp/revoked/<id>`, 30 days) its creation checks: a
  refresh, an exchange or a code used twice racing a revocation never brings the family back. A
  refresh may ask for fewer scopes: its access token gets those, its refresh token keeps the
  grant (RFC 6749 §6). Scopes: `deckhand:read` and `deckhand:work` (what a client gets when it
  asks for neither), and `deckhand:machine`, granted only when asked for ([Machines](#machines));
  others (`offline_access`) are ignored.
- **Kept hashed.** Codes, access and refresh tokens are random (256 bits) and kept as their
  SHA-256 in edge's store (`mcp/…`), which its two copies share: they survive a restart and a
  handover, and neither the store nor the logs ever hold one.
- **Every use is checked again**: the token's family still there, its login still in
  `ALLOWED_USERS`, and its session epoch unchanged. Signing out on the dashboard (which ends
  that login's sessions everywhere) ends its MCP clients' tokens too; so does Revoke in
  Settings › MCP clients (the login's own clients, posted from the dashboard's origin), or the
  client's own `POST /oauth/revoke` (RFC 7009). A login keeps 20 clients at most: a 21st ends
  the oldest.
- **`/mcp` itself** (#482): edge refuses a request whose `Origin` isn't Deckhand's public URL
  (`403`, before the token is read: a page elsewhere, DNS rebinding included, never reaches the
  tools; native clients send no `Origin`), and one without a valid token (`401`). It passes the
  rest on to the orchestrator as the token's login, with the token's scopes in a header of its
  own that a client can't set (`edge/forward.mjs` passes on only the headers it names), and its
  body 64 KB at most. The orchestrator answers `/mcp` only with those scopes, which a dashboard
  session never has.
- **What a client may do is its login's, as on the dashboard.** The read tools need
  `deckhand:read`, and read what the dashboard shows that login (`listener/mcp.mjs`, through
  `listener/http.mjs`): `ALLOWED_REPOS` and the login's [access](#access) (each repository's
  `users` included), on every call; a hidden repository stays hidden, a run in it is "not found"
  as one that doesn't exist, and a chat's runs are its owner's alone. A run's log may hold a
  repository's secrets in tool output: the logins who read it on the dashboard (`logs:read`)
  read it here, nobody else. It is also text the client's model reads, written by an agent that
  read issues, pull requests and web pages: the tool's description tells the model it is data,
  not instructions, which lowers the risk of a prompt injection through it, without removing it.
- **The write tools** (`rerun`, `schedule`, #483) need `deckhand:work`, and call what the
  dashboard's work area does (`listener/work.mjs`): its routes' checks (`ALLOWED_REPOS`, a
  hidden repository answered as one outside it, the route's action, `routeChecks()` in
  `listener/web.mjs`) but the `Origin`, which edge checked, then the same handler's: the
  start's mode, `runs:manage`, the repository's `users`, the issue's state. A run in a
  repository the login doesn't see, or another login's chat, is "not found" as one that doesn't
  exist. Each posts the dashboard's App comment on the issue, in the login's name, and is
  logged as the dashboard's are, marked "(MCP)". Their annotations (`destructiveHint`) make
  clients ask before calling them; a client given `deckhand:read` alone can't.

## The dashboard's actions

The dashboard is read-only but for two kinds of POST: starting a repository's onboarding
(`/api/repos/<owner>/<repo>/onboard`) and the graph's work area
(`/api/repos/<owner>/<repo>/work`, `listener/work.mjs`), which starts an issue, queues it
after another (`/after #n`), lays out a parent issue and its sub-issues from their "blocked
by" links (`plan`: each issue of the tree passes the checks below, or nothing is posted; blockers
in another repository are left out), moves its wait or cancels it (`/after none`), or stops a
brainstorm (`/stop`, refused unless it is active or idle), or stops a task's run (`cancel`,
what a `/cancel` comment does: only the repository's half of the checks below applies, as a
run may go on on a closed issue; refused when nothing runs or is queued). The work area
starts runs, so it is checked as a comment that waited is (`tasks.resume()`), at each request:

- a signed-in dashboard session, and an `Origin` header naming this Deckhand (its
  `PUBLIC_URL`, or the host the browser asked edge for, which edge passes on in
  `x-deckhand-origin` and `x-deckhand-host`): a page elsewhere can't post for a
  signed-in user, on top of the session cookie's `SameSite=Lax`;
- the repository in `ALLOWED_REPOS` (when set: by name, or through its owner's `owner/*`)
  and the App installed on it;
- its `.deckhand.yaml` on the default branch without errors, and a mode it has;
- the user in both `ALLOWED_USERS` and the repository's own `users`, with the route's
  [action](#access) there: `runs:start:<mode>` for what it starts, `runs:manage` for what it
  moves or stops (its mode's start too when that starts a run), each checked before anything
  is posted ([Access](../repo-config/policies.md#access) lists each route's);
- an open issue, not a pull request, with no run going or queued (a running issue doesn't
  move), and no wait that would loop back to it.

Each action is written on the issue as the App's comment ("Started from the dashboard by
@alice"), so the issue's history says who started what, as a trigger comment would. The
App's comments are ignored as triggers, so the orchestrator queues or holds the work itself
rather than through a webhook. The backlog (`GET /api/repos/<owner>/<repo>/issues`) lists a
repository's open issues to signed-in users in its `users` with `tasks:read` (every signed-in user
with `tasks:read` while its config has errors), from GitHub at most once every 30 seconds per repository, or after an `issues`
delivery for it, one read at a time (each issue's labels, and the parent of a sub-issue whose
parent is listed, read with it: one call per listed issue with open sub-issues); the dashboard keeps the last one in memory only, not in
the browser's storage, but for the names of the labels its Backlog filter has ticked. The repository list's backlog counts (`GET /api/repos?backlog=1`, the
Overview) come from the same reads under the same `users` rule and the same `tasks:read`
(a repository whose `users` leaves the user out, or that the user sees through another action
only, has none, and isn't read for them). While the list is asked for them, each configured repository
is read again in the background at most once every 5 minutes, which labels open questions as
a board's read does.

A failed run's Rerun (`POST /api/repos/<owner>/<repo>/rerun`) passes the same checks, for
the run's issue or pull request, and only for the task's latest run when it ended in `error`,
`interrupted` or `cancelled`: it queues the comments that run had already been allowed to act on, as the
signed-in user's, and posts the App's comment saying who asked.

A pull request's Review and Fix (`POST /api/repos/<owner>/<repo>/review { number, action }`,
which the dashboard offers once its review-and-fix loop is over) pass the same checks: same origin, the user in
`ALLOWED_USERS` and the repo's `users`, a config without errors, the pull request open and
nothing running or queued on it or its issue, one request at a time per pull request. They
need the repo's `review` block, and Fix its `review.fix`: the opt-in that lets findings become
a pushing run ([Review fix runs](github.md#review-fix-runs)) stays the repository's. Each posts the App's
comment saying who asked before its run is queued. Review queues what `/mode review` would;
Fix reads the App's latest review back from GitHub and goes through the fix loop's own checks
(`startFix()`: Deckhand's own pull request linked to its issue, ready for review, no
needs-input label, the loop not going on, the `deny_fix` policies), one fix run per click,
counted in the store's `reviews` before it is queued.

Its Dismiss (`POST /api/repos/<owner>/<repo>/dismiss { runId }`) passes the repository's half
of these checks (same origin, the user in `ALLOWED_USERS` and the repo's `users`, a config
without errors), not the issue's: a closed or busy item may be dismissed, since nothing runs.
It takes only the task's latest run, when it ended in `error`, `interrupted` or `cancelled`. It
is the orchestrator's own state (its store's `dismissed`: the run, who dismissed it and when), which only
the dashboard reads; nothing is posted on GitHub. Its Undo (`{ runId, undo: true }`) is open to
any of the repo's users, whoever dismissed it, as the dismissal is.

The same file holds the runs whose questions were set aside (`questions: true`), and those
come from GitHub, not the dashboard: anyone who can take the needs-input label off an issue or
pull request (the repo's triage permission, not `ALLOWED_USERS`) sets aside the questions of
its task's last run, and a close or merge does too. It starts and posts nothing, but it does
change what the dashboard allows for that task, which goes by its `needs-input` state: with
`wait_for_answers`, a Start, Queue or plan from the dashboard is no longer refused with "answer
them first" (`work.mjs` `asking()`), and the run's questions can no longer be answered there,
from its form or by ticking its reply's boxes (`answer()`, `ticked()`). So a label removal by
someone outside `ALLOWED_USERS` can let one of the repo's users start that issue from the
dashboard without answering its run's questions; what starts is still checked as any start is.
This is on purpose: the label is how the maintainer says the questions no longer hold, and the
dashboard follows what it shows (`work.test.mjs`, "wait_for_answers and a run's questions set
aside").
Comment triggers aren't held back for a run's questions either way (`tasks.mjs`
`unanswered()`); an issue's own open questions still go by the label. The label put back asks
again, and so does the dismiss API's `undo` for that run (the dashboard shows no Undo for
these).

A chat (`/api/chats`, `listener/chats.mjs`, [architecture.md](../architecture.md#chats)) is
created, and each of its messages sent, with the repository's half of these checks (same
origin, the repository in `ALLOWED_REPOS` and the App installed on it, a config without
errors, the user in `ALLOWED_USERS` and the repository's `users`, with the
`runs:start:chat` [action](#access) there, a repository they have no action on answering as one
outside `ALLOWED_REPOS`), at each request: a user taken out of any of them can't send another
message, and a sandbox of theirs still going is stopped, then and within a minute anyway (from
the repository's `users` as last read, and the access decision; one that fails stops nothing).
Their chats' volumes stay until they are deleted. A chat is its owner's alone: another user doesn't
list it, can't send it a message, reset or delete it (a `404`, as for a chat that doesn't
exist), nor read its runs' logs (`GET /api/runs/<id>/stream`), which the board, `/status` and
the run analyses leave out. Reset and Delete take the same origin and the owner's session
only, so a user who lost access can still drop what they left: their chat still lists for them,
without its runs (listed with `logs:read` only), whose logs are refused them too. `CHATS_PER_USER` caps the chats
a user keeps across the repositories (a repository's `chats.per_user` lowers it, never raises
it), and `MAX_RUNNING_CHATS` the chats' sandboxes running at once, apart from `MAX_PARALLEL`.

What a chat's sandbox gets is its policies' (`policy/mode-chat.rego`, which a grants folder's
file of that name replaces): the repository's code, its setup and its reads, never `push`, an
engine or a GitHub write (no `allow_github` rule allows any for the `chat` mode: the GitHub
gateway refuses them all), and its answers stay in its log. Its volumes are its own (its
task's sandbox name, `<repo>#chat-<id>`'s), never an issue's, and it gets none of the
repository's caches: nothing a chat leaves behind runs in a work run, with a work run's token.
Its prompt and its messages are the user's own words, read by the agent as an allowed user's
comment would be. Its owner narrows what it gets with its permissions profile ([Chats](policies.md#chats)).

An inbox entry sent from the dashboard (`POST /api/repos/<owner>/<repo>/inbox`) passes the
repository's half of these checks (same origin, the user in `ALLOWED_USERS` and the repo's
`users`, a config without errors), and only for an inbox the repo's config names. Its text is
posted on the inbox issue as the App's comment, ending "From the dashboard by @alice", and its
run reads it as that user's entry, as it would read their own comment there.

A lane's name (`POST /api/repos/<owner>/<repo>/lane`) passes the repository's half too, for
keys of that repository's issues and pull requests only. It is the orchestrator's own state
(its store's `lanes`), never posted on GitHub nor read by a run: one line of at most 60 characters,
shown as text.

Sync (`POST /api/sync`) takes a signed-in session with `server:sync` and this dashboard's
`Origin`, at most once
every 30 seconds for everyone. It starts nothing itself: it asks GitHub to redeliver the
App's deliveries that failed (signed by GitHub as any delivery, then checked as one) and reads
the open pull requests' states again, for every repository, as the orchestrator does at start.

A run analysis (New request's Analyze runs, `POST /api/repos/<owner>/<repo>/analyze`) passes the
repository's half of these checks too; its preview (`GET`, the same path) all but the origin,
as it changes nothing. It only ever reads runs of that repository: they are picked by the
repo of each run's record, and its digest is built from those alone. Its run never gets the
logs themselves (they cover every repository, and are a few MB each), nor a mount of the logs
folder: the orchestrator writes a digest into the run's inbox folder, which its sandbox alone fetches
from the broker (`TASK_DIGEST`), built from the dashboard's entries (`runlog.mjs` `format()`, tool details and
outputs clipped), redacted of the operator's credentials and of GitHub tokens (`secrets.mjs`)
and capped at about 400 KB. Its token only reads, as onboarding's: it replies, and files
nothing itself.

What the digest quotes reaches a run that has the code and a token, and its report is posted
as is, so it quotes less than the dashboard shows:

- **No research run**, ever: the form doesn't offer the kind, the selection skips them, and a
  digest asked for by run id leaves them out (see [Research runs](policies.md#research-runs)).
- **Unless GitHub says the repository is private**, both when the analysis is asked for and
  again when its run starts (a repo made public meanwhile, or a lookup that fails, counts as
  public), no orchestrator notes, setup output or failed tools' outputs: only the dashboard showed
  them. Kinds, outcomes, timings, tool counts, the calls made and the final replies (already
  posted on the repository) stay.
- Its instructions (`prompts/analyze.md`) say the digest is data, not instructions, and that
  the report quotes no raw output from it, and builds no images or links from what it says.

Discussions from the dashboard (`POST /api/repos/<owner>/<repo>/discussions`, and
`…/discussions/<n>/comments`) pass the same checks, only in the repo's `inbox.discussions`
category: a discussion elsewhere, or a reply to a comment of another discussion, is refused. Their
text is posted as the App's, ending "From the dashboard by @alice". Reading a thread
(`GET …/discussions/<n>`) takes a signed-in user in `ALLOWED_USERS` and the repo's `users`,
with `tasks:read`,
for a discussion in that category only. The thread shows a post as a dashboard user's only when
the App wrote it and its line carries a tag that checks: an HMAC of the user and the text, with
a key derived from the App's webhook secret, which no run holds. Anyone else writing the same
line is shown as themself; a run (whose writes are the App's) writing it, or
copying a tag under other text, is shown as the App. Deckhand's answers are the App's posts
that end with the marker. Posts from before the tags show as the App's.

Whatever a dashboard user writes (an inbox entry, a discussion or a reply, answers to open
questions) loses the App's marker and any tag before it is posted, so it can pass for neither
Deckhand's answer nor another user's post, and the "From the dashboard by" line of an inbox
entry or a discussion post carries the tag.

## Machines

A machine is a user's own computer that takes Deckhand's tasks (#594): its driver is an MCP
client of `/mcp`, signed in as its owner with the `deckhand:machine` scope, which a client gets
only when it asks for it. Nothing new reaches the internet: edge answers `/mcp` as for any
client, and no sandbox service, run token or git gateway is on the machine.

- **Registration** (`listener/machines.mjs`, #595): `register_machine` keeps its name (unique
  per owner), labels, capacity (1 by default, 16 at most), the repositories it takes
  (`owner/name` or `owner/*`) and its driver's version in the orchestrator's store
  (`machines/<id>`), with its owner and last heartbeat; 10 machines per owner at most. It is
  online while its last `heartbeat` is under 90 s old.
- **Its owner's alone**: every call names the machine by its id, and one that isn't the
  login's is "not found" as one that doesn't exist; Settings › MCP clients lists the login's
  own machines, its **Remove** posted from the dashboard's origin. Removing one deletes its
  entry and ends its claims, their tasks waiting again.
- **Every call checks the login again**: a token's login out of `ALLOWED_USERS` is refused at
  edge and at the orchestrator, as their dashboard session is; their machines are listed to
  nobody and offered nothing until they are back.
- **Opt-in per repository, both needed**: the operator's `machines` grant ([the
  grants](policies.md#the-grants), an `allow_grant` rule, nothing by default) and a `machines:` block in
  the repository's `.deckhand.yaml` on its default branch, whose `labels` narrow the machines
  it takes, never widen the grant. A machine is offered a repository only while its owner may
  start work runs there (`runs:start:work`, the repository's `users` narrowing it): never more
  than they may do on the dashboard. A grant, config or access decision that can't be read
  offers nothing (fail closed).
- **Who claims what** (`listener/claims.mjs`, #596): an issue runs on a machine only when its
  repository has the `machines:` block and it is routed there, by a `runs-on:<label>` label or
  a `/machine` comment. Its owner is who asked: the comment's author, who must be able to start
  work runs there, or whoever last added the label, checked as auto-pickup's labeller (an
  allowed user, not a bot, who may start work runs; anyone else's labelling runs nothing). A
  `claim` gives a machine only the tasks of its own owner, whose route it fits (the machine the
  task sticks to, or its name or label), in a repository offered to it now (above), within its
  capacity. The claim holds a lease of 2 minutes that the machine's heartbeat renews; one that
  runs out ends its run as interrupted (the issue told) and gives the task's comments back, for
  that machine. Another owner's `/machine` on the
  task is refused while its owner is a user here; taking its `runs-on` label off (anyone who
  may edit labels) ends a label route, as `/machine none` does: the task goes back to
  sandboxes, Deckhand's default, and the comments held for its owner are queued.
- **What reaches the machine**: the work a sandbox run would get (the repository, the issue, its
  branch's name, the mode, the prompt and the comments' text), the URL to clone it from and the
  hosts a sandbox run of the repository may reach (the agent's, GitHub's and the operator's grant:
  names the egress proxy already allows, for the driver's suggested settings), no token, no
  secret of the operator's. Only the owner's comments reach its runs: another user's are held on the task,
  shown on the dashboard to those who see the task, until the owner delivers or drops them
  (`POST /api/held/<repo>/<n>/deliver|drop`, the owner's alone). Deckhand's own items (a review's
  fix round, a CI fix, a rebase, and the review of the issue's own pull request, which is the
  issue's task) are delivered: the whole loop runs on the machine. Every comment a claim takes
  is checked again first, as a sandbox run's are: one whose author left `ALLOWED_USERS` or the
  repository's `users`, or may no longer start its mode, is dropped. Pushes are the owner's own
  git's; the App writes what it writes for any run (#597), and opens its pull request (below).
- **Its run** (#597, [External runs](../architecture.md#external-runs)): only the machine holding
  the claim reports on it (`post_events`, `next_message`, `ask`, `finish`): each call names the
  machine, its owner's, and the claim's run; another login's machine, the owner's other one or
  another run is refused as one that doesn't exist. What it reports is the run's log and reply:
  its lines are redacted of the operator's secrets as a sandbox's output is, and its reply is
  posted by the App on the task's own issue or pull request alone, as a sandbox run's (no other
  write of the App's is the machine's to ask for). Its run gets no token: a call is its owner's
  MCP token's, which edge checks.
- **Its agent's permission requests** (#600, `listener/requests.mjs`): a tool call its agent
  has to ask for (Claude Code's `--permission-prompt-tool`, which the driver relays to
  `approve_permission` with the claim's run) goes into the requests chats' agents use, owned by
  the run's owner, kept in the orchestrator's store (`permission-requests`). It is shown on the
  task's page to those who see the task, and in a comment of the App's on the issue that
  mentions the owner: the tool and its input, one line, redacted of the operator's secrets and
  cut to 200 characters as policy messages are; on the page as text, never HTML or markdown, in
  the comment inside a fenced block longer than any run of backticks in it (no markup, no
  mention). Only the owner answers it: **Allow once**, **Allow for this run** (that tool's later
  calls in the run allowed without asking) or **Deny**, from the dashboard
  (`POST /api/permissions/<repo>/<n>/<id>/once|run|deny`, from its origin, the owner's alone) or
  with a `/allow`, `/allow run` or `/deny` comment on the issue or its pull request, which is
  never queued nor sent to the agent; anyone else's comment is ignored, their dashboard answer
  refused. No answer within `CHAT_PERMISSION_TIMEOUT` (10 minutes) denies it, and so does the run
  ending. The call waits for the answer 25 s at a time, renewing the claim's lease each time, so
  a run waiting on its owner keeps its claim. At most 3 wait per run; more are refused. **No
  ceiling but the machine's**: Deckhand relays and records the answers, and enforces nothing
  with them; what the machine allows or denies without asking (its own settings, a deny list
  in its driver's config) never reaches Deckhand.
- **Its pull request** (#598, `listener/machine-pulls.mjs`): the machine pushes with its owner's
  own git and credentials, never through the git gateway, then names the branch and its head in
  `finish`. Before the App writes anything, the orchestrator checks the branch is the issue's
  own (`issue-<n>-<slug>`, one segment of plain characters), reads its head from the repository
  itself, never a fork, and compares it with the commit the machine named; a pull request open
  from it that isn't the App's, or closes another issue, is refused too. Then the App opens the
  draft (`Closes #<n>`), or finds the one it opened, and marks it ready when asked: the only
  writes of the App's the machine causes beyond its run's reply and its permission requests'
  comments. **A machine's pull request is
  trusted as an allowed user's**: its commits are whatever the owner's machine pushed (its
  refs, `allow_push`, the workflow files: none of the gateway's checks ran), so the review is
  their check. It is recorded as the machine's (`pr.external`, the owner's login), and so is the
  task's open pull request whenever a machine's claim covers it (at the claim, at its end, at a
  release or a lease run out), whether or not `finish` names a branch: the machine may push to it
  either way. The mark is kept per pull request (the store's `marks`, #947), not only in the
  task's entry: an older one left open when a newer one became the task's stays the machine's,
  and never merged by itself. It is shown so on
  the dashboard, and in the policies' input of `deny_review`, `deny_fix`, `deny_merge` and
  `deny_request_review`.
- **Never merged by itself, by default**: on top of auto-merge's gates ([Auto-merge](github.md#auto-merge):
  the files Deckhand trusts, `.github/` included, still wait for a person), Deckhand's
  `policy/machines.rego` refuses `deny_merge` for a pull request marked `external`. An operator
  who wants `review.merge` to merge them replaces that file in the grants folder's `policy/`; a
  repository can only add refusals.
- **What Deckhand doesn't enforce**: anything on the machine. An agent runs there on its own,
  with the owner's files, credentials and network; Deckhand suggests settings for it and
  enforces none. `register_machine`'s answer and the dashboard's list of machines say so.
- **The suggested settings** (#599, `machine/deckhand-machine.mjs` `settingsFor()`): the driver
  writes Claude Code settings for each run, passed with `--settings`: the run's clone writable,
  the extra paths of its `machine.yaml` reachable (read-only unless it says `write`), the usual
  credential stores, browser profiles and the driver's own tokens unreadable, the claim's hosts as
  the only domains its sandbox reaches, its sandbox on where Claude Code has one (macOS, Linux,
  WSL2: never native Windows) and refusing to start without it, `bypassPermissions` turned off.
  Claude Code applies them; nothing of Deckhand's checks that they were, nor stops an owner who
  edits the driver or its config. Its sandbox confines the commands it runs (Bash), its permission
  rules its file tools; neither covers what the owner's MCP servers or hooks do, nor its git
  credential helpers.
- **How it ran, as reported**: a claim says the agent's version, whether its sandbox is on, its
  permission mode and whether the suggested settings were used (`claim`'s `agentVersion`,
  `sandbox`, `permissionMode`, `suggestedSettings`: a word each, checked as such, since the
  reply's footer says them). The run's record, its log, the dashboard and the reply say them as
  what the machine reports, never as something Deckhand checked.
