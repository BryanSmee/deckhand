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
import { machinePullBody } from "../listener/machine-pulls.mjs";
import { createMachines } from "../listener/machines.mjs";
import { createPulls } from "../listener/pulls.mjs";
import { NEEDS_INPUT } from "../listener/questions.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createRequests } from "../listener/requests.mjs";
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
  // Its agents' requests (#600), their timeouts on the test's clock (`advance()`).
  clock.timers ??= new Set();
  ctx.requests = createRequests(ctx, {
    now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock.at + ms };
      clock.timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => clock.timers.delete(timer),
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
    await other.ctx.requests.load();
    other.ctx.requests.start();
    return other;
  };
  // The clock moved on by `ms`, the timers due by then fired in their order.
  const advance = (ms) => {
    clock.at += ms;
    for (const timer of [...clock.timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > clock.at || !clock.timers.has(timer)) continue;
      clock.timers.delete(timer);
      timer.fn();
    }
  };
  return { ctx, said, clock, say, ready, task, run, next, settings, advance };
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
  assert.deepEqual(asked, { key: KEY, status: "needs-input", pull: null });
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
  assert.deepEqual(finished, { key: KEY, status: "ok", pull: null });
  assert.match(
    said.answers[1].body,
    /^Done: the main menu\.\n\n<sub>🤖 Claude · on Desk · 1\.5 min/,
  );
  assert.equal(b.run(again.run).status, "ok");
  // Nothing of a sandbox's was ever asked for: no runner, broker or models call.
  assert.deepEqual(said.runner, []);
});

