import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { createWaits } from "../listener/waits.mjs";
import { ISSUES_MS, checkAction, createWorkApi, leadsTo, staleFor } from "../listener/work.mjs";
import { createAnalysis } from "../listener/analysis.mjs";
import { MAX_TEXT } from "../listener/answers.mjs";
import { board as boardOf } from "../listener/board.mjs";
import { workItem } from "../listener/events.mjs";

const ORIGIN = "https://deckhand.example.com";

// The work area with a fake GitHub behind it: `issues` by number (GET /issues/{n}, and the
// open ones listed), `repoSettings` as the default branch's config says, real waits in a temp
// dir.
// `tasks`: the board's, by key (api/state's, with their questions). `events`: an issue's
// timeline, by number. Issues the backlog lists as waiting for input are in `w.listed`, and on
// the board as board.mjs makes them.
function setup({
  env = {},
  settings = {},
  errors = [],
  issues = {},
  busy = [],
  board = [],
  live = board,
  tasks = {},
  runs = {},
  events = {},
  cancels = {},
  history = [],
} = {}) {
  const config = loadConfig({
    ALLOWED_USERS: "alice,bob",
    DATA_DIR: mkdtempSync(join(tmpdir(), "deckhand-")),
    ...env,
  });
  config.bot = "deckhand[bot]";
  const w = {
    calls: [],
    comments: [],
    posted: [],
    accepted: [],
    eyes: [],
    settled: [],
    labels: [],
    untracked: [],
    issues,
    tasks,
    runs,
    events,
    listed: new Map(),
    cancelled: [],
    logs: [],
    created: [],
    clock: 1000,
  };
  let commentId = 500;
  const github = async (repo, method, path, body) => {
    w.calls.push(`${method} ${path}`);
    // A test holds GitHub's answers with `w.hold = promise`, or fails them with `w.down`.
    await w.hold;
    if (w.down) return new Response("{}", { status: 502 });
    const on = /\/issues\/(\d+)\/comments$/.exec(path)?.[1];
    if (method === "POST" && on) {
      w.posted.push([Number(on), body.body]);
      return Response.json({ id: ++commentId, html_url: `c/${commentId}`, node_id: "N" });
    }
    if (method === "POST" && path === `/repos/${repo}/labels`) {
      return new Response("{}", { status: w.labelled ? 422 : 201 });
    }
    if (method === "POST" && path === `/repos/${repo}/issues`) {
      if (w.noIssues) return new Response("{}", { status: 410 });
      w.created.push(body);
      const number = 900 + w.created.length;
      return Response.json({ number, title: body.title, html_url: `u/${number}` });
    }
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
    const timeline = /\/issues\/(\d+)\/events\?/.exec(path)?.[1];
    if (timeline) return Response.json(w.events[timeline] ?? []);
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
      settings: { users: config.users, modes: {}, waitForAnswers: true, ...settings },
      errors,
    }),
    reply,
    waits: w.waits,
    accept: async (item) => w.accepted.push(item),
    boardKeys: () => new Set(board),
    liveKeys: () => new Set(live),
    busy: (key) => busy.includes(key),
    taskOf: (key) =>
      w.tasks[key] ??
      boardOf({
        runs: [],
        queued: [],
        brainstorms: [],
        inputs: [...w.listed].map(([k, questions]) => ({ key: k, since: 1, questions })),
      }).find((t) => t.key === key) ??
      null,
    label: async (repo, number, on) => {
      w.labels.push([number, on]);
      return new Response(null, { status: 200 });
    },
    inputs: {
      set: (key, on, questions) => {
        w.untracked.push([key, on]);
        if (on) w.listed.set(key, questions);
        else w.listed.delete(key);
      },
      has: (key) => w.listed.has(key),
    },
    runOf: (id) => w.runs[id] ?? null,
    cancel: (key, user) => {
      w.cancelled.push([key, user]);
      return cancels[key] ?? null;
    },
    // Each run's digest is its id: the endpoint's checks are what is tested here.
    analysis: createAnalysis({ runs: () => history, partOf: (r) => `part of ${r.id}` }),
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

// Lets a background read finish: the fake GitHub answers within a few turns.
const settled = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const post = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/work", { body, ...opts });

const open = (title) => ({ state: "open", title });

