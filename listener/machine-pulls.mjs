// A machine's pull request (#594, #598): its owner's machine pushed the issue's branch with its
// own git, never through the git gateway, and says so at its run's end (claims.mjs finish()). The
// App opens the draft pull request from that branch (`Closes #<n>`), or finds the one it opened
// already, so the review and its fix loop treat it as any of Deckhand's own (reviews.mjs `own`):
// a fix round pushes to the same branch, from the same machine.
//
// Checked first, nothing opened otherwise: the branch is the issue's own (`issue-<n>-<slug>`),
// read from the repository itself (never a fork's), and its head is the commit the machine says
// it pushed. The pull request is recorded with `external: <owner>` (pulls.mjs): the dashboard
// shows it as a machine's, and the policies read it (`pr.external`), Deckhand's
// policy/machines.rego refusing to auto-merge it, as its commits passed none of the gateway's
// checks.
import { Refused } from "../lib/http.mjs";
import { headInRepo, linkedIssue, pullEntry, taskKey } from "./events.mjs";
import { getJson } from "./github.mjs";

// A commit's id, SHA-1 or SHA-256.
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// What may follow `issue-<n>-`: one path segment of git's plainest characters, as a branch
// name in a URL needs no escaping.
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

// Whether `branch` is issue `number`'s own: `issue-<n>-<slug>`, as the sandbox names it.
export function issueBranch(branch, number) {
  const prefix = `issue-${number}-`;
  if (typeof branch !== "string" || !branch.startsWith(prefix)) return false;
  const slug = branch.slice(prefix.length);
  return SLUG.test(slug) && !slug.includes("..") && !/(?:\.lock|\.)$/.test(slug);
}

const short = (sha) => String(sha).slice(0, 7);

// What the App writes in a machine's pull request: the issue it closes, and where its commits
// come from.
export function machinePullBody(number, owner, machine) {
  return `Closes #${number}

Pushed from @${owner}'s machine ${machine} (a Deckhand machine run): its commits didn't go through Deckhand's git gateway. Deckhand reviews it as its own, and its default policy leaves the merge to a person.`;
}

// The pull request of task `task`'s machine run, from `branch` at `sha` (the machine's push),
// opened as the App, or the App's already open from it; marked ready for review with `ready`.
// `owner` and `machine`: the machine's (claims.mjs); `since`: the pull request's head when the
// run was claimed (null: none known). → { number, url, state, opened, moved } (`moved`: its
// head isn't the one it had then, a push this run made, whether or not its `synchronize`
// delivery came first). `now`: the clock, for its `readyAt`. Refused (400, 409) when
// a check fails, nothing written then. `ctx`: github, graphql, config, pulls, titles, log.
export async function openPull(
  ctx,
  task,
  { branch, sha, ready = false, owner, machine, since = null, now = Date.now },
) {
  const { github } = ctx;
  const repo = task.repo;
  const number = task.number;
  if (task.kind !== "issue") {
    throw new Refused(400, "Only an issue's run opens a pull request: push to its own branch.");
  }
  if (!issueBranch(branch, number)) {
    throw new Refused(400, `\`branch\` is the issue's own: issue-${number}-<slug>.`);
  }
  if (typeof sha !== "string" || !SHA.test(sha)) {
    throw new Refused(400, "`sha` is the full id of the commit pushed, in lowercase hex.");
  }
  // The repository's own branch: a fork's has no ref here.
  const ref = await getJson(github, repo, `/repos/${repo}/git/ref/heads/${branch}`, [404]);
  if (!ref) throw new Refused(409, `${branch} isn't on ${repo}: push it there first.`);
  if (ref.object?.sha !== sha) {
    throw new Refused(
      409,
      `${branch}'s head on ${repo} is ${short(ref.object?.sha ?? "?")}, not ${short(sha)}: push it, then finish again.`,
    );
  }
  let pr = await found(ctx, task, branch);
  let opened = false;
  if (!pr) {
    const base = task.base || (await getJson(github, repo, `/repos/${repo}`)).default_branch;
    const key = taskKey(repo, task.id);
    const title = ctx.titles?.get(key) || `Issue #${number}`;
    const res = await github(
      repo,
      "POST",
      `/repos/${repo}/pulls`,
      { title, head: branch, base, body: machinePullBody(number, owner, machine), draft: true },
      [422],
    );
    if (res.ok) {
      pr = await res.json();
      opened = true;
      ctx.log?.(`${key}: pull request #${pr.number} opened from ${owner}'s ${machine}`);
    } else {
      // Opened meanwhile (this call asked again after a lost answer), or GitHub's own refusal
      // (nothing between the branch and its base, say).
      pr = await found(ctx, task, branch);
      if (!pr) {
        const said = await res.json().catch(() => ({}));
        const why = said.errors?.map((e) => e.message).find(Boolean) ?? said.message ?? "422";
        if (/no commits between/i.test(why)) {
          throw new Refused(409, `${branch} has no commits beyond ${base}: nothing to open.`);
        }
        throw new Refused(
          409,
          `GitHub doesn't open the pull request: ${String(why).slice(0, 300)}`,
        );
      }
    }
  }
  // Marked as the machine's before anything else can fail: a mutation that throws mustn't leave
  // the App's pull request unmarked, which machines.rego would then let auto-merge.
  const { key } = pullEntry(repo, pr);
  ctx.pulls?.record(key, { ...pullEntry(repo, pr).pr, head: sha, external: owner });
  let readyAt = null;
  if (ready && pr.draft) {
    await ctx.graphql(
      repo,
      "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
      { id: pr.node_id },
    );
    pr = { ...pr, draft: false };
    readyAt = now();
  }
  const { pr: entry } = pullEntry(repo, pr, readyAt);
  if (readyAt) ctx.pulls?.record(key, { ...entry, head: sha, external: owner });
  const moved = opened || since !== sha;
  return { number: pr.number, url: pr.html_url, state: entry.state, opened, moved };
}

// The App's open pull request from `branch` that closes the task's issue, or null; Refused
// (409) for one that is someone else's, or closes another issue: GitHub opens one per branch.
async function found(ctx, task, branch) {
  const { config, github } = ctx;
  const repo = task.repo;
  const [owner] = repo.split("/");
  const head = encodeURIComponent(`${owner}:${branch}`);
  const list = await getJson(github, repo, `/repos/${repo}/pulls?head=${head}&state=open`);
  const pr = (list ?? []).find((p) => headInRepo(p, repo) && p.head?.ref === branch);
  if (!pr) return null;
  const own = !!config.bot && pr.user?.login?.toLowerCase() === config.bot.toLowerCase();
  if (!own) {
    throw new Refused(
      409,
      `#${pr.number} is open from ${branch}, not opened by Deckhand: close it, or push another issue-${task.number}- branch.`,
    );
  }
  if (linkedIssue(pr, repo, config.bot) !== task.number) {
    throw new Refused(409, `#${pr.number}, open from ${branch}, doesn't close #${task.number}.`);
  }
  return pr;
}
