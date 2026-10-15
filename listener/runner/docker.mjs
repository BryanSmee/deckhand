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
//   remove(name, run)    the sandbox, its network and its inbox
//   hasSession(name, agent)  whether its issue has a session of that agent already (a
//                        previous run)
//   address(name)        its addresses on its network
//   relink()             joins the listener and the proxy to running sandboxes' networks
//                        again, and removes the networks of runs that are gone
//   proxyAddresses()     the egress proxy's addresses, on all of its networks
//
// Each run has a network of its own, internal (no route out), named after the run: sandboxes
// can't reach each other. The listener (its broker) and the egress proxy join each one, under
// the host names sandboxes know them by (BROKER_URL, EGRESS_PROXY).
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

// The inbox's last line once the listener is done with it.
export const CLOSE = JSON.stringify({ type: "deckhand", event: "close" });

// Where the inbox is, inside the sandbox.
const INBOX_DIR = "/deckhand";
const INBOX = "inbox.jsonl";

// How long the proxy's addresses are trusted, and how often a caller that isn't among them
// may make the runner look again (a sandbox could ask the broker's port in a loop).
const PROXY_TTL_MS = 10000;
const PROXY_RETRY_MS = 2000;

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

  // `spec`: { run, name, image, labels, env, args }. `env` values reach the container by
  // name only (`-e NAME`), so they never show in `ps`; `args`: Docker's own options
  // (hardening, limits, volumes).
  async function start({ run, name, image, labels = {}, env: values = {}, args = [] }) {
    // Unset values stay unset in the sandbox, as with `-e NAME` and no NAME.
    const env = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    mkdirSync(join(inboxDir, run), { recursive: true });
    chmodSync(join(inboxDir, run), 0o755); // the sandbox runs as uid 1000 and only reads
    writeFileSync(inbox(run), "");
    const all = {
      "deckhand.owner": config.prefix,
      "deckhand.run": run,
      ...labels,
    };
    starting.add(run);
    try {
      await createNetwork(run);
      const { code, err } = await docker(
        [
          "run",
          "--detach",
          "--init",
          "--name",
          name,
          ...Object.entries(all).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
          ...Object.keys(env).flatMap((k) => ["-e", k]),
          "-e",
          `TASK_INBOX=${INBOX_DIR}/${INBOX}`,
          "--mount",
          `type=volume,src=${config.runsVolume},dst=${INBOX_DIR},volume-subpath=${run},readonly`,
          "--network",
          run,
          ...args,
          image,
        ],
        { env: { ...process.env, ...env } },
      );
      if (code !== 0) throw new Error(`the sandbox didn't start: ${err || `docker exit ${code}`}`);
    } catch (error) {
      await removeNetwork(run);
      throw error;
    } finally {
      starting.delete(run);
    }
  }

  // The run's own network: internal, so the proxy is its only way out (checked rather than
  // assumed), with the listener and the proxy on it. Docker refuses a name already taken.
  async function createNetwork(run) {
    const created = await docker([
      "network",
      "create",
      "--internal",
      ...["--label", `deckhand.owner=${config.prefix}`, "--label", `deckhand.run=${run}`],
      run,
    ]);
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

  // Without `run` (a leftover sandbox), its network is the one its label names.
  async function remove(name, run) {
    const net = run ?? (await runOf(name));
    await docker(["rm", "--force", name]);
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
  // started.
  async function address(name) {
    const nets = await networksOf(name);
    if (!nets) return null;
    const all = Object.values(nets).flatMap((n) => [n?.IPAddress, n?.GlobalIPv6Address]);
    const found = all.filter(Boolean);
    return found.length ? found : null;
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
  // back. Networks of this deployment whose run has no sandbox any more are removed.
  async function relink() {
    // Networks first, then sandboxes, with the runs starting in between: a network listed
    // here either has its sandbox listed below or belongs to a run still starting.
    const nets = await docker([
      "network",
      "ls",
      "--filter",
      `label=deckhand.owner=${config.prefix}`,
      "--filter",
      "label=deckhand.run",
      "--format",
      "{{.Name}}",
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
    if (nets.code !== 0) return;
    const runs = new Set(sandboxes.map((s) => s.run));
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
    remove,
    hasSession,
    address,
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
