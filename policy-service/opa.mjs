// The pinned `opa` binary (Dockerfile), as the policy service runs it (#501): short processes for
// what is asked once (its capabilities, a policy set's compile check), and long-lived servers that
// answer the decisions, each with one policy set loaded at its start (engine.mjs). Every process
// gets an empty environment: `opa.runtime` is refused anyway, but nothing of the service's leaks
// even to opa's own logs. A server listens on a Unix socket in its own temp folder, never on a
// port: nothing else in the container, and nothing outside it, can reach it.
import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

// `name` on the service's PATH, as a full path: the process runs without a PATH of its own.
function onPath(name) {
  if (name.includes("/")) return name;
  const { PATH = "" } = process.env;
  for (const dir of PATH.split(":").filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Not there.
    }
  }
  return name;
}

// How long a short process may take: `opa check` of a few files, or `capabilities`.
export const RUN_TIMEOUT_MS = 10_000;

// Runs `bin` once: `args`, `input` on stdin, an empty environment, killed after `timeoutMs`.
// → { code, stdout, stderr, timedOut }.
export function opaRunner(bin = "opa") {
  let path = null;
  return (args, { input = "", timeoutMs = RUN_TIMEOUT_MS, cwd } = {}) =>
    new Promise((resolve) => {
      path ??= onPath(bin);
      const child = execFile(
        path,
        args,
        { env: {}, cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 << 20 },
        (error, stdout, stderr) => {
          // Killed at the timeout; not for too much output (maxBuffer), said as a failure.
          const timedOut = !!error?.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          // Not started at all (ENOENT): said as a failure of its own.
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          resolve({ code, stdout, stderr: stderr || (code === -1 ? error.message : ""), timedOut });
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
}

// How long a server may take to load its policies and answer /health.
export const START_TIMEOUT_MS = 10_000;

// An HTTP request to the server on `socket` → { status, body } (body: its text). `timeoutMs`:
// past it, the request is cut, which cancels opa's evaluation (its context ends with the
// connection), and the promise resolves { timedOut: true }.
function call(socket, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method,
        path,
        headers: { "content-type": "application/json", connection: "close" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ timedOut: true });
    }, timeoutMs);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(body);
  });
}

// Starts `bin` as a server with the policies in `dir`/`policies` (a folder of .rego files: opa
// loads every .rego, .json and .yaml under it, and engine.mjs writes .rego files only), listening
// on `dir`/opa.sock → once it answers, { query(query, input, { timeoutMs }), stop(), exited }:
// `query` → { status, body } or { timedOut: true }, `exited` resolves when the process ends. A
// server that exits or doesn't answer within START_TIMEOUT_MS rejects, with what it said.
export function opaServer(bin = "opa", { startMs = START_TIMEOUT_MS } = {}) {
  let path = null;
  return (dir, policies) =>
    new Promise((resolve, reject) => {
      path ??= onPath(bin);
      const socket = join(dir, "opa.sock");
      const child = spawn(
        path,
        [
          "run",
          "--server",
          `--addr=unix://${socket}`,
          "--unix-socket-perm=600",
          // No call to GitHub's releases: the service has no network anyway.
          "--skip-version-check",
          "--log-level=error",
          "--shutdown-grace-period=1",
          policies,
        ],
        { env: {}, cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
      );
      // What it says: a load error at its start (on stdout), its logs after (on stderr).
      let said = "";
      const hear = (d) => {
        if (said.length < 64 * 1024) said += d;
      };
      child.stdout.on("data", hear);
      child.stderr.on("data", hear);
      let ended = false;
      const exited = new Promise((done) =>
        child.on("close", (code) => {
          ended = true;
          done(code);
        }),
      );
      child.on("error", (error) => {
        ended = true;
        reject(error);
      });
      const stop = () => {
        if (!ended) child.kill("SIGKILL");
        return exited;
      };
      const until = Date.now() + startMs;
      const ready = async () => {
        while (!ended) {
          try {
            const res = await call(socket, "GET", "/health", undefined, 1000);
            if (res.status === 200) {
              return resolve({
                query: (query, input, { timeoutMs }) =>
                  call(socket, "POST", "/v1/query", JSON.stringify({ query, input }), timeoutMs),
                stop,
                exited,
              });
            }
          } catch {
            // Not listening yet.
          }
          if (Date.now() > until) {
            await stop();
            return reject(new Error(`opa didn't start within ${startMs / 1000} s`));
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        // Its first two lines: what failed, and where ("load error: …", "policy/a.rego:4: …").
        const first = said.trim().split("\n").slice(0, 2).join(" ");
        reject(new Error(first || "opa exited at its start"));
      };
      ready();
    });
}

// The binary's two uses, as engine.mjs takes them: `run` (opaRunner()) and `serve` (opaServer()).
export const opaBinary = (bin = "opa") => ({ run: opaRunner(bin), serve: opaServer(bin) });
