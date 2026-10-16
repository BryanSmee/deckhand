// The runner: how the listener starts, follows, talks to and removes sandboxes. Everything
// it does to a sandbox goes through this interface, so another backend (Kubernetes Jobs with
// a volume per session, say) can replace Docker later:
//
//   start(spec)          starts a sandbox, detached: it outlives the listener
//   list()               this deployment's sandboxes, running or exited: [{ name, run, running }];
//                        throws when Docker can't tell (rather than "none")
//   state(name)          "running", "exited"… or null when there is no such sandbox
//   follow(name, opts)   its output, line by line, until it exits; `skip` what was already read
//   send(run, text, agent)  a message for the agent (a comment that arrived mid-run)
//   close(run)           no more messages: the agent exits once it has answered
//   closed(run)          whether close() was called, for a listener that restarts
//   wait(name)           until it exits
//   kill(name)           ends it now (a cancelled run): SIGTERM, then SIGKILL after 10 s
//   remove(name, run)    the sandbox, its engine, its network and its inbox
//   hasSession(name, agent)  whether its issue has a session of that agent already (a
//                        previous run)
//   address(name)        its addresses on its network, its engine's too
//   engineAddress(name)  its engine's alone
//   relink()             joins the listener and the proxy to running sandboxes' networks
//                        again, and removes the networks of runs that are gone
//   proxyAddresses()     the egress proxy's addresses, on all of its networks
//
// This file composes its parts, which share `docker`: inbox.mjs (the messages' file),
// networks.mjs (each run's own network), volumes.mjs (a run's container engine and its
// storage) and gc.mjs (relink()).
import { spawn as nodeSpawn } from "node:child_process";
import { agentFor } from "../agents/index.mjs";
import { checked, labelArgs, volumeExists } from "../docker.mjs";
import { engineEnv, engineName } from "./engine.mjs";
import { createRelink } from "./gc.mjs";
import { createInbox } from "./inbox.mjs";
import { createNetworks } from "./networks.mjs";
import { createEngines } from "./volumes.mjs";

export { CLOSE } from "./inbox.mjs";
export { aliasOf } from "./networks.mjs";

// How long a cancelled run's sandbox has between SIGTERM and SIGKILL.
const KILL_GRACE_S = 10;

