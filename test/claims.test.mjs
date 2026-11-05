// claims.mjs (#596): issues routed to their owner's machines (`runs-on:<label>`, `/machine`), the
// machines' pools outside MAX_PARALLEL, their claims and leases, and the comments held for the
// owner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchSlug, createClaims, fits, LEASE_MS } from "../listener/claims.mjs";
import { parseMachine, splitTrigger } from "../listener/events.mjs";
import { createMachines, hasRunsOn, runsOn } from "../listener/machines.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { countRun, createTasks, poolOf } from "../listener/tasks.mjs";
import { testConfig } from "./helpers.mjs";

const KEY = "org/repo#12";

// The tasks, the machines and their claims on org/repo, under a clock of the test's (`t.clock`),
// with MAX_PARALLEL 1. `yaml`: the repo's config (`machines: true` by default); `labels`: issue
// 12's, as GitHub has it; `events`: its events (who labelled it); `users`: ALLOWED_USERS.
function bench({
  yaml = "machines: true",
  labels = [],
  events = [],
  users = "alice,bob",
  granted = true,
} = {}) {
  const t = { clock: 1_000_000, replies: [], settled: [], logs: [], started: [], calls: [] };
  const now = () => t.clock;
  const config = testConfig({ ALLOWED_USERS: users, MAX_PARALLEL: "1", DEBOUNCE_MS: "0" });
  config.bot = "deckhand[bot]";
  const { settings } = parseRepoConfig(yaml, config);
  const github = async (repo, method, path) => {
    t.calls.push(`${method} ${path}`);
    const url = new URL(path, "https://api.github.com");
    if (url.pathname === "/repos/org/repo/issues/12/events") {
      return Response.json(url.searchParams.get("page") === "1" ? events : []);
    }
    if (url.pathname === "/repos/org/repo/issues/12") {
      if (t.labelsFail) return new Response("{}", { status: 502 });
      return Response.json({ number: 12, labels: t.labels ?? labels });
    }
    return new Response("{}", { status: 404 });
  };
  const ctx = {
    config,
    log: (line) => t.logs.push(line),
    skip: () => null,
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {}, activate: () => null },
    runs: [],
    running: 0,
    stopping: false,
    // A sandbox's run, counted in its pool as runs.mjs counts it.
    run: (task) => {
      task.running = true;
      task.pending = [];
      countRun(ctx, task, 1);
      t.started.push(task.id);
    },
    titles: { set: () => {}, get: () => "Café : bientôt" },
    received: () => {},
    publicUrl: () => "https://hooks.example.com",
    reply: async (repo, number, text) => (t.replies.push(text), null),
    settle: async (item, status) => t.settled.push([item.comment?.id ?? item.reason, status]),
    track: (promise) => promise,
    answer: async () => {},
    runner: { hasSession: async () => false },
    repoSettings: async () => ({ settings, errors: [] }),
    inputs: { ticksIgnored: () => false },
    waits: { reserve: () => null, release: async () => {}, request: async () => false },
    policies: { decide: async () => ({ applied: false, messages: [] }) },
    github,
    routeRetryMs: 20,
  };
  Object.assign(ctx, createTasks(ctx));
  ctx.cancel = (key, by) => {
    const task = ctx.tasks.get(key);
    return task?.claim && ctx.claims.cancel(task, by) ? "running" : null;
  };
  ctx.machines = createMachines({
    config,
    repoNames: async () => ["org/repo", "org/other"],
    granted: async () => granted,
    settings: async () => ({ settings, errors: [] }),
    mayRun: async () => true,
    removed: (m) => ctx.claims.machineGone(m),
    now,
  });
  let ids = 0;
  ctx.claims = createClaims(ctx, { now, waitMs: 0, newId: () => `run-${++ids}` });
  // A comment by `author` on issue 12 (or `number`), as the delivery has it.
  t.say = (author, body, { number = 12, issueLabels = labels, id = 100 } = {}) => {
    const payload = {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "main" },
      issue: { number, title: "Café : bientôt", state: "open", body: "", labels: issueLabels },
      comment: { id, body, user: { login: author, type: "User" } },
      sender: { login: author },
    };
    const first = {
      repo: "org/repo",
      id: String(number),
      kind: "issue",
      base: "main",
      author,
      trigger: "work",
      replyTo: number,
    };
    return ctx.admit(first, "issue_comment", payload);
  };
  // Every task's pause over at once, as its timer would: then the scheduler runs.
  t.ready = () => {
    for (const task of ctx.tasks.values()) {
      clearTimeout(task.timer);
      if (task.pending.length && !task.running) task.ready = true;
    }
    ctx.schedule();
  };
  t.register = (owner, name, fields = {}) =>
    ctx.machines.register(owner, { name, repos: ["org/repo"], ...fields }).id;
  t.task = (key = KEY) => ctx.tasks.get(key);
  // A sandbox's run over, its slot free.
  t.finish = (key = KEY) => {
    const task = ctx.tasks.get(key);
    task.running = false;
    countRun(ctx, task, -1);
  };
  return { t, ctx };
}

