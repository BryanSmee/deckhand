// Read-only comparisons of retained runs. No GitHub or agent calls: outcomes are the last
// recorded ones, and missing evidence stays unknown rather than implying success or no cost.

import { parseKey } from "./events.mjs";

export const DIMENSIONS = ["repo", "agent", "model", "effort", "user"];
const value = (r, key) => (key === "user" ? (r.user ?? "unknown") : (r[key] ?? "unknown"));
const stepOf = (r) => r.reason || r.taskMode || "work";
// A run's tokens by part, beside its total: each part is summed over the runs that report it.
export const PARTS = ["input", "output", "cacheRead", "cacheWrite"];
// Input, output and cache writes, the parts not read again from the cache. An agent that has
// no cache write (Codex, Antigravity) counts its input and output alone; Claude's needs its own.
const uncached = (r) => {
  const u = r.usage;
  const writes = !r.agent || r.agent === "claude";
  if (!valid(u?.input) || !valid(u?.output) || (writes && !valid(u.cacheWrite))) return undefined;
  return u.input + u.output + (u.cacheWrite ?? 0);
};

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
      // Each part over the runs (and issues) that report it, older runs reporting none.
      parts: Object.fromEntries(
        [...PARTS, "uncached"].map((p) => [p, { tokens: 0, runs: 0, issues: 0 }]),
      ),
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
    const partIssues = Object.fromEntries(Object.keys(out.parts).map((p) => [p, new Set()]));
    for (const r of list) {
      if (r.status === "needs-input") out.needsInput++;
      if (Number.isFinite(r.usage?.tokens)) {
        out.tokens += r.usage.tokens;
        out.usageRuns++;
        usageIssues.add(identity(r));
        const parts = { ...r.usage, uncached: uncached(r) };
        for (const p of Object.keys(out.parts)) {
          if (!valid(parts[p])) continue;
          out.parts[p].tokens += parts[p];
          out.parts[p].runs++;
          partIssues[p].add(identity(r));
        }
      }
      if (r.reason === "review-fix") out.fixes++;
      if (r.reason === "ci-fix") out.ciFixes++;
    }
    out.usageIssues = usageIssues.size;
    for (const p of Object.keys(out.parts)) out.parts[p].issues = partIssues[p].size;
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
// counts, not dollars or estimates of a subscription's shared allowance. Beside the total, its
// parts (PARTS): one the agent doesn't report stays absent, unknown rather than 0. Codex reports
// its thread's running total, carried over when a run resumes it: a run counts what it added to
// the totals its thread had when it started, `sessionTotal(thread)` (`{ total, parts }`, the last
// ones an earlier run saved).
export function recordUsage(record, line, sessionTotal = () => FRESH) {
  // Most lines (tool output, messages) carry neither: no second parse for them.
  if (!line.includes('"usage"') && !line.includes('"thread.started"')) return;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (!e || typeof e !== "object") return;
  let turn;
  if (record.agent === "codex") {
    // Read again after a restart, its start keeps the base it had.
    if (
      e.type === "thread.started" &&
      typeof e.thread_id === "string" &&
      record.usage?.thread !== e.thread_id
    ) {
      const { total, parts } = sessionTotal(e.thread_id) ?? {};
      record.usage = {
        thread: e.thread_id,
        base: valid(total) ? total : 0,
        // An earlier run recorded before the parts were has none: this run's are unknown.
        baseParts: known(parts ?? {}),
      };
    }
    const u = e.usage;
    if (e.type === "turn.completed" && valid(u?.input_tokens) && valid(u?.output_tokens)) {
      const total = u.input_tokens + u.output_tokens;
      const base = record.usage?.base ?? 0;
      // Codex's input includes its cached input: the uncached part is the rest.
      const cached = valid(u.cached_input_tokens) && u.cached_input_tokens <= u.input_tokens;
      const totalParts = known({
        input: cached ? u.input_tokens - u.cached_input_tokens : undefined,
        output: u.output_tokens,
        cacheRead: cached ? u.cached_input_tokens : undefined,
      });
      // A thread started before an update that added the parts saved no base for them: unknown.
      const baseParts = record.usage?.baseParts ?? (record.usage?.thread ? {} : FRESH.parts);
      const added = {};
      for (const [p, n] of Object.entries(totalParts))
        if (valid(baseParts[p])) added[p] = Math.max(0, n - baseParts[p]);
      // A part the last turn didn't report is unknown again, whatever an earlier one said.
      const { input, output, cacheRead, ...kept } = record.usage ?? {};
      record.usage = { ...kept, total, totalParts, tokens: Math.max(0, total - base), ...added };
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
      turn = {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      };
    }
  }
  if (record.agent === "antigravity" && e.event === "result") {
    const u = e.result?.usage;
    if (
      valid(u?.input_tokens) &&
      valid(u?.output_tokens) &&
      (u.cache_read_tokens == null || valid(u.cache_read_tokens))
    ) {
      turn = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_tokens };
    }
  }
  if (!turn) return;
  const tokens = PARTS.reduce((sum, p) => sum + (turn[p] ?? 0), 0);
  if (!valid(tokens)) return;
  // A part stays known while every result so far reported it.
  const first = !record.usage;
  const parts = {};
  for (const p of PARTS)
    if (valid(turn[p]) && (first || valid(record.usage[p])))
      parts[p] = (record.usage?.[p] ?? 0) + turn[p];
  record.usage = { tokens: (record.usage?.tokens ?? 0) + tokens, ...parts };
}
// A thread no earlier run saved: nothing to take off.
const FRESH = { total: 0, parts: { input: 0, output: 0, cacheRead: 0 } };
const known = (parts) => Object.fromEntries(Object.entries(parts).filter(([, n]) => valid(n)));
const valid = (n) => Number.isSafeInteger(n) && n >= 0;

// recordUsage()'s `sessionTotal` for a run: the totals the task's latest other run on that thread
// saved, none before it. `runs`: newest first, as ctx.runs is.
export const sessionTotals = (runs, record) => (thread) => {
  const usage = runs.find(
    (r) =>
      r.id !== record.id &&
      r.key === record.key &&
      r.usage?.thread === thread &&
      valid(r.usage.total),
  )?.usage;
  if (!usage) return FRESH;
  return { total: usage.total, parts: usage.totalParts ?? {} };
};
