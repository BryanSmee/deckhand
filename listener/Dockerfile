# The listener is gone (#506): edge (../edge/Dockerfile) and the orchestrator
# (../orchestrator/Dockerfile) took its place. The release still lists deckhand-listener until
# its entry is removed on main (#558): this placeholder builds, and runs nothing.
FROM node:26-alpine
USER node
ARG DECKHAND_VERSION=dev
ENV DECKHAND_VERSION=$DECKHAND_VERSION
CMD ["node", "-e", "console.error('deckhand-listener is gone: run deckhand-edge and deckhand-orchestrator (docs/setup.md)'); process.exit(1)"]
