# Deckhand's policy service (service.mjs, #501): the operator's and the repositories' Rego
# policies, evaluated by long-lived `opa` servers for the listener. No network but its callers',
# no secret, no state. Built from the repository root (compose.yaml), for ../lib/ and ../policy/;
# the layout is kept, so engine.mjs finds Deckhand's default policies at the same relative path.
FROM node:26-alpine
# opa: the static release, pinned by version and by the sha256 of each architecture's binary (its
# release's .sha256). A new version may bring builtins that read files or the network: check them
# against engine.mjs's REMOVED before raising it (test/policies.test.mjs tries the known ones).
ARG TARGETARCH
ARG OPA_VERSION=1.21.4
RUN case "$TARGETARCH" in \
      amd64) sum=2ab571f367f293bb19523b76f92f1945bbf245003392c7f392903f95c2b9b630 ;; \
      arm64) sum=810aa96e44f1f852d044888cf830324e44eafd0f510345339011347ab4deaab1 ;; \
      *) echo "no opa for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && apk add --no-cache --virtual .opa curl \
    && curl -fsSLo /usr/local/bin/opa "https://github.com/open-policy-agent/opa/releases/download/v${OPA_VERSION}/opa_linux_${TARGETARCH}_static" \
    && echo "$sum  /usr/local/bin/opa" | sha256sum -c - \
    && chmod 755 /usr/local/bin/opa \
    && apk del .opa \
    && opa version
WORKDIR /app
COPY policy-service/*.mjs policy-service/
# The modules every service shares (lib/), beside its own as in the repository.
COPY lib/ lib/
# Deckhand's default policies, under the operator's and the repos' (engine.mjs BUILT_IN_DIR).
COPY policy/ policy/
ENV NODE_ENV=production
# Nothing it does needs root: its files are read-only, its sets staged in /tmp.
USER node
# Its callers' calls (POLICY_SERVICE_URL), on its internal network only; /health and /ready too.
EXPOSE 8181
CMD ["node", "policy-service/service.mjs"]
