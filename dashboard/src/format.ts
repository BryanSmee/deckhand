// Names, groups and times the views share.
import type {
  Kind,
  PrState,
  PullRequest,
  RepoStatus,
  Run,
  RunStatus,
  ServerInfo,
  Task,
  TaskState,
} from "./types";

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
// the maintainer, like a run that stopped to ask. "Ready" (for review) is the pull request's
// state, whatever the task's: what waits for the maintainer's review. A run someone stopped
// is over, not failed.
export const CHIPS = [
  { id: "all", name: "All", states: null },
  {
    id: "running",
    name: "Running",
    states: ["building-image", "working", "stopping", "queued", "waiting"],
  },
  { id: "input", name: "Needs you", states: ["needs-input", "brainstorm", "idle-brainstorm"] },
  { id: "review", name: "Ready", states: null },
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

// The search box's: every word of the query in the task's title, number, pull request or
// repo. "#22" finds #22 (and #220), "app budgets" the budget tasks of the app repos.
export function matchesSearch(t: Task, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const number = t.number === null ? "" : `#${t.number}`;
  const pr = t.pr ? `#${t.pr.number}` : "";
  const text = [titleOf(t), t.repo, number, pr].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

// What a state looks like: one of the six status tones (global.css .s-*), which only ever
// mean a state. A stopped run is over, not failed: idle, like a queued one.
export type Tone = "run" | "input" | "ready" | "done" | "err" | "idle";

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
      return "done";
    case "error":
    case "interrupted":
      return "err";
    default:
      return "idle";
  }
}

// A task's tone: its state's, but a pull request ready for review is what it waits on once
// no run is going and nothing failed or asks.
export function taskTone(t: Pick<Task, "state" | "pr">): Tone {
  const tone = toneOf(t.state);
  return t.pr?.state === "ready" && (tone === "done" || tone === "idle") ? "ready" : tone;
}

export const isLive = (t: Task) => ["building-image", "working", "stopping"].includes(t.state);

const KIND_NAMES: Record<string, string> = { pr: "Pull request", discussion: "Discussion" };
// The listener's own modes (MODES in listener/modes.mjs, which a test keeps
// in step): the kind already names them, only the repo's own modes are shown.
export const BUILT_IN_MODES = [
  "work",
  "brainstorm",
  "onboarding",
  "research",
  "stop",
  "idea",
  "bug",
  "discussion",
  "analyze",
  "review",
  "policy",
];

export function kindName(t: Pick<Task, "kind">): string {
  if (t.kind === "brainstorm") return "Brainstorm";
  if (t.kind === "idea") return "Idea";
  if (t.kind === "bug") return "Bug report";
  if (t.kind === "research") return "Research";
  return KIND_NAMES[t.kind ?? ""] ?? "Issue";
}

// A run's kind as an analysis picks them (its `taskMode`): the task kinds' names, shorter for
// a bug, and the listener's own modes. A repo's own mode as it is.
const RUN_KIND_NAMES: Record<string, string> = {
  work: "Work",
  bug: "Bug",
  onboarding: "Onboarding",
  analyze: "Analysis",
  review: "Review",
};

export function runKindName(kind: string): string {
  if (RUN_KIND_NAMES[kind]) return RUN_KIND_NAMES[kind];
  return ["brainstorm", "idea", "discussion", "research"].includes(kind)
    ? kindName({ kind: kind as Kind })
    : kind;
}

// A pull request's own task ("org/app#pr-12"), not the issue a pull request closes.
export const isPrTask = (t: Pick<Task, "key" | "number">) =>
  t.number !== null && t.key.endsWith(`#pr-${t.number}`);

// "app" for "org/app".
export const shortRepo = (repo: string) => repo.slice(repo.indexOf("/") + 1);

// "1 run", "3 runs"; `many` when adding an s won't do ("replies").
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The mode a task runs in, where its kind doesn't say it already: an issue's or a pull
// request's ("work", "review"), else the repo's own mode only.
export function modeOf(t: Pick<Task, "kind" | "mode">): string | null {
  return t.kind === "issue" || t.kind === "pr" ? t.mode : ownMode(t.mode);
}

// A pull request in a row's line: "Draft #34", "PR #33" (ready), "merged #30"; and what
// that means, as its tooltip.
export function prName(pr: PullRequest): string {
  const auto = pr.state === "merged" && pr.autoMerged;
  const word = auto
    ? "merged by Deckhand"
    : { draft: "Draft", ready: "PR", merged: "merged", closed: "closed" }[pr.state];
  return `${word} #${pr.number}`;
}

