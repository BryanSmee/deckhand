// A Kubernetes job's stdout, sealed (kube-images.mjs runJob()): a container's stdout goes to its
// log on the node (/var/log/pods), which a cluster's log agents (Fluent Bit, Promtail, a cloud's
// own) ship elsewhere within seconds, before the pod is removed. What a job prints there (the
// refreshed Antigravity login) mustn't be readable in it. So the runner sends a one-time key
// first on its stdin (never logged), the job's own input after it; WRAPPER runs the job's
// command with the rest of its stdin, and prints its stdout encrypted with that key
// (AES-256-GCM), its stderr as it comes (no secret there: the refresh's own rule, #242).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// `node -e WRAPPER <command> <args…>`: the base image's node, CommonJS, nothing but node:*. The
// key line, then the command's stdin; on its end, iv ‖ tag ‖ ciphertext in base64 on stdout,
// and its exit code.
export const WRAPPER = `
const { spawn } = require("node:child_process");
const { createCipheriv, randomBytes } = require("node:crypto");
const [command, ...args] = process.argv.slice(1);
let head = Buffer.alloc(0);
let child = null;
const out = [];
function start(rest, key) {
  if (key.length !== 32) {
    process.stderr.write("deckhand: no key on stdin\\n");
    process.exit(1);
  }
  child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.on("error", (error) => {
    process.stderr.write("deckhand: " + error.message + "\\n");
    process.exit(127);
  });
  child.on("close", (code, signal) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const sealed = Buffer.concat([cipher.update(Buffer.concat(out)), cipher.final()]);
    const text = Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
    process.stdout.write(text, () => process.exit(code ?? (signal ? 128 : 1)));
  });
  child.stdin.write(rest);
}
process.stdin.on("data", (chunk) => {
  if (child) return void child.stdin.write(chunk);
  head = Buffer.concat([head, chunk]);
  const nl = head.indexOf(10);
  if (nl >= 0) start(head.subarray(nl + 1), Buffer.from(head.subarray(0, nl).toString(), "hex"));
});
process.stdin.on("end", () => {
  if (!child) start(Buffer.alloc(0), Buffer.from(head.toString().trim(), "hex"));
  child.stdin.end();
});
`;

// A key for one job, and its stdin: the key's line, then `input`.
export function sealing(input = "") {
  const key = randomBytes(32);
  return { key, input: `${key.toString("hex")}\n${input}` };
}

// The job's stdout as WRAPPER sealed it with `key`, or null when it isn't (cut short, or no
// output of the wrapper's at all: the command didn't run).
export function unseal(text, key) {
  const raw = Buffer.from(String(text).trim(), "base64");
  if (raw.length < 28) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString();
  } catch {
    return null;
  }
}
