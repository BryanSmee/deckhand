// runs.mjs's end of a run that answered with its inbox closed but whose sandbox goes on (#204):
// a fake runner whose sandbox never exits by itself, and a grace period of a few ms.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, fingerprintRedactor } from "../lib/fingerprints.mjs";
import { openStore } from "../lib/store.mjs";
import { createComments } from "../listener/comments.mjs";
import { RunError } from "../listener/access.mjs";
import { GitHubUnavailable } from "../listener/github.mjs";
import { createRuns, GITHUB_REQUEUE_MS, reopenedMode } from "../listener/runs.mjs";
import { openLog } from "../listener/runlog.mjs";
import { createStopped } from "../listener/stopped.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { recordingFetch, tempDir, testConfig, until } from "./helpers.mjs";

const result = (text) => JSON.stringify({ type: "result", result: text, duration_ms: 60000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A sandbox that runs until killed, its output written by the test (`out(line)`). `fails`: an
// error following it throws instead.
function fakeRunner(fails = null) {
  const runner = {
    running: true,
    kills: 0,
    closes: 0,
    onOut: null,
    exited: null,
    state: async () => (runner.running ? "running" : "exited"),
    // Past what was read before at once, unless `holding`: then when the test says (caughtUp()).
    holding: false,
    follow: (name, { onOut, onErr, onCaughtUp }) => {
      if (fails) return Promise.reject(fails);
      runner.onOut = onOut;
      runner.onErr = onErr;
      runner.caughtUp = onCaughtUp;
      if (!runner.holding) onCaughtUp?.();
      return new Promise((resolve) => (runner.exited = resolve));
    },
    kill: async () => {
      runner.kills++;
      runner.running = false;
      runner.exited?.();
    },
    close: () => runner.closes++,
    closed: () => false,
    remove: async () => {},
    out: (line, at) => runner.onOut(line, at),
    err: (line) => runner.onErr(line),
  };
  return runner;
}

function setup(
  t,
  {
    mode = "idea",
    graceMs = 60,
    tokens = [],
    scrubs = [],
    config = {},
    answer,
    fails,
    githubStatus,
  } = {},
) {
  const dir = tempDir(t);
  const runner = fakeRunner(fails);
  const answers = [];
  const logs = [];
  const done = [];
  const settled = [];
  const store = openStore("memory:");
  t.after(() => store.close());
  const ctx = {
    config: { ...testConfig(), ...config },
    log: (line) => logs.push(line),
    logDir: dir,
    shotsDir: dir,
    answerGraceMs: graceMs,
    runner,
    running: 1,
    stopping: false,
    runs: [],
    tasks: new Map(),
    // The runs' summaries (runlog.mjs saveSummary()).
    store,
    broker: {
      runOf: () => ({ tokens: new Set(tokens), scrubs }),
      secretsOf: () => [],
      revoke: () => {},
    },
    onboarded: { isIssue: () => false },
    brainstorms: { replied: () => {} },
    saveLive: async () => {},
    removeLive: async () => true,
    // An inbox entry's run takes no more comments.
    deliver: () => false,
    answer: answer ?? (async (_, text) => answers.push(text)),
    publicUrl: () => "https://deck.example",
    label: async () => {},
    track: () => {},
    settle: (item, status) => settled.push(status),
    startLater: () => {},
    schedule: () => done.push(true),
    // GitHub's own status, as the github service last read it (#943).
    githubStatus,
  };
  const runs = createRuns(ctx);
  const key = "org/repo#12";
  const logPath = join(dir, "run.log");
  const task = {
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
    name: "deckhand-org-repo-12",
    pending: [],
    next: {},
    running: true,
    settings: null,
  };
  task.live = {
    id: "run",
    key,
    mode,
    talk: false,
    light: true,
    record: { id: "run", key, agent: "claude", model: "opus", effort: "medium", startedAt: 0 },
    logFile: openLog(logPath),
    secret: "s3cret",
    replyTo: { kind: "issue", number: 12 },
    asked: { kind: "issue", number: 12 },
    open: true,
    replied: false,
    lines: { out: 0, err: 0 },
    result: null,
    later: {},
    unanswered: [],
    handled: [],
    cancelled: null,
    answered: false,
  };
  task.live.record.logPath = logPath;
  ctx.tasks.set(key, task);
  const following = runs.follow(task);
  return { ctx, runs, runner, task, answers, logs, done, settled, following, logPath };
}

// #414: a time before each line with a tool call or output, the agent's lines as it wrote them.
test("a run's log: when each tool call, output and message came, before its line", (t) => {
  const { runner, logPath } = setup(t);
  const assistant = (content) => JSON.stringify({ type: "assistant", message: { content } });
  const call = assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]);
  const output = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] },
  });
  const text = assistant([{ type: "text", text: "Looking." }]);
  runner.out("npm ci", 500);
  runner.out("added 1 package", 900);
  runner.out(text, 1000);
  runner.out(call, 2000);
  runner.out(output, 14000);
  // Plain lines (#719): an `at` line as a run of them starts, the agent's last line in the
  // same second, then once a second at most: the reader gives the next ones that time.
  runner.out("warn: deprecated", 14100);
  runner.out("warn: deprecated", 14900);
  runner.out("warn: deprecated", 15000);
  // Without Docker's time (an older engine, say), none.
  runner.out(call, null);
  // Its phases apart: its first event starts its work.
  const lines = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter((l) => !l.includes('"event":"phase"'));
  const at = (ms) => JSON.stringify({ type: "listener", event: "at", at: ms });
  assert.deepEqual(lines.slice(-15), [
    at(500),
    "npm ci",
    "added 1 package",
    at(1000),
    text,
    at(2000),
    call,
    at(14000),
    output,
    at(14100),
    "warn: deprecated",
    "warn: deprecated",
    at(15000),
    "warn: deprecated",
    call,
  ]);
});

