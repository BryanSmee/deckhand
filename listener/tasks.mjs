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
  takeOptions,
  taskKey,
  workItem,
} from "./events.mjs";
import { getJson } from "./github.mjs";
import { customMode, entryRun, isLight } from "./modes.mjs";
import { liveMessage } from "./prompts.mjs";
import { hasOpenQuestions, stillAsks } from "./questions.mjs";
import {
  CONFIG_FILE,
  effectiveConfig,
  modeNames,
  startable,
  taskSandboxName,
} from "./repo-config.mjs";
import { writeEvent } from "./runlog.mjs";
import { sameTask } from "./spelling.mjs";
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

// `ctx` (server.mjs): the listener's state and services, read at call time. Tasks are
// `ctx.tasks`: key → { repo, id, kind, number, base, name, settings, pending: [], running,
// ready, timer, live, next }; live: the running sandbox's (runs.mjs), next: "/model" and
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

  // A comment that passed the operator's checks, checked again with its repo's settings
  // (users, trigger lines), then queued.
  async function admit(first, event, payload) {
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
    if (!item.after && (item.trigger === "work" || item.modeLine)) {
      ctx.waits.cancel(taskKey(item.repo, item.id));
    }
    await accept(item);
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

  // Whether the repo's `wait_for_answers` holds `item` back: work, or a mode of the repo's that
  // isn't light, on an issue (`issue`: as GitHub has it) that carries NEEDS_INPUT_LABEL for its
  // own open questions, not all answered by their ticked boxes. Brainstorms and light modes
  // still run: they can help answer. A run that stopped to ask isn't held either: any comment
  // continues it.
  function unanswered(item, issue) {
    if (!item.settings?.waitForAnswers || !config.needsInputLabel || !issue) return false;
    if (item.kind !== "issue" || item.replyTo !== item.number) return false;
    const mode = item.modeLine ?? (item.trigger === "work" ? "work" : null);
    const own = customMode(item.settings, mode);
    if (mode !== "work" && (!own || own.light)) return false;
    if (!hasLabel(issue.labels, config.needsInputLabel)) return false;
    // Ticks in the bot's issue (an inbox run's), or that the bot's edit added, are its own
    // until a person's edit takes the label off (questions.mjs editedInput()).
    const key = taskKey(item.repo, item.id);
    const bot = issue.user?.type === "Bot" || !!ctx.inputs?.botTicked?.(key);
    if (!(bot ? hasOpenQuestions(issue.body) : stillAsks(issue.body))) return false;
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
    await accept({ ...item, settings });
    return true;
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

  async function accept(item) {
    // Its default branch, as GitHub said: "main" when it didn't.
    item.base ||= "main";
    const name = await containerName(item.repo, item.id);
    const key = taskKey(item.repo, item.id);
    item.mode = await modeOf(item, key, name);
    if (!item.mode) return;
    ctx.titles.set(key, item.title);
    let task = tasks.get(key);
    if (!task) {
      task = newTask({ ...item, name });
      tasks.set(key, task);
    }
    // The latest settings decide the repo's parallel cap.
    if (item.settings) task.settings = item.settings;
    // A comment that waited (resume()) has its 👀 already.
    if (!item.eyes) ctx.received(item);
    task.pending.push(item);
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
  }

  // A light run is what the task's next run will be: it goes first, after a shorter pause.
  function talking(task) {
    return isLight(task, task.pending.at(-1)?.mode);
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
      ctx.saveLive(task);
      return false;
    }
    ctx.runner.send(live.id, liveMessage(live.mode, text), agentFor(live.record.agent));
    writeEvent(live.logFile, "delivered", { message: text });
    live.unanswered.push(...items);
    ctx.saveLive(task);
    return true;
  }

  // Sends the comments to the running session after the usual pause.
  function deliverLater(task) {
    clearTimeout(task.timer);
    task.timer = setTimeout(() => deliver(task), debounce(task));
  }

  // Starts the task's next run after the usual pause, so a burst of comments is one run.
  function startLater(task) {
    clearTimeout(task.timer);
    task.ready = false;
    task.timer = setTimeout(() => {
      task.ready = true;
      schedule();
    }, debounce(task));
  }

  function schedule() {
    if (ctx.stopping) return;
    // Brainstorms first: someone is waiting for the reply, work runs take minutes anyway.
    const ready = [...tasks.values()]
      .filter((t) => t.ready && !t.running && t.pending.length)
      .sort((a, b) => Number(talking(b)) - Number(talking(a)));
    const perRepo = new Map();
    for (const t of tasks.values()) {
      if (t.running) perRepo.set(t.repo, (perRepo.get(t.repo) ?? 0) + 1);
    }
    for (const task of startable(ready, perRepo, ctx.running, config.maxParallel)) ctx.run(task);
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
  };
}
