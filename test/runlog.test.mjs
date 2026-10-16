import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clip,
  format,
  lastResult,
  loadRuns,
  outcome,
  publicRun,
  saveSummary,
  stream,
  summaryOf,
} from "../listener/runlog.mjs";
import { agentFor } from "../listener/agents/index.mjs";

const line = (event) => JSON.stringify(event);

test("outcome: ok, needs-input or error", () => {
  assert.equal(outcome(null), "error");
  assert.equal(outcome({ ok: false, text: "Oops" }), "error");
  assert.equal(outcome({ ok: true, text: "Done." }), "ok");
  assert.equal(
    outcome({ ok: true, text: "\n<!-- needs-input -->\n## Needs your input" }),
    "needs-input",
  );
});

test("summary: the first sentence of the reply, not its headings", () => {
  assert.equal(summaryOf(null), null);
  assert.equal(summaryOf({ text: "" }), null);
  assert.equal(
    summaryOf({ text: "<!-- needs-input -->\n## Needs your input\n\n1. Which one?" }),
    "1. Which one?",
  );
  assert.equal(summaryOf({ text: "## Only a heading" }), "Only a heading");
  assert.equal(summaryOf({ text: "> - Quoted item" }), "Quoted item");
  const long = summaryOf({ text: "x".repeat(300) });
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});

test("clip: lines first, then characters", () => {
  assert.equal(clip("a\nb", 5, 100), "a\nb");
  assert.equal(clip("a\nb\nc", 2, 100), "a\nb\n…");
  assert.equal(clip("abcdef", 5, 3), "abc\n…");
  assert.equal(clip(42, 1, 10), "42");
});

test("format: the listener's lines", () => {
  assert.deepEqual(format("  "), []);
  assert.deepEqual(format("Cloning into 'repo'..."), [
    { kind: "raw", text: "Cloning into 'repo'..." },
  ]);
  assert.deepEqual(format(line({ type: "listener", event: "note", message: "Image x" })), [
    { kind: "meta", text: "Image x" },
  ]);
  assert.deepEqual(
    format(
      line({
        type: "listener",
        event: "delivered",
        at: Date.UTC(2026, 0, 1, 9, 5, 7),
        message: "Hi",
      }),
    ),
    [{ kind: "meta", text: "New comment delivered to Claude at 09:05:07 UTC: Hi" }],
  );
  const start = (e) => format(line({ type: "listener", ...e }))[0].text;
  assert.equal(start({ mode: "start", kind: "issue", taskMode: "work" }), "Starting");
  assert.equal(
    start({ mode: "start", kind: "brainstorm", model: "sonnet", effort: "low", message: "Go" }),
    "Starting a brainstorm (sonnet, low effort): Go",
  );
  assert.equal(start({ mode: "continue", kind: "issue" }), "Continuing the session");
  assert.equal(
    start({ mode: "start", kind: "pr", taskMode: "review" }),
    "Starting the review mode",
  );
  assert.equal(
    start({ mode: "continue", kind: "issue", reason: "conflict" }),
    "Rebasing a pull request in conflict",
  );
  // A fallback's run says where it came from; one that stuck to it doesn't again.
  const fallback = { from: "claude@anthropic", reason: "overloaded (529)", tried: [] };
  const fell = { mode: "start", kind: "issue", agent: "codex", provider: "openai", fallback };
  assert.equal(
    format(line({ type: "listener", ...fell }), agentFor("codex"))[0].text,
    "Falling back to Codex (openai) from claude@anthropic, whose provider failed: overloaded (529). Starting",
  );
  const stuck = { ...fell, mode: "continue", fallback: { ...fallback, sticky: true } };
  assert.equal(start(stuck), "Continuing the session");
});

