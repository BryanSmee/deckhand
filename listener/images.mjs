// What a run starts from: the base image (../sandbox/Dockerfile, harness only) or the
// repo's own image built FROM it; Claude Code, installed once per version into a shared
// volume by a container of its own; and the repo's cache volumes. What Docker does for them is
// the runner's (runner/images.mjs, runner/jobs.mjs; on Kubernetes, runner/kube-images.mjs:
// BuildKit, a registry and claims): this module decides which image, which tag and which
// volumes.
//
// A repo image is built from the default branch (or, when the operator's policies grant the repo
// `branch_docker_images`, from a pull request's own branch, never a fork's)
// and tagged with a hash of the base image's id and the Dockerfile's blob: a new base or a changed Dockerfile builds a new tag, the same
// ones reuse it. A branch's image is tagged apart (`branch-…`, its commit in the hash): the
// default branch's runs never pick up what a branch built. Old tags are
// pruned, keeping the default branch's newest and the most recent few.
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sameRepo } from "./events.mjs";
import { checked } from "./docker.mjs";
import { cacheVolume, legacyRepoImage, repoImage } from "./repo-config.mjs";
import { SANDBOX_USER } from "./sandbox-spec.mjs";

// Tags kept per repo image: the default branch's and those of a few branches in flight.
export const KEEP_TAGS = 3;

// What a branch image's tag starts with.
const BRANCH = "branch-";

// Which ref a run's image is built from: the default branch, or a pull request's head when
// the operator grants the repo branch images (`grant`, grants.mjs) and the pull request's
// branch lives in the repo itself.
export function imageRef(grant, settings, repo, base, pr) {
  const own = sameRepo(pr?.head?.repo?.full_name, repo);
  if (grant.allowBranchDockerImages && settings.dockerfile && pr?.head?.sha && own) {
    return { ref: pr.head.sha, branch: true };
  }
  return { ref: base, branch: false };
}

