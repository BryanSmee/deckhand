// Which mode a queued comment runs in (tasks.mjs accept()): a trigger line, a "/mode" line, or
// the issue's current mode, its brainstorm or its work session. Keeps the issue's brainstorm
// (brainstorms.json) and repo mode (modes.json) up to date, and replies when a mode can't run.
import { researchRefusal } from "./access.mjs";
import { AGENTS } from "./agents/index.mjs";
import { taskKey } from "./events.mjs";
import { customMode, INBOX, sessionName } from "./modes.mjs";
import { CONFIG_FILE, modeNames } from "./repo-config.mjs";

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createTaskModes(ctx) {
  const { log, skip, tasks } = ctx;

  // What a comment asks for: "work", "brainstorm", "stop" (wrap a brainstorm up) or one of the
  // repo's own modes (its config's `modes:`); null when it doesn't reach Claude. A "/mode"
  // line picks the mode, with or without a trigger line; without either, a comment goes on in
  // the issue's current mode. Keeps the issue's brainstorm and mode state up to date.
  async function modeOf(item, key, name) {
    // The inbox issue or the discussion category is the trigger (workItem()), the dashboard's
    // Analyze (work.mjs analyze()), which no comment can ask for, or a pull request turning
    // ready (reviews.mjs).
    if (INBOX.has(item.trigger) || ["analyze", "review"].includes(item.trigger)) {
      return item.trigger;
    }
    if (item.trigger === "stop") return stopBrainstorm(item, key);
    let wanted = item.trigger;
    if (item.modeLine) {
      if (!(await switchable(item, key, name))) return null;
      wanted = item.modeLine;
    }
    // A comment without either goes on in the repo's own mode the issue is in, if any.
    const current = ctx.issueModes.get(key);
    if (!wanted && current && !talks(item, key)) return goOn(item, key, current);
    if (wanted === "onboarding") return startOnboarding(item, key);
    if (wanted === "research") return startResearch(item, key);
    if (wanted === "review") return startReview(item);
    if (wanted === "policy") return policyDryRun(item);
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
    // Without a trigger line, a comment only continues work the agent already started (a
    // brainstorm's session is not work's: sessionName()).
    if (!item.trigger && !(await hasSession(key, name, false))) {
      return skip(`#${item.replyTo} has no agent session and no trigger line`);
    }
    return "work";
  }

  // That of its work runs or of its light ones (either when `light` is undefined), of any
  // agent: the repo may have picked another since.
  async function hasSession(key, name, light) {
    if (tasks.has(key)) return true;
    const kinds = light === undefined ? [false, true] : [light];
    for (const l of kinds) {
      for (const agent of Object.values(AGENTS)) {
        if (await ctx.runner.hasSession(sessionName(name, l), agent)) return true;
      }
    }
    return false;
  }

  function onIssue(item) {
    return item.replyTo === item.number;
  }

  // A comment on a pull request: its own task, or the issue's it closes (events.mjs linkTo()).
  function onPull(item) {
    return item.kind === "pr" || (item.kind === "issue" && !onIssue(item));
  }

  // A comment on the issue of a brainstorm that goes on.
  function talks(item, key) {
    const b = ctx.brainstorms.get(key);
    return b && onIssue(item) && b.status !== "stopped";
  }

  // A "/mode" line: a mode the repo has. Without a trigger line, a switch: the conversation so
  // far carries over, so there must be one. Onboarding and research start their own.
  async function switchable(item, key, name) {
    if (!modeNames(item.settings).includes(item.modeLine)) {
      await unknownMode(item, `Unknown mode \`${item.modeLine}\`.`);
      return false;
    }
    if (item.trigger || ["onboarding", "research", "review", "policy"].includes(item.modeLine)) {
      return true;
    }
    if (ctx.brainstorms.get(key) || ctx.issueModes.has(key)) return true;
    if (await hasSession(key, name)) return true;
    skip(`#${item.replyTo} has no agent session and no trigger line`);
    return false;
  }

  // The issue's current mode, if it is still there.
  async function goOn(item, key, current) {
    if (current === "research") return startResearch(item, key);
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

  // Research (modes.mjs OPEN), only with the operator's grant: without it, a reply that names
  // it and no run. Kept in modes.json like the repo's modes: comments go on in it.
  async function startResearch(item, key) {
    const refused = researchRefusal(ctx.config, item.repo);
    if (refused) {
      const where = taskKey(item.repo, item.id);
      log(`${where}: research refused: ${refused}`);
      if (ctx.issueModes.get(key) === "research") ctx.issueModes.set(key, null);
      const text = `Research can't run here: ${refused}.`;
      await ctx.reply(item.repo, item.replyTo, text).catch((error) => log(`${where}: ${error}`));
      return null;
    }
    ctx.brainstorms.end(key);
    ctx.issueModes.set(key, "research");
    return "research";
  }

  // A review reads a pull request's diff: on an issue, a reply says where to ask. It runs once
  // on a session of its own (fresh): the issue stays in the mode it was in.
  async function startReview(item) {
    if (onPull(item)) return "review";
    const where = taskKey(item.repo, item.id);
    log(`${where}: review refused: not a pull request`);
    const text =
      "A review is of a pull request: comment `/mode review` on the pull request itself.";
    await ctx.reply(item.repo, item.replyTo, text).catch((error) => log(`${where}: ${error}`));
    return null;
  }

  // `/mode policy`: the policies evaluated on the pull request now, as a reply (reviews.mjs
  // dryRun()), kept on the task's page: who asked, the denials, the reply's link. No run,
  // nothing reviewed, fixed or merged; on an issue, a reply says where.
  async function policyDryRun(item) {
    const where = taskKey(item.repo, item.id);
    let text;
    let denials = null;
    if (!onPull(item)) {
      log(`${where}: policy dry run refused: not a pull request`);
      text =
        "A policy dry run is of a pull request: comment `/mode policy` on the pull request itself.";
    } else {
      try {
        log(`${where}: policy dry run on #${item.replyTo}`);
        const { repo, base, replyTo: number } = item;
        ({ text, denials } = await ctx.reviews.dryRun({ repo, base, number }));
      } catch (error) {
        log(`${where}: policy dry run: ${error.stack ?? error}`);
        text = `The policy dry run failed: GitHub couldn't be read (${error.message ?? error}).`;
      }
    }
    const res = await ctx.reply(item.repo, item.replyTo, text).catch((error) => {
      log(`${where}: ${error}`);
      return null;
    });
    if (denials === null) return null;
    // The reply's link, if GitHub said it: the dry run is kept without one.
    const url = (await res?.json?.().catch(() => null))?.html_url ?? null;
    try {
      ctx.decisions?.recordDryRun(where, { by: item.author ?? null, url, denials });
    } catch (error) {
      log(`${where}: keeping its dry run: ${error.message ?? error}`);
    }
    return null;
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
    const note = (m) =>
      own[m]?.light
        ? " (comments only)"
        : m === "research" && researchRefusal(ctx.config, item.repo)
          ? " (not granted here)"
          : "";
    const list = modeNames(item.settings)
      .map((m) => `\`${m}\`${note(m)}`)
      .join(", ");
    const where = taskKey(item.repo, item.id);
    log(`${where}: ${what}`);
    const text = `${what} The modes here: ${list}. Pick one with a \`/mode <name>\` line.`;
    await ctx.reply(item.repo, item.replyTo, text).catch((error) => log(`${where}: ${error}`));
  }

  return { modeOf, unknownMode };
}