export function prTitle(pr: PullRequest): string {
  return pr.state === "merged" && pr.autoMerged
    ? `Pull request #${pr.number}, merged by Deckhand with no human review`
    : `Pull request #${pr.number}: ${PR_NAMES[pr.state].toLowerCase()}`;
}

// The repo's own mode, if any: "audit".
export function ownMode(mode: string | null | undefined): string | null {
  return mode && !BUILT_IN_MODES.includes(mode) ? mode : null;
}

// What a task is called: its title, or its kind and number until the title is known.
export function titleOf(t: Task): string {
  return t.title ?? `${kindName(t)} #${t.number ?? "?"}`;
}

// "#12", "PR #3": the number as GitHub shows it.
export function numberOf(t: Pick<Task, "number" | "kind">): string {
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

// "3 d 4 h", "4 h 12 min", "12 min": how long the listener has been up, by the server's clock.
export function uptime(startedAt: number, now: number): string {
  const min = Math.max(0, Math.floor((now - startedAt) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// Where a version's code is: an edge build's commit, a release's page; null for "dev" or
// without the repository it was built from.
export function versionUrl({ version, source }: Pick<ServerInfo, "version" | "source">) {
  if (!source) return null;
  const edge = /^edge-([0-9a-f]{7,40})$/.exec(version);
  if (edge) return `${source}/commit/${edge[1]}`;
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    return `${source}/releases/tag/v${version}`;
  return null;
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
  const own = r.taskMode === "review" ? "Review" : ownMode(r.taskMode);
  const what = { start: "Start", continue: "Continue", restore: "Restore", "wrap-up": "Wrap-up" }[
    r.mode ?? ""
  ];
  const why = { conflict: "Conflict", "review-fix": "Review fix" }[r.reason ?? ""] ?? null;
  return [why, own, what ?? "Run"].filter(Boolean).join(" · ");
}

// GitHub's repo names ignore case: Owner/Repo and owner/repo are the same repo, which the
// listener can see spelled both ways (a rename, a hand-typed setting).
export const sameRepo = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Repo names without their duplicates in another case: the first spelling of each stays.
export function uniqueRepos(repos: string[]): string[] {
  const seen = new Map<string, string>();
  for (const r of repos) if (!seen.has(r.toLowerCase())) seen.set(r.toLowerCase(), r);
  return [...seen.values()];
}

// The repos' tabs: the most recently active first. Repo names alone, unless they come from
// more than one owner. A repo spelled in two cases is one tab, under its latest spelling.
export function repoTabs(tasks: Task[]): { repo: string; label: string }[] {
  const latest = new Map<string, { repo: string; since: number }>();
  for (const t of tasks) {
    const key = t.repo.toLowerCase();
    const seen = latest.get(key);
    if (!seen || t.since > seen.since) latest.set(key, { repo: t.repo, since: t.since });
  }
  const repos = [...latest.values()]
    .sort((a, b) => b.since - a.since || a.repo.localeCompare(b.repo))
    .map((r) => r.repo);
  const owners = new Set(repos.map((r) => r.split("/")[0].toLowerCase()));
  return repos.map((repo) => ({
    repo,
    label: owners.size > 1 ? repo : shortRepo(repo),
  }));
}

// The sidebar's repositories, in repoTabs()'s order (a repo from the address without a task
// yet too), each with its tasks running (its dot) and those waiting on you (its count): the
// old tabs' counts. `all` counts every repo's. `moving`: one of its runs is going on (the dot
// pulses), not only queued or waiting.
export interface RepoCounts {
  repo: string;
  live: number;
  input: number;
  moving: boolean;
}

export function repoCounts(
  tasks: Task[],
  current: string | null,
): { all: Omit<RepoCounts, "repo">; repos: RepoCounts[] } {
  const repos = repoTabs(tasks).map((t) => t.repo);
  if (current && !repos.some((r) => sameRepo(r, current))) repos.push(current);
  const count = (mine: Task[]) => ({
    live: mine.filter((t) => inChip("running", t)).length,
    input: mine.filter((t) => inChip("input", t)).length,
    moving: mine.some(isLive),
  });
  return {
    all: count(tasks),
    repos: repos.map((repo) => ({ repo, ...count(tasks.filter((t) => sameRepo(t.repo, repo))) })),
  };
}

// A repository's status (api/repos), as its badge says it.
export const REPO_LABELS: Record<RepoStatus, string> = {
  configured: "Configured",
  invalid: "Invalid config",
  onboarding: "Onboarding",
  "not-onboarded": "Not onboarded",
  unknown: "Unknown",
};

// "#12 · Fix the queue" shortened to `max` characters, to fit a graph node.
export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
