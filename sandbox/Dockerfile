# Deckhand's base sandbox image: a container per issue that clones the repository, runs an
# agent (Claude Code, Codex or the Antigravity CLI) without permission prompts, and pushes a branch. Built from
# the repository root (compose.yaml), as it also takes ../prompts/sandbox.md.
#
# The harness only: no project toolchain. A repo brings its own with a Dockerfile FROM this
# image (`ARG DECKHAND_BASE` / `FROM $DECKHAND_BASE`, see ../docs/repo-config.md), which the
# listener builds; without one, its runs use this image as is. Both hold a read-only copy of
# Deckhand's own source in /usr/local/share/deckhand/src (the source stage below).
#
# No agent is in the image: each installs per version into a shared volume before the first
# run that needs it (Claude Code: agents/claude/install puts the pinned CLAUDE_CODE_VERSION
# into the /opt/claude-code volume; Codex: agents/codex/install, CODEX_VERSION, /opt/codex;
# both through agents/npm-install; the Antigravity CLI: agents/antigravity/install, AGY_VERSION,
# /opt/antigravity, through agents/release-install).
# One image for every agent: what is an agent's own is in agents/<name>.sh and
# agents/<name>/, copied to /usr/local/share/deckhand-agents. GitHub
# access goes through the listener's token broker (git-credential-deckhand, the gh wrapper):
# no token or SSH key is ever mounted.

# Deckhand's own source, read-only, for the runs that write a repo's .deckhand.yaml
# (../prompts/onboarding.md): the base image's tools, how setup and caches run, how the
# listener reads the config. Assembled here so the final image gets it in one layer, root's
# and not writable by node whatever the build context's modes. No dashboard/ or test/. On the
# build machine's platform: the same files for every architecture, so no QEMU run for arm64.
# A local build copies these folders as they are on disk (.dockerignore leaves out secrets).
FROM --platform=$BUILDPLATFORM node:26-bookworm AS source
WORKDIR /src
COPY docs/ docs/
COPY prompts/ prompts/
COPY sandbox/ sandbox/
COPY listener/ listener/
COPY server.example/ server.example/
COPY compose.yaml AGENTS.md README.md ./
# The release it is (a git tag, .github/workflows/release-workflow.yml); "dev" from source.
ARG DECKHAND_VERSION=dev
RUN echo "$DECKHAND_VERSION" > VERSION && chmod -R u=rwX,go=rX .

FROM node:26-bookworm

# gh from GitHub's apt repository. The docker CLI with buildx and compose from Docker's, no
# daemon: a run granted a container engine talks to it (DOCKER_HOST, set by the listener).
# certutil (libnss3-tools): Chromium trusts the egress proxy's CA through it (entrypoint.sh).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -d /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh git ripgrep jq less procps unzip libnss3-tools \
      docker-ce-cli docker-buildx-plugin docker-compose-plugin; \
    rm -rf /var/lib/apt/lists/*

# A headless Chromium for checking pages: the Playwright MCP server gives the agent browser
# tools (navigate, click, screenshots it can look at, console), and the same Playwright
# serves scripts. One Playwright, the MCP server's own, so a single browser matches it.
# CJK and emoji fonts, so screenshots don't show boxes.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g @playwright/mcp@0.0.82 \
    && pw=/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright \
    && ln -s "$pw" /usr/local/lib/node_modules/playwright \
    && ln -s "$pw/cli.js" /usr/local/bin/playwright \
    && playwright install --with-deps chromium \
    && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force \
    && chmod -R a+rX /ms-playwright

# Git over HTTPS with the broker's tokens; gh through its wrapper, ahead of /usr/bin/gh.
COPY sandbox/deckhand-broker sandbox/deckhand-token sandbox/git-credential-deckhand sandbox/gh \
    /usr/local/bin/
RUN git config --system credential.helper deckhand \
    && git config --system credential.useHttpPath false

ENV GH_PROMPT_DISABLED=1

COPY sandbox/pre-push /usr/local/share/git-hooks/pre-push
COPY prompts/sandbox.md /usr/local/share/deckhand-sandbox.md
COPY sandbox/entrypoint.sh /usr/local/bin/deckhand-entrypoint
COPY sandbox/deckhand-inbox /usr/local/bin/deckhand-inbox
COPY sandbox/draft-pr.sh /usr/local/bin/sandbox-draft-pr
COPY sandbox/agents/ /usr/local/share/deckhand-agents/

# Claude Code's: pre-accepted onboarding, workspace trust and bypass mode (nobody is there to
# click), its installer, and its hooks: managed settings, because ~/.claude is a per-issue
# volume that would keep an old copy of a settings.json forever. The installers are links to
# their copy in deckhand-agents, where they find the npm-install they share.
COPY --chown=node:node sandbox/agents/claude/home/ /home/node/.claude/
RUN ln -s /usr/local/share/deckhand-agents/claude/install /usr/local/bin/deckhand-install-claude-code
COPY sandbox/agents/claude/managed-settings.json /etc/claude-code/managed-settings.json
# /opt/claude-code: a new volume mounted there takes this owner, root: the listener installs
# Claude Code as root and sandboxes mount it read-only (../docs/security.md).
RUN install -d -o node -g node /workspace && install -d /opt/claude-code

# Codex's: its installer. Its home (/home/node/.codex, the issue's session volume) gets its
# config and hooks from agents/codex.sh on every start; a new volume mounted there takes the
# owner of this folder, node. /opt/codex: root's, like /opt/claude-code.
RUN ln -s /usr/local/share/deckhand-agents/codex/install /usr/local/bin/deckhand-install-codex
RUN install -d -o node -g node /home/node/.codex && install -d /opt/codex

# The Antigravity CLI's: its installer, and the refresh of the listener's plan login, which runs
# in a container of its own (../listener/antigravity-login.mjs). Its home (/home/node/.gemini,
# the issue's session volume, or the login's own) gets its token file, settings, MCP servers
# and hooks from agents/antigravity.sh on every start; a new volume mounted there takes the
# owner of this folder, node. /opt/antigravity: root's, like /opt/claude-code.
RUN ln -s /usr/local/share/deckhand-agents/antigravity/install /usr/local/bin/deckhand-install-antigravity \
    && ln -s /usr/local/share/deckhand-agents/antigravity/refresh /usr/local/bin/deckhand-antigravity-refresh
RUN install -d -o node -g node /home/node/.gemini && install -d /opt/antigravity

# Deckhand's source, matching this image (the source stage above). Last: it changes most.
COPY --from=source /src/ /usr/local/share/deckhand/src/

# Run as `node` (uid 1000): Claude Code refuses --dangerously-skip-permissions as root anyway.
USER node
WORKDIR /workspace
ENTRYPOINT ["deckhand-entrypoint"]