// A branch's tag also hashes its commit (`ref`): its build context (what the Dockerfile
// COPYs or RUNs) may differ from the default branch's with the same Dockerfile. The repo is
// hashed too, as two repos' contexts differ just the same.
export function imageTag(config, repo, baseId, dockerfile, blob, branchRef = null) {
  const parts = [
    repo.toLowerCase(),
    baseId,
    dockerfile,
    blob,
    ...(branchRef ? ["branch", branchRef] : []),
  ];
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${repoImage(config, repo)}:${branchRef ? BRANCH : ""}${hash.slice(0, 16)}`;
}

// A file's git blob id, as GitHub names its contents (a Dockerfile's `sha`), which a repo image's
// tag hashes.
export const gitBlob = (data) =>
  createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

// The blobs a file of a checkout may have been archived from. GitHub's tarballs come from `git
// archive`, which applies the repository's .gitattributes to what it writes: `eol=crlf` turns
// its line ends to CRLF, `ident` expands `$Id$`. Undone here, as git stores the file; what can't
// be undone (`export-subst`, a Git LFS pointer) doesn't match, and the build says so.
export function archivedBlobs(data) {
  const text = Buffer.from(data).toString("latin1");
  const lf = text.replace(/\r\n/g, "\n");
  const unident = (t) => t.replace(/\$Id: [0-9a-f]{40,64} \$/g, "$Id$");
  return new Set(
    [text, lf, unident(text), unident(lf)].map((t) => gitBlob(Buffer.from(t, "latin1"))),
  );
}

export function createImages({
  config,
  backend, // the runner's images and volumes (runner/images.mjs)
  jobs, // its short containers (runner/jobs.mjs)
  checkout, // (repo, ref) → a folder with the repo's files (checkout.mjs)
  log = () => {},
  metrics = null, // the runner's (../runner/metrics.mjs): builds, prunes and installs counted
  now = Date.now,
}) {
  const builds = new Map(); // tag → Promise, so two runs never build the same image
  const installs = new Map(); // "<agent>@<version>" → Promise
  const volumes = new Map(); // cache volume → Promise

  // A repo image's full name: under the registry, for a runner whose nodes pull from one.
  const named = (name) => backend.repository?.(name) ?? name;

  async function baseId() {
    const out = await backend.id(config.image);
    if (!out) {
      throw new Error(
        config.runner === "kubernetes"
          ? `the base image ${config.image} is not in its registry: SANDBOX_IMAGE has to be one the nodes can pull`
          : `the base image ${config.image} is missing: run docker compose build`,
      );
    }
    return out;
  }

  // The image to run: the base without a Dockerfile, else the repo's, built if needed.
  // `onBuild(tag)` is called when a build starts or is already under way; `output` gets its
  // log (the first caller's only). `branch`: `ref` is a pull request's head (imageRef()).
  // `access`: the run's { hosts, trusted } (access.mjs), which a build may reach on a runner
  // whose builder goes through the egress proxy (Kubernetes). `blob`: the Dockerfile's blob at
  // `ref`, which the caller read (the runner reads nothing of GitHub's but a tarball).
  async function imageFor({
    repo,
    ref,
    branch = false,
    dockerfile,
    blob,
    onBuild = () => {},
    output,
    access = {},
  }) {
    // Without a Dockerfile, a registry's base image is the nodes' to pull, with their own
    // credentials (a kind or ECR node's): not looked up. A host's Docker must have it.
    if (!dockerfile) {
      if (!backend.repository) await baseId();
      return config.image;
    }
    const id = await baseId();
    if (!blob)
      throw new Error(
        `${dockerfile} (the config's dockerfile) is not in ${repo} at ${ref ?? "its default branch"}`,
      );
    const tag = named(imageTag(config, repo, id, dockerfile, blob, branch ? ref : null));
    if ((await backend.id(tag)) !== null) return tag;
    if (!builds.has(tag)) {
      const build = buildImage(repo, ref, dockerfile, blob, tag, output, access).finally(() =>
        builds.delete(tag),
      );
      builds.set(tag, build);
    }
    onBuild(tag);
    await builds.get(tag);
    return tag;
  }

  // The tag hashes the Dockerfile's blob, which the caller read apart from the files it builds
  // (the github service, #502): built only when the Dockerfile in those files is that blob, so
  // that a tag always names what it was built from, whoever served the files.
  async function buildImage(repo, ref, dockerfile, blob, tag, output, { hosts, trusted }) {
    const at = ref ?? "its default branch";
    log(`${repo}: building ${tag} from ${dockerfile} at ${at}`);
    const dir = await checkout(repo, ref);
    try {
      let found = null;
      try {
        found = archivedBlobs(readFileSync(join(dir, dockerfile)));
      } catch {
        // None: refused below.
      }
      if (!found?.has(blob)) {
        // A push between the blob's lookup and this download, most often: the caller may plan
        // again (DOCKERFILE_MOVED).
        const error = new Error(
          `${dockerfile} of ${repo} at ${at}: not the Dockerfile its tag names (${found ? [...found][0] : "none"} in its files, ${blob} asked)`,
        );
        error.code = "DOCKERFILE_MOVED";
        throw error;
      }
      const started = now();
      let built;
      try {
        built = await backend.build({
          dir,
          dockerfile,
          tag,
          labels: { "deckhand.repo": repo.toLowerCase() },
          output,
          hosts,
          trusted,
        });
      } finally {
        metrics?.built(built?.code === 0, (now() - started) / 1000);
      }
      checked(built, `building ${dockerfile} of ${repo} failed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    log(`${repo}: built ${tag}`);
    await prune(repo, tag);
  }

  // Newest first (docker's order); a tag still used by a container refuses to go, and stays.
  // The default branch's newest tag stays first: branch builds in a row don't push it out.
  // The backend is told which stay (a registry deletes a manifest with all its tags).
  async function prune(repo, keep) {
    const name = named(repoImage(config, repo));
    const tags = await backend.tags(name);
    if (!tags) return;
    const main = tags.find((t) => !t.startsWith(BRANCH));
    const kept = new Set([keep.slice(name.length + 1), ...(main ? [main] : [])]);
    for (const tag of tags) if (kept.size < KEEP_TAGS) kept.add(tag);
    const keeping = [...kept].map((tag) => `${name}:${tag}`);
    for (const tag of tags) {
      if (kept.has(tag)) continue;
      // "deleted", "kept" (in use) or "failed"; nothing from a backend that doesn't say.
      const result = await backend.remove(`${name}:${tag}`, keeping);
      if (result) metrics?.pruned(result);
    }
    // Tags of the name before it had a hash: no run picks them any more, whichever repo built
    // them. None under a registry, which never had them.
    if (backend.repository) return;
    const legacy = legacyRepoImage(config, repo);
    for (const tag of (await backend.tags(legacy)) ?? []) {
      await backend.remove(`${legacy}:${tag}`);
    }
  }

  // The agent in its shared volume, once per version: a short container of its own before
  // the first run that needs it (the base image ships without it). As root, so the files
  // aren't the sandbox user's (uid 1000) to change: sandboxes mount the volume read-only,
  // and this still holds if a mount ever isn't. CHOWN only to take over a volume uid 1000
  // owned before (../sandbox/agents/claude/install). `agent`: agents/.
  // A backend with its own way (Kubernetes: a pod of its own, or nothing when each sandbox
  // installs it, runner/kube-images.mjs) installs it its way, once per version all the same.
  function installAgent(agent, output) {
    const spec = agent.install(config);
    const { volume, mount, version, versionVar, command, env = {} } = spec;
    const key = `${agent.name}@${version}`;
    if (!installs.has(key)) {
      const install = (
        backend.installAgent
          ? backend.installAgent({
              ...spec,
              name: agent.name,
              displayName: agent.displayName,
              output,
            })
          : jobs.run({
              image: config.image,
              // npm's registry, outside the runs' networks: no repo or agent input runs here.
              network: "install",
              user: { uid: 0 },
              caps: ["CHOWN"],
              env: { [versionVar]: version, ...env },
              volumes: [{ name: volume, path: mount }],
              entrypoint: command,
              output,
            })
      ).then((result) => {
        // Left to the sandbox (a runner whose sandboxes install it without a volume): asked
        // again at the next run, which may have a volume to fill by then.
        if (result?.inSandbox) installs.get(key) === install && installs.delete(key);
        else if (result) checked(result, `installing ${agent.displayName} ${version} failed`);
        if (!result?.inSandbox) metrics?.installed(agent.name, true);
      });
      // A failure is not kept: the next run tries again.
      install.catch(() => {
        metrics?.installed(agent.name, false);
        if (installs.get(key) === install) installs.delete(key);
      });
      installs.set(key, install);
    }
    return installs.get(key);
  }

  // The repo's caches, [{ name, path }] (sandbox-spec.mjs). A new volume is handed to the
  // sandbox's user (uid 1000): Docker creates a missing mount point as root. None on a runner
  // that keeps none (preparation.mjs says so).
  const keepsCaches = backend.keepsCaches ?? Boolean(jobs.run);
  async function caches(repo, paths, image) {
    const found = [];
    if (!keepsCaches) return found;
    for (const path of paths) {
      const name = cacheVolume(config, repo, path);
      if (!volumes.has(name)) {
        const ready = cacheReady(repo, path, name, image);
        ready.catch(() => volumes.get(name) === ready && volumes.delete(name));
        volumes.set(name, ready);
      }
      await volumes.get(name);
      found.push({ name, path });
    }
    return found;
  }

  async function cacheReady(repo, path, name, image) {
    if (await backend.volumeExists(name)) return;
    const labels = { "deckhand.repo": repo.toLowerCase(), "deckhand.cache": path };
    checked(await backend.createVolume(name, labels), `creating the cache volume ${name}`);
    // A backend whose volumes come to the sandbox's user anyway (Kubernetes' fsGroup).
    if (backend.ownsVolumes) return;
    const owned = await jobs.run({
      image,
      network: "none",
      // Root for chown, and nothing else.
      user: { uid: 0 },
      caps: ["CHOWN"],
      volumes: [{ name, path }],
      entrypoint: "chown",
      args: [`${SANDBOX_USER.uid}:${SANDBOX_USER.gid}`, path],
    });
    if (owned.code !== 0) await backend.removeVolume(name); // so the next run prepares it again
    checked(owned, `preparing the cache volume ${name}`);
  }

  return {
    baseId,
    imageFor,
    installAgent,
    caches,
    // Whether caches() gives any.
    keepsCaches,
    // Why there are none, when there aren't.
    noCaches: keepsCaches ? null : (backend.noCaches ?? `the ${config.runner} runner keeps none`),
    // The egress proxy's answer for a caller that isn't a sandbox (its builder, an install),
    // or null (egress-http.mjs).
    egressFor: async (ip, host) => (await backend.egressFor?.(ip, host)) ?? null,
    building: () => [...builds.keys()],
  };
}
