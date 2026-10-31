# Deckhand's broker service (server.mjs): the runs' and the services' tokens, which only its
# containers sign, the live runs and their files, and the endpoints sandboxes call about their
# own run, through the egress proxy. Built from the repository root (compose.yaml).
FROM node:26-alpine
WORKDIR /app
COPY broker/*.mjs broker/
# The modules every service shares (lib/), beside the broker's as in the repository.
COPY lib/ lib/
# Its signing key (/keys, a volume or Secret of its own) and its store (/data): the node user's,
# which a new volume mounted there takes.
RUN mkdir /keys /data && chown node:node /keys /data && chmod 700 /keys
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8081/health || exit 1
CMD ["node", "broker/server.mjs"]
