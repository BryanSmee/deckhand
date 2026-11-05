import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ReplyError } from "../listener/comments.mjs";
import { createWaits } from "../listener/waits.mjs";
import { createDismissals } from "../listener/dismissals.mjs";
import { createLanes } from "../listener/lanes.mjs";
import { createOrder } from "../listener/order.mjs";
import { MAX_TREE, leadsTo } from "../listener/plans.mjs";
import { COUNT_MS, ISSUES_MS, checkAction, createWorkApi, staleFor } from "../listener/work.mjs";
import { createAnalysis } from "../listener/analysis.mjs";
import { MAX_TEXT } from "../listener/answers.mjs";
import { board as boardOf } from "../listener/board.mjs";
import { MARKER, parseKey, workItem } from "../listener/events.mjs";
import { MEMBER, VIEWER, permissionsOf, tempDir, testConfig, fileMap } from "./helpers.mjs";
import { openStore } from "../lib/store.mjs";
import { storeMap } from "../lib/store-map.mjs";

const ORIGIN = "https://deckhand.example.com";

// The work area with a fake GitHub behind it: `issues` by number (GET /issues/{n}, the open
// ones listed, and their sub-issues and blockers), `repoSettings` as the default branch's config says, real waits in a temp
// dir.
// `tasks`: the board's, by key (api/state's, with their questions). `events`: an issue's
// timeline, by number. Issues the backlog lists as waiting for input are in `w.listed`, and on
// the board as board.mjs makes them. `queued`: the tasks waiting for a slot that can wait
// instead (runs.mjs queuedTask()), the comment that would wait by key (null: replies only,
// "other": none that starts a run, not replies either: an inbox entry, a wrap-up); busy too.
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
  queued = {},
  history = [],
  queue = [],
  pulls = {},
  reviews = {},
  // The Map the waits are kept in, else one in a file.
  waits = null,
  // Who may do what where (permissions.mjs); none: every action.
  permissions = null,
} = {}) {
  const config = testConfig({
    ALLOWED_USERS: "alice,bob",
    DATA_DIR: tempDir(null),
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
    pulls,
    reviews,
    asked: [],
    listed: new Map(),
    cancelled: [],
    unqueued: [],
    queued: { ...queued },
    logs: [],
    created: [],
    clock: 1000,
  };
  let commentId = 500;
  const github = async (repo, method, path, body) => {
    w.calls.push(`${method} ${path}`);
    // A test acts while GitHub is asked (`w.onCall`): a slot freeing, say.
    w.onCall?.(method, path);
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
      // GitHub's spelling of the name, whatever the request's (`w.fullName`).
      return repo.toLowerCase() === "org/app"
        ? Response.json({
            full_name: w.fullName ?? "org/app",
            default_branch: "main",
            private: !!w.private,
          })
        : new Response("{}", { status: 404 });
    }
    if (path.startsWith(`/repos/${repo}/issues?`)) {
      return Response.json(
        Object.entries(w.issues)
          .filter(([, i]) => i.state === "open")
          .map(([n, i]) => ({ number: Number(n), html_url: `u/${n}`, ...i })),
      );
    }
    // An issue's sub-issues (`subs`) and blockers (`blockedBy`): numbers of `issues`, or
    // another repo's issues as GitHub describes them.
    const tree = /\/issues\/(\d+)\/(sub_issues|dependencies\/blocked_by)\?/.exec(path);
    if (tree) {
      const refs =
        (tree[2] === "sub_issues" ? w.issues[tree[1]]?.subs : w.issues[tree[1]]?.blockedBy) ?? [];
      return Response.json(
        refs.map((r) =>
          typeof r === "number"
            ? { number: r, repository_url: `https://api.github.com/repos/${repo}`, ...w.issues[r] }
            : r,
        ),
      );
    }
    // Pull requests (`pulls`) and the reviews on them (`reviews`), by number.
    const pull = /\/pulls\/(\d+)(\/reviews\?.*)?$/.exec(path);
    if (pull) {
      if (pull[2]) return Response.json(path.includes("page=1") ? (w.reviews[pull[1]] ?? []) : []);
      const pr = w.pulls[pull[1]];
      return pr
        ? Response.json({ number: Number(pull[1]), ...pr })
        : new Response("{}", { status: 404 });
    }
    // A comment of the App's edited (`w.edits`: [id, body]).
    const edited = /\/issues\/comments\/(\d+)$/.exec(path)?.[1];
    if (method === "PATCH" && edited) {
      (w.edits ??= []).push([Number(edited), body.body]);
      return Response.json({ id: Number(edited) });
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
    // A test holds the App's comments with `w.replyHold`; `w.replying`: how many wait there.
    if (w.replyHold) {
      w.replying = (w.replying ?? 0) + 1;
      await w.replyHold;
      w.replying--;
    }
    // A test fails a comment with `w.failComment()` returning true: it throws, as comments.mjs's.
    if (w.failComment?.())
      throw new ReplyError(`GitHub POST /repos/${repo}/issues/${number}/comments`, 502);
    w.comments.push([number, text]);
    return Response.json({ id: ++commentId, html_url: `c/${commentId}`, node_id: "N" });
  };
  w.path = join(config.dataDir, "waits.json");
  w.waits = createWaits({
    waits: waits ?? fileMap(w.path),
    github,
    reply,
    received: (i) => w.eyes.push(i.comment.id),
    settle: async (i, status) => w.settled.push([i.comment.id, status]),
    resume: async () => true,
  });
  w.lanes = createLanes({ now: () => w.clock });
  w.dismissals = createDismissals({ now: () => w.clock });
  w.order = createOrder();
  // The tasks waiting for a slot (`queue`: keys, "brainstorm:" before a brainstorm's), as
  // tasks.mjs queueOrder() sorts them.
  w.queue = queue.map((k) => {
    const [mode, key] = k.includes(":") ? k.split(":") : ["work", k];
    const { repo, id } = parseKey(key);
    return { repo, id, pending: [{ mode }] };
  });
  const queueOrder = () => {
    const ranks = w.order.ranks();
    const rank = (t) => ranks.get(`${t.repo}#${t.id}`.toLowerCase()) ?? Infinity;
    return [...w.queue].sort((a, b) => rank(a) - rank(b));
  };
  w.api = createWorkApi({
    config,
    github,
    repoSettings: async () => ({
      settings: { users: config.users, modes: {}, waitForAnswers: true, ...settings },
      errors,
    }),
    reply,
    waits: w.waits,
    // `w.refusing`: what the policies' refusal replied (run-policy.mjs marks the item).
    accept: async (item) => {
      w.accepted.push(item);
      if (w.refusing) item.refused = w.refusing;
      // Its mode, as tasks.mjs accept() says it: none when refused.
      return w.refusing ? null : (item.modeLine ?? "work");
    },
    boardKeys: () => new Set(board),
    liveKeys: () => new Set(live),
    busy: (key) => busy.includes(key) || key in w.queued,
    // `w.started`: its run started (a slot freed): no longer waiting for one.
    queuedTask: (key) => {
      if (w.started || !(key in w.queued)) return null;
      const item = w.queued[key];
      // `w.others`: other authors' comments queued with it.
      return item === "other"
        ? { item: null, replies: false, others: false }
        : { item: item ?? null, replies: item === null, others: !!item && !!w.others };
    },
    // `until`: what the queue keeps them for (restart.mjs park()), in `w.until`; `w.queueIds`:
    // the queueIds it took out.
    unqueue: (key, user, until) => {
      w.unqueued.push([key, user]);
      w.until = until;
      const item = w.queued[key];
      delete w.queued[key];
      // `w.dropped`: other authors' comments queued with it.
      const unqueued = w.queueIds ?? [];
      return item ? { item: { ...item }, dropped: w.dropped ?? 0, unqueued } : null;
    },
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
    lanes: w.lanes,
    dismissals: w.dismissals,
    order: w.order,
    queueOrder,
    // The review loop's Fix (reviews.mjs startFix(), tested there): what it was asked, and
    // round 4 queued with the App's comment, or `w.noFix`'s reason.
    reviews: {
      fixAsked: async (run, posted, asked) => {
        w.asked.push({ run, posted, user: asked.user });
        if (w.noFix) return { item: null, why: w.noFix };
        const comment = await asked.announce(4, 4, "2 high findings");
        // Refused once its comment is posted (`w.lateFix`): checked again after it; or failing.
        if (w.lateFix) return { item: null, why: w.lateFix };
        if (w.fixFails) throw new Error("GitHub down");
        const item = { reason: "review-fix", round: 4, comment };
        await w.accepted.push(item);
        return { item };
      },
    },
    permissions,
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
  assert.equal(checkAction({ action: "plan", number: 3 }).after, null);
  assert.equal(checkAction({ action: "plan", number: 3, after: 2 }).after, 2);
  for (const bad of [
    "null",
    '{"action":"merge","number":3}',
    '{"action":"start","number":"3"}',
    '{"action":"start","number":-1}',
    '{"action":"queue","number":3}',
    '{"action":"plan","number":3,"after":"2"}',
    '{"action":"start","number":3,"mode":"a b"}',
    '{"action":"cancel","number":3,"pr":"yes"}',
  ]) {
    assert.throws(() => checkAction(JSON.parse(bad)), { status: 400 }, bad);
  }
});

test("leadsTo: follows the waits from blocker to blocker", () => {
  const waits = { 2: [1], 3: [2, 9] };
  const get = (n) => waits[n];
  assert.equal(leadsTo(get, 3, 1), true);
  assert.equal(leadsTo(get, 3, 9), true);
  assert.equal(leadsTo(get, 2, 3), false);
  assert.equal(leadsTo(get, 4, 4), true);
});

test("GET issues: the open issues without a task or pull request, and the repo's modes", async () => {
  const w = setup({
    settings: { modes: { audit: { light: true } } },
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
  assert.deepEqual(res.body.issues, [{ number: 1, title: "One", url: "u/1", labels: [] }]);
  assert.deepEqual(res.body.modes, ["work", "brainstorm", "audit"]);
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
  assert.equal(first.body.refreshing, false);
  w.clock += ISSUES_MS;
  w.issues[2] = open("Two");
  let release;
  w.hold = new Promise((resolve) => (release = resolve));
  // GitHub holds its answers: the requests don't wait for it, and start a single read.
  // Each says a new read is on its way.
  const old = await get();
  assert.deepEqual(old.body, { ...first.body, refreshing: true });
  assert.deepEqual((await get()).body, old.body);
  // The first request's two: its name (nameOf()), then its backlog.
  assert.equal(w.calls.filter((c) => c === "GET /repos/org/app").length, 3);
  release();
  w.hold = null;
  await settled();
  const fresh = await get();
  assert.deepEqual(
    fresh.body.issues.map((i) => i.number),
    [1, 2],
  );
  assert.equal(fresh.body.readAt, 1000 + ISSUES_MS);
  assert.equal(fresh.body.refreshing, false);
});

test("GET issues: a failed background read keeps the last one, and is tried again", async () => {
  const w = setup({ issues: { 1: open("One") } });
  const get = () => call(w.api, "GET", "/api/repos/org/app/issues");
  await get();
  w.clock += ISSUES_MS;
  w.down = true;
  assert.deepEqual((await get()).body.issues, [
    { number: 1, title: "One", url: "u/1", labels: [] },
  ]);
  await settled();
  assert.match(w.logs.at(-1), /org\/app: backlog: GitHub GET \/repos\/org\/app: 502/);
  // Still the last read, and another try.
  // One more than the backlog's: the first request read the repo's name too (nameOf()).
  const reads = () => w.calls.filter((c) => c === "GET /repos/org/app").length - 1;
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
  // The delivery starts the read: once it is done, the next request gets the new issue at
  // once, without reading GitHub again.
  await settled();
  const listed = () => w.calls.filter((c) => c.includes("/issues?")).length;
  assert.equal(listed(), 2);
  const res = await get();
  assert.equal(res.body.issues.length, 2);
  assert.equal(res.body.refreshing, false);
  assert.equal(listed(), 2);
  for (const action of ["closed", "reopened", "edited", "transferred", "deleted"]) {
    const calls = [];
    assert.equal(
      staleFor("issues", { action, repository }, (r) => calls.push(r)),
      true,
    );
    assert.deepEqual(calls, ["Org/App"]);
  }
});

test("GET issues: a delivery during a read reads once more after it, one read at a time", async () => {
  const w = setup({ issues: { 1: open("One") } });
  const get = () => call(w.api, "GET", "/api/repos/org/app/issues");
  await get();
  w.clock += ISSUES_MS;
  let release;
  w.hold = new Promise((resolve) => (release = resolve));
  await get();
  // One more than the backlog's: the first request read the repo's name too (nameOf()).
  const reads = () => w.calls.filter((c) => c === "GET /repos/org/app").length - 1;
  // The read going started before the new issue: two deliveries ask for a single one more,
  // which waits for it.
  w.issues[2] = open("Two");
  w.api.stale("org/app");
  w.api.stale("org/app");
  await settled();
  assert.equal(reads(), 2);
  release();
  w.hold = null;
  await settled();
  assert.equal(reads(), 3);
  const res = await get();
  assert.deepEqual(
    res.body.issues.map((i) => i.number),
    [1, 2],
  );
  assert.equal(res.body.refreshing, false);
  assert.equal(reads(), 3);
});

test("GET issues: a delivery before any read starts none", async () => {
  const w = setup({ issues: { 1: open("One") } });
  w.api.stale("org/app");
  await settled();
  assert.deepEqual(w.calls, []);
});

test("GET issues: an issue whose task ended stays out until a new read says it is open", async () => {
  const live = ["org/app#1", "org/app#2"];
  const w = setup({
    issues: { 1: open("Closed by its run"), 2: open("Run done, still open"), 3: open("Three") },
    live,
  });
  const get = () => call(w.api, "GET", "/api/repos/org/app/issues");
  const numbers = async () => (await get()).body.issues.map((i) => i.number);
  assert.deepEqual(await numbers(), [3]);
  // Both runs end; the first closed its issue. The cached read still has both open: neither
  // comes back from it, and a read starts.
  live.length = 0;
  w.issues[1].state = "closed";
  let release;
  w.hold = new Promise((resolve) => (release = resolve));
  const old = await get();
  assert.deepEqual(
    old.body.issues.map((i) => i.number),
    [3],
  );
  assert.equal(old.body.refreshing, true);
  assert.deepEqual(await numbers(), [3]);
  release();
  w.hold = null;
  await settled();
  assert.deepEqual(await numbers(), [2, 3]);
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

test("counts: none before a first read, which starts in the background, then the backlog's", async () => {
  const w = setup({
    issues: { 1: open("One"), 2: open("Live"), 3: { ...open("A pull request"), pull_request: {} } },
    live: ["org/app#2"],
  });
  let release;
  w.hold = new Promise((resolve) => (release = resolve));
  // Nothing waits for GitHub: the read is on its way, and a second call starts no other.
  assert.deepEqual(w.api.counts(["Org/App"], "alice"), { "org/app": null });
  assert.deepEqual(w.api.counts(["Org/App"], "alice"), { "org/app": null });
  release();
  w.hold = null;
  await settled();
  const listed = () => w.calls.filter((c) => c.includes("/issues?")).length;
  assert.equal(listed(), 1);
  assert.deepEqual(w.api.counts(["Org/App"], "alice"), {
    "org/app": { count: 1, more: false, readAt: 1000 },
  });
  // The board's read is the same: no read of its own, and the count follows it.
  w.issues[4] = open("Four");
  w.clock += ISSUES_MS;
  await call(w.api, "GET", "/api/repos/org/app/issues");
  await settled();
  assert.equal(listed(), 2);
  assert.deepEqual(w.api.counts(["org/app"], "alice"), {
    "org/app": { count: 2, more: false, readAt: 1000 + ISSUES_MS },
  });
  assert.equal(listed(), 2);
});

test("counts: read again once COUNT_MS old, or at an issues delivery", async () => {
  const w = setup({ issues: { 1: open("One") } });
  const listed = () => w.calls.filter((c) => c.includes("/issues?")).length;
  w.api.counts(["org/app"], "alice");
  await settled();
  w.clock += COUNT_MS - 1;
  w.issues[2] = open("Two");
  assert.equal(w.api.counts(["org/app"], "alice")["org/app"].count, 1);
  await settled();
  assert.equal(listed(), 1);
  // Old: the last count at once, the new one at the next call.
  w.clock += 1;
  assert.equal(w.api.counts(["org/app"], "alice")["org/app"].count, 1);
  await settled();
  assert.equal(listed(), 2);
  assert.equal(w.api.counts(["org/app"], "alice")["org/app"].count, 2);
  w.issues[3] = open("Three");
  staleFor("issues", { action: "opened", repository: { full_name: "org/app" } }, w.api.stale);
  await settled();
  assert.equal(w.api.counts(["org/app"], "alice")["org/app"].count, 3);
  assert.equal(listed(), 3);
});

test("counts: a failing read is tried again only after COUNT_MS", async () => {
  const w = setup({ issues: { 1: open("One") } });
  w.down = true;
  const reads = () => w.calls.filter((c) => c === "GET /repos/org/app").length;
  assert.deepEqual(w.api.counts(["org/app"], "alice"), { "org/app": null });
  await settled();
  assert.equal(reads(), 1);
  assert.match(w.logs.at(-1), /org\/app: backlog: GitHub GET \/repos\/org\/app: 502/);
  w.clock += COUNT_MS - 1;
  w.api.counts(["org/app"], "alice");
  await settled();
  assert.equal(reads(), 1);
  w.down = false;
  w.clock += 1;
  w.api.counts(["org/app"], "alice");
  await settled();
  assert.deepEqual(w.api.counts(["org/app"], "alice"), {
    "org/app": { count: 1, more: false, readAt: 1000 + COUNT_MS },
  });
});

test("counts: a full page of issues and pull requests may not be the whole backlog", async () => {
  const issues = {};
  for (let n = 1; n <= 100; n++)
    issues[n] = { ...open(`#${n}`), ...(n > 60 && { pull_request: {} }) };
  const w = setup({ issues });
  w.api.counts(["org/app"], "alice");
  await settled();
  assert.deepEqual(w.api.counts(["org/app"], "alice")["org/app"], {
    count: 60,
    more: true,
    readAt: 1000,
  });
});

test("counts: only for the repo's own users, and without the issues whose task just ended", async () => {
  const live = ["org/app#1"];
  const w = setup({ settings: { users: ["alice"] }, issues: { 1: open("One") }, live });
  w.api.counts(["org/app"], "alice");
  await settled();
  assert.deepEqual(w.api.counts(["org/app"], "bob"), { "org/app": null });
  assert.equal(w.api.counts(["org/app"], "Alice")["org/app"].count, 0);
  // Its run ended: out until a read started after says it is still open, as on the board.
  live.length = 0;
  let release;
  w.hold = new Promise((resolve) => (release = resolve));
  assert.equal(w.api.counts(["org/app"], "alice")["org/app"].count, 0);
  release();
  w.hold = null;
  await settled();
  assert.equal(w.api.counts(["org/app"], "alice")["org/app"].count, 1);
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
const TICKED = "## Open questions\n\n1. Which?\n   - [ ] A\n   - [x] B";
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

test("GET issues: no seeding once the label was taken off, nor for the board, other authors, no questions or every box ticked", async () => {
  const w = setup({
    issues: {
      1: asked(BODY_144),
      7: asked(TICKED, { user: { login: "alice", type: "User" } }),
      // The App's own ticks (an inbox run's) answer nothing: seeded.
      8: asked(TICKED),
      // Ticked, but still labelled (the bot's ticks, say): listed, no label call.
      9: asked(TICKED, {
        user: { login: "alice", type: "User" },
        labels: [{ name: "needs-input" }],
      }),
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
  assert.deepEqual([...w.listed.keys()].sort(), [
    "org/app#5",
    "org/app#6",
    "org/app#8",
    "org/app#9",
  ]);
  assert.equal(w.listed.get("org/app#5").items, null);
  assert.deepEqual(w.labels, [
    [5, true],
    [6, true],
    [8, true],
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
  assert.deepEqual(bob.body.issues, [{ number: 1, title: "One", url: "u/1", labels: [] }]);
});

test("GET issues: how many open sub-issues an issue has, from the list's summary", async () => {
  const w = setup({
    issues: {
      1: { ...open("Epic"), sub_issues_summary: { total: 3, completed: 1 } },
      2: { ...open("Done epic"), sub_issues_summary: { total: 2, completed: 2 } },
    },
  });
  const res = await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.deepEqual(
    res.body.issues.map((i) => [i.number, i.subIssues]),
    [
      [1, 2],
      [2, undefined],
    ],
  );
});

test("GET issues: each issue's labels, from the list", async () => {
  const w = setup({
    issues: {
      1: { ...open("Bug"), labels: [{ name: "bug", color: "d73a4a", id: 7 }, "idea"] },
      2: open("Plain"),
    },
  });
  const res = await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.deepEqual(
    res.body.issues.map((i) => [i.number, i.labels]),
    [
      [
        1,
        [
          { name: "bug", color: "d73a4a" },
          { name: "idea", color: null },
        ],
      ],
      [2, []],
    ],
  );
});

test("GET issues: a sub-issue's parent when it is listed, read once per backlog read", async () => {
  const sub = (title, extra = {}) => ({ ...open(title), ...extra });
  const w = setup({
    issues: {
      1: { ...open("Epic"), subs: [2, 3, 9], sub_issues_summary: { total: 3, completed: 1 } },
      2: sub("Child"),
      3: sub("Child elsewhere"),
      // Closed: not listed, so its open sub-issue keeps no parent.
      4: { state: "closed", title: "Closed epic", subs: [5] },
      5: sub("Orphan"),
      // A parent whose sub-issues are all done isn't asked.
      6: { ...open("Done epic"), subs: [2], sub_issues_summary: { total: 1, completed: 1 } },
      // Its sub-issue is beyond the list (closed): nothing to point at it.
      7: { ...open("Epic of closed"), subs: [8], sub_issues_summary: { total: 1, completed: 0 } },
      8: { state: "closed", title: "Closed child" },
    },
  });
  // #3 is in another repo, as GitHub describes it there: its number matches a listed issue.
  w.issues[1].subs = [
    2,
    { number: 3, repository_url: "https://api.github.com/repos/org/other", state: "open" },
    9,
  ];
  const subCalls = () => w.calls.filter((c) => c.includes("/sub_issues")).length;
  const res = await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.deepEqual(
    res.body.issues.map((i) => [i.number, i.parent]),
    [
      [1, undefined],
      [2, 1],
      [3, undefined],
      [5, undefined],
      [6, undefined],
      [7, undefined],
    ],
  );
  assert.equal(subCalls(), 2);
  // The dashboard's polls take the cached read: no more calls.
  await call(w.api, "GET", "/api/repos/org/app/issues");
  await call(w.api, "GET", "/api/repos/org/app/issues");
  assert.equal(subCalls(), 2);
});

test("GET issues: parents' sub-issues read four at a time", async () => {
  const issues = {};
  for (let n = 1; n <= 6; n++)
    issues[n] = { ...open(`Epic ${n}`), subs: [], sub_issues_summary: { total: 1, completed: 0 } };
  const w = setup({ issues });
  let release;
  const subCalls = () => w.calls.filter((c) => c.includes("/sub_issues")).length;
  w.onCall = (method, path) => {
    if (path.includes("/sub_issues") && !release) w.hold = new Promise((r) => (release = r));
  };
  const res = call(w.api, "GET", "/api/repos/org/app/issues");
  while (subCalls() < 4) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(subCalls(), 4);
  w.hold = null;
  release();
  assert.equal((await res).status, 200);
  assert.equal(subCalls(), 6);
});

test("GET issues: a parent's sub-issues that can't be read only lose their parent", async () => {
  const w = setup({
    issues: {
      1: { ...open("Epic"), subs: [2], sub_issues_summary: { total: 1, completed: 0 } },
      2: open("Child"),
    },
  });
  w.onCall = (method, path) => {
    if (path.includes("/sub_issues")) w.down = true;
  };
  const res = await call(w.api, "GET", "/api/repos/org/app/issues");
  w.down = false;
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.issues.map((i) => [i.number, i.parent]),
    [
      [1, undefined],
      [2, undefined],
    ],
  );
  assert.match(w.logs.join("\n"), /#1's sub-issues/);
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

test("start refused by the policies (allow_run, deny_run): their reply is the answer, 403", async () => {
  const w = setup({ issues: { 5: open("Five") } });
  // Items from the dashboard say so, for the policies' input.trigger.
  await post(w, { action: "start", number: 5 });
  assert.equal(w.accepted[0].dashboard, true);
  w.refusing = "No `work` run: the policies refuse it: `not today`.";
  const res = await post(w, { action: "start", number: 5 });
  assert.equal(res.status, 403);
  assert.equal(res.body.error ?? res.body.message, w.refusing);
});

test("refused by the policies: every dashboard action that starts a run answers 403, waits kept", async () => {
  const refusing = "No `work` run: the policies refuse it: `not today`.";
  const refused = async (w, res) => {
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error ?? res.body.message, refusing);
    assert.equal(w.accepted.length, 1);
  };
  // Start: the issue's wait stays, the run didn't replace it.
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven") } });
  await post(w, { action: "queue", number: 5, after: 7 });
  w.refusing = refusing;
  await refused(w, await post(w, { action: "start", number: 5 }));
  assert.deepEqual(w.waits.get("org/app#5").blockers, [7]);
  // Its comment, which said it started, edited to say it didn't.
  assert.deepEqual(w.edits, [
    [
      w.accepted[0].comment.id,
      "Asked from the dashboard by @alice: not started, the policies refuse it. It still waits for #7.\n\n<!-- deckhand -->",
    ],
  ]);
  // Stop.
  const stopping = setup({
    issues: { 5: open("Five") },
    tasks: { "org/app#5": { state: "brainstorm" } },
  });
  stopping.refusing = refusing;
  await refused(stopping, await post(stopping, { action: "stop", number: 5 }));
  // Rerun.
  const again = setup({ issues: { 5: open("Five") }, ...failed("org/app#5", { status: "error" }) });
  again.refusing = refusing;
  await refused(again, await rerun(again, { runId: "run-5" }));
  // Inbox.
  const entry = setup({ settings: INBOX, issues: { 12: open("Ideas"), 13: open("Bugs") } });
  entry.refusing = refusing;
  await refused(entry, await sendInbox(entry, { kind: "idea", text: "Dark mode" }));
  // A run's questions answered.
  const asked = setup({ issues: { 5: open("Five") }, tasks: { "org/app#5": asking(5, "run") } });
  asked.refusing = refusing;
  await refused(asked, await answer(asked, { number: 5, answers: [{ options: [0] }, {}] }));
  // Review.
  const reviewing = reviewSetup();
  reviewing.refusing = refusing;
  await refused(reviewing, await review(reviewing, { number: 8, action: "review" }));
  // Analyze: the issue made for it is closed, no analysis to keep.
  const analysis = setup({ history: HISTORY });
  analysis.refusing = refusing;
  await refused(
    analysis,
    await analyze(analysis, { count: 1, kinds: ["work"], outcomes: ["error"] }),
  );
  assert.ok(analysis.calls.includes("PATCH /repos/org/app/issues/901"), analysis.calls.join("\n"));
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

// A task waiting for a slot: its latest comment, as tasks.mjs queued it.
const QUEUED = {
  "org/app#5": {
    repo: "org/app",
    id: "5",
    kind: "issue",
    number: 5,
    trigger: "work",
    modeLine: "brainstorm",
    text: "please",
    author: "bob",
    comment: { id: 42 },
  },
};

test("queue: a task waiting for a slot leaves the queue and waits, its comment and mode kept", async () => {
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven") }, queued: QUEUED });
  const res = await post(w, { action: "queue", number: 5, after: 7 });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "#5 waits for #7.");
  assert.deepEqual(w.unqueued, [["org/app#5", "alice"]]);
  assert.deepEqual(w.accepted, []);
  const wait = w.waits.get("org/app#5");
  assert.deepEqual(wait.blockers, [7]);
  // The comment that queued it waits: its text, author and mode, the 👀 it has (not asked for
  // again: nothing awaited between the queue and the wait).
  assert.deepEqual(
    [wait.item.text, wait.item.author, wait.item.modeLine, wait.item.comment.id],
    ["please", "bob", "brainstorm", 42],
  );
  assert.deepEqual(w.eyes, []);
  assert.deepEqual(w.comments, [
    [
      5,
      "Moved from the dashboard by @alice: no longer queued, now waits for #7 in `brainstorm` mode. It starts when #7 is done (closed as completed, or merged).",
    ],
  ]);
});

test("queue: the comment leaves the queue's writes once its wait is in the store, its queueIds with the wait", async () => {
  // A store holding back its writes until `land()`.
  const memory = openStore("memory:");
  let land;
  const held = new Promise((resolve) => (land = resolve));
  const store = { ...memory, set: async (k, v) => (await held, memory.set(k, v)) };
  const w = setup({
    issues: { 5: open("Five"), 7: open("Seven") },
    queued: QUEUED,
    waits: await storeMap(store, "waits"),
  });
  w.queueIds = ["q-1", "q-2"];
  assert.equal((await post(w, { action: "queue", number: 5, after: 7 })).status, 200);
  let saved = false;
  w.until.then(() => (saved = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The wait not in the store yet: the queue still has the comment.
  assert.equal(saved, false);
  land();
  await w.until;
  const stored = await memory.get("waits/org/app#5");
  assert.deepEqual([stored.blockers, stored.unqueued], [[7], ["q-1", "q-2"]]);
  assert.deepEqual([...w.waits.unqueued()], ["q-1", "q-2"]);
});

test("queue: a task waiting for a slot takes the mode picked; stays queued after a done issue", async () => {
  const w = setup({
    issues: {
      5: open("Five"),
      7: open("Seven"),
      8: { state: "closed", state_reason: "completed" },
    },
    queued: QUEUED,
  });
  const done = await post(w, { action: "queue", number: 5, after: 8 });
  assert.equal(done.status, 200);
  assert.equal(done.body.message, "#8 is done already: #5 stays queued.");
  assert.deepEqual([w.unqueued, w.comments, w.accepted], [[], [], []]);
  assert.equal(
    (await post(w, { action: "queue", number: 5, after: 7, mode: "deploy" })).status,
    422,
  );
  assert.equal((await post(w, { action: "queue", number: 5, after: 5 })).status, 422);
  assert.deepEqual(w.unqueued, []);
  await post(w, { action: "queue", number: 5, after: 7, mode: "work" });
  assert.equal(w.waits.get("org/app#5").item.modeLine, null);
  assert.match(w.comments[0][1], /now waits for #7\. It starts/);
});

test("queue: a queued `/mode` comment alone, work picked, waits as a trigger comment", async () => {
  // "/mode brainstorm" without the trigger line: no trigger (events.mjs splitTrigger()).
  const modeOnly = { ...QUEUED["org/app#5"], trigger: null };
  const w = setup({
    issues: { 5: open("Five"), 7: open("Seven") },
    queued: { "org/app#5": modeOnly },
  });
  assert.equal((await post(w, { action: "queue", number: 5, after: 7, mode: "work" })).status, 200);
  const { item } = w.waits.get("org/app#5");
  // Something to start once #7 is done: work, as the dashboard picked.
  assert.deepEqual([item.trigger, item.modeLine], ["work", null]);
  // No mode picked: its own mode line starts it.
  const kept = setup({
    issues: { 5: open("Five"), 7: open("Seven") },
    queued: { "org/app#5": modeOnly },
  });
  await post(kept, { action: "queue", number: 5, after: 7 });
  const held = kept.waits.get("org/app#5").item;
  assert.deepEqual([held.trigger, held.modeLine], [null, "brainstorm"]);
});

test("queue: refused for a task with a run going, or one started while GitHub is asked", async () => {
  // A run going, or a follow-up behind one: busy, not a queued item.
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven") }, busy: ["org/app#5"] });
  const res = await post(w, { action: "queue", number: 5, after: 7 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "#5 is running or queued: it can't be moved now.");
  // Only `queue` moves a queued one: a start is refused as before.
  const q = setup({ issues: { 5: open("Five"), 7: open("Seven") }, queued: QUEUED });
  assert.equal((await post(q, { action: "start", number: 5 })).status, 409);
  // A slot freed while GitHub says whether #7 is open (requeue()'s check): it runs, nothing
  // to take out, nothing waits.
  q.onCall = (method, path) => {
    if (path.endsWith("/issues/7")) q.started = true;
  };
  const late = await post(q, { action: "queue", number: 5, after: 7 });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "#5 is running or queued: it can't be moved now.");
  // Or while its own issue is read (checked()'s): refused there.
  const early = setup({ issues: { 5: open("Five"), 7: open("Seven") }, queued: QUEUED });
  early.onCall = (method, path) => {
    if (path.endsWith("/issues/5")) early.started = true;
  };
  const before = await post(early, { action: "queue", number: 5, after: 7 });
  assert.equal(before.status, 409);
  assert.equal(before.body.error, "#5 is running or queued: it can't be moved now.");
  for (const x of [w, q, early]) {
    assert.deepEqual(x.unqueued, []);
    assert.equal(x.waits.get("org/app#5"), undefined);
    assert.deepEqual(x.comments, []);
  }
});

test("queue: other authors' comments queued with it are dropped, the App's comment says so", async () => {
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven") }, queued: QUEUED });
  w.dropped = 2;
  assert.equal((await post(w, { action: "queue", number: 5, after: 7 })).status, 200);
  assert.match(
    w.comments[0][1],
    /\(closed as completed, or merged\)\. 2 comments queued by someone else were dropped: only its author's go with it\. Post again to add them\.$/,
  );
});

test("queue: a queued inbox entry or wrap-up is refused as busy, not as replies", async () => {
  const w = setup({
    issues: { 5: open("Five"), 7: open("Seven") },
    queued: { "org/app#5": "other" },
  });
  const res = await post(w, { action: "queue", number: 5, after: 7 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "#5 is running or queued: it can't be moved now.");
  assert.deepEqual([w.unqueued, w.comments], [[], []]);
});

test("queue: a task waiting for a slot with replies only is refused, saying why", async () => {
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven") }, queued: { "org/app#5": null } });
  const res = await post(w, { action: "queue", number: 5, after: 7 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /^#5's queued comments only reply to its last run/);
  assert.deepEqual([w.unqueued, w.comments], [[], []]);
});

test("queue: a newer comment queued while the 👀 is awaited waits instead, its mode named", async () => {
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven") } });
  const newer = { ...QUEUED["org/app#5"], modeLine: null, comment: { id: 43 } };
  // The first comment's 👀 lands once the newer one is queued.
  const first = {
    ...QUEUED["org/app#5"],
    eyes: Promise.resolve().then(() => (w.queued["org/app#5"] = newer)),
  };
  w.queued["org/app#5"] = first;
  assert.equal((await post(w, { action: "queue", number: 5, after: 7 })).status, 200);
  const { item } = w.waits.get("org/app#5");
  assert.equal(item.comment.id, 43);
  assert.match(w.comments[0][1], /now waits for #7\. It starts/);
});

// #10's sub-issues are #11, #12 and #13, and #11 is blocked by #12: the issue's example.
const epic = (extra = {}) => ({
  10: { ...open("Epic"), subs: [11, 12, 13] },
  11: { ...open("Eleven"), blockedBy: [12] },
  12: open("Twelve"),
  13: open("Thirteen"),
  ...extra,
});
const blockersOf = (w, n) => w.waits.get(`org/app#${n}`)?.blockers;

test("plan: the tree starts in order, from its sub-issues and their blockers", async () => {
  const w = setup({ issues: epic() });
  const res = await post(w, { action: "plan", number: 10, mode: "brainstorm" });
  assert.equal(res.status, 200);
  assert.equal(
    res.body.message,
    "#10 laid out: #12 and #13 start; #10 waits for #11, #12 and #13; #11 waits for #12.",
  );
  assert.deepEqual(
    w.accepted.map((i) => [i.number, i.modeLine]),
    [
      [12, "brainstorm"],
      [13, "brainstorm"],
    ],
  );
  assert.deepEqual(blockersOf(w, 10), [11, 12, 13]);
  assert.deepEqual(blockersOf(w, 11), [12]);
  assert.equal(w.waits.get("org/app#11").item.modeLine, "brainstorm");
  assert.deepEqual(w.comments, [
    [
      10,
      "Queued from the dashboard by @alice, after #11, #12 and #13 in `brainstorm` mode. It starts when they are done (closed as completed, or merged).",
    ],
    [
      11,
      "Queued from the dashboard by @alice as part of #10, after #12 in `brainstorm` mode. It starts when it is done (closed as completed, or merged).",
    ],
    [12, "Started from the dashboard by @alice in `brainstorm` mode as part of #10."],
    [13, "Started from the dashboard by @alice in `brainstorm` mode as part of #10."],
  ]);
  // Once #12 is done, #11 starts and #10 still waits.
  await w.waits.closed("org/app", 12, "done");
  assert.equal(blockersOf(w, 11), undefined);
  assert.deepEqual(blockersOf(w, 10), [11, 13]);
  // Their lane is named after the parent.
  for (const n of [10, 11, 12, 13]) assert.equal(w.lanes.get(`org/app#${n}`).plan, 10);
});

test("plan: the issues the policies refuse to start are named in its answer, their comments edited", async () => {
  const w = setup({ issues: epic() });
  w.refusing = "No `work` run: the policies refuse it: `not today`.";
  const res = await post(w, { action: "plan", number: 10 });
  assert.equal(res.status, 200);
  assert.equal(
    res.body.message,
    "#10 laid out: #12 and #13 start; #10 waits for #11, #12 and #13; #11 waits for #12. Refused by the policies, not started: #12 and #13.",
  );
  assert.deepEqual(
    w.edits.map(([, body]) => body),
    [
      "Asked from the dashboard by @alice: not started, the policies refuse it.\n\n<!-- deckhand -->",
      "Asked from the dashboard by @alice: not started, the policies refuse it.\n\n<!-- deckhand -->",
    ],
  );
});

test("plan: nested sub-issues, blockers outside the tree or in another repo, done ones", async () => {
  const other = {
    number: 5,
    state: "open",
    repository_url: "https://api.github.com/repos/org/other",
  };
  const w = setup({
    issues: epic({
      11: { ...open("Eleven"), subs: [14, 15], blockedBy: [12] },
      12: { ...open("Twelve"), blockedBy: [20, 21, other] },
      13: { state: "closed", state_reason: "completed" },
      14: open("Fourteen"),
      15: { ...open("Fifteen"), blockedBy: [14] },
      20: open("Outside"),
      21: { state: "closed", state_reason: "completed" },
    }),
  });
  const res = await post(w, { action: "plan", number: 10 });
  assert.equal(res.status, 200);
  assert.match(
    res.body.message,
    /Done already: #13\. Left out, in another repository: org\/other#5\.$/,
  );
  // Nothing starts: #12 waits for #20, and #14 for #12 since its parent #11 does.
  assert.deepEqual(w.accepted, []);
  assert.deepEqual(blockersOf(w, 10), [11, 12]);
  assert.deepEqual(blockersOf(w, 11), [14, 15]);
  assert.deepEqual(blockersOf(w, 12), [20]);
  assert.deepEqual(blockersOf(w, 14), [12]);
  assert.deepEqual(blockersOf(w, 15), [14]);
  assert.equal(blockersOf(w, 20), undefined);
});

test("plan next to an issue: the tree's first issues wait for it", async () => {
  const w = setup({ issues: epic({ 30: open("Before") }) });
  const res = await post(w, { action: "plan", number: 10, after: 30 });
  assert.equal(res.status, 200);
  assert.deepEqual(w.accepted, []);
  assert.deepEqual(blockersOf(w, 12), [30]);
  assert.deepEqual(blockersOf(w, 13), [30]);
  assert.deepEqual(blockersOf(w, 11), [12]);
  assert.deepEqual(blockersOf(w, 10), [11, 12, 13]);
  // Not after one of its own sub-issues.
  const own = setup({ issues: epic() });
  assert.equal((await post(own, { action: "plan", number: 10, after: 12 })).status, 422);
  assert.deepEqual(own.comments, []);
});

test("plan refused as a whole: a loop, a sub-issue busy or not planned", async () => {
  const cases = [
    [
      { issues: epic({ 12: { ...open("Twelve"), blockedBy: [11] } }) },
      422,
      /#11 waits for #12, #12 waits for #11/,
    ],
    [{ issues: epic(), busy: ["org/app#13"] }, 409, /#13 is running or queued/],
    [
      { issues: epic({ 13: { state: "closed", state_reason: "duplicate" } }) },
      422,
      /#13, a sub-issue of #10, was closed without being done/,
    ],
    [
      { issues: epic({ 13: { state: "closed", state_reason: "not_planned" } }) },
      422,
      /#13, a sub-issue of #10, was closed without being done/,
    ],
  ];
  for (const [opts, status, error] of cases) {
    const w = setup(opts);
    const res = await post(w, { action: "plan", number: 10 });
    assert.equal(res.status, status);
    assert.match(res.body.error, error);
    assert.deepEqual([w.comments, w.accepted, w.waits.list()], [[], [], []]);
  }
  // Through a wait already there: #20 waits for #10's #12, and #12 is blocked by #20.
  const w = setup({
    issues: epic({ 12: { ...open("Twelve"), blockedBy: [20] }, 20: open("Twenty") }),
  });
  await post(w, { action: "queue", number: 20, after: 12 });
  const res = await post(w, { action: "plan", number: 10 });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /#12 waits for #20, #20 waits for #12/);
});

test("plan: a parent blocked by its own sub-issues waits for them, as it would anyway", async () => {
  // #10 is blocked by its sub-issue #11 and by #14, a sub-issue of #11; #11 by #14 too.
  const w = setup({
    issues: epic({
      10: { ...open("Epic"), subs: [11, 12, 13], blockedBy: [11, 14] },
      11: { ...open("Eleven"), subs: [14], blockedBy: [12, 14] },
      14: open("Fourteen"),
    }),
  });
  const res = await post(w, { action: "plan", number: 10 });
  assert.equal(res.status, 200);
  assert.deepEqual(
    w.accepted.map((i) => i.number),
    [12, 13],
  );
  assert.deepEqual(blockersOf(w, 10), [11, 12, 13]);
  assert.deepEqual(blockersOf(w, 11), [14]);
  assert.deepEqual(blockersOf(w, 14), [12]);
});

test("plan: over MAX_TREE open issues, or one of an unknown repo, is refused or left out", async () => {
  const subs = Array.from({ length: MAX_TREE }, (_, i) => 100 + i);
  const issues = { 10: { ...open("Epic"), subs } };
  for (const n of subs) issues[n] = open(`Sub ${n}`);
  const big = setup({ issues });
  const refused = await post(big, { action: "plan", number: 10 });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, new RegExp(`over ${MAX_TREE} open issues`));
  assert.deepEqual(big.comments, []);
  // Without its repository, a sub-issue isn't taken for one of this repo's.
  const w = setup({
    issues: epic({ 10: { ...open("Epic"), subs: [12, { number: 5, state: "open" }] } }),
  });
  const res = await post(w, { action: "plan", number: 10 });
  assert.match(res.body.message, /Left out, in another repository: an unknown repository#5\.$/);
  assert.deepEqual(blockersOf(w, 10), [12]);
});

test("plan: GitHub failing halfway says what is laid out and what isn't", async () => {
  const w = setup({ issues: epic() });
  let posts = 0;
  // The third comment fails: #10 and #11 wait, #12 and #13 don't start.
  w.failComment = () => ++posts === 3;
  const res = await post(w, { action: "plan", number: 10 });
  assert.equal(res.status, 502);
  assert.equal(
    res.body.error,
    "GitHub failed on #12: #10 and #11 laid out, #12 and #13 not. Start or queue those from the backlog.",
  );
  assert.deepEqual(blockersOf(w, 11), [12]);
  assert.deepEqual(w.accepted, []);
  // What is laid out is the parent's lane; the rest isn't.
  assert.equal(w.lanes.get("org/app#11").plan, 10);
  assert.equal(w.lanes.get("org/app#12"), null);
});

test("plan next to an issue done already: it starts, and the reply says so", async () => {
  const w = setup({ issues: epic({ 30: { state: "closed", state_reason: "completed" } }) });
  const res = await post(w, { action: "plan", number: 10, after: 30 });
  assert.match(res.body.message, /#30 is done already: nothing waits for it\.$/);
  assert.deepEqual(
    w.accepted.map((i) => i.number),
    [12, 13],
  );
});

test("plan: the lane's name failing to save is logged, the plan's answer is GitHub's", async () => {
  const w = setup({ issues: epic() });
  w.lanes.planned = () => {
    throw new Error("EACCES: lanes.json");
  };
  const res = await post(w, { action: "plan", number: 10 });
  assert.equal(res.status, 200);
  assert.match(res.body.message, /^#10 laid out/);
  assert.ok(w.logs.includes("Work area: org/app#10: the lane's name: EACCES: lanes.json"));
});

const lane = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/lane", { body, ...opts });

test("lane: the name typed goes on each of its issues, and comes off with an empty one", async () => {
  const w = setup();
  const keys = ["org/app#18", "Org/App#22", "org/app#pr-23"];
  const res = await lane(w, { keys, name: "  Per-repo\n budgets " });
  assert.deepEqual(res, { status: 200, body: { message: "Lane named “Per-repo budgets”." } });
  for (const key of keys) assert.equal(w.lanes.get(key).name, "Per-repo budgets");
  assert.deepEqual(await lane(w, { keys: keys.slice(1), name: "" }), {
    status: 200,
    body: { message: "Lane name taken off." },
  });
  assert.equal(w.lanes.get("org/app#18").name, "Per-repo budgets");
  assert.equal(w.lanes.get("org/app#22"), null);
});

test("lane refused: keys of another repo or a discussion, a long name, users, a broken config", async () => {
  const w = setup();
  const refused = async (body, status, opts) => {
    const res = await lane(w, body, opts);
    assert.equal(res.status, status, JSON.stringify(body));
    return res.body.error;
  };
  assert.match(await refused({ keys: ["org/other#1"], name: "A" }, 400), /issues of org\/app/);
  await refused({ keys: ["org/app#discussion-3"], name: "A" }, 400);
  await refused({ keys: [], name: "A" }, 400);
  await refused({ keys: "org/app#1", name: "A" }, 400);
  assert.match(await refused({ keys: ["org/app#1"], name: "x".repeat(61) }, 400), /60 characters/);
  await refused({ keys: ["org/app#1"] }, 400);
  await refused({ keys: ["org/app#1"], name: "A" }, 403, { user: "mallory" });
  await refused({ keys: ["org/app#1"], name: "A" }, 403, { origin: "https://evil.example" });
  const broken = setup({ errors: ["bad"] });
  assert.equal((await lane(broken, { keys: ["org/app#1"], name: "A" })).status, 409);
  assert.equal(w.lanes.get("org/app#1"), null);
});

const reorder = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/order", { body, ...opts });

test("order: before or after another, first or last; the queued tasks nobody placed keep their places", async () => {
  const w = setup({
    queue: ["org/other#9", "org/app#1", "org/app#2", "org/app#pr-3", "org/app#discussion-4"],
  });
  const keys = () => w.order.keys();
  assert.deepEqual(await reorder(w, { key: "org/app#pr-3", first: true }), {
    status: 200,
    body: { message: "#3 moved first in line." },
  });
  assert.deepEqual(keys(), [
    "org/app#pr-3",
    "org/other#9",
    "org/app#1",
    "org/app#2",
    "org/app#discussion-4",
  ]);
  // Spelled as GitHub has it, the task's own key goes in.
  assert.deepEqual((await reorder(w, { key: "Org/App#1", before: "org/app#pr-3" })).body, {
    message: "#1 moved before #3.",
  });
  assert.equal((await reorder(w, { key: "org/app#1" })).body.message, "#1 moved last in line.");
  assert.deepEqual(keys(), [
    "org/app#pr-3",
    "org/other#9",
    "org/app#2",
    "org/app#discussion-4",
    "org/app#1",
  ]);
  assert.ok(w.logs.some((l) => /alice moves org\/app#1 last in the run order/.test(l)));
});

test("order: down one, right after the next of the repo's, never past another repo's tasks", async () => {
  // org/app holds places 1 and 2, org/other 3 to 5.
  const w = setup({
    queue: ["org/app#1", "org/app#2", "org/other#7", "org/other#8", "org/other#9"],
  });
  assert.deepEqual((await reorder(w, { key: "org/app#1", after: "org/app#2" })).body, {
    message: "#1 moved after #2.",
  });
  assert.deepEqual(w.order.keys(), [
    "org/app#2",
    "org/app#1",
    "org/other#7",
    "org/other#8",
    "org/other#9",
  ]);
});

test("order refused: not queued, a brainstorm, another repo's, users, a broken config", async () => {
  const w = setup({ queue: ["org/app#1", "brainstorm:org/app#2", "org/other#3"] });
  const refused = async (body, status, opts) => {
    const res = await reorder(w, body, opts);
    assert.equal(res.status, status, JSON.stringify(body));
    return res.body.error;
  };
  assert.match(
    await refused({ key: "org/app#5", first: true }, 409),
    /#5 isn't waiting for a slot/,
  );
  assert.match(await refused({ key: "org/app#2", first: true }, 409), /brainstorm/);
  assert.match(await refused({ key: "org/app#1", before: "org/app#6" }, 409), /#6 is no longer/);
  assert.match(await refused({ key: "org/other#3", first: true }, 400), /org\/app's tasks/);
  await refused({ key: "org/app#1", before: "org/other#3" }, 400);
  await refused({ key: "org/app#1", first: "yes" }, 400);
  // Itself, or two places at once: nobody asked for anywhere.
  assert.match(await refused({ key: "org/app#1", before: "Org/App#1" }, 400), /another task/);
  await refused({ key: "org/app#1", after: "org/app#1" }, 400);
  await refused({ key: "org/app#1", after: "org/other#3" }, 400);
  await refused({ key: "org/app#1", before: "org/app#2", after: "org/app#2" }, 400);
  await refused({ key: "org/app#1", first: true, after: "org/app#2" }, 400);
  assert.match(await refused({ key: "org/app#1", after: "org/app#6" }, 409), /#6 is no longer/);
  await refused({ key: 12 }, 400);
  await refused({ key: "org/app#1", first: true }, 403, { user: "mallory" });
  await refused({ key: "org/app#1", first: true }, 403, { origin: "https://evil.example" });
  const broken = setup({ errors: ["bad"], queue: ["org/app#1"] });
  assert.equal((await reorder(broken, { key: "org/app#1", first: true })).status, 409);
  assert.deepEqual(w.order.keys(), []);
});

test("plan without open sub-issues: it starts, or queues", async () => {
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven") } });
  assert.equal((await post(w, { action: "plan", number: 5 })).body.message, "#5 started.");
  const queued = await post(w, { action: "plan", number: 7, after: 5 });
  assert.equal(queued.body.message, "#7 waits for #5.");
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
    cancels: {
      "org/app#5": "running",
      "org/app#pr-8": "queued",
      "org/app#6": "queued",
      "org/app#7": "following",
    },
  });
  const res = await post(w, { action: "cancel", number: 5 });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "#5 stops.");
  // Busy, and its issue isn't even looked up: a run may go on on a closed issue.
  assert.deepEqual(w.cancelled, [["org/app#5", "alice"]]);
  assert.deepEqual(w.comments, [[9, "Stopped from the dashboard by @alice."]]);
  const pr = await post(w, { action: "cancel", number: 8, pr: true });
  assert.equal(pr.status, 200);
  // A pull request's: no backlog to go back to.
  assert.equal(pr.body.message, "#8's queued comments dropped.");
  assert.deepEqual(w.cancelled.at(-1), ["org/app#pr-8", "alice"]);
  assert.deepEqual(w.comments.at(-1), [8, "Queued comments dropped from the dashboard by @alice."]);
  // An issue's with no run: back in the backlog.
  const issue = await post(w, { action: "cancel", number: 6 });
  assert.equal(issue.body.message, "#6 is back in the backlog.");
  assert.deepEqual(w.comments.at(-1), [
    6,
    "Taken out of the queue from the dashboard by @alice: back in the backlog.",
  ]);
  // Behind a run that is ending: its task isn't in the backlog.
  const behind = await post(w, { action: "cancel", number: 7 });
  assert.equal(behind.body.message, "#7's queued comments dropped.");
  assert.deepEqual(w.comments.at(-1), [7, "Queued comments dropped from the dashboard by @alice."]);
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
  // From the dashboard: the policies' input.trigger.
  assert.equal(item.dashboard, true);
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

test("answers sent with a start the policies refuse: kept in the App's edited comment", async () => {
  const w = setup({ issues: { 5: open("Five") }, tasks: { "org/app#5": asking(5, "issue") } });
  w.refusing = "No `work` run: the policies refuse it: `not today`.";
  const res = await answer(w, {
    number: 5,
    answers: [{ options: [0] }, { text: "Home" }],
    then: { action: "start" },
  });
  assert.equal(res.status, 403);
  const [[, posted]] = w.comments;
  const [[, edited]] = w.edits;
  assert.match(
    edited,
    /^Asked from the dashboard by @alice: not started, the policies refuse it\./,
  );
  // What the form said is still there: the answers, as posted.
  const answers = posted.slice(posted.indexOf("\n\n") + 2);
  assert.ok(answers.length > 0);
  assert.ok(edited.includes(answers), `${edited}\n---\n${answers}`);
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

// docs/security.md, Dashboard: a set-aside goes by the needs-input label, which anyone with the
// repo's triage permission can take off, and the gate goes by the board's state, which follows.
test("wait_for_answers and a run's questions set aside: the start no longer held, nor its answers taken", async () => {
  const w = setup({ issues: { 5: open("Five") }, board: ["org/app#5"] });
  const runs = [
    {
      id: "run-5",
      key: "org/app#5",
      repo: "org/app",
      kind: "issue",
      replyTo: 5,
      startedAt: 10,
      finishedAt: 20,
      status: "needs-input",
      questions: { items: QUESTIONS, raw: "1. …" },
    },
  ];
  // The task as board() has it now, the set-asides included.
  const now = () => {
    const tasks = boardOf({
      runs,
      queued: [],
      brainstorms: [],
      inputs: [],
      dismissals: w.dismissals.list(),
    });
    w.tasks["org/app#5"] = tasks.find((t) => t.key === "org/app#5");
    return w.tasks["org/app#5"].state;
  };
  const edited = QUESTIONS.map((q) => ({
    ...q,
    options: q.options.map((o, j) => ({ ...o, checked: j === 0 })),
  }));
  const start = () => post(w, { action: "start", number: 5 });
  assert.equal(now(), "needs-input");
  assert.equal((await start()).status, 409);
  // The label taken off by someone outside ALLOWED_USERS (or the issue closed): set aside.
  assert.equal(w.dismissals.setAsideOn(runs, "org/app#5", "mallory", 30), "org/app#5");
  assert.equal(now(), "done");
  // Its questions can't be answered from the dashboard, nor by ticking the reply's boxes.
  const answered = await answer(w, { number: 5, text: "Yes" });
  assert.equal(answered.status, 409);
  assert.match(answered.body.error, /isn't waiting for answers/);
  assert.match(
    await w.api.ticked("org/app", "alice", { number: 5, pr: false, items: edited }),
    /not the questions waiting for answers/,
  );
  // The label put back: held again.
  assert.equal(w.dismissals.restoreOn(runs, "org/app#5"), "org/app#5");
  assert.equal(now(), "needs-input");
  assert.equal((await start()).status, 409);
  assert.deepEqual([w.comments, w.accepted], [[], []]);
  // Set aside again: a Start goes through, without answers, as a fresh run.
  w.dismissals.setAsideOn(runs, "org/app#5", "mallory", 50);
  assert.equal(now(), "done");
  const started = await start();
  assert.equal(started.status, 200);
  assert.equal(started.body.message, "#5 started.");
  assert.deepEqual([w.accepted[0].trigger, w.accepted[0].text], ["work", ""]);
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

test("plan with open questions: the parent's answered first, a sub-issue's refuse it", async () => {
  const w = setup({ issues: epic(), tasks: { "org/app#10": asking(10, "issue") } });
  assert.equal((await post(w, { action: "plan", number: 10 })).status, 409);
  const res = await answer(w, { number: 10, text: "Yes", then: { action: "plan" } });
  assert.equal(res.status, 200);
  assert.match(res.body.message, /^Answers sent: #10 laid out:/);
  assert.match(w.comments[0][1], /^Queued from the dashboard by @alice, after #11, #12 and #13\./);
  assert.match(w.waits.get("org/app#10").item.text, /^Answers from @alice/);
  const sub = setup({ issues: epic(), tasks: { "org/app#12": asking(12, "issue") } });
  const refused = await post(sub, { action: "plan", number: 10 });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /#12 has open questions/);
  assert.deepEqual(sub.comments, []);
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
    settings: { modes: { audit: {} } },
    ...failed("org/app#5", { taskMode: "audit", status: "interrupted" }),
  });
  const res = await rerun(w, { runId: "run-5" });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "Rerun of #5 queued.");
  assert.deepEqual(w.comments, [
    [5, "Rerun from the dashboard by @alice in `audit` mode: its last run was interrupted."],
  ]);
  const [item] = w.accepted;
  assert.equal(item.id, "5");
  assert.equal(item.kind, "issue");
  assert.equal(item.trigger, "work");
  assert.equal(item.modeLine, "audit");
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
  await refused(failed("org/app#5", { taskMode: "audit" }), { runId: "run-5" }, 422);
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

const dismiss = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/dismiss", { body, ...opts });

test("dismiss: the task's last run, failed, interrupted or cancelled; Undo takes it back", async () => {
  for (const status of ["error", "interrupted", "cancelled"]) {
    // Closed or busy doesn't matter: nothing runs, nothing is posted.
    const w = setup({ issues: { 5: { state: "closed" } }, ...failed("org/app#5", { status }) });
    const res = await dismiss(w, { runId: "run-5" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message, "#5 dismissed.");
    assert.deepEqual(w.dismissals.list(), [
      { key: "org/app#5", runId: "run-5", by: "alice", at: 1000 },
    ]);
    assert.deepEqual([w.comments, w.accepted], [[], []]);
    const undone = await dismiss(w, { runId: "run-5", undo: true }, { user: "bob" });
    assert.equal(undone.status, 200);
    assert.equal(undone.body.message, "#5's dismissal is undone.");
    assert.deepEqual(w.dismissals.list(), []);
    // Twice: nothing to undo.
    assert.equal((await dismiss(w, { runId: "run-5", undo: true })).status, 409);
  }
});

test("dismiss refused: users, a broken config, not the latest, not failed, unknown", async () => {
  const refused = async (opts, body, expected, user = "alice") => {
    const w = setup({ issues: { 5: open("Five") }, ...failed("org/app#5"), ...opts });
    const res = await dismiss(w, body, { user });
    assert.equal(res.status, expected, JSON.stringify(res.body));
    assert.deepEqual(w.dismissals.list(), []);
    return res.body.error;
  };
  assert.match(await refused({}, { runId: "run-5" }, 403, "carol"), /not in ALLOWED_USERS/);
  await refused({ settings: { users: ["bob"] } }, { runId: "run-5" }, 403);
  await refused({ errors: ["bad"] }, { runId: "run-5" }, 409);
  await refused({}, { runId: "run-6" }, 404);
  await refused(failed("org/app#5", { repo: "org/other" }), { runId: "run-5" }, 404);
  await refused({}, { runId: "../x" }, 400);
  await refused({}, "nope", 400);
  const older = failed("org/app#5");
  older.tasks["org/app#5"].runs.unshift({ id: "run-5b", status: "error" });
  assert.match(await refused(older, { runId: "run-5" }, 409), /Only the latest run of #5/);
  for (const status of ["ok", "needs-input", "running"]) {
    assert.match(
      await refused(failed("org/app#5", { status }), { runId: "run-5" }, 409),
      /didn't fail or stop/,
    );
  }
  // Failed, but the needs-input label came since: it asks already.
  const labelled = failed("org/app#5");
  labelled.tasks["org/app#5"].state = "needs-input";
  await refused(labelled, { runId: "run-5" }, 409);
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
  const hook = workItem({ ...testConfig(), ...INBOX }, "issue_comment", {
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
  // The App's marks in the text are taken out: posted as the App, it would pass for its own.
  const marked = `It ${MARKER}hangs <!-- deckhand-from:bob:x -->`;
  assert.equal((await sendInbox(w, { kind: "bug", text: marked })).status, 200);
  assert.deepEqual(w.posted[2], [13, "It hangs\n\nFrom the dashboard by @alice"]);
  assert.equal((await sendInbox(w, { kind: "bug", text: MARKER })).status, 400);
  // Nested: taking one mark out mustn't join the text around it into another.
  const nested = `It <!-- deck${MARKER}hand -->fails <!-<!-- deckhand-from:x -->- deckhand-from:bob:abc -->`;
  assert.equal((await sendInbox(w, { kind: "bug", text: nested })).status, 200);
  assert.deepEqual(w.posted[3], [13, "It fails\n\nFrom the dashboard by @alice"]);
  assert.equal(
    (await sendInbox(w, { kind: "bug", text: `<!-- deck${MARKER}hand -->` })).status,
    400,
  );
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
    // Public as far as GitHub said: the digest quotes nothing only the dashboard showed.
    private: false,
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
  w.private = true;
  await analyze(w, { count: 1, kinds: ["work"], outcomes: ["error"] });
  assert.equal(w.accepted[2].analysis.private, true);
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

// GitHub names repos regardless of case: "Org/app" for a dashboard address in lowercase.
test("a repo spelled otherwise: work starts under GitHub's name, refused while its run goes", async () => {
  const w = setup({ issues: { 5: open("Five"), 6: open("Six") }, busy: ["Org/app#6"] });
  w.fullName = "Org/app";
  const res = await post(w, { action: "start", number: 5 });
  assert.equal(res.status, 200);
  assert.equal(w.accepted[0].repo, "Org/app");
  assert.ok(w.calls.includes("GET /repos/Org/app/issues/5"));
  // The webhook's run on #6 is keyed "Org/app#6": the lowercase address doesn't miss it.
  const busy = await post(w, { action: "start", number: 6 });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /#6 is running or queued/);
  assert.equal(w.accepted.length, 1);
  // GitHub is asked for the name once.
  assert.equal(w.calls.filter((c) => c === "GET /repos/org/app").length, 1);
});

test("a repo spelled otherwise: inbox, answers, reruns and analyses use GitHub's name", async () => {
  const w = setup({
    settings: INBOX,
    issues: { 5: open("Five"), 7: open("Seven"), 12: open("Ideas") },
    history: HISTORY,
    ...failed("Org/app#7"),
  });
  w.tasks["Org/app#5"] = asking(5, "run", QUESTIONS, { key: "Org/app#5" });
  w.fullName = "Org/app";
  const sent = await sendInbox(w, { kind: "idea", text: "Dark mode" });
  assert.equal(sent.body.task, "Org/app#12");
  assert.equal(w.accepted.at(-1).repo, "Org/app");
  const answered = await answer(w, { number: 5, text: "Yes" });
  assert.equal(answered.status, 200);
  assert.equal(w.accepted.at(-1).repo, "Org/app");
  const rerun7 = await rerun(w, { runId: "run-7" });
  assert.equal(rerun7.status, 200);
  assert.equal(w.accepted.at(-1).repo, "Org/app");
  const analysis = await analyze(w, { count: 2, kinds: ["work"], outcomes: ["error"] });
  assert.equal(analysis.body.task, "Org/app#901");
  assert.equal(w.accepted.at(-1).repo, "Org/app");
});

test("ticked in a run's reply: the answers continue its session, once, for its latest questions", async () => {
  const items = [QUESTIONS[0], { ...QUESTIONS[0], text: "Another?" }];
  // The questions with option `picks[i]` of each ticked, as an edit leaves them.
  const tick = (qs, picks) =>
    qs.map((q, i) => ({
      ...q,
      options: q.options.map((o, j) => ({ ...o, checked: !!o.checked || j === picks[i] })),
    }));
  const edited = tick(items, [1, 0]);
  const w = setup({
    issues: { 5: open("Five"), 9: { ...open("Its PR"), pull_request: {} }, 6: open("Six") },
    tasks: {
      "org/app#5": asking(5, "run", items),
      // An issue's run that asked on its pull request #9.
      "org/app#6": asking(6, "run", items, { key: "org/app#6", replyTo: 9 }),
    },
    board: ["org/app#5", "org/app#6"],
  });
  const said = await w.api.ticked("org/app", "alice", {
    number: 5,
    pr: false,
    items: edited,
  });
  assert.equal(said, "Answers sent: #5 continues.");
  assert.equal(
    w.comments[0][1],
    [
      "Answers from @alice, ticked in the run's questions:",
      "",
      "1. **Phones**",
      "   - [x] Top to bottom",
      "2. **Phones**",
      "   - [x] Left to right",
    ].join("\n"),
  );
  const [item] = w.accepted;
  assert.deepEqual(
    [item.id, item.trigger, item.author, item.text, item.dashboard],
    ["5", null, "alice", w.comments[0][1], false],
  );
  // On the pull request the issue's run replied on.
  await w.api.ticked("org/app", "alice", { number: 9, pr: true, items: edited });
  assert.deepEqual([w.accepted[1].id, w.accepted[1].replyTo, w.comments[1][0]], ["6", 9, 9]);
  // Other questions than the task's (an older reply), or a task no longer waiting: nothing.
  const older = [edited[0], { ...edited[1], text: "Before?" }];
  w.tasks["org/app#6"] = asking(6, "run", items);
  assert.match(
    await w.api.ticked("org/app", "alice", { number: 6, pr: false, items: older }),
    /not the questions waiting for answers/,
  );
  // The same questions with other options (asked again, reordered): their indexes differ.
  const reordered = edited.map((q) => ({ ...q, options: [...q.options].reverse() }));
  assert.match(
    await w.api.ticked("org/app", "alice", {
      number: 6,
      pr: false,
      items: reordered,
    }),
    /not the questions waiting for answers/,
  );
  w.tasks["org/app#6"] = asking(6, "issue", items);
  assert.match(
    await w.api.ticked("org/app", "alice", { number: 6, pr: false, items: edited }),
    /not the questions waiting for answers/,
  );
  assert.equal(w.accepted.length, 2);
  // Someone not among the repo's users: refused, as from the dashboard.
  w.tasks["org/app#6"] = asking(6, "run", items);
  await assert.rejects(
    w.api.ticked("org/app", "mallory", { number: 6, pr: false, items: edited }),
    /mallory|allowed|user/i,
  );
});

test("ticked in a run's reply: the boxes it came with are the agent's, only a person's answer", async () => {
  // The run's reply came with its pick ticked in question 1 (`checked`, parsed from its text).
  const own = [
    { ...QUESTIONS[0], options: QUESTIONS[0].options.map((o, j) => ({ ...o, checked: j === 0 })) },
    { ...QUESTIONS[0], text: "Another?" },
  ];
  const w = setup({ issues: { 5: open("Five") }, tasks: { "org/app#5": asking(5, "run", own) } });
  const check = (q, j) => ({
    ...q,
    options: q.options.map((o, k) => ({ ...o, checked: !!o.checked || k === j })),
  });
  // alice ticks question 2 only: question 1's tick is still the agent's.
  const second = [own[0], check(own[1], 1)];
  assert.match(
    await w.api.ticked("org/app", "alice", { number: 5, pr: false, items: second }),
    /not a new box in every question/,
  );
  assert.deepEqual([w.comments, w.accepted], [[], []]);
  // Then the other option of question 1 too: that one is hers.
  const both = [check(own[0], 1), second[1]];
  assert.equal(
    await w.api.ticked("org/app", "alice", { number: 5, pr: false, items: both }),
    "Answers sent: #5 continues.",
  );
  assert.match(
    w.comments[0][1],
    /1\. \*\*Phones\*\*\n {3}- \[x\] Top to bottom\n2\. \*\*Phones\*\*\n {3}- \[x\] Top to bottom/,
  );
});

// The task page's Review and Fix on a pull request whose review loop is over: Deckhand's own
// #8, which closes #5.
const OWN_PR = {
  state: "open",
  title: "Eight",
  body: "Closes #5",
  user: { login: "deckhand[bot]", type: "Bot" },
  head: { sha: "s8", repo: { full_name: "org/app" } },
};
const REVIEWED = `**Verdict: request changes** · Rating: 4/10

### 🟠 High (2)

- \`a.mjs:1\`: a hole.
- \`b.mjs:2\`: another.

f

${MARKER}`;
const LOOP = { review: { on: "ready", fix: true, fixRounds: 3, maxAllowedSeverity: "medium" } };
const reviewSetup = (opts = {}) =>
  setup({
    pulls: { 8: OWN_PR },
    reviews: { 8: [{ user: { login: "deckhand[bot]" }, body: REVIEWED }] },
    settings: LOOP,
    ...opts,
  });
const review = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/review", { body, ...opts });

test("review: the App comments, then a review of the pull request is queued as /mode review", async () => {
  const w = reviewSetup();
  const res = await review(w, { number: 8, action: "review" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.message, "Review of #8 queued.");
  assert.deepEqual(w.comments, [[8, "Review from the dashboard by @alice."]]);
  const [item] = w.accepted;
  // On its issue's task, replying on the pull request; no loop reason: nothing tolerated.
  assert.deepEqual(
    [item.id, item.kind, item.number, item.replyTo, item.modeLine, item.author, item.reason],
    ["5", "issue", 5, 8, "review", "alice", undefined],
  );
  assert.equal(item.comment.id, 501);
  // Someone else's pull request: its own task.
  const theirs = reviewSetup({ pulls: { 8: { ...OWN_PR, user: { login: "bob" }, head: {} } } });
  await review(theirs, { number: 8, action: "review" });
  assert.deepEqual([theirs.accepted[0].id, theirs.accepted[0].kind], ["pr-8", "pr"]);
});

test("review fix: the App's latest review read back, then the review loop's fix run", async () => {
  const w = reviewSetup();
  const res = await review(w, { number: 8, action: "fix" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.message, "Fix round 4 of #8 queued.");
  assert.deepEqual(w.comments, [
    [8, "Fix round 4 from the dashboard by @alice: 2 high findings left."],
  ]);
  const [{ run, posted, user }] = w.asked;
  assert.deepEqual([run.repo, run.number, run.base, user], ["org/app", 8, "main", "alice"]);
  assert.equal(posted.pr.number, 8);
  // Read with the repo's tolerance.
  assert.deepEqual(
    [posted.review.allowed, posted.review.findings.map((f) => f.path)],
    ["medium", ["a.mjs", "b.mjs"]],
  );
  assert.equal(w.accepted[0].comment.id, 501);
});

test("review refused: users, action, closed, busy, no review block, no review.fix, no review, the loop's reason", async () => {
  const refused = async (opts, body, expected, user = "alice") => {
    const w = reviewSetup(opts);
    const res = await review(w, body, { user });
    assert.equal(res.status, expected, JSON.stringify(res.body));
    assert.deepEqual(w.comments, []);
    assert.deepEqual(w.accepted, []);
    return res.body.error;
  };
  const fix = { number: 8, action: "fix" };
  await refused({}, fix, 403, "carol");
  await refused({ settings: { ...LOOP, users: ["bob"] } }, fix, 403);
  await refused({ errors: ["bad"] }, fix, 409);
  await refused({}, { number: 8, action: "merge" }, 400);
  await refused({}, { number: "8", action: "fix" }, 400);
  await refused({ pulls: {} }, fix, 404);
  await refused({ pulls: { 8: { ...OWN_PR, state: "closed" } } }, fix, 409);
  assert.match(await refused({ busy: ["org/app#5"] }, fix, 409), /run going or queued/);
  await refused({ busy: ["org/app#pr-8"] }, { number: 8, action: "review" }, 409);
  assert.match(await refused({ settings: {} }, { number: 8, action: "review" }, 422), /`review`/);
  const off = { review: { ...LOOP.review, fix: false } };
  assert.match(await refused({ settings: off }, fix, 422), /`review\.fix` is off/);
  assert.match(await refused({ reviews: {} }, fix, 409), /no review of Deckhand's/);
  // The review loop's own refusal, as it says it.
  const w = reviewSetup();
  w.noFix = "it waits for the maintainer's input";
  const res = await review(w, fix);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "No fix run on #8: it waits for the maintainer's input.");
  assert.deepEqual(w.comments, []);
});

test("review: a second request while the first is being started posts and queues nothing", async () => {
  for (const action of ["review", "fix"]) {
    const w = reviewSetup();
    // The first request waits in its App comment (`w.replyHold`).
    let go;
    w.replyHold = new Promise((resolve) => (go = resolve));
    const first = review(w, { number: 8, action });
    while (!w.replying) await settled();
    const asked = review(w, { number: 8, action: "review" }, { user: "bob" });
    // Let it run as far as it would before the first is let go.
    await settled();
    go();
    w.replyHold = null;
    const [one, second] = await Promise.all([first, asked]);
    assert.equal(one.status, 200, action);
    assert.equal(second.status, 409, action);
    assert.match(second.body.error, /run going or queued/);
    assert.equal(w.comments.length, 1, action);
    assert.equal(w.accepted.length, 1, action);
    // Once it is queued, busy() refuses as before; refused, the pull request is free again.
    w.noFix = "nothing";
    assert.equal((await review(w, { number: 8, action: "fix" })).status, 409);
    assert.equal((await review(w, { number: 8, action: "review" })).status, 200, action);
  }
});

test("review fix refused once its comment is posted: the comment says no run started", async () => {
  const w = reviewSetup();
  w.lateFix = "#5 has a run going or queued";
  const res = await review(w, { number: 8, action: "fix" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "No fix run on #8: #5 has a run going or queued.");
  assert.deepEqual(w.comments, [
    [8, "Fix round 4 from the dashboard by @alice: 2 high findings left."],
  ]);
  assert.deepEqual(w.edits, [
    [
      501,
      `Fix round 4 from the dashboard by @alice: not started, #5 has a run going or queued.\n\n${MARKER}`,
    ],
  ]);
  assert.deepEqual(w.accepted, []);
  // Failing after it: said too, and the request fails.
  const failing = reviewSetup();
  failing.fixFails = true;
  assert.equal((await review(failing, { number: 8, action: "fix" })).status, 502);
  assert.match(failing.edits[0][1], /: not started, the listener failed\./);
  // Refused before any comment: nothing to edit.
  const early = reviewSetup();
  early.noFix = "it waits for the maintainer's input";
  assert.equal((await review(early, { number: 8, action: "fix" })).status, 409);
  assert.equal(early.edits, undefined);
});

test("review fix refused on a draft, which a review isn't", async () => {
  const draft = reviewSetup({ pulls: { 8: { ...OWN_PR, draft: true } } });
  const res = await review(draft, { number: 8, action: "fix" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "#8 is a draft: mark it ready for review first.");
  assert.deepEqual([draft.comments, draft.asked], [[], []]);
  assert.equal((await review(draft, { number: 8, action: "review" })).status, 200);
});

test("access: a viewer reads the backlog but starts nothing, a member starts, a hidden repo is a 404", async () => {
  const permissions = permissionsOf({
    alice: { "org/app": MEMBER },
    bob: { "org/app": VIEWER },
    carol: { "org/app": ["tasks:read", "runs:start:brainstorm"] },
  });
  const w = setup({
    env: { ALLOWED_USERS: "alice,bob,carol,dave" },
    issues: { 3: open("Fix it") },
    settings: { modes: { brainstorm: {} } },
    permissions,
  });
  const get = (user) => call(w.api, "GET", "/api/repos/org/app/issues", { user });
  assert.equal((await get("bob")).status, 200);
  // Nothing on the repo: hidden, as a repo outside ALLOWED_REPOS.
  const hidden = await get("dave");
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error, "org/app isn't one of this dashboard's repositories.");
  const start = (user, extra = {}) => post(w, { action: "start", number: 3, ...extra }, { user });
  // A viewer's start: refused before anything is posted or queued.
  const refused = await start("bob");
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /`runs:start:work`/);
  assert.deepEqual([w.posted, w.comments, w.accepted], [[], [], []]);
  assert.equal((await post(w, { action: "cancel", number: 3 }, { user: "bob" })).status, 403);
  assert.deepEqual(w.cancelled, []);
  // A brainstorm, but no work.
  assert.equal((await start("carol")).status, 403);
  assert.equal((await start("carol", { mode: "brainstorm" })).status, 200);
  assert.equal(w.accepted.length, 1);
  // The rerun, the lanes and the rest need runs:manage.
  const lane = { keys: ["org/app#3"], name: "Later" };
  const named = (user) => call(w.api, "POST", "/api/repos/org/app/lane", { body: lane, user });
  assert.equal((await named("carol")).status, 403);
  assert.equal((await named("alice")).status, 200);
  // A member starts work.
  assert.equal((await start("alice")).status, 200);
  assert.equal(w.accepted.at(-1).author, "alice");
});

test("access: the inbox and Analyze need their mode's start", async () => {
  const permissions = permissionsOf({
    alice: { "org/app": ["tasks:read", "runs:start:idea"] },
  });
  const issues = { 7: open("Ideas"), 8: open("Bugs") };
  const w = setup({ settings: { inbox: { ideas: 7, bugs: 8 } }, issues, permissions });
  const send = (kind) =>
    call(w.api, "POST", "/api/repos/org/app/inbox", { body: { kind, text: "An idea" } });
  assert.equal((await send("bug")).status, 403);
  // Only the repo's spelling read: nothing posted.
  assert.deepEqual(w.calls, ["GET /repos/org/app"]);
  assert.equal((await send("idea")).status, 200);
  assert.equal(w.accepted.at(-1).trigger, "idea");
  const analyze = await call(w.api, "GET", "/api/repos/org/app/analyze?kinds=work");
  assert.equal(analyze.status, 403);
  assert.match(analyze.body.error, /`runs:start:analyze`/);
});

test("access: Review, Fix and answers that go on in a session need their start, before any comment", async () => {
  // bob may manage runs, but start none.
  const permissions = permissionsOf({
    alice: { "org/app": MEMBER },
    bob: { "org/app": ["tasks:read", "runs:manage"] },
  });
  const w = reviewSetup({ permissions });
  for (const action of ["review", "fix"]) {
    const res = await review(w, { number: 8, action }, { user: "bob" });
    assert.equal(res.status, 403, action);
    assert.match(res.body.error, action === "fix" ? /`runs:start:work`/ : /`runs:start:review`/);
  }
  assert.deepEqual([w.comments, w.asked, w.accepted], [[], [], []]);
  // A run's questions: answering goes on in its session, a start of its mode.
  const asked = setup({
    issues: { 5: open("Five") },
    tasks: { "org/app#5": asking(5, "run") },
    permissions,
  });
  const refused = await answer(asked, { number: 5, text: "Go" }, { user: "bob" });
  assert.equal(refused.status, 403);
  assert.deepEqual([asked.comments, asked.accepted], [[], []]);
  assert.equal((await answer(asked, { number: 5, text: "Go" })).status, 200);
});

test("access: boxes ticked in a run's reply by a viewer post nothing and start nothing", async () => {
  const items = [QUESTIONS[0]];
  const edited = items.map((q) => ({
    ...q,
    options: q.options.map((o, j) => ({ ...o, checked: !!o.checked || j === 0 })),
  }));
  const w = setup({
    issues: { 5: open("Five") },
    tasks: { "org/app#5": asking(5, "run", items) },
    board: ["org/app#5"],
    permissions: permissionsOf({ bob: { "org/app": VIEWER } }),
  });
  const ticked = w.api.ticked("org/app", "bob", { number: 5, pr: false, items: edited });
  await assert.rejects(ticked, { status: 403, message: /`runs:start:work`/ });
  assert.deepEqual([w.comments, w.posted, w.accepted], [[], [], []]);
});

test("access: a rerun, Stop and a plan need their start, refused before anything is posted", async () => {
  // bob may manage runs, but start none.
  const permissions = permissionsOf({
    alice: { "org/app": MEMBER },
    bob: { "org/app": ["tasks:read", "runs:manage"] },
  });
  const nothing = (w) => assert.deepEqual([w.comments, w.posted, w.accepted], [[], [], []]);
  const refused = (res, action) => {
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.error, new RegExp(`\`${action}\``));
  };
  // Rerun: runs:manage is the route's, the failed run's mode the start it needs.
  const again = setup({
    issues: { 5: open("Five") },
    ...failed("org/app#5", { status: "error" }),
    permissions,
  });
  refused(await rerun(again, { runId: "run-5" }, { user: "bob" }), "runs:start:work");
  nothing(again);
  assert.equal((await rerun(again, { runId: "run-5" })).status, 200);
  // Stop: wrapping a brainstorm up.
  const stopping = setup({
    issues: { 5: open("Five") },
    tasks: { "org/app#5": { state: "brainstorm" } },
    permissions,
  });
  refused(await post(stopping, { action: "stop", number: 5 }, { user: "bob" }), "runs:start:stop");
  nothing(stopping);
  assert.equal((await post(stopping, { action: "stop", number: 5 })).status, 200);
  // A plan: every issue of its tree, before any is laid out.
  const planned = setup({ issues: epic(), permissions });
  const res = await post(planned, { action: "plan", number: 10 }, { user: "bob" });
  refused(res, "runs:start:work");
  nothing(planned);
  assert.equal(blockersOf(planned, 10), undefined);
  assert.equal((await post(planned, { action: "plan", number: 10 })).status, 200);
});

test("access: moving a queued task or a wait needs its start, and runs:manage for someone else's comment", async () => {
  // QUEUED's comment is bob's, in brainstorm mode.
  const permissions = permissionsOf({
    alice: { "org/app": MEMBER },
    bob: { "org/app": ["tasks:read", "runs:start:brainstorm"] },
    carol: { "org/app": VIEWER },
    dave: { "org/app": ["tasks:read", "runs:start:brainstorm"] },
  });
  const issues = { 5: open("Five"), 7: open("Seven"), 8: open("Eight") };
  const env = { ALLOWED_USERS: "alice,bob,carol,dave" };
  const w = setup({ env, issues, queued: QUEUED, permissions });
  const move = (user, after = 7) => post(w, { action: "queue", number: 5, after }, { user });
  const untouched = () => {
    assert.deepEqual([w.unqueued, w.comments, w.accepted], [[], [], []]);
    assert.equal(w.waits.get("org/app#5"), undefined);
  };
  let res = await move("carol");
  assert.equal(res.status, 403);
  assert.match(res.body.error, /`runs:start:brainstorm`/);
  untouched();
  // The start, but not bob's comment to move: as dequeueing, runs:manage.
  res = await move("dave");
  assert.equal(res.status, 403);
  assert.match(res.body.error, /`runs:manage`/);
  untouched();
  // Its author, with another author's comment queued too, which the move would drop.
  w.others = true;
  res = await move("bob");
  assert.equal(res.status, 403);
  assert.match(res.body.error, /`runs:manage`/);
  untouched();
  w.others = false;
  // Its author moves it.
  assert.equal((await move("bob")).status, 200);
  assert.deepEqual(w.waits.get("org/app#5").blockers, [7]);
  // A wait moved: its mode's start, before any comment.
  const comments = w.comments.length;
  res = await move("carol", 8);
  assert.equal(res.status, 403);
  assert.deepEqual(w.waits.get("org/app#5").blockers, [7]);
  assert.equal(w.comments.length, comments);
  assert.equal((await move("alice", 8)).status, 200);
  assert.deepEqual(w.waits.get("org/app#5").blockers, [8]);
});

test("access: a comment queued while moving a task is decided is decided in turn, before it moves", async () => {
  // bob may move a brainstorm, not work.
  const inner = permissionsOf({
    bob: { "org/app": ["tasks:read", "runs:start:brainstorm", "runs:manage"] },
  });
  let brainstorms = 0;
  const permissions = {
    ...inner,
    decide: async (login, repo, action) => {
      const said = await inner.decide(login, repo, action);
      // The second decision of bob's comment (after GitHub said #7 is open): carol's work
      // comment is queued meanwhile, the newest.
      if (action === "runs:start:brainstorm" && ++brainstorms === 2) {
        w.queued["org/app#5"] = {
          ...QUEUED["org/app#5"],
          modeLine: null,
          author: "carol",
          comment: { id: 43 },
        };
      }
      return said;
    },
  };
  const w = setup({ issues: { 5: open("Five"), 7: open("Seven") }, queued: QUEUED, permissions });
  const res = await post(w, { action: "queue", number: 5, after: 7 }, { user: "bob" });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /`runs:start:work`/);
  assert.deepEqual([w.unqueued, w.comments], [[], []]);
  assert.equal(w.waits.get("org/app#5"), undefined);
});

// --- The MCP tools' way in (mcp.mjs, #483) -----------------------------------------------

test("MCP: schedule starts, queues, plans, dequeues and cancels as the dashboard does, logged as MCP", async () => {
  const w = setup({
    issues: { ...epic(), 5: open("Five"), 6: open("Six"), 7: open("Seven") },
    cancels: { "org/app#5": "running" },
  });
  const { schedule } = w.api.mcp;
  assert.equal(await schedule("alice", "org/app", { action: "start", number: 5 }), "#5 started.");
  assert.deepEqual(w.comments.at(-1), [5, "Started from the dashboard by @alice."]);
  assert.equal(w.accepted.at(-1).number, 5);
  assert.ok(w.logs.includes("Work area: alice asks start org/app#5 (MCP)"));
  assert.equal(
    await schedule("alice", "org/app", { action: "queue", number: 6, after: 7 }),
    "#6 waits for #7.",
  );
  assert.deepEqual(w.waits.get("org/app#6").blockers, [7]);
  assert.ok(w.logs.includes("Work area: alice asks queue org/app#6 after #7 (MCP)"));
  assert.equal(
    await schedule("alice", "org/app", { action: "dequeue", number: 6 }),
    "#6 no longer waits.",
  );
  assert.equal(w.waits.get("org/app#6"), undefined);
  assert.match(w.comments.at(-1)[1], /^No longer waiting for #7: cancelled from the dashboard/);
  assert.match(
    await schedule("alice", "org/app", { action: "plan", number: 10 }),
    /^#10 laid out: #12 and #13 start/,
  );
  assert.equal(await schedule("alice", "org/app", { action: "cancel", number: 5 }), "#5 stops.");
  assert.deepEqual(w.cancelled, [["org/app#5", "alice"]]);
  assert.deepEqual(w.comments.at(-1), [5, "Stopped from the dashboard by @alice."]);
});

test("MCP: schedule refused as the dashboard's route: hidden repos, actions, its body's checks", async () => {
  const permissions = permissionsOf({
    alice: { "org/app": MEMBER },
    bob: { "org/app": VIEWER },
  });
  const w = setup({
    env: { ALLOWED_REPOS: "org/app" },
    issues: { 5: open("Five") },
    permissions,
  });
  const { schedule } = w.api.mcp;
  const start = { action: "start", number: 5 };
  // Outside ALLOWED_REPOS, or where the login has no action: the same answer.
  await assert.rejects(schedule("alice", "org/other", start), {
    status: 404,
    message: "org/other isn't one of this dashboard's repositories.",
  });
  await assert.rejects(schedule("carol", "org/app", start), {
    status: 404,
    message: "org/app isn't one of this dashboard's repositories.",
  });
  await assert.rejects(schedule("bob", "org/app", start), {
    status: 403,
    message: /`runs:start:work`/,
  });
  await assert.rejects(schedule("bob", "org/app", { action: "cancel", number: 5 }), {
    status: 403,
    message: /`runs:manage`/,
  });
  await assert.rejects(schedule("alice", "org/app", { action: "queue", number: 5 }), {
    status: 400,
  });
  await assert.rejects(schedule("alice", "org/app", { action: "start", number: 404 }), {
    status: 404,
  });
  assert.deepEqual([w.comments, w.accepted], [[], []]);
});

test("MCP: rerun by a run's id alone, refused as the dashboard's; a run the login can't see is none", async () => {
  const permissions = permissionsOf({
    alice: { "org/app": MEMBER },
    bob: { "org/app": VIEWER },
  });
  const w = setup({ issues: { 5: open("Five") }, ...failed("org/app#5"), permissions });
  const { rerun: again } = w.api.mcp;
  const none = (id) => ({ status: 404, message: `No run ${id} among those you see.` });
  await assert.rejects(again("alice", "run-6"), none("run-6"));
  // carol sees nothing of org/app: its run is no run of hers.
  await assert.rejects(again("carol", "run-5"), none("run-5"));
  await assert.rejects(again("bob", "run-5"), { status: 403, message: /`runs:manage`/ });
  // A chat's run is its owner's alone.
  w.runs["run-5"].owner = "bob";
  await assert.rejects(again("alice", "run-5"), none("run-5"));
  delete w.runs["run-5"].owner;
  assert.deepEqual([w.comments, w.accepted], [[], []]);
  assert.equal(await again("alice", "run-5"), "Rerun of #5 queued.");
  assert.deepEqual(w.comments, [[5, "Rerun from the dashboard by @alice: its last run failed."]]);
  assert.ok(w.logs.includes("Work area: alice reruns org/app run-5 (MCP)"));
  // Not rerunnable (it ran again: something is queued now).
  const busy = setup({ issues: { 5: open("Five") }, ...failed("org/app#5"), busy: ["org/app#5"] });
  await assert.rejects(busy.api.mcp.rerun("alice", "run-5"), {
    status: 409,
    message: /running or queued/,
  });
  const done = setup({ issues: { 5: open("Five") }, ...failed("org/app#5", { status: "ok" }) });
  done.tasks["org/app#5"].rerunnable = false;
  await assert.rejects(done.api.mcp.rerun("alice", "run-5"), {
    status: 409,
    message: /doesn't run again/,
  });
});