test("checkAction: an action, issue numbers, a mode's name", () => {
  assert.deepEqual(checkAction({ action: "start", number: 3 }), {
    action: "start",
    number: 3,
    after: null,
    mode: null,
    pr: false,
  });
  assert.deepEqual(checkAction({ action: "queue", number: 3, after: 2, mode: "brainstorm" }), {
    action: "queue",
    number: 3,
    after: 2,
    mode: "brainstorm",
    pr: false,
  });
  // `pr` only means something to a cancel.
  assert.equal(checkAction({ action: "cancel", number: 3, pr: true }).pr, true);
  assert.equal(checkAction({ action: "start", number: 3, pr: true }).pr, false);
  for (const bad of [
    "null",
    '{"action":"merge","number":3}',
    '{"action":"start","number":"3"}',
    '{"action":"start","number":-1}',
    '{"action":"queue","number":3}',
    '{"action":"start","number":3,"mode":"a b"}',
    '{"action":"cancel","number":3,"pr":"yes"}',
  ]) {
    assert.throws(() => checkAction(JSON.parse(bad)), { status: 400 }, bad);
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
  await settled();
  assert.equal(listed(), 1);
  w.clock += ISSUES_MS;
  await call(w.api, "GET", "/api/repos/org/app/issues");
  await settled();
  assert.equal(listed(), 2);
});

test("GET issues: an old read is served at once, and read again once in the background", async () => {
  const w = setup({ issues: { 1: open("One") } });
  const get = () => call(w.api, "GET", "/api/repos/org/app/issues");
  const first = await get();
  assert.equal(first.body.readAt, 1000);
  w.clock += ISSUES_MS;
  w.issues[2] = open("Two");
  let release;
  w.hold = new Promise((resolve) => (release = resolve));
  // GitHub holds its answers: the requests don't wait for it, and start a single read.
  const old = await get();
  assert.deepEqual(old.body, first.body);
  assert.deepEqual((await get()).body, first.body);
  assert.equal(w.calls.filter((c) => c === "GET /repos/org/app").length, 2);
  release();
  w.hold = null;
  await settled();
  const fresh = await get();
  assert.deepEqual(
    fresh.body.issues.map((i) => i.number),
    [1, 2],
  );
  assert.equal(fresh.body.readAt, 1000 + ISSUES_MS);
});

test("GET issues: a failed background read keeps the last one, and is tried again", async () => {
  const w = setup({ issues: { 1: open("One") } });
  const get = () => call(w.api, "GET", "/api/repos/org/app/issues");
  await get();
  w.clock += ISSUES_MS;
  w.down = true;
  assert.deepEqual((await get()).body.issues, [{ number: 1, title: "One", url: "u/1" }]);
  await settled();
  assert.match(w.logs.at(-1), /org\/app: backlog: GitHub GET \/repos\/org\/app: 502/);
  // Still the last read, and another try.
  const reads = () => w.calls.filter((c) => c === "GET /repos/org/app").length;
  assert.equal((await get()).status, 200);
  assert.equal(reads(), 3);
  await settled();
  w.down = false;
  w.issues[2] = open("Two");
  assert.equal((await get()).body.issues.length, 1);
  await settled();
  assert.equal((await get()).body.issues.length, 2);
});

test("GET issues: without a read yet, a failure is the request's", async () => {
  const w = setup({ issues: { 1: open("One") } });
  w.down = true;
  const get = () => call(w.api, "GET", "/api/repos/org/app/issues");
  assert.equal((await get()).status, 502);
  // Not kept: the next request reads again.
  w.down = false;
  assert.equal((await get()).status, 200);
});

test("GET issues: the users check applies to an old read too", async () => {
  const w = setup({ settings: { users: ["alice"] }, issues: { 1: open("One") } });
  const get = (user) => call(w.api, "GET", "/api/repos/org/app/issues", { user });
  assert.equal((await get("bob")).status, 404);
  w.clock += ISSUES_MS;
  w.hold = new Promise(() => {});
  assert.equal((await get("bob")).status, 404);
  assert.equal((await get("alice")).status, 200);
});

test("GET issues: an issues delivery makes the backlog stale", async () => {
  const w = setup({ issues: { 1: open("One") } });
  const get = () => call(w.api, "GET", "/api/repos/org/app/issues");
  await get();
  w.issues[2] = open("Two");
  const repository = { full_name: "Org/App" };
  // Labels don't change the backlog; another repo's issue doesn't either.
  assert.equal(staleFor("issues", { action: "labeled", repository }, w.api.stale), false);
  assert.equal(staleFor("issue_comment", { action: "created", repository }, w.api.stale), false);
  staleFor("issues", { action: "opened", repository: { full_name: "org/other" } }, w.api.stale);
  await get();
  await settled();
  assert.equal((await get()).body.issues.length, 1);
  assert.equal(staleFor("issues", { action: "opened", repository }, w.api.stale), true);
  // The next request gets the last read and reads again; the one after, the new issue.
  assert.equal((await get()).body.issues.length, 1);
  await settled();
  assert.equal((await get()).body.issues.length, 2);
  for (const action of ["closed", "reopened", "edited", "transferred", "deleted"]) {
    const calls = [];
    assert.equal(
      staleFor("issues", { action, repository }, (r) => calls.push(r)),
      true,
    );
    assert.deepEqual(calls, ["Org/App"]);
  }
});

test("GET issues: a delivery during a read makes the next request read again", async () => {
  const w = setup({ issues: { 1: open("One") } });
  const get = () => call(w.api, "GET", "/api/repos/org/app/issues");
  await get();
  w.clock += ISSUES_MS;
  let release;
  w.hold = new Promise((resolve) => (release = resolve));
  await get();
  w.api.stale("org/app");
  release();
  w.hold = null;
  await settled();
  const reads = () => w.calls.filter((c) => c === "GET /repos/org/app").length;
  assert.equal(reads(), 2);
  await get();
  assert.equal(reads(), 3);
});

test("GET issues: an issue whose task is over is back, one with something live isn't", async () => {
  const w = setup({
    issues: { 1: open("Brainstorm stopped"), 2: open("Brainstorming"), 3: open("Run done") },
    board: ["org/app#1", "org/app#2", "org/app#3"],
    live: ["org/app#2"],
  });
  const res = await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.deepEqual(
    res.body.issues.map((i) => i.number),
    [1, 3],
  );
});

// #144's body: an inbox issue with three questions in the format.
const BODY_144 = `## Problem

Something.

## Open questions

1. **Label from the backlog**: should the listener also add the label?
   - [ ] Yes, so GitHub and the dashboard agree (recommended)
   - [ ] No, only list it on the dashboard
2. **Where**: which page?
   - [ ] The graph (recommended)
   - [ ] The task list
3. **Wording**: what should the notice say?

From the ideas inbox: https://github.com/org/app/issues/16#issuecomment-1`;
const BOT = { login: "deckhand[bot]", type: "Bot" };
const asked = (body, extra = {}) => ({ ...open("Asks"), user: BOT, labels: [], body, ...extra });

test("GET issues: open questions without the label are listed and labelled, then a start is refused", async () => {
  const w = setup({ issues: { 144: asked(BODY_144) } });
  const res = await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.equal(res.status, 200);
  assert.deepEqual(w.labels, [[144, true]]);
  const questions = w.listed.get("org/app#144");
  assert.equal(questions.items.length, 3);
  assert.equal(questions.items[0].title, "Label from the backlog");
  // Read again: nothing asked twice.
  w.clock += ISSUES_MS;
  await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.deepEqual(w.labels, [[144, true]]);
  assert.equal(w.calls.filter((c) => c.includes("/events?")).length, 1);
  // The graph's form opens for it, and the API holds a start without answers.
  const start = await post(w, { action: "start", number: 144 });
  assert.equal(start.status, 409);
  assert.deepEqual(w.accepted, []);
});

test("GET issues: an issue already labelled is listed without a label call or timeline", async () => {
  const w = setup({ issues: { 144: asked(BODY_144, { labels: [{ name: "needs-input" }] }) } });
  await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.equal(w.listed.get("org/app#144").items.length, 3);
  assert.deepEqual(w.labels, []);
  assert.equal(w.calls.filter((c) => c.includes("/events?")).length, 0);
});

test("GET issues: no seeding once the label was taken off, nor for the board, other authors or no questions", async () => {
  const w = setup({
    issues: {
      1: asked(BODY_144),
      2: asked(BODY_144),
      3: asked(BODY_144, { user: { login: "mallory", type: "User" } }),
      4: asked("## Open questions\n\nNone"),
      5: asked("## Open questions\n\nWhat colour, and why?"),
      6: asked(BODY_144, { user: { login: "alice", type: "User" } }),
    },
    events: { 1: [{ event: "unlabeled", label: { name: "Needs-Input" } }] },
    board: ["org/app#2"],
  });
  await call(w.api, "GET", "/api/repos/org/app/issues");
  // A section not in the format: listed, with the text box (no items).
  assert.deepEqual([...w.listed.keys()].sort(), ["org/app#5", "org/app#6"]);
  assert.equal(w.listed.get("org/app#5").items, null);
  assert.deepEqual(w.labels, [
    [5, true],
    [6, true],
  ]);
  // The removed label is remembered: its timeline isn't read again.
  w.clock += ISSUES_MS;
  await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.equal(w.calls.filter((c) => c.includes("/issues/1/events?")).length, 1);
});

test("GET issues: no seeding without a label name or with config errors", async () => {
  const off = setup({ env: { NEEDS_INPUT_LABEL: "" }, issues: { 144: asked(BODY_144) } });
  await call(off.api, "GET", "/api/repos/org/app/issues");
  assert.equal(off.listed.size, 0);
  const broken = setup({ errors: ["bad"], issues: { 144: asked(BODY_144) } });
  await call(broken.api, "GET", "/api/repos/org/app/issues");
  assert.equal(broken.listed.size, 0);
});

test("GET issues: signed in, for allowed repos the App is installed on", async () => {
  const w = setup({ env: { ALLOWED_REPOS: "org/app,org/gone" } });
  assert.equal((await call(w.api, "GET", "/api/repos/org/app/issues", { user: null })).status, 401);
  assert.equal((await call(w.api, "GET", "/api/repos/org/secret/issues")).status, 404);
  assert.equal((await call(w.api, "GET", "/api/repos/org/gone/issues")).status, 404);
  assert.equal((await call(w.api, "POST", "/api/repos/org/app/issues")).status, 405);
  assert.equal(w.api.handle({ method: "GET", url: "/api/repos/org/app/config" }, {}, "x"), false);
});

test("GET issues: only for the repo's own users, as the dashboard's tasks are", async () => {
  const w = setup({ settings: { users: ["bob"] }, issues: { 1: open("One") } });
  const res = await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.equal(res.status, 404);
  assert.match(res.body.error, /alice is not among org\/app's users/);
  const bob = await call(w.api, "GET", "/api/repos/org/app/issues", { user: "bob" });
  assert.equal(bob.status, 200);
  assert.deepEqual(bob.body.issues, [{ number: 1, title: "One", url: "u/1" }]);
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

test("stop: an active or idle brainstorm wraps up, with the App's comment", async () => {
  for (const state of ["brainstorm", "idle-brainstorm"]) {
    const w = setup({ issues: { 5: open("Five") }, tasks: { "org/app#5": { state } } });
    const res = await post(w, { action: "stop", number: 5 });
    assert.equal(res.status, 200);
    assert.match(res.body.message, /#5's brainstorm wraps up/);
    assert.deepEqual(w.comments, [
      [
        5,
        "Brainstorm stopped from the dashboard by @alice: a summary and the issue's update follow.",
      ],
    ]);
    const [item] = w.accepted;
    // What a "/stop" comment is: task-modes.mjs modeOf() turns it into the wrap-up.
    assert.equal(item.trigger, "stop");
    assert.equal(item.modeLine, null);
    assert.equal(item.author, "alice");
    assert.equal(item.comment.id, 501);
  }
});

test("stop refused: no brainstorm, one stopped or busy, users, a broken config", async () => {
  const cases = [
    [{}, 409],
    [{ tasks: { "org/app#5": { state: "done" } } }, 409],
    [{ tasks: { "org/app#5": { state: "stopping" } } }, 409],
    [{ tasks: { "org/app#5": { state: "brainstorm" } }, busy: ["org/app#5"] }, 409],
    [{ tasks: { "org/app#5": { state: "brainstorm" } }, settings: { users: ["bob"] } }, 403],
    [{ tasks: { "org/app#5": { state: "brainstorm" } }, errors: ["bad"] }, 409],
  ];
  for (const [opts, status] of cases) {
    const w = setup({ issues: { 5: open("Five") }, ...opts });
    const res = await post(w, { action: "stop", number: 5 });
    assert.equal(res.status, status, JSON.stringify(opts));
    assert.deepEqual([w.comments, w.accepted], [[], []]);
  }
  const w = setup({ issues: { 5: open("Five") }, tasks: { "org/app#5": { state: "brainstorm" } } });
  assert.equal((await post(w, { action: "stop", number: 5 }, { user: "mallory" })).status, 403);
  assert.equal((await post(w, { action: "stop", number: 5 }, { origin: "https://x" })).status, 403);
});

test("cancel: the run stops or the queue is dropped, with the App's comment where the task replies", async () => {
  const w = setup({
    issues: { 5: open("Five") },
    tasks: { "org/app#5": { state: "working", replyTo: 9 } },
    cancels: { "org/app#5": "running", "org/app#pr-8": "queued" },
  });
  const res = await post(w, { action: "cancel", number: 5 });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "#5 stops.");
  // Busy, and its issue isn't even looked up: a run may go on on a closed issue.
  assert.deepEqual(w.cancelled, [["org/app#5", "alice"]]);
  assert.deepEqual(w.comments, [[9, "Stopped from the dashboard by @alice."]]);
  const pr = await post(w, { action: "cancel", number: 8, pr: true });
  assert.equal(pr.status, 200);
  assert.equal(pr.body.message, "#8's queued comments dropped.");
  assert.deepEqual(w.cancelled.at(-1), ["org/app#pr-8", "alice"]);
  assert.deepEqual(w.comments.at(-1), [8, "Stopped from the dashboard by @alice."]);
  assert.deepEqual(w.accepted, []);
});

test("cancel refused: nothing running or queued, users, a broken config, another origin", async () => {
  const cases = [
    [{}, {}, 409],
    [{ settings: { users: ["bob"] } }, {}, 403],
    [{ errors: ["bad"] }, {}, 409],
    [{}, { user: "mallory" }, 403],
    [{}, { origin: "https://x" }, 403],
  ];
  for (const [opts, as, status] of cases) {
    const running = Object.keys(opts).length || Object.keys(as).length;
    const w = setup({ cancels: running ? { "org/app#5": "running" } : {}, ...opts });
    const res = await post(w, { action: "cancel", number: 5 }, as);
    assert.equal(res.status, status, JSON.stringify([opts, as]));
    assert.deepEqual(w.comments, []);
    // Checked before anything stops.
    if (status === 403 || opts.errors) assert.deepEqual(w.cancelled, []);
  }
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

// --- Answers to open questions -----------------------------------------------------------

const QUESTIONS = [
  {
    title: "Phones",
    text: "Left to right, or top to bottom on phones?",
    options: [
      { label: "Left to right", recommended: true },
      { label: "Top to bottom", recommended: false },
    ],
  },
  { title: null, text: "What should the link say?", options: [] },
];

// A task waiting for input, as board() has it: `source` "issue" (its body's questions) or "run".
const asking = (number, source, items = QUESTIONS, extra = {}) => ({
  key: `org/app#${number}`,
  state: "needs-input",
  replyTo: number,
  runs: source === "run" ? [{ status: "needs-input" }] : [],
  questions: { source, items, raw: "1. …" },
  ...extra,
});

const answer = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/answer", { body, ...opts });

test("answer an issue's questions: one App comment, the label off, the task no longer listed", async () => {
  const w = setup({ issues: { 5: open("Five") }, tasks: { "org/app#5": asking(5, "issue") } });
  const res = await answer(w, {
    number: 5,
    answers: [{ options: [0], text: "Scroll hint too" }, { text: "Home" }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "Answers sent: #5 no longer needs input.");
  assert.deepEqual(w.comments, [
    [
      5,
      [
        "Answers from @alice, from the dashboard:",
        "",
        "1. **Phones**",
        "   - [x] Left to right",
        "   - Scroll hint too",
        "2. What should the link say?",
        "   - Home",
      ].join("\n"),
    ],
  ]);
  assert.deepEqual(w.labels, [[5, false]]);
  assert.deepEqual(w.untracked, [["org/app#5", false]]);
  // Nothing runs: the issue starts later, from the work area or a trigger.
  assert.deepEqual(w.accepted, []);
});

test("answer some of an issue's questions: the comment says which are open, the label stays", async () => {
  const w = setup({ issues: { 5: open("Five") }, tasks: { "org/app#5": asking(5, "issue") } });
  const res = await answer(w, { number: 5, answers: [{ options: [1] }, {}] });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "Answers sent: #5 still needs input. 1 still open.");
  assert.match(w.comments[0][1], /2\. What should the link say\?\n {3}- _Not answered yet\._/);
  assert.match(w.comments[0][1], /\n\nStill open: question 2\.$/);
  assert.deepEqual([w.labels, w.untracked], [[], []]);
});

test("answer questions not in the format: the free text as written", async () => {
  const w = setup({
    issues: { 5: open("Five") },
    tasks: { "org/app#5": asking(5, "issue", null) },
  });
  const res = await answer(w, { number: 5, text: "  1. yes\n2. the second one  " });
  assert.equal(res.status, 200);
  assert.deepEqual(w.comments, [
    [5, "Answers from @alice, from the dashboard:\n\n1. yes\n2. the second one"],
  ]);
  assert.deepEqual(w.labels, [[5, false]]);
  // A form's answers to questions that aren't parsed: refused.
  w.tasks["org/app#5"] = asking(5, "issue", null);
  assert.equal((await answer(w, { number: 5, answers: [{ text: "x" }] })).status, 409);
});

test("answer a run's questions: the comment is the reply that continues its session", async () => {
  const w = setup({
    issues: { 5: open("Five"), 9: { ...open("Its PR"), pull_request: {} } },
    tasks: {
      "org/app#5": asking(5, "run"),
      "org/app#pr-9": asking(9, "run", QUESTIONS, { key: "org/app#pr-9" }),
    },
  });
  const res = await answer(w, { number: 5, answers: [{ options: [0] }, {}] });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "Answers sent: #5 continues. 1 still open.");
  const [item] = w.accepted;
  assert.equal(item.id, "5");
  assert.equal(item.kind, "issue");
  // No trigger: it goes on as a reply would, in the session that asked.
  assert.equal(item.trigger, null);
  assert.equal(item.modeLine, null);
  assert.equal(item.text, w.comments[0][1]);
  assert.equal(item.author, "alice");
  assert.equal(item.comment.id, 501);
  assert.equal(item.base, "main");
  // The run takes the label off as it starts (runs.mjs start()).
  assert.deepEqual(w.labels, []);
  // A pull request's own task.
  const pr = await answer(w, { number: 9, pr: true, text: "Go ahead" });
  assert.equal(pr.status, 200);
  assert.equal(w.accepted[1].id, "pr-9");
  assert.equal(w.accepted[1].kind, "pr");
  assert.equal(w.comments[1][0], 9);
});

test("answer a run's questions before they are parsed: free text, the reply all the same", async () => {
  const run = {
    key: "org/app#5",
    state: "needs-input",
    replyTo: 7,
    runs: [{ status: "needs-input" }],
  };
  const w = setup({ issues: { 5: open("Five") }, tasks: { "org/app#5": run } });
  const res = await answer(w, { number: 5, text: "Yes" });
  assert.equal(res.status, 200);
  // The run asked on its pull request: the answers go there.
  assert.equal(w.comments[0][0], 7);
  assert.equal(w.accepted[0].replyTo, 7);
});

test("answer refused: signed out, another origin, users, not waiting, changed or empty answers, too big", async () => {
  const w = setup({
    env: { ALLOWED_REPOS: "org/app", ALLOWED_USERS: "alice,bob,carol" },
    settings: { users: ["alice", "carol"] },
    issues: { 5: open("Five"), 6: open("Six"), 8: { state: "closed" } },
    tasks: {
      "org/app#5": asking(5, "issue"),
      "org/app#6": { key: "org/app#6", state: "done", runs: [] },
      "org/app#8": asking(8, "issue"),
    },
  });
  const ok = { number: 5, text: "Yes" };
  assert.equal((await answer(w, ok, { user: null })).status, 401);
  assert.equal((await answer(w, ok, { origin: "https://evil.example" })).status, 403);
  assert.equal((await answer(w, ok, { origin: null })).status, 403);
  // Not in ALLOWED_USERS, then not among the repo's users.
  assert.equal((await answer(w, ok, { user: "mallory" })).status, 403);
  assert.equal((await answer(w, ok, { user: "bob" })).status, 403);
  assert.equal(
    (await call(w.api, "POST", "/api/repos/org/other/answer", { body: ok })).status,
    404,
  );
  assert.equal((await call(w.api, "GET", "/api/repos/org/app/answer")).status, 405);
  // Not waiting for input, unknown, closed.
  assert.equal((await answer(w, { number: 6, text: "Yes" })).status, 409);
  assert.equal((await answer(w, { number: 7, text: "Yes" })).status, 409);
  assert.equal((await answer(w, { number: 8, text: "Yes" })).status, 409);
  // Not a pull request's task.
  assert.equal((await answer(w, { number: 5, pr: true, text: "Yes" })).status, 409);
  // Answers that don't fit the questions any more, or say nothing.
  assert.equal((await answer(w, { number: 5, answers: [{ text: "x" }] })).status, 409);
  assert.equal((await answer(w, { number: 5, answers: [{ options: [2] }, {}] })).status, 409);
  assert.equal((await answer(w, { number: 5, answers: [{}, { text: " " }] })).status, 400);
  assert.equal((await answer(w, { number: 5, text: "  " })).status, 400);
  // Over the body's limit.
  const big = await answer(w, { number: 5, text: "x".repeat(5 * MAX_TEXT) });
  assert.equal(big.status, 413);
  assert.deepEqual([w.comments, w.accepted, w.labels], [[], [], []]);
  assert.equal((await answer(w, ok, { user: "carol" })).status, 200);
});

test("start or queue an issue with open questions: refused until they are answered", async () => {
  const w = setup({
    issues: { 5: open("Five"), 7: open("Seven") },
    tasks: { "org/app#5": asking(5, "issue") },
  });
  const start = await post(w, { action: "start", number: 5 });
  assert.equal(start.status, 409);
  assert.match(start.body.error, /open questions: answer them first/);
  assert.equal((await post(w, { action: "queue", number: 5, after: 7 })).status, 409);
  // Every question needs an answer before it moves.
  const partial = await answer(w, {
    number: 5,
    answers: [{ options: [0] }, {}],
    then: { action: "start" },
  });
  assert.equal(partial.status, 400);
  assert.equal(
    (await answer(w, { number: 5, text: "x", then: { action: "dequeue" } })).status,
    422,
  );
  assert.equal((await answer(w, { number: 5, text: "x", then: { action: "fly" } })).status, 400);
  assert.deepEqual([w.comments, w.accepted, w.labels], [[], [], []]);
});

test("wait_for_answers off: an issue with open questions starts and queues without them", async () => {
  const w = setup({
    settings: { waitForAnswers: false },
    issues: { 5: open("Five"), 7: open("Seven") },
    tasks: { "org/app#5": asking(5, "issue") },
  });
  const start = await post(w, { action: "start", number: 5 });
  assert.equal(start.status, 200);
  assert.equal(start.body.message, "#5 started.");
  assert.equal(w.accepted.length, 1);
  assert.equal(w.accepted[0].text, "");
  const queue = await post(w, { action: "queue", number: 5, after: 7 });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.message, "#5 waits for #7.");
  // The label stays: nothing answered the questions.
  assert.deepEqual(w.labels, []);
});

test("answer then queue: one App comment with the answers, held after the other issue, label off", async () => {
  const w = setup({
    issues: { 5: open("Five"), 7: open("Seven") },
    tasks: { "org/app#5": asking(5, "issue") },
  });
  const res = await answer(w, {
    number: 5,
    answers: [{ options: [0] }, { text: "Home" }],
    then: { action: "queue", after: 7, mode: "brainstorm" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "Answers sent: #5 waits for #7.");
  assert.equal(w.comments.length, 1);
  const [number, text] = w.comments[0];
  assert.equal(number, 5);
  assert.match(text, /^Queued from the dashboard by @alice, after #7 in `brainstorm` mode\./);
  assert.match(text, /\n\nAnswers from @alice, from the dashboard:\n\n1\. \*\*Phones\*\*/);
  const wait = w.waits.get("org/app#5");
  assert.deepEqual(wait.blockers, [7]);
  // The run that starts once #7 is done reads them.
  assert.match(wait.item.text, /^Answers from @alice/);
  assert.equal(wait.item.modeLine, "brainstorm");
  assert.deepEqual(w.labels, [[5, false]]);
  assert.deepEqual(w.untracked, [["org/app#5", false]]);
});

test("answer then start: a run's questions too, the work queued with them", async () => {
  const w = setup({
    issues: { 5: open("Five") },
    tasks: { "org/app#5": asking(5, "run", null) },
  });
  const res = await answer(w, { number: 5, text: "Yes to both", then: { action: "start" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "Answers sent: #5 started.");
  assert.equal(
    w.comments[0][1],
    "Started from the dashboard by @alice.\n\nAnswers from @alice, from the dashboard:\n\nYes to both",
  );
  const [item] = w.accepted;
  assert.equal(item.trigger, "work");
  assert.equal(item.text, "Answers from @alice, from the dashboard:\n\nYes to both");
  assert.equal(w.accepted.length, 1);
  assert.deepEqual(w.labels, [[5, false]]);
});

// A task whose last run failed (board.mjs), and that run's record (runs.mjs).
function failed(key, extra = {}) {
  const id = key.slice(key.indexOf("#") + 1);
  const run = {
    id: `run-${id}`,
    key,
    repo: "org/app",
    kind: id.startsWith("pr-") ? "pr" : "issue",
    taskMode: "work",
    replyTo: Number(id.replace("pr-", "")),
    status: "error",
    items: [
      { id, kind: "issue", number: 5, trigger: "work", modeLine: null, text: "Fix it\n/model x" },
      { id, kind: "issue", number: 5, trigger: null, modeLine: null, text: "" },
      { id, kind: "issue", number: 5, trigger: null, modeLine: null, text: "And this" },
    ],
    ...extra,
  };
  const task = { key, state: run.status, rerunnable: true, runs: [run] };
  return { runs: { [run.id]: run }, tasks: { [key]: task } };
}

const rerun = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/rerun", { body, ...opts });

test("rerun: the App comments, then the failed run's comments are queued in its mode", async () => {
  const w = setup({
    issues: { 5: open("Five") },
    settings: { modes: { review: {} } },
    ...failed("org/app#5", { taskMode: "review", status: "interrupted" }),
  });
  const res = await rerun(w, { runId: "run-5" });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "Rerun of #5 queued.");
  assert.deepEqual(w.comments, [
    [5, "Rerun from the dashboard by @alice in `review` mode: its last run was interrupted."],
  ]);
  const [item] = w.accepted;
  assert.equal(item.id, "5");
  assert.equal(item.kind, "issue");
  assert.equal(item.trigger, "work");
  assert.equal(item.modeLine, "review");
  assert.equal(item.text, "Fix it\n/model x\n\n---\n\nAnd this");
  assert.equal(item.author, "alice");
  assert.equal(item.replyTo, 5);
  // Its reactions go on the App's comment.
  assert.equal(item.comment.id, 501);
});

test("rerun: a pull request's task, replying where the failed run did", async () => {
  const w = setup({
    issues: { 8: { ...open("PR"), pull_request: {} } },
    ...failed("org/app#pr-8"),
  });
  const res = await rerun(w, { runId: "run-pr-8" });
  assert.equal(res.status, 200);
  assert.deepEqual(w.comments, [[8, "Rerun from the dashboard by @alice: its last run failed."]]);
  const [item] = w.accepted;
  assert.equal(item.id, "pr-8");
  assert.equal(item.kind, "pr");
  assert.equal(item.modeLine, null);
});

test("rerun refused: users, a broken config, closed, busy, not the latest, not failed, unknown", async () => {
  const issues = { 5: open("Five") };
  const refused = async (opts, body, expected, user = "alice") => {
    const w = setup({ issues, ...failed("org/app#5"), ...opts });
    const res = await rerun(w, body, { user });
    assert.equal(res.status, expected, JSON.stringify(res.body));
    assert.deepEqual(w.comments, []);
    assert.deepEqual(w.accepted, []);
    return res.body.error;
  };
  await refused({}, { runId: "run-5" }, 403, "carol");
  await refused({ settings: { users: ["bob"] } }, { runId: "run-5" }, 403);
  await refused({ errors: ["bad"] }, { runId: "run-5" }, 409);
  await refused({ issues: { 5: { state: "closed" } } }, { runId: "run-5" }, 409);
  await refused({ busy: ["org/app#5"] }, { runId: "run-5" }, 409);
  await refused({}, { runId: "run-6" }, 404);
  await refused({}, { runId: "../x" }, 400);
  await refused({}, "nope", 400);
  // Not the latest: a newer run came after it.
  const older = failed("org/app#5");
  older.tasks["org/app#5"].runs.unshift({ id: "run-5b", status: "error" });
  await refused(older, { runId: "run-5" }, 409);
  // Ended ok or needs-input: the board doesn't call it rerunnable.
  for (const status of ["ok", "needs-input"]) {
    const done = failed("org/app#5", { status });
    done.tasks["org/app#5"].rerunnable = false;
    await refused(done, { runId: "run-5" }, 409);
  }
  // A mode gone from the config since.
  await refused(failed("org/app#5", { taskMode: "review" }), { runId: "run-5" }, 422);
  // Another repo's run.
  await refused(failed("org/app#5", { repo: "org/other" }), { runId: "run-5" }, 404);
  // A pull request's task that is busy (its key isn't the issue's).
  const pr = failed("org/app#pr-8");
  await refused(
    { ...pr, issues: { 8: { ...open("PR"), pull_request: {} } }, busy: ["org/app#pr-8"] },
    { runId: "run-pr-8" },
    409,
  );
});

const sendInbox = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/inbox", { body, ...opts });

const INBOX = { inbox: { ideas: 12, bugs: 13 } };

test("inbox: the App's comment on the inbox issue, and the run a comment there starts", async () => {
  const w = setup({ settings: INBOX, issues: { 12: open("Ideas"), 13: open("Bugs") } });
  const sent = await sendInbox(w, { kind: "idea", text: "  Dark mode\n" });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, { message: "Sent to #12.", url: "c/501", task: "org/app#12" });
  // An entry, not a reply: no marker, so the run reads it as the user's.
  assert.deepEqual(w.posted, [[12, "Dark mode\n\nFrom the dashboard by @alice"]]);
  assert.deepEqual(w.comments, []);
  const [item] = w.accepted;
  // What the webhook makes of a comment on the inbox: the same trigger, text and target.
  const hook = workItem({ ...loadConfig({ ALLOWED_USERS: "alice" }), ...INBOX }, "issue_comment", {
    action: "created",
    installation: { id: 1 },
    repository: { full_name: "org/app" },
    issue: { number: 12, title: "Ideas" },
    comment: { id: 501, html_url: "c/501", body: "  Dark mode\n", user: { login: "alice" } },
  });
  for (const key of ["repo", "id", "kind", "number", "title", "trigger", "text", "replyTo"]) {
    assert.deepEqual(item[key], hook[key], key);
  }
  assert.equal(item.text, "From @alice (c/501):\n\nDark mode");
  assert.equal(item.author, "alice");
  assert.equal(item.base, "main");
  assert.deepEqual(item.comment, { id: 501, html_url: "c/501", node_id: "N" });
  // A bug goes to the bugs inbox.
  assert.equal((await sendInbox(w, { kind: "bug", text: "It crashes" })).status, 200);
  assert.deepEqual(w.posted[1], [13, "It crashes\n\nFrom the dashboard by @alice"]);
  assert.equal(w.accepted[1].trigger, "bug");
});

test("inbox refused, nothing posted: users, config errors, no such inbox, text, origin", async () => {
  const issues = { 12: open("Ideas") };
  const w = setup({
    env: { ALLOWED_USERS: "alice,bob,carol" },
    settings: { users: ["alice", "carol"], inbox: { ideas: 12 } },
    issues,
  });
  const ok = { kind: "idea", text: "Dark mode" };
  assert.equal((await sendInbox(w, ok, { user: null })).status, 401);
  assert.equal((await sendInbox(w, ok, { origin: "https://evil.example" })).status, 403);
  assert.equal((await sendInbox(w, ok, { origin: null })).status, 403);
  // Not in ALLOWED_USERS, then not among the repo's users.
  assert.equal((await sendInbox(w, ok, { user: "mallory" })).status, 403);
  assert.equal((await sendInbox(w, ok, { user: "bob" })).status, 403);
  // No bugs inbox.
  const none = await sendInbox(w, { kind: "bug", text: "It crashes" });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /no bug inbox/);
  // Not a kind, no text, too long.
  assert.equal((await sendInbox(w, { kind: "discussion", text: "x" })).status, 400);
  assert.equal((await sendInbox(w, { kind: "idea", text: " \n " })).status, 400);
  assert.equal((await sendInbox(w, { kind: "idea" })).status, 400);
  const long = await sendInbox(w, { kind: "idea", text: "x".repeat(MAX_TEXT + 1) });
  assert.equal(long.status, 413);
  assert.equal((await call(w.api, "GET", "/api/repos/org/app/inbox")).status, 405);
  // The inbox issue is gone.
  delete issues[12];
  assert.equal((await sendInbox(w, ok)).status, 409);
  assert.deepEqual([w.posted, w.accepted], [[], []]);

  // A config with errors.
  const broken = setup({ settings: INBOX, errors: ["bad"], issues: { 12: open("Ideas") } });
  const refused = await sendInbox(broken, ok);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /has errors/);
  assert.deepEqual([broken.posted, broken.accepted], [[], []]);
});

const analyze = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/analyze", { body, ...opts });

const HISTORY = [
  { id: "r5", repo: "org/app", key: "org/app#5", taskMode: "work", status: "error", finishedAt: 5 },
  {
    id: "o4",
    repo: "org/other",
    key: "org/other#4",
    taskMode: "work",
    status: "error",
    finishedAt: 4,
  },
  {
    id: "r3",
    repo: "org/app",
    key: "org/app#3",
    taskMode: "bug",
    status: "needs-input",
    finishedAt: 3,
  },
  { id: "r2", repo: "org/app", key: "org/app#2", taskMode: "work", status: "ok", finishedAt: 2 },
  { id: "r1", repo: "org/app", key: "org/app#1", taskMode: "work", status: "error", finishedAt: 1 },
];

test("analyze: a new issue labelled analysis, and a run in the analyze mode on it", async () => {
  const w = setup({ history: HISTORY });
  const sent = await analyze(w, {
    count: 12,
    kinds: ["work", "bug"],
    outcomes: ["error", "needs-input"],
  });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, {
    message: "Analysis of 3 runs started on #901.",
    url: "u/901",
    number: 901,
    task: "org/app#901",
  });
  assert.ok(w.calls.includes("POST /repos/org/app/labels"));
  const [issue] = w.created;
  assert.equal(issue.title, "Run analysis: last 3 runs (errors, needs-input)");
  assert.deepEqual(issue.labels, ["analysis"]);
  assert.match(issue.body, /^Asked for from the dashboard by @alice/);
  assert.match(issue.body, /Runs \(3, of 12 asked for, newest first\): r5, r3, r1/);
  const [item] = w.accepted;
  assert.equal(item.trigger, "analyze");
  assert.equal(item.modeLine, null);
  assert.deepEqual([item.number, item.replyTo, item.id, item.kind], [901, 901, "901", "issue"]);
  assert.equal(item.author, "alice");
  assert.equal(item.comment, null);
  // Only this repo's runs: org/other's run is never picked.
  assert.deepEqual(item.analysis, {
    runs: ["r5", "r3", "r1"],
    count: 12,
    kinds: ["work", "bug"],
    outcomes: ["error", "needs-input"],
  });
  assert.match(item.text, /- Kinds: work, bug\n- Outcomes: error, needs-input\n/);
  // Every outcome: the title doesn't list them; the label is there already (422).
  w.labelled = true;
  const all = await analyze(w, {
    count: 1,
    kinds: ["work"],
    outcomes: ["ok", "error", "needs-input", "interrupted", "cancelled"],
  });
  assert.equal(all.status, 200);
  assert.equal(w.created[1].title, "Run analysis: last 1 run");
  assert.deepEqual(w.accepted[1].analysis.runs, ["r5"]);
});

test("analyze refused, nothing created: users, origin, config errors, selection, no runs", async () => {
  const w = setup({
    env: { ALLOWED_USERS: "alice,bob,carol" },
    settings: { users: ["alice", "carol"] },
    history: HISTORY,
  });
  const ok = { count: 10, kinds: ["work"], outcomes: ["error"] };
  assert.equal((await analyze(w, ok, { user: null })).status, 401);
  assert.equal((await analyze(w, ok, { origin: "https://evil.example" })).status, 403);
  assert.equal((await analyze(w, ok, { origin: null })).status, 403);
  // Not in ALLOWED_USERS, then not among the repo's users.
  assert.equal((await analyze(w, ok, { user: "mallory" })).status, 403);
  assert.equal((await analyze(w, ok, { user: "bob" })).status, 403);
  // A repo outside ALLOWED_REPOS.
  const outside = setup({ env: { ALLOWED_REPOS: "org/other" }, history: HISTORY });
  const other = await call(outside.api, "POST", "/api/repos/org/app/analyze", { body: ok });
  assert.equal(other.status, 404);
  // An empty selection, or over the maximum.
  for (const body of [
    { ...ok, kinds: [] },
    { ...ok, outcomes: [] },
    { ...ok, count: 51 },
    { ...ok, count: 0 },
    { ...ok, outcomes: ["success"] },
  ]) {
    assert.equal((await analyze(w, body)).status, 400, JSON.stringify(body));
  }
  // No run matches: only another repo's would.
  const none = await analyze(w, { ...ok, kinds: ["discussion"] });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /No run of org\/app matches/);
  // Issues turned off.
  w.noIssues = true;
  assert.equal((await analyze(w, ok)).status, 409);
  assert.deepEqual([w.created, w.accepted], [[], []]);
  // A config with errors.
  const broken = setup({ errors: ["bad"], history: HISTORY });
  const refused = await analyze(broken, ok);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /has errors/);
  assert.deepEqual([broken.created, broken.accepted], [[], []]);
});

test("analyze preview: how many runs match, the tokens, the kinds there are", async () => {
  const w = setup({
    env: { ALLOWED_USERS: "alice,bob" },
    settings: { users: ["alice"] },
    history: HISTORY,
  });
  const get = (query, opts) => call(w.api, "GET", `/api/repos/org/app/analyze?${query}`, opts);
  const seen = await get("count=10&kinds=work,bug&outcomes=error,needs-input");
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.body.runs, ["r5", "r3", "r1"]);
  assert.deepEqual([seen.body.included, seen.body.left, seen.body.max], [3, 0, 50]);
  assert.equal(seen.body.tokens, Math.ceil(seen.body.bytes / 4));
  assert.deepEqual(seen.body.kinds, ["bug", "work"]);
  // Nothing picked yet: no run, the kinds all the same.
  const empty = await get("");
  assert.deepEqual([empty.status, empty.body.runs, empty.body.kinds], [200, [], ["bug", "work"]]);
  // The same checks as the POST, but the origin: a GET changes nothing.
  assert.equal((await get("kinds=work&outcomes=ok", { user: "bob" })).status, 403);
  assert.equal((await get("kinds=work&outcomes=ok", { user: null })).status, 401);
  assert.equal((await get("count=99&kinds=work&outcomes=ok")).status, 400);
  assert.equal((await get("kinds=work&outcomes=nope")).status, 400);
  assert.deepEqual(w.created, []);
  // Other methods.
  assert.equal((await call(w.api, "PUT", "/api/repos/org/app/analyze")).status, 405);
  assert.equal((await call(w.api, "POST", "/api/repos/org/app/issues", { body: {} })).status, 405);
});
