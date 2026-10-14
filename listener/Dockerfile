# Deckhand's listener (server.mjs): receives the GitHub App's webhooks and starts sandbox
# containers through the host's Docker. Built from the repository root (compose.yaml) for
# ../prompts/; the layout is kept, so server.mjs finds them at the same relative paths.
FROM node:22-alpine
# buildx: repo images build with BuildKit. GNU tar: checkouts strip GitHub's top folder.
RUN apk add --no-cache docker-cli docker-cli-buildx tar
WORKDIR /app
COPY listener/*.mjs listener/dashboard.html listener/
COPY prompts/brainstorm.md prompts/idea.md prompts/bug.md prompts/discussion.md prompts/
ENV NODE_ENV=production
# 8080: webhooks, /setup, dashboard (published). 8081: token broker (sandboxes only).
EXPOSE 8080
# Root: it drives the host's Docker socket, which is root-equivalent anyway.
CMD ["node", "listener/server.mjs"]
