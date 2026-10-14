# Deckhand's egress proxy (proxy.mjs): sits on the sandboxes' internal network and the
# outside one, and lets each sandbox reach only the hosts the listener allows it. Built from
# the repository root (compose.yaml).
FROM node:22-alpine
WORKDIR /app
COPY proxy/proxy.mjs proxy/
USER node
EXPOSE 3128
CMD ["node", "proxy/proxy.mjs"]
