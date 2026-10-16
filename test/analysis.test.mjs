import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_RUNS,
  buildDigest,
  checkSelection,
  createAnalysis,
  logPart,
  runDigest,
  runKinds,
  selectRuns,
  tokens,
} from "../listener/analysis.mjs";
import { REDACTED } from "../listener/secrets.mjs";

const line = (event) => JSON.stringify(event);
const tool = (name, input, id) =>
  line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const output = (text, error = false) =>
  line({
    type: "user",
    message: { content: [{ type: "tool_result", content: text, is_error: error }] },
  });
const result = (text, ok = true) =>
  line({ type: "result", is_error: !ok, result: text, duration_ms: 90000 });

// A run as ctx.runs lists it, and its log's lines.
const run = (id, extra = {}) => ({
  id,
  key: "org/app#12",
  repo: "org/app",
  title: "Dark mode",
  kind: "issue",
  taskMode: "work",
  mode: "start",
  agent: "claude",
  model: "opus",
  effort: "high",
  status: "ok",
  startedAt: Date.UTC(2026, 9, 1, 12, 0),
  finishedAt: Date.UTC(2026, 9, 1, 12, 12),
  ...extra,
});

const LOG = [
  line({ type: "listener", repo: "org/app", taskMode: "work", model: "opus", effort: "high" }),
  line({ type: "listener", event: "note", at: 1, message: "Image deckhand-app:abc" }),
  "Cloning into 'workspace'...",
  "npm error 403 Forbidden - GET https://registry.example.com/x",
  tool("Bash", { command: "npm test" }),
  output("1 failing", true),
  tool("Bash", { command: "npm test" }),
  output("ok"),
  tool("Bash", { command: "npm test" }),
  output("ok"),
  tool("Read", { file_path: "/workspace/a.js" }),
  output("content"),
  result("Done: the pull request is ready."),
];

