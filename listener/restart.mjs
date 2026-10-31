// Restarts: the queue and the runs a listener leaves to the next one. On SIGTERM the comments
// still waiting for a run go to queue.json; each run's state is in logs/<run>.live.json all
// along. The next listener reads both, finds the sandboxes by their labels, follows their
// output from where the previous one stopped, and posts each reply once.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentFor } from "./agents/index.mjs";
import { parseKey, taskKey } from "./events.mjs";
import { permissionsFor } from "./modes.mjs";
import { addRun, openLog, writeEvent } from "./runlog.mjs";
import { ambiguous, githubNames, respelled, spellings } from "./spelling.mjs";
import { readJson, writeJsonAtomic } from "../lib/files.mjs";
import { newTask, noLongerAllowed } from "./tasks.mjs";

// A result saved by a listener from before the agent seam is Claude Code's raw stream-json
// `result` event: Deckhand's own from it, with the duration of all its turns.
function savedResult(result) {
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
  // spelled(repo) (spelling.mjs): set by unifySpellings(), or by restoreRuns() without GitHub's names.
  let spelled = null;

  const readLive = () =>
    readdirSync(ctx.logDir)
      .filter((f) => f.endsWith(".live.json"))
      .map((file) => readJson(join(ctx.logDir, file)))
      .filter(Boolean);

  // Every repo the runs, the runs going, the queue and `keys` (other state's task keys) have,
  // for spellings().
  function records(keys = []) {
    const queued = readJson(queuePath);
    return [
      ...ctx.runs,
      ...readLive().map((saved) => ({
        repo: saved.task?.repo,
        startedAt: saved.record?.startedAt,
        live: true,
      })),
      ...(Array.isArray(queued) ? queued : []).map((t) => ({ repo: t.repo })),
      ...keys.map((key) => ({ repo: parseKey(key)?.repo })),
    ];
  }

  // One spelling per repo, before restoreRuns() and loadQueue(): GitHub's for a repo the state
  // has under two, asked with `nameOf(repo)` (repo-check.mjs), for at most `waitMs`. Else
  // spellings()'. The runs' list (runlog.mjs loadRuns()) takes it now: the dashboard shows the
  // repo once, and its tasks are one. In memory only: the next start does it again. Returns
  // spelled(), for the other state keyed by task (server.mjs).
  async function unifySpellings({ nameOf = null, keys = [], waitMs } = {}) {
    const all = records(keys);
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
    const spell = spelled ?? respellRuns(spellings(records()));
    for (const t of saved) {
      t.repo = spell(t.repo);
      for (const item of t.pending) item.repo = spell(item.repo);
      const key = taskKey(t.repo, t.id);
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
    };
    live.saving = (live.saving ?? Promise.resolve())
      .then(write)
      .catch((error) => log(`${live.key}: saving its state: ${error.stack ?? error}`));
    return live.saving;
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
  function restoreRuns() {
    if (!spelled) respellRuns(spellings(records()));
    const live = readLive();
    for (const saved of live) {
      saved.task.repo = spelled(saved.task.repo);
      saved.record.repo = spelled(saved.record.repo);
      saved.record.key = respelled(saved.record.key, spelled);
      for (const item of saved.handled ?? []) item.repo = spelled(item.repo);
    }
    return live.map(restoreRun);
  }

  function restoreRun(saved) {
    const key = taskKey(saved.task.repo, saved.task.id);
    const logPath = join(ctx.logDir, `${saved.id}.log`);
    // State saved before records kept their screenshots' folder has it beside them.
    const shots = saved.record.shots ?? saved.shots ?? null;
    // Its phase as its log has it: records saved before they kept it in step have none, or
    // "building image".
    const phase = saved.logPhase ?? saved.record.phase ?? null;
    const record = { ...saved.record, shots, phase, logPath, status: "running", finishedAt: null };
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
      logFile: openLog(logPath),
      // A cancelled or overflowed run takes no more comments: they wait for the next one.
      open: !saved.cancelled && !saved.overflow && !ctx.runner.closed(saved.id),
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
    const { handled } = task.live;
    task.live.record.status = "interrupted";
    await ctx.teardown(task);
    task.pending.unshift(...handled);
    ctx.startLater(task);
  }

  return {
    unifySpellings,
    saveQueue,
    loadQueue,
    livePath,
    saveLive,
    watchPushes,
    restoreRuns,
    reattach,
    relink,
  };
}
