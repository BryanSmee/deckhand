// What each kind of run is: the built-in modes, and the repo's own (its config's `modes:`,
// customMode()) that add their `light` and `fresh` to them. Pure: no state, no I/O.
import {
  DISCUSSION_PERMISSIONS,
  LIGHT_PERMISSIONS,
  NO_TOKEN,
  READ_ONLY_PERMISSIONS,
} from "./github-app.mjs";

// The modes' ceilings (MODES' `ceiling` below), by the kinds github-writes.mjs resolves from
// GitHub: `own_issue`, the run's issue; `own_pr`, its pull request or one from a branch it
// may push; `sub_issue`, an issue whose parent is the run's; `created_issue`, one the run
// created; `other_issue`, `pr`, the rest; `new_issue`, an issue it creates; `new_pr`, a pull
// request it opens (from one of its branches: github-pulls.mjs); `label`, a label of the repo
// it creates. A link's child must be a sub-issue or an issue the run created
// (github-writes.mjs), and moving one from another parent is in no ceiling. Brainstorms
// comment elsewhere in theirs, which the default policy refuses
// (docs/repo-config.md#the-github-input).
const WORK_CEILING = {
  own_issue: ["edit", "comment", "label", "link"],
  own_pr: ["edit", "comment", "label", "ready", "draft"],
  sub_issue: ["edit", "comment", "link"],
  created_issue: ["edit", "comment", "link"],
  new_issue: ["create"],
  new_pr: ["create"],
};
const BRAINSTORM_CEILING = {
  own_issue: ["edit", "comment", "link"],
  sub_issue: ["edit", "comment", "link"],
  created_issue: ["edit", "comment", "link"],
  new_issue: ["create"],
  label: ["create"],
  own_pr: ["comment"],
  other_issue: ["comment"],
  pr: ["comment"],
};
// An inbox entry files issues, parents with their sub-issues (prompts/idea.md): it links under
// the parents it created.
const INBOX_CEILING = {
  own_issue: ["comment"],
  created_issue: ["link"],
  new_issue: ["create"],
  label: ["create"],
};
const NO_WRITES = {};

// The listener's own modes, each with its traits:
// - picked: "/mode" picks it; the others come from the inbox, discussions, "/stop" and the
//   dashboard's Analyze (analysis.mjs).
// - light: it reads the code and answers, without a branch or the repo's setup.
// - fresh: a new session each time. An inbox issue collects unrelated entries, so each entry
//   is a run of its own (entryRun()); an analysis reads its digest, nothing before.
// - open: the open internet, with nothing of the repo's: no clone, no GitHub token, no
//   image, setup, caches, mounts, engine or screenshots of the repo's, and volumes of its own
//   (sessionName()). Only with the operator's `allow_research` (access.mjs researchAccess()).
// - inbox: inbox issues and discussion categories are their own trigger (workItem()).
// - kind: what the dashboard shows its runs as (kindOf()).
// - permissions: its token's (permissionsFor()). No light run writes pull requests. A
//   discussion run answers through GraphQL: its token needs Discussions too. Brainstorms and
//   inbox entries comment and create issues. Onboarding proposes: nothing is pushed or created
//   before the trigger line. An analysis reports: the maintainer files what they want of it.
//   A review reads: the listener posts its GitHub review (reviews.mjs), a diff can't write.
//   Research gets none (NO_TOKEN): a web page it reads can't make it read the repo.
// - ceiling: the most its writes to GitHub (REST, and GraphQL mutations: github-graphql.mjs)
//   can ever do, whatever the policies say (github-writes.mjs): target kind → the actions
//   allowed on it. None: it writes nothing. Reviews, merges, closing, deleting, labels' and
//   the repo's settings, and anything outside the run's repo are in no ceiling. GitHub closes
//   an issue when its pull request merges.
// - issueLabel: the label each issue it creates must carry, in its ceiling too
//   (issueLabelOf(), github-writes.mjs).
// - prompt: its instructions, in ../prompts/ (prompts.mjs).
// Their names are reserved: a repo's `modes:` can't take them (repo-config.mjs). The
// dashboard has a copy of the list (format.ts), checked by a test.
export const MODES = {
  work: { picked: true, ceiling: WORK_CEILING },
  brainstorm: {
    picked: true,
    light: true,
    kind: "brainstorm",
    permissions: LIGHT_PERMISSIONS,
    ceiling: BRAINSTORM_CEILING,
    prompt: "brainstorm.md",
  },
  onboarding: {
    picked: true,
    light: true,
    permissions: READ_ONLY_PERMISSIONS,
    prompt: "onboarding.md",
  },
  // Research on the open web: its input is the issue's thread (preparation.mjs).
  research: {
    picked: true,
    light: true,
    open: true,
    kind: "research",
    permissions: NO_TOKEN,
    prompt: "research.md",
  },
  // A brainstorm's wrap-up.
  stop: {
    light: true,
    kind: "brainstorm",
    permissions: LIGHT_PERMISSIONS,
    ceiling: BRAINSTORM_CEILING,
    prompt: "brainstorm.md",
  },
  idea: {
    light: true,
    fresh: true,
    inbox: true,
    kind: "idea",
    permissions: LIGHT_PERMISSIONS,
    ceiling: INBOX_CEILING,
    issueLabel: "idea",
    prompt: "idea.md",
  },
  bug: {
    light: true,
    fresh: true,
    inbox: true,
    kind: "bug",
    permissions: LIGHT_PERMISSIONS,
    ceiling: INBOX_CEILING,
    issueLabel: "bug",
    prompt: "bug.md",
  },
  // A discussion keeps its session, like a brainstorm.
  discussion: {
    light: true,
    inbox: true,
    kind: "discussion",
    permissions: DISCUSSION_PERMISSIONS,
    ceiling: { new_issue: ["create"] },
    prompt: "discussion.md",
  },
  analyze: { light: true, fresh: true, permissions: READ_ONLY_PERMISSIONS, prompt: "analyze.md" },
  // A pull request's review, only in repos with a `review` block (repo-config.mjs): "/mode"
  // picks it there (modeNames()), and reviews.mjs starts it when a pull request turns ready.
  review: { light: true, fresh: true, permissions: READ_ONLY_PERMISSIONS, prompt: "review.md" },
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
// (work, brainstorm and the inbox are the listener's): light (no branch, no setup, a read-only
// token: it can only comment), fresh (a new session each time, the issue's kept as it is),
// its instructions file, its agent, model and effort, by default those of work or
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

// A built-in mode's token, else a light run in one of the repo's own modes only comments: its
// token only reads.
export function permissionsFor(mode, light) {
  return builtIn(mode)?.permissions ?? (light ? READ_ONLY_PERMISSIONS : undefined);
}

// The most a run's writes can do (`ceiling` above): a built-in mode's, else one of the
// repo's own modes: a light one writes nothing (unless the operator grants more, which no
// grant does yet), the others as work runs. Fail closed: no mode, nothing.
export function ceilingOf(mode, light) {
  const own = builtIn(mode);
  if (own) return own.ceiling ?? NO_WRITES;
  if (!mode || light !== false) return NO_WRITES;
  return WORK_CEILING;
}

// The label a mode's issues carry (`issueLabel` above), or null when any do.
export function issueLabelOf(mode) {
  return builtIn(mode)?.issueLabel ?? null;
}
