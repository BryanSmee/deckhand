// What the runner decides itself of a repo image's build (#503), a container that holds more than
// a sandbox does. The orchestrator only names the repository, its Dockerfile and ref; the runner
// reads the grants (GRANTS_DIR, and the policy service for what the operator's policies grant:
// `granted`, grants.mjs grantsBy()) and asks the github service for the Dockerfile's blob, and
// whether a branch's commit is the repository's own, never taking any of them from the request.
import { Refused } from "../lib/http.mjs";
import { grantOf, loadGrants, notGranted } from "../listener/grants.mjs";
import { AGENTS } from "../listener/agents/index.mjs";
import { operatorHosts } from "../listener/egress.mjs";
import { gitBlob as blobOf } from "../listener/images.mjs";
import { repoPath, validRepo } from "../listener/repo-config.mjs";

// A branch's image is built at a commit, named by its full id: what the orchestrator asks
// (images.mjs imageRef(): a pull request's head), pinned, so a push can't change the files
// between the check and the build. A branch's name, `refs/pull/<n>/head`, an abbreviation: no.
const SHA = /^[0-9a-f]{40}$/;

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
// and from a branch only with `branch_docker_images`, at a commit's full id; any other ref is
// the default branch (buildPlan()). Without a Dockerfile, nothing builds.
export async function buildProblem(config, { repo, ref, branch, dockerfile }, grants, granted) {
  if (!dockerfile) return null;
  const grant = await grantOrRefuse(config, repo, grants, granted);
  if (!grant.allowDockerfile) return `${repo}: ${notGranted("dockerfile")}`;
  if (repoPath(dockerfile) !== dockerfile) return `its Dockerfile ${dockerfile}: not a plain path`;
  if (branch && !grant.allowBranchDockerImages) {
    return `${repo}: ${notGranted("branch_docker_images")}`;
  }
  if (branch && (typeof ref !== "string" || !SHA.test(ref))) {
    return `a branch's image is built at a commit's full id, not ${JSON.stringify(String(ref).slice(0, 80))}`;
  }
  return null;
}

// What a build is from, as the runner decides it, never the orchestrator: the default branch's
// files (`ref` null) unless it asks for a branch's, which needs its own grant (buildProblem())
// and a commit the github service says is the repository's own (`ownCommit(repo, sha)`: on its
// default branch, a branch's head, in a pull request from one of its branches), as GitHub serves
// a fork pull request's commits through the repository too; the hosts the build may reach
// (Kubernetes' builder) among those the operator grants the repository; the Dockerfile's blob,
// from the github service (`blobOf(repo, path, ref)`), which the image's tag hashes. → what
// images.mjs imageFor() takes.
export async function buildPlan(
  config,
  asked,
  { grants, blobOf: lookup, ownCommit = async () => false },
) {
  const { repo, ref, branch, dockerfile, access = {} } = asked;
  const from = branch ? ref : null;
  if (!dockerfile) return { repo, ref: from, branch: Boolean(branch), dockerfile };
  if (branch && !(await ownCommit(repo, ref))) {
    throw new Refused(
      403,
      `no build: ${ref} isn't a commit of ${repo}'s own branches (a fork's pull request's, maybe): a branch's image is built from the repository's own branches only`,
    );
  }
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
