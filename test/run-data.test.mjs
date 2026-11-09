import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runData, recordUsage } from "../listener/run-data.mjs";
const run = (id, extra = {}) => ({
  id,
  key: "org/app#1",
  repo: "org/app",
  kind: "issue",
  agent: "codex",
  model: "model",
  effort: "high",
  startedAt: 10,
  status: "ok",
  ...extra,
});

test("linked issue and PR runs share one outcome, with strict and broad success side by side", () => {
  const runs = [
    run("a", { user: "alice", usage: { tokens: 100 }, lastPushAt: 11, lastPushHead: "old" }),
    run("b", {
      key: "org/app#pr-2",
      kind: "pr",
      reason: "review-fix",
      startedAt: 20,
      lastPushAt: 21,
      lastPushHead: "new",
      status: "needs-input",
    }),
    run("c", { key: "org/app#pr-2", kind: "pr", reason: "ci-fix", startedAt: 30 }),
  ];
  const result = runData({
    runs,
    pull: () => ({ number: 2, state: "merged", head: "new" }),
    reviewed: () => ({ rounds: [{ at: 15, counts: { high: 2, low: 1 } }] }),
  });
  assert.deepEqual(result.total, {
    runs: 3,
    issues: 1,
    needsInput: 1,
    tokens: 100,
    usageRuns: 1,
    fixes: 1,
    ciFixes: 1,
    findings: 3,
    reviewedPulls: 1,
    pullRequests: 1,
    merged: 1,
    unchanged: 1,
    changed: 0,
    unknownMerge: 0,
    mergedAfterFixes: 1,
    closed: 0,
  });
  assert.equal(result.steps.length, 3);
  assert.equal(result.groups.length, 2);
  // The last push is outside this cohort, but determines its outcome all the same.
  assert.equal(
    runData({
      runs,
      pull: () => ({ number: 2, state: "merged", head: "new" }),
      filters: { user: "alice", from: 10, to: 20 },
    }).total.unchanged,
    1,
  );
});

test("missing evidence, changed heads and closed PRs stay distinct; private chats never count", () => {
  const runs = [
    run("old"),
    run("changed", { key: "org/app#2", lastPushAt: 12, lastPushHead: "a" }),
    run("closed", { key: "org/app#3" }),
    run("chat", { owner: "alice" }),
  ];
  const data = runData({
    runs,
    pull: (key) => ({
      number: Number(key.split("#")[1]),
      state: key.endsWith("3") ? "closed" : "merged",
      head: "b",
    }),
  });
  assert.equal(data.total.runs, 3);
  assert.equal(data.total.unknownMerge, 1);
  assert.equal(data.total.changed, 1);
  assert.equal(data.total.closed, 1);
  assert.equal(data.total.usageRuns, 0);
});

test("each dimension and the half-open period filters runs, not the board's limited list", () => {
  const runs = Array.from({ length: 250 }, (_, i) =>
    run(String(i), { startedAt: i, user: "Alice" }),
  );
  const filters = {
    repo: "ORG/APP",
    agent: "CODEX",
    model: "model",
    effort: "high",
    user: "alice",
    from: 100,
    to: 200,
  };
  assert.equal(runData({ runs, filters }).total.runs, 100);
  for (const key of ["repo", "agent", "model", "effort", "user"])
    assert.equal(runData({ runs, filters: { ...filters, [key]: "absent" } }).total.runs, 0);
  assert.equal(runData({ runs, filters: { task: "missing" } }).total.runs, 0);
  assert.equal(runData({ runs, filters: { to: 0 } }).total.runs, 0);
});

test("turn usage includes cached input once and accumulates; missing or invalid usage is unknown", () => {
  const codex = { agent: "codex" };
  recordUsage(
    codex,
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 60, cached_input_tokens: 20, output_tokens: 30 },
    }),
  );
  recordUsage(
    codex,
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
  );
  assert.equal(codex.usage.tokens, 102);
  const claude = { agent: "claude" };
  recordUsage(
    claude,
    JSON.stringify({
      type: "result",
      usage: {
        input_tokens: 5,
        output_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 3,
      },
    }),
  );
  assert.equal(claude.usage.tokens, 38);
  const missing = { agent: "codex" };
  for (const line of [
    "bad",
    "null",
    "42",
    "{}",
    '{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":2}}',
  ])
    recordUsage(missing, line);
  assert.equal(missing.usage, undefined);
});

test("Antigravity counts the result total once, including cached input, not every step", () => {
  const record = { agent: "antigravity" };
  const log = readFileSync(new URL("./fixtures/antigravity-work.jsonl", import.meta.url), "utf8");
  for (const line of log.split("\n")) recordUsage(record, line);
  assert.deepEqual(record.usage, { tokens: 52904 });
});

test("issue-backed modes count; discussions and private chats do not", () => {
  const data = runData({
    runs: [
      run("research", { kind: "research", taskMode: "research" }),
      run("discussion", { key: "org/app#discussion-2", kind: "discussion" }),
      run("chat", { key: "org/app#chat-3", owner: "alice" }),
    ],
  });
  assert.equal(data.total.runs, 1);
  assert.equal(data.steps[0].step, "research");
});

test("a PR-only cohort finds its outcome on the linked issue's record", () => {
  const runs = [
    run("issue", { lastPushAt: 15, lastPushHead: "head" }),
    run("review", { key: "org/app#pr-2", kind: "pr", reason: "review", model: "reviewer" }),
  ];
  const data = runData({
    runs,
    filters: { model: "reviewer" },
    pull: (key) => (key.endsWith("#1") ? { number: 2, state: "merged", head: "head" } : null),
  });
  assert.equal(data.total.issues, 1);
  assert.equal(data.total.merged, 1);
  assert.equal(data.total.unchanged, 1);
});
