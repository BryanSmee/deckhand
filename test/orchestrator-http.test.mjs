// The orchestrator's HTTP (listener/http.mjs), as edge passes requests on to it: a route that
// throws answers 500 and leaves it up, its error logged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttp } from "../listener/http.mjs";
import { createStatus } from "../listener/status.mjs";
import { MEMBER, VIEWER, permissionsOf, serve } from "./helpers.mjs";

test("an unexpected throw answers 500, and the orchestrator keeps serving", async (t) => {
  const logged = [];
  const ctx = {
    config: { port: 0 },
    log: (line) => logged.push(line),
    skip: () => {},
    tasks: new Map(),
  };
  const http = createHttp(ctx);
  // /status a local caller's, as edge passes it on (../edge/forward.mjs). This orchestrator has
  // no status: it throws.
  const { url } = await serve(t, (req, res) => http.handle(req, res, { local: true }));
  assert.equal((await fetch(`${url}/status`)).status, 500);
  assert.ok(logged.some((line) => line.startsWith("GET /status: TypeError")));
  // The next request still gets its answer.
  assert.equal((await fetch(`${url}/status`)).status, 500);
});

test("access (#731): api/state, /status and the server's views follow the login's actions", async (t) => {
  const run = (key, extra = {}) => ({
    id: `${key.replace(/[/#]/g, "-")}-1`,
    key,
    repo: key.split("#")[0],
    kind: "issue",
    replyTo: Number(key.split("#")[1]),
    mode: "work",
    startedAt: 1,
    status: "running",
    ...extra,
  });
  const runs = [run("org/app#1"), run("org/hidden#2")];
  const rules = {
    alice: { "org/app": VIEWER, "org/hidden": VIEWER, "": ["server:read"] },
    bob: { "org/app": VIEWER },
    carol: { "org/app": [...VIEWER, "logs:read"] },
  };
  // org/app#1's lane is named after its parent, in org/hidden.
  const lanes = new Map([
    ["org/app#1", { key: "org/app#1", parent: { key: "org/hidden#9", title: "Secret plan" } }],
  ]);
  const titled = [];
  const ctx = {
    config: { maxParallel: 2 },
    log: () => {},
    skip: () => {},
    tasks: new Map(),
    app: {},
    runs,
    runsById: new Map(runs.map((r) => [r.id, r])),
    running: 2,
    brainstorms: { list: () => [] },
    // Each running task waits for another issue of its repo.
    waits: {
      list: () => [
        { key: "org/app#1", repo: "org/app", blockers: [5] },
        { key: "org/hidden#2", repo: "org/hidden", blockers: [6] },
      ],
    },
    inputs: { list: () => [] },
    inboxes: () => [
      ["org/app", { ideas: 3 }],
      ["org/hidden", { ideas: 4 }],
    ],
    titles: { get: () => null, closed: () => null, fill: (keys) => titled.push(...keys) },
    pulls: { get: () => null, fill: () => {} },
    lanes: {
      fill: () => {},
      parentKeys: (keys) => keys.flatMap((k) => (lanes.get(k) ? [lanes.get(k).parent.key] : [])),
      labels: (keys) =>
        Object.fromEntries(
          keys
            .filter((k) => lanes.get(k))
            .map((k) => [k, { name: lanes.get(k).parent.title, source: "parent" }]),
        ),
    },
    models: { plans: () => [{ name: "claude", used: 1 }] },
    serverSetup: () => ({ grants: "all of them" }),
    status: (shows = () => true) => ({
      reasons: runs.filter((r) => shows(r.repo)).map((r) => r.key),
    }),
    // dave's decisions fail.
    permissions: permissionsOf(rules, { failing: ["dave"] }),
    // An empty log, its run going on: the stream stays open until access ends it.
    runLogs: { read: async () => ({ data: Buffer.alloc(0) }) },
  };
  const http = createHttp(ctx);
  const { url } = await serve(t, (req, res) =>
    http.handle(req, res, { user: req.headers["x-user"] ?? null }),
  );
  const get = async (path, user) => {
    const res = await fetch(url + path, { headers: { "x-user": user } });
    return [res.status, await res.json()];
  };
  const [, all] = await get("/api/state", "alice");
  assert.deepEqual(all.tasks.map((task) => task.key).sort(), ["org/app#1", "org/hidden#2"]);
  assert.equal(all.lanes["org/app#1"].name, "Secret plan");
  assert.equal(all.plans.length, 1);
  const [, mine] = await get("/api/state", "bob");
  assert.deepEqual(
    mine.tasks.map((task) => task.key),
    ["org/app#1"],
  );
  assert.deepEqual(Object.keys(mine.inboxes), ["org/app"]);
  // org/hidden's wait and its blocker aren't his either: neither listed, nor their titles read.
  assert.deepEqual(mine.edges, [{ from: "org/app#5", to: "org/app#1", kind: "after" }]);
  assert.deepEqual(
    mine.blockers.map((b) => b.key),
    ["org/app#5"],
  );
  assert.deepEqual(
    all.blockers.map((b) => b.key),
    ["org/app#5", "org/hidden#6"],
  );
  // The parent's title isn't bob's to see, nor read for him.
  assert.deepEqual(mine.lanes["org/app#1"], { name: "a hidden issue", source: "parent" });
  titled.length = 0;
  await get("/api/state", "bob");
  assert.ok(!titled.some((key) => key.startsWith("org/hidden")));
  // Totals stay, plans are server-wide.
  assert.equal(mine.running, 2);
  assert.equal(mine.plans, undefined);
  assert.deepEqual((await get("/api/server", "bob"))[0], 403);
  assert.deepEqual(await get("/api/server", "alice"), [200, { grants: "all of them" }]);
  // A decision that fails: said, not a refusal.
  const [status, body] = await get("/api/server", "dave");
  assert.equal(status, 503);
  assert.match(body.error, /\(`server:read`\) can't be decided now/);
  // /status and the log streams.
  assert.deepEqual((await get("/status", "bob"))[1].reasons, ["org/app#1"]);
  const stream = await fetch(`${url}/api/runs/org-hidden-2-1/stream`, {
    headers: { "x-user": "bob" },
  });
  assert.equal(stream.status, 404);
  // A viewer has no logs:read: not even the repo it sees.
  const own = await fetch(`${url}/api/runs/org-app-1-1/stream`, { headers: { "x-user": "bob" } });
  assert.equal(own.status, 404);
  // carol reads the logs, until her logs:read is taken away: her open stream ends then.
  const open = await fetch(`${url}/api/runs/org-app-1-1/stream`, {
    headers: { "x-user": "carol" },
  });
  assert.equal(open.status, 200);
  rules.carol = { "org/app": VIEWER };
  assert.equal(await open.text(), "");
  // Unknown to the decision: an empty dashboard.
  const [, nobody] = await get("/api/state", "dave");
  assert.deepEqual([nobody.tasks, nobody.inboxes], [[], {}]);
  assert.deepEqual(nobody.access, { server: [], repos: {} });
  // What each may do (#732): the repos they see, none of the others.
  assert.deepEqual(all.access, {
    server: ["server:read"],
    repos: {
      "org/app": { actions: ["tasks:read"], starts: [], startsDenied: [] },
      "org/hidden": { actions: ["tasks:read"], starts: [], startsDenied: [] },
    },
  });
  assert.deepEqual(Object.keys(mine.access.repos), ["org/app"]);
});

test("access (#732): api/state's actions name the boards' repos; Settings › Access for server:read", async (t) => {
  const rules = {
    alice: { "org/app": MEMBER, "org/board": VIEWER, "org/new": ["*"], "": ["server:read"] },
    bob: { "org/app": VIEWER },
  };
  let listing = async () => ["org/board", "org/app"];
  const ctx = {
    config: { maxParallel: 1, users: ["bob", "alice"] },
    log: () => {},
    skip: () => {},
    tasks: new Map(),
    app: {},
    runs: [],
    runsById: new Map(),
    running: 0,
    brainstorms: { list: () => [] },
    waits: { list: () => [] },
    inputs: { list: () => [] },
    titles: { get: () => null, closed: () => null, fill: () => {} },
    pulls: { get: () => null, fill: () => {} },
    // org/board's config was read (its board), and org/new, listed, has none (not onboarded):
    // nothing of either is in the state.
    repoList: { listed: () => ["org/board", "org/new"], names: () => listing() },
    usersOf: () => null,
    permissions: permissionsOf(rules),
  };
  const http = createHttp(ctx);
  const { url } = await serve(t, (req, res) =>
    http.handle(req, res, { user: req.headers["x-user"] ?? null }),
  );
  const get = async (path, user) => {
    const res = await fetch(url + path, { headers: { "x-user": user } });
    return [res.status, await res.json()];
  };
  const [, state] = await get("/api/state", "alice");
  assert.deepEqual(state.access.repos, {
    "org/board": { actions: ["tasks:read"], starts: [], startsDenied: [] },
    // Its Onboard and Config are offered.
    "org/new": {
      actions: ["tasks:read", "logs:read", "runs:manage", "repo:config:read"],
      starts: ["*"],
      startsDenied: [],
    },
  });
  assert.deepEqual(state.access.server, ["server:read"]);
  // Settings › Access: server:read only.
  assert.equal((await get("/api/access", "bob"))[0], 403);
  const [status, report] = await get("/api/access", "alice");
  assert.equal(status, 200);
  assert.deepEqual(report.repos, ["org/app", "org/board"]);
  assert.equal(report.error, null);
  assert.deepEqual(
    report.users.map((u) => u.login),
    ["alice", "bob"],
  );
  const [alice, bob] = report.users;
  assert.deepEqual(alice.server.actions, [{ action: "server:read", files: [] }]);
  assert.deepEqual(
    alice.repos.map((r) => [r.repo, r.actions.map((a) => a.action)]),
    [
      ["org/app", MEMBER],
      ["org/board", VIEWER],
    ],
  );
  assert.deepEqual(bob.repos[1].actions, []);
  // A listing that fails says so; the server-wide actions are still there.
  listing = async () => {
    throw new Error("GitHub is down");
  };
  const [, down] = await get("/api/access", "alice");
  assert.match(down.error, /GitHub is down/);
  assert.deepEqual(down.repos, []);
  assert.equal(down.users[0].server.actions.length, 1);
});

// An orchestrator's ctx with one finished run of org/repo#pr-3, for the access tests below:
// `extra` adds to it (its permissions, usersOf, health, sync…).
function oneRun(extra = {}) {
  const run = {
    id: "org-repo-pr-3-1000",
    key: "org/repo#pr-3",
    repo: "org/repo",
    kind: "pr",
    mode: "work",
    startedAt: 1000,
    status: "ok",
  };
  return {
    config: { maxParallel: 3, users: ["alice", "bob", "dave"] },
    log: () => {},
    skip: () => {},
    tasks: new Map(),
    app: {},
    runs: [run],
    runsById: new Map([[run.id, run]]),
    running: 0,
    brainstorms: { list: () => [] },
    waits: { list: () => [] },
    inputs: { list: () => [] },
    inboxes: () => [["org/repo", { ideas: 1 }]],
    titles: { get: () => null, closed: () => null, fill: () => {} },
    pulls: { get: () => null, fill: () => {} },
    runLogs: { read: async () => ({ data: Buffer.alloc(0) }) },
    ...extra,
  };
}

// `ctx`'s HTTP as edge passes it on: the user in x-user, a local caller with x-local.
async function serveHttp(t, ctx) {
  const http = createHttp(ctx);
  const { url } = await serve(t, (req, res) =>
    http.handle(req, res, {
      user: req.headers["x-user"] ?? null,
      local: req.headers["x-local"] === "1",
    }),
  );
  return url;
}

test("access: the repo's users, once read, leave a login out of api/state and the log streams", async (t) => {
  // Not read yet: ALLOWED_USERS (and the decision) alone.
  let users = null;
  const ctx = oneRun({
    permissions: permissionsOf({ alice: { "org/repo": ["*"] } }, { usersOf: () => users }),
  });
  const url = await serveHttp(t, ctx);
  const get = (path) => fetch(url + path, { headers: { "x-user": "alice" } });
  const keys = async () => (await (await get("/api/state")).json()).tasks.map((task) => task.key);
  assert.deepEqual(await keys(), ["org/repo#pr-3"]);
  const open = await get("/api/runs/org-repo-pr-3-1000/stream");
  assert.equal(open.status, 200);
  await open.text();
  // The repo's config read: its users leave alice out, whatever the decision says.
  users = ["bob"];
  assert.deepEqual(await keys(), []);
  assert.equal((await get("/api/runs/org-repo-pr-3-1000/stream")).status, 404);
});

test("access (#783): api/state asks about the repos as last listed, a log stream reads its own", async (t) => {
  const info = { full_name: "org/repo", private: true, default_branch: "main" };
  const permissions = permissionsOf(
    { alice: { "org/repo": ["*"] } },
    { infoOf: (repo) => (repo.toLowerCase() === "org/repo" ? info : null) },
  );
  const ctx = oneRun({ permissions });
  ctx.status = (shows) => ({ shown: shows("org/repo") });
  const url = await serveHttp(t, ctx);
  const get = (path) => fetch(url + path, { headers: { "x-user": "alice" } });
  const state = await (await get("/api/state")).json();
  assert.deepEqual(
    state.tasks.map((task) => task.key),
    ["org/repo#pr-3"],
  );
  assert.ok(permissions.asked.length);
  assert.ok(permissions.asked.every(([, repo]) => repo === info || repo === null));
  // /status too: what it shows of the repos.
  permissions.asked.length = 0;
  assert.deepEqual(await (await get("/status")).json(), { shown: true });
  assert.ok(permissions.asked.length);
  assert.ok(permissions.asked.every(([, repo]) => repo === info));
  // The stream guards the logs on its own: asked by name, read as a single decision is.
  permissions.asked.length = 0;
  const open = await get("/api/runs/org-repo-pr-3-1000/stream");
  assert.equal(open.status, 200);
  await open.text();
  assert.ok(permissions.asked.length);
  assert.ok(permissions.asked.every(([, repo]) => repo === "org/repo"));
});

test("access (#731): a login with no action: its totals only, 403 server-wide, no Sync, /status filtered", async (t) => {
  const synced = [];
  const checked = [];
  const ctx = oneRun({
    permissions: permissionsOf({ bob: { "org/repo": ["*"], "": ["*"] } }),
    health: { check: async () => (checked.push(1), { services: [] }) },
    sync: async (user) => (synced.push(user), { ok: true }),
    publicUrl: () => "https://hooks.example.com",
    server: { version: "dev", startedAt: 500 },
  });
  ctx.runs[0].status = "running";
  ctx.running = 1;
  ctx.status = createStatus(ctx).status;
  const url = await serveHttp(t, ctx);
  const get = (path, headers = {}, init = {}) => fetch(url + path, { ...init, headers });
  const dave = { "x-user": "dave" };
  const seen = await (await get("/api/state", dave)).json();
  assert.deepEqual([seen.tasks, seen.inboxes], [[], {}]);
  // Totals stay: numbers without names.
  assert.deepEqual([seen.maxParallel, seen.running], [3, 1]);
  // Queued too, of every repo like running (#786): org/repo's waiting issue counted, not listed.
  ctx.tasks.set("org/repo#12", {
    ...{ repo: "org/repo", id: 12, kind: "issue", running: false },
    pending: [{ mode: "work", replyTo: 99, text: "Also the docs." }],
  });
  const later = await (await get("/api/state", dave)).json();
  assert.deepEqual([later.tasks, later.queued], [[], 1]);
  const bobs = await (await get("/api/state", { "x-user": "bob" })).json();
  assert.deepEqual([bobs.tasks.some((x) => x.key === "org/repo#12"), bobs.queued], [true, 1]);
  ctx.tasks.clear();
  assert.equal((await get("/api/runs/org-repo-pr-3-1000/stream", dave)).status, 404);
  for (const path of ["/api/server", "/api/health"]) {
    assert.equal((await get(path, dave)).status, 403, path);
  }
  assert.deepEqual(checked, []);
  // Sync is server:sync, from this dashboard's page: refused, nothing asked of GitHub.
  const origin = { origin: "https://hooks.example.com" };
  const sync = await get("/api/sync", { ...dave, ...origin }, { method: "POST" });
  assert.equal(sync.status, 403);
  assert.match((await sync.json()).error, /`server:sync`/);
  assert.deepEqual(synced, []);
  const bobSync = await get("/api/sync", { "x-user": "bob", ...origin }, { method: "POST" });
  assert.equal(bobSync.status, 200);
  assert.deepEqual(synced, ["bob"]);
  // /status: dave's lists none of org/repo, though the listener is busy; bob's and a local
  // caller's list its run; nobody's, neither signed in nor local, is refused.
  const status = async (headers) => (await get("/status", headers)).json();
  const mine = await status(dave);
  assert.deepEqual([mine.idle, mine.reasons, mine.queued], [false, [], 0]);
  assert.match((await status({ "x-user": "bob" })).reasons.join("\n"), /run org\/repo#pr-3 since/);
  const all = await status({ "x-local": "1" });
  assert.match(all.reasons.join("\n"), /run org\/repo#pr-3 since/);
  assert.equal(all.startedAt, 500);
  assert.equal((await get("/status")).status, 401);
});

test("api/state: a task's pull request in its fix loop has its review from the store, its place in the queue", async (t) => {
  // #12's fix run is over; its pull request #13 waits for checks (the store's pulls and
  // reviews); a maintainer's comment on #12 is queued, the first in the run order.
  const ctx = oneRun({
    permissions: permissionsOf({ alice: { "org/repo": ["*"] } }),
    pulls: {
      get: (key) => (key === "org/repo#12" ? { number: 13, state: "ready", readyAt: 1 } : null),
      fill: () => {},
    },
    reviews: {
      entry: (repo, number) =>
        repo === "org/repo" && number === 13
          ? {
              head: "sha-1",
              at: 2000,
              fixes: 1,
              reviewedFixes: 1,
              fixRounds: 3,
              rounds: [{ round: 0, at: 2000, head: "sha-0", blocking: 1 }],
              waiting: { sha: "sha-1", since: 2000 },
            }
          : null,
    },
    queueOrder: () => [ctx.tasks.get("org/repo#12")],
    deliverable: () => 0,
  });
  ctx.runs.push({
    id: "org-repo-12-1000",
    key: "org/repo#12",
    repo: "org/repo",
    kind: "issue",
    mode: "start",
    taskMode: "work",
    reason: "review-fix",
    startedAt: 1000,
    status: "ok",
  });
  ctx.tasks.set("org/repo#12", {
    repo: "org/repo",
    id: 12,
    kind: "issue",
    running: false,
    pending: [{ mode: "work", replyTo: 99, text: "Also the docs." }],
  });
  const url = await serveHttp(t, ctx);
  const state = await (await fetch(`${url}/api/state`, { headers: { "x-user": "alice" } })).json();
  const task = state.tasks.find((x) => x.key === "org/repo#12");
  assert.deepEqual(
    [task.state, task.review?.loop, task.review?.rounds, task.position],
    ["queued", "checks", 3, 1],
  );
});
