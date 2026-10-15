// The agent seam: Claude Code's stream-json, as recorded from its runs, becomes Deckhand's own
// events, and its tiers and efforts resolve to its own names.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS, agentFor, effortOf, modelOf } from "../listener/agents/index.mjs";
import { claude } from "../listener/agents/claude.mjs";
import { modelFor } from "../listener/runs.mjs";

const line = (event) => JSON.stringify(event);

test("normalize: Claude Code's init gives the model it started on", () => {
  const init = {
    type: "system",
    subtype: "init",
    cwd: "/workspace",
    session_id: "0b5c",
    tools: ["Bash", "Read"],
    mcp_servers: [{ name: "playwright", status: "connected" }],
    model: "claude-opus-5-5",
    permissionMode: "bypassPermissions",
  };
  assert.deepEqual(claude.normalize(line(init)), [{ type: "started", model: "claude-opus-5-5" }]);
  // Hooks and other system events say nothing.
  assert.deepEqual(claude.normalize(line({ type: "system", subtype: "hook_response" })), []);
});

test("normalize: assistant text and tool calls, with what each call is about", () => {
  const assistant = {
    type: "assistant",
    message: {
      id: "msg_01",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "thinking", thinking: "First the README." },
        { type: "text", text: "Looking at the README." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", description: "List" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/workspace/a.md" } },
        { type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [] } },
        { type: "tool_use", id: "t4", name: "ExitPlanMode", input: {} },
        { type: "tool_use", id: "t5", name: "Odd" },
      ],
    },
  };
  assert.deepEqual(claude.normalize(line(assistant)), [
    { type: "text", text: "Looking at the README." },
    { type: "tool", name: "Bash", detail: "ls" },
    { type: "tool", name: "Read", detail: "/workspace/a.md" },
    { type: "tool", name: "TodoWrite", detail: '{"todos":[]}' },
    { type: "tool", name: "ExitPlanMode", detail: "" },
    { type: "tool", name: "Odd", detail: "" },
  ]);
});

test("normalize: tool results, as text or parts, errors flagged", () => {
  const user = {
    type: "user",
    message: {
      role: "user",
      content: [
        { tool_use_id: "t1", type: "tool_result", content: "a.md\nb.md", is_error: false },
        {
          tool_use_id: "t2",
          type: "tool_result",
          is_error: true,
          content: [
            { type: "text", text: "No such file" },
            { type: "image", source: {} },
          ],
        },
        { tool_use_id: "t3", type: "tool_result" },
      ],
    },
  };
  assert.deepEqual(claude.normalize(line(user)), [
    { type: "toolOutput", error: false, text: "a.md\nb.md" },
    { type: "toolOutput", error: true, text: "No such file\n" },
    { type: "toolOutput", error: false, text: "" },
  ]);
  // A user message that is only text (a comment echoed back) has no tool output.
  assert.deepEqual(claude.normalize(line({ type: "user", message: { content: "Hi" } })), []);
});

test("normalize: results, ok, needs-input and errors", () => {
  const ok = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 125000,
    num_turns: 9,
    result: "## Fixed\n\nThe typo.",
    total_cost_usd: 0.4,
  };
  assert.deepEqual(claude.normalize(line(ok)), [
    { type: "result", ok: true, text: "## Fixed\n\nThe typo.", durationMs: 125000 },
  ]);
  const asks = { ...ok, result: "<!-- needs-input -->\n## Needs your input\n\n1. Which?" };
  assert.deepEqual(claude.normalize(line(asks)), [
    { type: "result", ok: true, text: asks.result, durationMs: 125000 },
  ]);
  const failed = { type: "result", subtype: "error_during_execution", is_error: true };
  assert.deepEqual(claude.normalize(line(failed)), [
    { type: "result", ok: false, text: "", durationMs: 0 },
  ]);
  const overloaded = { type: "result", is_error: true, result: "API Error: 529", duration_ms: 9 };
  assert.deepEqual(claude.normalize(line(overloaded)), [
    { type: "result", ok: false, text: "API Error: 529", durationMs: 9 },
  ]);
});

test("normalize: what isn't Claude Code's JSON gives nothing", () => {
  for (const raw of ["Cloning into 'x'...", "", "42", "null", '"text"', "[1]"]) {
    assert.deepEqual(claude.normalize(raw), [], raw);
  }
  assert.deepEqual(claude.normalize(line({ type: "rate_limit_event" })), []);
  assert.deepEqual(claude.normalize(line({ type: "constructor" })), []);
  assert.deepEqual(claude.normalize(line({ type: "assistant" })), []);
});

test("agents: Claude Code is the default, also for unknown names", () => {
  assert.deepEqual(Object.keys(AGENTS), ["claude"]);
  assert.equal(agentFor(), claude);
  assert.equal(agentFor("claude"), claude);
  assert.equal(agentFor("toString"), claude);
  assert.equal(claude.takesMessages, true);
  assert.deepEqual(JSON.parse(claude.message("Hi")), {
    type: "user",
    message: { role: "user", content: "Hi" },
  });
});

test("tiers and efforts resolve per agent; other names pass through", () => {
  assert.equal(modelOf(claude, "best"), "opus");
  assert.equal(modelOf(claude, "balanced"), "sonnet");
  assert.equal(modelOf(claude, "fast"), "haiku");
  assert.equal(modelOf(claude, "claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
  assert.equal(modelOf(claude, "anthropic/claude-sonnet-5.5"), "anthropic/claude-sonnet-5.5");
  assert.equal(modelOf(claude, "constructor"), "constructor");
  assert.equal(effortOf(claude, "max"), "max");
  assert.equal(effortOf(claude, "medium"), "medium");
  // A run's model: /model best in a comment, else the defaults, tiers resolved either way.
  const settings = {
    model: "best",
    effort: "medium",
    brainstormModel: "balanced",
    brainstormEffort: "low",
  };
  assert.deepEqual(modelFor(settings, null, false, {}), ["opus", "medium"]);
  assert.deepEqual(modelFor(settings, null, true, {}), ["sonnet", "low"]);
  assert.deepEqual(modelFor(settings, null, false, { model: "fast", effort: "high" }), [
    "haiku",
    "high",
  ]);
  assert.deepEqual(modelFor(settings, { model: "sonnet", effort: "max" }, false, {}), [
    "sonnet",
    "max",
  ]);
});

test("Claude Code's env: the run's secret in place of the credential, calls to the listener", () => {
  const config = {
    claudeCredential: "ANTHROPIC_API_KEY",
    brokerUrl: "http://listener:8081",
    modelAliases: { ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-5.5" },
    claudeCodeVolume: "deckhand-claude-code",
    claudeCodeVersion: "9.9.9",
  };
  assert.deepEqual(claude.env(config, "run-secret"), {
    ANTHROPIC_API_KEY: "run-secret",
    ANTHROPIC_BASE_URL: "http://listener:8081/anthropic",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-5.5",
  });
  assert.deepEqual(
    claude.env({ ...config, claudeCredential: null }, "s").ANTHROPIC_API_KEY,
    undefined,
  );
  assert.deepEqual(claude.install(config), {
    volume: "deckhand-claude-code",
    mount: "/opt/claude-code",
    version: "9.9.9",
    versionVar: "CLAUDE_CODE_VERSION",
    command: "deckhand-install-claude-code",
  });
});
