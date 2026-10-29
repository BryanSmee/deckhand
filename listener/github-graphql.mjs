// What a run's GraphQL may do (issue #406): each call the GitHub gateway relays to GitHub's
// GraphQL (github-gateway.mjs) is parsed with graphql-js (bundled into vendor/graphql.mjs at
// image build: AGENTS.md) and validated against GitHub's schema, pinned in
// vendor/github.graphql (vendor/update-schema.mjs). Then:
//
// - a call that doesn't parse or validate, or that names no single operation (several without
//   a matching `operationName`), is refused, and so is a subscription;
// - a query goes on: the token it gets only reads (github-app.mjs readsOf());
// - each field of a mutation, through its fragments and under any alias, must be one MUTATIONS
//   names, with only the input fields it knows: any other is refused before any policy runs;
// - its targets come from GitHub: the node IDs it names (inline or in its variables, which
//   graphql-js resolves as GitHub will) are looked up with the listener's token, to a repo, a
//   kind and a number, never read from the call;
// - each field is then a write as a REST one is (github-writes.mjs classify()'s shape), held to
//   the mode's ceiling and `deny_github` (checkWrite()): one refusal refuses the whole call;
// - what goes on to GitHub is the document as parsed here, printed again (print()), with its
//   variables and operation name, never the call's own bytes: GitHub runs what was checked.
import { readFileSync } from "node:fs";
import {
  buildSchema,
  getArgumentValues,
  getOperationAST,
  getVariableValues,
  Kind,
  parse,
  print,
  validate,
} from "./vendor/graphql.mjs";

// The most tokens a document may hold (parsing stops there), and its most bytes, checked before
// it is parsed: gh's are a few hundred tokens, every field it can ask of a pull request or an
// issue about 1,200, and its bodies go in variables. Validation is quadratic in a document's
// repeated fields, and the listener's one thread waits for it: at this size, a fifth of a
// second at worst.
export const MAX_TOKENS = 2_500;
export const MAX_QUERY = 64 * 1024;
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
// Comments no ceiling lets a run edit or react to: refused as REST refuses them.
const COMMENTS = new Set([
  "IssueComment",
  "PullRequestReviewComment",
  "CommitComment",
  "DiscussionComment",
  "PullRequestReview",
]);

// What a set of fields makes of an issue's or a pull request's update, as REST's PATCH does
// (github-writes.mjs patched()): a state first, then labels, assignees, the milestone, then
// the rest.
function updated(input) {
  const actions = [];
  if (input.state != null) actions.push(input.state === "CLOSED" ? "close" : "reopen");
  if (input.labelIds != null) actions.push("label");
  if (input.assigneeIds != null) actions.push("assign");
  if (input.milestoneId != null) actions.push("milestone");
  const rest = ["state", "labelIds", "assigneeIds", "milestoneId"];
  if (!actions.length || Object.keys(input).some((k) => !rest.includes(k))) actions.push("edit");
  return actions;
}

// The mutations a run may send, by name. Each one's:
// - target: the input field that holds what it writes to, and the types it may be (`repo`: a
//   Repository, for a create, whose target is then `kind`);
// - fields: the input fields it may set besides that one and `clientMutationId` (any other set
//   is refused: a field GitHub adds may do what no ceiling knows);
// - actions(input): what it does, as github-writes.mjs names actions;
// - labels: the input field of label IDs it adds (`added`) or removes (`removed`), or sets in
//   place of the issue's (`set`);
// - child: a link's sub-issue field.
// The pull request ones are refused by every ceiling until #407 moves `gh pr` here.
export const MUTATIONS = {
  createIssue: {
    target: "repositoryId",
    repo: true,
    kind: "new_issue",
    // Not `issueTemplate`: GitHub would add its labels and assignees, which no check sees.
    fields: ["title", "body", "labelIds", "assigneeIds", "milestoneId"],
    actions: (input) => [
      "create",
      ...(input.assigneeIds != null ? ["assign"] : []),
      ...(input.milestoneId != null ? ["milestone"] : []),
    ],
    labels: { field: "labelIds", as: "added" },
  },
  updateIssue: {
    target: "id",
    types: ISSUE,
    fields: ["title", "body", "labelIds", "assigneeIds", "milestoneId", "state"],
    actions: updated,
    labels: { field: "labelIds", as: "set" },
  },
  addComment: {
    target: "subjectId",
    types: ISSUE_OR_PR,
    fields: ["body"],
    actions: () => ["comment"],
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
  addAssigneesToAssignable: {
    target: "assignableId",
    types: ISSUE_OR_PR,
    fields: ["assigneeIds"],
    actions: () => ["assign"],
  },
  removeAssigneesFromAssignable: {
    target: "assignableId",
    types: ISSUE_OR_PR,
    fields: ["assigneeIds"],
    actions: () => ["assign"],
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
  },
  createPullRequest: {
    target: "repositoryId",
    repo: true,
    kind: "new_pr",
    fields: ["baseRefName", "headRefName", "title", "body", "maintainerCanModify", "draft"],
    actions: () => ["create"],
  },
  updatePullRequest: {
    target: "pullRequestId",
    types: ["PullRequest"],
    fields: ["baseRefName", "title", "body", "state", "maintainerCanModify"],
    actions: updated,
  },
  markPullRequestReadyForReview: {
    target: "pullRequestId",
    types: ["PullRequest"],
    fields: [],
    actions: () => ["ready"],
  },
  convertPullRequestToDraft: {
    target: "pullRequestId",
    types: ["PullRequest"],
    fields: [],
    actions: () => ["draft"],
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
  }
}`;

const refusal = (status, message) => ({ status, message });

// A GraphQL call's body → { doc, op, variables, operationName, coerced } or { refused }:
// parsed, validated against `schema`, its operation picked as GitHub picks it, and its
// variables coerced to their types.
export function parseCall(body, schema = githubSchema()) {
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
  if (Buffer.byteLength(query) > MAX_QUERY) {
    return { refused: refusal(413, `a GraphQL document over ${MAX_QUERY} bytes`) };
  }
  let doc;
  try {
    doc = parse(query, { maxTokens: MAX_TOKENS, noLocation: true });
  } catch (error) {
    return { refused: refusal(400, `its GraphQL doesn't parse: ${error.message}`) };
  }
  const errors = validate(schema, doc, undefined, { maxErrors: 1 });
  if (errors.length) {
    return { refused: refusal(400, `its GraphQL isn't valid on GitHub: ${errors[0].message}`) };
  }
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

