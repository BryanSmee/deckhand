// The agents Deckhand can run, behind one seam: everything that differs between them is in
// their module (claude.mjs, codex.mjs, antigravity.mjs), and the listener only reads Deckhand's own events from
// them. docs/architecture.md describes it.
import { antigravity } from "./antigravity.mjs";
import { claude } from "./claude.mjs";
import { codex } from "./codex.mjs";

export const AGENTS = { claude, codex, antigravity };

// The agent of a deployment that picks none (SANDBOX_AGENT); also that of runs logged before
// agents had names.
export const DEFAULT_AGENT = "claude";

export function agentFor(name) {
  return Object.hasOwn(AGENTS, name ?? "") ? AGENTS[name] : AGENTS[DEFAULT_AGENT];
}

// A tier (`best`, `balanced`, `fast`) or effort as the agent names it, with the operator's
// own tiers (`config`); other names as they are.
export function modelOf(agent, model, config) {
  const models = agent.models(config);
  return Object.hasOwn(models, model) ? models[model] : model;
}

export function effortOf(agent, effort) {
  return Object.hasOwn(agent.efforts, effort) ? agent.efforts[effort] : effort;
}

// Every credential any agent's providers take: none may reach a log or a reply, whichever
// agent ran (secrets.mjs).
export const AGENT_SECRETS = [
  ...new Set(
    Object.values(AGENTS).flatMap((a) => Object.values(a.providers).flatMap((p) => p.secrets)),
  ),
];

// An agent on a provider, written `agent@provider` (FALLBACKS): "claude@openrouter" →
// { agent: "claude", provider: "openrouter" }; "codex" is Codex on its default provider. Null
// for an agent or provider Deckhand doesn't have.
export function entryOf(name) {
  const [agent, provider, ...rest] = String(name ?? "").split("@");
  if (rest.length || !Object.hasOwn(AGENTS, agent)) return null;
  const p = provider ?? AGENTS[agent].defaultProvider;
  return Object.hasOwn(AGENTS[agent].providers, p) ? { agent, provider: p } : null;
}

export function entryName(agent, provider) {
  return `${agent}@${provider ?? agentFor(agent).defaultProvider}`;
}

// Every agent@provider there is, for error messages.
export const ENTRIES = Object.values(AGENTS).flatMap((a) =>
  Object.keys(a.providers).map((p) => entryName(a.name, p)),
);

// What a provider's failure says, in an agent's error result (Claude Code's "API Error: 529
// {…overloaded_error…}", Codex's "unexpected status 429 Too Many Requests", the Antigravity
// CLI's "Eligibility check failed: UNAUTHENTICATED (code 401)…"), and what each
// HTTP status means. A failing test, a task the agent gave up on or a model's own refusal
// is none of these.
const PROVIDER_ERRORS = [
  [/overloaded/i, "overloaded"],
  [
    /usage limit|limit reached|insufficient_quota|exceeded your current quota|credit balance|RESOURCE_EXHAUSTED/i,
    "quota reached",
  ],
  [/rate[ _-]?limit|too many requests/i, "rate limited"],
  [
    /invalid (x-)?api[ _-]?key|incorrect api key|authentication_error|invalid bearer|oauth token (has )?expired|UNAUTHENTICATED|PERMISSION_DENIED|eligibility check failed/i,
    "invalid credentials",
  ],
];
const API_STATUS = /\b(?:API Error|status(?: code)?)[: ]+(\d{3})\b/i;

function statusReason(status) {
  if (status === 529) return "overloaded (529)";
  if (status === 429) return "rate limited (429)";
  if (status === 402) return "quota reached (402)";
  if (status === 401 || status === 403) return `invalid credentials (${status})`;
  if (status >= 500 && status < 600) return `server error (${status})`;
  return null;
}

// Why the provider failed a run, or null: what decides a fallback (FALLBACKS). From the
// agent's result when it isn't ok (null: the agent gave none), then the last answer the
// listener's endpoint got from the provider (`status`, anthropic.mjs and openai.mjs).
export function providerError(result, status = null) {
  if (result?.ok) return null;
  const text = result?.text ?? "";
  const code = Number(API_STATUS.exec(text)?.[1]);
  const found = PROVIDER_ERRORS.find(([pattern]) => pattern.test(text));
  if (found) return code ? `${found[1]} (${code})` : found[1];
  return statusReason(code) ?? statusReason(status);
}
