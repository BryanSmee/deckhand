// What a run may write to GitHub (issue #405): each REST write the GitHub gateway relays
// (github-gateway.mjs) is classified from its method, path and body into actions on a target,
// the target's kind is resolved from GitHub (never from the request), and the write goes on only
// when its mode's ceiling (modes.mjs ceilingOf()) holds each action on that kind and the
// policies' `deny_github` (policies.mjs) refuses nothing. A write it can't classify is refused.
// GraphQL's mutations are classified by github-graphql.mjs (#406), each into the same shape,
// and held to the same checks (checkWrite()). A pull request's own writes (opening, editing,
// readying, drafting one) are then held to github-pulls.mjs's checks too.
//
// Kinds: `own_issue` (the run's issue), `own_pr` (the run's pull request, or one from a branch
// it may push: broker.mjs allow()), `sub_issue` (an issue whose parent is the run's, in its
// repo), `created_issue` (one this run created: GitHub answered the run's own create with it,
// over REST or GraphQL, as `gh issue create` sends: answered()),
// `other_issue`, `pr`, `new_issue` (an issue it creates), `new_pr` (a pull request it opens),
// `label` (a label of the repo it creates), and `comment`, `review` for writes no ceiling
// allows anyway.
//
// A sub-issue link names two issues: its target is the parent, in the path, and the child, by
// its id in the body, must be one the run created or one already under the run's issue (a
// REST issue can't be looked up by its id: the run's issue's sub-issues and the issues it
// created carry theirs). Moving an issue from another parent (`replace_parent`, any value
// but false) is in no ceiling: a link would otherwise take any issue under the run's.
// A "blocked by" link (issue #437) is a `link` too: its target is the blocked issue, in the
// path, and its blocker, by its id (the body's `issue_id`, or the path's when removed), one the
// run created, one under its issue, or any open issue of its repository (resolveBlocker()).
// Format of the policies' input: ../docs/repo-config.md#the-github-input.
import { branchAllowed } from "./broker.mjs";
import { createPullChecks, PULL_WRITE } from "./github-pulls.mjs";
import { ceilingOf, issueLabelOf } from "./modes.mjs";

// Actions on another target than an issue or pull request by number: no ceiling holds them,
// so they are refused before any look-up.
const ID_TARGETS = new Set(["comment", "review"]);

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

// A "blocked by" link's blocker: its `issue_id`, a positive integer. Null without one.
function blocker(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? { id } : null;
}

