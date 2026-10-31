// Run analysis (the dashboard's Analyze): a selection of a repo's past runs, digested for a
// light run that reads them and replies with what would make sessions faster or more
// reliable. A digest, not the logs: those are MB of stream-json each, cover every repo and
// are only redacted line by line as they are written. Built from format()'s entries, which
// clip tool details and outputs, redacted again, capped in size. Pure, apart from reading
// the logs and startAnalysis(), which opens the analysis's issue and queues its run.
import { agentFor } from "./agents/index.mjs";
import { ensureLabel } from "./comments.mjs";
import { issueItem, sameRepo, taskKey } from "./events.mjs";
import { OPEN } from "./modes.mjs";
import { clip, format, minutes } from "./runlog.mjs";
import { redact } from "./secrets.mjs";
import { refuse } from "../lib/http.mjs";

// How many runs one analysis reads: 10 unless asked, 50 at most.
export const DEFAULT_RUNS = 10;
export const MAX_RUNS = 50;
// The digest's cap, in bytes: older runs beyond it are left out (and the digest says so).
const MAX_DIGEST = 400_000;
// One run's share at most, so a single long run doesn't push all the others out.
const MAX_RUN = 24_000;
// Run statuses an analysis can pick (runlog.mjs outcome(), and runs that ended otherwise).
const OUTCOMES = ["ok", "error", "needs-input", "interrupted", "cancelled"];
// About four bytes a token: the preview's estimate of what the run reads.
export const tokens = (bytes) => Math.ceil(bytes / 4);

// What a run was: its mode (work, brainstorm, idea, bug, discussion, onboarding, analyze or
// one of the repo's own), or its kind for logs from before runs kept their mode.
function runKind(run) {
  return run.taskMode ?? run.kind ?? "work";
}

const ofRepo = (run, repo) => sameRepo(run.repo, repo);
const finished = (run) => run.status !== "running";
// A research run (modes.mjs OPEN) read the open web: what a page made it say would reach a run
// that has the code and a token, and a report posted as is. Never in a digest.
const research = (run) => OPEN.has(run.taskMode) || run.kind === "research";
// The runs of `repo` an analysis may read.
const readable = (run, repo) => ofRepo(run, repo) && finished(run) && !research(run);

// The kinds of a repo's finished runs, for the form to offer.
export function runKinds(runs, repo) {
  const kinds = new Set(runs.filter((r) => readable(r, repo)).map(runKind));
  return [...kinds].sort();
}

// The `count` newest finished runs of `repo` (never another repo's, never research) of those
// kinds and outcomes. `runs`: newest first, as ctx.runs is.
export function selectRuns(runs, repo, { count, kinds, outcomes }) {
  return runs
    .filter((r) => readable(r, repo) && kinds.includes(runKind(r)) && outcomes.includes(r.status))
    .slice(0, count);
}

// The selection a request asks for, checked: { count, kinds, outcomes }. `fail(message)`
// throws (answers.mjs refuse(), with a 400). `empty`: no kind or outcome is fine (a preview).
export function checkSelection(body, fail, { empty = false } = {}) {
  const { count = DEFAULT_RUNS, kinds, outcomes } = body ?? {};
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RUNS) {
    fail(`\`count\` is a number of runs, from 1 to ${MAX_RUNS}.`);
  }
  const names = (list) =>
    Array.isArray(list) && list.every((k) => typeof k === "string" && /^[\w-]+$/.test(k));
  if (!names(kinds) || (!empty && !kinds.length)) {
    fail("Pick at least one kind of run (`kinds`).");
  }
  if (
    !Array.isArray(outcomes) ||
    (!empty && !outcomes.length) ||
    !outcomes.every((o) => OUTCOMES.includes(o))
  ) {
    fail(`Pick at least one outcome (\`outcomes\`: ${OUTCOMES.join(", ")}).`);
  }
  return { count, kinds: [...new Set(kinds)], outcomes: [...new Set(outcomes)] };
}

const time = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const quote = (text) =>
  String(text)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
// Setup and other raw output worth a look: failures, refused hosts, slow steps the tools say.
const NOTABLE = /error|fail|denied|refused|forbidden|\b403\b|timed? ?out|not found|warn/i;
// git's hints after a push: they quote the branch name, which may say "fail" or "error".
const PUSH_HINT = /^remote:\s+(Create a pull request|https:\/\/github\.com\/\S+\/pull\/new\/)/;

