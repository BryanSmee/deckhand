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
// `label` (a label of the repo it creates), `created_comment` (an issue's or pull request's
// comment this run posted: GitHub answered the run's own comment with it, as `gh issue
// comment` sends: answered(); issue #455), and `comment`, `review` for writes no ceiling
// allows anyway. The App's bot writes every run's comments and the listener's own (its live
// progress, its replies): a comment by the bot isn't the run's for that, and one the run
// didn't post is refused before any look-up.
//
// A sub-issue link names two issues: its target is the parent, in the path, and the child, by
// its id in the body, must be one the run created or one already under the run's issue (a
// REST issue can't be looked up by its id: the run's issue's sub-issues and the issues it
// created carry theirs). Moving an issue from another parent (`replace_parent`, any value
// but false) is in no ceiling: a link would otherwise take any issue under the run's.
// A "blocked by" link (issue #437) is a `link` too: its target is the blocked issue, in the
// path, and its blocker, by its id (the body's `issue_id`, or the path's when removed), one the
// run created, one under its issue, or any open issue of its repository (resolveBlocker()).
// A reaction (issue #458) on a comment has the comment's issue or pull request for its target,
// looked up on GitHub (resolveReacted()), the comment in `target.comment` (its id, as a
// `created_comment`'s), `comment_author` and `comment_deckhand`. The App's
// bot adds the listener's reactions too (👀, then the outcome's, on the comments that trigger
// runs): a run removes (`unreact`) only those GitHub said it added (answered()).
// A review thread's reply, resolution or reopening (issue #449) is a `reply`, a `resolve` or an
// `unresolve` on its pull request: the thread, by its first comment's id, is looked up on
// GitHub, must be on that pull request, and its first comment's author goes to the policies
// (resolveThread(); their default: ../policy/gh-review-threads.rego). A new review, or a review
// comment that answers no thread, stays `review`.
// Format of the policies' input: ../docs/repo-config.md#the-github-input.
import { branchAllowed } from "./broker.mjs";
import { createPullChecks, PULL_WRITE } from "./github-pulls.mjs";
import { BUILT_IN, ceilingOf, issueLabelOf } from "./modes.mjs";

// Actions on another target than an issue or pull request by number: no ceiling holds them,
// so they are refused before any look-up.
const ID_TARGETS = new Set(["comment", "review"]);

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

// A comment a reaction names, by its path: an issue's or pull request's (`issue`), or a review
// comment (`review`).
const reactedOf = (where, id) => ({ id: +id, type: /^pulls$/i.test(where) ? "review" : "issue" });

// What a reaction is on, as the run's own reactions are kept (answered()): `issue:<n>` (an
// issue or a pull request), `issue_comment:<id>`, `review_comment:<id>`. `target`: a write's,
// `{ number }` or `{ reacted: { id, type } }`.
export function reactionSubject({ number, reacted }) {
  return reacted ? `${reacted.type}_comment:${reacted.id}` : `issue:${number}`;
}

// [method, path under the repo (case-insensitive), (match, body, method) → { actions, target,
// change, pull, thread, permissions }]: `pull`, a pull request's own write's head, base and
// draft (github-pulls.mjs), `thread`, a review thread's comment it answers, `permissions`, what
// its token needs beyond its mode's (PULL_WRITE).
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
    // Its blocker is in the path: named as POST's body names it, for the policies.
    (m) => ({
      actions: ["link"],
      target: { number: +m[1] },
      blocker: blocker(m[2]),
      change: { fields: ["issue_id"] },
    }),
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
  [
    "PUT",
    /^pulls\/(\d+)\/update-branch$/i,
    (m) => ({ actions: ["update_branch"], target: { number: +m[1] } }),
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
  // Reviews, their comments (but replies, above) and their requests: in no ceiling.
  [
    /^(?:POST|PUT|PATCH|DELETE)$/,
    /^pulls\/\d+\/(?:reviews|comments|requested_reviewers)(?:\/.*)?$/i,
    () => ({ actions: ["review"], target: { kind: "review" } }),
  ],
];

