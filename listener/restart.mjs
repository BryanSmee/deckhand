// Restarts: the queue and the runs a listener leaves to the next one, saved as they change, so
// that one killed without SIGTERM (a crash, an OOM kill) leaves the same as one that stopped.
// The comments waiting for a run are in the store (`queue`, with each task's deadline: the end
// of its pause); each run's state is in logs/<run>.live.json. The next listener reads both,
// re-arms the deadlines, finds the sandboxes by their labels (through the runner service,
// which outlives it), follows their output from where
// the previous one stopped, and posts each reply once.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentFor } from "./agents/index.mjs";
import { parseKey, taskKey } from "./events.mjs";
import { permissionsFor } from "./modes.mjs";
import { addRun, writeEvent } from "./runlog.mjs";
import { ambiguous, githubNames, respelled, spellings } from "./spelling.mjs";
import { readJson, writeJsonAtomic } from "../lib/files.mjs";
import { storable } from "../lib/store.mjs";
import { newTask, noLongerAllowed } from "./tasks.mjs";

// A result saved by a listener from before the agent seam is Claude Code's raw stream-json
// `result` event: Deckhand's own from it, with the duration of all its turns.
function savedResult(result) {
  if (!result || "ok" in result) return result ?? null;
  return agentFor("claude").normalize(JSON.stringify(result))[0];
}

// A comment as saved to disk: the id of its 👀 rather than the promise of it.
export async function plain(item) {
  return plainWith(item, (await item.eyes?.catch(() => null)) ?? null);
}

function plainWith({ eyes: _, comment, ...item }, eyes) {
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
    eyes,
  };
}

// How long the lines a run's output adds wait to be saved with its state (saveLiveSoon()).
const LIVE_SAVE_MS = 1000;

// The store's key of the queue: every task's comments waiting for a run, as one value. The
// store lists no keys, and the next listener needs them all.
export const QUEUE_KEY = "queue";

// What tells a queued comment apart, given when it is accepted (tasks.mjs accept()): a comment
// both in the queue and in a run's saved state (a listener killed between the two writes) is the
// run's alone.
export function queueId() {
  return randomUUID();
}

// Each comment's 👀 id once GitHub answered, for the queue's writes (eyesOf()).
const eyesKnown = new WeakMap();

export function revive(item) {
  // Saved by a listener from before queueIds: one now, so that the next restart tells it apart.
  const revived = { ...item, queueId: item.queueId ?? queueId(), eyes: Promise.resolve(item.eyes) };
  // Known already: the queue's next write keeps it (eyesOf()).
  eyesKnown.set(revived, item.eyes ?? null);
  return revived;
}

function pick({ repo, id, kind, number, name, base, discussionId, settings }) {
  return { repo, id, kind, number, name, base, discussionId, settings };
}

// How long a start waits for the runner to say whether the restored runs' inboxes are open.
export const RESTORE_WAIT_MS = 10_000;

// How long a run's state, or its end, waits for its log to be at the runner.
export const LOG_SENT_MS = 5000;

// Once what the run's log was written is at the runner, or LOG_SENT_MS on.
export function logSent(live, ms = LOG_SENT_MS) {
  // No log (a run that never started one): nothing to wait for.
  if (!live.logFile?.flushed) return Promise.resolve();
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
  return Promise.race([live.logFile.flushed(), late]).finally(() => clearTimeout(timer));
}