test("runDigest: what the run was, what went wrong, its final reply", () => {
  const text = runDigest(run("dh-app-12-1"), LOG);
  assert.match(text, /^## Run dh-app-12-1\n\n- org\/app#12: Dark mode\n/);
  assert.match(text, /kind work \(start\) · claude opus, high effort · ok after 12 min/);
  assert.match(text, /started 2026-10-01 12:00 UTC/);
  assert.match(text, /Listener notes:\n- Image deckhand-app:abc/);
  // Setup output: only the line that looks wrong.
  assert.match(text, /npm error 403 Forbidden/);
  assert.doesNotMatch(text, /Cloning into/);
  assert.match(text, /Tool calls: 4 \(Bash 3, Read 1\)/);
  assert.match(text, /3× `Bash: npm test`/);
  assert.match(text, /Failed tool calls \(1\):\n\n```\nBash: npm test\n→\n1 failing\n```/);
  assert.match(text, /Final reply \(ok, 1\.5 min of agent time\):\n\n> Done: the pull request/);
  // A run that never answered.
  assert.match(runDigest(run("x"), LOG.slice(0, 4)), /No final reply/);
});

test("runDigest: clipped outputs, and a cap per run", () => {
  const long = [tool("Bash", { command: "make" }), output("x\n".repeat(500), true)];
  const text = runDigest(run("x"), long);
  assert.ok(text.length < 4000, "an output is clipped to a few lines");
  const huge = Array.from({ length: 2000 }, (_, i) => [
    tool("Bash", { command: `step ${i}` }),
    output("e".repeat(1000), true),
  ]).flat();
  huge.push(result("r".repeat(10000)));
  assert.ok(runDigest(run("y"), huge).length <= 24_000 + 10);
});

test("selectRuns: one repo's finished runs, by kind and outcome, the newest `count`", () => {
  const runs = [
    run("a", { status: "running" }),
    run("b", { status: "error" }),
    run("c", { repo: "org/other", key: "org/other#1", status: "error" }),
    run("d", { taskMode: "bug", status: "error" }),
    run("e", { status: "needs-input" }),
    run("f", { status: "error" }),
    run("g", { taskMode: null, kind: "brainstorm", status: "error" }),
  ];
  const pick = (sel) => selectRuns(runs, "ORG/app", sel).map((r) => r.id);
  assert.deepEqual(pick({ count: 10, kinds: ["work"], outcomes: ["error"] }), ["b", "f"]);
  assert.deepEqual(pick({ count: 1, kinds: ["work"], outcomes: ["error"] }), ["b"]);
  assert.deepEqual(pick({ count: 10, kinds: ["work", "bug"], outcomes: ["error"] }), [
    "b",
    "d",
    "f",
  ]);
  assert.deepEqual(pick({ count: 10, kinds: ["work"], outcomes: ["needs-input", "ok"] }), ["e"]);
  // Logs from before runs kept their mode: their kind.
  assert.deepEqual(pick({ count: 10, kinds: ["brainstorm"], outcomes: ["error"] }), ["g"]);
  // Never another repo's, never a running one.
  assert.deepEqual(
    selectRuns(runs, "org/other", { count: 10, kinds: ["work"], outcomes: ["error"] }).map(
      (r) => r.id,
    ),
    ["c"],
  );
  assert.deepEqual(runKinds(runs, "org/app"), ["brainstorm", "bug", "work"]);
});

test("checkSelection: a count up to the maximum, kinds and outcomes", () => {
  const fail = (message) => {
    throw new Error(message);
  };
  const ok = { count: 12, kinds: ["work", "work", "bug"], outcomes: ["error"] };
  assert.deepEqual(checkSelection(ok, fail), {
    count: 12,
    kinds: ["work", "bug"],
    outcomes: ["error"],
  });
  assert.equal(checkSelection({ kinds: ["work"], outcomes: ["ok"] }, fail).count, 10);
  for (const bad of [
    { ...ok, count: MAX_RUNS + 1 },
    { ...ok, count: 0 },
    { ...ok, count: 2.5 },
    { ...ok, count: "5" },
    { ...ok, kinds: [] },
    { ...ok, kinds: ["a b"] },
    { ...ok, kinds: "work" },
    { ...ok, outcomes: [] },
    { ...ok, outcomes: ["success"] },
    null,
  ]) {
    assert.throws(() => checkSelection(bad, fail), undefined, JSON.stringify(bad));
  }
  // A preview may have none yet.
  assert.deepEqual(checkSelection({ kinds: [], outcomes: [] }, fail, { empty: true }), {
    count: 10,
    kinds: [],
    outcomes: [],
  });
});

test("buildDigest: redacted, newest first, capped: older runs left out and said", () => {
  const secret = "sk-ant-0123456789abcdefghij";
  const parts = { a: `part a ${secret}`, b: "part b ".repeat(100), c: "part c", d: null };
  const runs = ["a", "d", "b", "c"].map((id) => run(id));
  const all = buildDigest(runs, { partOf: (r) => parts[r.id], secrets: [secret] });
  assert.deepEqual(all.included, ["a", "b", "c"]);
  // A run whose log is gone is left out, and said.
  assert.deepEqual(all.left, ["d"]);
  assert.ok(!all.text.includes(secret));
  assert.match(all.text, new RegExp(`part a \\${REDACTED}`));
  assert.equal(all.bytes, Buffer.byteLength(all.text));
  assert.ok(all.text.indexOf("part a") < all.text.indexOf("part b"));
  // Under a cap that takes a and not b: b and the older c are left out.
  const capped = buildDigest(runs, {
    partOf: (r) => parts[r.id],
    secrets: [secret],
    max: 100,
    selection: { kinds: ["work"], outcomes: ["error"] },
  });
  assert.deepEqual(capped.included, ["a"]);
  assert.deepEqual(capped.left, ["d", "b", "c"]);
  assert.match(capped.text, /^# Run digest: 1 run \(kinds: work; outcomes: error\), newest first/);
  assert.match(
    capped.text,
    /3 older runs left out, over the digest's 0 KB cap or without a log: d, b, c\./,
  );
  assert.match(all.text, /Every selected run is here|1 older run left out/);
  assert.equal(tokens(400), 100);
});

test("createAnalysis: previews and digests from the logs, one repo's runs only", () => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-analysis-"));
  const secret = "ghs_0123456789abcdefghijklmnop";
  const runs = [
    run("mine-2", { status: "error", logPath: join(dir, "mine-2.log") }),
    run("theirs-1", {
      repo: "org/other",
      key: "org/other#3",
      status: "error",
      logPath: join(dir, "theirs-1.log"),
    }),
    run("mine-1", { status: "error", logPath: join(dir, "mine-1.log") }),
  ];
  writeFileSync(runs[0].logPath, [...LOG, output(`token ${secret}`, true)].join("\n"));
  writeFileSync(runs[1].logPath, [...LOG, output("OTHER REPO SECRET STUFF", true)].join("\n"));
  writeFileSync(runs[2].logPath, LOG.join("\n"));
  let reads = 0;
  const analysis = createAnalysis({
    runs: () => runs,
    secrets: () => [secret],
    partOf: (r) => (reads++, logPart(r)),
  });
  const selection = { count: 10, kinds: ["work"], outcomes: ["error"] };
  const preview = analysis.preview("org/app", selection);
  assert.deepEqual(preview.runs, ["mine-2", "mine-1"]);
  assert.equal(preview.included, 2);
  assert.equal(preview.left, 0);
  assert.equal(preview.tokens, Math.ceil(preview.bytes / 4));
  assert.deepEqual(preview.kinds, ["work"]);
  // The other repo's run, even asked for by id, never goes in.
  const digest = analysis.digest("org/app", ["mine-2", "theirs-1", "mine-1"], selection);
  assert.deepEqual(digest.included, ["mine-2", "mine-1"]);
  assert.doesNotMatch(digest.text, /OTHER REPO|theirs-1/);
  assert.ok(!digest.text.includes(secret));
  assert.match(digest.text, /token \[redacted\]/);
  // Each run's part is read once.
  assert.equal(reads, 2);
  // Nothing selected: the preview says so, with the kinds there are.
  const none = analysis.preview("org/app", { count: 10, kinds: [], outcomes: [] });
  assert.deepEqual([none.runs, none.included], [[], 0]);
  assert.deepEqual(none.kinds, ["work"]);
});
