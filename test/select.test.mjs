import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEntry, speedFor } from "../listener/agents/select.mjs";

const settings = {
  agent: "claude",
  brainstormAgent: "claude",
  model: "opus",
  effort: "high",
  brainstormModel: "sonnet",
  brainstormEffort: "low",
};
const config = { agents: ["claude", "codex"], fallbacks: ["claude@openrouter", "codex@openai"] };
const base = { config, settings, own: null, light: false, previous: undefined, options: {} };

test("resolveEntry: the settings' agent, model and effort, nothing taken over", () => {
  const r = resolveEntry(base);
  assert.deepEqual(r.entry, { agent: "claude", provider: "anthropic", fallback: null });
  assert.deepEqual([r.model, r.effort], ["opus", "high"]);
  assert.equal(r.badPick, null);
  assert.equal(r.takeOver, false);
  assert.equal(r.switched, null);
  assert.ok(!r.foreign);
  // A light run: the brainstorm's.
  const light = resolveEntry({ ...base, light: true });
  assert.deepEqual([light.model, light.effort], ["sonnet", "low"]);
  // The comments' "/model" wins, as a tier of the agent.
  assert.equal(resolveEntry({ ...base, options: { model: "fast" } }).model, "haiku");
});

test("resolveEntry: an /agent the operator doesn't have is a bad pick, and isn't followed", () => {
  const r = resolveEntry({ ...base, options: { agent: "gemini" } });
  assert.match(r.badPick, /isn't one the operator configured/);
  assert.equal(r.pick, undefined);
  assert.equal(r.entry.agent, "claude");
});

test("resolveEntry: a fallback to another agent takes over, with that agent's best model", () => {
  const marker = {
    entry: "codex@openai",
    from: "claude@anthropic",
    reason: "overloaded (529)",
    tried: ["claude@anthropic"],
    result: "API Error: 529",
  };
  const r = resolveEntry({ ...base, marker });
  assert.equal(r.entry.agent, "codex");
  assert.equal(r.switched.from, "claude@anthropic");
  assert.equal(r.takeOver, true);
  assert.equal(r.handedBy, false);
  // "opus" is Claude's: Codex runs its best instead, and says why.
  assert.match(r.foreign, /is a Claude model/);
  assert.notEqual(r.model, "opus");
  // The same agent on another provider: its session goes on.
  const same = resolveEntry({ ...base, marker: { ...marker, entry: "claude@openrouter" } });
  assert.equal(same.entry.provider, "openrouter");
  assert.ok(same.switched);
  assert.equal(same.takeOver, false);
});

test("resolveEntry: /agent hands the issue over from the previous run's agent, not for inbox entries", () => {
  const previous = { agent: "claude", provider: "anthropic", fallback: null, summary: "Done." };
  const r = resolveEntry({ ...base, previous, options: { agent: "codex" } });
  assert.equal(r.entry.agent, "codex");
  assert.equal(r.handedBy, true);
  assert.equal(r.takeOver, true);
  // The settings' model is Claude's, and `/model` didn't ask for it: Codex's best.
  assert.match(r.foreign, /is a Claude model/);
  assert.equal(
    resolveEntry({ ...base, previous, options: { agent: "codex" }, fresh: true }).takeOver,
    false,
  );
  // The same agent as before: nothing to hand over.
  const same = resolveEntry({ ...base, previous, options: { agent: "claude" } });
  assert.equal(same.takeOver, false);
});

test("speedFor: /speed fast on Claude, allowed by the operator, runs fast on Opus", () => {
  const allowed = { ...config, fastMode: true };
  const r = resolveEntry({ ...base, config: allowed, options: { speed: "fast" } });
  assert.deepEqual([r.model, r.speed, r.speedNote], ["opus", "fast", null]);
  // Without the command: normal, as before.
  const plain = resolveEntry({ ...base, config: allowed });
  assert.deepEqual([plain.model, plain.speed, plain.speedNote], ["opus", "normal", null]);
  // A model's own name with opus in it is Opus.
  const named = { ...base, config: allowed, settings: { ...settings, model: "claude-opus-5-5" } };
  assert.equal(resolveEntry({ ...named, options: { speed: "fast" } }).speed, "fast");
});

test("speedFor: another model switches to the best tier, and says so", () => {
  const allowed = { ...config, fastMode: true };
  for (const model of ["balanced", "fast"]) {
    const r = resolveEntry({ ...base, config: allowed, options: { speed: "fast", model } });
    assert.deepEqual([r.model, r.speed], ["opus", "fast"], model);
    assert.match(r.speedNote, /^fast mode runs on opus, not (sonnet|haiku)$/);
  }
});

test("speedFor: off by the operator, the repo, the agent or the provider: normal, with why", () => {
  const fast = { options: { speed: "fast" } };
  const off = resolveEntry({ ...base, ...fast });
  assert.deepEqual([off.speed, off.model], ["normal", "opus"]);
  assert.equal(off.speedNote, "fast mode is off (the operator's SANDBOX_FAST_MODE): normal speed");
  const allowed = { ...config, fastMode: true };
  const repo = resolveEntry({
    ...base,
    ...fast,
    config: allowed,
    settings: { ...settings, fastMode: false },
  });
  assert.equal(repo.speed, "normal");
  assert.match(repo.speedNote, /off for this repository \(`fast_mode: false`\)/);
  // Codex has no fast mode: its model stays.
  const codex = resolveEntry({
    ...base,
    config: allowed,
    options: { speed: "fast", agent: "codex" },
  });
  assert.equal(codex.entry.agent, "codex");
  assert.equal(codex.speed, "normal");
  assert.equal(codex.speedNote, "fast mode isn't available for Codex: normal speed");
  const openrouter = resolveEntry({
    ...base,
    config: allowed,
    options: { speed: "fast", agent: "claude@openrouter" },
  });
  assert.equal(openrouter.speed, "normal");
  assert.match(openrouter.speedNote, /through openrouter/);
});

test("speedFor: a mode's speed: fast without a command, /speed normal overrides it", () => {
  const allowed = { ...config, fastMode: true };
  const own = { agent: "claude", model: "opus", effort: "high", speed: "fast" };
  assert.equal(resolveEntry({ ...base, config: allowed, own }).speed, "fast");
  const normal = resolveEntry({ ...base, config: allowed, own, options: { speed: "normal" } });
  assert.deepEqual([normal.speed, normal.speedNote], ["normal", null]);
  // speedFor() alone: what it is given decides.
  const agent = { displayName: "X", speeds: ["normal"], defaultProvider: "x" };
  const r = speedFor({ config: allowed, settings, own: null, options: { speed: "fast" }, agent });
  assert.equal(r.speed, "normal");
});