// One run's part of the digest: what it was, how it ended, what went wrong on the way and its
// final reply. `lines`: its log's lines (the first one the listener's). `isPublic`: the repo is
// public, and the report is posted there: no listener notes, setup output or failed tools'
// outputs, which only the dashboard showed. Its final reply was posted already.
export function runDigest(run, lines, { isPublic = false } = {}) {
  const agent = agentFor(run.agent);
  const entries = lines.flatMap((l) => format(l, agent));
  const out = [
    ...runHeader(run, agent),
    ...(isPublic ? [] : setupLines(entries)),
    ...toolLines(entries, { isPublic }),
  ];
  const result = entries.findLast((e) => e.kind === "result");
  out.push(
    "",
    result
      ? `Final reply (${result.status}, ${result.minutes} min of agent time):\n\n${quote(clip(result.text, 60, 4000))}`
      : "No final reply: the run ended before the agent answered.",
  );
  const text = out.join("\n");
  return text.length > MAX_RUN ? `${text.slice(0, MAX_RUN)}\n…(cut)` : text;
}

// The run's heading and what it was: its task, kind, agent, model, how and when it ended.
function runHeader(run, agent) {
  const took = run.finishedAt && run.startedAt ? minutes(run.finishedAt - run.startedAt) : null;
  const what = [
    `kind ${runKind(run)}${run.mode ? ` (${run.mode})` : ""}`,
    `${agent.name}${run.provider ? `@${run.provider}` : ""} ${run.model ?? "?"}, ${run.effort ?? "?"} effort${run.speed === "fast" ? ", fast" : ""}`,
    `${run.status}${took !== null ? ` after ${took} min` : ""}`,
    `started ${time(run.startedAt)} UTC`,
  ];
  const out = [
    `## Run ${run.id}`,
    "",
    `- ${run.key}${run.title ? `: ${run.title}` : ""}`,
    `- ${what.join(" · ")}`,
  ];
  if (run.reason) out.push(`- started by the listener: ${run.reason}`);
  if (run.fallback) out.push(`- fell back from ${run.fallback.from}: ${run.fallback.reason}`);
  return out;
}

// What happened before the agent's own work: the listener's notes and setup output that
// looks wrong.
function setupLines(entries) {
  const out = [];
  // The listener's notes (image builds, mounts, egress cache…), the first one aside: the
  // lines above say it.
  const notes = entries.filter((e) => e.kind === "meta").slice(1);
  if (notes.length) {
    out.push("", "Listener notes:", ...notes.slice(0, 20).map((e) => `- ${clip(e.text, 2, 300)}`));
  }
  const raw = entries.filter(
    (e) => e.kind === "raw" && !PUSH_HINT.test(e.text) && NOTABLE.test(e.text),
  );
  if (raw.length) {
    out.push(
      "",
      `Setup output that looks wrong (${raw.length} line${raw.length > 1 ? "s" : ""}${raw.length > 30 ? ", the first 30" : ""}):`,
      "```",
      ...raw.slice(0, 30).map((e) => clip(e.text, 1, 300)),
      "```",
    );
  }
  return out;
}

// Tool calls: how many of each (`tools`), each distinct call's count (`calls`), and those that
// failed with what they gave back (`failed`). An output answers the call before it.
export function toolStats(entries) {
  const tools = new Map();
  const calls = new Map();
  const failed = [];
  let last = null;
  for (const e of entries) {
    if (e.kind === "tool") {
      tools.set(e.name, (tools.get(e.name) ?? 0) + 1);
      const call = `${e.name}: ${clip(e.text, 1, 200)}`;
      calls.set(call, (calls.get(call) ?? 0) + 1);
      last = e;
    } else if (e.kind === "output" && e.error) {
      failed.push({ tool: last, output: e.text });
    }
  }
  return { tools, calls, failed };
}

// The digest's lines on tool calls: the counts, the same call made again and again, the
// failures (without what they gave back when `isPublic`).
function toolLines(entries, { isPublic = false } = {}) {
  const { tools, calls, failed } = toolStats(entries);
  const out = [];
  const total = [...tools.values()].reduce((a, b) => a + b, 0);
  if (total) {
    const each = [...tools].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`);
    out.push("", `Tool calls: ${total} (${each.join(", ")})`);
  }
  const repeated = [...calls].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  if (repeated.length) {
    out.push(
      "",
      "Made 3 times or more:",
      ...repeated.slice(0, 10).map(([call, n]) => `- ${n}× \`${call.replaceAll("`", "'")}\``),
    );
  }
  if (failed.length) {
    out.push(
      "",
      `Failed tool calls (${failed.length}${failed.length > 10 ? ", the last 10" : ""}):`,
    );
    for (const { tool, output } of failed.slice(-10)) {
      const call = tool ? `${tool.name}: ${clip(tool.text, 3, 300)}` : "(unknown call)";
      out.push(
        "",
        "```",
        call,
        "→",
        isPublic ? "(output left out: public repository)" : clip(output, 12, 1200),
        "```",
      );
    }
  }
  return out;
}