test("format: Claude's lines", () => {
  assert.deepEqual(format(line({ type: "system", subtype: "init", model: "opus" })), [
    { kind: "meta", text: "Claude started (opus)" },
  ]);
  assert.deepEqual(format(line({ type: "system", subtype: "hook" })), []);
  const assistant = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Looking." },
        { type: "thinking", thinking: "…" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", name: "Other", input: { a: 1 } },
        { type: "tool_use", name: "None", input: {} },
      ],
    },
  };
  assert.deepEqual(format(line(assistant)), [
    { kind: "text", text: "Looking." },
    { kind: "tool", name: "Bash", text: "ls" },
    { kind: "tool", name: "Other", text: '{"a":1}' },
    { kind: "tool", name: "None", text: "" },
  ]);
  const user = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", content: "out" },
        { type: "tool_result", is_error: true, content: [{ type: "text", text: "bad" }] },
        { type: "text", text: "ignored" },
      ],
    },
  };
  assert.deepEqual(format(line(user)), [
    { kind: "output", error: false, text: "out" },
    { kind: "output", error: true, text: "bad" },
  ]);
  assert.deepEqual(format(line({ type: "result", result: "Done.", duration_ms: 90000 })), [
    { kind: "result", status: "ok", text: "Done.", minutes: 1.5 },
  ]);
  // Unknown types, and names an object has from its prototype, show nothing.
  assert.deepEqual(format(line({ type: "rate_limit_event" })), []);
  assert.deepEqual(format(line({ type: "constructor" })), []);
  assert.deepEqual(format("42"), []);
});

// A log written before the agent seam, and what the dashboard showed for it then: the
// same entries now that Claude Code's lines are read through its normalize().
test("format: a log from before the agent seam renders as it did", () => {
  const fixture = (name) => new URL(`fixtures/${name}`, import.meta.url);
  const lines = readFileSync(fixture("claude-run.log"), "utf8").split("\n");
  const before = JSON.parse(readFileSync(fixture("claude-run.entries.json"), "utf8"));
  assert.deepEqual(
    lines.flatMap((l) => format(l)),
    before,
  );
  assert.deepEqual(
    lines.flatMap((l) => format(l, agentFor("claude"))),
    before,
  );
});

test("lastResult: the agent's last result in a log's lines", () => {
  const claude = agentFor("claude");
  assert.equal(lastResult(["Cloning", line({ type: "system", subtype: "init" })], claude), null);
  assert.deepEqual(
    lastResult(
      [
        line({ type: "result", result: "First", duration_ms: 1000 }),
        line({ type: "result", is_error: true, result: "Second", duration_ms: 2000 }),
        "trailing output",
      ],
      claude,
    ),
    { type: "result", ok: false, text: "Second", durationMs: 2000 },
  );
});

test("runs: rebuilt from their log files, newest first, without their path for the dashboard", () => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-"));
  const meta = {
    type: "listener",
    key: "org/repo#1",
    kind: "issue",
    title: "One",
    repo: "org/repo",
  };
  writeFileSync(
    join(dir, "deckhand-org-repo-1-1000.log"),
    [line({ ...meta, startedAt: 1000 }), line({ type: "result", result: "Done." })].join("\n"),
  );
  // No listener line and no result: an old log, interrupted.
  writeFileSync(join(dir, "deckhand-org-repo-2-2000.log"), "Cloning\n");
  writeFileSync(join(dir, "deckhand-org-repo-1-1000.live.json"), "{}");
  // Stopped to ask: its questions, for the task rather than the run.
  const asked = "<!-- needs-input -->\n## Needs your input\n\n1. **Name**: which one?";
  writeFileSync(
    join(dir, "deckhand-org-repo-3-500.log"),
    [
      line({ ...meta, key: "org/repo#3", startedAt: 500 }),
      line({ type: "result", result: asked }),
    ].join("\n"),
  );
  const runs = loadRuns(dir).filter((r) => r.key !== "org/repo#3");
  const stopped = loadRuns(dir).find((r) => r.key === "org/repo#3");
  assert.equal(stopped.status, "needs-input");
  assert.deepEqual(stopped.questions, {
    items: [{ title: "Name", text: "which one?", options: [] }],
    raw: "1. **Name**: which one?",
  });
  assert.equal("questions" in publicRun(stopped), false);
  assert.equal(runs[1].questions, null);
  assert.deepEqual(
    runs.map((r) => [r.id, r.key, r.status, r.summary, r.title]),
    [
      ["deckhand-org-repo-2-2000", "deckhand-org-repo-2", "interrupted", null, null],
      ["deckhand-org-repo-1-1000", "org/repo#1", "ok", "Done.", "One"],
    ],
  );
  assert.equal(runs[1].logPath, join(dir, "deckhand-org-repo-1-1000.log"));
  // Logs from before agents had names are Claude Code's.
  assert.equal(runs[1].agent, "claude");
  assert.equal("logPath" in publicRun(runs[1]), false);
});

