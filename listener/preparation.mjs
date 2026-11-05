// Everything a run needs before its sandbox starts (runs.mjs start()): its capabilities
// (capabilities.mjs), then what they give: the branches it may push, its mode's instructions,
// what it may reach (access.mjs), its image, agent and caches, its screenshots' folder, the
// egress cache, and an analysis's digest or a research run's thread. What fails stops the run
// with a reply (RunError).
import { randomBytes } from "node:crypto";
import {
  bareAccess,
  cantRun,
  egressCache,
  engineFor,
  grantedAccess,
  grantsRefusal,
  RunError,
  runnerRefusal,
} from "./access.mjs";
import { agentFor } from "./agents/index.mjs";
import { capabilitiesInput, listed, outcomeOf } from "./capabilities.mjs";
import { mandatoryHosts, operatorHosts } from "./egress.mjs";
import { headInRepo } from "./events.mjs";
import { getJson, paginate } from "./github.mjs";
import { grantCheck, grantsBy } from "./grants.mjs";
import { imageRef } from "./images.mjs";
import { handoffMessage } from "./prompts.mjs";
import { reviewThread } from "./reviews.mjs";
import { ceilingOf, leftOut, narrowProfile } from "./profiles.mjs";
import { personStarted, runTrigger } from "./run-policy.mjs";
import { buildOutput, enterPhase } from "./runlog.mjs";
import { operatorSecrets, redact } from "./secrets.mjs";
import { isChat } from "./tasks.mjs";

