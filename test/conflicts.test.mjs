import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createConflicts,
  intoDefaultBranch,
  noRebaseText,
  rebaseMessage,
} from "../listener/conflicts.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createStopped } from "../listener/stopped.mjs";
import { busyTask } from "../listener/tasks.mjs";
import { mapStore, policyEngine, testConfig } from "./helpers.mjs";

const MIN = 60_000;
const config = testConfig({ CONFLICT_CHECK_MINUTES: "5" });
const optedIn = (minutes = 10, c = config) =>
  parseRepoConfig(`conflicts:\n  check_minutes: ${minutes}`, c);

// A map of attempts in a store, holding `entries`.
async function stored(maps, entries = {}) {
  const attempts = await maps.map("conflicts");
  for (const [key, value] of Object.entries(entries)) attempts.set(key, value);
  return attempts;
}
const saved = async (maps) => Object.fromEntries(await maps.again("conflicts"));

// A pull request as GET /repos/{repo}/pulls/{n} has it.
function pull(number, fields = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: "open",
    mergeable: false,
    mergeable_state: "dirty",
    labels: [],
    head: { sha: "head-1", repo: { full_name: "org/repo" } },
    base: { ref: "main", sha: "stale" },
    ...fields,
  };
}

// The watcher with fake GitHub, clock and queue. `github`: { "/path": body | () => body },
// missing paths answer 404.
function setup({
  open = [["org/repo#30", { number: 31, state: "draft" }]],
  prs = { 31: pull(31) },
  issue = { labels: [] },
  baseSha = "base-1",
  settings = optedIn(),
  busy = () => false,
  stopped,
  c = config,
  attempts = new Map(),
  routes: more = {},
  sleep,
  policies = null,
  fixes = 0,
  looping = () => false,
  reply = null,
  metrics = null,
} = {}) {
  let time = 1_800_000_000_000;
  const calls = [];
  const accepted = [];
  const replies = [];
  const decided = [];
  const logged = [];
  const seen = [];
  const routes = {
    "/repos/org/repo/pulls/31/files?per_page=100&page=1": () => w.files,
    "/repos/org/repo": { default_branch: "main" },
    "/repos/org/repo/git/ref/heads/main": () => ({ object: { sha: w.baseSha } }),
    "/repos/org/repo/issues/30": () => w.issue,
    ...more,
  };
  const w = {
    files: [{ filename: "migrations/1.sql", status: "modified", additions: 3, deletions: 1 }],
    prs,
    issue,
    baseSha,
    settings,
    calls,
    accepted,
    replies,
    decided,
    logged,
    seen,
    advance: (ms) => (time += ms),
  };
  w.conflicts = createConflicts({
    attempts,
    config: c,
    pulls: { open: () => open, sawMerge: (key, pr) => seen.push([key, pr.mergeable]) },
    github: async (repo, method, url) => {
      calls.push(url);
      const pr = /\/pulls\/(\d+)$/.exec(url);
      const route = pr ? w.prs[pr[1]] : routes[url];
      const body = typeof route === "function" ? await route() : route;
      return body
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response("{}", { status: 404 });
    },
    repoSettings: async () => w.settings,
    busy,
    ...(stopped && { stopped }),
    accept: async (item) => accepted.push(item),
    policies,
    decided: (key, entry) => decided.push({ key, ...entry }),
    fixes: (repo, number) => (repo === "org/repo" && number === 31 ? fixes : 0),
    looping,
    reply: reply ?? (async (repo, number, text) => replies.push({ repo, number, text })),
    log: (line) => logged.push(line),
    now: () => time,
    metrics,
    ...(sleep ? { sleep } : {}),
  });
  return w;
}

test("a dirty pull request starts one work run with the rebase message", async () => {
  const w = setup();
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  const item = w.accepted[0];
  assert.deepEqual(
    { ...item, settings: undefined },
    {
      repo: "org/repo",
      id: "30",
      kind: "issue",
      number: 30,
      title: null,
      trigger: "work",
      modeLine: null,
      text: rebaseMessage("main"),
      replyTo: 31,
      comment: null,
      base: "main",
      settings: undefined,
      sender: null,
      reason: "conflict",
      rebaseFrom: "head-1",
    },
  );
  assert.match(item.text, /rebase it on `origin\/main`.*--force-with-lease.*stop and ask/s);
  // Still in conflict at the next check: same pair, no second run.
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
});