// `ctx` (server.mjs): the listener's state and services, read at call time. `ctx.store`
// (lib/store.mjs) keeps the queue.
export function createRestart(ctx) {
  const { config, log, tasks } = ctx;
  // Where a listener from before the store saved its queue, on SIGTERM only: read once, then
  // in the store.
  const queuePath = join(config.dataDir, "queue.json");
  // spelled(repo) (spelling.mjs): set by unifySpellings(), or by restoreRuns() without GitHub's names.
  let spelled = null;

  const readLive = () =>
    readdirSync(ctx.logDir)
      .filter((f) => f.endsWith(".live.json"))
      .map((file) => readJson(join(ctx.logDir, file)))
      .filter(Boolean);

  // The queue a previous listener left: the store's, and queue.json's from before it. Read once,
  // by unifySpellings() or loadQueue(), whichever comes first.
  let leftQueue = null;
  // And the files keepQueued() left, a run's end the queue couldn't be written for.
  const keptFiles = () =>
    readdirSync(ctx.logDir)
      .filter((f) => f.endsWith(".queued.json"))
      .map((f) => join(ctx.logDir, f));
  function readQueue() {
    leftQueue ??= ctx.store.get(QUEUE_KEY).then((stored) => {
      const files = [queuePath, ...keptFiles()];
      const legacy = files.flatMap((path) => {
        const saved = readJson(path);
        return Array.isArray(saved) ? saved : [];
      });
      return [...Object.values(stored ?? {}), ...legacy];
    });
    return leftQueue;
  }

  // A run's end whose queue write failed (runs.mjs teardown()): its task's queue in
  // logs/<run>.queued.json, read with the queue at the next start, and removed after the next
  // write of the queue that succeeds. False when it can't be written either.
  function keepQueued(task, live) {
    if (!task.pending.length) return true;
    const path = join(ctx.logDir, `${live.id}.queued.json`);
    const pending = task.pending.map((item) => plainWith(item, eyesOf(item)));
    try {
      const saved = storable([{ ...pick(task), pending, next: task.next }], ctx.storeSecrets?.());
      // The comments' text and authors: the owner's only.
      writeJsonAtomic(path, saved, { mode: 0o600 });
    } catch (error) {
      log(`${live.key}: keeping its queue: ${error.stack ?? error}`);
      return false;
    }
    log(`${live.key}: its task's queue kept in ${path} until the queue is saved`);
    removeOnceSaved(path);
    return true;
  }

  // Every repo the runs, the runs going, the queue and `keys` (other state's task keys) have,
  // for spellings().
  const records = async (keys = []) => recordsWith(await readQueue(), keys);
  function recordsWith(queued, keys = []) {
    return [
      ...ctx.runs,
      ...readLive().map((saved) => ({
        repo: saved.task?.repo,
        startedAt: saved.record?.startedAt,
        live: true,
      })),
      ...queued.map((t) => ({ repo: t.repo })),
      ...keys.map((key) => ({ repo: parseKey(key)?.repo })),
    ];
  }

  // One spelling per repo, before restoreRuns() and loadQueue(): GitHub's for a repo the state
  // has under two, asked with `nameOf(repo)` (repo-check.mjs), for at most `waitMs`. Else
  // spellings()'. The runs' list (runlog.mjs loadRuns()) takes it now: the dashboard shows the
  // repo once, and its tasks are one. In memory only: the next start does it again. Returns
  // spelled(), for the other state keyed by task (server.mjs).
  async function unifySpellings({ nameOf = null, keys = [], waitMs } = {}) {
    const all = await records(keys);
    const known = nameOf ? await githubNames(ambiguous(all), nameOf, waitMs) : new Map();
    for (const full of known.values()) log(`${full}: other spellings of it are now this one`);
    return respellRuns(spellings(all, known));
  }

  function respellRuns(spell) {
    spelled = spell;
    for (const run of ctx.runs) {
      run.repo = spelled(run.repo);
      run.key = respelled(run.key, spelled);
    }
    return spelled;
  }

  // The comments that wait for a run, with the 👀 they got and each task's deadline, written to
  // the store whenever they change (tasks.mjs, runs.mjs): a listener killed at any moment
  // leaves them to the next one. Whole each time, the latest state when the write begins: a
  // call while one waits to begin joins it, one while it is under way comes after it.
  // Resolves once its state is written, to whether it was: a failed write is logged, the next
  // one tries again.
  let saving = Promise.resolve();
  let waiting = null;
  function saveQueue() {
    waiting ??= saving.then(() => {
      waiting = null;
      let value;
      try {
        value = storable(queueState(), ctx.storeSecrets?.() ?? []);
      } catch (error) {
        log(`Saving the queue: ${error.stack ?? error}`);
        return false;
      }
      // Those this write's state makes useless, as it is now: one added meanwhile waits for
      // the next write, which has what made it so.
      const removing = [...removeOnSave];
      return ctx.store.set(QUEUE_KEY, value).then(
        () => {
          for (const path of removing) {
            rmSync(path, { force: true });
            removeOnSave.delete(path);
          }
          return true;
        },
        (error) => (log(`Saving the queue: ${error.stack ?? error}`), false),
      );
    });
    saving = waiting;
    return waiting;
  }

  // Files whose comments are only safe once the queue is written with them (a queue.json from
  // before the store, a run's state kept when the queue couldn't be written at its end,
  // runs.mjs teardown()): removed after the next write that succeeds, whichever it is.
  const removeOnSave = new Set();
  function removeOnceSaved(path) {
    removeOnSave.add(path);
  }

  // A comment's 👀 is a promise until GitHub answers: saved without it meanwhile (not waited
  // for: the comment would be lost with a listener killed before), and saved again once known.
  // The 👀 still on their way, each until the queue is saved with it (eyesSaved()).
  const eyesComing = new Set();
  function eyesOf(item) {
    if (eyesKnown.has(item)) return eyesKnown.get(item);
    eyesKnown.set(item, null);
    if (!item.eyes) return null;
    const coming = item.eyes
      .catch(() => null)
      .then((eyes) => {
        if (!eyes) return;
        eyesKnown.set(item, eyes);
        return saveQueue();
      })
      .finally(() => eyesComing.delete(coming));
    eyesComing.add(coming);
    return null;
  }

  // Once the 👀 on their way are in the queue's saved state, or after `ms`: a listener that stops
  // leaves the next one their ids, which it takes off with the comments' outcome.
  function eyesSaved(ms) {
    let timer;
    const timeout = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
    return Promise.race([Promise.allSettled([...eyesComing]), timeout]).finally(() =>
      clearTimeout(timer),
    );
  }

  // Comments a run or a running session is taking (take()): out of `pending`, not yet in the
  // run's saved state. live → [items], still written with the queue meanwhile, until a write
  // of the run's state that has them succeeds (saveLive() moved()), or the run is over (they
  // are back in `pending` then, or answered).
  const moving = new Map();

  // Comments `items` of `task`, out of its `pending` now, taken by its run: written in the run's
  // state first, then out of the queue. Until the run's state is written, every write of the
  // queue (another task's, a 👀 known) still has them: a listener killed meanwhile finds them
  // in the queue, or in both (loadQueue() leaves them to the run), never in neither.
  function take(task, items) {
    const { live } = task;
    moving.set(live, [...(moving.get(live) ?? []), ...items]);
    return saveLive(task).then(() => saveQueue());
  }

  // The run's state was written with `handled`: those of its comments are in it.
  function moved(live, handled) {
    const left = (moving.get(live) ?? []).filter((item) => !handled.includes(item));
    if (left.length) moving.set(live, left);
    else moving.delete(live);
  }

  function takenBy(live) {
    if (!live) return [];
    if (live.over) moving.delete(live);
    return moving.get(live) ?? [];
  }

  function queueState() {
    const saved = {};
    for (const [key, t] of tasks) {
      // Once each: one a run put back in `pending` may still be moving.
      const all = [...new Set([...takenBy(t.live), ...t.pending])];
      if (!all.length && !Object.keys(t.next).length) continue;
      const pending = all.map((item) => plainWith(item, eyesOf(item)));
      // The comments' text and authors: the store is the listener's own (its files the
      // owner's only, lib/store-file.mjs).
      saved[key] = { ...pick(t), pending, next: t.next, dueAt: t.dueAt ?? null };
    }
    return saved;
  }

  // Back from the store, after restoreRuns(): each task's comments queued again, its pause
  // re-armed for what was left of it (its deadline, `dueAt`), or over at once when it passed.
  async function loadQueue() {
    const saved = await readQueue();
    const spell = spelled ?? respellRuns(spellings(await records()));
    // A comment a run took as the listener stopped is that run's (restoreRuns()).
    const taken = new Set();
    for (const task of tasks.values()) {
      for (const item of task.live?.handled ?? []) if (item.queueId) taken.add(item.queueId);
    }
    for (const t of saved) {
      t.repo = spell(t.repo);
      for (const item of t.pending) item.repo = spell(item.repo);
      const key = taskKey(t.repo, t.id);
      // Once each: a comment in a kept file and in the store too, say.
      t.pending = t.pending.filter((item) => {
        if (!item.queueId) return true;
        if (taken.has(item.queueId)) return false;
        taken.add(item.queueId);
        return true;
      });
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
        task = newTask(t);
        tasks.set(key, task);
      }
      task.next = { ...t.next, ...task.next };
      task.pending.push(...t.pending.map(revive));
      if (!t.pending.length) continue;
      // Saved before deadlines were: its pause starts again.
      const dueAt = t.dueAt ?? undefined;
      const left = dueAt === undefined ? "" : `, due in ${Math.max(0, dueAt - Date.now())} ms`;
      log(`${key}: ${t.pending.length} comment(s) queued before the restart${left}`);
      if (!task.running) ctx.startLater(task, dueAt);
      // Its run began before: these comments weren't checked against the repo's users then.
      else ctx.track(ctx.dropRefused(task).then(() => ctx.deliverLater(task, dueAt)));
    }
    // In the store as it is now (one spelling, without what was dropped); queue.json and the
    // kept files no more, once their comments are there (this write, or the next that succeeds).
    for (const path of [queuePath, ...keptFiles()]) if (existsSync(path)) removeOnceSaved(path);
    await saveQueue();
  }

  // What a listener needs to carry on with a run started by a previous one: written when it
  // starts and whenever a comment reaches it, Claude answers or the reply is posted, and within
  // a second of the output it reads (saveLiveSoon()); removed once it is over (runs.mjs
  // teardown(), which sets `over`: a write still due then writes nothing). In order, each after
  // the comments' 👀 are known.
  const livePath = (id) => join(ctx.logDir, `${id}.live.json`);

  function saveLive(task) {
    const live = task.live;
    clearTimeout(live.soon);
    live.soon = null;
    // Whether it was written.
    const write = async () => {
      if (live.over) return false;
      // Its log first: the lines counted here are at the runner (`lines`, which the next
      // listener skips). A few seconds at most: with the runner away, the state goes anyway
      // (what it says, `replied` say, matters more than a line the next listener misses).
      await logSent(live);
      if (live.over) return false;
      const handled = [...live.handled];
      // State saved before #503 has where its log was in the listener's volume.
      const { logPath: _, ...record } = live.record;
      const state = {
        task: pick(task),
        ...Object.fromEntries(
          [
            "id",
            "mode",
            "talk",
            "light",
            "secret",
            "agentToken",
            "sandbox",
            "asked",
            "replyTo",
            "replied",
            "hosts",
            "shots",
          ]
            .concat(["trusted", "cached", "uncached", "branches", "lines", "result", "later"])
            .concat(["cancelled", "overflow", "answered", "logPhase", "created", "reruns", "fork"])
            .concat(["graceUntil"])
            .map((k) => [k, live[k]]),
        ),
        // Its run tokens still valid, for its output's redaction after a restart (broker.mjs).
        runTokens: ctx.broker.issuedOf?.(live.id) ?? [],
        record,
        handled: await Promise.all(live.handled.map(plain)),
        // Delivered comments are among the handled ones.
        unanswered: live.unanswered.map((i) => live.handled.indexOf(i)),
      };
      // The run's tokens (or its secret, from before tokens) are in it: the owner's only.
      writeJsonAtomic(livePath(live.id), state, { mode: 0o600 });
      moved(live, handled);
      return true;
    };
    live.saving = (live.saving ?? Promise.resolve())
      .then(write)
      .catch((error) => (log(`${live.key}: saving its state: ${error.stack ?? error}`), false));
    return live.saving;
  }

  // The lines of output read (`lines`) and the silent-end grace they push back (`graceUntil`)
  // change with each line: saved a second later at most, once for all those that came
  // meanwhile. A listener killed in that second reads them again, and its log has them twice.
  function saveLiveSoon(task, delayMs = LIVE_SAVE_MS) {
    const live = task.live;
    if (live.soon || live.over) return;
    live.soon = setTimeout(() => {
      live.soon = null;
      if (task.live === live) saveLive(task);
    }, delayMs);
    live.soon.unref?.();
  }

  // The pushes of the run's GitHub took (git-gateway.mjs), on its record: when it last pushed,
  // and which branch, for the dashboard. Saved with it, so a restart keeps them.
  // The issues it creates, the comments it posts and the reactions it adds too
  // (github-writes.mjs answered()), in `live.created`, and the workflow runs it reruns, in
  // `live.reruns`.
  function watchPushes(task) {
    const { live } = task;
    ctx.broker.watchPushes(live.id, ({ branch, at }) => {
      Object.assign(live.record, { branch, lastPushAt: at });
      if (task.live === live) saveLive(task);
    });
    ctx.broker.watchChanges(live.id, () => {
      if (task.live === live) saveLive(task);
    });
  }

  // Runs a previous listener left behind, from their saved state: their tokens and egress work
  // again at once, and comments find them. reattach() then follows their sandboxes.
  // Whether each one's inbox is still open is asked of the runner before a comment can reach
  // it: no comment goes to one until it answers. `waitMs`: how long the start waits for that;
  // a runner away longer doesn't keep the listener down, and a run whose answer comes later
  // takes its comments then.
  async function restoreRuns({ waitMs = RESTORE_WAIT_MS } = {}) {
    if (!spelled) respellRuns(spellings(recordsWith([])));
    const live = readLive();
    for (const saved of live) {
      saved.task.repo = spelled(saved.task.repo);
      saved.record.repo = spelled(saved.record.repo);
      saved.record.key = respelled(saved.record.key, spelled);
      for (const item of saved.handled ?? []) item.repo = spelled(item.repo);
    }
    const restored = live.map(restoreRun);
    let started = true;
    const asked = Promise.all(
      restored.map(async (task) => {
        const run = task.live;
        if (!run.open) return;
        run.open = false;
        let closed;
        try {
          closed = await ctx.runner.closed(run.id);
        } catch (error) {
          // Not knowing: no comment goes to it, they wait for the next run.
          log(`${run.key}: its inbox: ${error.message}`);
          return;
        }
        if (closed || task.live !== run || run.finishing || run.cancelled) return;
        run.open = true;
        // Answered after the start went on: what waits meanwhile goes to it now.
        if (!started) ctx.deliverLater?.(task);
      }),
    );
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(resolve, waitMs)));
    await Promise.race([asked, late]).finally(() => clearTimeout(timer));
    started = false;
    return restored;
  }

  function restoreRun(saved) {
    const key = taskKey(saved.task.repo, saved.task.id);
    // State saved before #503 has where its log was in the listener's volume.
    const { logPath: _, ...kept } = saved.record;
    // State saved before records kept their screenshots' folder has it beside them.
    const shots = kept.shots ?? saved.shots ?? null;
    // Its phase as its log has it: records saved before they kept it in step have none, or
    // "building image".
    const phase = saved.logPhase ?? kept.phase ?? null;
    const record = { ...kept, shots, phase, status: "running", finishedAt: null };
    addRun(ctx, record);
    let task = tasks.get(key);
    if (!task) {
      task = newTask(saved.task);
      tasks.set(key, task);
    }
    const handled = saved.handled.map(revive);
    task.live = {
      ...saved,
      key,
      record,
      result: savedResult(saved.result),
      // Its log at the runner, written on from its end (asked first), once the log this
      // listener kept of it, if any, moved there (runlog.mjs moveLogs()).
      logFile: ctx.runLogs.open(saved.id, { size: null, after: ctx.logsMoving?.get(saved.id) }),
      // A cancelled or overflowed run takes no more comments: they wait for the next one; nor
      // one whose inbox is closed (restoreRuns()).
      open: !saved.cancelled && !saved.overflow,
      // A run started before the proxy decrypted HTTPS doesn't trust its CA: nothing cached.
      cached: saved.uncached ? saved.cached : [],
      handled,
      unanswered: saved.unanswered.map((i) => handled[i]).filter(Boolean),
      // State saved before runs kept the issues they created: none.
      created: Array.isArray(saved.created) ? saved.created : [],
      // Or the workflow runs they reran.
      reruns: Array.isArray(saved.reruns) ? saved.reruns : [],
      saving: null,
    };
    delete task.live.task;
    task.running = true;
    ctx.running++;
    ctx.broker.register(task.repo, permissionsFor(saved.mode, saved.light), {
      // Fail closed: a saved run that doesn't say it was a work run doesn't push.
      push: saved.light === false,
      mode: saved.mode,
      issue: task.number,
      base: task.base,
      // The same list as its live state's, which saveLive() writes.
      created: task.live.created,
      reruns: task.live.reruns,
      reason: record.reason ?? null,
      // Its id, so its tokens still name it; a run from before tokens, its secret.
      id: saved.id,
      secret: saved.secret ?? null,
      agentToken: saved.agentToken ?? null,
      sandbox: saved.sandbox ?? null,
      issued: saved.runTokens ?? [],
    });
    // State saved before runs had branches: none, rather than any; before they kept whether they
    // were a fork's, not one: what it fetches is checked (github-forks.mjs).
    ctx.broker.allow(saved.id, saved.branches ?? [], saved.fork === true);
    const { logFile } = task.live;
    // Its agent's calls go on to the provider and credential it started on (a fallback's), or its
    // agent's own when the record has none: never another agent's credential.
    ctx.broker.provide(
      saved.id,
      record.provider ?? agentFor(record.agent).defaultProvider,
      (message) => writeEvent(logFile, "note", { message }),
      record.credential ?? null,
    );
    watchPushes(task);
    // The broker service hears it still goes, and gets its inbox and files again (all of them,
    // for a run from before it, #505): its tokens renew there, its sandbox reads them there.
    const told = ctx.brokerService?.persist ?? ((what, fn) => fn().catch(() => {}));
    told(`run ${saved.id}`, () => ctx.broker.restore(saved.id, shots));
    if (ctx.runner.resync) told(`run ${saved.id}'s files`, () => ctx.runner.resync(saved.id));
    return task;
  }

  // Follows each restored run's sandbox to its end, as if the listener had never stopped. A
  // run whose sandbox never started gives its comments back to the queue, unless it was
  // cancelled or its output passed RUN_LOG_MAX_MB: it ends as such (runs.mjs), its sandbox
  // stopped again if it runs. Sandboxes nobody knows about any more are told to finish (their
  // next run waits for them). First, this listener joins the running sandboxes' networks: a
  // new container isn't on them.
  async function reattach(restored) {
    await relink();
    const sandboxes = await listSandboxes();
    for (const task of restored) {
      const live = task.live;
      const sandbox = sandboxes.find((s) => s.run === live.id);
      if (live.replied || live.cancelled || live.overflow || sandbox) {
        // Where its log goes on from: its size at the runner.
        await live.logFile.ready;
        log(`${live.key}: picked up ${task.name} again`);
        if ((live.cancelled || live.overflow) && sandbox?.running) {
          ctx.runner
            .kill(task.name)
            .catch((error) => log(`${live.key}: stopping its sandbox: ${error.message ?? error}`));
        }
        ctx.follow(task);
        continue;
      }
      log(`${live.key}: its sandbox never started: its comments are queued again`);
      await requeue(task);
    }
    // Those of the runs going now, restored or started since this listener did (the runner
    // took a while to answer): its own.
    const going = [...ctx.tasks.values()].filter((t) => t.live);
    for (const s of sandboxes) {
      if (going.some((t) => t.live.id === s.run || t.name === s.name)) continue;
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

  // Its comments back in the queue before its state goes (teardown() saves the queue first).
  async function requeue(task) {
    const { handled } = task.live;
    task.live.record.status = "interrupted";
    task.pending.unshift(...handled);
    await ctx.teardown(task);
    ctx.startLater(task);
  }

  return {
    unifySpellings,
    saveQueue,
    loadQueue,
    take,
    eyesSaved,
    removeOnceSaved,
    keepQueued,
    livePath,
    saveLive,
    saveLiveSoon,
    watchPushes,
    restoreRuns,
    reattach,
    relink,
  };
}
