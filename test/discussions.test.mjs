import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_TEXT } from "../listener/answers.mjs";
import { loadConfig } from "../listener/config.mjs";
import {
  MAX_TITLE,
  THREAD_MS,
  createDiscussionApi,
  postOf,
  threadOf,
} from "../listener/discussions.mjs";
import { MARKER, workItem } from "../listener/events.mjs";
import { createRepoCheck } from "../listener/repo-check.mjs";

const ORIGIN = "https://deckhand.example.com";
const BOT = "deckhand[bot]";
const user = (login) => ({ login, __typename: "User" });
// GraphQL names a bot without its "[bot]".
const app = { login: "deckhand", __typename: "Bot" };

// Discussion 8 in "Ask Claude", with a comment (DC_41) that has a reply (DC_42).
function discussion8(extra = {}) {
  return {
    id: "D_8",
    databaseId: 5,
    number: 8,
    title: "How do runs restart?",
    url: "https://github.com/org/app/discussions/8",
    body: "Is the queue kept?",
    createdAt: "2026-10-16T10:00:00Z",
    author: user("alice"),
    category: { name: "💬 Ask Claude" },
    comments: {
      totalCount: 1,
      nodes: [
        {
          id: "DC_41",
          databaseId: 41,
          url: "u/41",
          body: `Yes, in queue.json.\n\n${MARKER}`,
          createdAt: "2026-10-16T10:01:00Z",
          author: app,
          replies: {
            totalCount: 1,
            nodes: [
              {
                id: "DC_42",
                databaseId: 42,
                url: "u/42",
                body: "And the reactions?\n\nFrom the dashboard by @alice",
                createdAt: "2026-10-16T10:02:00Z",
                author: app,
              },
            ],
          },
        },
      ],
    },
    ...extra,
  };
}

// The discussions API with a fake GitHub (GraphQL for the discussions, REST for the repo's
// checks through the work area's), the repo's config as `settings` says.
function setup({ env = {}, settings = {}, errors = [], categories, discussions } = {}) {
  const config = loadConfig({
    ALLOWED_USERS: "alice,bob",
    DATA_DIR: mkdtempSync(join(tmpdir(), "deckhand-")),
    ...env,
  });
  config.bot = BOT;
  const w = {
    queries: [],
    created: [],
    added: [],
    accepted: [],
    logs: [],
    clock: 1000,
    discussions: discussions ?? { 8: discussion8() },
    categories: categories ?? [
      { id: "C_1", name: "General" },
      { id: "C_2", name: "💬 Ask Claude" },
    ],
  };
  const github = async (repo, method, path) =>
    path === `/repos/${repo}` && repo === "org/app"
      ? Response.json({ default_branch: "main" })
      : new Response("{}", { status: 404 });
  const graphql = async (repo, query, vars) => {
    w.queries.push(query.slice(0, 40));
    if (query.includes("createDiscussion")) {
      w.created.push(vars);
      return {
        createDiscussion: {
          discussion: {
            id: "D_9",
            databaseId: 6,
            number: 9,
            title: vars.title,
            url: "https://github.com/org/app/discussions/9",
          },
        },
      };
    }
    if (query.includes("addDiscussionComment")) {
      w.added.push(vars);
      return {
        addDiscussionComment: {
          comment: {
            id: "DC_50",
            databaseId: 50,
            url: "u/50",
            replyTo: vars.thread ? { databaseId: 41 } : null,
          },
        },
      };
    }
    if (query.includes("discussionCategories")) {
      return {
        repository: {
          id: "R_1",
          hasDiscussionsEnabled: w.categories.length > 0,
          discussionCategories: { nodes: w.categories },
        },
      };
    }
    if (query.includes("node(id")) {
      const nodes = {
        DC_41: { id: "DC_41", discussion: { id: "D_8" }, replyTo: null },
        DC_42: { id: "DC_42", discussion: { id: "D_8" }, replyTo: { id: "DC_41" } },
        DC_99: { id: "DC_99", discussion: { id: "D_3" }, replyTo: null },
      };
      if (!nodes[vars.id]) {
        throw new Error(`GraphQL: 200 [{"type":"NOT_FOUND","message":"Could not resolve"}]`);
      }
      return { node: nodes[vars.id] };
    }
    // GitHub's answer for what isn't there: an error (github.mjs graphql() throws it).
    const notFound = () => {
      throw new Error(`GraphQL: 200 [{"type":"NOT_FOUND","message":"Could not resolve"}]`);
    };
    return { repository: { discussion: w.discussions[vars.number] ?? notFound() } };
  };
  const repoSettings = async () => ({
    settings: {
      users: config.users,
      modes: {},
      inbox: { discussions: "ask claude" },
      ...settings,
    },
    errors,
  });
  const { checkedRepo } = createRepoCheck({ config, github, repoSettings });
  w.api = createDiscussionApi({
    config,
    graphql,
    checkedRepo,
    accept: async (item) => w.accepted.push(item),
    publicUrl: () => ORIGIN,
    now: () => w.clock,
    log: (line) => w.logs.push(line),
  });
  return w;
}

