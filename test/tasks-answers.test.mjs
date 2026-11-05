// tasks.mjs and the repo's `wait_for_answers`: what a comment on an issue with open questions
// starts (admit()), and what a comment that waited starts once they are answered (resume()).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createTasks } from "../listener/tasks.mjs";
import { testConfig } from "./helpers.mjs";

const config = testConfig();
const BOT = { login: "deckhand-x[bot]", type: "Bot" };
const QUESTIONS = "Do it.\n\n## Open questions\n\n1. Which one?";
const tickedBody = (box) =>
  `## Open questions\n\n1. Which one?\n   - [${box}] This one\n   - [ ] That one`;

// createTasks() whose policies allow every run, the repo's config `yaml`: the ctx, its log, its
// replies and settled comments. `issue`: what GitHub answers for org/repo#12 (resume());
// `permissions`: the logins' actions (permissions.mjs), none for every action.
function gate(yaml = "", { issue = null, ticksIgnored = false, permissions } = {}) {
  const logs = [];
  const replies = [];
  const settled = [];
  const { settings } = parseRepoConfig(yaml, config);
  const ctx = {
    config,
    log: (line) => logs.push(line),
    skip: (why) => (logs.push(why), null),
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {}, activate: () => null },
    runs: [],
    running: 0,
    run: () => {},
    titles: { set: () => {} },
    received: () => {},
    publicUrl: () => "https://hooks.example.com",
    reply: async (repo, number, text) => (replies.push(text), null),
    settle: async (item, status) => settled.push([item.comment?.id, status]),
    answer: async () => {},
    runner: { hasSession: async () => false },
    repoSettings: async () => ({ settings, errors: [] }),
    inputs: { ticksIgnored: () => ticksIgnored },
    waits: { reserve: () => null, release: async () => {}, request: async () => false },
    policies: { decide: async () => ({ applied: false, messages: [] }) },
    permissions,
    github: async () => (issue ? Response.json(issue) : new Response("", { status: 404 })),
  };
  const tasks = createTasks(ctx);
  // A comment by alice on issue 12, as the delivery has the issue (`issue`'s fields).
  const say = (body, issueFields = {}, id = 99) => {
    const payload = {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      issue: {
        number: 12,
        title: "An idea",
        state: "open",
        body: QUESTIONS,
        labels: [{ name: "needs-input" }],
        ...issueFields,
      },
      comment: { id, body, user: { login: "alice", type: "User" } },
      sender: { login: "alice" },
    };
    const first = {
      repo: "org/repo",
      id: "12",
      kind: "issue",
      base: "trunk",
      author: "alice",
      trigger: "work",
      replyTo: 12,
    };
    return tasks.admit(first, "issue_comment", payload);
  };
  // What is queued for #12, its timer cleared: [text, mode].
  const queued = () => {
    const task = ctx.tasks.get("org/repo#12");
    if (!task) return [];
    clearTimeout(task.timer);
    return task.pending.map((i) => [i.text, i.mode]);
  };
  return { ctx, logs, replies, settled, say, queued, ...tasks };
}

const HELD = "org/repo#12: not started, its open questions aren't answered";

