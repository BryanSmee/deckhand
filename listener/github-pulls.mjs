// A run's pull request writes (issue #407): `gh pr create`, `gh pr edit`, `gh pr ready
// [--undo]`, or the same over REST, are writes the GitHub gateway checks like any other
// (github-writes.mjs, github-graphql.mjs): its mode's ceiling holds them for a work run's own
// pull requests only (modes.mjs WORK_CEILING). Then, before the policies, here:
//
// - a pull request is opened from a branch of the run's repo it may push (broker.mjs allow()),
//   never `owner:branch` nor another repository's head, and only with the fields GitHub's create
//   takes for that (not `issue`, which turns an issue into one);
// - one that is opened, edited, labelled, readied, drafted or has its branch updated runs its
//   workflows from a new merge of its branch with its base (an update commits that merge): for
//   a repo granted `allow_workflows`, its workflow files are checked in that merge first, as the
//   git gateway checks a push (git-gateway.mjs checkBranch());
// - one that is edited, readied or drafted, over any endpoint (`…/pulls/<n>`, `…/issues/<n>`,
//   GraphQL), or whose token must write more than its mode's (`permissions`: pull requests for a
//   create or an edit, contents for ready and draft), is from one of the run's branches, not
//   only the pull request it was triggered on: a fork's head isn't the run's to vouch for, nor
//   its author's title and description the run's to rewrite. A comment or a label still is;
// - one that conflicts with its base isn't made ready;
// - its branch is updated (`gh pr update-branch`, issue #456) with a merge only, never a rebase,
//   which would rewrite the commits the git gateway let through, and from the head the run saw
//   (`expected_head_sha`, `expectedHeadOid`): that write reaches the branch past the git gateway,
//   which the head being the run's own makes up for. GitHub refuses one that conflicts.
//
// Each change that went on is recorded for the dashboard at once (`record`, answered()): the
// `pull_request` delivery that follows may never come.
import { branchAllowed } from "./broker.mjs";

// What a create may set (REST's names: github-graphql.mjs restName()).
const CREATE_FIELDS = new Set(["title", "body", "head", "base", "draft", "maintainer_can_modify"]);
// Actions that run none of the pull request's workflows from its branch: a comment's run from
// the default branch (`issue_comment`).
const UNCHECKED = new Set(["comment", "react"]);
// Actions on a pull request that need its head to be one of the run's branches.
const OWN_BRANCH = new Set(["edit", "ready", "draft", "update_branch"]);
// What a branch update may send (REST's names: github-graphql.mjs restName()).
const UPDATE_FIELDS = new Set(["expected_head_sha", "update_method"]);
// A commit's ID: SHA-1's, or SHA-256's.
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// What a pull request's own write needs of its token beyond its mode's: GitHub opens and edits
// one with `pull_requests: write`, and readies, drafts or updates the branch of one with
// `contents: write` for an App's token.
export const PULL_WRITE = { pull_requests: "write" };
export const CONTENTS_WRITE = { contents: "write" };

const refusal = (status, message) => ({ status, message });

