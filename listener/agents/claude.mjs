// Claude Code, the agent behind the seam (index.mjs): what Deckhand needs to install it, run
// it and read it. Its sandbox half is ../../sandbox/agents/claude.sh.
import { CREDENTIALS, NAMED } from "./credentials.mjs";
import { cutOutput, EFFORTS, idOf, installSpec, normalizer } from "./common.mjs";
import { SANDBOX_URLS } from "../../lib/services.mjs";

// Deckhand's model tiers (`/model best`) → Claude Code's aliases, which the operator can point
// elsewhere (ANTHROPIC_DEFAULT_OPUS_MODEL…, config.modelAliases).
const MODELS = { best: "opus", balanced: "sonnet", fast: "haiku" };

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

// Whether Claude Code runs in fast mode ("on", "cooldown": back to normal speed for a while
// after a rate limit, "off"), as its init and result events say; older versions say nothing.
const fastMode = (e) => (e.fast_mode_state ? { fastMode: e.fast_mode_state } : {});

// stream-json event types → Deckhand's events; other types give none.
const EVENTS = {
  system: (e) =>
    e.subtype === "init" ? [{ type: "started", model: e.model, ...fastMode(e) }] : [],
  assistant: (e) =>
    contentOf(e.message).flatMap((c) => {
      if (c.type === "text") return [{ type: "text", text: c.text }];
      if (c.type === "tool_use")
        return [{ type: "tool", name: c.name, detail: detailOf(c.input), ...idOf(c.id) }];
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
        ...idOf(c.tool_use_id),
      })),
  result: (e) => [
    {
      type: "result",
      ok: !e.is_error,
      text: e.result ?? "",
      durationMs: e.duration_ms ?? 0,
      ...fastMode(e),
    },
  ],
};

export const claude = {
  name: "claude",
  displayName: "Claude",
  install: (config) =>
    installSpec("claude-code", {
      volume: config.claudeCodeVolume,
      version: config.claudeCodeVersion,
      versionVar: "CLAUDE_CODE_VERSION",
    }),
  // Its environment on `provider`. No credential: Claude Code calls the listener
  // (anthropic.mjs) with the run's agent token in its place, in the variable that gives the
  // provider's header (a gateway's token as a bearer). On a credential the run's entry names
  // (`claude@anthropic:key`), that credential's variable: Claude Code's auth mode matches it.
  env: (config, secret, provider = "anthropic", credential = null) => {
    const name = Object.hasOwn(NAMED, credential ?? "")
      ? NAMED[credential].variable
      : config.claudeCredential;
    return {
      ...(provider === "anthropic" ? name && { [name]: secret } : { ANTHROPIC_AUTH_TOKEN: secret }),
      ANTHROPIC_BASE_URL: `${SANDBOX_URLS.models}/anthropic`,
      ...config.modelAliases,
      ...(provider === "openrouter" && config.openrouterAliases),
      // Claude Code's own fallback when the model is overloaded, within the provider.
      ...(config.claudeFallbackModel && {
        SANDBOX_FALLBACK_MODEL: MODELS[config.claudeFallbackModel] ?? config.claudeFallbackModel,
      }),
    };
  },
  // Variables whose values never reach a log or a reply (secrets.mjs): its default provider's.
  secrets: CREDENTIALS,
  // Where its API calls go (the listener forwards them, anthropic.mjs), each with the
  // credentials it takes. `anthropic` is the operator's ANTHROPIC_BASE_URL: Anthropic, unless
  // it points at a gateway. `credentials`: those an entry can name (`claude@anthropic:key`),
  // each with its variable and its label in replies.
  providers: {
    anthropic: { secrets: CREDENTIALS, credentials: NAMED },
    openrouter: { secrets: ["OPENROUTER_API_KEY"] },
  },
  defaultProvider: "anthropic",
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
  // Deckhand's efforts are Claude Code's own.
  efforts: EFFORTS,
  // Its fast mode (`/speed fast`, claude.sh): Opus only, through Anthropic's API only. Agents
  // without `speeds` run at normal speed.
  speeds: ["normal", "fast"],
  fastModels: /opus/i,
  // One line of its output (stream-json) → Deckhand's events: started{model}, text,
  // tool{name, detail, id}, toolOutput{text, error, id}, result{ok, text, durationMs}.
  // A tool's result cut at MAX_LINE (a screenshot read, say): still its call's output.
  normalize: normalizer(EVENTS, "type", cutOutput(/^\{"type":"user".*?"tool_use_id":"([^"]+)"/)),
};
