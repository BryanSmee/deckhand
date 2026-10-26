import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDiscussionComment,
  commentThread,
  createComments,
  ensureLabel,
  hasLabel,
  labelFailed,
  ReplyError,
} from "../listener/comments.mjs";
import { recordingFetch } from "./helpers.mjs";

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

// createComments() on a recordingFetch: GitHub's answers to the comment POSTs, in order.
function replying(statuses, { graphql } = {}) {
  const left = [...statuses];
  const { fetch, calls } = recordingFetch(({ method }) => {
    if (method !== "POST") return undefined;
    const [status, text] = [left.shift()].flat();
    return new Response(text ?? JSON.stringify({ id: 1 }), { status });
  });
  const github = (repo, method, path, body) =>
    fetch(`https://api.github.com${path}`, { method, body: JSON.stringify(body) });
  const logs = [];
  const waits = [];
  const comments = createComments({
    config: {},
    github,
    graphql,
    log: (line) => logs.push(line),
    delays: [1, 2, 3],
    sleep: async (ms) => waits.push(ms),
  });
  const bodies = () => calls.map((c) => JSON.parse(c.body).body);
  return { comments, calls, bodies, logs, waits };
}

test("reply: a 422 posts again shortened, with where the full answer is", async () => {
  const { comments, bodies, logs } = replying([422, 201]);
  const long = "x".repeat(30000);
  const res = await comments.reply("o/r", 3, long, { full: "https://deck/#/o/r?task=k&run=r" });
  assert.equal(res.status, 201);
  const [first, second] = bodies();
  assert.ok(first.startsWith(long));
  assert.ok(second.length < 21000);
  assert.match(
    second,
    /full answer is \[on the dashboard\]\(https:\/\/deck\/#\/o\/r\?task=k&run=r\)/,
  );
  assert.match(second, /<!-- deckhand -->$/);
  assert.match(logs[0], /issues\/3\/comments: 422, posted again shortened/);
});

test("reply: shortened once only, a second 422 throws", async () => {
  const { comments, calls } = replying([422, 422, 201]);
  await assert.rejects(comments.reply("o/r", 3, "x".repeat(30000)), { status: 422 });
  assert.equal(calls.length, 2);
});

test("reply: a 422 on a short reply, or any other refusal, throws at once", async () => {
  for (const status of [422, 404, 403]) {
    const { comments, calls } = replying([status, 201]);
    await assert.rejects(comments.reply("o/r", 3, "short"), (error) => {
      assert.ok(error instanceof ReplyError);
      assert.equal(error.status, status);
      assert.match(
        error.message,
        new RegExp(`^GitHub POST /repos/o/r/issues/3/comments: ${status}`),
      );
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("reply: a 5xx or a rate limit is tried again, then throws", async () => {
  const limited = [403, '{"message":"You have exceeded a secondary rate limit"}'];
  const ok = replying([502, limited, 429, 201]);
  assert.equal((await ok.comments.reply("o/r", 3, "hi")).status, 201);
  assert.deepEqual(ok.waits, [1, 2, 3]);
  const failing = replying([500, 500, 500, 500, 201]);
  await assert.rejects(failing.comments.reply("o/r", 3, "hi"), { status: 500 });
  assert.equal(failing.calls.length, 4);
});

test("answer in a discussion: too long posts again shortened, a refusal throws", async () => {
  const posted = [];
  let refusals = ['GraphQL: 200 [{"message":"Body is too long (maximum is 65536 characters)"}]'];
  const graphql = async (repo, query, { body }) => {
    posted.push(body);
    const refusal = refusals.shift();
    if (refusal) throw new Error(refusal);
    return { addDiscussionComment: { comment: { url: "u" } } };
  };
  const { comments } = replying([], { graphql });
  const target = { kind: "discussion", repo: "o/r", discussionId: "D_1", comment: null };
  assert.deepEqual(await comments.answer(target, "y".repeat(30000)), { url: "u" });
  assert.equal(posted.length, 2);
  assert.match(posted[1], /Cut: GitHub refused the whole answer/);
  refusals = ["GraphQL: 403 {}"];
  await assert.rejects(comments.answer(target, "hi"), { status: 403 });
  // A GraphQL error comes with a 200: not tried again, and its message says why, not "200".
  posted.length = 0;
  refusals = ['GraphQL: 200 [{"message":"Discussion is locked"}]'];
  await assert.rejects(comments.answer(target, "hi"), (error) => {
    assert.equal(error.status, null);
    assert.match(error.reason, /Discussion is locked/);
    return true;
  });
  assert.equal(posted.length, 1);
});