// A request to the API, with a body for POSTs.
function call(api, method, url, { user = "alice", origin = ORIGIN, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const listeners = {};
  const req = {
    method,
    url,
    headers: { origin, host: "deckhand.example.com" },
    on(event, fn) {
      listeners[event] = fn;
      if (event === "close") {
        queueMicrotask(() => {
          for (const c of chunks) listeners.data?.(c);
          listeners.end?.();
        });
      }
      return this;
    },
    destroy() {},
  };
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(text) {
        resolve({ status: this.status, body: JSON.parse(text) });
      },
    };
    assert.equal(api.handle(req, res, user), true);
  });
}

const start = (w, body, opts) =>
  call(w.api, "POST", "/api/repos/org/app/discussions", { body, ...opts });
const comment = (w, body, opts) =>
  call(w.api, "POST", "/api/repos/org/app/discussions/8/comments", { body, ...opts });
const read = (w, opts) => call(w.api, "GET", "/api/repos/org/app/discussions/8", opts);

// What the webhook makes of the same discussion or comment, by its author.
const repoConfig = {
  ...loadConfig({ ALLOWED_USERS: "alice" }),
  inbox: { discussions: "ask claude" },
};
const delivery = (event, d, c = null) =>
  workItem(repoConfig, event, {
    action: "created",
    installation: { id: 1 },
    repository: { full_name: "org/app" },
    discussion: { ...d, category: { name: "Ask Claude" }, user: { login: "alice" } },
    ...(c && { comment: { ...c, user: { login: "alice" } } }),
  });
const KEYS = ["repo", "id", "kind", "number", "title", "trigger", "text", "replyTo"];
const same = (item, hook) => {
  for (const key of [...KEYS, "discussionId", "comment"]) {
    assert.deepEqual(item[key], hook[key], key);
  }
};

test("postOf: the App's answers are Deckhand's, its dashboard posts its user's; anyone else's as is", () => {
  const answer = postOf({ id: "a", body: `Done.\n\n${MARKER}`, author: app }, BOT);
  assert.deepEqual([answer.author, answer.deckhand, answer.body], ["deckhand", true, "Done."]);
  const mine = postOf(
    { id: "b", body: "Hi\r\n\r\nFrom the dashboard by @alice", author: app },
    BOT,
  );
  assert.deepEqual([mine.author, mine.deckhand, mine.body], ["alice", false, "Hi"]);
  // Someone else writing the line, or another App: not the dashboard's.
  const forged = "Hi\n\nFrom the dashboard by @alice";
  assert.equal(postOf({ id: "c", body: forged, author: user("mallory") }, BOT).author, "mallory");
  const other = { login: "other", __typename: "Bot" };
  assert.equal(postOf({ id: "d", body: forged, author: other }, BOT).author, "other");
  assert.equal(postOf({ id: "e", body: `x ${MARKER}`, author: other }, BOT).deckhand, false);
  // A deleted account.
  assert.equal(postOf({ id: "f", body: "x", author: null }, BOT).author, null);
});