const labelledBy = (login, type = "User", name = "runs-on:unreal") => ({
  event: "labeled",
  label: { name },
  actor: { login, type },
  created_at: "2026-02-01T00:00:00Z",
});

test("/machine routes the issue to its author's machines: none of MAX_PARALLEL taken, claimed with its work", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk", { labels: ["unreal"] });
  await t.say("alice", "Deckhand\n/machine unreal\nBuild the level.");
  t.ready();
  // The scheduler never starts it, though a slot is free.
  assert.deepEqual(t.started, []);
  assert.equal(poolOf(t.task()), "machines");
  assert.deepEqual(ctx.queueOrder(), []);
  const work = await ctx.claims.claim("alice", desk);
  assert.equal(work.run, "run-1");
  assert.equal(work.repository, "org/repo");
  assert.equal(work.issue, 12);
  assert.equal(work.mode, "work");
  assert.equal(work.branch, "issue-12-cafe-bientot");
  assert.equal(work.resume, false);
  assert.match(work.prompt, /Work on GitHub issue #12 of org\/repo/);
  assert.equal(work.message, "Build the level.");
  assert.equal(work.leaseSeconds, LEASE_MS / 1000);
  // Its comments are the claim's; the task runs on that machine, which it sticks to.
  const task = t.task();
  assert.equal(task.running, true);
  assert.deepEqual(task.pending, []);
  assert.equal(poolOf(task), `machine:${desk}`);
  assert.equal(ctx.running, 0);
  // Nothing more for it.
  assert.equal(await ctx.claims.claim("alice", desk), null);
});

test("with every MAX_PARALLEL slot taken, a machine still claims; a full machine's next task waits for it alone", async () => {
  const { t, ctx } = bench();
  await t.say("bob", "Deckhand", { number: 40 });
  t.ready();
  assert.deepEqual(t.started, ["40"]);
  assert.equal(ctx.running, 1);
  const desk = t.register("alice", "Desk", { labels: ["unreal"] });
  const laptop = t.register("alice", "Laptop", { labels: ["unreal"] });
  await t.say("alice", "Deckhand\n/machine Desk");
  await t.say("alice", "Deckhand\n/machine Desk", { number: 13 });
  t.ready();
  assert.equal((await ctx.claims.claim("alice", desk)).issue, 12);
  // Desk is full (capacity 1): #13 sticks to it, so neither the laptop nor a sandbox takes it.
  assert.equal(await ctx.claims.claim("alice", desk), null);
  assert.equal(await ctx.claims.claim("alice", laptop), null);
  t.ready();
  assert.deepEqual(t.started, ["40"]);
  // Once desk gives #12 back, its next claim takes the oldest of its two.
  ctx.claims.release("alice", desk, "run-1");
  t.ready();
  assert.equal((await ctx.claims.claim("alice", desk)).issue, 12);
});

test("another user's machine, one without the label, or without the repository, never gets the task", async () => {
  const { t, ctx } = bench({ yaml: "machines:\n  labels: [unreal]" });
  const bobs = t.register("bob", "Rig", { labels: ["unreal"] });
  const gpu = t.register("alice", "Gpu box", { labels: ["gpu"] });
  const away = t.register("alice", "Away", { labels: ["unreal"], repos: ["org/other"] });
  await t.say("alice", "Deckhand\n/machine unreal");
  t.ready();
  for (const [owner, id] of [
    ["bob", bobs],
    ["alice", gpu],
    ["alice", away],
  ]) {
    assert.equal(await ctx.claims.claim(owner, id), null, `${owner}'s ${id}`);
  }
  // Another's machine id is no machine of theirs.
  await assert.rejects(ctx.claims.claim("alice", bobs), { status: 404 });
  // A machine named after the label, but which the repository's `machines.labels` don't take.
  const named = t.register("alice", "unreal", { labels: ["gpu"] });
  assert.equal(await ctx.claims.claim("alice", named), null);
  const desk = t.register("alice", "Desk", { labels: ["unreal", "gpu"] });
  assert.equal((await ctx.claims.claim("alice", desk)).issue, 12);
});

