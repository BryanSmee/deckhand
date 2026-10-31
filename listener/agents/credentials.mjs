// The agents' credentials by name (#504): which variables hold them, how runs and replies name
// them. Their values are the models service's alone (../../models/), which adds them to the
// runs' API calls; the listener only learns which of them it has (models-service.mjs
// credentials()), for its settings (config.mjs) and replies.

// Claude Code's, in the order runs take them when several are set: a bearer token (a
// gateway's), then a plan's OAuth token, already paid for, then an API key, billed per token.
// Not Claude Code's own order (the key before the plan): a run gets one of them, and FALLBACKS
// can name the key (`claude@anthropic:key`) for when the plan's limit is reached.
export const CREDENTIALS = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

// The credentials an entry can name (`claude@anthropic:plan`), each with its variable and how
// replies name it.
export const NAMED = {
  plan: { variable: "CLAUDE_CODE_OAUTH_TOKEN", label: "plan" },
  key: { variable: "ANTHROPIC_API_KEY", label: "API key" },
};

// How the dashboard tells a run's credential (a run record's `auth`), by its variable: a
// gateway's token, a plan's, or an API key, billed per token.
export const AUTHS = {
  ANTHROPIC_AUTH_TOKEN: "gateway",
  ...Object.fromEntries(Object.entries(NAMED).map(([name, { variable }]) => [variable, name])),
};

// The variable that holds the operator's default Claude credential, or null.
export function credentialName(env) {
  return CREDENTIALS.find((name) => env[name]) ?? null;
}

// How long a plan's usage limit lasts when its answer doesn't say: its window, 5 hours.
export const PLAN_WINDOW_MS = 5 * 3600_000;

// Codex's: an API key first, as Claude Code's order puts one before a plan's token.
export const OPENAI_CREDENTIALS = ["OPENAI_API_KEY", "CODEX_AUTH_FILE"];

// The Antigravity CLI's: an API key first, as Claude Code's and Codex's orders put one before a
// plan's login.
export const GOOGLE_CREDENTIALS = ["GEMINI_API_KEY", "AGY_AUTH_FILE"];

export const GEMINI_URL = "https://generativelanguage.googleapis.com";

// Plans' credentials (`claude setup-token`, `codex login`, `agy`'s sign-in): logged at start,
// as the operator is responsible for how they are used, and a plan's terms may not cover a
// team's bot.
const PLANS = {
  CLAUDE_CODE_OAUTH_TOKEN: "a Claude plan's credential",
  CODEX_AUTH_FILE: "a ChatGPT plan's login",
  AGY_AUTH_FILE: "a Google AI plan's login",
};

export function planWarning(name) {
  if (!Object.hasOwn(PLANS, name ?? "")) return null;
  return `Warning: ${name} is ${PLANS[name]}. A subscription (Claude Pro/Max, a ChatGPT plan, Google AI Pro/Ultra) is usually licensed to one person. Serving a team, or repositories other people write to, may break your provider's terms: check them before you do. You are responsible for how your Deckhand uses your credential. For teams, use an API key.`;
}
