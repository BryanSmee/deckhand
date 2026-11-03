import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  clip,
  enterPhase,
  format,
  lastResult,
  loadRuns,
  minutes,
  moveLogs,
  moveSummaries,
  openLog,
  outcome,
  phaseOf,
  publicRun,
  buildOutput,
  reader,
  saveSummary,
  sessionEventOf,
  summaryKey,
  sessionModeOf,
  stream,
  summaryOf,
  writeEvent,
} from "../listener/runlog.mjs";
import { agentFor } from "../listener/agents/index.mjs";
import { openStore } from "../lib/store.mjs";
import { tempDir } from "./helpers.mjs";

const line = (event) => JSON.stringify(event);

// The runner's logs (runner/client.mjs logs), as moveLogs() sends them: each upload's id, and
// its text then, by id. `refuse`: ids it doesn't take.
function fakeRunner(refuse = []) {
  const logs = new Map();
  return {
    logs,
    upload: async (id, path) => {
      if (refuse.includes(id)) throw new Error("the runner service didn't answer");
      logs.set(id, readFileSync(path, "utf8"));
    },
  };
}

// The redacted copies moveLogs() left in `dir` (runlog.mjs redactedCopy()).
const redactedCopies = (dir) => readdirSync(dir).filter((f) => f.endsWith(".redacted"));

// A start: the logs a listener kept itself go to the runner, the summaries in `dir` to the
// store, then the runs are listed from it.
async function started(dir, options) {
  await moveLogs(dir, options?.runner ?? fakeRunner(), options).done;
  return listed(dir, options);
}

// The runs a start lists: the summaries in `dir` moved to `store` first, by default the one
// `dir`'s earlier starts had, as the orchestrator's store outlives it.
const stores = new Map();
const storeOf = (dir) => stores.get(dir) ?? stores.set(dir, openStore("memory:")).get(dir);
async function listed(dir, { store = storeOf(dir), ...options } = {}) {
  await moveSummaries(dir, store, options);
  return loadRuns(store, options);
}

// What stream() reads a log by (the runner's, as edge): a file here, empty until written.
const fromFile = (path) => async (offset) => ({
  data: existsSync(path) ? readFileSync(path).subarray(offset) : Buffer.alloc(0),
});