// What a research run reads of its issue: the last comments, each clipped.
const THREAD_COMMENTS = 50;
const THREAD_TEXT = 20_000;

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createPreparation(ctx) {
  const { config, log } = ctx;

  // The run's agent (agents/), by the name its record keeps across a restart.
  const agentOf = (task) => agentFor(task.live.record.agent);

  // Its capabilities (capabilities.mjs), then what they give: the branches it may push, the
  // mode's instructions, what it may reach (access.mjs), its image and caches, its screenshots'
  // folder and the egress cache. A run without `pull` gets nothing of the repo's
  // (prepareBare()).
  // `run`: runs.mjs begin()'s, whose reopen() makes its first message again when the session
  // volume its capabilities give it isn't its mode's.
  async function prepareRun(task, items, run, note) {
    const { live } = task;
    const { settings, own } = run;
    const agent = agentOf(task);
    const { pulls, unread } = await pullRequests(task, items);
    // One that couldn't be looked up may be a fork's: counted as one.
    const fork = !!unread || [...pulls.values()].some((pr) => !headInRepo(pr, task.repo));
    const { caps, profile } = await capabilitiesOf(task, items, settings, fork, note, unread);
    // Its volume (sandbox-spec.mjs sessionOf()) depends on whether it is a fork's: known before
    // reopen() looks in it. A run without `pull` isn't one (prepareBare()).
    live.fork = caps.has("pull") && fork;
    const { handoff, message } = { ...run, ...((await run.reopen?.(note)) ?? {}) };
    // A run that pushes needs them all: its branches are their heads.
    if (unread && caps.has("push")) throw unread;
    if (!caps.has("pull"))
      return prepareBare(task, caps, { settings, own, handoff, message }, note);
    const branches = caps.has("push") ? pushBranches(task, pulls) : [];
    live.handoff = !!handoff;
    live.branches = branches;
    // A fork's code may run in it: a clone of its own (sandbox-spec.mjs: `-fork`, a light run's
    // too, so the issue's later light runs, which may get caches or an engine, never start in
    // it), and nothing it can leave for the repo's later runs, which trust what they find
    // (prepareImage(), access.mjs). The broker gets the same: it may read the fork's code,
    // whatever it may push (github-forks.mjs restricted()), after a restart too.
    live.fork = fork;
    ctx.broker.allow(live.id, live.branches, fork);
    // A review's are optional (its `review` block); a repo's mode always has them.
    const instructions = own?.instructions ? await modeInstructions(task, own) : null;
    const access = await grantedAccess(config, task, settings, {
      agent,
      note,
      log,
      granted: grantsBy(ctx.policies),
      kept: profile?.mounts ?? null,
    });
    if (profile) narrowHosts(access, profile, agent);
    // The open internet: any public host, private addresses only for those every run needs
    // (access.mjs bareAccess() says why).
    if (caps.has("internet")) {
      Object.assign(access, openHosts(agent));
      // And no host mount: what the operator mounts may be private, whatever the repository is,
      // and the open internet would be its way out (as for research runs, bareAccess()).
      if (access.mounts?.length) {
        note(
          `No host mounts: this run reaches the open internet (${access.mounts.map((m) => m.target).join(", ")} left out)`,
        );
        access.mounts = [];
      }
    }
    // Never where a fork's code may run, whether the run pushes or not.
    const engine = caps.has("docker")
      ? engineFor(config, task, settings, access, fork, note, caps.has("internet"))
      : null;
    const refused = runnerRefusal(config, settings, access, engine, caps);
    if (refused) throw new RunError(`${cantRun(agent)}: ${refused}`);
    const prepared = await prepareImage(task, items, settings, access, note, { pulls, caps, fork });
    live.shots = shotsFolder();
    live.record.shots = live.shots;
    live.hosts = access.hosts;
    live.trusted = access.trusted;
    // Whether the proxy's engines' port is this run's (egress-http.mjs taskWhere()).
    live.engine = !!engine;
    live.uncached = mandatoryHosts(config, agent);
    // Its GitHub calls are relayed through the proxy: it trusts the CA.
    const { ca, cached } = await egressCache(access.grant, ctx.egressCa, note, agent, config, true);
    live.cached = cached;
    const digest = live.mode === "review" ? await reviewDigest(task, settings, note) : undefined;
    // Its issue's branch (linked-branch.mjs), last: once nothing above can stop the run, so a
    // failed preparation leaves no branch behind. Created and linked now when the issue has
    // none, or its one branch already: the sandbox checks it out (TASK_BRANCH, draft-pr.sh).
    // Null: the sandbox names and creates it, unlinked.
    live.linkedBranch =
      live.cancelled || !caps.has("push")
        ? null
        : ((await ctx.linkedBranches?.link(task, note)) ?? null);
    return {
      // Another agent takes over: the branches are part of what it is handed.
      message: handoff ? handoffMessage({ ...handoff, branches }) : message,
      instructions,
      access,
      engine,
      prepared,
      ca,
      digest,
    };
  }

  // What the run gets (capabilities.mjs outcomeOf()), decided by the policies on its repo's
  // default branch, with its config and the operator's grant: kept on its live state (saved
  // with it) and in its tokens (broker.mjs grant()), and said in its log. A broken dependency,
  // a risky combination the operator doesn't allow or a policy error stops it with a reply.
  // `fork`: whether a fork's pull request's comments started it. → the names, a Set.
  // `unread`: the error of a pull request that couldn't be looked up, which `fork` counts as a
  // fork's: the run is refused with it when, not a fork's, it would push (a policy that denies
  // forks `push` would otherwise turn a maintainer's run into a read-only one, unsaid).
  // A chat's permissions profile (profiles.mjs) narrows them, within what they give now: a grant
  // or a policy gone since it was saved narrows it silently. → { caps: the names, a Set;
  // profile: a chat's, as narrowProfile() makes it, null for any other run }.
  async function capabilitiesOf(task, items, settings, fork, note, unread = null) {
    const { live } = task;
    const agent = agentOf(task);
    const last = items.at(-1) ?? {};
    const repo = { name: task.repo, private: await isPrivate(task.repo) };
    const input = capabilitiesInput({
      repo,
      mode: live.mode,
      issue: task.number,
      reason: last.reason,
      fork,
      // As the run input says it (`deny_run`'s), the comment's command apart.
      trigger: personStarted(last) ? runTrigger(last) : null,
      command: last.trigger ?? null,
    });
    // Asked once with the run as a fork's and not, when it might not be one.
    const inputs = { run: input, ...(unread && fork && { unforked: { ...input, fork: false } }) };
    const said = ctx.policies
      ? await ctx.policies.capabilityRules(task.repo, task.base, inputs)
      : { error: "no policies to decide them" };
    if (said.error) {
      throw new RunError(
        `${cantRun(agent)}: its capabilities couldn't be decided (${said.error}). The repository's config page on the dashboard shows the policies' errors.`,
      );
    }
    // Grants that can't be read stop the run as they always did, before what they gate.
    const check = await grantCheck(config, task.repo, settings, {
      granted: grantsBy(ctx.policies),
    });
    if (check.error) {
      log(`${task.repo}: ${check.error.message}`);
      throw new RunError(`${cantRun(agent)}: ${grantsRefusal(check)}.`);
    }
    const outcomeFor = (key) =>
      outcomeOf({
        rules: said.results[key],
        custom: input.custom_mode,
        settings,
        grant: check.grant,
        repo,
        mode: live.mode,
      });
    if (inputs.unforked && outcomeFor("unforked").used.includes("push")) throw unread;
    const outcome = outcomeFor("run");
    for (const warning of outcome.warnings) note(`Capabilities: ${warning}`);
    if (outcome.errors.length) {
      throw new RunError(
        `${cantRun(agent)}: the capabilities its policies give a \`${live.mode}\` run don't hold.\n\n${outcome.errors.map((e) => `- ${e}`).join("\n")}\n\nThe repository's config page on the dashboard shows what each mode gets, and the file that decided it (see Deckhand's docs/repo-config.md#capabilities).`,
      );
    }
    let used = outcome.used;
    let profile = null;
    if (isChat(task)) {
      const ceiling = ceilingOf({ outcome, grant: check.grant, mounts: check.mounts.mounts });
      profile = narrowProfile(ctx.chats?.profileOf(task) ?? null, ceiling);
      used = used.filter((name) => profile.capabilities.includes(name));
      const out = leftOut(profile, ceiling);
      if (out) note(`Permissions profile: leaves out ${out}`);
    }
    live.capabilities = used;
    // On its record too: saved with its summary, so an analysis knows it had the open internet.
    if (live.record) live.record.capabilities = used;
    ctx.broker.grant(live.id, used);
    note(`Capabilities: ${listed(used)}`);
    return { caps: new Set(used), profile };
  }

  // A chat's hosts, as its profile keeps them (narrowProfile()): the granted hosts it turned
  // off are no longer reachable (the egress proxy reads `live.hosts`), but the ones every run
  // needs. Its mounts are narrowed by grantedAccess() (`kept`). `access`: grantedAccess()'s,
  // changed in place.
  function narrowHosts(access, profile, agent) {
    const hosts = access.grant.hosts.filter((h) => profile.hosts.includes(h.toLowerCase()));
    access.hosts = operatorHosts(config, { ...access.grant, hosts }, agent);
    access.trusted = operatorHosts(config, { ...access.grant, hosts }, agent);
  }

  // Whether GitHub says `repo` is private: null when it can't say, which the risky combinations
  // take for private.
  async function isPrivate(repo) {
    const info = await getJson(ctx.github, repo, `/repos/${repo}`).catch(() => null);
    return typeof info?.private === "boolean" ? info.private : null;
  }

  // What a run with the open internet reaches: any public host, and private addresses only for
  // the hosts every run needs (mandatoryHosts()): an internal host next to the open internet
  // would be a way out for what it serves.
  const openHosts = (agent) => ({ hosts: ["*"], trusted: mandatoryHosts(config, agent) });

  // A review's thread (reviews.mjs reviewThread()): only what allowed users and the App
  // wrote, redacted like any output. Not read: no review, rather than one on the whole thread.
  async function reviewDigest(task, settings, note) {
    const { repo } = task;
    const number = task.live.replyTo;
    let text;
    try {
      text = await reviewThread({ github: ctx.github, config, settings }, repo, number);
    } catch (error) {
      throw new RunError(
        `${cantRun(agentOf(task))}: #${number}'s thread couldn't be read (${error.message ?? error}). Comment again to retry.`,
      );
    }
    note(`Thread: #${number}, allowed users' and Deckhand's comments only`);
    return redact(text, operatorSecrets(ctx));
  }

  // A run without `pull` (a research run): nothing of the repo's (access.mjs bareAccess()):
  // the base image, no branches, caches, engine, CA or screenshots, and any public host only
  // with `internet`. Its input is the issue's thread (threadDigest()): it has no token to read
  // it with.
  async function prepareBare(task, caps, { settings, own, handoff, message }, note) {
    const { live } = task;
    const agent = agentOf(task);
    live.handoff = !!handoff;
    live.branches = [];
    // The listener reads them: the sandbox has no clone to read them from.
    const instructions = own?.instructions ? await modeInstructions(task, own) : null;
    live.fork = false;
    const access = await bareAccess(config, task, {
      agent,
      log,
      internet: caps.has("internet"),
      granted: grantsBy(ctx.policies),
    });
    note(
      caps.has("internet")
        ? "Research: any public host, without the repository's code, image or a GitHub token"
        : "Without the repository's code, image or a GitHub token",
    );
    try {
      await ctx.images.installAgent(agent, (chunk) => live.logFile.write(chunk));
    } catch (error) {
      throw new RunError(
        `${agent.displayName} couldn't start: ${error.message}\n\nThe run's log on the dashboard has the details.`,
      );
    }
    live.shots = null;
    live.record.shots = null;
    live.hosts = access.hosts;
    live.trusted = access.trusted;
    live.engine = false;
    live.uncached = mandatoryHosts(config, agent);
    live.cached = [];
    // No cached hosts, but the CA an agent whose calls are relayed needs.
    const { ca } = await egressCache(access.grant, ctx.egressCa, note, agent, config);
    return {
      message: handoff ? handoffMessage({ ...handoff, branches: [] }) : message,
      instructions,
      access,
      engine: null,
      prepared: { image: config.image, caches: [], settings },
      ca,
      digest: await bareDigest(task, settings, note),
    };
  }

  // A run without `pull`'s input: its issue's thread; an analysis's, its runs' digest (runs.mjs
  // analysisDigest()). A review or a discussion without `pull` doesn't start (capabilities.mjs
  // NEED_PULL); were one to, a review would read only what allowed users and Deckhand wrote.
  async function bareDigest(task, settings, note) {
    if (task.live.mode === "analyze") return undefined;
    if (task.live.mode === "review") return reviewDigest(task, settings, note);
    return threadDigest(task, note);
  }

  // The issue's (or pull request's) title, description and last comments, as a research run
  // reads them (TASK_DIGEST), redacted like any output.
  async function threadDigest(task, note) {
    const { repo, number } = task;
    const get = (path) => ctx.github(repo, "GET", path);
    let issue, comments;
    try {
      issue = await getJson(ctx.github, repo, `/repos/${repo}/issues/${number}`);
      comments = await paginate(get, `/repos/${repo}/issues/${number}/comments`);
    } catch (error) {
      throw new RunError(
        `${cantRun(agentOf(task))}: #${number} couldn't be read (${error.message ?? error}). Comment again to retry.`,
      );
    }
    const clip = (text) =>
      !text ? "(empty)" : text.length > THREAD_TEXT ? `${text.slice(0, THREAD_TEXT)}…` : text;
    const kept = comments.slice(-THREAD_COMMENTS);
    const when = (at) => `${String(at).slice(0, 16).replace("T", " ")} UTC`;
    const parts = [
      `# ${issue.title}`,
      `${repo}#${number}, opened by @${issue.user?.login ?? "?"} on ${when(issue.created_at)}`,
      clip(issue.body),
      `## Comments${comments.length > kept.length ? ` (the last ${kept.length} of ${comments.length})` : ""}`,
      ...kept.map((c) => `### @${c.user?.login ?? "?"}, ${when(c.created_at)}\n\n${clip(c.body)}`),
    ];
    if (!kept.length) parts.push("None.");
    note(`Thread: #${number}, ${kept.length} of ${comments.length} comment(s)`);
    return redact(parts.join("\n\n") + "\n", operatorSecrets(ctx));
  }

  // An analysis's digest (analysis.mjs), built now from the runs picked when it was asked
  // for: those of its repo still listed, redacted like any output. None left: no run. Only an
  // analysis asked for on a private repo, still private now, quotes what only the dashboard
  // showed (analysis.mjs runDigest()): older ones didn't say, and a repo made public while
  // the analysis waited would publish it. A lookup that fails counts as public.
  async function analysisDigest(task, items, note) {
    const asked = items.findLast((i) => i.analysis)?.analysis;
    if (!asked?.runs?.length) {
      throw new RunError(
        `${cantRun(agentOf(task))}: this analysis has no runs to read. Start one from the dashboard's Analyze.`,
      );
    }
    const isPrivate =
      asked.private === true &&
      (await getJson(ctx.github, task.repo, `/repos/${task.repo}`).catch(() => null))?.private ===
        true;
    const { text, included, left } = await ctx.analysis.digest(task.repo, asked.runs, asked, {
      isPublic: !isPrivate,
    });
    if (!included.length) {
      throw new RunError(
        `${cantRun(agentOf(task))}: the runs this analysis was to read are gone (their logs were removed).`,
      );
    }
    note(
      `Run digest: ${included.length} run(s), ${Math.round(Buffer.byteLength(text) / 1000)} KB${left.length ? `, ${left.length} left out` : ""}`,
    );
    return redact(text, operatorSecrets(ctx));
  }

  // Left over from a listener that lost track of it: wait for it, then make room.
  async function makeRoom(task) {
    const leftover = await ctx.runner.state(task.name);
    if (leftover === "running") await ctx.runner.wait(task.name);
    if (leftover) await ctx.runner.remove(task.name);
  }

  // A fresh, unguessable folder per run: its screenshots are public once linked on GitHub. The
  // broker keeps them (#609): nothing is made here.
  function shotsFolder() {
    return randomBytes(12).toString("hex");
  }

  // The instructions file of the repo's mode, from its default branch like the config.
  async function modeInstructions(task, own) {
    const { base } = task;
    const missing = `${cantRun(agentOf(task))}: the \`${own.name}\` mode's instructions, \`${own.instructions}\`, are not on \`${base}\`.`;
    let file;
    try {
      file = await ctx.repoFile(task.repo, own.instructions, base);
    } catch (error) {
      throw new RunError(`${missing}\n\n${error.message}`);
    }
    if (!file) throw new RunError(missing);
    return file.text;
  }

  // The run's image (built first if the repo's Dockerfile changed: `image:repo`, or
  // `image:branch` for its pull request's), its agent and the repo's cache volumes (`setup`).
  // While an image builds, the dashboard shows the run as "building image" (its `image` phase,
  // board.mjs runState()). `caps`: its capabilities; `fork`: whether a fork's pull request's
  // comments started it.
  async function prepareImage(task, items, settings, access, note, { pulls, caps, fork }) {
    const { grant } = access;
    const { logFile } = task.live;
    const { base } = task;
    const output = (chunk) => logFile.write(chunk);
    // By whole lines, each build step's first one timed (runlog.mjs buildOutput()).
    const build = buildOutput(logFile);
    try {
      const source = await imageSource(task, items, settings, grant, pulls);
      const own = caps.has(source.branch ? "image:branch" : "image:repo");
      const image = await ctx.images.imageFor({
        repo: task.repo,
        ref: source.ref,
        branch: source.branch,
        dockerfile: own ? settings.dockerfile : null,
        onBuild: (tag) => {
          enterPhase(task.live, "image");
          note(
            `Building ${tag} from ${settings.dockerfile} (${source.branch ? "pull request branch" : base})`,
          );
        },
        output: build.write,
        access: { hosts: access.hosts, trusted: access.trusted },
      });
      build.flush();
      // The sandbox's part of the setup comes after the image's build.
      enterPhase(task.live, "setup");
      if (image !== config.image)
        note(`Image ${image}${source.branch ? " (pull request branch)" : ""}`);
      await ctx.images.installAgent(agentOf(task), output);
      // A run without `setup` runs none: no caches, which work runs trust. Nor a run whose
      // comments came from a fork's pull request: its code would write into what every later
      // run uses; nor one that reaches the open internet, which a page may have it write there.
      // What the runner keeps (the runner service's GET /info, ../runner/client.mjs).
      const { keepsCaches, noCaches } = (await ctx.images.info?.()) ?? ctx.images;
      const setup = caps.has("setup");
      const internet = caps.has("internet");
      // Nor a chat's: its workspace is its own and kept, and the caches are the work runs'.
      const chat = isChat(task);
      if (chat && setup && settings.caches?.length)
        note("No caches: a chat keeps its own workspace");
      else if (fork && setup && settings.caches?.length)
        note("No caches: a pull request from a fork");
      else if (internet && setup && settings.caches?.length)
        note("No caches: this run reaches the open internet");
      else if (setup && settings.caches?.length && keepsCaches === false)
        note(`No caches: ${noCaches ?? `the ${config.runner} runner keeps none`}`);
      const caches =
        !setup || fork || internet || chat
          ? []
          : await ctx.images.caches(task.repo, settings.caches, image);
      return { image, caches, settings };
    } catch (error) {
      // What a failed build printed last (flushing again writes nothing).
      build.flush();
      throw new RunError(
        `${agentOf(task).displayName} couldn't start: ${error.message}\n\nThe run's log on the dashboard has the details.`,
      );
    }
  }

  // The pull requests its comments came from, but the task's own issue: { pulls: number → the
  // pull request, as GitHub has it, for whether one is a fork's, the branches it may push
  // (pushBranches()) and its image (imageSource()); unread: the RunError of the first that
  // couldn't be looked up, which stops a run that pushes, or null }.
  async function pullRequests(task, items) {
    const pulls = new Map();
    let unread = null;
    const numbers = new Set(items.map((i) => i.replyTo).filter(Number.isInteger));
    if (task.kind !== "pr") numbers.delete(task.number);
    for (const number of numbers) {
      try {
        pulls.set(
          number,
          await getJson(ctx.github, task.repo, `/repos/${task.repo}/pulls/${number}`),
        );
      } catch (error) {
        unread ??= new RunError(
          `${agentOf(task).displayName} couldn't start: pull request #${number} couldn't be looked up (${error.message ?? error}). Comment again to retry.`,
        );
      }
    }
    return { pulls, unread };
  }

  // The branches a run with `push` may push (git-gateway.mjs) and whose pull requests it may
  // mark ready (github-pulls.mjs): an issue's own, issue-<n>-* (draft-pr.sh names it from the
  // title, which may change), and the head of each pull request its comments came from
  // (`pulls`, pullRequests()'s), a maintainer's included, but not a fork's.
  function pushBranches(task, pulls) {
    const branches = task.kind === "issue" ? [`issue-${task.number}-*`] : [];
    for (const pr of pulls.values()) {
      const ref = pr.head?.ref;
      if (headInRepo(pr, task.repo) && ref && !branches.includes(ref)) branches.push(ref);
    }
    return branches;
  }

  // A comment on a pull request may run on the image of its own branch (imageRef()), with
  // `image:branch`. `pulls`: those pullRequests() looked up already.
  async function imageSource(task, items, settings, grant, pulls = new Map()) {
    const { base } = task;
    const pr = items.at(-1).replyTo;
    if (
      task.live.capabilities.includes("image:branch") &&
      grant.allowBranchDockerImages &&
      settings.dockerfile &&
      (task.kind === "pr" || pr !== task.number)
    ) {
      const found =
        pulls.get(pr) ??
        (await getJson(ctx.github, task.repo, `/repos/${task.repo}/pulls/${pr}`).catch(() => null));
      if (found) return imageRef(grant, settings, task.repo, base, found);
    }
    return { ref: base, branch: false };
  }

  return { prepareRun, analysisDigest, makeRoom };
}
