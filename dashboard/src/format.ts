// Names, groups and times the views share.
// `tr`: t() where a task is called `t`.
import { and, locale, t, t as tr } from "./i18n";
import type { Plain } from "./locales";
import type {
  Auth,
  Kind,
  LoopState,
  PrState,
  PullRequest,
  RepoSlots,
  RepoStatus,
  ReviewRound,
  Run,
  RunStatus,
  ServerInfo,
  State,
  Task,
  TaskMachine,
  TaskState,
} from "./types";

// Each table holds keys, translated where they show (t(STATE_NAMES.done)), as AUTH_NAMES does.
export const STATE_NAMES: Record<TaskState, Plain> = {
  scheduled: "state.scheduled",
  "building-image": "state.buildingImage",
  working: "state.working",
  stopping: "state.stopping",
  queued: "state.queued",
  "in-review": "state.inReview",
  waiting: "state.waiting",
  brainstorm: "state.brainstorm",
  "idle-brainstorm": "state.idleBrainstorm",
  "needs-input": "state.needsInput",
  done: "state.done",
  error: "state.error",
  interrupted: "state.interrupted",
  cancelled: "state.cancelled",
};

// A run's Claude credential (Run.auth): its tag, and the variable it comes from.
export const AUTH_NAMES: Record<Auth, { label: Plain; variable: string }> = {
  plan: { label: "auth.plan", variable: "CLAUDE_CODE_OAUTH_TOKEN" },
  key: { label: "auth.key", variable: "ANTHROPIC_API_KEY" },
  gateway: { label: "auth.gateway", variable: "ANTHROPIC_AUTH_TOKEN" },
};

export const RUN_NAMES: Record<RunStatus, Plain> = {
  running: "run.running",
  ok: "run.ok",
  "needs-input": "run.needsInput",
  error: "run.error",
  interrupted: "run.interrupted",
  cancelled: "run.cancelled",
};

export const PR_NAMES: Record<PrState, Plain> = {
  draft: "pr.draft",
  ready: "pr.ready",
  merged: "pr.merged",
  closed: "pr.closed",
};