test("without the operator's grant, no machine takes it; without `machines:`, /machine says so and routes nothing", async () => {
  const ungranted = bench({ granted: false });
  const desk = ungranted.t.register("alice", "Desk");
  await ungranted.t.say("alice", "Deckhand\n/machine Desk");
  ungranted.t.ready();
  assert.equal(await ungranted.ctx.claims.claim("alice", desk), null);
  assert.deepEqual(ungranted.t.started, []);
  const off = bench({ yaml: "" });
  await off.t.say("alice", "Deckhand\n/machine Desk");
  assert.match(off.t.replies[0], /this repository takes no machines/);
  assert.equal(off.t.task(), undefined);
});

test("a runs-on label routes it to whoever added it; a bot's labelling is refused, said once", async () => {
  const labels = [{ name: "auto-pickup" }, { name: "Runs-On:Unreal" }];
  const { t, ctx } = bench({ labels, events: [labelledBy("alice", "User", "Runs-On:Unreal")] });
  const desk = t.register("alice", "Desk", { labels: ["unreal"] });
  // Alice labelled it: her machine takes it, the comment hers.
  await t.say("alice", "Deckhand");
  t.ready();
  assert.deepEqual(t.started, []);
  assert.equal((await ctx.claims.claim("alice", desk)).issue, 12);
  // The delivery's labels are read, not GitHub's issue again; its events once, for the route.
  assert.deepEqual(
    t.calls.map((c) => c.replace(/\?.*/, "")),
    ["GET /repos/org/repo/issues/12/events"],
  );
  const bot = bench({ labels, events: [labelledBy("renovate[bot]", "Bot", "Runs-On:Unreal")] });
  await bot.t.say("alice", "Deckhand");
  await bot.t.say("alice", "Deckhand", { id: 101 });
  assert.equal(bot.t.task()?.pending.length ?? 0, 0);
  assert.equal(bot.t.replies.length, 1);
  assert.match(bot.t.replies[0], /^Not run: the label was added by a bot \(renovate\[bot\]\)\./);
  // Its label taken off: the next comment runs in a sandbox.
  await bot.t.say("alice", "Deckhand", { issueLabels: [], id: 102 });
  bot.t.ready();
  assert.deepEqual(bot.t.started, ["12"]);
});

