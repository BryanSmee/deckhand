// The runner: how the listener starts, follows, talks to and removes sandboxes. Everything
// it does to a sandbox goes through this interface, so another backend (Kubernetes Jobs with
// a volume per session, say) can replace Docker later:
//
//   start(spec)          starts a sandbox (sandbox-spec.mjs), detached: it outlives the
//                        listener
//   list()               this deployment's sandboxes, running or exited: [{ name, run, running }];
//                        throws when Docker can't tell (rather than "none")
//   state(name)          "running", "exited"… or null when there is no such sandbox
//   follow(name, opts)   its output, line by line, until it exits; `skip` what was already read
//   send(run, text, agent)  a message for the agent (a comment that arrived mid-run)
//   close(run)           no more messages: the agent exits once it has answered (or is
//                        stopped if it stays silent after that, runs.mjs linger())
//   closed(run)          whether close() was called, for a listener that restarts
//   poll(run, from, opts)  the inbox's whole lines after byte `from`, waiting for one up to
//                        `timeout` ms (the sandbox's long poll, ../run-files.mjs); null
//                        without an inbox
//   file(run, name)      the run's "ca" (the egress proxy's) or "digest", or null
//   wait(name)           until it exits
//   kill(name)           ends it now (a cancelled run, or one silent after its answer):
//                        SIGTERM, then SIGKILL after 10 s
//   remove(name, run)    the sandbox, its engine, its network and its inbox
//   hasSession(name, agent)  whether its issue has a session of that agent already (a
//                        previous run)
//   address(name)        its addresses on its network (its engine's: engineAddress())
//   engineAddress(name)  its engine's alone
//   relink()             joins the listener and the proxy to running sandboxes' networks
//                        again, and removes the networks of runs that are gone
//   proxyAddresses()     the egress proxy's addresses, on all of its networks
//
// This file composes its parts, which share `docker`: inbox.mjs (the messages' file and the
// run's other files, which the sandbox fetches from the broker rather than mounts),
// networks.mjs (each run's own network), volumes.mjs (a run's container engine and its
// storage) and gc.mjs (relink()). What else the listener has Docker do, images and short
// containers of its own, is in images.mjs and jobs.mjs beside it (index.mjs).
import { spawn as nodeSpawn } from "node:child_process";
import { agentFor } from "../agents/index.mjs";
import {
  checked,
  envArgs,
  hardeningArgs,
  labelArgs,
  mountArgs,
  userArg,
  volumeArgs,
  volumeExists,
} from "../docker.mjs";
import { engineEnv, engineName } from "./engine.mjs";
import { createRelink } from "./gc.mjs";
import { createInbox } from "./inbox.mjs";
import { splitLines } from "./lines.mjs";
import { createNetworks } from "./networks.mjs";
import { createEngines } from "./volumes.mjs";

export { CLOSE } from "./inbox.mjs";
export { LINE_CUT, MAX_LINE, unstamped } from "./lines.mjs";
export { aliasOf } from "./networks.mjs";

// How long a cancelled run's sandbox has between SIGTERM and SIGKILL.
const KILL_GRACE_S = 10;

// A sandbox spec's user, hardening, limits and volumes (sandbox-spec.mjs) as `docker run`
// options: a volume's folder (`subpath`) and a host path through --mount, the others -v.
// Fail closed: a spec without its user or limits starts nothing, rather than a sandbox as the
// image's user (root, for some) or without the operator's limits.
export function sandboxArgs({ user, limits, caps = [], volumes = [] }) {
  if (!user) throw new Error("the sandbox spec has no user");
  if (!limits) throw new Error("the sandbox spec has no limits");
  return [
    ...["--user", userArg(user)],
    ...hardeningArgs(limits, caps),
    ...volumes.flatMap((v) => {
      if (v.kind === "mount") {
        return mountArgs([{ source: v.name, target: v.path, readOnly: v.readOnly }]);
      }
      if (v.subpath) {
        const ro = v.readOnly ? ",readonly" : "";
        return [
          "--mount",
          `type=volume,src=${v.name},dst=${v.path},volume-subpath=${v.subpath}${ro}`,
        ];
      }
      return volumeArgs([v]);
    }),
  ];
}

export function createDockerRunner({
  config,
  docker, // ../docker.mjs
  spawn = nodeSpawn, // `docker logs --follow`, a stream rather than one answer
  inboxDir, // the runs folder, in the listener's own volume
  log = () => {},
  now = Date.now,
  timers, // inbox.mjs poll()'s clock
}) {
  const inbox = createInbox({ inboxDir, timers });
  const networks = createNetworks({ config, docker, log, now });
  const engines = createEngines({ config, docker });
  // Runs whose network exists before their sandbox does: relink() leaves them alone.
  const starting = new Set();

  // `spec`: sandboxSpec()'s. `env` values reach the container by name only (`-e NAME`), so
  // they never show in `ps`; its user, limits, caps and volumes become Docker's own options
  // (sandboxArgs()); `engine`: { limits, cache } for a run granted a
  // container engine, `cache` the base name of the repo's cache volume when it keeps one;
  // `ca`: the egress proxy's CA certificate (PEM), which the sandbox trusts, in its inbox
  // folder (DECKHAND_CA, where the sandbox fetches it); `digest`: a run analysis's digest of
  // past runs (analysis.mjs), there too (TASK_DIGEST). → { engine: { backend, volume, cached } }
  // when it has one.
  async function start(spec) {
    const { run, name, image, labels = {}, env: values = {}, engine, ca, digest } = spec;
    const args = sandboxArgs(spec);
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
      // Not secrets: where the engine and the run's files are, as values.
      const engineVars = {
        ...(started ? engineEnv(started.backend) : {}),
        ...inbox.env(config.brokerUrl, ca, digest),
      };
      checked(
        await docker(runArgs({ run, name, image, labels: all, env, engineVars, args }), {
          env: { ...process.env, ...env },
        }),
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
  // and the run files' URLs (not secrets) as values, on the run's own network.
  function runArgs({ run, name, image, labels, env, engineVars, args }) {
    return [
      "run",
      "--detach",
      "--init",
      "--name",
      name,
      ...labelArgs(labels),
      ...Object.keys(env).flatMap((k) => ["-e", k]),
      ...envArgs(engineVars),
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
  // Only whole lines count: one cut short is read again, whole, by the next follow(). A line
  // over MAX_LINE is cut there and counts as one line, the same for the next follow(). Each
  // handler gets the line and when Docker says it was written (ms; null without a stamp):
  // Docker's time, so a line read again after a restart keeps its own.
  function follow(name, { skip = { out: 0, err: 0 }, onOut, onErr }) {
    return new Promise((resolve) => {
      const child = spawn("docker", ["logs", "--follow", "--timestamps", name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Whole lines, by bytes (lines.mjs): a character split between two chunks isn't
      // mangled. A handler that throws (its log's disk full, say) loses that line, not the
      // listener.
      const lines = (stream, n, each) => {
        let seen = 0;
        const split = splitLines((line, at) => {
          if (seen++ < n) return;
          try {
            each(line, at);
          } catch (error) {
            log(`docker logs ${name}: ${error.stack ?? error}`);
          }
        });
        stream.on("data", (data) => split(Buffer.isBuffer(data) ? data : Buffer.from(data)));
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
  // started. The sandbox's alone, from one inspection, as engineAddress() is the engine's: the
  // broker counts both as the run's (broker-http.mjs hasAddress()), and can tell whether the
  // sandbox's is known yet (#517).
  async function address(name) {
    const found = (await networks.addressesOf(name)) ?? [];
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
    poll: inbox.poll,
    file: inbox.file,
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
