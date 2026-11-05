// chats.mjs (#476): a user's chats from the dashboard, with an injected runner, clock and run
// machinery (runs.mjs and tasks.mjs, whose part runs.test.mjs and orchestrator-server.test.mjs
// cover), and the dashboard's real checks (repo-check.mjs) over a fake GitHub.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chatKey, createChats } from "../listener/chats.mjs";
import { DEFAULT_PROFILE } from "../listener/profiles.mjs";
import { createRepoCheck } from "../listener/repo-check.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { summaryKey } from "../listener/runlog.mjs";
import { openStore } from "../lib/store.mjs";
import { capabilityPolicies, serve, tempDir, testConfig } from "./helpers.mjs";

// A clock and timers the test moves (`advance(ms)`).
function fakeClock(start = 1_000_000) {
  const clock = { at: start, timers: new Set() };
  clock.now = () => clock.at;
  clock.setTimer = (fn, ms) => {
    const timer = { fn, at: clock.at + ms };
    clock.timers.add(timer);
    return timer;
  };
  clock.clearTimer = (timer) => clock.timers.delete(timer);
  clock.advance = (ms) => {
    clock.at += ms;
    for (const timer of [...clock.timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > clock.at || !clock.timers.has(timer)) continue;
      clock.timers.delete(timer);
      timer.fn();
    }
  };
  return clock;
}

// The chats of a fake orchestrator: `yaml`, org/repo's .deckhand.yaml (none: no file); `env`, the
// operator's settings over ALLOWED_USERS alice and bob; `installed`: whether the App reads
// org/repo. What the run machinery was asked is in `calls`.
async function setup(
  t,
  {
    yaml = null,
    env = {},
    installed = true,
    users,
    store = openStore("memory:"),
    permissions = null,
    // What decides a chat's capabilities (helpers.mjs capabilityPolicies()), for its profile.
    policies = null,
    // A promise GitHub's answers wait for, while set (`hold.until`).
    hold = {},
  } = {},
) {
  const config = testConfig({
    ALLOWED_USERS: "alice,bob",
    CHATS_PER_USER: "2",
    CHAT_IDLE_MINUTES: "30",
    ...env,
  });
  const clock = fakeClock();
  const calls = {
    started: [],
    delivered: [],
    rested: [],
    cancelled: [],
    removed: [],
    logs: [],
    shots: [],
  };
  const lines = [];
  const ctx = {
    config,
    log: (line) => lines.push(line),
    tasks: new Map(),
    runs: [],
    runsById: new Map(),
    store,
    stopping: false,
    saveQueue: async () => true,
    publicUrl: () => "https://deck.example",
    usersOf: () => users ?? null,
    startLater: (task) => calls.started.push(task.pending.map((i) => i.text)),
    deliverable: (task) => (task.live?.open ? task.pending.length : 0),
    deliverLater: (task) => calls.delivered.push(task.pending.splice(0).map((i) => i.text)),
    // runs.mjs cancel(): a run stops (its end comes with the next tick), queued messages go.
    cancel: (key, by) => {
      const task = ctx.tasks.get(key);
      calls.cancelled.push([key, by]);
      if (task?.running) {
        setImmediate(() => Object.assign(task, { running: false, live: null }));
        return "running";
      }
      if (!task?.pending.length) return null;
      task.pending.splice(0);
      return "queued";
    },
    rest: (task) => (calls.rested.push(task.name), true),
    runner: {
      removeSessions: async (name, key) => {
        calls.removed.push([name, key]);
        return [`${name}-light-trusted-workspace`];
      },
    },
    runLogs: { remove: async (id) => calls.logs.push(id) },
    removeShots: async (folder) => calls.shots.push(folder),
    permissions,
    policies,
  };
  const github = async (_repo, _method, path) => {
    await hold.until;
    if (path === "/repos/org/repo" && installed) {
      return Response.json({ full_name: "org/repo", default_branch: "trunk", private: true });
    }
    return new Response("{}", { status: 404 });
  };
  const repoSettings = async () =>
    yaml === null
      ? { settings: parseRepoConfig("", config).settings, errors: [] }
      : parseRepoConfig(yaml, config);
  const checks = createRepoCheck({ config, github, repoSettings });
  const chats = createChats(ctx, {
    checks,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    every: () => null,
    stopEvery: () => {},
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  ctx.chats = chats;
  await chats.load();
  return { chats, ctx, calls, clock, config, lines, store };
}

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { status: error.status, message: error.message };
  }
  assert.fail("not refused");
};

