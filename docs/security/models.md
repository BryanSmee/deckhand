# The models service and credentials

Where the agents' credentials live and what a run's calls to its agent's API carry. Part of the [Security overview](../security.md).

## The models service

The operator's agent credentials (Claude, OpenAI and Google keys, a gateway's token, the plans'
logins) are in one service only, the **models service** (`models/`, #504): its environment, and
the plans' files in its credentials folder, mounted read only. Not in edge, the orchestrator, the runner,
the broker or any sandbox (a test reads `compose.yaml`: `test/networks.test.mjs`).

- **Who calls it.** The egress proxy, with the sandboxes' agent calls, and the orchestrator, each
  over a network of its own that only the two of them are on; every call
  carries the caller's [service token](tokens.md#service-tokens), checked against one table of what each
  caller may do (`models/http.mjs` `ROUTES`): the proxy reaches the agents' endpoints alone; the
  orchestrator also learns which credentials it holds (names only), their fingerprints, a run's
  API state and its stream. It calls the broker (its tokens, whether a run goes) and the runner
  (the Antigravity login's refresh), and the agents' APIs: its only way out.
- **A run's agent token, checked offline.** A sandbox's call arrives with its run's agent token
  (moved by the proxy into `x-deckhand-run-token`, its own service token in `Authorization`)
  and the network (or pod) the proxy vouches it came from (`x-deckhand-sandbox`, from the
  orchestrator's egress policy, as for the broker). The service checks the token with the broker's
  public keys, for the agents' audience, from that network only, for a run the broker says still
  goes (asked every 30 s at most, its last answer kept 10 minutes while it is away), and reads
  its **`agent` claim**: the provider, and the credential of its, the orchestrator chose for the run
  (`claude@anthropic:key`). A Claude Code run's token gets no OpenAI key, nor the plan when it
  names the key.
- **The agents' base URL** is the broker's host (`<broker>/anthropic`, …): the egress proxy
  sends those paths to the models service, and the hosts it relays for the Antigravity CLI on a
  plan too (the egress policy says `models: true`).
- **The plans' logins, in its store, sealed.** A refreshed login (the ChatGPT plan's, the
  Google AI plan's) is kept in the service's store, encrypted with AES-256-GCM under a key only
  its containers hold (`models.key`, in a volume or Secret of its own, the same for every copy: a
  login sealed with another key is refused, never written over: `models/logins.mjs`):
  the store may be Redis, which every service reads (#509). The operator's file is where a login
  starts, never written: the store's login is used until the file's content changes (a new
  sign-in). Their refresh tokens are single-use, so one copy refreshes at a time, holding a
  lease in the store, and the others wait for its result; a refused refresh is saved too, so no
  copy spends the login again until the file is replaced.
- **What the orchestrator learns.** Which credentials are set, by name (its settings need them:
  which agents may run, `FALLBACKS`), and their **fingerprints** for redaction (`GET
/fingerprints`: a salt, each value's length and salted SHA-256, and the salted SHA-256 of
  each of its 16-character parts at fixed offsets, with a 32-bit rolling hash of each part that
  picks the few windows of a run's output worth hashing), never a value. The salt comes from the
  models service's key: every copy, and every restart, gives the same set. It reads them before it
  restores any run, and every minute after. It redacts a credential that shows whole in a run's
  output (whatever `.`, `/`, `=` are next to it), and a run of characters that holds one of its
  parts, whole: any part of a credential 31 characters long or more (a value cut off in an error
  message, #242), glued to other characters or not. A shorter part may get through, where the
  run's own tokens are redacted from 16 characters: the hashes of every 16-character window of a
  credential would give it back one character at a time; those of fixed parts only give back the
  few unknown characters of a part that is mostly known (`sk-ant-api03-` and 3 more), and the
  rest has too many. The credentials never enter a sandbox: this only catches a mistake bringing
  one back.

### The Claude credential

Your `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` outlives everything else a sandbox
could hold, and works for anyone: **no sandbox gets it**. Runs read text anyone may write
(issue and discussion comments, a fork's code), and their final message is posted as is: a
credential in the sandbox's environment could be read by Claude's tools or the repo's setup
and end up in a public comment.

- A sandbox's Claude Code calls the models service instead of Anthropic (`ANTHROPIC_BASE_URL`
  set to `<broker>/anthropic`, which the egress proxy sends there: `models/anthropic.mjs`), with
  the run's agent token in the variable
  your credential would be in, so it keeps its mode (an OAuth token or a gateway's
  `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer`, an API key as `x-api-key`; when you set
  several, `ANTHROPIC_AUTH_TOKEN` wins, then the API key, as in Claude Code).
- The models service refuses an agent token that isn't a live run's, or comes from another
  sandbox, or is another agent's, replaces it with your credential in the header it takes and
  forwards the call to Anthropic (or to the operator's `ANTHROPIC_BASE_URL`, a gateway such as
  OpenRouter), streaming the answer back. Only the
  operator sets that address: a repository can't, since it would send its code and your
  credential elsewhere. A sandbox never reaches the gateway itself, so it needs no host.
- So a run's agent token can call the API with your credential while the run lasts, and nothing
  after: what a run copied out of its sandbox can't.
- The orchestrator redacts the run's tokens from the sandbox's output before writing the run's log
  (what the dashboard shows) and from its reply before posting it, as `[redacted]`: the value,
  or any part of it 16 characters long or more (a value cut off in an error message); a value
  shorter than that isn't redacted (it would be no credential, and would redact ordinary words),
  and an encoded or split one gets through. Your credential, which it doesn't hold, it redacts by
  its fingerprints, whole or a part of 31 characters or more (see
  [The models service](#the-models-service)): which is why the credential isn't there to begin
  with. A JWT's header and the `.eyJ` that starts its payload don't count
  towards those 16 characters: every token its issuer signs shares them, so other JWTs in a
  reply stay readable.
- When the models service can't use an operator's login (a refresh that failed, a file it can't
  read), the sandbox's call and the run's reply get a fixed text per kind ("the operator's
  login for Google can't be refreshed right now", "can't be used", or "was refused, and must
  be signed in again", each followed by "see the models service's log"), never the error
  itself, which could quote the credential file. The details go to its log, redacted.

Codex's `OPENAI_API_KEY` is kept out the same way (`models/openai.mjs`): a sandbox's Codex
has `<broker>/openai` as its provider's base URL and the run's agent token as its key, sent as
`Authorization: Bearer`; the models service checks it, puts your key in its place and forwards the
call to OpenAI (or the operator's `OPENAI_BASE_URL`), under its base path only: a path with
`//host`, a scheme or `..` is refused, so the key can't be sent elsewhere, and only Codex's own
calls go (see [What the API endpoints forward](#what-the-api-endpoints-forward)). Both agents'
credentials are redacted
from every run's log and reply, whichever agent ran.

A ChatGPT plan's login (`CODEX_AUTH_FILE`, `models/chatgpt.mjs`) takes the key's place the
same way, with more reason: its refresh token is account-wide, single-use and rotated on every
refresh, so copies in several sandboxes would also spend each other's. The models service holds
the only copy: it refreshes the access token at `auth.openai.com` (one refresh at a time, for
all runs and every copy of the service), keeps the rotated tokens sealed in its store before
using them (the file is never written), and sends the
sandboxes' calls to ChatGPT's Codex backend (`chatgpt.com/backend-api/codex`) with the access
token and the account's `ChatGPT-Account-ID`, headers a sandbox can't set itself. A sandbox
gets the run's agent token as its key, as with an API key, and nothing of the login. The tokens are
redacted from runs' output too.

Why this way, checked against Codex 0.162.1 (`codex-rs/login`, `model-provider`): with a
ChatGPT login, Codex calls `chatgpt.com/backend-api/codex/responses` with
`Authorization: Bearer <access token>` and `ChatGPT-Account-ID`, the same Responses requests
as with a key (`store: false`, streamed), and refreshes at
`auth.openai.com/oauth/token` 5 minutes before the access token expires. A custom provider
(the sandbox's `deckhand` one) sends those requests with the run's agent token instead, so the
models service only has to swap the headers and the base URL; Codex in the sandbox never knows it
runs on a plan. Codex's own "external tokens" mode (`chatgptAuthTokens`) only exists in its
app server, not `codex exec`, and would still put the access token in the sandbox. Check it
again when you change `CODEX_VERSION`.

### The Antigravity CLI's login

The Antigravity CLI's `GEMINI_API_KEY` is kept out the same way (`models/google.mjs`): a
sandbox's `agy` has `<broker>/google` as `GOOGLE_GEMINI_BASE_URL`, `modelProvider: "gemini"`
in its settings, and the run's agent token as `GEMINI_API_KEY`, sent as `x-goog-api-key`; the
models service checks it, puts your key in its place and forwards the call to
Google (or the operator's `GEMINI_BASE_URL`), for the model calls `agy` makes under `/v1/` and
`/v1beta/` only (see [What the API endpoints forward](#what-the-api-endpoints-forward)).

A Google AI plan's login (`AGY_AUTH_FILE`, `models/antigravity-login.mjs`) is the token file
`agy` writes when you sign in: an access token for about an hour, and a refresh token that
stands for the Google account. Neither enters a sandbox. On a plan, `agy` has no base URL to
point at the models service, and its calls go to Google directly, so it is kept out another way:

- **The sandbox's token file holds the run's agent token** as its access token, with an expiry in
  2099 and a placeholder refresh token (`sandbox/agents/antigravity.sh`): `agy` sends the token
  as it is and never tries to refresh it (checked against agy 1.4.0).
- **The proxy relays the hosts that carry it.** For runs of the Antigravity CLI on a plan
  only (the broker's run says which agent it is), the egress policy marks
  `daily-cloudcode-pa.googleapis.com` and `www.googleapis.com` as relayed: the proxy ends the
  sandbox's TLS with Deckhand's CA (see [HTTPS and Deckhand's CA](network.md#https-and-deckhands-ca)),
  cache on or off, and sends each request to the models service
  (`<MODELS_SERVICE_URL>/relay/<host>/<path>`) instead of the host, never as a tunnel. A path that could
  leave `/relay/<host>/` once parsed (`..`, `%2e`, `\`, or not starting with `/`) gets a
  `400` and never reaches either. The models service
  (`models/google.mjs`) checks the agent token, and that it comes from its own sandbox (the
  network the proxy vouches for),
  refuses any other agent's run, puts the plan's access token in its place and sends the call
  on, streaming the answer back. Only the paths `agy` calls go through
  (`daily-cloudcode-pa.googleapis.com/v1internal:*`, `www.googleapis.com/oauth2/v2/userinfo`):
  the plan's token opens more than the CLI's API, and a sandbox can't reach the rest with it.
- **Refused:** `agy`'s telemetry (`play.googleapis.com`, which carries the token too), whatever
  the grants say, for these runs. `antigravity-unleash.goog` (feature flags, no token) and the
  account's avatar (`lh3.googleusercontent.com`, a public image address) stay a tunnel, as
  every other host: `agy`'s eligibility check fetches the avatar the userinfo call names and
  stops if it can't (#224). Even if `agy` sent its token there, that token is the run's agent token,
  which works nowhere but the models service.
- **The refresh is `agy`'s own**: the models service doesn't reimplement Google's OAuth with a
  client secret taken from the binary. When the access token is within 5 minutes of its expiry (or
  Google refused it), it has the runner run `agy models` (the runner's
  `POST /logins/antigravity/refresh`, which only the models service may call: it never holds the
  Docker socket) in a short container of the sandbox image (no capabilities, as `node`), on a volume
  of its own (`<AGY_VOLUME>-login`), outside the runs' networks, with the login's expiry set in the
  past; it reads back the file `agy` wrote and keeps it sealed in its store. On Kubernetes it is a
  pod of its own (Pod Security `restricted`, no ServiceAccount token, no Secret, `~/.gemini` an
  `emptyDir`): the file goes in on its stdin and comes back on its stdout through the API server's
  `pods/attach`, never in its spec. That stdout is sealed with a one-time key the runner sends first
  on stdin (`listener/runner/kube-seal.mjs`): the container's log on the node, which log agents may
  ship off the cluster, holds only ciphertext, never the login. The egress proxy lets it reach
  Google's OAuth and the CLI's own hosts only, tunnelled (and GitHub's releases while an init
  container installs the CLI, when it has no claim, never once `agy` runs with the login). It is
  removed once it ends, whatever its outcome. One refresh at a time, for all runs and every copy of
  the service. The login's tokens are redacted from runs' output like the other credentials.

What this changes: the proxy reads those two hosts' requests and answers for these runs, as it
does a cached host's, and the run's agent token, which it sees, is worth what it is elsewhere: this
run's calls, until it ends. A sandbox that trusts the CA gains nothing: it reaches the same
hosts, through the same proxy. Check the hosts and paths again when you change `AGY_VERSION`.

`OPENROUTER_API_KEY`, for runs that fall back to Claude Code through OpenRouter
(`claude@openrouter` in `FALLBACKS`), is kept out the same way: such a run's Claude Code gets
the run's agent token as `ANTHROPIC_AUTH_TOKEN`, and the models service's Anthropic endpoint,
which the token's `agent` claim tells which provider the run is on, sends the call to
`OPENROUTER_BASE_URL` with your key. A sandbox can't pick its provider: only the orchestrator sets
it, from `FALLBACKS`, and the broker signs it into the run's tokens. The key is
redacted like the others.

### What the API endpoints forward

A run's agent token opens the operator's credential only for its own agent's calls. The
credentials open far more (files, batches, stored responses, fine-tuning, an organisation's
admin API), shared with every other run and with whatever else the operator uses them for, and
a batch or a cached content would keep billing after the run ends. So each
endpoint forwards a fixed list of methods and paths, what its agent calls, and nothing else:

| Endpoint                        | Runs                                                                               | Forwarded                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/anthropic/` (`anthropic.mjs`) | Claude Code's, on `anthropic` or a provider the operator configured (`openrouter`) | `POST v1/messages`, `POST v1/messages/count_tokens`, `GET v1/models`, `GET v1/models/<id>`                                                         |
| `/openai/` (`openai.mjs`)       | Codex's (`openai`)                                                                 | `POST responses`, `POST responses/compact`, `GET models`, `GET models/<id>`, under the API's base URL or ChatGPT's `backend-api/codex/`            |
| `/google/` (`google.mjs`)       | the Antigravity CLI's (`google`)                                                   | `POST v1beta/models/<name>:generateContent`, `:streamGenerateContent`, `:countTokens`, `GET v1beta/models`, `GET v1beta/models/<name>` (`v1/` too) |
| `/relay/<host>/` (`google.mjs`) | the Antigravity CLI's on a plan                                                    | `POST v1internal:<method>` on `daily-cloudcode-pa.googleapis.com`, `GET oauth2/v2/userinfo` on `www.googleapis.com`                                |

- Anything else answers `404` in the provider's error shape, never reaching the provider, and
  is a line in the run's log ("Deckhand refused the agent's call …"), redacted like the
  sandbox's output: an agent version that needs another path shows up there. Each call is
  noted once (by each copy of the models service), and the first 20 only, then one line saying
  the rest aren't, which the service streams to the orchestrator (its `models` stream): the
  orchestrator's own lines are written even past `RUN_LOG_MAX_MB` (see [Output](mounts-and-engine.md#output)), so a sandbox looping
  on refused calls can't grow its log without end. When a new `CLAUDE_CODE_VERSION`,
  `CODEX_VERSION` or `AGY_VERSION` needs another path, add it to the endpoint's list (`ROUTES`, `GEMINI_ROUTES`,
  `RELAYED_PATHS`).
- Each endpoint serves its agent's runs only, from the provider the orchestrator gave the run
  (`broker.provide()`, claimed by its tokens): a Claude Code run's token gets no OpenAI key,
  and a run without a provider gets no credential at all. A run a restarted orchestrator picks up
  whose saved record names no provider gets its agent's default one.
- A run has at most 16 calls in flight through all the endpoints of a copy of the models
  service together (32 with two copies): the next one answers `429` (agents retry those) until
  one ends. A call that gets no byte either way for 10 minutes is cut off: a stalled provider
  doesn't hold the service, which every run shares.
- So a provider's `401` on one of these paths, the only ones a run reaches, is what marks a
  plan's token for a refresh: a sandbox can't force refreshes through some other path.
