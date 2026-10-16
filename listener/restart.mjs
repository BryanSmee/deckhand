// Restarts: the queue and the runs a listener leaves to the next one. On SIGTERM the comments
// still waiting for a run go to queue.json; each run's state is in logs/<run>.live.json all
// along. The next listener reads both, finds the sandboxes by their labels, follows their
// output from where the previous one stopped, and posts each reply once.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentFor } from "./agents/index.mjs";
import { permissionsFor } from "./modes.mjs";
import { addRun, openLog, saveSummary } from "./runlog.mjs";
import { readJson, writeJsonAtomic } from "./store.mjs";
import { noLongerAllowed } from "./tasks.mjs";

// A result saved by a listener from before the agent seam is Claude Code's raw stream-json
// `result` event: Deckhand's own from it, with the duration of all its turns.
export function savedResult(result) {
  if (!result || "ok" in result) return result ?? null;
  return agentFor("claude").normalize(JSON.stringify(result))[0];
}

// A comment as saved to disk: the id of its 👀 rather than the promise of it.
export async function plain({ eyes, comment, ...item }) {
  return {
    ...item,
    comment: comment && {
      id: comment.id,
      html_url: comment.html_url,
      review: comment.review,
      node_id: comment.node_id,
      parent_id: comment.parent_id,
      discussion: comment.discussion,
    },
    eyes: (await eyes?.catch(() => null)) ?? null,
  };
}

export function revive(item) {
  return { ...item, eyes: Promise.resolve(item.eyes) };
}

