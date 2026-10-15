// Preview hooks: on `pull_request` and `workflow_run` deliveries, a repo's `preview.command`
// (from its default branch's config) runs in a container, in a checkout of the default
// branch, with the event's JSON on stdin and the host's Docker socket, so it can start or
// remove a preview deployment. One hook at a time per repo, in delivery order.
//
// Anyone can open pull requests, forks included, and each hook downloads the repo and runs a
// container: a repo has at most MAX_WAITING hooks waiting, and a newer event for the same pull
// request (or workflow run) replaces the one still waiting, as it describes its latest state.
//
// A hook is busy while its container runs: the listener's /status reports it, so a restart
// waits for it. A hook that starts something long-lived should run until it is done.
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const MAX_WAITING = 3;

// What a newer event replaces: the same pull request's, or the same workflow run's.
function subject(event, payload) {
  const id = event === "workflow_run" ? payload.workflow_run?.id : payload.pull_request?.number;
  return id == null ? null : `${event}#${id}`;
}

export function createPreviews({
  config,
  docker, // docker.mjs
  checkout, // (repo, ref) → folder (checkout.mjs)
  logDir,
  log = () => {},
  now = Date.now,
}) {
  const hooks = new Map(); // container name → { repo, event, action, state, since }
  const queues = new Map(); // repo → { running, waiting: [{ name, entry, job, subject, resolve }] }
  let count = 0;
  mkdirSync(logDir, { recursive: true });

  // `hook`: { command, image, timeoutMinutes }; `image`: what it runs in. Resolves to the
  // hook's exit code once it ran, or null when it was dropped or replaced.
  function run(job) {
    const { repo, event, payload } = job;
    const slug = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const queue = queues.get(repo) ?? { running: false, waiting: [] };
    queues.set(repo, queue);
    const about = subject(event, payload);
    const replaced = about ? queue.waiting.findIndex((w) => w.subject === about) : -1;
    if (replaced >= 0) {
      const [old] = queue.waiting.splice(replaced, 1);
      log(`${repo}: preview hook for ${about} ${old.entry.action ?? ""} replaced by a newer event`);
      hooks.delete(old.name);
      old.resolve(null);
    } else if (queue.waiting.length >= MAX_WAITING) {
      log(`${repo}: ${MAX_WAITING} preview hooks waiting already: ${event} dropped`);
      return Promise.resolve(null);
    }
    const name = `${config.prefix}-preview-${slug}-${now()}-${++count}`;
    const entry = { repo, event, action: payload.action ?? null, state: "waiting", since: now() };
    hooks.set(name, entry);
    const done = new Promise((resolve) =>
      queue.waiting.push({ name, entry, job, subject: about, resolve }),
    );
    next(repo);
    return done;
  }

  // Starts the repo's next waiting hook, if none runs.
  function next(repo) {
    const queue = queues.get(repo);
    if (!queue || queue.running) return;
    const hook = queue.waiting.shift();
    if (!hook) return queues.delete(repo);
    queue.running = true;
    start(hook.name, hook.entry, hook.job)
      .catch((error) => {
        log(`${repo}: preview hook: ${error.message ?? error}`);
        return null;
      })
      .then((code) => {
        hooks.delete(hook.name);
        queue.running = false;
        hook.resolve(code);
        next(repo);
      });
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