test("/machine none sends it back to sandboxes, whatever its runs-on label says; only its owner moves it", async () => {
  const labels = [{ name: "runs-on:unreal" }];
  const { t, ctx } = bench({ labels, events: [labelledBy("alice")] });
  await t.say("alice", "Deckhand");
  t.ready();
  assert.deepEqual(t.started, []);
  // Bob's /machine: refused, the task alice's.
  await t.say("bob", "/machine none", { id: 101 });
  assert.match(t.replies.at(-1), /runs on @alice's machines: only they can move it/);
  assert.equal(poolOf(t.task()), "machines");
  await t.say("alice", "/machine none", { id: 102 });
  assert.deepEqual(t.settled.at(-1), [102, "acknowledged"]);
  t.ready();
  assert.deepEqual(t.started, ["12"]);
  assert.equal(poolOf(t.task()), "shared");
  // Later comments too, its label still on.
  const item = {
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
    settings: t.task().settings,
  };
  assert.equal(await ctx.claims.routeFor(item, labels), null);
});

test("another user's comment on a machine task is held for its owner; a review's fix round is delivered", async () => {
  const { t, ctx } = bench();
  t.register("alice", "Desk");
  await t.say("alice", "Deckhand\n/machine Desk");
  await t.say("bob", "Also do the menu.", { id: 101 });
  const task = t.task();
  assert.equal(task.pending.length, 1);
  assert.deepEqual(
    ctx.claims.heldOf(KEY).map((h) => [h.author, h.text]),
    [["bob", "Also do the menu."]],
  );
  // A review's fix round: Deckhand's own, not held.
  await ctx.accept({
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
    trigger: "work",
    modeLine: null,
    text: "Fix the findings.",
    replyTo: 30,
    comment: null,
    base: "main",
    settings: task.settings,
    sender: null,
    reason: "review-fix",
  });
  assert.deepEqual(
    task.pending.map((i) => i.reason ?? i.author),
    ["alice", "review-fix"],
  );
  // Only the owner delivers them.
  assert.throws(() => ctx.claims.deliverHeld("bob", KEY), { status: 403 });
  assert.equal(ctx.claims.deliverHeld("alice", KEY), 1);
  assert.deepEqual(
    task.pending.map((i) => i.reason ?? i.author),
    ["alice", "review-fix", "bob"],
  );
  assert.deepEqual(ctx.claims.heldOf(KEY), []);
  // Or drops them, their 👀 off.
  await t.say("bob", "And the credits.", { id: 102 });
  assert.equal(ctx.claims.dropHeld("alice", KEY), 1);
  assert.deepEqual(t.settled.at(-1), [102, "cancelled"]);
  assert.throws(() => ctx.claims.dropHeld("alice", KEY), { status: 404 });
});

test("a lease that runs out gives the task back; the next claim of the same machine resumes it", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk", { labels: ["unreal"] });
  const laptop = t.register("alice", "Laptop", { labels: ["unreal"] });
  await t.say("alice", "Deckhand\n/machine unreal\nGo.");
  t.ready();
  const first = await ctx.claims.claim("alice", desk);
  assert.equal(first.resume, false);
  // A heartbeat renews it.
  t.clock += LEASE_MS - 1000;
  assert.deepEqual(
    ctx.claims.renew("alice", desk).map((c) => c.run),
    ["run-1"],
  );
  t.clock += LEASE_MS - 1000;
  assert.deepEqual(ctx.claims.expire(), []);
  // A heartbeat that no longer lists it doesn't: it runs out.
  ctx.claims.renew("alice", desk, []);
  t.clock += LEASE_MS;
  assert.deepEqual(ctx.claims.expire(), [KEY]);
  const task = t.task();
  assert.equal(task.running, false);
  assert.deepEqual(
    task.pending.map((i) => i.text),
    ["Go."],
  );
  assert.deepEqual(ctx.claims.renew("alice", desk), []);
  t.ready();
  // Stuck to desk: the laptop, with the label, doesn't take it.
  assert.equal(await ctx.claims.claim("alice", laptop), null);
  const again = await ctx.claims.claim("alice", desk);
  assert.equal(again.resume, true);
  assert.match(again.message, /^Go\.\n\n\(This run is a new container/);
  // Its run given back by the machine gives the same; another's claim isn't theirs to release.
  assert.throws(() => ctx.claims.release("alice", laptop, again.run), { status: 404 });
  assert.equal(ctx.claims.release("alice", desk, again.run), KEY);
});

test("removing a machine ends its claims: its task waits again, for another of the owner's that fits", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk", { labels: ["unreal"] });
  const laptop = t.register("alice", "Laptop", { labels: ["unreal"] });
  await t.say("alice", "Deckhand\n/machine unreal");
  t.ready();
  await ctx.claims.claim("alice", desk);
  ctx.machines.remove("alice", desk);
  assert.equal(t.task().running, false);
  t.ready();
  const work = await ctx.claims.claim("alice", laptop);
  assert.equal(work.issue, 12);
  // A fresh session there.
  assert.equal(work.resume, false);
});

test("/cancel on a claimed task ends its claim, and the machine's heartbeat no longer lists it", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk");
  await t.say("alice", "Deckhand\n/machine Desk");
  t.ready();
  await ctx.claims.claim("alice", desk);
  await t.say("alice", "/cancel", { id: 101 });
  assert.equal(t.task().running, false);
  assert.deepEqual(ctx.claims.renew("alice", desk), []);
  assert.deepEqual(t.settled.slice(-2), [
    [100, "cancelled"],
    [101, "acknowledged"],
  ]);
});

