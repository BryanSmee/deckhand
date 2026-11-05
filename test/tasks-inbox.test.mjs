// A burst of comments on a task (tasks.mjs queue(), runs.mjs run()), each run from its start to
// its reply on a fake runner: on an ordinary issue one run takes them all; on an inbox issue each
// entry is a run of its own, its own entry in its prompt and its own reply, and an entry that
// comes while another runs isn't delivered to it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createRuns } from "../listener/runs.mjs";
import { createTasks } from "../listener/tasks.mjs";
import { openStore } from "../lib/store.mjs";
import { capabilityPolicies, testConfig, until } from "./helpers.mjs";

const config = testConfig({ DEBOUNCE_MS: "0", BRAINSTORM_DEBOUNCE_MS: "0" });

// An inbox entry's text: who wrote it and where, then what they said (events.mjs inboxItem()).
const entry = (id, body) =>
  `From @alice (https://github.com/org/repo/issues/12#issuecomment-${id}):\n\n${body}`;

// What a run's agent answers (runs.mjs output()): one result.
const result = (text) => JSON.stringify({ type: "result", result: text, duration_ms: 1000 });

// A runner whose sandboxes run until the test answers for them (`reply(text)`: a result, after
// which the run closes its inbox and the sandbox exits). `specs`: what each start was given.
function fakeRunner() {
  const runner = {
    specs: [],
    sent: [],
    following: null,
    exited: null,
    state: async () => null,
    hasSession: async () => false,
    start: async (spec) => (runner.specs.push(spec), {}),
    follow: (name, { onOut, onCaughtUp }) => {
      onCaughtUp?.();
      runner.following = onOut;
      // Exited: the next sandbox's output is the next follow's.
      return new Promise((resolve) => (runner.exited = resolve)).then(
        () => (runner.following = null),
      );
    },
    reply: (text) => runner.following(result(text)),
    send: (...args) => runner.sent.push(args),
    close: () => runner.exited?.(),
    kill: async () => runner.exited?.(),
    closed: () => false,
    remove: async () => {},
  };
  return runner;
}

// createTasks() and createRuns() on one ctx, as the orchestrator puts them together, the repo's
// config `yaml`, every run allowed, each mode with the capabilities Deckhand's policies give it.
// Runs start only when the test says (startNext(), `ctx.run` does nothing), on the fake runner:
// `runner.specs` has each sandbox's, `replies` each reply posted [the comment it answers, text].
function queueing(yaml = "") {
  const logs = [];
  const replies = [];
  const runner = fakeRunner();
  const { settings } = parseRepoConfig(yaml, config);
  const ctx = {
    config,
    log: (line) => logs.push(line),
    skip: (why) => (logs.push(why), null),
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {}, activate: () => null, replied: () => {} },
    runs: [],
    runsById: new Map(),
    running: 0,
    stopping: false,
    titles: { set: () => {}, get: () => "An idea" },
    received: () => {},
    reply: async () => null,
    settle: async () => {},
    track: () => {},
    answer: async (target, text) => replies.push([target.comment?.id, text]),
    publicUrl: () => "https://deck.example",
    label: async () => {},
    runner,
    repoSettings: async () => ({ settings, errors: [], warnings: [] }),
    waits: {
      reserve: () => null,
      release: async () => {},
      request: async () => false,
      recheck: async () => null,
    },
    policies: {
      decide: async () => ({ applied: false, messages: [] }),
      ...capabilityPolicies(),
    },
    github: async () => new Response("[]", { status: 200 }),
    app: { identity: () => ({ name: "deckhand[bot]", email: "bot@example" }) },
    images: {
      imageFor: async () => config.image,
      installAgent: async () => {},
      caches: async () => [],
    },
    egressCa: async () => "a CA",
    broker: {
      register: () => {},
      provide: () => {},
      grant: () => {},
      allow: () => {},
      revoke: () => {},
      runOf: () => ({ tokens: new Set(), scrubs: [] }),
      secretsOf: () => [],
    },
    watchPushes: () => {},
    onboarded: { isIssue: () => false },
    runLogs: { open: () => ({ write: () => {}, close: () => {} }) },
    store: openStore("memory:"),
    saveLive: async () => {},
    removeLive: async () => true,
  };
  Object.assign(ctx, createTasks(ctx));
  const runs = createRuns(ctx);
  Object.assign(ctx, runs, { run: () => {}, schedule: () => {} });
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
    return ctx.admit({ ...first, author: "alice", replyTo: 12 }, "issue_comment", payload);
  };
  const task = () => ctx.tasks.get("org/repo#12");
  // The task's next run, up to its sandbox's start: `reply(text)`, its agent's answer, `over`, its
  // end.
  const startNext = async () => {
    const t = task();
    clearTimeout(t.timer);
    const starts = runner.specs.length;
    let ended = false;
    const over = runs.run(t).finally(() => (ended = true));
    await until(() => ended || (runner.specs.length > starts && t.live?.open && runner.following), {
      what: "the sandbox",
    });
    // Over before its sandbox started: what it said, rather than a timeout.
    assert.ok(!ended, [...logs, ...replies.map(([, text]) => text)].join("\n"));
    return { reply: runner.reply, over };
  };
  // A run from start to end, its agent answering `text`.
  const runNext = async (text) => {
    const { reply, over } = await startNext();
    reply(text);
    await over;
    // Its slot free again, as runs.mjs teardown() leaves it.
    assert.equal(ctx.running, 0);
  };
  // What each sandbox's agent was told: its TASK_PROMPT.
  const prompts = () => runner.specs.map((spec) => spec.env.TASK_PROMPT);
  // And its first message: TASK_MESSAGE.
  const messages = () => runner.specs.map((spec) => spec.env.TASK_MESSAGE);
  return { ctx, logs, replies, runner, say, task, startNext, runNext, prompts, messages };
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
  await q.runNext("Fixed both.");
  assert.equal(q.messages().length, 1);
  assert.match(q.messages()[0], /^Fix the login page\.\n\n---\n\nAnd the dates\.$/);
  assert.equal(q.task().pending.length, 0);
  // One reply, on the last comment it took.
  assert.deepEqual(
    q.replies.map(([id, text]) => [id, text.split("\n")[0]]),
    [[100, "Fixed both."]],
  );
});

