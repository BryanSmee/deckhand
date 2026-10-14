// The runner: how the listener starts, follows, talks to and removes sandboxes. Everything
// it does to a sandbox goes through this interface, so another backend (Kubernetes Jobs with
// a volume per session, say) can replace Docker later:
//
//   start(spec)          starts a sandbox, detached: it outlives the listener
//   list()               this deployment's sandboxes, running or exited: [{ name, run, running }];
//                        throws when Docker can't tell (rather than "none")
//   state(name)          "running", "exited"… or null when there is no such sandbox
//   follow(name, opts)   its output, line by line, until it exits; `skip` what was already read
//   send(run, text)      a message for Claude (a comment that arrived mid-run)
//   close(run)           no more messages: Claude exits once it has answered
//   closed(run)          whether close() was called, for a listener that restarts
//   wait(name)           until it exits
//   remove(name, run)    the sandbox and its inbox
//   hasSession(name)     whether its issue has a Claude session already (a previous run)
//   address(name)        its addresses on the sandboxes' network
//   checkNetwork()       throws unless that network is internal
//
// Messages go through a file rather than the container's stdin: a pipe dies with the
// listener, a file in a volume doesn't. Each run has a folder in the runs volume, mounted
// read-only into its sandbox, where the listener appends stream-json messages and finally a
// close line; ../sandbox/deckhand-inbox follows it into Claude's input.
import { spawn as nodeSpawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The inbox's last line once the listener is done with it.
export const CLOSE = JSON.stringify({ type: "deckhand", event: "close" });

// Where the inbox is, inside the sandbox.
const INBOX_DIR = "/deckhand";
const INBOX = "inbox.jsonl";

export function createDockerRunner({
  config,
  docker, // ../docker.mjs
  spawn = nodeSpawn, // `docker logs --follow`, a stream rather than one answer
  inboxDir, // the runs volume, as the listener mounts it
  log = () => {},
}) {
  const inbox = (run) => join(inboxDir, run, INBOX);

  // `spec`: { run, name, image, labels, env, args }. `env` values reach the container by
  // name only (`-e NAME`), so they never show in `ps`; `args`: Docker's own options
  // (hardening, limits, volumes).
  async function start({ run, name, image, labels = {}, env: values = {}, args = [] }) {
    // Unset values stay unset in the sandbox, as with `-e NAME` and no NAME.
    const env = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    mkdirSync(join(inboxDir, run), { recursive: true });
    chmodSync(join(inboxDir, run), 0o755); // the sandbox runs as uid 1000 and only reads
    writeFileSync(inbox(run), "");
    const all = {
      "deckhand.owner": config.prefix,
      "deckhand.run": run,
      ...labels,
    };
    const { code, err } = await docker(
      [
        "run",
        "--detach",
        "--init",
        "--name",
        name,
        ...Object.entries(all).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        ...Object.keys(env).flatMap((k) => ["-e", k]),
        "-e",
        `TASK_INBOX=${INBOX_DIR}/${INBOX}`,
        "--mount",
        `type=volume,src=${config.runsVolume},dst=${INBOX_DIR},volume-subpath=${run},readonly`,
        ...args,
        image,
      ],
      { env: { ...process.env, ...env } },
    );
    if (code !== 0) throw new Error(`the sandbox didn't start: ${err || `docker exit ${code}`}`);
  }

  async function list() {
    const { code, out, err } = await docker([
      "ps",
      "--all",
      "--filter",
      `label=deckhand.owner=${config.prefix}`,
      "--filter",
      "label=deckhand.run",
      "--format",
      '{{.Names}}\t{{.Label "deckhand.run"}}\t{{.State}}',
    ]);
    if (code !== 0) throw new Error(`docker ps: ${err || `exit ${code}`}`);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, run, state] = line.split("\t");
        return { name, run, running: state === "running" };
      });
  }

  async function state(name) {
    const { code, out } = await docker(["inspect", "--format", "{{.State.Status}}", name]);
    return code === 0 && out ? out : null;
  }

  // Resolves once the sandbox's output ends (it exited, or `docker logs` stopped: state()
  // tells). `skip`: { out, err } lines of each stream already read by a previous listener.
  // Only whole lines count: one cut short is read again, whole, by the next follow().
  function follow(name, { skip = { out: 0, err: 0 }, onOut, onErr }) {
    return new Promise((resolve) => {
      const child = spawn("docker", ["logs", "--follow", name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const lines = (stream, n, each) => {
        let rest = "";
        let seen = 0;
        const emit = (line) => (seen++ < n ? null : each(line));
        stream.on("data", (chunk) => {
          const parts = (rest + chunk).split("\n");
          rest = parts.pop();
          parts.forEach(emit);
        });
      };
      lines(child.stdout, skip.out, onOut);
      lines(child.stderr, skip.err, onErr);
      child.on("error", (error) => log(`docker logs ${name}: ${error.message}`));
      child.on("close", resolve);
    });
  }

  function send(run, text) {
    appendFileSync(
      inbox(run),
      JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n",
    );
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

  async function wait(name) {
    await docker(["wait", name]);
  }

  async function remove(name, run) {
    await docker(["rm", "--force", name]);
    if (run) rmSync(join(inboxDir, run), { recursive: true, force: true });
  }

  async function hasSession(name) {
    return (await docker(["volume", "inspect", `${name}-claude`])).code === 0;
  }

  async function address(name) {
    const { code, out } = await docker([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      name,
    ]);
    let net = null;
    try {
      net = code === 0 ? JSON.parse(out)?.[config.network] : null;
    } catch {
      // Not a sandbox, or gone.
    }
    return net?.IPAddress ? [net.IPAddress, net.GlobalIPv6Address].filter(Boolean) : null;
  }

  // Sandboxes reach the outside through the egress proxy only: their network must have no
  // route out. Checked until it passes once, so a fixed network needs no restart.
  let internal = false;
  async function checkNetwork() {
    if (internal) return;
    const { code, out } = await docker([
      "network",
      "inspect",
      "--format",
      "{{.Internal}}",
      config.network,
    ]);
    if (code !== 0 || out !== "true") {
      throw new Error(
        `the sandboxes' network ${config.network} is ${code === 0 ? "not internal" : "missing"}: sandboxes would bypass the egress proxy (see docs/security.md)`,
      );
    }
    internal = true;
  }

  return {
    start,
    list,
    state,
    follow,
    send,
    close,
    closed,
    wait,
    remove,
    hasSession,
    address,
    checkNetwork,
  };
}
