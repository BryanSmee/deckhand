# Deckhand: guide for coding agents

Deckhand runs Claude Code on GitHub issues and pull requests: comment triggers, brainstorms,
inbox issues (ideas, bugs), GitHub Discussions, a sandbox container per issue, a dashboard. It is
self-hosted and bring-your-own-key: each operator creates their own private GitHub App and
runs their own server with their own Claude credentials. One deployment = one operator, on
Docker Compose (`compose.yaml`) or Kubernetes (`deploy/kubernetes/`, the Helm chart in
`deploy/helm/deckhand/`, docs/kubernetes.md).

It started as the issue runner of another project, PocketBerry, and was extracted from it: keep
what already works (debounce, live comments, reactions, needs-input, brainstorm sessions)
rather than rewriting it. Its decisions are in this repository's issues and pull requests.

## Commands

Node 26. The GitHub gateway has one dependency, graphql-js, bundled into a file before it runs
(the github service's image); the dashboard has build-time ones (see Conventions).

| Task            | Command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests           | `node --test --test-force-exit --import ./test/blocking-stdout.mjs --test-timeout=120000` (after `cd listener/vendor && npm ci && npm run build`, which bundles graphql-js; `--test-force-exit`: a file whose tests are done exits even if something it started is left open, #521; the `--import`: without it, that exit may lose the file's last results, #563; `--test-timeout`: CI's, a test that hangs fails in 2 min rather than holding the run forever)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Dashboard       | `cd dashboard && npm ci && npm test && npm run build` (types, tests, build)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Docs site       | `cd docs && npm ci && npm run build && cd .. && node --test test/docs-links.test.mjs` (the VitePress site, then every page's anchors as the site renders them; `npm run dev` in `docs/` to preview)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Syntax check    | `node --check edge/server.mjs orchestrator/server.mjs runner/server.mjs broker/server.mjs github/server.mjs models/server.mjs`, `for f in sandbox/*.sh sandbox/agents/*.sh sandbox/agents/claude/install sandbox/agents/codex/install sandbox/agents/antigravity/install sandbox/agents/antigravity/refresh sandbox/agents/npm-install sandbox/agents/release-install sandbox/deckhand-token sandbox/gh sandbox/git-credential-deckhand sandbox/pre-push engine/entrypoint.sh test/fixtures/fake-docker.sh test/fixtures/fake-opa.sh test/fixtures/fake-kubectl.sh deploy/kubernetes-e2e/run.sh; do bash -n "$f"; done` (one at a time: `bash -n a b` reads `b` as an argument of `a`; it prints what fails), `node --check policy-service/service.mjs machine/deckhand-machine.mjs sandbox/deckhand-inbox sandbox/deckhand-files sandbox/deckhand-tagged sandbox/deckhand-permissions deploy/kubernetes/secrets.mjs deploy/kubernetes-e2e/fakes.mjs`, `sh -n deploy/kubernetes/check-isolation.sh` |
| Format          | `npx --yes prettier@3 --check .` (`--write` to fix; `npx --yes prettier@3 --write --ignore-unknown <files>` for just the files you changed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Dashboard (dev) | `cd dashboard && npm run dev` (proxies the API to edge on `:8080`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Screenshots     | `cd dashboard && npm run screenshots` (the docs' pictures in `docs/images/`, the README's hero too: the dev server with the fake API of `src/shots.ts`, every page at 1440 and 390 px in both themes; needs Playwright and its Chromium, global ones are fine). Run it when a change alters a page they show                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Run the tests, the syntax check and the format check before pushing, plus the dashboard's when it changed and the docs site's when `docs/` did. CI runs them too, a job
each, on every pull request and push to `main` (`.github/workflows/checks.yml`, GitHub-hosted
runners): the tests twice, as a user that isn't root and as root in `node:26`, both with the
real `opa` that `policy-service/Dockerfile` pins and a Redis 7 beside them (`TEST_REDIS_URL`),
so none of their tests skips there. A
`kubernetes` job renders `deploy/kubernetes` with kustomize, alone and with each component, and
the Helm chart, validates both with kubeconform, and runs `test/helm-chart.test.mjs` (the chart
held to the base; it skips without `helm` and `kustomize` on the PATH, and fails the job if it
does there), and renders `deploy/kubernetes-e2e` the same way, with
`test/kubernetes-e2e-overlay.test.mjs` (the overlay held to `run.sh`'s guard, its patches
landed; kustomize alone, same skip). A change to the base goes to the chart too, a new component with its values. A pull request's checks can
point at that run. Work runs on this
repository start with the dashboard's packages installed and graphql-js bundled (`setup` in
`.deckhand.yaml`) and the npm cache kept between runs.

Work runs also have a container engine (`docker`, `DOCKER_HOST=tcp://engine:2375`) when the
operator grants one (your prompt says whether this run has it), but never webhooks: test edge
and the orchestrator through the injectable seams below, and say in the pull request what you could not
run. The engine is another machine: `-v "$PWD:…"` mounts its empty
directory, not your clone, so send files with `tar` on stdin. With the engine:

```sh
# Build an image, from the root: edge, the orchestrator, the runner, the policy service, the
# sandbox and the proxy COPY from other directories.
docker build -t deckhand-edge -f edge/Dockerfile .
docker build -t deckhand-orchestrator -f orchestrator/Dockerfile .
docker build -t deckhand-runner -f runner/Dockerfile .
docker build -t deckhand-github -f github/Dockerfile .
# Start edge: ALLOWED_USERS is all it needs to come up. Ports answer on engine, not localhost.
docker run -d --name edge -p 8080:8080 -e ALLOWED_USERS=someone deckhand-edge
curl engine:8080/health
# The whole stack, as an operator runs it (one copy each; --scale orchestrator=2 for a
# handover): every service, then `docker compose -p <name> down -v` once seen.
docker compose -p dh --env-file <your .env> up -d --build
# The tests on another Node: a Debian image (bash and git for the fakes), jq, not root, and
# graphql-js bundled first (listener/vendor/graphql.mjs isn't committed).
git ls-files -z | tar --null -T - -c | docker run --rm -i node:<v> sh -c \
  'apt-get update -qq && apt-get install -y -qq jq && mkdir /w && cd /w && tar x &&
   chown -R node . && su node -c "cd listener/vendor && npm ci && npm run build && cd ../.. &&
   node --test --test-force-exit --import ./test/blocking-stdout.mjs --test-timeout=120000"'
# The same as root, as CI's tests-root job runs it (--init reaps the fake docker's orphans).
git ls-files -z | tar --null -T - -c | docker run --rm -i --init node:<v> sh -c \
  'apt-get update -qq && apt-get install -y -qq jq && mkdir /w && cd /w && tar x &&
   cd listener/vendor && npm ci && npm run build && cd ../.. &&
   node --test --test-force-exit --import ./test/blocking-stdout.mjs --test-timeout=120000'
```

The engine is slower than the sandbox: a timing test failing there alone (`deliveries`)
passes on its own, so rerun its file before you suspect the change. Build the images a change touches (Dockerfiles, and the files they `COPY`), and stop what you
started before you finish.

## Layout (target; build it as the issues land)

```
lib/          what every service shares, copied into each image: yaml, settings, redact, log (its
              lines, a request's ID), http, health (every service's /health), files, drain,
              tokens, service tokens (service-token.mjs), capped.mjs (keepLast(): a capped Map
              whose fresh value moves last, #887), pool.mjs (mapLimited(): a worker pool, #974), the store (store.mjs, store-file.mjs,
              store-redis.mjs and its client resp.mjs, the arguments both backends check in
              store-checks.mjs; store-map.mjs: a Map kept there one key per item), the S3 client
              (s3.mjs, #605) and blob storage over it (blobs.mjs: BLOB_URL's backends, #606),
              metrics (every service's registry and METRICS_PORT's server, #651), shots (the
              screenshots' names, sizes and types the broker accepts and edge serves, #609), the
              calls between services (services.mjs: which calls which; service-client.mjs,
              broker-client.mjs; fence.mjs: the orchestrator's fencing epoch), active.mjs (a
              lease's active/passive copies), seal.mjs (secrets sealed in the store),
              fingerprints.mjs (redacting secrets a service doesn't hold), policy-files.mjs (the
              operator's policy files), subnets.mjs, upstream.mjs (forwarding a call as it
              streams)
edge/         edge (#506), the only service the internet reaches: server.mjs (wiring), http.mjs
              (webhooks, /setup, sign-in, the dashboard's files), forward.mjs (the dashboard's API
              passed on to the orchestrator), internal.mjs (the deliveries' stream and the App's
              public parts, for the orchestrator), app.mjs (the webhook secret, the OAuth
              client's), oauth.mjs (MCP clients' sign-in: an OAuth 2.1 server over GitHub's),
              client.mjs (what the orchestrator calls it with), metrics.mjs (its metrics: the
              webhooks, the requests by route, sign-ins and sessions), shots.mjs (the runs'
              screenshots, passed on to the broker)
orchestrator/ the orchestrator (#506): server.mjs (wiring: its lease, then the queue and the runs'
              lives, from ../listener/'s modules); two copies, active/passive
listener/     the modules edge and the orchestrator run (no entry point of its own): http.mjs (the
              dashboard's API and the deliveries, the orchestrator's), tasks.mjs (queue),
              runs.mjs, restart.mjs, … (docs/contributing/architecture.md), runner/ (Docker and
              Kubernetes backends), agents/ (each agent's specifics: install, env, hosts, session,
              normalize(); the credentials' names, credentials.mjs)
github/       the github service (#502): the only one with the GitHub App's key; server.mjs
              (wiring), service.mjs (its API, who may call what), runs.mjs (the runs' state in its
              store), app.mjs (the App's credentials), client.mjs (what the orchestrator and
              edge call it with), metrics.mjs (its API calls, rate limit, git operations); it
              runs listener/'s GitHub and git gateways (github-*.mjs, git-gateway.mjs)
runner/       the runner service (#503): the only one with the Docker socket or the Kubernetes
              API; server.mjs (wiring), service.mjs (its API, who may call what), client.mjs
              (what the orchestrator calls it with), logs.mjs, events.mjs, spec-check.mjs,
              builds.mjs, metrics.mjs (its own, #659); it runs listener/runner/'s backends and
              images.mjs
policy-service/ the policy service (#501): long-lived `opa` servers evaluating the operator's and
              the repos' policies for the orchestrator; its own image, no network but its callers';
              metrics.mjs (its decisions, their time, the operator's policies' loads)
policy/       Deckhand's default policies (*.rego), copied into the policy service's image
dashboard/    the dashboard: Preact + Vite + TypeScript, built to dist/ in edge's image;
              screenshots/ takes the docs' pictures (run.mjs, hero.html) against src/shots.ts
sandbox/      base image: Dockerfile, entrypoint.sh, draft-pr.sh, pre-push, git credential
              helper and gh wrapper; agents/<name>.sh and agents/<name>/ (Claude Code's
              flags, installer, settings, hooks, progress.jq)
prompts/      sandbox.md (generic rules), idea.md, bug.md, discussion.md, brainstorm.md,
              analyze.md, onboarding.md (followed by the config's reference, its pages in
              prompts.mjs CONFIG_PAGES, copied into the image)
proxy/        egress proxy for sandboxes
machine/      deckhand-machine.mjs: the driver that runs a user's machine tasks there (#599), one
              file, no dependency, attached to each release; its loop tested against a fake /mcp
              and test/fixtures/fake-claude.mjs
broker/       the broker service: the tokens' signing key, the live runs and their files, the
              endpoints sandboxes call about their own run (docs/contributing/services.md);
              metrics.mjs (the tokens signed, renewed and refused, the live runs, the inbox polls)
models/       the models service (#504): the only one holding the agents' credentials; the
              agents' API endpoints (upstream.mjs, anthropic.mjs, openai.mjs, google.mjs), the
              plans' logins (chatgpt.mjs, antigravity-login.mjs, logins.mjs: sealed in its
              store, one refresh for every copy), runs.mjs (whose call it is), http.mjs
engine/       container engine sidecar images (dockerd for Sysbox, podman/ for Podman)
compose.yaml  what an operator runs (publishes a port; no reverse-proxy labels)
deploy/       kubernetes/: the manifests for a cluster (#396), a kustomize base and its components
              (redis, buildkit, engine, blobs), secrets.mjs (the Secrets the base doesn't hold) and
              check-isolation.sh; test/kubernetes-manifests.test.mjs holds them to CALLS (docs/kubernetes/isolation.md);
              helm/deckhand/: the same as a Helm chart (#570), whose default values render the
              base's objects (test/helm-chart.test.mjs); kubernetes-e2e/: a run from start to end on a
              cluster, every service updated mid-run (run.sh, its fakes;
              docs/contributing/kubernetes-e2e.md);
              grafana/deckhand.json: the Grafana dashboard, alerts/: the alert rules and their
              promtool tests (#661; docs/guides/metrics.md), the chart carrying copies of both in
              helm/deckhand/files/, held the same by test/metrics-deploy.test.mjs
docs/         the docs, and the site built from them (VitePress, build-time only like the
              dashboard's, published to GitHub Pages by .github/workflows/docs.yml): index.md (the
              site's home), get-started/ (what Deckhand is, the quick start, core ideas),
              images/ (the pictures dashboard/screenshots/ takes, out of every image's build),
              guides/ (one page per task: install, a stable tunnel, the GitHub App, the dashboard, inboxes, the agents,
              logs and metrics, updating and its upgrade notes, the store…; setup.md, the page
              they were split from, only says where each section went, #984), reference/
              (settings.md and settings/: the server settings, a page per area; server-folder.md:
              the server folder, the grants, the operator's policies; comment-commands.md), per-repo
              config reference (repo-config.md: the core keys; repo-config/: modes,
              reviews, issues, policies, policy inputs), the security model (security.md: a one-page
              overview; security/: the threat model by area, #985), Kubernetes (kubernetes.md:
              the overview and requirements; kubernetes/: installing with Helm or kustomize,
              updating, components, sandboxes, isolation, metrics), contributing/ (index.md; the
              architecture split into short pages: architecture.md, runs, replies, run-logs, queue,
              reviews, external-runs, restarts, agents, modules; services.md, each-service.md,
              upgrades.md; the dashboard's languages; the end-to-end check on a cluster), design/
              (the dashboard's redesign); .vitepress/ (config.mjs: the
              sidebar, links out of docs/ sent to GitHub; slug.mjs: GitHub's heading slugs),
              kept out of the images (.dockerignore). test/docs-links.test.mjs holds every
              docs/<page>.md#<anchor> reference to a heading that exists, and the site's anchors
              to GitHub's
```

## Conventions

- **No runtime dependencies.** Edge and the orchestrator use `node:http`, `node:crypto` and
  `node:fs` only (the docker CLI is the runner's). Ask before adding a package.
- **graphql-js is the one exception** (`listener/vendor/`, issue #406): the GitHub gateway must
  parse the runs' GraphQL to check their writes (`github-graphql.mjs`), and a parser of its own
  would be the bigger risk. Pinned to an exact version (`package-lock.json` too), and bundled
  with esbuild into one file, `listener/vendor/graphql.mjs` (not committed), in the github
  service's image's build stage (it runs the gateway, #502): the released image has no
  `node_modules`. `graphql.entry.mjs`
  lists what the gateway takes from it. GitHub's schema is pinned beside it
  (`github.graphql`): `npm run schema` there reads it again through `gh`, on purpose, and its
  diff is reviewed.
- **The dashboard is the exception** (`dashboard/`, issue #22): Preact, Vite and TypeScript,
  with hand-written CSS Modules, no UI or chart library. Its packages are build-time only: the
  image's build stage turns them into static files in `dashboard/dist/`, which edge
  serves; the released image has no `node_modules`. `src/types.ts` is the contract with
  `http.mjs` (`api/state`) and `runlog.mjs` (the log stream): change them together. Tests: Vitest and
  Testing Library, named `*.spec.ts(x)`: Node runs `*.test.ts` files itself, and
  `node --test` must leave them alone.
- **So is the docs site** (`docs/`, issue #982): VitePress, and Mermaid for the ` ```mermaid `
  blocks GitHub draws too (#996, drawn in the browser by `docs/.vitepress/theme/Mermaid.vue`),
  pinned with their lock file in `docs/package.json`, build-time only. Its files stay out of every image (`.dockerignore`): the
  sandbox image copies `docs/` for its pages. The pages are plain Markdown that reads the same on
  GitHub: relative links, GitHub's heading anchors, no Vue components outside `index.md`.
- **ESM** (`.mjs`), small functions, comments that explain _why_, briefly.
- **Files over 800 lines can't grow** (1,500 for tests; #1065): an agent adds to the file it is
  already in and nothing else pushes back. `test/file-sizes.test.mjs` holds each to its number
  in `test/file-sizes.json`, which only goes down: split the file (a module of its own for the
  part you touch), never raise its number to make room. A file that shrank lowers its number in
  the same pull request. A number raised against main's fails unless its entry says why
  (`{ "lines": 900, "why": "#<issue>" }`), which the review weighs.
- **Nothing project-specific.** No PocketBerry, Linear, pnpm or Postgres in the services, base
  image or generic prompts: a project brings those through its per-repo config, Dockerfile
  and extra instructions. Names, hosts and volume names come from settings.
- **Sandboxes outlive an update, one update**: an endpoint they call is kept through the
  update that stops calling it, so the sandboxes in flight while it happens still reach it.
  The next update may remove it: its last callers were started before the one that stopped
  calling it (`docker ps --filter label=deckhand.run` lists the running sandboxes;
  `docs/contributing/restarts.md`, Restarts). Not every older release's sandboxes. That is one of the
  cases of [Runs in flight](#runs-in-flight) below.
- **GitHub only.** Issues, labels and sub-issues; branches `issue-<n>-<slug>`.
- **Naming.** Never use "Claude" or "Anthropic" in the product, image or repo names; "runs
  Claude Code" in text is fine. Claude Code is never bundled in an image: it installs on
  first start, at a pinned version.

## Security rules (don't weaken without an issue saying so)

- **Fail closed:** no allowlist, no start. Unknown repos, users or events are ignored.
- **Per-repo config is read from the default branch only**, and can only narrow the
  operator's settings (users, parallel runs), never widen them. What would widen them is a
  request the operator's grants folder must grant: `mounts` only under a granted root. Hosts
  are the grants folder's only (`default.yaml`, `<owner>/<repo>.yaml`): a repo can't add
  any (issue #151). A repo's `dockerfile` is built only with the `dockerfile` grant, branch
  Dockerfiles only with `branch_docker_images`, never for fork pull requests. The yes-or-no grants are the operator's policies' (#498:
  `allow_grant`, asked per repository of the operator's layer alone, nothing granted by default,
  `listener/grants.mjs` GRANTS); `docker`, `workflows` and auto-merge only one repository at a
  time (best effort: a rule that also gives them to `*/*` or `<owner>/*` gives them to none;
  other wide rules aren't caught). A repo's own rules never grant them.
- **Policies: a decision is allowed when an allow rule matches and no deny rule does** (a deny
  always wins; no allow, refused; a policy error, refused: `listener/policies.mjs`). The
  operator's layer (Deckhand's `policy/` under the grants folder's `policy/`, by file name) has
  the allow rules that are the ceiling. A repo's `.deckhand/policy/` is a layer of its own, its
  packages moved under `deckhand_repository` (`namespaced()`): it can only narrow that
  ceiling (its deny rules apply to every run), except for its own modes, which need its allow
  rules and the operator's.
- **Capabilities: what a run's sandbox gets is decided at its start** by the policies
  (`allow_capabilities`, `deny_capabilities`), greedily, and checked in code whatever they say
  (`listener/capabilities.mjs`): each capability's dependencies, and `pull` of a private
  repository with `internet` refused unless the operator's allow rule gives `pull+internet`. A
  run that fails them, or whose policies fail, doesn't start. Every run gets only its sandbox,
  the agent's API, its own endpoints and its prompt beyond them.
- **The agents' credentials are the models service's alone** (#504): its environment and the
  credentials folder (read only), the refreshed logins sealed in its store. The orchestrator learns
  their names and fingerprints only; a run's agent token gets its own agent's credential alone
  (its `agent` claim, `models/runs.mjs`).
- **No GitHub token in a sandbox:** it holds only a run token (and its agent's token), signed
  by the broker service, which alone holds the key, bound to its network or pod and dead with
  the run (`lib/tokens.mjs`,
  docs/security/tokens.md#run-tokens). The egress proxy relays its GitHub calls to the GitHub gateway
  (`listener/github-gateway.mjs`) in the github service (`github/`, #502), the only one holding
  the App's key, which adds a short-lived installation token for that run's repo and redacts
  what it writes. That token only reads: a write the policies allowed
  (`allow_github`) gets one of its own with only the write permission it needs, and a push
  goes through the git gateway (`allow_push`). No allow rule, no write.
- **No host mounts** unless the operator's config grants a root; requested paths are
  resolved (`..`, symlinks) before the check. Read-only unless the operator grants
  read-write.
- **Network restricted by default** through the egress proxy; containers run with
  `--cap-drop ALL` and `no-new-privileges`. The Docker socket (and the Kubernetes API's
  credentials) stays in the runner service, never in edge or the orchestrator; the runner checks every
  sandbox spec against the grants again (`runner/spec-check.mjs`), asking the policy service
  for the operator's grants itself.
- **A mode says nothing of what its runs may do** (`listener/modes.mjs`: its volumes, agent
  defaults, trigger, prompt): their capabilities, writes and pushes are the policies' alone.
- **Edge holds the webhook secret, the session key and the OAuth client's, nothing else; the
  orchestrator holds no secret** (#506, a test reads compose.yaml's environments and volumes):
  no setting of the orchestrator's names one, and it has no way out. The orchestrator takes a
  dashboard user's login from edge's service token alone (`listener/services-http.mjs`), and
  its lease's fencing epoch goes with every call to the github service, the runner and the
  broker, which refuse an older one.
- Verify every webhook's HMAC with a constant-time comparison (edge, `edge/http.mjs`).

## Runs in flight

An update never waits for the runs (#441): sandboxes keep running, the base image may lag the
services, and the next orchestrator picks up the runs the last one left. A change to the
contract between the services and the sandbox breaks those runs unless it says how it doesn't:
the variables a run starts with (`DECKHAND_CA`, `TASK_DIGEST`, the URLs), the endpoints a
sandbox calls (broker, edge, the gateways through the proxy), the egress proxy's answers (which
hosts it decrypts, relays or tunnels), a run's state in the store, the token's claims, and the
sandbox's scripts (`entrypoint.sh`, `deckhand-*`, the agents' hooks). #393 passed `DECKHAND_CA`
as a URL that older images read as a missing file: their runs trusted no CA and failed later on
GitHub's TLS, without a word.

- **Check the three cases** before pushing:
  - **running sandboxes under the new services**: their old scripts and their old variables
    call the new endpoints (the rule above);
  - **new runs on an older sandbox image**: the base image lags the services (compose's
    `sandbox` service exits at once, so an updater that follows running containers never pulls
    it; a release publishes its images in parallel), and a repository's image is built from
    that base;
  - **runs the next orchestrator picks up**: their state in the store, and what the broker,
    the proxy and the gateways decide for them, were written under the old rules.
- **Say so in the pull request**, under a "Runs in flight" heading: "None affected", or which
  runs break and how they fail.
- **When runs break, give the options**, and pick one: a compatibility shim on the services'
  side (an old endpoint kept, answering where to go, as above); a fallback in the sandbox's
  scripts that reads both forms; a check that fails the run at once with what to run
  (`docker compose pull sandbox`); or a one-time recovery (the commands that find and stop the
  broken runs), written in the pull request for the operator.
- **Never fail silently.** A run that can't work stops at its start with a message saying why,
  not at its first GitHub call with a TLS error.

The details, and how to find the runs an update broke: `docs/contributing/restarts.md`, Runs in flight.

## Testing

- `node --test` with `node:assert`. Inject what touches the outside: `fetch` for GitHub,
  the runner for Docker, a clock for timers, a temp dir for state files.
- Shared fakes live in `test/helpers.mjs` (`listening`, `serve`, `tempDir`, `testConfig`,
  `recordingFetch`) and `test/fixtures/` (the fake `docker` of `orchestrator-server.test.mjs`):
  reuse them rather than write another copy. A temp dir goes with its test (`tempDir(t)`).
- The suite passes as root and as any other user, and inside a Deckhand sandbox (Deckhand
  testing itself): CI runs it both ways. A test whose subject is "a user can't write here"
  skips as root with its reason (`{ skip: isRoot && "root writes anywhere" }`, `isRoot` from
  `test/helpers.mjs`), its logic covered through a `stat` seam where the code has one
  (`resolveMounts`). A sandbox script a test spawns gets `scriptEnv(t, extra)`, never the
  tests' own environment: in a sandbox that one holds the run's settings, and
  `DECKHAND_TOKEN_FILE` unset would read the run's real token.
- The pure-Node tests pass on native Windows too (#565), which no CI job runs: what only
  POSIX has (bash and the sh fakes, file modes, Linux's mount paths, signals) skips
  there with a reason from `test/helpers.mjs` (`{ skip: needsBash }`, `needsModes`,
  `needsPosixPaths`…; `assertMode()` for a mode checked in passing). Paths are
  built with `join()` and compared through `posix()` or `RegExp.escape()`, never with a
  hard-coded `/`; a Node script is spawned through `process.execPath`, not its shebang; and
  `.gitattributes` checks every file out with LF.
- Flaky is a bug, fixed at its cause, never retried away (#563). Ports: the OS's (port 0),
  never one probed free then handed on; a service that restarts is reached through a port the
  test holds (`forwarder`), or one the OS never hands out (`listenToRestart`). Time: an injected
  clock (or `t.mock.timers`) rather than a wall-clock bound, and a wait for what the test
  asserts on rather than a fixed delay.
- `orchestrator-server.test.mjs` starts edge and the orchestrator (and the runner beside them)
  per test, the suite's slowest part: one wiring test per area there, the cases themselves in
  the module's own unit tests. Its `handOver()` starts the orchestrator's next copy, waiting
  for the lease, before it stops the one acting. `edge-server.test.mjs` starts edge alone.
- Dashboard specs share `dashboard/src/testUtils.ts` (`mockApi`, `makeTask`, `makeState`) and
  `vitest.setup.ts` (the global stubs and cleanup).
- Cover the decisions that matter: allowlist and config narrowing, mount path checks,
  host wildcard matching, trigger parsing, queue persistence across a restart.

## Workflow

- Work happens on GitHub issues: one branch and pull request per issue, `Closes #<n>`,
  never push to `main`. Write everything in English.
- Most pull requests come from Deckhand's own runs on this repository; a person's are held to
  the same rules. How to contribute: CONTRIBUTING.md; how to report a vulnerability:
  SECURITY.md.
