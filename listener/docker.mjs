// The docker CLI, the listener's only way to the host's Docker. Injected into the modules
// that use it (images.mjs, previews.mjs), so their tests play Docker instead.
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
// Deckhand starts but the engine sidecar (runner/engine.mjs) and preview hooks (previews.mjs).
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
export async function removeVolume(docker, name) {
  if (await volumeExists(docker, name)) await docker(["volume", "rm", name]);
}
