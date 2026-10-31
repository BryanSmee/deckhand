// What a run's GraphQL may do (issue #406): each call the GitHub gateway relays to GitHub's
// GraphQL (github-gateway.mjs) is parsed with graphql-js (bundled into vendor/graphql.mjs at
// image build: AGENTS.md) and validated against GitHub's schema, pinned in
// vendor/github.graphql (vendor/update-schema.mjs). Then:
//
// - a call that doesn't parse or validate, or that names no single operation (several without
//   a matching `operationName`), is refused, and so is a subscription;
// - a query goes on: the token it gets only reads (github-app.mjs readsOf()); one that selects
//   CI's results beyond Actions says so (checkReads()), for `read_checks` and its permissions;
// - each field of a mutation, through its fragments and under any alias, must be one MUTATIONS
//   names, with only the input fields it knows: any other is refused before any policy runs;
// - its targets come from GitHub: the node IDs it names (inline or in its variables, which
//   graphql-js resolves as GitHub will) are looked up with the listener's token, to a repo, a
//   kind and a number, never read from the call;
// - each field is then a write as a REST one is (github-writes.mjs classify()'s shape), held to
//   the policies' `allow_github` and `deny_github` (checkWrite()): one refusal refuses the whole
//   call;
// - what goes on to GitHub is the document as parsed here, printed again (print()), with its
//   variables and operation name, never the call's own bytes: GitHub runs what was checked.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { REACTION_ENUM } from "./comments.mjs";
import { PROJECT_WRITE } from "./github-app.mjs";
import { CONTENTS_WRITE, PULL_WRITE, pullOf } from "./github-pulls.mjs";
import { labelNames, permissionsOf, reactionSubject } from "./github-writes.mjs";
import {
  buildSchema,
  getArgumentValues,
  getOperationAST,
  getVariableValues,
  Kind,
  OverlappingFieldsCanBeMergedRule,
  parse,
  print,
  specifiedRules,
  validate,
} from "./vendor/graphql.mjs";

// The most tokens a document may hold (parsing stops there), and its most bytes, checked before
// it is parsed: gh's are a few hundred tokens, every field it can ask of a pull request or an
// issue about 1,200, and its bodies go in variables. Validation is quadratic in a document's
// repeated fields: at this size, under half a second at worst, which is why the gateway
// validates in a worker (createValidator()), not on the listener's one thread.
export const MAX_TOKENS = 2_500;
export const MAX_QUERY = 64 * 1024;
// The most mutation fields a call may hold (gh sends one): each is looked up on GitHub and
// held to the policies, with the listener's token and rate limit.
export const MAX_FIELDS = 10;
// How long a document may take to validate in the worker.
export const VALIDATE_MS = 10_000;
// The most node IDs a call's mutations may name: GitHub looks up 100 at once.
export const MAX_NODES = 100;

const SCHEMA = new URL("./vendor/github.graphql", import.meta.url);
let schema = null;
// GitHub's schema, built on the first call that needs it (it takes a moment).
export function githubSchema() {
  return (schema ??= buildSchema(readFileSync(SCHEMA, "utf8"), {
    assumeValid: true,
    assumeValidSDL: true,
  }));
}

// The types a target or a subject may be, as GitHub's node lookup answers them.
const ISSUE = ["Issue"];
const ISSUE_OR_PR = ["Issue", "PullRequest"];
// A review thread: its target is its pull request, the thread its first comment (writeOf()).
const THREAD = ["PullRequestReviewThread"];
// Comments: a reaction on an issue's or pull request's (REACTABLE_COMMENTS) is held to theirs,
// on the others refused as REST refuses them (a run edits the ones it posted
// with updateIssueComment, and deleteIssueComment, not through these). Those of a
// repository (RepositoryNode, which NODES reads); a discussion's comment has none, and is
// refused as outside it.
const COMMENTS = new Set([
  "IssueComment",
  "PullRequestReviewComment",
  "CommitComment",
  "PullRequestReview",
]);
// The comments a reaction's target may be (issue #458), as REST names their kind: their
// issue's or pull request's kind is then the target's (github-writes.mjs resolveComment()).
const REACTABLE_COMMENTS = { IssueComment: "issue", PullRequestReviewComment: "review" };
// GraphQL's reactions, as REST names them (`change.content`).
export const REACTION_CONTENT = Object.fromEntries(
  Object.entries(REACTION_ENUM).map(([rest, graphql]) => [graphql, rest]),
);

// What a set of fields makes of an issue's or a pull request's update, as REST's PATCH does
// (github-writes.mjs patched()): a state first, then labels, assignees, the milestone, then
// the rest.
// A field sent as null counts as set: GraphQL tells it from one left out, and GitHub may read it
// as clearing the field (REST's `"milestone" in body` does the same).
function updated(input) {
  const actions = [];
  if ("state" in input) actions.push(input.state === "CLOSED" ? "close" : "reopen");
  if ("labelIds" in input) actions.push("label");
  if ("assigneeIds" in input) actions.push("assign");
  if ("milestoneId" in input) actions.push("milestone");
  const rest = ["state", "labelIds", "assigneeIds", "milestoneId"];
  if (!actions.length || Object.keys(input).some((k) => !rest.includes(k))) actions.push("edit");
  return actions;
}