test("GET: the thread, posts as the dashboard shows them, kept THREAD_MS", async () => {
  const w = setup();
  const got = await read(w);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, { ...threadOf(discussion8(), BOT), readAt: 1000 });
  assert.equal(got.body.post.body, "Is the queue kept?");
  const [c] = got.body.comments;
  assert.deepEqual([c.author, c.deckhand, c.body], ["deckhand", true, "Yes, in queue.json."]);
  assert.deepEqual(
    [c.replies[0].author, c.replies[0].body, c.more, got.body.more],
    ["alice", "And the reactions?", 0, 0],
  );
  // Kept, for another allowed user too, then read again.
  await read(w, { user: "bob" });
  assert.equal(w.queries.length, 1);
  w.clock += THREAD_MS;
  await read(w);
  assert.equal(w.queries.length, 2);
});

test("GET refused: signed out, users, no category, another category, not a discussion", async () => {
  const w = setup({ env: { ALLOWED_USERS: "alice,bob,carol" }, settings: { users: ["alice"] } });
  assert.equal((await read(w, { user: null })).status, 401);
  assert.equal((await read(w, { user: "mallory" })).status, 403);
  assert.equal((await read(w, { user: "bob" })).status, 403);
  // Kept from alice's read: still refused for bob.
  assert.equal((await read(w)).status, 200);
  assert.equal((await read(w, { user: "bob" })).status, 403);
  assert.equal((await call(w.api, "POST", "/api/repos/org/app/discussions/8")).status, 405);
  assert.equal((await call(w.api, "GET", "/api/repos/other/app/discussions/8")).status, 404);

  const none = setup({ settings: { inbox: {} } });
  const refused = await read(none);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no discussions category/);
  const elsewhere = setup({
    discussions: { 8: discussion8({ category: { name: "General" } }) },
  });
  assert.equal((await read(elsewhere)).status, 404);
  const missing = setup({ discussions: {} });
  assert.equal((await read(missing)).status, 404);
  assert.equal((await read(setup({ errors: ["bad"] }))).status, 409);
});

test("start: the App's discussion in the category, and the run a new discussion starts", async () => {
  const w = setup();
  const sent = await start(w, { title: " Restarts ", body: "Is the queue kept?\n" });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, {
    message: "Discussion #9 started.",
    url: "https://github.com/org/app/discussions/9",
    number: 9,
    task: "org/app#discussion-9",
  });
  assert.deepEqual(w.created, [
    {
      repo: "R_1",
      category: "C_2",
      title: "Restarts",
      body: "Is the queue kept?\n\nFrom the dashboard by @alice",
    },
  ]);
  const [item] = w.accepted;
  const hook = delivery("discussion", {
    id: 6,
    node_id: "D_9",
    number: 9,
    title: "Restarts",
    html_url: "https://github.com/org/app/discussions/9",
    body: "Is the queue kept?\n",
  });
  same(item, hook);
  assert.match(item.text, /^From @alice \(.*\/9\):\n\nIs the queue kept\?\n\n\(Title: Restarts\)$/);
  assert.deepEqual([item.author, item.base], ["alice", "main"]);
  assert.deepEqual(item.settings.inbox, { discussions: "ask claude" });
});

test("start refused, nothing posted: users, category, text, origin", async () => {
  const w = setup({ env: { ALLOWED_USERS: "alice,bob" }, settings: { users: ["alice"] } });
  const ok = { title: "Restarts", body: "Is the queue kept?" };
  assert.equal((await start(w, ok, { user: null })).status, 401);
  assert.equal((await start(w, ok, { origin: "https://evil.example" })).status, 403);
  assert.equal((await start(w, ok, { origin: null })).status, 403);
  assert.equal((await start(w, ok, { user: "mallory" })).status, 403);
  assert.equal((await start(w, ok, { user: "bob" })).status, 403);
  assert.equal((await start(w, { title: " ", body: "x" })).status, 400);
  assert.equal((await start(w, { title: "x", body: "\n" })).status, 400);
  assert.equal((await start(w, { title: "x" })).status, 400);
  assert.equal((await start(w, { title: "x".repeat(MAX_TITLE + 1), body: "x" })).status, 413);
  assert.equal((await start(w, { title: "x", body: "x".repeat(MAX_TEXT + 1) })).status, 413);
  assert.equal((await call(w.api, "GET", "/api/repos/org/app/discussions")).status, 405);
  // The category isn't on GitHub, or Discussions are off.
  w.categories = [{ id: "C_1", name: "General" }];
  const gone = await start(w, ok);
  assert.equal(gone.status, 409);
  assert.match(gone.body.error, /create it/);
  w.categories = [];
  assert.equal((await start(w, ok)).status, 409);
  assert.equal((await start(setup({ settings: { inbox: { ideas: 12 } } }), ok)).status, 409);
  assert.equal((await start(setup({ errors: ["bad"] }), ok)).status, 409);
  assert.deepEqual([w.created, w.accepted], [[], []]);
});

