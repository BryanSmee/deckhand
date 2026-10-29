// What a run may write to GitHub over REST (issue #405): each write the GitHub gateway relays
// (github-gateway.mjs) is classified from its method, path and body into actions on a target,
// the target's kind is resolved from GitHub (never from the request), and the write goes on only
// when its mode's ceiling (modes.mjs ceilingOf()) holds each action on that kind and the
// policies' `deny_github` (policies.mjs) refuses nothing. A write it can't classify is refused.
// GraphQL's writes are #406's: they go on as the token allows until then.
//
// Kinds: `own_issue` (the run's issue), `own_pr` (the run's pull request, or one from a branch
// it may push: broker.mjs allow()), `sub_issue` (an issue whose parent is the run's, in its
// repo), `created_issue` (one this run created: by the App's bot, since the run started, as
// GitHub says, however it was created: `gh issue create` is GraphQL),
// `other_issue`, `pr`, `new_issue` (an issue it creates), `label` (a label of the repo it
// creates), and `new_pr`, `comment`, `review` for writes no ceiling allows anyway.
//
// A sub-issue link names two issues: its target is the parent, in the path, and the child, by
// its id in the body, must be one the run created or one already under the run's issue (a
// REST issue can't be looked up by its id: the repo's newest issues and the run's issue's
// sub-issues carry theirs). Moving an issue from another parent (`replace_parent`, any value
// but false) is in no ceiling: a link would otherwise take any issue under the run's.
// Format of the policies' input: ../docs/repo-config.md#the-github-input.
import { branchAllowed } from "./broker.mjs";
import { ceilingOf } from "./modes.mjs";

// Actions on another target than an issue or pull request by number: no ceiling holds them,
// so they are refused before any look-up.
const ID_TARGETS = new Set(["comment", "review", "new_pr"]);

// The label names of a body's `labels` (strings, or objects with a name), or of the body itself
// when it is the list (PUT …/labels takes either).
function labelNames(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((l) => typeof l === "string");
}

// PATCH of an issue or a pull request: what each field it sets is. A state changes first, then
// labels, assignees and the milestone, then the rest (title, body, base…): the actions in that
// order, the first being the write's `action`.
function patched(body) {
  const actions = [];
  const keys = Object.keys(body);
  if ("state" in body) actions.push(body.state === "closed" ? "close" : "reopen");
  if ("labels" in body) actions.push("label");
  actions.push(...assigned(body));
  const rest = ["state", "state_reason", "labels", "assignees", "assignee", "milestone"];
  if (!actions.length || keys.some((k) => !rest.includes(k))) actions.push("edit");
  // Labels set replace the issue's: what they remove is known once it is looked up.
  const change = { labels_added: labelNames(body.labels) };
  return { actions, change: "labels" in body ? { ...change, labels_set: true } : change };
}

// The assignees and milestone a body sets, which a create and an edit both take.
function assigned(body) {
  const actions = [];
  if ("assignees" in body || "assignee" in body) actions.push("assign");
  if ("milestone" in body) actions.push("milestone");
  return actions;
}

