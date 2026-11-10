// What each kind of run is: the built-in modes, and the repo's own (its config's `modes:`,
// customMode()) that add their `fresh` to them. Pure: no state, no I/O. What a mode's runs may
// do is never here: what their sandbox gets is their capabilities (capabilities.mjs), what they
// write to GitHub and where they push the policies' (`allow_github`, `allow_push`), all decided
// by Deckhand's default policies (../policy/mode-*.rego) and the operator's and the repo's.
//
// The listener's own modes, each with its config:
// - picked: "/mode" picks it; the others come from the inbox, discussions, "/stop" and the
//   dashboard's Analyze (analysis.mjs).
// - volumes: where its runs keep their clone and the agent's session. None: the issue's, which
//   its work runs share (sandbox-spec.mjs sessionOf(), by the run's capabilities). `apart`:
//   volumes of their own, never a work run's (what one leaves there, git hooks or the agent's
//   settings, would otherwise run in the issue's next work run). `research`: their own again,
//   apart from those too (what a web page leaves there would otherwise run in a run with a
//   token). Runs apart also go before work runs in the queue (tasks.mjs), and leave the issue's
//   needs-input label and projects alone (runs.mjs, projects.mjs).
// - defaults: whose agent, model and effort its runs get unless the repo's config says
//   otherwise: the work runs' (AGENT, MODEL, EFFORT), or `brainstorm`, the light runs'
//   (BRAINSTORM_AGENT, BRAINSTORM_MODEL, BRAINSTORM_EFFORT).
// - fresh: a new session each time. An inbox issue collects unrelated entries, so each entry
//   is a run of its own (entryRun()); an analysis reads its digest, nothing before.
// - inbox: inbox issues and discussion categories are their own trigger (workItem()).
// - kind: what the dashboard shows its runs as (kindOf()).
// - talk: a conversation on its issue (`brainstorm`, `grooming`), which comments go on in until
//   "/stop" runs its wrap-up (`wrapUp`, that wrap-up's mode: brainstorms.mjs keeps its state).
//   Its own mode is a wrap-up's, so the policies tell the two apart (`input.mode`).
// - prompt: its instructions, in ../prompts/ (prompts.mjs).
// Their names are reserved: a repo's `modes:` can't take them (repo-config.mjs). The
// dashboard has a copy of the list (format.ts), checked by a test.
export const MODES = {
  work: { picked: true },
  brainstorm: {
    picked: true,
    volumes: "apart",
    defaults: "brainstorm",
    kind: "brainstorm",
    talk: true,
    prompt: "brainstorm.md",
  },
  onboarding: {
    picked: true,
    volumes: "apart",
    defaults: "brainstorm",
    prompt: "onboarding.md",
  },
  // Research on the open web: its input is the issue's thread (preparation.mjs).
  research: {
    picked: true,
    volumes: "research",
    defaults: "brainstorm",
    kind: "research",
    prompt: "research.md",
  },
  // A brainstorm's wrap-up.
  stop: {
    volumes: "apart",
    defaults: "brainstorm",
    kind: "brainstorm",
    wrapUp: "brainstorm",
    prompt: "brainstorm.md",
  },
  // A review of the backlog (#585): a conversation like a brainstorm's, which may comment on the
  // issues it reviews; its wrap-up edits, labels and closes them as agreed (mode-grooming.rego).
  grooming: {
    picked: true,
    volumes: "apart",
    defaults: "brainstorm",
    kind: "grooming",
    talk: true,
    prompt: "grooming.md",
  },
  "grooming-stop": {
    volumes: "apart",
    defaults: "brainstorm",
    kind: "grooming",
    wrapUp: "grooming",
    prompt: "grooming.md",
  },
  idea: {
    volumes: "apart",
    defaults: "brainstorm",
    fresh: true,
    inbox: true,
    kind: "idea",
    prompt: "idea.md",
  },
  bug: {
    volumes: "apart",
    defaults: "brainstorm",
    fresh: true,
    inbox: true,
    kind: "bug",
    prompt: "bug.md",
  },
  // A discussion keeps its session, like a brainstorm.
  discussion: {
    volumes: "apart",
    defaults: "brainstorm",
    inbox: true,
    kind: "discussion",
    prompt: "discussion.md",
  },
  analyze: { volumes: "apart", defaults: "brainstorm", fresh: true, prompt: "analyze.md" },
  // A pull request's review, only in repos with a `review` block (repo-config.mjs): "/mode"
  // picks it there (modeNames()), and reviews.mjs starts it when a pull request turns ready.
  // Its reply has three sections, must-fix findings, follow-ups (filed as issues once the pull
  // request is merged) and comments, then the same as a `json deckhand-review` block, which
  // review-parse.mjs parseReview() reads first, the markdown when the block is missing or wrong.
  review: { volumes: "apart", defaults: "brainstorm", fresh: true, prompt: "review.md" },
  // A dry run of the repo's policies on a pull request: no run, the listener evaluates them
  // and replies (task-modes.mjs, reviews.mjs dryRun()).
  policy: { picked: true },
  // A user's chat from the dashboard (chats.mjs): no issue, its session kept like a brainstorm's
  // in volumes of its own (its task is the chat's, never an issue's), its answers in its log.
  chat: { volumes: "apart", defaults: "brainstorm", kind: "chat", prompt: "chat.md" },
};

