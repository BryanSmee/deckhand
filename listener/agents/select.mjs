// Which agent, provider, model, effort and speed a run gets: the settings', a fallback's, `/agent`'s,
// or the one that stuck to the issue (docs/architecture.md, Agents). Pure.
import { agentFor, effortOf, entryName, entryOf, modelOf, providerError } from "./index.mjs";

// The agent of a run: the repo's mode's, else that of light runs or work (the repo's, among
// the operator's, else the operator's).
export function agentNameFor(settings, own, light) {
  return own?.agent ?? (light ? settings.brainstormAgent : settings.agent);
}

// "codex@openai" → "Codex (openai)": an agent on a provider, as replies name it.
export function entryLabel(name) {
  const entry = entryOf(name);
  return entry ? `${agentFor(entry.agent).displayName} (${entry.provider})` : name;
}

// What `/agent` may pick: the agents the operator configured (config.agents), on their default
// provider, and the entries of FALLBACKS. A repo's config can't add any.
function pickable(config) {
  return [...new Set([...config.agents.map((a) => entryName(a)), ...config.fallbacks])];
}

// Why a comment's `/agent` can't be followed, or null: an agent or provider Deckhand doesn't
// have, or one the operator hasn't configured. `default` goes back to the settings' agent.
export function pickProblem(config, pick) {
  if (!pick || pick === "default") return null;
  const entry = entryOf(pick);
  if (entry && pickable(config).includes(entryName(entry.agent, entry.provider))) return null;
  const names = pickable(config)
    .map((e) => `\`${e}\``)
    .join(", ");
  return `\`/agent ${pick}\` isn't one the operator configured (${names}, or \`default\`)`;
}

// The agent and provider of a run (`fallback` on the record: why it isn't the usual one,
// `picked`: chosen with `/agent`): the fallback its comments carry (finish()), else the
// comments' `/agent` (`pick`, checked by pickProblem()), else the entry the task's previous run
// picked or fell back to (`previous`: an agent sticks to an issue), else the agent the
// settings pick (`chosen`) on its default provider. `/agent default` drops what stuck. A
// previous entry the operator took out since doesn't stick.
export function entryFor(config, chosen, fallback, previous, pick) {
  if (fallback && config.fallbacks.includes(fallback.entry)) {
    const { from, reason, tried, result } = fallback;
    return { ...entryOf(fallback.entry), fallback: { from, reason, tried }, result };
  }
  const settings = { agent: chosen, provider: agentFor(chosen).defaultProvider, fallback: null };
  if (pick === "default") return settings;
  if (pick) return { ...entryOf(pick), fallback: null, picked: {} };
  const last = previous && entryName(previous.agent, previous.provider);
  if (previous?.picked && pickable(config).includes(last)) {
    return { ...entryOf(last), fallback: null, picked: { sticky: true } };
  }
  if (previous?.fallback && config.fallbacks.includes(last)) {
    const { from, reason } = previous.fallback;
    return { ...entryOf(last), fallback: { from, reason, sticky: true } };
  }
  return settings;
}

// Where a run whose provider failed goes next: the first entry of FALLBACKS it hasn't been
// on yet (each at most once per run, across the runs of one fallback chain), or null when
// it failed for another reason or none is left. `apiStatus`: the provider's last answer. An
// agent picked with `/agent` doesn't fall back: it was asked for.
export function nextFallback(config, record, result, apiStatus) {
  if (!config.fallbacks.length || record.picked) return null;
  const reason = providerError(result, apiStatus);
  if (!reason) return null;
  const from = entryName(record.agent, record.provider);
  const own = record.fallback && !record.fallback.sticky ? record.fallback.tried : [];
  const tried = [...own, from];
  const entry = config.fallbacks.find((e) => !tried.includes(e));
  return entry ? { entry, from, reason, tried } : null;
}

