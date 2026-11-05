// chats.mjs (#476): a user's chats from the dashboard, with an injected runner, clock and run
// machinery (runs.mjs and tasks.mjs, whose part runs.test.mjs and orchestrator-server.test.mjs
// cover), and the dashboard's real checks (repo-check.mjs) over a fake GitHub.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chatKey, createChats } from "../listener/chats.mjs";
import { createRepoCheck } from "../listener/repo-check.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { summaryPath } from "../listener/runlog.mjs";
import { openStore } from "../lib/store.mjs";
import { serve, tempDir, testConfig } from "./helpers.mjs";

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
    dir = tempDir(t),
    users,
    store = openStore("memory:"),
  } = {},
) {
  const config = testConfig({
    ALLOWED_USERS: "alice,bob",
    CHATS_PER_USER: "2",
    CHAT_IDLE_MINUTES: "30",
    ...env,
  });
  const clock = fakeClock();
  const calls = { started: [], delivered: [], rested: [], cancelled: [], removed: [], logs: [] };
  const lines = [];
  const ctx = {
    config,
    log: (line) => lines.push(line),
    tasks: new Map(),
    runs: [],
    runsById: new Map(),
    store,
    logDir: dir,
    shotsDir: dir,
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
  };
  const github = async (_repo, _method, path) => {
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
  return { chats, ctx, calls, clock, config, lines, dir, store };
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
  assert.equal(chats.list("alice")[0].status, "idle");
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
    chats.list("alice").map((c) => c.id),
    [mine.id],
  );
  assert.deepEqual(
    chats.list("BOB").map((c) => c.id),
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
  assert.equal(chats.list("bob").length, 1);
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
    next.chats.list("alice").map((c) => [c.id, c.status]),
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
  assert.equal(chats.list("alice").length, 1);
  await chats.message("alice", chat.id, "again");
  assert.deepEqual(calls.started.at(-1), ["again"]);
});

test("delete: its sandbox, volumes, runs' logs and task gone, and the chat itself", async (t) => {
  const { chats, ctx, calls, dir, store } = await setup(t);
  const chat = await chats.create("alice", { repo: "org/repo", message: "hi" });
  const other = await chats.create("alice", { repo: "org/repo" });
  const key = chatKey(chat);
  const task = ctx.tasks.get(key);
  Object.assign(task, { running: true, live: { open: true } });
  task.pending.splice(0);
  const run = { id: "run-1", key, chat: chat.id, status: "ok", startedAt: 1 };
  const kept = { id: "run-2", key: "org/repo#12", status: "ok", startedAt: 1 };
  writeFileSync(summaryPath(dir, run.id), JSON.stringify(run));
  ctx.runs.push(run, kept);
  ctx.runsById.set(run.id, run).set(kept.id, kept);
  await chats.remove("alice", chat.id);
  assert.deepEqual(calls.cancelled, [[key, "Deckhand"]]);
  assert.deepEqual(calls.removed, [[task.name, key]]);
  assert.deepEqual(calls.logs, ["run-1"]);
  assert.equal(existsSync(summaryPath(dir, run.id)), false);
  assert.deepEqual(ctx.runs, [kept]);
  assert.equal(ctx.tasks.has(key), false);
  assert.deepEqual(
    chats.list("alice").map((c) => c.id),
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
  narrowed.chats.sweep();
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

test("a chat its owner can no longer reach: listed, so they can delete it, without its runs", async (t) => {
  const { chats, ctx } = await setup(t, { users: ["bob"] });
  const users = { list: ["alice", "bob"] };
  ctx.usersOf = () => users.list;
  const chat = await chats.create("alice", { repo: "org/repo" });
  ctx.runs.push({ id: "run-1", key: chatKey(chat), chat: chat.id, status: "ok", startedAt: 1 });
  assert.equal(chats.list("alice")[0].runs.length, 1);
  users.list = ["bob"];
  const [listed] = chats.list("alice");
  assert.deepEqual([listed.reachable, listed.runs], [false, []]);
  await chats.remove("alice", chat.id);
  assert.deepEqual(chats.list("alice"), []);
});