// The digest of `runs` (newest first): a header, then each run's part, redacted of
// `secrets`, while the whole stays under `max` bytes; the older runs beyond it are left out,
// and the header says so. `partOf(run)`: its part (runDigest()), null when its log is gone.
// → { text, bytes, included: [id], left: [id] }.
export async function buildDigest(
  runs,
  { partOf, secrets = [], max = MAX_DIGEST, selection = null } = {},
) {
  const parts = [];
  const left = [];
  let size = 0;
  let full = false;
  for (const run of runs) {
    // The newest first, until the digest is full: an older run's log isn't read for nothing.
    if (full) {
      left.push(run.id);
      continue;
    }
    const raw = await partOf(run);
    if (raw === null) {
      left.push(run.id);
      continue;
    }
    const part = redact(raw, secrets);
    const bytes = Buffer.byteLength(part) + 2;
    // Once one doesn't fit, the older ones don't go in either: the newest runs are read.
    full ||= size + bytes > max;
    if (full) {
      left.push(run.id);
      continue;
    }
    parts.push({ id: run.id, part });
    size += bytes;
  }
  const what = selection
    ? ` (kinds: ${selection.kinds.join(", ")}; outcomes: ${selection.outcomes.join(", ")})`
    : "";
  const header = [
    `# Run digest: ${parts.length} run${parts.length === 1 ? "" : "s"}${what}, newest first`,
    "",
    left.length
      ? `${left.length} older run${left.length === 1 ? "" : "s"} left out, over the digest's ${Math.round(max / 1000)} KB cap or without a log: ${left.join(", ")}.`
      : "Every selected run is here.",
  ].join("\n");
  const text = [header, ...parts.map((p) => p.part)].join("\n\n");
  return { text, bytes: Buffer.byteLength(text), included: parts.map((p) => p.id), left };
}

// A run's part, from its log (`readLog(id)`: its text, the runner's, ../runner/client.mjs);
// null when the log is gone (removed by retention, say) or can't be read now.
export async function logPart(run, options, readLog) {
  let text;
  try {
    text = await readLog(run.id);
  } catch {
    return null;
  }
  if (!text) return null;
  return runDigest(run, text.split("\n"), options);
}

// The listener's half: previews for the form, the digest for the run. `runs()`: ctx.runs;
// `secrets()`: the values no digest may carry (runs.mjs hidden()). Each run's part is kept
// once built: a finished run's log no longer changes, and the form previews often.
export function createAnalysis({
  runs,
  secrets = () => [],
  readLog = async () => null,
  partOf = (run, options) => logPart(run, options, readLog),
  max = MAX_DIGEST,
}) {
  // "<run id> <public>" → { id, finishedAt, part }: a few KB each, not the log.
  const cache = new Map();
  const cachedIn = (isPublic) => async (run) => {
    const key = `${run.id} ${isPublic}`;
    const known = cache.get(key);
    if (known?.finishedAt === run.finishedAt) return known.part;
    const part = await partOf(run, { isPublic });
    if (part !== null) cache.set(key, { id: run.id, finishedAt: run.finishedAt, part });
    return part;
  };
  const digestOf = (selected, selection, isPublic = false) => {
    // Runs gone from the list (retention) leave the cache too.
    const ids = new Set(runs().map((r) => r.id));
    for (const [key, { id }] of cache) if (!ids.has(id)) cache.delete(key);
    const partOf = cachedIn(isPublic);
    return buildDigest(selected, { partOf, secrets: secrets(), max, selection });
  };
  return {
    // What the form shows: how many runs match, the digest's size and the kinds there are.
    async preview(repo, selection) {
      const selected = selectRuns(runs(), repo, selection);
      const { bytes, included, left } = await digestOf(selected, selection);
      return {
        runs: selected.map((r) => r.id),
        included: included.length,
        left: left.length,
        bytes,
        tokens: tokens(bytes),
        kinds: runKinds(runs(), repo),
      };
    },
    select: (repo, selection) => selectRuns(runs(), repo, selection),
    // The digest of these runs, as they are now: those of `repo` still listed, never research
    // (an analysis asked for before they were left out may list some). `isPublic`: the repo is
    // public (runDigest()).
    digest(repo, ids, selection = null, { isPublic = false } = {}) {
      const byId = new Map(runs().map((r) => [r.id, r]));
      const selected = ids.map((id) => byId.get(id)).filter((r) => r && readable(r, repo));
      return digestOf(selected, selection, isPublic);
    },
  };
}

