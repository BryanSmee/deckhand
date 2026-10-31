# Deckhand's listener (server.mjs): receives the GitHub App's webhooks and has the runner service
# (../runner/) start sandbox containers: it holds no Docker socket. Built from the repository
# root (compose.yaml) for ../prompts/, ../docs/ and ../dashboard/; the layout is kept, so
# server.mjs finds them at the same relative paths.

# The dashboard: built on the build machine's platform (static files, the same for every
# architecture), so a multi-arch release doesn't run Vite under emulation.
FROM --platform=$BUILDPLATFORM node:26-alpine AS dashboard
WORKDIR /dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# graphql-js, the listener's one runtime package (AGENTS.md): bundled into a single file the
# GitHub gateway imports (github-graphql.mjs), so the image has no node_modules either.
FROM --platform=$BUILDPLATFORM node:26-alpine AS vendor
WORKDIR /vendor
COPY listener/vendor/package.json listener/vendor/package-lock.json ./
RUN npm ci
COPY listener/vendor/graphql.entry.mjs ./
RUN npm run build

# The listener has no other dependencies: the dashboard's build and graphql-js's bundle, no
# node_modules.
FROM node:26-alpine
# git: the git gateway reads the workflow files a push of a repo granted `workflows`
# changes, against a mirror of it (git-mirror.mjs). No Docker CLI: the runner has it.
RUN apk add --no-cache git
WORKDIR /app
COPY listener/*.mjs listener/
# The modules every service shares (lib/), beside the listener's as in the repository.
COPY lib/ lib/
COPY --from=dashboard /dashboard/dist/ dashboard/dist/
# GitHub's GraphQL schema, pinned (vendor/update-schema.mjs), which the gateway validates against.
COPY --from=vendor /vendor/graphql.mjs listener/vendor/
COPY listener/vendor/github.graphql listener/vendor/
# The runner's constants the listener's sandbox specs use (runner/engine.mjs, runner/inbox.mjs),
# and the runner service's client.
COPY listener/runner/ listener/runner/
COPY runner/client.mjs runner/
COPY listener/agents/ listener/agents/
COPY prompts/brainstorm.md prompts/idea.md prompts/bug.md prompts/discussion.md prompts/onboarding.md prompts/analyze.md prompts/research.md prompts/review.md prompts/
# The onboarding prompt ends with the config's reference.
COPY docs/repo-config.md docs/
ENV NODE_ENV=production
# The release it is (a git tag, .github/workflows/release.yml); "dev" when built from source.
ARG DECKHAND_VERSION=dev
ENV DECKHAND_VERSION=$DECKHAND_VERSION
# The repository it was built from (https://github.com/<owner>/<repo>): the dashboard links
# the version to its commit or release there. Empty from source: no link.
ARG DECKHAND_SOURCE=
ENV DECKHAND_SOURCE=$DECKHAND_SOURCE
# 8080: webhooks, /setup, dashboard (published). 8081: token broker (sandboxes only). 8083: the
# other services' calls (the runner's).
EXPOSE 8080
CMD ["node", "listener/server.mjs"]
