import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDiscussionComment,
  commentThread,
  ensureLabel,
  hasLabel,
  labelFailed,
} from "../listener/comments.mjs";

test("hasLabel: names or { name }, whatever their case", () => {
  assert.equal(hasLabel([{ name: "needs-input" }], "needs-input"), true);
  assert.equal(hasLabel([{ name: "Needs-Input" }], "needs-input"), true);
  assert.equal(hasLabel(["bug", "NEEDS-INPUT"], "needs-input"), true);
  assert.equal(hasLabel([{ name: "bug" }, null, {}], "needs-input"), false);
  assert.equal(hasLabel(undefined, "needs-input"), false);
  // The label turned off (NEEDS_INPUT_LABEL empty): nothing has it.
  assert.equal(hasLabel([{ name: "" }], ""), false);
});

test("ensureLabel: made, or there already (422); anything else is logged", async () => {
  const calls = [];
  const logs = [];
  const answer = (status) => async (repo, method, path, body, expected) => {
    calls.push({ method, path, body, expected });
    return new Response("{}", { status });
  };
  const label = { name: "analysis", color: "c5def5", description: "d" };
  await ensureLabel(answer(201), "o/r", label, (l) => logs.push(l));
  await ensureLabel(answer(422), "o/r", label, (l) => logs.push(l));
  await ensureLabel(answer(403), "o/r", label, (l) => logs.push(l));
  assert.deepEqual(calls[0], {
    method: "POST",
    path: "/repos/o/r/labels",
    body: label,
    expected: [422],
  });
  assert.deepEqual(logs, ["o/r: the analysis label: 403"]);
});

test("labelFailed: a label already off (404) isn't a failure", () => {
  assert.equal(labelFailed(new Response(null, { status: 204 })), false);
  assert.equal(labelFailed(new Response(null, { status: 404 })), false);
  assert.equal(labelFailed(new Response(null, { status: 403 })), true);
});

test("discussion comments: a reply's thread is its comment's, and the comment posted", async () => {
  const nodes = {
    DC_1: { id: "DC_1", discussion: { id: "D_1" }, replyTo: null },
    DC_2: { id: "DC_2", discussion: { id: "D_1" }, replyTo: { id: "DC_1" } },
  };
  const asked = [];
  const graphql = async (repo, query, variables) => {
    asked.push({ query, variables });
    if (query.includes("addDiscussionComment")) {
      return { addDiscussionComment: { comment: { url: "u", id: "DC_3" } } };
    }
    return { node: nodes[variables.id] ?? null };
  };
  assert.deepEqual(await commentThread(graphql, "o/r", "DC_1"), {
    discussion: "D_1",
    thread: "DC_1",
  });
  assert.deepEqual(await commentThread(graphql, "o/r", "DC_2"), {
    discussion: "D_1",
    thread: "DC_1",
  });
  assert.equal(await commentThread(graphql, "o/r", "DC_9"), null);
  const c = await addDiscussionComment(
    graphql,
    "o/r",
    { id: "D_1", thread: "DC_1", body: "hi" },
    "id url",
  );
  assert.deepEqual(c, { url: "u", id: "DC_3" });
  assert.deepEqual(asked.at(-1).variables, { id: "D_1", thread: "DC_1", body: "hi" });
  assert.match(asked.at(-1).query, /comment \{ id url \}/);
});
