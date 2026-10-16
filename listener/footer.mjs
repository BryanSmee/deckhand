// The line under each reply (runs.mjs): agent, model, effort, duration, the next step and
// options that came too late for the run. Pure.
import { agentFor } from "./agents/index.mjs";
import { entryLabel } from "./agents/select.mjs";
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
  if (!BUILT_IN.has(mode) && !fresh) {
    return ` · ${mode} mode: replies go on in it, \`/mode work\` switches`;
  }
  return "";
}

// The line under each reply: agent, model, effort, duration, the next step and options that
// came too late for the run.
// The provider shows when it isn't the agent's default, or after a fallback, with why.
export function replyFooter(record, result, hint, later) {
  const took = result ? minutes(result.durationMs) : null;
  const late = Object.entries(later)
    .map(([k, v]) => `\`/${k} ${v}\``)
    .join(" ");
  const next = late ? ` · ${late} came mid-run: it applies to the next run` : "";
  const agent = agentFor(record.agent);
  const { fallback } = record;
  const provider =
    record.provider && (fallback || record.provider !== agent.defaultProvider)
      ? ` (${record.provider})`
      : "";
  const switched =
    fallback && !fallback.sticky
      ? ` · fell back from ${entryLabel(fallback.from)}: ${fallback.reason}`
      : "";
  return `<sub>🤖 ${agent.displayName}${provider} ${record.model} · ${record.effort} effort${took !== null ? ` · ${took} min` : ""}${switched}${hint}${next}</sub>`;
}
