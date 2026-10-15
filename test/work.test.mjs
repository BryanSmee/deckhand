import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { createWaits } from "../listener/waits.mjs";
import { ISSUES_MS, createWorkApi, leadsTo, parseAction } from "../listener/work.mjs";

const ORIGIN = "https://deckhand.example.com";

// The work area with a fake GitHub behind it: `issues` by number (GET /issues/{n}, and the
// open ones listed), `repoSettings` as the default branch's config says, real waits in a temp
// dir.
function setup({ env = {}, settings = {}, errors = [], issues = {}, busy = [], board = [] } = {}) {
  const config = loadConfig({
    ALLOWED_USERS: "alice,bob",
    DATA_DIR: mkdtempSync(join(tmpdir(), "deckhand-")),
    ...env,
  });
  const w = { calls: [], comments: [], accepted: [], eyes: [], settled: [], issues, clock: 1000 };
  let commentId = 500;
  const github = async (repo, method, path) => {
    w.calls.push(`${method} ${path}`);
    if (path === `/repos/${repo}`) {
      return repo === "org/app"
        ? Response.json({ default_branch: "main" })
        : new Response("{}", { status: 404 });
    }
    if (path.startsWith(`/repos/${repo}/issues?`)) {
      return Response.json(
        Object.entries(w.issues)
          .filter(([, i]) => i.state === "open")
          .map(([n, i]) => ({ number: Number(n), html_url: `u/${n}`, ...i })),
      );
    }
    const n = /\/issues\/(\d+)$/.exec(path)?.[1];
    const issue = w.issues[n];
    return issue
      ? Response.json({ number: Number(n), ...issue })
      : new Response("{}", { status: 404 });
  };
  const reply = async (repo, number, text) => {
    w.comments.push([number, text]);
    return Response.json({ id: ++commentId, html_url: `c/${commentId}`, node_id: "N" });
  };
  w.path = join(config.dataDir, "waits.json");
  w.waits = createWaits({
    path: w.path,
    github,
    reply,
    received: (i) => w.eyes.push(i.comment.id),
    settle: async (i, status) => w.settled.push([i.comment.id, status]),
    resume: async () => true,
  });
  w.api = createWorkApi({
    config,
    github,
    repoSettings: async () => ({
      settings: { users: config.users, modes: {}, ...settings },
      errors,
    }),
    reply,
    waits: w.waits,
    accept: async (item) => w.accepted.push(item),
    boardKeys: () => new Set(board),
    busy: (key) => busy.includes(key),
    publicUrl: () => ORIGIN,
    now: () => w.clock,
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

const post = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/work", { body, ...opts });

const open = (title) => ({ state: "open", title });

test("parseAction: an action, issue numbers, a mode's name", () => {
  assert.deepEqual(parseAction('{"action":"start","number":3}'), {
    action: "start",
    number: 3,
    after: null,
    mode: null,
  });
  assert.deepEqual(parseAction('{"action":"queue","number":3,"after":2,"mode":"brainstorm"}'), {
    action: "queue",
    number: 3,
    after: 2,
    mode: "brainstorm",
  });
  for (const bad of [
    "nope",
    "null",
    '{"action":"merge","number":3}',
    '{"action":"start","number":"3"}',
    '{"action":"start","number":-1}',
    '{"action":"queue","number":3}',
    '{"action":"start","number":3,"mode":"a b"}',
  ]) {
    assert.throws(() => parseAction(bad), { status: 400 }, bad);
  }
});

test("leadsTo: follows the waits from blocker to blocker", () => {
  const waits = { "o/r#2": { blockers: [1] }, "o/r#3": { blockers: [2, 9] } };
  const get = (key) => waits[key];
  assert.equal(leadsTo(get, "o/r", 3, 1), true);
  assert.equal(leadsTo(get, "o/r", 3, 9), true);
  assert.equal(leadsTo(get, "o/r", 2, 3), false);
  assert.equal(leadsTo(get, "o/r", 4, 4), true);
});

test("GET issues: the open issues without a task or pull request, and the repo's modes", async () => {
  const w = setup({
    settings: { modes: { review: { light: true } } },
    issues: {
      1: open("One"),
      2: open("On the board"),
      3: { ...open("A pull request"), pull_request: {} },
      4: { state: "closed", title: "Closed" },
    },
    board: ["org/app#2"],
  });
  const res = await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.issues, [{ number: 1, title: "One", url: "u/1" }]);
  assert.deepEqual(res.body.modes, ["work", "brainstorm", "review"]);
  assert.equal(res.body.errors, false);
  // Cached: GitHub is asked again only after ISSUES_MS.
  const listed = () => w.calls.filter((c) => c.includes("/issues?")).length;
  await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.equal(listed(), 1);
  w.clock += ISSUES_MS;
  await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.equal(listed(), 2);
});

test("GET issues: signed in, for allowed repos the App is installed on", async () => {
  const w = setup({ env: { ALLOWED_REPOS: "org/app,org/gone" } });
  assert.equal((await call(w.api, "GET", "/api/repos/org/app/issues", { user: null })).status, 401);
  assert.equal((await call(w.api, "GET", "/api/repos/org/secret/issues")).status, 404);
  assert.equal((await call(w.api, "GET", "/api/repos/org/gone/issues")).status, 404);
  assert.equal((await call(w.api, "POST", "/api/repos/org/app/issues")).status, 405);
  assert.equal(w.api.handle({ method: "GET", url: "/api/repos/org/app/config" }, {}, "x"), false);
});

test("GET issues: a config with errors offers no mode", async () => {
  const w = setup({ errors: ["bad"], issues: { 1: open("One") } });
  const res = await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.deepEqual([res.body.modes, res.body.errors], [[], true]);
});

test("start: the App comments, then the work is queued as a trigger comment would be", async () => {
  const w = setup({ issues: { 5: open("Five") } });
  const res = await post(w, { action: "start", number: 5 });
  assert.equal(res.status, 200);
  assert.deepEqual(w.comments, [[5, "Started from the dashboard by @alice."]]);
  const [item] = w.accepted;
  assert.equal(item.repo, "org/app");
  assert.equal(item.id, "5");
  assert.equal(item.trigger, "work");
  assert.equal(item.modeLine, null);
  assert.equal(item.author, "alice");
  assert.equal(item.base, "main");
  assert.equal(item.title, "Five");
  // Its reactions go on the App's comment.
  assert.equal(item.comment.id, 501);
});

test("start in another mode: a /mode line's", async () => {
  const w = setup({ issues: { 5: open("Five") } });
  await post(w, { action: "start", number: 5, mode: "brainstorm" });
  assert.equal(w.accepted[0].modeLine, "brainstorm");
  assert.match(w.comments[0][1], /in `brainstorm` mode/);
  const unknown = await post(w, { action: "start", number: 5, mode: "deploy" });
  assert.equal(unknown.status, 422);
  assert.equal(w.accepted.length, 1);
});

test("queue: waits for the issue it was dropped after, with the App's comment", async () => {
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven") } });
  const res = await post(w, { action: "queue", number: 5, after: 7 });
  assert.equal(res.status, 200);
  assert.deepEqual(w.accepted, []);
  assert.match(w.comments[0][1], /^Queued from the dashboard by @alice, after #7\. It starts/);
  const wait = w.waits.get("org/app#5");
  assert.deepEqual(wait.blockers, [7]);
  assert.equal(wait.item.author, "alice");
  assert.equal(wait.item.comment.id, 501);
  assert.deepEqual(w.eyes, [501]);
  // Kept across a restart.
  assert.deepEqual(JSON.parse(readFileSync(w.path, "utf8"))["org/app#5"].blockers, [7]);
  // Once #7 is done, the wait resumes it as for a comment.
  w.issues[7] = { state: "closed", state_reason: "completed" };
  await w.waits.closed("org/app", 7, "done");
  assert.equal(w.waits.get("org/app#5"), undefined);
});

test("queue onto another node moves the wait, keeping its mode", async () => {
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven"), 8: open("Eight") } });
  await post(w, { action: "queue", number: 5, after: 7, mode: "brainstorm" });
  const res = await post(w, { action: "queue", number: 5, after: 8 });
  assert.equal(res.status, 200);
  assert.deepEqual(w.waits.get("org/app#5").blockers, [8]);
  assert.equal(w.waits.get("org/app#5").item.modeLine, "brainstorm");
  assert.match(
    w.comments[1][1],
    /^Moved from the dashboard by @alice: now after #8 in `brainstorm` mode \(it waited for #7\)/,
  );
  // The old comment loses its 👀.
  assert.deepEqual(w.settled, [[501, "stopped"]]);
  // Onto the same node again: nothing to do, no comment.
  await post(w, { action: "queue", number: 5, after: 8 });
  assert.equal(w.comments.length, 2);
});

test("queue: refused for itself, a cycle, a missing or undone blocker; started when it is done", async () => {
  const w = setup({
    issues: {
      5: open("Five"),
      6: open("Six"),
      7: { state: "closed", state_reason: "not_planned" },
      8: { state: "closed", state_reason: "completed" },
    },
  });
  assert.equal((await post(w, { action: "queue", number: 5, after: 5 })).status, 422);
  await post(w, { action: "queue", number: 6, after: 5 });
  const cycle = await post(w, { action: "queue", number: 5, after: 6 });
  assert.equal(cycle.status, 422);
  assert.match(cycle.body.error, /#6 waits for #5/);
  assert.equal((await post(w, { action: "queue", number: 5, after: 99 })).status, 422);
  assert.equal((await post(w, { action: "queue", number: 5, after: 7 })).status, 422);
  const done = await post(w, { action: "queue", number: 5, after: 8 });
  assert.equal(done.status, 200);
  assert.equal(w.accepted.length, 1);
  assert.equal(w.comments.at(-1)[1], "Started from the dashboard by @alice: #8 is done already.");
});

test("dequeue: the wait is cancelled, with the App's comment; start drops it too", async () => {
  const w = setup({ issues: { 5: open("Five"), 6: open("Six"), 7: open("Seven") } });
  assert.equal((await post(w, { action: "dequeue", number: 5 })).status, 409);
  await post(w, { action: "queue", number: 5, after: 7 });
  const res = await post(w, { action: "dequeue", number: 5 });
  assert.equal(res.status, 200);
  assert.equal(w.waits.get("org/app#5"), undefined);
  assert.match(
    w.comments.at(-1)[1],
    /^No longer waiting for #7: cancelled from the dashboard by @alice/,
  );
  await post(w, { action: "queue", number: 6, after: 7 });
  await post(w, { action: "start", number: 6 });
  assert.equal(w.waits.get("org/app#6"), undefined);
  assert.equal(
    w.comments.at(-1)[1],
    "Started from the dashboard by @alice. It no longer waits for #7.",
  );
});

test("refused: other origins, repos, users, a broken config, pull requests, closed or busy issues", async () => {
  const issues = {
    5: open("Five"),
    6: { ...open("PR"), pull_request: {} },
    7: { state: "closed" },
    8: open("Running"),
  };
  const w = setup({ env: { ALLOWED_REPOS: "org/app" }, issues, busy: ["org/app#8"] });
  const start = (number, opts) => post(w, { action: "start", number }, opts);
  assert.equal((await start(5, { user: null })).status, 401);
  assert.equal((await start(5, { origin: "https://evil.example" })).status, 403);
  assert.equal((await start(5, { origin: null })).status, 403);
  assert.equal((await start(5, { user: "mallory" })).status, 403);
  assert.equal(
    (
      await call(w.api, "POST", "/api/repos/org/other/work", {
        body: { action: "start", number: 5 },
      })
    ).status,
    404,
  );
  assert.equal((await call(w.api, "GET", "/api/repos/org/app/work")).status, 405);
  assert.equal((await start(404)).status, 404);
  assert.equal((await start(6)).status, 422);
  assert.equal((await start(7)).status, 409);
  const busy = await start(8);
  assert.equal(busy.status, 409);
  assert.equal((await post(w, { action: "queue", number: 8, after: 5 })).status, 409);
  assert.deepEqual([w.accepted, w.comments], [[], []]);
});

test("refused: a config with errors, a user outside the repo's users", async () => {
  const broken = setup({ errors: ["bad"], issues: { 5: open("Five") } });
  assert.equal((await post(broken, { action: "start", number: 5 })).status, 409);
  const narrowed = setup({ settings: { users: ["bob"] }, issues: { 5: open("Five") } });
  const res = await post(narrowed, { action: "start", number: 5 });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /not among org\/app's users/);
  assert.equal((await post(narrowed, { action: "start", number: 5 }, { user: "bob" })).status, 200);
  assert.deepEqual(broken.accepted, []);
});
