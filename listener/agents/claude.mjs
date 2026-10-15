// Claude Code, the agent behind the seam (index.mjs): what Deckhand needs to install it, run
// it and read it. Its sandbox half is ../../sandbox/agents/claude.sh.
import { CREDENTIALS } from "../anthropic.mjs";

// Deckhand's model tiers (`/model best`) → Claude Code's aliases, which the operator can point
// elsewhere (ANTHROPIC_DEFAULT_OPUS_MODEL…, config.modelAliases).
const MODELS = { best: "opus", balanced: "sonnet", fast: "haiku" };
// Deckhand's efforts are Claude Code's own.
const EFFORTS = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

// What a tool call is about, for the dashboard: the input that says it, else all of it.
function detailOf(input = {}) {
  const i = input ?? {};
  return (
    i.command ??
    i.file_path ??
    i.pattern ??
    i.url ??
    i.description ??
    i.prompt ??
    i.query ??
    (Object.keys(i).length ? JSON.stringify(i) : "")
  );
}

function contentOf(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

// stream-json event types → Deckhand's events; other types give none.
const EVENTS = {
  system: (e) => (e.subtype === "init" ? [{ type: "started", model: e.model }] : []),
  assistant: (e) =>
    contentOf(e.message).flatMap((c) => {
      if (c.type === "text") return [{ type: "text", text: c.text }];
      if (c.type === "tool_use") return [{ type: "tool", name: c.name, detail: detailOf(c.input) }];
      return [];
    }),
  // What the tools gave back.
  user: (e) =>
    contentOf(e.message)
      .filter((c) => c.type === "tool_result")
      .map((c) => ({
        type: "toolOutput",
        error: !!c.is_error,
        text: Array.isArray(c.content)
          ? c.content.map((p) => p.text ?? "").join("\n")
          : (c.content ?? ""),
      })),
  result: (e) => [
    { type: "result", ok: !e.is_error, text: e.result ?? "", durationMs: e.duration_ms ?? 0 },
  ],
};

export const claude = {
  name: "claude",
  displayName: "Claude",
  // Installed per version into a shared, root-owned volume (images.installAgent()), mounted
  // read-only in sandboxes.
  install: (config) => ({
    volume: config.claudeCodeVolume,
    mount: "/opt/claude-code",
    version: config.claudeCodeVersion,
    versionVar: "CLAUDE_CODE_VERSION",
    command: "deckhand-install-claude-code",
  }),
  // Its environment. No credential: Claude Code calls the listener (anthropic.mjs) with the
  // run's secret in its place.
  env: (config, secret) => ({
    ...(config.claudeCredential && { [config.claudeCredential]: secret }),
    ANTHROPIC_BASE_URL: `${config.brokerUrl}/anthropic`,
    ...config.modelAliases,
  }),
  // Variables whose values never reach a log or a reply (secrets.mjs).
  secrets: CREDENTIALS,
  // Claude Code (with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and a credential variable) only
  // calls api.anthropic.com, for WebFetch's domain check: its API calls go to the listener,
  // even with a gateway (ANTHROPIC_BASE_URL), no OAuth refresh, telemetry or update host.
  hosts: ["api.anthropic.com"],
  // Its home, sessions in it: a volume per issue, `<sandbox>-claude`. The volume existing is
  // what hasSession() checks.
  session: { volume: "claude", path: "/home/node/.claude" },
  // Comments that arrive mid-run reach it as stream-json user messages (its inbox).
  takesMessages: true,
  message: (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } }),
  models: () => MODELS,
  // Any name passes: a gateway's models have names of their own (openai/gpt-…).
  modelProblem: () => null,
  efforts: EFFORTS,
  // One line of its output (stream-json) → Deckhand's events: started{model}, text,
  // tool{name, detail}, toolOutput{text, error}, result{ok, text, durationMs}. Lines that
  // aren't its JSON give none.
  normalize(line) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return [];
    }
    return e && Object.hasOwn(EVENTS, e.type) ? EVENTS[e.type](e) : [];
  },
};
