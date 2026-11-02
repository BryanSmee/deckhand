# Deckhand's egress proxy (proxy.mjs): sits on the sandboxes' internal network and the
# outside one, and lets each sandbox reach only the hosts the orchestrator's egress policy
# allows it. Built from
# the repository root (compose.yaml).
FROM node:26-alpine
# Deckhand's CA and its host certificates (authority.mjs): Node can't make certificates.
RUN apk add --no-cache openssl
WORKDIR /app
COPY proxy/proxy.mjs proxy/addresses.mjs proxy/cached.mjs proxy/cache.mjs proxy/authority.mjs \
  proxy/atomic.mjs proxy/wait.mjs proxy/
# Draining on SIGTERM, every service's, and the broker service's calls with the proxy's own
# service token (lib/).
COPY lib/ lib/
# The egress cache's folder, the node user's: a new volume mounted there takes its owner. The
# CA lives in it too (ca/).
RUN mkdir /cache && chown node:node /cache
USER node
# 3129: the container engines that share their sandbox's address (Kubernetes, #573).
EXPOSE 3128 3129
CMD ["node", "proxy/proxy.mjs"]
