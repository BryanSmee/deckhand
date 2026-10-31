// Which agent, provider, model, effort and speed a run gets: the settings', a fallback's, `/agent`'s,
// or the one that stuck to the issue (docs/architecture.md, Agents). Pure.
import { AUTHS, NAMED, PLAN_WINDOW_MS } from "./credentials.mjs";
import { agentFor, effortOf, entryName, entryOf, modelOf, providerError } from "./index.mjs";

// The agent of a run: the repo's mode's, else that of light runs or work (the repo's, among
// the operator's, else the operator's).
export function agentNameFor(settings, own, light) {
  return own?.agent ?? (light ? settings.brainstormAgent : settings.agent);
}

// "codex@openai" → "Codex (openai)": an agent on a provider, as replies name it, with its
// credential when it names one: "claude@anthropic:key" → "Claude (anthropic, API key)".
export function entryLabel(name) {
  const entry = entryOf(name);
  if (!entry) return name;
  return `${agentFor(entry.agent).displayName} (${providerLabel(entry)})`;
}

// "anthropic", or "anthropic, API key" for an entry that names its credential.
export function providerLabel({ agent, provider, credential }) {
  if (!credential) return provider;
  return `${provider}, ${agentFor(agent).providers[provider].credentials[credential].label}`;
}

// An entry with the credential it runs on: the one it names, else the operator's default one
// for its provider (config.credentials), "claude@anthropic" → "claude@anthropic:plan" with a
// plan's token. As it is when the default isn't one an entry can name (a gateway's token).
export function resolved(config, name) {
  const entry = entryOf(name);
  if (!entry) return name;
  const credential =
    entry.credential ??
    config.credentials?.[entryName(entry.agent, entry.provider)]?.default ??
    null;
  return entryName(entry.agent, entry.provider, credential);
}

// Which of the operator's Claude credentials a run on `entry` uses, for the dashboard: "plan",
// "key" or "gateway" (AUTHS), the one its entry names, else the default one
// (config.claudeCredential, as the broker routes it: anthropic.mjs). null on another provider,
// or with no Claude credential set.
export function authOf(config, { provider, credential }) {
  if (provider !== "anthropic") return null;
  if (credential) return Object.hasOwn(NAMED, credential) ? credential : null;
  return AUTHS[config.claudeCredential] ?? null;
}

// What `/agent` may pick: the agents the operator configured (config.agents), on their default
// provider and on each credential of it the operator set (`claude@anthropic:key`), and the
// entries of FALLBACKS. A repo's config can't add any. Not a named credential when the default
// is none of them (a gateway's token): it would go to the gateway, which only FALLBACKS may ask.
function pickable(config) {
  const named = config.agents.flatMap((a) => {
    const own = entryName(a);
    const credentials = config.credentials?.[own];
    if (!credentials?.default) return [];
    return credentials.set.map((c) => `${own}:${c}`);
  });
  return [...new Set([...config.agents.map((a) => entryName(a)), ...named, ...config.fallbacks])];
}

// Why a comment's `/agent` can't be followed, or null: an agent or provider Deckhand doesn't
// have, or one the operator hasn't configured. `default` goes back to the settings' agent.
export function pickProblem(config, pick) {
  if (!pick || pick === "default") return null;
  const entry = entryOf(pick);
  const name = entry && entryName(entry.agent, entry.provider, entry.credential);
  if (entry && pickable(config).includes(name)) return null;
  const names = pickable(config)
    .map((e) => `\`${e}\``)
    .join(", ");
  return `\`/agent ${pick}\` isn't one the operator configured (${names}, or \`default\`)`;
}

// The agent, provider and credential of a run (`fallback` on the record: why it isn't the
// usual one, `picked`: chosen with `/agent`): the fallback its comments carry (finish()), else
// the comments' `/agent` (`pick`, checked by pickProblem()), else the entry the task's previous
// run picked or fell back to (`previous`: an agent sticks to an issue), else the agent the
// settings pick (`chosen`) on its default provider. `/agent default` drops what stuck. A
// previous entry the operator took out since doesn't stick, nor a fallback from a plan once its
// limit reset (`until`, nextFallback()): runs go back to the plan, already paid for.
export function entryFor(config, chosen, fallback, previous, pick, now = Date.now()) {
  if (fallback && config.fallbacks.includes(fallback.entry)) {
    const { from, reason, tried, until, result } = fallback;
    return {
      ...entryOf(fallback.entry),
      fallback: { from, reason, tried, ...(until && { until }) },
      result,
    };
  }
  const settings = { agent: chosen, provider: agentFor(chosen).defaultProvider, fallback: null };
  if (pick === "default") return settings;
  if (pick) return { ...entryOf(pick), fallback: null, picked: {} };
  const last = previous && entryName(previous.agent, previous.provider, previous.credential);
  if (previous?.picked && pickable(config).includes(last)) {
    return { ...entryOf(last), fallback: null, picked: { sticky: true } };
  }
  const { until } = previous?.fallback ?? {};
  if (previous?.fallback && config.fallbacks.includes(last) && !(until && now >= until)) {
    const { from, reason } = previous.fallback;
    return { ...entryOf(last), fallback: { from, reason, sticky: true, ...(until && { until }) } };
  }
  return settings;
}