test("a claim waits for work: a task that becomes ready wakes it", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk");
  const waiting = ctx.claims.claim("alice", desk, { wait: 60_000 });
  await t.say("alice", "Deckhand\n/machine Desk");
  t.ready();
  assert.equal((await waiting).issue, 12);
});

test("the board: a task waiting for its machine, then at work there", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk");
  await t.say("alice", "Deckhand\n/machine desk");
  t.ready();
  assert.deepEqual(ctx.claims.board(), [
    {
      key: KEY,
      repo: "org/repo",
      owner: "alice",
      want: "desk",
      via: "comment",
      machine: "Desk",
      claimed: false,
      available: true,
    },
  ]);
  await ctx.claims.claim("alice", desk);
  assert.equal(ctx.claims.board()[0].claimed, true);
});

test("/machine and runs-on: parsed from the comment and the labels", () => {
  const config = testConfig();
  assert.deepEqual(splitTrigger(config, "Deckhand /machine Desk box\nGo").machine, {
    want: "Desk box",
  });
  assert.deepEqual(splitTrigger(config, "/machine none").machine, { none: true });
  assert.equal(splitTrigger(config, "/machine none").trigger, null);
  assert.match(parseMachine("").error, /needs a machine/);
  assert.match(parseMachine("x".repeat(65)).error, /64 characters at most/);
  // Not "/machines".
  assert.equal(splitTrigger(config, "/machines are great").machine, null);
  assert.deepEqual(runsOn([{ name: "bug" }, { name: "runs-on:GPU" }, "runs-on:unreal"]), {
    name: "runs-on:GPU",
    label: "gpu",
  });
  assert.equal(runsOn([{ name: "runs-on:" }, { name: "runs-on:no spaces" }]), null);
  assert.equal(hasRunsOn({ labels: [{ name: "runs-on:unreal" }] }), true);
  assert.equal(branchSlug("修复登录"), "task");
  const m = { id: "a", owner: "alice", name: "Desk", labels: ["unreal"] };
  assert.equal(fits({ owner: "alice", want: "desk", machine: null }, m), true);
  assert.equal(fits({ owner: "alice", want: "unreal", machine: null }, m), true);
  assert.equal(fits({ owner: "alice", want: "unreal", machine: "b" }, m), false);
  assert.equal(fits({ owner: "bob", want: "unreal", machine: null }, m), false);
});

test("a claim saved with the queue comes back running on its machine, with a fresh lease", () => {
  const { t, ctx } = bench();
  const task = { repo: "org/repo", id: "12", pending: [], held: [] };
  ctx.claims.restore(task, { id: "run-1", machine: "m1", items: [], leaseUntil: 5 });
  assert.equal(task.running, true);
  assert.equal(task.pool, "machine:m1");
  assert.equal(task.claim.leaseUntil, t.clock + LEASE_MS);
});

test("/machine during a sandbox's run: that run keeps its slot, what comes next goes to the machine", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk");
  await t.say("alice", "Deckhand");
  t.ready();
  assert.deepEqual(t.started, ["12"]);
  assert.equal(ctx.running, 1);
  await t.say("alice", "Deckhand\n/machine Desk\nOn the desk now.", { id: 101 });
  // Named, the machine it sticks to at once.
  assert.equal(poolOf(t.task()), `machine:${desk}`);
  t.finish();
  assert.equal(ctx.running, 0);
  t.ready();
  assert.deepEqual(t.started, ["12"]);
  assert.equal((await ctx.claims.claim("alice", desk)).message, "On the desk now.");
});

// Deckhand's own fix round on issue 12, as reviews.mjs queues it.
const fixRound = (settings) => ({
  repo: "org/repo",
  id: "12",
  kind: "issue",
  number: 12,
  trigger: "work",
  modeLine: null,
  text: "Fix the findings.",
  replyTo: 30,
  comment: null,
  base: "main",
  settings,
  sender: null,
  reason: "review-fix",
});