test("a chat: created on a repository, its first message starts its sandbox, the next go to it", async (t) => {
  const { chats, ctx, calls, store } = await setup(t);
  const chat = await chats.create("Alice", { repo: "org/repo", message: "What does run() do?" });
  assert.match(chat.id, /^[0-9a-f]{16}$/);
  assert.equal(chat.owner, "alice");
  assert.equal(chat.base, "trunk");
  assert.equal(chat.title, "What does run() do?");
  // Its task: the chat's own, a sandbox name of its own (the runner checks it).
  const task = ctx.tasks.get(`org/repo#chat-${chat.id}`);
  assert.equal(task.kind, "chat");
  assert.equal(task.number, null);
  assert.match(task.name, /^deckhand-org-repo-chat-[0-9a-f]{16}-[0-9a-f]{10}$/);
  assert.deepEqual(calls.started, [["What does run() do?"]]);
  const [item] = task.pending;
  assert.deepEqual(
    { ...item, queuedAt: 0, queueId: 0 },
    {
      repo: "org/repo",
      id: `chat-${chat.id}`,
      kind: "chat",
      number: null,
      author: "alice",
      text: "What does run() do?",
      mode: "chat",
      replyTo: null,
      dashboard: true,
      queuedAt: 0,
      queueId: 0,
    },
  );
  // Its sandbox waits for the next message: it goes to its inbox.
  task.pending.splice(0);
  Object.assign(task, { running: true, live: { open: true, result: {}, unanswered: [] } });
  assert.equal((await chats.list("alice"))[0].status, "idle");
  const after = await chats.message("alice", chat.id, "And follow()?");
  assert.deepEqual(calls.delivered, [["And follow()?"]]);
  assert.equal(after.status, "idle");
  // In the orchestrator's store, which its two copies share, with what the next one needs.
  const saved = await store.get("chats");
  assert.deepEqual(Object.keys(saved), [chat.id]);
  assert.equal(saved[chat.id].repo, "org/repo");
});

test("a chat's agent, model and effort: checked when it is created, under its messages' own", async (t) => {
  const { chats, ctx } = await setup(t);
  const bad = (body) => refusal(chats.create("alice", { repo: "org/repo", ...body }));
  assert.equal((await bad({ agent: "nope" })).status, 422);
  assert.equal((await bad({ model: "a b" })).status, 422);
  assert.equal((await bad({ effort: "huge" })).status, 422);
  assert.equal((await bad({ message: "  " })).status, 400);
  assert.equal((await bad({ repo: "nope" })).status, 400);
  const chat = await chats.create("alice", { repo: "org/repo", model: "fast", effort: "high" });
  const task = { id: `chat-${chat.id}` };
  assert.deepEqual(chats.options(task), { model: "fast", effort: "high" });
  assert.equal(ctx.tasks.size, 0, "no message, no task yet");
});