// The fields an operation selects at its root, through its fragments (spread or inline), each
// once. Validation has ruled out cycles and fragments on other types.
export function rootFields(doc, op) {
  const fragments = new Map(
    doc.definitions
      .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
      .map((d) => [d.name.value, d]),
  );
  const fields = [];
  const walk = (set) => {
    for (const node of set.selections) {
      if (node.kind === Kind.FIELD) fields.push(node);
      else if (node.kind === Kind.INLINE_FRAGMENT) walk(node.selectionSet);
      else if (node.kind === Kind.FRAGMENT_SPREAD)
        walk(fragments.get(node.name.value).selectionSet);
    }
  };
  walk(op.selectionSet);
  return fields;
}

// A mutation's root fields → [{ name, key, spec, input }], or { refused }: each one MUTATIONS
// names, its input (`input:` as graphql-js resolves it, inline or from the variables) with only
// the fields it knows. `__typename` asks nothing.
export function mutationFields({ doc, op, coerced }, schema = githubSchema()) {
  const defs = schema.getMutationType().getFields();
  const out = [];
  for (const field of rootFields(doc, op)) {
    const name = field.name.value;
    if (name === "__typename") continue;
    const spec = Object.hasOwn(MUTATIONS, name) ? MUTATIONS[name] : null;
    if (!spec) return { refused: refusal(403, `Deckhand doesn't let a run send ${name}`) };
    const { input = {} } = getArgumentValues(defs[name], field, coerced);
    // Fields set to null are GitHub's "not set": only those with a value count.
    const set = Object.fromEntries(
      Object.entries(input ?? {}).filter(([k, v]) => v != null && k !== "clientMutationId"),
    );
    const known = [spec.target, ...spec.fields];
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
    out.push({ name, key: field.alias?.value ?? name, spec, input: set, node: field });
  }
  return out;
}

// The node IDs a call's mutations name: their targets, sub-issues and labels.
function idsOf(fields) {
  const ids = new Set();
  for (const { spec, input } of fields) {
    ids.add(input[spec.target]);
    if (spec.child) ids.add(input[spec.child]);
    for (const id of spec.labels ? (input[spec.labels.field] ?? []) : []) ids.add(id);
  }
  return [...ids];
}

const repoOf = (node) => String(node?.nameWithOwner ?? node?.repository?.nameWithOwner ?? "");

// The fields a selection set selects, through its fragments: each with its response key.
function selected(doc, set) {
  const fragments = new Map(
    doc.definitions
      .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
      .map((d) => [d.name.value, d]),
  );
  const fields = [];
  const walk = (inner) => {
    for (const node of inner?.selections ?? []) {
      if (node.kind === Kind.FIELD) fields.push(node);
      else if (node.kind === Kind.INLINE_FRAGMENT) walk(node.selectionSet);
      else if (node.kind === Kind.FRAGMENT_SPREAD)
        walk(fragments.get(node.name.value)?.selectionSet);
    }
  };
  walk(set);
  return fields;
}
const keyOf = (field) => field.alias?.value ?? field.name.value;

