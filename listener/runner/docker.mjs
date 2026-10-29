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
//   wait(name)           until it exits
//   kill(name)           ends it now (a cancelled run, or one silent after its answer):
//                        SIGTERM, then SIGKILL after 10 s
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
import { createNetworks } from "./networks.mjs";
import { createEngines } from "./volumes.mjs";

export { CLOSE } from "./inbox.mjs";
export { aliasOf } from "./networks.mjs";

// How long a cancelled run's sandbox has between SIGTERM and SIGKILL.
const KILL_GRACE_S = 10;

// The longest line follow() keeps: past it, the line is cut and the rest of it, up to its
// newline, dropped. Unbounded, one line with no newline would grow until the string can't
// (about 512 MB) and throw in the stream's handler, which takes the listener down (#241).
export const MAX_LINE = 1024 * 1024;
export const LINE_CUT = " … (line cut)";

// The RFC 3339 time `docker logs --timestamps` starts each line with, nanoseconds and all.
const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d) /;

// Docker keeps a line over 16 KiB as parts of 16384 bytes, and --timestamps stamps each part
// again, inside the line (moby/moby#37681, docker/cli#4941): those stamps go too. A part may
// be a few bytes longer: its json-file driver turns the bytes of a character split between two
// parts into U+FFFDs (with or without --timestamps), so each inner stamp is looked for just
// past the part's 16384 bytes.
const PART = 16384;
const STAMP_MAX = 48; // bytes: "2026-10-29T08:00:00.123456789+02:00 " and some
const SLACK = 64; // bytes a part may grow by
const INNER = new RegExp(STAMP.source.slice(1));

const stampAt = (bytes, at) => STAMP.exec(bytes.subarray(at, at + STAMP_MAX).toString("latin1"));

// A line of `docker logs --timestamps`, as bytes → the line as written, and when (ms), or
// null for a line without the stamp. On bytes: a part may end inside a character.
export function unstamped(bytes) {
  const m = stampAt(bytes, 0);
  if (!m) return [bytes.toString("utf8"), null];
  // Date.parse() takes milliseconds, not Docker's nanoseconds.
  const at = Date.parse(m[1] + (m[2] ?? "").slice(0, 4) + m[3]);
  const parts = [];
  let from = m[0].length;
  while (from + PART < bytes.length) {
    const window = bytes.subarray(from + PART, from + PART + SLACK + STAMP_MAX);
    const inner = INNER.exec(window.toString("latin1"));
    if (!inner || inner.index > SLACK) break;
    const end = from + PART + inner.index;
    parts.push(bytes.subarray(from, end));
    from = end + inner[0].length;
  }
  parts.push(bytes.subarray(from));
  return [Buffer.concat(parts).toString("utf8"), Number.isNaN(at) ? null : at];
}

// The most bytes a line of MAX_LINE takes with its stamps.
const ROOM = MAX_LINE + (Math.ceil(MAX_LINE / PART) + 1) * STAMP_MAX;

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
  inboxDir, // the runs volume, as the listener mounts it
  log = () => {},
  now = Date.now,
}) {
  const inbox = createInbox({ config, inboxDir });
  const networks = createNetworks({ config, docker, log, now });
  const engines = createEngines({ config, docker });
  // Runs whose network exists before their sandbox does: relink() leaves them alone.
  const starting = new Set();

  // `spec`: sandboxSpec()'s. `env` values reach the container by name only (`-e NAME`), so
  // they never show in `ps`; its user, limits, caps and volumes become Docker's own options
  // (sandboxArgs()); `engine`: { limits, cache } for a run granted a
  // container engine, `cache` the base name of the repo's cache volume when it keeps one;
  // `ca`: the egress proxy's CA certificate (PEM), which the sandbox trusts, in its inbox
  // folder (DECKHAND_CA); `digest`: a run analysis's digest of past runs (analysis.mjs), there
  // too (TASK_DIGEST). → { engine: { backend, volume, cached } } when it has one.
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
      ...envArgs(engineVars),
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
  // Only whole lines count: one cut short is read again, whole, by the next follow(). A line
  // over MAX_LINE is cut there and counts as one line, the same for the next follow(). Each
  // handler gets the line and when Docker says it was written (ms; null without a stamp):
  // Docker's time, so a line read again after a restart keeps its own.
  function follow(name, { skip = { out: 0, err: 0 }, onOut, onErr }) {
    return new Promise((resolve) => {
      const child = spawn("docker", ["logs", "--follow", "--timestamps", name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      // By bytes, decoded once a line is whole (unstamped()): a character split between two
      // chunks isn't mangled.
      const lines = (stream, n, each) => {
        let rest = [];
        let size = 0;
        let cut = false; // the current line was cut: dropped up to its newline
        let seen = 0;
        // A handler that throws (its log's disk full, say) loses that line, not the listener.
        // `over`: it went past ROOM, and was cut there.
        const emit = (stamped, over = false) => {
          if (seen++ < n) return;
          const [line, at] = unstamped(stamped);
          const kept = over || line.length > MAX_LINE ? line.slice(0, MAX_LINE) + LINE_CUT : line;
          try {
            each(kept, at);
          } catch (error) {
            log(`docker logs ${name}: ${error.stack ?? error}`);
          }
        };
        const take = () => {
          const line = Buffer.concat(rest);
          rest = [];
          size = 0;
          return line;
        };
        // A chunk is at most the pipe's buffer: `rest` stays near ROOM.
        const add = (part) => {
          if (cut || !part.length) return;
          rest.push(part);
          size += part.length;
          if (size <= ROOM) return;
          emit(take(), true);
          cut = true;
        };
        stream.on("data", (data) => {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          let from = 0;
          for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, from)) {
            add(chunk.subarray(from, i));
            if (cut) take();
            else emit(take());
            cut = false;
            from = i + 1;
          }
          add(chunk.subarray(from));
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
