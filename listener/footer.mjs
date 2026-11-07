// The line under each reply (runs.mjs): agent, model, effort, speed, duration, the next step and
// options that came too late for the run. Pure.
import { agentFor } from "./agents/index.mjs";
import { entryLabel, providerLabel } from "./agents/select.mjs";
import { BUILT_IN } from "./modes.mjs";
import { triggerWord } from "./onboarding.mjs";
import { minutes } from "./runlog.mjs";

// On a phone, the reply is where the next step is read.
export function nextStep(mode, { talk, fresh, trigger }) {
  if (mode === "stop") return " · 💬 brainstorm ended: a trigger line starts it again";
  if (talk) return " · 💬 brainstorm: reply to continue, `/stop` to wrap up";
  if (mode === "discussion") return " · 💬 reply in this discussion to continue";
  if (mode === "onboarding") {
    return ` · 💬 onboarding: reply to change the proposal, \`${triggerWord(trigger)}\` opens the pull request`;
  }
  if (mode === "research") return " · 🔎 research: replies go on in it, `/mode work` switches";
  if (!BUILT_IN.has(mode) && !fresh) {
    return ` · ${mode} mode: replies go on in it, \`/mode work\` switches`;
  }
  return "";
}

// A fast run, by what its agent said of its fast mode at the end (agents/claude.mjs): "on"
// (or nothing, from an older version) is plain fast, "cooldown" back to normal speed for a
// while after a rate limit, "off" it couldn't turn it on (the organization's settings, an
// OAuth token: docs/guides/claude-code.md).
const FAST = {
  cooldown: " · fast, then normal speed for a while (rate limited)",
  off: " · normal speed: the agent couldn't turn fast mode on",
};

// The line under each reply: agent, model, effort, speed, duration, the next step and options
// that came too late for the run.
// The provider shows when it isn't the agent's default, or after a fallback, with why, and the
// credential when the run's entry names one (`claude@anthropic:key`); the
// speed when it is fast, or when the run didn't get what it asked for (record.speedNote).
export function replyFooter(record, result, hint, later) {
  const took = result ? minutes(result.durationMs) : null;
  const late = Object.entries(later)
    .map(([k, v]) => `\`/${k} ${v}\``)
    .join(" ");
  const next = late ? ` · ${late} came mid-run: it applies to the next run` : "";
  const agent = agentFor(record.agent);
  const { fallback } = record;
  const provider =
    record.provider && (fallback || record.credential || record.provider !== agent.defaultProvider)
      ? ` (${providerLabel({ ...record, agent: agent.name })})`
      : "";
  const switched =
    fallback && !fallback.sticky
      ? ` · fell back from ${entryLabel(fallback.from)}: ${fallback.reason}`
      : "";
  const state = result?.fastMode ?? "on";
  const fast = record.speed !== "fast" ? "" : Object.hasOwn(FAST, state) ? FAST[state] : " · fast";
  const speedNote = record.speedNote ? ` · ${record.speedNote}` : "";
  // An external run's (#597): its machine, and its model and effort only as its driver said them.
  const model = record.model ? ` ${record.model}` : "";
  const effort = record.effort ? ` · ${record.effort} effort` : "";
  const setup = record.setup ? ` (${setupText(record.setup)}, as it reports)` : "";
  const on = record.machine ? ` · on ${record.machine}${setup}` : "";
  return `<sub>🤖 ${agent.displayName}${provider}${model}${effort}${on}${fast}${took !== null ? ` · ${took} min` : ""}${switched}${speedNote}${hint}${next}</sub>`;
}

// How an external run's agent ran, as its machine reported it at its claim (#599, mcp.mjs
// setupOf(), which keeps its words to safe characters): "v2.1.3, sandbox on, `acceptEdits`,
// Deckhand's settings". What it didn't say is left out.
export function setupText({ version, sandbox, permissionMode, suggested }) {
  return [
    version && `v${version.replace(/^v/i, "")}`,
    sandbox !== null && sandbox !== undefined && `sandbox ${sandbox ? "on" : "off"}`,
    permissionMode && `\`${permissionMode}\``,
    suggested !== null &&
      suggested !== undefined &&
      (suggested ? "Deckhand's settings" : "its own settings"),
  ]
    .filter(Boolean)
    .join(", ");
}
