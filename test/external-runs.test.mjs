// External runs (#597): the run a machine's claim starts (claims.mjs, runs.mjs startExternal()),
// without a sandbox, reported through the run tools: its log's lines, the comments that reach it,
// its question or its end, and what follows that end as after a sandbox run's; interrupted by a
// release or a lease that runs out; kept by the next copy of the orchestrator.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Refused } from "../lib/http.mjs";
import { openStore } from "../lib/store.mjs";
import { createClaims, LEASE_MS, MACHINE_PROTOCOL } from "../listener/claims.mjs";
import { createMachines } from "../listener/machines.mjs";
import { NEEDS_INPUT } from "../listener/questions.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createRestart } from "../listener/restart.mjs";
import { openLog } from "../listener/runlog.mjs";
import { createRuns } from "../listener/runs.mjs";
import { createTasks } from "../listener/tasks.mjs";
import { tempDir, testConfig, until } from "./helpers.mjs";

const KEY = "org/repo#12";
const line = (event) => JSON.stringify(event);
const text = (said) =>
  line({ type: "assistant", message: { content: [{ type: "text", text: said }] } });
const result = (said, isError = false) =>
  line({ type: "result", is_error: isError, result: said, duration_ms: 90_000 });

// One copy of the orchestrator: its tasks, runs, restarts, machines and claims on org/repo, under
// a clock of the test's for the leases (`t.clock`). `store` and `dir` (the logs) are shared with
// the next copy (`next()`), as a handover's; `machines` too, the store's map.
function copy(t, { store, dir, machines = new Map(), routes = new Map(), clock = { at: 1e6 } }) {
  const said = {
    answers: [],
    replies: [],
    labels: [],
    settled: [],
    after: [],
    runner: [],
    logs: [],
  };
  const now = () => clock.at;
  const config = testConfig({ ALLOWED_USERS: "alice,bob", DEBOUNCE_MS: "0" });
  config.bot = "deckhand[bot]";
  const { settings } = parseRepoConfig("machines: true", config);
  // Nothing of a sandbox's: an external run calls none of it.
  const runner = new Proxy(
    { list: async () => [], relink: async () => {}, hasSession: async () => false },
    {
      get: (target, name) =>
        target[name] ??
        ((...args) => {
          said.runner.push(name);
          throw new Error(`runner.${String(name)}(${args[0]}) called`);
        }),
    },
  );
  const ctx = {
    config,
    log: (l) => said.logs.push(l),
    logDir: dir,
    store,
    tasks: new Map(),
    runs: [],
    runsById: new Map(),
    running: 0,
    stopping: false,
    skip: () => null,
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {}, activate: () => null, replied: () => {} },
    titles: { set: () => {}, get: () => "Build the level" },
    onboarded: { isIssue: () => false },
    received: () => {},
    publicUrl: () => "https://deck.example",
    reply: async (repo, number, body) => said.replies.push(body),
    answer: async (target, body) => said.answers.push({ to: target.replyTo, body }),
    label: async (repo, number, on) => said.labels.push(on),
    settle: async (item, status) => said.settled.push([item.comment?.id ?? item.reason, status]),
    track: (promise) => promise,
    runner,
    runLogs: {
      open: (id) => Object.assign(openLog(join(dir, `${id}.log`)), { ready: Promise.resolve() }),
    },
    broker: {
      register: () => said.runner.push("broker.register"),
      runOf: () => undefined,
      secretsOf: () => [],
      revoke: async () => said.runner.push("broker.revoke"),
    },
    models: { apiOf: async () => said.runner.push("models.apiOf"), prints: () => [] },
    reviews: {
      fixed: async (run) => said.after.push(["fixed", run.number, run.status]),
      ciFixed: async (run) => said.after.push(["ciFixed", run.number, run.status]),
      runEnded: () => {},
      settle: async () => {},
    },
    repoSettings: async () => ({ settings, errors: [] }),
    inputs: { ticksIgnored: () => false },
    waits: {
      reserve: () => null,
      release: async () => {},
      request: async () => false,
      recheck: async () => {},
    },
    policies: { decide: async () => ({ applied: false, messages: [] }) },
    github: async () => new Response("{}", { status: 404 }),
  };
  Object.assign(ctx, createTasks(ctx), createRuns(ctx), createRestart(ctx));
  ctx.machines = createMachines({
    machines,
    config,
    repoNames: async () => ["org/repo"],
    granted: async () => true,
    settings: async () => ({ settings, errors: [] }),
    mayRun: async () => true,
    removed: (m) => ctx.claims.machineGone(m),
    now,
  });
  let ids = 0;
  ctx.claims = createClaims(ctx, {
    routes,
    now,
    waitMs: 0,
    newId: () => `run-${clock.at}-${++ids}`,
  });
  t.after(() => ctx.claims.stop());
  // A comment by `author` on issue 12, as its delivery has it.
  const say = (author, body, { id = 100, replyTo = 12 } = {}) =>
    ctx.admit(
      {
        repo: "org/repo",
        id: "12",
        kind: "issue",
        base: "main",
        author,
        trigger: "work",
        replyTo,
      },
      "issue_comment",
      {
        action: "created",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "main" },
        issue: { number: 12, title: "Build the level", state: "open", body: "", labels: [] },
        comment: { id, body, user: { login: author, type: "User" } },
        sender: { login: author },
      },
    );
  // Every task's pause over at once, as its timer would.
  const ready = () => {
    for (const task of ctx.tasks.values()) {
      clearTimeout(task.timer);
      if (task.pending.length && !task.running) task.ready = true;
    }
    ctx.schedule();
  };
  const task = () => ctx.tasks.get(KEY);
  const run = (id) => ctx.runsById.get(id);
  // The next copy, on the same store, logs and clock: what a handover's restores.
  const next = async () => {
    ctx.stopping = true;
    ctx.claims.stop();
    const other = copy(t, { store, dir, machines, routes, clock });
    await other.ctx.unifySpellings();
    const restored = await other.ctx.restoreRuns({ waitMs: 0 });
    await other.ctx.loadQueue();
    await other.ctx.reattach(restored, { waitMs: 0 });
    return other;
  };
  return { ctx, said, clock, say, ready, task, run, next, settings };
}

