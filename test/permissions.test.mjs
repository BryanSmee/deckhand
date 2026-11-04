// Who may do what where (#731): permissions.mjs over the access decision, and the dashboard
// API's envelope (web.mjs apiRoute()) asking it: a hidden repository answers as one outside
// ALLOWED_REPOS, a missing action 403.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anyAction, createPermissions, refusal } from "../listener/permissions.mjs";
import { apiRoute, mustDo } from "../listener/web.mjs";
import { Refused, sendJson } from "../lib/http.mjs";
import { MEMBER, VIEWER, permissionsOf, serve } from "./helpers.mjs";

const answer = (actions, denied = []) => ({ actions, denied, files: {}, error: null });

test("anyAction: an action a pattern gives that no deny takes; an error or nothing, none", () => {
  assert.equal(anyAction(answer(VIEWER)), true);
  assert.equal(anyAction(answer(["*"])), true);
  assert.equal(anyAction(answer(["runs:start:review"])), true);
  // Server-wide actions say nothing of a repository.
  assert.equal(anyAction(answer(["server:read"])), false);
  assert.equal(anyAction(answer([])), false);
  assert.equal(anyAction(null), false);
  assert.equal(anyAction({ ...answer(["*"]), error: "the policies can't be read" }), false);
  // One mode denied: the others are still there.
  assert.equal(anyAction(answer(["runs:start:*"], [{ action: "runs:start:work" }])), true);
  // Every mode denied, or everything.
  assert.equal(anyAction(answer(["runs:start:*"], [{ action: "runs:*" }])), false);
  assert.equal(anyAction(answer(["runs:start:work"], [{ action: "runs:start:work" }])), false);
  assert.equal(anyAction(answer(["*"], [{ action: "*" }])), false);
  assert.equal(anyAction(answer(VIEWER, [{ action: "tasks:read" }])), false);
});

test("permissions: the decision, narrowed by the repo's users; a failure gives nothing", async () => {
  const users = { "org/app": ["alice", "bob"] };
  const permissions = permissionsOf(
    { alice: { "org/app": MEMBER, "": ["server:read"] }, bob: { "org/app": VIEWER } },
    { usersOf: (repo) => users[repo.toLowerCase()] ?? null, failing: ["carol"] },
  );
  assert.equal(await permissions.can("alice", "org/app", "runs:start:work"), true);
  assert.equal(await permissions.can("Alice", "Org/App", "runs:manage"), true);
  assert.equal(await permissions.can("bob", "org/app", "tasks:read"), true);
  assert.equal(await permissions.can("bob", "org/app", "runs:start:work"), false);
  assert.equal(await permissions.visible("bob", "org/app"), true);
  assert.equal(await permissions.visible("bob", "org/other"), false);
  // Server-wide.
  assert.equal(await permissions.can("alice", null, "server:read"), true);
  assert.equal(await permissions.can("alice", null, "server:sync"), false);
  assert.equal(await permissions.can("bob", null, "server:read"), false);
  // The repo's users leave alice out: nothing there, whatever the decision says.
  users["org/app"] = ["bob"];
  assert.equal(await permissions.visible("alice", "org/app"), false);
  assert.equal(await permissions.can("alice", "org/app", "tasks:read"), false);
  // A decision that fails, or no login: nothing.
  assert.equal(await permissions.visible("carol", "org/app"), false);
  assert.equal(await permissions.visible(null, "org/app"), false);
  assert.deepEqual(
    [...(await permissions.which("bob", ["org/app", "Org/App", "org/other", null]))],
    ["org/app"],
  );
  // decide() tells the failure from a refusal, the action null asking for any action.
  assert.deepEqual(await permissions.decide("bob", "org/app", null), { ok: true, error: null });
  assert.deepEqual(await permissions.decide("bob", "org/other", null), { ok: false, error: null });
  const failed = await permissions.decide("carol", "org/else", null);
  assert.deepEqual(failed, { ok: false, error: "the policies can't be read" });
  assert.equal(
    refusal(failed, "carol", null),
    "carol's access can't be decided (the policies can't be read)",
  );
  assert.equal(
    refusal(await permissions.decide("bob", "org/app", "runs:manage"), "bob", "runs:manage"),
    "bob has no runs:manage here",
  );
  // A decision that throws gives nothing either.
  const throwing = createPermissions({ policies: { access: async () => Promise.reject("down") } });
  assert.equal(await throwing.visible("alice", "org/app"), false);
  // Without policies (some tests): every action.
  const open = createPermissions({});
  assert.equal(await open.can("alice", "org/app", "runs:start:work"), true);
  assert.equal(await open.can("alice", null, "server:sync"), true);
});

