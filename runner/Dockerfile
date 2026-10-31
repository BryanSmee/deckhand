# Deckhand's runner service (server.mjs): the only container with the host's Docker socket (or
# the Kubernetes API's credentials). It starts sandboxes, builds repo images and runs preview
# hooks for the listener, and keeps the runs' logs. Built from the repository root
# (compose.yaml): it runs the listener's backends (listener/runner/, images.mjs, previews.mjs)
# and lib/, at the same relative paths.
FROM node:26-alpine
# buildx: repo images build with BuildKit. GNU tar: checkouts strip GitHub's top folder.
RUN apk add --no-cache docker-cli docker-cli-buildx tar
# buildctl: the Kubernetes runner builds repo images with a BuildKit daemon in the cluster
# (listener/runner/kube-images.mjs). The client only, from BuildKit's release, pinned by version
# and by the sha256 of each architecture's tarball (its release's digests).
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
# The listener's modules the runner runs: its backends, images, previews, the settings and the
# agents' specifics. No GitHub or agent credential comes with them: those are the listener's.
COPY listener/*.mjs listener/
COPY listener/runner/ listener/runner/
COPY listener/agents/ listener/agents/
COPY lib/ lib/
COPY runner/*.mjs runner/
ENV NODE_ENV=production
ARG DECKHAND_VERSION=dev
ENV DECKHAND_VERSION=$DECKHAND_VERSION
# 8080: the runner's API, on the networks of the services that call it only (compose.yaml).
EXPOSE 8080
# Root: it drives the host's Docker socket, which is root-equivalent anyway.
CMD ["node", "runner/server.mjs"]
