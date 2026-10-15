// The agents Deckhand can run, behind one seam: everything that differs between them is in
// their module (claude.mjs), and the listener only reads Deckhand's own events from them.
// docs/architecture.md describes it.
import { claude } from "./claude.mjs";

export const AGENTS = { claude };

// The agent until a deployment can pick one; also that of runs logged before agents had names.
export const DEFAULT_AGENT = "claude";

export function agentFor(name) {
  return Object.hasOwn(AGENTS, name ?? "") ? AGENTS[name] : AGENTS[DEFAULT_AGENT];
}

// A tier (`best`, `balanced`, `fast`) or effort as the agent names it; other names as they are.
export function modelOf(agent, model) {
  return Object.hasOwn(agent.models, model) ? agent.models[model] : model;
}

export function effortOf(agent, effort) {
  return Object.hasOwn(agent.efforts, effort) ? agent.efforts[effort] : effort;
}