test("outcome: ok, needs-input or error", () => {
  assert.equal(outcome(null), "error");
  assert.equal(outcome({ ok: false, text: "Oops" }), "error");
  assert.equal(outcome({ ok: true, text: "Done." }), "ok");
  assert.equal(
    outcome({ ok: true, text: "\n<!-- needs-input -->\n## Needs your input" }),
    "needs-input",
  );
  // Issue #705: after a translated heading or a sentence, on a line of its own, it still asks.
  for (const text of [
    "## Besoin de votre avis\n\n<!-- needs-input -->\n\n1. Lequel ?",
    "Il me faut votre avis.\n<!-- needs-input -->\n1. Lequel ?",
  ]) {
    assert.equal(outcome({ ok: true, text }), "needs-input", text);
  }
  // Not quoted in a sentence, in a code block, or after the first question.
  for (const text of [
    "Done. A run asks with `<!-- needs-input -->` first.",
    "Done.\n```\n<!-- needs-input -->\n```",
    "Done.\n1. Fixed it.\n<!-- needs-input -->",
    "Done.\n\n<!-- needs-input --> is what a run starts with to ask.",
  ]) {
    assert.equal(outcome({ ok: true, text }), "ok", text);
  }
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

test("writeEvent: the listener's line, at now unless it says when; minutes to a tenth", () => {
  const lines = [];
  const file = { write: (text) => lines.push(text) };
  const before = Date.now();
  writeEvent(file, "note", { message: "hi" });
  writeEvent(file, "cancelled", { by: "alice", at: 5 });
  assert.ok(lines.every((l) => l.endsWith("\n")));
  const [note, cancelled] = lines.map((l) => JSON.parse(l));
  assert.equal(note.type, "listener");
  assert.equal(note.event, "note");
  assert.equal(note.message, "hi");
  assert.ok(note.at >= before && note.at <= Date.now());
  // Its fields in their order: logs from before read the same.
  assert.equal(lines[1], '{"type":"listener","event":"cancelled","by":"alice","at":5}\n');
  assert.deepEqual(cancelled, { type: "listener", event: "cancelled", by: "alice", at: 5 });
  assert.equal(minutes(90_000), 1.5);
  assert.equal(minutes(0), 0);
  assert.equal(minutes(6_100_000), 101.7);
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
  assert.equal(
    start({ mode: "start", kind: "issue", model: "opus", effort: "high", speed: "fast" }),
    "Starting (opus, high effort, fast)",
  );
  assert.equal(start({ mode: "continue", kind: "issue" }), "Continuing the session");
  assert.equal(start({ mode: "start", kind: "pr", taskMode: "audit" }), "Starting the audit mode");
  assert.equal(
    start({ mode: "continue", kind: "issue", reason: "conflict" }),
    "Rebasing a pull request in conflict",
  );
  assert.equal(
    start({ mode: "continue", kind: "issue", reason: "review-fix" }),
    "Addressing the findings of a review that requested changes",
  );
  // A fallback's run says where it came from; one that stuck to it doesn't again.
  const fallback = { from: "claude@anthropic", reason: "overloaded (529)", tried: [] };
  const fell = { mode: "start", kind: "issue", agent: "codex", provider: "openai", fallback };
  assert.equal(
    format(line({ type: "listener", ...fell }), agentFor("codex"))[0].text,
    "Falling back to Codex (openai) from Claude (anthropic), whose provider failed: overloaded (529). Starting",
  );
  const stuck = { ...fell, mode: "continue", fallback: { ...fallback, sticky: true } };
  assert.equal(start(stuck), "Continuing the session");
});

test("format: Claude's lines", () => {
  assert.deepEqual(format(line({ type: "system", subtype: "init", model: "opus" })), [
    { kind: "meta", text: "Claude started (opus)" },
  ]);
  // Fast mode once Claude Code says it is on: it says "off" in every other run.
  const init = { type: "system", subtype: "init", model: "opus" };
  assert.equal(
    format(line({ ...init, fast_mode_state: "on" }))[0].text,
    "Claude started (opus, fast mode on)",
  );
  assert.equal(format(line({ ...init, fast_mode_state: "off" }))[0].text, "Claude started (opus)");
  assert.equal(
    format(line({ ...init, fast_mode_state: "toString" }))[0].text,
    "Claude started (opus)",
  );
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

test("runs: logs kept here are summarized, sent to the runner, then listed newest first", async (t) => {
  const dir = tempDir(t);
  const meta = {
    type: "listener",
    key: "org/repo#1",
    kind: "issue",
    title: "One",
    repo: "org/repo",
  };
  writeFileSync(
    join(dir, "deckhand-org-repo-1-1000.log"),
    [
      line({
        ...meta,
        startedAt: 1000,
        provider: "anthropic",
        auth: "plan",
        speed: "fast",
        speedNote: "fast mode runs on opus, not sonnet",
      }),
      line({ type: "result", result: "Done." }),
    ].join("\n"),
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
  const runner = fakeRunner();
  const all = await started(dir, { runner });
  // Every log at the runner, as it was, and none left here.
  assert.deepEqual([...runner.logs.keys()].sort(), [
    "deckhand-org-repo-1-1000",
    "deckhand-org-repo-2-2000",
    "deckhand-org-repo-3-500",
  ]);
  assert.equal(runner.logs.get("deckhand-org-repo-2-2000"), "Cloning\n");
  assert.equal(existsSync(join(dir, "deckhand-org-repo-2-2000.log")), false);
  // The live run's is listed once restoreRuns() restores it, and summarized when it ends.
  assert.deepEqual(
    all.map((r) => r.id),
    ["deckhand-org-repo-2-2000", "deckhand-org-repo-3-500"],
  );
  // Its state gone without a summary (a listener from before summaries): its log, read.
  rmSync(join(dir, "deckhand-org-repo-1-1000.live.json"));
  writeFileSync(
    join(dir, "deckhand-org-repo-1-1000.log"),
    runner.logs.get("deckhand-org-repo-1-1000"),
  );
  const listed = await started(dir);
  const runs = listed.filter((r) => r.key !== "org/repo#3");
  const stopped = listed.find((r) => r.key === "org/repo#3");
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
  // Logs from before agents had names are Claude Code's; from before speeds, no speed.
  assert.equal(runs[1].agent, "claude");
  assert.deepEqual(
    [runs[1].speed, runs[1].speedNote],
    ["fast", "fast mode runs on opus, not sonnet"],
  );
  assert.deepEqual([runs[0].speed, runs[0].speedNote], [null, null]);
  // The credential it ran on survives the restart; none known from before it.
  assert.deepEqual([runs[1].auth, runs[0].auth], ["plan", null]);
  // Where a summary from before #503 said its log was: not for the dashboard.
  assert.equal("logPath" in publicRun({ ...runs[1], logPath: "/data/logs/x.log" }), false);
});

// A sign-out, or a repo's users narrowed, while the stream is open: it ends within a second.
test(
  "stream: a running run's log stops once the viewer may no longer see it",
  { timeout: 5000 },
  async (t) => {
    const dir = tempDir(t, "deckhand-stream-");
    const logPath = join(dir, "run.log");
    writeFileSync(logPath, "");
    const req = new EventEmitter();
    let ended;
    const done = new Promise((resolve) => (ended = resolve));
    const written = [];
    const res = { writeHead() {}, write: (s) => written.push(s), end: ended };
    let allowed = true;
    stream(
      req,
      res,
      { status: "running", agent: "claude" },
      { read: fromFile(logPath), allowed: () => allowed, every: 20 },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    allowed = false;
    await done;
    assert.ok(!written.some((w) => w.startsWith("event: end")));
  },
);

// A run registered before its first line (a sandbox that never started) has no log file yet.
test("stream: a running run with no log file yet waits for it", { timeout: 5000 }, async (t) => {
  const logPath = join(tempDir(t, "deckhand-stream-"), "run.log");
  const req = new EventEmitter();
  const written = [];
  const res = { writeHead() {}, write: (s) => written.push(s), end() {} };
  const run = { status: "running", agent: "claude" };
  stream(req, res, run, { read: fromFile(logPath), every: 20 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  writeFileSync(logPath, line({ type: "listener", event: "note", message: "Hello", at: 0 }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  req.emit("close");
  assert.ok(written.some((w) => w.startsWith("event: entries") && w.includes("Hello")));
});

test("stream: a finished run with no log file ends", { timeout: 5000 }, async (t) => {
  const logPath = join(tempDir(t, "deckhand-stream-"), "run.log");
  const written = [];
  let ended;
  const done = new Promise((resolve) => (ended = resolve));
  const res = { writeHead() {}, write: (s) => written.push(s), end: ended };
  stream(
    new EventEmitter(),
    res,
    { status: "failed", agent: "claude" },
    { read: fromFile(logPath), every: 20 },
  );
  await done;
  assert.ok(written.some((w) => w.startsWith("event: end")));
});

test("stream: an error reading the log ends that stream only", { timeout: 5000 }, async () => {
  // The runner refusing it, say.
  const read = async () => {
    throw new Error("the log of x: 500");
  };
  const errors = [];
  let ended;
  const done = new Promise((resolve) => (ended = resolve));
  const res = { writeHead() {}, write() {}, end: ended };
  const run = { status: "running", agent: "claude" };
  stream(new EventEmitter(), res, run, { read, every: 20, onError: (e) => errors.push(e) });
  await done;
  assert.equal(errors.length, 1);
});

test("runs: a cancelled run is cancelled after a restart, whatever its last result; its log says who", async (t) => {
  const dir = tempDir(t);
  const result = { type: "result", result: "Half done.", duration_ms: 1000 };
  const cancelled = {
    type: "listener",
    event: "cancelled",
    by: "alice",
    at: Date.UTC(2026, 0, 1, 9),
  };
  writeFileSync(
    join(dir, "deckhand-org-repo-4-1000.log"),
    [
      line({ type: "listener", key: "org/repo#4", startedAt: 1000 }),
      line(result),
      line(cancelled),
    ].join("\n"),
  );
  const [run] = await started(dir);
  assert.equal(run.status, "cancelled");
  assert.equal(run.summary, "Stopped by @alice");
  assert.deepEqual(format(line(cancelled)), [
    { kind: "meta", text: "Stopped by @alice at 09:00:00 UTC" },
  ]);
});

test("log: a run stopped for its silence after its answer says so", () => {
  const ended = { type: "listener", event: "ended", after: 120000, at: Date.UTC(2026, 0, 1, 9) };
  assert.deepEqual(format(line(ended)), [
    {
      kind: "meta",
      text: "Stopped at 09:00:00 UTC, silent for 2 min after its answer: the answer is posted",
    },
  ]);
});

test("runs: the comments a run ran on come back from its log, for a rerun, not for the dashboard", async (t) => {
  const dir = tempDir(t);
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
  const [run, old] = await started(dir);
  assert.equal(run.status, "interrupted");
  assert.deepEqual(run.items, items);
  assert.equal(old.items, null);
  assert.equal("items" in publicRun(run), false);
});

test("runs: an older log without a summary is read, then its summary stands", async (t) => {
  const dir = tempDir(t);
  const logPath = join(dir, "deckhand-org-repo-6-1000.log");
  const meta = { type: "listener", key: "org/repo#6", repo: "org/repo", startedAt: 1000 };
  writeFileSync(logPath, [line(meta), line({ type: "result", result: "Done." })].join("\n"));
  const [first] = await started(dir);
  assert.equal(first.summary, "Done.");
  const saved = await storeOf(dir).get(summaryKey("deckhand-org-repo-6-1000"));
  assert.equal(saved.status, "ok");
  assert.equal("logPath" in saved, false);
  // A log left here again (a start whose upload failed): its summary stands.
  writeFileSync(logPath, [line(meta), line({ type: "result", result: "Changed." })].join("\n"));
  const [again] = await started(dir);
  assert.deepEqual(again, first);
});

test("runs: a log the runner doesn't take stays here, summarized, and goes at the next start", async (t) => {
  const dir = tempDir(t);
  const id = "deckhand-org-repo-11-1000";
  const meta = { type: "listener", key: "org/repo#11", repo: "org/repo", startedAt: 1000 };
  writeFileSync(
    join(dir, `${id}.log`),
    [line(meta), line({ type: "result", result: "Ok." })].join("\n"),
  );
  const logs = [];
  const [run] = await started(dir, { runner: fakeRunner([id]), log: (l) => logs.push(l) });
  assert.equal(run.summary, "Ok.");
  assert.equal(existsSync(join(dir, `${id}.log`)), true);
  assert.match(logs.join("\n"), /not sent to the runner \(the runner service didn't answer\)/);
  const runner = fakeRunner();
  await started(dir, { runner });
  assert.deepEqual([...runner.logs.keys()], [id]);
  assert.equal(existsSync(join(dir, `${id}.log`)), false);
});

test("runs: a log whose summary can't be written stays here, unsent: its run is never lost", async (t) => {
  const dir = tempDir(t);
  const id = "deckhand-org-repo-12-1000";
  const meta = { type: "listener", key: "org/repo#12", repo: "org/repo", startedAt: 1000 };
  writeFileSync(join(dir, `${id}.log`), line(meta));
  // Where its summary goes, a folder that isn't empty: no write replaces it.
  mkdirSync(join(dir, `${id}.json`));
  writeFileSync(join(dir, `${id}.json`, "x"), "");
  const runner = fakeRunner();
  const logs = [];
  await moveLogs(dir, runner, { log: (l) => logs.push(l) }).done;
  assert.equal(runner.logs.size, 0);
  assert.equal(existsSync(join(dir, `${id}.log`)), true);
  assert.match(logs.join("\n"), new RegExp(`${id}\\.log not sent to the runner`));
});

test("runs: a log holding a token goes redacted, whole, its bytes otherwise as they were", async (t) => {
  const dir = tempDir(t);
  const [dirty, clean] = ["deckhand-org-repo-13-1000", "deckhand-org-repo-14-1000"];
  const meta = (id) => line({ type: "listener", key: id, repo: "org/repo", startedAt: 1000 });
  const token = `ghs_${"a1".repeat(18)}`;
  const runToken = `eyJ2ZXIiOjEsInN1YiI6InJ1biJ9.${"x".repeat(43)}`;
  // A byte that isn't UTF-8 stays that byte; a line with no newline at the end is read too.
  const tail = Buffer.from([0xff, 0x0a]);
  writeFileSync(
    join(dir, `${dirty}.log`),
    Buffer.concat([
      Buffer.from(`${meta(dirty)}\n{"text":"token ${token} here"}\n`),
      tail,
      Buffer.from(`{"text":"${runToken}"}`),
    ]),
  );
  writeFileSync(join(dir, `${clean}.log`), `${meta(clean)}\n`);
  const calls = [];
  const runner = {
    // A part a try before sent of the file as it was.
    logs: new Map([[dirty, Buffer.from(meta(dirty))]]),
    remove: async (id) => {
      calls.push(`remove ${id}`);
      runner.logs.delete(id);
    },
    upload: async (id, path) => {
      calls.push(`upload ${id}`);
      runner.logs.set(id, readFileSync(path));
    },
  };
  await moveLogs(dir, runner, { log: () => {} }).done;
  // Removed before it is sent, not after: the runner's log would be gone. The two logs' order is
  // the folder's.
  assert.deepEqual(
    calls.filter((c) => c.endsWith(dirty)),
    [`remove ${dirty}`, `upload ${dirty}`],
  );
  assert.deepEqual(
    calls.filter((c) => c.endsWith(clean)),
    [`upload ${clean}`],
  );
  assert.deepEqual(
    runner.logs.get(dirty),
    Buffer.concat([
      Buffer.from(`${meta(dirty)}\n{"text":"token [redacted] here"}\n`),
      tail,
      Buffer.from(`{"text":"[redacted]"}`),
    ]),
  );
  assert.equal(runner.logs.get(clean).toString(), `${meta(clean)}\n`);
  for (const id of [dirty, clean]) assert.equal(existsSync(join(dir, `${id}.log`)), false);
  assert.deepEqual(redactedCopies(dir), []);
});

test("runs: a redacted copy a stopped start left goes once an hour old, a newer one stays", async (t) => {
  const dir = tempDir(t);
  const [old, recent] = ["a.log.1.redacted", "b.log.2.redacted"];
  for (const f of [old, recent]) writeFileSync(join(dir, f), "x");
  const hours = (n) => new Date(Date.now() - n * 60 * 60_000);
  utimesSync(join(dir, old), hours(2), hours(2));
  await moveLogs(dir, fakeRunner(), { log: () => {} }).done;
  assert.deepEqual(redactedCopies(dir), [recent]);
});

test("runs: a log longer than a read, a token across two of them and in a long line, goes redacted", async (t) => {
  const dir = tempDir(t);
  const id = "deckhand-org-repo-16-1000";
  const first = `${line({ type: "listener", key: id, startedAt: 1000 })}\n`;
  const token = `ghs_${"c".repeat(36)}`;
  const read = 4 * 1024 * 1024; // runlog.mjs REDACT_READ
  // A line of words longer than a read, the token across the end of the first read; then one
  // more past a read's length, with no newline at the end and a token near its own end.
  const words = (n) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);
  const before = words(read - first.length - 10);
  const long = `${before}${token} ${words(read)}\n`;
  const last = `${words(read + 100)}${token}`;
  writeFileSync(join(dir, `${id}.log`), first + long + last);
  const runner = fakeRunner();
  runner.remove = async () => {};
  await moveLogs(dir, runner, { log: () => {} }).done;
  assert.equal(
    runner.logs.get(id),
    `${first}${before}[redacted] ${words(read)}\n${words(read + 100)}[redacted]`,
  );
});

test("runs: a log to redact whose runner copy can't be removed stays as it was, for the next start", async (t) => {
  const dir = tempDir(t);
  const id = "deckhand-org-repo-15-1000";
  const text = `${line({ type: "listener", key: id, startedAt: 1000 })}\nghp_${"b".repeat(36)}\n`;
  writeFileSync(join(dir, `${id}.log`), text);
  const runner = {
    remove: async () => {
      throw new Error("the runner service didn't answer");
    },
    upload: async () => assert.fail("not sent before its runner copy is removed"),
  };
  const logs = [];
  await moveLogs(dir, runner, { log: (l) => logs.push(l) }).done;
  assert.equal(readFileSync(join(dir, `${id}.log`), "utf8"), text);
  assert.deepEqual(redactedCopies(dir), []);
  assert.match(logs.join("\n"), /not sent to the runner \(the runner service didn't answer\)/);
});

test("runs: live runs' logs move first, on their own; a failed try is tried again, never left halfway", async (t) => {
  const dir = tempDir(t);
  const ids = ["deckhand-org-repo-1-1000", "deckhand-org-repo-2-1000", "deckhand-org-repo-3-1000"];
  for (const id of ids) {
    writeFileSync(join(dir, `${id}.log`), line({ type: "listener", key: id, startedAt: 1000 }));
  }
  // The last one is live.
  const live = ids[2];
  writeFileSync(join(dir, `${live}.live.json`), "{}");
  const order = [];
  let failures = 2;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const runner = {
    upload: async (id) => {
      order.push(id);
      if (id === live && failures-- > 0) throw new Error("the runner service didn't answer");
      // The history's first log is slow: the live one doesn't wait for it.
      if (id === ids[0]) await held;
    },
  };
  const waits = [];
  const moved = moveLogs(dir, runner, {
    log: () => {},
    sleep: async (ms) => waits.push(ms),
    retryMs: 5000,
  });
  assert.equal(await moved.moving.get(live), true);
  assert.deepEqual(waits, [5000, 10000]);
  assert.equal(existsSync(join(dir, `${live}.log`)), false);
  assert.ok(!order.includes(ids[1]), "the live log waited for no other");
  release();
  assert.equal(await moved.done, 3);
});

test("runs: a live run's log the runner holds more of is given up, not tried forever", async (t) => {
  const dir = tempDir(t);
  const id = "deckhand-org-repo-9-1000";
  writeFileSync(join(dir, `${id}.log`), line({ type: "listener", key: id, startedAt: 1000 }));
  writeFileSync(join(dir, `${id}.live.json`), "{}");
  let tries = 0;
  const runner = {
    upload: async () => {
      tries++;
      throw Object.assign(new Error("longer"), { code: "LOG_LONGER" });
    },
  };
  const moved = moveLogs(dir, runner, { log: () => {}, sleep: async () => {} });
  assert.equal(await moved.moving.get(id), false);
  assert.equal(tries, 1);
  assert.equal(await moved.done, 0);
});

test("runs: the run states and queues kept beside the summaries aren't moved, listed, nor logged", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "deckhand-org-repo-1-1000.live.json"), "{}");
  writeFileSync(join(dir, "deckhand-org-repo-1-1000.queued.json"), "[]");
  const logs = [];
  assert.deepEqual(await listed(dir, { log: (l) => logs.push(l) }), []);
  assert.deepEqual(logs, []);
  assert.equal(readdirSync(dir).length, 2);
});

// #618: the summaries a release before kept in logs/ go to the store at the first start.
test("moveSummaries: the summaries in logs/ go to the store and are removed, a key there wins", async (t) => {
  const dir = tempDir(t);
  const store = openStore("memory:");
  const run = (n, fields) => ({
    id: `deckhand-org-repo-${n}-1000`,
    key: `org/repo#${n}`,
    ...fields,
  });
  writeFileSync(
    join(dir, `${run(1).id}.json`),
    JSON.stringify(run(1, { startedAt: 1, status: "ok" })),
  );
  writeFileSync(
    join(dir, `${run(2).id}.json`),
    JSON.stringify(run(2, { startedAt: 2, status: "ok" })),
  );
  // A start that stopped before removing the file: the store's is the newer.
  await store.set(summaryKey(run(2).id), run(2, { startedAt: 2, status: "error", exitCode: 137 }));
  const logs = [];
  assert.equal(await moveSummaries(dir, store, { log: (l) => logs.push(l) }), 2);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(logs, [`Run summaries: 2 moved from ${dir} to the store`]);
  const runs = await loadRuns(store);
  assert.deepEqual(
    runs.map((r) => [r.key, r.status]),
    [
      ["org/repo#2", "error"],
      ["org/repo#1", "ok"],
    ],
  );
  // Nothing left: the next start moves none, and says nothing.
  assert.equal(await moveSummaries(dir, store, { log: (l) => logs.push(l) }), 0);
  assert.equal(logs.length, 1);
});

test("moveSummaries: one the store refuses stays in logs/, for the next start", async (t) => {
  const dir = tempDir(t);
  const id = "deckhand-org-repo-3-1000";
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, key: "org/repo#3", startedAt: 1 }));
  const store = {
    ...openStore("memory:"),
    setIfAbsent: async () => {
      throw new Error("the store is away");
    },
  };
  const logs = [];
  assert.equal(await moveSummaries(dir, store, { log: (l) => logs.push(l) }), 0);
  assert.deepEqual(readdirSync(dir), [`${id}.json`]);
  assert.match(
    logs.join("\n"),
    /deckhand-org-repo-3-1000\.json not moved to the store \(the store is away\)/,
  );
});

test("saveSummary: one the store doesn't take is kept in logs/, moved over the store's at the next start", async (t) => {
  const dir = tempDir(t);
  const store = openStore("memory:");
  const id = "deckhand-org-repo-7-1000";
  const record = { id, key: "org/repo#7", startedAt: 1, finishedAt: 2, status: "ok" };
  assert.equal(await saveSummary(store, record, { logDir: dir }), true);
  // Its exit code, said later, while the store is away: kept here.
  let away = true;
  const flaky = {
    ...store,
    set: async (...args) => {
      if (away) throw new Error("the store is away");
      return store.set(...args);
    },
  };
  const logs = [];
  const log = (l) => logs.push(l);
  record.exitCode = 137;
  assert.equal(await saveSummary(flaky, record, { log, logDir: dir }), false);
  assert.deepEqual(readdirSync(dir), [`${id}.summary.json`]);
  assert.match(logs.join("\n"), /kept in .*, for the next start/);
  // The next start: it goes over the store's older one, and the file goes.
  away = false;
  assert.equal(await moveSummaries(dir, flaky, { log }), 1);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal((await loadRuns(store))[0].exitCode, 137);
  // A save the store took removes what one before kept here.
  away = true;
  await saveSummary(flaky, record, { log, logDir: dir });
  away = false;
  await saveSummary(flaky, { ...record, status: "error" }, { log, logDir: dir });
  assert.deepEqual(readdirSync(dir), []);
  assert.equal((await loadRuns(store))[0].status, "error");
});

test("loadRuns: a key that isn't a run's summary is left out, logged", async () => {
  const store = openStore("memory:");
  await saveSummary(store, { id: "deckhand-org-repo-4-1000", key: "org/repo#4", startedAt: 1 });
  await store.set(summaryKey("deckhand-org-repo-5-1000"), { id: "another" });
  const logs = [];
  const runs = await loadRuns(store, { log: (l) => logs.push(l) });
  assert.deepEqual(
    runs.map((r) => r.key),
    ["org/repo#4"],
  );
  assert.deepEqual(logs, [
    "Listing the run of summaries/deckhand-org-repo-5-1000: not a run's summary",
  ]);
});

test("saveSummary: a GitHub token or a secret in its text is redacted, not the summary refused", async () => {
  const store = openStore("memory:");
  const token = `ghp_${"a".repeat(36)}`;
  const logs = [];
  const id = "deckhand-org-repo-6-1000";
  const log = (l) => logs.push(l);
  const summary = `Used ${token} and the operator's s3cr3t-of-the-operator`;
  await saveSummary(
    store,
    { id, key: "org/repo#6", summary },
    { log, secrets: ["s3cr3t-of-the-operator"] },
  );
  assert.deepEqual(logs, []);
  const saved = await store.get(summaryKey(id));
  assert.doesNotMatch(saved.summary, /ghp_|s3cr3t/);
  // A store that fails: logged, nothing thrown.
  const away = { set: async () => Promise.reject(new Error("away")) };
  await saveSummary(away, { id, key: "org/repo#6" }, { log });
  assert.deepEqual(logs, [`org/repo#6: saving the summary of ${id}: away`]);
});

test("runs: a live run gets no summary from its log, the one written when it ends wins", async (t) => {
  const dir = tempDir(t);
  const id = "deckhand-org-repo-7-1000";
  const logPath = join(dir, `${id}.log`);
  writeFileSync(logPath, line({ type: "listener", key: "org/repo#7", startedAt: 1000 }));
  writeFileSync(join(dir, `${id}.live.json`), "{}");
  // restoreRuns() lists it.
  const store = openStore("memory:");
  assert.deepEqual(await started(dir, { store }), []);
  assert.equal(existsSync(join(dir, `${id}.json`)), false);
  // Its state in the store (#617), no file: the same.
  rmSync(join(dir, `${id}.live.json`));
  writeFileSync(logPath, line({ type: "listener", key: "org/repo#7", startedAt: 1000 }));
  assert.deepEqual(await started(dir, { live: new Set([id]) }), []);
  assert.equal(existsSync(join(dir, `${id}.json`)), false);
  const record = { id, key: "org/repo#7", startedAt: 1000, finishedAt: 5000 };
  await saveSummary(store, { ...record, status: "ok", summary: "Done.", shots: "a".repeat(24) });
  const [run] = await loadRuns(store);
  assert.deepEqual([run.status, run.summary, run.finishedAt], ["ok", "Done.", 5000]);
  assert.equal("shots" in publicRun(run), false);
});

// Thousands of runs whose logs are never opened: their summaries alone.
test("runs: a few thousand runs with summaries load fast", async () => {
  const store = openStore("memory:");
  const count = 3000;
  for (let i = 0; i < count; i++) {
    const id = `deckhand-org-repo-${i % 50}-${i}`;
    await saveSummary(store, { id, key: `org/repo#${i % 50}`, startedAt: i, status: "ok" });
  }
  const started = performance.now();
  const runs = await loadRuns(store);
  const ms = performance.now() - started;
  assert.equal(runs.length, count);
  assert.equal(runs[0].startedAt, count - 1);
  assert.ok(runs.every((r) => r.summary === undefined));
  assert.ok(ms < 3000, `${count} runs took ${Math.round(ms)} ms`);
});

// #241: a log too big to read whole (a string can't hold over about 512 MB) doesn't stop the
// start. Here with a small cap.
test("runs: an oversized log is read by its first line and its end, and logged", async (t) => {
  const dir = tempDir(t);
  const meta = { type: "listener", key: "org/repo#8", repo: "org/repo", startedAt: 1000 };
  writeFileSync(
    join(dir, "deckhand-org-repo-8-1000.log"),
    [line(meta), "x".repeat(5000), line({ type: "result", result: "Done." })].join("\n"),
  );
  const logs = [];
  const [run] = await started(dir, { max: 1000, log: (l) => logs.push(l) });
  assert.deepEqual(
    [run.key, run.repo, run.status, run.summary],
    ["org/repo#8", "org/repo", "ok", "Done."],
  );
  assert.match(
    logs.join("\n"),
    /deckhand-org-repo-8-1000\.log: 0 MB, only its first line and its end read/,
  );
});

test("openLog: its size, from what the file had when opened", (t) => {
  const path = join(tempDir(t), "run.log");
  const file = openLog(path);
  assert.equal(file.size, 0);
  file.write("héllo\n");
  assert.equal(file.size, 7);
  assert.equal(openLog(path).size, 7);
});

test("runs: a log that can't be read is left out, logged, and the others listed", async (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "deckhand-org-repo-9-1000.log"));
  writeFileSync(
    join(dir, "deckhand-org-repo-10-1000.log"),
    line({ type: "listener", key: "org/repo#10", startedAt: 1000 }),
  );
  const logs = [];
  const runs = await started(dir, { log: (l) => logs.push(l) });
  assert.deepEqual(
    runs.map((r) => r.key),
    ["org/repo#10"],
  );
  assert.match(logs.join("\n"), /deckhand-org-repo-9-1000\.log not sent to the runner/);
  // A summary that isn't one: left out too, logged.
  writeFileSync(join(dir, "deckhand-org-repo-12-1000.json"), "[]");
  assert.equal((await listed(dir, { log: (l) => logs.push(l) })).length, 1);
  assert.match(logs.at(-1), /^Listing the run of deckhand-org-repo-12-1000\.json: /);
  assert.equal(existsSync(join(dir, "deckhand-org-repo-12-1000.json")), true);
});

test("format: a line that isn't JSON is clipped, an agent's event cut at MAX_LINE too", () => {
  assert.deepEqual(format("npm warn deprecated"), [{ kind: "raw", text: "npm warn deprecated" }]);
  const cut = `{"type":"user","message":"${"a".repeat(1024 * 1024)}`;
  const [entry] = format(cut);
  assert.equal(entry.kind, "raw");
  assert.equal(entry.text, `${cut.slice(0, 4000)}… (1024 KB in all)`);
});

// #414: a tool's result cut at MAX_LINE is still its call's output, so its call's time ends.
test("format: a tool result cut at MAX_LINE is its call's output, by id", () => {
  const cut = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t9","type":"tool_result","content":[{"type":"image","source":{"data":"${"A".repeat(5000)} … (line cut)`;
  const [entry, ...more] = format(cut);
  assert.deepEqual(more, []);
  assert.equal(entry.kind, "output");
  assert.equal(entry.id, "t9");
  assert.equal(entry.error, false);
  assert.equal(entry.text, `${cut.slice(0, 4000)}\n…`);
  // An id deep in the output isn't its call's.
  const late = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"${"b".repeat(400)}\"tool_use_id\":\"t1\"`;
  assert.equal(format(late)[0].kind, "raw");
});

test("buildOutput: a character split between two chunks stays whole", () => {
  const written = [];
  const out = buildOutput({ write: (text) => written.push(text) }, () => 1);
  const bytes = Buffer.from("#1 0.1 ✓ ok\n#1 ✓");
  out.write(bytes.subarray(0, 9));
  out.write(bytes.subarray(9, bytes.length - 1));
  out.write(bytes.subarray(bytes.length - 1));
  out.flush();
  assert.deepEqual(written.slice(1), ["#1 0.1 ✓ ok\n", "#1 ✓\n"]);
});

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const phase = (name, at) => line({ type: "listener", event: "phase", phase: name, at });

test("enterPhase: a phase line in the log at each change only", () => {
  const written = [];
  const marks = [];
  const write = (text, options) => (written.push(JSON.parse(text)), marks.push(options));
  const live = { logPhase: null, logFile: { write } };
  assert.equal(enterPhase(live, "setup"), true);
  assert.equal(enterPhase(live, "setup"), false);
  assert.equal(enterPhase(live, "image"), true);
  assert.throws(() => enterPhase(live, "building"), /no such phase: building/);
  assert.deepEqual(
    written.map(({ type, event, phase }) => [type, event, phase]),
    [
      ["listener", "phase", "setup"],
      ["listener", "phase", "image"],
    ],
  );
  assert.equal(typeof written[0].at, "number");
  // Each a step of the run: the runner starts its log's next segment with it (runner/logs.mjs).
  assert.deepEqual(marks, [{ step: true }, { step: true }]);
  assert.equal(live.logPhase, "image");
});

test("enterPhase keeps the run's record in the same phase, for the dashboard's state", () => {
  const live = { logPhase: null, record: { phase: "setup" }, logFile: { write: () => {} } };
  enterPhase(live, "image");
  assert.equal(live.record.phase, "image");
  enterPhase(live, "setup");
  assert.equal(live.record.phase, "setup");
  enterPhase(live, "work");
  assert.equal(live.record.phase, "work");
});

test("phaseOf: the agent's first event works, pushes and pull request commands push", () => {
  const tool = (detail) => ({ type: "tool", name: "Bash", detail });
  assert.equal(phaseOf("setup", []), null);
  assert.equal(phaseOf("setup", [{ type: "started" }]), "work");
  // A run picked up from a listener that didn't keep phases.
  assert.equal(phaseOf(undefined, [{ type: "text", text: "Hi" }]), "work");
  assert.equal(phaseOf("work", [{ type: "text", text: "Hi" }]), null);
  assert.equal(phaseOf("work", [tool("node --test")]), null);
  assert.equal(
    phaseOf("work", [tool("git add -A && git commit -m x && git push -u origin b")]),
    "push",
  );
  assert.equal(phaseOf("work", [tool("gh pr edit 3 --body-file b.md")]), "push");
  assert.equal(phaseOf("setup", [tool("gh pr ready")]), "push");
  // Its output, its messages and its pull request commands stay in the push.
  assert.equal(phaseOf("push", [{ type: "toolOutput", text: "ok" }]), null);
  assert.equal(phaseOf("push", [{ type: "text", text: "Pushed." }]), null);
  assert.equal(phaseOf("push", [tool("gh pr ready")]), null);
  assert.equal(phaseOf("push", [tool("git status")]), "work");
  // The last tool call of a line decides.
  assert.equal(phaseOf("work", [tool("git push"), tool("ls")]), null);
  // After the final answer, nothing moves it.
  assert.equal(phaseOf("wrap-up", [tool("git push")]), null);
  assert.equal(phaseOf("work", [tool("cd /workspace && git -C sub push origin b")]), "push");
  assert.equal(phaseOf("work", [tool("npm test\ngh pr create --draft")]), "push");
  assert.equal(phaseOf("work", [{ type: "tool", name: "command", detail: "git push" }]), "push");
  // Not a push: words that only look like one, a command that only quotes it, other tools.
  assert.equal(phaseOf("work", [tool("grep -n 'git pushes' notes.md")]), null);
  assert.equal(phaseOf("work", [tool('grep -rn "git push" listener/')]), null);
  assert.equal(phaseOf("work", [tool("echo gh pr ready")]), null);
  assert.equal(phaseOf("work", [{ type: "tool", name: "Grep", detail: "git push" }]), null);
  const agent = { type: "tool", name: "Agent", detail: "Run git push when done" };
  assert.equal(phaseOf("work", [agent]), null);
  assert.equal(phaseOf("push", [agent]), "work");
});

test("reader: a log's phases in order, with when they started", () => {
  const read = reader();
  const lines = [
    line({ type: "listener", kind: "issue", message: "Go" }),
    phase("setup", 1000),
    "Cloning into '/workspace'...",
    phase("work", 2000),
    line({ type: "result", result: "Done.", duration_ms: 60000 }),
    phase("wrap-up", 3000),
  ];
  const entries = lines.flatMap(read);
  assert.deepEqual(
    entries.filter((e) => e.kind === "phase"),
    [
      { kind: "phase", phase: "setup", at: 1000 },
      { kind: "phase", phase: "work", at: 2000 },
      { kind: "phase", phase: "wrap-up", at: 3000 },
    ],
  );
  assert.deepEqual(entries[2], { kind: "raw", text: "Cloning into '/workspace'..." });
});

test("reader: a log from before phases reads as format() did", () => {
  const lines = fixture("claude-run.log").split("\n");
  const before = JSON.parse(fixture("claude-run.entries.json"));
  assert.deepEqual(lines.flatMap(reader()), before);
  assert.ok(!before.some((e) => e.kind === "phase"));
});

// A recorded `docker build --progress plain` (images.mjs): steps from the builder's own,
// cached ones, one that ran with its output, one that failed, then BuildKit's error summary.
test("reader: an image build's output comes as its steps", () => {
  const read = reader();
  const lines = [
    phase("image", 1000),
    ...fixture("docker-build-failed.txt").split("\n"),
    phase("setup", 2000),
  ];
  const entries = lines.flatMap(read);
  const steps = new Map();
  for (const e of entries.filter((e) => e.kind === "step")) steps.set(e.step, e);
  assert.deepEqual([...steps.keys()], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(steps.get(1), {
    kind: "step",
    step: 1,
    stage: "internal",
    name: "load build definition from Dockerfile",
    status: "done",
    seconds: 0,
    error: null,
  });
  assert.deepEqual(
    [5, 6].map((n) => [steps.get(n).stage, steps.get(n).name, steps.get(n).status]),
    [
      ["base 2/2", "RUN echo cached step", "cached"],
      ["stage-1 1/4", "WORKDIR /app", "cached"],
    ],
  );
  assert.deepEqual(steps.get(7), {
    kind: "step",
    step: 7,
    stage: "stage-1 2/4",
    name: 'RUN for i in 1 2 3; do echo "line $i"; sleep 1; done',
    status: "done",
    seconds: 3.4,
    error: null,
  });
  assert.deepEqual(steps.get(8), {
    kind: "step",
    step: 8,
    stage: "stage-1 3/4",
    name: 'RUN echo "about to fail" && exit 3',
    status: "error",
    seconds: null,
    error:
      'process "/bin/sh -c echo \\"about to fail\\" && exit 3" did not complete successfully: exit code: 3',
  });
  // Each step starts running, then says how it ended.
  assert.deepEqual(
    entries.filter((e) => e.step === 7 && e.kind === "step").map((e) => e.status),
    ["running", "done"],
  );
  // Their output, without BuildKit's prefix, under their number.
  const output = (n) => entries.filter((e) => e.kind === "raw" && e.step === n).map((e) => e.text);
  assert.deepEqual(output(7), ["line 1", "line 2", "line 3"]);
  assert.deepEqual(output(8), ["about to fail"]);
  assert.deepEqual(output(1), ["transferring dockerfile: 221B done"]);
  // Which builder, the error's summary and the empty lines: not a step's.
  assert.deepEqual(entries[1], {
    kind: "raw",
    text: '#0 building with "default" instance using docker driver',
  });
  const rest = entries.filter((e) => e.kind === "raw" && e.step === undefined);
  assert.ok(rest.some((e) => e.text === "Dockerfile:7"));
  assert.match(rest.at(-1).text, /^ERROR: failed to build: failed to solve/);
  assert.deepEqual(entries.at(-1), { kind: "phase", phase: "setup", at: 2000 });
});

test("reader: only the image phase's lines are build steps; a step named again adds nothing", () => {
  const read = reader();
  assert.deepEqual(read("#3 [internal] load .dockerignore"), [
    { kind: "raw", text: "#3 [internal] load .dockerignore" },
  ]);
  read(phase("image", 1));
  assert.equal(read("#3 [internal] load .dockerignore")[0].kind, "step");
  assert.deepEqual(read("#3 [internal] load .dockerignore"), []);
  assert.deepEqual(read("#3 CANCELED")[0].status, "cancelled");
  read(phase("setup", 2));
  assert.deepEqual(read("#4 DONE 1.0s"), [{ kind: "raw", text: "#4 DONE 1.0s" }]);
  // A second build (a run that falls back, say) numbers its steps afresh.
  read(phase("image", 3));
  assert.equal(read("#3 [b 1/1] RUN true")[0].name, "RUN true");
  // A step's name is its whole command: clipped like any raw line.
  const long = read(`#5 [b 1/1] RUN ${"x".repeat(5000)}`)[0].name;
  assert.match(long, /^RUN x+… \(5 KB in all\)$/);
  assert.ok(long.length < 4100);
});

test("stream: a log's entries with their phases and build steps", { timeout: 5000 }, async (t) => {
  const logPath = join(tempDir(t, "deckhand-stream-"), "run.log");
  writeFileSync(
    logPath,
    [
      phase("image", 1),
      "#1 [a 1/1] RUN make",
      "#1 0.1 ok",
      "#1 DONE 0.5s",
      phase("work", 2),
      "",
    ].join("\n"),
  );
  const req = new EventEmitter();
  let ended;
  const done = new Promise((resolve) => (ended = resolve));
  const written = [];
  const res = { writeHead() {}, write: (s) => written.push(s), end: ended };
  stream(req, res, { status: "ok", agent: "claude" }, { read: fromFile(logPath), every: 20 });
  await done;
  const entries = written
    .filter((w) => w.startsWith("event: entries"))
    .flatMap((w) => JSON.parse(w.split("data: ")[1]));
  assert.deepEqual(
    entries.map((e) => [e.kind, e.phase ?? e.status ?? e.text]),
    [
      ["phase", "image"],
      ["step", "running"],
      ["raw", "ok"],
      ["step", "done"],
      ["phase", "work"],
    ],
  );
});

// #414: an `at` line times the entries of the next line, its tool calls and outputs (with
// their ids) and an image build step as it starts; format() alone shows nothing of it.
test("reader: the time of an `at` line goes on the next line's calls and outputs", () => {
  const at = (ms) => line({ type: "listener", event: "at", at: ms });
  const call = line({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.md" } },
      ],
    },
  });
  const output = line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "a" }] },
  });
  const text = line({ type: "assistant", message: { content: [{ type: "text", text: "Hm." }] } });
  assert.deepEqual(format(at(1000)), []);
  const entries = [at(1000), call, text, at(5000), output, output].flatMap(reader());
  assert.deepEqual(entries, [
    { kind: "tool", name: "Bash", text: "npm test", id: "t1", at: 1000 },
    { kind: "tool", name: "Read", text: "a.md", id: "t2", at: 1000 },
    { kind: "text", text: "Hm." },
    { kind: "output", error: false, text: "a", id: "t2", at: 5000 },
    // A line with no `at` before it has none.
    { kind: "output", error: false, text: "a", id: "t2" },
  ]);
  const build = [phase("image", 0), at(7000), "#5 [a 1/2] RUN npm ci", "#5 DONE 3.0s"];
  const steps = build.flatMap(reader()).filter((e) => e.kind === "step");
  assert.deepEqual(
    steps.map((s) => [s.status, s.at]),
    [
      ["running", 7000],
      ["done", 7000],
    ],
  );
});