// A sub-issue link's child: the `sub_issue_id` of its body, and whether it may leave another
// parent: `replace_parent` with any value but false, however GitHub would read it. Null
// without one: GitHub needs it.
function child(body) {
  const id = Number(body.sub_issue_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { id, replace_parent: "replace_parent" in body && body.replace_parent !== false };
}

// [method, path under the repo (case-insensitive), match → { actions, target, change }].
// `number`: an issue's or pull request's; `body`: the write's JSON.
const ROUTES = [
  [
    "POST",
    /^issues$/i,
    (m, body) => ({
      actions: ["create", ...assigned(body)],
      target: { kind: "new_issue" },
      change: { labels_added: labelNames(body.labels) },
    }),
  ],
  [
    "PATCH",
    /^(?:issues|pulls)\/(\d+)$/i,
    (m, body) => ({ ...patched(body), target: { number: +m[1] } }),
  ],
  [
    "POST",
    /^issues\/(\d+)\/comments$/i,
    (m) => ({ actions: ["comment"], target: { number: +m[1] } }),
  ],
  [
    "POST",
    /^issues\/(\d+)\/labels$/i,
    (m, body) => ({
      actions: ["label"],
      target: { number: +m[1] },
      change: { labels_added: labelNames(Array.isArray(body) ? body : body.labels) },
    }),
  ],
  [
    "PUT",
    /^issues\/(\d+)\/labels$/i,
    (m, body) => ({
      actions: ["label"],
      target: { number: +m[1] },
      change: {
        labels_added: labelNames(Array.isArray(body) ? body : body.labels),
        labels_set: true,
      },
    }),
  ],
  [
    "DELETE",
    /^issues\/(\d+)\/labels(?:\/(.+))?$/i,
    (m) => ({
      actions: ["label"],
      target: { number: +m[1] },
      change: { labels_removed: m[2] === undefined ? ["*"] : [m[2]] },
    }),
  ],
  [
    "POST",
    /^issues\/(\d+)\/sub_issues$/i,
    (m, body) => ({ actions: ["link"], target: { number: +m[1] }, child: child(body) }),
  ],
  [
    /^(?:DELETE|PATCH)$/,
    /^issues\/(\d+)\/(?:sub_issue|sub_issues\/priority)$/i,
    (m, body) => ({ actions: ["link"], target: { number: +m[1] }, child: child(body) }),
  ],
  [
    /^(?:POST|DELETE)$/,
    /^issues\/(\d+)\/assignees$/i,
    (m) => ({ actions: ["assign"], target: { number: +m[1] } }),
  ],
  [
    /^(?:PUT|DELETE)$/,
    /^issues\/(\d+)\/lock$/i,
    (m) => ({ actions: ["lock"], target: { number: +m[1] } }),
  ],
  [
    "POST",
    /^issues\/(\d+)\/reactions$/i,
    (m) => ({ actions: ["react"], target: { number: +m[1] } }),
  ],
  [
    "DELETE",
    /^issues\/(\d+)\/reactions\/\d+$/i,
    (m) => ({ actions: ["delete"], target: { number: +m[1] } }),
  ],
  [
    "PATCH",
    /^(?:issues|pulls)\/comments\/\d+$/i,
    () => ({ actions: ["edit"], target: { kind: "comment" } }),
  ],
  [
    "DELETE",
    /^(?:issues|pulls)\/comments\/\d+(?:\/reactions\/\d+)?$/i,
    () => ({ actions: ["delete"], target: { kind: "comment" } }),
  ],
  [
    "POST",
    /^(?:issues|pulls)\/comments\/\d+\/reactions$/i,
    () => ({ actions: ["react"], target: { kind: "comment" } }),
  ],
  [
    "POST",
    /^labels$/i,
    (m, body) => ({
      actions: ["create"],
      target: { kind: "label" },
      change: { labels_added: labelNames([body.name]) },
    }),
  ],
  ["PATCH", /^labels\/.+$/i, () => ({ actions: ["edit"], target: { kind: "label" } })],
  ["DELETE", /^labels\/.+$/i, () => ({ actions: ["delete"], target: { kind: "label" } })],
  ["POST", /^pulls$/i, () => ({ actions: ["create"], target: { kind: "new_pr" } })],
  ["PUT", /^pulls\/(\d+)\/merge$/i, (m) => ({ actions: ["merge"], target: { number: +m[1] } })],
  [
    "PUT",
    /^pulls\/(\d+)\/update-branch$/i,
    (m) => ({ actions: ["update_branch"], target: { number: +m[1] } }),
  ],
  // Reviews, their comments and their requests: in no ceiling.
  [
    /^(?:POST|PUT|PATCH|DELETE)$/,
    /^pulls\/\d+\/(?:reviews|comments|requested_reviewers)(?:\/.*)?$/i,
    () => ({ actions: ["review"], target: { kind: "review" } }),
  ],
];

// A write → { repo, actions, target: { number } | { kind }, child (a link's: { id,
// replace_parent }), change: { fields, labels_added, labels_removed, labels_set (the labels
// it sets replace the issue's) } }, `{ read: true }` for a POST that writes nothing (rendering markdown), or
// null when it can't be classified. `path`: under the API's base, decoded, without its query
// (github-gateway.mjs route()); `body`: the bytes sent.
export function classify(method, path, body) {
  const clean = String(path).replace(/^\/+|\/+$/g, "");
  if (method === "POST" && /^markdown(?:\/raw)?$/i.test(clean)) return { read: true };
  const at = /^repos\/([^/]+)\/([^/]+)\/(.+)$/i.exec(clean);
  if (!at) return null;
  const [, owner, name, rest] = at;
  let json = {};
  const text = body?.length ? body.toString("utf8").trim() : "";
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (json === null || typeof json !== "object") return null;
  for (const [verb, route, build] of ROUTES) {
    const ok = typeof verb === "string" ? verb === method : verb.test(method);
    if (!ok) continue;
    const m = route.exec(rest);
    if (!m) continue;
    const write = build(m, json);
    // A link without its child can't be checked.
    if (write.child === null) return null;
    return {
      repo: `${owner}/${name}`.toLowerCase(),
      actions: write.actions,
      target: write.target,
      ...(write.child && { child: write.child }),
      change: {
        fields: Array.isArray(json) ? [] : Object.keys(json),
        labels_added: [],
        labels_removed: [],
        ...write.change,
      },
    };
  }
  return null;
}

// The actions of `actions` that `ceiling` doesn't hold on `kind`.
export function aboveCeiling(ceiling, kind, actions) {
  const allowed = ceiling[kind] ?? [];
  return actions.filter((a) => !allowed.includes(a));
}

// Whether `ceiling` holds every action of `actions` on some kind: a write none of whose kinds
// could pass is refused before GitHub is asked what its target is.
function anyKindHolds(ceiling, actions) {
  return Object.values(ceiling).some((allowed) => actions.every((a) => allowed.includes(a)));
}

// How many pages of the repo's newest issues a link's child is looked for in: they go back to
// the run's start, so a busy repo's are all there.
const MAX_PAGES = 5;

// `lookup(repo, path)`: GitHub's JSON with the listener's token, null for a 404 (github.mjs
// getJson()); `bot()`: the App's login (`slug[bot]`), null before /setup; `policies`:
// policies.mjs's, null without; `log`: the listener's.
export function createWriteChecks({ lookup, bot = () => null, policies = null, log = () => {} }) {
  // Whether GitHub's issue is one `run` created: by the App's bot, since the run started.
  // Another run of the App's that created one meanwhile is the only other author it could be.
  function created(run, issue) {
    const login = bot();
    if (!login || !Number.isFinite(run.since)) return false;
    if (String(issue?.user?.login ?? "").toLowerCase() !== login.toLowerCase()) return false;
    return Date.parse(issue.created_at) >= run.since && !issue.pull_request;
  }

  // The target's kind, number, labels and author, from GitHub. Null when it isn't there.
  async function resolve(run, repo, number) {
    const issue = await lookup(repo, `/repos/${repo}/issues/${number}`);
    if (!issue) return null;
    const target = {
      number,
      labels: labelNames(issue.labels),
      author: issue.user?.login ?? null,
    };
    if (issue.pull_request) {
      const pr = await lookup(repo, `/repos/${repo}/pulls/${number}`);
      if (!pr) return null;
      const head = pr.head ?? {};
      const branch =
        head.repo?.full_name?.toLowerCase() === repo && branchAllowed(run.branches ?? [], head.ref);
      return { ...target, kind: number === run.issue || branch ? "own_pr" : "pr" };
    }
    if (number === run.issue) return { ...target, kind: "own_issue" };
    const parent = await lookup(repo, `/repos/${repo}/issues/${number}/parent`);
    // Sub-issues cross repositories: the run's #n is its repo's.
    const sub = run.issue != null && parent?.number === run.issue && inRepo(parent, repo);
    if (sub) return { ...target, kind: "sub_issue" };
    return { ...target, kind: created(run, issue) ? "created_issue" : "other_issue" };
  }

  // A link's child → { id, number, kind }: `sub_issue` when it is already under the run's issue
  // (its sub-issues list them with their ids), `created_issue` when the run created it (among
  // the repo's newest issues, back to the run's start), else `other_issue`.
  async function resolveChild(run, repo, { id }) {
    if (run.issue != null) {
      const subs = await lookup(repo, `/repos/${repo}/issues/${run.issue}/sub_issues?per_page=100`);
      const found = Array.isArray(subs) ? subs.find((i) => i?.id === id) : null;
      if (found) return { id, number: found.number ?? null, kind: "sub_issue" };
    }
    if (bot() && Number.isFinite(run.since)) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const issues = await lookup(
          repo,
          `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
        );
        if (!Array.isArray(issues) || !issues.length) break;
        const found = issues.find((i) => i?.id === id);
        if (found) {
          const kind = created(run, found) ? "created_issue" : "other_issue";
          return { id, number: found.number ?? null, kind };
        }
        // Older than the run: none further on is its own.
        if (Date.parse(issues.at(-1)?.created_at) < run.since) break;
      }
    }
    return { id, number: null, kind: "other_issue" };
  }

  // A run's write → null when it may go on, else { status, message }: GitHub's status and why,
  // which `gh` prints. `path`, `body`: classify()'s.
  async function check(run, { method, path, body }) {
    const write = classify(method, path, body);
    if (write?.read) return null;
    if (!write) {
      return refusal(403, "it can't tell what this write does, so it refuses it");
    }
    if (write.repo !== run.repo) {
      return refusal(403, "a run writes only to its own repository");
    }
    const ceiling = ceilingOf(run.mode, !run.push);
    const mode = run.mode ?? "this";
    const what = write.actions.join(", ");
    if (!anyKindHolds(ceiling, write.actions) || ID_TARGETS.has(write.target.kind)) {
      return refusal(403, `a ${mode} run can't ${what} here (its ceiling)`);
    }
    if (write.child?.replace_parent) {
      return refusal(403, "a run can't move an issue from another parent (replace_parent)");
    }
    let target = write.target;
    if (target.number !== undefined) {
      try {
        target = await resolve(run, write.repo, target.number);
      } catch (error) {
        log(`GitHub gateway: ${run.repo}#${write.target.number}: ${error.message ?? error}`);
        return refusal(502, `#${write.target.number} can't be looked up on GitHub`);
      }
      if (!target) return refusal(404, `#${write.target.number} isn't there`);
    } else {
      target = { number: null, labels: [], author: null, ...target };
    }
    const above = aboveCeiling(ceiling, target.kind, write.actions);
    if (above.length) {
      const on = target.number === null ? target.kind : `${target.kind} #${target.number}`;
      return refusal(403, `a ${mode} run can't ${above.join(", ")} on ${on} (its ceiling)`);
    }
    const change = { ...write.change };
    // Labels that replace the issue's remove those they leave out.
    if (change.labels_set) {
      const kept = new Set(change.labels_added.map((l) => l.toLowerCase()));
      change.labels_removed = target.labels.filter((l) => !kept.has(l.toLowerCase()));
    }
    delete change.labels_set;
    if (write.child) {
      let sub;
      try {
        sub = await resolveChild(run, write.repo, write.child);
      } catch (error) {
        log(`GitHub gateway: ${run.repo} sub-issue ${write.child.id}: ${error.message ?? error}`);
        return refusal(502, "the sub-issue can't be looked up on GitHub");
      }
      if (!LINKABLE.has(sub.kind)) {
        return refusal(
          403,
          "a run links only issues it created, or those already under its issue (its ceiling)",
        );
      }
      change.sub_issue = sub;
    }
    if (!policies) return null;
    const input = {
      repo: run.repo,
      mode: run.mode,
      issue: run.issue ?? null,
      action: write.actions[0],
      actions: write.actions,
      target,
      change,
    };
    const messages = await policies.deny("deny_github", run.repo, run.base || "main", () => input);
    if (!messages.length) return null;
    return refusal(403, `the policies refuse it (deny_github): ${messages.join("; ")}`);
  }

  return { check };
}

// The children a link may name (resolveChild()).
const LINKABLE = new Set(["sub_issue", "created_issue"]);

// Whether GitHub's issue (or parent) is in `repo` ("owner/name", lower case).
function inRepo(issue, repo) {
  const url = String(issue?.repository_url ?? "").toLowerCase();
  return url.endsWith(`/repos/${repo}`);
}

const refusal = (status, message) => ({ status, message });
