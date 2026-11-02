// Tasks: one queue per issue, pull request or discussion, at most maxParallel containers.
// A comment that passed the checks is queued under its task's key ("org/repo#12"); after a
// pause (so a burst is one run) it starts a run, or goes to the running one (deliver()).
import { configErrors } from "./access.mjs";
import { agentFor } from "./agents/index.mjs";
import { repoAllowed } from "./config.mjs";
import { hasLabel } from "./comments.mjs";
import {
  commentsText,
  dashboardLink,
  linkedIssue,
  linkTo,
  parseKey,
  prId,
  takeOptions,
  taskKey,
  workItem,
} from "./events.mjs";
import { getJson } from "./github.mjs";
import { customMode, entryRun, isApart } from "./modes.mjs";
import { liveMessage } from "./prompts.mjs";
import { hasOpenQuestions, stillAsks } from "./questions.mjs";
import {
  CONFIG_FILE,
  effectiveConfig,
  modeNames,
  startable,
  taskSandboxName,
} from "./repo-config.mjs";
import { queueId } from "./restart.mjs";
import { LOOPING, loopState } from "./reviews.mjs";
import { writeEvent } from "./runlog.mjs";
import { sameTask, taskId } from "./spelling.mjs";
import { createTaskModes } from "./task-modes.mjs";

// Why a queued comment may no longer run, or null: its repo left ALLOWED_REPOS, or its author
// left ALLOWED_USERS or (`settings`, when known) the repo's `users`. Checked again when it was
// queued before a restart, and when its run begins. Items the listener makes itself
// (onboarding, conflicts) have no comment and no author; a comment without one is refused.
export function noLongerAllowed(config, item, settings = null) {
  if (!repoAllowed(config, item.repo)) {
    return `${item.repo} is no longer in ALLOWED_REPOS`;
  }
  if (!item.author) return item.comment ? "its author isn't known" : null;
  const login = item.author.toLowerCase();
  if (!config.users.includes(login) || (settings && !settings.users.includes(login))) {
    return `${item.author} is no longer an allowed user`;
  }
  return null;
}

// A task with nothing queued nor running yet: `fields` are the comment's (repo, id, kind,
// number, base, name, settings), or those a listener left (restart.mjs).
export function newTask(fields) {
  return {
    ...fields,
    pending: [],
    running: false,
    ready: false,
    timer: null,
    // When its pause ends (startLater(), deliverLater()): the timer's deadline, saved.
    dueAt: null,
    live: null,
    next: {},
  };
}

// Whether task `key` of `tasks` has a run going or comments waiting for one, under any
// spelling of its repo: a key kept from before a restart unified them (spelling.mjs) mustn't
// start a second sandbox on the same branch.
export function busyTask(tasks, key) {
  const busy = (task) => !!(task?.running || task?.pending.length);
  if (busy(tasks.get(key))) return true;
  for (const [other, task] of tasks) if (sameTask(other, key) && busy(task)) return true;
  return false;
}

// Whether task `t` holds one of AUTO_PICKUP_SLOTS (auto-pickup.mjs): its run is an auto-picked
// one, or, before it starts (or while run() reads its settings), its first queued item is.
export function pickedTask(t) {
  return t.live ? !!t.live.record?.autoPickup : !!t.pending?.[0]?.autoPickup;
}

// `fn()` once the calls `chains` holds for `key` before it have settled, failed or not: → its
// promise. The key is dropped once its last call is done.
function inOrder(chains, key, fn) {
  const done = (chains.get(key) ?? Promise.resolve()).then(fn);
  const settled = done.catch(() => {});
  chains.set(key, settled);
  settled.then(() => chains.get(key) === settled && chains.delete(key));
  return done;
}

