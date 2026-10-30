// Each run has a network of its own, internal (no route out), named after the run: sandboxes
// can't reach each other. The listener (its broker) and the egress proxy join each one, under
// the host names sandboxes know them by (BROKER_URL, EGRESS_PROXY).
import { hostname } from "node:os";
import { checked, labelArgs } from "../docker.mjs";
import { freeBlocks } from "../subnets.mjs";

// How long the proxy's addresses are trusted, and how often a caller that isn't among them
// may make the runner look again (a sandbox could ask the broker's port in a loop).
const PROXY_TTL_MS = 10000;
const PROXY_RETRY_MS = 2000;

// How many free-looking blocks of SANDBOX_SUBNETS a run's network tries when Docker says
// each overlaps (another project took it since the listener looked).
const SUBNET_TRIES = 5;

// What compose.yaml labels the egress proxy with, so the listener finds it.
const ROLE = "deckhand.role";
const PROJECT = "com.docker.compose.project";

export function createNetworks({ config, docker, log, now }) {
  // The run's own network: internal, so the proxy is its only way out (checked rather than
  // assumed), with the listener and the proxy on it. Docker refuses a name already taken.
  async function create(run) {
    checked(await newNetwork(run), `the run's network ${run} wasn't created`);
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
      ...labelArgs({ "deckhand.owner": config.prefix, "deckhand.run": run }),
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
    const ids = checked(
      await docker(["network", "ls", "--quiet", "--no-trunc"]),
      "docker network ls",
    );
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
  async function remove(net) {
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
    const result = await docker([
      "network",
      "connect",
      ...(alias ? ["--alias", alias] : []),
      net,
      container,
    ]);
    // Already there: a relink() racing a start(), say.
    if (!/already exists/i.test(result.err)) {
      checked(result, `joining ${container} to the network ${net}`);
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

  // A container's networks, by name; null when it is gone.
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

  // Its addresses, on all of its networks.
  async function addressesOf(container) {
    const nets = await networksOf(container);
    if (!nets) return null;
    const all = Object.values(nets).flatMap((n) => [n?.IPAddress, n?.GlobalIPv6Address]);
    return all.filter(Boolean);
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
      addresses = (await addressesOf(container)) ?? [];
    } catch (error) {
      log(`Looking up the egress proxy: ${error.message}`);
    }
    proxy = { at, addresses };
    return addresses;
  }

  // Where an address is on the runs' networks: { sandbox, name }, the ID of the network and the
  // name of the container that has it there (a sandbox, its engine, the listener, the proxy), or
  // null: what a run's tokens are bound to (../broker.mjs check()), and what the egress policy
  // finds a connection's run by (../broker-http.mjs taskWhere()). IDs, not names or addresses:
  // both are reused, an ID never. Cached, as each call to the broker asks; forgotten whenever a
  // network is created or removed or a container joins one, so an address never names a
  // network that is gone. One not found makes the runner look again, at most every
  // PROXY_RETRY_MS.
  let sandboxes = { at: -Infinity, byAddress: new Map() };
  let generation = 0; // counts forget()s
  async function locate(ip) {
    const age = now() - sandboxes.at;
    const known = sandboxes.byAddress.get(ip);
    if (known && age < PROXY_TTL_MS) return known;
    if (age < PROXY_RETRY_MS) return known ?? null;
    const at = now();
    const seen = generation;
    const byAddress = new Map();
    try {
      for (const [address, where] of await runAddresses()) byAddress.set(address, where);
    } catch (error) {
      log(`Looking up the runs' networks: ${error.message}`);
    }
    // Unless one was created or removed meanwhile: its answer would be older than that.
    if (seen === generation) sandboxes = { at, byAddress };
    return byAddress.get(ip) ?? null;
  }

  // [address, { sandbox: network ID, name }] of every container on this deployment's runs'
  // networks. Neither a container's name nor an address has a space or a "|".
  async function runAddresses() {
    const { out } = checked(
      await docker([
        "network",
        "ls",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=deckhand.owner=${config.prefix}`,
        "--filter",
        "label=deckhand.run",
      ]),
      "docker network ls",
    );
    const ids = out.split("\n").filter(Boolean);
    if (!ids.length) return [];
    // One removed meanwhile makes Docker exit 1 after printing the others.
    const listed = await docker([
      "network",
      "inspect",
      "--format",
      "{{.Id}}{{range .Containers}} {{.Name}}|{{.IPv4Address}}|{{.IPv6Address}}{{end}}",
      ...ids,
    ]);
    return listed.out
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [id, ...containers] = line.split(" ").filter(Boolean);
        return containers.flatMap((c) => {
          const [name, ...addresses] = c.split("|");
          return addresses
            .filter(Boolean)
            .map((a) => [a.replace(/\/\d+$/, ""), { sandbox: id, name }]);
        });
      });
  }

  // Its ID, once created.
  async function idOf(net) {
    return checked(
      await docker(["network", "inspect", "--format", "{{.Id}}", net]),
      `the run's network ${net}`,
    ).out;
  }

  function forget() {
    generation++;
    sandboxes = { at: -Infinity, byAddress: new Map() };
  }

  return {
    create: async (run) => (forget(), await create(run)),
    remove: async (net) => {
      try {
        return await remove(net);
      } finally {
        forget();
      }
    },
    idOf,
    locate,
    // For a container that joined a network: its address must be looked up again.
    forget,
    connect,
    peers,
    networksOf,
    addressesOf,
    proxyAddresses,
  };
}

// "http://listener:8081" → "listener": the name a sandbox calls it by on its network. None
// for an address (the tests'): there is no name to give.
export function aliasOf(url) {
  const host = new URL(url).hostname;
  return /^[\d.]+$|^\[/.test(host) ? null : host;
}
