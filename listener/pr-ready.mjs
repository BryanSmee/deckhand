// A work run's pull request writes, which its token can't make: it only reads pull requests
// (github-app.mjs, SANDBOX_PERMISSIONS), since `pull_requests: write` would also let it approve
// any pull request of its repo, or replace the review mode's verdict, as the App.
//
// - Ready for review, or back to draft: GitHub only lets an App's token do either with
//   `contents: write` (markPullRequestReadyForReview, convertPullRequestToDraft).
// - Open a pull request from one of the run's branches, or edit the title and body of one.
//
// The sandbox's gh wrapper (../sandbox/gh) sends `gh pr ready [--undo]`, `gh pr create` and
// `gh pr edit` here instead, with the run's secret; the listener checks the pull request is
// the run's repo's own, from a branch of that repo the run may push (broker.mjs allow()), and
// makes the change with a token of its own that the sandbox never sees.
//
// Opening, editing, readying or drafting a pull request runs its workflows from a new merge of
// its branch with its base: for a repo granted `allow_workflows`, its workflow files are
// checked in that merge first, as the git gateway checks a push (git-gateway.mjs
// checkBranch()).
//
// Served on the broker's port, which only the runs' networks reach.
import { branchAllowed, NOT_ITS_SANDBOX } from "./broker.mjs";
import { GITHUB_HEADERS, PUSH_PERMISSIONS } from "./github-app.mjs";
import { graphqlData } from "./github.mjs";
import { readJsonBody, Refused, send } from "./web.mjs";

