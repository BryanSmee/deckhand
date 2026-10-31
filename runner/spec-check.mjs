// What the runner checks of a sandbox spec before it starts one (#503): the rules that hold
// whatever the orchestrator says, as they held in the listener (AGENTS.md, Security rules, per
// service). A spec names its run's task (its `deckhand.task` label), and from that its
// repository, whose grants the runner reads itself (GRANTS_DIR, read-only):
//
//   - as the sandbox's user, and no capability (`--cap-drop ALL` and `no-new-privileges` are
//     the backend's);
//   - the base image, or the repository's own (its name hashes the repository: another's is
//     refused), under the registry the runner pushes to on Kubernetes;
//   - each volume at a plain absolute path, named plainly: nothing Docker would read as another
//     option;
//   - the agents' volumes read-only, the task's own session volumes, the repository's own caches;
//   - host paths resolved again here (`..`, symlinks) and inside a root the operator grants that
//     repository, read-only unless the root is granted read-write;
//   - the operator's limits for that repository, its own task's label only;
//   - a container engine only for a repository granted `allow_docker`.
//
// A compromised orchestrator can still start a run: it is its job. It can't make one root on the
// host through the runner.
import { posix } from "node:path";
import { grantFor, loadGrants, resolveMounts } from "../listener/grants.mjs";
import { AGENTS } from "../listener/agents/index.mjs";
import {
  cacheVolume,
  engineCacheVolume,
  legacySandboxName,
  PLAIN_PATH,
  repoImage,
  sandboxName,
} from "../listener/repo-config.mjs";
import { cliName } from "../listener/runner/docker.mjs";
import { SANDBOX_USER, sessionNames } from "../listener/sandbox-spec.mjs";

// A volume's name and where it goes, as Docker's options take them (`-v name:path`,
// `--mount …,dst=path`): nothing that would end one and start another (`:`, `,`, `=`).
const VOLUME_NAME = /^\w[\w.-]*$/;
const plainPath = (path) =>
  typeof path === "string" && PLAIN_PATH.test(path) && posix.normalize(path) === path;

