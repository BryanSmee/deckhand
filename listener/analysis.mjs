// Run analysis (the dashboard's Analyze): a selection of a repo's past runs, digested for a
// light run that reads them and replies with what would make sessions faster or more
// reliable. A digest, not the logs: those are MB of stream-json each, cover every repo and
// are only redacted line by line as they are written. Built from format()'s entries, which
// clip tool details and outputs, redacted again, capped in size. Pure, apart from reading
// the logs.
import { readFileSync } from "node:fs";
import { agentFor } from "./agents/index.mjs";
import { clip, format } from "./runlog.mjs";
import { redact } from "./secrets.mjs";

// How many runs one analysis reads: 10 unless asked, 50 at most.
export const DEFAULT_RUNS = 10;
export const MAX_RUNS = 50;
// The digest's cap, in bytes: older runs beyond it are left out (and the digest says so).
export const MAX_DIGEST = 400_000;
// One run's share at most, so a single long run doesn't push all the others out.
const MAX_RUN = 24_000;
// Run statuses an analysis can pick (runlog.mjs outcome(), and runs that ended otherwise).
export const OUTCOMES = ["ok", "error", "needs-input", "interrupted", "cancelled"];
// About four bytes a token: the preview's estimate of what the run reads.
export const tokens = (bytes) => Math.ceil(bytes / 4);

// What a run was: its mode (work, brainstorm, idea, bug, discussion, onboarding, analyze or
// one of the repo's own), or its kind for logs from before runs kept their mode.
export function kindOf(run) {
  return run.taskMode ?? run.kind ?? "work";
}

const ofRepo = (run, repo) => run.repo?.toLowerCase() === repo.toLowerCase();
const finished = (run) => run.status !== "running";

// The kinds of a repo's finished runs, for the form to offer.
export function runKinds(runs, repo) {
  const kinds = new Set(runs.filter((r) => ofRepo(r, repo) && finished(r)).map(kindOf));
  return [...kinds].sort();
}

// The `count` newest finished runs of `repo` (never another repo's) of those kinds and
// outcomes. `runs`: newest first, as ctx.runs is.
export function selectRuns(runs, repo, { count, kinds, outcomes }) {
  return runs
    .filter(
      (r) =>
        ofRepo(r, repo) && finished(r) && kinds.includes(kindOf(r)) && outcomes.includes(r.status),
    )
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

// One run's part of the digest: what it was, how it ended, what went wrong on the way and its
// final reply. `lines`: its log's lines (the first one the listener's).
export function runDigest(run, lines) {
  const agent = agentFor(run.agent);
  const entries = lines.flatMap((l) => format(l, agent));
  const minutes =
    run.finishedAt && run.startedAt
      ? Math.round((run.finishedAt - run.startedAt) / 6000) / 10
      : null;
  const what = [
    `kind ${kindOf(run)}${run.mode ? ` (${run.mode})` : ""}`,
    `${agent.name}${run.provider ? `@${run.provider}` : ""} ${run.model ?? "?"}, ${run.effort ?? "?"} effort`,
    `${run.status}${minutes !== null ? ` after ${minutes} min` : ""}`,
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

  // The listener's notes (image builds, mounts, egress cache…), the first one aside: the
  // lines above say it.
  const notes = entries.filter((e) => e.kind === "meta").slice(1);
  if (notes.length) {
    out.push("", "Listener notes:", ...notes.slice(0, 20).map((e) => `- ${clip(e.text, 2, 300)}`));
  }
  const raw = entries.filter((e) => e.kind === "raw" && NOTABLE.test(e.text));
  if (raw.length) {
    out.push(
      "",
      `Setup output that looks wrong (${raw.length} line${raw.length > 1 ? "s" : ""}${raw.length > 30 ? ", the first 30" : ""}):`,
      "```",
      ...raw.slice(0, 30).map((e) => clip(e.text, 1, 300)),
      "```",
    );
  }

  // Tool calls: how many of each, the same call made again and again, and those that failed
  // with what they gave back. An output answers the call before it.
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
      out.push("", "```", call, "→", clip(output, 12, 1200), "```");
    }
  }
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

// The digest of `runs` (newest first): a header, then each run's part, redacted of
// `secrets`, while the whole stays under `max` bytes; the older runs beyond it are left out,
// and the header says so. `partOf(run)`: its part (runDigest()), null when its log is gone.
// → { text, bytes, included: [id], left: [id] }.
export function buildDigest(
  runs,
  { partOf = logPart, secrets = [], max = MAX_DIGEST, selection = null } = {},
) {
  const parts = [];
  const left = [];
  let size = 0;
  let full = false;
  for (const run of runs) {
    const raw = partOf(run);
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

// A run's part, from its log; null when the log is gone (removed by retention, say).
export function logPart(run) {
  let text;
  try {
    text = readFileSync(run.logPath, "utf8");
  } catch {
    return null;
  }
  return runDigest(run, text.split("\n"));
}

// The listener's half: previews for the form, the digest for the run. `runs()`: ctx.runs;
// `secrets()`: the values no digest may carry (runs.mjs hidden()). Each run's part is kept
// once built: a finished run's log no longer changes, and the form previews often.
export function createAnalysis({ runs, secrets = () => [], partOf = logPart, max = MAX_DIGEST }) {
  // run id → { finishedAt, part }: a few KB each, not the log.
  const cache = new Map();
  const cached = (run) => {
    const known = cache.get(run.id);
    if (known?.finishedAt === run.finishedAt) return known.part;
    const part = partOf(run);
    if (part !== null) cache.set(run.id, { finishedAt: run.finishedAt, part });
    return part;
  };
  const digestOf = (selected, selection) => {
    // Runs gone from the list (retention) leave the cache too.
    const ids = new Set(runs().map((r) => r.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    return buildDigest(selected, { partOf: cached, secrets: secrets(), max, selection });
  };
  return {
    // What the form shows: how many runs match, the digest's size and the kinds there are.
    preview(repo, selection) {
      const selected = selectRuns(runs(), repo, selection);
      const { bytes, included, left } = digestOf(selected, selection);
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
    // The digest of these runs, as they are now: those of `repo` still listed.
    digest(repo, ids, selection = null) {
      const byId = new Map(runs().map((r) => [r.id, r]));
      const selected = ids.map((id) => byId.get(id)).filter((r) => r && ofRepo(r, repo));
      return digestOf(selected, selection);
    },
  };
}
