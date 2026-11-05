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
import { createRuns, reopenedMode } from "../listener/runs.mjs";
import { openLog } from "../listener/runlog.mjs";
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
  { mode = "idea", graceMs = 60, tokens = [], scrubs = [], config = {}, answer, fails } = {},
) {
  const dir = tempDir(t);
  const runner = fakeRunner(fails);
  const answers = [];
  const logs = [];
  const done = [];
  const settled = [];
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
    store: openStore("memory:"),
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
test("a run's log: when each tool call and output came, before its line", (t) => {
  const { runner, logPath } = setup(t);
  const assistant = (content) => JSON.stringify({ type: "assistant", message: { content } });
  const call = assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]);
  const output = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] },
  });
  const text = assistant([{ type: "text", text: "Looking." }]);
  runner.out(text, 1000);
  runner.out(call, 2000);
  runner.out(output, 14000);
  // Without Docker's time (an older engine, say), none.
  runner.out(call, null);
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  const at = (ms) => JSON.stringify({ type: "listener", event: "at", at: ms });
  assert.deepEqual(lines.slice(-6), [text, at(2000), call, at(14000), output, call]);
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

async function endWith(t, statuses, text) {
  const github = replyingWith(statuses);
  const run = setup(t, { graceMs: 30, answer: github.answer });
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