test("no rebase run while the pull request's review loop decides a step or waits for CI (#896)", async () => {
  let looping = true;
  const asked = [];
  const w = setup({
    looping: (repo, number) => {
      asked.push([repo, number]);
      return looping;
    },
  });
  assert.deepEqual(await w.conflicts.tick(), { started: 0, pending: 0, errors: [] });
  assert.deepEqual([w.accepted, asked], [[], [["org/repo", 31]]]);
  // Skipped before its attempt is kept: once the loop is done, the next check starts it.
  w.advance(10 * MIN);
  looping = false;
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  // The loop's next step begun during the watcher's own calls: checked again before it starts.
  let calls = 0;
  const late = setup({ looping: () => ++calls > 1 });
  await late.conflicts.tick();
  assert.deepEqual([late.accepted, calls], [[], 2]);
  late.advance(10 * MIN);
  calls = -10;
  await late.conflicts.tick();
  assert.equal(late.accepted.length, 1);
});

test("a stopped task gets no rebase run until it is triggered again (#1003)", async () => {
  const marks = createStopped();
  marks.stop("Org/Repo#30", "alice");
  const w = setup({ stopped: (key) => marks.has(key) });
  assert.deepEqual(await w.conflicts.tick(), { started: 0, pending: 0, errors: [] });
  assert.deepEqual(w.accepted, []);
  // Not even asked about, and its attempt not kept: the next check after a trigger rebases.
  assert.ok(!w.calls.some((u) => u.includes("/pulls/")));
  w.advance(10 * MIN);
  marks.clear("org/repo#30");
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  // Stopped during the watcher's own calls: checked again before it starts.
  let calls = 0;
  const late = setup({ stopped: () => ++calls > 1 });
  await late.conflicts.tick();
  assert.deepEqual([late.accepted, calls], [[], 2]);
});

test("a pull request without an issue is its own task", async () => {
  const w = setup({
    open: [["org/repo#pr-31", { number: 31, state: "ready" }]],
  });
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  assert.deepEqual(
    [w.accepted[0].id, w.accepted[0].kind, w.accepted[0].number, w.accepted[0].title],
    ["pr-31", "pr", 31, "PR 31"],
  );
});

test("clean, unstable, blocked, behind and not yet computed don't start a run", async () => {
  for (const fields of [
    { mergeable: true, mergeable_state: "clean" },
    { mergeable: true, mergeable_state: "unstable" },
    { mergeable: true, mergeable_state: "blocked" },
    { mergeable: true, mergeable_state: "behind" },
    { mergeable: null, mergeable_state: "unknown" },
  ]) {
    const w = setup({ prs: { 31: pull(31, fields) } });
    await w.conflicts.tick();
    assert.deepEqual(w.accepted, [], JSON.stringify(fields));
  }
});

test("what each check read is passed to pulls.mjs, for the dashboard (#638)", async () => {
  const w = setup({
    open: [31, 41, 51].map((n) => [`org/repo#${n - 1}`, { number: n, state: "ready" }]),
    prs: {
      31: pull(31),
      41: pull(41, { mergeable: true, mergeable_state: "clean" }),
      51: pull(51, { mergeable: null, mergeable_state: "unknown" }),
    },
  });
  await w.conflicts.tick();
  assert.deepEqual(w.seen, [
    ["org/repo#30", false],
    ["org/repo#40", true],
    ["org/repo#50", null],
  ]);
});

test("each pull request's check counted by its result (deckhand_conflict_checks_total)", async () => {
  const results = [];
  const w = setup({
    open: [31, 41, 51, 61, 71].map((n) => [`org/repo#${n - 1}`, { number: n, state: "draft" }]),
    prs: {
      31: pull(31),
      41: pull(41, { mergeable: true, mergeable_state: "clean" }),
      51: pull(51, { mergeable: null, mergeable_state: "unknown" }),
      61: pull(61),
      71: () => {
        throw new Error("GitHub is down");
      },
    },
    busy: (key) => key === "org/repo#60",
    metrics: { conflictCheck: (result) => results.push(result) },
  });
  const counts = await w.conflicts.tick();
  assert.deepEqual(results, ["started", "clean", "pending", "skipped", "error"]);
  assert.deepEqual([counts.started, counts.pending], [1, 1]);
});

