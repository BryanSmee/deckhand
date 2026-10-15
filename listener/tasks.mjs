// Tasks: one queue per issue, pull request or discussion, at most maxParallel containers.
// A comment that passed the checks is queued under its task's key ("org/repo#12"); after a
// pause (so a burst is one run) it starts a run, or goes to the running one (deliver()).
import { commentsText, workItem } from "./events.mjs";
import { INBOX, isLight, sessionName } from "./modes.mjs";
import { liveMessage } from "./prompts.mjs";
import {
  CONFIG_FILE,
  customMode,
  effectiveConfig,
  legacySandboxName,
  modeNames,
  sandboxName,
  startable,
} from "./repo-config.mjs";
import { configErrors } from "./runs.mjs";

// `ctx` (server.mjs): the listener's state and services, read at call time. Tasks are
// `ctx.tasks`: key → { repo, id, kind, number, base, name, settings, pending: [], running,
// ready, timer, live, next }; live: the running sandbox's (runs.mjs), next: "/model" and
// "/effort" for the next run.
export function createTasks(ctx) {
  const { config, log, skip, tasks } = ctx;

  // A task's sandbox name. Tasks with a session from before names had a hash keep their old
  // name, so they still find their volumes; the others get the new one.
  async function containerName(repo, id) {
    const key = `${repo}#${id}`;
    if (tasks.has(key)) return tasks.get(key).name;
    const legacy = legacySandboxName(config, repo, id);
    return (await ctx.runner.hasSession(legacy)) ? legacy : sandboxName(config, repo, id);
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
    const item = workItem(effectiveConfig(config, settings), event, payload, skip);
    if (!item) return;
    item.base = first.base;
    item.settings = settings;
    await accept(item);
  }

  // An onboarding issue for the repo, if it needs one, starting an onboarding run on it as a
  // "/mode onboarding" comment would. Resolves to the issue, or null (the reason logged).
  // `byHand`: started from the dashboard's repository list.
  async function onboardRepo(repo, sender, byHand = false) {
    const issue = await ctx.onboarding.open(repo, sender, byHand).catch((error) => {
      log(`  onboarding ${repo}: ${error.stack ?? error}`);
      return null;
    });
    if (!issue) return null;
    const { settings } = await ctx.repoSettings(repo, issue.base);
    await accept({
      repo,
      id: String(issue.number),
      kind: "issue",
      number: issue.number,
      title: issue.title,
      trigger: null,
      modeLine: "onboarding",
      text: "",
      replyTo: issue.number,
      comment: null,
      base: issue.base,
      settings,
    });
    return issue;
  }

  // An installation delivery: an onboarding issue per repo that needs one.
  async function onboard(repos, sender) {
    for (const repo of repos) await onboardRepo(repo, sender);
  }

  async function accept(item) {
    const name = await containerName(item.repo, item.id);
    const key = `${item.repo}#${item.id}`;
    item.mode = await modeOf(item, key, name);
    if (!item.mode) return;
    ctx.titles.set(key, item.title);
    let task = tasks.get(key);
    if (!task) {
      task = {
        ...item,
        name,
        pending: [],
        running: false,
        ready: false,
        timer: null,
        live: null,
        next: {},
      };
      tasks.set(key, task);
    }
    // The latest settings decide the repo's parallel cap.
    if (item.settings) task.settings = item.settings;
    ctx.received(item);
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

  // What a comment asks for: "work", "brainstorm", "stop" (wrap a brainstorm up) or one of the
  // repo's own modes (its config's `modes:`); null when it doesn't reach Claude. A "/mode"
  // line picks the mode, with or without a trigger line; without either, a comment goes on in
  // the issue's current mode. Keeps the issue's brainstorm and mode state up to date.
  async function modeOf(item, key, name) {
    // The inbox issue or the discussion category is the trigger (workItem()).
    if (INBOX.has(item.trigger)) return item.trigger;
    if (item.trigger === "stop") return stopBrainstorm(item, key);
    let wanted = item.trigger;
    if (item.modeLine) {
      if (!(await switchable(item, key, name))) return null;
      wanted = item.modeLine;
    }
    // A comment without either goes on in the repo's own mode the issue is in, if any.
    const current = ctx.issueModes.get(key);
    if (!wanted && current && !talks(item, key)) return goOn(item, current);
    if (wanted === "onboarding") return startOnboarding(item, key);
    const own = customMode(item.settings, wanted);
    if (wanted === "work" || (own && !own.fresh)) {
      // The work (or the repo's mode) takes over from the brainstorm. Light and work runs keep
      // separate sessions (sessionName()): work reads what was settled from the issue.
      ctx.brainstorms.end(key);
      ctx.issueModes.set(key, own ? wanted : null);
      return wanted;
    }
    // A fresh mode runs once on its own session: the issue stays in the mode it was in.
    if (own) return wanted;
    // A comment on the issue itself continues its brainstorm; one on its pull request is work.
    if (wanted === "brainstorm" || (!wanted && ctx.brainstorms.get(key) && onIssue(item))) {
      return brainstorm(item, key, wanted);
    }
    // Without a trigger line, a comment only continues work Claude already started (a
    // brainstorm's session is not work's: sessionName()).
    if (!item.trigger && !(await hasSession(key, name, false))) {
      return skip(`#${item.replyTo} has no Claude session and no trigger line`);
    }
    return "work";
  }

  // That of its work runs or of its light ones; either when `light` is undefined.
  async function hasSession(key, name, light) {
    if (tasks.has(key)) return true;
    const kinds = light === undefined ? [false, true] : [light];
    for (const l of kinds) if (await ctx.runner.hasSession(sessionName(name, l))) return true;
    return false;
  }

  function onIssue(item) {
    return item.replyTo === item.number;
  }

  // A comment on the issue of a brainstorm that goes on.
  function talks(item, key) {
    const b = ctx.brainstorms.get(key);
    return b && onIssue(item) && b.status !== "stopped";
  }

  // A "/mode" line: a mode the repo has. Without a trigger line, a switch: the conversation so
  // far carries over, so there must be one. Onboarding starts its own.
  async function switchable(item, key, name) {
    if (!modeNames(item.settings).includes(item.modeLine)) {
      await unknownMode(item, `Unknown mode \`${item.modeLine}\`.`);
      return false;
    }
    if (item.trigger || item.modeLine === "onboarding") return true;
    if (ctx.brainstorms.get(key) || ctx.issueModes.has(key)) return true;
    if (await hasSession(key, name)) return true;
    skip(`#${item.replyTo} has no Claude session and no trigger line`);
    return false;
  }

  // The issue's current mode, if it is still there.
  async function goOn(item, current) {
    if (current === "onboarding" || customMode(item.settings, current)) return current;
    // Gone from the config: don't guess what to run instead (work could push).
    await unknownMode(item, `The mode \`${current}\` is no longer in \`${CONFIG_FILE}\`.`);
    return null;
  }

  // Like a brainstorm, kept in modes.json: comments go on in it until the trigger line.
  function startOnboarding(item, key) {
    ctx.brainstorms.end(key);
    ctx.issueModes.set(key, "onboarding");
    // Its work run gets the onboarding prompt and the config check (finish()); no
    // automatic issue for the repo any more.
    const { onboarded } = ctx;
    if (!onboarded.isIssue(item.repo, item.number)) onboarded.record(item.repo, item.number);
    return "onboarding";
  }

  function brainstorm(item, key, wanted) {
    if (!wanted && ctx.brainstorms.get(key).status === "stopped") {
      return skip(`#${item.number}: brainstorm stopped and no trigger line`);
    }
    ctx.issueModes.set(key, null);
    item.restored = ctx.brainstorms.activate(key, item);
    return "brainstorm";
  }

  function stopBrainstorm(item, key) {
    const b = ctx.brainstorms.get(key);
    if (!b || b.status === "stopped") return skip(`#${item.number} has no brainstorm to stop`);
    ctx.brainstorms.stop(key);
    return "stop";
  }

  // The reply to a "/mode" Claude can't run: the modes there are. No run starts.
  async function unknownMode(item, what) {
    const own = item.settings?.modes ?? {};
    const list = modeNames(item.settings)
      .map((m) => `\`${m}\`${own[m]?.light ? " (comments only)" : ""}`)
      .join(", ");
    const where = `${item.repo}#${item.id}`;
    log(`${where}: ${what}`);
    const text = `${what} The modes here: ${list}. Pick one with a \`/mode <name>\` line.`;
    await ctx.reply(item.repo, item.replyTo, text).catch((error) => log(`${where}: ${error}`));
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
  // and everything after it (order is kept) wait for the next run.
  function deliverable(task) {
    const live = task.live;
    if (!live?.open || live.mode === "stop") return 0;
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
    // Only "/model …" lines: nothing to tell Claude.
    if (!text) {
      ctx.saveLive(task);
      return false;
    }
    ctx.runner.send(live.id, liveMessage(live.mode, text));
    const event = { type: "listener", event: "delivered", at: Date.now(), message: text };
    live.logFile.write(JSON.stringify(event) + "\n");
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
    onboardRepo,
    onboard,
    deliverable,
    deliver,
    deliverLater,
    startLater,
    schedule,
  };
}
