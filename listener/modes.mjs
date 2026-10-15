// What each kind of run is: the built-in modes, and the repo's own (its config's `modes:`,
// customMode()) that add their `light` and `fresh` to them. Pure: no state, no I/O.
import { DISCUSSION_PERMISSIONS, READ_ONLY_PERMISSIONS } from "./github-app.mjs";
import { customMode, RESERVED_MODES } from "./repo-config.mjs";

// Inbox issues and discussion categories are their own trigger (workItem()).
export const INBOX = new Set(["idea", "bug", "discussion"]);

// Runs that read the code and answer, without a branch or the repo's setup: brainstorms (and
// their wrap-up), onboarding, inbox entries and discussions.
export const LIGHT = new Set(["brainstorm", "stop", "onboarding", ...INBOX]);

// Each inbox entry starts a fresh session (the inbox issue collects unrelated entries); a
// discussion keeps its own, like a brainstorm.
export const FRESH = new Set(["idea", "bug"]);

// Any other mode is one of the repo's own.
export const BUILT_IN = new Set(RESERVED_MODES);

export function isLight(task, mode) {
  return LIGHT.has(mode) || !!customMode(task.settings, mode)?.light;
}

export function isFresh(task, mode) {
  return FRESH.has(mode) || !!customMode(task.settings, mode)?.fresh;
}

// The name of an issue's volumes for a run: light runs get their own clone and Claude session.
// Their token may not write the repo, but what they leave in a volume (git hooks, Claude's
// hooks and settings) would run in the issue's next work run, with a token that may.
export function sessionName(name, light) {
  return light ? `${name}-light` : name;
}

// What the dashboard shows a run or queued task as.
export function kindOf(mode, kind) {
  return mode === "brainstorm" || mode === "stop" ? "brainstorm" : INBOX.has(mode) ? mode : kind;
}

// A discussion run answers through GraphQL: its token needs Discussions too. Onboarding and
// a light run in one of the repo's own modes only comment: their token only reads.
export function permissionsFor(mode, light) {
  if (mode === "discussion") return DISCUSSION_PERMISSIONS;
  // Onboarding proposes: nothing is pushed or created before the trigger line.
  if (mode === "onboarding") return READ_ONLY_PERMISSIONS;
  return light && !LIGHT.has(mode) ? READ_ONLY_PERMISSIONS : undefined;
}