test("mergeable: null is asked again at the next tick, not the next interval", async () => {
  const w = setup({ prs: { 31: pull(31, { mergeable: null, mergeable_state: "unknown" }) } });
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 0);
  w.prs[31] = pull(31);
  w.advance(MIN);
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
});

test("running or queued tasks, forks, closed pull requests and needs-input are left alone", async () => {
  const cases = {
    busy: setup({ busy: () => true }),
    fork: setup({ prs: { 31: pull(31, { head: { sha: "h", repo: { full_name: "x/repo" } } }) } }),
    gone: setup({ prs: { 31: pull(31, { head: { sha: "h", repo: null } }) } }),
    closed: setup({ prs: { 31: pull(31, { state: "closed" }) } }),
    labelled: setup({ prs: { 31: pull(31, { labels: [{ name: "needs-input" }] }) } }),
    "issue labelled": setup({ issue: { labels: [{ name: "needs-input" }] } }),
    // GitHub's label names are case-insensitive: one set by hand counts too.
    "labelled by hand": setup({ prs: { 31: pull(31, { labels: [{ name: "Needs-Input" }] }) } }),
    "issue labelled by hand": setup({ issue: { labels: [{ name: "NEEDS-INPUT" }] } }),
  };
  for (const [what, w] of Object.entries(cases)) {
    await w.conflicts.tick();
    assert.deepEqual(w.accepted, [], what);
  }
  // A busy task isn't even asked about.
  assert.ok(!cases.busy.calls.some((u) => u.includes("/pulls/")));
});

test("a run on another spelling of the task's repo holds the rebase run until it ends", async () => {
  // A key kept from before a restart unified the spellings, the run under GitHub's.
  const tasks = new Map([["Org/Repo#30", { running: true, pending: [] }]]);
  const w = setup({ busy: (key) => busyTask(tasks, key) });
  await w.conflicts.tick();
  assert.deepEqual(w.accepted, []);
  tasks.set("Org/Repo#30", { running: false, pending: [{}] });
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.deepEqual(w.accepted, []);
  tasks.get("Org/Repo#30").pending = [];
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
});

test("only the open pull requests pulls.mjs knows as tasks', in allowed repos", async () => {
  const w = setup({ open: [] });
  await w.conflicts.tick();
  assert.deepEqual(w.calls, []);
  const narrowed = testConfig({ ALLOWED_REPOS: "org/other" });
  const outside = setup({ c: narrowed, settings: optedIn(10, narrowed) });
  await outside.conflicts.tick();
  assert.deepEqual(outside.calls, []);
  // Discussions have no pull request.
  const discussion = setup({ open: [["org/repo#discussion-3", { number: 3 }]] });
  await discussion.conflicts.tick();
  assert.deepEqual(discussion.calls, []);
});

test("without conflicts in the repo's config, or with errors, nothing is checked", async () => {
  for (const settings of [
    parseRepoConfig("trigger: go", config),
    parseRepoConfig("conflicts:\n  check_minutes: soon", config),
  ]) {
    const w = setup({ settings });
    await w.conflicts.tick();
    assert.deepEqual(w.accepted, []);
    assert.ok(!w.calls.some((u) => u.includes("/pulls/")));
  }
});

test("CONFLICT_CHECK_MINUTES=0 turns the watcher off for everyone", async () => {
  const off = testConfig({ CONFLICT_CHECK_MINUTES: "0" });
  // Even with settings that slipped through: the watcher itself doesn't run.
  const w = setup({ c: off, settings: optedIn() });
  await w.conflicts.tick();
  assert.deepEqual(w.calls, []);
});

test("each repo at its own interval, never shorter than the floor", async () => {
  const w = setup({ prs: { 31: pull(31, { mergeable: true, mergeable_state: "clean" }) } });
  const checks = () => w.calls.filter((u) => u.endsWith("/pulls/31")).length;
  await w.conflicts.tick();
  assert.equal(checks(), 1);
  w.advance(9 * MIN);
  await w.conflicts.tick();
  assert.equal(checks(), 1);
  w.advance(MIN);
  await w.conflicts.tick();
  assert.equal(checks(), 2);
  // A repo asking for 1 minute gets the operator's 5.
  w.settings = optedIn(1);
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(checks(), 3);
  w.advance(4 * MIN);
  await w.conflicts.tick();
  assert.equal(checks(), 3);
  w.advance(MIN);
  await w.conflicts.tick();
  assert.equal(checks(), 4);
});

