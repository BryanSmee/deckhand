# Deckhand: guide for coding agents

Deckhand runs Claude Code on GitHub issues and pull requests: comment triggers, brainstorms,
inbox issues (ideas, bugs), GitHub Discussions, a sandbox container per issue, a dashboard. It is
self-hosted and bring-your-own-key: each operator creates their own private GitHub App and
runs their own server with their own Claude credentials. One deployment = one operator, Docker
only.

It is being extracted from PocketBerry's `infra/claude/`
(https://github.com/BryanSmee/shiny-piece/tree/main/infra/claude): port from there rather than
rewriting, and keep what already works (debounce, live comments, reactions, needs-input,
brainstorm sessions). The plan and its decisions: PocketBerry's PB-135 and issues #1–#7 here.

## Commands

Node 26. The listener has no dependencies; the dashboard has build-time ones (see
Conventions).

| Task            | Command                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests           | `node --test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Dashboard       | `cd dashboard && npm ci && npm test && npm run build` (types, tests, build)                                                                                                                                                                                                                                                                                                                                                                                                   |
| Syntax check    | `node --check listener/server.mjs`, `bash -n sandbox/*.sh sandbox/agents/*.sh sandbox/agents/claude/install sandbox/agents/codex/install sandbox/agents/antigravity/install sandbox/agents/antigravity/refresh sandbox/agents/npm-install sandbox/agents/release-install sandbox/deckhand-broker sandbox/deckhand-token sandbox/gh sandbox/git-credential-deckhand sandbox/pre-push engine/entrypoint.sh test/fixtures/fake-docker.sh`, `node --check sandbox/deckhand-inbox` |
| Format          | `npx --yes prettier@3 --check .` (`--write` to fix; `npx --yes prettier@3 --write --ignore-unknown <files>` for just the files you changed)                                                                                                                                                                                                                                                                                                                                   |
| Dashboard (dev) | `cd dashboard && npm run dev` (proxies the API to a listener on `:8080`)                                                                                                                                                                                                                                                                                                                                                                                                      |

Run the first four before pushing (the dashboard's when it changed). Work runs on this
repository start with the dashboard's packages installed (`setup` in `.deckhand.yaml`) and
the npm cache kept between runs.

Work runs also have a container engine (`docker`, `DOCKER_HOST=tcp://engine:2375`) when the
operator grants one (your prompt says whether this run has it), but never webhooks: test the
listener through the injectable seams below, and say in the pull request what you could not
run. The engine is another machine: `-v "$PWD:…"` mounts its empty
directory, not your clone, so send files with `tar` on stdin. With the engine:

```sh
# Build an image, from the root: listener, sandbox and proxy COPY from other directories.
docker build -t deckhand-listener -f listener/Dockerfile .
# Start it: ALLOWED_USERS is all it needs to come up. Ports answer on engine, not localhost.
docker run -d --name listener -p 8080:8080 -e ALLOWED_USERS=someone deckhand-listener
curl engine:8080/health
# The tests on another Node: a Debian image (bash and git for the fakes), jq, not root.
git ls-files -z | tar --null -T - -c | docker run --rm -i node:<v> sh -c \
  'apt-get update -qq && apt-get install -y -qq jq && mkdir /w && cd /w && tar x &&
   chown -R node . && su node -c "node --test"'
```

The engine is slower than the sandbox: a timing test failing there alone (`deliveries`,
`previews`) passes on its own, so rerun its file before you suspect the change. Build the images a change touches (Dockerfiles, and the files they `COPY`), and stop what you
started before you finish.

## Layout (target; build it as the issues land)

```
listener/     server.mjs (wiring), http.mjs (webhooks, dashboard API), tasks.mjs (queue),
              runs.mjs, restart.mjs, … (docs/architecture.md), runner/ (Docker backend),
              agents/ (each agent's specifics: install, env, hosts, session, normalize())
dashboard/    the dashboard: Preact + Vite + TypeScript, built to dist/ in the listener's image
sandbox/      base image: Dockerfile, entrypoint.sh, draft-pr.sh, pre-push, git credential
              helper and gh wrapper; agents/<name>.sh and agents/<name>/ (Claude Code's
              flags, installer, settings, hooks, progress.jq)
prompts/      sandbox.md (generic rules), idea.md, bug.md, discussion.md, brainstorm.md,
              analyze.md, onboarding.md (followed by docs/repo-config.md, copied into the
              image)
proxy/        egress proxy for sandboxes
engine/       container engine sidecar images (dockerd for Sysbox, podman/ for Podman)
compose.yaml  what an operator runs (publishes a port; no reverse-proxy labels)
docs/         setup, per-repo config reference, security model, architecture
```

## Conventions

- **No runtime dependencies.** The listener uses `node:http`, `node:crypto`, `node:fs` and the
  docker CLI only. Ask before adding a package.
- **The dashboard is the exception** (`dashboard/`, issue #22): Preact, Vite and TypeScript,
  with hand-written CSS Modules, no UI or chart library. Its packages are build-time only: the
  image's build stage turns them into static files in `dashboard/dist/`, which the listener
  serves; the released image has no `node_modules`. `src/types.ts` is the contract with
  `http.mjs` (`api/state`) and `runlog.mjs` (the log stream): change them together. Tests: Vitest and
  Testing Library, named `*.spec.ts(x)`: Node runs `*.test.ts` files itself, and
  `node --test` must leave them alone.
- **ESM** (`.mjs`), small functions, comments that explain _why_, briefly.
- **Nothing project-specific.** No PocketBerry, Linear, pnpm or Postgres in the listener, base
  image or generic prompts: a project brings those through its per-repo config, Dockerfile
  and extra instructions. Names, hosts and volume names come from settings.
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
  any (issue #151). A repo's `dockerfile` is built only with `allow_dockerfile`, its `preview`
  hook runs only with `allow_preview`, branch Dockerfiles only with
  `allow_branch_docker_images` (all three in the grants folder), never for fork pull requests.
- **No long-lived token in a sandbox:** short-lived installation tokens for that run's repo,
  through the listener's broker.
- **No host mounts** unless the operator's config grants a root; requested paths are
  resolved (`..`, symlinks) before the check. Read-only unless the operator grants
  read-write.
- **Network restricted by default** through the egress proxy; containers run with
  `--cap-drop ALL` and `no-new-privileges`. The Docker socket stays in the listener.
- Verify every webhook's HMAC with a constant-time comparison.

## Testing

- `node --test` with `node:assert`. Inject what touches the outside: `fetch` for GitHub,
  the runner for Docker, a clock for timers, a temp dir for state files.
- Shared fakes live in `test/helpers.mjs` (`listening`, `serve`, `tempDir`, `testConfig`,
  `recordingFetch`) and `test/fixtures/` (the fake `docker` of `server.test.mjs`): reuse them
  rather than write another copy. A temp dir goes with its test (`tempDir(t)`).
- `server.test.mjs` starts a listener per test, the suite's slowest part: one wiring test per
  area there, the cases themselves in the module's own unit tests.
- Dashboard specs share `dashboard/src/testUtils.ts` (`mockApi`, `makeTask`, `makeState`) and
  `vitest.setup.ts` (the global stubs and cleanup).
- Cover the decisions that matter: allowlist and config narrowing, mount path checks,
  host wildcard matching, trigger parsing, queue persistence across a restart.

## Workflow

- Work happens on GitHub issues: one branch and pull request per issue, `Closes #<n>`,
  never push to `main`. Write everything in English.
- Until Deckhand runs itself, its runs come from PocketBerry's listener. That sandbox's user
  `CLAUDE.md` is mostly about PocketBerry (`fr.json`, pnpm, dev servers, databases `shiny`):
  ignore those parts here. Writing in English, stopping to ask and the needs-input marker
  still apply.
