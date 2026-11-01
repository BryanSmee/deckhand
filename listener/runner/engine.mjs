// The container engine sidecar: a second container a granted run gets next to its sandbox, on
// the run's network, so the agent can `docker build`, `docker run` and `docker compose up`
// without the host's Docker. The sandbox keeps all of its hardening (uid 1000, no
// capabilities, no-new-privileges); what an engine needs relaxed is relaxed here only, never
// --privileged and never the host's Docker socket. Security model: ../../docs/security.md.
//
//   sysbox   dockerd (../../engine/Dockerfile) under the Sysbox runtime: root in the
//            container is an unprivileged user on the host, no relaxed seccomp or AppArmor
//   podman   rootless Podman's Docker-compatible API (../../engine/podman/Dockerfile): no
//            host setup, but seccomp and AppArmor unconfined, /dev/fuse and /dev/net/tun
//   auto     sysbox where the host's Docker has its runtime, else podman

import { limitArgs } from "../docker.mjs";

// SANDBOX_ENGINE's values; empty: no engine for anyone.
export const ENGINES = ["sysbox", "podman", "auto"];

// What the sandbox calls it by on the run's network, and where its API listens: unencrypted,
// but only the run's own network (the sandbox, the proxy) can reach it.
export const ENGINE_HOST = "engine";
const ENGINE_PORT = 2375;

// The runtime Sysbox installs on the host's Docker.
const SYSBOX_RUNTIME = "sysbox-runc";

// The sidecar of the sandbox `name`, and the storage volume of the run `run`.
export const engineName = (name) => `${name}-engine`;
export const engineVolume = (run) => `${run}-engine`;

// Where each backend keeps its images, layers and containers.
const STORAGE = {
  sysbox: "/var/lib/docker",
  podman: "/home/podman/.local/share/containers",
};

// Docker's options for the sidecar of a `backend` (sysbox or podman): its runtime or what it
// relaxes, its storage `volume` and the repo's `limits`, those of its sandbox.
export function engineArgs(backend, { volume, limits }) {
  const own =
    backend === "sysbox"
      ? // Root inside is mapped to an unprivileged range on the host: dockerd gets the
        // capabilities it needs in its own user namespace only.
        ["--runtime", SYSBOX_RUNTIME]
      : [
          // Rootless Podman makes user namespaces (newuidmap is setuid, so no
          // no-new-privileges) and mounts fuse-overlayfs: the syscalls and devices that takes.
          ...["--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined"],
          ...["--security-opt", "label=disable"],
          ...["--device", "/dev/fuse", "--device", "/dev/net/tun"],
        ];
  return [
    ...own,
    ...limitArgs(limits),
    "--mount",
    `type=volume,src=${volume},dst=${STORAGE[backend]}`,
  ];
}

// What the sandbox gets to use it: the engine's address, and Podman's API has no BuildKit
// (`docker build` falls back to the classic builder, which it serves).
export function engineEnv(backend) {
  return {
    DOCKER_HOST: `tcp://${ENGINE_HOST}:${ENGINE_PORT}`,
    ...(backend === "podman" ? { DOCKER_BUILDKIT: "0" } : {}),
  };
}

// SANDBOX_ENGINE as configured → the backend for this host: `runtimes` are the host's Docker's
// (`docker info`). Throws when sysbox is asked for and missing: no engine rather than a
// weaker one the operator didn't pick.
export function engineBackend(setting, runtimes) {
  const sysbox = runtimes.includes(SYSBOX_RUNTIME);
  if (setting === "auto") return sysbox ? "sysbox" : "podman";
  if (setting === "sysbox" && !sysbox) {
    throw new Error(
      `SANDBOX_ENGINE is sysbox, but the host's Docker has no ${SYSBOX_RUNTIME} runtime: install Sysbox, or set SANDBOX_ENGINE to podman or auto (docs/setup.md)`,
    );
  }
  return setting;
}
