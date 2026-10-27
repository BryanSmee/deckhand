import assert from "node:assert/strict";
import { test } from "node:test";
import { replyFooter } from "../listener/footer.mjs";

const record = { agent: "claude", provider: "anthropic", model: "opus", effort: "high" };
const result = { ok: true, text: "Done", durationMs: 240000 };

test("footer: a fast run says fast, a normal one nothing", () => {
  assert.equal(
    replyFooter({ ...record, speed: "fast" }, result, "", {}),
    "<sub>🤖 Claude opus · high effort · fast · 4 min</sub>",
  );
  assert.equal(
    replyFooter({ ...record, speed: "normal" }, result, "", {}),
    "<sub>🤖 Claude opus · high effort · 4 min</sub>",
  );
});

test("footer: why the run didn't get the speed or model asked for", () => {
  const off = { ...record, speed: "normal", speedNote: "fast mode is off (x): normal speed" };
  assert.equal(
    replyFooter(off, result, "", {}),
    "<sub>🤖 Claude opus · high effort · 4 min · fast mode is off (x): normal speed</sub>",
  );
  const best = { ...record, speed: "fast", speedNote: "fast mode runs on opus, not sonnet" };
  assert.equal(
    replyFooter(best, result, "", {}),
    "<sub>🤖 Claude opus · high effort · fast · 4 min · fast mode runs on opus, not sonnet</sub>",
  );
});

test("footer: what Claude Code said of its fast mode at the end", () => {
  const fast = { ...record, speed: "fast" };
  assert.match(replyFooter(fast, { ...result, fastMode: "on" }, "", {}), /effort · fast · 4 min/);
  assert.match(
    replyFooter(fast, { ...result, fastMode: "off" }, "", {}),
    /effort · normal speed: the agent couldn't turn fast mode on · 4 min/,
  );
  assert.match(
    replyFooter(fast, { ...result, fastMode: "cooldown" }, "", {}),
    /fast, then normal speed for a while \(rate limited\)/,
  );
  // A normal run ignores it.
  assert.doesNotMatch(replyFooter(record, { ...result, fastMode: "off" }, "", {}), /fast/);
});

test("footer: a /speed sent mid-run applies to the next run", () => {
  assert.equal(
    replyFooter(record, result, "", { speed: "fast" }),
    "<sub>🤖 Claude opus · high effort · 4 min · `/speed fast` came mid-run: it applies to the next run</sub>",
  );
});

test("footer: the credential that answered, and the one it fell back from", () => {
  const onKey = {
    ...record,
    credential: "key",
    fallback: { from: "claude@anthropic:plan", reason: "quota reached", tried: [] },
  };
  assert.equal(
    replyFooter(onKey, result, "", {}),
    "<sub>🤖 Claude (anthropic, API key) opus · high effort · 4 min · fell back from Claude (anthropic, plan): quota reached</sub>",
  );
  // Picked with /agent: named without a fallback.
  assert.equal(
    replyFooter({ ...record, credential: "key", picked: {} }, result, "", {}),
    "<sub>🤖 Claude (anthropic, API key) opus · high effort · 4 min</sub>",
  );
});
