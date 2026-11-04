// A run's container engine (engine.mjs) and its storage: the repo's cache volume when it keeps
// one and no other engine has it, else the run's own volume. The engine is on the run's
// network as `engine`, labelled deckhand.engine rather than deckhand.run so it is never taken
// for a sandbox, and removed with its run.
import { checked, containerLabels, labelArgs, removeVolume, volumeLabels } from "../docker.mjs";
import {
  ENGINE_HOST,
  SYSBOX_RUNTIME,
  engineArgs,
  engineBackend,
  engineName,
  engineVolume,
} from "./engine.mjs";

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
    await removeEngine(name);
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
        // Its own last: a spec's labels never make it another deployment's or another run's.
        ...labelArgs({ ...labels, ...owner, "deckhand.engine": run }),
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
  // Only one of this deployment's engines (its labels), and only that run's volume: never a
  // container or a volume of the host's that has the name (../../runner/service.mjs).
  async function remove(name, run) {
    await removeEngine(name, run);
    if (!run) return;
    caches.delete(run);
    const labels = await volumeLabels(docker, engineVolume(run));
    if (labels?.owner === config.prefix && labels.engine === run) {
      await removeVolume(docker, engineVolume(run));
    }
  }

  async function removeEngine(name, run) {
    const labels = await containerLabels(docker, engineName(name));
    if (!labels || labels.owner !== config.prefix || !labels.engine) return;
    if (run && labels.engine !== run) return;
    await docker(["rm", "--force", "--volumes", engineName(name)]);
  }

  // The run's cache volume is free again: its engine is gone (relink()).
  const release = (run) => caches.delete(run);

  // The engine the run's sandbox `name` has, as start() answered it, read back from its sidecar
  // (a start recovered after a crash, ../../runner/service.mjs): its runtime says the backend,
  // its mounts whether it has the repo's cache volume (`cache`, its base name). Null without one
  // of this deployment's for that run.
  async function engineOf(name, run, { cache } = {}) {
    const { code, out } = await docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "deckhand.owner"}}|{{index .Config.Labels "deckhand.engine"}}|{{.HostConfig.Runtime}}|{{range .Mounts}}{{.Name}} {{end}}',
      engineName(name),
    ]);
    if (code !== 0) return null;
    const [owner, engine, runtime = "", mounts = ""] = out.trim().split("|");
    if (owner !== config.prefix || engine !== run) return null;
    // start() runs Sysbox's sidecar under SYSBOX_RUNTIME (engine.mjs engineArgs()) and Podman's
    // under Docker's default: any other runtime is Podman's.
    const kind = runtime === SYSBOX_RUNTIME ? "sysbox" : "podman";
    const shared = cache ? `${cache}-${kind}` : null;
    const cached = !!shared && mounts.split(" ").includes(shared);
    if (cached) caches.set(run, shared);
    return { backend: kind, volume: cached ? shared : engineVolume(run), cached };
  }

  return { start, remove, release, engineOf };
}
