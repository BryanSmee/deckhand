// What the runner decides itself of a repo image's build (#503), a container that holds more than
// a sandbox does. The orchestrator only names the repository, its Dockerfile and ref; the runner
// reads the grants (GRANTS_DIR, and the policy service for what the operator's policies grant:
// `granted`, grants.mjs grantsBy()) and asks the github service for the Dockerfile's blob, never
// taking either from the request.
import { Refused } from "../lib/http.mjs";
import { grantOf, loadGrants, notGranted } from "../listener/grants.mjs";
import { AGENTS } from "../listener/agents/index.mjs";
import { operatorHosts } from "../listener/egress.mjs";
import { gitBlob as blobOf } from "../listener/images.mjs";
import { repoPath, validRepo } from "../listener/repo-config.mjs";

const REF = /^[A-Za-z0-9_./-]{1,250}$/;

// The service's callers import it from here.
export { validRepo };

// The repository's grant, with what the operator's policies grant it (`granted`), or a Refused:
// no grant read is no build.
export async function grantOrRefuse(
  config,
  repo,
  grants = () => loadGrants(config),
  granted = null,
) {
  if (!validRepo(repo)) throw new Refused(400, "repo?");
  try {
    return await grantOf(config, repo, { load: grants, granted });
  } catch (error) {
    throw new Refused(403, `${repo}: its grants: ${error.message}`);
  }
}

// A repo image's build, as asked: with the `dockerfile` grant, from a plain path of the repo,
// and from a branch only with `branch_docker_images`; any other ref is the default branch
// (buildPlan()). Without a Dockerfile, nothing builds.
export async function buildProblem(config, { repo, ref, branch, dockerfile }, grants, granted) {
  if (!dockerfile) return null;
  const grant = await grantOrRefuse(config, repo, grants, granted);
  if (!grant.allowDockerfile) return `${repo}: ${notGranted("dockerfile")}`;
  if (repoPath(dockerfile) !== dockerfile) return `its Dockerfile ${dockerfile}: not a plain path`;
  if (branch && (typeof ref !== "string" || !REF.test(ref) || ref.split("/").includes(".."))) {
    return "ref?";
  }
  if (branch && !grant.allowBranchDockerImages) {
    return `${repo}: ${notGranted("branch_docker_images")}`;
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
  const grant = await grantOrRefuse(config, repo, grants);
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