test("a run that answered, its inbox closed, and stays silent: stopped, its answer posted", async (t) => {
  const { runner, answers, logs, following, logPath, task } = setup(t);
  runner.out(result("Nothing to decide."));
  // Background turns: each result is the answer so far.
  runner.out(result("I filed #195 and its sub-issues."));
  assert.equal(task.live.answered, true);
  assert.equal(runner.closes, 1);
  await following;
  assert.equal(runner.kills, 1);
  assert.equal(answers.length, 1);
  assert.match(answers[0], /^I filed #195 and its sub-issues\.\n\n<sub>🤖 Claude opus/);
  assert.doesNotMatch(answers[0], /Stopped by/);
  assert.ok(logs.some((l) => /Silent for 0 min after its answer: stopped/.test(l)));
  assert.ok(logs.some((l) => /done \(ok\)/.test(l)));
  assert.match(readFileSync(logPath, "utf8"), /"event":"ended",.*"after":60/);
});

test("a CI fix run that is over: the reviews get its outcome and the reruns it made", async (t) => {
  const { ctx, runner, task, following } = setup(t, { mode: "work" });
  const fixed = [];
  ctx.reviews = { runEnded: () => {}, ciFixed: async (run) => fixed.push(run) };
  task.base = "trunk";
  task.live.light = false;
  task.live.handled = [{ reason: "ci-fix", replyTo: 5 }];
  // What the GitHub gateway kept of the run's reruns (github-writes.mjs answered()).
  task.live.reruns = [{ run_id: 7, sha: "sha-1", at: 1 }];
  runner.out(result("Reran the flaky job."));
  await runner.kill();
  await following;
  assert.deepEqual(fixed, [
    {
      repo: "org/repo",
      number: 5,
      base: "trunk",
      status: "ok",
      reruns: [{ run_id: 7, sha: "sha-1", at: 1 }],
    },
  ]);
});

// A run's end (cleanUp()), the reviews recording what they hear: `handled`, what it answered.
async function endRun(t, handled) {
  const { ctx, runner, task, following } = setup(t, { mode: "work" });
  const heard = [];
  ctx.reviews = {
    runEnded: (repo) => heard.push(["runEnded", repo]),
    fixed: async (run) => heard.push(["fixed", run]),
    ciFixed: async (run) => heard.push(["ciFixed", run]),
    rebased: async (run) => heard.push(["rebased", run]),
  };
  task.base = "trunk";
  task.live.light = false;
  task.live.handled = handled;
  runner.out(result("Done."));
  await runner.kill();
  await following;
  return heard;
}

test("a run's end: the CI step told of any run, a review's fix run's outcome to fixed()", async (t) => {
  // An ordinary run: its repo's CI waits decided again (a CI fix run may wait for the task).
  assert.deepEqual(await endRun(t, []), [["runEnded", "org/repo"]]);
  // A review's fix run, replying on #13: its outcome, for the review of what it pushed.
  assert.deepEqual(await endRun(t, [{ reason: "review-fix", replyTo: 13 }]), [
    ["fixed", { repo: "org/repo", number: 13, base: "trunk", status: "ok" }],
    ["runEnded", "org/repo"],
  ]);
  // A conflict run, rebasing #13 from head-1: the loop goes on from what it pushed (#896).
  assert.deepEqual(await endRun(t, [{ reason: "conflict", replyTo: 13, rebaseFrom: "head-1" }]), [
    ["rebased", { repo: "org/repo", number: 13, base: "trunk", status: "ok", from: "head-1" }],
    ["runEnded", "org/repo"],
  ]);
});

// A review run's end (cleanUp()): its posted review to settle(), for its fix run or merge.
// `reason`: the answered item's ("review": the listener's own, which may merge; none: a comment's);
// `line`, its result.
const CHANGES = `A redelivery starts a second run.

## Findings

- **high** \`listener/reviews.mjs:42\`: a redelivery starts a second run. Fix: check the head.

Rating: 5/10
Verdict: request-changes
`;

async function endReview(t, reason, line = result(CHANGES)) {
  const { ctx, runner, task, following } = setup(t, { mode: "review" });
  const heard = [];
  const pr = { number: 13, head: { sha: "sha-2" }, base: { repo: { html_url: "https://x" } } };
  // Every write accepted: postReview()'s 422 fallbacks are reviews.test.mjs's.
  ctx.github = async (repo, method, path, body) => {
    heard.push([method, path, body?.commit_id]);
    return method === "GET" ? Response.json(pr) : Response.json({ id: 1 });
  };
  ctx.reviews = {
    tolerance: async () => "low",
    runEnded: (repo) => heard.push(["runEnded", repo]),
    settle: async (run, posted) => heard.push(["settle", run, posted]),
  };
  task.base = "trunk";
  task.live.replyTo = 13;
  task.live.reviewFrom = "sha-1";
  task.live.handled = [{ ...(reason && { reason }), replyTo: 13 }];
  runner.out(line);
  await runner.kill();
  await following;
  return heard;
}

test("a review run's end: settle() gets the review it posted, its own only for a fix or merge", async (t) => {
  for (const [reason, auto] of [
    ["review", true],
    // A "/mode review" comment's item, which has no reason.
    [undefined, false],
  ]) {
    const heard = await endReview(t, reason);
    const [get, post, settle, ended] = heard;
    assert.deepEqual(get, ["GET", "/repos/org/repo/pulls/13", undefined]);
    // Posted at the commit the run reviewed, not the head a push moved since.
    assert.deepEqual(post, ["POST", "/repos/org/repo/pulls/13/reviews", "sha-1"]);
    assert.equal(settle[0], "settle");
    assert.deepEqual(settle[1], {
      repo: "org/repo",
      number: 13,
      base: "trunk",
      settings: null,
      auto,
    });
    assert.equal(settle[2].event, "REQUEST_CHANGES");
    assert.equal(settle[2].review.verdict, "request-changes");
    assert.equal(settle[2].head, "sha-1");
    assert.deepEqual(settle[2].pr, {
      number: 13,
      head: { sha: "sha-2" },
      base: { repo: { html_url: "https://x" } },
    });
    assert.deepEqual(ended, ["runEnded", "org/repo"]);
    assert.equal(heard.length, 4);
  }
  // A review run that failed posts no review, and its end (reached) has nothing to settle.
  const failed = JSON.stringify({ type: "result", is_error: true, result: "Overloaded." });
  assert.deepEqual(await endReview(t, "review", failed), [["runEnded", "org/repo"]]);
});

test("any run's end asks for the next pick at once: an auto-picked one's slot, or its repo's", async (t) => {
  for (const autoPickup of [true, false]) {
    const { ctx, runner, task, following } = setup(t, { mode: "work" });
    let asked = 0;
    ctx.autoPickup = { soon: () => asked++ };
    task.live.light = false;
    if (autoPickup) task.live.record.autoPickup = true;
    runner.out(result("Done."));
    await runner.kill();
    await following;
    assert.equal(asked, 1);
  }
});

test("a queued auto-picked task cancelled frees its reserved slot: the next pick at once", async (t) => {
  const { ctx, runs, runner, following } = setup(t, { mode: "work" });
  let asked = 0;
  ctx.autoPickup = { soon: () => asked++ };
  const queued = (id, item) => {
    const task = { repo: "org/repo", id, kind: "issue", number: Number(id), pending: [item] };
    Object.assign(task, { running: false, ready: true, timer: null, live: null, next: {} });
    ctx.tasks.set(`org/repo#${id}`, task);
  };
  queued("13", { mode: "work", replyTo: 13, autoPickup: true });
  queued("14", { mode: "work", replyTo: 14 });
  assert.equal(runs.cancel("org/repo#14", "alice"), "queued");
  assert.equal(asked, 0);
  assert.equal(runs.cancel("org/repo#13", "alice"), "queued");
  assert.equal(asked, 1);
  await runner.kill();
  await following;
});

test("unqueue: a queued task's latest comment leaves the queue for a wait, the others settled", async (t) => {
  const { ctx, runs, runner, settled, following } = setup(t, { mode: "work" });
  let asked = 0;
  ctx.autoPickup = { soon: () => asked++ };
  const dropped = [];
  ctx.order = { drop: (key) => dropped.push(key) };
  const queued = (id, pending, extra = {}) => {
    const task = { repo: "org/repo", id, kind: "issue", number: Number(id), pending };
    Object.assign(task, { running: false, ready: true, timer: null, live: null, next: {} });
    ctx.tasks.set(`org/repo#${id}`, Object.assign(task, extra));
    return task;
  };
  const item = (text, extra = {}) => ({
    kind: "issue",
    author: "alice",
    trigger: "work",
    mode: "work",
    text,
    queuedAt: 1,
    queueId: "q",
    ...extra,
  });
  const task = queued("13", [
    item("first", { autoPickup: true }),
    item("second", { modeLine: "review" }),
  ]);
  assert.equal(runs.queuedTask("org/repo#13").item.text, "second");
  // Both alice's: none that unqueue() would drop.
  assert.equal(runs.queuedTask("org/repo#13").others, false);
  const latest = runs.unqueue("org/repo#13", "alice");
  // Every queued comment's text, as the run would have read them.
  assert.deepEqual(latest, {
    item: {
      kind: "issue",
      author: "alice",
      trigger: "work",
      text: "first\n\n---\n\nsecond",
      modeLine: "review",
    },
    dropped: 0,
    // Their queueIds, which go with the wait (waits.mjs hold()).
    unqueued: ["q", "q"],
  });
  assert.deepEqual(task.pending, []);
  assert.deepEqual(settled, ["cancelled"]);
  assert.deepEqual(dropped, ["org/repo#13"]);
  // An auto-picked one's slot is free again.
  assert.equal(asked, 1);
  assert.equal(runs.unqueue("org/repo#13", "alice"), null);
  // A follow-up behind a run going (or ending), a reply that starts nothing, a pull request's:
  // they stay.
  queued("14", [item("more")], { running: true });
  queued("15", [item("reply", { trigger: null })]);
  queued("16", [item("pr", { kind: "pr" })]);
  for (const id of ["14", "15", "16"]) {
    // Waiting for a slot with replies only: queued, but nothing to wait.
    const replies = {
      14: null,
      15: { item: null, replies: true, others: false },
      16: { item: null, replies: false, others: false },
    };
    assert.deepEqual(runs.queuedTask(`org/repo#${id}`), replies[id]);
    assert.equal(runs.unqueue(`org/repo#${id}`, "alice"), null);
    assert.equal(ctx.tasks.get(`org/repo#${id}`).pending.length, 1);
  }
  // An inbox entry or a wrap-up: nothing to wait, and not replies either.
  queued("19", [item("an idea", { trigger: "idea" })]);
  queued("20", [item("", { trigger: "stop", mode: "stop" })]);
  for (const id of ["19", "20"]) {
    assert.deepEqual(runs.queuedTask(`org/repo#${id}`), {
      item: null,
      replies: false,
      others: false,
    });
  }
  // A trigger, then a plain comment while it waited: the trigger waits, with both texts; the
  // follow-up's 👀 goes.
  const trigger = item("do it", { modeLine: "review", comment: { id: 1 } });
  const reply = item("and this too", { trigger: null, comment: { id: 2 } });
  const both = queued("17", [trigger, reply]);
  assert.equal(runs.queuedTask("org/repo#17").item, trigger);
  const { item: held, dropped: none } = runs.unqueue("org/repo#17", "alice");
  assert.equal(none, 0);
  assert.equal(held.comment.id, 1);
  assert.equal(held.modeLine, "review");
  assert.equal(held.text, "do it\n\n---\n\nand this too");
  assert.deepEqual(both.pending, []);
  assert.deepEqual(settled, ["cancelled", "cancelled"]);
  // Another author's comments don't go with it (the wait has one author, whom the run's checks
  // see): dropped and counted. The held one's author in another case is the same login.
  queued("18", [
    item("from alice", { comment: { id: 3 } }),
    item("from bob", { trigger: null, author: "bob", comment: { id: 4 } }),
    item("alice again", { trigger: null, author: "Alice", comment: { id: 5 } }),
  ]);
  // What queuedTask() says of it, for the dashboard's check (work.mjs requeue()).
  assert.equal(runs.queuedTask("org/repo#18").others, true);
  const mixed = runs.unqueue("org/repo#18", "alice");
  assert.equal(mixed.dropped, 1);
  assert.equal(mixed.item.author, "alice");
  assert.equal(mixed.item.text, "from alice\n\n---\n\nalice again");
  assert.deepEqual(settled.slice(2), ["cancelled", "cancelled"]);
  // Moved to a wait (`until`: once the wait is in the store): its comments are parked in the
  // queue's writes (restart.mjs park()) before the write that drops them, their queueIds out.
  const order = [];
  ctx.park = (task, items, until) => order.push(["park", task.id, items.map((i) => i.text), until]);
  ctx.saveQueue = () => order.push(["save"]);
  queued("21", [
    item("one", { queueId: "q-21" }),
    item("two", { trigger: null, author: "bob", queueId: "q-22" }),
  ]);
  const until = Promise.resolve();
  const parked = runs.unqueue("org/repo#21", "alice", until);
  assert.deepEqual(parked.unqueued, ["q-21", "q-22"]);
  assert.deepEqual(order, [["park", "21", ["one", "two"], until], ["save"]]);
  // Cancelled, the one behind a run says so: it isn't back in the backlog.
  assert.equal(runs.cancel("org/repo#14", "alice"), "following");
  assert.equal(runs.cancel("org/repo#15", "alice"), "queued");
  await runner.kill();
  await following;
});

test("a chat's run (#476): its inbox stays open between answers, its idle rest stops it, nothing posted", async (t) => {
  const { ctx, runs, runner, task, answers, settled, following } = setup(t, {
    mode: "chat",
    graceMs: 30,
  });
  Object.assign(task, { kind: "chat", id: "chat-0123456789abcdef", number: null });
  task.live.handled = [{ kind: "chat", author: "alice", text: "hi" }];
  task.pool = "chats";
  ctx.pools = new Map([["chats", 1]]);
  ctx.running = 0;
  let deliveries = 0;
  ctx.deliver = () => (deliveries++, false);
  runner.out(result("run() starts a run."));
  // Nothing more to send: the sandbox still waits for the user's next message.
  assert.equal(deliveries, 1);
  assert.equal(runner.closes, 0);
  assert.equal(task.live.open, true);
  assert.equal(task.live.answered, false);
  await sleep(60);
  assert.equal(runner.kills, 0);
  // CHAT_IDLE_MINUTES later (chats.mjs): its inbox closes, and as it said all it had to, its
  // sandbox stops after the grace if it doesn't exit by itself.
  assert.equal(runs.rest(task), true);
  assert.equal(runner.closes, 1);
  assert.equal(task.live.answered, true);
  await following;
  assert.equal(runner.kills, 1);
  // Its answers are in its log, which its owner reads: no reply, no reaction.
  assert.deepEqual(answers, []);
  assert.deepEqual(settled, ["ok"]);
  assert.equal(ctx.pools.get("chats"), 0);
  assert.equal(ctx.running, 0);
});

test("a restored chat whose inbox isn't known open (the runner didn't answer): its idle rest still closes it, and stops it", async (t) => {
  const { runs, runner, task, answers, following } = setup(t, { mode: "chat", graceMs: 30 });
  Object.assign(task, { kind: "chat", id: "chat-0123456789abcdef", number: null });
  // restart.mjs restoreRuns(): `closed()` threw, `open` left false; it had answered.
  Object.assign(task.live, { open: false, result: { ok: true, text: "Done.", durationMs: 1 } });
  assert.equal(runs.rest(task), true);
  assert.equal(runner.closes, 1, "closed at the runner all the same");
  assert.equal(task.live.answered, true);
  // Once: it lingers now.
  assert.equal(runs.rest(task), false);
  await following;
  assert.equal(runner.kills, 1);
  assert.deepEqual(answers, []);
});

test("a chat's run resting while its agent works: its inbox closes, it answers and exits", async (t) => {
  const { runs, runner, task, answers, following } = setup(t, { mode: "chat", graceMs: 30 });
  Object.assign(task, { kind: "chat", id: "chat-0123456789abcdef", number: null });
  task.live.unanswered = [{ text: "a long one" }];
  assert.equal(runs.rest(task), true);
  assert.equal(task.live.answered, false);
  runner.out(result("Done with the long one."));
  assert.equal(task.live.answered, true);
  await following;
  assert.equal(runner.kills, 1);
  assert.deepEqual(answers, []);
  // Nothing to rest once it ends.
  assert.equal(runs.rest(task), false);
});

test("output after the answer postpones its stop", async (t) => {
  const { runner, answers, following } = setup(t, { graceMs: 80 });
  // The test's clock: a pause between a line and the next 40 ms wait (a busy runner's) would
  // otherwise let the grace end first (#563).
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  runner.out(result("A first answer."));
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(40);
    runner.out(JSON.stringify({ type: "assistant", message: { content: [] } }));
  }
  // 160 ms after the result, twice the grace: still running, as it wrote meanwhile.
  assert.equal(runner.kills, 0);
  runner.out(result("The final answer."));
  t.mock.timers.tick(79);
  assert.equal(runner.kills, 0);
  t.mock.timers.tick(1);
  await following;
  assert.equal(runner.kills, 1);
  assert.match(answers[0], /^The final answer\./);
});

