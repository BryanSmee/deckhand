# A placeholder (#558): the release builds every image it lists, so deckhand-orchestrator is
# published before #506 (#557). That pull request replaces this file with the orchestrator's
# (the queue, the runs' lives) and changes no workflow. It runs nothing.
FROM node:26-alpine
USER node
ARG DECKHAND_VERSION=dev
ENV DECKHAND_VERSION=$DECKHAND_VERSION
CMD ["node", "-e", "console.error('deckhand-orchestrator: a placeholder, nothing runs here yet (#506)'); process.exit(1)"]
