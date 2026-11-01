// The Docker runner's short containers that aren't sandboxes: an agent's install, a cache
// volume's chown and the Antigravity login's refresh (jobs: run()). A backend without them
// refuses what needs them (../../models/antigravity-login.mjs).
import { envArgs, hardening, userArg, volumeArgs } from "../docker.mjs";

export function createDockerJobs({ config, docker }) {
  // `job`: { image, user ({ uid, gid }), caps, network ("install": INSTALL_NETWORK, outside
  // the runs' networks; "none"), env (values: none of them secrets), volumes ([{ name, path,
  // readOnly }]), entrypoint, args, input (stdin), output (its log as it comes) }. Removed once
  // it exits. → { code, out, err }.
  function run({
    image,
    user,
    caps = [],
    network,
    env = {},
    volumes = [],
    entrypoint,
    args = [],
    input,
    output,
  }) {
    return docker(
      [
        "run",
        "--rm",
        ...(input === undefined ? [] : ["-i"]),
        "--network",
        network === "install" ? config.installNetwork : network,
        ...["--user", userArg(user), ...hardening(...caps)],
        ...envArgs(env),
        ...volumeArgs(volumes),
        "--entrypoint",
        entrypoint,
        image,
        ...args,
      ],
      { input, onData: output },
    );
  }

  return { run };
}