test("a grace timer that fires before its deadline by the wall clock waits for what's left", async (t) => {
  const { runner, task, following } = setup(t, { graceMs: 80 });
  // Two clocks, as Node has: the timers' (monotonic) and Date.now()'s (the wall's), which the
  // deadline is saved on. A mocked Date would move with the timers.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let wall = 10_000;
  t.mock.method(Date, "now", () => wall);
  runner.out(result("Answered."));
  assert.equal(task.live.graceUntil, 10_080);
  // The timer fires with the wall clock 2 ms short of the deadline (whole milliseconds on
  // clocks that tick apart, #563's hosted runners): no stop yet.
  wall = 10_078;
  t.mock.timers.tick(80);
  // Whatever its timer started settles (setImmediate isn't mocked).
  await new Promise(setImmediate);
  assert.equal(runner.kills, 0);
  wall = 10_080;
  t.mock.timers.tick(2);
  await following;
  assert.equal(runner.kills, 1);
});

test("a run whose inbox is still open isn't stopped after a result", async (t) => {
  const { ctx, runner, task } = setup(t, { graceMs: 20 });
  ctx.deliver = () => true;
  runner.out(result("Answered; a comment was delivered meanwhile."));
  await sleep(60);
  assert.equal(task.live.answered, false);
  assert.equal(runner.kills, 0);
  runner.kill();
});

