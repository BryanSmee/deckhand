// After a restart of the listener or the proxy (`docker compose up -d` recreates them without
// the networks they were joined to), each running sandbox's networks get them back. Networks,
// engines and engine volumes of this deployment whose run has no sandbox any more are removed.
import { removeVolume } from "../docker.mjs";

// `list`: the runner's; `starting`: runs whose network exists before their sandbox does, left
// alone; `networks`: networks.mjs; `engines`: volumes.mjs.
export function createRelink({ config, docker, log, list, starting, networks, engines }) {
  return async function relink() {
    // Networks and engines first, then sandboxes, with the runs starting in between: one
    // listed here either has its sandbox listed below or belongs to a run still starting.
    const owned = ["--filter", `label=deckhand.owner=${config.prefix}`];
    const nets = await docker([
      ...["network", "ls", ...owned, "--filter", "label=deckhand.run"],
      ...["--format", "{{.Name}}"],
    ]);
    const engineList = await docker([
      ...["ps", "--all", ...owned, "--filter", "label=deckhand.engine"],
      ...["--format", '{{.Names}}\t{{.Label "deckhand.engine"}}'],
    ]);
    const volumes = await docker([
      ...["volume", "ls", ...owned, "--filter", "label=deckhand.engine"],
      ...["--format", '{{.Name}}\t{{.Label "deckhand.engine"}}'],
    ]);
    const pending = new Set(starting);
    const sandboxes = await list();
    await rejoin(sandboxes.filter((s) => s.running));
    const runs = new Set(sandboxes.map((s) => s.run));
    const gone = (result) =>
      result.code !== 0
        ? []
        : result.out
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split("\t"))
            .filter(([, run]) => run && !runs.has(run) && !pending.has(run));
    for (const [engine, run] of gone(engineList)) {
      log(`Removing the container engine ${engine}: its run is gone`);
      await docker(["rm", "--force", "--volumes", engine]);
      engines.release(run);
    }
    for (const [volume] of gone(volumes)) {
      log(`Removing the volume ${volume}: its run is gone`);
      await removeVolume(docker, volume);
    }
    if (nets.code !== 0) return;
    for (const net of nets.out.split("\n").filter(Boolean)) {
      if (runs.has(net) || pending.has(net)) continue;
      log(`Removing the network ${net}: its run is gone`);
      await networks.remove(net);
    }
  };

  // The proxy, back on the networks of the `running` sandboxes.
  async function rejoin(running) {
    const wanted = new Set();
    for (const s of running) {
      for (const net of Object.keys((await networks.networksOf(s.name)) ?? {})) wanted.add(net);
    }
    if (!wanted.size) return;
    for (const peer of await networks.peers()) {
      const joined = Object.keys((await networks.networksOf(peer.container)) ?? {});
      for (const net of wanted) {
        if (joined.includes(net)) continue;
        log(`Joining ${peer.container} to the network ${net} again`);
        // Its run may be ending meanwhile: the others still get theirs.
        await networks.connect(net, peer).catch((error) => log(error.message));
      }
    }
  }
}