// The mutations a run may send, by name. Each one's:
// - target: the input field that holds what it writes to, and the types it may be (`repo`: a
//   Repository, for a create, whose target is then `kind`);
// - fields: the input fields it may set besides that one and `clientMutationId` (any other set
//   is refused: a field GitHub adds may do what no check knows);
// - empty: input fields gh always sends, as null or [] when it sets nothing, dropped then (issue
//   #422): on a create, an empty one sets nothing;
// - actions(input): what it does, as github-writes.mjs names actions;
// - labels: the input field of label IDs it adds (`added`) or removes (`removed`), or sets in
//   place of the issue's (`set`);
// - named: the input field of the label it creates' name, its `labels_added` as REST's;
// - assignees: the input fields of the assignees it adds (`added`), removes (`removed`), or
//   sets in place of the issue's (`set`): `field`, by node ID (a User or a Bot), and `logins`,
//   by login (github-writes.mjs assigneesOf());
// - milestone: the input field of the milestone it sets (null clears it);
// - child: a link's sub-issue field; blocker: a "blocked by" link's blocking issue field;
// - reaction: `add` or `remove`, a reaction's (its subject may be a comment: REACTABLE_COMMENTS);
// - thread: its target is a review thread, written to as its pull request (writeOf());
// - project: the project (v2) field of an item it adds, which must be a granted one
//   (github-writes.mjs);
// - pull(input): a pull request's own write's head, base and draft (github-pulls.mjs);
// - permissions: what its token needs to write when it isn't `issues: write` (github-writes.mjs
//   writePermissions()).
// Deckhand's default policies allow the pull request ones to a work run, for its own pull
// requests only (../policy/mode-work.rego): opened,
// edited (`gh pr create` sets its labels and milestone with `updatePullRequest`), readied,
// drafted and its branch updated, and its review threads replied to, resolved and unresolved.
// Reviews and merges aren't mutations a run may send.
export const MUTATIONS = {
  createIssue: {
    target: "repositoryId",
    repo: true,
    kind: "new_issue",
    // Not `issueTemplate`: GitHub would add its labels and assignees, which no check sees.
    fields: ["title", "body", "labelIds", "assigneeIds", "milestoneId"],
    // gh issue create sends `projectIds: null` whenever it resolves any metadata (a label).
    // They are classic projects', which GitHub retired: gh adds a project (v2) item after the
    // create, with addProjectV2ItemById.
    empty: ["projectIds"],
    actions: (input) => [
      "create",
      ...("assigneeIds" in input ? ["assign"] : []),
      ...("milestoneId" in input ? ["milestone"] : []),
    ],
    labels: { field: "labelIds", as: "added" },
    assignees: { field: "assigneeIds", as: "added" },
    milestone: "milestoneId",
  },
  // A label of the run's repository, as `gh label create` makes it over REST. Not
  // updateLabel or deleteLabel: a label's settings aren't a run's.
  createLabel: {
    target: "repositoryId",
    repo: true,
    kind: "label",
    fields: ["name", "color", "description"],
    actions: () => ["create"],
    named: "name",
  },
  updateIssue: {
    target: "id",
    types: ISSUE,
    fields: ["title", "body", "labelIds", "assigneeIds", "milestoneId", "state"],
    actions: updated,
    labels: { field: "labelIds", as: "set" },
    assignees: { field: "assigneeIds", as: "set" },
    milestone: "milestoneId",
  },
  addComment: {
    target: "subjectId",
    types: ISSUE_OR_PR,
    fields: ["body"],
    actions: () => ["comment"],
  },
  // A comment the run posted (github-writes.mjs `created_comment`, by its id), as `gh issue
  // comment --edit-last` and `--delete-last` send: any other is refused before any look-up.
  updateIssueComment: {
    target: "id",
    types: ["IssueComment"],
    comment: true,
    fields: ["body"],
    actions: () => ["edit"],
  },
  deleteIssueComment: {
    target: "id",
    types: ["IssueComment"],
    comment: true,
    fields: [],
    actions: () => ["delete"],
  },
  addLabelsToLabelable: {
    target: "labelableId",
    types: ISSUE_OR_PR,
    fields: ["labelIds"],
    actions: () => ["label"],
    labels: { field: "labelIds", as: "added" },
  },
  removeLabelsFromLabelable: {
    target: "labelableId",
    types: ISSUE_OR_PR,
    fields: ["labelIds"],
    actions: () => ["label"],
    labels: { field: "labelIds", as: "removed" },
  },
  // Not their `assignees` or `agentAssignment`: Copilot's assignment, which starts it working.
  addAssigneesToAssignable: {
    target: "assignableId",
    types: ISSUE_OR_PR,
    fields: ["assigneeIds"],
    actions: () => ["assign"],
    assignees: { field: "assigneeIds", as: "added" },
  },
  removeAssigneesFromAssignable: {
    target: "assignableId",
    types: ISSUE_OR_PR,
    fields: ["assigneeIds"],
    actions: () => ["assign"],
    assignees: { field: "assigneeIds", as: "removed" },
  },
  // What `gh issue edit --add-assignee` and `gh issue create --assignee` send: every assignee,
  // by login.
  replaceActorsForAssignable: {
    target: "assignableId",
    types: ISSUE_OR_PR,
    fields: ["actorIds", "actorLogins"],
    actions: () => ["assign"],
    assignees: { field: "actorIds", logins: "actorLogins", as: "set" },
  },
  addSubIssue: {
    target: "issueId",
    types: ISSUE,
    fields: ["subIssueId", "replaceParent"],
    actions: () => ["link"],
    child: "subIssueId",
  },
  removeSubIssue: {
    target: "issueId",
    types: ISSUE,
    fields: ["subIssueId"],
    actions: () => ["link"],
    child: "subIssueId",
  },
  reprioritizeSubIssue: {
    target: "issueId",
    types: ISSUE,
    fields: ["subIssueId", "afterId", "beforeId"],
    actions: () => ["link"],
    child: "subIssueId",
  },
  addBlockedBy: {
    target: "issueId",
    types: ISSUE,
    fields: ["blockingIssueId"],
    actions: () => ["link"],
    blocker: "blockingIssueId",
  },
  removeBlockedBy: {
    target: "issueId",
    types: ISSUE,
    fields: ["blockingIssueId"],
    actions: () => ["link"],
    blocker: "blockingIssueId",
  },
  closeIssue: {
    target: "issueId",
    types: ISSUE,
    fields: ["stateReason"],
    actions: () => ["close"],
  },
  reopenIssue: { target: "issueId", types: ISSUE, fields: [], actions: () => ["reopen"] },
  addReaction: {
    target: "subjectId",
    types: ISSUE_OR_PR,
    comments: true,
    fields: ["content"],
    actions: () => ["react"],
    reaction: "add",
  },
  // Only the run's own reaction: the viewer's of that content, which GitHub removes, must be one
  // it added (github-writes.mjs), never the listener's.
  removeReaction: {
    target: "subjectId",
    types: ISSUE_OR_PR,
    comments: true,
    fields: ["content"],
    actions: () => ["unreact"],
    reaction: "remove",
  },
  // An item on a project (v2), as `gh project item-add` and `gh issue create --project` add it
  // (not `gh issue/pr edit --add-project`, which sends an updateIssue or updatePullRequest
  // with `projectIds: []` besides, refused as an update that may clear classic projects:
  // issue #422): its content is the target, an issue or a pull
  // request of the run's, and its project one the operator grants the repo (issue #454). Not
  // deleteProjectV2Item, archiving, an item's field values (the listener sets them:
  // projects.mjs), nor the project's own settings, fields or views.
  addProjectV2ItemById: {
    target: "contentId",
    types: ISSUE_OR_PR,
    fields: ["projectId"],
    actions: () => ["project"],
    project: "projectId",
    permissions: PROJECT_WRITE,
  },
  createPullRequest: {
    target: "repositoryId",
    repo: true,
    kind: "new_pr",
    fields: ["baseRefName", "headRefName", "title", "body", "maintainerCanModify", "draft"],
    actions: () => ["create"],
    pull: (input) => ({
      head: input.headRefName,
      base: input.baseRefName,
      draft: input.draft === true,
    }),
    permissions: PULL_WRITE,
  },
  updatePullRequest: {
    target: "pullRequestId",
    types: ["PullRequest"],
    fields: [
      "baseRefName",
      "title",
      "body",
      "state",
      "maintainerCanModify",
      "labelIds",
      "assigneeIds",
      "milestoneId",
    ],
    actions: updated,
    labels: { field: "labelIds", as: "set" },
    assignees: { field: "assigneeIds", as: "set" },
    milestone: "milestoneId",
    pull: (input) => ({ base: input.baseRefName ?? undefined }),
    permissions: PULL_WRITE,
  },
  markPullRequestReadyForReview: {
    target: "pullRequestId",
    types: ["PullRequest"],
    fields: [],
    actions: () => ["ready"],
    pull: () => ({}),
    permissions: CONTENTS_WRITE,
  },
  convertPullRequestToDraft: {
    target: "pullRequestId",
    types: ["PullRequest"],
    fields: [],
    actions: () => ["draft"],
    pull: () => ({}),
    permissions: CONTENTS_WRITE,
  },
  // Not `pullRequestReviewId`: the reply would go into a pending review, and a run sends no
  // review.
  addPullRequestReviewThreadReply: {
    target: "pullRequestReviewThreadId",
    types: THREAD,
    thread: true,
    fields: ["body"],
    actions: () => ["reply"],
    permissions: PULL_WRITE,
  },
  resolveReviewThread: {
    target: "threadId",
    types: THREAD,
    thread: true,
    fields: ["resolutionReason"],
    actions: () => ["resolve"],
    permissions: PULL_WRITE,
  },
  unresolveReviewThread: {
    target: "threadId",
    types: THREAD,
    thread: true,
    fields: [],
    actions: () => ["unresolve"],
    permissions: PULL_WRITE,
  },
  // `gh pr update-branch [--rebase]`: merge only, from the head the run saw (github-pulls.mjs).
  updatePullRequestBranch: {
    target: "pullRequestId",
    types: ["PullRequest"],
    fields: ["expectedHeadOid", "updateMethod"],
    actions: () => ["update_branch"],
    pull: (input) => ({ expected_head: input.expectedHeadOid, method: input.updateMethod }),
    permissions: CONTENTS_WRITE,
  },
};