test("buildOutput: whole lines, each step's first after when it came, the rest at the end", () => {
  const written = [];
  let now = 100;
  const out = buildOutput({ write: (text) => written.push(text) }, () => now++);
  out.write("#1 [internal] load\n#1 DO");
  out.write("NE 0.1s\n\n#2 [a 1/2] RUN npm ci\n#2 0.5 added\n#1 [internal] load\nERROR: x");
  out.flush();
  assert.deepEqual(written, [
    line({ type: "listener", event: "at", at: 100 }) + "\n",
    "#1 [internal] load\n",
    "#1 DONE 0.1s\n",
    "\n",
    line({ type: "listener", event: "at", at: 101 }) + "\n",
    "#2 [a 1/2] RUN npm ci\n",
    "#2 0.5 added\n",
    "#1 [internal] load\n",
    "ERROR: x\n",
  ]);
});

// A log a listener kept itself is summarized as moveLogs() sends it to the runner (#503): with the
// mode its run's capabilities corrected (a live run's summary has it from its record).
test("moveLogs: a run's summary has its record mode as its capabilities corrected it", async (t) => {
  const logs = { upload: async () => {} };
  const dir = tempDir(t);
  writeFileSync(
    join(dir, "deckhand-org-repo-5-1000.log"),
    [
      line({ type: "listener", key: "org/repo#5", startedAt: 1000, mode: "continue" }),
      line({ type: "listener", event: "note", at: 1001, message: "it starts afresh" }),
      line({
        type: "listener",
        event: "session",
        at: 1001,
        mode: "start",
        capabilities: ["pull", "internet"],
      }),
      line({ type: "listener", event: "sandbox", at: 1002 }),
      // The sandbox's own output, which can't pass for one.
      line({ type: "listener", event: "session", at: 1003, mode: "continue", capabilities: [] }),
    ].join("\n"),
  );
  const store = openStore("memory:");
  await moveLogs(dir, logs).done;
  const [run] = await listed(dir, { store });
  assert.equal(run.mode, "start");
  // What its start decided it gets, kept: an analysis leaves it out (analysis.mjs).
  assert.deepEqual(run.capabilities, ["pull", "internet"]);
  // Not a line of its own in the log: the note says it.
  assert.deepEqual(format(line({ type: "listener", event: "session", mode: "start" })), []);
  // A log too big to read whole: the correction near its start still counts.
  const big = join(dir, "deckhand-org-repo-6-1000.log");
  writeFileSync(
    big,
    [
      line({ type: "listener", key: "org/repo#6", startedAt: 1000, mode: "start" }),
      line({ type: "listener", event: "session", at: 1001, mode: "continue" }),
      line({ type: "listener", event: "sandbox", at: 1002 }),
      "x".repeat(2048),
      "y".repeat(2048),
      "",
    ].join("\n"),
  );
  await moveLogs(dir, logs, { max: 1024, log: () => {} }).done;
  const loaded = (await listed(dir, { store })).find((r) => r.key === "org/repo#6");
  assert.equal(loaded.mode, "continue");
});

