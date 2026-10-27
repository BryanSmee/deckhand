// Each task's last policy decisions (decisions.mjs): newest first, capped, kept across a
// restart, one task under any spelling of its repo.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import {
  createDecisions,
  keptInput,
  MAX_DECISIONS,
  MAX_INPUT,
  MAX_INPUTS,
} from "../listener/decisions.mjs";
import { tempDir } from "./helpers.mjs";

const entry = (n, denied = false) => ({
  decision: "merge",
  rule: "deny_merge",
  denied,
  messages: denied ? [`reason ${n}`] : [],
  pr: 5,
});

test("decisions: newest first, capped, kept across a restart", (t) => {
  const path = join(tempDir(t), "decisions.json");
  let time = 1_000;
  const now = () => (time += 1000);
  const decisions = createDecisions({ path, now });
  assert.deepEqual(decisions.get("org/repo#12"), []);
  for (let n = 0; n < MAX_DECISIONS + 2; n++)
    decisions.record("org/repo#12", entry(n, n % 2 === 1));
  const list = decisions.get("org/repo#12");
  assert.equal(list.length, MAX_DECISIONS);
  assert.deepEqual(list[0], { at: list[0].at, ...entry(MAX_DECISIONS + 1, true) });
  assert.ok(list[0].at > list[1].at);
  const again = createDecisions({ path, now });
  assert.deepEqual(again.get("org/repo#12"), list);
});

test("decisions: a task's under another spelling of its repo, merged at restart", (t) => {
  const path = join(tempDir(t), "decisions.json");
  let time = 1_000;
  const decisions = createDecisions({ path, now: () => (time += 1000) });
  decisions.record("Org/Repo#12", entry(1));
  decisions.record("org/repo#12", entry(2, true));
  assert.equal(decisions.get("ORG/repo#12").length, 1);
  decisions.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/Repo" : repo));
  assert.deepEqual(decisions.keys(), ["Org/Repo#12"]);
  assert.deepEqual(
    decisions.get("Org/Repo#12").map((d) => d.messages),
    [["reason 2"], []],
  );
});

test("decisions: a task whose last decision is old is forgotten", (t) => {
  let time = 0;
  const decisions = createDecisions({ path: join(tempDir(t), "d.json"), now: () => time });
  decisions.record("org/repo#1", entry(1));
  time = 91 * 24 * 3600_000;
  decisions.record("org/repo#2", entry(2));
  assert.deepEqual(decisions.keys(), ["org/repo#2"]);
});

test("decisions: the input, redacted and capped, kept on the newest 3 only", (t) => {
  const path = join(tempDir(t), "decisions.json");
  let time = 1_000;
  const secret = "s3cr3t-value-of-the-operator";
  const decisions = createDecisions({ path, now: () => (time += 1000), secrets: () => [secret] });
  const input = (n) => ({
    version: 1,
    decision: "merge",
    pr: { number: 5, title: `${secret} ${n}` },
  });
  for (let n = 0; n < MAX_INPUTS + 2; n++) {
    decisions.record("org/repo#12", {
      ...entry(n),
      gates: [{ name: "Checks green", passed: true }],
      input: input(n),
    });
  }
  const list = decisions.get("org/repo#12");
  assert.equal(MAX_INPUTS, 3);
  assert.deepEqual(
    list.map((d) => "input" in d),
    [true, true, true, false, false],
  );
  assert.equal(list[0].pr, 5);
  assert.equal(list[0].input.pr.title, `[redacted] ${MAX_INPUTS + 1}`);
  assert.equal("truncated" in list[0], false);
  // The gates stay on every one.
  assert.deepEqual(list[4].gates, [{ name: "Checks green", passed: true }]);
  // Without an input (no policy could build it): none kept.
  decisions.record("org/repo#12", entry(9));
  assert.equal("input" in decisions.get("org/repo#12")[0], false);
});

test("keptInput: the changed files cut first, then the findings, with a truncated flag", () => {
  const file = (n) => ({ path: `src/${"x".repeat(80)}/${n}.mjs`, additions: 1, deletions: 0 });
  const big = {
    decision: "merge",
    pr: { number: 5, changed_files: 500, files: Array.from({ length: 500 }, (_, n) => file(n)) },
    review: { findings: [{ severity: "low", path: "a", line: 1, text: "fine" }] },
  };
  const kept = keptInput(big, []);
  assert.equal(kept.truncated, true);
  assert.ok(JSON.stringify(kept.input).length <= MAX_INPUT);
  const files = kept.input.pr.files.length;
  assert.ok(files > 0 && files < 500);
  // As many as fit: one more would not.
  const more = { ...kept.input, pr: { ...kept.input.pr, files: big.pr.files.slice(0, files + 1) } };
  assert.ok(JSON.stringify(more).length > MAX_INPUT);
  assert.equal(kept.input.pr.changed_files, 500);
  assert.equal(kept.input.review.findings.length, 1);
  // The caller's input is left alone.
  assert.equal(big.pr.files.length, 500);
  // Long findings once the files are gone; too big still, none.
  const finding = { severity: "high", path: "a", line: 1, text: "y".repeat(1000) };
  const noisy = { pr: { files: [file(1)] }, review: { findings: Array(20).fill(finding) } };
  const cut = keptInput(noisy, []);
  assert.deepEqual([cut.truncated, cut.input.pr.files.length], [true, 0]);
  assert.ok(cut.input.review.findings.length < 20);
  assert.deepEqual(keptInput({ pr: { title: "z".repeat(MAX_INPUT) } }, []), {
    input: null,
    truncated: true,
  });
  assert.deepEqual(keptInput({ a: 1 }, []), { input: { a: 1 } });
});

test("decisions: a decisions.json written before gates and inputs still loads", (t) => {
  const path = join(tempDir(t), "decisions.json");
  const old = {
    decision: "merge",
    rule: "deny_merge",
    denied: true,
    messages: ["no"],
    pr: 5,
    at: 10,
  };
  writeFileSync(path, JSON.stringify({ "org/repo#12": [old] }));
  const decisions = createDecisions({ path, now: () => 20 });
  assert.deepEqual(decisions.get("org/repo#12"), [old]);
  assert.equal(decisions.dryRun("org/repo#12"), null);
  decisions.record("org/repo#12", { ...entry(1), input: { a: 1 } });
  assert.deepEqual(decisions.get("org/repo#12")[1], old);
});

test("decisions: the last dry run, no decision, kept across a restart and a respelling", (t) => {
  const dir = tempDir(t);
  const files = { path: join(dir, "decisions.json"), dryRunPath: join(dir, "dry-runs.json") };
  let time = 1_000;
  const now = () => (time += 1000);
  const decisions = createDecisions({ ...files, now });
  const url = "https://github.com/org/repo/pull/5#issuecomment-1";
  decisions.recordDryRun("Org/Repo#12", { by: "alice", url, denials: 1 });
  decisions.recordDryRun("org/repo#12", { by: "bob", url, denials: 2 });
  assert.deepEqual(decisions.get("org/repo#12"), []);
  const last = decisions.dryRun("org/repo#12");
  assert.deepEqual(last, { dryRun: true, by: "bob", at: last.at, denials: 2, url });
  assert.ok(last.at > decisions.dryRun("Org/Repo#12").at);
  const again = createDecisions({ ...files, now });
  assert.equal(again.dryRun("ORG/repo#12").by, "alice");
  again.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/Repo" : repo));
  assert.equal(again.dryRun("Org/Repo#12").by, "bob");
});