function bench(t) {
  const store = openStore("memory:");
  t.after(() => store.close());
  const one = copy(t, { store, dir: tempDir(t) });
  const register = (owner, name) =>
    one.ctx.machines.register(owner, { name, labels: ["unreal"], repos: ["org/repo"] }).id;
  return { ...one, register, store };
}

// Alice's Desk claims #12, routed to it with `/machine`: → its work.
async function claimed(b, body = "Deckhand\n/machine Desk\nBuild it.") {
  const desk = b.register("alice", "Desk");
  await b.say("alice", body);
  b.ready();
  const work = await b.ctx.claims.claim("alice", desk, {
    reported: { agent: "claude", model: "opus", effort: "high" },
  });
  assert.ok(work, "the claim takes #12");
  return { desk, work };
}

test("a run claimed, logged, asking, answered and finished goes the steps of a sandbox run's, with no sandbox", async (t) => {
  const b = bench(t);
  const { ctx, said } = b;
  const { desk, work } = await claimed(b);
  assert.equal(work.protocol, MACHINE_PROTOCOL);
  // Its record, as a sandbox run's: running, its agent and model as the driver said, its machine.
  const record = b.run(work.run);
  assert.equal(record.status, "running");
  assert.equal(record.key, KEY);
  assert.deepEqual(
    [record.agent, record.model, record.effort, record.machine, record.mode],
    ["claude", "opus", "high", "Desk", "start"],
  );
  assert.equal(b.task().live.id, work.run);
  assert.deepEqual(b.task().live.external, { machine: desk, name: "Desk", owner: "alice" });
  // Its start takes the needs-input label off, as a sandbox run's does.
  assert.deepEqual(said.labels, [false]);
  // In the store at once: a copy that takes over has it.
  await until(async () => (await b.store.get(`runs/${work.run}`))?.external);

  // Its agent's lines, in its log.
  const posted = await ctx.claims.post("alice", desk, work.run, [text("Looking at the level.")], 0);
  assert.deepEqual(posted, { key: KEY, next: 1 });
  // Sent again (its answer lost): taken once.
  assert.equal(
    (await ctx.claims.post("alice", desk, work.run, [text("Looking at the level.")], 0)).next,
    1,
  );
  await assert.rejects(ctx.claims.post("alice", desk, work.run, [text("…")], 5), { status: 409 });
  const logged = readFileSync(join(ctx.logDir, `${work.run}.log`), "utf8");
  assert.equal(logged.split("\n").filter((l) => l.includes("Looking at the level.")).length, 1);

  // Alice's comment meanwhile goes to its agent, as to a sandbox's inbox.
  await b.say("alice", "Also the menu.", { id: 101 });
  const got = await ctx.claims.nextMessage("alice", desk, work.run, 0, { wait: 2000 });
  assert.equal(got.messages.length, 1);
  assert.match(got.messages[0], /Also the menu\./);
  assert.deepEqual([got.next, got.closed], [1, false]);
  // Nothing more yet: asked again, nothing (the test's wait is 0).
  assert.deepEqual(await ctx.claims.nextMessage("alice", desk, work.run, 1, { wait: 0 }), {
    messages: [],
    next: 1,
    closed: false,
  });
  // Its answer, nothing left for it: its inbox closes.
  await ctx.claims.post("alice", desk, work.run, [result("Which menu?")], 1);
  assert.deepEqual(await ctx.claims.nextMessage("alice", desk, work.run, 1), {
    messages: [],
    next: 1,
    closed: true,
  });

  // It stops to ask: the reply as the App, with the marker, the label, needs-input.
  const asked = await ctx.claims.ask("alice", desk, work.run, "1. **Menu**: the main one?");
  assert.deepEqual(asked, { key: KEY, status: "needs-input" });
  assert.equal(said.answers.length, 1);
  assert.equal(said.answers[0].to, 12);
  assert.ok(said.answers[0].body.startsWith(`${NEEDS_INPUT}\n\n1. **Menu**: the main one?`));
  assert.match(said.answers[0].body, /🤖 Claude opus · high effort · on Desk · 1\.5 min/);
  assert.deepEqual(said.labels, [false, true]);
  assert.equal(record.status, "needs-input");
  assert.ok(record.finishedAt);
  assert.deepEqual(
    record.questions?.items.map((q) => q.title),
    ["Menu"],
  );
  // Its comments get their outcome's reaction; its claim, state and slot are gone.
  assert.deepEqual(said.settled, [
    [100, "needs-input"],
    [101, "needs-input"],
  ]);
  const task = b.task();
  assert.deepEqual([task.live, task.claim, task.running], [null, null, false]);
  assert.deepEqual(ctx.claims.renew("alice", desk), []);
  assert.equal(await b.store.get(`runs/${work.run}`), null);
  // Its run is over: its machine reaches it no more.
  await assert.rejects(ctx.claims.post("alice", desk, work.run, [text("…")]), { status: 404 });

  // Her answer: the next claim, on Desk, goes on with the session.
  await b.say("alice", "The main menu.", { id: 102 });
  b.ready();
  const again = await ctx.claims.claim("alice", desk);
  assert.equal(again.resume, true);
  assert.equal(b.run(again.run).mode, "continue");
  // Its model unknown (none reported): the footer leaves it out.
  assert.equal(b.run(again.run).model, null);
  await ctx.claims.post("alice", desk, again.run, [result("Done: the main menu.")]);
  const finished = await ctx.claims.finish("alice", desk, again.run, { outcome: "ok" });
  assert.deepEqual(finished, { key: KEY, status: "ok" });
  assert.match(
    said.answers[1].body,
    /^Done: the main menu\.\n\n<sub>🤖 Claude · on Desk · 1\.5 min/,
  );
  assert.equal(b.run(again.run).status, "ok");
  // Nothing of a sandbox's was ever asked for: no runner, broker or models call.
  assert.deepEqual(said.runner, []);
});

