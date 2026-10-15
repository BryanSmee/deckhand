// The agents Deckhand can run, behind one seam: everything that differs between them is in
// their module (claude.mjs, codex.mjs), and the listener only reads Deckhand's own events from
// them. docs/architecture.md describes it.
import { claude } from "./claude.mjs";
import { codex } from "./codex.mjs";

export const AGENTS = { claude, codex };

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

// Every credential any agent's endpoint holds: none may reach a log or a reply, whichever
// agent ran (secrets.mjs).
export const AGENT_SECRETS = [...new Set(Object.values(AGENTS).flatMap((a) => a.secrets))];