test("a sandbox that exits on its own after its answer: no stop", async (t) => {
  const { runner, answers, following } = setup(t, { graceMs: 30 });
  runner.out(result("Done."));
  runner.running = false;
  runner.exited();
  await following;
  await sleep(60);
  assert.equal(runner.kills, 0);
  assert.equal(answers.length, 1);
});

test("a Stop after the answer posts it with the Stopped by line", async (t) => {
  const { runs, runner, answers, logs, following } = setup(t, { graceMs: 5000 });
  runner.out(result("I filed #195."));
  assert.equal(runs.cancel("org/repo#12", "bryansmee"), "running");
  await following;
  assert.equal(answers.length, 1);
  assert.match(answers[0], /^I filed #195\.\n\nStopped by @bryansmee after its answer\.\n\n<sub>/);
  assert.ok(logs.some((l) => /done \(cancelled\)/.test(l)));
});

test("a Stop marks the task stopped, and holds what was queued behind it at its end (#1003)", async (t) => {
  const { ctx, runs, runner, task, following } = setup(t, { graceMs: 5000 });
  ctx.stopped = createStopped();
  const held = [];
  const later = [];
  ctx.holdStopped = (task) => held.push(...task.pending.splice(0));
  ctx.startLater = (task) => later.push(task.id);
  runner.out(result("Half way."));
  task.pending.push({ repo: "org/repo", id: "12", text: "And this too." });
  assert.equal(runs.cancel("org/repo#12", "bryansmee"), "running");
  // At once, before its sandbox is gone: a comment meanwhile doesn't go on in its session.
  assert.equal(ctx.stopped.get("org/repo#12").by, "bryansmee");
  await following;
  assert.deepEqual([held.map((i) => i.text), later], [["And this too."], []]);
});

test("a task stopped and queued no more: a Stop drops the comments held since (#1003)", async (t) => {
  const { ctx, runs, task, settled, following } = setup(t, { graceMs: 5000 });
  runs.cancel("org/repo#12", "bryansmee");
  await following;
  assert.equal(task.live, null);
  settled.length = 0;
  task.onHold = [{ text: "Held." }];
  ctx.saveQueue = () => {};
  assert.equal(runs.cancel("org/repo#12", "bryansmee"), "queued");
  assert.deepEqual([task.onHold, settled], [[], ["cancelled"]]);
  assert.equal(runs.cancel("org/repo#12", "bryansmee"), null);
});

test("a run's end counted with its outcome (deckhand_runs_finished_total)", async (t) => {
  for (const [stop, outcome] of [
    [false, "ok"],
    [true, "cancelled"],
  ]) {
    // Silent after its answer, it is stopped once its grace ends (60 ms): an ok run.
    const { ctx, runs, runner, following } = setup(t, { graceMs: stop ? 5000 : 60 });
    const ended = [];
    ctx.metrics = { runFinished: (live) => ended.push([live.mode, live.record.status]) };
    runner.out(result("Done."));
    if (stop) runs.cancel("org/repo#12", "bryansmee");
    await following;
    assert.deepEqual(ended, [["idea", outcome]]);
  }
});

test("a Stop before any answer: the short reply", async (t) => {
  const { ctx, runs, answers, following } = setup(t, { graceMs: 5000 });
  ctx.deliver = () => true;
  // A result with its inbox still open: not the final answer.
  ctx.runner.out(result("Half way."));
  runs.cancel("org/repo#12", "bryansmee");
  await following;
  assert.match(answers[0], /^Stopped by @bryansmee\.\n\n<sub>/);
});

test("a run that answered before a restart: what was left of its grace, when it is followed", async (t) => {
  const { ctx, runner, task, following } = setup(t, { graceMs: 300 });
  runner.out(result("Answered before the restart."));
  const { graceUntil } = task.live;
  assert.ok(graceUntil > Date.now());
  // The next listener's: the same saved state, a runner without the old timer, and a grace of
  // its own far longer. The deadline saved holds.
  ctx.stopping = true;
  runner.exited();
  await following;
  ctx.stopping = false;
  const next = createRuns({ ...ctx, answerGraceMs: 60_000, catchUpMs: 20 });
  await next.follow(task);
  assert.equal(runner.kills, 1);
  assert.ok(Date.now() >= graceUntil);
  assert.ok(Date.now() < graceUntil + 5000);
});

test("a restored run's grace waits for the follow to skip what was read before", async (t) => {
  const { ctx, runner, task, following } = setup(t, { graceMs: 30 });
  runner.out(result("Answered before the restart."));
  ctx.stopping = true;
  runner.exited();
  await following;
  ctx.stopping = false;
  // Its deadline long gone, and a log long to skip.
  task.live.graceUntil = Date.now() - 60_000;
  runner.holding = true;
  const next = createRuns({ ...ctx, answerGraceMs: 10_000, catchUpMs: 20 });
  const followed = next.follow(task);
  await sleep(150);
  // Still skipping: its whole grace meanwhile.
  assert.equal(runner.kills, 0);
  // Past them, nothing new: the moment to read what came meanwhile, then stopped, well before
  // its whole grace.
  const at = Date.now();
  runner.caughtUp();
  await followed;
  assert.equal(runner.kills, 1);
  assert.ok(Date.now() - at < 5000);
});

test("a run whose grace passed while no listener was there: what its sandbox wrote meanwhile is read before any stop", async (t) => {
  const { ctx, runner, task, following } = setup(t, { graceMs: 30 });
  runner.out(result("Answered before the restart."));
  ctx.stopping = true;
  runner.exited();
  await following;
  ctx.stopping = false;
  // Its deadline long gone; its sandbox went on (a background task's turn).
  task.live.graceUntil = Date.now() - 60_000;
  // A grace well past the waits below: with 200 ms, a runner pausing 50 ms stopped it first.
  const next = createRuns({ ...ctx, answerGraceMs: 1000, catchUpMs: 100 });
  const followed = next.follow(task);
  // The follow's backlog: a line written while no listener was there.
  await sleep(30);
  runner.out(JSON.stringify({ type: "assistant", message: { content: [] } }));
  await sleep(150);
  assert.equal(runner.kills, 0);
  // Silent for its grace from that line on: stopped then.
  await followed;
  assert.equal(runner.kills, 1);
});

test("a run that answered before a restart, saved before its grace's deadline was: all of it again", async (t) => {
  const { ctx, runner, task, following } = setup(t, { graceMs: 5000 });
  runner.out(result("Answered before the restart."));
  ctx.stopping = true;
  runner.exited();
  await following;
  ctx.stopping = false;
  delete task.live.graceUntil;
  const next = createRuns({ ...ctx, answerGraceMs: 30 });
  await next.follow(task);
  assert.equal(runner.kills, 1);
});

test("the lines a run's output adds are saved with it a second later at most", async (t) => {
  const saves = [];
  const { ctx, runner, task } = setup(t);
  ctx.saveLiveSoon = (saved) => saves.push(saved.live.lines.out);
  runner.out(JSON.stringify({ type: "assistant" }));
  runner.out(JSON.stringify({ type: "assistant" }));
  assert.deepEqual(saves, [1, 2]);
  assert.equal(task.live.lines.out, 2);
});

test("the GitHub tokens the broker gave the run are redacted from its log and its reply", async (t) => {
  // One the broker issued (any shape), and one in GitHub's from elsewhere.
  const issued = "v1.0123456789abcdef0123456789abcdef";
  const other = "ghs_" + "Q".repeat(36);
  const { runner, answers, following, logPath } = setup(t, { tokens: [issued] });
  runner.out(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: `gh auth token: ${issued}\n$ gh auth token\n${other}` }],
      },
    }),
  );
  runner.out(result(`Mine is ${issued}, and I found ${other}.`));
  await following;
  assert.match(answers[0], /^Mine is \[redacted\], and I found \[redacted\]\./);
  const log = readFileSync(logPath, "utf8");
  assert.ok(!log.includes(issued) && !log.includes(other));
  // The raw line has `\n` before the second: still redacted (no word boundary needed).
  assert.match(log, /gh auth token: \[redacted\]\\n\$ gh auth token\\n\[redacted\]/);
});

