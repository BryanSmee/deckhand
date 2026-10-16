// Names, groups and times the views share.
import type { PrState, RepoStatus, Run, RunStatus, Task, TaskState } from "./types";

export const STATE_NAMES: Record<TaskState, string> = {
  "building-image": "Building image",
  working: "Working",
  stopping: "Stopping",
  queued: "Queued",
  waiting: "Waiting",
  brainstorm: "Brainstorm",
  "idle-brainstorm": "Idle brainstorm",
  "needs-input": "Needs input",
  done: "Done",
  error: "Error",
  interrupted: "Interrupted",
  cancelled: "Stopped",
};

export const RUN_NAMES: Record<RunStatus, string> = {
  running: "Running",
  ok: "Done",
  "needs-input": "Needs input",
  error: "Error",
  interrupted: "Interrupted",
  cancelled: "Stopped",
};

export const PR_NAMES: Record<PrState, string> = {
  draft: "Draft",
  ready: "Ready for review",
  merged: "Merged",
  closed: "Closed",
};

// The state chips: each groups states. A task waiting for other issues ("/after") is on its
// way to a run, like a queued one. A brainstorm waiting for its next comment waits for
// the maintainer, like a run that stopped to ask. "Ready for review" is the pull request's
// state, whatever the task's: what waits for the maintainer's review. A run someone stopped
// is over, not failed.
export const CHIPS = [
  { id: "all", name: "All", states: null },
  {
    id: "running",
    name: "Running",
    states: ["building-image", "working", "stopping", "queued", "waiting"],
  },
  { id: "input", name: "Needs input", states: ["needs-input", "brainstorm", "idle-brainstorm"] },
  { id: "review", name: "Ready for review", states: null },
  { id: "done", name: "Done", states: ["done", "cancelled"] },
  { id: "error", name: "Error", states: ["error", "interrupted"] },
] as const satisfies readonly { id: string; name: string; states: readonly TaskState[] | null }[];

export type ChipId = (typeof CHIPS)[number]["id"];

export function inChip(chip: ChipId, t: Task): boolean {
  if (chip === "review") return isReady(t);
  const states: readonly TaskState[] | null = CHIPS.find((c) => c.id === chip)?.states ?? null;
  return !states || states.includes(t.state);
}

export const isReady = (t: Task) => t.pr?.state === "ready";

// What a state looks like: its colour family.
export type Tone = "run" | "input" | "ok" | "err" | "stop" | "idle";

export function toneOf(state: TaskState | RunStatus): Tone {
  switch (state) {
    case "building-image":
    case "working":
    case "stopping":
    case "running":
      return "run";
    case "needs-input":
    case "brainstorm":
      return "input";
    case "done":
    case "ok":
      return "ok";
    case "error":
    case "interrupted":
      return "err";
    case "cancelled":
      return "stop";
    default:
      return "idle";
  }
}

export const isLive = (t: Task) => ["building-image", "working", "stopping"].includes(t.state);

const KIND_NAMES: Record<string, string> = { pr: "Pull request", discussion: "Discussion" };
// The listener's own modes (RESERVED_MODES in listener/repo-config.mjs, which a test keeps
// in step): the kind already names them, only the repo's own modes are shown.
export const BUILT_IN_MODES = [
  "work",
  "brainstorm",
  "onboarding",
  "stop",
  "idea",
  "bug",
  "discussion",
  "analyze",
];

export function kindName(t: Pick<Task, "kind">): string {
  if (t.kind === "brainstorm") return "Brainstorm";
  if (t.kind === "idea") return "Idea";
  if (t.kind === "bug") return "Bug report";
  return KIND_NAMES[t.kind ?? ""] ?? "Issue";
}

// The repo's own mode, if any: "review".
export function ownMode(mode: string | null | undefined): string | null {
  return mode && !BUILT_IN_MODES.includes(mode) ? mode : null;
}

// What a task is called: its title, or its kind and number until the title is known.
export function titleOf(t: Task): string {
  return t.title ?? `${kindName(t)} #${t.number ?? "?"}`;
}

// "#12", "PR #3": the number as GitHub shows it.
export function numberOf(t: Task): string {
  if (t.number === null) return "";
  return t.kind === "pr" ? `PR #${t.number}` : `#${t.number}`;
}

// `base`: the listener's GitHub (api/state's githubUrl), GitHub Enterprise's included.
export function githubUrl(t: Task, base: string): string | null {
  if (!t.repo || !t.replyTo) return null;
  const path = t.kind === "discussion" ? "discussions" : "issues";
  return `${base}/${t.repo}/${path}/${t.replyTo}`;
}

export function ago(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function duration(r: Run, now: number): string {
  const ms = (r.finishedAt ?? now) - r.startedAt;
  const min = Math.round(ms / 6000) / 10;
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;
}

// What a row says besides its state: how long, until when, or how long ago.
export function when(t: Task, now: number): string {
  const last = t.runs[0];
  if (isLive(t) && last) return duration(last, now);
  if (t.state === "queued") return t.replyTo ? `reply on #${t.replyTo}` : "";
  if (t.state === "waiting" && t.waitingFor?.length) return `after ${issueList(t.waitingFor)}`;
  if (t.state === "brainstorm" && t.deadline) {
    return `idle in ${Math.max(0, Math.ceil((t.deadline - now) / 60000))} min`;
  }
  if (t.state === "idle-brainstorm" && t.deadline) return `since ${ago(t.deadline, now)}`;
  // An issue waiting for input without a run: since it was labelled.
  if (last) return ago(last.startedAt, now);
  return t.since ? ago(t.since, now) : "";
}

// "#77", "#77 and #80", "#77, #80 and #81".
export function issueList(numbers: number[]): string {
  const refs = numbers.map((n) => `#${n}`);
  return refs.length > 1 ? `${refs.slice(0, -1).join(", ")} and ${refs.at(-1)}` : (refs[0] ?? "");
}

// "Continue", "Wrap-up"…: what a run did, for its button in the run history.
export function runName(r: Run): string {
  const own = ownMode(r.taskMode);
  const what = { start: "Start", continue: "Continue", restore: "Restore", "wrap-up": "Wrap-up" }[
    r.mode ?? ""
  ];
  const why = r.reason === "conflict" ? "Conflict" : null;
  return [why, own, what ?? "Run"].filter(Boolean).join(" · ");
}

// The repos' tabs: the most recently active first. Repo names alone, unless they come from
// more than one owner.
export function repoTabs(tasks: Task[]): { repo: string; label: string }[] {
  const latest = new Map<string, number>();
  for (const t of tasks) latest.set(t.repo, Math.max(latest.get(t.repo) ?? 0, t.since));
  const repos = [...latest.keys()].sort(
    (a, b) => latest.get(b)! - latest.get(a)! || a.localeCompare(b),
  );
  const owners = new Set(repos.map((r) => r.split("/")[0]));
  return repos.map((repo) => ({
    repo,
    label: owners.size > 1 ? repo : repo.slice(repo.indexOf("/") + 1),
  }));
}

// A repository's status (api/repos), as its badge says it.
export const REPO_LABELS: Record<RepoStatus, string> = {
  configured: "Configured",
  invalid: "Invalid config",
  onboarding: "Onboarding",
  "not-onboarded": "Not onboarded",
  unknown: "Unknown",
};
