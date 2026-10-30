// What a run may reach and use, from the operator's grants (grants.mjs) and the repo's
// requests: the hosts its sandbox may reach, its host mounts and limits, the egress proxy's
// cache, and a container engine. What is refused stops the run with a reply (RunError).
import { agentFor } from "./agents/index.mjs";
import { mandatoryHosts, operatorHosts } from "./egress.mjs";
import { grantCheck, resolveMounts } from "./grants.mjs";
import { BUILT_IN } from "./modes.mjs";
import { CONFIG_FILE, engineCacheVolume } from "./repo-config.mjs";

// A run that can't start for a reason the maintainer can fix: the reply says it.
export class RunError extends Error {}

// The start of most of these replies. `agent`: the run's (agents/).
export const cantRun = (agent) => `${agent.displayName} can't run here`;

// `name`: the run's agent's (agents/).
export function configErrors(base, errors, name = agentFor().displayName) {
  return `${name} can't run here: \`${CONFIG_FILE}\` on \`${base || "main"}\` has errors.\n\n${errors.map((e) => `- ${e}`).join("\n")}`;
}

// A config with errors, an `/agent` the operator doesn't allow, a mode no longer in the
// config or a model of another agent's stop the run (runs.mjs) once its log has its first
// line. `run`: what resolveEntry() and the repo's settings made of its comments.
export function validateRun(agent, task, { badPick, errors, warnings, own }, note) {
  const { mode, record } = task.live;
  if (badPick) throw new RunError(`${cantRun(agent)}: ${badPick}.`);
  if (errors.length) throw new RunError(configErrors(task.base, errors, agent.displayName));
  for (const warning of warnings) note(`${CONFIG_FILE}: ${warning}`);
  if (!own && !BUILT_IN.has(mode)) {
    throw new RunError(
      `${cantRun(agent)}: the \`${mode}\` mode is no longer in \`${CONFIG_FILE}\` on \`${task.base}\`.`,
    );
  }
  // A model of another agent's ("/model opus" for Codex): the run would only fail later.
  const wrongModel = agent.modelProblem(record.model);
  if (wrongModel) {
    throw new RunError(
      `${cantRun(agent)}: ${wrongModel}. Use a tier (\`/model best\`, \`balanced\` or \`fast\`) or one of its models.`,
    );
  }
}

function refusedMounts(refused, name) {
  return `${name} can't run here: host mounts requested by \`${CONFIG_FILE}\` are refused.\n\n${refused.map((r) => `- ${r}`).join("\n")}\n\nOnly paths under a root the operator grants this repository can be mounted.`;
}

// What the operator grants the repo, with its config's requests: the hosts its sandbox may
// reach, its host mounts and limits. Refused mounts, and a preview hook or Dockerfile
// without their grant, stop the run, and the reply lists them. `task`: the run's (tasks.mjs),
// `agent` its agent, `note(text)` a line in its log.
// `fs`: the file system the mounts are resolved on (grants.mjs resolveMounts()), for tests.
export function grantedAccess(config, task, settings, { agent, note, log, fs }) {
  const { repo } = task;
  const check = grantCheck(config, repo, settings, { fs });
  if (check.error) {
    log(`${repo}: ${check.error.message}`);
    const where = check.error.file
      ? `\`${check.error.file}\` in the operator's grants folder has errors`
      : "the operator's grants folder has errors";
    throw new RunError(`${cantRun(agent)}: ${where} (see the listener's logs).`);
  }
  const { grant, missing } = check;
  if (missing.length) {
    log(`${repo}: ${CONFIG_FILE} asks for what its grant doesn't allow: ${missing.join("; ")}`);
    throw new RunError(
      `${configErrors(task.base, missing, agent.displayName)}\n\nThe operator can add these to the repository's file in the grants folder (see Deckhand's docs/security.md), or the repository can remove them from \`${CONFIG_FILE}\`.`,
    );
  }
  const { mounts, refused, notes } = check.mounts;
  if (refused.length) throw new RunError(refusedMounts(refused, agent.displayName));
  for (const text of notes) note(text);
  // Read-only for a light run and a fork's (sandbox-spec.mjs).
  const { light, fork } = task.live;
  for (const m of mounts) {
    const why = !m.readOnly && !light && fork ? ": a pull request from a fork" : "";
    note(`Host mount ${m.target}${m.readOnly || light || fork ? ` (read-only${why})` : ""}`);
  }
  return {
    grant,
    // All the operator's, for the run's agent: each may resolve to a private address.
    hosts: operatorHosts(config, grant, agent),
    trusted: operatorHosts(config, grant, agent),
    mounts,
    limits: grant.limits,
  };
}

// Why a research run (modes.mjs OPEN) can't run in `repo`, or null: its grants have errors, or
// don't set `allow_research`. Checked when `/mode research` is asked for (task-modes.mjs), and
// again when the run starts (researchAccess()): the grant may be gone meanwhile.
export function researchRefusal(config, repo, check = grantCheck(config, repo, { mounts: [] })) {
  if (check.error) {
    const where = check.error.file
      ? `\`${check.error.file}\` in the operator's grants folder has errors`
      : "the operator's grants folder has errors";
    return `${where} (see the listener's logs)`;
  }
  if (!check.grant.allowResearch) {
    return "research runs need the operator's `allow_research: true` grant for this repository (in its file of the grants folder, or `default.yaml`; see Deckhand's docs/security.md)";
  }
  return null;
}

