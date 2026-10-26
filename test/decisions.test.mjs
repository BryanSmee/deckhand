// Each task's last policy decisions (decisions.mjs): newest first, capped, kept across a
// restart, one task under any spelling of its repo.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createDecisions, MAX_DECISIONS } from "../listener/decisions.mjs";
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
