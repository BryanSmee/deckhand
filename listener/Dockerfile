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
# buildx: repo images build with BuildKit. GNU tar: checkouts strip GitHub's top folder.
# git: the git gateway reads the workflow files a push of a repo granted `allow_workflows`
# changes, against a mirror of it (git-mirror.mjs).
RUN apk add --no-cache docker-cli docker-cli-buildx git tar
# buildctl: the Kubernetes runner builds repo images with a BuildKit daemon in the cluster
# (runner/kube-images.mjs). The client only, from BuildKit's release, pinned by version and
# by the sha256 of each architecture's tarball (its release's digests).
ARG TARGETARCH
ARG BUILDKIT_VERSION=0.34.1
RUN case "$TARGETARCH" in \
      amd64) sum=a59539daf547fe0958efe2d07e41c0a6944e1112a66d7e519ec1cf5b673ef15b ;; \
      arm64) sum=c8c97b84baf89dfe0ea85063ac24ad88eb909979ea476ce3ef9e8e11e60ebef8 ;; \
      *) echo "no buildctl for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && apk add --no-cache --virtual .buildctl curl \
    && curl -fsSLo /tmp/buildkit.tgz "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-${TARGETARCH}.tar.gz" \
    && echo "$sum  /tmp/buildkit.tgz" | sha256sum -c - \
    && tar -xzf /tmp/buildkit.tgz -C /usr/local bin/buildctl \
    && rm /tmp/buildkit.tgz \
    && apk del .buildctl \
    && buildctl --version
WORKDIR /app
COPY listener/*.mjs listener/
# The modules every service shares (lib/), beside the listener's as in the repository.
COPY lib/ lib/
COPY --from=dashboard /dashboard/dist/ dashboard/dist/
# GitHub's GraphQL schema, pinned (vendor/update-schema.mjs), which the gateway validates against.
COPY --from=vendor /vendor/graphql.mjs listener/vendor/
COPY listener/vendor/github.graphql listener/vendor/
COPY listener/runner/ listener/runner/
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
# 8080: webhooks, /setup, dashboard (published). 8081: token broker (sandboxes only).
EXPOSE 8080
# Root: it drives the host's Docker socket, which is root-equivalent anyway.
CMD ["node", "listener/server.mjs"]