test("sessionEventOf: the capabilities its start decided, when the first event says them as names", () => {
  const header = line({ type: "listener", mode: "start" });
  const marker = line({ type: "listener", event: "sandbox" });
  const session = (fields) => line({ type: "listener", event: "session", ...fields });
  assert.deepEqual(
    sessionEventOf([
      header,
      session({ mode: "start", capabilities: ["pull", "internet"] }),
      marker,
    ]),
    { mode: "start", capabilities: ["pull", "internet"] },
  );
  assert.deepEqual(
    sessionEventOf([header, session({ mode: "start", capabilities: [1] }), marker]),
    { mode: "start", capabilities: null },
  );
  // A later line, a build's say, doesn't change them.
  const forged = session({ mode: "start", capabilities: [] });
  assert.deepEqual(
    sessionEventOf([
      header,
      session({ mode: "start", capabilities: ["internet"] }),
      forged,
      marker,
    ]),
    { mode: "start", capabilities: ["internet"] },
  );
});

test("sessionModeOf: only before the sandbox's marker, and only a record's mode", () => {
  const header = line({ type: "listener", mode: "start" });
  const session = (mode) => line({ type: "listener", event: "session", mode });
  const marker = line({ type: "listener", event: "sandbox" });
  assert.equal(sessionModeOf([header, session("continue"), marker]), "continue");
  // None before the marker, or no marker at all (its sandbox never started): nothing.
  assert.equal(sessionModeOf([header, marker, session("continue")]), null);
  assert.equal(sessionModeOf([header, session("continue")]), null);
  // A mode no record has: not one.
  assert.equal(sessionModeOf([header, session("pwned"), marker]), null);
  assert.equal(sessionModeOf([header, session("restore"), session("x"), marker]), "restore");
  // The first only: what an image's build prints in the log before the marker comes after it.
  const forged = session("continue");
  assert.equal(sessionModeOf([header, session("start"), "#5 RUN echo", forged, marker]), "start");
});
