# Deckhand's broker service (server.mjs): the runs' and the services' tokens, which only its
# containers sign, the live runs and their files, and the endpoints sandboxes call about their
# own run, through the egress proxy. Built from the repository root (compose.yaml).
FROM node:26-alpine
WORKDIR /app
COPY broker/*.mjs broker/
# The modules every service shares (lib/), beside the broker's as in the repository.
COPY lib/ lib/
# Its signing key (/keys, a volume or Secret of its own), its store (/data) and where it
# publishes its public key (/service-keys, SERVICE_KEYS_DIR): the node user's, which a new volume
# mounted there takes.
RUN mkdir /keys /data /service-keys && chown node:node /keys /data /service-keys && chmod 700 /keys
USER node
EXPOSE 8081
# Node's fetch, which no HTTP_PROXY of the environment takes elsewhere.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "broker/server.mjs"]