test("the installation tokens the github service used: redacted from the log and reply by their fingerprints", async (t) => {
  const used = "v1.fedcba9876543210fedcba9876543210";
  const scrubs = [fingerprintRedactor(fingerprint([used]))];
  const { runner, answers, following, logPath } = setup(t, { scrubs });
  runner.out(result(`It was ${used}.`));
  await following;
  assert.match(answers[0], /^It was \[redacted\]\./);
  assert.ok(!readFileSync(logPath, "utf8").includes(used));
});

// #241: output without end (setup's, an agent's) would fill the data volume.
test("a run whose output passes RUN_LOG_MAX_MB: stopped, failed, a note in its log", async (t) => {
  const { ctx, runner, task, answers, logs, following, logPath } = setup(t, {
    config: { runLogMax: 1000 },
  });
  const live = task.live;
  for (let i = 0; i < 20; i++) runner.err("x".repeat(99));
  // Past the cap, nothing more is written, its result neither.
  runner.out(result("Done."));
  await following;
  assert.equal(runner.kills, 1);
  assert.equal(live.record.status, "error");
  assert.equal(
    live.record.summary,
    "Stopped as failed: its output passed RUN_LOG_MAX_MB (0 MB), the rest of it not kept",
  );
  assert.equal(answers.length, 1);
  assert.match(answers[0], /^Claude was stopped as failed: its output passed RUN_LOG_MAX_MB/);
  const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
  assert.equal(lines.filter((l) => l.startsWith("x")).length, 10);
  assert.match(JSON.parse(lines.at(-1)).message, /passed RUN_LOG_MAX_MB/);
  assert.ok(!lines.some((l) => l.includes("Done.")));
  // Every line counts as read: a restart doesn't read the dropped ones again.
  assert.deepEqual(live.lines, { out: 1, err: 20 });
  assert.ok(logs.some((l) => /: Stopped as failed: its output passed/.test(l)));
  assert.equal(ctx.running, 0);
});

test("a run that answered, then passed RUN_LOG_MAX_MB: its answer posted, as failed", async (t) => {
  const { runner, task, answers, following } = setup(t, {
    graceMs: 5000,
    config: { runLogMax: 1000 },
  });
  const live = task.live;
  runner.out(result("I filed #195."));
  assert.equal(live.answered, true);
  // A background task's output, without end.
  for (let i = 0; i < 20; i++) runner.err("x".repeat(99));
  await following;
  assert.equal(runner.kills, 1);
  assert.equal(live.record.status, "error");
  assert.equal(answers.length, 1);
  assert.match(
    answers[0],
    /^I filed #195\.\n\nClaude was stopped as failed after its answer: its output passed RUN_LOG_MAX_MB \(0 MB\), the rest of it not kept\.\n\n<sub>🤖 Claude/,
  );
});

test("a run that passed RUN_LOG_MAX_MB with a comment unanswered: the next run gets it", async (t) => {
  const { runner, task, following } = setup(t, { config: { runLogMax: 1000 } });
  const comment = { id: "c1", text: "And the tests?" };
  task.live.unanswered = [comment];
  for (let i = 0; i < 20; i++) runner.err("x".repeat(99));
  await following;
  assert.deepEqual(task.pending, [comment]);
});

// The run's reply through comments.mjs, GitHub answering its POSTs with `statuses` in turn.
function replyingWith(statuses) {
  const left = [...statuses];
  const { fetch, calls } = recordingFetch(() => new Response("{}", { status: left.shift() }));
  const github = (repo, method, path, body) =>
    fetch(`https://api.github.com${path}`, { method, body: JSON.stringify(body) });
  const comments = createComments({ config: {}, github, log: () => {}, delays: [0, 0] });
  const bodies = () => calls.map((c) => JSON.parse(c.body).body);
  return { answer: comments.answer, bodies };
}

async function endWith(t, statuses, text, githubStatus) {
  const github = replyingWith(statuses);
  const run = setup(t, { graceMs: 30, answer: github.answer, githubStatus });
  const live = run.task.live;
  live.handled.push({ comment: { id: 7 } });
  run.runner.out(result(text));
  run.runner.running = false;
  run.runner.exited();
  await run.following;
  await sleep(20);
  return { ...run, live, bodies: github.bodies };
}

