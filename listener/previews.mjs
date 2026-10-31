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
import { grantFor, loadGrants, ungranted } from "./grants.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";

export const MAX_WAITING = 3;

// What a runner without preview containers (runner/jobs.mjs preview) says.
const refusal = (config) => `the ${config.runner} runner runs no preview hooks`;

// What a newer event replaces: the same pull request's, or the same workflow run's.
function subject(event, payload) {
  const id = event === "workflow_run" ? payload.workflow_run?.id : payload.pull_request?.number;
  return id == null ? null : `${event}#${id}`;
}

export function createPreviews({
  config,
  containers, // the runner's preview containers (runner/jobs.mjs preview), or none: it runs none
  checkout, // (repo, ref) → folder (checkout.mjs)
  logDir,
  log = () => {},
  now = Date.now,
}) {
  const hooks = new Map(); // container name → { repo, event, action, state, since }
  const queues = new Map(); // repo → { running, waiting: [{ name, entry, job, subject, resolve }] }
  let count = 0;
  mkdirSync(logDir, { recursive: true });

  // A job that won't run: the checkout it came with goes.
  const discard = (job) => job.dir && rmSync(job.dir, { recursive: true, force: true });

  // `hook`: { command, image, timeoutMinutes }; `image`: what it runs in; `dir`: the checkout
  // it runs in, when it comes with one (the runner's), else fetched at `ref`. Resolves to the
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
      discard(old.job);
      old.resolve(null);
    } else if (queue.waiting.length >= MAX_WAITING) {
      log(`${repo}: ${MAX_WAITING} preview hooks waiting already: ${event} dropped`);
      discard(job);
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

  async function start(name, entry, job) {
    const { repo, event, payload, ref, hook, image } = job;
    entry.state = "running";
    entry.since = now();
    const logFile = createWriteStream(join(logDir, `${name}.log`));
    // The runner's own checkout, the one its config was read from (../runner/hooks.mjs).
    let dir = job.dir ?? null;
    let timer = null;
    try {
      if (!containers) throw new Error(refusal(config));
      dir ??= await checkout(repo, ref);
      await containers.create({
        name,
        repo,
        image,
        env: { GITHUB_EVENT_NAME: event, DECKHAND_REPO: repo },
        command: hook.command,
      });
      await containers.copy(name, dir);
      log(`${repo}: preview hook for ${event} ${payload.action ?? ""} (${name})`);
      timer = setTimeout(() => {
        log(`${repo}: preview hook ${name} timed out after ${hook.timeoutMinutes} min`);
        containers.kill(name);
      }, hook.timeoutMinutes * 60000);
      const code = await containers.start(name, {
        input: JSON.stringify(payload),
        output: (d) => logFile.write(d),
      });
      log(`${repo}: preview hook ${name} exited with ${code}`);
      return code;
    } finally {
      clearTimeout(timer);
      logFile.end();
      if (dir) rmSync(dir, { recursive: true, force: true });
      if (containers) await containers.remove(name);
    }
  }

  function status() {
    return [...hooks].map(([name, h]) => ({ name, ...h }));
  }

  // Whether the runner can run hooks at all: previewHook() asks before it builds or queues one
  // (the runner service's client asks the runner, ../runner/client.mjs).
  return { run, status, runs: async () => Boolean(containers) };
}

// A delivery's preview hook (events.mjs previewEvent()), asked of the runner when the repo's
// config has one and the operator's grants allow it (skipped here, said in the log): it runs
// as root on the host. `ctx` (server.mjs): the listener's state and services, `ctx.previews`
// the runner's queue (../runner/client.mjs).
export async function previewHook(ctx, { repo, base, event }, payload) {
  const { config, skip } = ctx;
  const { settings, errors } = await ctx.repoSettings(repo, base);
  if (errors.length) return skip(`${event}: ${CONFIG_FILE} of ${repo} has errors`);
  if (!settings.preview) return skip(`${event}: ${repo} has no preview hook`);
  // Before the image's build and the queue: neither helps a runner that can't run it.
  if (!(await ctx.previews.runs())) {
    return skip(`${event}: preview hook of ${repo} not run: ${refusal(config)}`);
  }
  // Root on the host: only when the operator's grants say so (grants.mjs).
  let grant;
  try {
    grant = grantFor(loadGrants(config), config, repo);
  } catch (error) {
    return skip(`${event}: preview hook of ${repo} not run: ${error.message}`);
  }
  const missing = ungranted(grant, settings);
  if (missing.length) {
    return skip(`${event}: preview hook of ${repo} not run: ${missing.join("; ")}`);
  }
  // The runner reads its command and image itself, from the default branch's config, and
  // checks the grants again (../runner/hooks.mjs): it runs as root on the host.
  await ctx.previews.run({ repo, event, payload });
}