test("a route that ends queues the comments held for its owner: /machine none, or its label taken off", async () => {
  const none = bench();
  none.t.register("alice", "Desk");
  await none.t.say("alice", "Deckhand\n/machine Desk");
  await none.t.say("bob", "Also do the menu.", { id: 101 });
  assert.equal(none.ctx.claims.heldOf(KEY).length, 1);
  await none.t.say("alice", "/machine none", { id: 102 });
  assert.deepEqual(none.ctx.claims.heldOf(KEY), []);
  none.t.ready();
  assert.deepEqual(none.t.started, ["12"]);

  const labels = [{ name: "runs-on:unreal" }];
  const label = bench({ labels, events: [labelledBy("alice")] });
  await label.t.say("alice", "Deckhand");
  await label.t.say("bob", "Also do the menu.", { id: 101 });
  assert.equal(label.ctx.claims.heldOf(KEY).length, 1);
  // The label off: bob's next comment finds no route, and his first goes with it.
  await label.t.say("bob", "And the credits.", { id: 102, issueLabels: [] });
  assert.deepEqual(label.ctx.claims.heldOf(KEY), []);
  assert.deepEqual(
    label.t.task().pending.map((i) => i.text),
    ["", "Also do the menu.", "And the credits."],
  );
});

test("a route that can't be read: the kept one goes on; a person is told; Deckhand's own item is queued again", async () => {
  const { t, ctx } = bench({ labels: [{ name: "runs-on:unreal" }], events: [labelledBy("alice")] });
  t.labelsFail = true;
  // No route kept yet: alice's comment from the dashboard is refused with a reply, its 👀 off.
  await ctx.accept({
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
    trigger: "work",
    modeLine: null,
    text: "Go.",
    replyTo: 12,
    comment: { id: 100 },
    base: "main",
    author: "alice",
    settings: (await ctx.repoSettings()).settings,
  });
  assert.match(t.replies.at(-1), /^Not queued: whether #12 runs on a machine/);
  assert.deepEqual(t.settled.at(-1), [100, "refused"]);
  assert.equal(t.task()?.pending.length ?? 0, 0);
  // A fix round: queued again once GitHub answers.
  const { settings } = await ctx.repoSettings();
  await ctx.accept(fixRound(settings));
  assert.equal(t.task()?.pending.length ?? 0, 0);
  t.labelsFail = false;
  for (let i = 0; i < 50 && !t.task()?.pending.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(
    t.task().pending.map((i) => i.reason),
    ["review-fix"],
  );
  assert.equal(poolOf(t.task()), "machines");
  // Its route kept now: a read that fails goes by it.
  t.labelsFail = true;
  await ctx.accept({ ...fixRound(settings), text: "Again." });
  assert.equal(t.task().pending.length, 2);
  assert.equal(poolOf(t.task()), "machines");
});

test("routed, the comments others queued before are held for the owner: a /machine line, or a runs-on label", async () => {
  const line = bench();
  line.t.register("alice", "Desk");
  await line.t.say("bob", "Deckhand\nDo X.");
  assert.equal(line.t.task().pending.length, 1);
  await line.t.say("alice", "/machine Desk", { id: 101 });
  assert.deepEqual(line.t.task().pending, []);
  assert.deepEqual(
    line.ctx.claims.heldOf(KEY).map((h) => h.author),
    ["bob"],
  );

  const labels = [{ name: "runs-on:unreal" }];
  const label = bench({ labels, events: [labelledBy("alice")] });
  await label.t.say("bob", "Deckhand\nDo X.", { issueLabels: [] });
  await label.t.say("alice", "Deckhand", { id: 101 });
  assert.deepEqual(
    label.t.task().pending.map((i) => i.author),
    ["alice"],
  );
  assert.deepEqual(
    label.ctx.claims.heldOf(KEY).map((h) => h.author),
    ["bob"],
  );
});

test("another user's runs-on label doesn't take the task while its owner's is still on", async () => {
  const { t, ctx } = bench({
    users: "alice,bob,carol",
    labels: [{ name: "runs-on:unreal" }],
    events: [labelledBy("alice")],
  });
  await t.say("alice", "Deckhand");
  const both = [{ name: "runs-on:aaa" }, { name: "runs-on:unreal" }];
  await t.say("alice", "More.", { id: 101, issueLabels: both });
  const route = ctx.claims.view(t.task());
  assert.deepEqual([route.owner, route.want], ["alice", "unreal"]);
});

test("Deckhand's own item whose route can't be read is tried a few times, then given up, logged", async () => {
  const { t, ctx } = bench({ labels: [{ name: "runs-on:unreal" }], events: [labelledBy("alice")] });
  ctx.routeRetryMs = 1;
  t.labelsFail = true;
  const { settings } = await ctx.repoSettings();
  await ctx.accept(fixRound(settings));
  for (let i = 0; i < 100 && !t.logs.some((l) => l.includes("after 5 tries")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(
    t.logs.some((l) => l.includes("can't be read after 5 tries")),
    t.logs.join("\n"),
  );
  assert.equal(t.task()?.pending.length ?? 0, 0);
});

test("a claim checks its comments again: one whose author left the repo's users isn't in the work, given back or not", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk");
  await t.say("alice", "Deckhand\n/machine Desk\nGo.");
  await t.say("bob", "Also the menu.", { id: 101 });
  ctx.claims.deliverHeld("alice", KEY);
  t.ready();
  const first = await ctx.claims.claim("alice", desk);
  assert.match(first.message, /Also the menu\./);
  // Its lease runs out; meanwhile bob leaves the repo's `users`.
  t.clock += LEASE_MS;
  ctx.claims.expire();
  const narrowed = parseRepoConfig("machines: true\nusers: [alice]", ctx.config).settings;
  ctx.repoSettings = async () => ({ settings: narrowed, errors: [] });
  t.ready();
  const again = await ctx.claims.claim("alice", desk);
  assert.equal(again.message.split("\n\n")[0], "Go.");
  assert.doesNotMatch(again.message, /menu/);
  assert.deepEqual(t.settled.at(-1), [101, "refused"]);
  assert.deepEqual(
    t.task().claim.items.map((i) => i.author),
    ["alice"],
  );
});

test("a claim whose task its owner moves while its work is read takes nothing, and leaves the route as moved", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk");
  await t.say("alice", "Deckhand\n/machine Desk");
  t.ready();
  const read = ctx.repoSettings;
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  ctx.repoSettings = async (...args) => {
    ctx.repoSettings = read;
    await gate;
    return read(...args);
  };
  const claiming = ctx.claims.claim("alice", desk);
  await new Promise((resolve) => setImmediate(resolve));
  await t.say("alice", "/machine none", { id: 101 });
  open();
  assert.equal(await claiming, null);
  assert.equal(t.task().claim, null);
  assert.equal(poolOf(t.task()), "shared");
  assert.equal(ctx.claims.view(t.task()), null);
  assert.equal(ctx.claims.kept({ ...t.task().pending[0], kind: "issue" }), null);
});

test("a claim whose machine is removed while its work is read writes no route back to it", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk");
  await t.say("alice", "Deckhand\n/machine Desk");
  t.ready();
  const read = ctx.repoSettings;
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  ctx.repoSettings = async (...args) => {
    ctx.repoSettings = read;
    await gate;
    return read(...args);
  };
  const claiming = ctx.claims.claim("alice", desk);
  await new Promise((resolve) => setImmediate(resolve));
  ctx.machines.remove("alice", desk);
  open();
  assert.equal(await claiming, null);
  assert.equal(t.task().claim, null);
  assert.equal(poolOf(t.task()), "machines");
  assert.equal(ctx.claims.view(t.task()).machine, null);
});

test("a repo config with errors: no claim takes its task, whose comments stay queued", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk");
  await t.say("alice", "Deckhand\n/machine Desk");
  t.ready();
  const broken = parseRepoConfig("machines: [nope", ctx.config);
  assert.ok(broken.errors.length);
  ctx.repoSettings = async () => broken;
  assert.equal(await ctx.claims.claim("alice", desk), null);
  assert.equal(t.task().pending.length, 1);
  assert.ok(t.logs.some((l) => l.includes(`${KEY}: not claimed, .deckhand.yaml has errors`)));
});