// What a research run may reach: any public host, and private addresses only for the hosts
// every run needs (mandatoryHosts()), not the repo's granted ones: an internal host next to
// the open internet would be a way out for what it serves. Nothing else of the repo's: no
// mounts, no cached hosts (no CA), its limits only. Its config's requests (a preview hook, a
// Dockerfile) don't matter: none of it runs.
export function researchAccess(config, task, { agent, log }) {
  const check = grantCheck(config, task.repo, { mounts: [] });
  if (check.error) log(`${task.repo}: ${check.error.message}`);
  const refused = researchRefusal(config, task.repo, check);
  if (refused) throw new RunError(`${cantRun(agent)}: ${refused}.`);
  const { grant } = check;
  return {
    grant: { ...grant, cachedHosts: [] },
    hosts: ["*"],
    trusted: mandatoryHosts(config, agent),
    mounts: [],
    limits: grant.limits,
  };
}

// The egress proxy's CA certificate, which the sandbox trusts so that the proxy may decrypt
// the HTTPS of its cached hosts, and those hosts. Without the CA (the proxy doesn't answer),
// none: their HTTPS would fail on a certificate the sandbox doesn't know. A run that reaches
// GitHub (`github`: every run but research), whose calls the proxy relays to the listener's
// GitHub gateway, and an agent whose calls the proxy relays to the listener (its `relayed`
// hosts, agents/) can't do without it: the run stops. `egressCa()`: the proxy's, or null.
export async function egressCache(grant, egressCa, note, agent, config = {}, github = false) {
  const relays = !!agent?.relayed?.length && !Object.keys(agent.env(config, "s")).length;
  if (!grant.cachedHosts.length && !relays && !github) return { ca: null, cached: [] };
  const ca = await egressCa();
  if (!ca && (relays || github)) {
    const what = github ? "GitHub" : "its provider";
    throw new RunError(
      `${cantRun(agent)}: the egress proxy has no CA, and its calls to ${what} go through it. Check the egress service's log.`,
    );
  }
  if (ca) return { ca, cached: grant.cachedHosts };
  note("Egress cache: off for this run, the egress proxy has no CA");
  return { ca: null, cached: [] };
}

// The container engine (runner/engine.mjs) a run gets, or null: only with the operator's
// SANDBOX_ENGINE, the repo's `docker` and its grant (grantedAccess() stopped the run when
// that is missing), for work runs whose comments came from no fork's pull request: a
// fork's code never runs in one.
export function engineFor(config, task, settings, { grant, limits }, fork, note) {
  if (!settings.docker || !grant.allowDocker || task.live.light) return null;
  if (!config.engine) {
    note("No container engine: the operator hasn't set SANDBOX_ENGINE");
    return null;
  }
  if (fork) {
    note("No container engine: a pull request from a fork");
    return null;
  }
  const cache = settings.docker.cache ? engineCacheVolume(config, task.repo) : null;
  return { limits, cache };
}

// What the operator granted and the repo asks for that the runner can't do yet (RUNNER), as
// the reply's reason, or null. Docker does all of it; the Kubernetes runner runs no container
// engine, builds no repo image, runs no preview hook and mounts no host path
// (runner/kubernetes.mjs). Only what is granted: an ungranted ask is refused before this, by
// grantedAccess().
export function runnerRefusal(config, task, settings, { grant, mounts }) {
  if ((config.runner ?? "docker") === "docker") return null;
  const asked = [
    settings.docker && grant.allowDocker && !task.live.light && "a container engine (`docker`)",
    settings.dockerfile && grant.allowDockerfile && `its own image (\`dockerfile\`)`,
    settings.preview && grant.allowPreview && "a preview hook (`preview`)",
    mounts.length && "host mounts (`mounts`)",
  ].filter(Boolean);
  if (!asked.length) return null;
  return `the operator runs sandboxes on the ${config.runner} runner, which doesn't support ${asked.join(", ")} yet. The repository can remove ${asked.length > 1 ? "them" : "it"} from \`${CONFIG_FILE}\`, or the operator can run its sandboxes on Docker (\`RUNNER=docker\`).`;
}

// The log's line about the engine the runner started (`started`) for engineFor()'s request.
export function engineNote({ backend, cached }, { cache }) {
  const storage = cached
    ? "the repository's cache"
    : cache
      ? "fresh storage: another run has the repository's cache"
      : "fresh storage";
  return `Container engine: ${backend}, ${storage}`;
}

// Resolved again as late as possible: preparing the run can take minutes, during which a
// path's parts may have changed. Anything different from what was checked stops the run.
export function recheckMounts(agent, settings, { grant, mounts }) {
  const now = resolveMounts(settings.mounts, grant, { caches: settings.caches });
  if (now.refused.length) {
    throw new RunError(refusedMounts(now.refused, agent.displayName));
  }
  const changed = mounts.filter(
    (m, i) => now.mounts[i]?.source !== m.source || now.mounts[i]?.readOnly !== m.readOnly,
  );
  if (changed.length || now.mounts.length !== mounts.length) {
    throw new RunError(
      `${cantRun(agent)}: host mounts changed while the run was being prepared.\n\n${changed.map((m) => `- \`${m.target}\` no longer resolves to \`${m.source}\``).join("\n")}\n\nComment again to retry once they are stable.`,
    );
  }
}