// Whether a createIssue field's answer names the issue it created where github-writes.mjs
// answered() reads it (`issue.url`, else `issue.html_url`), as GitHub's own fields: `issue`
// and `url` unaliased (or aliased to themselves), and no `html_url`, which GraphQL's Issue
// doesn't have, so it could only be another field's alias. Otherwise a run could answer
// `url: title` with a title of its choosing, and claim an issue it didn't create.
export function answersCreated(doc, field) {
  const issues = selected(doc, field.selectionSet).filter((f) => keyOf(f) === "issue");
  if (!issues.length || issues.some((f) => f.name.value !== "issue")) return false;
  const inner = issues.flatMap((f) => selected(doc, f.selectionSet));
  const urls = inner.filter((f) => keyOf(f) === "url");
  if (!urls.length || urls.some((f) => f.name.value !== "url")) return false;
  return !inner.some((f) => keyOf(f) === "html_url");
}

// A mutation field and the nodes it names → a write in github-writes.mjs classify()'s shape,
// or { refused }. `repo`: the run's: a node elsewhere, or missing, is refused alike before its
// type is named, so a refusal says nothing of another repository's nodes.
export function writeOf({ name, spec, input }, nodes, repo) {
  const node = nodes.get(input[spec.target]);
  const elsewhere = (field) =>
    refusal(403, `${name}'s ${field} isn't in the run's repository, or isn't there`);
  if (!node || repoOf(node).toLowerCase() !== repo) return { refused: elsewhere(spec.target) };
  let target;
  if (spec.repo) {
    if (node.__typename !== "Repository") {
      return { refused: refusal(403, `${name}'s ${spec.target} isn't a repository`) };
    }
    target = { kind: spec.kind };
  } else if (spec.types.includes(node.__typename)) {
    target = { number: node.number };
  } else if (spec.comments && COMMENTS.has(node.__typename)) {
    // No ceiling holds them: refused before any look-up (github-writes.mjs ID_TARGETS).
    target = { kind: "comment" };
  } else {
    return { refused: refusal(403, `${name} on a ${node.__typename} isn't something it checks`) };
  }
  // What it sets, as a REST write's body would: its target is its path's.
  const { [spec.target]: _, ...set } = input;
  const actions = spec.actions(set);
  const change = { fields: Object.keys(set), labels_added: [], labels_removed: [] };
  if (spec.labels && input[spec.labels.field]) {
    const names = [];
    for (const id of input[spec.labels.field]) {
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
  const write = { repo, actions, target, change };
  if (spec.child) {
    const sub = nodes.get(input[spec.child]);
    if (!sub || repoOf(sub).toLowerCase() !== repo) return { refused: elsewhere(spec.child) };
    if (sub.__typename !== "Issue") {
      return { refused: refusal(404, `${name}'s ${spec.child} isn't an issue`) };
    }
    write.child = {
      id: sub.databaseId ?? null,
      number: sub.number,
      repo: repoOf(sub).toLowerCase(),
      // Moving it from another parent: in no ceiling (github-writes.mjs).
      replace_parent: input.replaceParent === true,
    };
  }
  return write;
}

// `nodes(repo, ids)`: GitHub's answer to NODES for those IDs, with the listener's token (a
// missing one: null); `checkWrite(run, write)`: github-writes.mjs's, null when it may go on.
export function createGraphqlChecks({ nodes, checkWrite, schema = githubSchema, log = () => {} }) {
  // A run's GraphQL call → { refused } or { body, write, creates }: what goes on to GitHub
  // (printed again), whether it writes (its token then may), and the response keys of its
  // `createIssue` fields, whose answers name the issues it created (github-writes.mjs
  // answered()).
  async function check(run, body) {
    const parsed = parseCall(body, schema());
    if (parsed.refused) return parsed;
    const { doc, op, variables, operationName } = parsed;
    const forwarded = Buffer.from(
      JSON.stringify({
        query: print(doc),
        ...(operationName !== null && { operationName }),
        ...(variables !== null && { variables }),
      }),
    );
    if (op.operation !== "mutation") return { body: forwarded, write: false, creates: [] };
    const fields = mutationFields(parsed, schema());
    if (fields.refused) return fields;
    const ids = idsOf(fields);
    if (ids.length > MAX_NODES) {
      return { refused: refusal(400, `a GraphQL call naming over ${MAX_NODES} nodes`) };
    }
    let found = new Map();
    if (ids.length) {
      try {
        const answer = await nodes(run.repo, ids);
        found = new Map(ids.map((id, i) => [id, answer?.[i] ?? null]));
      } catch (error) {
        log(`GitHub gateway: ${run.repo} nodes: ${error.message ?? error}`);
        return { refused: refusal(502, "its GraphQL's nodes can't be looked up on GitHub") };
      }
    }
    for (const field of fields) {
      const write = writeOf(field, found, run.repo);
      if (write.refused) return write;
      const refused = await checkWrite(run, write);
      if (refused) {
        return { refused: { ...refused, message: `${field.key}: ${refused.message}` } };
      }
    }
    // Only those whose answer is GitHub's own `issue { url }`.
    const creates = fields
      .filter((f) => f.name === "createIssue" && answersCreated(doc, f.node))
      .map((f) => f.key);
    return { body: forwarded, write: fields.length > 0, creates };
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