test("the dashboard's checks: the App installed, a config without errors, the user among its users", async (t) => {
  const missing = await setup(t, { installed: false });
  assert.deepEqual(await refusal(missing.chats.create("alice", { repo: "org/repo" })), {
    status: 404,
    message: "The App is not installed on org/repo.",
  });
  const narrowed = await setup(t, { yaml: "users: [bob]\n" });
  assert.deepEqual(await refusal(narrowed.chats.create("alice", { repo: "org/repo" })), {
    status: 403,
    message: "alice is not among org/repo's users.",
  });
  const broken = await setup(t, { yaml: "users: 3\n" });
  assert.equal((await refusal(broken.chats.create("alice", { repo: "org/repo" }))).status, 409);
  const outside = await setup(t, { env: { ALLOWED_REPOS: "org/other" } });
  assert.equal((await refusal(outside.chats.create("alice", { repo: "org/repo" }))).status, 404);
  const stranger = await setup(t);
  assert.deepEqual(await refusal(stranger.chats.create("carol", { repo: "org/repo" })), {
    status: 403,
    message: "carol is not in ALLOWED_USERS.",
  });
});

test("the access decision: a hidden repo is a 404, no runs:start:chat a 403 that stops its sandbox, one undecided a 503", async (t) => {
  // login → { ok, error } per action (null: some action at all), as permissions.mjs decide().
  const access = { alice: {}, bob: { null: true, [`runs:start:chat`]: true, "logs:read": true } };
  const permissions = {
    decide: async (login, _repo, action) => {
      const said = access[login]?.[action];
      return said === "error" ? { ok: false, error: "policy away" } : { ok: !!said, error: null };
    },
  };
  const { chats, ctx, calls } = await setup(t, { permissions });
  // Alice sees nothing there: as a repo outside ALLOWED_REPOS.
  assert.deepEqual(await refusal(chats.create("alice", { repo: "org/repo" })), {
    status: 404,
    message: "org/repo isn't one of this dashboard's repositories.",
  });
  access.alice = { null: true, "logs:read": true };
  assert.deepEqual(await refusal(chats.create("alice", { repo: "org/repo" })), {
    status: 403,
    message: "You can't do this on org/repo: it needs the `runs:start:chat` action.",
  });
  access.alice["runs:start:chat"] = true;
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  const key = chatKey(chat);
  const task = ctx.tasks.get(key);
  Object.assign(task, { running: true, live: { open: true } });
  task.pending.splice(0);
  ctx.runs.push({ id: "run-1", key, chat: chat.id, status: "ok", startedAt: 1 });
  // Undecided: the message refused, nothing stopped, the sweep neither; whether it can see the
  // repo at all undecided too (a 503, not a hidden repo's 404).
  access.alice["runs:start:chat"] = "error";
  assert.equal((await refusal(chats.message("alice", chat.id, "next"))).status, 503);
  await chats.sweep();
  access.alice["runs:start:chat"] = true;
  access.alice.null = "error";
  assert.deepEqual(await refusal(chats.message("alice", chat.id, "next")), {
    status: 503,
    message: "Your access to org/repo can't be decided now; try again later.",
  });
  assert.equal((await refusal(chats.create("alice", { repo: "org/repo" }))).status, 503);
  assert.deepEqual(calls.cancelled, []);
  access.alice.null = true;
  // Its runs listed while its owner reads its logs.
  assert.equal((await chats.list("alice"))[0].runs.length, 1);
  access.alice["logs:read"] = false;
  assert.deepEqual((await chats.list("alice"))[0].runs, []);
  // Refused: the sweep stops it.
  access.alice["runs:start:chat"] = false;
  await chats.sweep();
  assert.deepEqual(calls.cancelled, [[key, "Deckhand"]]);
  // As does a message, once its repo is hidden.
  task.running = true;
  access.alice = {};
  assert.equal((await refusal(chats.message("alice", chat.id, "again"))).status, 404);
  assert.deepEqual(calls.cancelled.at(-1), [key, "Deckhand"]);
});