test("comment: in the thread asked, then the run a comment there starts", async () => {
  const w = setup();
  const d = {
    id: 5,
    node_id: "D_8",
    number: 8,
    title: "How do runs restart?",
    html_url: "https://github.com/org/app/discussions/8",
  };
  // A new top-level comment.
  await read(w);
  const top = await comment(w, { text: "And logs?" });
  assert.equal(top.status, 200);
  assert.deepEqual(top.body, { message: "Sent to discussion #8.", url: "u/50" });
  assert.deepEqual(w.added[0], {
    id: "D_8",
    thread: null,
    body: "And logs?\n\nFrom the dashboard by @alice",
  });
  same(
    w.accepted[0],
    delivery("discussion_comment", d, {
      id: 50,
      node_id: "DC_50",
      html_url: "u/50",
      body: "And logs?",
    }),
  );
  // The thread is read again at once, kept or not.
  const before = w.queries.length;
  await read(w);
  assert.equal(w.queries.length, before + 1);

  // A reply to a comment, and to a reply: both in the comment's thread.
  await comment(w, { text: "Thanks", replyTo: "DC_41" });
  await comment(w, { text: "Thanks again", replyTo: "DC_42" });
  assert.deepEqual(
    w.added.slice(1).map((a) => a.thread),
    ["DC_41", "DC_41"],
  );
  same(
    w.accepted[1],
    delivery("discussion_comment", d, {
      id: 50,
      node_id: "DC_50",
      parent_id: 41,
      html_url: "u/50",
      body: "Thanks",
    }),
  );
});

test("comment refused, nothing posted: users, text, origin, another discussion's thread", async () => {
  const w = setup({ settings: { users: ["alice"] } });
  assert.equal((await comment(w, { text: "x" }, { user: "bob" })).status, 403);
  assert.equal((await comment(w, { text: "x" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await comment(w, { text: " " })).status, 400);
  assert.equal((await comment(w, { text: "x".repeat(MAX_TEXT + 1) })).status, 413);
  assert.equal((await comment(w, { text: "x", replyTo: 41 })).status, 400);
  assert.equal((await comment(w, { text: "x", replyTo: "DC_99" })).status, 404);
  assert.equal((await comment(w, { text: "x", replyTo: "DC_00" })).status, 404);
  const other = await call(w.api, "POST", "/api/repos/org/app/discussions/3/comments", {
    body: { text: "x" },
  });
  assert.equal(other.status, 404);
  const elsewhere = setup({
    discussions: { 8: discussion8({ category: { name: "General" } }) },
  });
  assert.equal((await comment(elsewhere, { text: "x" })).status, 404);
  assert.deepEqual([w.added, w.accepted, elsewhere.added], [[], [], []]);
});

test("GitHub failing: a 502, nothing queued", async () => {
  const w = setup();
  w.api = createDiscussionApi({
    config: { repos: [], users: ["alice"] },
    graphql: async () => {
      throw new Error("GraphQL: 502");
    },
    checkedRepo: async () => ({
      settings: { users: ["alice"], inbox: { discussions: "ask claude" } },
      base: "main",
    }),
    accept: async (item) => w.accepted.push(item),
    publicUrl: () => ORIGIN,
  });
  assert.equal((await start(w, { title: "x", body: "y" })).status, 502);
  assert.equal((await read(w)).status, 502);
  assert.deepEqual(w.accepted, []);
});
