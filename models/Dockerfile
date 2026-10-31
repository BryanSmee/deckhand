# Deckhand's models service (server.mjs): the only container holding the operator's agent
# credentials (Claude, OpenAI, Google: keys, a gateway's token, the plans' logins). Sandboxes'
# agents call their APIs through it, by the egress proxy. Built from the repository root
# (compose.yaml): it reads the listener's settings and agents' specifics (listener/config.mjs,
# listener/agents/), and calls the runner with its client (runner/client.mjs), at the same
# relative paths.
FROM node:26-alpine
WORKDIR /app
COPY models/*.mjs models/
# The listener's modules it reads its settings with: no GitHub credential comes with them.
COPY listener/*.mjs listener/
COPY listener/agents/ listener/agents/
COPY listener/runner/ listener/runner/
COPY runner/client.mjs runner/
COPY lib/ lib/
# The key the plans' logins are sealed with (/keys, a volume or Secret of its own) and its
# store (/data/store): the node user's, which a new volume mounted there takes. The plans' files
# are mounted read only at /data/credentials.
RUN mkdir -p /keys /data/store && chown node:node /keys /data/store && chmod 700 /keys
USER node
ENV NODE_ENV=production
ARG DECKHAND_VERSION=dev
ENV DECKHAND_VERSION=$DECKHAND_VERSION
# 8080: the agents' calls from the egress proxy, the orchestrator's, on their networks only.
EXPOSE 8080
# Node's fetch, which no HTTP_PROXY of the environment takes elsewhere.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "models/server.mjs"]
