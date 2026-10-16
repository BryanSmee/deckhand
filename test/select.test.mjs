import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEntry } from "../listener/agents/select.mjs";

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