test("a machine's fix run that ends starts what a sandbox's does: the review's next step, the CI step", async (t) => {
  const b = bench(t);
  const { ctx, said } = b;
  const { desk, work } = await claimed(b);
  await ctx.claims.finish("alice", desk, work.run, { outcome: "ok", reply: "Built." });
  // The review of its pull request #30 requests changes: Deckhand's own fix round, queued on the
  // issue's task, which sticks to Desk.
  const fixItem = (reason) => ({
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
    title: null,
    trigger: "work",
    modeLine: null,
    text: "Fix what the review found.",
    replyTo: 30,
    comment: null,
    base: "main",
    settings: b.settings,
    sender: null,
    reason,
  });
  for (const [reason, step] of [
    ["review-fix", "fixed"],
    ["ci-fix", "ciFixed"],
  ]) {
    await ctx.accept(fixItem(reason));
    b.ready();
    const fix = await ctx.claims.claim("alice", desk);
    assert.ok(fix, `${reason}: claimed`);
    assert.equal(fix.resume, true);
    await ctx.claims.finish("alice", desk, fix.run, { outcome: "ok", reply: "Fixed." });
    assert.deepEqual(said.after.at(-1), [step, 30, "ok"]);
    // Its reply on the pull request, as a fix run's.
    assert.equal(said.answers.at(-1).to, 30);
  }
  // An error is the run's, with no fallback: its machine runs the agent it has.
  await b.say("alice", "Once more.", { id: 103 });
  b.ready();
  const failing = await ctx.claims.claim("alice", desk);
  await ctx.claims.post("alice", desk, failing.run, [result("API down", true)]);
  assert.equal(
    (await ctx.claims.finish("alice", desk, failing.run, { outcome: "error" })).status,
    "error",
  );
  assert.match(said.answers.at(-1).body, /^Claude stopped with an error\.\n\n> API down/);
  assert.deepEqual(said.runner, []);
});

