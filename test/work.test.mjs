import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { createWaits } from "../listener/waits.mjs";
import { ISSUES_MS, createWorkApi, leadsTo, parseAction } from "../listener/work.mjs";
import { MAX_TEXT } from "../listener/answers.mjs";
import { board as boardOf } from "../listener/board.mjs";

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
  tasks = {},
  runs = {},
  events = {},
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
    logs: [],
    clock: 1000,
  };
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
      settings: { users: config.users, modes: {}, ...settings },
      errors,
    }),
    reply,
    waits: w.waits,
    accept: async (item) => w.accepted.push(item),
    boardKeys: () => new Set(board),
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
  // The run takes the label off as it starts (runs.mjs begin()).
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