const builtIn = (mode) => (Object.hasOwn(MODES, mode) ? MODES[mode] : null);
const having = (trait, value = true) =>
  new Set(Object.keys(MODES).filter((mode) => MODES[mode][trait] === value));

export const RESERVED_MODES = Object.keys(MODES);
export const PICKED_MODES = RESERVED_MODES.filter((mode) => MODES[mode].picked);
export const INBOX = having("inbox");
export const FRESH = having("fresh");
// The modes whose runs have volumes of their own (`volumes`), and of those, research's.
export const APART = new Set(Object.keys(MODES).filter((mode) => MODES[mode].volumes));
export const RESEARCH = having("volumes", "research");
// The conversations, and their wrap-ups: the runs that read and answer on their issue only.
export const TALKS = new Set(
  Object.keys(MODES).filter((mode) => MODES[mode].talk || MODES[mode].wrapUp),
);
export const WRAP_UPS = new Set(Object.keys(MODES).filter((mode) => MODES[mode].wrapUp));

// Any other mode is one of the repo's own.
export const BUILT_IN = new Set(RESERVED_MODES);

// What a run in the repo's own mode `name` gets, or null when the repo has no such mode
// (work, brainstorm and the inbox are the listener's): fresh (a new session each time, the
// issue's kept as it is), its instructions file, its agent, model and effort, by default those
// of work runs, and its speed. The built-in review takes its `review` block's the same way
// (reviewMode()). Its runs share the issue's volumes, as their capabilities pick them
// (sandbox-spec.mjs sessionOf()). No hosts, mounts or limits: those are the repo's grants, the
// same in every mode; nor what its runs may do: its policies decide that.
export function customMode(settings, name) {
  if (name === "review") return reviewMode(settings);
  const own = settings?.modes?.[name];
  if (!own) return null;
  return {
    name,
    fresh: own.session === "fresh",
    instructions: own.instructions,
    agent: own.agent ?? settings.agent,
    model: own.model ?? settings.model,
    effort: own.effort ?? settings.effort,
    // `fast`: `/speed fast` without the command (agents/select.mjs speedFor()).
    speed: own.speed ?? null,
  };
}

// The repo's `review` block as a mode: fresh, its instructions optional (added to
// prompts/review.md), its agent, model and effort those of its `defaults` (MODES.review) unless
// it says otherwise. Null without the block: the repo hasn't turned reviews on.
function reviewMode(settings) {
  const own = settings?.review;
  if (!own) return null;
  const [agent, model, effort] = defaultsOf(settings, "review");
  return {
    name: "review",
    fresh: true,
    instructions: own.instructions,
    agent: own.agent ?? agent,
    model: own.model ?? model,
    effort: own.effort ?? effort,
  };
}

// Whether a run in `mode` gets the light runs' agent, model and effort by default (its
// `defaults`), rather than work's: agents/select.mjs.
export const brainstormDefaults = (mode) => builtIn(mode)?.defaults === "brainstorm";

// The agent, model and effort `settings` (the repo's, over the operator's) give a run in `mode`
// by default (its `defaults`): [agent, model, effort].
function defaultsOf(settings, mode) {
  return brainstormDefaults(mode)
    ? [settings?.brainstormAgent, settings?.brainstormModel, settings?.brainstormEffort]
    : [settings?.agent, settings?.model, settings?.effort];
}

// Whether `mode`'s runs have volumes of their own (`volumes`): the repo's own modes never do.
export function isApart(mode) {
  return APART.has(mode);
}

export function isFresh(task, mode) {
  return FRESH.has(mode) || !!customMode(task.settings, mode)?.fresh;
}

// An inbox entry is a run of its own: never batched with the next one, never delivered to a
// running entry. A repo's `fresh` modes run on its issues, where a burst belongs together.
export function entryRun(mode) {
  return FRESH.has(mode);
}

// The conversation a run is part of: its own mode, or the one a wrap-up ends ("stop" →
// "brainstorm"). What the sandbox (TASK_MODE) and the dashboard (`taskMode`) know it as.
export function talkOf(mode) {
  return builtIn(mode)?.wrapUp ?? mode;
}

// The wrap-up "/stop" runs for the conversation `mode` (a brainstorm's when unknown).
export function wrapUpOf(mode) {
  return Object.keys(MODES).find((m) => MODES[m].wrapUp === mode) ?? "stop";
}

// What the dashboard shows a run or queued task as.
export function kindOf(mode, kind) {
  return builtIn(mode)?.kind ?? kind;
}