// The label of run analyses' issues.
const ANALYSIS_LABEL = "analysis";
// How an analysis's issue names each outcome.
const OUTCOME_NAMES = {
  ok: "successes",
  error: "errors",
  "needs-input": "needs-input",
  interrupted: "interrupted",
  cancelled: "cancelled",
};

// The analysis's issue: its title, its body, and the selection as the run reads it (`text`).
function analysisIssue(repo, user, runs, { count, kinds, outcomes }) {
  const every = outcomes.length === OUTCOMES.length;
  const title = `Run analysis: last ${runs.length} run${runs.length === 1 ? "" : "s"}${every ? "" : ` (${outcomes.map((o) => OUTCOME_NAMES[o]).join(", ")})`}`;
  const text = [
    `- Kinds: ${kinds.join(", ")}`,
    `- Outcomes: ${outcomes.join(", ")}`,
    `- Runs (${runs.length}${runs.length < count ? `, of ${count} asked for` : ""}, newest first): ${runs.map((r) => r.id).join(", ")}`,
  ].join("\n");
  const body = `Asked for from the dashboard by @${user}: what would make the runs of ${repo} faster and more reliable.\n\n${text}\n\nDeckhand reads a digest of these runs (not their raw logs) and replies here with its findings. It changes no code: file what you want of them.`;
  return { title, body, text };
}

// A run analysis (the dashboard's Analyze, work.mjs): the runs it reads, picked now among the
// repo's (never another's), in an issue of its own that stays as its record, then the run on
// it. The run reads a digest of them (preparation.mjs analysisDigest()); it changes nothing,
// and its reply is the report. `github`: the App's calls; `checkedRepo(repo, user)`:
// repo-check.mjs; `analysis`: createAnalysis(); `accept(item)`: queues the run (tasks.mjs).
// Throws Refused (web.mjs).
export async function startAnalysis(
  { github, checkedRepo, analysis, accept, log },
  repo,
  user,
  selection,
) {
  const { settings, base, isPrivate } = await checkedRepo(repo, user);
  const runs = analysis.select(repo, selection);
  if (!runs.length) refuse(409, `No run of ${repo} matches: pick other kinds or outcomes.`);
  const { title, body, text } = analysisIssue(repo, user, runs, selection);
  await ensureLabel(
    github,
    repo,
    { name: ANALYSIS_LABEL, color: "c5def5", description: "A Deckhand analysis of past runs" },
    log,
  );
  const res = await github(
    repo,
    "POST",
    `/repos/${repo}/issues`,
    { title, body, labels: [ANALYSIS_LABEL] },
    [410],
  );
  if (res.status === 410) refuse(409, `${repo} has issues turned off: an analysis needs one.`);
  if (!res.ok) throw new Error(`GitHub POST an issue: ${res.status}`);
  const issue = await res.json();
  const { count, kinds, outcomes } = selection;
  const item = issueItem(repo, issue, {
    trigger: "analyze",
    modeLine: null,
    text,
    author: user,
    base,
    settings,
    comment: null,
    // For the policies' `input.trigger` (run-policy.mjs).
    dashboard: true,
    // Whether the digest may quote what only the dashboard showed (runDigest()): only on a
    // repo GitHub said was private.
    analysis: { runs: runs.map((r) => r.id), count, kinds, outcomes, private: isPrivate },
  });
  await accept(item);
  // The policies refused it (run-policy.mjs), saying so on the issue: the form's answer too, and
  // the issue made for it closed, no analysis to keep.
  if (item.refused) {
    await github(repo, "PATCH", `/repos/${repo}/issues/${issue.number}`, {
      state: "closed",
      state_reason: "not_planned",
    }).catch((error) => log(`${repo}#${issue.number}: closing it: ${error.message ?? error}`));
    refuse(403, item.refused);
  }
  return {
    message: `Analysis of ${runs.length} run${runs.length === 1 ? "" : "s"} started on #${issue.number}.`,
    url: issue.html_url,
    number: issue.number,
    task: taskKey(repo, issue.number),
  };
}
