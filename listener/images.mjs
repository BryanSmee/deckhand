// What a run starts from: the base image (../sandbox/Dockerfile, harness only) or the
// repo's own image built FROM it; Claude Code, installed once per version into a shared
// volume by a container of its own; and the repo's cache volumes.
//
// A repo image is built from the default branch (or, when the operator's grants set
// allow_branch_docker_images for the repo, from a pull request's own branch, never a fork's)
// and tagged with a hash of the base image's id and the Dockerfile's blob: a new base or a changed Dockerfile builds a new tag, the same
// ones reuse it. A branch's image is tagged apart (`branch-…`, its commit in the hash): the
// default branch's runs and preview hooks never pick up what a branch built. Old tags are
// pruned, keeping the default branch's newest and the most recent few.
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { checked, hardening, labelArgs, removeVolume, volumeExists } from "./docker.mjs";
import { cacheVolume, repoImage } from "./repo-config.mjs";

// Tags kept per repo image: the default branch's and those of a few branches in flight.
export const KEEP_TAGS = 3;

// What a branch image's tag starts with.
const BRANCH = "branch-";

// Which ref a run's image is built from: the default branch, or a pull request's head when
// the operator grants the repo branch images (`grant`, grants.mjs) and the pull request's
// branch lives in the repo itself.
export function imageRef(grant, settings, repo, base, pr) {
  const own = pr?.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase();
  if (grant.allowBranchDockerImages && settings.dockerfile && pr?.head?.sha && own) {
    return { ref: pr.head.sha, branch: true };
  }
  return { ref: base, branch: false };
}

