// The orchestrator's HTTP (listener/http.mjs), as edge passes requests on to it: a route that
// throws answers 500 and leaves it up, its error logged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttp } from "../listener/http.mjs";
import { VIEWER, permissionsOf, serve } from "./helpers.mjs";

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
    permissions: permissionsOf(rules),
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
});
