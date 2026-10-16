# Deckhand's listener (server.mjs): receives the GitHub App's webhooks and starts sandbox
# containers through the host's Docker. Built from the repository root (compose.yaml) for
# ../prompts/, ../docs/ and ../dashboard/; the layout is kept, so server.mjs finds them at
# the same relative paths.

# The dashboard: built on the build machine's platform (static files, the same for every
# architecture), so a multi-arch release doesn't run Vite under emulation.
FROM --platform=$BUILDPLATFORM node:26-alpine AS dashboard
WORKDIR /dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# The listener has no dependencies: only the dashboard's build, no node_modules.
FROM node:26-alpine
# buildx: repo images build with BuildKit. GNU tar: checkouts strip GitHub's top folder.
RUN apk add --no-cache docker-cli docker-cli-buildx tar
WORKDIR /app
COPY listener/*.mjs listener/
COPY --from=dashboard /dashboard/dist/ dashboard/dist/
COPY listener/runner/ listener/runner/
COPY listener/agents/ listener/agents/
COPY prompts/brainstorm.md prompts/idea.md prompts/bug.md prompts/discussion.md prompts/onboarding.md prompts/analyze.md prompts/
# The onboarding prompt ends with the config's reference.
COPY docs/repo-config.md docs/
ENV NODE_ENV=production
# The release it is (a git tag, .github/workflows/release.yml); "dev" when built from source.
ARG DECKHAND_VERSION=dev
ENV DECKHAND_VERSION=$DECKHAND_VERSION
# 8080: webhooks, /setup, dashboard (published). 8081: token broker (sandboxes only).
EXPOSE 8080
# Root: it drives the host's Docker socket, which is root-equivalent anyway.
CMD ["node", "listener/server.mjs"]
