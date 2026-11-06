// tasks.mjs admit() while GitHub fails the read of the repo's settings (#939): the comment is
// held, admitted again ADMIT_RETRY_MS later or behind a later comment on its task, and only
// after those tries is it dropped, its trigger told why.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubUnavailable } from "../listener/github.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { ADMIT_RETRY_MS, createTasks } from "../listener/tasks.mjs";
import { testConfig } from "./helpers.mjs";

const config = testConfig();
const PATH = "/repos/org/repo/contents/.deckhand.yaml?ref=trunk";
const DOWN = `GitHub returned 500 reading .deckhand.yaml of org/repo (GET ${PATH})`;

// createTasks() whose policies allow every run, its repo's settings read as `reads` says: each
// read takes the next of its answers ("down": GitHubUnavailable; anything else: the settings).
// `admissions`: the held comments' map, as the store gives it back to a copy taking over.
function gate({ reads = [], admissions = new Map() } = {}) {
  const logs = [];
  const replies = [];
  const { settings } = parseRepoConfig("", config);
  const ctx = {
    config,
    log: (line) => logs.push(line),
    skip: () => null,
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {}, activate: () => null },
    runs: [],
    running: 0,
    run: () => {},
    titles: { set: () => {} },
    received: () => {},
    reply: async (repo, number, text) => (replies.push(text), null),
    settle: async () => {},
    answer: async () => {},
    runner: { hasSession: async () => false },
    repoSettings: async () => {
      if (reads.shift() === "down")
        throw new GitHubUnavailable("GET", PATH, 500, "reading .deckhand.yaml of org/repo");
      return { settings, errors: [] };
    },
    inputs: { ticksIgnored: () => false },
    waits: { reserve: () => null, release: async () => {}, request: async () => false },
    policies: { decide: async () => ({ applied: false, messages: [] }) },
    admissions,
  };
  const tasks = createTasks(ctx);
  // Alice's comment `body` on issue 12; `trigger`: whether it calls Deckhand.
  const say = (body, { id = 99, trigger = true } = {}) =>
    tasks.admit(...delivery(body, id, trigger));
  // What is queued for #12, its timer cleared: the comments' texts.
  const queued = () => {
    const task = ctx.tasks.get("org/repo#12");
    if (!task) return [];
    clearTimeout(task.timer);
    return task.pending.map((i) => i.text);
  };
  return { ctx, logs, replies, say, queued, admissions, ...tasks };
}

// What admit() takes for alice's comment: the item the operator's checks found, the event and
// its payload.
function delivery(body, id = 99, trigger = true) {
  const payload = {
    action: "created",
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    issue: { number: 12, title: "An idea", state: "open", labels: [] },
    comment: { id, body, user: { login: "alice", type: "User" } },
    sender: { login: "alice" },
  };
  const first = {
    repo: "org/repo",
    id: "12",
    kind: "issue",
    base: "trunk",
    author: "alice",
    trigger: trigger ? "work" : null,
    replyTo: 12,
  };
  return [first, "issue_comment", payload];
}

// Until `done()` holds: what a timer's admission does goes on after the tick.
async function until(done) {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), "never happened");
}

test("GitHub failing the settings' read holds the comment, admitted once GitHub answers a minute later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const g = gate({ reads: ["down"] });
  await g.say("Deckhand\ndo it");
  assert.deepEqual([g.queued(), g.replies], [[], []]);
  assert.equal(g.admissions.size, 1);
  assert.ok(
    g.logs.includes(`org/repo#12: not queued yet, ${DOWN}: admitted again in 1 min`),
    g.logs.join("\n"),
  );
  t.mock.timers.tick(ADMIT_RETRY_MS[0] - 1);
  assert.deepEqual(g.queued(), []);
  t.mock.timers.tick(1);
  await until(() => g.queued().length);
  assert.deepEqual(g.queued(), ["do it"]);
  assert.equal(g.admissions.size, 0);
  assert.deepEqual(g.replies, []);
});

test("GitHub failing every try: the comment is dropped after them, its trigger told why", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const g = gate({ reads: Array(4).fill("down") });
  await g.say("Deckhand\ndo it");
  for (const [i, ms] of ADMIT_RETRY_MS.entries()) {
    assert.equal(g.admissions.size, 1);
    assert.equal([...g.admissions.values()][0].tries, i + 1);
    t.mock.timers.tick(ms);
    // The next try's line, or the reply.
    await until(() => g.logs.length === i + 2 || g.replies.length);
  }
  assert.equal(g.admissions.size, 0);
  assert.deepEqual(g.queued(), []);
  assert.ok(g.logs.includes(`org/repo#12: not queued, ${DOWN}, 4 tries`), g.logs.join("\n"));
  assert.deepEqual(g.replies, [`Not queued: ${DOWN}, 4 times. Comment again once GitHub answers.`]);
});

test("a comment without a trigger GitHub kept failing is dropped without a reply", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const g = gate({ reads: Array(4).fill("down") });
  await g.say("one more thing", { trigger: false });
  for (const [i, ms] of ADMIT_RETRY_MS.entries()) {
    t.mock.timers.tick(ms);
    await until(() => g.logs.length === i + 2);
  }
  assert.ok(g.logs.includes(`org/repo#12: not queued, ${DOWN}, 4 tries`), g.logs.join("\n"));
  assert.deepEqual([g.admissions.size, g.replies], [0, []]);
});

test("a later comment on the task admits those held before it, first", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const g = gate({ reads: ["down", "down", "down"] });
  await g.say("Deckhand\nfirst");
  // GitHub still down for both: the first keeps its try and its time, the second is held after it.
  await g.say("Deckhand\nsecond", { id: 100 });
  assert.deepEqual(g.queued(), []);
  const [first, second] = [...g.admissions.values()].sort((a, b) => a.at - b.at);
  assert.equal(first.tries, 1);
  assert.equal(first.dueAt, Date.now() + ADMIT_RETRY_MS[0]);
  assert.equal(second.payload.comment.id, 100);
  assert.ok(g.logs.includes(`org/repo#12: not queued yet, ${DOWN}: held still`), g.logs.join("\n"));
  // GitHub back for a third: the two held ones, in their order, then it.
  await g.say("Deckhand\nthird", { id: 101 });
  assert.deepEqual(g.queued(), ["first", "second", "third"]);
  assert.equal(g.admissions.size, 0);
  // Their timers went with them.
  t.mock.timers.tick(ADMIT_RETRY_MS[0]);
  await until(() => true);
  assert.deepEqual(g.queued(), ["first", "second", "third"]);
});

test("the comments held when a copy stops are admitted by the next one (startAdmissions())", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const before = gate({ reads: ["down"] });
  await before.say("Deckhand\ndo it");
  before.stopRetries();
  // As the store gives the map back: its values through JSON.
  const admissions = new Map(
    [...before.admissions].map(([id, h]) => [id, JSON.parse(JSON.stringify(h))]),
  );
  const g = gate({ admissions });
  g.startAdmissions();
  assert.ok(g.logs.includes("1 comment(s) held while GitHub failed, admitted again later"));
  t.mock.timers.tick(ADMIT_RETRY_MS[0]);
  await until(() => g.queued().length);
  assert.deepEqual(g.queued(), ["do it"]);
  assert.equal(admissions.size, 0);
});

test("another failure reading the settings is no hold: it throws, as before", async () => {
  const g = gate();
  g.ctx.repoSettings = async () => {
    throw new Error("reading .deckhand.yaml of org/repo: 403");
  };
  await assert.rejects(g.say("Deckhand\ndo it"), /403/);
  assert.equal(g.admissions.size, 0);
});