// What GitHub's node lookup reads of each node: enough to say what it is and where.
const NODES = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    id
    ... on Repository { nameWithOwner }
    ... on Issue { number databaseId repository { nameWithOwner } }
    ... on PullRequest { number repository { nameWithOwner } }
    ... on Label { name repository { nameWithOwner } }
    ... on IssueComment { fullDatabaseId }
    ... on PullRequestReviewComment { fullDatabaseId }
    ... on ProjectV2 { number title owner { __typename ... on Organization { login } ... on User { login } } }
    ... on Milestone { number title repository { nameWithOwner } }
    ... on Actor { login }
    ... on RepositoryNode { repository { nameWithOwner } }
    ... on Reactable { reactionGroups { content viewerHasReacted } }
    ... on PullRequestReviewThread {
      repository { nameWithOwner }
      pullRequest { number }
      comments(first: 1) { nodes { databaseId } }
    }
  }
}`;

const refusal = (status, message) => ({ status, message });
// Who may be assigned: no organization, mannequin or enterprise account.
const ACTORS = new Set(["User", "Bot"]);

// A GraphQL call's body → { query, doc, variables, operationName } or { refused }: its JSON
// read, its document under the caps and parsed (in linear time: validation is apart).
export function readCall(body) {
  let call;
  try {
    call = JSON.parse(body.toString("utf8"));
  } catch {
    return { refused: refusal(400, "a GraphQL call that isn't JSON") };
  }
  const { query, variables = null, operationName = null } = call ?? {};
  if (typeof query !== "string") return { refused: refusal(400, "a GraphQL call without a query") };
  if (variables !== null && (typeof variables !== "object" || Array.isArray(variables))) {
    return { refused: refusal(400, "a GraphQL call whose variables aren't an object") };
  }
  if (operationName !== null && typeof operationName !== "string") {
    return { refused: refusal(400, "a GraphQL call whose operationName isn't a string") };
  }
  const doc = parsed(query);
  if (doc.refused) return doc;
  return { query, doc, variables, operationName };
}

// A document under the caps, parsed, or { refused }.
function parsed(query) {
  if (Buffer.byteLength(query) > MAX_QUERY) {
    return { refused: refusal(413, `a GraphQL document over ${MAX_QUERY} bytes`) };
  }
  try {
    return parse(query, { maxTokens: MAX_TOKENS, noLocation: true });
  } catch (error) {
    return { refused: refusal(400, `its GraphQL doesn't parse: ${error.message}`) };
  }
}

// The rules a document without a mutation is validated with: all of the spec's but the one on
// fields that can't merge, which GitHub doesn't apply to fragments on distinct types (gh's own
// `issue view` selects `...on Issue{state}` and `...on PullRequest{state}`, of two enums). A
// query only gets a token that reads; a mutation keeps every rule, so what its fields write
// is never ambiguous.
const READ_RULES = specifiedRules.filter((rule) => rule !== OverlappingFieldsCanBeMergedRule);
const mutates = (doc) =>
  doc.definitions.some((d) => d.kind === Kind.OPERATION_DEFINITION && d.operation === "mutation");

// Why a document isn't valid on GitHub, or null when it is: what the worker answers
// (github-graphql-worker.mjs), and the in-thread validator of the tests.
export function validationError(query, schema = githubSchema()) {
  const doc = parsed(query);
  if (doc.refused) return doc.refused.message;
  const errors = validate(schema, doc, mutates(doc) ? specifiedRules : READ_RULES, {
    maxErrors: 1,
  });
  return errors.length ? `its GraphQL isn't valid on GitHub: ${errors[0].message}` : null;
}