test("a repo config that can't be read skips its task alone: the next one is claimed", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk", { capacity: 2 });
  await t.say("alice", "Deckhand\n/machine Desk\nFirst.");
  t.clock += 1;
  await t.say("alice", "Deckhand\n/machine Desk\nSecond.", { number: 13, id: 101 });
  t.ready();
  const read = ctx.repoSettings;
  ctx.repoSettings = async (...args) => {
    ctx.repoSettings = read;
    throw new Error("GitHub answered 502");
  };
  const work = await ctx.claims.claim("alice", desk);
  assert.match(work.message, /Second\./);
  assert.equal(ctx.tasks.get(KEY).claim, null);
  assert.equal(ctx.tasks.get(KEY).pending.length, 1);
  assert.ok(
    t.logs.some((l) => l.includes(`${KEY}: not claimed, .deckhand.yaml couldn't be read: GitHub`)),
  );
  // The read back, the next claim takes the task it skipped.
  assert.match((await ctx.claims.claim("alice", desk)).message, /First\./);
});

test("a claim asks the access decision again: a refused start drops its comment, one that can't be decided keeps it", async () => {
  for (const said of [{ ok: false }, { ok: false, error: "the policy service is away" }]) {
    const { t, ctx } = bench();
    const desk = t.register("alice", "Desk");
    await t.say("alice", "Deckhand\n/machine Desk\nGo.");
    await t.say("bob", "Also the menu.", { id: 101 });
    ctx.claims.deliverHeld("alice", KEY);
    t.ready();
    const asked = [];
    ctx.permissions = {
      decide: async (login, repo, action) => {
        asked.push([login, action]);
        return login === "bob" ? said : { ok: true };
      },
    };
    const work = await ctx.claims.claim("alice", desk);
    assert.deepEqual(asked.sort(), [
      ["alice", "runs:start:work"],
      ["bob", "runs:start:work"],
    ]);
    if (said.error) {
      assert.match(work.message, /Also the menu\./);
      assert.ok(t.logs.includes(`${KEY}: runs:start:work not decided: ${said.error}`));
    } else {
      assert.doesNotMatch(work.message, /menu/);
      assert.deepEqual(t.settled.at(-1), [101, "refused"]);
    }
  }
});