// /pr/<owner>/<repo>/<number>/<ready|draft|edit>, or /pr/<owner>/<repo>/create.
const PATH = /^\/pr\/([\w.-]+)\/([\w.-]+)\/(?:(\d+)\/(ready|draft|edit)|(create))$/;
// GitHub takes 65536 characters of body: up to four bytes each, escaped in JSON.
const BODY_LIMIT = 1024 * 1024;

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
  // (repo, branch, base) => why its workflows can't run merged with `base`, or null.
  checkWorkflows = async () => null,
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
  async function admit(req, res) {
    const path = PATH.exec(new URL(req.url, "http://broker").pathname);
    if (!path) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
    const run = scheme === "Bearer" ? broker.runOf(secret) : undefined;
    if (!run) return send(res, 401, { error: "unknown or finished run" });
    if (!(await broker.sentBy(run, req))) return send(res, 403, { error: NOT_ITS_SANDBOX });

    const repo = `${path[1]}/${path[2]}`.toLowerCase();
    const number = path[3] ? Number(path[3]) : null;
    const action = path[4] ?? path[5];
    const ref = number ? `${repo}#${number}` : repo;
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
    const asked = await admit(req, res);
    if (!asked) return;
    if (asked.action === "create") return create(req, res, asked);
    const pr = await ownPullRequest(res, asked);
    if (!pr) return;
    // Each change is an event (`edited`, `ready_for_review`, `converted_to_draft`) that runs
    // the pull request's workflows from a new merge with its base.
    const pass = () => workflowsPass(res, asked.ref, pr.head.ref, pr.base?.ref, asked);
    if (asked.action === "edit") return (await pass()) && edit(req, res, asked);
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
    if (!(await pass())) return;
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

  // Whether `branch`'s workflows may run merged with `base`; once refused, false.
  async function workflowsPass(res, ref, branch, base, { repo }) {
    let why;
    try {
      why = await checkWorkflows(repo, branch, base);
    } catch (error) {
      log(`Pull requests: ${ref}: ${error.message ?? error}`);
      send(res, 502, { error: `couldn't check ${branch}'s workflow files; try again` });
      return false;
    }
    if (!why) return true;
    log(`Pull requests: ${ref}: refused: ${why}`);
    send(res, 422, { error: `Deckhand: ${why}` });
    return false;
  }

  // The request's JSON object, or nothing once refused (400, 413).
  async function readFields(req, res) {
    try {
      const fields = await readJsonBody(req, BODY_LIMIT);
      if (fields && typeof fields === "object" && !Array.isArray(fields)) return fields;
      return send(res, 400, { error: "expected a JSON object" });
    } catch (error) {
      if (error instanceof Refused) return send(res, error.status, { error: error.message });
      throw error;
    }
  }

  // The fields GitHub gets: `title` and `body` when given, as strings, and a title never blank.
  // An error message for the first one that isn't.
  function texts(fields) {
    const out = {};
    for (const name of ["title", "body"]) {
      if (fields[name] === undefined) continue;
      if (typeof fields[name] !== "string") return `${name} must be a string`;
      out[name] = fields[name];
    }
    if (out.title !== undefined && !out.title.trim()) return "the title can't be empty";
    return out;
  }

  // GitHub's reason for a 422 (a pull request already open for the branch, no commits
  // between the branches…), else its status.
  async function refusal(found) {
    const answer = await found.json().catch(() => ({}));
    const reasons = (answer.errors ?? []).map((e) => e.message ?? e.code).filter(Boolean);
    return reasons.join("; ") || answer.message || `GitHub answered ${found.status}`;
  }

  // A pull request from one of the run's branches (`head`, a branch of its repo: never
  // `owner:branch`), into `base` or the repo's default branch.
  async function create(req, res, { run, repo, github }) {
    const fields = await readFields(req, res);
    if (!fields) return;
    const asked = texts(fields);
    if (typeof asked === "string") return send(res, 400, { error: asked });
    const { head, base, draft = false } = fields;
    if (!asked.title) return send(res, 400, { error: "a pull request needs a title" });
    if (typeof head !== "string" || !head || head.includes(":")) {
      return send(res, 400, { error: "head must be a branch of this repository" });
    }
    if (base !== undefined && (typeof base !== "string" || !base)) {
      return send(res, 400, { error: "base must be a branch name" });
    }
    if (typeof draft !== "boolean") return send(res, 400, { error: "draft must be true or false" });
    if (!branchAllowed(run.branches, head)) {
      return send(res, 403, { error: `${head} is not this run's branch` });
    }
    let into = base;
    if (!into) {
      try {
        const info = await github.request(repo, "GET", `/repos/${repo}`);
        if (!info.ok) throw new Error(`repository lookup: ${info.status}`);
        into = (await info.json()).default_branch;
      } catch (error) {
        log(`Pull requests: ${repo}: ${error.message ?? error}`);
        return send(res, 502, { error: `couldn't open a pull request from ${head}; try again` });
      }
    }
    if (!(await workflowsPass(res, repo, head, into, { repo }))) return;
    let found;
    try {
      found = await github.request(
        repo,
        "POST",
        `/repos/${repo}/pulls`,
        { ...asked, body: asked.body ?? "", head, base: into, draft },
        [422],
      );
      if (found.status === 422) {
        return send(res, 422, { error: `GitHub refused it: ${await refusal(found)}` });
      }
      if (!found.ok) throw new Error(`pull request creation: ${found.status}`);
    } catch (error) {
      log(`Pull requests: ${repo}: ${error.message ?? error}`);
      return send(res, 502, { error: `couldn't open a pull request from ${head}; try again` });
    }
    const pr = await found.json();
    log(`Pull requests: ${repo}#${pr.number} opened from ${head}`);
    send(res, 201, { message: `${repo}#${pr.number} is open`, url: pr.html_url });
  }

  // The title or body of the run's own pull request (ownPullRequest()): nothing else.
  async function edit(req, res, { repo, number, ref, github }) {
    const fields = await readFields(req, res);
    if (!fields) return;
    const asked = texts(fields);
    if (typeof asked === "string") return send(res, 400, { error: asked });
    if (!Object.keys(asked).length) return send(res, 400, { error: "nothing to change" });
    let found;
    try {
      found = await github.request(repo, "PATCH", `/repos/${repo}/pulls/${number}`, asked, [422]);
      if (found.status === 422) {
        return send(res, 422, { error: `GitHub refused it: ${await refusal(found)}` });
      }
      if (!found.ok) throw new Error(`pull request edit: ${found.status}`);
    } catch (error) {
      log(`Pull requests: ${ref}: ${error.message ?? error}`);
      return send(res, 502, { error: `couldn't edit ${ref}; try again` });
    }
    const pr = await found.json();
    log(`Pull requests: ${ref} edited (${Object.keys(asked).join(", ")})`);
    send(res, 200, { message: `${ref} is edited`, url: pr.html_url });
  }

  return { handle };
}
