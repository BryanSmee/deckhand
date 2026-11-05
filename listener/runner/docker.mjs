// The runner: how the listener starts, follows, talks to and removes sandboxes. Everything
// it does to a sandbox goes through this interface, so another backend (Kubernetes Jobs with
// a volume per session, say) can replace Docker later:
//
//   start(spec)          starts a sandbox (sandbox-spec.mjs), detached: it outlives the
//                        listener
//   list()               this deployment's sandboxes, running or exited: [{ name, run, running }];
//                        throws when Docker can't tell (rather than "none")
//   state(name)          "running", "exited"… or null when there is no such sandbox
//   follow(name, opts)   its output, line by line, until it exits; `skip` what was already read,
//                        `signal` ends it early
//   exitCode(name)       its exit code once it exited, or null
//   send(run, text, agent)  a message for the agent (a comment that arrived mid-run)
//   close(run)           no more messages: the agent exits once it has answered (or is
//                        stopped if it stays silent after that, runs.mjs linger())
//   closed(run)          whether close() was called, for a listener that restarts
//   wait(name)           until it exits
//   kill(name)           ends it now (a cancelled run, or one silent after its answer):
//                        SIGTERM, then SIGKILL after 10 s
//   remove(name, run)    the sandbox, its engine, its network and its inbox
//   hasSession(name, agent)  whether its issue has a session of that agent already (a
//                        previous run)
//   removeSessions(volumes)  those of the session volumes that exist, removed (a chat's)
//   relink()             joins the proxy to running sandboxes' networks
//                        again, and removes the networks of runs that are gone
//   proxyAddresses()     the egress proxy's addresses, on all of its networks
//   locate(ip)           { sandbox, name }: the ID of the run's network that address is on (its
//                        pod's UID, on Kubernetes) and the container that has it there
//                        (Kubernetes names none: the pod is the sandbox), or null: what the
//                        run's tokens are bound to, once the egress policy knows that
//                        container is the run's sandbox or engine (../egress-http.mjs taskWhere())
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
  containerLabels,
  envArgs,
  hardeningArgs,
  labelArgs,
  mountArgs,
  userArg,
  volumeArgs,
  volumeExists,
  volumeLabels,
} from "../docker.mjs";
import { engineEnv } from "./engine.mjs";
import { createRelink } from "./gc.mjs";
import { createInbox } from "./inbox.mjs";
import { splitLines } from "./lines.mjs";
import { createNetworks } from "./networks.mjs";
import { createEngines } from "./volumes.mjs";

export { CLOSE } from "./inbox.mjs";

// The label saying what a volume of Deckhand's is for (a session's), as on Kubernetes.
const ROLE = "deckhand.role";
export { LINE_CUT, MAX_LINE, unstamped } from "./lines.mjs";
export { aliasOf } from "./networks.mjs";