test("an issue closed drops its route once its task is idle: then, or at the sweep after its run", async () => {
  const { t, ctx } = bench();
  const desk = t.register("alice", "Desk");
  await t.say("alice", "Deckhand\n/machine Desk");
  t.ready();
  await ctx.claims.claim("alice", desk);
  // Closed while its machine holds it: kept, the claim's.
  assert.equal(ctx.claims.forget(KEY), false);
  assert.equal(ctx.claims.view(t.task()).machine, "Desk");
  const closed = new Map([[KEY, "completed"]]);
  ctx.titles = {
    ...ctx.titles,
    keys: () => [...closed.keys(), "org/repo#3"],
    closed: (key) => closed.get(key) ?? null,
  };
  assert.deepEqual(ctx.claims.forgetClosed(), []);
  // Its claim over: the next sweep drops it, the task shared again.
  ctx.claims.cancel(t.task(), "alice");
  assert.deepEqual(ctx.claims.forgetClosed(), [KEY]);
  assert.equal(ctx.claims.view(t.task()), null);
  assert.equal(poolOf(t.task()), "shared");
  assert.match(t.logs.at(-1), /org\/repo#12: its route dropped, the issue closed/);
  // Nothing left to drop.
  assert.equal(ctx.claims.forget(KEY), false);
  assert.deepEqual(ctx.claims.forgetClosed(), []);
});

test("a closed issue's `/machine none` goes too; a reopened one routes again from its runs-on label", async () => {
  const labels = [{ name: "runs-on:unreal" }];
  const { t, ctx } = bench({ labels, events: [labelledBy("alice")] });
  await t.say("alice", "/machine none");
  assert.equal(t.task(), undefined);
  assert.equal(ctx.claims.forget(KEY), true);
  const item = {
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
    settings: (await ctx.repoSettings()).settings,
  };
  const route = await ctx.claims.routeFor(item, labels);
  assert.equal(route.owner, "alice");
  assert.equal(route.via, "label");
});

test("start() sweeps the closed issues' routes at once, then hourly; stop() ends both timers", async () => {
  const timers = [];
  const { t, ctx } = bench();
  const routes = new Map();
  ctx.claims = createClaims(ctx, {
    routes,
    every: (fn, ms) => (timers.push(ms), { unref: () => {} }),
  });
  routes.set(KEY, { none: true, by: "alice", at: 1 });
  ctx.titles = { ...ctx.titles, keys: () => [KEY], closed: () => "not_planned" };
  ctx.claims.start();
  assert.equal(routes.size, 0);
  assert.deepEqual(timers, [5000, 3_600_000]);
  ctx.claims.stop();
  assert.equal(t.started.length, 0);
});