test("the same (head, base) never starts a second run, across a restart", async () => {
  const maps = mapStore();
  const first = setup({ attempts: await stored(maps) });
  await first.conflicts.tick();
  assert.equal(first.accepted.length, 1);
  assert.deepEqual(await saved(maps), {
    "org/repo#30": { pr: 31, head: "head-1", base: "base-1", at: 1_800_000_000_000 },
  });

  // The rebase failed: a new listener sees the same pair and leaves it.
  const next = setup({ attempts: await maps.again("conflicts") });
  await next.conflicts.tick();
  assert.equal(next.accepted.length, 0);

  // A new base commit: another try.
  next.baseSha = "base-2";
  next.advance(10 * MIN);
  await next.conflicts.tick();
  assert.equal(next.accepted.length, 1);

  // A new push that still conflicts: another try.
  next.prs[31] = pull(31, { head: { sha: "head-2", repo: { full_name: "org/repo" } } });
  next.advance(10 * MIN);
  await next.conflicts.tick();
  assert.equal(next.accepted.length, 2);
});

test("respell: attempts saved under another spelling move to the one given", async () => {
  const maps = mapStore();
  const pair = { pr: 31, head: "head-1", base: "base-1" };
  const w = setup({ attempts: await stored(maps, { "org/repo#30": pair, "other/repo#2": pair }) });
  w.conflicts.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/repo" : repo));
  assert.deepEqual(w.conflicts.keys(), ["other/repo#2", "Org/repo#30"]);
  assert.deepEqual((await saved(maps))["Org/repo#30"], pair);
});

test("respell: of an attempt under each spelling, the later stays, so it isn't tried again", async () => {
  const maps = mapStore();
  // The watcher ran under the old spelling last, at the pair GitHub still has.
  const stale = { pr: 31, head: "old", base: "old", at: 1 };
  const attempts = await stored(maps, {
    "Org/Repo#30": stale,
    "org/repo#30": { pr: 31, head: "head-1", base: "base-1", at: 2 },
  });
  const w = setup({ attempts, open: [["Org/Repo#30", { number: 31, state: "draft" }]] });
  w.conflicts.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/Repo" : repo));
  assert.deepEqual(await saved(maps), {
    "Org/Repo#30": { pr: 31, head: "head-1", base: "base-1", at: 2 },
  });
  // Saved before attempts had a time: the old spelling's, where the watcher ran.
  const before = mapStore();
  const old = setup({
    attempts: await stored(before, {
      "Org/Repo#30": { pr: 31, head: "old", base: "old" },
      "org/repo#30": { pr: 31, head: "x", base: "y" },
    }),
  });
  old.conflicts.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/Repo" : repo));
  assert.deepEqual(await saved(before), {
    "Org/Repo#30": { pr: 31, head: "x", base: "y" },
  });
});

test("check(): every repo due now, its runs and pending ones counted, the interval reset", async () => {
  const w = setup({
    open: [
      ["org/repo#30", { number: 31, state: "draft" }],
      ["org/repo#40", { number: 41, state: "draft" }],
    ],
    prs: {
      31: pull(31, { mergeable: true, mergeable_state: "clean" }),
      41: pull(41, { mergeable: true, mergeable_state: "clean" }),
    },
  });
  const checks = () => w.calls.filter((u) => u.endsWith("/pulls/41")).length;
  assert.deepEqual(await w.conflicts.tick(), { started: 0, pending: 0, errors: [] });
  // Not due for 10 minutes: a tick leaves it, Sync's check() doesn't.
  w.prs[31] = pull(31);
  w.prs[41] = pull(41, { mergeable: null, mergeable_state: "unknown" });
  w.advance(MIN);
  assert.deepEqual(await w.conflicts.tick(), { started: 0, pending: 0, errors: [] });
  assert.equal(checks(), 1);
  assert.deepEqual(await w.conflicts.check(), { started: 1, pending: 1, errors: [] });
  assert.equal(w.accepted.length, 1);
  assert.equal(w.accepted[0].reason, "conflict");
  assert.equal(checks(), 2);
  // The pending one is the next tick's, at once, not Sync's to wait for.
  w.prs[41] = pull(41);
  w.advance(MIN);
  assert.deepEqual(await w.conflicts.tick(), { started: 1, pending: 0, errors: [] });
  assert.equal(w.accepted.length, 2);
  // Then the repo's interval again, from that pass.
  w.advance(MIN);
  await w.conflicts.tick();
  assert.equal(checks(), 3);
});

