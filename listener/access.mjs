// What a run may reach and use, from the operator's grants (grants.mjs) and the repo's
// requests: the hosts its sandbox may reach, its host mounts and limits, the egress proxy's
// cache, and a container engine. What is refused stops the run with a reply (RunError).
import { agentFor } from "./agents/index.mjs";
import { mandatoryHosts, operatorHosts } from "./egress.mjs";
import { grantCheck, notGranted, resolveMounts } from "./grants.mjs";
import { BUILT_IN } from "./modes.mjs";
import { CONFIG_FILE, engineCacheVolume } from "./repo-config.mjs";
import { kubernetesEngine } from "./runner/engine.mjs";

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
// reach, its host mounts and limits. Refused mounts, and a Dockerfile or an engine
// without their grant, stop the run, and the reply lists them. `task`: the run's (tasks.mjs),
// `agent` its agent, `note(text)` a line in its log.
// `fs`: the file system the mounts are resolved on (grants.mjs resolveMounts()), for tests;
// `granted(repo)`: what the operator's policies grant it (policies.mjs grants(), grantsBy());
// `kept`: a chat's mounts as its permissions profile keeps them ([{ target, readOnly }]:
// profiles.mjs narrowProfile()), null for every other run's.
export async function grantedAccess(
  config,
  task,
  settings,
  { agent, note, log, fs, granted, kept = null },
) {
  const { repo } = task;
  const check = await grantCheck(config, repo, settings, { fs, granted });
  if (check.error) {
    log(`${repo}: ${check.error.message}`);
    const where = check.error.file
      ? `\`${check.error.file}\` in the operator's grants folder has errors`
      : "the operator's grants folder has errors";
    throw new RunError(`${cantRun(agent)}: ${where} (see the orchestrator's logs).`);
  }
  const { grant, missing } = check;
  if (missing.length) {
    log(`${repo}: ${CONFIG_FILE} asks for what its grant doesn't allow: ${missing.join("; ")}`);
    throw new RunError(
      `${configErrors(task.base, missing, agent.displayName)}\n\nThe operator can grant these to the repository with \`allow_grant\` rules in the grants folder's policies (see Deckhand's docs/reference/server-folder.md#the-grants), or the repository can remove them from \`${CONFIG_FILE}\`.`,
    );
  }
  const { refused, notes } = check.mounts;
  if (refused.length) throw new RunError(refusedMounts(refused, agent.displayName));
  // Before they are logged: a mount the profile turned off isn't said as the run's.
  const mounts = !kept
    ? check.mounts.mounts
    : check.mounts.mounts.flatMap((m) => {
        const keep = kept.find((k) => k.target === m.target);
        return keep ? [{ ...m, readOnly: m.readOnly || keep.readOnly }] : [];
      });
  for (const text of notes) note(text);
  // Read-only for a run without `push` and a fork's (sandbox-spec.mjs).
  const { fork } = task.live;
  const light = !task.live.capabilities?.includes("push");
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

// Why a research run (modes.mjs RESEARCH) can't run in `repo`, or null: its grants have errors, or
// the operator's policies don't grant it `research`. Checked when `/mode research` is asked for
// (task-modes.mjs), and again when a run with `internet` starts (capabilities.mjs,
// bareAccess()): the grant may be gone meanwhile. `granted(repo)`: grantedAccess()'s; `check`:
// grantCheck()'s, when the caller has it.
export async function researchRefusal(config, repo, { granted = null, check = null } = {}) {
  check ??= await grantCheck(config, repo, { mounts: [] }, { granted });
  if (check.error) return grantsRefusal(check);
  if (!check.grant.allowResearch) {
    return `research runs need the \`research\` grant: ${notGranted("research")} (see Deckhand's docs/reference/server-folder.md#the-grants)`;
  }
  return null;
}

// What a run without `pull` (capabilities.mjs) may reach: with `internet` (a research run), any
// public host, and private addresses only for the hosts every run needs (mandatoryHosts()),
// not the repo's granted ones: an internal host next to the open internet would be a way out
// for what it serves. Without, only those. Nothing else of the repo's: no mounts, no cached
// hosts (no CA), its limits only. Its config's requests (a Dockerfile, an engine) don't
// matter: none of it runs.
export async function bareAccess(config, task, { agent, log, internet, granted }) {
  const check = await grantCheck(config, task.repo, { mounts: [] }, { granted });
  if (check.error) log(`${task.repo}: ${check.error.message}`);
  const refused = internet
    ? await researchRefusal(config, task.repo, { check })
    : grantsRefusal(check);
  if (refused) throw new RunError(`${cantRun(agent)}: ${refused}.`);
  const { grant } = check;
  const trusted = mandatoryHosts(config, agent);
  return {
    grant: { ...grant, cachedHosts: [] },
    hosts: internet ? ["*"] : trusted,
    trusted,
    mounts: [],
    limits: grant.limits,
  };
}

// Why grants that can't be read refuse a run (grantCheck()'s `check`), or null.
export function grantsRefusal(check) {
  if (!check.error) return null;
  const where = check.error.file
    ? `\`${check.error.file}\` in the operator's grants folder has errors`
    : "the operator's grants folder has errors";
  return `${where} (see the orchestrator's logs)`;
}

// The egress proxy's CA certificate, which the sandbox trusts so that the proxy may decrypt
// the HTTPS of its cached hosts, and those hosts. Without the CA (the proxy doesn't answer),
// none: their HTTPS would fail on a certificate the sandbox doesn't know. A run that reaches
// GitHub (`github`: every run but research), whose calls the proxy relays to the listener's
// GitHub gateway, and an agent whose calls the proxy relays to the listener (its `relayed`
// hosts, agents/) can't do without it: the run stops. `egressCa()`: the proxy's, or null.
export async function egressCache(grant, egressCa, note, agent, config = {}, github = false) {
  // Its `relays(config)` says whether they go that way now (the Antigravity CLI's on a plan's
  // login, not on an API key).
  const relays = !!agent?.relayed?.length && agent.relays?.(config) === true;
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

// The container engine (runner/engine.mjs) a run with `docker` (capabilities.mjs) gets, or
// null: only with the operator's SANDBOX_ENGINE, the repo's `docker` and its grant
// (grantedAccess() stopped the run when that is missing), for runs whose comments came from no
// fork's pull request: a fork's code never runs in one. `internet`: the run reaches the open
// internet, so it gets no engine cache, which later runs' engines trust (as caches,
// preparation.mjs).
export function engineFor(config, task, settings, { grant, limits }, fork, note, internet = false) {
  if (!settings.docker || !grant.allowDocker) return null;
  if (!config.engine) {
    note("No container engine: the operator hasn't set SANDBOX_ENGINE");
    return null;
  }
  if (fork) {
    note("No container engine: a pull request from a fork");
    return null;
  }
  if (settings.docker.cache && internet) {
    note("No engine cache: this run reaches the open internet");
    return { limits, cache: null };
  }
  // Its storage is an emptyDir, gone with the pod (runner/kubernetes.mjs).
  if (settings.docker.cache && config.runner === "kubernetes") {
    note("No engine cache: the Kubernetes runner keeps none");
    return { limits, cache: null };
  }
  const cache = settings.docker.cache ? engineCacheVolume(config, task.repo) : null;
  return { limits, cache };
}

// What the operator granted and the repo asks for that the runner can't do yet (RUNNER), as
// the reply's reason, or null. Docker does all of it; the Kubernetes runner runs a container
// engine only through Sysbox's RuntimeClass (runner/engine.mjs kubernetesEngine()), builds no
// repo image without a registry to push it to and mounts no host path (runner/kubernetes.mjs). Only what is granted: an ungranted ask is refused before this, by
// grantedAccess(). The engine only when the run would get one (`engine`, engineFor()'s): a
// run without `docker`, a fork's, or one without SANDBOX_ENGINE goes without, as under Docker.
// `caps`: the run's capabilities (capabilities.mjs).
export function runnerRefusal(config, settings, { grant, mounts }, engine, caps = new Set()) {
  if ((config.runner ?? "docker") === "docker") return null;
  const asked = [
    engine && !kubernetesEngine(config) && "a container engine (`docker`)",
    // Its image needs a registry the nodes pull from (runner/kube-images.mjs): a run that
    // builds none (without `image:repo`) needs none.
    settings.dockerfile &&
      grant.allowDockerfile &&
      (caps.has("image:repo") || caps.has("image:branch")) &&
      !config.kubernetes?.registry &&
      `its own image (\`dockerfile\`) without a registry (\`KUBERNETES_REGISTRY\`)`,
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