export function createDockerRunner({
  config,
  docker, // ../docker.mjs
  spawn = nodeSpawn, // `docker logs --follow`, a stream rather than one answer
  inboxDir, // the runs volume, as the listener mounts it
  log = () => {},
  now = Date.now,
}) {
  const inbox = createInbox({ config, inboxDir });
  const networks = createNetworks({ config, docker, log, now });
  const engines = createEngines({ config, docker });
  // Runs whose network exists before their sandbox does: relink() leaves them alone.
  const starting = new Set();

  // `spec`: { run, name, image, labels, env, args, engine, ca }. `env` values reach the
  // container by name only (`-e NAME`), so they never show in `ps`; `args`: Docker's own
  // options (hardening, limits, volumes); `engine`: { limits, cache } for a run granted a
  // container engine, `cache` the base name of the repo's cache volume when it keeps one;
  // `ca`: the egress proxy's CA certificate (PEM), which the sandbox trusts, in its inbox
  // folder (DECKHAND_CA); `digest`: a run analysis's digest of past runs (analysis.mjs), there
  // too (TASK_DIGEST). → { engine: { backend, volume, cached } } when it has one.
  async function start({
    run,
    name,
    image,
    labels = {},
    env: values = {},
    args = [],
    engine,
    ca,
    digest,
  }) {
    // Unset values stay unset in the sandbox, as with `-e NAME` and no NAME.
    const env = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    inbox.write(run, ca, digest);
    const all = {
      "deckhand.owner": config.prefix,
      "deckhand.run": run,
      ...labels,
    };
    starting.add(run);
    let started = null;
    try {
      await networks.create(run);
      if (engine) started = await engines.start(run, name, labels, engine);
      // Not secrets: where the engine is, as values.
      const engineVars = started ? engineEnv(started.backend) : {};
      checked(
        await docker(
          runArgs({ run, name, image, labels: all, env, engineVars, args, ca, digest }),
          {
            env: { ...process.env, ...env },
          },
        ),
        "the sandbox didn't start",
      );
    } catch (error) {
      if (engine) await engines.remove(name, run);
      await networks.remove(run);
      throw error;
    } finally {
      starting.delete(run);
    }
    return { engine: started };
  }

  // start()'s `docker run` arguments: secrets in `env` by name only, the engine's variables
  // (not secrets) as values, the inbox volume read-only, on the run's own network.
  function runArgs({ run, name, image, labels, env, engineVars, args, ca, digest }) {
    return [
      "run",
      "--detach",
      "--init",
      "--name",
      name,
      ...labelArgs(labels),
      ...Object.keys(env).flatMap((k) => ["-e", k]),
      ...Object.entries(engineVars).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      ...inbox.args(run, ca, digest),
      "--network",
      run,
      ...args,
      image,
    ];
  }

  async function list() {
    const { out } = checked(
      await docker([
        "ps",
        "--all",
        "--filter",
        `label=deckhand.owner=${config.prefix}`,
        "--filter",
        "label=deckhand.run",
        "--format",
        '{{.Names}}\t{{.Label "deckhand.run"}}\t{{.State}}',
      ]),
      "docker ps",
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, run, state] = line.split("\t");
        return { name, run, running: state === "running" };
      });
  }

  async function state(name) {
    const { code, out } = await docker(["inspect", "--format", "{{.State.Status}}", name]);
    return code === 0 && out ? out : null;
  }

  // Resolves once the sandbox's output ends (it exited, or `docker logs` stopped: state()
  // tells). `skip`: { out, err } lines of each stream already read by a previous listener.
  // Only whole lines count: one cut short is read again, whole, by the next follow().
  function follow(name, { skip = { out: 0, err: 0 }, onOut, onErr }) {
    return new Promise((resolve) => {
      const child = spawn("docker", ["logs", "--follow", name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const lines = (stream, n, each) => {
        let rest = "";
        let seen = 0;
        const emit = (line) => (seen++ < n ? null : each(line));
        stream.on("data", (chunk) => {
          const parts = (rest + chunk).split("\n");
          rest = parts.pop();
          parts.forEach(emit);
        });
      };
      lines(child.stdout, skip.out, onOut);
      lines(child.stderr, skip.err, onErr);
      child.on("error", (error) => log(`docker logs ${name}: ${error.message}`));
      child.on("close", resolve);
    });
  }

  async function wait(name) {
    await docker(["wait", name]);
  }

  async function kill(name) {
    checked(await docker(["stop", "-t", String(KILL_GRACE_S), name]), `docker stop ${name}`);
  }

  // Without `run` (a leftover sandbox), its network is the one its label names.
  async function remove(name, run) {
    const net = run ?? (await runOf(name));
    await docker(["rm", "--force", name]);
    await engines.remove(name, net);
    if (net) await networks.remove(net);
    if (run) inbox.remove(run);
  }

  async function runOf(name) {
    const { code, out } = await docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "deckhand.run"}}',
      name,
    ]);
    return code === 0 && out ? out : null;
  }

  // The agent's session volume (its `session`), kept by the issue's runs.
  async function hasSession(name, agent = agentFor()) {
    return volumeExists(docker, `${name}-${agent.session.volume}`);
  }

  // On every network it is on: its own, or the shared one of a sandbox an older listener
  // started. Its engine's count as its own: the engine's pulls and containers go out under
  // the run's hosts.
  async function address(name) {
    const found = [
      ...((await networks.addressesOf(name)) ?? []),
      ...((await engineAddress(name)) ?? []),
    ];
    return found.length ? found : null;
  }

  // Its engine's alone: the egress proxy never decrypts their HTTPS, as the engine's builds
  // and containers don't trust Deckhand's CA.
  async function engineAddress(name) {
    return networks.addressesOf(engineName(name));
  }

  return {
    start,
    list,
    state,
    follow,
    send: inbox.send,
    close: inbox.close,
    closed: inbox.closed,
    wait,
    kill,
    remove,
    hasSession,
    address,
    engineAddress,
    relink: createRelink({ config, docker, log, list, starting, networks, engines }),
    proxyAddresses: networks.proxyAddresses,
  };
}
