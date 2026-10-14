// The docker CLI, the listener's only way to the host's Docker. Injected into the modules
// that use it (images.mjs, previews.mjs), so their tests play Docker instead.
import { spawn } from "node:child_process";

// Resolves with { code, out, err } (trimmed). `input`: written to stdin, then closed.
// `onData`: stdout and stderr chunks as they come (build logs), not kept in out/err.
export function docker(args, { input, onData } = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
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
