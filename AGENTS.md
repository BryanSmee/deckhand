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

Node 22. The listener has no dependencies; the dashboard has build-time ones (see
Conventions).

| Task            | Command                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests           | `node --test`                                                                                                                                                                                                                                               |
| Dashboard       | `cd dashboard && npm ci && npm test && npm run build` (types, tests, build)                                                                                                                                                                                 |
| Syntax check    | `node --check listener/server.mjs`, `bash -n sandbox/*.sh sandbox/agents/*.sh sandbox/agents/claude/install sandbox/deckhand-token sandbox/gh sandbox/git-credential-deckhand sandbox/pre-push engine/entrypoint.sh`, `node --check sandbox/deckhand-inbox` |
| Format          | `npx --yes prettier@3 --check .` (`--write` to fix)                                                                                                                                                                                                         |
| Dashboard (dev) | `cd dashboard && npm run dev` (proxies the API to a listener on `:8080`)                                                                                                                                                                                    |

Run the first four before pushing (the dashboard's when it changed). The sandbox you run in has **no Docker** and receives no
webhooks: test through the injectable seams below, and say in the pull request what you
could not run.

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
              onboarding.md (followed by docs/repo-config.md, copied into the image)
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
  Testing Library, named `*.spec.ts(x)`: Node 22 runs `*.test.ts` files itself, and
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
  request the operator's grants folder must grant: `mounts` only under a granted root, `hosts`
  only with `allow_repo_hosts: true` for that repo (or `"*"`), and never `*` or `*.<tld>`
  from a repo. A repo's `dockerfile` is built only with `allow_dockerfile`, its `preview`
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
- Cover the decisions that matter: allowlist and config narrowing, mount path checks,
  host wildcard matching, trigger parsing, queue persistence across a restart.

## Workflow

- Work happens on GitHub issues: one branch and pull request per issue, `Closes #<n>`,
  never push to `main`. Write everything in English.
- Until Deckhand runs itself, its runs come from PocketBerry's listener. That sandbox's user
  `CLAUDE.md` is mostly about PocketBerry (`fr.json`, pnpm, dev servers, databases `shiny`):
  ignore those parts here. Writing in English, stopping to ask and the needs-input marker
  still apply.
