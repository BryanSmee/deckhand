// A work run's branch, created and linked to its issue by the listener before the sandbox
// starts (issue #457), so the issue's Development sidebar shows it from the start, not only once
// the pull request says "Closes #n". GitHub links a branch only as it creates it
// (createLinkedBranch): the listener creates it at the base branch's head, so it carries no code
// the git gateway didn't check, and the sandbox (../sandbox/draft-pr.sh, TASK_BRANCH) adds its
// "start work" commit and pushes through the gateway as before. Only when the issue has no
// branch yet: a fix or conflict run's, or a later run's, already exists, and GitHub links no
// existing branch; for a work run, its one branch is then the sandbox's still (a title changed
// since names another, and an earlier link whose run never started has no commit yet). Policies
// may refuse it (`deny_link_branch`, ../policy/gh-linked-branch.rego). TASK_BRANCH is what lets
// a repo's own mode open its branch and draft (draft-pr.sh): only a link the policies allowed.
// Nothing here fails the run: without a link, the sandbox creates the branch itself.
import { branchAllowed } from "./broker.mjs";
import { getJson } from "./github.mjs";
import { runTraits } from "./github-writes.mjs";
import { denyKept, passed } from "./policies.mjs";

// "Café : bientôt" → "issue-12-cafe-bientot", as draft-pr.sh names it from the title. A title
// with no Latin letter or digit gives "task": the gateway takes issue-<n>-<something> only.
export function branchName(number, title) {
  const slug =
    String(title ?? "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "task";
  return `issue-${number}-${slug}`;
}

const LINK = `mutation($input: CreateLinkedBranchInput!) {
  createLinkedBranch(input: $input) { linkedBranch { ref { name } } }
}`;

// A path's segments encoded, its slashes kept: a base branch may be "release/1.x".
const refPath = (name) => name.split("/").map(encodeURIComponent).join("/");

// `github`, `graphql`: the listener's calls (github.mjs); `policies`: policies.mjs, null without;
// `runOf(secret)`: the broker's run; `decided(key, entry)`: keeps a decision for the task's page
// (decisions.mjs).
export function createLinkedBranches({ github, graphql, policies, runOf, decided, log }) {
  // `task`'s run, about to start → the branch it created and linked, the issue's one branch
  // when it has one already, or null. `note`: a line of the run's log.
  async function link(task, note) {
    const { live, repo, number, base } = task;
    const pattern = `issue-${number}-*`;
    // A run that pushes its issue's branch: not a light one, nor one where a fork's code runs.
    if (task.kind !== "issue" || live.light || live.fork || !live.branches.includes(pattern)) {
      return null;
    }
    const run = runOf(live.secret);
    if (!run?.push) return null;
    try {
      const existing = await getJson(
        github,
        repo,
        `/repos/${repo}/git/matching-refs/heads/issue-${number}-`,
      );
      if (!Array.isArray(existing)) throw new Error("GitHub listed no branches");
      const names = existing
        .map((r) => r.ref?.replace(/^refs\/heads\//, ""))
        .filter((name) => branchAllowed([pattern], name));
      // Several: the sandbox's own name (draft-pr.sh) picks among them. A repo's own mode gets
      // none: the policies weren't asked, and its sandbox opens no branch without them.
      if (names.length) {
        return names.length === 1 && (run.mode ?? live.mode) === "work" ? names[0] : null;
      }
      const issue = await getJson(github, repo, `/repos/${repo}/issues/${number}`);
      if (issue.pull_request) return null;
      const head = await getJson(github, repo, `/repos/${repo}/git/ref/heads/${refPath(base)}`);
      const oid = head?.object?.sha;
      if (!oid) throw new Error(`${base} has no head commit`);
      const info = await getJson(github, repo, `/repos/${repo}`);
      const name = branchName(number, issue.title);
      const denied = await deny(task, run, { issue, name, oid });
      if (denied.length) {
        note(`Branch not linked to #${number}: ${denied.join("; ")}`);
        return null;
      }
      const data = await graphql(repo, LINK, {
        input: { issueId: issue.node_id, oid, name, repositoryId: info.node_id },
      });
      const created = data?.createLinkedBranch?.linkedBranch?.ref?.name;
      // What GitHub named it is what the sandbox checks out: one it may push, or none. No name:
      // nothing confirmed.
      if (!created) throw new Error("GitHub created no linked branch");
      if (!branchAllowed([pattern], created)) {
        throw new Error(`GitHub named the branch ${created}`);
      }
      note(`Branch ${created} created at ${base}'s head and linked to #${number}`);
      return created;
    } catch (error) {
      log(`${live.key}: linking a branch to #${number}: ${error.message ?? error}`);
      note(`Branch not linked to #${number}: ${error.message ?? error}`);
      return null;
    }
  }

  // `deny_link_branch`'s messages (docs/repo-config.md#the-linked-branch-input), the decision
  // kept for the task's page when a policy was asked. [] without policies.
  async function deny(task, run, { issue, name, oid }) {
    if (!policies) return [];
    const { repo, number, base, live } = task;
    const rule = "deny_link_branch";
    return denyKept(
      policies,
      rule,
      repo,
      base,
      () => ({
        repo: repo.toLowerCase(),
        mode: run.mode ?? live.mode,
        ...runTraits(run),
        issue: number,
        labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
        branch: name,
        base,
        oid,
      }),
      {
        pr: { number },
        gates: [passed("A work run on its issue"), passed("No branch of the issue yet")],
        keep: (entry) => decided(live.key, entry),
        log,
      },
    );
  }

  return { link };
}
