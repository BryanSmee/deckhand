// A Kubernetes job's stdout, sealed (listener/runner/kube-seal.mjs): WRAPPER run with node as the
// job's pod runs it, its key first on stdin, the command's output only readable with that key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { sealing, unseal, WRAPPER } from "../listener/runner/kube-seal.mjs";
import { scriptEnv } from "./helpers.mjs";

// WRAPPER around `node -e script`, `stdin` on its stdin → { code, out, err }.
function wrapped(t, script, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", WRAPPER, process.execPath, "-e", script], {
      env: scriptEnv(t),
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }),
    );
    child.stdin.end(stdin);
  });
}

// A refresh's stand-in: its stdin back on stdout, a line on stderr, exit 3.
const ECHO = `let s = ""; process.stdin.on("data", (c) => (s += c));
process.stdin.on("end", () => { process.stdout.write("file:" + s); process.stderr.write("agy: log\\n"); process.exit(3); });`;

test("the job's stdout is sealed with the key on its stdin, its stderr and exit code as they are", async (t) => {
  const seal = sealing('{"token":{"refresh_token":"1//secret"}}');
  const result = await wrapped(t, ECHO, seal.input);
  assert.equal(result.code, 3);
  assert.equal(result.err, "agy: log\n");
  // What the node's log would hold: neither the file nor the key.
  assert.ok(!result.out.includes("1//secret"));
  assert.ok(!result.out.includes(seal.key.toString("hex")));
  assert.equal(unseal(result.out, seal.key), 'file:{"token":{"refresh_token":"1//secret"}}');
  // Another key opens nothing.
  assert.equal(unseal(result.out, sealing().key), null);
  assert.equal(unseal('{"token":"plain"}', seal.key), null);
});

test("without a key, nothing runs; a command that can't start says so", async (t) => {
  const none = await wrapped(t, ECHO, "no key here");
  assert.equal(none.code, 1);
  assert.match(none.err, /no key on stdin/);
  assert.equal(none.out, "");
  const missing = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", WRAPPER, "/no/such/command"], {
      env: scriptEnv(t),
    });
    const err = [];
    child.stderr.on("data", (c) => err.push(c));
    child.on("close", (code) => resolve({ code, err: Buffer.concat(err).toString() }));
    child.stdin.end(sealing("x").input);
  });
  assert.equal(missing.code, 127);
  assert.match(missing.err, /ENOENT/);
});
