# Deckhand's container engine without Sysbox (SANDBOX_ENGINE=podman, ../../listener/runner/engine.mjs):
# rootless Podman serving Docker's API on tcp://engine:2375, on the run's own network only.
# The listener runs it with seccomp and AppArmor unconfined, /dev/fuse and /dev/net/tun (what
# user namespaces and fuse-overlayfs need), never --privileged: see ../../docs/security/mounts-and-engine.md#container-engine.
# Built from the repository root (compose.yaml).
FROM quay.io/podman/stable:v5

COPY engine/entrypoint.sh /usr/local/bin/deckhand-engine
USER podman
EXPOSE 2375
ENTRYPOINT ["deckhand-engine"]
CMD ["podman", "system", "service", "--time=0", "tcp://0.0.0.0:2375"]