function pick({ repo, id, kind, number, name, base, discussionId, settings }) {
  return { repo, id, kind, number, name, base, discussionId, settings };
}

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createRestart(ctx) {
  const { config, log, tasks } = ctx;
  const queuePath = join(config.dataDir, "queue.json");

  // Reaction updates still on their way to GitHub once a run is over (see cleanUp()).
  const inflight = new Set();

  function track(promise) {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  }

  // Queued comments don't count: they are saved (saveQueue()), running sandboxes go on without
  // the listener (restoreRuns()), and brainstorms between replies are restored from
  // brainstorms.json and their volume. Nothing needs to drain before a restart. `sees(repo)`:
  // which repos' runs, hooks and queues are listed (a signed-in user's, http.mjs); `idle` is
  // the whole listener's either way.
  function status(sees = () => true) {
    const active = ctx.runs.filter((r) => r.status === "running");
    const previews = ctx.previews.status();
    const reasons = (shown) => [
      ...active
        .filter((r) => shown(r.repo ?? r.key.slice(0, r.key.lastIndexOf("#"))))
        .map((r) => `${r.kind} run ${r.key} since ${new Date(r.startedAt).toISOString()}`),
      ...(inflight.size ? [`${inflight.size} reaction update(s) in flight`] : []),
      // A preview hook may be deploying: a restart waits for it too.
      ...previews
        .filter((h) => shown(h.repo))
        .map(
          (h) =>
            `preview hook ${h.repo} (${h.event}) ${h.state} since ${new Date(h.since).toISOString()}`,
        ),
    ];
    return {
      version: ctx.version,
      idle: ctx.running === 0 && !reasons(() => true).length,
      previews: previews.filter((h) => sees(h.repo)),
      reasons: reasons(sees),
      setUp: ctx.app !== null,
      queued: [...tasks.values()]
        .filter((t) => sees(t.repo))
        .reduce((n, t) => n + t.pending.length, 0),
      now: Date.now(),
    };
  }

  // Comments that wait for a run, with the 👀 they got, so the next listener runs them.
  async function saveQueue() {
    const saved = [];
    for (const t of tasks.values()) {
      if (!t.pending.length && !Object.keys(t.next).length) continue;
      const pending = await Promise.all(t.pending.map(plain));
      saved.push({ ...pick(t), pending, next: t.next });
    }
    // The comments' text and authors: the owner's only, like the runs' state.
    if (saved.length) writeJsonAtomic(queuePath, saved, { mode: 0o600 });
    log(`Saved ${saved.length} task(s) with queued comments`);
  }

  function loadQueue() {
    const saved = readJson(queuePath);
    if (!Array.isArray(saved)) return; // Nothing was waiting.
    rmSync(queuePath, { force: true });
    for (const t of saved) {
      const key = `${t.repo}#${t.id}`;
      // ALLOWED_REPOS or ALLOWED_USERS may have changed with the restart. The repo's own
      // users are checked when the run begins (runs.mjs), or below for a run still going.
      t.pending = t.pending.filter((item) => {
        const refused = noLongerAllowed(config, item);
        if (!refused) return true;
        log(`${key}: a comment queued before the restart dropped: ${refused}`);
        // Its 👀 off: nothing will answer it.
        ctx.track(ctx.settle(revive(item), "refused"));
        return false;
      });
      // Its run may have gone on through the restart (restoreRuns()).
      let task = tasks.get(key);
      if (!task) {
        task = { ...t, pending: [], running: false, ready: false, timer: null, live: null };
        tasks.set(key, task);
      }
      task.next = { ...t.next, ...task.next };
      task.pending.push(...t.pending.map(revive));
      if (!t.pending.length) continue;
      log(`${key}: ${t.pending.length} comment(s) queued before the restart`);
      if (!task.running) ctx.startLater(task);
      // Its run began before: these comments weren't checked against the repo's users then.
      else ctx.track(ctx.dropRefused(task).then(() => ctx.deliverLater(task)));
    }
  }

  // What a listener needs to carry on with a run started by a previous one: written when it
  // starts and whenever a comment reaches it, Claude answers or the reply is posted; removed
  // once it is over. In order, each after the comments' 👀 are known.
  const livePath = (id) => join(ctx.logDir, `${id}.live.json`);

  function saveLive(task) {
    const live = task.live;
    const write = async () => {
      const { logPath, ...record } = live.record;
      const state = {
        task: pick(task),
        ...Object.fromEntries(
          ["id", "mode", "talk", "light", "secret", "asked", "replyTo", "replied", "hosts", "shots"]
            .concat(["trusted", "cached", "uncached", "branches", "lines", "result", "later"])
            .map((k) => [k, live[k]]),
        ),
        record,
        handled: await Promise.all(live.handled.map(plain)),
        // Delivered comments are among the handled ones.
        unanswered: live.unanswered.map((i) => live.handled.indexOf(i)),
      };
      // The run's secret is in it: the owner's only.
      writeJsonAtomic(livePath(live.id), state, { mode: 0o600 });
    };
    live.saving = (live.saving ?? Promise.resolve())
      .then(write)
      .catch((error) => log(`${live.key}: saving its state: ${error.stack ?? error}`));
    return live.saving;
  }

  // Runs a previous listener left behind, from their saved state: their tokens and egress work
  // again at once, and comments find them. reattach() then follows their sandboxes.
  function restoreRuns() {
    const restored = [];
    for (const file of readdirSync(ctx.logDir).filter((f) => f.endsWith(".live.json"))) {
      const saved = readJson(join(ctx.logDir, file));
      if (saved) restored.push(restoreRun(saved));
    }
    return restored;
  }

  function restoreRun(saved) {
    const key = `${saved.task.repo}#${saved.task.id}`;
    const logPath = join(ctx.logDir, `${saved.id}.log`);
    // State saved before records kept their screenshots' folder has it beside them.
    const shots = saved.record.shots ?? saved.shots ?? null;
    const record = { ...saved.record, shots, logPath, status: "running", finishedAt: null };
    addRun(ctx, record);
    let task = tasks.get(key);
    if (!task) {
      task = { ...saved.task, pending: [], ready: false, timer: null, next: {} };
      tasks.set(key, task);
    }
    const handled = saved.handled.map(revive);
    task.live = {
      ...saved,
      key,
      record,
      result: savedResult(saved.result),
      logFile: openLog(logPath),
      open: !ctx.runner.closed(saved.id),
      // A run started before the proxy decrypted HTTPS doesn't trust its CA: nothing cached.
      cached: saved.uncached ? saved.cached : [],
      ip: null,
      engineIp: null,
      handled,
      unanswered: saved.unanswered.map((i) => handled[i]).filter(Boolean),
      saving: null,
    };
    delete task.live.task;
    task.running = true;
    ctx.running++;
    ctx.broker.register(task.repo, permissionsFor(saved.mode, saved.light), {
      // Fail closed: a saved run that doesn't say it was a work run doesn't push.
      push: saved.light === false,
      secret: saved.secret,
    });
    // State saved before runs had branches: none, rather than any.
    ctx.broker.allow(saved.secret, saved.branches ?? []);
    // Its agent's calls go on to the provider it started on (a fallback's).
    ctx.broker.provide(saved.secret, record.provider ?? null);
    return task;
  }

  // Follows each restored run's sandbox to its end, as if the listener had never stopped. A
  // run whose sandbox never started gives its comments back to the queue. Sandboxes nobody
  // knows about any more are told to finish (their next run waits for them). First, this
  // listener joins the running sandboxes' networks: a new container isn't on them.
  async function reattach(restored) {
    await relink();
    const sandboxes = await listSandboxes();
    for (const task of restored) {
      const live = task.live;
      if (live.replied || sandboxes.some((s) => s.run === live.id)) {
        log(`${live.key}: picked up ${task.name} again`);
        ctx.follow(task);
        continue;
      }
      log(`${live.key}: its sandbox never started: its comments are queued again`);
      await requeue(task);
    }
    for (const s of sandboxes) {
      if (restored.some((t) => t.live?.id === s.run || t.name === s.name)) continue;
      log(`${s.name}: no saved state for it: ${s.running ? "closing its input" : "removing it"}`);
      if (s.running) ctx.runner.close(s.run);
      else await ctx.runner.remove(s.name, s.run);
    }
  }

  // Also every minute (server.mjs): the egress proxy may be recreated on its own. A failure
  // is logged; the next one tries again.
  async function relink() {
    try {
      await ctx.runner.relink();
    } catch (error) {
      log(`Joining the runs' networks: ${error.message}`);
    }
  }

  // Not knowing isn't "none": that would remove sandboxes still at work.
  async function listSandboxes() {
    for (;;) {
      try {
        return await ctx.runner.list();
      } catch (error) {
        log(`Listing the sandboxes (again in 5 s): ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  async function requeue(task) {
    const live = task.live;
    live.record.status = "interrupted";
    live.record.finishedAt = Date.now();
    saveSummary(live.record, log);
    ctx.broker.revoke(live.secret);
    await ctx.runner.remove(task.name, live.id);
    rmSync(livePath(live.id), { force: true });
    task.pending.unshift(...live.handled);
    task.live = null;
    task.running = false;
    ctx.running--;
    ctx.startLater(task);
  }

  return {
    track,
    status,
    saveQueue,
    loadQueue,
    livePath,
    saveLive,
    restoreRuns,
    reattach,
    relink,
  };
}