test("CHATS_PER_USER: a user's chats on every repository count, running or not; a repo's lower value too", async (t) => {
  const { chats } = await setup(t);
  await chats.create("alice", { repo: "org/repo" });
  await chats.create("alice", { repo: "org/repo", message: "hi" });
  assert.deepEqual(await refusal(chats.create("alice", { repo: "org/repo" })), {
    status: 409,
    message: "You have 2 chat(s), the most you may keep (CHATS_PER_USER is 2): delete one first.",
  });
  // Another user's are theirs.
  await chats.create("bob", { repo: "org/repo" });
  const lower = await setup(t, { yaml: "chats:\n  per_user: 1\n" });
  await lower.chats.create("alice", { repo: "org/repo" });
  assert.deepEqual(await refusal(lower.chats.create("alice", { repo: "org/repo" })), {
    status: 409,
    message:
      "You have 1 chat(s), the most you may keep (org/repo's `chats.per_user` allows 1): delete one first.",
  });
  // Never higher than the operator's.
  const higher = await setup(t, { yaml: "chats:\n  per_user: 9\n" });
  await higher.chats.create("alice", { repo: "org/repo" });
  await higher.chats.create("alice", { repo: "org/repo" });
  assert.equal((await refusal(higher.chats.create("alice", { repo: "org/repo" }))).status, 409);
  const off = await setup(t, { yaml: "chats:\n  per_user: 0\n" });
  assert.deepEqual(await refusal(off.chats.create("alice", { repo: "org/repo" })), {
    status: 409,
    message: "No chats on org/repo: org/repo's `chats.per_user` allows 0.",
  });
});

test("a user lists and reaches their own chats only", async (t) => {
  const { chats } = await setup(t);
  const mine = await chats.create("alice", { repo: "org/repo" });
  const theirs = await chats.create("bob", { repo: "org/repo" });
  assert.deepEqual(
    (await chats.list("alice")).map((c) => c.id),
    [mine.id],
  );
  assert.deepEqual(
    (await chats.list("BOB")).map((c) => c.id),
    [theirs.id],
  );
  for (const attempt of [
    chats.message("alice", theirs.id, "hi"),
    chats.reset("alice", theirs.id),
    chats.remove("alice", theirs.id),
    chats.message("alice", "../../x", "hi"),
  ]) {
    assert.deepEqual(await refusal(attempt), { status: 404, message: "No such chat." });
  }
  assert.equal((await chats.list("bob")).length, 1);
});

test("CHAT_IDLE_MINUTES after its last message, a chat's sandbox stops; a message in between waits longer", async (t) => {
  const { chats, ctx, calls, clock } = await setup(t);
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  const task = ctx.tasks.get(chatKey(chat));
  Object.assign(task, { running: true, live: { open: true, result: {}, unanswered: [] } });
  task.pending.splice(0);
  clock.advance(20 * 60_000);
  await chats.message("alice", chat.id, "still there?");
  clock.advance(20 * 60_000);
  assert.deepEqual(calls.rested, [], "20 min since its last message");
  clock.advance(10 * 60_000);
  assert.deepEqual(calls.rested, [task.name]);
  // No sandbox (it stopped): nothing to do when the timer comes again.
  task.live = null;
  task.running = false;
  await chats.message("alice", chat.id, "back");
  clock.advance(30 * 60_000);
  assert.deepEqual(calls.rested, [task.name]);
});

test("chats survive a restart: listed again, their idle timers armed from their last message", async (t) => {
  const store = openStore("memory:");
  const first = await setup(t, { store });
  const chat = await first.chats.create("alice", { repo: "org/repo", message: "hi" });
  const next = await setup(t, { store });
  assert.deepEqual(
    (await next.chats.list("alice")).map((c) => [c.id, c.status]),
    [[chat.id, "stopped"]],
  );
  // Its run came back with the queue (restart.mjs): its timer fires 30 min after its message.
  const task = { name: "sandbox", running: true, pending: [], live: { open: true } };
  next.ctx.tasks.set(chatKey(chat), task);
  next.clock.at = first.clock.at + 10 * 60_000;
  next.chats.start();
  next.clock.advance(19 * 60_000);
  assert.deepEqual(next.calls.rested, []);
  next.clock.advance(60_000);
  assert.deepEqual(next.calls.rested, ["sandbox"]);
});

