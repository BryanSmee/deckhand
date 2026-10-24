import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createConflicts, rebaseMessage } from "../listener/conflicts.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { busyTask } from "../listener/tasks.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

const MIN = 60_000;
const config = testConfig({ CONFLICT_CHECK_MINUTES: "5" });
const optedIn = (minutes = 10, c = config) =>
  parseRepoConfig(`conflicts:\n  check_minutes: ${minutes}`, c);

// `t` null: removed when the file's tests end.
const tempPath = (t = null) => join(tempDir(t), "conflicts.json");

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
  c = config,
  path = tempPath(),
} = {}) {
  let time = 1_800_000_000_000;
  const calls = [];
  const accepted = [];
  const routes = {
    "/repos/org/repo": { default_branch: "main" },
    "/repos/org/repo/git/ref/heads/main": () => ({ object: { sha: w.baseSha } }),
    "/repos/org/repo/issues/30": () => w.issue,
  };
  const w = {
    prs,
    issue,
    baseSha,
    settings,
    calls,
    accepted,
    advance: (ms) => (time += ms),
  };
  w.conflicts = createConflicts({
    path,
    config: c,
    pulls: { open: () => open },
    github: async (repo, method, url) => {
      calls.push(url);
      const pr = /\/pulls\/(\d+)$/.exec(url);
      const route = pr ? w.prs[pr[1]] : routes[url];
      const body = typeof route === "function" ? route() : route;
      return body
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response("{}", { status: 404 });
    },
    repoSettings: async () => w.settings,
    busy,
    accept: async (item) => accepted.push(item),
    now: () => time,
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
    },
  );
  assert.match(item.text, /rebase it on `origin\/main`.*--force-with-lease.*stop and ask/s);
  // Still in conflict at the next check: same pair, no second run.
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
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

test("the same (head, base) never starts a second run, across a restart", async (t) => {
  const path = tempPath(t);
  const first = setup({ path });
  await first.conflicts.tick();
  assert.equal(first.accepted.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "org/repo#30": { pr: 31, head: "head-1", base: "base-1" },
  });

  // The rebase failed: a new listener sees the same pair and leaves it.
  const next = setup({ path });
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

test("respell: attempts saved under another spelling move to the one given", (t) => {
  const path = tempPath(t);
  const pair = { pr: 31, head: "head-1", base: "base-1" };
  writeFileSync(path, JSON.stringify({ "org/repo#30": pair, "other/repo#2": pair }));
  const w = setup({ path });
  w.conflicts.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/repo" : repo));
  assert.deepEqual(w.conflicts.keys(), ["other/repo#2", "Org/repo#30"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8"))["Org/repo#30"], pair);
});
