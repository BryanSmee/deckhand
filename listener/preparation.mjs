// Everything a run needs before its sandbox starts (runs.mjs start()): the branches it may
// push, its mode's instructions, what it may reach (access.mjs), its image, agent and caches,
// its screenshots' folder, the egress cache, and an analysis's digest. What fails stops the
// run with a reply (RunError).
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cantRun, egressCache, engineFor, grantedAccess, RunError } from "./access.mjs";
import { agentFor } from "./agents/index.mjs";
import { mandatoryHosts } from "./egress.mjs";
import { sameRepo } from "./events.mjs";
import { getJson } from "./github.mjs";
import { imageRef } from "./images.mjs";
import { handoffMessage } from "./prompts.mjs";
import { operatorSecrets, redact } from "./secrets.mjs";

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createPreparation(ctx) {
  const { config, log } = ctx;

  // The run's agent (agents/), by the name its record keeps across a restart.
  const agentOf = (task) => agentFor(task.live.record.agent);

  // The branches it may push, the mode's instructions, what it may reach (access.mjs), its
  // image and caches, its screenshots' folder and the egress cache.
  async function prepareRun(task, items, { settings, own, handoff, message }, note) {
    const { live } = task;
    const agent = agentOf(task);
    const { branches, fork, pulls } = await pushBranches(task, items);
    live.handoff = !!handoff;
    live.branches = branches;
    ctx.broker.allow(live.secret, live.branches);
    const instructions = own && (await modeInstructions(task, own));
    const access = grantedAccess(config, task, settings, { agent, note, log });
    const engine = engineFor(config, task, settings, access, fork, note);
    const prepared = await prepareImage(task, items, settings, access.grant, note, pulls);
    live.shots = shotsFolder();
    live.record.shots = live.shots;
    live.hosts = access.hosts;
    live.trusted = access.trusted;
    live.uncached = mandatoryHosts(config, agent);
    const { ca, cached } = await egressCache(access.grant, ctx.egressCa, note);
    live.cached = cached;
    return {
      // Another agent takes over: the branches are part of what it is handed.
      message: handoff ? handoffMessage({ ...handoff, branches }) : message,
      instructions,
      access,
      engine,
      prepared,
      ca,
    };
  }

  // An analysis's digest (analysis.mjs), built now from the runs picked when it was asked
  // for: those of its repo still listed, redacted like any output. None left: no run.
  function analysisDigest(task, items, note) {
    const asked = items.findLast((i) => i.analysis)?.analysis;
    if (!asked?.runs?.length) {
      throw new RunError(
        `${cantRun(agentOf(task))}: this analysis has no runs to read. Start one from the dashboard's Analyze.`,
      );
    }
    const { text, included, left } = ctx.analysis.digest(task.repo, asked.runs, asked);
    if (!included.length) {
      throw new RunError(
        `${cantRun(agentOf(task))}: the runs this analysis was to read are gone (their logs were removed).`,
      );
    }
    note(
      `Run digest: ${included.length} run(s), ${Math.round(Buffer.byteLength(text) / 1000)} KB${left.length ? `, ${left.length} left out` : ""}`,
    );
    return redact(text, [task.live.secret, ...operatorSecrets(ctx)]);
  }

  // Left over from a listener that lost track of it: wait for it, then make room.
  async function makeRoom(task) {
    const leftover = await ctx.runner.state(task.name);
    if (leftover === "running") await ctx.runner.wait(task.name);
    if (leftover) await ctx.runner.remove(task.name);
  }

  // A fresh, unguessable folder per run: its screenshots are public once linked on GitHub.
  function shotsFolder() {
    const shots = randomBytes(12).toString("hex");
    mkdirSync(join(ctx.shotsDir, shots), { recursive: true });
    chmodSync(join(ctx.shotsDir, shots), 0o777); // the sandbox runs as uid 1000
    return shots;
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

  // The run's image (built first if the repo's Dockerfile changed), its agent and the repo's
  // cache volumes. While an image builds, the dashboard shows the run as "building image".
  async function prepareImage(task, items, settings, grant, note, pulls) {
    const { record, logFile } = task.live;
    const { base } = task;
    const output = (chunk) => logFile.write(chunk);
    try {
      const source = await imageSource(task, items, settings, grant, pulls);
      const image = await ctx.images.imageFor({
        repo: task.repo,
        ref: source.ref,
        branch: source.branch,
        dockerfile: settings.dockerfile,
        onBuild: (tag) => {
          record.phase = "building image";
          note(
            `Building ${tag} from ${settings.dockerfile} (${source.branch ? "pull request branch" : base})`,
          );
        },
        output,
      });
      record.phase = null;
      if (image !== config.image)
        note(`Image ${image}${source.branch ? " (pull request branch)" : ""}`);
      await ctx.images.installAgent(agentOf(task), output);
      // A light run runs no setup: no caches, which work runs trust.
      const cacheArgs = task.live.light
        ? []
        : await ctx.images.caches(task.repo, settings.caches, image);
      return { image, cacheArgs, settings };
    } catch (error) {
      throw new RunError(
        `${agentOf(task).displayName} couldn't start: ${error.message}\n\nThe run's log on the dashboard has the details.`,
      );
    }
  }

  // The branches the run may push (git-gateway.mjs) and whose pull requests it may mark ready
  // (pr-ready.mjs): an issue's own, issue-<n>-* (draft-pr.sh names it from the title, which
  // may change), and the head of each pull request its comments came from, a maintainer's
  // included, but not a fork's. None for a run that can't push. `fork`: whether one of them
  // is a fork's; `pulls`: number → the pull request, as GitHub has it, for imageSource().
  async function pushBranches(task, items) {
    const pulls = new Map();
    if (!ctx.broker.runOf(task.live.secret)?.push) return { branches: [], fork: false, pulls };
    let fork = false;
    const branches = task.kind === "issue" ? [`issue-${task.number}-*`] : [];
    const numbers = new Set(items.map((i) => i.replyTo));
    if (task.kind !== "pr") numbers.delete(task.number);
    for (const number of numbers) {
      let pr;
      try {
        pr = await getJson(ctx.github, task.repo, `/repos/${task.repo}/pulls/${number}`);
      } catch (error) {
        throw new RunError(
          `${agentOf(task).displayName} couldn't start: pull request #${number} couldn't be looked up (${error.message ?? error}). Comment again to retry.`,
        );
      }
      pulls.set(number, pr);
      const ref = pr.head?.ref;
      if (!sameRepo(pr, task.repo)) fork = true;
      else if (ref && !branches.includes(ref)) branches.push(ref);
    }
    return { branches, fork, pulls };
  }

  // A comment on a pull request may run on the image of its own branch (imageRef()). `pulls`:
  // those pushBranches() looked up already.
  async function imageSource(task, items, settings, grant, pulls = new Map()) {
    const { base } = task;
    const pr = items.at(-1).replyTo;
    if (
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