test("reset: its sandbox stopped, then its volumes removed; the chat stays, its next message starts afresh", async (t) => {
  const { chats, ctx, calls } = await setup(t);
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  const key = chatKey(chat);
  const task = ctx.tasks.get(key);
  Object.assign(task, { running: true, live: { open: true }, next: { model: "opus" } });
  task.pending.splice(0);
  const reset = await chats.reset("alice", chat.id);
  assert.deepEqual(calls.cancelled, [[key, "Deckhand"]]);
  assert.deepEqual(calls.removed, [[task.name, key]]);
  assert.equal(task.running, false);
  assert.deepEqual(task.next, {});
  assert.equal(reset.status, "stopped");
  assert.equal(typeof reset.resetAt, "number");
  assert.equal((await chats.list("alice")).length, 1);
  await chats.message("alice", chat.id, "again");
  assert.deepEqual(calls.started.at(-1), ["again"]);
});

test("delete: its sandbox, volumes, runs' logs and task gone, and the chat itself", async (t) => {
  const { chats, ctx, calls, store } = await setup(t);
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  const other = await chats.create("alice", { repo: "org/repo" });
  const key = chatKey(chat);
  const task = ctx.tasks.get(key);
  Object.assign(task, { running: true, live: { open: true } });
  task.pending.splice(0);
  const run = {
    id: "run-1",
    key,
    chat: chat.id,
    status: "ok",
    startedAt: 1,
    shots: "0123456789abcdef01234567",
  };
  const kept = { id: "run-2", key: "org/repo#12", status: "ok", startedAt: 1 };
  await store.set(summaryKey(run.id), run);
  ctx.runs.push(run, kept);
  ctx.runsById.set(run.id, run).set(kept.id, kept);
  await chats.remove("alice", chat.id);
  assert.deepEqual(calls.cancelled, [[key, "Deckhand"]]);
  assert.deepEqual(calls.removed, [[task.name, key]]);
  assert.deepEqual(calls.logs, ["run-1"]);
  assert.deepEqual(calls.shots, ["0123456789abcdef01234567"]);
  assert.equal(await store.get(summaryKey(run.id)), null);
  assert.deepEqual(ctx.runs, [kept]);
  assert.equal(ctx.tasks.has(key), false);
  assert.deepEqual(
    (await chats.list("alice")).map((c) => c.id),
    [other.id],
  );
  assert.equal(chats.has(key), false);
  assert.deepEqual(Object.keys(await store.get("chats")), [other.id]);
});

