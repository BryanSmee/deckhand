# Deckhand's egress proxy (proxy.mjs): sits on the sandboxes' internal network and the
# outside one, and lets each sandbox reach only the hosts the listener allows it. Built from
# the repository root (compose.yaml).
FROM node:26-alpine
# Deckhand's CA and its host certificates (authority.mjs): Node can't make certificates.
RUN apk add --no-cache openssl
WORKDIR /app
COPY proxy/proxy.mjs proxy/cache.mjs proxy/authority.mjs proxy/
# The egress cache's folder, the node user's: a new volume mounted there takes its owner. The
# CA lives in it too (ca/).
RUN mkdir /cache && chown node:node /cache
USER node
EXPOSE 3128
CMD ["node", "proxy/proxy.mjs"]
