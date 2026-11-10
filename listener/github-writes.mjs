// What a run may write to GitHub (issue #405): each REST write the GitHub gateway relays
// (github-gateway.mjs) is classified from its method, path and body into actions on a target,
// the target's kind is resolved from GitHub (never from the request), and the write goes on only
// when the policies allow it (policies.mjs): an `allow_github` rule matches it and no
// `deny_github` rule refuses it. Deckhand's defaults allow each mode what it writes, in its own
// file (../policy/mode-<mode>.rego: what the modes' built-in ceilings were). A write it can't
// classify is refused, and so is every write when no policy is there to decide.
// GraphQL's mutations are classified by github-graphql.mjs (#406), each into the same shape,
// and held to the same checks (checkWrite()). A pull request's own writes (opening, editing,
// readying, drafting one, updating its branch) are then held to github-pulls.mjs's checks too.
//
// Kinds: `own_issue` (the run's issue), `own_pr` (the run's pull request, or one from a branch
// it may push: broker.mjs allow()), `sub_issue` (an issue whose parent is the run's, in its
// repo), `created_issue` (one this run created: GitHub answered the run's own create with it,
// over REST or GraphQL, as `gh issue create` sends: answered()),
// `other_issue`, `pr`, `new_issue` (an issue it creates), `new_pr` (a pull request it opens),
// `label` (a label of the repo it creates), `created_comment` (an issue's or pull request's
// comment this run posted: GitHub answered the run's own comment with it, as `gh issue
// comment` sends: answered(); issue #455), and `comment`, `review` for a review's writes and its
// comments', refused before any policy (ID_TARGETS). The App's bot writes every run's comments
// and the listener's own (its live progress, its replies): a comment by the bot isn't the run's
// for that, and one the run didn't post is refused before any look-up.
//
// A sub-issue link names two issues: its target is the parent, in the path, and the child, by
// its id in the body, must be one the run created or one already under the run's issue (a
// REST issue can't be looked up by its id: the run's issue's sub-issues and the issues it
// created carry theirs). Moving an issue from another parent (`replace_parent`, any value
// but false) is refused, whatever the policies say: a link would otherwise take any issue under
// the run's.
// A "blocked by" link (issue #437) is a `link` too: its target is the blocked issue, in the
// path, and its blocker, by its id (the body's `issue_id`, or the path's when removed), one the
// run created, one under its issue, or any open issue of its repository (resolveBlocker()).
// A rerun of a GitHub Actions run's failed jobs (issue #451) names the workflow run, or one of
// its jobs: its target is the pull request whose head that run tested, looked up from GitHub
// (resolveRerun()), and only a failed run of the head of one of them (its kind, `own_pr` for
// the run's own, is the policies' to hold), on a push or a pull request of its branch, is
// rerun, at most MAX_RERUNS times per head commit and run of Deckhand's.
// A reaction (issue #458) on a comment has the comment's issue or pull request for its target,
// looked up on GitHub (resolveReacted()), the comment in `target.comment` (its id, as a
// `created_comment`'s), `comment_author` and `comment_deckhand`. The App's
// bot adds the listener's reactions too (👀, then the outcome's, on the comments that trigger
// runs): a run removes (`unreact`) only those GitHub said it added (answered()).
// A review thread's reply, resolution or reopening (issue #449) is a `reply`, a `resolve` or an
// `unresolve` on its pull request: the thread, by its first comment's id, is looked up on
// GitHub, must be on that pull request, and its first comment's author goes to the policies
// (resolveThread(); their default: ../policy/mode-work.rego). A new review, or a review
// comment that answers no thread, stays `review`.
// An item added to a project (v2) is a `project` on its content (issue #454), over GraphQL only
// (github-graphql.mjs addProjectV2ItemById): its project must be one the operator's grants list
// for the repository (`allow_projects`), whatever the policies say.
// Format of the policies' input: ../docs/repo-config/policy-inputs.md#the-github-input.
import { randomUUID } from "node:crypto";
import { branchAllowed } from "./broker.mjs";
import { ISSUES_WRITE } from "./github-app.mjs";
import { CONTENTS_WRITE, createPullChecks, PULL_WRITE } from "./github-pulls.mjs";
import { BUILT_IN } from "./modes.mjs";
import { isPolicyError } from "./policies.mjs";

// What a rerun's token needs: GitHub reruns a job with `actions: write`, an optional permission
// of the App's (github-app.mjs OPTIONAL_PERMISSIONS), which the sandbox's own token never has.
export const ACTIONS_WRITE = { actions: "write" };
// How many reruns one run of Deckhand's makes on one head commit (its workflow runs' failed jobs,
// or single jobs), whatever the policies allow: GitHub's own `run_attempt` counts every rerun of
// a workflow run, the policies read it (`target.attempt`).
export const MAX_RERUNS = 2;
// How many look-ups on GitHub (with the listener's token, whose rate limit every run shares) a
// run's writes may cost in REFUSED_WINDOW_MS when a rule or a built-in check refuses them: each
// write's target is looked up before the policies are asked, so a run that only reads, steered
// by what it read into writes no rule allows, would otherwise spend them unbounded. Each
// look-up counts as it is made, so writes checked at once can't each pass on the same count,
// and is given back when its write goes on or failed for no fault of the run's (GitHub or the
// policy service failing). Past it, the run's writes are refused before another look-up, until
// the window has room again.
export const MAX_REFUSED_LOOKUPS = 100;
export const REFUSED_WINDOW_MS = 60 * 60_000;
// A workflow run's or job's conclusions a rerun is for.
export const RERUN_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"]);
// The events whose runs test a branch's head: a push to it, its pull request.
export const RERUN_EVENTS = new Set(["push", "pull_request"]);

// Actions on another target than an issue or pull request by number (a review comment by its id,
// a review): Deckhand can't tell whose they are, so they are refused before any look-up,
// whatever the policies say.
const ID_TARGETS = new Set(["comment", "review"]);

// The actions that set an issue's or a pull request's labels, assignees or milestone: GitHub
// takes them with `issues: write`, whatever the endpoint.
const ISSUE_FIELDS = new Set(["label", "assign", "milestone"]);

// What a write's token needs to write, besides the run's reads (github-gateway.mjs): its route's
// own permissions (`permissions`: a pull request's, a rerun's, a project's), else `issues:
// write`, the endpoint being an issue's (its comments, labels, reactions, links), and that too
// when it sets labels, assignees or a milestone. Nothing for a POST that writes nothing.
export function writePermissions(write) {
  if (!write || write.read) return {};
  const own = write.permissions;
  const issues = !own || write.actions.some((a) => ISSUE_FIELDS.has(a));
  return { ...(issues && ISSUES_WRITE), ...own };
}

// The permissions a call's several writes need, merged (a GraphQL call's: github-graphql.mjs).
export function permissionsOf(writes) {
  return Object.assign({}, ...writes.map(writePermissions));
}

