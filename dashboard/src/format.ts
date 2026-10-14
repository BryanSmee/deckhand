// Names, groups and times the views share.
import type { Run, RunStatus, Task, TaskState } from "./types";

export const STATE_NAMES: Record<TaskState, string> = {
  "building-image": "Building image",
  working: "Working",
  stopping: "Stopping",
  queued: "Queued",
  brainstorm: "Brainstorm",
  "idle-brainstorm": "Idle brainstorm",
  "needs-input": "Needs input",
  done: "Done",
  error: "Error",
  interrupted: "Interrupted",
};

export const RUN_NAMES: Record<RunStatus, string> = {
  running: "Running",
  ok: "Done",
  "needs-input": "Needs input",
  error: "Error",
  interrupted: "Interrupted",
};

// The state chips: each groups states. A brainstorm waiting for its next comment waits for
// the maintainer, like a run that stopped to ask.
export const CHIPS = [
  { id: "all", name: "All", states: null },
  { id: "running", name: "Running", states: ["building-image", "working", "stopping", "queued"] },
  { id: "input", name: "Needs input", states: ["needs-input", "brainstorm", "idle-brainstorm"] },
  { id: "done", name: "Done", states: ["done"] },
  { id: "error", name: "Error", states: ["error", "interrupted"] },
] as const satisfies readonly { id: string; name: string; states: readonly TaskState[] | null }[];

export type ChipId = (typeof CHIPS)[number]["id"];

export function inChip(chip: ChipId, t: Task): boolean {
  const states: readonly TaskState[] | null = CHIPS.find((c) => c.id === chip)?.states ?? null;
  return !states || states.includes(t.state);
}

// What a state looks like: its colour family.
export type Tone = "run" | "input" | "ok" | "err" | "idle";

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
    default:
      return "idle";
  }
}

export const isLive = (t: Task) => ["building-image", "working", "stopping"].includes(t.state);

const KIND_NAMES: Record<string, string> = { pr: "Pull request", discussion: "Discussion" };
// The kinds and built-in modes the kind already names; the repo's own modes are shown.
const PLAIN = ["work", "brainstorm", "idea", "bug", "discussion"];

export function kindName(t: Pick<Task, "kind">): string {
  if (t.kind === "brainstorm") return "Brainstorm";
  if (t.kind === "idea") return "Idea";
  if (t.kind === "bug") return "Bug report";
  return KIND_NAMES[t.kind ?? ""] ?? "Issue";
}

// The repo's own mode, if any: "review".
export function ownMode(mode: string | null | undefined): string | null {
  return mode && !PLAIN.includes(mode) ? mode : null;
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

export function githubUrl(t: Task): string | null {
  if (!t.repo || !t.replyTo) return null;
  const path = t.kind === "discussion" ? "discussions" : "issues";
  return `https://github.com/${t.repo}/${path}/${t.replyTo}`;
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
  if (t.state === "brainstorm" && t.deadline) {
    return `idle in ${Math.max(0, Math.ceil((t.deadline - now) / 60000))} min`;
  }
  if (t.state === "idle-brainstorm" && t.deadline) return `since ${ago(t.deadline, now)}`;
  return last ? ago(last.startedAt, now) : "";
}

// "Continue", "Wrap-up"…: what a run did, for its button in the run history.
export function runName(r: Run): string {
  const own = ownMode(r.taskMode);
  const what = { start: "Start", continue: "Continue", restore: "Restore", "wrap-up": "Wrap-up" }[
    r.mode ?? ""
  ];
  return [own, what ?? "Run"].filter(Boolean).join(" · ");
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
