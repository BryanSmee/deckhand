# Deckhand's edge (server.mjs, #506): the only service the internet reaches. GitHub's webhooks,
# /setup, sign-in and the dashboard's files; its API, which the orchestrator answers. It holds
# the webhook secret, the session key and the OAuth client's, nothing else. Built from the
# repository root (compose.yaml) for ../dashboard/ and ../listener/; the layout is kept.

# The dashboard: built on the build machine's platform (static files, the same for every
# architecture), so a multi-arch release doesn't run Vite under emulation.
FROM --platform=$BUILDPLATFORM node:26-alpine AS dashboard
WORKDIR /dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# No dependencies: the dashboard's build, no node_modules.
FROM node:26-alpine
WORKDIR /app
COPY edge/*.mjs edge/
# The modules it runs (sign-in, /setup, deliveries' checks, its settings), from ../listener/, and
# those every service shares (lib/), as in the repository.
COPY listener/*.mjs listener/
COPY listener/agents/ listener/agents/
COPY listener/runner/ listener/runner/
COPY lib/ lib/
COPY github/client.mjs github/
COPY --from=dashboard /dashboard/dist/ dashboard/dist/
ENV NODE_ENV=production
ARG DECKHAND_VERSION=dev
ENV DECKHAND_VERSION=$DECKHAND_VERSION
ARG DECKHAND_SOURCE=
ENV DECKHAND_SOURCE=$DECKHAND_SOURCE
# 8080: webhooks, /setup, the dashboard (published). 8083: the orchestrator's calls (internal).
EXPOSE 8080 8083
# Not root: its data volume (app.json, the session key, its store) made the node user's when new.
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "edge/server.mjs"]
