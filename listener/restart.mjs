// Restarts: the queue and the runs a listener leaves to the next one, saved as they change, so
// that one killed without SIGTERM (a crash, an OOM kill) leaves the same as one that stopped.
// The comments waiting for a run are in the store (`queue`, with each task's deadline: the end
// of its pause); each run's state too (`runs/<id>`), without its tokens: the next copy asks the
// broker service for those (#617). The next listener reads both,
// re-arms the deadlines, finds the sandboxes by their labels (through the runner service,
// which outlives it), follows their output from where
// the previous one stopped, and posts each reply once.
import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentFor } from "./agents/index.mjs";
import { parseKey, taskKey } from "./events.mjs";
import { RESEARCH } from "./modes.mjs";
import { addRun, isRunState, writeEvent } from "./runlog.mjs";
import { runLogContext } from "./runs.mjs";
import { ambiguous, githubNames, respelled, spellings } from "./spelling.mjs";
import { listDir, readJson } from "../lib/files.mjs";
import { newLogContext } from "../lib/log.mjs";
import { storable, values } from "../lib/store.mjs";
import { countRun, newTask, noLongerAllowed } from "./tasks.mjs";

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

// Where each live run's state is in the store: `runs/<id>` (saveLive()), listed at the takeover.
export const LIVE_PREFIX = "runs/";
const liveKey = (id) => `${LIVE_PREFIX}${id}`;

// Where moveLive() sets aside a logs/<run>.live.json that holds no run's state, no move reading
// it again: <file>.bad, or <file>.bad.<n> beside one the operator hasn't removed yet, which a
// rename would overwrite.
function asideName(dir, file) {
  const taken = new Set(listDir(dir));
  let name = `${file}.bad`;
  for (let n = 2; taken.has(name); n++) name = `${file}.bad.${n}`;
  return name;
}

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

function pick({ repo, id, kind, number, name, base, discussionId, settings, owner, pool }) {
  return { repo, id, kind, number, name, base, discussionId, settings, owner, pool };
}