test("a reply refused as too long is posted shortened: then 🚀", async (t) => {
  const { settled, bodies, live } = await endWith(t, [422, 201], "z".repeat(30000));
  assert.equal(bodies().length, 2);
  assert.match(
    bodies()[1],
    /\[on the dashboard\]\(https:\/\/deck\.example\/#\/org\/repo\?task=org%2Frepo%2312&run=run\)/,
  );
  assert.deepEqual(settled, ["ok"]);
  assert.equal(live.replied, true);
  assert.equal(live.record.status, "ok");
});

test("a reply GitHub keeps refusing: the run fails, 👎, and says why", async (t) => {
  const { settled, bodies, live, logs, logPath } = await endWith(t, [500, 500, 500], "Done.");
  assert.equal(bodies().length, 3);
  assert.deepEqual(settled, ["error"]);
  // A listener restarting meanwhile would post it again.
  assert.equal(live.replied, false);
  assert.equal(live.record.status, "error");
  assert.equal(live.record.summary, "The reply couldn't be posted: 500");
  assert.ok(logs.some((l) => /done \(error, its reply refused\): GitHub POST .*: 500/.test(l)));
  assert.match(readFileSync(logPath, "utf8"), /The reply couldn't be posted: 500/);
});

// A cancelled or overflowed run's reply goes through the same check: refused, the run fails.
test("a Stop whose reply GitHub keeps refusing: failed, 👎, its reply still to post", async (t) => {
  const github = replyingWith([500, 500, 500]);
  const { runs, runner, task, settled, following } = setup(t, {
    graceMs: 5000,
    answer: github.answer,
  });
  const live = task.live;
  live.handled.push({ comment: { id: 7 } });
  runner.out(result("I filed #195."));
  runs.cancel("org/repo#12", "bryansmee");
  await following;
  await sleep(20);
  assert.equal(github.bodies().length, 3);
  assert.match(github.bodies()[0], /Stopped by @bryansmee after its answer/);
  assert.equal(live.replied, false);
  assert.equal(live.record.status, "error");
  assert.equal(live.record.summary, "The reply couldn't be posted: 500");
  assert.deepEqual(settled, ["error"]);
});

test("an overflowed run whose reply GitHub refuses: failed, 👎, said why", async (t) => {
  const github = replyingWith([403]);
  const { runner, task, settled, following } = setup(t, {
    config: { runLogMax: 1000 },
    answer: github.answer,
  });
  const live = task.live;
  live.handled.push({ comment: { id: 7 } });
  for (let i = 0; i < 20; i++) runner.err("x".repeat(99));
  await following;
  await sleep(20);
  assert.equal(github.bodies().length, 1);
  assert.match(github.bodies()[0], /stopped as failed: its output passed RUN_LOG_MAX_MB/);
  assert.equal(live.replied, false);
  assert.equal(live.record.status, "error");
  assert.equal(live.record.summary, "The reply couldn't be posted: 403");
  assert.deepEqual(settled, ["error"]);
});

// The error path's own reply (a RunError's message): a refusal is logged, the run fails as it was.
test("an error whose reply GitHub refuses: logged", async (t) => {
  const github = replyingWith([404]);
  const fails = new RunError("Not allowed here.");
  const { task, logs, settled, following } = setup(t, { answer: github.answer, fails });
  const live = task.live;
  live.handled.push({ comment: { id: 7 } });
  await following;
  await sleep(20);
  assert.equal(github.bodies().length, 1);
  assert.match(github.bodies()[0], /^Not allowed here\./);
  assert.equal(live.record.status, "error");
  assert.ok(logs.some((l) => /org\/repo#12: ReplyError: GitHub POST .*comments: 404/.test(l)));
  assert.deepEqual(settled, ["error"]);
});

// GitHub failing the read of the repo's config after the App's own tries (#680), for an item
// tried `tries` times already.
async function githubDown(t, tries = 0, githubStatus = undefined, status = 500) {
  const fails = new GitHubUnavailable(
    "GET",
    "/repos/org/repo/contents/.deckhand.yaml?ref=main",
    status,
    "reading .deckhand.yaml of org/repo",
  );
  const run = setup(t, { fails, githubStatus });
  const later = [];
  run.ctx.startLater = (task, dueAt) => later.push({ task, dueAt });
  const item = { comment: { id: 7 }, ...(tries && { githubTries: tries }) };
  const live = run.task.live;
  live.handled.push(item);
  await run.following;
  return { ...run, item, later, record: live.record };
}

const DOWN =
  "GitHub returned 500 reading .deckhand.yaml of org/repo (GET /repos/org/repo/contents/.deckhand.yaml?ref=main)";

test("a run GitHub kept failing before its start: failed, said why, its comments back in the queue a minute later", async (t) => {
  const before = Date.now();
  const { task, item, later, answers, logs, settled, logPath, record } = await githubDown(t);
  assert.equal(record.status, "error");
  assert.equal(record.summary, `Failed: ${DOWN}. Tried again in 1 min`);
  assert.deepEqual(answers, []);
  assert.deepEqual(task.pending, [item]);
  assert.equal(item.githubTries, 1);
  // Its 👀 kept: settled by the next run.
  assert.deepEqual(settled, []);
  assert.equal(later.length, 1);
  assert.ok(later[0].dueAt >= before + GITHUB_REQUEUE_MS[0]);
  assert.ok(
    logs.includes(`org/repo#12: done (error, GitHub unavailable): ${DOWN}, tried again in 1 min`),
  );
  // What the dashboard shows: the log says it, not an empty one.
  assert.match(
    readFileSync(logPath, "utf8"),
    new RegExp(RegExp.escape(`Failed: ${DOWN}. Tried again in 1 min`)),
  );
});

test("a run GitHub kept failing every time: its reply says GitHub failed, with the call", async (t) => {
  const { task, item, later, answers, settled, logPath } = await githubDown(
    t,
    GITHUB_REQUEUE_MS.length,
  );
  assert.equal(task.pending.length, 0);
  assert.equal(item.githubTries, undefined);
  assert.equal(later.length, 0);
  assert.deepEqual(answers, [
    `Claude couldn't start: ${DOWN}, 4 times. Comment again once GitHub answers.`,
  ]);
  assert.deepEqual(settled, ["error"]);
  assert.match(
    readFileSync(logPath, "utf8"),
    new RegExp(RegExp.escape(`Failed: ${DOWN}, 4 tries`)),
  );
});

// GitHub's status page as the github service last read it, a minute ago (#943).
const incident = (extra = {}) => ({
  watched: true,
  checkedAt: Date.now() - 60_000,
  triedAt: Date.now() - 60_000,
  failed: null,
  indicator: "major",
  description: "Partial System Outage",
  components: [],
  incidents: [
    {
      name: "Degraded API",
      status: "investigating",
      impact: "major",
      startedAt: 0,
      url: "https://www.githubstatus.com/incidents/abc123",
    },
  ],
  ...extra,
});
const SAID = "GitHub's status page reported an open incident then: “Degraded API” (investigating).";

test("a run GitHub failed with a 5xx: its outcome says GitHub's open incident then", async (t) => {
  const { record, logPath } = await githubDown(t, 0, async () => incident());
  assert.equal(record.summary, `Failed: ${DOWN}. Tried again in 1 min. ${SAID}`);
  assert.match(readFileSync(logPath, "utf8"), new RegExp(RegExp.escape(SAID)));
});

test("a run GitHub failed every time: its reply links GitHub's open incident", async (t) => {
  const { answers, record, logPath } = await githubDown(t, GITHUB_REQUEUE_MS.length, async () =>
    incident(),
  );
  assert.equal(record.summary, `Failed: ${DOWN}. ${SAID}`);
  assert.deepEqual(answers, [
    `Claude couldn't start: ${DOWN}, 4 times. GitHub's status page reported an open incident then: [Degraded API](https://www.githubstatus.com/incidents/abc123) (investigating). Comment again once GitHub answers.`,
  ]);
  assert.match(
    readFileSync(logPath, "utf8"),
    new RegExp(RegExp.escape(`Failed: ${DOWN}, 4 tries. ${SAID}`)),
  );
});

test("a run GitHub failed while its status page reported nothing: said so", async (t) => {
  const none = incident({
    indicator: "none",
    description: "All Systems Operational",
    incidents: [],
  });
  const { record } = await githubDown(t, 0, async () => none);
  assert.equal(
    record.summary,
    `Failed: ${DOWN}. Tried again in 1 min. GitHub's status page reported no incident then.`,
  );
});

test("GitHub's status unknown, stale or not a 5xx's: the outcome says nothing of it", async (t) => {
  const plain = `Failed: ${DOWN}. Tried again in 1 min`;
  const unreachable = async () => {
    throw new Error("the github service: 502");
  };
  const { record, logs } = await githubDown(t, 0, unreachable);
  assert.equal(record.summary, plain);
  assert.ok(logs.includes("GitHub's status: the github service: 502"));
  const stale = async () => incident({ checkedAt: Date.now() - 60 * 60_000 });
  assert.equal((await githubDown(t, 0, stale)).record.summary, plain);
  assert.equal((await githubDown(t, 0, async () => ({ watched: false }))).record.summary, plain);
  // A rate limit isn't GitHub failing: its status isn't read.
  let read = false;
  const limited = await githubDown(t, 0, async () => ((read = true), incident()), 429);
  assert.equal(limited.record.summary, plain.replace("500", "429"));
  assert.equal(read, false);
});

test("a reply GitHub keeps refusing with a 5xx: its outcome says GitHub's open incident", async (t) => {
  const { live, logPath } = await endWith(t, [500, 500, 500], "Done.", async () => incident());
  assert.equal(live.record.summary, `The reply couldn't be posted: 500. ${SAID}`);
  assert.match(readFileSync(logPath, "utf8"), new RegExp(RegExp.escape(SAID)));
});

test("the agent's output moves its log through work, push and wrap-up", async (t) => {
  const { runner, following, logPath, task } = setup(t);
  task.live.logPhase = "setup";
  const bash = (command) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
    });
  runner.err("Setup: npm ci");
  runner.out(JSON.stringify({ type: "system", subtype: "init", model: "opus" }));
  runner.out(bash("node --test"));
  runner.out(bash("git push -u origin issue-12-x"));
  runner.out(bash("gh pr ready"));
  runner.out(bash("git status"));
  runner.out(result("Done."));
  runner.out(bash("git push"));
  await following;
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  const at = (phase) => lines.findIndex((l) => l.includes(`"phase":"${phase}"`));
  const phases = lines.filter((l) => l.includes('"event":"phase"')).map((l) => JSON.parse(l));
  assert.deepEqual(
    phases.map((p) => p.phase),
    ["work", "push", "work", "wrap-up"],
  );
  assert.ok(phases.every((p) => typeof p.at === "number"));
  // Each before the line that starts it; the wrap-up after the answer, for good.
  assert.match(lines[at("work") - 1], /Setup: npm ci/);
  assert.match(lines[at("work") + 1], /"init"/);
  assert.match(lines[at("push") + 1], /git push -u/);
  assert.match(lines[at("wrap-up") - 1], /"result"/);
  assert.match(lines[at("wrap-up") + 1], /git push"/);
  assert.equal(task.live, null);
});

test("an agent's line past RUN_LOG_MAX_MB starts no phase: the line isn't kept", async (t) => {
  const { runner, following, logPath, task } = setup(t, { config: { runLogMax: 400 } });
  task.live.logPhase = "setup";
  runner.err("x".repeat(100));
  runner.out(JSON.stringify({ type: "system", subtype: "init", model: "x".repeat(400) }));
  await following;
  assert.doesNotMatch(readFileSync(logPath, "utf8"), /"event":"phase"/);
});

test("a run's end holds its task until its state is gone, after the queue's write (restart.mjs removeLive())", async (t) => {
  const { ctx, runs, task } = setup(t);
  let removed;
  const removing = [];
  ctx.removeLive = (ending) => {
    removing.push(ending.live.over);
    return new Promise((resolve) => (removed = resolve));
  };
  const ended = runs.teardown(task);
  await until(() => removing.length === 1);
  // Its last write done first; its task still taken meanwhile: no other run starts for it.
  assert.deepEqual(removing, [true]);
  assert.equal(task.running, true);
  removed(true);
  await ended;
  assert.equal(task.live, null);
  assert.equal(task.running, false);
});

test("a restored run's grace: a line read before the follow caught up keeps its whole grace", async (t) => {
  const { ctx, runner, task, following } = setup(t, { graceMs: 30 });
  runner.out(result("Answered before the restart."));
  ctx.stopping = true;
  runner.exited();
  await following;
  ctx.stopping = false;
  task.live.graceUntil = Date.now() - 60_000;
  runner.holding = true;
  const next = createRuns({ ...ctx, answerGraceMs: 400, catchUpMs: 20 });
  const followed = next.follow(task);
  // Docker's stdout past its skip first: a line written while no listener was there.
  await sleep(30);
  runner.out(JSON.stringify({ type: "assistant", message: { content: [] } }));
  // Then stderr's: caught up. The line's whole grace holds, not the moment's.
  await sleep(30);
  runner.caughtUp();
  await sleep(150);
  assert.equal(runner.kills, 0);
  await followed;
  assert.equal(runner.kills, 1);
});

test("reopenedMode: a run's record once the volume its capabilities give it is known", () => {
  // The same answer as its mode's volume: nothing to make again.
  for (const started of [true, false]) {
    assert.equal(reopenedMode({ mode: "work", restored: false, started, now: started }), null);
  }
  assert.equal(
    reopenedMode({ mode: "work", restored: false, started: false, now: true }),
    "continue",
  );
  assert.equal(reopenedMode({ mode: "work", restored: false, started: true, now: false }), "start");
  // A wrap-up and a restored run say so whatever the volume holds.
  assert.equal(
    reopenedMode({ mode: "stop", restored: false, started: true, now: false }),
    "wrap-up",
  );
  assert.equal(
    reopenedMode({ mode: "work", restored: true, started: false, now: true }),
    "restore",
  );
});

test("a run's reply carries its idempotency key: asked again after a handover, it isn't posted twice", async (t) => {
  const sent = [];
  const { ctx, runs, following } = setup(t, {
    graceMs: 5000,
    answer: async (target, text, options) => sent.push(options),
  });
  ctx.deliver = () => true;
  runs.cancel("org/repo#12", "bryansmee");
  await following;
  assert.equal(sent.length, 1);
  // The run's id, its key whoever asks.
  assert.equal(sent[0].key, "run:reply");
});

// A provider's error, as Claude Code's result says it (agents/: providerError()).
const failed = (text) =>
  JSON.stringify({ type: "result", is_error: true, result: text, duration_ms: 1000 });
const OVERLOADED = "API Error: 529 overloaded_error: Overloaded";

// The operator's Claude plan, an OpenRouter key and an OpenAI key, with FALLBACKS; a run that
// fails with `line`, its comment handled, its sandbox gone after it.
async function endFailing(t, line, { fallbacks = "claude@openrouter, codex", record = {} } = {}) {
  const config = testConfig({
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-operator",
    OPENROUTER_API_KEY: "sk-or-v1-operator",
    OPENAI_API_KEY: "sk-proj-operator",
    FALLBACKS: fallbacks,
  });
  const run = setup(t, { mode: "work", config });
  const counted = [];
  const later = [];
  Object.assign(run.ctx, {
    models: { apiOf: async () => ({}), prints: () => [] },
    fallbacks: { inc: (labels) => counted.push(labels) },
    startLater: (task) => later.push(task),
  });
  Object.assign(run.task.live.record, { provider: "anthropic", ...record });
  const item = { comment: { id: 99 }, mode: "work" };
  run.task.live.handled.push(item);
  run.runner.out(line);
  await run.following;
  return { ...run, item, counted, later };
}

test("a provider error with a fallback: no reply, its comments queued again for the next entry, said and counted", async (t) => {
  const { task, item, answers, logs, counted, later, settled, logPath } = await endFailing(
    t,
    failed(OVERLOADED),
  );
  // The next run's reply says what happened: none for this one.
  assert.deepEqual(answers, []);
  const summary =
    "Claude (anthropic, plan)'s provider failed: overloaded (529). Falling back to Claude (openrouter)";
  assert.ok(logs.includes(`org/repo#12: ${summary}`));
  assert.ok(logs.includes("org/repo#12: done (error)"));
  assert.match(readFileSync(logPath, "utf8"), /Falling back to Claude \(openrouter\)/);
  // deckhand_model_fallbacks_total, from the credential it ran on.
  assert.deepEqual(counted, [{ from: "claude@anthropic:plan", to: "claude@openrouter" }]);
  // Back in the queue, marked for the next entry with what the agent left; its 👀 kept.
  assert.deepEqual(task.pending, [item]);
  assert.deepEqual(item.fallback, {
    entry: "claude@openrouter",
    from: "claude@anthropic:plan",
    reason: "overloaded (529)",
    tried: ["claude@anthropic:plan"],
    result: OVERLOADED,
  });
  assert.deepEqual(settled, []);
  assert.deepEqual(later, [task]);
});

test("a provider error to another agent: the marker names it, the next run takes over", async (t) => {
  const { item, counted } = await endFailing(t, failed(OVERLOADED), { fallbacks: "codex@openai" });
  assert.equal(item.fallback.entry, "codex@openai");
  assert.deepEqual(counted, [{ from: "claude@anthropic:plan", to: "codex@openai" }]);
});

test("a run that fails for another reason: its error replied, no fallback", async (t) => {
  const { task, answers, counted, settled } = await endFailing(t, failed("The tests still fail."));
  assert.equal(answers.length, 1);
  assert.match(answers[0], /^Claude stopped with an error\.\n\n> The tests still fail\./);
  assert.deepEqual(counted, []);
  assert.deepEqual(task.pending, []);
  assert.deepEqual(settled, ["error"]);
});

test("a provider error with no fallback left, or on an /agent pick: its error replied", async (t) => {
  // Every entry tried in this chain.
  const left = await endFailing(t, failed(OVERLOADED), {
    fallbacks: "claude@openrouter",
    record: {
      provider: "openrouter",
      fallback: { from: "claude@anthropic:plan", reason: "x", tried: ["claude@anthropic:plan"] },
    },
  });
  assert.equal(left.answers.length, 1);
  assert.match(left.answers[0], /^Claude stopped with an error\.\n\n> API Error: 529/);
  assert.deepEqual(left.counted, []);
  assert.deepEqual(left.task.pending, []);
  // Picked with /agent (and stuck to the issue since): never falls back.
  const picked = await endFailing(t, failed(OVERLOADED), { record: { picked: { sticky: true } } });
  assert.match(picked.answers[0], /^Claude stopped with an error\./);
  assert.deepEqual(picked.counted, []);
  assert.deepEqual(picked.task.pending, []);
});

test("a run's address is nobody's once its sandbox exits, before its reply is posted", async (t) => {
  // Docker may give the address to another sandbox meanwhile (egress-http.mjs taskWhere()).
  const seen = [];
  const { runner, task, following } = setup(t, {
    answer: async (target) => seen.push([target.live.hosts, target.live.trusted]),
  });
  Object.assign(task.live, { hosts: ["github.com"], trusted: [], cached: [], uncached: [] });
  runner.out(result("Done."));
  await following;
  assert.deepEqual(seen, [[null, null]]);
});

// A run's start, up to the first line of its log (begin(), writeHeader()): `items` queued on
// issue 12, the repo's settings parsed from `yaml`. Its errors, an /agent refused, or STOP's
// mode (in no config) end it there (access.mjs validateRun()): none of these tests needs its
// preparation.
async function starting(t, { env = {}, items, yaml = "", previous = null }) {
  const dir = tempDir(t);
  const config = testConfig({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-operator", ...env });
  const logs = [];
  const answers = [];
  const provided = [];
  const moved = [];
  const store = openStore("memory:");
  t.after(() => store.close());
  const ctx = {
    config,
    log: (line) => logs.push(line),
    logDir: dir,
    shotsDir: dir,
    running: 0,
    runs: previous ? [previous] : [],
    runsById: new Map(),
    tasks: new Map(),
    store,
    titles: { get: () => null },
    broker: {
      register: () => {},
      provide: (id, provider, note, credential) => provided.push([provider, credential]),
      runOf: () => null,
      secretsOf: () => [],
      revoke: () => {},
    },
    runner: { state: async () => null, remove: async () => {}, hasSession: async () => true },
    runLogs: { open: (id) => openLog(join(dir, `${id}.log`)) },
    models: { apiOf: async () => ({}), prints: () => [] },
    repoSettings: async () => parseRepoConfig(yaml, config),
    projects: { started: async (...args) => moved.push(args) },
    watchPushes: () => {},
    label: async () => {},
    saveLive: async () => {},
    removeLive: async () => true,
    answer: async (_, text) => answers.push(text),
    schedule: () => {},
    track: () => {},
    settle: () => {},
    startLater: () => {},
    onboarded: { isIssue: () => false },
    brainstorms: { replied: () => {} },
  };
  Object.assign(ctx, createRuns(ctx));
  const task = {
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
    base: "trunk",
    name: "deckhand-org-repo-12",
    pending: items.map((item) => ({
      repo: "org/repo",
      author: "alice",
      mode: "work",
      replyTo: { kind: "issue", number: 12 },
      comment: { id: 99 },
      ...item,
    })),
    next: {},
    running: false,
    settings: null,
  };
  ctx.tasks.set("org/repo#12", task);
  const record = ctx.runs[0];
  await ctx.run(task);
  const header = logs.find((l) => l.includes(": running "));
  return {
    logs,
    answers,
    provided,
    moved,
    header,
    task,
    record: ctx.runs.find((r) => r !== record),
  };
}

// A mode no config has: the run stops once its log has its first line.
const STOP = { mode: "gone" };

test("a run marked for a plan's fallback to its key: on the key, in its session, the broker told", async (t) => {
  const fallback = {
    entry: "claude@anthropic:key",
    from: "claude@anthropic:plan",
    reason: "overloaded (529)",
    tried: ["claude@anthropic:plan"],
    result: OVERLOADED,
  };
  const { provided, header, record } = await starting(t, {
    env: { ANTHROPIC_API_KEY: "sk-ant-api03-operator", FALLBACKS: "claude@anthropic:key" },
    items: [{ text: "Fix the login", fallback, ...STOP }],
  });
  // The models service gives its agent token the key, not the plan (models/runs.mjs).
  assert.deepEqual(provided, [["anthropic", "key"]]);
  assert.match(header, /running deckhand-org-repo-12 \(gone, continue, claude@anthropic:key /);
  assert.equal(record.credential, "key");
  assert.equal(record.auth, "key");
  assert.equal(record.fallback.from, "claude@anthropic:plan");
});

test("/agent codex on an issue Claude worked on: Codex takes over afresh, on its best model", async (t) => {
  const previous = {
    id: "before",
    key: "org/repo#12",
    light: false,
    status: "ok",
    agent: "claude",
    provider: "anthropic",
    fallback: null,
    picked: null,
  };
  const { provided, header, record } = await starting(t, {
    env: { OPENAI_API_KEY: "sk-proj-operator" },
    items: [{ text: "/agent codex\nNow the logout", ...STOP }],
    previous,
  });
  assert.deepEqual(provided, [["openai", null]]);
  // A new session (`start`), not Claude's (`continue`).
  assert.match(header, /\(gone, start, codex@openai gpt-6-astra\/medium\)/);
  assert.deepEqual(record.picked, {});
  assert.equal(record.fallback, null);
});

test("a run refused as it starts (an /agent the operator hasn't configured, a config's errors) moves nothing", async (t) => {
  // Only Claude configured.
  const pick = await starting(t, { items: [{ text: "/agent codex\nGo." }] });
  assert.equal(pick.answers.length, 1);
  assert.match(
    pick.answers[0],
    /^Claude can't run here: `\/agent codex` isn't one the operator configured/,
  );
  // Not even its project asked for (projects.mjs).
  assert.deepEqual(pick.moved, []);
  const broken = await starting(t, { items: [{ text: "Go." }], yaml: "max_parallel: lots\n" });
  assert.match(
    broken.answers[0],
    /^Claude can't run here: `\.deckhand\.yaml` on `trunk` has errors\.\n\n- max_parallel: expected a whole number/,
  );
  assert.deepEqual(broken.moved, []);
});

test("a run's start reads the repo's settings again, and when (#639: api/state's repo slots)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 7000 });
  const { task } = await starting(t, {
    items: [{ text: "Go.", ...STOP }],
    yaml: "max_parallel: 1\n",
  });
  assert.deepEqual([task.settings.maxParallel, task.settingsAt], [1, 7000]);
});

test("a run's end asks the waits about its own issue again: its run may have closed it", async (t) => {
  const { ctx, runner, task, following } = setup(t, { mode: "work" });
  const asked = [];
  ctx.waits = { recheck: async (repo, number) => (asked.push(`${repo}#${number}`), null) };
  task.live.light = false;
  runner.out(result("Done."));
  await runner.kill();
  await following;
  assert.deepEqual(asked, ["org/repo#12"]);
});
