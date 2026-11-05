// A burst of comments on a task (tasks.mjs queue(), runs.mjs run()): on an ordinary issue one
// run takes them all; on an inbox issue each entry is a run of its own, and an entry that comes
// while another runs isn't delivered to it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createRuns } from "../listener/runs.mjs";
import { createTasks } from "../listener/tasks.mjs";
import { testConfig } from "./helpers.mjs";

const config = testConfig({ DEBOUNCE_MS: "0", BRAINSTORM_DEBOUNCE_MS: "0" });

// An inbox entry's text: who wrote it and where, then what they said (events.mjs inboxItem()).
const entry = (id, body) =>
  `From @alice (https://github.com/org/repo/issues/12#issuecomment-${id}):\n\n${body}`;

// Where run() stops: once it took its comments (ctx.take()), what the test asserts on.
class Taken extends Error {}

// createTasks() and createRuns() on one ctx, the repo's config `yaml`, every run allowed. Runs
// start only when the test says (`ctx.run` does nothing), and stop once they took their
// comments: `taken`, the texts each took.
function queueing(yaml = "") {
  const logs = [];
  const sent = [];
  const taken = [];
  const { settings } = parseRepoConfig(yaml, config);
  const ctx = {
    config,
    log: (line) => logs.push(line),
    skip: (why) => (logs.push(why), null),
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {}, activate: () => null },
    runs: [],
    runsById: new Map(),
    running: 0,
    run: () => {},
    schedule: () => {},
    titles: { set: () => {}, get: () => "An idea" },
    received: () => {},
    reply: async () => null,
    settle: async () => {},
    track: () => {},
    answer: async () => {},
    runner: {
      hasSession: async () => false,
      send: (...args) => sent.push(args),
    },
    repoSettings: async () => ({ settings, errors: [] }),
    waits: { reserve: () => null, release: async () => {}, request: async () => false },
    policies: { decide: async () => ({ applied: false, messages: [] }) },
    github: async () => new Response("", { status: 404 }),
    broker: { register: () => {} },
    runLogs: { open: () => ({ write: () => {}, close: () => {} }) },
    take: (task, items) => {
      taken.push(items.map((i) => i.text));
      throw new Taken();
    },
  };
  const tasks = createTasks(ctx);
  const runs = createRuns(ctx);
  // Comment `id` by alice on issue 12 saying `body`.
  const say = (id, body) => {
    const payload = {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      issue: { number: 12, title: "An idea", state: "open", labels: [] },
      comment: {
        id,
        body,
        html_url: `https://github.com/org/repo/issues/12#issuecomment-${id}`,
        user: { login: "alice", type: "User" },
      },
      sender: { login: "alice" },
    };
    const trigger = /^deckhand/i.test(body) ? "work" : null;
    const first = { repo: "org/repo", id: "12", kind: "issue", base: "trunk", trigger };
    return tasks.admit({ ...first, author: "alice", replyTo: 12 }, "issue_comment", payload);
  };
  const task = () => ctx.tasks.get("org/repo#12");
  // The task's next run, up to taking its comments: then as if it ended.
  const runNext = async () => {
    const t = task();
    clearTimeout(t.timer);
    await assert.rejects(runs.run(t), Taken);
    t.running = false;
    t.live = null;
    ctx.running--;
  };
  return { ctx, logs, sent, taken, say, task, runNext, ...tasks };
}

test("a burst of comments on an ordinary issue is one run", async () => {
  const q = queueing();
  await q.say(99, "Deckhand\nFix the login page.");
  await q.say(100, "And the dates.");
  assert.deepEqual(
    q.task().pending.map((i) => [i.text, i.mode]),
    [
      ["Fix the login page.", "work"],
      ["And the dates.", "work"],
    ],
  );
  await q.runNext();
  assert.deepEqual(q.taken, [["Fix the login page.", "And the dates."]]);
  assert.equal(q.task().pending.length, 0);
});

test("a burst of inbox entries: a run each, its own entry alone", async () => {
  const q = queueing("inbox: { ideas: 12 }\n");
  await q.say(99, "A dark mode");
  await q.say(100, "Keyboard shortcuts");
  assert.deepEqual(
    q.task().pending.map((i) => [i.text, i.mode]),
    [
      [entry(99, "A dark mode"), "idea"],
      [entry(100, "Keyboard shortcuts"), "idea"],
    ],
  );
  await q.runNext();
  assert.deepEqual(q.taken, [[entry(99, "A dark mode")]]);
  assert.equal(q.task().pending.length, 1);
  await q.runNext();
  assert.deepEqual(q.taken, [[entry(99, "A dark mode")], [entry(100, "Keyboard shortcuts")]]);
});

test("an inbox entry while another one runs: not delivered to it, queued for a run of its own", async () => {
  const q = queueing("inbox: { bugs: 12 }\n");
  await q.say(99, "The login page is blank");
  await q.runNext();
  // The first entry's run going on, its session open to messages.
  const t = q.task();
  t.running = true;
  t.live = {
    key: "org/repo#12",
    mode: "bug",
    open: true,
    record: { agent: "claude" },
    later: {},
    handled: [],
    unanswered: [],
  };
  await q.say(100, "Dates are off by one");
  assert.ok(q.logs.includes("org/repo#12: queued after the running one (bug)"), q.logs.join("\n"));
  assert.equal(q.deliverable(t), 0);
  assert.equal(q.deliver(t), false);
  assert.deepEqual(q.sent, []);
  assert.deepEqual(
    t.pending.map((i) => i.text),
    [entry(100, "Dates are off by one")],
  );
  clearTimeout(t.timer);
  // Once it is over: a run of its own, with that entry alone.
  t.running = false;
  t.live = null;
  await q.runNext();
  assert.deepEqual(q.taken, [
    [entry(99, "The login page is blank")],
    [entry(100, "Dates are off by one")],
  ]);
});

test("a comment while a work run goes on: delivered to its session", async () => {
  const q = queueing();
  await q.say(99, "Deckhand\nFix it.");
  await q.runNext();
  const t = q.task();
  t.running = true;
  t.live = {
    key: "org/repo#12",
    mode: "work",
    open: true,
    record: { agent: "claude" },
    later: {},
    handled: [],
    unanswered: [],
    logFile: { write: () => {} },
  };
  await q.say(100, "And the dates.");
  clearTimeout(t.timer);
  assert.ok(q.logs.includes("org/repo#12: for the running session (work)"), q.logs.join("\n"));
  assert.equal(q.deliverable(t), 1);
});