// The docker CLI's environment for a sandbox's start: the runner's own, with the sandbox's
// values (`-e NAME` reads them from it), but never one that changes what the CLI or its loader
// does (the runner's own, or none): the spec's names are checked too (runner/spec-check.mjs).
const OWN = /^(LD_|DOCKER_|BUILDKIT_|BUILDX_|KUBE|GCONV_|MALLOC_|SSL_CERT_|GODEBUG$|GOTRACEBACK$)/;
const OWN_NAMES = ["PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "IFS", "TMPDIR", "NODE_OPTIONS"];
// Whether `name` is one of those: the one list, which the runner's spec check refuses too
// (../../runner/spec-check.mjs).
export const cliName = (name) => OWN.test(name) || OWN_NAMES.includes(name);
export function cliEnv(values, own = process.env) {
  const env = { ...own, ...values };
  for (const name of Object.keys(env)) {
    if (!cliName(name)) continue;
    if (name in own) env[name] = own[name];
    else delete env[name];
  }
  return env;
}

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
  mirror = null, // the broker service's copy of the runs' inboxes and files (inbox.mjs)
  metrics = null, // the runner's (../../runner/metrics.mjs): how long a start takes
}) {
  const inbox = createInbox({ inboxDir, mirror });
  const networks = createNetworks({ config, docker, log, now });
  const engines = createEngines({ config, docker });
  // Runs whose network exists before their sandbox does: relink() leaves them alone.
  const starting = new Set();

  // `spec`: sandboxSpec()'s. `env` values reach the container by name only (`-e NAME`), so
  // they never show in `ps`, with those of `tokens(sandbox)`, once its network's ID is known; its user, limits, caps and volumes become Docker's own options
  // (sandboxArgs()); `engine`: { limits, cache } for a run granted a
  // container engine, `cache` the base name of the repo's cache volume when it keeps one;
  // `ca`: the egress proxy's CA certificate (PEM), which the sandbox trusts, in its inbox
  // folder (DECKHAND_CA, where the sandbox fetches it); `digest`: a run analysis's digest of
  // past runs (analysis.mjs), there too (TASK_DIGEST). `recheck()`: checks the spec again (the
  // runner's spec-check.mjs) right before `docker run`, after the waits for the tokens and the
  // engine, so that a host path swapped for a symlink meanwhile isn't mounted; throws to refuse.
  // → { engine: { backend, volume, cached } } when it has one.
  async function start(spec) {
    const { run, name, image, labels = {}, env: values = {}, tokens, engine, ca, digest } = spec;
    const { recheck = () => {} } = spec;
    const asked = now();
    const args = sandboxArgs(spec);
    await inbox.write(run, ca, digest);
    // Its own last: a spec's labels never make a sandbox another deployment's or another run's.
    const all = {
      ...labels,
      "deckhand.owner": config.prefix,
      "deckhand.run": run,
    };
    starting.add(run);
    let started = null;
    // Whether this start made its network: one it didn't (its name taken) isn't its to remove.
    let made = false;
    try {
      await networks.create(run, { onCreated: () => (made = true) });
      // The run's tokens, bound to its network's ID (../sandbox-spec.mjs tokenEnv()). Unset
      // values stay unset in the sandbox, as with `-e NAME` and no NAME.
      const bound = tokens ? await tokens(await networks.idOf(run)) : {};
      const env = Object.fromEntries(
        Object.entries({ ...bound, ...values }).filter(([, v]) => v !== undefined),
      );
      if (engine) started = await engines.start(run, name, labels, engine);
      // The engine's address is new on the network.
      if (started) networks.forget();
      // Not secrets: where the engine and the run's files are, as values.
      const engineVars = {
        ...(started ? engineEnv(started.backend) : {}),
        ...inbox.env(ca, digest),
      };
      await recheck();
      await labelSessions(spec.volumes);
      checked(
        await docker(runArgs({ run, name, image, labels: all, env, engineVars, args }), {
          env: cliEnv(env),
        }),
        "the sandbox didn't start",
      );
      // Its address is new: a lookup made since its network was created didn't see it.
      networks.forget();
      // `docker run --detach` returns once it runs: its image is local, its agent installed.
      metrics?.started((now() - asked) / 1000);
    } catch (error) {
      if (engine) await engines.remove(name, run);
      if (made) await networks.remove(run);
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
  // Docker's time, so a line read again after a restart keeps its own. `onCaughtUp()`: once,
  // when both streams are past the lines skipped (at once with none), before the next line.
  // `signal`: the caller is gone (the runner service's, ../../runner/service.mjs), `docker logs` ends.
  function follow(
    name,
    { skip = { out: 0, err: 0 }, onOut, onErr, onCaughtUp = () => {}, signal },
  ) {
    return new Promise((resolve) => {
      const child = spawn("docker", ["logs", "--follow", "--timestamps", name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (signal?.aborted) child.kill();
      signal?.addEventListener("abort", () => child.kill(), { once: true });
      // Whole lines, by bytes (lines.mjs): a character split between two chunks isn't
      // mangled. A handler that throws (its log's disk full, say) loses that line, not the
      // listener.
      let behind = 0;
      const past = () => {
        if (--behind) return;
        try {
          onCaughtUp();
        } catch (error) {
          log(`docker logs ${name}: ${error.stack ?? error}`);
        }
      };
      const lines = (stream, n, each) => {
        let seen = 0;
        const split = splitLines((line, at) => {
          if (seen++ < n) {
            if (seen === n) past();
            return;
          }
          try {
            each(line, at);
          } catch (error) {
            log(`docker logs ${name}: ${error.stack ?? error}`);
          }
        });
        stream.on("data", (data) => split(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      };
      behind = 1 + (skip.out > 0) + (skip.err > 0);
      lines(child.stdout, skip.out, onOut);
      lines(child.stderr, skip.err, onErr);
      past();
      child.on("error", (error) => log(`docker logs ${name}: ${error.message}`));
      child.on("close", resolve);
    });
  }

  // Its exit code once it exited, or null (running, gone): the runner's run events.
  async function exitCode(name) {
    const { code, out } = await docker(["inspect", "--format", "{{.State.ExitCode}}", name]);
    return code === 0 && /^-?\d+$/.test(out) ? Number(out) : null;
  }

  async function wait(name) {
    await docker(["wait", name]);
  }

  async function kill(name) {
    checked(await docker(["stop", "-t", String(KILL_GRACE_S), name]), `docker stop ${name}`);
  }

  // Without `run` (a leftover sandbox), its network is the one its label names.
  // Only a sandbox of this deployment's (its labels) and that run's: never a container of the
  // host's that has the name. Its engine and network check theirs too.
  async function remove(name, run) {
    const labels = await containerLabels(docker, name);
    const ours = labels?.owner === config.prefix && labels.run && (!run || labels.run === run);
    if (labels && !ours) log(`Not removing ${name}: not a sandbox of this deployment's`);
    const net = run ?? (ours ? labels.run : null);
    if (ours) await docker(["rm", "--force", name]);
    await engines.remove(name, net);
    if (net) await networks.remove(net);
    if (run) inbox.remove(run);
  }

  // The agent's session volume (its `session`), kept by the issue's runs.
  async function hasSession(name, agent = agentFor()) {
    return volumeExists(docker, `${name}-${agent.session.volume}`);
  }

  // The run's session volumes it makes, made first with this deployment's labels rather than
  // by `docker run -v`, which labels none: what removeSessions() checks. One that exists keeps
  // its own (Docker can't relabel a volume).
  async function labelSessions(volumes = []) {
    for (const { kind, name } of volumes) {
      if (kind !== "session" || (await volumeExists(docker, name))) continue;
      const labels = { "deckhand.owner": config.prefix, [ROLE]: "session" };
      checked(
        await docker(["volume", "create", ...labelArgs(labels), name]),
        `creating the session volume ${name}`,
      );
    }
  }

  // A chat's session volumes, each that exists (the runner service checks they are a chat's,
  // without a sandbox) and is this deployment's session volume: → the names removed. One
  // without labels was made before sessions had them (by `docker run -v`): its name, with the
  // deployment's prefix and the chat's hash, is all there is to go by.
  async function removeSessions(volumes) {
    const removed = [];
    for (const volume of volumes) {
      const labels = await volumeLabels(docker, volume);
      if (!labels) continue;
      const labelled = labels.owner || labels.engine || labels.role;
      if (labelled && (labels.owner !== config.prefix || labels.role !== "session")) {
        log(`Not removing ${volume}: not a session volume of this deployment's`);
        continue;
      }
      checked(await docker(["volume", "rm", volume]), `docker volume rm ${volume}`);
      removed.push(volume);
    }
    return removed;
  }

  return {
    start,
    list,
    state,
    exitCode,
    follow,
    send: inbox.send,
    close: inbox.close,
    closed: inbox.closed,
    resync: inbox.resync,
    wait,
    kill,
    remove,
    hasSession,
    // The engine of a sandbox that runs, as start() answered it, or null (volumes.mjs).
    engine: (name, run, engine) => engines.engineOf(name, run, engine),
    removeSessions,
    relink: createRelink({ config, docker, log, list, starting, networks, engines }),
    proxyAddresses: networks.proxyAddresses,
    locate: networks.locate,
  };
}
