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
import { recordingFetch, tempDir } from "./helpers.mjs";

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

test("the listener's reactions: claimed before GitHub is asked, on any comment, kept across a restart", async (t) => {
  const dir = tempDir(t);
  const calls = [];
  // What GitHub answers: the POSTs and DELETEs as `status` says.
  let status = 201;
  const github = async (repo, method, path) => {
    // Claimed before the call goes out.
    calls.push([method, path, comments.listenerReacted("org/repo", "issue_comment:5", "eyes")]);
    if (status >= 500) throw new Error("down");
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ id: 40, content: "eyes" }, { status });
  };
  // What the next listener reads: the github service's record, the tests' own map here.
  const claims = new Map();
  const make = () => createComments({ config: { dataDir: dir }, github, claims, log: () => {} });
  let comments = make();
  const item = { repo: "Org/Repo", comment: { id: 5 } };
  comments.received(item);
  await item.eyes;
  assert.deepEqual(calls[0], ["POST", "/repos/Org/Repo/issues/comments/5/reactions", true]);
  // Its subject as github-writes.mjs names a run's: a review comment apart from an issue's.
  assert.equal(comments.listenerReacted("org/repo", "review_comment:5", "eyes"), false);
  comments.received({ repo: "org/repo", comment: { id: 5, review: true } });
  assert.equal(comments.listenerReacted("org/repo", "review_comment:5", "eyes"), true);
  // A restarted listener knows them.
  comments = make();
  assert.equal(comments.listenerReacted("org/repo", "issue_comment:5", "eyes"), true);
  // Its 👀 off once the run is over, its outcome's on.
  await comments.settle(item, "ok");
  assert.equal(comments.listenerReacted("org/repo", "issue_comment:5", "eyes"), false);
  assert.equal(comments.listenerReacted("org/repo", "issue_comment:5", "rocket"), true);
  // A POST that fails keeps its claim: a run's same reaction stays (fail closed).
  status = 503;
  comments.received({ repo: "org/repo", comment: { id: 6 } });
  assert.equal(comments.listenerReacted("org/repo", "issue_comment:6", "eyes"), true);
  // A discussion's comment: no run reacts there.
  const graphql = async () => ({});
  const discussions = createComments({ config: {}, github, graphql, log: () => {} });
  discussions.received({ repo: "org/repo", comment: { id: 7, discussion: true, node_id: "D" } });
  assert.equal(discussions.listenerReacted("org/repo", "issue_comment:7", "eyes"), false);
});

test("the listener's reactions with the github service: noted there before GitHub is asked, reactions.json handed over", async (t) => {
  const dir = tempDir(t);
  const { existsSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  // What a listener from before the github service saved.
  writeFileSync(
    join(dir, "reactions.json"),
    JSON.stringify({ "org/repo issue_comment:3 rocket": 1 }),
  );
  const order = [];
  const shared = async (repo, subject, content, held) => {
    order.push(["claim", repo, subject, content, held]);
  };
  const github = async (repo, method, path) => {
    order.push([method, path]);
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ id: 40, content: "eyes" }, { status: 201 });
  };
  const comments = createComments({ config: { dataDir: dir }, github, shared, log: () => {} });
  // The old ones go to the service, then the file goes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order.shift(), ["claim", "org/repo", "issue_comment:3", "rocket", true]);
  assert.equal(existsSync(join(dir, "reactions.json")), false);
  const item = { repo: "Org/Repo", comment: { id: 5 } };
  comments.received(item);
  await item.eyes;
  await comments.settle(item, "ok");
  assert.deepEqual(order, [
    ["claim", "org/repo", "issue_comment:5", "eyes", true],
    ["POST", "/repos/Org/Repo/issues/comments/5/reactions"],
    ["DELETE", "/repos/Org/Repo/issues/comments/5/reactions/40"],
    ["claim", "org/repo", "issue_comment:5", "eyes", false],
    ["claim", "org/repo", "issue_comment:5", "rocket", true],
    ["POST", "/repos/Org/Repo/issues/comments/5/reactions"],
  ]);
  // A service that doesn't answer: logged, and the reaction not added (a run could take it off
  // otherwise: fail closed).
  const logs = [];
  const down = createComments({
    config: {},
    github,
    shared: async () => {
      throw new Error("the github service: 503");
    },
    log: (line) => logs.push(line),
  });
  const other = { repo: "org/repo", comment: { id: 6 } };
  const posts = order.length;
  down.received(other);
  assert.equal(await other.eyes, null);
  assert.equal(order.length, posts);
  assert.match(logs[0], /Noting the listener's reaction: the github service: 503/);
});

test("a run's reply carries its idempotency key, in an issue and in a discussion", async () => {
  const keys = [];
  const github = async (repo, method, path, body, expected, options) => {
    keys.push(["rest", options?.key]);
    return Response.json({ id: 1 }, { status: 201 });
  };
  const graphql = async (repo, query, variables, options) => {
    keys.push(["graphql", options?.key]);
    return { addDiscussionComment: { comment: { url: "u" } } };
  };
  const comments = createComments({ config: {}, github, graphql, log: () => {} });
  await comments.answer({ kind: "issue", repo: "o/r", replyTo: 12 }, "hi", { key: "run-1:reply" });
  const discussion = { kind: "discussion", repo: "o/r", discussionId: "D_1", comment: null };
  await comments.answer(discussion, "hi", { key: "run-2:reply" });
  // Without one, none.
  await comments.answer(discussion, "hi");
  assert.deepEqual(keys, [
    ["rest", "run-1:reply"],
    ["graphql", "run-2:reply"],
    ["graphql", undefined],
  ]);
});