// The label names of a body's `labels` (strings, or objects with a name), or of the body itself
// when it is the list (PUT …/labels takes either).
export function labelNames(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((l) => typeof l === "string");
}

// PATCH of an issue or a pull request: what each field it sets is. A state changes first, then
// labels, assignees and the milestone, then the rest (title, body, base…): the actions in that
// order, the first being the write's `action`. The assignees it sets replace the issue's.
function patched(body) {
  const actions = [];
  const keys = Object.keys(body);
  if ("state" in body) actions.push(body.state === "closed" ? "close" : "reopen");
  if ("labels" in body) actions.push("label");
  const set = assigned(body, "set");
  actions.push(...set.actions);
  const rest = ["state", "state_reason", "labels", "assignees", "assignee", "milestone"];
  if (!actions.length || keys.some((k) => !rest.includes(k))) actions.push("edit");
  // Labels set replace the issue's: what they remove is known once it is looked up.
  const change = { labels_added: labelNames(body.labels) };
  if ("labels" in body) change.labels_set = true;
  if (body.state === "closed") change.state_reason = closeReason(body.state_reason);
  return { actions, assignees: set.assignees, milestone: set.milestone, change };
}

// A close's reason as GitHub reads it, `completed` without one: `change.state_reason`.
export const closeReason = (reason) => String(reason ?? "completed").toLowerCase();

// The assignees and milestone a body sets, which a create and an edit both take → { actions,
// assignees: { logins, as } (`as`: they are `added`, or `set` in place of the issue's), milestone:
// { number } (null: cleared) }, each undefined when the body leaves it out, null when it can't be
// read (classify() refuses the write).
function assigned(body, as) {
  const actions = [];
  let assignees;
  let milestone;
  if ("assignees" in body || "assignee" in body) {
    actions.push("assign");
    // `assignee`: one login, or null; either, null, clears them.
    const many = body.assignees ?? [];
    const one = body.assignee ?? null;
    const logins = Array.isArray(many) && loginsOf(one === null ? many : [one, ...many]);
    assignees = logins ? { logins, as } : null;
  }
  if ("milestone" in body) {
    actions.push("milestone");
    milestone = body.milestone === null ? { number: null } : positive(body.milestone);
  }
  return { actions, assignees, milestone };
}

// A body's logins: strings, else null.
function loginsOf(list) {
  if (!Array.isArray(list) || list.some((l) => typeof l !== "string" || !l)) return null;
  return list;
}