// [method, path under the repo (case-insensitive), match → { actions, target, change, pull,
// permissions }]: `pull`, a pull request's own write's head, base and draft (github-pulls.mjs),
// `permissions`, its token's (PULL_WRITE).
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
  ["PATCH", /^issues\/(\d+)$/i, (m, body) => ({ ...patched(body), target: { number: +m[1] } })],
  [
    "PATCH",
    /^pulls\/(\d+)$/i,
    (m, body) => ({
      ...patched(body),
      target: { number: +m[1] },
      pull: { base: body.base },
      permissions: PULL_WRITE,
    }),
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
    "POST",
    /^issues\/(\d+)\/dependencies\/blocked_by$/i,
    (m, body) => ({
      actions: ["link"],
      target: { number: +m[1] },
      blocker: blocker(body.issue_id),
    }),
  ],
  [
    "DELETE",
    /^issues\/(\d+)\/dependencies\/blocked_by\/(\d+)$/i,
    (m) => ({ actions: ["link"], target: { number: +m[1] }, blocker: blocker(m[2]) }),
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
  [
    "POST",
    /^pulls$/i,
    (m, body) => ({
      actions: ["create"],
      target: { kind: "new_pr" },
      pull: { head: body.head, base: body.base, draft: body.draft === true },
      permissions: PULL_WRITE,
    }),
  ],
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
// replace_parent }), blocker (a "blocked by" link's: { id }), change: { fields, labels_added,
// labels_removed, labels_set (the labels it sets replace the issue's) }, pull, permissions (ROUTES') }, `{ read: true }` for a POST that writes nothing (rendering markdown), or
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
    // A link without its child or its blocker can't be checked.
    if (write.child === null || write.blocker === null) return null;
    return {
      repo: `${owner}/${name}`.toLowerCase(),
      actions: write.actions,
      target: write.target,
      ...(write.child && { child: write.child }),
      ...(write.blocker && { blocker: write.blocker }),
      ...(write.pull && { pull: write.pull, permissions: write.permissions }),
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

// The issues a run created that a link's child is looked for among: a run files a few.
const MAX_CREATED = 100;
// The pages of the repo's open issues, newest first, that a "blocked by" link's blocker named
// by its id only (REST) is looked for among, past the run's own: GitHub can't look an issue up
// by its id. GraphQL's names it by its node ID, looked up whatever the repo holds.
const MAX_OPEN_PAGES = 10;
const PAGE = 100;
// How much earlier than the call that created it GitHub may say an issue was created: the
// listener's and GitHub's clocks differ, and `created_at` is in seconds.
const SKEW_MS = 2 * 60_000;

// `lookup(repo, path)`: GitHub's JSON with the listener's token, null for a 404 (github.mjs
// getJson()); `bot()`: the App's login (`slug[bot]`), null before /setup; `policies`:
// policies.mjs's, null without; `pulls`: github-pulls.mjs's checks (its workflow check and
// record, none by default); `log`: the listener's.
export function createWriteChecks({
  lookup,
  bot = () => null,
  policies = null,
  pulls = createPullChecks({ lookup }),
  log = () => {},
}) {
  // Whether GitHub's issue is one `run` created: GitHub answered one of the run's own creates
  // with it (answered()), it is no older than that call, and the App's bot wrote it. The bot
  // files issues for every run and for the listener too: its authorship alone says nothing.
  function created(run, issue) {
    if (issue?.pull_request) return false;
    const login = bot();
    if (!login || String(issue?.user?.login ?? "").toLowerCase() !== login.toLowerCase()) {
      return false;
    }
    const made = (run.created ?? []).find((c) => c.number === issue?.number);
    return !!made && Date.parse(issue.created_at) >= made.at - SKEW_MS;
  }

  // The target's kind, number, labels and author, from GitHub. Null when it isn't there.
  async function resolve(run, repo, number, lookup) {
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
  // (its sub-issues list them with their ids), `created_issue` when the run created it (the
  // issues it created, looked up: their ids are GitHub's), else `other_issue`. A GraphQL
  // link's child comes with its number and repo, resolved from its node ID: resolved as a
  // target is.
  async function resolveChild(run, repo, { id, number, repo: at }, lookup) {
    if (number !== undefined) {
      if (at !== repo) return { id, number, kind: "other_issue" };
      const found = await resolve(run, repo, number, lookup);
      return { id, number, kind: found?.kind ?? "other_issue" };
    }
    if (run.issue != null) {
      // One page: GitHub takes 100 sub-issues per parent at most.
      const subs = await lookup(repo, `/repos/${repo}/issues/${run.issue}/sub_issues?per_page=100`);
      const found = Array.isArray(subs) ? subs.find((i) => i?.id === id) : null;
      if (found) return { id, number: found.number ?? null, kind: "sub_issue" };
    }
    for (const { number } of (run.created ?? []).slice(-MAX_CREATED)) {
      const issue = await lookup(repo, `/repos/${repo}/issues/${number}`);
      if (issue?.id === id && created(run, issue)) return { id, number, kind: "created_issue" };
    }
    return { id, number: null, kind: "other_issue" };
  }

  // A "blocked by" link's blocker → { id, number, kind }: as resolveChild() finds a child, and
  // else, when it is an open issue of the repo (never a pull request), its kind as a target's
  // (resolve()). `open` says whether it may block: an issue the run created or under its
  // issue, whatever its state, or an open one. A GraphQL blocker comes with its number and
  // repo, resolved from its node ID.
  async function resolveBlocker(run, repo, { id, number, repo: at }, lookup) {
    if (number === undefined) {
      const found = await resolveChild(run, repo, { id }, lookup);
      if (LINKABLE.has(found.kind)) return { ...found, open: true };
      number = await openNumber(repo, id, lookup);
      if (number === null) return { id, number: null, kind: "other_issue", open: false };
    } else if (at !== repo) {
      return { id, number, kind: "other_issue", open: false };
    }
    const target = await resolve(run, repo, number, lookup);
    const kind = target?.kind ?? "other_issue";
    if (LINKABLE.has(kind)) return { id, number, kind, open: true };
    const issue = await lookup(repo, `/repos/${repo}/issues/${number}`);
    const open = !issue?.pull_request && issue?.state === "open";
    return { id, number, kind, open };
  }

  // The number of the repo's open issue whose id is `id`, among its newest (MAX_OPEN_PAGES),
  // or null.
  async function openNumber(repo, id, lookup) {
    for (let page = 1; page <= MAX_OPEN_PAGES; page++) {
      const list = await lookup(
        repo,
        `/repos/${repo}/issues?state=open&per_page=${PAGE}&page=${page}`,
      );
      if (!Array.isArray(list)) return null;
      const found = list.find((i) => i?.id === id && !i.pull_request);
      if (found) return found.number ?? null;
      if (list.length < PAGE) return null;
    }
    return null;
  }

  // GitHub's answer to a run's write that went on (github-gateway.mjs wroteWrite()): the pull
  // requests it changed go to the dashboard (github-pulls.mjs answered()), and the issues it
  // created, from a REST create (201, its JSON) or a GraphQL `createIssue` (what `gh issue
  // create` sends: `data.<its response key>.issue`, by its URL, `creates` naming the keys:
  // github-graphql.mjs), in the run's repo, are kept on the run (`run.created`, saved with it:
  // restart.mjs), with when the call was sent.
  function answered(run, call, status, answer) {
    const { method, path, body, graphql, creates = [], at } = call;
    pulls
      .answered(run, call, status, answer)
      .catch((error) => log(`GitHub gateway: ${run.repo}: ${error.stack ?? error}`));
    let json;
    try {
      json = JSON.parse(answer.toString("utf8"));
    } catch {
      return;
    }
    let issues;
    if (graphql) {
      if (status !== 200) return;
      issues = creates.map((key) => json?.data?.[key]?.issue);
    } else {
      const write = classify(method, path, body);
      if (status !== 201 || write?.target?.kind !== "new_issue" || write.repo !== run.repo) return;
      if (!inRepo(json, run.repo)) return;
      issues = [json];
    }
    if (!Array.isArray(run.created)) return;
    let added = false;
    for (const issue of issues) {
      const number = numberOf(issue, run.repo);
      if (number === null || run.created.some((c) => c.number === number)) continue;
      run.created.push({ number, at });
      added = true;
    }
    if (added) run.createdChanged?.();
  }

  // A run's REST write → null when it may go on, else { status, message }: GitHub's status and
  // why, which `gh` prints. `path`, `body`: classify()'s.
  async function check(run, { method, path, body }) {
    const write = classify(method, path, body);
    if (write?.read) return null;
    if (!write) {
      return refusal(403, "it can't tell what this write does, so it refuses it");
    }
    return checkWrite(run, write);
  }

  // A classified write (classify()'s shape, or a GraphQL mutation's: github-graphql.mjs) → the
  // same as check(). `memo`: a Map that keeps GitHub's answers across the writes of one call (a
  // GraphQL call's several fields), so the same target is looked up once.
  async function checkWrite(run, write, memo = new Map()) {
    const get = (repo, path) => {
      const key = `${repo} ${path}`;
      if (!memo.has(key)) memo.set(key, lookup(repo, path));
      return memo.get(key);
    };
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
        target = await resolve(run, write.repo, target.number, get);
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
    // An inbox run's issues carry its label (prompts/idea.md, bug.md): in its ceiling too.
    const label = issueLabelOf(run.mode);
    const labelled = write.change.labels_added.some((l) => l.toLowerCase() === label);
    if (label && target.kind === "new_issue" && !labelled) {
      return refusal(403, `${mode} runs' issues carry the ${label} label (their ceiling)`);
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
        sub = await resolveChild(run, write.repo, write.child, get);
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
    if (write.blocker) {
      let found;
      try {
        found = await resolveBlocker(run, write.repo, write.blocker, get);
      } catch (error) {
        log(`GitHub gateway: ${run.repo} blocker ${write.blocker.id}: ${error.message ?? error}`);
        return refusal(502, "the blocking issue can't be looked up on GitHub");
      }
      if (!found.open) {
        return refusal(
          403,
          "a run's blocking issue is one it created, one under its issue, or an open issue of its repository",
        );
      }
      const { open: _, ...blocked_by } = found;
      change.blocked_by = blocked_by;
    }
    const pulled = await pulls.check(run, write, target, get);
    if (pulled) return pulled;
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

  return { check, checkWrite, answered };
}

// An issue of GitHub's answer → its number, when it is in `repo`: its `url` (GraphQL's is the
// web page, REST's the API's) says which repository it is in; a bare number only with REST's
// `repository_url` checked by the caller.
function numberOf(issue, repo) {
  const url = String(issue?.url ?? issue?.html_url ?? "");
  const m = /\/(?:repos\/)?([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
  if (m) return m[1].toLowerCase() === repo ? Number(m[2]) : null;
  return null;
}

// The children a link may name (resolveChild()).
const LINKABLE = new Set(["sub_issue", "created_issue"]);

// Whether GitHub's issue (or parent) is in `repo` ("owner/name", lower case).
function inRepo(issue, repo) {
  const url = String(issue?.repository_url ?? "").toLowerCase();
  return url.endsWith(`/repos/${repo}`);
}

const refusal = (status, message) => ({ status, message });
