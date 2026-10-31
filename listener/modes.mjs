// What each kind of run is: the built-in modes, and the repo's own (its config's `modes:`,
// customMode()) that add their `light` and `fresh` to them. Pure: no state, no I/O.

// The listener's own modes, each with its traits:
// - picked: "/mode" picks it; the others come from the inbox, discussions, "/stop" and the
//   dashboard's Analyze (analysis.mjs).
// - light: it reads the code and answers, without a branch or the repo's setup. What its
//   sandbox gets is its capabilities (capabilities.mjs), what its token reads too (#497), and
//   what it writes to GitHub and where it pushes are the policies' (`allow_github`,
//   `allow_push`), which Deckhand's defaults (../policy/mode-*.rego) give as these traits did:
//   the traits still decide its volumes.
// - fresh: a new session each time. An inbox issue collects unrelated entries, so each entry
//   is a run of its own (entryRun()); an analysis reads its digest, nothing before.
// - open: the open internet, with nothing of the repo's: no GitHub token, and volumes of its
//   own (sessionName()); no clone, image, setup, caches, mounts, engine or screenshots of the
//   repo's (its capabilities: ../policy/mode-research.rego). Only with the operator's
//   `allow_research` (access.mjs researchRefusal()).
// - inbox: inbox issues and discussion categories are their own trigger (workItem()).
// - kind: what the dashboard shows its runs as (kindOf()).
// - prompt: its instructions, in ../prompts/ (prompts.mjs).
// Their names are reserved: a repo's `modes:` can't take them (repo-config.mjs). The
// dashboard has a copy of the list (format.ts), checked by a test.
export const MODES = {
  work: { picked: true },
  brainstorm: {
    picked: true,
    light: true,
    kind: "brainstorm",
    prompt: "brainstorm.md",
  },
  onboarding: {
    picked: true,
    light: true,
    prompt: "onboarding.md",
  },
  // Research on the open web: its input is the issue's thread (preparation.mjs).
  research: {
    picked: true,
    light: true,
    open: true,
    kind: "research",
    prompt: "research.md",
  },
  // A brainstorm's wrap-up.
  stop: {
    light: true,
    kind: "brainstorm",
    prompt: "brainstorm.md",
  },
  idea: {
    light: true,
    fresh: true,
    inbox: true,
    kind: "idea",
    prompt: "idea.md",
  },
  bug: {
    light: true,
    fresh: true,
    inbox: true,
    kind: "bug",
    prompt: "bug.md",
  },
  // A discussion keeps its session, like a brainstorm.
  discussion: {
    light: true,
    inbox: true,
    kind: "discussion",
    prompt: "discussion.md",
  },
  analyze: { light: true, fresh: true, prompt: "analyze.md" },
  // A pull request's review, only in repos with a `review` block (repo-config.mjs): "/mode"
  // picks it there (modeNames()), and reviews.mjs starts it when a pull request turns ready.
  review: { light: true, fresh: true, prompt: "review.md" },
  // A dry run of the repo's policies on a pull request: no run, the listener evaluates them
  // and replies (task-modes.mjs, reviews.mjs dryRun()).
  policy: { picked: true },
};

const builtIn = (mode) => (Object.hasOwn(MODES, mode) ? MODES[mode] : null);
const having = (trait) => new Set(Object.keys(MODES).filter((mode) => MODES[mode][trait]));

export const RESERVED_MODES = Object.keys(MODES);
export const PICKED_MODES = RESERVED_MODES.filter((mode) => MODES[mode].picked);
export const INBOX = having("inbox");
export const LIGHT = having("light");
export const FRESH = having("fresh");
export const OPEN = having("open");

// Any other mode is one of the repo's own.
export const BUILT_IN = new Set(RESERVED_MODES);

// What a run in the repo's own mode `name` gets, or null when the repo has no such mode
// (work, brainstorm and the inbox are the listener's): light (no branch, no setup, and none of
// the work runs' writes in Deckhand's default policies: ../policy/mode-work.rego), fresh (a new
// session each time, the issue's kept as it is), its instructions file, its agent, model and effort, by default those of work or
// brainstorms, and its speed. The built-in review takes its `review` block's the same way (reviewMode()).
// No hosts, mounts or limits: those are the repo's grants, the same in every mode.
export function customMode(settings, name) {
  if (name === "review") return reviewMode(settings);
  const own = settings?.modes?.[name];
  if (!own) return null;
  const [agent, model, effort] = own.light
    ? [settings.brainstormAgent, settings.brainstormModel, settings.brainstormEffort]
    : [settings.agent, settings.model, settings.effort];
  return {
    name,
    light: own.light,
    fresh: own.session === "fresh",
    instructions: own.instructions,
    agent: own.agent ?? agent,
    model: own.model ?? model,
    effort: own.effort ?? effort,
    // `fast`: `/speed fast` without the command (agents/select.mjs speedFor()).
    speed: own.speed ?? null,
  };
}

// The repo's `review` block as a mode: light and fresh, its instructions optional (added to
// prompts/review.md), its agent, model and effort those of light runs unless it says
// otherwise. Null without the block: the repo hasn't turned reviews on.
function reviewMode(settings) {
  const own = settings?.review;
  if (!own) return null;
  return {
    name: "review",
    light: true,
    fresh: true,
    instructions: own.instructions,
    agent: own.agent ?? settings.brainstormAgent,
    model: own.model ?? settings.brainstormModel,
    effort: own.effort ?? settings.brainstormEffort,
  };
}

export function isLight(task, mode) {
  return LIGHT.has(mode) || !!customMode(task.settings, mode)?.light;
}

export function isFresh(task, mode) {
  return FRESH.has(mode) || !!customMode(task.settings, mode)?.fresh;
}

// An inbox entry is a run of its own: never batched with the next one, never delivered to a
// running entry. A repo's `fresh` modes run on its issues, where a burst belongs together.
export function entryRun(mode) {
  return FRESH.has(mode);
}

// The name of an issue's volumes for a run: light runs get their own clone and Claude session.
// They can't push (the broker refuses them), but what they leave in a volume (git hooks,
// Claude's hooks and settings) would run in the issue's next work run, which can. Research
// runs (`mode`, OPEN) get their own again: what a web page leaves there would otherwise run
// in a light run, which has a token.
export function sessionName(name, light, mode) {
  if (OPEN.has(mode)) return `${name}-research`;
  return light ? `${name}-light` : name;
}

// What the dashboard shows a run or queued task as.
export function kindOf(mode, kind) {
  return builtIn(mode)?.kind ?? kind;
}