// A branch's tag also hashes its commit (`ref`): its build context (what the Dockerfile
// COPYs or RUNs) may differ from the default branch's with the same Dockerfile.
export function imageTag(config, repo, baseId, dockerfile, blob, branchRef = null) {
  const parts = [baseId, dockerfile, blob, ...(branchRef ? ["branch", branchRef] : [])];
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${repoImage(config, repo)}:${branchRef ? BRANCH : ""}${hash.slice(0, 16)}`;
}

export function createImages({
  config,
  docker, // docker.mjs
  readFile, // (repo, path, ref) → { sha, text } or null (repo-config.mjs readRepoFile)
  checkout, // (repo, ref) → a folder with the repo's files (checkout.mjs)
  log = () => {},
}) {
  const builds = new Map(); // tag → Promise, so two runs never build the same image
  const installs = new Map(); // "<agent>@<version>" → Promise
  const volumes = new Map(); // cache volume → Promise

  async function baseId() {
    const { code, out } = await docker(["image", "inspect", "--format", "{{.Id}}", config.image]);
    if (code !== 0 || !out) {
      throw new Error(`the base image ${config.image} is missing: run docker compose build`);
    }
    return out;
  }

  // The image to run: the base without a Dockerfile, else the repo's, built if needed.
  // `onBuild(tag)` is called when a build starts or is already under way; `output` gets its
  // log (the first caller's only). `branch`: `ref` is a pull request's head (imageRef()).
  async function imageFor({ repo, ref, branch = false, dockerfile, onBuild = () => {}, output }) {
    const id = await baseId();
    if (!dockerfile) return config.image;
    const file = await readFile(repo, dockerfile, ref);
    if (!file)
      throw new Error(`${dockerfile} (the config's dockerfile) is not in ${repo} at ${ref}`);
    const tag = imageTag(config, repo, id, dockerfile, file.sha, branch ? ref : null);
    if ((await docker(["image", "inspect", "--format", "{{.Id}}", tag])).code === 0) return tag;
    if (!builds.has(tag)) {
      const build = buildImage(repo, ref, dockerfile, tag, output).finally(() =>
        builds.delete(tag),
      );
      builds.set(tag, build);
    }
    onBuild(tag);
    await builds.get(tag);
    return tag;
  }

  async function buildImage(repo, ref, dockerfile, tag, output) {
    log(`${repo}: building ${tag} from ${dockerfile} at ${ref}`);
    const dir = await checkout(repo, ref);
    try {
      const built = await docker(
        [
          "build",
          "--progress",
          "plain",
          // A Dockerfile names its base with `ARG DECKHAND_BASE` / `FROM $DECKHAND_BASE`, so
          // the operator's image name isn't written in every repo.
          "--build-arg",
          `DECKHAND_BASE=${config.image}`,
          ...labelArgs({ "deckhand.repo": repo.toLowerCase() }),
          "-t",
          tag,
          "-f",
          join(dir, dockerfile),
          dir,
        ],
        { onData: output },
      );
      checked(built, `building ${dockerfile} of ${repo} failed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    log(`${repo}: built ${tag}`);
    await prune(repo, tag);
  }

  // Newest first (docker's order); a tag still used by a container refuses to go, and stays.
  // The default branch's newest tag stays first: branch builds in a row don't push it out.
  async function prune(repo, keep) {
    const name = repoImage(config, repo);
    const { code, out } = await docker(["image", "ls", "--format", "{{.Tag}}", name]);
    if (code !== 0) return;
    const tags = out.split("\n").filter((t) => t && t !== "<none>");
    const main = tags.find((t) => !t.startsWith(BRANCH));
    const kept = new Set([keep.split(":")[1], ...(main ? [main] : [])]);
    for (const tag of tags) if (kept.size < KEEP_TAGS) kept.add(tag);
    for (const tag of tags) {
      if (!kept.has(tag)) await docker(["image", "rm", `${name}:${tag}`]);
    }
  }

  // The agent in its shared volume, once per version: a short container of its own before
  // the first run that needs it (the base image ships without it). As root, so the files
  // aren't the sandbox user's (uid 1000) to change: sandboxes mount the volume read-only,
  // and this still holds if a mount ever isn't. CHOWN only to take over a volume uid 1000
  // owned before (../sandbox/agents/claude/install). `agent`: agents/.
  function installAgent(agent, output) {
    const { volume, mount, version, versionVar, command } = agent.install(config);
    const key = `${agent.name}@${version}`;
    if (!installs.has(key)) {
      const install = docker(
        [
          "run",
          "--rm",
          // npm's registry, outside the runs' networks: no repo or agent input runs here.
          "--network",
          config.installNetwork,
          ...["--user", "0", ...hardening("CHOWN")],
          "-e",
          `${versionVar}=${version}`,
          "-v",
          `${volume}:${mount}`,
          "--entrypoint",
          command,
          config.image,
        ],
        { onData: output },
      ).then((result) => {
        checked(result, `installing ${agent.displayName} ${version} failed`);
      });
      // A failure is not kept: the next run tries again.
      install.catch(() => installs.get(key) === install && installs.delete(key));
      installs.set(key, install);
    }
    return installs.get(key);
  }

  // `-v` arguments for the repo's caches. A new volume is handed to the sandbox's user
  // (uid 1000): Docker creates a missing mount point as root.
  async function caches(repo, paths, image) {
    const args = [];
    for (const path of paths) {
      const name = cacheVolume(config, repo, path);
      if (!volumes.has(name)) {
        const ready = cacheReady(repo, path, name, image);
        ready.catch(() => volumes.get(name) === ready && volumes.delete(name));
        volumes.set(name, ready);
      }
      await volumes.get(name);
      args.push("-v", `${name}:${path}`);
    }
    return args;
  }

  async function cacheReady(repo, path, name, image) {
    if (await volumeExists(docker, name)) return;
    const labels = labelArgs({ "deckhand.repo": repo.toLowerCase(), "deckhand.cache": path });
    checked(
      await docker(["volume", "create", ...labels, name]),
      `creating the cache volume ${name}`,
    );
    const owned = await docker([
      "run",
      "--rm",
      "--network",
      "none",
      // Root for chown, and nothing else.
      ...["--user", "0", ...hardening("CHOWN")],
      "--entrypoint",
      "chown",
      "-v",
      `${name}:${path}`,
      image,
      "1000:1000",
      path,
    ]);
    if (owned.code !== 0) await removeVolume(docker, name); // so the next run prepares it again
    checked(owned, `preparing the cache volume ${name}`);
  }

  return { baseId, imageFor, installAgent, caches, building: () => [...builds.keys()] };
}
