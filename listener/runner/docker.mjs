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
// Each run has a network of its own, internal (no route out), named after the run: sandboxes
// can't reach each other. The listener (its broker) and the egress proxy join each one, under
// the host names sandboxes know them by (BROKER_URL, EGRESS_PROXY). A run granted a container
// engine (engine.mjs) has it there too, as `engine`: labelled deckhand.engine rather than
// deckhand.run, so it is never taken for a sandbox, and removed with its run.
//
// Messages go through a file rather than the container's stdin: a pipe dies with the
// listener, a file in a volume doesn't. Each run has a folder in the runs volume, mounted
// read-only into its sandbox, where the listener appends the agent's messages (its
// message()) and finally a close line; ../sandbox/deckhand-inbox follows it into the agent's
// input.
import { spawn as nodeSpawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { agentFor } from "../agents/index.mjs";
import {
  ENGINE_HOST,
  engineArgs,
  engineBackend,
  engineEnv,
  engineName,
  engineVolume,
} from "./engine.mjs";
import { freeBlocks } from "../subnets.mjs";

// The inbox's last line once the listener is done with it.
export const CLOSE = JSON.stringify({ type: "deckhand", event: "close" });

// Where the inbox is, inside the sandbox.
const INBOX_DIR = "/deckhand";
const CA_FILE = "egress-ca.crt";
const DIGEST_FILE = "digest.md";
const INBOX = "inbox.jsonl";

// How long the proxy's addresses are trusted, and how often a caller that isn't among them
// may make the runner look again (a sandbox could ask the broker's port in a loop).
const PROXY_TTL_MS = 10000;
const PROXY_RETRY_MS = 2000;

// How many free-looking blocks of SANDBOX_SUBNETS a run's network tries when Docker says
// each overlaps (another project took it since the listener looked).
const SUBNET_TRIES = 5;

// How long a cancelled run's sandbox has between SIGTERM and SIGKILL.
const KILL_GRACE_S = 10;

// What compose.yaml labels the egress proxy with, so the listener finds it.
const ROLE = "deckhand.role";
const PROJECT = "com.docker.compose.project";

export function createDockerRunner({
  config,
  docker, // ../docker.mjs
  spawn = nodeSpawn, // `docker logs --follow`, a stream rather than one answer
  inboxDir, // the runs volume, as the listener mounts it
  log = () => {},
  now = Date.now,
}) {
  const inbox = (run) => join(inboxDir, run, INBOX);
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
    writeInbox(run, ca, digest);
    const all = {
      "deckhand.owner": config.prefix,
      "deckhand.run": run,
      ...labels,
    };
    starting.add(run);
    let started = null;
    try {
      await createNetwork(run);
      if (engine) started = await startEngine(run, name, labels, engine);
      // Not secrets: where the engine is, as values.
      const engineVars = started ? engineEnv(started.backend) : {};
      const { code, err } = await docker(
        runArgs({ run, name, image, labels: all, env, engineVars, args, ca, digest }),
        { env: { ...process.env, ...env } },
      );
      if (code !== 0) throw new Error(`the sandbox didn't start: ${err || `docker exit ${code}`}`);
    } catch (error) {
      if (engine) await removeEngine(name, run);
      await removeNetwork(run);
      throw error;
    } finally {
      starting.delete(run);
    }
    return { engine: started };
  }

  // The run's inbox folder, which the sandbox mounts read-only: its inbox file, empty, and the
  // proxy's CA and the digest when start() has them.
  function writeInbox(run, ca, digest) {
    mkdirSync(join(inboxDir, run), { recursive: true });
    chmodSync(join(inboxDir, run), 0o755); // the sandbox runs as uid 1000 and only reads
    writeFileSync(inbox(run), "");
    if (ca) writeFileSync(join(inboxDir, run, CA_FILE), ca, { mode: 0o644 });
    if (digest) writeFileSync(join(inboxDir, run, DIGEST_FILE), digest, { mode: 0o644 });
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
      ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      ...Object.keys(env).flatMap((k) => ["-e", k]),
      ...Object.entries(engineVars).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "-e",
      `TASK_INBOX=${INBOX_DIR}/${INBOX}`,
      ...(ca ? ["-e", `DECKHAND_CA=${INBOX_DIR}/${CA_FILE}`] : []),
      ...(digest ? ["-e", `TASK_DIGEST=${INBOX_DIR}/${DIGEST_FILE}`] : []),
      "--mount",
      `type=volume,src=${config.runsVolume},dst=${INBOX_DIR},volume-subpath=${run},readonly`,
      "--network",
      run,
      ...args,
      image,
    ];
  }

  // Which engine this host runs (engine.mjs engineBackend()), asked once; again after a
  // failure (Sysbox installed meanwhile, say).
  let backend = null;
  function backendOf() {
    backend ??= (async () => {
      if (config.engine === "podman") return "podman";
      const { code, out, err } = await docker(["info", "--format", "{{json .Runtimes}}"]);
      if (code !== 0) throw new Error(`docker info: ${err || `exit ${code}`}`);
      let runtimes = {};
      try {
        runtimes = JSON.parse(out || "{}") ?? {};
      } catch {
        // Unreadable: as if it had none.
      }
      return engineBackend(config.engine, Object.keys(runtimes));
    })();
    backend.catch(() => (backend = null));
    return backend;
  }

  // Cache volumes in use, by the run whose engine has them: an engine locks its storage, so a
  // second run of the repo meanwhile gets a volume of its own. `docker ps` covers engines a
  // previous listener started.
  const caches = new Map();

  // The run's engine, on its network before its sandbox starts, so it is there for the
  // repo's setup. Its storage: the repo's cache volume (one per backend: their layouts
  // differ) when it keeps one and no other engine has it, else the run's own volume.
  async function startEngine(run, name, labels, { limits, cache }) {
    const kind = await backendOf();
    const shared = cache ? `${cache}-${kind}` : null;
    let cached = false;
    if (shared && ![...caches.values()].includes(shared)) {
      caches.set(run, shared);
      cached = !(await volumeUsed(shared));
      if (!cached) caches.delete(run);
    }
    const volume = cached ? shared : engineVolume(run);
    const owner = { "deckhand.owner": config.prefix };
    // One left by a run that never got its sandbox: a task has one run at a time.
    await docker(["rm", "--force", "--volumes", engineName(name)]);
    await createVolume(volume, cached ? owner : { ...owner, "deckhand.engine": run });
    const { code, err } = await docker([
      "run",
      "--detach",
      "--name",
      engineName(name),
      ...Object.entries({ ...owner, "deckhand.engine": run, ...labels }).flatMap(([k, v]) => [
        "--label",
        `${k}=${v}`,
      ]),
      ...["--network", run, "--network-alias", ENGINE_HOST],
      // Its only way out, like the sandbox's: pulls, builds and its containers go through it.
      ...["-e", `EGRESS_PROXY=${config.egressProxy}`],
      ...engineArgs(kind, { volume, limits }),
      kind === "sysbox" ? config.engineImage : config.enginePodmanImage,
    ]);
    if (code !== 0) {
      throw new Error(`its container engine didn't start: ${err || `docker exit ${code}`}`);
    }
    return { backend: kind, volume, cached };
  }

  async function volumeUsed(volume) {
    const { code, out } = await docker([
      "ps",
      "--all",
      "--filter",
      `volume=${volume}`,
      "--format",
      "{{.Names}}",
    ]);
    return code !== 0 || out.trim() !== ""; // not knowing isn't "free"
  }

  async function createVolume(volume, labels) {
    const { code, err } = await docker([
      "volume",
      "create",
      ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      volume,
    ]);
    if (code !== 0) throw new Error(`creating the engine's volume ${volume}: ${err || code}`);
  }

  // The engine of the sandbox `name` and its run's own volume (with its image's anonymous
  // ones); the repo's cache volume stays. Either may be missing.
  async function removeEngine(name, run) {
    await docker(["rm", "--force", "--volumes", engineName(name)]);
    if (!run) return;
    caches.delete(run);
    const volume = engineVolume(run);
    if ((await docker(["volume", "inspect", volume])).code === 0) {
      await docker(["volume", "rm", volume]);
    }
  }

  // The run's own network: internal, so the proxy is its only way out (checked rather than
  // assumed), with the listener and the proxy on it. Docker refuses a name already taken.
  async function createNetwork(run) {
    const created = await newNetwork(run);
    if (created.code !== 0) {
      throw new Error(`the run's network ${run} wasn't created: ${created.err || created.code}`);
    }
    const { code, out } = await docker(["network", "inspect", "--format", "{{.Internal}}", run]);
    if (code !== 0 || out !== "true") {
      throw new Error(
        `the run's network ${run} is ${code === 0 ? "not internal" : "missing"}: its sandbox would bypass the egress proxy (see docs/security.md)`,
      );
    }
    for (const peer of await peers()) await connect(run, peer);
  }

  // With SANDBOX_SUBNETS, on the lowest block no network on the host uses; Docker's own
  // pools otherwise.
  async function newNetwork(run) {
    const args = [
      "network",
      "create",
      "--internal",
      ...["--label", `deckhand.owner=${config.prefix}`, "--label", `deckhand.run=${run}`],
    ];
    const { subnets } = config;
    if (!subnets) return docker([...args, run]);
    let tries = 0;
    for (const block of freeBlocks(subnets, await usedSubnets())) {
      const created = await docker([...args, "--subnet", block, run]);
      if (created.code === 0 || !/overlap/i.test(created.err) || ++tries >= SUBNET_TRIES) {
        return created;
      }
      log(`The network ${run}: ${block} is taken, trying the next block`);
    }
    throw new Error(
      `the run's network ${run} wasn't created: no free block of /${subnets.size} left in SANDBOX_SUBNETS (${subnets.range}). Set a larger range or a lower MAX_PARALLEL (docs/setup.md)`,
    );
  }

  // Every network's subnets, Deckhand's or not.
  async function usedSubnets() {
    const ids = await docker(["network", "ls", "--quiet", "--no-trunc"]);
    if (ids.code !== 0) throw new Error(`docker network ls: ${ids.err || `exit ${ids.code}`}`);
    const all = ids.out.split("\n").filter(Boolean);
    if (!all.length) return [];
    // One removed meanwhile makes Docker exit 1 after printing the others: those still count.
    const { out } = await docker([
      "network",
      "inspect",
      "--format",
      "{{range .IPAM.Config}}{{.Subnet}} {{end}}",
      ...all,
    ]);
    return out.split(/\s+/).filter(Boolean);
  }

  // Disconnects whatever is still on it first: Docker refuses to remove a network in use.
  async function removeNetwork(net) {
    const { code, out } = await docker([
      "network",
      "inspect",
      "--format",
      "{{range $id, $c := .Containers}}{{$id}} {{end}}",
      net,
    ]);
    if (code !== 0) return; // no such network
    for (const id of out.split(" ").filter(Boolean)) {
      await docker(["network", "disconnect", "--force", net, id]);
    }
    const removed = await docker(["network", "rm", net]);
    if (removed.code !== 0) log(`Removing the network ${net}: ${removed.err || removed.code}`);
  }

  async function connect(net, { container, alias }) {
    const { code, err } = await docker([
      "network",
      "connect",
      ...(alias ? ["--alias", alias] : []),
      net,
      container,
    ]);
    // Already there: a relink() racing a start(), say.
    if (code !== 0 && !/already exists/i.test(err)) {
      throw new Error(
        `joining ${container} to the network ${net}: ${err || `docker exit ${code}`}`,
      );
    }
  }

  // The listener's and the proxy's containers, with the names sandboxes call them by: the
  // listener is the container it runs in (LISTENER_CONTAINER, or its host name, Docker's
  // short id); the proxy is EGRESS_CONTAINER, or the container labelled deckhand.role=egress
  // in the listener's compose project. Looked up each time: `docker compose up -d` recreates
  // them under new ids.
  async function peers() {
    const listener = config.listenerContainer || hostname();
    const project = await docker([
      "inspect",
      "--format",
      `{{index .Config.Labels "${PROJECT}"}}`,
      listener,
    ]);
    if (project.code !== 0) {
      throw new Error(
        `the listener's container ${listener} wasn't found: set LISTENER_CONTAINER (docs/setup.md)`,
      );
    }
    return [
      { container: listener, alias: aliasOf(config.brokerUrl) },
      { container: await egressContainer(project.out), alias: aliasOf(config.egressProxy) },
    ];
  }

  async function egressContainer(project) {
    if (config.egressContainer) return config.egressContainer;
    const { code, out, err } = await docker([
      "ps",
      "--filter",
      `label=${ROLE}=egress`,
      ...(project ? ["--filter", `label=${PROJECT}=${project}`] : []),
      "--format",
      "{{.ID}}",
    ]);
    const found = code === 0 ? out.split("\n").filter(Boolean) : [];
    if (found.length !== 1) {
      throw new Error(
        `the egress proxy's container wasn't found (${code === 0 ? `${found.length} labelled ${ROLE}=egress` : err}): set EGRESS_CONTAINER (docs/setup.md)`,
      );
    }
    return found[0];
  }

  async function list() {
    const { code, out, err } = await docker([
      "ps",
      "--all",
      "--filter",
      `label=deckhand.owner=${config.prefix}`,
      "--filter",
      "label=deckhand.run",
      "--format",
      '{{.Names}}\t{{.Label "deckhand.run"}}\t{{.State}}',
    ]);
    if (code !== 0) throw new Error(`docker ps: ${err || `exit ${code}`}`);
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

  function send(run, text, agent = agentFor()) {
    appendFileSync(inbox(run), agent.message(text) + "\n");
  }

  function close(run) {
    if (!closed(run)) appendFileSync(inbox(run), CLOSE + "\n");
  }

  function closed(run) {
    try {
      return readFileSync(inbox(run), "utf8").trimEnd().split("\n").at(-1) === CLOSE;
    } catch {
      return true; // no inbox: nothing can reach that run
    }
  }

  async function wait(name) {
    await docker(["wait", name]);
  }

  async function kill(name) {
    const { code, err } = await docker(["stop", "-t", String(KILL_GRACE_S), name]);
    if (code !== 0) throw new Error(`docker stop ${name}: ${err || `exit ${code}`}`);
  }

  // Without `run` (a leftover sandbox), its network is the one its label names.
  async function remove(name, run) {
    const net = run ?? (await runOf(name));
    await docker(["rm", "--force", name]);
    await removeEngine(name, net);
    if (net) await removeNetwork(net);
    if (run) rmSync(join(inboxDir, run), { recursive: true, force: true });
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
    return (await docker(["volume", "inspect", `${name}-${agent.session.volume}`])).code === 0;
  }

  // On every network it is on: its own, or the shared one of a sandbox an older listener
  // started. Its engine's count as its own: the engine's pulls and containers go out under
  // the run's hosts.
  async function address(name) {
    const found = [...((await addressesOf(name)) ?? []), ...((await engineAddress(name)) ?? [])];
    return found.length ? found : null;
  }

  // Its engine's alone: the egress proxy never decrypts their HTTPS, as the engine's builds
  // and containers don't trust Deckhand's CA.
  async function engineAddress(name) {
    return addressesOf(engineName(name));
  }

  async function addressesOf(container) {
    const nets = await networksOf(container);
    if (!nets) return null;
    const all = Object.values(nets).flatMap((n) => [n?.IPAddress, n?.GlobalIPv6Address]);
    return all.filter(Boolean);
  }

  async function networksOf(container) {
    const { code, out } = await docker([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      container,
    ]);
    try {
      return code === 0 ? JSON.parse(out) : null;
    } catch {
      return null; // gone meanwhile
    }
  }

  // After a restart of the listener or the proxy (`docker compose up -d` recreates them
  // without the networks they were joined to), each running sandbox's networks get them
  // back. Networks, engines and engine volumes of this deployment whose run has no sandbox
  // any more are removed.
  async function relink() {
    // Networks and engines first, then sandboxes, with the runs starting in between: one
    // listed here either has its sandbox listed below or belongs to a run still starting.
    const owned = ["--filter", `label=deckhand.owner=${config.prefix}`];
    const nets = await docker([
      ...["network", "ls", ...owned, "--filter", "label=deckhand.run"],
      ...["--format", "{{.Name}}"],
    ]);
    const engines = await docker([
      ...["ps", "--all", ...owned, "--filter", "label=deckhand.engine"],
      ...["--format", '{{.Names}}\t{{.Label "deckhand.engine"}}'],
    ]);
    const volumes = await docker([
      ...["volume", "ls", ...owned, "--filter", "label=deckhand.engine"],
      ...["--format", '{{.Name}}\t{{.Label "deckhand.engine"}}'],
    ]);
    const pending = new Set(starting);
    const sandboxes = await list();
    const wanted = new Set();
    for (const s of sandboxes.filter((s) => s.running)) {
      for (const net of Object.keys((await networksOf(s.name)) ?? {})) wanted.add(net);
    }
    if (wanted.size) {
      for (const peer of await peers()) {
        const joined = Object.keys((await networksOf(peer.container)) ?? {});
        for (const net of wanted) {
          if (joined.includes(net)) continue;
          log(`Joining ${peer.container} to the network ${net} again`);
          // Its run may be ending meanwhile: the others still get theirs.
          await connect(net, peer).catch((error) => log(error.message));
        }
      }
    }
    const runs = new Set(sandboxes.map((s) => s.run));
    const gone = (result) =>
      result.code !== 0
        ? []
        : result.out
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split("\t"))
            .filter(([, run]) => run && !runs.has(run) && !pending.has(run));
    for (const [engine, run] of gone(engines)) {
      log(`Removing the container engine ${engine}: its run is gone`);
      await docker(["rm", "--force", "--volumes", engine]);
      caches.delete(run);
    }
    for (const [volume] of gone(volumes)) {
      log(`Removing the volume ${volume}: its run is gone`);
      await docker(["volume", "rm", volume]);
    }
    if (nets.code !== 0) return;
    for (const net of nets.out.split("\n").filter(Boolean)) {
      if (runs.has(net) || pending.has(net)) continue;
      log(`Removing the network ${net}: its run is gone`);
      await removeNetwork(net);
    }
  }

  // Cached: the proxy asks for each connection. A caller that isn't among them makes the
  // runner look again (the proxy may have been recreated), at most every PROXY_RETRY_MS.
  let proxy = { at: -Infinity, addresses: [] };
  async function proxyAddresses({ fresh = false } = {}) {
    const age = now() - proxy.at;
    if (age < PROXY_TTL_MS && !(fresh && age >= PROXY_RETRY_MS)) return proxy.addresses;
    const at = now();
    let addresses = [];
    try {
      const container = config.egressContainer || (await peers())[1].container;
      const nets = (await networksOf(container)) ?? {};
      addresses = Object.values(nets)
        .flatMap((n) => [n?.IPAddress, n?.GlobalIPv6Address])
        .filter(Boolean);
    } catch (error) {
      log(`Looking up the egress proxy: ${error.message}`);
    }
    proxy = { at, addresses };
    return addresses;
  }

  return {
    start,
    list,
    state,
    follow,
    send,
    close,
    closed,
    wait,
    kill,
    remove,
    hasSession,
    address,
    engineAddress,
    relink,
    proxyAddresses,
  };
}

// "http://listener:8081" → "listener": the name a sandbox calls it by on its network. None
// for an address (the tests'): there is no name to give.
export function aliasOf(url) {
  const host = new URL(url).hostname;
  return /^[\d.]+$|^\[/.test(host) ? null : host;
}
