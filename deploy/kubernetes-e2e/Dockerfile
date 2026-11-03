# The fakes of the end-to-end check (fakes.mjs): node, and git for the repository it serves.
FROM node:26-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY deploy/kubernetes-e2e/fakes.mjs /fakes.mjs
ENTRYPOINT ["node", "/fakes.mjs"]
