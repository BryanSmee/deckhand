// A run's container engine (engine.mjs) and its storage: the repo's cache volume when it keeps
// one and no other engine has it, else the run's own volume. The engine is on the run's
// network as `engine`, labelled deckhand.engine rather than deckhand.run so it is never taken
// for a sandbox, and removed with its run.
import { checked, labelArgs, removeVolume } from "../docker.mjs";
import { ENGINE_HOST, engineArgs, engineBackend, engineName, engineVolume } from "./engine.mjs";

export function createEngines({ config, docker }) {
  // Which engine this host runs (engine.mjs engineBackend()), asked once; again after a
  // failure (Sysbox installed meanwhile, say).
  let backend = null;
  function backendOf() {
    backend ??= (async () => {
      if (config.engine === "podman") return "podman";
      const { out } = checked(
        await docker(["info", "--format", "{{json .Runtimes}}"]),
        "docker info",
      );
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
  async function start(run, name, labels, { limits, cache }) {
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
    checked(
      await docker([
        ...["volume", "create"],
        ...labelArgs(cached ? owner : { ...owner, "deckhand.engine": run }),
        volume,
      ]),
      `creating the engine's volume ${volume}`,
    );
    checked(
      await docker([
        "run",
        "--detach",
        "--name",
        engineName(name),
        ...labelArgs({ ...owner, "deckhand.engine": run, ...labels }),
        ...["--network", run, "--network-alias", ENGINE_HOST],
        // Its only way out, like the sandbox's: pulls, builds and its containers go through it.
        ...["-e", `EGRESS_PROXY=${config.egressProxy}`],
        ...engineArgs(kind, { volume, limits }),
        kind === "sysbox" ? config.engineImage : config.enginePodmanImage,
      ]),
      "its container engine didn't start",
    );
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

  // The engine of the sandbox `name` and its run's own volume (with its image's anonymous
  // ones); the repo's cache volume stays. Either may be missing.
  async function remove(name, run) {
    await docker(["rm", "--force", "--volumes", engineName(name)]);
    if (!run) return;
    caches.delete(run);
    await removeVolume(docker, engineVolume(run));
  }

  // The run's cache volume is free again: its engine is gone (relink()).
  const release = (run) => caches.delete(run);

  return { start, remove, release };
}
