// What the Overview counts (docs/design/dashboard-redesign.md › Pages › Overview): what waits
// on you across repositories, the totals, and each repository's tasks by tone and its lanes.
import { graphOf } from "./graphModel";
import { lanesOf } from "./lanes";
import { isReady, isSettled, plural, sameRepo, type Tone, taskTone } from "./format";
import type { Blocker, Edge, Task } from "./types";

// Why a task waits on you, and the one action its row offers.
export type Need = "input" | "turn" | "ready" | "error";

export interface Waiting {
  task: Task;
  need: Need;
  // Since when it waits: its state's, or its pull request's turning ready.
  at: number;
}

// The tasks waiting on you, oldest first: open questions, a brainstorm's turn, a failed run
// (unless isSettled()), a pull request ready for review (once nothing runs on it). One row per task: what asks
// first, then what failed.
export function waitingOnYou(tasks: Task[]): Waiting[] {
  const rows: Waiting[] = [];
  for (const task of tasks) {
    const need = needOf(task);
    if (!need) continue;
    const at = need === "ready" ? (task.pr?.readyAt ?? task.since) : task.since;
    rows.push({ task, need, at });
  }
  return rows.sort((a, b) => a.at - b.at || a.task.key.localeCompare(b.task.key));
}

function needOf(t: Task): Need | null {
  if (t.state === "needs-input") return "input";
  if (t.state === "brainstorm") return "turn";
  const tone = taskTone(t);
  // A failure dismissed with its pull request still ready waits for the review alone.
  if (tone === "err" && !isSettled(t)) return "error";
  if ((tone === "ready" || tone === "err") && isReady(t)) return "ready";
  return null;
}

// Ended tasks count on a repository's card for a week: "3 done this week".
export const WEEK_MS = 7 * 24 * 3600 * 1000;

const ENDED: Task["state"][] = ["done", "cancelled"];

// The order of a card's bar and its words.
const ORDER: Tone[] = ["run", "input", "ready", "err", "idle", "done"];

export interface Part {
  tone: Tone;
  count: number;
  words: string;
}

// A repository's tasks by tone, for its bar ("2 running · 2 need you · 1 ready"). What ended
// over a week ago is left out; queued and idle ones share the idle tone, each with its word.
export function repoParts(tasks: Task[], now: number): Part[] {
  const counts = new Map<string, number>();
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const t of tasks) {
    if (ENDED.includes(t.state) && !isReady(t) && now - t.since > WEEK_MS) continue;
    const tone = taskTone(t);
    // A failure that no longer asks (isSettled()) isn't "failed" here either.
    if (tone === "err" && isSettled(t)) continue;
    add(tone === "idle" ? (["queued", "waiting"].includes(t.state) ? "queued" : "idle") : tone);
  }
  const words: Record<string, (n: number) => string> = {
    run: (n) => `${n} running`,
    input: (n) => `${n} ${n === 1 ? "needs" : "need"} you`,
    ready: (n) => `${n} ready`,
    err: (n) => `${n} failed`,
    queued: (n) => `${n} queued`,
    idle: (n) => `${n} idle`,
    done: (n) => `${n} done this week`,
  };
  const keys = ["run", "input", "ready", "err", "queued", "idle", "done"];
  return keys
    .filter((k) => counts.get(k))
    .map((k) => ({
      tone: (k === "queued" ? "idle" : k) as Tone,
      count: counts.get(k)!,
      words: words[k](counts.get(k)!),
    }))
    .sort((a, b) => ORDER.indexOf(a.tone) - ORDER.indexOf(b.tone));
}

// A repository's lanes: the chains of issues waiting for one another on its board (its graph
// as the board draws it, closed ones left out), as its Lanes view lists them (lanes.ts).
export function laneCount(repo: string, tasks: Task[], edges: Edge[], blockers: Blocker[]) {
  const mine = tasks.filter((t) => sameRepo(t.repo, repo));
  const graph = graphOf(mine, edges, blockers);
  return lanesOf(graph.nodes, graph.edges).lanes.length;
}

// "Backlog 12 · 4 lanes", "Backlog 100+", "2 lanes"; null: nothing known yet.
export function backlogLine(
  backlog: { count: number; more: boolean } | null | undefined,
  lanes: number,
): string | null {
  const parts = [
    backlog ? `Backlog ${backlog.count}${backlog.more ? "+" : ""}` : "",
    lanes ? plural(lanes, "lane") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

// "now", "12 min", "5 h", "3 d": how long a row has waited.
export function age(at: number, now: number): string {
  const min = Math.floor(Math.max(0, now - at) / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / (24 * 60))} d`;
}
