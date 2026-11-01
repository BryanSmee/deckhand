// A run's inbox: messages go through a file rather than the container's stdin, as a pipe dies
// with the listener and a file in its data volume doesn't. Each run has a folder in the runs
// folder, where the listener appends the agent's messages (its message()) and finally a close
// line. The folder also holds the egress proxy's CA and a run analysis's digest.
//
// The file is the truth, and the broker service has a copy (`mirror`, ../broker-service.mjs,
// #505): the CA and the digest before the sandbox starts, the inbox appended from the same
// offset after each change. The sandbox mounts none of it: ../../sandbox/deckhand-inbox asks the
// broker for what follows its offset and feeds it to the agent, so a restarted listener neither
// loses nor repeats a line, and it fetches the CA and the digest from there once at start.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentFor } from "../agents/index.mjs";
import { redact } from "../../lib/redact.mjs";
import { SANDBOX_URLS } from "../../lib/services.mjs";

// The inbox's last line once the listener is done with it.
export const CLOSE = JSON.stringify({ type: "deckhand", event: "close" });

// Where the sandbox keeps them (../../sandbox/entrypoint.sh), and its screenshots until they
// are uploaded (../../sandbox/deckhand-files): a cache or mount can't take these over.
export const FILES_DIR = "/tmp/deckhand";
export const SCREENSHOT_DIR = "/tmp/screenshots";

const INBOX = "inbox.jsonl";
// The files a sandbox fetches, by the name it asks for.
const FILES = { ca: "egress-ca.crt", digest: "digest.md" };

// A run's folder: one name, directly in the runs folder, never `.`, `..` or a path.
function folderName(run) {
  if (typeof run !== "string" || !/^\w[\w.-]*$/.test(run)) {
    throw new TypeError(`not a run's name: ${JSON.stringify(run)}`);
  }
  return run;
}

// `mirror`: the broker service's copy ({ files(run, { ca, digest }), sync(run, bytesFrom),
// forget(run) }), none in the tests that don't need it.
export function createInbox({ inboxDir, mirror = null }) {
  const folder = (run) => join(inboxDir, folderName(run));
  const inbox = (run) => join(folder(run), INBOX);

  // The run's folder: its inbox file, empty, and the proxy's CA and the digest when start()
  // has them. The sandbox reads none of it directly: the broker service has them before it
  // starts, or the start fails.
  async function write(run, ca, digest) {
    mkdirSync(folder(run), { recursive: true });
    writeFileSync(inbox(run), "");
    if (ca) writeFileSync(join(folder(run), FILES.ca), ca);
    if (digest) writeFileSync(join(folder(run), FILES.digest), digest);
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
  // what it doesn't have of its inbox.
  async function resync(run) {
    if (!mirror) return;
    await mirror.files(run, { ca: file(run, "ca"), digest: file(run, "digest") });
    await mirror.sync(run, (from) => bytesFrom(run, from));
  }

  // Where the sandbox gets them, from the broker service: values, not secrets.
  function env(ca, digest) {
    const brokerUrl = SANDBOX_URLS.broker;
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
    mirrored(run);
  }

  function close(run) {
    if (!closed(run)) appendFileSync(inbox(run), CLOSE + "\n");
    mirrored(run);
  }

  function closed(run) {
    try {
      return readFileSync(inbox(run), "utf8").trimEnd().split("\n").at(-1) === CLOSE;
    } catch {
      return true; // no inbox: nothing can reach that run
    }
  }

  // The proxy's CA or the digest (`name`: ca, digest) as write() wrote it, or null.
  function file(run, name) {
    if (!Object.hasOwn(FILES, name)) return null;
    try {
      return readFileSync(join(folder(run), FILES[name]));
    } catch {
      return null;
    }
  }

  function remove(run) {
    rmSync(folder(run), { recursive: true, force: true });
    mirror?.forget(run);
  }

  return { write, resync, env, send, close, closed, remove };
}
