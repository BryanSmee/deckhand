// A run's inbox: messages go through a file rather than the container's stdin, as a pipe dies
// with the listener and a file in a volume doesn't. Each run has a folder in the runs volume,
// mounted read-only into its sandbox, where the listener appends the agent's messages (its
// message()) and finally a close line; ../../sandbox/deckhand-inbox follows it into the
// agent's input. The folder also holds the egress proxy's CA and a run analysis's digest.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentFor } from "../agents/index.mjs";

// The inbox's last line once the listener is done with it.
export const CLOSE = JSON.stringify({ type: "deckhand", event: "close" });

// Where the inbox is, inside the sandbox.
export const INBOX_DIR = "/deckhand";
const CA_FILE = "egress-ca.crt";
const DIGEST_FILE = "digest.md";
const INBOX = "inbox.jsonl";

export function createInbox({ config, inboxDir }) {
  const inbox = (run) => join(inboxDir, run, INBOX);

  // The run's folder, which the sandbox mounts read-only: its inbox file, empty, and the
  // proxy's CA and the digest when start() has them.
  function write(run, ca, digest) {
    mkdirSync(join(inboxDir, run), { recursive: true });
    chmodSync(join(inboxDir, run), 0o755); // the sandbox runs as uid 1000 and only reads
    writeFileSync(inbox(run), "");
    if (ca) writeFileSync(join(inboxDir, run, CA_FILE), ca, { mode: 0o644 });
    if (digest) writeFileSync(join(inboxDir, run, DIGEST_FILE), digest, { mode: 0o644 });
  }

  // The sandbox's `docker run` arguments for it: where each file is, and the folder mounted.
  function args(run, ca, digest) {
    return [
      "-e",
      `TASK_INBOX=${INBOX_DIR}/${INBOX}`,
      ...(ca ? ["-e", `DECKHAND_CA=${INBOX_DIR}/${CA_FILE}`] : []),
      ...(digest ? ["-e", `TASK_DIGEST=${INBOX_DIR}/${DIGEST_FILE}`] : []),
      "--mount",
      `type=volume,src=${config.runsVolume},dst=${INBOX_DIR},volume-subpath=${run},readonly`,
    ];
  }

  function send(run, text, agent = agentFor()) {
    appendFileSync(inbox(run), agent.message(text) + "\n");
  }

  function close(run) {
    if (!closed(run)) appendFileSync(inbox(run), CLOSE + "\n");
  }

  function closed(run) {
    try {
      return readFileSync(inbox(run), "utf8").trimEnd().split("\n").at(-1) === CLOSE;
    } catch {
      return true; // no inbox: nothing can reach that run
    }
  }

  function remove(run) {
    rmSync(join(inboxDir, run), { recursive: true, force: true });
  }

  return { write, args, send, close, closed, remove };
}
