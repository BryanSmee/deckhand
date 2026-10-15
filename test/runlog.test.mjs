import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clip, format, loadRuns, outcome, publicRun, summaryOf } from "../listener/runlog.mjs";

const line = (event) => JSON.stringify(event);

test("outcome: ok, needs-input or error", () => {
  assert.equal(outcome(null), "error");
  assert.equal(outcome({ is_error: true, result: "Oops" }), "error");
  assert.equal(outcome({ result: "Done." }), "ok");
  assert.equal(outcome({ result: "\n<!-- needs-input -->\n## Needs your input" }), "needs-input");
});

test("summary: the first sentence of the reply, not its headings", () => {
  assert.equal(summaryOf(null), null);
  assert.equal(summaryOf({ result: "" }), null);
  assert.equal(
    summaryOf({ result: "<!-- needs-input -->\n## Needs your input\n\n1. Which one?" }),
    "1. Which one?",
  );
  assert.equal(summaryOf({ result: "## Only a heading" }), "Only a heading");
  assert.equal(summaryOf({ result: "> - Quoted item" }), "Quoted item");
  const long = summaryOf({ result: "x".repeat(300) });
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
  const runs = loadRuns(dir);
  assert.deepEqual(
    runs.map((r) => [r.id, r.key, r.status, r.summary, r.title]),
    [
      ["deckhand-org-repo-2-2000", "deckhand-org-repo-2", "interrupted", null, null],
      ["deckhand-org-repo-1-1000", "org/repo#1", "ok", "Done.", "One"],
    ],
  );
  assert.equal(runs[1].logPath, join(dir, "deckhand-org-repo-1-1000.log"));
  assert.equal("logPath" in publicRun(runs[1]), false);
});