// `lookup(repo, path)`: GitHub's JSON with the listener's token, null for a 404 (github.mjs
// getJson()); `checkWorkflows(repo, branch, base)`: why `branch`'s workflows can't run merged
// with `base`, or null (git-gateway.mjs checkBranch()); `record(repo, pull request as GitHub
// has it, readyAt or null)`: pulls.mjs's.
export function createPullChecks({
  lookup,
  checkWorkflows = async () => null,
  record = () => {},
  now = Date.now,
  log = () => {},
}) {
  // A write within the ceiling (github-writes.mjs checkWrite()), its target resolved → null when
  // it may go on, else { status, message }. `get`: `lookup`, kept across the call's writes.
  async function check(run, write, target, get = lookup) {
    if (target.kind !== "new_pr" && target.kind !== "own_pr") return null;
    if (write.actions.every((a) => UNCHECKED.has(a))) return null;
    const { repo } = write;
    if (target.kind === "new_pr") {
      const { head, base } = write.pull ?? {};
      const extra = write.change.fields.filter((f) => !CREATE_FIELDS.has(f));
      if (extra.length) {
        return refusal(403, `a run opens a pull request without its ${extra.join(", ")}`);
      }
      if (typeof head !== "string" || !head || head.includes(":")) {
        return refusal(403, "a run opens pull requests from a branch of its own repository only");
      }
      if (!branchAllowed(run.branches ?? [], head)) {
        return refusal(403, `${head} is not this run's branch`);
      }
      if (typeof base !== "string" || !base) return refusal(422, "a pull request needs its base");
      return workflows(repo, head, base, repo);
    }
    if (write.actions.includes("update_branch")) {
      const refused = updateRefusal(write);
      if (refused) return refused;
    }
    const ref = `${repo}#${target.number}`;
    let pr;
    try {
      pr = await get(repo, `/repos/${repo}/pulls/${target.number}`);
    } catch (error) {
      log(`GitHub gateway: ${ref}: ${error.message ?? error}`);
      return refusal(502, `#${target.number} can't be looked up on GitHub`);
    }
    if (!pr) return refusal(404, `#${target.number} isn't there`);
    const branch = pr.head?.ref;
    const own = pr.head?.repo?.full_name?.toLowerCase() === repo;
    const needsBranch = write.permissions || write.actions.some((a) => OWN_BRANCH.has(a));
    if (needsBranch && !(own && branchAllowed(run.branches ?? [], branch))) {
      return refusal(403, `#${target.number}'s branch, ${branch}, is not this run's`);
    }
    const asked = write.pull?.base;
    if (asked !== undefined && (typeof asked !== "string" || !asked)) {
      return refusal(422, "a pull request's base is a branch name");
    }
    // Conflicts with its base: not ready, whatever the run thinks. Only `dirty` is refused:
    // GitHub computes the state lazily (`unknown`, null) and the rest (checks, reviews) is for
    // the reviewer to weigh.
    const base = asked ?? pr.base?.ref;
    if (write.actions.includes("ready") && pr.draft && pr.mergeable_state === "dirty") {
      const into = pr.base?.ref ?? "the base branch";
      return refusal(
        409,
        `#${target.number} conflicts with ${into}: rebase on origin/${into} first (git fetch origin, git rebase origin/${into}, git push --force-with-lease)`,
      );
    }
    // A fork's workflows run without the repo's secrets: nothing of the run's to check.
    return own ? workflows(repo, branch, base, ref) : null;
  }

  // Why a branch update can't go on, or null: only the fields Deckhand checks, a merge, and
  // the head it applies to.
  function updateRefusal(write) {
    const extra = write.change.fields.filter((f) => !UPDATE_FIELDS.has(f));
    if (extra.length) {
      return refusal(403, `a run updates a pull request's branch without its ${extra.join(", ")}`);
    }
    const { expected_head, method } = write.pull ?? {};
    if (method != null && String(method).toUpperCase() !== "MERGE") {
      return refusal(
        403,
        "a run updates its pull request's branch with a merge only: a rebase rewrites the commits Deckhand checked (rebase locally and push with --force-with-lease instead)",
      );
    }
    if (typeof expected_head !== "string" || !OID.test(expected_head)) {
      return refusal(
        422,
        "a run updates its pull request's branch from the head it saw: send it (expected_head_sha, expectedHeadOid)",
      );
    }
    return null;
  }

  // Whether `branch`'s workflows may run merged with `base`: null, else why not.
  async function workflows(repo, branch, base, ref) {
    let why;
    try {
      why = await checkWorkflows(repo, branch, base);
    } catch (error) {
      log(`GitHub gateway: ${ref}: ${error.message ?? error}`);
      return refusal(502, `${branch}'s workflow files can't be checked; try again`);
    }
    if (!why) return null;
    log(`GitHub gateway: ${ref}: refused: ${why}`);
    return refusal(422, why);
  }

  // GitHub's answer to a run's write that went on (github-gateway.mjs wroteWrite()): each pull
  // request it changed is looked up and recorded, with when it turned ready if it was opened or
  // readied. `pulls`: [{ key, number | head, ready }], what it wrote to (a GraphQL call's
  // response key, null over REST, whose status says whether it went on).
  async function answered(run, { pulls = [], graphql }, status, answer) {
    if (!pulls.length || status < 200 || status >= 300) return;
    let json = null;
    try {
      json = JSON.parse(answer.toString("utf8"));
    } catch {}
    for (const { key, number, head, ready } of pulls) {
      // A GraphQL field that failed answers null, beside the others' data.
      if (graphql && !json?.data?.[key]) continue;
      try {
        // A REST create answers with the pull request it opened.
        const pr =
          graphql || number != null || !json?.number
            ? await found(run.repo, number, head, claimed(json?.data?.[key], run.repo))
            : json;
        if (!pr?.number) continue;
        record(run.repo, pr, ready && pr.state === "open" && !pr.draft ? now() : null);
      } catch (error) {
        log(`GitHub gateway: ${run.repo} pull request: ${error.message ?? error}`);
      }
    }
  }

  // A pull request by its number, or the one opened from `head`: the number the create's answer
  // claims (`claimed`, gh's `pullRequest { url }`), when that pull request is from `head`, which
  // an alias in the run's document can't fake; else the open one from `head`, which may be
  // another into a different base.
  async function found(repo, number, head, claimed = null) {
    if (number != null) return lookup(repo, `/repos/${repo}/pulls/${number}`);
    if (claimed != null) {
      const pr = await lookup(repo, `/repos/${repo}/pulls/${claimed}`);
      if (pr?.head?.ref === head && pr.head.repo?.full_name?.toLowerCase() === repo) return pr;
    }
    const owner = repo.split("/")[0];
    const list = await lookup(
      repo,
      `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open&per_page=1`,
    );
    return Array.isArray(list) ? list[0] : null;
  }

  return { check, answered };
}

// What answered() records of a classified write (github-writes.mjs classify(), github-graphql.mjs
// writeOf()), or null for one that isn't a pull request's own: `key`, its GraphQL field's
// response key.
export function pullOf(write, key = null) {
  if (!write?.pull) return null;
  const number = write.target.number ?? null;
  const ready = write.actions.includes("ready") || write.actions.includes("create");
  return { key, number, head: write.pull.head ?? null, ready };
}

// The number of the pull request a GraphQL create's answer names in its repo (`pullRequest {
// url }`, or `number`), or null.
function claimed(answer, repo) {
  const pr = answer?.pullRequest;
  const m = /\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(String(pr?.url ?? ""));
  if (m && m[1].toLowerCase() === repo) return Number(m[2]);
  return Number.isSafeInteger(pr?.number) ? pr.number : null;
}

// The token permissions a classified write needs beyond its mode's, merged: a call's several.
export function permissionsOf(writes) {
  return Object.assign({}, ...writes.map((w) => w?.permissions ?? {}));
}