test("a claim's work says where to clone and which hosts to allow; how the machine runs it is its record's, its log's and its reply's (#599)", async (t) => {
  const b = bench(t);
  const { ctx, said } = b;
  ctx.grantOf = async (repo) => (repo === "org/repo" ? { hosts: ["Assets.example.com"] } : null);
  const desk = b.register("alice", "Desk");
  await b.say("alice", "Deckhand\n/machine Desk\nBuild it.");
  b.ready();
  const setup = { version: "2.1.3", sandbox: false, permissionMode: "acceptEdits", suggested: true };
  const work = await ctx.claims.claim("alice", desk, { reported: { agent: "claude", setup } });
  assert.equal(work.cloneUrl, "https://github.com/org/repo.git");
  // The agent's API, GitHub's and the grant's: what a sandbox run of the repository reaches.
  for (const host of ["api.anthropic.com", "github.com", "assets.example.com"]) {
    assert.ok(work.hosts.includes(host), host);
  }
  const record = b.run(work.run);
  assert.deepEqual(record.setup, setup);
  const logged = readFileSync(join(ctx.logDir, `${work.run}.log`), "utf8");
  assert.match(
    logged,
    /As Desk reports it, not checked by Deckhand: v2\.1\.3, sandbox off, `acceptEdits`, Deckhand's settings\./,
  );
  await ctx.claims.finish("alice", desk, work.run, { outcome: "ok", reply: "Built." });
  assert.match(
    said.answers.at(-1).body,
    /· on Desk \(v2\.1\.3, sandbox off, `acceptEdits`, Deckhand's settings, as it reports\)/,
  );

  // A grant that can't be read: the hosts every run needs, still.
  ctx.grantOf = async () => {
    throw new Error("no policies");
  };
  await b.say("alice", "Deckhand\nAgain.", { id: 102 });
  b.ready();
  const again = await ctx.claims.claim("alice", desk, { reported: {} });
  assert.ok(again.hosts.includes("github.com"));
  assert.ok(!again.hosts.includes("assets.example.com"));
  assert.equal(b.run(again.run).setup, null);
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

// GitHub as a machine's pull request reads and writes it (machine-pulls.mjs): org/repo's branches
// (`refs`: name → head) and pull requests, the App's writes recorded in `writes`.
function fakeGithub(b, refs) {
  const pulls = [];
  const writes = [];
  b.ctx.pulls = createPulls({ listPulls: async () => [] });
  b.ctx.graphql = async (repo, query, variables) => {
    writes.push(["graphql", /markPullRequestReadyForReview/.test(query), variables.id]);
    const pr = pulls.find((p) => p.node_id === variables.id);
    pr.draft = false;
    return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
  };
  b.ctx.github = async (repo, method, path, body) => {
    const ref = /^\/repos\/org\/repo\/git\/ref\/heads\/(.+)$/.exec(path);
    if (method === "GET" && ref) {
      const sha = refs[ref[1]];
      return sha ? Response.json({ object: { sha } }) : new Response("{}", { status: 404 });
    }
    const listed = /^\/repos\/org\/repo\/pulls\?head=([^&]+)&state=open$/.exec(path);
    if (method === "GET" && listed) {
      const [, branch] = decodeURIComponent(listed[1]).split(":");
      return Response.json(pulls.filter((p) => p.state === "open" && p.head.ref === branch));
    }
    if (method === "POST" && path === "/repos/org/repo/pulls") {
      writes.push(["POST", body]);
      const number = 30 + pulls.length;
      const pr = {
        number,
        node_id: `PR_${number}`,
        html_url: `https://github.com/org/repo/pull/${number}`,
        state: "open",
        draft: body.draft,
        title: body.title,
        body: body.body,
        user: { login: "deckhand[bot]", type: "Bot" },
        head: { ref: body.head, sha: refs[body.head], repo: { full_name: "org/repo" } },
        base: { ref: body.base },
      };
      pulls.push(pr);
      return Response.json(pr, { status: 201 });
    }
    return new Response("{}", { status: 404 });
  };
  return { pulls, writes };
}

test("finish with a pushed branch: the App opens its pull request, a machine's, after checking the branch is the issue's and at that head", async (t) => {
  const b = bench(t);
  const { ctx, said } = b;
  const branch = "issue-12-build-the-level";
  const sha = "a".repeat(40);
  const refs = { [branch]: sha, "issue-13-other": "b".repeat(40) };
  const gh = fakeGithub(b, refs);
  const { desk, work } = await claimed(b);
  assert.equal(work.branch, branch);
  const finish = (pushed, outcome = "ok") =>
    ctx.claims.finish("alice", desk, work.run, { outcome, reply: "Built.", pushed });
  // Another issue's branch, one that isn't in the repository (a fork's), a head that isn't
  // what it says, a sha that isn't one: refused, nothing opened, the run going on.
  for (const [pushed, status] of [
    [{ branch: "issue-13-other", sha: "b".repeat(40) }, 400],
    [{ branch: "main", sha }, 400],
    [{ branch: "issue-12-../main", sha }, 400],
    [{ branch: "issue-12-on-a-fork", sha }, 409],
    [{ branch, sha: "c".repeat(40) }, 409],
    [{ branch, sha: "HEAD" }, 400],
  ]) {
    await assert.rejects(finish(pushed), (error) => {
      assert.ok(error instanceof Refused, error.stack);
      assert.equal(error.status, status, `${JSON.stringify(pushed)}: ${error.message}`);
      return true;
    });
  }
  assert.deepEqual(gh.writes, []);
  assert.equal(b.run(work.run).status, "running");
  assert.deepEqual(said.answers, []);

  // Its own branch at its head: the App opens the draft, ready for review as asked, then the
  // run's end as any.
  const done = await finish({ branch, sha, ready: true });
  assert.deepEqual(done.pull, {
    number: 30,
    url: "https://github.com/org/repo/pull/30",
    state: "ready",
    opened: true,
    moved: true,
  });
  assert.deepEqual(gh.writes, [
    [
      "POST",
      {
        title: "Build the level",
        head: branch,
        base: "main",
        body: machinePullBody(12, "alice", "Desk"),
        draft: true,
      },
    ],
    ["graphql", true, "PR_30"],
  ]);
  assert.match(gh.writes[0][1].body, /^Closes #12\n/);
  // Recorded as a machine's, for the dashboard and the policies' `pr.external`.
  assert.equal(ctx.pulls.get(KEY).external, "alice");
  assert.equal(ctx.pulls.get(KEY).head, sha);
  assert.equal(ctx.pulls.externalOf("org/repo", 30), "alice");
  assert.equal(ctx.pulls.externalOf("org/repo", 31), null);
  // A delivery about it later says nothing of machines: it stays one.
  ctx.pulls.record(KEY, { number: 30, url: "u", state: "ready", readyAt: null, head: sha });
  assert.equal(ctx.pulls.externalOf("org/repo", 30), "alice");
  // Its record has the push, for what follows a run that pushed (its reviewers again).
  const record = b.run(work.run);
  assert.deepEqual([record.status, record.branch], ["ok", branch]);
  assert.ok(record.lastPushAt);
  assert.equal(said.answers.at(-1).to, 12);

  // Its review requests changes: the fix round, Deckhand's own, sticks to Desk, which pushes
  // to the same branch; the App finds its pull request, opens none.
  await ctx.accept({
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
    reason: "review-fix",
  });
  const laptop = b.register("alice", "Laptop");
  b.ready();
  assert.equal(await ctx.claims.claim("alice", laptop), null, "not another machine of hers");
  const fix = await ctx.claims.claim("alice", desk);
  assert.ok(fix, "Desk claims the fix round");
  assert.equal(fix.resume, true);
  const fixed = await ctx.claims.finish("alice", desk, fix.run, {
    outcome: "ok",
    reply: "Fixed.",
    pushed: { branch, sha, ready: true },
  });
  // Nothing pushed since: not a push of this run's.
  assert.deepEqual([fixed.pull.number, fixed.pull.opened, fixed.pull.moved], [30, false, false]);
  assert.equal(b.run(fix.run).lastPushAt, null);
  assert.equal(gh.writes.length, 2, "nothing written again");
  assert.deepEqual(said.after.at(-1), ["fixed", 30, "ok"]);

  // The next round pushes, and GitHub's `synchronize` delivery of it is recorded before its
  // finish: still a push of this run's, by the head the pull request had at its claim.
  await b.say("alice", "Once more.", { id: 104 });
  b.ready();
  const again = await ctx.claims.claim("alice", desk);
  const pushed = "d".repeat(40);
  refs[branch] = pushed;
  gh.pulls[0].head.sha = pushed;
  ctx.pulls.record(KEY, { number: 30, url: "u", state: "ready", readyAt: null, head: pushed });
  const round = await ctx.claims.finish("alice", desk, again.run, {
    outcome: "ok",
    pushed: { branch, sha: pushed },
  });
  assert.equal(round.pull.moved, true);
  assert.ok(b.run(again.run).lastPushAt);
});

test("finish with a pushed branch: the pull request is marked a machine's before marking it ready can fail", async (t) => {
  const b = bench(t);
  const { ctx } = b;
  const branch = "issue-12-build-the-level";
  const sha = "a".repeat(40);
  const gh = fakeGithub(b, { [branch]: sha });
  ctx.graphql = async () => {
    throw new Error("GitHub GraphQL: 502");
  };
  const { desk, work } = await claimed(b);
  await assert.rejects(
    ctx.claims.finish("alice", desk, work.run, {
      outcome: "ok",
      pushed: { branch, sha, ready: true },
    }),
    /502/,
  );
  // Opened, and already the machine's: machines.rego holds whoever marks it ready.
  assert.equal(gh.pulls.length, 1);
  assert.equal(ctx.pulls.externalOf("org/repo", 30), "alice");
  // Asked again: found, not opened twice.
  ctx.graphql = async () => ({});
  const done = await ctx.claims.finish("alice", desk, work.run, {
    outcome: "ok",
    pushed: { branch, sha, ready: true },
  });
  assert.deepEqual([done.pull.number, done.pull.opened, done.pull.state], [30, false, "ready"]);
  assert.equal(gh.pulls.length, 1);
});

test("finish with a pushed branch: a branch with nothing beyond its base is said so", async (t) => {
  const b = bench(t);
  const { ctx } = b;
  const branch = "issue-12-build-the-level";
  const sha = "a".repeat(40);
  fakeGithub(b, { [branch]: sha });
  const github = ctx.github;
  ctx.github = async (repo, method, path, body, expected) =>
    method === "POST"
      ? Response.json(
          {
            message: "Validation Failed",
            errors: [{ message: "No commits between main and issue-12-build-the-level" }],
          },
          { status: 422 },
        )
      : github(repo, method, path, body, expected);
  const { desk, work } = await claimed(b);
  await assert.rejects(
    ctx.claims.finish("alice", desk, work.run, { outcome: "ok", pushed: { branch, sha } }),
    {
      status: 409,
      message: "issue-12-build-the-level has no commits beyond main: nothing to open.",
    },
  );
  assert.equal(b.run(work.run).status, "running");
});

test("a pull request a machine's claim covers is the machine's, whether or not finish names its branch", async (t) => {
  const b = bench(t);
  const { ctx } = b;
  fakeGithub(b, {});
  // A sandbox run's pull request, open when the issue moves to Desk: marked at the claim.
  const sandbox = { number: 30, url: "u", state: "ready", readyAt: null, head: "a".repeat(40) };
  ctx.pulls.record(KEY, sandbox);
  const { desk, work } = await claimed(b);
  assert.equal(ctx.pulls.externalOf("org/repo", 30), "alice");
  await ctx.claims.finish("alice", desk, work.run, { outcome: "ok", reply: "Fixed." });
  assert.equal(ctx.pulls.externalOf("org/repo", 30), "alice");

  // One the pulls store learns of during the run, the run finishing without `branch`: marked
  // at its end.
  const other = bench(t);
  fakeGithub(other, {});
  const second = await claimed(other);
  other.ctx.pulls.record(KEY, { ...sandbox, number: 31 });
  assert.equal(other.ctx.pulls.externalOf("org/repo", 31), null);
  await other.ctx.claims.finish("alice", second.desk, second.work.run, { outcome: "ok" });
  assert.equal(other.ctx.pulls.externalOf("org/repo", 31), "alice");

  // Or given back (its lease run out): marked all the same.
  const third = bench(t);
  fakeGithub(third, {});
  const given = await claimed(third);
  third.ctx.pulls.record(KEY, { ...sandbox, number: 32 });
  third.ctx.claims.release("alice", given.desk, given.work.run);
  assert.equal(third.ctx.pulls.externalOf("org/repo", 32), "alice");
  // A closed one isn't.
  const fourth = bench(t);
  fakeGithub(fourth, {});
  fourth.ctx.pulls.record(KEY, { ...sandbox, number: 33, state: "merged" });
  await claimed(fourth);
  assert.equal(fourth.ctx.pulls.externalOf("org/repo", 33), null);
});

test("finish with a pushed branch: a pull request from it that isn't the App's, or closes another issue, is refused", async (t) => {
  const b = bench(t);
  const { ctx } = b;
  const branch = "issue-12-build-the-level";
  const sha = "a".repeat(40);
  const gh = fakeGithub(b, { [branch]: sha });
  const { desk, work } = await claimed(b);
  const theirs = {
    number: 7,
    state: "open",
    body: "Closes #12",
    user: { login: "alice", type: "User" },
    head: { ref: branch, sha, repo: { full_name: "org/repo" } },
  };
  gh.pulls.push(theirs);
  const finish = () =>
    ctx.claims.finish("alice", desk, work.run, { outcome: "ok", pushed: { branch, sha } });
  await assert.rejects(finish(), {
    status: 409,
    message: /#7 is open from .*not opened by Deckhand/,
  });
  Object.assign(theirs, { user: { login: "deckhand[bot]", type: "Bot" }, body: "Closes #13" });
  await assert.rejects(finish(), { status: 409, message: /doesn't close #12/ });
  assert.deepEqual(gh.writes, []);
  assert.equal(b.run(work.run).status, "running");
  // Its own, a draft without `ready`: found, left a draft, the run over.
  theirs.body = "Closes #12";
  theirs.draft = true;
  const done = await finish();
  assert.deepEqual([done.pull.number, done.pull.state, done.pull.opened], [7, "draft", false]);
  assert.deepEqual(gh.writes, []);
  assert.equal(ctx.pulls.externalOf("org/repo", 7), "alice");
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

// --- Its agent's permission requests (#600) --------------------------------------------------

const BASH = { tool: "Bash", input: { command: "make level" }, toolUseId: "toolu_1" };

test("a machine run's tool call waits for its owner: on the dashboard and the issue; the owner's /allow reaches it, another's is ignored", async (t) => {
  const b = bench(t);
  const { ctx, said } = b;
  const { desk, work } = await claimed(b);
  const replies = said.replies.length;
  // An input that would be markup, a mention and a fence's end.
  const input = {
    command: "echo '**bold** <img src=x onerror=alert(1)> @bob ``` done' && cat ~/.ssh/id_rsa",
  };
  const call = ctx.claims.approve("alice", desk, work.run, { ...BASH, input }, { wait: 60_000 });
  await until(() => said.replies.length > replies, { what: "the request's comment" });
  const asking = said.replies.at(-1);
  assert.match(
    asking,
    /^@alice, the agent on your machine Desk asks to use a tool \(request `[0-9a-f]{6}`\):/,
  );
  // The tool and its input in a fence longer than any run of backticks in it: shown as text.
  assert.ok(
    asking.includes(
      "\n````text\nBash: echo '**bold** <img src=x onerror=alert(1)> @bob ``` done' && cat ~/.ssh/id_rsa\n````\n",
    ),
  );
  assert.match(asking, /`\/allow` \(this call\), `\/allow run`.*`\/deny`/);
  assert.match(asking, /within 10 min, it is denied\. Only @alice's answer counts\./);
  // On the dashboard, the task's.
  const [shown] = ctx.requests.toolRequests(KEY);
  assert.deepEqual(
    [shown.tool, shown.machine, shown.owner, shown.state],
    ["Bash", "Desk", "alice", "pending"],
  );
  assert.equal(shown.expiresAt - shown.at, 10 * 60_000);
  // In the run's log.
  await until(() =>
    readFileSync(join(ctx.logDir, `${work.run}.log`), "utf8").includes("Permission asked: Bash"),
  );

  // Bob's `/allow`: ignored, neither an answer nor a comment for the run.
  await b.say("bob", "/allow", { id: 103 });
  assert.equal(ctx.requests.toolRequests(KEY).length, 1);
  assert.equal(said.replies.length, replies + 1);
  // Bob on the dashboard: refused.
  assert.equal((await ctx.requests.answerTool("bob", KEY, shown.id, "once")).error, 403);

  // Alice's: the call has its answer, her comment a 👍; neither queued nor sent to the agent.
  await b.say("alice", "/allow", { id: 104 });
  assert.deepEqual(await call, {
    request: shown.id,
    state: "granted",
    message: "Allowed by alice once.",
  });
  assert.deepEqual(said.settled.at(-1), [104, "acknowledged"]);
  assert.deepEqual(b.task().pending, []);
  assert.deepEqual(b.task().live.outbox, []);
  assert.deepEqual(ctx.requests.toolRequests(KEY), []);
  // Allowed once: the next call of the same tool asks again.
  const again = ctx.claims.approve(
    "alice",
    desk,
    work.run,
    { ...BASH, toolUseId: "toolu_2" },
    {
      wait: 60_000,
    },
  );
  await until(() => ctx.requests.toolRequests(KEY).length === 1);
  await b.say("alice", "/deny", { id: 105 });
  assert.equal((await again).state, "denied");
  assert.equal(said.replies.length, replies + 2);
});

test("Allow for this run: that tool's later calls are allowed without asking; a call asked again finds its request", async (t) => {
  const b = bench(t);
  const { ctx, said } = b;
  const { desk, work } = await claimed(b);
  const first = await ctx.claims.approve("alice", desk, work.run, BASH, { wait: 0 });
  assert.equal(first.state, "pending");
  // Asked again (its driver waiting on): the same request, not a second one.
  const polled = ctx.claims.approve("alice", desk, work.run, BASH, { wait: 60_000 });
  assert.equal(ctx.requests.toolRequests(KEY).length, 1);
  // Several waiting: `/allow` alone names none; with its id, it answers that one.
  const other = ctx.claims.approve(
    "alice",
    desk,
    work.run,
    { tool: "Write", input: { file_path: "Level.umap" }, toolUseId: "toolu_w" },
    { wait: 60_000 },
  );
  const asking = () => said.replies.filter((r) => r.includes("asks to use a tool")).length;
  await until(() => asking() === 2, { what: "both requests' comments" });
  const before = said.replies.length;
  await b.say("alice", "/allow run", { id: 106 });
  assert.match(
    said.replies.at(-1),
    /^Several requests wait: `[0-9a-f]{6}` \(Bash\), `[0-9a-f]{6}` \(Write\)\./,
  );
  assert.equal(said.replies.length, before + 1);
  await b.say("alice", `/allow ${first.request.slice(0, 8)} run`, { id: 107 });
  assert.deepEqual(await polled, {
    request: first.request,
    state: "granted",
    message: "Allowed by alice for this run.",
  });
  // Bash from now on, without asking; Write still waits, and is denied from the dashboard.
  const replies = said.replies.length;
  const later = await ctx.claims.approve(
    "alice",
    desk,
    work.run,
    { tool: "Bash", input: { command: "make test" }, toolUseId: "toolu_3" },
    { wait: 0 },
  );
  assert.equal(later.state, "granted");
  assert.equal(later.message, "Allowed: alice allowed Bash for this run.");
  assert.equal(said.replies.length, replies);
  const [write] = ctx.requests.toolRequests(KEY);
  assert.equal(write.tool, "Write");
  assert.equal(write.input, "Level.umap");
  assert.equal(
    (await ctx.requests.answerTool("alice", KEY, write.id, "deny")).request.state,
    "denied",
  );
  assert.equal((await other).state, "denied");
});

test("no answer within the timeout denies the call; the lease stays alive while it waits", async (t) => {
  const b = bench(t);
  const { ctx } = b;
  const { desk, work } = await claimed(b);
  let answer = null;
  // The driver asks again each time its call answers "pending", 25 s apart: no heartbeat at all.
  for (let waited = 0; waited <= 11 * 60_000 && !answer; waited += 25_000) {
    const call = ctx.claims.approve("alice", desk, work.run, BASH, { wait: 25_000 });
    // Its wait armed before the clock moves on.
    const due = b.clock.at + 25_000;
    await until(() => [...b.clock.timers].some((timer) => timer.at === due));
    b.advance(25_000);
    const said = await call;
    if (said.state !== "pending") answer = said;
    // Long past LEASE_MS: still claimed.
    assert.deepEqual(ctx.claims.expire(), []);
  }
  assert.ok(answer, "the timeout answers");
  assert.equal(answer.state, "denied");
  assert.equal(answer.message, "Denied: alice didn't answer within 10 min.");
  assert.equal(b.task().claim.id, work.run);
  assert.ok(b.clock.at - b.task().claim.claimedAt >= 5 * LEASE_MS);
  // Without the calls (nor a heartbeat), the lease runs out as before.
  b.advance(LEASE_MS + 1);
  assert.deepEqual(ctx.claims.expire(), [KEY]);
});

test("the run ending denies the calls waiting; the next copy has the requests", async (t) => {
  const b = bench(t);
  const { ctx } = b;
  const { desk, work } = await claimed(b);
  assert.equal(
    (await ctx.claims.approve("alice", desk, work.run, BASH, { wait: 0 })).state,
    "pending",
  );
  await until(async () => Object.keys((await b.store.get("permission-requests")) ?? {}).length);
  // A handover: the next copy shows it, and its driver's call finds it there.
  const other = await b.next();
  const [kept] = other.ctx.requests.toolRequests(KEY);
  assert.equal(kept.tool, "Bash");
  const call = other.ctx.claims.approve("alice", desk, work.run, BASH, { wait: 60_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(other.ctx.requests.toolRequests(KEY).length, 1);
  await other.ctx.claims.finish("alice", desk, work.run, { outcome: "ok", reply: "Built." });
  assert.deepEqual(await call, {
    request: kept.id,
    state: "denied",
    message: "Denied: this run has ended.",
  });
});
