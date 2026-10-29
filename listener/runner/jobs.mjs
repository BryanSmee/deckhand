// The Docker runner's short containers that aren't sandboxes: an agent's install, a cache
// volume's chown and the Antigravity login's refresh (jobs: run()), and preview hooks
// (preview), which hold the host's Docker socket. A backend without them refuses what needs
// them (../previews.mjs, ../antigravity-login.mjs).
import { envArgs, hardening, labelArgs, userArg, volumeArgs } from "../docker.mjs";

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

  // A preview hook's container: created, given its checkout, then started with the event on
  // stdin. As root with the host's Docker socket: whoever holds it is root on the host anyway.
  const preview = {
    async create({ name, repo, image, env = {}, command }) {
      const created = await docker([
        "create",
        "-i",
        "--name",
        name,
        ...labelArgs({ "deckhand.preview": repo.toLowerCase() }),
        "--user",
        "0",
        "-v",
        `${config.dockerSocket}:/var/run/docker.sock`,
        ...envArgs(env),
        "--entrypoint",
        "sh",
        image,
        "-c",
        'cd /deckhand-checkout && exec sh -c "$1"',
        "preview",
        command,
      ]);
      if (created.code !== 0) throw new Error(`creating its container: ${created.err}`);
    },
    async copy(name, dir) {
      const copied = await docker(["cp", dir, `${name}:/deckhand-checkout`]);
      if (copied.code !== 0) throw new Error(`copying the checkout: ${copied.err}`);
    },
    // → its exit code.
    async start(name, { input, output }) {
      const { code } = await docker(["start", "-ai", name], { input, onData: output });
      return code;
    },
    kill: (name) => docker(["kill", name]),
    remove: (name) => docker(["rm", "-f", name]),
  };

  return { run, preview };
}