// A read and validated call → { doc, op, variables, operationName, coerced } or { refused }:
// its operation picked as GitHub picks it, and its variables coerced to their types.
export function operationOf(schema, { doc, variables, operationName }) {
  const op = getOperationAST(doc, operationName ?? undefined);
  if (!op) {
    return {
      refused: refusal(
        400,
        "its GraphQL names no single operation: send one, or its operationName",
      ),
    };
  }
  if (op.operation === "subscription") {
    return { refused: refusal(400, "a GraphQL subscription") };
  }
  const values = getVariableValues(schema, op.variableDefinitions ?? [], variables ?? {}, {
    maxErrors: 1,
  });
  if (values.errors) {
    return { refused: refusal(400, `its GraphQL variables: ${values.errors[0].message}`) };
  }
  return { doc, op, variables, operationName, coerced: values.variableValues };
}

// A GraphQL call's body → operationOf()'s, validated on this thread: the tests' shortcut.
export function parseCall(body, schema = githubSchema()) {
  const call = readCall(body);
  if (call.refused) return call;
  const error = validationError(call.query, schema);
  if (error) return { refused: refusal(400, error) };
  return operationOf(schema, call);
}

// Validation in a worker thread: (query, run) → a promise of null (valid) or { status,
// message }, so the listener's webhooks, dashboard and REST calls never wait for it. The worker
// validates one document at a time, taken from the runs in turn: a run that floods it only
// delays itself, the others waiting one document of each run ahead at most (the gateway's
// `maxInFlight` bounds how many a run sends at once). A document
// validated for over `timeoutMs` is refused alone, the worker stopped and started again for the
// rest (its time counted once the worker has built GitHub's schema).
export function createValidator({ timeoutMs = VALIDATE_MS } = {}) {
  let worker = null;
  let next = 0;
  // run → its documents waiting, in order; the runs in turn (a Map keeps the order they came
  // in, and a run served goes to its end).
  const queues = new Map();
  let current = null;
  function start() {
    const started = new Worker(new URL("./github-graphql-worker.mjs", import.meta.url));
    started.unref();
    started.on("message", ({ ready, id, error }) => {
      // Its schema built: what it takes is timed from now on.
      if (ready) return ((started.ready = true), pump());
      if (current?.id !== id) return;
      finish(error === null ? null : refusal(400, error));
    });
    const lost = (message) => {
      if (worker !== started) return;
      worker = null;
      // One that never got ready would only fail again: what waits is refused, and the next
      // call tries anew.
      if (!started.ready) refuseAll(message);
      finish(refusal(503, message));
    };
    started.on("error", (error) => lost(`its GraphQL couldn't be validated: ${error.message}`));
    started.on("exit", () => lost("its GraphQL couldn't be validated"));
    return started;
  }
  // The document being validated is answered, and the next one sent.
  function finish(answer) {
    const done = current;
    current = null;
    if (done) {
      clearTimeout(done.timer);
      done.resolve(answer);
    }
    pump();
  }
  function pump() {
    if (current || !queues.size) return;
    worker ??= start();
    if (!worker.ready) return;
    const [run, queue] = queues.entries().next().value;
    current = queue.shift();
    queues.delete(run);
    if (queue.length) queues.set(run, queue);
    current.timer = setTimeout(() => {
      const stuck = worker;
      worker = null;
      stuck?.terminate();
      finish(refusal(503, `its GraphQL took over ${timeoutMs / 1000} s to validate`));
    }, timeoutMs);
    current.timer.unref?.();
    worker.postMessage({ id: current.id, query: current.query });
  }
  function check(query, run = null) {
    const queue = queues.get(run) ?? [];
    return new Promise((resolve) => {
      queue.push({ id: next++, query, resolve });
      if (!queues.has(run)) queues.set(run, queue);
      pump();
    });
  }
  function refuseAll(message) {
    for (const queue of queues.values()) {
      for (const p of queue) p.resolve(refusal(503, message));
    }
    queues.clear();
  }
  function close() {
    refuseAll("the validator is closed");
    const was = worker;
    worker = null;
    was?.terminate();
    if (current) {
      clearTimeout(current.timer);
      current.resolve(refusal(503, "the validator is closed"));
      current = null;
    }
  }
  return { check, close };
}

// The fields an operation selects at its root (selected()). Validation has ruled out cycles and
// fragments on other types.
export function rootFields(doc, op) {
  return selected(doc, op.selectionSet);
}

// A mutation's root fields → [{ name, key, spec, input }], or { refused }: each one MUTATIONS
// names, its input (`input:` as graphql-js resolves it, inline or from the variables) with only
// the fields it knows. `__typename` asks nothing.
export function mutationFields({ doc, op, coerced }, schema = githubSchema()) {
  const defs = schema.getMutationType().getFields();
  const out = [];
  // Fields with the same response key are one, which GitHub runs once (validation has made
  // sure they are the same field with the same arguments): checked once, their nodes together.
  const byKey = new Map();
  for (const field of rootFields(doc, op)) {
    const name = field.name.value;
    if (name === "__typename") continue;
    const key = field.alias?.value ?? name;
    if (byKey.has(key)) {
      byKey.get(key).nodes.push(field);
      continue;
    }
    if (byKey.size >= MAX_FIELDS) {
      return { refused: refusal(400, `a GraphQL call with over ${MAX_FIELDS} mutation fields`) };
    }
    const spec = Object.hasOwn(MUTATIONS, name) ? MUTATIONS[name] : null;
    if (!spec) return { refused: refusal(403, `Deckhand doesn't let a run send ${name}`) };
    // It can still refuse a value validation let through (a variable's default replaced by
    // null where the argument takes none).
    let input;
    try {
      ({ input = {} } = getArgumentValues(defs[name], field, coerced));
    } catch (error) {
      return { refused: refusal(400, `its GraphQL arguments: ${error.message}`) };
    }
    // The fields it sets, null ones too: GitHub may read null as clearing a field (updated()),
    // so an unknown one sent as null is refused as one with a value is. Only those the spec
    // names `empty` go when empty; the document GitHub gets still has them, which it accepts.
    const known = [spec.target, ...spec.fields];
    const empty = (k, v) =>
      spec.empty?.includes(k) && (v === null || (Array.isArray(v) && !v.length));
    const set = Object.fromEntries(
      Object.entries(input ?? {}).filter(([k, v]) => k !== "clientMutationId" && !empty(k, v)),
    );
    const unknown = Object.keys(set).filter((k) => !known.includes(k));
    if (unknown.length) {
      return {
        refused: refusal(403, `Deckhand doesn't let a run set ${name}'s ${unknown.join(", ")}`),
      };
    }
    if (typeof set[spec.target] !== "string") {
      return { refused: refusal(400, `${name} without its ${spec.target}`) };
    }
    if (spec.child && typeof set[spec.child] !== "string") {
      return { refused: refusal(403, `${name} names its sub-issue by its ${spec.child} only`) };
    }
    if (spec.blocker && typeof set[spec.blocker] !== "string") {
      return { refused: refusal(400, `${name} without its ${spec.blocker}`) };
    }
    if (spec.project && typeof set[spec.project] !== "string") {
      return { refused: refusal(400, `${name} without its ${spec.project}`) };
    }
    const entry = { name, key, spec, input: set, nodes: [field] };
    byKey.set(key, entry);
    out.push(entry);
  }
  return out;
}