// How often queueWritten() tries the queue's write again while the store is away, and a run's
// end its queue's write or its state's removal (removeLive()).
export const QUEUE_RETRY_MS = 5000;

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
  // spelled(repo) (spelling.mjs): set by unifySpellings(), or by restoreRuns() without GitHub's names.
  let spelled = null;

  // The runs' states a previous copy left, read once (by unifySpellings() or restoreRuns(),
  // whichever comes first): those a listener of the release before kept in
  // logs/<run>.live.json moved to the store first.
  let leftLive = null;
  const readLive = () => (leftLive ??= moveLive().then(listLive));

  // The runs' states in the store. A key that holds no run's state is logged and removed: else
  // it would be listed again at every takeover. A removal the store refuses is logged, the start
  // going on: the next takeover tries again.
  async function listLive() {
    const found = [];
    for await (const [key, saved] of values(ctx.store, LIVE_PREFIX)) {
      if (isRunState(saved)) {
        found.push(saved);
        continue;
      }
      try {
        await ctx.store.delete(key);
        log(`${key}: not a run's state, removed`);
      } catch (err) {
        log(`${key}: not a run's state, its removal failed: ${err.message}`);
      }
    }
    return found;
  }

  // The tokens the moved files held, by run: { agentToken, runTokens, path }, in memory only.
  // The broker service is told them (restoreRun()), and keeps them for the next copies: the file
  // is removed once it has them, or once the run is over (removeLive()), whichever comes first.
  const movedTokens = new Map();

  // Each logs/<run>.live.json written to the store without its tokens. A store that refuses the
  // write fails the start, the file kept: the queue can't be read either then. One whose run the
  // store has already (a copy that stopped before the broker service had its tokens) leaves the
  // store's, newer, as it is: only its tokens are read. One that isn't a run's state is set
  // aside as <run>.live.json.bad, logged once: left as it was, it would be logged at every
  // start. The operator removes it (tidyData() names it, server.mjs); a rename that fails leaves
  // it there, logged, for the next start to try again.
  async function moveLive() {
    const files = listDir(ctx.logDir).filter((f) => f.endsWith(".live.json"));
    for (const file of files) {
      const path = join(ctx.logDir, file);
      const saved = readJson(path);
      if (!isRunState(saved)) {
        try {
          const aside = asideName(ctx.logDir, file);
          renameSync(path, join(ctx.logDir, aside));
          log(`${file}: not a run's state, set aside as ${aside}`);
        } catch (err) {
          log(`${file}: not a run's state, left there: ${err.message}`);
        }
        continue;
      }
      const { agentToken: agent, runTokens: issued, ...state } = saved;
      const agentToken = typeof agent === "string" ? agent : null;
      const runTokens = Array.isArray(issued) ? issued.filter((t) => typeof t === "string") : [];
      movedTokens.set(saved.id, { agentToken, runTokens, path });
      if (await ctx.store.get(liveKey(saved.id))) continue;
      const secrets = [...(ctx.storeSecrets?.() ?? []), agentToken, ...runTokens];
      await ctx.store.set(liveKey(saved.id), storable(state, secrets.filter(Boolean)));
      log(`${saved.record.key ?? saved.id}: its state moved from ${file} to the store`);
    }
  }

  // The queue a previous copy left, the store's. Read once, by unifySpellings() or loadQueue(),
  // whichever comes first.
  let leftQueue = null;
  // And the files a listener of the release before left, a run's end the queue couldn't be
  // written for (logs/<run>.queued.json): read with it, removed once it is written.
  const keptFiles = () =>
    listDir(ctx.logDir)
      .filter((f) => f.endsWith(".queued.json"))
      .map((f) => join(ctx.logDir, f));
  function readQueue() {
    leftQueue ??= ctx.store.get(QUEUE_KEY).then((stored) => {
      const legacy = keptFiles().flatMap((path) => {
        const saved = readJson(path);
        return Array.isArray(saved) ? saved : [];
      });
      return [...Object.values(stored ?? {}), ...legacy];
    });
    return leftQueue;
  }

  // Every repo the runs, the runs going, the queue and `keys` (other state's task keys) have,
  // for spellings().
  const records = async (keys = []) => recordsWith(await readQueue(), await readLive(), keys);
  function recordsWith(queued, live, keys = []) {
    return [
      ...ctx.runs,
      ...live.map((saved) => ({
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

  // Files whose comments are only safe once the queue is written with them (a .queued.json of a
  // release before #617): removed after the next write that succeeds, whichever it is.
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

  // Comments taken out of the queue for a wait (work.mjs requeue(), runs.mjs unqueue()): task →
  // [items], still written with the queue until `until` resolves (the wait is in the store),
  // then written without them. One pair: the wait first, then the queue, so a listener killed in
  // between leaves them in both, which loadQueue() leaves to the wait, never in neither.
  const parked = new Map();
  function park(task, items, until) {
    parked.set(task, [...(parked.get(task) ?? []), ...items]);
    const done = () => {
      const left = (parked.get(task) ?? []).filter((item) => !items.includes(item));
      if (left.length) parked.set(task, left);
      else parked.delete(task);
      saveQueue();
    };
    Promise.resolve(until).then(done, done);
  }

  // Once the queue is in the store with what is queued by now, the comment queue() pushes after
  // the await this turn ends included (tasks.mjs): what a change written after the queue waits
  // for (a wait released, a brainstorm ended: waits.mjs, brainstorms.mjs). Tried again every
  // QUEUE_RETRY_MS while the store is away, until written or the lease is lost (`ctx.held()`).
  function queueWritten() {
    const sleep = ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    return new Promise((resolve) => setImmediate(resolve)).then(async () => {
      while (!(await saveQueue()) && (ctx.held?.() ?? true)) await sleep(QUEUE_RETRY_MS);
    });
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
      const all = [...new Set([...takenBy(t.live), ...(parked.get(t) ?? []), ...t.pending])];
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
    // A comment a run took as the listener stopped is that run's (restoreRuns()), one the
    // dashboard moved to a wait the wait's (park()).
    const taken = new Set(ctx.waits?.unqueued?.() ?? []);
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
    // In the store as it is now (one spelling, without what was dropped); the kept files no more,
    // once their comments are there (this write, or the next that succeeds).
    for (const path of keptFiles()) removeOnceSaved(path);
    await saveQueue();
  }

  // What a listener needs to carry on with a run started by a previous one, in the store
  // (`runs/<id>`): written when it starts and whenever a comment reaches it, Claude answers or
  // the reply is posted, and within a second of the output it reads (saveLiveSoon()); removed
  // once it is over (removeLive(), after runs.mjs teardown() set `over`: a write still due then
  // writes nothing). In order, each after the comments' 👀 are known. Never its tokens: the
  // next copy asks the broker service for them (#617).

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
            .concat(["capabilities", "engine"])
            // A review's commit (runs.mjs launch()): its review is posted there.
            .concat(["reviewFrom"])
            .map((k) => [k, live[k]]),
        ),
        record,
        handled: await Promise.all(live.handled.map(plain)),
        // Delivered comments are among the handled ones.
        unanswered: live.unanswered.map((i) => live.handled.indexOf(i)),
      };
      // Its comments' text and authors, without the operator's secrets nor the run's tokens,
      // should one of them hold one.
      const secrets = [...(ctx.storeSecrets?.() ?? []), ...ctx.broker.secretsOf(live.id)];
      await ctx.store.set(liveKey(live.id), storable(state, secrets));
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

  // A run's end (runs.mjs teardown(), once its last write is done): the queue written with what
  // it put back, then its state removed, so that a copy killed between the two finds its
  // comments in both (the run's win, loadQueue()), never in neither. A write of the queue that
  // fails keeps it in memory and is tried again every QUEUE_RETRY_MS until it lands, the run
  // holding its task meanwhile (no other run starts for it); its state's removal too. A copy
  // that stops or loses its lease meanwhile (`ctx.held()`) leaves the state: the next copy finds
  // the comments there, its sandbox gone. → whether the state is gone.
  async function removeLive(task) {
    const { live } = task;
    const retryMs = ctx.queueRetryMs ?? QUEUE_RETRY_MS;
    const again = (what) => {
      if (ctx.stopping || !(ctx.held?.() ?? true)) {
        log(`${live.key}: ${what} failed as this copy stops: its state stays for the next one`);
        return false;
      }
      return new Promise((resolve) => setTimeout(() => resolve(true), retryMs).unref?.());
    };
    let said = false;
    while (!(await saveQueue())) {
      if (!said) log(`${live.key}: its state stays until the queue is saved with what it put back`);
      said = true;
      if (!(await again("saving the queue"))) return false;
    }
    for (;;) {
      try {
        await ctx.store.delete(liveKey(live.id));
        // A file of the release before it was moved from, whose tokens the broker service may
        // not have had yet: the run is over, they name nothing.
        forgetMoved(live.id);
        return true;
      } catch (error) {
        log(`${live.key}: removing its state: ${error.stack ?? error}`);
        if (!(await again("removing its state"))) return false;
      }
    }
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
    const live = await readLive();
    if (!spelled) respellRuns(spellings(recordsWith([], live)));
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

  // The file a run's state was moved from (moveLive()), removed: its tokens are the broker
  // service's, or name nothing any more. One that held none has nothing to wait for.
  function forgetMoved(id) {
    const moved = movedTokens.get(id);
    if (moved) rmSync(moved.path, { force: true });
  }

  // Restored task → once the broker service told its run's tokens (restoreRun()).
  const recalls = new WeakMap();

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
      // Its log at the runner, written on from its end (asked first).
      logFile: ctx.runLogs.open(saved.id, { size: null }),
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
    countRun(ctx, task, 1);
    ctx.broker.register(task.repo, {
      // Fail closed: a run saved with its capabilities pushes only with `push` (its `light` says
      // only whether its mode has volumes of its own, #498); one saved before them, only when it
      // says it was a work run.
      push: Array.isArray(saved.capabilities)
        ? saved.capabilities.includes("push")
        : saved.light === false,
      mode: saved.mode,
      issue: task.number,
      base: task.base,
      // The same list as its live state's, which saveLive() writes.
      created: task.live.created,
      reruns: task.live.reruns,
      reason: record.reason ?? null,
      // Its id, so its tokens still name it; those a file of the release before kept, at once
      // (the broker service has the rest: recall(), below).
      id: saved.id,
      agentToken: movedTokens.get(saved.id)?.agentToken ?? null,
      sandbox: saved.sandbox ?? null,
      issued: movedTokens.get(saved.id)?.runTokens ?? [],
      // Its tokens' `caps`, which its token reads with (and no token without `pull`).
      caps: savedCapabilities(saved),
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
    // The broker service hears it still goes, and gets its inbox and files again (#505): its
    // tokens renew there, its sandbox reads them there. Then it says which tokens the run holds,
    // which its output is redacted of (#617): reattach() waits for that a little. One retry for
    // both, on purpose: while a broker of the release before refuses the second (403), the
    // first goes again with the tokens a moved file held, which a broker updated since then
    // takes. It's idempotent.
    const told = ctx.brokerService?.persist ?? ((what, fn) => fn().catch(() => {}));
    const moved = movedTokens.get(saved.id);
    const tokens = moved ? [moved.agentToken, ...moved.runTokens].filter(Boolean) : [];
    recalls.set(
      task,
      told(`run ${saved.id}`, async () => {
        await ctx.broker.restore(saved.id, shots, tokens);
        const found = await ctx.broker.recall?.(saved.id);
        // The broker service has them (it answered them back): the file they were in can go. A
        // broker of the release before takes the PUT but drops its tokens, and refuses
        // /secrets: the file stays until one that has them answers, or the run is over.
        const had = found ? [found.agentToken, ...found.tokens] : [];
        if (tokens.every((token) => had.includes(token))) forgetMoved(saved.id);
      }),
    );
    if (ctx.runner.resync) told(`run ${saved.id}'s files`, () => ctx.runner.resync(saved.id));
    return task;
  }

  // Follows each restored run's sandbox to its end, as if the listener had never stopped. A
  // run whose sandbox never started gives its comments back to the queue, unless it was
  // cancelled or its output passed RUN_LOG_MAX_MB: it ends as such (runs.mjs), its sandbox
  // stopped again if it runs. Sandboxes nobody knows about any more are told to finish (their
  // next run waits for them). First, this listener joins the running sandboxes' networks: a
  // new container isn't on them.
  async function reattach(restored, { waitMs = RESTORE_WAIT_MS } = {}) {
    await relink();
    const sandboxes = await listSandboxes();
    // Its output is followed once its tokens are known, or `waitMs` on (a broker service away
    // longer doesn't hold the runs up: their tokens' shape is redacted anyway, lib/redact.mjs).
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(resolve, waitMs)));
    const told = Promise.allSettled(restored.map((task) => recalls.get(task)));
    await Promise.race([told, late]).finally(() => clearTimeout(timer));
    for (const task of restored) {
      const live = task.live;
      const sandbox = sandboxes.find((s) => s.run === live.id);
      if (live.replied || live.cancelled || live.overflow || sandbox) {
        // Where its log goes on from: its size at the runner.
        await live.logFile.ready;
        // Followed under its own context again, as from its start (runs.mjs).
        newLogContext(runLogContext(task), () => {
          log(`${live.key}: picked up ${task.name} again`);
          if ((live.cancelled || live.overflow) && sandbox?.running) {
            ctx.runner
              .kill(task.name)
              .catch((error) =>
                log(`${live.key}: stopping its sandbox: ${error.message ?? error}`),
              );
          }
          ctx.follow(task);
        });
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
    // Left to the next copy when this one stops first.
    if (await ctx.teardown(task)) ctx.startLater(task);
  }

  return {
    unifySpellings,
    saveQueue,
    loadQueue,
    take,
    park,
    queueWritten,
    eyesSaved,
    saveLive,
    saveLiveSoon,
    removeLive,
    watchPushes,
    restoreRuns,
    reattach,
    relink,
  };
}

// A restored run's capabilities: as saved, else (a run saved before capabilities, #495) what
// its mode's token read then, so that it reads the same after the restart (github-app.mjs
// readsOf()): nothing for research, the code, issues, pull requests and CI for the rest, and
// discussions for a discussion run.
// A run saved before #497 with `read:discussions` outside a discussion run (the old
// mode-work.rego gave it): dropped, as its token would now need a permission its App may lack.
export function savedCapabilities(saved) {
  if (Array.isArray(saved.capabilities)) {
    if (saved.mode === "discussion") return saved.capabilities;
    return saved.capabilities.filter((c) => c !== "read:discussions");
  }
  if (RESEARCH.has(saved.mode)) return [];
  const reads = ["pull", "read:issues", "read:pulls", "read:actions"];
  return saved.mode === "discussion" ? [...reads, "read:discussions"] : reads;
}