// `ctx` (server.mjs): the listener's state and services, read at call time. Tasks are
// `ctx.tasks`: key → { repo, id, kind, number, base, name, settings, pending: [], running,
// ready, timer, dueAt, live, next }; live: the running sandbox's (runs.mjs), next: "/model" and
// "/effort" for the next run.
export function createTasks(ctx) {
  const { config, log, skip, tasks } = ctx;
  const { modeOf, unknownMode } = createTaskModes(ctx);

  // A task's sandbox name: the task's, else taskSandboxName()'s.
  async function containerName(repo, id) {
    const key = taskKey(repo, id);
    if (tasks.has(key)) return tasks.get(key).name;
    return taskSandboxName(config, repo, id, ctx.runs, (name) => ctx.runner.hasSession(name));
  }

  // Task key, as the delivery names it → its latest admit(), settled: the next waits for it.
  const admitting = new Map();

  // A comment that passed the operator's checks, checked again with its repo's settings
  // (users, trigger lines), then queued. After the comments on its task that came before: its
  // checks await (the repo's settings, a pull request's lookup), and a follow-up whose answers
  // came first mustn't pass the comment that creates the task (accept() keeps that order only
  // from there on).
  function admit(first, event, payload) {
    return inOrder(admitting, taskKey(first.repo, first.id), () => admitNow(first, event, payload));
  }

  async function admitNow(first, event, payload) {
    const { settings, errors } = await ctx.repoSettings(first.repo, first.base);
    if (errors.length) {
      log(`${first.repo}: ${CONFIG_FILE} has errors: ${errors.join("; ")}`);
      // Only to someone asking for a run: other comments can't tell a broken config from none,
      // and discussions can't tell whether they are in the category that calls Claude.
      if ((first.trigger || first.modeLine) && first.kind !== "discussion") {
        await ctx.reply(first.repo, first.replyTo, configErrors(first.base, errors));
      }
      return;
    }
    const found = workItem(effectiveConfig(config, settings), event, payload, skip);
    if (!found) return;
    const item = await linked(found);
    item.base = first.base;
    item.settings = settings;
    // Never queued nor sent to the agent: a stuck run would never read it.
    if (item.trigger === "cancel") return cancelRun(item);
    if (item.after) {
      // A mode it can't run is said now, not once what it waits for is done.
      if (item.modeLine && !modeNames(settings).includes(item.modeLine)) {
        return unknownMode(item, `Unknown mode \`${item.modeLine}\`.`);
      }
      if (await ctx.waits.request(item)) return;
    }
    // Only the comment's own issue, as the delivery has it: a pull request's labels are its own.
    const issue = event === "issue_comment" && !payload.issue?.pull_request ? payload.issue : null;
    if (!hasAnswer(item) && unanswered(item, issue)) return holdBack(item);
    // A trigger or "/mode" comment replaces the issue's wait, once it runs: refused by the
    // policies, it changes nothing. The wait is held meanwhile (waits.mjs reserve()): a blocker
    // done during the decision doesn't start it beside the new comment.
    const key = taskKey(item.repo, item.id);
    // With "/after", only one that runs now (waits.mjs request() said false), the wait left.
    const replaces = item.trigger === "work" || !!item.modeLine;
    const held = replaces ? ctx.waits.reserve(key) : null;
    let mode = null;
    try {
      mode = await accept(item);
    } finally {
      if (replaces) await ctx.waits.release(key, !!mode, "a new comment replaces it", held);
    }
  }

  // A `/cancel` comment: the task's run stops (runs.mjs cancel()), or its queued comments are
  // dropped, and the comment gets a 👍; the run's reply says who stopped it. With nothing to
  // stop, a reply says so.
  async function cancelRun(item) {
    const key = taskKey(item.repo, item.id);
    if (!ctx.cancel(key, item.author)) {
      log(`${key}: /cancel with nothing running`);
      const text = `Nothing is running on #${item.replyTo}.`;
      await ctx.reply(item.repo, item.replyTo, text).catch((error) => log(`${key}: ${error}`));
      return;
    }
    await ctx.settle(item, "acknowledged");
  }

  // Whether the comment says anything besides its trigger and command lines: then it answers
  // the issue's open questions (questions.mjs takes the label off).
  function hasAnswer(item) {
    return !!takeOptions(item.text ?? "", {});
  }

  // Whether the repo's `wait_for_answers` holds `item` back: work, or a mode of the repo's, on an
  // issue (`issue`: as GitHub has it) that carries NEEDS_INPUT_LABEL for its own open questions,
  // not all answered by their ticked boxes. Brainstorms and the other modes apart from work
  // (modes.mjs `volumes`) still run: they can help answer. A run that stopped to ask isn't held either: any comment
  // continues it.
  function unanswered(item, issue) {
    if (!item.settings?.waitForAnswers || !config.needsInputLabel || !issue) return false;
    if (item.kind !== "issue" || item.replyTo !== item.number) return false;
    const mode = item.modeLine ?? (item.trigger === "work" ? "work" : null);
    const own = customMode(item.settings, mode);
    if (mode !== "work" && (!own || isApart(mode))) return false;
    if (!hasLabel(issue.labels, config.needsInputLabel)) return false;
    // Ticks in the bot's issue (an inbox run's), or that the listener didn't take for answers
    // (the bot's, someone not allowed: questions.mjs editedInput()), answer nothing until an
    // allowed user's edit takes the label off.
    const key = taskKey(item.repo, item.id);
    const ignored = issue.user?.type === "Bot" || !!ctx.inputs?.ticksIgnored?.(key);
    if (!(ignored ? hasOpenQuestions(issue.body) : stillAsks(issue.body))) return false;
    return ctx.runs.find((r) => r.key === key)?.status !== "needs-input";
  }

  // A trigger comment on an issue whose questions aren't answered: nothing starts, and the
  // reply says how to answer. The label stays (questions.mjs applyInput()).
  async function holdBack(item) {
    const key = taskKey(item.repo, item.id);
    log(`${key}: not started, its open questions aren't answered`);
    const url = ctx.publicUrl?.();
    const form = url ? ` or [on the dashboard](${dashboardLink(url, item.repo, key)})` : "";
    const text = `#${item.number} has open questions: nothing starts until they are answered. A trigger comment with the answers starts the run with them; answered in a comment${form}, a new trigger comment starts it. (\`wait_for_answers: false\` in \`${CONFIG_FILE}\` turns this off.)`;
    await ctx.reply(item.repo, item.replyTo, text).catch((error) => log(`${key}: ${error}`));
    await ctx.settle(item, "needs-input");
  }

  // A comment on a pull request that says it closes an issue, from a payload without the pull
  // request's head (events.mjs prItem()): the issue's only when that head is in the repo.
  // Unknown is the pull request's own.
  async function linked(item) {
    if (!item.claims) return item;
    const { claims: _, ...own } = item;
    const path = `/repos/${item.repo}/pulls/${item.number}`;
    let pr = null;
    let why = "lookup: 404";
    try {
      pr = await getJson(ctx.github, item.repo, path, [404]);
    } catch (error) {
      why = `lookup: ${error.message ?? error}`;
    }
    const issue = pr && linkedIssue(pr, item.repo, config.bot);
    if (!issue) {
      if (pr) why = "its head isn't a branch of the repo";
      log(`${taskKey(item.repo, own.id)}: says it closes #${item.claims}, not linked (${why})`);
    }
    return issue ? linkTo(item, issue) : own;
  }

  // A comment that waited for other issues (waits.mjs), checked again as if it had just come:
  // the operator's repos and the repo's users or config may have changed since. False when
  // it may no longer run (the reason logged).
  async function resume(item) {
    const key = taskKey(item.repo, item.id);
    const repoGone = noLongerAllowed(config, { repo: item.repo });
    if (repoGone) {
      log(`${key}: not started, ${repoGone}`);
      return false;
    }
    const { settings, errors } = await ctx.repoSettings(item.repo, item.base);
    if (errors.length) {
      log(`${key}: not started, ${CONFIG_FILE} has errors: ${errors.join("; ")}`);
      await ctx
        .reply(item.repo, item.replyTo, configErrors(item.base, errors))
        .catch((error) => log(`${key}: ${error}`));
      return false;
    }
    const refused = noLongerAllowed(config, item, settings);
    if (refused) {
      log(`${key}: not started, ${refused}`);
      return false;
    }
    if (await stillAsking({ ...item, settings })) {
      log(`${key}: not started yet, its open questions aren't answered`);
      return "answers";
    }
    // Refused by the policies (their reply said why), or nothing to run: not started.
    return !!(await accept({ ...item, settings }));
  }

  // Whether the issue of a comment that waited still has open questions (unanswered()), as
  // GitHub has it now. Not knowing isn't unanswered: the wait was what the comment asked for.
  async function stillAsking(item) {
    if (!item.settings.waitForAnswers || !config.needsInputLabel || item.kind !== "issue") {
      return false;
    }
    const path = `/repos/${item.repo}/issues/${item.number}`;
    const issue = await getJson(ctx.github, item.repo, path, [404, 410]).catch(() => null);
    return !!issue && unanswered(item, issue);
  }

  // Task key → the accept() of its latest item, settled: the next waits for it.
  const accepting = new Map();

  // Queues `item` after the items of its task that came before: modeOf() awaits (the policies,
  // a session look-up), and a follow-up mustn't pass the comment that creates the task. → its
  // mode, or null when it runs nothing (refused by the policies, nothing to go on in…).
  function accept(item) {
    return inOrder(accepting, taskKey(item.repo, item.id), () => queue(item));
  }

  // `store`'s entry for task `key` (titles.mjs closed(), pulls.mjs get()) under any spelling of
  // its repo: one a webhook recorded under another is only unified at a restart.
  function spelledGet(store, key) {
    if (!store) return null;
    const found = store.get(key);
    if (found) return found;
    const other = store.keys?.().find((k) => k !== key && sameTask(k, key));
    return other ? store.get(other) : null;
  }

  // Task `key`'s last run record, under any spelling: ctx.runs is newest first.
  const lastRun = (key) => ctx.runs?.find((r) => taskId(r.key) === taskId(key)) ?? null;

  // The review loop's entry of pull request `number` (reviews.mjs entry()), under any spelling
  // of `repo`: reviews.json's may be another's until a restart unifies them.
  function reviewEntry(repo, number) {
    const found = ctx.reviews?.entry?.(repo, number);
    if (found || !ctx.reviews?.keys) return found ?? null;
    const key = taskKey(repo, prId(number));
    const other = ctx.reviews.keys().find((k) => k !== key && sameTask(k, key));
    const spelled = other && parseKey(other)?.repo;
    return spelled ? (ctx.reviews.entry(spelled, number) ?? null) : null;
  }

  // Whether auto-picked task `key` of `repo` still holds its reserved slot with no run of its
  // own going nor queued: its last run was picked (or followed a pick), and its pull request,
  // open, is between two steps of its review loop (reviews.mjs loopState(), the dashboard's
  // in-review): waiting for CI, the next step being decided or on its way. The records and the
  // loop's entry are kept through a restart. Not once its work is done: the issue closed, the
  // pull request merged or closed, or a close seen since that run (picks.mjs), a reopen
  // included. Nor while it asks, nor once the loop is over: the slot is free then.
  function loopHolds(key, repo) {
    const last = lastRun(key);
    if (!last?.autoPickup || ctx.picks?.ended(key, last.id)) return false;
    const titles = ctx.titles?.closed && { get: ctx.titles.closed, keys: ctx.titles.keys };
    if (spelledGet(titles, key)) return false;
    const pr = spelledGet(ctx.pulls, key);
    if (pr?.state !== "draft" && pr?.state !== "ready") return false;
    return LOOPING.includes(loopState(reviewEntry(repo, pr.number), last)?.loop);
  }

  // Whether what is queued now on `task` (null: not in `tasks`) follows an auto-picked run
  // (#591): only while the task holds its reserved slot, so what it queues can't wait for a slot
  // the sweep gave away. Its run or first queued item is picked, or its loop holds the slot
  // between steps (loopHolds()). Then it holds the slot too, the review loop's runs and people's
  // comments alike.
  function followsPick(task, key, repo) {
    return (!!task && pickedTask(task)) || loopHolds(key, repo);
  }

  // Whether auto-picked task `key` of `repo`, nothing of it running nor queued (`task`, null
  // when it isn't in `tasks`, as after a restart), keeps its reserved slot between two steps of
  // its loop.
  function loopGoing(key, repo, task = null) {
    if (task?.running || task?.pending.length) return false;
    return loopHolds(key, repo);
  }

  async function queue(item) {
    // Its default branch, as GitHub said: "main" when it didn't.
    item.base ||= "main";
    const name = await containerName(item.repo, item.id);
    const key = taskKey(item.repo, item.id);
    item.mode = await modeOf(item, key, name);
    if (!item.mode) return null;
    ctx.titles.set(key, item.title);
    let task = tasks.get(key);
    if (!task) {
      task = newTask({ ...item, name });
      tasks.set(key, task);
    }
    // The latest settings decide the repo's parallel cap.
    if (item.settings) task.settings = item.settings;
    // Its pick's follow-up (the review loop, a comment): in the reserved slot too, and still
    // started by what started it for the policies (run-policy.mjs runTrigger()).
    if (!item.autoPickup && followsPick(task, key, item.repo)) {
      Object.assign(item, { autoPickup: true, followsPick: true });
    }
    // A comment that waited (resume()) has its 👀 already.
    if (!item.eyes) ctx.received(item);
    // When it was queued: the run order's, for a task nobody placed (queueOrder()).
    item.queuedAt ??= Date.now();
    item.queueId ??= queueId();
    task.pending.push(item);
    // In the store at once (restart.mjs): a listener killed during its pause doesn't lose it.
    ctx.saveQueue?.();
    if (task.running) {
      const live = deliverable(task) === task.pending.length;
      log(
        `${key}: ${live ? "for the running session" : "queued after the running one"} (${item.mode})`,
      );
      if (live) deliverLater(task);
    } else {
      log(`${key}: queued (${item.mode}, ${item.kind} ${item.number}, reply on #${item.replyTo})`);
      startLater(task);
    }
    return item.mode;
  }

  // A run apart from work (modes.mjs `volumes`) is what the task's next run will be: it goes
  // first, after a shorter pause.
  function talking(task) {
    return isApart(task.pending.at(-1)?.mode);
  }

  function debounce(task) {
    return talking(task) ? config.brainstormDebounceMs : config.debounceMs;
  }

  // How many of the pending comments, from the first, the running session can take: those in
  // its own mode. A wrap-up or a switch between work and brainstorm needs its own prompt, so it
  // and everything after it (order is kept) wait for the next run. So does every inbox entry.
  function deliverable(task) {
    const live = task.live;
    if (!live?.open || live.mode === "stop" || entryRun(live.mode)) return 0;
    // An agent that takes no messages mid-run gets them in its next run.
    if (!agentFor(live.record.agent).takesMessages) return 0;
    const n = task.pending.findIndex((i) => i.mode !== live.mode);
    return n < 0 ? task.pending.length : n;
  }

  // Sends the comments the running session can take as one message; false when none went.
  function deliver(task) {
    if (ctx.stopping) return false; // what waits is saved for the next listener
    const live = task.live;
    const items = task.pending.splice(0, deliverable(task));
    if (!items.length) return false;
    const options = {};
    const text = commentsText(items, options);
    // The process is already running with its model and effort: they are for the next run.
    Object.assign(task.next, options);
    Object.assign(live.later, options);
    live.replyTo = items.at(-1).replyTo;
    live.handled.push(...items);
    log(`${live.key}: delivered ${items.length} comment(s) to the running session`);
    live.record.delivered = (live.record.delivered ?? 0) + items.length;
    // Only "/model …" lines: nothing to tell the agent.
    if (!text) {
      taken(task, items);
      return false;
    }
    ctx.runner.send(live.id, liveMessage(live.mode, text), agentFor(live.record.agent));
    writeEvent(live.logFile, "delivered", { message: text });
    live.unanswered.push(...items);
    taken(task, items);
    return true;
  }

  // Comments a run took: in its saved state first, then out of the saved queue (restart.mjs
  // take()). A listener killed between the two finds them in both, and leaves them to the run
  // (loadQueue()); the other way round, it would lose them.
  function taken(task, items) {
    return ctx.take ? ctx.take(task, items) : ctx.saveLive(task);
  }

  // When a pause that starts now ends: its deadline, saved with the queue (restart.mjs), so
  // the next listener keeps to it rather than starting it again.
  const pauseEnd = (task) => Date.now() + debounce(task);
  const until = (dueAt) => Math.max(0, dueAt - Date.now());

  // Sends the comments to the running session after the usual pause, or at `dueAt`.
  function deliverLater(task, dueAt = pauseEnd(task)) {
    clearTimeout(task.timer);
    task.dueAt = dueAt;
    task.timer = setTimeout(() => deliver(task), until(dueAt));
    ctx.saveQueue?.();
  }

  // Starts the task's next run after the usual pause, so a burst of comments is one run; or at
  // `dueAt`, a pause a previous listener began.
  function startLater(task, dueAt = pauseEnd(task)) {
    clearTimeout(task.timer);
    task.ready = false;
    task.dueAt = dueAt;
    task.timer = setTimeout(() => {
      task.ready = true;
      schedule();
    }, until(dueAt));
    ctx.saveQueue?.();
  }

  // The tasks with comments waiting for a run of their own, in the order they start when
  // slots free: brainstorms first (someone is waiting for the reply, work runs take minutes
  // anyway), then those the maintainer placed (order.mjs), then the others by when their first
  // comment was queued. Ready or still in their pause.
  function queueOrder() {
    const ranks = ctx.order?.ranks() ?? new Map();
    const rank = (t) => ranks.get(taskId(taskKey(t.repo, t.id))) ?? Infinity;
    const since = (t) => t.pending[0].queuedAt ?? 0;
    return [...tasks.values()]
      .filter((t) => !t.running && t.pending.length)
      .sort(
        (a, b) =>
          Number(talking(b)) - Number(talking(a)) || rank(a) - rank(b) || since(a) - since(b),
      );
  }

  function schedule() {
    if (ctx.stopping) return;
    const queued = queueOrder();
    // What was dropped meanwhile leaves the order (runs.mjs drops a run's as it starts). Not a
    // task whose run() is still reading its settings: `running`, its comments not taken yet.
    const waiting = [...tasks.values()].filter((t) => t.pending.length && !t.live);
    ctx.order?.keep(waiting.map((t) => taskKey(t.repo, t.id)));
    const ready = queued.filter((t) => t.ready);
    const perRepo = new Map();
    let auto = 0;
    for (const t of tasks.values()) {
      if (!t.running) continue;
      perRepo.set(t.repo, (perRepo.get(t.repo) ?? 0) + 1);
      if (pickedTask(t)) auto++;
    }
    const reserved = {
      reserved: config.autoPickupSlots ?? 0,
      auto,
      waiting: queued.filter(pickedTask),
      picked: pickedTask,
    };
    for (const task of startable(ready, perRepo, ctx.running, config.maxParallel, reserved)) {
      ctx.run(task);
    }
  }

  // How many of AUTO_PICKUP_SLOTS are taken: auto-picked tasks running, queued with room in
  // their repo's max_parallel, or between two steps of their review loop (loopGoing()). One
  // its repo holds back leaves the sweep free to pick an issue of another repo, which can
  // start now.
  function pickedCount() {
    const list = [...tasks.values()];
    const runningIn = (repo) => list.filter((t) => t.running && t.repo === repo).length;
    // A repo without a cap of its own below MAX_PARALLEL holds nothing back: every slot is
    // busy then, and the task waits for the next one as any other.
    const room = (t) => {
      const cap = t.settings?.maxParallel ?? config.maxParallel;
      return cap >= config.maxParallel || runningIn(t.repo) < cap;
    };
    const holds = (t) => pickedTask(t) && (t.running || (t.pending.length && room(t)));
    const counted = list.filter(
      (t) => holds(t) || loopGoing(taskKey(t.repo, t.id), t.repo, t),
    ).length;
    // A task between two loop steps isn't in `tasks` after a restart (restart.mjs saves those
    // with something queued or running): its pull request, kept in pulls.json, finds it.
    const known = (key) => list.some((t) => sameTask(taskKey(t.repo, t.id), key));
    const between = (ctx.pulls?.keys?.() ?? []).filter((key) => {
      const pr = ctx.pulls.get(key);
      if (pr?.state !== "draft" && pr?.state !== "ready") return false;
      const repo = parseKey(key)?.repo;
      return !!repo && !known(key) && loopGoing(key, repo);
    });
    return counted + between.length;
  }

  // How many of `repo`'s tasks are running or queued: what its max_parallel is held against
  // before the sweep picks one of its issues (auto-pickup.mjs).
  function repoLoad(repo) {
    const name = repo.toLowerCase();
    return [...tasks.values()].filter(
      (t) => t.repo.toLowerCase() === name && (t.running || t.pending.length),
    ).length;
  }

  return {
    admit,
    accept,
    resume,
    deliverable,
    deliver,
    deliverLater,
    startLater,
    schedule,
    queueOrder,
    pickedCount,
    repoLoad,
  };
}
