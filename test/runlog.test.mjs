import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  clip,
  enterPhase,
  format,
  lastResult,
  loadRuns,
  minutes,
  moveSummaries,
  openLog,
  outcome,
  phaseOf,
  buildOutput,
  reader,
  saveSummary,
  summaryKey,
  stream,
  summaryOf,
  writeEvent,
} from "../listener/runlog.mjs";
import { agentFor } from "../listener/agents/index.mjs";
import { openStore } from "../lib/store.mjs";
import { tempDir } from "./helpers.mjs";

const line = (event) => JSON.stringify(event);

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
    "Il me faut votre avis.\r\n<!-- needs-input -->\r\n1. Lequel ?",
  ]) {
    assert.equal(outcome({ ok: true, text }), "needs-input", text);
  }
  // Not quoted in a sentence, in a code block, or after the first question.
  for (const text of [
    "Done. A run asks with `<!-- needs-input -->` first.",
    "Done.\n```\n<!-- needs-input -->\n```",
    "Done.\n1. Fixed it.\n<!-- needs-input -->",
    "Done.\n\n<!-- needs-input --> is what a run starts with to ask.",
    "Done.\r\n1. Fixed\r\n<!-- needs-input -->",
    // After a numbered line, even a summary: a reply explaining the marker lists too.
    "## Besoin de votre avis\n\nJ'ai fait :\n1. tests\n\n<!-- needs-input -->\n\n1. **A** : ?",
    "Done. The format:\n\n    <!-- needs-input -->\n    ## Needs your input",
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
  // The marker on a line of its own is gone too, after one quoted in a heading.
  assert.equal(
    summaryOf({ text: "## Using `<!-- needs-input -->`\n<!-- needs-input -->\n## Avis" }),
    "Using `<!-- needs-input -->`",
  );
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

test("log: a cancelled run's log says who", () => {
  const cancelled = {
    type: "listener",
    event: "cancelled",
    by: "alice",
    at: Date.UTC(2026, 0, 1, 9),
  };
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

test("saveSummary: one the store doesn't take is logged, false; one a release before kept in logs/ goes over the store's", async (t) => {
  const dir = tempDir(t);
  const store = openStore("memory:");
  const id = "deckhand-org-repo-7-1000";
  const record = { id, key: "org/repo#7", startedAt: 1, finishedAt: 2, status: "ok" };
  assert.equal(await saveSummary(store, record), true);
  // Its exit code, said later, while the store is away: nothing kept anywhere else (#619), the
  // caller tries again (runs.mjs summarySaved()).
  const away = {
    ...store,
    set: async () => {
      throw new Error("the store is away");
    },
  };
  const logs = [];
  const log = (l) => logs.push(l);
  record.exitCode = 137;
  assert.equal(await saveSummary(away, record, { log }), false);
  assert.deepEqual(readdirSync(dir), []);
  assert.match(
    logs.join("\n"),
    /saving the summary of deckhand-org-repo-7-1000: the store is away/,
  );
  // One a release before #619 kept in logs/ then: the next start moves it over the store's
  // older one, and the file goes.
  writeFileSync(join(dir, `${id}.summary.json`), JSON.stringify(record));
  assert.equal(await moveSummaries(dir, store, { log }), 1);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal((await loadRuns(store))[0].exitCode, 137);
  // No logs/ at all: an orchestrator with no volume.
  assert.equal(await moveSummaries(join(dir, "logs"), store, { log }), 0);
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

test("openLog: its size, from what the file had when opened", (t) => {
  const path = join(tempDir(t), "run.log");
  const file = openLog(path);
  assert.equal(file.size, 0);
  file.write("héllo\n");
  assert.equal(file.size, 7);
  assert.equal(openLog(path).size, 7);
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
