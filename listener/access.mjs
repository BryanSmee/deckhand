// What a run may reach and use, from the operator's grants (grants.mjs) and the repo's
// requests: the hosts its sandbox may reach, its host mounts and limits, the egress proxy's
// cache, and a container engine. What is refused stops the run with a reply (RunError).
import { agentFor } from "./agents/index.mjs";
import { operatorHosts } from "./egress.mjs";
import { grantCheck, resolveMounts } from "./grants.mjs";
import { CONFIG_FILE, engineCacheVolume } from "./repo-config.mjs";

// A run that can't start for a reason the maintainer can fix: the reply says it.
export class RunError extends Error {}

// The start of most of these replies. `agent`: the run's (agents/).
export const cantRun = (agent) => `${agent.displayName} can't run here`;

// `name`: the run's agent's (agents/).
export function configErrors(base, errors, name = agentFor().displayName) {
  return `${name} can't run here: \`${CONFIG_FILE}\` on \`${base || "main"}\` has errors.\n\n${errors.map((e) => `- ${e}`).join("\n")}`;
}

function refusedMounts(refused, name) {
  return `${name} can't run here: host mounts requested by \`${CONFIG_FILE}\` are refused.\n\n${refused.map((r) => `- ${r}`).join("\n")}\n\nOnly paths under a root the operator grants this repository can be mounted.`;
}

// What the operator grants the repo, with its config's requests: the hosts its sandbox may
// reach, its host mounts and limits. Refused mounts, and a preview hook or Dockerfile
// without their grant, stop the run, and the reply lists them. `task`: the run's (tasks.mjs),
// `agent` its agent, `note(text)` a line in its log.
export function grantedAccess(config, task, settings, { agent, note, log }) {
  const { repo } = task;
  const check = grantCheck(config, repo, settings);
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
  const { light } = task.live;
  for (const m of mounts) {
    note(`Host mount ${m.target}${m.readOnly || light ? " (read-only)" : ""}`);
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

// The egress proxy's CA certificate, which the sandbox trusts so that the proxy may decrypt
// the HTTPS of its cached hosts, and those hosts. Without the CA (the proxy's cache is off,
// or it doesn't answer), none: their HTTPS would fail on a certificate the sandbox doesn't
// know. `egressCa()`: the proxy's, or null.
export async function egressCache(grant, egressCa, note) {
  if (!grant.cachedHosts.length) return { ca: null, cached: [] };
  const ca = await egressCa();
  if (ca) return { ca, cached: grant.cachedHosts };
  note("Egress cache: off for this run, the egress proxy has no CA (its cache is off?)");
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