test("a lease that runs out, or a release, ends the run as interrupted, the issue told, its comments queued again for the machine", async (t) => {
  const b = bench(t);
  const { ctx, said, clock } = b;
  const { desk, work } = await claimed(b);
  await ctx.claims.post("alice", desk, work.run, [text("Working.")]);
  // Two minutes without Desk's heartbeat.
  clock.at += LEASE_MS + 1;
  assert.deepEqual(ctx.claims.expire(), [KEY]);
  await until(() => b.run(work.run).status === "interrupted", { what: "its end" });
  assert.match(
    b.run(work.run).summary,
    /^Interrupted: its lease ran out, without Desk's heartbeat/,
  );
  await until(() => said.replies.length === 1, { what: "the issue told" });
  assert.match(said.replies[0], /^Desk's run was interrupted: its lease ran out/);
  // No reply as a run's, no reaction: its comment waits again, with its 👀.
  assert.deepEqual([said.answers, said.settled], [[], []]);
  await until(() => !b.task().running, { what: "its slot" });
  assert.equal(b.task().pending.length, 1);
  assert.equal(await b.store.get(`runs/${work.run}`), null);
  // Its machine reaches the run no more; its next claim takes the comment again, and resumes.
  await assert.rejects(ctx.claims.post("alice", desk, work.run, [text("…")]), { status: 404 });
  b.ready();
  const again = await ctx.claims.claim("alice", desk);
  assert.equal(again.resume, true);
  assert.match(again.message, /Build it\./);
  // Given back by the machine: the same.
  assert.equal(ctx.claims.release("alice", desk, again.run), KEY);
  await until(() => b.run(again.run).status === "interrupted", { what: "its end" });
  await until(() => said.replies.length === 2, { what: "the issue told" });
  assert.match(said.replies[1], /^Desk's run was interrupted: Desk released it/);
  await until(() => !b.task().running && b.task().pending.length === 1, { what: "its comment" });
  // Stopped from the dashboard (or `/cancel`): ended as cancelled, its comment's 👀 off.
  b.ready();
  const third = await ctx.claims.claim("alice", desk);
  assert.equal(ctx.cancel(KEY, "alice"), "running");
  await until(() => b.run(third.run).status === "cancelled", { what: "its end" });
  assert.match(said.answers.at(-1).body, /^Stopped by @alice\./);
  assert.deepEqual(said.settled, [[100, "cancelled"]]);
  assert.equal(b.task().claim, null);
  assert.deepEqual(said.runner, []);
});

test("only the machine holding the claim reaches its run: not another login's, nor the owner's other machine", async (t) => {
  const b = bench(t);
  const { ctx } = b;
  const { desk, work } = await claimed(b);
  const laptop = b.register("alice", "Laptop");
  const rig = b.register("bob", "Rig");
  const calls = (owner, id, run = work.run) => [
    () => ctx.claims.post(owner, id, run, [text("Mine now.")]),
    () => ctx.claims.nextMessage(owner, id, run),
    () => ctx.claims.ask(owner, id, run, "Who am I?"),
    () => ctx.claims.finish(owner, id, run, { outcome: "ok", reply: "Hijacked." }),
  ];
  for (const call of [
    ...calls("bob", desk),
    ...calls("bob", rig),
    ...calls("alice", laptop),
    ...calls("alice", desk, "run-other"),
  ]) {
    await assert.rejects(call(), (error) => error instanceof Refused && error.status === 404);
  }
  // Untouched: still running, nothing in its log of theirs, nothing posted.
  assert.equal(b.run(work.run).status, "running");
  assert.equal(b.task().live.lines.out, 0);
  assert.deepEqual(b.said.answers, []);
  // An agent Deckhand doesn't know is refused at the claim.
  await assert.rejects(ctx.claims.claim("alice", laptop, { reported: { agent: "gpt-7" } }), {
    status: 400,
  });
});

test("the next copy of the orchestrator keeps an external run: its lines, messages and claim, its end posted once", async (t) => {
  const b = bench(t);
  const { desk, work } = await claimed(b);
  await b.ctx.claims.post("alice", desk, work.run, [text("One.")]);
  await b.say("alice", "Also the menu.", { id: 101 });
  await until(() => b.task().live.outbox.length === 1, { what: "the message" });
  await b.ctx.saveLive(b.task());
  const other = await b.next();
  const { ctx } = other;
  // Its run, as it was: running, its record, its inbox and the lines it had; its claim.
  const task = other.task();
  assert.equal(task.live.id, work.run);
  assert.equal(task.live.open, true);
  assert.equal(task.live.lines.out, 1);
  assert.equal(task.claim.id, work.run);
  assert.equal(other.run(work.run).status, "running");
  assert.deepEqual(
    ctx.claims.renew("alice", desk).map((c) => c.run),
    [work.run],
  );
  // The driver sends again what it sent the copy before, and more: the new lines alone are taken.
  const posted = await ctx.claims.post("alice", desk, work.run, [text("One."), text("Two.")], 0);
  assert.equal(posted.next, 2);
  const logged = readFileSync(join(ctx.logDir, `${work.run}.log`), "utf8");
  assert.equal(logged.split("\n").filter((l) => l.includes("One.")).length, 1);
  const got = await ctx.claims.nextMessage("alice", desk, work.run, 0);
  assert.match(got.messages[0], /Also the menu\./);
  await ctx.claims.finish("alice", desk, work.run, { outcome: "ok", reply: "Built." });
  assert.equal(other.said.answers.length, 1);
  assert.equal(other.run(work.run).status, "ok");
  assert.deepEqual(other.said.runner, []);
  // The copy before never posted it.
  assert.deepEqual(b.said.answers, []);
});

test("a claim saved without its run, or a run without its claim, is given back as the next copy starts", async (t) => {
  const b = bench(t);
  const { desk, work } = await claimed(b);
  await b.ctx.saveLive(b.task());
  await b.ctx.saveQueue();
  // The run's state is there, the queue's claim isn't (a copy killed in between, say).
  const queue = await b.store.get("queue");
  delete queue[KEY].claim;
  await b.store.set("queue", queue);
  const other = await b.next();
  await until(() => other.run(work.run)?.status === "interrupted", { what: "its end" });
  await until(() => !other.task().running, { what: "its slot" });
  assert.match(other.said.replies[0], /^Desk's run was interrupted: its claim was lost/);
  assert.equal(other.task().pending.length, 1);
  // And a claim whose run's state was never written: its comments queued again.
  other.ready();
  const again = await other.ctx.claims.claim("alice", desk);
  assert.ok(again);
  await other.ctx.saveLive(other.task());
  await other.ctx.saveQueue();
  await b.store.delete(`runs/${again.run}`);
  const third = await other.next();
  assert.equal(third.task().live, null);
  assert.equal(third.task().claim, null);
  assert.equal(third.task().pending.length, 1);
});