// The state chips: each groups states. A task waiting for other issues ("/after") is on its
// way to a run, like a queued one. A brainstorm waiting for its next comment waits for
// the maintainer, like a run that stopped to ask. "Ready" (for review) is the pull request's
// state, whatever the task's: what waits for the maintainer's review. A run someone stopped
// is over, not failed. A pull request in its review-and-fix loop is still on its way: ready once
// the loop ends.
// A chip's name is its key (t(chip.name)).
export const CHIPS = [
  { id: "all", name: "chips.all", states: null },
  {
    id: "running",
    name: "chips.running",
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
  { id: "input", name: "chips.input", states: ["needs-input", "brainstorm", "idle-brainstorm"] },
  { id: "review", name: "chips.review", states: null },
  { id: "done", name: "chips.done", states: ["done", "cancelled"] },
  { id: "error", name: "chips.error", states: ["error", "interrupted"] },
] as const satisfies readonly { id: string; name: Plain; states: readonly TaskState[] | null }[];

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
// auto-merge waiting for checks, its review waiting for CI or a CI fix run, a conflict run whose
// end it goes on from (listener/reviews.mjs reviewLoop()).
const LOOPING: LoopState[] = ["reviewing", "fixing", "checks", "ci", "ci-fix", "rebasing"];
export const inLoop = (t: Pick<Task, "review">) => !!t.review && LOOPING.includes(t.review.loop);

// A loop still going, for a row: "Review · first review", "Review · round 2 of 3", "Review ·
// waiting for checks", "Review · waiting for CI", "Review · fixing CI", "Review · rebasing"; null
// otherwise.
export function loopLine(t: Pick<Task, "review">): string | null {
  const r = t.review;
  if (!r || !inLoop(t)) return null;
  if (r.loop === "checks") return tr("loop.checks");
  if (r.loop === "ci") return tr("loop.ci");
  if (r.loop === "ci-fix") return tr("loop.ciFix");
  if (r.loop === "rebasing") return tr("loop.rebasing");
  if (!r.round) return tr("loop.first");
  return r.rounds
    ? tr("loop.roundOf", { round: r.round, rounds: r.rounds })
    : tr("loop.round", { round: r.round });
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const SEVERITY_KEYS = {
  critical: "review.critical",
  high: "review.high",
  medium: "review.medium",
  low: "review.low",
} as const;

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
export function findingsLeft(task: Pick<Task, "review">): string | null {
  const r = task.review;
  // The CI step stopped before any review of this head: CI fails, nothing was reviewed.
  if (r?.loop === "ci-failed") return t("review.ciFailed");
  const last = r?.history.at(-1);
  if (!r || !["rounds-out", "stopped"].includes(r.loop) || !last?.blocking) return null;
  const parts: string[] = [];
  const comments = last.comments?.blocking ?? 0;
  let left = last.blocking - comments;
  for (const s of SEVERITIES) {
    const n = Math.min(last.counts[s] ?? 0, left);
    if (n) parts.push(t(SEVERITY_KEYS[s], { count: n }));
    left -= n;
    if (!left) break;
  }
  const after = last.round
    ? t("review.afterRounds", { count: last.round })
    : t("review.afterReview");
  const findings = last.blocking - comments;
  const found = findings
    ? t("review.findings", { count: findings, what: and(parts) || String(findings) })
    : null;
  const said = comments ? t("review.blockingComments", { count: comments }) : null;
  return t("review.left", { what: and([found, said].filter((p) => p !== null)), after });
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
  const parts = SEVERITIES.filter((s) => r.counts[s]).map((s) =>
    t(SEVERITY_KEYS[s], { count: r.counts[s]! }),
  );
  const { blocking = 0, notes = 0 } = r.comments ?? {};
  if (blocking) parts.push(t("review.blockingComments", { count: blocking }));
  if (notes) parts.push(t("review.notes", { count: notes }));
  if (r.followUps) parts.push(t("review.followUps", { count: r.followUps }));
  return parts.join(" · ") || t("review.noFindings");
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
  if (t.pr?.ci?.state === "failed" || t.review?.loop === "ci-failed") return tr("ready.ciFailed");
  if (t.pr?.conflict) return tr("ready.conflict");
  if (findingsLeft(t)) return tr("ready.findingsLeft");
  if (reviewOutdated(t)) return tr("ready.outdated");
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
export function taskStatus(t: Pick<Task, "state" | "pr" | "review" | "machine">): {
  tone: Tone;
  label: string;
} {
  const tone = toneOf(t.state);
  const label = machineLabel(t) ?? tr(STATE_NAMES[t.state]);
  // Queued or waiting: a run is on its way to its pull request, which says nothing yet.
  if (tone !== "idle" || t.state === "queued" || t.state === "waiting") return { tone, label };
  if (t.pr?.state === "merged") return { tone: "done", label };
  if (t.pr?.state !== "ready") return { tone, label };
  return readyStatus(t) ?? { tone: "run", label: tr(STATE_NAMES["in-review"]) };
}

export const taskTone = (t: Pick<Task, "state" | "pr" | "review" | "machine">) =>
  taskStatus(t).tone;

// The machine a machine task waits for or runs on (listener/claims.mjs): the one it sticks to,
// else the name or label asked for.
export const machineName = (m: TaskMachine) => m.machine ?? m.want;

// A machine task's state in words: "Waiting for desk" while queued and no machine holds it,
// "On desk" once one does; null for any other task, or state.
function machineLabel(t: Pick<Task, "state" | "machine">): string | null {
  const m = t.machine;
  if (!m) return null;
  if (t.state === "queued" && !m.claimed)
    return tr("state.waitingFor", { machine: machineName(m) });
  if (t.state === "working" && m.claimed) return tr("state.onMachine", { machine: machineName(m) });
  return null;
}

// A pull request ready for review whose loop is over (isReady()): its tone and word, as the
// task's (taskStatus()) and the Overview's rows have them; null otherwise.
export function readyStatus(t: Pick<Task, "pr" | "review">): { tone: Tone; label: string } | null {
  if (!isReady(t)) return null;
  const why = notClean(t);
  if (why) return { tone: "input", label: why };
  if (t.pr?.ci?.state === "running") return { tone: "run", label: tr("ready.waitingCi") };
  return { tone: "ready", label: tr(PR_NAMES.ready) };
}

export const isLive = (t: Task) =>
  ["scheduled", "building-image", "working", "stopping"].includes(t.state);

const KIND_NAMES: Record<string, Plain> = { pr: "kind.pr", discussion: "kind.discussion" };
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
  "chat",
];

export function kindName(t: Pick<Task, "kind">): string {
  if (t.kind === "brainstorm") return tr("kind.brainstorm");
  if (t.kind === "idea") return tr("kind.idea");
  if (t.kind === "bug") return tr("kind.bug");
  if (t.kind === "research") return tr("kind.research");
  return tr(KIND_NAMES[t.kind ?? ""] ?? "kind.issue");
}

// A run's kind as an analysis picks them (its `taskMode`): the task kinds' names, shorter for
// a bug, and the listener's own modes. A repo's own mode as it is.
const RUN_KIND_NAMES: Record<string, Plain> = {
  work: "runKind.work",
  bug: "runKind.bug",
  onboarding: "runKind.onboarding",
  analyze: "runKind.analyze",
  review: "runKind.review",
};

export function runKindName(kind: string): string {
  if (Object.hasOwn(RUN_KIND_NAMES, kind)) return t(RUN_KIND_NAMES[kind]);
  return ["brainstorm", "idea", "discussion", "research"].includes(kind)
    ? kindName({ kind: kind as Kind })
    : kind;
}

// A pull request's own task ("org/app#pr-12"), not the issue a pull request closes.
export const isPrTask = (t: Pick<Task, "key" | "number">) =>
  t.number !== null && t.key.endsWith(`#pr-${t.number}`);

// "app" for "org/app".
export const shortRepo = (repo: string) => repo.slice(repo.indexOf("/") + 1);

// "1 run", "3 runs"; `many` when adding an s won't do ("replies"). English only: what still
// calls it moves to t() (i18n.ts), whose catalogs have each language's plurals.
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The top bar's run count: "2 of 3 running". Auto-pickup's share is reservedText()'s.
export function runningText({
  running,
  maxParallel,
}: Pick<State, "running" | "maxParallel">): string {
  return t("slots.running", { running, max: maxParallel });
}

// One repo's run slots (State.repoSlots), null when the listener sends none for it.
export function repoSlotsOf(state: Pick<State, "repoSlots"> | null, repo: string | null) {
  if (!state?.repoSlots || !repo) return null;
  const name = Object.keys(state.repoSlots).find((r) => sameRepo(r, repo));
  return name ? state.repoSlots[name] : null;
}

// A repo's run slots: "1 of 2 running · 3 queued" against its own max_parallel, "1 running · of 4
// shared slots" against MAX_PARALLEL, which the other repos use too (not a quota of its own).
export function repoSlotsText({ running, queued, max, own }: RepoSlots): string {
  const used = own
    ? t("slots.running", { running, max })
    : t("slots.shared", { running, count: max });
  return queued ? `${used} · ${t("slots.queued", { count: queued })}` : used;
}

// Its meter's accessible name, the repo's in it.
export function repoSlotsLabel(repo: string, { running, max, own }: RepoSlots): string {
  return t(own ? "slots.repoLabel" : "slots.repoSharedLabel", { repo, running, max });
}

// Auto-pickup's reserved slots and how they are used: "1 auto-pickup slot (1 in use)", "… (free)",
// with how many of them picks hold while they aren't running (asking, between two loop steps:
// the sweep picks nothing for them); null when it is off.
export function reservedText(state: Pick<State, "autoPickup">): string | null {
  const slots = state.autoPickup?.slots;
  if (!slots) return null;
  const running = state.autoPickup?.running ?? 0;
  const held = heldText(state);
  const use = [running > 0 && t("slots.inUse", { count: running }), held].filter(
    (u) => typeof u === "string",
  );
  return t("slots.reserved", {
    count: slots,
    use: use.length ? use.join(t("list.comma")) : t("slots.free"),
  });
}

// "1 held between runs": the reserved slots picks hold while not running, or null.
export function heldText(state: Pick<State, "autoPickup">): string | null {
  const { running = 0, taken = 0 } = state.autoPickup ?? {};
  return taken > running ? t("slots.held", { count: taken - running }) : null;
}

// The mode a task runs in, where its kind doesn't say it already: an issue's or a pull
// request's ("work", "review"), else the repo's own mode only.
export function modeOf(t: Pick<Task, "kind" | "mode">): string | null {
  return t.kind === "issue" || t.kind === "pr" ? t.mode : ownMode(t.mode);
}

// A pull request in a row's line: "Draft #34", "PR #33" (ready), "merged #30"; and what
// that means, as its tooltip.
export function prName(pr: PullRequest): string {
  const { number } = pr;
  if (pr.state === "merged" && pr.autoMerged) return t("pr.nameAutoMerged", { number });
  const key = PR_NAME_KEYS[pr.state];
  return t(key, { number });
}

const PR_NAME_KEYS = {
  draft: "pr.nameDraft",
  ready: "pr.nameReady",
  merged: "pr.nameMerged",
  closed: "pr.nameClosed",
} as const;
const PR_TITLE_KEYS = {
  draft: "pr.titleDraft",
  ready: "pr.titleReady",
  merged: "pr.titleMerged",
  closed: "pr.titleClosed",
} as const;

export function prTitle(pr: PullRequest): string {
  const { number } = pr;
  return pr.state === "merged" && pr.autoMerged
    ? t("pr.titleAutoMerged", { number })
    : t(PR_TITLE_KEYS[pr.state], { number });
}

// The repo's own mode, if any: "audit".
export function ownMode(mode: string | null | undefined): string | null {
  return mode && !BUILT_IN_MODES.includes(mode) ? mode : null;
}

// What a task is called: its title, or its kind and number until the title is known.
export function titleOf(t: Task): string {
  return t.title ?? tr("task.untitled", { kind: kindName(t), number: t.number ?? "?" });
}

// "#12", "PR #3": the number as GitHub shows it.
export function numberOf(t: Pick<Task, "number" | "kind">): string {
  if (t.number === null) return "";
  return t.kind === "pr" ? tr("task.prNumber", { number: t.number }) : `#${t.number}`;
}

// `base`: the listener's GitHub (api/state's githubUrl), GitHub Enterprise's included.
export function githubUrl(t: Task, base: string): string | null {
  if (!t.repo || !t.replyTo) return null;
  const path = t.kind === "discussion" ? "discussions" : "issues";
  return `${base}/${t.repo}/${path}/${t.replyTo}`;
}

export function ago(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return t("time.secondsAgo", { n: Math.max(0, s) });
  if (s < 3600) return t("time.minutesAgo", { n: Math.round(s / 60) });
  if (s < 86400) return t("time.hoursAgo", { n: Math.round(s / 3600) });
  return new Date(ms).toLocaleDateString(locale());
}

// When something happened, by the clock: "today 14:31", "yesterday 18:40", "Oct 14, 09:30";
// without `words`, "14:31" today and the date on any other day.
export function dayTime(at: number, now: number, words = true): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  const day = new Date(now);
  if (d.toDateString() === day.toDateString()) return words ? t("time.today", { time }) : time;
  day.setDate(day.getDate() - 1);
  if (words && d.toDateString() === day.toDateString()) return t("time.yesterday", { time });
  const date = d.toLocaleDateString(locale(), { month: "short", day: "numeric" });
  return t("time.dayTime", { date, time });
}

// "3 d 4 h", "4 h 12 min", "12 min": how long the listener has been up, by the server's clock.
export function uptime(startedAt: number, now: number): string {
  const min = Math.max(0, Math.floor((now - startedAt) / 60000));
  if (min < 60) return t("time.upMinutes", { min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("time.upHours", { h, min: min % 60 });
  return t("time.upDays", { d: Math.floor(h / 24), h: h % 24 });
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
  return min < 60
    ? t("time.minutes", { min })
    : t("time.hoursMinutes", { h: Math.floor(min / 60), min: Math.round(min % 60) });
}

// What a row says besides its state: how long, until when, or how long ago.
export function when(t: Task, now: number): string {
  return ownWhen(t, now) ?? (t.updatedAt ? ago(t.updatedAt, now) : "");
}

// The full time behind when()'s "… ago", and its last run's start; null when it says another.
export function whenTitle(t: Task, now: number): string | null {
  if (ownWhen(t, now) !== null || !t.updatedAt) return null;
  const updated = dayTime(t.updatedAt, now);
  const last = t.runs[0];
  return last
    ? tr("when.updatedLastRun", { updated, started: dayTime(last.startedAt, now) })
    : tr("when.updated", { updated });
}

// A live, queued, waiting or brainstorm row's own text; null for the others, which say when
// they were last updated.
function ownWhen(t: Task, now: number): string | null {
  const last = t.runs[0];
  if (isLive(t) && last) return duration(last, now);
  if (t.state === "queued") return t.replyTo ? tr("when.reply", { number: t.replyTo }) : "";
  if (t.state === "waiting" && t.waitingFor?.length)
    return tr("when.after", { issues: issueList(t.waitingFor) });
  if (t.state === "brainstorm" && t.deadline) {
    return tr("when.idleIn", { min: Math.max(0, Math.ceil((t.deadline - now) / 60000)) });
  }
  if (t.state === "idle-brainstorm" && t.deadline)
    return tr("when.since", { ago: ago(t.deadline, now) });
  return null;
}

// "#77", "#77 and #80", "#77, #80 and #81".
export function issueList(numbers: number[]): string {
  return and(numbers.map((n) => `#${n}`));
}

// "Continue", "Wrap-up"…: what a run did, for its button in the run history.
export function runName(r: Run): string {
  const own = r.taskMode === "review" ? t("runName.review") : ownMode(r.taskMode);
  const what = (
    {
      start: "runName.start",
      continue: "runName.continue",
      restore: "runName.restore",
      "wrap-up": "runName.wrapUp",
    } as const
  )[r.mode ?? ""];
  const of = r.round && (r.rounds ?? 1) > 1 ? { round: r.round, rounds: r.rounds! } : null;
  const fix = of ? t("runName.reviewFixOf", of) : t("runName.reviewFix");
  const ci = of ? t("runName.ciFixOf", of) : t("runName.ciFix");
  const why =
    { conflict: t("runName.conflict"), "review-fix": fix, "ci-fix": ci }[r.reason ?? ""] ?? null;
  return [why, own, t(what ?? "runName.run")].filter(Boolean).join(" · ");
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
export const REPO_LABELS: Record<RepoStatus, Plain> = {
  configured: "repoStatus.configured",
  invalid: "repoStatus.invalid",
  onboarding: "repoStatus.onboarding",
  "not-onboarded": "repoStatus.notOnboarded",
  unknown: "repoStatus.unknown",
};

// "#12 · Fix the queue" shortened to `max` characters, to fit a graph node.
export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
