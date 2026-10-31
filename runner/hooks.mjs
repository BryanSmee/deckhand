// What the runner decides itself of the containers that aren't sandboxes and hold more than one
// (#503): a repo image's build and a preview hook. The orchestrator only names the repository
// (and, for a build, its Dockerfile and ref); the runner reads the grants (GRANTS_DIR) and,
// for a hook, the repository's config from its default branch's tarball, never from the
// request: a preview hook runs as root on the host, with its Docker socket.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Refused } from "../lib/http.mjs";
import { grantFor, loadGrants, ungranted } from "../listener/grants.mjs";
import { AGENTS } from "../listener/agents/index.mjs";
import { operatorHosts } from "../listener/egress.mjs";
import { sameRepo } from "../listener/events.mjs";
import { gitBlob as blobOf } from "../listener/images.mjs";
import { CONFIG_FILE, parseRepoConfig, repoPath } from "../listener/repo-config.mjs";

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,250}$/;

export function validRepo(repo) {
  return (
    typeof repo === "string" &&
    REPO.test(repo) &&
    repo.split("/").every((part) => part !== "." && part !== "..")
  );
}

// The repository's grant, or a Refused: no grant read is no build and no hook.
export function grantOrRefuse(config, repo, grants = () => loadGrants(config)) {
  if (!validRepo(repo)) throw new Refused(400, "repo?");
  try {
    return grantFor(grants(), config, repo);
  } catch (error) {
    throw new Refused(403, `${repo}: its grants: ${error.message}`);
  }
}

// A repo image's build, as asked: with `allow_dockerfile`, from a plain path of the repo, and
// from a branch only with `allow_branch_docker_images`; any other ref is the default branch
// (buildPlan()). Without a Dockerfile, nothing builds.
export function buildProblem(config, { repo, ref, branch, dockerfile }, grants) {
  if (!dockerfile) return null;
  const grant = grantOrRefuse(config, repo, grants);
  if (!grant.allowDockerfile) return `the operator doesn't grant ${repo} \`allow_dockerfile\``;
  if (repoPath(dockerfile) !== dockerfile) return `its Dockerfile ${dockerfile}: not a plain path`;
  if (branch && (typeof ref !== "string" || !REF.test(ref) || ref.split("/").includes(".."))) {
    return "ref?";
  }
  if (branch && !grant.allowBranchDockerImages) {
    return `the operator doesn't grant ${repo} \`allow_branch_docker_images\``;
  }
  return null;
}

// What a build is from, as the runner decides it, never the orchestrator: the default branch's
// files (`ref` null) unless it asks for a branch's, which needs its own grant (buildProblem());
// the hosts the build may reach (Kubernetes' builder) among those the operator grants the
// repository; the Dockerfile's blob, from the github service (`blobOf(repo, path, ref)`), which
// the image's tag hashes. → what images.mjs imageFor() takes.
export async function buildPlan(config, asked, { grants, blobOf: lookup }) {
  const { repo, ref, branch, dockerfile, access = {} } = asked;
  const from = branch ? ref : null;
  if (!dockerfile) return { repo, ref: from, branch: Boolean(branch), dockerfile };
  const grant = grantOrRefuse(config, repo, grants);
  const granted = new Set(
    Object.values(AGENTS).flatMap((agent) => operatorHosts(config, grant, agent)),
  );
  const within = (hosts) => (hosts ?? []).filter((h) => granted.has(String(h).toLowerCase()));
  return {
    repo,
    ref: from,
    branch: Boolean(branch),
    dockerfile,
    blob: await lookup(repo, dockerfile, from),
    access: { hosts: within(access.hosts), trusted: within(access.trusted) },
  };
}

// A file's git blob id: what GitHub's contents API says of it (its `sha`), which a repo image's
// tag hashes (images.mjs imageTag()).
export { blobOf };

// What is wrong with a preview hook's event, or null. The runner can't check its delivery's
// signature (the listener took it): it checks at least that the event is one a hook gets, about
// the repository asked, with its subject, so a hook granted to one repository never gets
// another's events. The hook still judges the rest itself (docs/repo-config.md).
export function previewEventProblem(repo, event, payload) {
  if (!["pull_request", "workflow_run"].includes(event)) return "event?";
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "payload?";
  if (!sameRepo(payload.repository?.full_name, repo)) return `the event isn't about ${repo}`;
  if (!payload[event] || typeof payload[event] !== "object")
    return `a ${event} event without its ${event}`;
  return null;
}

// A preview hook for `repo`'s `event`: its command and image from its default branch's config,
// in the runner's own checkout (`checkout(repo, null)`: the default branch), which it then runs
// in (`dir`): the command and the files of one commit. → the job for
// previews.mjs run(), or a Refused saying why none runs. `imageFor`: images.mjs's.
export async function previewJob(config, { repo, event, payload }, { checkout, imageFor, grants }) {
  const problem = previewEventProblem(repo, event, payload);
  if (problem) throw new Refused(400, problem);
  const grant = grantOrRefuse(config, repo, grants);
  if (!grant.allowPreview) {
    throw new Refused(403, `the operator doesn't grant ${repo} \`allow_preview\``);
  }
  const dir = await checkout(repo, null);
  try {
    let text = "";
    try {
      text = readFileSync(join(dir, CONFIG_FILE), "utf8");
    } catch {
      throw new Refused(409, `${repo} has no ${CONFIG_FILE} on its default branch`);
    }
    const { settings, errors } = parseRepoConfig(text, config);
    if (errors.length) throw new Refused(409, `${CONFIG_FILE} of ${repo} has errors`);
    if (!settings.preview) throw new Refused(409, `${repo} has no preview hook`);
    const missing = ungranted(grant, settings);
    if (missing.length) throw new Refused(403, missing.join("; "));
    let image = settings.preview.image;
    if (!image) {
      let blob = null;
      if (settings.dockerfile) {
        try {
          blob = blobOf(readFileSync(join(dir, settings.dockerfile)));
        } catch {
          // imageFor() says the Dockerfile isn't there.
        }
      }
      image = await imageFor({ repo, ref: null, dockerfile: settings.dockerfile, blob });
    }
    // Its files are the ones its config was read from: previews.mjs runs it there, and
    // removes them.
    return { repo, event, payload, ref: null, hook: settings.preview, image, dir };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