// A positive integer, as a number or a string: { number }, else null.
function positive(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && String(value).trim() !== "" ? { number: n } : null;
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

// Whether a rerun's body turns on GitHub's runner and step debug logs (`enable_debug_logging`,
// any value but false, however GitHub would read it): they print more of the environment and of
// the expressions a workflow evaluates, in runs that see the repository's secrets, and the run
// reads its logs. Refused (checkWrite()): a rerun reruns, nothing more.
function rerunDebug(body) {
  return "enable_debug_logging" in body && body.enable_debug_logging !== false;
}

// A comment a reaction names, by its path: an issue's or pull request's (`issue`), or a review
// comment (`review`).
const reactedOf = (where, id) => ({ id: +id, type: /^pulls$/i.test(where) ? "review" : "issue" });

// What a reaction is on, as the run's own reactions are kept (answered()): `issue:<n>` (an
// issue or a pull request), `issue_comment:<id>`, `review_comment:<id>`. `target`: a write's,
// `{ number }` or `{ reacted: { id, type } }`.
export function reactionSubject({ number, reacted }) {
  return reacted ? `${reacted.type}_comment:${reacted.id}` : `issue:${number}`;
}

// …/issues/<n>/assignees: its body's `assignees`, `as` they are added or removed.
function assignees(m, body, as) {
  const logins = loginsOf(body.assignees ?? []);
  return { actions: ["assign"], target: { number: +m[1] }, assignees: logins && { logins, as } };
}

// [method, path under the repo (case-insensitive), (match, body, method) → { actions, target,
// change, pull, thread, permissions }]: `pull`, a pull request's own write's head, base and
// draft, or its branch update's expected head and method (github-pulls.mjs), `thread`, a review
// thread's comment it answers, `permissions`, what its token needs to write when it isn't
// `issues: write` (PULL_WRITE, CONTENTS_WRITE, ACTIONS_WRITE: writePermissions()).
// `number`: an issue's or pull request's; `body`: the write's JSON.
const ROUTES = [
  [
    "POST",
    /^issues$/i,
    (m, body) => {
      const { actions, assignees, milestone } = assigned(body, "added");
      return {
        actions: ["create", ...actions],
        target: { kind: "new_issue" },
        assignees,
        milestone,
        change: { labels_added: labelNames(body.labels) },
      };
    },
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
    // Its blocker is in the path: named as POST's body names it, for the policies.
    (m) => ({
      actions: ["link"],
      target: { number: +m[1] },
      blocker: blocker(m[2]),
      change: { fields: ["issue_id"] },
    }),
  ],
  // POST adds the body's assignees, DELETE removes them.
  ["POST", /^issues\/(\d+)\/assignees$/i, (m, body) => assignees(m, body, "added")],
  ["DELETE", /^issues\/(\d+)\/assignees$/i, (m, body) => assignees(m, body, "removed")],
  [
    /^(?:PUT|DELETE)$/,
    /^issues\/(\d+)\/lock$/i,
    (m) => ({ actions: ["lock"], target: { number: +m[1] } }),
  ],
  // Reactions (issue #458): on an issue or pull request, or on a comment, whose own issue or
  // pull request is then its target (checkWrite()). A reaction is removed by its id.
  [
    "POST",
    /^issues\/(\d+)\/reactions$/i,
    (m, body) => ({
      actions: ["react"],
      target: { number: +m[1] },
      reaction: { subject: `issue:${+m[1]}`, content: body.content },
    }),
  ],
  [
    "DELETE",
    /^issues\/(\d+)\/reactions\/(\d+)$/i,
    (m) => ({
      actions: ["unreact"],
      target: { number: +m[1] },
      reaction: { subject: `issue:${+m[1]}`, id: +m[2] },
    }),
  ],
  [
    "POST",
    /^(issues|pulls)\/comments\/(\d+)\/reactions$/i,
    (m, body) => {
      const reacted = reactedOf(m[1], m[2]);
      return {
        actions: ["react"],
        target: { reacted },
        reaction: { subject: reactionSubject({ reacted }), content: body.content },
      };
    },
  ],
  [
    "DELETE",
    /^(issues|pulls)\/comments\/(\d+)\/reactions\/(\d+)$/i,
    (m) => {
      const reacted = reactedOf(m[1], m[2]);
      return {
        actions: ["unreact"],
        target: { reacted },
        reaction: { subject: reactionSubject({ reacted }), id: +m[3] },
      };
    },
  ],
  // An issue's or pull request's comment, by its id: one the run posted, or refused before any
  // look-up (checkWrite()).
  [
    /^(?:PATCH|DELETE)$/,
    /^issues\/comments\/(\d+)$/i,
    (m, body, method) => ({
      actions: [method === "PATCH" ? "edit" : "delete"],
      target: { comment: +m[1] },
    }),
  ],
  ["PATCH", /^pulls\/comments\/\d+$/i, () => ({ actions: ["edit"], target: { kind: "comment" } })],
  [
    "DELETE",
    /^pulls\/comments\/\d+$/i,
    () => ({ actions: ["delete"], target: { kind: "comment" } }),
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
  // `gh pr update-branch` over REST: GitHub merges the base in (github-pulls.mjs).
  [
    "PUT",
    /^pulls\/(\d+)\/update-branch$/i,
    (m, body) => ({
      actions: ["update_branch"],
      target: { number: +m[1] },
      pull: { expected_head: body.expected_head_sha, method: body.update_method },
      permissions: CONTENTS_WRITE,
    }),
  ],
  // A rerun of a workflow run's failed jobs, or of one job (with those that need it): not a
  // whole run's (`…/rerun`), nor cancelling, dispatching or approving one. `debug`: whether it
  // asks for debug logs (rerunDebug()).
  [
    "POST",
    /^actions\/runs\/(\d+)\/rerun-failed-jobs$/i,
    (m, body) => ({
      actions: ["rerun"],
      target: { run_id: +m[1] },
      permissions: ACTIONS_WRITE,
      debug: rerunDebug(body),
    }),
  ],
  [
    "POST",
    /^actions\/jobs\/(\d+)\/rerun$/i,
    (m, body) => ({
      actions: ["rerun"],
      target: { job_id: +m[1] },
      permissions: ACTIONS_WRITE,
      debug: rerunDebug(body),
    }),
  ],
  // A reply in a review thread: GitHub takes it with `pull_requests: write`.
  [
    "POST",
    /^pulls\/(\d+)\/comments\/(\d+)\/replies$/i,
    (m) => ({
      actions: ["reply"],
      target: { number: +m[1] },
      thread: { comment: +m[2] },
      permissions: PULL_WRITE,
    }),
  ],
  // Reviews, their comments (but replies, above) and their requests: refused (ID_TARGETS).
  [
    /^(?:POST|PUT|PATCH|DELETE)$/,
    /^pulls\/\d+\/(?:reviews|comments|requested_reviewers)(?:\/.*)?$/i,
    () => ({ actions: ["review"], target: { kind: "review" } }),
  ],
];

// A write → { repo, actions, target: { number } | { kind } | { comment: its id } | { reacted:
// a reaction's comment, { id, type } }, child (a link's: { id, replace_parent }), blocker (a
// "blocked by" link's: { id }), reaction (a reaction's: { subject, content } added, { subject,
// id } removed: reactionSubject()), assignees ({ logins, as }: assigned()), milestone
// ({ number }), change: { fields, labels_added, labels_removed, labels_set (the labels it sets
// replace the issue's) }, pull, thread, permissions (ROUTES') }, `{ read: true }` for a POST
// that writes nothing (rendering markdown), or
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
    const write = build(m, json, method);
    // A link without its child or its blocker can't be checked, nor assignees or a milestone
    // that can't be read.
    if ([write.child, write.blocker, write.assignees, write.milestone].includes(null)) return null;
    return {
      repo: `${owner}/${name}`.toLowerCase(),
      actions: write.actions,
      target: write.target,
      ...(write.child && { child: write.child }),
      ...(write.blocker && { blocker: write.blocker }),
      ...(write.assignees && { assignees: write.assignees }),
      ...(write.milestone && { milestone: write.milestone }),
      ...(write.reaction && { reaction: write.reaction }),
      ...(write.pull && { pull: write.pull }),
      ...(write.thread && { thread: write.thread }),
      ...(write.permissions && { permissions: write.permissions }),
      ...(write.debug && { debug: true }),
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

// The issues a run created that a link's child is looked for among: a run files a few.
const MAX_CREATED = 100;
// The reactions a run added that it keeps as its own, its newest: a few acknowledgements.
const MAX_REACTIONS = 100;
// The pages of the repo's open issues (and pull requests, which GitHub lists with them), newest first, that a "blocked by" link's blocker named
// by its id only (REST) is looked for among, past the run's own: GitHub can't look an issue up
// by its id. GraphQL's names it by its node ID, looked up whatever the repo holds.
const MAX_OPEN_PAGES = 10;
const PAGE = 100;
// How much earlier than the call that created it GitHub may say an issue was created: the
// listener's and GitHub's clocks differ, and `created_at` is in seconds.
const SKEW_MS = 2 * 60_000;
// The most replies a review comment is followed up through to its thread's first: GitHub's
// point at it directly.
const MAX_HOPS = 5;

// `lookup(repo, path)`: GitHub's JSON with the listener's token, null for a 404 (github.mjs
// getJson()); `bot()`: the App's login (`slug[bot]`), null before /setup; `policies`:
// policies.mjs's, null without; `pulls`: github-pulls.mjs's checks (its workflow check and
// record, none by default); `needsInputLabel(run)`: NEEDS_INPUT_LABEL, null when unset (the
// github service has it on the run, from the orchestrator);
// `listenerReacted(repo, subject, content)`: whether the listener added that reaction
// (comments.mjs), which a run never removes;
// `projects(repo)`: the projects the operator's grants let its runs write, ["acme/3"] (grants.mjs
// allowProjects), none by default; `users(repo, run)`: the logins a run may assign there
// (ALLOWED_USERS, narrowed by the repo's `users`: the github service has them on the run), in
// lower case: none by default; `log`: the
// listener's; `now`: the clock (MAX_REFUSED_LOOKUPS' window).
export function createWriteChecks({
  lookup,
  bot = () => null,
  users = () => [],
  needsInputLabel,
  projects = () => [],
  policies = null,
  pulls = createPullChecks({ lookup }),
  listenerReacted = () => false,
  log = () => {},
  now = Date.now,
}) {
  // run → [{ at, n }]: the look-ups on GitHub its writes cost, those being checked included
  // (MAX_REFUSED_LOOKUPS).
  const spent = new WeakMap();
  const costOf = (run) => {
    const since = now() - REFUSED_WINDOW_MS;
    const kept = (spent.get(run) ?? []).filter((e) => e.at >= since);
    spent.set(run, kept);
    return kept.reduce((sum, e) => sum + e.n, 0);
  };
  // Required, so a caller that forgets it fails here rather than leaving the label unguarded:
  // () => null where nothing waits for answers.
  if (typeof needsInputLabel !== "function") {
    throw new TypeError("createWriteChecks: needsInputLabel is required");
  }
  // Whether GitHub's issue is one `run` created: GitHub answered one of the run's own creates
  // with it (answered()), it is no older than that call, and the App's bot wrote it. The bot
  // files issues for every run and for the listener too: its authorship alone says nothing.
  function created(run, issue) {
    if (issue?.pull_request) return false;
    const login = bot();
    if (!login || String(issue?.user?.login ?? "").toLowerCase() !== login.toLowerCase()) {
      return false;
    }
    const made = issuesOf(run).find((c) => c.number === issue?.number);
    return !!made && Date.parse(issue.created_at) >= made.at - SKEW_MS;
  }

  // A comment the run posted (answered()) → its target, `created_comment`, as GitHub has it: in
  // the run's repo (GitHub answers no other's under its path), by the App's bot, its issue's or
  // pull request's number. Null when it isn't there, or isn't the bot's.
  async function resolveComment(repo, id, lookup) {
    const comment = await lookup(repo, `/repos/${repo}/issues/comments/${id}`);
    const login = bot();
    const author = String(comment?.user?.login ?? "");
    if (!comment || !login || author.toLowerCase() !== login.toLowerCase()) return null;
    const on = /\/issues\/(\d+)$/.exec(String(comment.issue_url ?? ""));
    return {
      number: on ? Number(on[1]) : null,
      comment: id,
      labels: [],
      author,
      kind: "created_comment",
    };
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

  // A comment a reaction names ({ id, type }: classify()'s) → { number, id, author, deckhand }:
  // the issue or pull request it is on, in `repo`, its author, and whether the App's bot wrote
  // it. Null when it isn't there, or is elsewhere.
  async function resolveReacted(repo, { id, type }, lookup) {
    const found = await lookup(
      repo,
      `/repos/${repo}/${type === "review" ? "pulls" : "issues"}/comments/${id}`,
    );
    const on = String(found?.issue_url ?? found?.pull_request_url ?? "");
    const m = /\/repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)$/.exec(on);
    if (!m || m[1].toLowerCase() !== repo) return null;
    const author = found.user?.login ?? null;
    const login = bot();
    const deckhand = !!login && String(author ?? "").toLowerCase() === login.toLowerCase();
    return { number: Number(m[2]), id, author, deckhand };
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
    for (const { number } of issuesOf(run).slice(-MAX_CREATED)) {
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

  // A review thread, by the id of one of its comments → { author, deckhand }: its first
  // comment's author, and whether that is the App's bot (a thread Deckhand opened). Null when
  // the comment isn't there, or isn't on pull request `number`.
  async function resolveThread(repo, number, id, lookup) {
    const on = (c) =>
      String(c?.pull_request_url ?? "")
        .toLowerCase()
        .endsWith(`/repos/${repo}/pulls/${number}`);
    let comment = await lookup(repo, `/repos/${repo}/pulls/comments/${id}`);
    for (let hops = 0; comment?.in_reply_to_id && hops < MAX_HOPS; hops++) {
      if (!on(comment)) return null;
      comment = await lookup(repo, `/repos/${repo}/pulls/comments/${comment.in_reply_to_id}`);
    }
    if (!on(comment) || comment.in_reply_to_id) return null;
    const author = comment.user?.login ?? null;
    const login = bot();
    return { author, deckhand: !!login && author?.toLowerCase() === login.toLowerCase() };
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

  // A rerun's workflow run, or job → { target } (resolve()'s, for the pull request whose head it
  // tested, with the run's: `run_id`, `sha`, `event`, `workflow` { name, path }, `attempt`,
  // `conclusion`, the job's for a job, and `job` { id, name }, else null) or { refused }: a run
  // that failed, of a push or a pull request of a branch of the repo, whose head commit is
  // still that of an open pull request of that branch. Whether the pull request is the run's
  // own is its kind's, held to the policies as any target's.
  async function resolveRerun(run, repo, { run_id, job_id }, get) {
    let job = null;
    if (job_id !== undefined) {
      job = await get(repo, `/repos/${repo}/actions/jobs/${job_id}`);
      if (!job) return { refused: refusal(404, `job ${job_id} isn't there`) };
    }
    const id = job ? job.run_id : run_id;
    const at = Number.isSafeInteger(id)
      ? await get(repo, `/repos/${repo}/actions/runs/${id}`)
      : null;
    if (!at) return { refused: refusal(404, `workflow run ${id ?? "?"} isn't there`) };
    const what = job ? `job ${job_id}` : `workflow run ${id}`;
    const no = (why) => ({
      refused: refusal(
        403,
        `a run reruns only the failed GitHub Actions runs of its own pull request's head: ${why}`,
      ),
    });
    const conclusion = (job ?? at).conclusion ?? null;
    if (!RERUN_CONCLUSIONS.has(conclusion)) {
      return no(`${what} ${conclusion ? `ended with ${conclusion}` : "hasn't finished"}`);
    }
    if (!RERUN_EVENTS.has(at.event)) {
      return no(`workflow run ${id} ran on ${at.event}, not a push or a pull request`);
    }
    const branch = at.head_branch;
    if (at.head_repository?.full_name?.toLowerCase() !== repo || typeof branch !== "string") {
      return no(`workflow run ${id} isn't of a branch of ${repo}`);
    }
    const owner = repo.split("/")[0];
    const list = await get(
      repo,
      `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&per_page=100`,
    );
    const pr = Array.isArray(list)
      ? list.find(
          (p) => p?.head?.sha === at.head_sha && p.head.repo?.full_name?.toLowerCase() === repo,
        )
      : null;
    if (!pr?.number || !at.head_sha) {
      const sha = String(at.head_sha ?? "?").slice(0, 7);
      return no(`${sha} isn't the head of an open pull request of ${branch}`);
    }
    const target = await resolve(run, repo, pr.number, get);
    if (!target) return { refused: refusal(404, `#${pr.number} isn't there`) };
    return {
      target: {
        ...target,
        run_id: id,
        sha: at.head_sha,
        event: at.event,
        workflow: { name: at.name ?? null, path: at.path ?? null },
        attempt: (job ?? at).run_attempt ?? 1,
        conclusion,
        job: job ? { id: job_id, name: job.name ?? null } : null,
      },
    };
  }

  // A write's assignees → { added, removed }: the logins it adds and removes, those it sets in
  // place of the target's split against GitHub's (look-ups `get` has already made).
  async function assigneesOf({ repo, assignees: { logins, as } }, target, get) {
    if (as === "added") return { added: logins, removed: [] };
    if (as === "removed") return { added: [], removed: logins };
    const issue =
      target.number === null ? null : await get(repo, `/repos/${repo}/issues/${target.number}`);
    const now = (issue?.assignees ?? []).map((u) => u?.login).filter((l) => typeof l === "string");
    const has = (list, login) => list.some((l) => l.toLowerCase() === login.toLowerCase());
    return {
      added: logins.filter((l) => !has(now, l)),
      removed: now.filter((l) => !has(logins, l)),
    };
  }

  // Whether a run may assign `login`: an assignment notifies them, so one of the repo's allowed
  // users or the App's bot, never Copilot, which would start working on it.
  function assignable(run, login) {
    const name = login.toLowerCase();
    if (COPILOT.has(name)) return false;
    if (name === bot()?.toLowerCase()) return true;
    return users(run.repo, run).includes(name);
  }

  // A write's milestone → { number, title } (GraphQL's comes looked up), null when it clears
  // it, undefined when the repo has no such milestone.
  async function milestoneOf(repo, { number, title }, get) {
    if (number === null) return null;
    if (title !== undefined) return { number, title };
    const found = await get(repo, `/repos/${repo}/milestones/${number}`);
    return found ? { number, title: found.title ?? null } : undefined;
  }

  // GitHub's answer to a run's write that went on (github-gateway.mjs wroteWrite()): the pull
  // requests it changed go to the dashboard (github-pulls.mjs answered()), and the issues it
  // created, from a REST create (201, its JSON) or a GraphQL `createIssue` (what `gh issue
  // create` sends: `data.<its response key>.issue`, by its URL, `creates` naming the keys:
  // github-graphql.mjs), in the run's repo, are kept on the run (`run.created`, saved with it:
  // restart.mjs), with when the call was sent. So are the comments it posted, by their id
  // (`{ comment, at }`): from a REST comment (201, its JSON's API `url`) or a GraphQL
  // `addComment` (what `gh issue comment` and `gh pr comment` send:
  // `data.<its response key>.commentEdge.node.url`, its web page's `#issuecomment-<id>`,
  // `comments` naming the keys). And the reactions it added (`{ reaction: { subject, content,
  // id }, at }`, the only ones it may remove: checkWrite()): a REST `201` (a `200` says the bot
  // had it already), or a GraphQL `addReaction` field the gateway found new (`reacts`:
  // github-graphql.mjs) that GitHub ran; until it removes them (`unreacts`).
  async function answered(run, call, status, answer) {
    const { method, path, body, graphql, at } = call;
    const { creates = [], comments = [], reacts = [], unreacts = [] } = call;
    pulls
      .answered(run, call, status, answer)
      .catch((error) => log(`GitHub gateway: ${run.repo}: ${error.stack ?? error}`));
    // GitHub answers a rerun with an empty body. Its slot is a rerun done now, or free again.
    // No answer at all (status 0: the connection failed or was cut, the gateway's answered()):
    // GitHub may have taken it, so it counts, fail closed.
    if (call.rerun) {
      // A rerun GitHub took (a 201) stays on the run (`run.reruns`, saved with it: restart.mjs) for
      // MAX_RERUNS and the CI step (reviews.mjs afterCiFix()), with the workflow run and head
      // commit its check resolved (check()), never asked again: a look-up failing then would
      // leave it uncounted. Settled before the gateway's answer is over, so before the run exits.
      if (status === 201 || status === 0) await call.rerun.settle?.(at);
      await call.rerun.release?.();
      return;
    }
    // A reaction removed is no longer the run's: the bot's same one, added again by the listener
    // (or answered 200 to the run), isn't.
    if (!graphql && status === 204) {
      const write = classify(method, path, body);
      if (write?.repo === run.repo && write.actions[0] === "unreact") {
        await forget(run, [write.reaction]);
      }
      return;
    }
    let json;
    try {
      json = JSON.parse(answer.toString("utf8"));
    } catch {
      return;
    }
    let issues = [];
    let posted = [];
    let reactions = [];
    let removed = [];
    if (graphql) {
      if (status !== 200) return;
      issues = creates.map((key) => json?.data?.[key]?.issue);
      posted = comments.map((key) => commentOf(json?.data?.[key]?.commentEdge?.node, run.repo));
      // A field GitHub didn't run answers null.
      const ran = ({ key }) => json?.data?.[key] != null;
      reactions = reacts.filter(ran).map(({ subject, content }) => ({ subject, content }));
      removed = unreacts.filter(ran);
    } else {
      const write = classify(method, path, body);
      if (status !== 201 || write?.repo !== run.repo) return;
      if (write.target.kind === "new_issue" && inRepo(json, run.repo)) issues = [json];
      if (write.actions[0] === "comment" && write.target.number !== undefined) {
        posted = [restCommentOf(json, run.repo)];
      }
      // A 201: GitHub added it; a 200, the bot had it already, the listener's maybe.
      const added = Number.isSafeInteger(json?.id) && typeof json.content === "string";
      if (write.reaction && write.actions[0] === "react" && added) {
        reactions = [{ subject: write.reaction.subject, content: json.content, id: json.id }];
      }
    }
    if (removed.length) await forget(run, removed);
    if (!Array.isArray(run.created)) return;
    // The listener's same reaction, added meanwhile, isn't the run's: asked before the change,
    // which may be tried again on the latest state.
    const listeners = new Set();
    for (const reaction of reactions) {
      if (await listenerReacted(run.repo, reaction.subject, reaction.content)) {
        listeners.add(reaction);
      }
    }
    await mutate(run, (state) => {
      let added = false;
      for (const issue of issues) {
        const number = numberOf(issue, run.repo);
        if (number === null || state.created.some((c) => c.number === number)) continue;
        state.created.push({ number, at });
        added = true;
      }
      for (const comment of posted) {
        if (comment === null || postedBy(state, comment)) continue;
        state.created.push({ comment, at });
        added = true;
      }
      for (const reaction of reactions) {
        if (ownReaction(state, reaction) || listeners.has(reaction)) continue;
        state.created.push({ reaction, at });
        added = true;
      }
      // The oldest past MAX_REACTIONS go: the run can't take those off any more (fail closed).
      const kept = state.created.filter((c) => c?.reaction);
      if (kept.length > MAX_REACTIONS) {
        const dropped = new Set(kept.slice(0, kept.length - MAX_REACTIONS));
        state.created = state.created.filter((c) => !dropped.has(c));
      }
      return added;
    });
  }

  // Takes the reactions `removed` names (answered()'s: { subject, id } or { subject, content })
  // off the run's own.
  async function forget(run, removed) {
    if (!Array.isArray(run.created) || !removed.length) return;
    await mutate(run, (state) => {
      const gone = new Set(removed.map((r) => ownReaction(state, r)).filter(Boolean));
      if (!gone.size) return false;
      state.created = state.created.filter((c) => !gone.has(c?.reaction));
      return true;
    });
  }

  // A run's REST write → null when it may go on, else { status, message }: GitHub's status and
  // why, which `gh` prints. `path`, `body`: classify()'s.
  // A rerun that passed sets the call's `rerun`, its slot (reserve(): { run_id, sha, release }),
  // as resolved here: the gateway hands it back with GitHub's answer (answered()), and releases
  // it once the call is over.
  async function check(run, call) {
    const { method, path, body } = call;
    const write = classify(method, path, body);
    if (write?.read) return null;
    if (!write) {
      return refusal(403, "it can't tell what this write does, so it refuses it");
    }
    const refused = await checkWrite(run, write);
    if (!refused && write.rerun) call.rerun = write.rerun;
    return refused;
  }

  // A classified write (classify()'s shape, or a GraphQL mutation's: github-graphql.mjs) → the
  // same as check(). `memo`: a Map that keeps GitHub's answers across the writes of one call (a
  // GraphQL call's several fields), so the same target is looked up once.
  async function checkWrite(run, write, memo = new Map()) {
    const cost = budget.begin(run);
    if (!cost) return budget.spentOut();
    const refused = await checked(run, write, memo, cost);
    if (cost.over) return budget.spentOut();
    budget.settle(run, cost, refused);
    return refused;
  }

  // MAX_REFUSED_LOOKUPS, for checkWrite() and the GraphQL checks' node look-ups
  // (github-graphql.mjs): begin(run) → a cost entry whose `n` counts the look-ups as they are
  // made, or null when the run's are spent (spentOut()'s refusal then); settle(run, cost,
  // refused) keeps it only for a refusal the run caused.
  const budget = {
    begin(run) {
      if (costOf(run) >= MAX_REFUSED_LOOKUPS) return null;
      const cost = { at: now(), n: 0, over: false };
      spent.get(run).push(cost);
      return cost;
    },
    settle(run, cost, refused) {
      if (refused && chargeable(refused)) return;
      const list = spent.get(run) ?? [];
      if (list.includes(cost)) list.splice(list.indexOf(cost), 1);
    },
    spentOut: () =>
      refusal(
        429,
        `this run's refused writes cost ${MAX_REFUSED_LOOKUPS} look-ups on GitHub in the last hour: Deckhand checks no more of its writes until then`,
      ),
    // Whether the run's look-ups still allow one more.
    open: (run) => costOf(run) < MAX_REFUSED_LOOKUPS,
  };

  // checkWrite()'s work, each look-up it makes counted in `cost.n`; past the budget, a look-up
  // fails and `cost.over` says why.
  async function checked(run, write, memo, cost) {
    const get = (repo, path) => {
      const key = `${repo} ${path}`;
      if (!memo.has(key)) {
        if (costOf(run) >= MAX_REFUSED_LOOKUPS) {
          cost.over = true;
          return Promise.reject(new Error("the run's look-ups for refused writes are spent"));
        }
        cost.n++;
        memo.set(key, lookup(repo, path));
      }
      return memo.get(key);
    };
    if (write.repo !== run.repo) {
      return refusal(403, "a run writes only to its own repository");
    }
    if (!policies) return refusal(403, "no policy decides this run's writes");
    if (ID_TARGETS.has(write.target.kind)) {
      return refusal(403, `a run can't ${write.actions.join(", ")} here`);
    }
    if (write.child?.replace_parent) {
      return refusal(403, "a run can't move an issue from another parent (replace_parent)");
    }
    if (write.debug) {
      return refusal(
        403,
        "a run reruns GitHub Actions jobs without debug logs (enable_debug_logging)",
      );
    }
    let target = write.target;
    // A comment's reaction: its target is the issue or pull request the comment is on.
    let reacted = null;
    if (target.reacted) {
      try {
        reacted = await resolveReacted(write.repo, target.reacted, get);
      } catch (error) {
        log(`GitHub gateway: ${run.repo} comment ${target.reacted.id}: ${error.message ?? error}`);
        return refusal(502, `comment ${target.reacted.id} can't be looked up on GitHub`);
      }
      if (!reacted) return refusal(404, `comment ${target.reacted.id} isn't there`);
      target = { number: reacted.number };
    }
    if (target.run_id !== undefined || target.job_id !== undefined) {
      let found;
      try {
        found = await resolveRerun(run, write.repo, target, get);
      } catch (error) {
        log(`GitHub gateway: ${run.repo} workflow run: ${error.message ?? error}`);
        return refusal(502, "the workflow run can't be looked up on GitHub");
      }
      if (found.refused) return found.refused;
      target = found.target;
    } else if (target.comment !== undefined) {
      // Not one the run posted: another run's, the listener's or a person's, never looked up.
      if (!postedBy(run, target.comment)) {
        return refusal(403, notPosted(write.actions, write.repo));
      }
      try {
        target = await resolveComment(write.repo, target.comment, get);
      } catch (error) {
        log(
          `GitHub gateway: ${run.repo} comment ${write.target.comment}: ${error.message ?? error}`,
        );
        return refusal(502, `comment ${write.target.comment} can't be looked up on GitHub`);
      }
      if (!target) return refusal(404, `comment ${write.target.comment} isn't there`);
    } else if (target.number !== undefined) {
      const { number } = target;
      try {
        target = await resolve(run, write.repo, number, get);
      } catch (error) {
        log(`GitHub gateway: ${run.repo}#${number}: ${error.message ?? error}`);
        return refusal(502, `#${number} can't be looked up on GitHub`);
      }
      if (!target) return refusal(404, `#${number} isn't there`);
      // The comment, as a `created_comment` names it (its id), its author and whether the bot
      // wrote it.
      if (reacted) {
        const { id, author, deckhand } = reacted;
        Object.assign(target, { comment: id, comment_author: author, comment_deckhand: deckhand });
      }
    } else {
      target = { number: null, labels: [], author: null, ...target };
    }
    // Without `read:issues` (issue #497), an issue it can't read isn't written to either but by
    // a comment or a reaction: GitHub answers the other writes with the issue, body and all.
    const unread = !run.caps?.includes("read:issues");
    if (unread && UNREAD.has(target.kind)) {
      const answered = write.actions.filter((a) => !ANSWERED_APART.has(a));
      if (answered.length) {
        return refusal(
          403,
          `this run's capabilities don't give \`read:issues\`: it can't ${answered.join(", ")} on ${target.kind} #${target.number}, whose answer is that issue (it may comment or react)`,
        );
      }
    }
    if (write.thread) {
      let thread;
      try {
        thread = await resolveThread(write.repo, target.number, write.thread.comment, get);
      } catch (error) {
        log(
          `GitHub gateway: ${run.repo} review comment ${write.thread.comment}: ${error.message ?? error}`,
        );
        return refusal(502, "the review thread can't be looked up on GitHub");
      }
      if (!thread) return refusal(404, `#${target.number} has no such review thread`);
      target = { ...target, thread };
    }
    const change = { ...write.change };
    // A run removes only the reactions it added (answered()): never the listener's on the
    // comments that triggered it, which are the same bot's, nor anyone else's.
    if (write.reaction) {
      const own = write.actions.includes("unreact") ? ownReaction(run, write.reaction) : null;
      if (write.actions.includes("unreact") && !own) {
        return refusal(
          403,
          "a run removes only the reactions it added, never the listener's or anyone else's",
        );
      }
      // The listener's own on any comment, on any task's (its 👀, an outcome's): the same bot's
      // as one the run added there first, which GitHub keeps as one.
      if (own && (await listenerReacted(run.repo, own.subject, own.content))) {
        return refusal(403, "a run doesn't take off a reaction the listener added there");
      }
      change.content = own?.content ?? write.reaction.content ?? null;
    }
    // Labels that replace the issue's remove those they leave out.
    if (change.labels_set) {
      const kept = new Set(change.labels_added.map((l) => l.toLowerCase()));
      change.labels_removed = target.labels.filter((l) => !kept.has(l.toLowerCase()));
    }
    delete change.labels_set;
    // The needs-input label stays the listener's on the issues a run labels besides its own:
    // taking it off answers their questions and starts what waited for them (questions.mjs
    // labelInput()), which only an allowed user does.
    const waiting = needsInputLabel(run)?.toLowerCase();
    if (waiting && OTHERS_LABELLED.has(target.kind)) {
      const has = (list) => list.some((l) => l.toLowerCase() === waiting);
      const removed = has(change.labels_removed) || change.labels_removed.includes("*");
      // As GitHub has it now: setting it again where it is, or removing it where it isn't,
      // changes nothing.
      if (has(target.labels) ? removed : has(change.labels_added)) {
        const on = `${target.kind} #${target.number}`;
        return refusal(
          403,
          `a run doesn't add or remove ${waiting} on ${on}: an allowed user does`,
        );
      }
    }
    if (write.child) {
      let sub;
      try {
        sub = await resolveChild(run, write.repo, write.child, get);
      } catch (error) {
        log(`GitHub gateway: ${run.repo} sub-issue ${write.child.id}: ${error.message ?? error}`);
        return refusal(502, "the sub-issue can't be looked up on GitHub");
      }
      if (!LINKABLE.has(sub.kind)) {
        return refusal(403, "a run links only issues it created, or those already under its issue");
      }
      // Without `read:issues`, only one it created: GitHub may answer with the sub-issue (a
      // removal, a new priority).
      if (!run.caps?.includes("read:issues") && sub.kind !== "created_issue") {
        return refusal(
          403,
          "this run's capabilities don't give `read:issues`: it links, unlinks or reorders only issues it created",
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
      // Without `read:issues`, only one it created: GitHub answers with the blocking issue.
      if (!run.caps?.includes("read:issues") && found.kind !== "created_issue") {
        return refusal(
          403,
          "this run's capabilities don't give `read:issues`: its blocking issue is one it created",
        );
      }
      const { open: _, ...blocked_by } = found;
      change.blocked_by = blocked_by;
    }
    if (write.assignees) {
      const assignees = await assigneesOf(write, target, get);
      const refused = assignees.added.find((login) => !assignable(run, login));
      if (refused !== undefined) {
        return refusal(
          403,
          COPILOT.has(refused.toLowerCase())
            ? "a run doesn't assign Copilot"
            : `a run assigns only the repository's allowed users or its own bot, not @${refused}`,
        );
      }
      change.assignees = assignees;
    }
    if (write.milestone) {
      let milestone;
      try {
        milestone = await milestoneOf(write.repo, write.milestone, get);
      } catch (error) {
        log(`GitHub gateway: ${run.repo} milestone: ${error.message ?? error}`);
        return refusal(502, "the milestone can't be looked up on GitHub");
      }
      if (milestone === undefined) {
        return refusal(404, `milestone ${write.milestone.number} isn't there`);
      }
      change.milestone = milestone;
    }
    const rerun = write.actions.includes("rerun");
    if (rerun && reruns(run, target.sha) >= MAX_RERUNS) return tooMany(run, target.sha);
    if (write.project) {
      const name = `${write.project.owner}/${write.project.number}`;
      let granted;
      try {
        granted = await projects(run.repo);
      } catch (error) {
        log(`GitHub gateway: ${run.repo}: its grants: ${error.message ?? error}`);
        return refusal(503, "the operator's grants can't be read");
      }
      if (!Array.isArray(granted) || !granted.includes(name)) {
        return refusal(
          403,
          `the operator's grants don't let this repository's runs write project ${name} (allow_projects)`,
        );
      }
      change.project = write.project;
    }
    const pulled = await pulls.check(run, write, target, get);
    if (pulled) return pulled;
    const denied = await deny(run, write, target, change);
    if (denied || !rerun) return denied;
    write.rerun = await reserve(run, target);
    if (!write.rerun) return tooMany(run, target.sha);
    return null;
  }

  // The reruns a run made on head commit `sha`, and those GitHub hasn't answered yet.
  function reruns(run, sha) {
    return (run.reruns ?? []).filter((r) => r.sha === sha).length;
  }

  function tooMany(run, sha) {
    const done = reruns(run, sha);
    return refusal(
      403,
      `a run reruns GitHub Actions jobs at most ${MAX_RERUNS} times per head commit, and it reran or is rerunning ${done} on ${sha.slice(0, 7)}`,
    );
  }

  // A rerun that passed its checks holds a slot: an entry of `run.reruns` marked `pending`, saved
  // with the run before the call goes out, so a listener restarted meanwhile still counts it
  // (GitHub may have taken it). GitHub's answer settles it (`settle()`, answered()), or it is
  // taken out when GitHub refused it or it never went out (`release()`: the GitHub gateway calls
  // it once the call is over, whatever happened; a settled one stays). Counted again as it is
  // taken, on the latest state: the run's calls in flight at once (another workflow run's rerun
  // on the same commit, through the other copy of the github service) each passed the count
  // before. → the slot, or null when MAX_RERUNS were taken meanwhile.
  async function reserve(run, target) {
    const key = randomUUID();
    const taken = await mutate(run, (state) => {
      if (state.reruns.filter((r) => r.sha === target.sha).length >= MAX_RERUNS) return false;
      const entry = { run_id: target.run_id, sha: target.sha, at: Date.now() };
      state.reruns.push({ ...entry, pending: true, slot: key });
      return true;
    });
    if (!taken) return null;
    // The entry's own, while it is pending; nothing once settled or gone.
    const change = (fn) =>
      mutate(run, (state) => {
        const i = state.reruns.findIndex((r) => r.pending && r.slot === key);
        if (i < 0) return false;
        fn(state, i);
        return true;
      });
    return {
      run_id: target.run_id,
      sha: target.sha,
      settle: (at) =>
        change((state, i) => {
          const { pending: _, slot: __, ...entry } = state.reruns[i];
          state.reruns[i] = { ...entry, at: at ?? entry.at };
        }),
      release: () => change((state, i) => state.reruns.splice(i, 1)),
    };
  }

  // The policies' `allow_github` and `deny_github` on a write that passed the built-in checks:
  // null, or their refusal.
  async function deny(run, write, target, change) {
    const input = {
      repo: run.repo,
      mode: run.mode,
      ...runTraits(run),
      issue: run.issue ?? null,
      action: write.actions[0],
      actions: write.actions,
      target,
      change,
    };
    const messages = await policies.deny("deny_github", run.repo, run.base || "main", () => input);
    if (!messages.length) return null;
    // A policy that couldn't be evaluated (the service restarting, opa timing out) isn't the
    // run's doing: its look-ups aren't charged (chargeable()).
    const refused = refusal(403, `the policies refuse it: ${messages.join("; ")}`);
    return messages.some(isPolicyError) ? failedRefusal(refused) : refused;
  }

  return { check, checkWrite, answered, budget };
}

// The reads the policies' `allow_github` and `deny_github` see (github-gateway.mjs
// checkRead()): `read_checks`, CI's results beyond Actions, and `read_projects`, the
// organization's projects (v2) a run's token reads in a repo granted one, before it adds an item
// (Deckhand's defaults: work runs and brainstorms). Its input doesn't depend on the call, only on
// the run: asked once per run and
// action, and a definite answer kept, so that `gh pr checks --watch` doesn't start an `opa` per
// poll. A failed evaluation (policies.mjs's "policy error: …": GitHub not listing the policies,
// `opa` timing out) refuses this read only: the next one asks again, as each write does.
export function createReadChecks({ policies = null }) {
  const decided = new WeakMap();
  function checkRead(run, action) {
    // Fail closed, as writes do.
    if (!policies) return Promise.resolve(refusal(403, "no policy decides this run's reads"));
    const answers = decided.get(run) ?? new Map();
    decided.set(run, answers);
    if (!answers.has(action)) {
      const answer = decide(run, action);
      answers.set(action, answer);
      answer.then(
        (refused) => refused?.failed && answers.get(action) === answer && answers.delete(action),
        () => answers.get(action) === answer && answers.delete(action),
      );
    }
    return answers
      .get(action)
      .then((refused) => refused && refusal(refused.status, refused.message));
  }
  async function decide(run, action) {
    const input = {
      repo: run.repo,
      mode: run.mode,
      ...runTraits(run),
      issue: run.issue ?? null,
      action,
      actions: [action],
    };
    const messages = await policies.deny("deny_github", run.repo, run.base || "main", () => input);
    if (!messages.length) return null;
    return {
      ...refusal(403, `the policies refuse it: ${messages.join("; ")}`),
      failed: messages.some(isPolicyError),
    };
  }
  return { checkRead };
}

// What the policies read of a run besides its mode (issue #448): `custom_mode`, whether the mode
// is one of the repo's `modes:` (a policy needn't list the built-in ones), and `reason`, why the
// listener started it itself ("review-fix", "ci-fix", "conflict"), null for a comment's. What it
// may do beyond that is the policies' own: its mode, and its capabilities (`push`…), which no
// longer come from a trait of its mode (#498).
export function runTraits(run) {
  return {
    custom_mode: !!run.mode && !BUILT_IN.has(run.mode),
    reason: run.reason ?? null,
  };
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

// A GraphQL comment of GitHub's answer → its id, when it is in `repo`: its `url`, the web page's
// (`…/owner/repo/issues/12#issuecomment-345`, `/pull/` on a pull request).
function commentOf(node, repo) {
  const m = /\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+#issuecomment-(\d+)$/.exec(
    String(node?.url ?? ""),
  );
  return m && m[1].toLowerCase() === repo ? Number(m[2]) : null;
}

// A REST comment of GitHub's answer → its id, when it is in `repo`: its API `url`.
function restCommentOf(comment, repo) {
  const m = /\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(String(comment?.url ?? ""));
  return m && m[1].toLowerCase() === repo ? Number(m[2]) : null;
}

// Changes a run's `created` and `reruns` with `fn(state)` (its lists, which it may replace;
// → whether it changed them), and returns what `fn` returned: on the run itself, or through
// `run.update(fn)` where its state is shared (the github service's store, its copies:
// ../github/runs.mjs), which applies `fn` to the latest state, again should another change come
// first, then refreshes the run's lists.
async function mutate(run, fn) {
  if (run.update) return run.update(fn);
  if (!Array.isArray(run.created)) run.created = [];
  if (!Array.isArray(run.reruns)) run.reruns = [];
  // In place: the run's lists are its live state's too (runs.mjs), which saves them.
  const state = { created: [...run.created], reruns: [...run.reruns] };
  const changed = fn(state);
  if (changed) {
    run.created.splice(0, run.created.length, ...state.created);
    run.reruns.splice(0, run.reruns.length, ...state.reruns);
    run.changed?.();
  }
  return changed;
}

// The issues a run created, of `run.created` (which holds the comments it posted and the
// reactions it added too).
const issuesOf = (run) => (run.created ?? []).filter((c) => c.number !== undefined);

// Whether the run posted comment `id` (answered()).
const postedBy = (run, id) => (run.created ?? []).some((c) => c.comment === id);

// Why a write on a comment the run didn't post is refused, and what to send instead: `gh issue
// comment --edit-last` (or `--delete-last`) picks the App's last comment, which may be the
// listener's or another run's, all written by the same bot.
function notPosted(actions, repo) {
  const what = actions.join(", ");
  const call = actions.includes("delete")
    ? `gh api -X DELETE repos/${repo}/issues/comments/<id>`
    : `gh api -X PATCH repos/${repo}/issues/comments/<id> -f body=…`;
  return (
    `a run can ${what} only the comments it posted, and this isn't one (gh's --edit-last and ` +
    `--delete-last pick the App's last comment, which may be Deckhand's or another run's): ` +
    `send \`${call}\`, the <id> ending the URL gh printed for yours (#issuecomment-<id>)`
  );
}

// The reaction of `run.created` that `wanted` ({ subject } with its REST `id` or its
// `content`) names, or null: one the run added.
function ownReaction(run, { subject, id, content }) {
  for (const { reaction: r } of run.created ?? []) {
    if (r?.subject !== subject) continue;
    if (id !== undefined ? r.id === id : r.content === content) return r;
  }
  return null;
}

// The children a link may name (resolveChild()).
const LINKABLE = new Set(["sub_issue", "created_issue"]);
// The issues a run without `read:issues` can't read (issue #497): only comments and reactions
// (whose answer is the comment or the reaction, not the issue) and project items reach them.
const UNREAD = new Set(["sub_issue", "other_issue"]);
const ANSWERED_APART = new Set(["comment", "react", "unreact", "project"]);

// Whether GitHub's issue (or parent) is in `repo` ("owner/name", lower case).
function inRepo(issue, repo) {
  const url = String(issue?.repository_url ?? "").toLowerCase();
  return url.endsWith(`/repos/${repo}`);
}

const refusal = (status, message) => ({ status, message });
// A refusal that isn't the run's doing (a policy that couldn't be evaluated), marked so without
// changing what it says: a property of its own that isn't enumerable.
const failedRefusal = (refused) => Object.defineProperty(refused, "failed", { value: true });
// Whether a refusal's look-ups count against the run's MAX_REFUSED_LOOKUPS: a rule's or a built-in
// check's, not GitHub's or the policy service's failing, nor the budget's own.
const chargeable = (refused) => !refused.failed && ![429, 502, 503].includes(refused.status);
// Copilot's logins, over REST and GraphQL (a Bot's login with `[bot]`, github-graphql.mjs).
const COPILOT = new Set(["copilot", "copilot[bot]", "copilot-swe-agent", "copilot-swe-agent[bot]"]);
// The issues a run labels besides its own, which never get or lose the needs-input label from it.
const OTHERS_LABELLED = new Set(["sub_issue", "created_issue"]);