test("check(): a tried pair, a busy task or one waiting for input gets no run", async () => {
  const tried = setup();
  await tried.conflicts.tick();
  assert.deepEqual(await tried.conflicts.check(), { started: 0, pending: 0, errors: [] });
  assert.equal(tried.accepted.length, 1);
  const cases = {
    busy: setup({ busy: () => true }),
    labelled: setup({ prs: { 31: pull(31, { labels: [{ name: "needs-input" }] }) } }),
    "issue labelled": setup({ issue: { labels: [{ name: "needs-input" }] } }),
  };
  for (const [what, w] of Object.entries(cases)) {
    assert.deepEqual(await w.conflicts.check(), { started: 0, pending: 0, errors: [] }, what);
    assert.deepEqual(w.accepted, [], what);
  }
});

test("check(): nothing without the opt-in, with config errors, outside ALLOWED_REPOS or turned off", async () => {
  const narrowed = testConfig({ ALLOWED_REPOS: "org/other" });
  const off = testConfig({ CONFLICT_CHECK_MINUTES: "0" });
  const cases = {
    "no opt-in": setup({ settings: parseRepoConfig("trigger: go", config) }),
    errors: setup({ settings: parseRepoConfig("conflicts:\n  check_minutes: soon", config) }),
    outside: setup({ c: narrowed, settings: optedIn(10, narrowed) }),
    off: setup({ c: off, settings: optedIn() }),
  };
  for (const [what, w] of Object.entries(cases)) {
    assert.deepEqual(await w.conflicts.check(), { started: 0, pending: 0, errors: [] }, what);
    assert.deepEqual(w.accepted, [], what);
    assert.ok(!w.calls.some((u) => u.includes("/pulls/")), what);
  }
});

test("check() during a tick shares it, then checks the repos it left", async () => {
  const w = setup({
    open: [
      ["org/repo#30", { number: 31, state: "draft" }],
      ["org/two#50", { number: 51, state: "draft" }],
    ],
    prs: { 31: pull(31), 51: pull(51, { mergeable: true, mergeable_state: "clean" }) },
    routes: {
      "/repos/org/two": { default_branch: "main" },
      "/repos/org/two/issues/50": { labels: [] },
    },
  });
  const checks = (n) => w.calls.filter((u) => u.endsWith(`/pulls/${n}`)).length;
  await w.conflicts.tick();
  // org/repo due again, org/two not yet (both at 10 minutes, org/two checked later).
  w.prs[31] = pull(31, { head: { sha: "head-2", repo: { full_name: "org/repo" } } });
  w.prs[51] = pull(51, { head: { sha: "head-2", repo: { full_name: "org/repo" } } });
  w.advance(10 * MIN);
  const ticking = w.conflicts.tick();
  const checking = w.conflicts.check();
  // Another check meanwhile shares the whole of it.
  assert.equal(w.conflicts.check(), checking);
  assert.equal(w.conflicts.tick(), checking);
  assert.deepEqual(await ticking, { started: 1, pending: 0, errors: [] });
  assert.deepEqual(await checking, { started: 1, pending: 0, errors: [] });
  // Each repo checked once more: org/repo by the tick, org/two after it.
  assert.equal(checks(31), 2);
  assert.equal(checks(51), 2);
  assert.equal(w.accepted.length, 2);
});

test("check() during a check shares it; after a tick that took every repo, checks none again", async () => {
  const w = setup();
  const checking = w.conflicts.check();
  assert.equal(w.conflicts.check(), checking);
  assert.equal(w.conflicts.tick(), checking);
  assert.deepEqual(await checking, { started: 1, pending: 0, errors: [] });
  // The first tick after a start: every repo due.
  const fresh = setup();
  const ticking = fresh.conflicts.tick();
  const after = fresh.conflicts.check();
  assert.deepEqual(await ticking, { started: 1, pending: 0, errors: [] });
  assert.deepEqual(await after, { started: 1, pending: 0, errors: [] });
  assert.equal(fresh.calls.filter((u) => u.endsWith("/pulls/31")).length, 1);
});

