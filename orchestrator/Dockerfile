# Deckhand's orchestrator (server.mjs, #506): the queue and the runs' lives. It reads the verified
# deliveries edge passes on, has the runner service (../runner/) start sandbox containers, and
# answers the dashboard's API, which edge passes on. It holds no secret: no GitHub App key, no
# Docker socket, no agent credential, no webhook secret. Built from the repository root
# (compose.yaml) for ../listener/, ../prompts/ and ../docs/; the layout is kept, so server.mjs
# finds them at the same relative paths.
FROM node:26-alpine
WORKDIR /app
COPY orchestrator/server.mjs orchestrator/
# The modules it runs (../listener/), and those every service shares (lib/), as in the repository.
COPY listener/*.mjs listener/
COPY lib/ lib/
# The runner's constants its sandbox specs use (runner/engine.mjs, runner/inbox.mjs), and the
# clients of the runner, the github service and edge.
COPY listener/runner/ listener/runner/
COPY runner/client.mjs runner/
COPY github/client.mjs github/
COPY edge/client.mjs edge/
COPY listener/agents/ listener/agents/
COPY prompts/brainstorm.md prompts/idea.md prompts/bug.md prompts/discussion.md prompts/onboarding.md prompts/analyze.md prompts/research.md prompts/review.md prompts/chat.md prompts/
# The onboarding prompt ends with the config's reference.
COPY docs/repo-config.md docs/
COPY docs/repo-config/ docs/repo-config/
ENV NODE_ENV=production
# The release it is (a git tag, .github/workflows/release.yml); "dev" when built from source.
ARG DECKHAND_VERSION=dev
ENV DECKHAND_VERSION=$DECKHAND_VERSION
# The repository it was built from (https://github.com/<owner>/<repo>): the dashboard links
# the version to its commit or release there. Empty from source: no link.
ARG DECKHAND_SOURCE=
ENV DECKHAND_SOURCE=$DECKHAND_SOURCE
# 8082: the egress policy (the proxy's). 8083: the other services' calls (the runner's, edge's).
# Nothing is published.
EXPOSE 8082 8083
# Not root (#536). Its data volume, with the file store (/data/store): the node user's when new,
# as Docker copies this folder's owner into an empty volume. With Redis as the store, no volume
# (#619): nothing is written in its read-only root, this folder stays empty. One from a release
# before #536 is root's, which it refuses to start on, saying the one-time chown
# (docs/setup.md#upgrading-the-orchestrator-runs-as-node-536).
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "orchestrator/server.mjs"]
