// The Workflow editor's API (listener/workflow-editor.mjs, #1042), under
// api/repos/<owner>/<repo>/workflows: the files, their checks as they are typed, the what-if dry
// run on a past pull request (listener/workflow-what-if.mjs), and a save as a pull request.

// GET …/workflows.
export interface WorkflowFiles {
  base: string;
  // The files of .deckhand/workflows/ on the default branch.
  files: WorkflowFile[];
  // Deckhand's own workflows, by event: the one `review:` compiles to on `ready` (null without
  // `review.on: ready`), the conflicts one.
  builtIn: { ready: string | null; conflict: string | null };
  // How many open pull requests run each workflow (its file, null for Deckhand's), at the
  // version on the default branch (`current`) and at an older one: each keeps the version it
  // started with.
  running: { file: string | null; event: string; current: number; older: number }[];
  // The past pull requests a dry run can replay, newest first.
  pulls: PastPull[];
}

export interface WorkflowFile {
  name: string;
  file: string;
  text: string;
  // Its blob: a save over a file changed since is refused.
  sha: string;
  url: string;
}

export interface PastPull {
  number: number;
  at: number;
  reviews: number;
  fixes: number;
  merged: boolean;
}

// What `run:` names (listener/workflow-format.mjs RUN_STEPS).
export type StepRun = "rebase" | "ci" | "review" | "fix" | "merge";

// A parsed step (workflow-editor.mjs stepView()): its line is its id.
export interface WorkflowStep {
  line: number;
  kind: "run" | "comment" | "if" | "repeat";
  run?: StepRun;
  // A comment's text, or Deckhand's own by name (`say`: rounds-out).
  comment?: string;
  say?: string;
  // Its condition, as text.
  if?: string;
  then?: WorkflowStep[];
  else?: WorkflowStep[];
  repeat?: WorkflowStep[];
  max?: { var: string; rounds: number };
  count?: string;
  set?: string;
  agent?: string;
  model?: string;
  effort?: string;
  instructions?: string;
}

// An error of the text (`file` null) or of another file it clashes with, its line if known.
export interface WorkflowError {
  file: string | null;
  line: number | null;
  message: string;
}

// POST …/workflows/check: its steps while it parses (with trigger errors too), else null.
export interface WorkflowCheck {
  steps: WorkflowStep[] | null;
  on: string[];
  errors: WorkflowError[];
  // A workflow on `ready` where `review.on: ready` runs the built-in loop: saving turns that off
  // in .deckhand.yaml, in the same pull request, rather than clash with it.
  replaces?: boolean;
}

// A step the dry run took: recorded (as the pull request did), assumed (CI that went on isn't
// recorded), auto (decided for sure: no fix run without a blocking finding), picked.
export interface TrailStep {
  line: number;
  run?: StepRun;
  comment?: string;
  outcome: string;
  source: "recorded" | "assumed" | "auto" | "picked";
}

export interface RecordedStep {
  run: StepRun;
  outcome: string | null;
}

// POST …/workflows/dry-run.
export interface DryRun {
  pr: { number: number; title: string; url: string | null };
  event: string;
  history: RecordedStep[];
  trail: TrailStep[];
  // The first step the pull request never took: `index` in the trail, `expected` what it did
  // next (null: its history ends there).
  diverged: { line: number; run: StepRun; index: number; expected: RecordedStep | null } | null;
  // The step waiting for a pick, and its outcomes.
  ask: { line: number; run: StepRun; options: string[] } | null;
  end: "done" | "merged" | "stopped" | "asking";
  // What the pull request did after the workflow ended.
  leftover: RecordedStep[];
}

// POST …/workflows/save.
export interface SavedWorkflow {
  number: number;
  url: string;
  branch: string;
}