test("a repo that couldn't be checked: its error, logged and in the result", async () => {
  const logged = [];
  const w = setup({ routes: { "/repos/org/repo": null } });
  w.conflicts = createConflicts({
    config,
    pulls: { open: () => [["org/repo#30", { number: 31 }]] },
    github: async () => new Response("{}", { status: 502 }),
    repoSettings: async () => w.settings,
    busy: () => false,
    accept: async (item) => w.accepted.push(item),
    log: (line) => logged.push(line),
  });
  const { started, pending, errors } = await w.conflicts.check();
  assert.deepEqual([started, pending, w.accepted], [0, 0, []]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^org\/repo: .*502/);
  assert.deepEqual(logged, [`Conflicts in org/repo: ${errors[0].slice("org/repo: ".length)}`]);
});

// soon()'s wait, ended by the test: `waits` has each one's ms, `end()` ends them.
function manualSleep() {
  const waits = [];
  const ends = [];
  const sleep = (ms) => {
    waits.push(ms);
    return new Promise((resolve) => ends.push(resolve));
  };
  return { sleep, waits, end: () => ends.splice(0).forEach((resolve) => resolve()) };
}

test("a default branch that moved checks the repo after a short wait, whatever its interval", async () => {
  const s = manualSleep();
  const w = setup({
    sleep: s.sleep,
    prs: { 31: pull(31, { mergeable: true, mergeable_state: "clean" }) },
  });
  const checks = () => w.calls.filter((u) => u.endsWith("/pulls/31")).length;
  await w.conflicts.tick();
  assert.equal(checks(), 1);
  // Merged into the base: in conflict now, nine minutes before the repo's next check.
  w.prs[31] = pull(31);
  w.advance(MIN);
  const soon = w.conflicts.soon("Org/Repo");
  // Nothing until the wait ends, not even a tick meanwhile.
  assert.deepEqual(s.waits, [30_000]);
  await w.conflicts.tick();
  assert.equal(checks(), 1);
  s.end();
  assert.deepEqual(await soon, { started: 1, pending: 0, errors: [] });
  assert.equal(w.accepted.length, 1);
  assert.equal(w.accepted[0].reason, "conflict");
  // Its interval starts again from that check.
  w.advance(9 * MIN);
  await w.conflicts.tick();
  assert.equal(checks(), 2);
});

test("several triggers for one merge share one wait, one pass and one rebase run", async () => {
  const s = manualSleep();
  const w = setup({ sleep: s.sleep });
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  w.baseSha = "base-2";
  w.advance(MIN);
  const all = [
    w.conflicts.soon("org/repo"),
    w.conflicts.soon("org/repo"),
    w.conflicts.soon("ORG/REPO"),
  ];
  assert.equal(s.waits.length, 1);
  s.end();
  const results = await Promise.all(all);
  assert.ok(results.every((r) => r === results[0]));
  assert.equal(w.accepted.length, 2);
  assert.equal(w.calls.filter((u) => u.endsWith("/pulls/31")).length, 2);
  // Another trigger for the same base commit: checked again, no second run for the pair.
  const again = w.conflicts.soon("org/repo");
  s.end();
  await again;
  assert.equal(w.accepted.length, 2);
});

test("a pass under way when the wait ends is followed by one that checks the repo", async () => {
  const s = manualSleep();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const w = setup({
    sleep: s.sleep,
    routes: { "/repos/org/repo": async () => (await held, { default_branch: "main" }) },
  });
  const tick = w.conflicts.tick();
  w.advance(MIN);
  const soon = w.conflicts.soon("org/repo");
  s.end();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await tick;
  await soon;
  assert.equal(w.calls.filter((u) => u === "/repos/org/repo").length, 2);
});

