# Deckhand's github service (server.mjs): the only container with the GitHub App's key. It serves
# the runs' GitHub and git gateways, the listener's own GitHub calls and the runner's tarballs.
# Built from the repository root (compose.yaml): it runs the listener's gateway modules
# (listener/github-*.mjs, git-gateway.mjs…) and lib/, at the same relative paths.

# graphql-js, the gateway's one runtime package (AGENTS.md): bundled into a single file it imports
# (listener/github-graphql.mjs), so the image has no node_modules. On the build machine's
# platform: the bundle is the same for every architecture.
FROM --platform=$BUILDPLATFORM node:26-alpine AS vendor
WORKDIR /vendor
COPY listener/vendor/package.json listener/vendor/package-lock.json ./
RUN npm ci
COPY listener/vendor/graphql.entry.mjs ./
RUN npm run build

FROM node:26-alpine
# git: the git gateway reads the workflow files a push of a repo granted `allow_workflows`
# changes, against a mirror of it (listener/git-mirror.mjs).
RUN apk add --no-cache git
WORKDIR /app
COPY listener/*.mjs listener/
COPY listener/agents/ listener/agents/
COPY listener/runner/ listener/runner/
COPY lib/ lib/
COPY github/*.mjs github/
COPY --from=vendor /vendor/graphql.mjs listener/vendor/
# GitHub's GraphQL schema, pinned (vendor/update-schema.mjs), which the gateway validates against.
COPY listener/vendor/github.graphql listener/vendor/
# The App's credentials, its key with them (/app, APP_DIR: a volume or Secret of its own), and
# its store and git mirrors (/data): the node user's, which a new volume mounted there takes.
RUN mkdir /app-key /data && chown node:node /app-key /data && chmod 700 /app-key
ENV APP_DIR=/app-key
USER node
ENV NODE_ENV=production
ARG DECKHAND_VERSION=dev
ENV DECKHAND_VERSION=$DECKHAND_VERSION
# 8080: its API, on the networks of the services that call it only (compose.yaml).
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "github/server.mjs"]
