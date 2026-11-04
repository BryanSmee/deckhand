// Names, groups and times the views share.
import type {
  Auth,
  Kind,
  LoopState,
  PrState,
  PullRequest,
  RepoStatus,
  ReviewRound,
  Run,
  RunStatus,
  ServerInfo,
  State,
  Task,
  TaskState,
} from "./types";

export const STATE_NAMES: Record<TaskState, string> = {
  scheduled: "Scheduled",
  "building-image": "Building image",
  working: "Working",
  stopping: "Stopping",
  queued: "Queued",
  "in-review": "In review",
  waiting: "Waiting",
  brainstorm: "Brainstorm",
  "idle-brainstorm": "Idle brainstorm",
  "needs-input": "Needs input",
  done: "Done",
  error: "Error",
  interrupted: "Interrupted",
  cancelled: "Stopped",
};

// A run's Claude credential (Run.auth): its tag, and the variable it comes from.
export const AUTH_NAMES: Record<Auth, { label: string; variable: string }> = {
  plan: { label: "Plan", variable: "CLAUDE_CODE_OAUTH_TOKEN" },
  key: { label: "API key", variable: "ANTHROPIC_API_KEY" },
  gateway: { label: "Gateway", variable: "ANTHROPIC_AUTH_TOKEN" },
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
// is over, not failed. A pull request in its review-and-fix loop is still on its way: ready once
// the loop ends.
export const CHIPS = [
  { id: "all", name: "All", states: null },
  {
    id: "running",
    name: "Running",
    states: [
      "scheduled",
      "building-image",
      "working",
      "stopping",
      "queued",
      "in-review",
      "waiting",
    ],
  },
  { id: "input", name: "Needs you", states: ["needs-input", "brainstorm", "idle-brainstorm"] },
  { id: "review", name: "Ready", states: null },
  { id: "done", name: "Done", states: ["done", "cancelled"] },
  { id: "error", name: "Error", states: ["error", "interrupted"] },
] as const satisfies readonly { id: string; name: string; states: readonly TaskState[] | null }[];

export type ChipId = (typeof CHIPS)[number]["id"];

export function inChip(chip: ChipId, t: Task): boolean {
  if (chip === "review") return isReady(t);
  if (chip === "error" && isSettled(t)) return false;
  const states: readonly TaskState[] | null = CHIPS.find((c) => c.id === chip)?.states ?? null;
  return !states || states.includes(t.state);
}

// Ready for the maintainer's review: its pull request is, and Deckhand's review-and-fix loop
// on it is over (inLoop()).
export const isReady = (t: Pick<Task, "pr" | "review">) => t.pr?.state === "ready" && !inLoop(t);

// The loop's states while it goes on: a review or fix run of it queued or running, its
// auto-merge waiting for checks, its review waiting for CI or a CI fix run (listener/reviews.mjs
// reviewLoop()).
const LOOPING: LoopState[] = ["reviewing", "fixing", "checks", "ci", "ci-fix"];
export const inLoop = (t: Pick<Task, "review">) => !!t.review && LOOPING.includes(t.review.loop);

// A loop still going, for a row: "Review · first review", "Review · round 2 of 3", "Review ·
// waiting for checks", "Review · waiting for CI", "Review · fixing CI"; null otherwise.
export function loopLine(t: Pick<Task, "review">): string | null {
  const r = t.review;
  if (!r || !inLoop(t)) return null;
  if (r.loop === "checks") return "Review · waiting for checks";
  if (r.loop === "ci") return "Review · waiting for CI";
  if (r.loop === "ci-fix") return "Review · fixing CI";
  if (!r.round) return "Review · first review";
  return r.rounds ? `Review · round ${r.round} of ${r.rounds}` : `Review · round ${r.round}`;
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

// A review's points, every finding weighed by its severity (not only the blocking ones), and a
// blocking comment as a medium finding (it caps the rating as one does); notes and follow-ups
// weigh nothing: what the task page compares a review with the one before it by. Never shown.
const WEIGHTS = { critical: 8, high: 5, medium: 3, low: 1 } as const;
export const reviewScore = (r: Pick<ReviewRound, "counts" | "comments">) =>
  SEVERITIES.reduce((sum, s) => sum + (r.counts[s] ?? 0) * WEIGHTS[s], 0) +
  (r.comments?.blocking ?? 0) * WEIGHTS.medium;

// The last review against the one before it: "better" with fewer points, "worse" with more;
// null when they weigh the same or it's the only one.
export function reviewTrend(history: ReviewRound[]): "better" | "worse" | null {
  if (history.length < 2) return null;
  const last = reviewScore(history.at(-1)!);
  const before = reviewScore(history.at(-2)!);
  return last < before ? "better" : last > before ? "worse" : null;
}

// What a loop that ended blocking left, for the ready rows and its notification: "2 high
// findings left after 3 fix rounds", "1 critical and 1 high finding left after the review";
// null when it ended clean or still goes on. The blocking findings are the most severe ones.
export function findingsLeft(t: Pick<Task, "review">): string | null {
  const r = t.review;
  // The CI step stopped before any review of this head: CI fails, nothing was reviewed.
  if (r?.loop === "ci-failed") return "CI failed, not reviewed";
  const last = r?.history.at(-1);
  if (!r || !["rounds-out", "stopped"].includes(r.loop) || !last?.blocking) return null;
  const parts: string[] = [];
  const comments = last.comments?.blocking ?? 0;
  let left = last.blocking - comments;
  for (const s of SEVERITIES) {
    const n = Math.min(last.counts[s] ?? 0, left);
    if (n) parts.push(`${n} ${s}`);
    left -= n;
    if (!left) break;
  }
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  const after = last.round ? `after ${plural(last.round, "fix round")}` : "after the review";
  const findings = last.blocking - comments;
  const found = findings ? `${what ?? findings} ${findings === 1 ? "finding" : "findings"}` : null;
  const said = comments ? plural(comments, "blocking comment") : null;
  return `${[found, said].filter(Boolean).join(" and ")} left ${after}`;
}

// The loop's ends, where the task page offers to review its pull request again.
const LOOP_OVER = ["rounds-out", "stopped", "fixed", "ci-failed", "clean"];
// A run going or queued on the task: the listener would refuse.
const BUSY = ["scheduled", "building-image", "working", "stopping", "queued", "in-review"];

// What the task page offers once the review loop of its open pull request is over
// (listener/work.mjs `review`): Review, a review of its head now; Fix, one fix run more, when
// the last review left blocking findings (findingsLeft()) and the repo has `review.fix`
// (`rounds`), nobody's answer awaited. The listener checks again, and says why it refuses.
export function reviewOffers(t: Pick<Task, "review" | "pr" | "state">): {
  review: boolean;
  fix: boolean;
} {
  const r = t.review;
  const open = t.pr?.state === "draft" || t.pr?.state === "ready";
  if (!r || !open || !LOOP_OVER.includes(r.loop) || BUSY.includes(t.state)) {
    return { review: false, fix: false };
  }
  const last = r.history.at(-1);
  // A last review GitHub refused, posted as a comment: the listener can't read it back to fix.
  const blocking = !!last?.blocking && !last.comment && ["rounds-out", "stopped"].includes(r.loop);
  // Fix on a ready pull request only: the listener refuses a draft's.
  const ready = t.pr?.state === "ready";
  return { review: true, fix: blocking && ready && r.rounds > 0 && t.state !== "needs-input" };
}

// A commit pushed after the last review, once the loop is over: { reviewed, head }, the
// reviewed sha and the pull request's head now; null when they match, either one isn't known
// (older entries: never a false alarm), the loop still goes on (a new head is expected) or the
// pull request is merged or closed.
export function reviewOutdated(
  t: Pick<Task, "review" | "pr">,
): { reviewed: string; head: string } | null {
  const r = t.review;
  const open = t.pr?.state === "draft" || t.pr?.state === "ready";
  if (!r || !open || !LOOP_OVER.includes(r.loop)) return null;
  const reviewed = r.history.at(-1)?.head;
  const head = t.pr?.head;
  return reviewed && head && reviewed !== head ? { reviewed, head } : null;
}

// A commit's short sha, as GitHub shows it.
export const shortSha = (sha: string) => sha.slice(0, 7);

// A review's findings by severity, then its comments and follow-ups: "1 critical · 3 high",
// "1 low · 1 blocking comment · 2 notes · 1 follow-up", "no findings".
export function roundCounts(r: ReviewRound): string {
  const parts = SEVERITIES.filter((s) => r.counts[s]).map((s) => `${r.counts[s]} ${s}`);
  const { blocking = 0, notes = 0 } = r.comments ?? {};
  if (blocking) parts.push(plural(blocking, "blocking comment"));
  if (notes) parts.push(plural(notes, "note"));
  if (r.followUps) parts.push(plural(r.followUps, "follow-up"));
  return parts.join(" · ") || "no findings";
}

// A review that still blocks on as many findings as the one before it, or more: the fix run
// between them made no progress.
export const noProgress = (history: ReviewRound[], i: number) =>
  i > 0 && history[i].blocking > 0 && history[i].blocking >= history[i - 1].blocking;

// A failure that no longer asks for attention, though the task keeps its state: someone
// dismissed it, or its issue is closed or its pull request merged or closed, so it can't run
// again (listener/http.mjs `rerunnable`). Only All lists it then.
export const isSettled = (t: Pick<Task, "dismissed" | "closed" | "pr">) =>
  !!t.dismissed || !!t.closed || t.pr?.state === "merged" || t.pr?.state === "closed";

// Its last run failed, was lost or stopped, and it still asks: Dismiss is offered (the
// listener's checks: listener/work.mjs dismiss()).
export const canDismiss = (t: Task) =>
  ["error", "interrupted", "cancelled"].includes(t.state) &&
  t.runs[0]?.status === t.state &&
  !isSettled(t);

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

// Why a pull request ready for review (isReady()) isn't for the maintainer to review as it is:
// its CI failed, it conflicts with its base, its review loop left blocking findings, or a
// commit came after the last review; null when none of these. What its badge says instead.
export function notClean(t: Pick<Task, "pr" | "review">): string | null {
  if (!isReady(t)) return null;
  if (t.pr?.ci?.state === "failed" || t.review?.loop === "ci-failed") return "CI failed";
  if (t.pr?.conflict) return "Conflict";
  if (findingsLeft(t)) return "Findings left";
  if (reviewOutdated(t)) return "Reviewed before last push";
  return null;
}

// Ready for the maintainer's review, what purple means everywhere: open and not a draft, its
// review loop over and clean, CI passed on its head (none at all counts, as does one not read
// yet), and no conflict with its base (an unknown one counts as none: GitHub often doesn't
// know yet, and a pull request mustn't flicker).
export const cleanReady = (t: Pick<Task, "pr" | "review">) => readyStatus(t)?.tone === "ready";

// What a state looks like: one of the six status tones (global.css .s-*), which only ever
// mean a state. A stopped run is over, not failed: idle, like a queued one. A run or task that
// is done is idle too: green is for a merged pull request alone (taskStatus()).
export type Tone = "run" | "input" | "ready" | "done" | "err" | "idle";

export function toneOf(state: TaskState | RunStatus): Tone {
  switch (state) {
    case "scheduled":
    case "building-image":
    case "working":
    case "stopping":
    case "running":
      return "run";
    case "needs-input":
    case "brainstorm":
      return "input";
    // Deckhand reviews its own pull request: still at work, between the runs of its loop.
    case "in-review":
      return "run";
    case "error":
    case "interrupted":
      return "err";
    default:
      return "idle";
  }
}

// A task's tone and word: its state's, but once no run is going and nothing failed or asks,
// unless a run is queued or waits to start, its pull request's: merged, green; ready for review and clean (cleanReady()), purple; ready
// but not clean, amber with why (notClean()); still in its review loop or waiting for CI, the
// running tone.
export function taskStatus(t: Pick<Task, "state" | "pr" | "review">): {
  tone: Tone;
  label: string;
} {
  const tone = toneOf(t.state);
  const label = STATE_NAMES[t.state];
  // Queued or waiting: a run is on its way to its pull request, which says nothing yet.
  if (tone !== "idle" || t.state === "queued" || t.state === "waiting") return { tone, label };
  if (t.pr?.state === "merged") return { tone: "done", label };
  if (t.pr?.state !== "ready") return { tone, label };
  return readyStatus(t) ?? { tone: "run", label: "In review" };
}

export const taskTone = (t: Pick<Task, "state" | "pr" | "review">) => taskStatus(t).tone;

// A pull request ready for review whose loop is over (isReady()): its tone and word, as the
// task's (taskStatus()) and the Overview's rows have them; null otherwise.
export function readyStatus(t: Pick<Task, "pr" | "review">): { tone: Tone; label: string } | null {
  if (!isReady(t)) return null;
  const why = notClean(t);
  if (why) return { tone: "input", label: why };
  if (t.pr?.ci?.state === "running") return { tone: "run", label: "Waiting for CI" };
  return { tone: "ready", label: PR_NAMES.ready };
}

export const isLive = (t: Task) =>
  ["scheduled", "building-image", "working", "stopping"].includes(t.state);

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

// The top bar's run count: "2 of 3 running". Auto-pickup's share is reservedText()'s.
export function runningText({
  running,
  maxParallel,
}: Pick<State, "running" | "maxParallel">): string {
  return `${running} of ${maxParallel} running`;
}

// Auto-pickup's reserved slots and how they are used: "1 auto-pickup slot (1 in use)", "… (free)",
// with how many of them picks hold while they aren't running (asking, between two loop steps:
// the sweep picks nothing for them); null when it is off.
export function reservedText(state: Pick<State, "autoPickup">): string | null {
  const slots = state.autoPickup?.slots;
  if (!slots) return null;
  const running = state.autoPickup?.running ?? 0;
  const held = heldText(state);
  const use = [running > 0 && `${running} in use`, held].filter(Boolean);
  return `${plural(slots, "auto-pickup slot")} (${use.length ? use.join(", ") : "free"})`;
}

// "1 held between runs": the reserved slots picks hold while not running, or null.
export function heldText(state: Pick<State, "autoPickup">): string | null {
  const { running = 0, taken = 0 } = state.autoPickup ?? {};
  return taken > running ? `${taken - running} held between runs` : null;
}

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

// When something happened, by the clock: "today 14:31", "yesterday 18:40", "Oct 14, 09:30";
// without `words`, "14:31" today and the date on any other day.
export function dayTime(at: number, now: number, words = true): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = new Date(now);
  if (d.toDateString() === day.toDateString()) return words ? `today ${time}` : time;
  day.setDate(day.getDate() - 1);
  if (words && d.toDateString() === day.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
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
  return ownWhen(t, now) ?? (t.updatedAt ? ago(t.updatedAt, now) : "");
}

// The full time behind when()'s "… ago", and its last run's start; null when it says another.
export function whenTitle(t: Task, now: number): string | null {
  if (ownWhen(t, now) !== null || !t.updatedAt) return null;
  const updated = `Updated ${dayTime(t.updatedAt, now)}`;
  const last = t.runs[0];
  return last ? `${updated} · last run started ${dayTime(last.startedAt, now)}` : updated;
}

// A live, queued, waiting or brainstorm row's own text; null for the others, which say when
// they were last updated.
function ownWhen(t: Task, now: number): string | null {
  const last = t.runs[0];
  if (isLive(t) && last) return duration(last, now);
  if (t.state === "queued") return t.replyTo ? `reply on #${t.replyTo}` : "";
  if (t.state === "waiting" && t.waitingFor?.length) return `after ${issueList(t.waitingFor)}`;
  if (t.state === "brainstorm" && t.deadline) {
    return `idle in ${Math.max(0, Math.ceil((t.deadline - now) / 60000))} min`;
  }
  if (t.state === "idle-brainstorm" && t.deadline) return `since ${ago(t.deadline, now)}`;
  return null;
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
  const fix = r.round && (r.rounds ?? 1) > 1 ? `Review fix ${r.round}/${r.rounds}` : "Review fix";
  const ci = r.round && (r.rounds ?? 1) > 1 ? `CI fix ${r.round}/${r.rounds}` : "CI fix";
  const why = { conflict: "Conflict", "review-fix": fix, "ci-fix": ci }[r.reason ?? ""] ?? null;
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
  invalid: "Config has errors",
  onboarding: "Onboarding",
  "not-onboarded": "Not onboarded",
  unknown: "Unknown",
};

// "#12 · Fix the queue" shortened to `max` characters, to fit a graph node.
export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