test("after a merge, mergeable: null is asked again at the next tick", async () => {
  const s = manualSleep();
  const w = setup({
    sleep: s.sleep,
    prs: { 31: pull(31, { mergeable: true, mergeable_state: "clean" }) },
  });
  await w.conflicts.tick();
  w.prs[31] = pull(31, { mergeable: null, mergeable_state: "unknown" });
  const soon = w.conflicts.soon("org/repo");
  s.end();
  assert.equal((await soon).pending, 1);
  w.prs[31] = pull(31);
  w.advance(MIN);
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
});

test("soon() leaves alone repos outside ALLOWED_REPOS, without the opt-in, or with the watcher off", async () => {
  const narrowed = testConfig({ ALLOWED_REPOS: "org/other" });
  const off = testConfig({ CONFLICT_CHECK_MINUTES: "0" });
  for (const [what, c, settings] of [
    ["outside", narrowed, optedIn(10, narrowed)],
    ["off", off, optedIn()],
  ]) {
    const s = manualSleep();
    const w = setup({ c, settings, sleep: s.sleep });
    assert.equal(await w.conflicts.soon("org/repo"), null, what);
    assert.deepEqual([s.waits, w.calls], [[], []], what);
  }
  for (const settings of [
    parseRepoConfig("trigger: go", config),
    parseRepoConfig("conflicts:\n  check_minutes: soon", config),
  ]) {
    const s = manualSleep();
    const w = setup({ settings, sleep: s.sleep });
    const soon = w.conflicts.soon("org/repo");
    s.end();
    await soon;
    assert.deepEqual(w.accepted, []);
    assert.ok(!w.calls.some((u) => u.includes("/pulls/")));
  }
});

test("an auto-merge checks conflicts only when it went into the default branch", () => {
  const pr = (ref, repo) => ({ state: "closed", merged: true, base: { ref, repo } });
  assert.equal(intoDefaultBranch(pr("main", { default_branch: "main" })), true);
  assert.equal(intoDefaultBranch(pr("release", { default_branch: "main" })), false);
  // Without the default branch, nothing says it was that one.
  assert.equal(intoDefaultBranch(pr("main", {})), false);
  assert.equal(intoDefaultBranch(pr("main", null)), false);
  assert.equal(intoDefaultBranch({}), false);
});

test("deny_fix allows: the rebase run starts, asked with reason conflict", async (t) => {
  const policy = policyEngine(t, { files: { "fix.rego": "package deckhand" } });
  const w = setup({ policies: policy.engine, fixes: 2 });
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  assert.deepEqual(w.replies, []);
  const asked = policy.evals.filter((e) => e.rule === "deny_fix");
  assert.equal(asked.length, 1);
  const [input] = asked;
  assert.deepEqual(
    [input.decision, input.reason, input.ci, input.review, input.round, input.rounds],
    ["fix", "conflict", false, null, null, null],
  );
  assert.deepEqual(
    [input.fixed, input.fixes, input.pr.number, input.issue.number],
    [true, 2, 31, 30],
  );
  assert.deepEqual(
    input.pr.files.map((f) => f.path),
    ["migrations/1.sql"],
  );
  // Kept for the task's page, allowed.
  assert.equal(w.decided.length, 1);
  assert.deepEqual(
    [w.decided[0].key, w.decided[0].rule, w.decided[0].denied, w.decided[0].pr],
    ["org/repo#30", "deny_fix", false, 31],
  );
});

test("deny_fix refuses: no run, one comment quoting why, the pair not asked again", async (t) => {
  let reason = "conflicts in `migrations/` wait for a human";
  const policy = policyEngine(t, {
    files: { "fix.rego": "package deckhand" },
    messages: (i, rule) =>
      rule === "deny_fix" &&
      i.reason === "conflict" &&
      i.pr.files.some((f) => f.path.startsWith("migrations/"))
        ? [reason]
        : [],
  });
  const w = setup({ policies: policy.engine });
  assert.deepEqual(await w.conflicts.tick(), { started: 0, pending: 0, errors: [] });
  assert.deepEqual(w.accepted, []);
  assert.deepEqual(w.replies, [
    {
      repo: "org/repo",
      number: 31,
      text: noRebaseText(
        "the policies refuse it (`deny_fix`): `conflicts in 'migrations/' wait for a human`",
        "main",
      ),
    },
  ]);
  assert.match(w.replies[0].text, /^\*\*No rebase run\*\* \(`conflicts.check_minutes`\)/);
  assert.equal(w.decided[0].denied, true);
  // Same head and base, at the next check and from the dashboard's Sync: nothing asked again.
  w.advance(10 * MIN);
  await w.conflicts.tick();
  await w.conflicts.check();
  assert.equal(policy.evals.length, 1);
  assert.equal(w.replies.length, 1);
  // The base moved: asked again, refused again for the same reason, not said again.
  w.baseSha = "base-2";
  await w.conflicts.check();
  assert.equal(policy.evals.length, 2);
  assert.equal(w.replies.length, 1);
  assert.equal(w.decided.length, 2);
  // Another reason: said.
  reason = "on hold";
  w.baseSha = "base-3";
  await w.conflicts.check();
  assert.equal(w.replies.length, 2);
  assert.match(w.replies[1].text, /`on hold`/);
  assert.deepEqual(w.accepted, []);
});

