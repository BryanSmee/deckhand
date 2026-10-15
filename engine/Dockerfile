# Deckhand's container engine for Sysbox (SANDBOX_ENGINE=sysbox, ../listener/runner/engine.mjs):
# dockerd, run by the listener next to a granted run's sandbox with `--runtime sysbox-runc`,
# never --privileged. Its API listens on tcp://engine:2375, on the run's own network only.
# Built from the repository root (compose.yaml).
FROM docker:28-dind

# No TLS: only the run's network reaches it (dockerd-entrypoint.sh then listens on 2375).
ENV DOCKER_TLS_CERTDIR=
COPY engine/entrypoint.sh /usr/local/bin/deckhand-engine
EXPOSE 2375
ENTRYPOINT ["deckhand-engine", "dockerd-entrypoint.sh"]
CMD []