test("wait_for_answers: a trigger line alone is held back, with a reply saying how to answer and 😕", async () => {
  const g = gate();
  await g.say("Deckhand\n/effort high");
  assert.deepEqual(g.queued(), []);
  assert.ok(g.logs.includes(HELD), g.logs.join("\n"));
  assert.equal(g.replies.length, 1);
  assert.match(g.replies[0], /^#12 has open questions: nothing starts until they are answered\./);
  assert.match(
    g.replies[0],
    /\(https:\/\/hooks\.example\.com\/#\/org\/repo\?task=org%2Frepo%2312\)/,
  );
  assert.match(g.replies[0], /`wait_for_answers: false` in `\.deckhand\.yaml` turns this off/);
  // The comment's outcome: 😕 (comments.mjs REACTIONS).
  assert.deepEqual(g.settled, [[99, "needs-input"]]);
});

test("wait_for_answers: text besides the trigger line is the answer: it starts, with that text alone", async () => {
  const g = gate();
  await g.say("Deckhand\n1. The first one");
  assert.deepEqual(g.queued(), [["1. The first one", "work"]]);
  assert.deepEqual([g.replies, g.settled], [[], []]);
});

// permissions.mjs's decide() giving alice `actions` alone (and some action, null, with any);
// `asked`: the actions asked.
function only(actions, asked = []) {
  return {
    decide: async (login, repo, action) => {
      asked.push(action);
      const ok = action === null ? actions.length > 0 : actions.includes(action);
      return login === "alice" && ok ? { ok: true } : { ok: false };
    },
  };
}

test("wait_for_answers: text from an author without runs:manage is no answer: held back, as a trigger line alone", async () => {
  const g = gate("", { permissions: only(["runs:start:work"]) });
  await g.say("Deckhand\n1. The first one");
  assert.deepEqual(g.queued(), []);
  assert.ok(
    g.logs.includes("org/repo#12: its answers refused, alice has no runs:manage here"),
    g.logs.join("\n"),
  );
  assert.ok(g.logs.includes(HELD), g.logs.join("\n"));
  assert.match(g.replies[0], /^#12 has open questions/);
  assert.deepEqual(g.settled, [[99, "needs-input"]]);
});

test("wait_for_answers: text from an author with runs:manage starts work; with neither it nor the start, nothing is said", async () => {
  const asked = [];
  const g = gate("", { permissions: only(["runs:start:work", "runs:manage"], asked) });
  await g.say("Deckhand\n1. The first one");
  assert.deepEqual(g.queued(), [["1. The first one", "work"]]);
  assert.ok(asked.includes("runs:manage"), asked.join());
  assert.deepEqual([g.replies, g.settled], [[], []]);

  // Held back, and no start either: no reply (permissions.mjs).
  const none = gate("", { permissions: only(["tasks:read"]) });
  await none.say("Deckhand\n1. The first one");
  assert.deepEqual([none.queued(), none.replies, none.settled], [[], [], []]);
});

test("wait_for_answers: no open questions: text needs no runs:manage", async () => {
  const asked = [];
  const g = gate("", { permissions: only(["runs:start:work"], asked) });
  await g.say("Deckhand\n1. The first one", { labels: [] });
  assert.deepEqual(g.queued(), [["1. The first one", "work"]]);
  assert.ok(!asked.includes("runs:manage"), asked.join());
});

test("wait_for_answers: a brainstorm still runs on an issue with open questions", async () => {
  const g = gate();
  await g.say("Deckhand /mode brainstorm");
  assert.deepEqual(
    g.queued().map(([, mode]) => mode),
    ["brainstorm"],
  );
  assert.deepEqual(g.replies, []);
});

test("wait_for_answers: false: a trigger line alone starts work on an issue with open questions", async () => {
  const g = gate("wait_for_answers: false\n");
  await g.say("Deckhand");
  assert.deepEqual(
    g.queued().map(([, mode]) => mode),
    ["work"],
  );
  assert.deepEqual(g.replies, []);
});

test("wait_for_answers: a trigger on an issue whose boxes are all ticked starts work; not labelled, too", async () => {
  const ticked = gate();
  await ticked.say("Deckhand", { body: tickedBody("x") });
  assert.deepEqual(
    ticked.queued().map(([, mode]) => mode),
    ["work"],
  );
  // Partly ticked: held back.
  const partly = gate();
  await partly.say("Deckhand", { body: tickedBody(" ") });
  assert.deepEqual(partly.queued(), []);
  assert.ok(partly.logs.includes(HELD));
  // The label off: nothing to wait for.
  const off = gate();
  await off.say("Deckhand", { labels: [] });
  assert.equal(off.queued().length, 1);
});

test("wait_for_answers: the bot's own ticks in its issue answer nothing: a trigger is held back", async () => {
  const g = gate();
  await g.say("Deckhand", { body: tickedBody("x"), user: BOT });
  assert.deepEqual(g.queued(), []);
  assert.ok(g.logs.includes(HELD), g.logs.join("\n"));
  assert.equal(g.replies.length, 1);
  assert.match(g.replies[0], /^#12 has open questions/);
});

test("wait_for_answers: ticks the listener ignored (the bot's, someone not allowed) on a person's issue: a trigger is held back", async () => {
  const g = gate("", { ticksIgnored: true });
  await g.say("Deckhand", { body: tickedBody("x"), user: { login: "alice", type: "User" } });
  assert.deepEqual(g.queued(), []);
  assert.ok(g.logs.includes(HELD), g.logs.join("\n"));
});

test("wait_for_answers: a run that stopped to ask isn't held back: any comment continues it", async () => {
  const g = gate();
  g.ctx.runs = [{ id: "r1", key: "org/repo#12", status: "needs-input" }];
  await g.say("Deckhand");
  assert.equal(g.queued().length, 1);
});

// A comment that waited for #77 (waits.mjs), its issue's questions as `issue` has them.
const waited = (settings) => ({
  repo: "org/repo",
  id: "12",
  kind: "issue",
  number: 12,
  replyTo: 12,
  author: "alice",
  base: "trunk",
  trigger: "work",
  text: "Do it.",
  eyes: true,
  comment: { id: 99, user: { login: "alice", type: "User" } },
  settings,
});

test("resume: a comment that waited, its issue's questions still open, waits for the answers; then it starts", async () => {
  const issue = { number: 12, state: "open", body: QUESTIONS, labels: [{ name: "needs-input" }] };
  const g = gate("", { issue });
  assert.equal(await g.resume(waited()), "answers");
  assert.ok(g.logs.includes("org/repo#12: not started yet, its open questions aren't answered"));
  assert.deepEqual(g.queued(), []);
  // Every box ticked, the label still on: answered.
  issue.body = tickedBody("x");
  assert.equal(await g.resume(waited()), true);
  assert.deepEqual(g.queued(), [["Do it.", "work"]]);
  // The label taken off, the questions as they were: answered too.
  const off = gate("", { issue: { ...issue, body: QUESTIONS, labels: [] } });
  assert.equal(await off.resume(waited()), true);
  // Not known (GitHub's 404): not unanswered, it starts.
  const unknown = gate();
  assert.equal(await unknown.resume(waited()), true);
  // wait_for_answers: false: it starts whatever the issue says.
  const free = gate("wait_for_answers: false\n", {
    issue: { ...issue, body: QUESTIONS },
  });
  assert.equal(await free.resume(waited()), true);
});
