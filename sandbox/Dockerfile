# Deckhand's base sandbox image: a container per issue that clones the repository, runs an
# agent (Claude Code) without permission prompts, and pushes a branch. Built from the
# repository root (compose.yaml), as it also takes ../prompts/sandbox.md.
#
# The harness only: no project toolchain. A repo brings its own with a Dockerfile FROM this
# image (`ARG DECKHAND_BASE` / `FROM $DECKHAND_BASE`, see ../docs/repo-config.md), which the
# listener builds; without one, its runs use this image as is.
#
# No agent is in the image: each installs per version into a shared volume before the first
# run that needs it (Claude Code: agents/claude/install puts the pinned CLAUDE_CODE_VERSION
# into the /opt/claude-code volume). One image for every agent: what is an agent's own is in
# agents/<name>.sh and agents/<name>/, copied to /usr/local/share/deckhand-agents. GitHub
# access goes through the listener's token broker (git-credential-deckhand, the gh wrapper):
# no token or SSH key is ever mounted.

FROM node:22-bookworm

# gh from GitHub's apt repository.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -d /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh git ripgrep jq less procps unzip; \
    rm -rf /var/lib/apt/lists/*

# A headless Chromium for checking pages: the Playwright MCP server gives Claude browser
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
COPY sandbox/deckhand-token sandbox/git-credential-deckhand sandbox/gh /usr/local/bin/
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
# volume that would keep an old copy of a settings.json forever.
COPY --chown=node:node sandbox/agents/claude/home/ /home/node/.claude/
COPY sandbox/agents/claude/install /usr/local/bin/deckhand-install-claude-code
COPY sandbox/agents/claude/managed-settings.json /etc/claude-code/managed-settings.json
# /opt/claude-code: a new volume mounted there takes this owner, root: the listener installs
# Claude Code as root and sandboxes mount it read-only (../docs/security.md).
RUN install -d -o node -g node /workspace && install -d /opt/claude-code

# Run as `node` (uid 1000): Claude Code refuses --dangerously-skip-permissions as root anyway.
USER node
WORKDIR /workspace
ENTRYPOINT ["deckhand-entrypoint"]