// When a plan's limit resets, in ms, as Claude Code's result says it, or null: "You've hit
// your session limit · resets 1:10pm (UTC)" (the next 1:10 pm there), "… · resets Oct 30, 9am
// (Europe/Paris)", or an older version's "Claude AI usage limit reached|1760000000". A time
// without a zone is UTC's.
const RESET_EPOCH = /limit reached\|(\d{10})\b/i;
const RESET_AT =
  /\bresets (?:([A-Z][a-z]{2}) (\d{1,2}),? (?:at )?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([^)]+)\))?/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MS = 24 * 3600_000;

// How far `zone`'s clock is ahead of UTC's at `at`, in ms; null for a zone Intl doesn't know.
function zoneOffset(zone, at) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(at);
    const p = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
    const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return local - Math.floor(at / 1000) * 1000;
  } catch {
    return null;
  }
}

export function resetFrom(text, now) {
  const epoch = Number(RESET_EPOCH.exec(text ?? "")?.[1]);
  if (epoch) return epoch * 1000;
  const m = RESET_AT.exec(text ?? "");
  if (!m) return null;
  const [, monthName, day, hour, minute = "0", half, zone = "UTC"] = m;
  const month = monthName ? MONTHS.indexOf(monthName.toLowerCase()) : -1;
  const offset = zoneOffset(zone.trim(), now);
  if (offset === null || (monthName && month < 0)) return null;
  const here = new Date(now + offset);
  const h = (Number(hour) % 12) + (half.toLowerCase() === "pm" ? 12 : 0);
  const at = (year) =>
    Date.UTC(
      year,
      monthName ? month : here.getUTCMonth(),
      monthName ? Number(day) : here.getUTCDate(),
      h,
      Number(minute),
    ) - offset;
  let reset = at(here.getUTCFullYear());
  // The next such time: tomorrow's for a time alone, next year's for a past date.
  if (reset <= now) reset = monthName ? at(here.getUTCFullYear() + 1) : reset + DAY_MS;
  return reset;
}

// Where a run whose provider failed goes next: the first entry of FALLBACKS it hasn't been
// on yet (each at most once per run, across the runs of one fallback chain, each on the
// credential it runs on: resolved()), or null when it failed for another reason or none is
// left. `apiStatus`: the provider's last answer; `apiReset`: when the plan's limit it hit resets
// (anthropic.mjs). A run that fails on a plan's credential and goes on on another credential of
// the same agent and provider (`claude@anthropic:key`, the same session) sets `until`: later
// runs of the task stay on it until then (entryFor()), the reset its answer or result gave
// (resetFrom()), else the plan's window from `now`. Another agent or provider sticks as any
// fallback does: going back would resume the session that failed, without what it did. An agent picked with `/agent` doesn't fall back: it was asked for.
export function nextFallback(
  config,
  record,
  result,
  apiStatus,
  { apiReset = null, now = Date.now() } = {},
) {
  if (!config.fallbacks.length || record.picked) return null;
  const reason = providerError(result, apiStatus);
  if (!reason) return null;
  const from = resolved(config, entryName(record.agent, record.provider, record.credential));
  const own = record.fallback && !record.fallback.sticky ? record.fallback.tried : [];
  const tried = [...own, from];
  const entry = config.fallbacks.find((e) => !tried.includes(resolved(config, e)));
  if (!entry) return null;
  const [failed, next] = [entryOf(from), entryOf(entry)];
  const sameSession = failed?.agent === next.agent && failed?.provider === next.provider;
  if (failed?.credential !== "plan" || !sameSession) return { entry, from, reason, tried };
  const until = apiReset ?? resetFrom(result?.text, now) ?? now + PLAN_WINDOW_MS;
  return { entry, from, reason, tried, until };
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
// `marker`: the fallback its comments carry; `fresh`: an inbox entry, with no run to hand over;
// `now`: when a fallback from a plan stops sticking (entryFor()).
export function resolveEntry({
  config,
  settings,
  own,
  light,
  previous,
  options,
  marker,
  fresh,
  now = Date.now(),
}) {
  const chosen = agentFor(agentNameFor(settings, own, light)).name;
  // An `/agent` the operator doesn't allow: the run stops once its log has a first line.
  const badPick = pickProblem(config, options.agent);
  const pick = badPick ? undefined : options.agent;
  const entry = entryFor(config, chosen, marker, previous, pick, now);
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