// The environment's names: the sandbox's, which the runner's docker CLI is given too (`-e NAME`
// reads them from it). None that would change what that CLI, or a loader, does as root: the
// names the CLI keeps for itself (../listener/runner/docker.mjs cliName()).
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The labels a spec may set: its task's. The runner's own (`deckhand.owner`, `deckhand.run`,
// `deckhand.engine`) it sets itself, and `deckhand.role` and compose's are what it finds the
// listener and the proxy by.
const LABELS = new Set(["deckhand.task"]);

// Whether `image` is the base image or `repo`'s own, under the registry the runner pushes to
// on Kubernetes: a sandbox's, a cache's preparation (service.mjs).
export function ownImage(config, repo, image) {
  const own = repoImage(config, repo);
  const registry = config.kubernetes?.registry;
  const text = String(image ?? "");
  const tagOf = (prefix) => text.startsWith(prefix) && /^[\w.-]+$/.test(text.slice(prefix.length));
  return (
    text === config.image || tagOf(`${own}:`) || Boolean(registry && tagOf(`${registry}/${own}:`))
  );
}

export { plainPath };

// Whether `run` is one of `name`'s runs: its id, as runs.mjs makes it ("<name>-<ms>"). The
// spec's check and the runner's removals (service.mjs) both ask it.
export const runOf = (name, run) =>
  typeof run === "string" &&
  run.startsWith(`${name}-`) &&
  /^\d+$/.test(run.slice(String(name).length + 1));

// A task's session volumes: its workspace (with the fork's) and each agent's session, in every
// volume a run of the task may get (sandbox-spec.mjs sessionNames(), sessionOf()'s names: its
// work's, its light runs', by their capabilities) and its research's (modes.mjs sessionName()).
// The same list as the listener's, so that no run the listener names is refused here.
function sessionVolumes(name) {
  const out = new Set();
  for (const base of [...sessionNames(name), `${name}-research`]) {
    out.add(`${base}-workspace`).add(`${base}-fork-workspace`);
    for (const agent of Object.values(AGENTS)) out.add(`${base}-${agent.session.volume}`);
  }
  return out;
}

// [why] for each rule `spec` breaks, [] when none. `grants()`: the grants folder, read now;
// `resolve`: grants.mjs resolveMounts(), in the runner's own filesystem.
export function specProblems(
  config,
  spec,
  { grants = () => loadGrants(config), resolve = resolveMounts } = {},
) {
  const problems = [];
  const key = spec.labels?.["deckhand.task"];
  const repo =
    typeof key === "string" && /^[^/#\s]+\/[^/#\s]+#/.test(key) ? key.split("#")[0] : null;
  if (!repo) return ["it names no run's task (its deckhand.task label)"];
  // The task's own sandbox name (runs.mjs, repo-config.mjs taskSandboxName()): never one that
  // other volumes start with.
  const id = key.slice(repo.length + 1);
  // The legacy name only when it can't be another task's current one (which ends with a hash).
  const legacy = legacySandboxName(config, repo, id);
  const names = [sandboxName(config, repo, id), ...(/-[0-9a-f]{10}$/.test(legacy) ? [] : [legacy])];
  if (!names.includes(spec.name)) {
    return [`its name ${spec.name} is not ${key}'s sandbox's (${names[0]})`];
  }
  // Its run, named after its sandbox (runs.mjs: "<name>-<ms>"): its network, its inbox and its
  // start's key are named after it, never another's or the host's (`bridge`).
  if (!runOf(spec.name, spec.run)) return [`its run ${spec.run} isn't one of ${spec.name}'s`];
  const sessions = sessionVolumes(spec.name);
  for (const name of Object.keys(spec.env ?? {})) {
    if (!ENV_NAME.test(name) || cliName(name)) problems.push(`its environment's ${name}`);
  }
  const { uid, gid } = spec.user ?? {};
  if (uid !== SANDBOX_USER.uid || gid !== SANDBOX_USER.gid) {
    problems.push(`it runs as ${uid ?? "no user"}:${gid ?? "no group"}, not the sandbox's user`);
  }
  if (spec.caps?.length) problems.push(`it asks for capabilities (${spec.caps.join(", ")})`);
  // The repository's own: its name, where the runner keeps it (the host's Docker, or the
  // registry it pushes to on Kubernetes), and a tag.
  if (!ownImage(config, repo, spec.image)) {
    problems.push(`its image ${spec.image} is neither the base image nor ${repo}'s`);
  }
  for (const label of Object.keys(spec.labels)) {
    if (!LABELS.has(label)) problems.push(`its label ${label}`);
  }
  let grant = null;
  const grantOf = () => (grant ??= grantFor(grants(), config, repo));
  // The operator's limits for the repository, its engine's too (access.mjs): never the spec's.
  const sameLimits = (limits) =>
    ["cpus", "memory", "pids"].every((k) => String(limits?.[k]) === String(grantOf().limits?.[k]));
  if (!sameLimits(spec.limits)) problems.push("its limits aren't the operator's for it");
  if (spec.engine && !sameLimits(spec.engine.limits)) {
    problems.push("its engine's limits aren't the operator's for it");
  }
  const agents = [config.claudeCodeVolume, config.codexVolume, config.agyVolume];
  for (const v of spec.volumes ?? []) {
    const what = `the volume ${v.name} at ${v.path}`;
    if (!plainPath(v.path) || v.subpath !== undefined) {
      problems.push(`${what}: not at a plain absolute path`);
      continue;
    }
    if (v.kind !== "mount" && !VOLUME_NAME.test(String(v.name))) {
      problems.push(`${what}: not a volume's name`);
      continue;
    }
    if (v.kind === "agent") {
      if (!agents.includes(v.name) || v.readOnly !== true) {
        problems.push(`${what}: an agent's volume, read-only, only`);
      }
    } else if (v.kind === "session") {
      if (!sessions.has(v.name)) problems.push(`${what}: not one of ${spec.name}'s sessions`);
    } else if (v.kind === "cache") {
      if (v.name !== cacheVolume(config, repo, v.path)) {
        problems.push(`${what}: not ${repo}'s cache for ${v.path}`);
      }
    } else if (v.kind === "mount") {
      if (!plainPath(v.name)) {
        problems.push(`the host path ${v.name}: not a plain absolute path`);
        continue;
      }
      const { mounts, refused } = resolve([{ path: v.name, readOnly: v.readOnly }], grantOf());
      const [found] = mounts;
      if (!found || found.source !== v.name || (found.readOnly && !v.readOnly)) {
        const why = refused.length ? refused.join("; ") : "not as the operator grants it";
        problems.push(`the host path ${v.name}: ${why}`);
      }
    } else problems.push(`${what}: of no kind a sandbox has (${v.kind})`);
  }
  if (spec.engine && !(config.engine && grantOf().allowDocker)) {
    problems.push(`a container engine, which the operator doesn't grant ${repo}`);
  } else if (spec.engine?.cache && spec.engine.cache !== engineCacheVolume(config, repo)) {
    problems.push(`its engine's cache ${spec.engine.cache}: not ${repo}'s`);
  }
  return problems;
}
