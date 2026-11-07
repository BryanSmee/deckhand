// The agents Deckhand can run, behind one seam: everything that differs between them is in
// their module (claude.mjs, codex.mjs, antigravity.mjs), and the listener only reads Deckhand's own events from
// them. docs/contributing/architecture.md describes it.
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
// { agent: "claude", provider: "openrouter" }; "codex" is Codex on its default provider. A
// credential of the provider's can follow (its `credentials`): "claude@anthropic:key" →
// { agent: "claude", provider: "anthropic", credential: "key" }; without one, the default
// credential. Null for an agent, provider or credential Deckhand doesn't have.
export function entryOf(name) {
  const [head, credential, ...more] = String(name ?? "").split(":");
  const [agent, provider, ...rest] = head.split("@");
  if (rest.length || more.length || !Object.hasOwn(AGENTS, agent)) return null;
  const p = provider ?? AGENTS[agent].defaultProvider;
  if (!Object.hasOwn(AGENTS[agent].providers, p)) return null;
  if (credential === undefined) return { agent, provider: p };
  const named = AGENTS[agent].providers[p].credentials ?? {};
  return Object.hasOwn(named, credential) ? { agent, provider: p, credential } : null;
}

export function entryName(agent, provider, credential = null) {
  const name = `${agent}@${provider ?? agentFor(agent).defaultProvider}`;
  return credential ? `${name}:${credential}` : name;
}

// Every agent@provider there is, and agent@provider:credential, for error messages.
export const ENTRIES = Object.values(AGENTS).flatMap((a) =>
  Object.entries(a.providers).flatMap(([p, { credentials = {} }]) => [
    entryName(a.name, p),
    ...Object.keys(credentials).map((c) => entryName(a.name, p, c)),
  ]),
);

// What a provider's failure says, in an agent's error result (Claude Code's "API Error: 529
// {…overloaded_error…}", Codex's "unexpected status 429 Too Many Requests", the Antigravity
// CLI's "Eligibility check failed: UNAUTHENTICATED (code 401)…"), and what each
// HTTP status means. A failing test, a task the agent gave up on or a model's own refusal
// is none of these.
const PROVIDER_ERRORS = [
  [/overloaded/i, "overloaded"],
  [
    /usage limit|limit reached|hit your (?:\w+ )?limit|session limit|weekly limit|insufficient_quota|exceeded your current quota|credit balance|RESOURCE_EXHAUSTED/i,
    "quota reached",
  ],
  [/rate[ _-]?limit|too many requests/i, "rate limited"],
  [
    /invalid (x-)?api[ _-]?key|incorrect api key|authentication_error|invalid bearer|oauth token (has )?expired|UNAUTHENTICATED|PERMISSION_DENIED/i,
    "invalid credentials",
  ],
];
// Deckhand's own refusals, which only look like a provider's (an agent shows "API Error: 403
// Deckhand's egress proxy: …"): its egress proxy's (proxy/proxy.mjs), and the models service's
// for the run's agent token (models/runs.mjs check()). Another credential wouldn't get past
// them, so none is a reason to fall back (#936). The models service's word that the operator's
// login can't be used (upstream.mjs credentialFailure()) is the provider's credential failing:
// not among them.
const DECKHAND_REFUSALS =
  /Deckhand's egress proxy|Deckhand: (?:unknown or finished run|this run token is refused|this run's token only works from its own sandbox)/i;
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
// listener's endpoint got from the provider (`status`, anthropic.mjs and openai.mjs). A result
// that is Deckhand's own refusal (DECKHAND_REFUSALS) says nothing of the provider: only that
// status counts then.
export function providerError(result, status = null) {
  if (result?.ok) return null;
  const text = result?.text ?? "";
  // The endpoint's own status still counts: its last answer was the provider's.
  if (DECKHAND_REFUSALS.test(text)) return statusReason(status);
  const code = Number(API_STATUS.exec(text)?.[1]);
  const found = PROVIDER_ERRORS.find(([pattern]) => pattern.test(text));
  if (found) return code ? `${found[1]} (${code})` : found[1];
  return statusReason(code) ?? statusReason(status);
}
