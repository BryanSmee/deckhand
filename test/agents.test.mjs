// The agent seam: Claude Code's stream-json and Codex's JSONL, as recorded from their runs,
// become Deckhand's own events, and their tiers and efforts resolve to their own names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AGENT_SECRETS,
  AGENTS,
  agentFor,
  effortOf,
  entryName,
  entryOf,
  modelOf,
  providerError,
} from "../listener/agents/index.mjs";
import { claude } from "../listener/agents/claude.mjs";
import { codex } from "../listener/agents/codex.mjs";
import { lastResult, outcome } from "../listener/runlog.mjs";
import { agentNameFor, modelFor } from "../listener/agents/select.mjs";

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
  // Its fast mode, when the version says it (agents/claude.mjs).
  assert.deepEqual(claude.normalize(line({ ...init, fast_mode_state: "on" })), [
    { type: "started", model: "claude-opus-5-5", fastMode: "on" },
  ]);
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
  assert.deepEqual(claude.normalize(line({ ...ok, fast_mode_state: "off" })), [
    { type: "result", ok: true, text: ok.result, durationMs: 125000, fastMode: "off" },
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
  assert.deepEqual(Object.keys(AGENTS), ["claude", "codex", "antigravity"]);
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
  // On a credential the run's entry names: that one's variable, whatever the default.
  const plan = { ...config, claudeCredential: "CLAUDE_CODE_OAUTH_TOKEN" };
  const key = claude.env(plan, "s", "anthropic", "key");
  assert.equal(key.ANTHROPIC_API_KEY, "s");
  assert.equal(key.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(claude.env(config, "s", "anthropic", "plan").CLAUDE_CODE_OAUTH_TOKEN, "s");
  assert.deepEqual(claude.install(config), {
    volume: "deckhand-claude-code",
    mount: "/opt/claude-code",
    version: "9.9.9",
    versionVar: "CLAUDE_CODE_VERSION",
    command: "deckhand-install-claude-code",
  });
});

// Codex's JSONL, recorded from Codex 0.162.1 run through sandbox/agents/codex.sh (so with its
// closing deckhand.result line) against a scripted Responses API: a work turn (message,
// commands, an edit, a Playwright call, a needs-input answer) and one that failed.
const fixture = (name) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n");

test("normalize: a Codex turn, from its recorded JSONL", () => {
  const events = fixture("codex-work.jsonl").flatMap((l) => codex.normalize(l));
  assert.deepEqual(events, [
    { type: "started" },
    { type: "text", text: "Looking at the files first." },
    { type: "tool", name: "command", detail: "ls -a" },
    { type: "toolOutput", error: false, text: ".\n..\n.git\nhello.txt\n" },
    { type: "tool", name: "command", detail: "cat missing.txt" },
    { type: "toolOutput", error: true, text: "cat: missing.txt: No such file or directory\n" },
    { type: "tool", name: "edit", detail: "add /workspace/hello.txt" },
    {
      type: "tool",
      name: "mcp__playwright__browser_navigate",
      detail: '{"url":"http://localhost:5173"}',
    },
    { type: "toolOutput", error: false, text: "Navigated to http://localhost:5173" },
    { type: "text", text: "<!-- needs-input -->\n## Needs your input\n\n1. Which?" },
    {
      type: "result",
      ok: true,
      text: "<!-- needs-input -->\n## Needs your input\n\n1. Which?",
      durationMs: 309,
    },
  ]);
  // The result is the last message: the needs-input check reads it as with Claude Code.
  assert.equal(outcome(lastResult(fixture("codex-work.jsonl"), codex)), "needs-input");
});

test("normalize: a failed Codex turn is a failed result with Codex's error", () => {
  const lines = fixture("codex-failed.jsonl");
  // Its retries ("Reconnecting... 1/5") and turn.failed say nothing of their own.
  assert.deepEqual(
    lines.flatMap((l) => codex.normalize(l)),
    [
      { type: "started" },
      {
        type: "result",
        ok: false,
        text: "rate limit exceeded: Rate limit reached for gpt-5.5",
        durationMs: 5950,
      },
    ],
  );
  assert.equal(outcome(lastResult(lines, codex)), "error");
});

test("normalize: Codex's other items, failed edits and MCP errors, and what isn't its JSON", () => {
  const completed = (item) => line({ type: "item.completed", item });
  assert.deepEqual(
    codex.normalize(
      completed({
        type: "file_change",
        changes: [{ path: "a.md", kind: "update" }],
        status: "failed",
      }),
    ),
    [
      { type: "tool", name: "edit", detail: "update a.md" },
      { type: "toolOutput", error: true, text: "Not applied" },
    ],
  );
  assert.deepEqual(
    codex.normalize(
      completed({ type: "mcp_tool_call", status: "failed", error: { message: "No browser" } }),
    ),
    [{ type: "toolOutput", error: true, text: "No browser" }],
  );
  assert.deepEqual(codex.normalize(completed({ type: "web_search", query: "codex hooks" })), [
    { type: "tool", name: "web_search", detail: "codex hooks" },
  ]);
  // A command with a quote in it, unwrapped from Codex's shell.
  assert.deepEqual(
    codex.normalize(
      line({
        type: "item.started",
        item: { type: "command_execution", command: "/bin/bash -lc 'echo '\\''hi'\\'''" },
      }),
    ),
    [{ type: "tool", name: "command", detail: "echo 'hi'" }],
  );
  // Reasoning, todo lists, warnings and usage say nothing.
  for (const item of [
    { type: "reasoning", text: "Hm" },
    { type: "todo_list" },
    { type: "error" },
  ]) {
    assert.deepEqual(codex.normalize(completed(item)), [], item.type);
  }
  for (const raw of ["Cloning into 'x'...", "", "42", "null", '"text"', "[1]"]) {
    assert.deepEqual(codex.normalize(raw), [], raw);
  }
  assert.deepEqual(codex.normalize(line({ type: "turn.completed", usage: {} })), []);
  assert.deepEqual(codex.normalize(line({ type: "item.completed" })), []);
  assert.deepEqual(codex.normalize(line({ type: "constructor" })), []);
});

test("Codex: installed like Claude Code, the run's secret as its key, no mid-run messages", () => {
  const config = {
    brokerUrl: "http://listener:8081",
    codexVolume: "deckhand-codex",
    codexVersion: "0.162.1",
  };
  assert.equal(agentFor("codex"), codex);
  assert.deepEqual(codex.install(config), {
    volume: "deckhand-codex",
    mount: "/opt/codex",
    version: "0.162.1",
    versionVar: "CODEX_VERSION",
    command: "deckhand-install-codex",
  });
  assert.deepEqual(codex.env(config, "run-secret"), {
    OPENAI_API_KEY: "run-secret",
    OPENAI_BASE_URL: "http://listener:8081/openai",
  });
  assert.deepEqual(codex.secrets, ["OPENAI_API_KEY", "CODEX_AUTH_FILE"]);
  assert.deepEqual(codex.hosts, []);
  assert.deepEqual(codex.session, { volume: "codex", path: "/home/node/.codex" });
  assert.equal(codex.takesMessages, false);
  // Every agent's credential is redacted, whichever ran.
  for (const name of [...claude.secrets, ...codex.secrets]) assert.ok(AGENT_SECRETS.includes(name));
});

test("Codex's tiers: its catalog's, or the operator's; Claude's names are refused", () => {
  assert.equal(modelOf(codex, "best"), "gpt-6-astra");
  assert.equal(modelOf(codex, "balanced"), "gpt-6.1-sol");
  assert.equal(modelOf(codex, "fast"), "gpt-6-luna");
  assert.equal(modelOf(codex, "fast", { codexModels: { fast: "gpt-6-mini" } }), "gpt-6-mini");
  assert.equal(modelOf(codex, "best", { codexModels: { fast: "gpt-6-mini" } }), "gpt-6-astra");
  assert.equal(modelOf(codex, "gpt-5.5"), "gpt-5.5");
  assert.equal(effortOf(codex, "xhigh"), "xhigh");
  for (const model of ["opus", "sonnet", "haiku", "opus[1m]", "claude-opus-5-5", "Claude-x"]) {
    assert.match(codex.modelProblem(model), /is a Claude model, not one of Codex's/, model);
  }
  for (const model of ["gpt-6.1-sol", "o3", "gpt-5.5", "opus-like"]) {
    assert.equal(codex.modelProblem(model), null, model);
  }
  // Claude Code takes any name: a gateway's are its own.
  assert.equal(claude.modelProblem("openai/gpt-5"), null);
  // A run's model with Codex: the comment's tier, resolved by Codex.
  const settings = { model: "best", effort: "medium", brainstormModel: "fast" };
  assert.deepEqual(modelFor(settings, null, false, {}, codex), ["gpt-6-astra", "medium"]);
  assert.deepEqual(
    modelFor(settings, null, true, {}, codex, { codexModels: { fast: "gpt-6-mini" } }),
    ["gpt-6-mini", undefined],
  );
});

test("a run's agent: the repo's mode's, else light runs' or work's", () => {
  const settings = { agent: "codex", brainstormAgent: "claude" };
  assert.equal(agentNameFor(settings, null, false), "codex");
  assert.equal(agentNameFor(settings, null, true), "claude");
  assert.equal(agentNameFor(settings, { agent: "claude" }, false), "claude");
});

test("entries: agent@provider, an agent alone on its default provider", () => {
  assert.deepEqual(entryOf("claude"), { agent: "claude", provider: "anthropic" });
  assert.deepEqual(entryOf("claude@openrouter"), { agent: "claude", provider: "openrouter" });
  assert.deepEqual(entryOf("codex"), { agent: "codex", provider: "openai" });
  // A credential of the provider's.
  assert.deepEqual(entryOf("claude@anthropic:key"), {
    agent: "claude",
    provider: "anthropic",
    credential: "key",
  });
  assert.equal(entryOf("claude:plan").credential, "plan");
  assert.equal(entryName("claude", "anthropic", "key"), "claude@anthropic:key");
  for (const bad of [
    "gemini",
    "codex@openrouter",
    "claude@anthropic@x",
    "claude@anthropic:token",
    "claude@anthropic:key:x",
    "claude@openrouter:key",
    "codex@openai:key",
    "",
    null,
  ]) {
    assert.equal(entryOf(bad), null, String(bad));
  }
  assert.equal(entryName("codex"), "codex@openai");
  // Every provider's credential is redacted, whichever runs.
  assert.ok(AGENT_SECRETS.includes("OPENROUTER_API_KEY"));
});

test("providerError: a provider's failure, from the result or the endpoint's last status", () => {
  const failed = (text) => ({ type: "result", ok: false, text, durationMs: 0 });
  // Claude Code's API errors.
  const overloaded =
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  assert.equal(providerError(failed(overloaded)), "overloaded (529)");
  assert.equal(
    providerError(failed('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')),
    "rate limited (429)",
  );
  assert.equal(providerError(failed("Claude AI usage limit reached|1760547600")), "quota reached");
  assert.equal(providerError(failed("Invalid API key · Please run /login")), "invalid credentials");
  assert.equal(
    providerError(failed('API Error: 500 {"type":"error","error":{"type":"api_error"}}')),
    "server error (500)",
  );
  // Codex's.
  assert.equal(
    providerError(failed("exceeded retry limit, last status: 429 Too Many Requests")),
    "rate limited (429)",
  );
  assert.equal(
    providerError(failed("unexpected status 401 Unauthorized: Incorrect API key provided")),
    "invalid credentials (401)",
  );
  assert.equal(
    providerError(failed("You exceeded your current quota, please check your plan")),
    "quota reached",
  );
  // What the endpoint saw, when the result says nothing of it (or there is none).
  assert.equal(providerError(failed("Something went wrong"), 529), "overloaded (529)");
  assert.equal(providerError(null, 503), "server error (503)");
  assert.equal(providerError(null, 402), "quota reached (402)");

  // Not the provider's: a task that failed, a bad request, an ok result.
  assert.equal(providerError(failed("The tests still fail.")), null);
  assert.equal(providerError(failed("The tests still fail."), 200), null);
  assert.equal(
    providerError(failed('API Error: 400 {"error":{"type":"invalid_request_error"}}')),
    null,
  );
  assert.equal(providerError({ ok: true, text: "Done: added a rate limit." }, 429), null);
  // The Antigravity CLI's eligibility check: a refused login is, an unreachable avatar isn't.
  const eligibility = "Eligibility check failed: ";
  assert.equal(
    providerError(failed(`${eligibility}UNAUTHENTICATED (code 401): Request had invalid…`)),
    "invalid credentials",
  );
  const avatar =
    'failed to get profile picture: Get "https://lh3.googleusercontent.com/a/x": Forbidden';
  assert.equal(providerError(failed(eligibility + avatar), 200), null);
  assert.equal(providerError(null), null);
});

test("each agent's env on a provider: OpenRouter's token as a bearer, with its model names", () => {
  const config = {
    brokerUrl: "http://listener:8081",
    claudeCredential: "CLAUDE_CODE_OAUTH_TOKEN",
    modelAliases: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5" },
    openrouterAliases: { ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-5.5" },
    claudeFallbackModel: "balanced",
  };
  assert.deepEqual(claude.env(config, "s3cret"), {
    CLAUDE_CODE_OAUTH_TOKEN: "s3cret",
    ANTHROPIC_BASE_URL: "http://listener:8081/anthropic",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
    SANDBOX_FALLBACK_MODEL: "sonnet",
  });
  assert.deepEqual(claude.env({ ...config, claudeFallbackModel: null }, "s3cret", "openrouter"), {
    ANTHROPIC_AUTH_TOKEN: "s3cret",
    ANTHROPIC_BASE_URL: "http://listener:8081/anthropic",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-5.5",
  });
});
