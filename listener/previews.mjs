// Preview hooks: on `pull_request` and `workflow_run` deliveries, a repo's `preview.command`
// (from its default branch's config) runs in a container, in a checkout of the default
// branch, with the event's JSON on stdin and the host's Docker socket, so it can start or
// remove a preview deployment. One hook at a time per repo, in delivery order.
//
// A hook is busy while its container runs: the listener's /status reports it, so a restart
// waits for it. A hook that starts something long-lived should run until it is done.
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function createPreviews({
  config,
  docker, // docker.mjs
  checkout, // (repo, ref) → folder (checkout.mjs)
  logDir,
  log = () => {},
  now = Date.now,
}) {
  const hooks = new Map(); // container name → { repo, event, action, state, since }
  const chains = new Map(); // repo → the last hook's promise
  let count = 0;
  mkdirSync(logDir, { recursive: true });

  // `hook`: { command, image, timeoutMinutes }; `image`: what it runs in.
  function run({ repo, event, payload, ref, hook, image }) {
    const slug = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const name = `${config.prefix}-preview-${slug}-${now()}-${++count}`;
    const entry = { repo, event, action: payload.action ?? null, state: "waiting", since: now() };
    hooks.set(name, entry);
    const previous = chains.get(repo) ?? Promise.resolve();
    const done = previous
      .then(() => start(name, entry, { repo, event, payload, ref, hook, image }))
      .catch((error) => log(`${repo}: preview hook: ${error.message ?? error}`))
      .finally(() => {
        hooks.delete(name);
        if (chains.get(repo) === done) chains.delete(repo);
      });
    chains.set(repo, done);
    return done;
  }

  async function start(name, entry, { repo, event, payload, ref, hook, image }) {
    entry.state = "running";
    entry.since = now();
    const logFile = createWriteStream(join(logDir, `${name}.log`));
    let dir = null;
    let timer = null;
    try {
      dir = await checkout(repo, ref);
      const created = await docker([
        "create",
        "-i",
        "--name",
        name,
        "--label",
        `deckhand.preview=${repo.toLowerCase()}`,
        // Root: the socket belongs to root, and whoever holds it is root on the host anyway.
        "--user",
        "0",
        "-v",
        `${config.dockerSocket}:/var/run/docker.sock`,
        "-e",
        `GITHUB_EVENT_NAME=${event}`,
        "-e",
        `DECKHAND_REPO=${repo}`,
        "--entrypoint",
        "sh",
        image,
        "-c",
        'cd /deckhand-checkout && exec sh -c "$1"',
        "preview",
        hook.command,
      ]);
      if (created.code !== 0) throw new Error(`creating its container: ${created.err}`);
      const copied = await docker(["cp", dir, `${name}:/deckhand-checkout`]);
      if (copied.code !== 0) throw new Error(`copying the checkout: ${copied.err}`);
      log(`${repo}: preview hook for ${event} ${payload.action ?? ""} (${name})`);
      timer = setTimeout(() => {
        log(`${repo}: preview hook ${name} timed out after ${hook.timeoutMinutes} min`);
        docker(["kill", name]);
      }, hook.timeoutMinutes * 60000);
      const { code } = await docker(["start", "-ai", name], {
        input: JSON.stringify(payload),
        onData: (d) => logFile.write(d),
      });
      log(`${repo}: preview hook ${name} exited with ${code}`);
      return code;
    } finally {
      clearTimeout(timer);
      logFile.end();
      if (dir) rmSync(dir, { recursive: true, force: true });
      await docker(["rm", "-f", name]);
    }
  }

  function status() {
    return [...hooks].map(([name, h]) => ({ name, ...h }));
  }

  return { run, status };
}