test("deny_fix refuses and the comment fails: logged, no run, the pair still tried", async (t) => {
  const policy = policyEngine(t, {
    files: { "fix.rego": "package deckhand" },
    messages: (i, rule) => (rule === "deny_fix" ? ["no"] : []),
  });
  let failing = true;
  const replies = [];
  const w = setup({
    policies: policy.engine,
    reply: async (repo, number, text) => {
      if (failing) throw new Error("GitHub said 502");
      replies.push(text);
    },
  });
  await w.conflicts.tick();
  assert.deepEqual(w.accepted, []);
  assert.ok(w.logged.includes("org/repo#30: saying no rebase run: GitHub said 502"));
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(policy.evals.length, 1);
  // The base moved: the same refusal, never said yet, is said now.
  failing = false;
  w.baseSha = "base-2";
  await w.conflicts.check();
  assert.equal(policy.evals.length, 2);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /^\*\*No rebase run\*\*.*`no`/);
  assert.deepEqual(w.accepted, []);
});

test("deny_fix: GitHub failing to give the input starts nothing, keeps no pair, asks again", async (t) => {
  const policy = policyEngine(t, { files: { "fix.rego": "package deckhand" } });
  const w = setup({ policies: policy.engine });
  w.files = null;
  const { started, errors } = await w.conflicts.tick();
  assert.equal(started, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^org\/repo: #31: .*policy error: its input can't be built/);
  assert.deepEqual([w.accepted, w.replies, policy.evals, w.decided], [[], [], [], []]);
  // GitHub answers again: the same pair is asked, allowed, and its run starts.
  w.files = [];
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(policy.evals.length, 1);
  assert.equal(w.accepted.length, 1);
});

test("deny_fix: a policy error refuses the rebase run too", async (t) => {
  const policy = policyEngine(t, {
    files: { "fix.rego": "package deckhand" },
    failure: {
      code: 0,
      stdout: JSON.stringify({ result: [{ expressions: [{ value: { repo: { deny: [3] } } }] }] }),
    },
  });
  const w = setup({ policies: policy.engine });
  await w.conflicts.tick();
  assert.deepEqual(w.accepted, []);
  assert.equal(w.replies.length, 1);
  assert.match(w.replies[0].text, /`policy error: 'deny_fix' must be a set of strings`/);
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(w.replies.length, 1);
});

test("without any policy, the rebase run starts and no opa runs", async (t) => {
  const policy = policyEngine(t);
  const w = setup({ policies: policy.engine });
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  assert.deepEqual(policy.evals, []);
  assert.deepEqual([w.replies, w.decided], [[], []]);
});

test("deny_fix: GitHub failing to list the policies starts nothing, keeps no pair, asks again", async (t) => {
  let status = 502;
  const policy = policyEngine(t, {
    files: { "fix.rego": "package deckhand" },
    listFails: () => status,
  });
  const w = setup({ policies: policy.engine });
  const { started, errors } = await w.conflicts.tick();
  assert.equal(started, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^org\/repo: #31: .*policy error: the policies can't be read/);
  // No run, no comment, no rule asked, no refusal for the task's page.
  assert.deepEqual([w.accepted, w.replies, policy.evals, w.decided], [[], [], [], []]);
  // GitHub answers again: the same pair is asked, allowed, and its run starts.
  status = null;
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(policy.evals.length, 1);
  assert.equal(w.accepted.length, 1);
  assert.equal(w.decided.length, 1);
});