// The model and effort of a run: the comments' "/model" and "/effort" (`options`), else the
// repo's mode's, else those of light runs or work. Tiers (`best`…, with the operator's own in
// `config`) and efforts as the run's agent names them.
export function modelFor(settings, own, light, options, agent = agentFor(), config = {}) {
  const defaults = own
    ? [own.model, own.effort]
    : light
      ? [settings.brainstormModel, settings.brainstormEffort]
      : [settings.model, settings.effort];
  return [
    modelOf(agent, options.model ?? defaults[0], config),
    effortOf(agent, options.effort ?? defaults[1]),
  ];
}

// The speed of a run (`/speed`, else the repo's mode's): { speed, note, model }. Fast mode
// costs more, so each gate turns it off rather than fail the run, and `note` says why for the
// reply: the agent has none, the operator (SANDBOX_FAST_MODE) or the repo (`fast_mode: false`)
// turned it off, or the provider is a gateway it doesn't work through (OpenRouter). On another
// model than one the agent's fast mode takes (Opus), the run switches to its best tier:
// whoever asks for speed wants it now. `model`: the run's, as modelFor() gave it.
export function speedFor({ config, settings, own, options, agent, provider, model }) {
  const asked = options.speed ?? own?.speed ?? "normal";
  const normal = (why) => ({ speed: "normal", note: why && `${why}: normal speed`, model });
  if (asked !== "fast") return normal(null);
  if (!agent.speeds?.includes("fast")) {
    return normal(`fast mode isn't available for ${agent.displayName}`);
  }
  if (!config.fastMode) return normal("fast mode is off (the operator's SANDBOX_FAST_MODE)");
  if (settings.fastMode === false) {
    return normal("fast mode is off for this repository (`fast_mode: false`)");
  }
  if (provider !== agent.defaultProvider) {
    return normal(`fast mode isn't available through ${provider}`);
  }
  if (agent.fastModels.test(model)) return { speed: "fast", note: null, model };
  const best = modelOf(agent, "best", config);
  return { speed: "fast", note: `fast mode runs on ${best}, not ${model}`, model: best };
}

// Everything begin() (runs.mjs) decides about a run's agent before its log has a first line:
// the entry (entryFor()), the `/agent` it can't follow (`badPick`), whether another agent takes
// over the issue's session (`takeOver`: after a fallback, `switched`, or by `/agent` from the
// previous run's, `handedBy`), the model and effort, `foreign` when the one asked for is
// another agent's (its best instead), and the speed (speedFor(), `speedNote`). `own`: the
// repo's mode, if any; `previous`: the task's previous run of the same kind; `options`: the
// comments' "/model", "/effort", "/speed" and "/agent";
// `marker`: the fallback its comments carry; `fresh`: an inbox entry, with no run to hand over.
export function resolveEntry({ config, settings, own, light, previous, options, marker, fresh }) {
  const chosen = agentFor(agentNameFor(settings, own, light)).name;
  // An `/agent` the operator doesn't allow: the run stops once its log has a first line.
  const badPick = pickProblem(config, options.agent);
  const pick = badPick ? undefined : options.agent;
  const entry = entryFor(config, chosen, marker, previous, pick);
  const agent = agentFor(entry.agent);
  // Another agent than the one that failed: a new session, handed what it left.
  const switched = entry.fallback && !entry.fallback.sticky ? entry.fallback : null;
  // Another agent than the previous run's, by `/agent`: the same, without a failure.
  const handedBy =
    !switched && !!pick && !!previous && !fresh && agentFor(previous.agent).name !== agent.name;
  const takeOver = (!!switched && entryOf(switched.from)?.agent !== agent.name) || handedBy;
  let [model, effort] = modelFor(settings, own, light, options, agent, config);
  // A model of the agent that failed (`/model opus` before a fall back to Codex), or the
  // settings' model of another agent than the one picked: its best.
  const foreign = (takeOver || (entry.picked && !options.model)) && agent.modelProblem(model);
  if (foreign) model = modelOf(agent, "best", config);
  const { provider } = entry;
  const fast = speedFor({ config, settings, own, options, agent, provider, model });
  return {
    entry,
    badPick,
    pick,
    switched,
    handedBy,
    takeOver,
    model: fast.model,
    effort,
    foreign,
    speed: fast.speed,
    speedNote: fast.note,
  };
}