test("apiRoute: a hidden repo answers as one outside ALLOWED_REPOS, a missing action 403", async (t) => {
  const logs = [];
  const permissions = permissionsOf({
    alice: { "org/app": MEMBER, "": ["server:read"] },
    bob: { "org/app": VIEWER },
  });
  const handle = apiRoute({
    name: "Test",
    route: (pathname) => {
      if (pathname === "/api/server-thing") return { what: "server" };
      const one = /^\/api\/r\/([\w.-]+)\/([\w.-]+)\/(\w+)$/.exec(pathname);
      return one && { repo: `${one[1]}/${one[2]}`, what: one[3] };
    },
    gets: {
      read: (req, res, user, repo) => sendJson(res, { read: repo }),
      start: (req, res, user, repo) => sendJson(res, { started: repo }),
      server: (req, res, user) => sendJson(res, { server: user }),
    },
    posts: { write: (req, res, user, repo) => sendJson(res, { wrote: repo }) },
    allowed: (repo) => repo !== "org/secret",
    permissions,
    action: ({ what }) =>
      ({ read: "tasks:read", start: "runs:start:work", server: "server:read" })[what],
    log: (line) => logs.push(line),
  });
  const { url } = await serve(t, (req, res) => {
    if (!handle(req, res, req.headers["x-user"])) sendJson(res, { error: "not ours" }, 404);
  });
  const ask = async (path, user, init = {}) => {
    const res = await fetch(url + path, { ...init, headers: { "x-user": user, ...init.headers } });
    return [res.status, await res.json()];
  };
  assert.deepEqual(await ask("/api/r/org/app/read", "bob"), [200, { read: "org/app" }]);
  assert.deepEqual(await ask("/api/r/org/app/start", "alice"), [200, { started: "org/app" }]);
  // A viewer: the route's action is missing.
  assert.deepEqual(await ask("/api/r/org/app/start", "bob"), [
    403,
    { error: "You can't do this on org/app: it needs the `runs:start:work` action." },
  ]);
  assert.match(logs.join("\n"), /Test: org\/app: refused: bob has no runs:start:work here/);
  // Nothing on org/other: the same answer as org/secret, outside ALLOWED_REPOS.
  const hidden = await ask("/api/r/org/other/read", "bob");
  const outside = await ask("/api/r/org/secret/read", "bob");
  assert.equal(hidden[0], 404);
  assert.deepEqual(
    hidden[1].error.replace("org/other", "X"),
    outside[1].error.replace("org/secret", "X"),
  );
  // A POST from another site: refused before either is looked at, the same for both.
  for (const repo of ["org/other", "org/secret"]) {
    const post = await ask(`/api/r/${repo}/write`, "bob", { method: "POST" });
    assert.deepEqual(post, [403, { error: "Not from this dashboard." }], repo);
  }
  const asked = permissions.asked.length;
  await ask("/api/r/org/app/write", "bob", { method: "POST" });
  assert.equal(permissions.asked.length, asked);
  // A route without a repo: server-wide.
  assert.deepEqual(await ask("/api/server-thing", "alice"), [200, { server: "alice" }]);
  assert.equal((await ask("/api/server-thing", "bob"))[0], 403);
});

test("apiRoute and mustDo: a decision that fails hides the repo, or answers 503, the log saying so", async (t) => {
  const logs = [];
  const failing = ["carol"];
  const permissions = permissionsOf(
    { carol: { "org/app": MEMBER, "": ["server:read"] } },
    { failing },
  );
  const handle = apiRoute({
    name: "Test",
    route: (pathname) => {
      if (pathname === "/api/server-thing") return { what: "server" };
      const one = /^\/api\/r\/([\w.-]+)\/([\w.-]+)\/(\w+)$/.exec(pathname);
      return one && { repo: `${one[1]}/${one[2]}`, what: one[3] };
    },
    gets: {
      read: (req, res, user, repo) => sendJson(res, { read: repo }),
      server: (req, res, user) => sendJson(res, { server: user }),
    },
    allowed: (repo) => repo !== "org/secret",
    permissions,
    action: ({ what }) => ({ read: "tasks:read", server: "server:read" })[what],
    log: (line) => logs.push(line),
  });
  const { url } = await serve(t, (req, res) => {
    if (!handle(req, res, req.headers["x-user"])) sendJson(res, { error: "not ours" }, 404);
  });
  const ask = async (path) => {
    const res = await fetch(url + path, { headers: { "x-user": "carol" } });
    return [res.status, await res.json()];
  };
  // Whether carol sees org/app isn't known: hidden, as api/state hides it, answered as a repo
  // outside ALLOWED_REPOS; only the log tells the failure from a refusal.
  const hidden = await ask("/api/r/org/app/read");
  const outside = await ask("/api/r/org/secret/read");
  assert.equal(hidden[0], 404);
  assert.equal(
    hidden[1].error.replace("org/app", "X"),
    outside[1].error.replace("org/secret", "X"),
  );
  assert.match(
    logs.join("\n"),
    /Test: org\/app: hidden: carol's access can't be decided \(the policies can't be read\)/,
  );
  // A route without a repo hides nothing: a 503 that says so.
  const server = await ask("/api/server-thing");
  assert.equal(server[0], 503);
  assert.match(server[1].error, /\(`server:read`\) can't be decided now; try again later/);
  assert.match(logs.join("\n"), /Test: \/api\/server-thing: refused: carol's server:read can't/);
  // A handler's own check: the same 503, a refusal's 403.
  const refusedWith = (promise) =>
    promise.then(
      () => null,
      (error) => (assert.ok(error instanceof Refused), error.status),
    );
  assert.equal(await refusedWith(mustDo(permissions, "carol", "org/app", "runs:manage")), 503);
  failing.length = 0;
  assert.equal(await refusedWith(mustDo(permissions, "carol", "org/app", "runs:manage")), null);
  assert.equal(await refusedWith(mustDo(permissions, "dave", "org/app", "runs:manage")), 403);
});
