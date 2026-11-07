# The egress proxy and hosts

Where a sandbox's traffic goes, which hosts it reaches, and what the proxy keeps or decrypts on the way. Part of the [Security overview](../security.md).

## Network

```
sandbox ──(its run's network, internal: no route out)──▶ egress proxy ──▶ allowed hosts
                                                              └──▶ the broker, github and models services
```

- Each run has a **network of its own**, named after the run and labelled with the
  deployment's `NAME_PREFIX`: the runner creates it before the sandbox and removes it with
  the sandbox. Only two containers are on it (three with a
  [container engine](mounts-and-engine.md#container-engine)): the sandbox and the egress proxy, which the runner
  joins to it under the name sandboxes call it by (the host of `EGRESS_PROXY`). Sandboxes
  can't reach each other, nor what
  another run's setup started (a dev server, a database).
- That network is **internal**: Docker gives it no route out. The runner creates it with
  `--internal`, checks it (`docker network inspect`) and refuses to start the run otherwise.
  Its subnet comes from Docker's address pools, or from `SANDBOX_SUBNETS` when set (a block
  no other network on the host uses, [Sandbox networks](../settings.md#sandbox-networks)): either way the network is
  internal, so the range changes addresses, not what a sandbox can reach. It must lie inside
  `10/8`, `172.16/12`, `192.168/16` or `100.64/10`: Deckhand refuses to start with
  another.
- The runner finds the proxy's container by its `deckhand.role=egress` label, in its own
  compose project (`EGRESS_CONTAINER` to name it instead), and joins no other container to a
  run's network. A new runner joins it again to the running sandboxes' networks when it
  starts, and checks every minute (`docker compose up -d` recreates it without the networks it
  was joined to); networks of this deployment whose run is gone are removed then.
- The **egress proxy** (`proxy/proxy.mjs`, the `egress` service) is on every run's network
  and the outside one. Being on all of them, it is the only path between two runs: it
  connects to the hosts a run may reach only, and to a private address only for a host you
  list by name (below). It handles HTTP `CONNECT` (HTTPS, and anything tunnelled) and plain HTTP
  requests, `https://` ones too (see [HTTPS and Deckhand's CA](#https-and-deckhands-ca)). For
  each one, it asks the orchestrator's egress policy whether the sandbox at that source
  address may reach that host; the orchestrator matches the address to the running sandbox (the
  runner's `docker inspect`) and answers from that run's list. Only the proxy may ask: the
  orchestrator compares
  the caller with the proxy's addresses on all of its networks (`docker inspect`). An unknown address, an unknown host, or an
  orchestrator that doesn't answer: refused, with a `403` saying why.
- The proxy resolves names itself and connects to the address it checked. Loopback,
  link-local (cloud metadata, `169.254.169.254`), `0/8`, multicast and reserved (`224/4` and
  up), IPv6 site-local (`fec0::/10`) and anything that isn't an IP address are always
  refused, and so is `198.18/15` (benchmarking); private ones (`10/8`, `172.16/12`,
  `192.168/16`, `100.64/10`, `fc00::/7`, NAT64's local-use `64:ff9b:1::/48`) only when the
  host is one you allow by name or `*.domain` in the grants folder, never through `*` alone. The same goes for any address in
  a subnet of the networks the proxy is on (read from its interfaces at each connection, so a
  run's network counts as soon as it is joined): other runs' sandboxes and engines, the
  orchestrator, whatever range Docker gave those networks, a public one or a global IPv6 prefix
  included. IPv6 addresses are compared as bytes, and those standing for an
  IPv4 one (`::ffff:0:0/96`, `::ffff:0:0:0/96`, `::/96`, NAT64's `64:ff9b::/96`, 6to4's
  `2002::/16`) are checked as that IPv4 address, so `[::ffff:a9fe:a9fe]` is the metadata
  service too.
- The proxy keeps answers from the hosts you list in `cached_hosts`, and decrypts their
  HTTPS to do so (see [The egress cache](#the-egress-cache)). It also decrypts GitHub's hosts
  and those that carry the Antigravity CLI's token (for its runs only), and hands their
  requests to the github service and the models service, naming the sandbox they came from (see
  [The GitHub gateway](github.md#the-github-gateway) and
  [The Antigravity CLI's login](models.md#the-antigravity-clis-login)). Every other `CONNECT` stays a
  tunnel the proxy can't read.
- The orchestrator stops answering for a run as soon as it sees its sandbox exit, before posting
  its reply, and finds a connection's run by the ID of the network its address is on now,
  never by an address it kept: Docker may give the address to another sandbox, which must not
  get the finished run's hosts.
- The proxy forwards plain HTTP to the services' names sandboxes call (`http://broker:8081`,
  `http://github:8080`, `http://models:8080`: `lib/services.mjs` `SANDBOX_URLS`, the same in
  every release) to its own URL for each (`BROKER_SERVICE_URL`, `GITHUB_SERVICE_URL`,
  `MODELS_SERVICE_URL`), and only on the paths that service takes from sandboxes: the run's
  token and files (`/run/…`) to the broker, pushes (`/git/…`) to the github service, the agents'
  APIs (`/anthropic/`, `/openai/`, `/google/`) to the models service; anything else there is
  `404`. Only once the policy, asked about the name (`forward=1`), allows it: for a running
  sandbox or its engine, never a build or an install's own pod, nor anyone else, and never as a
  tunnel. It names the network (or pod) the policy gave for the sandbox, as for a relayed call.
  The path and query (its URL parsed first: `..`, `%2e`) are set on the service's own URL, never
  parsed as a URL again, so a path such as `//host/x` stays a path on the service and never
  names another host.
- Sandboxes get `HTTP_PROXY`, `HTTPS_PROXY` (both cases), `NO_PROXY` (`localhost`, and the
  run's container engine) and `NODE_USE_ENV_PROXY=1`: without it, Node's `fetch` ignores the proxy (and
  fails, as nothing else goes out). The Playwright browser gets the proxy as flags. A tool
  that ignores proxy settings fails closed: it has no route out.

## The egress cache

Runs download the same packages again and again: `npm ci` from the npm registry,
`apt-get` from a Debian mirror, a toolchain from its release server. For the hosts you list
in `cached_hosts` (in `grants/default.yaml` and `grants/<owner>/<repo>.yaml`, added up like
`hosts`, with the same patterns), the egress proxy keeps the answers on disk, in the
`egress-cache` volume, and serves them to every run: plain HTTP, and HTTPS, which it
decrypts ([below](#https-and-deckhands-ca)). A repository's `.deckhand.yaml`
can't list them (one there is ignored, with a warning): the cache is shared by every run, so
only you say what goes in it. A host in `cached_hosts` must be reachable too (in `hosts`, or
mandatory): `cached_hosts` alone opens nothing.

- **What is kept**: only what is the same for anyone. A `GET` without a body
  (`Content-Length` over 0, any `Transfer-Encoding`, or `Expect`), `Cookie`, `Range` or a
  header whose name looks like a credential (with `auth`, `token`, `key`, `secret`,
  `password` or `credential` in it, or starting with `x-jfrog-`: `Authorization`,
  `Private-Token`, `X-Api-Key`…; npm's `npm-auth-type` and the proxy's own `Proxy-*` aside),
  answered `200` without `Cache-Control: private` or `no-store`, and within
  `EGRESS_CACHE_ENTRY_MAX`. Anything else is forwarded as before.
- **What reaches the host**: on the cache path, only `Accept`, `Accept-Encoding`,
  `Accept-Language` and `User-Agent` go on, with `Host`; to check a kept answer, its own
  `If-None-Match` and `If-Modified-Since`, never the client's. Any other header
  (`X-HTTP-Method-Override`, `X-Forwarded-Host`) is dropped, so it can't shape an answer kept
  for every repository. `Accept-Language` and `User-Agent` aren't in the key (see `Vary`
  below). A request the cache doesn't answer (one checking its own copy when nothing is
  kept, or one sending a header the kept answer varies on) goes on as it is, and its answer
  isn't kept.
- **Connections**: every request the proxy sends to a host, cached or not, gets a new
  connection, never reused: a request whose body a host doesn't read (request smuggling)
  can't put another URL's answer under a key.
- **Cookies and `Vary`**: a cookie the answer sets goes to that client only, never into the
  cache: the request had none, so the answer is the one anyone gets, and CDNs set theirs on
  everything (Cloudflare's `__cf_bm` on npm's registry). `Accept-Encoding` and `Accept` are
  part of the key, with the URL. An answer varying on another header (`Vary: Origin` on
  Alpine's mirror) is kept only when the request didn't send it, and served only to
  requests that don't either; one varying on `*` isn't kept.
- **Freshness**: the host's `Cache-Control` (`s-maxage`, `max-age`, `no-cache`), else its
  `Expires`, else a tenth of the time since its `Last-Modified` (a day at most), else none.
  A fresh answer is served from disk without asking the host; a stale one is checked with
  `If-None-Match` / `If-Modified-Since`, and a `304` serves it. A client's own
  `Cache-Control: no-cache` has it checked too. Each answer says how in an
  `x-deckhand-cache: hit | miss | revalidated` header.
- **Downloads**: the first one is streamed to the client while it is written to a temporary
  file, renamed into place once complete. A client that disconnects, a host that stops
  midway or a body over the per-entry limit leaves nothing behind.
- **Size**: `EGRESS_CACHE_MAX` (10 GB by default) counts the downloads being written too.
  One with a `Content-Length` reserves it as it starts, and the least recently used answers
  are removed to make room for it; one without makes room as it comes. Downloads under way
  take half of it at most (`EGRESS_CACHE_ENTRY_MAX` when that is more): a download read slowly, or dropped before its end, never evicts
  more than that, and one that finds no room goes on to its client without being kept. The
  bodies are counted, not their small metadata files, and a removed answer a client is still
  reading stays on disk until it is done: the volume can go past it by the answers being
  read then. That half holds at any one time: over time, a run that fetches many different
  URLs (a query string changed each time, say) can still push every other repository's
  answers out. The cache stays within its size, not its contents.
  `EGRESS_CACHE_MAX=0` turns the cache off
  ([Advanced settings](../settings.md#advanced-settings)).
- **Trust**: plain HTTP can be tampered with on the way, cached or not, and a cached answer
  then reaches every run. Cache only what the client checks itself (apt's signed indexes and
  their package checksums do) or hosts you would trust over plain HTTP anyway.

### HTTPS and Deckhand's CA

HTTPS reaches the proxy as a `CONNECT` tunnel, which it can't read. For a host in
`cached_hosts` (and the relayed hosts: GitHub's, the Antigravity CLI's), and only then, the
proxy ends the client's TLS itself, with a certificate for that host signed by a CA of its
own, and serves the requests inside through the cache above (or hands them to the service that relays them); what isn't served from it goes on to the host over TLS, which the proxy checks
against Node's trust store. Everything else keeps the raw tunnel, and the client sees the
real server's certificate.

Some clients don't open a tunnel for HTTPS: busybox `wget` (Alpine's) sends the whole URL to the
proxy instead (`GET https://host/path`), unencrypted on the run's network. The proxy takes it as
a `CONNECT` to that host: the same policy answer, and the request goes on to the host over TLS
it checks against Node's trust store, or to the service that relays it. It is cached only where
the host's `CONNECT` would be decrypted, so a container engine's (never decrypted), an agent
provider's (which Deckhand's CA can't vouch for, below) or any with no CA is sent on, never
kept. The proxy reads nothing the client had encrypted: such a client never encrypted it.
(busybox `wget` also shuts its side of the connection down once the request is sent: the proxy
keeps the connection open until it has answered.)

- **The CA** is made by the proxy on its first start (the `openssl` CLI, in its image),
  in its volume (`ca/` in the `egress-cache` volume), and kept across restarts: a new
  volume is a new CA, which the next runs get. It lasts a year, and the proxy makes a new
  one a month before its end (and replaces one from before name constraints, or whose
  constraints still exclude GitHub, below, on its next start): sandboxes get it at their
  next start, and runs going on then lose their cached and relayed hosts' HTTPS (their
  certificates are the old CA's), GitHub's included, until their next run. Its key
  (`ca.key`) never leaves that volume; no sandbox, engine or other service mounts it. Its **name
  constraints** exclude the agents' providers (`anthropic.com`, `openai.com`, `chatgpt.com`
  and their subdomains): a certificate it signs for them fails verification, and the proxy
  never asks for one. Each host's certificate lasts 7 days, and is made again 2 days before
  its end. It exists with the cache off too (`EGRESS_CACHE_MAX` `0`): every run's GitHub
  calls need it.
- **Why GitHub is no longer excluded**: the CA must certify `github.com` and
  `api.github.com` for the proxy to relay them to the [GitHub gateway](github.md#the-github-gateway).
  The exclusion kept a leaked CA key from opening live tokens; since the same change, no
  sandbox's traffic to GitHub carries one, only the run token, which works from its own
  sandbox, through the gateway, while the run lasts. A key that leaks lets its holder read
  and change the GitHub traffic of the sandboxes running then (what they read and write, as
  the proxy does), not act as them elsewhere. `githubusercontent.com` is certifiable too: only
  GitHub's content hosts are relayed, for a work run that isn't a fork's (they carry no
  token), and neither relayed nor decrypted for the others unless you cache them. The
  providers' names stay excluded: the operator's credentials still go there, from the
  models service.
- **Trust in the sandbox**: for every run that reaches GitHub (all but research runs), and
  when its repository's grant has `cached_hosts` or its agent's calls are relayed (the
  Antigravity CLI's), the orchestrator
  asks the proxy for the CA's certificate (public, at `http://egress:3128/deckhand-ca.crt`)
  and puts it in the run's inbox folder, which its sandbox alone fetches from the broker at
  start (a run that can't stops). The sandbox's entrypoint adds it to a
  bundle with the image's own roots, which `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE` and `PIP_CERT` point at, and to
  Chromium's store (`~/.pki/nssdb`, with `certutil`). A tool that reads none of them refuses
  cached hosts' certificates, and fails rather than going round the proxy. When the
  orchestrator can't get the CA (the proxy doesn't answer), the run stops, saying so: it couldn't
  reach GitHub. (A research run, whose GitHub isn't relayed, then has no cached hosts, and
  an Antigravity CLI one on a plan stops.)
- **Never cached**, whatever `cached_hosts` says: the mandatory hosts below, the agent's and
  GitHub's (decrypted only to be relayed to the github service and the models service). Their traffic carries the run
  token, which the cache would refuse anyway. Nor a run's [container engine](mounts-and-engine.md#container-engine): its builds and
  containers don't trust the CA, so its connections keep the tunnel, and only plain HTTP is
  cached for them; caching in the engine itself is `docker: { cache: true }`'s.
- **An upstream certificate that doesn't verify** (expired, self-signed, for another name)
  is refused with a `502` saying so: the proxy never passes it on under its own CA. A
  private mirror whose CA isn't a public one can't be cached over HTTPS: leave it out of
  `cached_hosts`.
- A tunnel to a cached host that doesn't start with TLS (SSH on port 443, say) is passed on
  as is.

What this changes: the proxy now reads the requests and answers of the hosts you list in
`cached_hosts`, and holds a key that sandboxes trust for any host but those its name
constraints exclude. It stays acceptable because the proxy only uses it for the hosts you
listed, which are what you would cache anyway (public mirrors, without credentials: a
request with `Authorization`, `Cookie` or another credential-like header is sent on, never
kept); the key never leaves the proxy's volume, which neither sandboxes nor engines can
reach, and the proxy runs read-only, without capabilities; and a sandbox
trusting the CA gains nothing it could use: it reaches the same hosts as before, through
the same proxy. Someone who gets the key (from the host, or the proxy's volume) can
impersonate any other host to the sandboxes running then, for at most the CA's year, GitHub's
included (whose traffic from a sandbox carries no token), but not Anthropic's or OpenAI's
hosts (nor Google's, which the Antigravity CLI's runs relay, are excluded): treat the volume
like edge's data. Removing the volume (or `ca/`
in it) and restarting the proxy makes a new CA.

## Where a sandbox's hosts come from

**Restricted by default**: a sandbox reaches the mandatory hosts (below) and the hosts you
grant its repository, nothing else. You list them in one place per scope, the grants
folder, read again at each run:

| For        | Where                                   | Read        |
| ---------- | --------------------------------------- | ----------- |
| every repo | the mandatory hosts (below)             | built in    |
| every repo | `hosts` in `grants/default.yaml`        | at each run |
| one repo   | `hosts` in `grants/<owner>/<repo>.yaml` | at each run |

They add up: a run of `acme/api` reaches the mandatory hosts, then `default.yaml`'s, then
`acme/api.yaml`'s. Nothing narrows them: a repository's `.deckhand.yaml` has no `hosts` (one
there is ignored, with a warning in the dashboard and the run's log), and a mode has no key
for them, so every run of a repository reaches the same hosts.

Each entry is a host name (`registry.npmjs.org`), `*.domain` (any subdomain, at any depth,
not the domain itself: list both if you need both), or `*` (anything). Any port. An IP
address or a name without a domain (`172.17.0.1`, `cache`) works too: you decide what sits
next to the sandboxes. Hosts you list may resolve to private addresses (`*` alone doesn't
count, see above).

Why not the repository: its `.deckhand.yaml` is written by whoever can push to its default
branch, and a run can open a pull request that someone merges. If its own `hosts` counted, a
sandbox could get its way out by changing that file. A repository says what it needs in its
docs or onboarding issue; you add it to its grants file. The proxy's `403`, the sandbox's
instructions and the dashboard's repository panel all name these files.

**Mandatory hosts**, always allowed:

| Host                         | For                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `api.anthropic.com`          | Claude Code's runs only: WebFetch's domain check                                                      |
| `github.com`                 | git over HTTPS (`GITHUB_URL`), relayed to the [gateway](github.md#the-github-gateway)                 |
| `api.github.com`             | `gh` and the API (`GITHUB_API`), relayed to the [gateway](github.md#the-github-gateway)               |
| `*.githubusercontent.com`    | raw and LFS files, diffs, release downloads, avatars (relayed for checked runs)                       |
| `broker`, `github`, `models` | the services' names: the run's token and files, pushes, the agent's API calls, forwarded by the proxy |

That list was checked against Claude Code 2.1.300 (the pinned version) by reading the hosts
in its binary. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (set in the image) and the
credential in `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN`, Claude Code sends its API calls to the models service's name (`ANTHROPIC_BASE_URL`, which the proxy forwards to the models service,
see [The Claude credential](models.md#the-claude-credential)) and nothing else but WebFetch's domain
check to `api.anthropic.com`:

- not `platform.claude.com`: it refreshes OAuth credentials stored by `/login`, which a
  sandbox doesn't use (`setup-token` tokens aren't refreshed);
- not `claude.ai` / `claude.com`: interactive login only;
- not the telemetry, error reporting and update hosts (Statsig, Sentry, Datadog,
  `downloads.claude.ai`): non-essential traffic, off.

Check it again when you change `CLAUDE_CODE_VERSION`. A refused host shows up in the
orchestrator's logs (`Egress: refused <host> for <repo>#<n>`).

A Codex run's mandatory hosts are GitHub's and the services' names only: no `api.anthropic.com`,
and no `api.openai.com` either. Checked against Codex 0.162.1 (the pinned `CODEX_VERSION`)
through a proxy that logged every connection: with its calls sent to the models service's name
(`OPENAI_BASE_URL`) and the
settings `sandbox/agents/codex.sh` writes (analytics, update check, plugins, apps and remote
plugins off), it opens none. Without them it reaches `chatgpt.com`, `ab.chatgpt.com`,
`github.com` and `api.github.com` for its plugin marketplace and analytics. Its web search
runs on OpenAI's side, in the API call. Check it again when you change `CODEX_VERSION`.

An Antigravity CLI run's mandatory hosts are GitHub's, the services' names, and `agy`'s own:
`daily-cloudcode-pa.googleapis.com` and `www.googleapis.com` (relayed to the models service, see
[The Antigravity CLI's login](models.md#the-antigravity-clis-login)) and `antigravity-unleash.goog`
(feature flags) and `lh3.googleusercontent.com` (the account's avatar, which its eligibility
check needs). `play.googleapis.com` is refused for its runs, whatever the grants say. Checked against agy 1.4.0 (the pinned `AGY_VERSION`) through a proxy
that logged every connection; its update check is off (`AGY_CLI_DISABLE_AUTO_UPDATE`). Check
it again when you change `AGY_VERSION`.