// A write → { repo, actions, target: { number } | { kind } | { comment: its id } | { reacted:
// a reaction's comment, { id, type } }, child (a link's: { id, replace_parent }), blocker (a
// "blocked by" link's: { id }), reaction (a reaction's: { subject, content } added, { subject,
// id } removed: reactionSubject()), change: { fields, labels_added,
// labels_removed, labels_set (the labels it sets replace the issue's) }, pull, thread,
// permissions (ROUTES') }, `{ read: true }` for a POST that writes nothing (rendering markdown), or
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
    // A link without its child or its blocker can't be checked.
    if (write.child === null || write.blocker === null) return null;
    return {
      repo: `${owner}/${name}`.toLowerCase(),
      actions: write.actions,
      target: write.target,
      ...(write.child && { child: write.child }),
      ...(write.blocker && { blocker: write.blocker }),
      ...(write.reaction && { reaction: write.reaction }),
      ...(write.pull && { pull: write.pull }),
      ...(write.thread && { thread: write.thread }),
      ...(write.permissions && { permissions: write.permissions }),
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
// record, none by default); `needsInputLabel()`: NEEDS_INPUT_LABEL, null when unset;
// `listenerReacted(repo, subject, content)`: whether the listener added that reaction
// (comments.mjs), which a run never removes; `log`: the listener's.
export function createWriteChecks({
  lookup,
  bot = () => null,
  needsInputLabel,
  policies = null,
  pulls = createPullChecks({ lookup }),
  listenerReacted = () => false,
  log = () => {},
}) {
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
  function answered(run, call, status, answer) {
    const { method, path, body, graphql, at } = call;
    const { creates = [], comments = [], reacts = [], unreacts = [] } = call;
    pulls
      .answered(run, call, status, answer)
      .catch((error) => log(`GitHub gateway: ${run.repo}: ${error.stack ?? error}`));
    // A reaction removed is no longer the run's: the bot's same one, added again by the listener
    // (or answered 200 to the run), isn't.
    if (!graphql && status === 204) {
      const write = classify(method, path, body);
      if (write?.repo === run.repo && write.actions[0] === "unreact") {
        forget(run, [write.reaction]);
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
    if (graphql) {
      if (status !== 200) return;
      issues = creates.map((key) => json?.data?.[key]?.issue);
      posted = comments.map((key) => commentOf(json?.data?.[key]?.commentEdge?.node, run.repo));
      // A field GitHub didn't run answers null.
      const ran = ({ key }) => json?.data?.[key] != null;
      reactions = reacts.filter(ran).map(({ subject, content }) => ({ subject, content }));
      forget(run, unreacts.filter(ran));
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
    if (!Array.isArray(run.created)) return;
    let added = false;
    for (const issue of issues) {
      const number = numberOf(issue, run.repo);
      if (number === null || run.created.some((c) => c.number === number)) continue;
      run.created.push({ number, at });
      added = true;
    }
    for (const comment of posted) {
      if (comment === null || postedBy(run, comment)) continue;
      run.created.push({ comment, at });
      added = true;
    }
    for (const reaction of reactions) {
      // The listener's same reaction, added meanwhile, isn't the run's.
      if (ownReaction(run, reaction)) continue;
      if (listenerReacted(run.repo, reaction.subject, reaction.content)) continue;
      run.created.push({ reaction, at });
      added = true;
    }
    // The oldest past MAX_REACTIONS go: the run can't take those off any more (fail closed).
    const kept = run.created.filter((c) => c?.reaction);
    if (kept.length > MAX_REACTIONS) {
      const dropped = new Set(kept.slice(0, kept.length - MAX_REACTIONS));
      run.created.splice(0, run.created.length, ...run.created.filter((c) => !dropped.has(c)));
    }
    if (added) run.createdChanged?.();
  }

  // Takes the reactions `removed` names (answered()'s: { subject, id } or { subject, content })
  // off the run's own.
  function forget(run, removed) {
    if (!Array.isArray(run.created) || !removed.length) return;
    const gone = new Set(removed.map((r) => ownReaction(run, r)).filter(Boolean));
    if (!gone.size) return;
    const left = run.created.filter((c) => !gone.has(c?.reaction));
    run.created.splice(0, run.created.length, ...left);
    run.createdChanged?.();
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
    if (target.comment !== undefined) {
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
    const above = aboveCeiling(ceiling, target.kind, write.actions);
    if (above.length) {
      const on = target.number === null ? target.kind : `${target.kind} #${target.number}`;
      return refusal(403, `a ${mode} run can't ${above.join(", ")} on ${on} (its ceiling)`);
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
    // An inbox run's issues carry its label (prompts/idea.md, bug.md): in its ceiling too.
    const label = issueLabelOf(run.mode);
    const labelled = write.change.labels_added.some((l) => l.toLowerCase() === label);
    if (label && target.kind === "new_issue" && !labelled) {
      return refusal(403, `${mode} runs' issues carry the ${label} label (their ceiling)`);
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
      if (own && listenerReacted(run.repo, own.subject, own.content)) {
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
    const waiting = needsInputLabel()?.toLowerCase();
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
      ...runTraits(run),
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

// What the policies read of a run besides its mode (issue #448): `custom_mode`, whether the mode
// is one of the repo's `modes:` (a policy needn't list the built-in ones), `light`, whether it
// runs without a branch (it can't push: broker.mjs), and `reason`, why the listener started it
// itself ("review-fix", "ci-fix", "conflict"), null for a comment's.
export function runTraits(run) {
  return {
    custom_mode: !!run.mode && !BUILT_IN.has(run.mode),
    light: run.push !== true,
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

// Whether GitHub's issue (or parent) is in `repo` ("owner/name", lower case).
function inRepo(issue, repo) {
  const url = String(issue?.repository_url ?? "").toLowerCase();
  return url.endsWith(`/repos/${repo}`);
}

const refusal = (status, message) => ({ status, message });
// The issues a run labels besides its own, which never get or lose the needs-input label from it.
const OTHERS_LABELLED = new Set(["sub_issue", "created_issue"]);