// The node IDs a call's mutations name: their targets, sub-issues, blockers, projects, labels,
// assignees and milestones.
function idsOf(fields) {
  const ids = new Set();
  for (const { spec, input } of fields) {
    ids.add(input[spec.target]);
    if (spec.child) ids.add(input[spec.child]);
    if (spec.blocker) ids.add(input[spec.blocker]);
    if (spec.project) ids.add(input[spec.project]);
    if (spec.milestone && typeof input[spec.milestone] === "string") ids.add(input[spec.milestone]);
    for (const id of spec.labels ? (input[spec.labels.field] ?? []) : []) ids.add(id);
    for (const id of spec.assignees ? (input[spec.assignees.field] ?? []) : []) ids.add(id);
  }
  return [...ids];
}

// An input field's name as a REST body would name it, so a policy on `change.fields` reads one
// spelling for both: `labelIds` → `labels`, `assigneeIds` → `assignees`, `milestoneId` →
// `milestone`, `actorIds` and `actorLogins` → `assignees`, `baseRefName` → `base`,
// `blockingIssueId` → `issue_id`, `expectedHeadOid` → `expected_head_sha`, the others in snake
// case
// (`subIssueId` → `sub_issue_id`).
const REST_NAMES = {
  blockingIssueId: "issue_id",
  labelIds: "labels",
  assigneeIds: "assignees",
  milestoneId: "milestone",
  actorIds: "assignees",
  actorLogins: "assignees",
  baseRefName: "base",
  headRefName: "head",
  expectedHeadOid: "expected_head_sha",
};
export function restName(field) {
  return REST_NAMES[field] ?? field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// An IssueComment node's id (its `fullDatabaseId`, a BigInt GitHub sends as a string), or null.
function commentId(node) {
  const id = Number(node?.fullDatabaseId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const repoOf = (node) => String(node?.nameWithOwner ?? node?.repository?.nameWithOwner ?? "");

// The fields selection sets select, through their fragments (spread or inline), each node
// once: a fragment is walked the first time it is spread only, since its fields are the same
// nodes wherever it is spread again. Walking it each time would expand a small document
// exponentially (fragments spreading each other ten times over), which validation doesn't
// catch. `sets`: one, or a list, walked together.
function selected(doc, sets) {
  const fragments = new Map(
    doc.definitions
      .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
      .map((d) => [d.name.value, d]),
  );
  const seen = new Set();
  const fields = [];
  const walk = (inner) => {
    for (const node of inner?.selections ?? []) {
      if (node.kind === Kind.FIELD) fields.push(node);
      else if (node.kind === Kind.INLINE_FRAGMENT) walk(node.selectionSet);
      else if (node.kind === Kind.FRAGMENT_SPREAD && !seen.has(node.name.value)) {
        seen.add(node.name.value);
        walk(fragments.get(node.name.value)?.selectionSet);
      }
    }
  };
  for (const set of [sets].flat()) walk(set);
  return fields;
}
const keyOf = (field) => field.alias?.value ?? field.name.value;

// The fields under `path` of `fields` (the nodes of one response key, whose selections GitHub
// merges), each step under GitHub's own name: none aliased to another's, nor another field
// aliased to it. Null otherwise, or when one isn't selected.
function ownPath(doc, fields, path) {
  let found = [fields].flat();
  for (const name of path) {
    found = selected(
      doc,
      found.map((f) => f.selectionSet),
    ).filter((f) => keyOf(f) === name);
    if (!found.length || found.some((f) => f.name.value !== name)) return null;
  }
  return found;
}

// The types that hold CI's results beyond Actions, by the permission GitHub reads them with
// (github-gateway.mjs CHECK_READS): check runs and suites, commit statuses, and the rollup of
// both that `gh pr checks` and `gh pr view` select. Their enums and scalars are only reached
// through them.
const CHECK_TYPES = /^Check(?:Run|Suite|Step|Annotation)/;
const STATUS_TYPES = new Set(["Status", "StatusContext", "StatusContextStateCount"]);
const ROLLUP_TYPES = /^StatusCheckRollup/;

// The most response paths checkSelections() keeps: fragments spread under several aliases at
// each level could name exponentially many. Past it, none is kept (paths: null).
export const MAX_CHECK_PATHS = 500;

// What an operation reads of CI's results → { checks: "read", statuses: "read" }, either or
// both, or {}: any field it selects, through its fragments, whose type is one of theirs, and any
// fragment on one of them (`node(id:) { ... on CheckRun }`). A validated document: its fields
// are its types'.
export function checkReads(schema, doc, op) {
  return checkSelections(schema, doc, op).reads;
}

// checkReads()'s work → { reads, paths }: `paths`, the response paths (keys, aliases as such,
// without list indices) of those fields, and of the fields a fragment on their types is spread
// under: what GitHub refuses without the permissions is at or under one of them
// (github-gateway.mjs explained()). Null past MAX_CHECK_PATHS. Each named fragment is walked
// once, on its own type condition, its paths then put under each place it is spread.
export function checkSelections(schema, doc, op) {
  const fragments = new Map(
    doc.definitions
      .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
      .map((d) => [d.name.value, d]),
  );
  let over = false;
  const kinds = (type) => {
    const name = type?.name ?? "";
    const out = [];
    if (CHECK_TYPES.test(name) || ROLLUP_TYPES.test(name)) out.push("checks");
    if (STATUS_TYPES.has(name) || ROLLUP_TYPES.test(name)) out.push("statuses");
    return out;
  };
  const named = (type) => {
    let t = type;
    while (t?.ofType) t = t.ofType;
    return t;
  };
  // The object types a value of `type` may be: an interface's or a union's members, or itself.
  const possible = (type) => {
    if (!type) return [];
    const members = schema.getPossibleTypes(type) ?? [];
    return members.length ? members : [type];
  };
  const abstract = (type) => !!type && possible(type)[0] !== type;
  // What an abstract type, at a place whose value is one of `runtime`, reads of them: a fragment
  // on an interface a check run implements (`node(id:) { ... on UniformResourceLocatable { url
  // } }`), or fields selected on `resource(url:)`. Only when it selects something besides
  // `__typename` and `id`, which say nothing of a check.
  // `set`, on `type`: through untyped inline fragments (`... @include(if: …) { url }`) and the
  // named fragments on that same type, which select on the same value; a fragment on another
  // type is walk()'s, as any. A named fragment is looked into once.
  const told = new Map();
  const telling = (set, type) =>
    (set?.selections ?? []).some((n) => {
      if (n.kind === Kind.FIELD) return !["__typename", "id"].includes(n.name.value);
      if (n.kind === Kind.INLINE_FRAGMENT) {
        const same = !n.typeCondition || n.typeCondition.name.value === type?.name;
        return same && telling(n.selectionSet, type);
      }
      const fragment = fragments.get(n.name.value);
      if (fragment?.typeCondition.name.value !== type?.name) return false;
      if (!told.has(fragment)) {
        told.set(fragment, false);
        told.set(fragment, telling(fragment.selectionSet, type));
      }
      return told.get(fragment);
    });
  const kindsOf = (type, runtime, set) => {
    const own = new Set(kinds(type));
    if (abstract(type) && telling(set, type))
      for (const t of runtime) for (const k of kinds(t)) own.add(k);
    return [...own];
  };
  const within = (runtime, type) => {
    const names = new Set(possible(type).map((t) => t.name));
    return runtime.filter((t) => names.has(t.name));
  };
  const memo = new Map();
  // A selection set on `parent`, whose value is one of `runtime` → { reads: Set, paths:
  // [relative paths] }; [] is the set's own place (a fragment on a check type).
  const walk = (set, parent, runtime = possible(parent)) => {
    const reads = new Set();
    const paths = [];
    const add = (path) => {
      if (paths.length >= MAX_CHECK_PATHS) over = true;
      else paths.push(path);
    };
    const merge = (own, inner, prefix) => {
      for (const k of [...own, ...inner.reads]) reads.add(k);
      if (own.length) add(prefix);
      else for (const p of inner.paths) add([...prefix, ...p]);
    };
    for (const node of set?.selections ?? []) {
      if (node.kind === Kind.FIELD) {
        const type = named(parent?.getFields?.()[node.name.value]?.type);
        if (!node.selectionSet) {
          merge(kinds(type), { reads: [], paths: [] }, [keyOf(node)]);
          continue;
        }
        const here = possible(type);
        const own = kindsOf(type, here, node.selectionSet);
        merge(own, walk(node.selectionSet, type, here), [keyOf(node)]);
      } else if (node.kind === Kind.INLINE_FRAGMENT) {
        if (!node.typeCondition) {
          merge([], walk(node.selectionSet, parent, runtime), []);
          continue;
        }
        const type = schema.getType(node.typeCondition.name.value);
        const here = within(runtime, type);
        merge(kindsOf(type, here, node.selectionSet), walk(node.selectionSet, type, here), []);
      } else if (node.kind === Kind.FRAGMENT_SPREAD) {
        const name = node.name.value;
        const fragment = fragments.get(name);
        const type = fragment && schema.getType(fragment.typeCondition.name.value);
        // Walked once, on its own type: wider than where it is spread, never narrower.
        if (!memo.has(name)) memo.set(name, walk(fragment?.selectionSet, type));
        const own = kindsOf(type, within(runtime, type), fragment?.selectionSet);
        merge(own, memo.get(name), []);
      }
    }
    return { reads, paths };
  };
  const { reads, paths } = walk(op.selectionSet, schema.getRootType(op.operation));
  return {
    reads: Object.fromEntries([...reads].sort().map((k) => [k, "read"])),
    paths: over ? null : paths,
  };
}

// Whether a createIssue field's answer names the issue it created where github-writes.mjs
// answered() reads it (`issue.url`, else `issue.html_url`), as GitHub's own fields: `issue`
// and `url` unaliased (or aliased to themselves), and no `html_url`, which GraphQL's Issue
// doesn't have, so it could only be another field's alias. Otherwise a run could answer
// `url: title` with a title of its choosing, and claim an issue it didn't create.
export function answersCreated(doc, fields) {
  const issues = ownPath(doc, fields, ["issue"]);
  if (!issues || !ownPath(doc, issues, ["url"])) return false;
  const inner = selected(
    doc,
    issues.map((f) => f.selectionSet),
  );
  return !inner.some((f) => keyOf(f) === "html_url");
}

// Whether an addComment field's answer names the comment it posted where github-writes.mjs
// answered() reads it (`commentEdge.node.url`), as GitHub's own fields, as answersCreated():
// otherwise `url: body` would claim the comment its body names, the listener's say.
export function answersComment(doc, fields) {
  return ownPath(doc, fields, ["commentEdge", "node", "url"]) !== null;
}

// A mutation field and the nodes it names → a write in github-writes.mjs classify()'s shape,
// or { refused }. `repo`: the run's: a node elsewhere, or missing, is refused alike before its
// type is named, so a refusal says nothing of another repository's nodes.
export function writeOf({ name, spec, input }, nodes, repo) {
  const node = nodes.get(input[spec.target]);
  let thread = null;
  const elsewhere = (field) =>
    refusal(403, `${name}'s ${field} isn't in the run's repository, or isn't there`);
  if (!node || repoOf(node).toLowerCase() !== repo) return { refused: elsewhere(spec.target) };
  let target;
  if (spec.repo) {
    if (node.__typename !== "Repository") {
      return { refused: refusal(403, `${name}'s ${spec.target} isn't a repository`) };
    }
    target = { kind: spec.kind };
  } else if (spec.thread && spec.types.includes(node.__typename)) {
    // Its first comment names the thread as REST's replies do (github-writes.mjs).
    const comment = node.comments?.nodes?.[0]?.databaseId;
    if (!Number.isSafeInteger(node.pullRequest?.number) || !Number.isSafeInteger(comment)) {
      return { refused: refusal(404, `${name}'s ${spec.target} has no pull request or comment`) };
    }
    target = { number: node.pullRequest.number };
    thread = { comment };
  } else if (spec.types.includes(node.__typename)) {
    // A comment by its id, as REST's path names it: `databaseId`, an Int, no longer holds them.
    target = spec.comment ? { comment: commentId(node) } : { number: node.number };
  } else if (spec.reaction && REACTABLE_COMMENTS[node.__typename]) {
    // Its issue or pull request, looked up by the comment's id (REST's).
    const id = commentId(node);
    if (id === null) {
      return { refused: refusal(403, `${name} on a comment whose id it can't read`) };
    }
    target = { reacted: { id, type: REACTABLE_COMMENTS[node.__typename] } };
  } else if (spec.comments && COMMENTS.has(node.__typename)) {
    // Refused before any look-up (github-writes.mjs ID_TARGETS).
    target = { kind: "comment" };
  } else {
    return { refused: refusal(403, `${name} on a ${node.__typename} isn't something it checks`) };
  }
  // What it sets, as a REST write's body would: its target is its path's.
  const { [spec.target]: _, ...set } = input;
  const actions = spec.actions(set);
  const change = { fields: Object.keys(set).map(restName), labels_added: [], labels_removed: [] };
  // Labels set to null: none, so a `set` removes them all.
  if (spec.labels && spec.labels.field in input) {
    const names = [];
    for (const id of input[spec.labels.field] ?? []) {
      const label = nodes.get(id);
      if (label?.__typename !== "Label" || repoOf(label).toLowerCase() !== repo) {
        return { refused: refusal(403, `${name} names a label that isn't its repository's`) };
      }
      names.push(label.name);
    }
    if (spec.labels.as === "removed") change.labels_removed = names;
    else change.labels_added = names;
    if (spec.labels.as === "set") change.labels_set = true;
  }
  if (spec.named) change.labels_added = labelNames([input[spec.named]]);
  // The same field twice (`actorIds` and `actorLogins`, both `assignees`): once.
  change.fields = [...new Set(change.fields)];
  const write = { repo, actions, target, change };
  // A reaction's subject and content, as REST's; `fresh`: one the bot (the listener's token's
  // viewer, as the run's) hasn't added yet, which the run's then is once GitHub runs it.
  if (spec.reaction && target.kind === undefined) {
    const content = REACTION_CONTENT[input.content] ?? null;
    write.reaction = { subject: reactionSubject(target), content };
    if (spec.reaction === "add") {
      const group = (node.reactionGroups ?? []).find((g) => g?.content === input.content);
      write.reaction.fresh = !group?.viewerHasReacted;
    }
  }
  // Its assignees, by login as REST names them (a Bot's with `[bot]`): set to null or left
  // out, none.
  const { field: ids, logins } = spec.assignees ?? {};
  if (spec.assignees && actions.includes("assign")) {
    const names = [];
    for (const id of input[ids] ?? []) {
      const actor = nodes.get(id);
      if (!ACTORS.has(actor?.__typename) || typeof actor.login !== "string") {
        return { refused: refusal(403, `${name} names an assignee that isn't a user`) };
      }
      names.push(actor.__typename === "Bot" ? `${actor.login}[bot]` : actor.login);
    }
    names.push(...((logins && input[logins]) ?? []));
    write.assignees = { logins: names, as: spec.assignees.as };
  }
  // Its milestone, the run's repository's, or null to clear it.
  if (spec.milestone && spec.milestone in input) {
    const id = input[spec.milestone];
    const found = id === null ? null : nodes.get(id);
    if (
      id !== null &&
      (found?.__typename !== "Milestone" || repoOf(found).toLowerCase() !== repo)
    ) {
      return { refused: elsewhere(spec.milestone) };
    }
    write.milestone = found ? { number: found.number, title: found.title } : { number: null };
  }
  if (spec.pull) write.pull = spec.pull(set);
  if (thread) write.thread = thread;
  if (spec.permissions) write.permissions = spec.permissions;
  // The project an item goes on: outside the repository, so not refused as elsewhere. Which
  // ones the run may write is the grant's (github-writes.mjs). GitHub answers null for a
  // project the App can't see, as it does for every one when the installation lacks
  // organization_projects: the refusal says what it needs (`needs`), and the gateway names the
  // permission instead when the installation lacks it (github-gateway.mjs unaccepted()).
  if (spec.project) {
    const project = nodes.get(input[spec.project]);
    if (project?.__typename !== "ProjectV2") {
      return {
        refused: {
          ...refusal(
            403,
            `${name}'s ${spec.project} isn't a project, or the GitHub App can't see it`,
          ),
          needs: spec.permissions,
        },
      };
    }
    write.project = {
      owner: String(project.owner?.login ?? "").toLowerCase(),
      number: project.number,
      title: project.title ?? null,
    };
  }
  // The other issue a link names, its sub-issue or its blocker: in the run's repo (GitHub
  // allows cross-repository ones, a run doesn't), an issue.
  const linked = (field) => {
    const issue = nodes.get(input[field]);
    if (!issue || repoOf(issue).toLowerCase() !== repo) return { refused: elsewhere(field) };
    if (issue.__typename !== "Issue") {
      return { refused: refusal(404, `${name}'s ${field} isn't an issue`) };
    }
    return { id: issue.databaseId ?? null, number: issue.number, repo };
  };
  if (spec.child) {
    const sub = linked(spec.child);
    if (sub.refused) return sub;
    write.child = {
      ...sub,
      // Moving it from another parent: refused (github-writes.mjs). Any value but false,
      // null too, as REST's child() reads it: fail closed.
      replace_parent: "replaceParent" in input && input.replaceParent !== false,
    };
  }
  if (spec.blocker) {
    const blocker = linked(spec.blocker);
    if (blocker.refused) return blocker;
    write.blocker = blocker;
  }
  return write;
}

// `nodes(repo, ids)`: GitHub's answer to NODES for those IDs, with the listener's token (a
// missing one: null); `checkWrite(run, write)`: github-writes.mjs's, null when it may go on.
// `validator`: createValidator()'s check, or (the tests') validationError() on this thread.
// `files(run, { schema, doc, op, variables })`: null when the run's operation may read what it
// does, else { status, message } (github-forks.mjs checkGraphql(): a work run that isn't a
// fork's reads nothing of a fork's).
export function createGraphqlChecks({
  nodes,
  checkWrite,
  // github-writes.mjs createWriteChecks()'s `budget`: the node look-up is one of the run's
  // look-ups for refused writes (MAX_REFUSED_LOOKUPS), past which none is made. None: uncounted.
  budget = null,
  files = async () => null,
  schema = githubSchema,
  validator = async (query) => {
    const error = validationError(query, schema());
    return error && refusal(400, error);
  },
  log = () => {},
}) {
  // A run's GraphQL call → { refused } or { body, write, creates, comments, reacts, unreacts,
  // permissions, pulls, reads, readPaths }: what goes on to GitHub (printed again), whether it
  // writes (its token then may), the response keys of its `createIssue` fields, whose answers
  // name the issues it created, and of its `addComment` ones, the comments it posted, the new
  // reactions it adds and those it removes ({ key, subject, content }) (github-writes.mjs
  // answered()), what its token needs to write (github-writes.mjs permissionsOf()), the pull
  // requests it changes (github-pulls.mjs pullOf()), and the optional permissions its reads need,
  // with where they are in the answer (checkSelections()).
  async function check(run, body) {
    const call = readCall(body);
    if (call.refused) return call;
    const invalid = await validator(call.query, run);
    if (invalid) return { refused: invalid };
    const parsed = operationOf(schema(), call);
    if (parsed.refused) return parsed;
    const { doc, op, variables, operationName } = parsed;
    // Its variables' values, defaults applied (graphql-js keeps them under `coerced`).
    const unread = await files(run, {
      schema: schema(),
      doc,
      op,
      variables: parsed.coerced?.coerced ?? {},
    });
    if (unread) return { refused: refusal(unread.status, unread.message) };
    const forwarded = Buffer.from(
      JSON.stringify({
        query: print(doc),
        ...(operationName !== null && { operationName }),
        ...(variables !== null && { variables }),
      }),
    );
    const { reads, paths: readPaths } = checkSelections(schema(), doc, op);
    if (op.operation !== "mutation") {
      return {
        body: forwarded,
        write: false,
        creates: [],
        comments: [],
        reacts: [],
        unreacts: [],
        permissions: {},
        pulls: [],
        reads,
        readPaths,
      };
    }
    const fields = mutationFields(parsed, schema());
    if (fields.refused) return fields;
    const ids = idsOf(fields);
    if (ids.length > MAX_NODES) {
      return { refused: refusal(400, `a GraphQL call naming over ${MAX_NODES} nodes`) };
    }
    const found = new Map();
    // The node look-up's cost, kept when the call is refused for something the run did.
    let cost = null;
    if (ids.length) {
      if (budget) {
        cost = budget.begin(run);
        if (!cost) return { refused: budget.spentOut() };
        cost.n++;
      }
      try {
        const answer = await nodes(run.repo, ids);
        ids.forEach((id, i) => found.set(id, answer?.[i] ?? null));
      } catch (error) {
        log(`GitHub gateway: ${run.repo} nodes: ${error.message ?? error}`);
        const refused = refusal(502, "its GraphQL's nodes can't be looked up on GitHub");
        if (cost) budget.settle(run, cost, refused);
        return { refused };
      }
    }
    // A field refused for the budget the node look-up just reached keeps that look-up counted:
    // the next call is refused before another.
    const done = (refused) => {
      if (cost && refused?.status !== 429) budget.settle(run, cost, refused);
      return refused && { refused };
    };
    // GitHub's answers about the targets, kept across the call's fields.
    const memo = new Map();
    const writes = [];
    for (const field of fields) {
      const write = writeOf(field, found, run.repo);
      if (write.refused) return done(write.refused);
      writes.push(write);
      const refused = await checkWrite(run, write, memo);
      if (refused) {
        // Its own message, the field's key first; whether it is the run's doing as it was.
        const keyed = { ...refused, message: `${field.key}: ${refused.message}` };
        if (refused.failed) Object.defineProperty(keyed, "failed", { value: true });
        return done(keyed);
      }
    }
    done(null);
    // Only those whose answer is GitHub's own `issue { url }`.
    const creates = fields
      .filter((f) => f.name === "createIssue" && answersCreated(doc, f.nodes))
      .map((f) => f.key);
    // And those whose answer is GitHub's own `commentEdge { node { url } }`.
    const comments = fields
      .filter((f) => f.name === "addComment" && answersComment(doc, f.nodes))
      .map((f) => f.key);
    // The reactions it adds that the bot hadn't: the run's once GitHub runs them; and those it
    // removes, no longer its own then.
    const reactions = (keep) =>
      writes
        .map((w, i) => w.reaction && keep(w) && { key: fields[i].key, ...w.reaction })
        .filter(Boolean)
        .map(({ key, subject, content }) => ({ key, subject, content }));
    const reacts = reactions((w) => w.reaction.fresh);
    const unreacts = reactions((w) => w.actions.includes("unreact"));
    return {
      body: forwarded,
      write: fields.length > 0,
      creates,
      comments,
      reacts,
      unreacts,
      permissions: permissionsOf(writes),
      pulls: writes.map((w, i) => pullOf(w, fields[i].key)).filter(Boolean),
      reads,
      readPaths,
    };
  }

  return { check };
}

// GitHub's nodes for `ids`, in their order (null for those it doesn't have), as `github(repo,
// method, path, body)` (github.mjs) answers NODES: a missing node comes with an error beside
// the others' data.
export async function lookupNodes(github, repo, ids) {
  const res = await github(repo, "POST", "/graphql", { query: NODES, variables: { ids } });
  const answer = await res.json().catch(() => ({}));
  const list = answer?.data?.nodes;
  if (!res.ok || !Array.isArray(list) || list.length !== ids.length) {
    throw new Error(
      `GraphQL nodes: ${res.status} ${JSON.stringify(answer.errors ?? answer).slice(0, 300)}`,
    );
  }
  // In the order asked (GitHub's own guarantee): an ID in its legacy format comes back in
  // the new one, so they can't be compared.
  return list;
}