test("a user no longer allowed: their message refused and their chat's sandbox stopped; the sweep stops it too", async (t) => {
  const { chats, ctx, calls, config } = await setup(t);
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  const key = chatKey(chat);
  const task = ctx.tasks.get(key);
  Object.assign(task, { running: true, live: { open: true } });
  task.pending.splice(0);
  config.users.splice(config.users.indexOf("alice"), 1);
  assert.deepEqual(await refusal(chats.message("alice", chat.id, "hi")), {
    status: 403,
    message: "alice is not in ALLOWED_USERS.",
  });
  assert.deepEqual(calls.cancelled, [[key, "Deckhand"]]);
  // The repo's `users` narrowed (as last read): the sweep stops what goes on.
  const narrowed = await setup(t, { users: ["bob"] });
  const theirs = await narrowed.chats.create("alice", { repo: "org/repo", message: "hi" });
  const going = narrowed.ctx.tasks.get(chatKey(theirs));
  going.running = true;
  await narrowed.chats.sweep();
  assert.deepEqual(narrowed.calls.cancelled, [[chatKey(theirs), "Deckhand"]]);
  assert.ok(
    narrowed.lines.some((l) => /stopped, alice is no longer among org\/repo's users/.test(l)),
  );
  // Its volumes stay until it is deleted.
  assert.deepEqual(narrowed.calls.removed, []);
});

test("the API: GET and POST /api/chats, messages, reset and DELETE, signed in and from the dashboard", async (t) => {
  const { chats } = await setup(t);
  const { url } = await serve(t, (req, res) => {
    const user = req.headers["x-user"] ?? null;
    if (!chats.handle(req, res, user)) res.writeHead(404).end();
  });
  const call = async (method, path, { user = "alice", body, origin = url } = {}) => {
    const res = await fetch(url + path, {
      method,
      headers: {
        ...(user && { "x-user": user }),
        ...(origin && { origin }),
        "content-type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call("GET", "/api/chats", { user: null })).status, 401);
  assert.equal(
    (
      await call("POST", "/api/chats", {
        body: { repo: "org/repo" },
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  const created = await call("POST", "/api/chats", { body: { repo: "org/repo", message: "hi" } });
  assert.equal(created.status, 201);
  const { id } = created.body.chat;
  assert.equal(created.body.chat.status, "running");
  assert.deepEqual(
    (await call("GET", "/api/chats")).body.chats.map((c) => c.id),
    [id],
  );
  assert.deepEqual((await call("GET", "/api/chats", { user: "bob" })).body, { chats: [] });
  assert.equal((await call("GET", `/api/chats/${id}`, { user: "bob" })).status, 404);
  assert.equal(
    (await call("POST", `/api/chats/${id}/messages`, { body: { text: "more" } })).status,
    202,
  );
  assert.equal((await call("POST", `/api/chats/${id}/reset`)).status, 200);
  assert.equal((await call("DELETE", `/api/chats/${id}`, { origin: null })).status, 403);
  assert.equal((await call("DELETE", `/api/chats/${id}`)).status, 200);
  assert.equal((await call("GET", `/api/chats/${id}`)).status, 404);
  assert.equal((await call("PUT", "/api/chats")).status, 405);
});

test("a message that waits for a chat slot past CHAT_IDLE_MINUTES: the idle time counts from its answer", async (t) => {
  const { chats, ctx, calls, clock } = await setup(t);
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  const task = ctx.tasks.get(chatKey(chat));
  // Waiting for one of MAX_RUNNING_CHATS, then starting, for longer than the idle time.
  clock.advance(45 * 60_000);
  assert.deepEqual(calls.rested, []);
  assert.equal(clock.timers.size, 1, "armed again while it waits");
  task.pending.splice(0);
  Object.assign(task, { running: true, live: { open: true, result: {}, unanswered: [] } });
  // Its answer (runs.mjs output()): idle 30 min from there.
  chats.answered(task);
  clock.advance(29 * 60_000);
  assert.deepEqual(calls.rested, []);
  clock.advance(60_000);
  assert.deepEqual(calls.rested, [task.name]);
});

test("an idle chat whose inbox isn't known open (a restart): rested all the same, not retried for ever", async (t) => {
  const { chats, ctx, calls, clock } = await setup(t);
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  const task = ctx.tasks.get(chatKey(chat));
  task.pending.splice(0);
  Object.assign(task, { running: true, live: { open: false, result: {}, unanswered: [] } });
  clock.advance(30 * 60_000);
  assert.deepEqual(calls.rested, [task.name]);
  assert.equal(clock.timers.size, 0);
});

test("a chat deleted, or reset, while a message's checks read GitHub: the message refused, nothing started", async (t) => {
  const hold = {};
  const { chats, ctx, calls } = await setup(t, { hold });
  for (const [what, act] of [
    ["deleted", (chat) => chats.remove("alice", chat.id)],
    ["reset", (chat) => chats.reset("alice", chat.id)],
  ]) {
    const chat = await chats.create("alice", { repo: "org/repo" });
    let release;
    hold.until = new Promise((resolve) => (release = resolve));
    const sent = refusal(chats.message("alice", chat.id, "hi"));
    await act(chat);
    release();
    assert.deepEqual(
      await sent,
      { status: 409, message: "This chat is being reset or deleted: send it again in a moment." },
      what,
    );
    assert.deepEqual(calls.started, [], what);
    assert.equal(ctx.tasks.get(chatKey(chat))?.pending.length ?? 0, 0, what);
    hold.until = null;
    if (what === "reset") await chats.remove("alice", chat.id);
  }
});

test("a restored chat that answered, its inbox not known open: a message rests it at once, and starts the next run", async (t) => {
  const { chats, ctx, calls } = await setup(t);
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  const task = ctx.tasks.get(chatKey(chat));
  task.pending.splice(0);
  Object.assign(task, { running: true, live: { open: false, result: {}, unanswered: [] } });
  await chats.message("alice", chat.id, "still there?");
  assert.deepEqual(calls.rested, [task.name]);
  assert.deepEqual(calls.delivered, []);
  // One still working on its answer: left alone, the message waits for it.
  task.live = { open: false, result: null, unanswered: [] };
  await chats.message("alice", chat.id, "and now?");
  assert.deepEqual(calls.rested, [task.name]);
});

test("MAX_RUNNING_CHATS 0: no message is taken, as it would wait for good", async (t) => {
  const { chats } = await setup(t, { env: { MAX_RUNNING_CHATS: "0" } });
  const message = "No chat runs here: MAX_RUNNING_CHATS is 0.";
  assert.deepEqual(await refusal(chats.create("alice", { repo: "org/repo", message: "hi" })), {
    status: 409,
    message,
  });
  const chat = await chats.create("alice", { repo: "org/repo" });
  assert.deepEqual(await refusal(chats.message("alice", chat.id, "hi")), { status: 409, message });
});

test("a chat its owner can no longer reach: listed, so they can delete it, without its runs", async (t) => {
  const { chats, ctx } = await setup(t, { users: ["bob"] });
  const users = { list: ["alice", "bob"] };
  ctx.usersOf = () => users.list;
  const chat = await chats.create("alice", { repo: "org/repo" });
  ctx.runs.push({ id: "run-1", key: chatKey(chat), chat: chat.id, status: "ok", startedAt: 1 });
  assert.equal((await chats.list("alice"))[0].runs.length, 1);
  users.list = ["bob"];
  const [listed] = await chats.list("alice");
  assert.deepEqual([listed.reachable, listed.runs], [false, []]);
  await chats.remove("alice", chat.id);
  assert.deepEqual(await chats.list("alice"), []);
});

// A grants folder giving org/repo `hosts`: its path, for GRANTS_DIR.
function grantsFolder(t, text) {
  const dir = realpathSync(tempDir(t));
  mkdirSync(join(dir, "org"));
  writeFileSync(join(dir, "org", "repo.yaml"), text);
  return dir;
}

test("permissions: the ceiling a chat's run gets, a profile saved within it, what would widen it refused (#478)", async (t) => {
  const policies = capabilityPolicies();
  const { chats, store } = await setup(t, {
    env: { GRANTS_DIR: grantsFolder(t, "hosts: [registry.npmjs.org, pypi.org]\n") },
    policies,
    yaml: "setup: npm ci\n",
  });
  const chat = await chats.create("alice", { repo: "org/repo" });
  const view = await chats.permissions("alice", chat.id);
  // What a chat's run is decided with: a `chat` one started from the dashboard, no issue.
  assert.deepEqual(policies.inputs.at(-1), {
    repo: { name: "org/repo", private: true },
    mode: "chat",
    custom_mode: false,
    issue: null,
    reason: null,
    fork: false,
    trigger: "dashboard",
    command: null,
  });
  assert.deepEqual(view.profile, DEFAULT_PROFILE);
  assert.deepEqual(view.ceiling.hosts, ["registry.npmjs.org", "pypi.org"]);
  assert.deepEqual(
    view.ceiling.capabilities.filter((c) => c.allowed).map((c) => c.name),
    ["pull", "setup", "read:issues", "read:pulls", "read:actions"],
  );
  assert.equal(view.effective.hosts.length, 2);
  assert.equal(view.running, false);
  assert.deepEqual(view.errors, []);

  // Beyond the ceiling: refused, each said, nothing saved.
  const widened = await chats.setPermissions("alice", chat.id, {
    profile: { hosts: ["evil.example"], capabilities: ["pull", "docker"], github: "push" },
  });
  assert.equal(widened.refused.length, 3);
  assert.match(widened.refused[0], /^GitHub: `push`/);
  assert.equal((await store.get("chats"))[chat.id].profile, null);

  // Within it: saved with the chat, in the store, for its next start.
  const saved = await chats.setPermissions("alice", chat.id, {
    profile: { capabilities: ["pull", "setup"], hosts: ["pypi.org"] },
  });
  const profile = {
    github: "read",
    capabilities: ["pull", "setup"],
    hosts: ["pypi.org"],
    mounts: null,
  };
  assert.deepEqual(saved.profile, profile);
  assert.deepEqual(saved.effective.capabilities, ["pull", "setup"]);
  assert.deepEqual((await store.get("chats"))[chat.id].profile, profile);
  assert.deepEqual(chats.profileOf({ id: `chat-${chat.id}` }), profile);
  // Someone else's: no such chat.
  assert.equal((await refusal(chats.permissions("bob", chat.id))).status, 404);
  assert.equal((await refusal(chats.setPermissions("bob", chat.id, { profile: {} }))).status, 404);
});

test("permissions: a chat whose capabilities can't be decided answers a 503, saving nothing", async (t) => {
  const { chats } = await setup(t, {
    env: { GRANTS_DIR: grantsFolder(t, "hosts: []\n") },
    policies: { capabilityRules: async () => ({ error: "opa is away" }), grants: async () => ({}) },
  });
  const chat = await chats.create("alice", { repo: "org/repo" });
  assert.deepEqual(await refusal(chats.setPermissions("alice", chat.id, { profile: {} })), {
    status: 503,
    message: "What org/repo's chats get can't be decided now: opa is away",
  });
});

test("restart: the chat's sandbox rests (its session kept), so its next message starts with the new profile", async (t) => {
  const { chats, ctx, calls } = await setup(t);
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  // No sandbox going yet: nothing to stop.
  assert.equal(chats.restart("alice", chat.id), false);
  const task = ctx.tasks.get(chatKey(chat));
  task.live = { open: true };
  assert.equal(chats.restart("alice", chat.id), true);
  assert.deepEqual(calls.rested, [task.name]);
  // Nothing removed: the session stays.
  assert.deepEqual(calls.removed, []);
  assert.throws(() => chats.restart("bob", chat.id), { status: 404 });
});

test("the API: GET and POST /api/chats/<id>/permissions, a 422 listing what would widen it, POST restart", async (t) => {
  const { chats } = await setup(t, {
    env: { GRANTS_DIR: grantsFolder(t, "hosts: [pypi.org]\n") },
    policies: capabilityPolicies(),
  });
  const { url } = await serve(t, (req, res) => {
    if (!chats.handle(req, res, req.headers["x-user"] ?? null)) res.writeHead(404).end();
  });
  const call = async (method, path, body) => {
    const res = await fetch(url + path, {
      method,
      headers: { "x-user": "alice", origin: url, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const { id } = (await call("POST", "/api/chats", { repo: "org/repo" })).body.chat;
  const got = await call("GET", `/api/chats/${id}/permissions`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.ceiling.hosts, ["pypi.org"]);
  const refused = await call("POST", `/api/chats/${id}/permissions`, {
    profile: { hosts: ["evil.example"] },
  });
  assert.equal(refused.status, 422);
  assert.deepEqual(refused.body.errors, [
    "`evil.example`: not among the hosts the operator grants this repository",
  ]);
  assert.match(refused.body.error, /^This profile goes beyond what the chat may get: /);
  const saved = await call("POST", `/api/chats/${id}/permissions`, { profile: { hosts: [] } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.effective.hosts, []);
  const restarted = await call("POST", `/api/chats/${id}/restart`);
  assert.equal(restarted.status, 200);
  assert.match(restarted.body.message, /^No sandbox is going/);
  assert.equal((await call("DELETE", `/api/chats/${id}/permissions`)).status, 405);
});
