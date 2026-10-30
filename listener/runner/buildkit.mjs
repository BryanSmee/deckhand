// buildctl, the client of the BuildKit daemon that builds repo images on Kubernetes
// (kube-images.mjs, KUBERNETES_BUILDKIT): the same build as `docker build` under Docker
// (images.mjs), pushed to the registry rather than kept on a host. Its credentials reach it
// as a docker config of its own, in a folder removed after the build.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Resolves with { code, out, err }, as docker() does (../docker.mjs). `onData`: its output as
// it comes. `env`: its environment. `signal`: kills it (and so ends its build: the daemon
// cancels a build whose client is gone).
export function buildctl(args, { onData, env, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn("buildctl", args, { env, signal, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (onData ? onData(d) : (out += d)));
    child.stderr.on("data", (d) => (onData ? onData(d) : (err += d)));
    child.on("error", (error) => resolve({ code: -1, out: "", err: error.message }));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// `buildctl build`'s arguments: `dir` the checkout (its context), `dockerfile` in it, `ref`
// the image to push, `buildArgs` and `labels` as `docker build` takes them.
export function buildArgs({ addr, dir, dockerfile, ref, buildArgs = {}, labels = {} }) {
  const file = join(dir, dockerfile);
  return [
    ...["--addr", addr],
    "build",
    ...["--progress", "plain"],
    ...["--frontend", "dockerfile.v0"],
    ...["--local", `context=${dir}`],
    ...["--local", `dockerfile=${dirname(file)}`],
    ...["--opt", `filename=${file.slice(dirname(file).length + 1)}`],
    ...Object.entries(buildArgs).flatMap(([k, v]) => ["--opt", `build-arg:${k}=${v}`]),
    ...Object.entries(labels).flatMap(([k, v]) => ["--opt", `label:${k}=${v}`]),
    ...["--output", `type=image,name=${ref},push=true`],
  ];
}

// `call(env)`'s answer, `env` with DOCKER_CONFIG pointing at a folder holding `dockerConfig`
// (a dockerconfigjson's text; null: none), readable by the listener only and removed
// afterwards whatever happened. Nothing else of the listener's environment: its secrets
// aren't buildctl's.
export async function withDockerConfig(dockerConfig, call) {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-buildctl-"));
  try {
    writeFileSync(join(dir, "config.json"), dockerConfig ?? "{}", { mode: 0o600 });
    // Where buildctl is found: the one variable it needs of the listener's.
    const { PATH } = process.env;
    return await call({ PATH, HOME: dir, DOCKER_CONFIG: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
