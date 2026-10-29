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
import { Worker } from "node:worker_threads";
import { permissionsOf, pullOf } from "./github-pulls.mjs";
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
// Comments no ceiling lets a run edit or react to: refused as REST refuses them. Those of a
// repository (RepositoryNode, which NODES reads); a discussion's comment has none, and is
// refused as outside it.
const COMMENTS = new Set([
  "IssueComment",
  "PullRequestReviewComment",
  "CommitComment",
  "PullRequestReview",
]);

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

const PULL_WRITE = { pull_requests: "write" };
const CONTENTS_WRITE = { contents: "write" };

// The mutations a run may send, by name. Each one's:
// - target: the input field that holds what it writes to, and the types it may be (`repo`: a
//   Repository, for a create, whose target is then `kind`);
// - fields: the input fields it may set besides that one and `clientMutationId` (any other set
//   is refused: a field GitHub adds may do what no ceiling knows);
// - actions(input): what it does, as github-writes.mjs names actions;
// - labels: the input field of label IDs it adds (`added`) or removes (`removed`), or sets in
//   place of the issue's (`set`);
// - child: a link's sub-issue field;
// - pull(input), permissions: a pull request's own write's head, base and draft, and what its
//   token needs beyond its mode's (github-pulls.mjs, github-writes.mjs classify()'s).
// The pull request ones are in a work run's ceiling, for its own pull requests only: opened,
// edited (`gh pr create` sets its labels and milestone with `updatePullRequest`), readied and
// drafted. Reviews and merges are in none.
export const MUTATIONS = {
  createIssue: {
    target: "repositoryId",
    repo: true,
    kind: "new_issue",
    // Not `issueTemplate`: GitHub would add its labels and assignees, which no check sees.
    fields: ["title", "body", "labelIds", "assigneeIds", "milestoneId"],
    actions: (input) => [
      "create",
      ...("assigneeIds" in input ? ["assign"] : []),
      ...("milestoneId" in input ? ["milestone"] : []),
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
    pull: (input) => ({ base: input.baseRefName ?? undefined }),
    permissions: PULL_WRITE,
  },
  // GitHub lets an App's token do these with `contents: write` only.
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
    ... on RepositoryNode { repository { nameWithOwner } }
  }
}`;

const refusal = (status, message) => ({ status, message });

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

// Why a document isn't valid on GitHub, or null when it is: what the worker answers
// (github-graphql-worker.mjs), and the in-thread validator of the tests.
export function validationError(query, schema = githubSchema()) {
  const doc = parsed(query);
  if (doc.refused) return doc.refused.message;
  const errors = validate(schema, doc, undefined, { maxErrors: 1 });
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
    // so an unknown one sent as null is refused as one with a value is.
    const known = [spec.target, ...spec.fields];
    const set = Object.fromEntries(
      Object.entries(input ?? {}).filter(([k]) => k !== "clientMutationId"),
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
    const entry = { name, key, spec, input: set, nodes: [field] };
    byKey.set(key, entry);
    out.push(entry);
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

// An input field's name as a REST body would name it, so a policy on `change.fields` reads one
// spelling for both: `labelIds` → `labels`, `assigneeIds` → `assignees`, `milestoneId` →
// `milestone`, `baseRefName` → `base`, the others in snake case (`subIssueId` → `sub_issue_id`).
const REST_NAMES = {
  labelIds: "labels",
  assigneeIds: "assignees",
  milestoneId: "milestone",
  baseRefName: "base",
  headRefName: "head",
};
export function restName(field) {
  return REST_NAMES[field] ?? field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
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

// Whether a createIssue field's answer names the issue it created where github-writes.mjs
// answered() reads it (`issue.url`, else `issue.html_url`), as GitHub's own fields: `issue`
// and `url` unaliased (or aliased to themselves), and no `html_url`, which GraphQL's Issue
// doesn't have, so it could only be another field's alias. Otherwise a run could answer
// `url: title` with a title of its choosing, and claim an issue it didn't create. `fields`: the
// nodes of one response key, whose selections GitHub merges.
export function answersCreated(doc, fields) {
  const sets = [fields].flat().map((f) => f.selectionSet);
  const issues = selected(doc, sets).filter((f) => keyOf(f) === "issue");
  if (!issues.length || issues.some((f) => f.name.value !== "issue")) return false;
  const inner = selected(
    doc,
    issues.map((f) => f.selectionSet),
  );
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
  const write = { repo, actions, target, change };
  if (spec.pull) Object.assign(write, { pull: spec.pull(set), permissions: spec.permissions });
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
      // Moving it from another parent: in no ceiling (github-writes.mjs). Any value but false,
      // null too, as REST's child() reads it: fail closed.
      replace_parent: "replaceParent" in input && input.replaceParent !== false,
    };
  }
  return write;
}

// `nodes(repo, ids)`: GitHub's answer to NODES for those IDs, with the listener's token (a
// missing one: null); `checkWrite(run, write)`: github-writes.mjs's, null when it may go on.
// `validator`: createValidator()'s check, or (the tests') validationError() on this thread.
export function createGraphqlChecks({
  nodes,
  checkWrite,
  schema = githubSchema,
  validator = async (query) => {
    const error = validationError(query, schema());
    return error && refusal(400, error);
  },
  log = () => {},
}) {
  // A run's GraphQL call → { refused } or { body, write, creates, permissions, pulls }: what
  // goes on to GitHub (printed again), whether it writes (its token then may), the response
  // keys of its `createIssue` fields, whose answers name the issues it created
  // (github-writes.mjs answered()), what its token needs beyond its mode's, and the pull
  // requests it changes (github-pulls.mjs permissionsOf(), pullOf()).
  async function check(run, body) {
    const call = readCall(body);
    if (call.refused) return call;
    const invalid = await validator(call.query, run);
    if (invalid) return { refused: invalid };
    const parsed = operationOf(schema(), call);
    if (parsed.refused) return parsed;
    const { doc, op, variables, operationName } = parsed;
    const forwarded = Buffer.from(
      JSON.stringify({
        query: print(doc),
        ...(operationName !== null && { operationName }),
        ...(variables !== null && { variables }),
      }),
    );
    if (op.operation !== "mutation") {
      return { body: forwarded, write: false, creates: [], permissions: {}, pulls: [] };
    }
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
    // GitHub's answers about the targets, kept across the call's fields.
    const memo = new Map();
    const writes = [];
    for (const field of fields) {
      const write = writeOf(field, found, run.repo);
      if (write.refused) return write;
      writes.push(write);
      const refused = await checkWrite(run, write, memo);
      if (refused) {
        return { refused: { ...refused, message: `${field.key}: ${refused.message}` } };
      }
    }
    // Only those whose answer is GitHub's own `issue { url }`.
    const creates = fields
      .filter((f) => f.name === "createIssue" && answersCreated(doc, f.nodes))
      .map((f) => f.key);
    return {
      body: forwarded,
      write: fields.length > 0,
      creates,
      permissions: permissionsOf(writes),
      pulls: writes.map((w, i) => pullOf(w, fields[i].key)).filter(Boolean),
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
