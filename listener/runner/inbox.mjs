// A run's inbox: messages go through a file rather than the container's stdin, as a pipe dies
// with the listener and a file in its data volume doesn't. Each run has a folder in the runs
// folder, where the listener appends the agent's messages (its message()) and finally a close
// line. The sandbox doesn't mount it: ../../sandbox/deckhand-inbox asks the broker for what
// follows its offset (poll(), ../run-files.mjs) and feeds it to the agent, so a restarted
// listener neither loses nor repeats a line. The folder also holds the egress proxy's CA and
// a run analysis's digest, which the sandbox fetches once at start (file()).
//
// The file is the truth, and the broker service has a copy (`mirror`, ../broker-service.mjs,
// #505): the CA and the digest before the sandbox starts, the inbox appended from the same
// offset after each change, so the sandbox reads it from either copy of the broker. Only the
// runs from before tokens are still answered from here (poll(), file()).
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agentFor } from "../agents/index.mjs";
import { redact } from "../../lib/redact.mjs";

// The inbox's last line once the listener is done with it.
export const CLOSE = JSON.stringify({ type: "deckhand", event: "close" });

// Where the sandbox keeps them (../../sandbox/entrypoint.sh), and its screenshots until they
// are uploaded (../../sandbox/deckhand-files): a cache or mount can't take these over.
export const FILES_DIR = "/tmp/deckhand";
export const SCREENSHOT_DIR = "/tmp/screenshots";

const INBOX = "inbox.jsonl";
// The files a sandbox may fetch, by the name it asks for.
const FILES = { ca: "egress-ca.crt", digest: "digest.md" };

// The most one poll() answers: whole lines only, so a longer one comes alone.
export const MAX_READ = 1024 * 1024;

// `timers`: { setTimeout, clearTimeout }, a clock of the tests' own. `mirror`: the broker
// service's copy ({ files(run, { ca, digest }), sync(run, bytesFrom), forget(run) }), none in
// the tests that don't need it.
export function createInbox({ inboxDir, timers = globalThis, mirror = null }) {
  const inbox = (run) => join(inboxDir, run, INBOX);
  // run → the poll()s waiting for its next line, woken by send() and close().
  const waiting = new Map();

  // The run's folder: its inbox file, empty, and the proxy's CA and the digest when start()
  // has them. The sandbox reads none of it directly: the broker service has them before it
  // starts, or the start fails.
  async function write(run, ca, digest) {
    mkdirSync(join(inboxDir, run), { recursive: true });
    writeFileSync(inbox(run), "");
    if (ca) writeFileSync(join(inboxDir, run, FILES.ca), ca);
    if (digest) writeFileSync(join(inboxDir, run, FILES.digest), digest);
    if (!mirror) return;
    await mirror.files(run, { ca: ca || null, digest: digest || null });
    await mirror.sync(run, (from) => bytesFrom(run, from));
  }

  // The inbox file's bytes from `from`, or null once it is gone (the run ended).
  function bytesFrom(run, from) {
    try {
      return readFileSync(inbox(run)).subarray(from);
    } catch {
      return null;
    }
  }

  // The broker service's copy, after each change: tried again until it has it.
  function mirrored(run) {
    mirror?.sync(run, (from) => bytesFrom(run, from)).catch(() => {});
  }

  // A run a restarted listener picked up: the broker service gets its CA and digest again, and
  // what it doesn't have of its inbox (all of it, for a run from before the broker service).
  async function resync(run) {
    if (!mirror) return;
    // A run's from before the broker service may hold a token's shape: redacted in place first,
    // as send() writes them now (an offset its sandbox read past one is off by the difference).
    try {
      const text = readFileSync(inbox(run), "latin1");
      const clean = redact(text, []);
      if (clean !== text) writeFileSync(inbox(run), clean, "latin1");
    } catch {
      // No inbox: nothing to copy.
    }
    await mirror.files(run, { ca: file(run, "ca"), digest: file(run, "digest") });
    await mirror.sync(run, (from) => bytesFrom(run, from));
  }

  // Where the sandbox gets them (../run-files.mjs): values, not secrets. `brokerUrl` is read at
  // each start, as the tests' broker picks its port.
  function env(brokerUrl, ca, digest) {
    return {
      TASK_INBOX: `${brokerUrl}/run/inbox`,
      ...(ca ? { DECKHAND_CA: `${brokerUrl}/run/ca` } : {}),
      ...(digest ? { TASK_DIGEST: `${brokerUrl}/run/digest` } : {}),
    };
  }

  function send(run, text, agent = agentFor()) {
    // Without a token's shape (a GitHub token, a run token pasted in a comment): the broker
    // service's copy is this file byte for byte, and its store takes no token.
    appendFileSync(inbox(run), redact(agent.message(text), []) + "\n");
    wake(run);
    mirrored(run);
  }

  function close(run) {
    if (!closed(run)) appendFileSync(inbox(run), CLOSE + "\n");
    wake(run);
    mirrored(run);
  }

  function closed(run) {
    try {
      return readFileSync(inbox(run), "utf8").trimEnd().split("\n").at(-1) === CLOSE;
    } catch {
      return true; // no inbox: nothing can reach that run
    }
  }

  function wake(run) {
    const all = waiting.get(run);
    waiting.delete(run);
    for (const done of all ?? []) done();
  }

  // The whole lines after byte `from`, up to MAX_READ (or the first line, if longer): an
  // empty buffer when there are none yet, null when the run has no inbox.
  function read(run, from) {
    let fd;
    try {
      fd = openSync(inbox(run), "r");
    } catch {
      return null;
    }
    try {
      const { size } = fstatSync(fd);
      if (size <= from) return Buffer.alloc(0);
      // MAX_READ bytes first, and more only while no newline turned up (a line that long).
      let data = Buffer.alloc(0);
      while (from + data.length < size) {
        const chunk = Buffer.alloc(Math.min(MAX_READ, size - from - data.length));
        const n = readSync(fd, chunk, 0, chunk.length, from + data.length);
        if (!n) break;
        data = Buffer.concat([data, chunk.subarray(0, n)]);
        if (data.includes(10)) break;
      }
      const within = data.lastIndexOf(10, MAX_READ - 1);
      const end = within !== -1 ? within : data.indexOf(10);
      return data.subarray(0, end + 1);
    } finally {
      closeSync(fd);
    }
  }

  // read(), waiting up to `timeout` ms for a line when there is none yet: the sandbox's long
  // poll. `signal`: the request went away.
  async function poll(run, from, { timeout = 25_000, signal } = {}) {
    const now = read(run, from);
    if (now === null || now.length || signal?.aborted) return now;
    await new Promise((resolve) => {
      const done = () => {
        timers.clearTimeout(timer);
        waiting.get(run)?.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = timers.setTimeout(done, timeout);
      if (!waiting.has(run)) waiting.set(run, new Set());
      waiting.get(run).add(done);
      signal?.addEventListener("abort", done);
    });
    return read(run, from);
  }

  // The proxy's CA or the digest (`name`: ca, digest) as start() wrote it, or null.
  function file(run, name) {
    if (!Object.hasOwn(FILES, name)) return null;
    try {
      return readFileSync(join(inboxDir, run, FILES[name]));
    } catch {
      return null;
    }
  }

  function remove(run) {
    rmSync(join(inboxDir, run), { recursive: true, force: true });
    wake(run);
    mirror?.forget(run);
  }

  return { write, resync, env, send, close, closed, poll, file, remove };
}