test("a burst of inbox entries: a run each, its own entry in the prompt, its own reply", async () => {
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
  await q.runNext("Filed #13.");
  assert.equal(q.task().pending.length, 1);
  await q.runNext("Filed #14.");
  const [first, second] = q.prompts();
  assert.ok(first.endsWith(`The entry:\n\n${entry(99, "A dark mode")}`), first);
  assert.doesNotMatch(first, /Keyboard shortcuts/);
  assert.ok(second.endsWith(`The entry:\n\n${entry(100, "Keyboard shortcuts")}`), second);
  assert.doesNotMatch(second, /A dark mode/);
  // Each reply on its own entry, with its own run's answer.
  assert.deepEqual(
    q.replies.map(([id, text]) => [id, text.split("\n")[0]]),
    [
      [99, "Filed #13."],
      [100, "Filed #14."],
    ],
  );
});

test("an inbox entry while another one runs: not delivered to it, queued for a run of its own", async () => {
  const q = queueing("inbox: { bugs: 12 }\n");
  await q.say(99, "The login page is blank");
  // The first entry's run going on, its session open to messages.
  const { reply, over } = await q.startNext();
  const t = q.task();
  await q.say(100, "Dates are off by one");
  clearTimeout(t.timer);
  assert.ok(q.logs.includes("org/repo#12: queued after the running one (bug)"), q.logs.join("\n"));
  assert.equal(q.ctx.deliverable(t), 0);
  assert.equal(q.ctx.deliver(t), false);
  assert.deepEqual(
    t.pending.map((i) => i.text),
    [entry(100, "Dates are off by one")],
  );
  reply("Filed #13.");
  await over;
  assert.deepEqual(q.runner.sent, []);
  // Once it is over: a run of its own, with that entry alone.
  await q.runNext("Filed #14.");
  const [first, second] = q.prompts();
  assert.match(first, /The login page is blank$/);
  assert.doesNotMatch(first, /off by one/);
  assert.match(second, /Dates are off by one$/);
  assert.doesNotMatch(second, /login page/);
  assert.deepEqual(
    q.replies.map(([id]) => id),
    [99, 100],
  );
});

test("a comment while a work run goes on: delivered to its session", async () => {
  const q = queueing();
  await q.say(99, "Deckhand\nFix it.");
  const { reply, over } = await q.startNext();
  const t = q.task();
  await q.say(100, "And the dates.");
  clearTimeout(t.timer);
  assert.ok(q.logs.includes("org/repo#12: for the running session (work)"), q.logs.join("\n"));
  assert.equal(q.ctx.deliverable(t), 1);
  // At its agent's next result, sent to its session: answered in the same run.
  reply("Fixed it.");
  assert.equal(q.runner.sent.length, 1);
  assert.match(q.runner.sent[0][1], /And the dates\./);
  reply("Fixed the dates too.");
  await over;
  assert.equal(q.prompts().length, 1);
  assert.deepEqual(
    q.replies.map(([id, text]) => [id, text.split("\n")[0]]),
    [[100, "Fixed the dates too."]],
  );
});
