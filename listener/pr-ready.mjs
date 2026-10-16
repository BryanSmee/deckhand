// Ready for review, or back to draft: GitHub only lets an App's token do either with
// `contents: write` (markPullRequestReadyForReview, convertPullRequestToDraft), which a
// sandbox's token lacks (github-app.mjs, SANDBOX_PERMISSIONS). The sandbox's gh wrapper
// (../sandbox/gh) sends `gh pr ready [--undo]` here instead, with the run's secret; the
// listener checks the pull request is the run's repo's own, from a branch of that repo the run
// may push (broker.mjs allow()), and calls the mutation with a token of its own that the
// sandbox never sees.
//
// Served on the broker's port, which only the runs' networks reach.
import { branchAllowed } from "./broker.mjs";
import { GITHUB_HEADERS, PUSH_PERMISSIONS } from "./github-app.mjs";
import { graphqlData } from "./github.mjs";
import { send } from "./web.mjs";

const PATH = /^\/pr\/([\w.-]+)\/([\w.-]+)\/(\d+)\/(ready|draft)$/;

const MUTATIONS = {
  ready: "markPullRequestReadyForReview",
  draft: "convertPullRequestToDraft",
};

export function createPrReady({
  broker, // broker.mjs: the run a secret belongs to
  app, // () => the GitHub App (github-app.mjs), or null before /setup
  api = "https://api.github.com",
  fetch = globalThis.fetch,
  log = () => {},
}) {
  async function mutate(token, action, id) {
    const name = MUTATIONS[action];
    const res = await fetch(`${api}/graphql`, {
      method: "POST",
      headers: {
        ...GITHUB_HEADERS,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation($id: ID!) { ${name}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
        variables: { id },
      }),
    });
    // GraphQL errors come with a 200: graphqlData() throws them.
    await graphqlData(res, name);
  }

  // The run and pull request a request is about, once the run may ask: { run, repo, number,
  // action, ref, github }, or nothing once refused.
  function admit(req, res) {
    const path = PATH.exec(new URL(req.url, "http://broker").pathname);
    if (!path) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
    const run = scheme === "Bearer" ? broker.runOf(secret) : undefined;
    if (!run) return send(res, 401, { error: "unknown or finished run" });

    const repo = `${path[1]}/${path[2]}`.toLowerCase();
    const number = Number(path[3]);
    const action = path[4];
    const ref = `${repo}#${number}`;
    if (run.repo !== repo) {
      return send(res, 403, { error: `this run can only change ${run.repo}'s pull requests` });
    }
    // Light runs (brainstorms, inbox entries, onboarding, a repo's light modes) only comment.
    if (!run.push) return send(res, 403, { error: "this run can't change pull requests" });

    const github = app();
    if (!github) return send(res, 503, { error: "the GitHub App is not set up" });
    return { run, repo, number, action, ref, github };
  }

  // The pull request, once it is the run's own: of its repo, not from a fork, from a branch
  // the run may push. Nothing once refused.
  async function ownPullRequest(res, { run, repo, number, ref, github }) {
    let pr;
    try {
      const found = await github.request(
        repo,
        "GET",
        `/repos/${repo}/pulls/${number}`,
        undefined,
        [404],
      );
      if (found.status === 404) return send(res, 404, { error: `no pull request ${ref}` });
      if (!found.ok) throw new Error(`pull request lookup: ${found.status}`);
      pr = await found.json();
    } catch (error) {
      log(`Pull requests: ${ref}: ${error.message ?? error}`);
      return send(res, 502, { error: "couldn't look the pull request up; try again" });
    }
    // A fork's head isn't the run's to vouch for; a deleted fork has no head repo at all.
    if (pr.base?.repo?.full_name?.toLowerCase() !== repo) {
      return send(res, 403, { error: `${ref} is not a pull request of ${repo}` });
    }
    if (pr.head?.repo?.full_name?.toLowerCase() !== repo) {
      return send(res, 403, { error: `${ref} comes from a fork` });
    }
    // Another task's pull request, or a maintainer's, is not this run's to change.
    if (!branchAllowed(run.branches, pr.head.ref)) {
      return send(res, 403, { error: `${ref}'s branch, ${pr.head.ref}, is not this run's` });
    }
    return pr;
  }

  async function handle(req, res) {
    const asked = admit(req, res);
    if (!asked) return;
    const pr = await ownPullRequest(res, asked);
    if (!pr) return;
    const { repo, action, ref, github } = asked;

    const wanted = action === "draft";
    const state = wanted ? "a draft" : "ready for review";
    if (pr.draft === wanted) return send(res, 200, { message: `${ref} is already ${state}` });
    // Conflicts with its base: not ready, whatever the run thinks. Only `dirty` is refused:
    // GitHub computes the state lazily (`unknown`, null) and the rest (checks, reviews) is
    // for the reviewer to weigh.
    if (!wanted && pr.mergeable_state === "dirty") {
      const base = pr.base?.ref ?? "the base branch";
      return send(res, 409, {
        error: `${ref} conflicts with ${base}: rebase on origin/${base} first (git fetch origin, git rebase origin/${base}, git push --force-with-lease)`,
      });
    }
    try {
      const { token } = await github.repoToken(repo, PUSH_PERMISSIONS);
      await mutate(token, action, pr.node_id);
    } catch (error) {
      log(`Pull requests: ${ref}: ${error.message ?? error}`);
      return send(res, 502, { error: `GitHub refused to mark ${ref} as ${state}` });
    }
    log(`Pull requests: ${ref} marked as ${state}`);
    send(res, 200, { message: `${ref} is marked as ${state}` });
  }

  return { handle };
}
