# Deckhand: guide for coding agents

Deckhand runs Claude Code on GitHub issues and pull requests: comment triggers, brainstorms,
inbox issues (ideas, bugs, discussions), a sandbox container per issue, a dashboard. It is
self-hosted and bring-your-own-key: each operator creates their own private GitHub App and
runs their own server with their own Claude credentials. One deployment = one operator, Docker
only.

It is being extracted from PocketBerry's `infra/claude/`
(https://github.com/BryanSmee/shiny-piece/tree/main/infra/claude): port from there rather than
rewriting, and keep what already works (debounce, live comments, reactions, needs-input,
brainstorm sessions). The plan and its decisions: PocketBerry's PB-135 and issues #1–#7 here.

## Commands

Node 22, no dependencies (see Conventions).

| Task         | Command                                                    |
| ------------ | ---------------------------------------------------------- |
| Tests        | `node --test`                                              |
| Syntax check | `node --check listener/server.mjs`, `bash -n sandbox/*.sh` |
| Format       | `npx --yes prettier@3 --check .` (`--write` to fix)        |

Run all three before pushing. The sandbox you run in has **no Docker** and receives no
webhooks: test through the injectable seams below, and say in the pull request what you
could not run.

## Layout (target; build it as the issues land)

```
listener/     server.mjs (webhooks, queue, runs, dashboard API), dashboard.html, runner/ (Docker backend)
sandbox/      base image: Dockerfile, entrypoint.sh, draft-pr.sh, pre-push, progress.jq,
              managed-settings.json, git credential helper and gh wrapper
prompts/      sandbox.md (generic rules), idea.md, bug.md, discussion.md, brainstorm.md
proxy/        egress proxy for sandboxes
compose.yaml  what an operator runs (publishes a port; no reverse-proxy labels)
docs/         setup, per-repo config reference, security model
```

## Conventions

- **No runtime dependencies.** The listener uses `node:http`, `node:crypto`, `node:fs` and the
  docker CLI only; the dashboard is plain HTML served by the listener, no build step. Ask
  before adding a package.
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
  operator's settings (users, hosts, mounts), never widen them. Branch Dockerfiles only with
  `allow_branch_docker_images`, never for fork pull requests.
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
