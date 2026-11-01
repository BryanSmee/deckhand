// The docker CLI, the listener's only way to the host's Docker. Injected into the Docker
// runner (runner/index.mjs) and its parts, so their tests play Docker instead.
import { spawn } from "node:child_process";

// Resolves with { code, out, err } (trimmed). `input`: written to stdin, then closed.
// `onData`: stdout and stderr chunks as they come (build logs), not kept in out/err. `env`:
// the CLI's environment, for `-e NAME` values that must not show in `ps`.
export function docker(args, { input, onData, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (onData ? onData(d) : (out += d)));
    child.stderr.on("data", (d) => (onData ? onData(d) : (err += d)));
    if (input !== undefined) {
      child.stdin.on("error", () => {}); // exited without reading it all
      child.stdin.end(input);
    }
    child.on("error", (error) => resolve({ code: -1, out: "", err: error.message }));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// No capabilities but `caps`, no privilege gain through setuid binaries: every container
// Deckhand starts but the engine sidecar (runner/engine.mjs).
export function hardening(...caps) {
  return [
    ...["--cap-drop", "ALL"],
    ...caps.flatMap((cap) => ["--cap-add", cap]),
    ...["--security-opt", "no-new-privileges"],
  ];
}

// The repo's limits (no swap beyond its memory).
export function limitArgs(limits) {
  return [
    ...["--cpus", limits.cpus, "--memory", limits.memory, "--memory-swap", limits.memory],
    ...["--pids-limit", String(limits.pids)],
  ];
}

// { "deckhand.run": "x" } → ["--label", "deckhand.run=x"].
export function labelArgs(labels) {
  return Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
}

// docker()'s `result`, or an error saying `what` failed and why: Docker's message, else its
// exit code.
export function checked(result, what) {
  if (result.code !== 0) throw new Error(`${what}: ${result.err || `exit ${result.code}`}`);
  return result;
}

export async function volumeExists(docker, name) {
  return (await docker(["volume", "inspect", name])).code === 0;
}

// A volume that may be missing.
// A container's labels Deckhand reads (its owner, its run, the run it is the engine of), or
// null when there is none: what the runner checks before it removes one.
export async function containerLabels(docker, name) {
  const { code, out } = await docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "deckhand.owner"}}|{{index .Config.Labels "deckhand.run"}}|{{index .Config.Labels "deckhand.engine"}}',
    name,
  ]);
  if (code !== 0) return null;
  const [owner = "", run = "", engine = ""] = out.split("|");
  return { owner, run, engine };
}

// A volume's: its owner and the run whose engine it is, or null when there is none.
export async function volumeLabels(docker, name) {
  const { code, out } = await docker([
    "volume",
    "inspect",
    "--format",
    '{{index .Labels "deckhand.owner"}}|{{index .Labels "deckhand.engine"}}',
    name,
  ]);
  if (code !== 0) return null;
  const [owner = "", engine = ""] = out.split("|");
  return { owner, engine };
}

export async function removeVolume(docker, name) {
  if (await volumeExists(docker, name)) await docker(["volume", "rm", name]);
}

// Host paths ({ source, target, readOnly }, grants.mjs resolveMounts()) as bind mounts.
export function mountArgs(mounts) {
  return mounts.flatMap(({ source, target, readOnly }) => [
    "--mount",
    `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`,
  ]);
}

// Volumes ({ name, path, readOnly }) as -v options.
export function volumeArgs(volumes) {
  return volumes.flatMap((v) => ["-v", `${v.name}:${v.path}${v.readOnly ? ":ro" : ""}`]);
}

// { NAME: value } → ["-e", "NAME=value"]: values on the command line, so never secrets.
export function envArgs(env) {
  return Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

// No capabilities but `caps`, no privilege gain through setuid binaries, and the repo's limits.
export function hardeningArgs(limits, caps = []) {
  return [...hardening(...caps), ...limitArgs(limits)];
}

// { uid, gid } → "1000:1000"; without a gid, the uid alone ("0").
export function userArg({ uid, gid }) {
  return gid === undefined ? String(uid) : `${uid}:${gid}`;
}
