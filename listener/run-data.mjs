// Read-only comparisons of retained runs. No GitHub or agent calls: outcomes are the last
// recorded ones, and missing evidence stays unknown rather than implying success or no cost.

import { parseKey } from "./events.mjs";

export const DIMENSIONS = ["repo", "agent", "model", "effort", "user"];
const value = (r, key) => (key === "user" ? (r.user ?? "unknown") : (r[key] ?? "unknown"));
const stepOf = (r) => r.reason || r.taskMode || "work";

export function runData({ runs, pull = () => null, reviewed = () => null, filters = {} }) {
  const all = runs.filter((r) => !r.owner && ["issue", "pr"].includes(parseKey(r.key)?.kind));
  const identity = (r) => {
    const pr = pull(r.key);
    return pr ? `${r.repo.toLowerCase()}#pr-${pr.number}` : r.key.toLowerCase();
  };
  const selectedKey = filters.task && all.find((r) => r.key === filters.task);
  const selected = all.filter(
    (r) =>
      (!filters.task || (selectedKey && identity(r) === identity(selectedKey))) &&
      (filters.from == null || r.startedAt >= filters.from) &&
      (filters.to == null || r.startedAt < filters.to) &&
      DIMENSIONS.every(
        (d) => !filters[d] || value(r, d).toLowerCase() === filters[d].toLowerCase(),
      ),
  );
  // Full retained history supplies the last push and fixes, even if a run filter omits them.
  const histories = new Map();
  const pullsByIssue = new Map();
  for (const r of all) {
    const key = identity(r);
    if (!histories.has(key)) histories.set(key, []);
    histories.get(key).push(r);
    const pr = pull(r.key);
    const previous = pullsByIssue.get(key);
    if (pr && (!previous || (pr.updatedAt ?? 0) >= (previous.updatedAt ?? 0)))
      pullsByIssue.set(key, pr);
  }
  function metrics(list) {
    const issues = new Map(list.map((r) => [identity(r), r]));
    const out = {
      runs: list.length,
      issues: issues.size,
      needsInput: 0,
      tokens: 0,
      usageRuns: 0,
      // Issues with token data: tokens per issue is over these, absent usage being unknown.
      usageIssues: 0,
      fixes: 0,
      ciFixes: 0,
      findings: 0,
      reviewedPulls: 0,
      pullRequests: 0,
      merged: 0,
      unchanged: 0,
      changed: 0,
      unknownMerge: 0,
      mergedAfterFixes: 0,
      closed: 0,
    };
    const usageIssues = new Set();
    for (const r of list) {
      if (r.status === "needs-input") out.needsInput++;
      if (Number.isFinite(r.usage?.tokens)) {
        out.tokens += r.usage.tokens;
        out.usageRuns++;
        usageIssues.add(identity(r));
      }
      if (r.reason === "review-fix") out.fixes++;
      if (r.reason === "ci-fix") out.ciFixes++;
    }
    out.usageIssues = usageIssues.size;
    for (const [key, r] of issues) {
      const pr = pullsByIssue.get(key);
      if (!pr) continue;
      out.pullRequests++;
      const rounds = reviewed(r.repo, pr.number)?.rounds ?? [];
      const inPeriod = rounds.filter(
        (h) =>
          (filters.from == null || h.at >= filters.from) &&
          (filters.to == null || h.at < filters.to),
      );
      if (inPeriod.length) out.reviewedPulls++;
      for (const h of inPeriod)
        out.findings += Object.values(h.counts ?? {}).reduce((a, b) => a + b, 0);
      if (pr.state === "closed") out.closed++;
      if (pr.state !== "merged") continue;
      out.merged++;
      const history = histories.get(key);
      if (history.some((x) => ["review-fix", "ci-fix"].includes(x.reason))) out.mergedAfterFixes++;
      const pushed = history
        .filter((x) => x.lastPushAt)
        .sort((a, b) => b.lastPushAt - a.lastPushAt)[0];
      if (!pushed?.lastPushHead || !pr.head) out.unknownMerge++;
      else if (pushed.lastPushHead === pr.head) out.unchanged++;
      else out.changed++;
    }
    return out;
  }
  // One spelling per value whatever its case, as filtering ignores it: the first one seen. The
  // options and the groups both show it, so a login recorded in two cases is one group.
  const spellings = Object.fromEntries(
    DIMENSIONS.map((d) => {
      const seen = new Map();
      for (const r of all) {
        const v = value(r, d);
        if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
      }
      return [d, seen];
    }),
  );
  const spelling = (r, d) => spellings[d].get(value(r, d).toLowerCase());
  function group(keyOf) {
    const groups = new Map();
    for (const r of selected) {
      const key = keyOf(r);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  }
  return {
    options: Object.fromEntries(DIMENSIONS.map((d) => [d, [...spellings[d].values()].sort()])),
    total: metrics(selected),
    groups: group((r) => JSON.stringify(DIMENSIONS.map((d) => spelling(r, d)))).map(
      ([key, list]) => ({
        dimensions: Object.fromEntries(DIMENSIONS.map((d, i) => [d, JSON.parse(key)[i]])),
        ...metrics(list),
      }),
    ),
    steps: group(stepOf).map(([step, list]) => ({ step, ...metrics(list) })),
  };
}

// Turn totals already printed by the agent. Cached input is included once; these are token
// counts, not dollars or estimates of a subscription's shared allowance. Codex reports its
// thread's running total, carried over when a run resumes it: a run counts what it added to the
// total its thread had when it started, `sessionTotal(thread)` (the last one an earlier run saved).
export function recordUsage(record, line, sessionTotal = () => 0) {
  // Most lines (tool output, messages) carry neither: no second parse for them.
  if (!line.includes('"usage"') && !line.includes('"thread.started"')) return;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (!e || typeof e !== "object") return;
  let tokens;
  if (record.agent === "codex") {
    // Read again after a restart, its start keeps the base it had.
    if (
      e.type === "thread.started" &&
      typeof e.thread_id === "string" &&
      record.usage?.thread !== e.thread_id
    ) {
      const base = sessionTotal(e.thread_id);
      record.usage = { thread: e.thread_id, base: valid(base) ? base : 0 };
    }
    const u = e.usage;
    if (e.type === "turn.completed" && valid(u?.input_tokens) && valid(u?.output_tokens)) {
      const total = u.input_tokens + u.output_tokens;
      const base = record.usage?.base ?? 0;
      record.usage = { ...record.usage, total, tokens: Math.max(0, total - base) };
    }
    return;
  }
  if ((!record.agent || record.agent === "claude") && e.type === "result") {
    const u = e.usage;
    if (
      valid(u?.input_tokens) &&
      valid(u?.output_tokens) &&
      [u.cache_read_input_tokens, u.cache_creation_input_tokens].every((n) => n == null || valid(n))
    ) {
      tokens =
        u.input_tokens +
        u.output_tokens +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
    }
  }
  if (record.agent === "antigravity" && e.event === "result") {
    const u = e.result?.usage;
    if (
      valid(u?.input_tokens) &&
      valid(u?.output_tokens) &&
      (u.cache_read_tokens == null || valid(u.cache_read_tokens))
    ) {
      tokens = u.input_tokens + u.output_tokens + (u.cache_read_tokens ?? 0);
    }
  }
  if (valid(tokens)) record.usage = { tokens: (record.usage?.tokens ?? 0) + tokens };
}
const valid = (n) => Number.isSafeInteger(n) && n >= 0;

// recordUsage()'s `sessionTotal` for a run: the total the task's latest other run on that thread
// saved. `runs`: newest first, as ctx.runs is.
export const sessionTotals = (runs, record) => (thread) =>
  runs.find(
    (r) =>
      r.id !== record.id &&
      r.key === record.key &&
      r.usage?.thread === thread &&
      valid(r.usage.total),
  )?.usage.total ?? 0;