// A sign-out, or a repo's users narrowed, while the stream is open: it ends within a second.
test(
  "stream: a running run's log stops once the viewer may no longer see it",
  { timeout: 5000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "deckhand-stream-"));
    const logPath = join(dir, "run.log");
    writeFileSync(logPath, "");
    const req = new EventEmitter();
    let ended;
    const done = new Promise((resolve) => (ended = resolve));
    const written = [];
    const res = { writeHead() {}, write: (s) => written.push(s), end: ended };
    let allowed = true;
    stream(req, res, { status: "running", logPath, agent: "claude" }, () => allowed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    allowed = false;
    await done;
    assert.ok(!written.some((w) => w.startsWith("event: end")));
  },
);

test("runs: the comments a run ran on come back from its log, for a rerun, not for the dashboard", () => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-"));
  const items = [
    { id: "4", kind: "issue", number: 4, trigger: "work", modeLine: null, text: "Fix it" },
  ];
  writeFileSync(
    join(dir, "deckhand-org-repo-4-1000.log"),
    line({ type: "listener", key: "org/repo#4", repo: "org/repo", startedAt: 1000, items }),
  );
  writeFileSync(
    join(dir, "deckhand-org-repo-5-900.log"),
    line({ type: "listener", key: "org/repo#5", repo: "org/repo", startedAt: 900 }),
  );
  const [run, old] = loadRuns(dir);
  assert.equal(run.status, "interrupted");
  assert.deepEqual(run.items, items);
  assert.equal(old.items, null);
  assert.equal("items" in publicRun(run), false);
});

test("runs: an older log without a summary is read once, then its summary is", () => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-"));
  const logPath = join(dir, "deckhand-org-repo-6-1000.log");
  const meta = { type: "listener", key: "org/repo#6", repo: "org/repo", startedAt: 1000 };
  writeFileSync(logPath, [line(meta), line({ type: "result", result: "Done." })].join("\n"));
  const [first] = loadRuns(dir);
  assert.equal(first.summary, "Done.");
  const saved = JSON.parse(readFileSync(join(dir, "deckhand-org-repo-6-1000.json"), "utf8"));
  assert.equal(saved.status, "ok");
  assert.equal("logPath" in saved, false);
  // The next start lists it from its summary: the log isn't read again.
  writeFileSync(logPath, [line(meta), line({ type: "result", result: "Changed." })].join("\n"));
  const [again] = loadRuns(dir);
  assert.deepEqual(again, first);
});

test("runs: a live run gets no summary from its log, the one written when it ends wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-"));
  const id = "deckhand-org-repo-7-1000";
  const logPath = join(dir, `${id}.log`);
  writeFileSync(logPath, line({ type: "listener", key: "org/repo#7", startedAt: 1000 }));
  writeFileSync(join(dir, `${id}.live.json`), "{}");
  assert.equal(loadRuns(dir)[0].status, "interrupted");
  assert.equal(existsSync(join(dir, `${id}.json`)), false);
  const record = { id, key: "org/repo#7", startedAt: 1000, finishedAt: 5000, logPath };
  saveSummary({ ...record, status: "ok", summary: "Done.", shots: "a".repeat(24) });
  const [run] = loadRuns(dir);
  assert.deepEqual(
    [run.status, run.summary, run.finishedAt, run.logPath],
    ["ok", "Done.", 5000, logPath],
  );
  assert.equal("shots" in publicRun(run), false);
});

// Thousands of runs whose logs are never opened: their summaries alone.
test("runs: a few thousand runs with summaries load fast", () => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-"));
  const count = 3000;
  const big = line({ type: "result", result: "x".repeat(20_000) });
  for (let i = 0; i < count; i++) {
    const id = `deckhand-org-repo-${i % 50}-${i}`;
    const logPath = join(dir, `${id}.log`);
    writeFileSync(logPath, big);
    saveSummary({ id, key: `org/repo#${i % 50}`, startedAt: i, status: "ok", logPath });
  }
  const started = performance.now();
  const runs = loadRuns(dir);
  const ms = performance.now() - started;
  assert.equal(runs.length, count);
  assert.equal(runs[0].startedAt, count - 1);
  // Read from their logs, they would have a summary.
  assert.ok(runs.every((r) => r.summary === undefined));
  assert.ok(ms < 3000, `${count} runs took ${Math.round(ms)} ms`);
});
