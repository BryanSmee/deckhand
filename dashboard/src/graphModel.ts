// The graph page's model: what each issue looks like, and where it goes: the graph, or the
// Brainstorm column beside it (brainstormsOf()). Where each node is drawn: graphLayout.ts.
import { inChip, STATE_NAMES } from "./format";
import type { Backlog, Blocker, Edge, Pending, PrState, Task } from "./types";

// What a node looks like: the graph's own families, not the list's (format.ts toneOf()).
// Purple, GitHub's colour for merged, stays out: merged is implemented, green. "pending": an
// action on it is on its way to the listener; not in the legend, it lasts a few seconds.
// "input": questions wait for answers; "talk": a brainstorm waits for its next comment.
export type Look = "idle" | "input" | "talk" | "run" | "err" | "ready" | "done" | "pending";

export const LOOKS: { look: Look; name: string; means: string }[] = [
  { look: "idle", name: "Waiting", means: "for a blocker, queued, or nothing started" },
  { look: "input", name: "Needs input", means: "questions wait for your answers: click to answer" },
  { look: "talk", name: "Brainstorm", means: "waits for your next comment" },
  { look: "run", name: "Running", means: "being worked on" },
  { look: "err", name: "Error", means: "failed: what waits for it keeps waiting" },
  { look: "ready", name: "Ready for review", means: "its pull request" },
  { look: "done", name: "Implemented", means: "closed as completed, or merged" },
];

// An issue in the graph: a task on the board, or an issue one of them waits for.
export interface GraphNode {
  key: string;
  repo: string;
  number: number | null;
  kind: Task["kind"];
  title: string | null;
  look: Look;
  // What its aria-label and tooltip say about its state.
  status: string;
  closed: Task["closed"];
  // The board's task, which a click opens; null for a blocker not on the board.
  task: Task | null;
}

// What it does now wins over how it ended: a run on a closed issue is still a run. Questions
// win over a ready pull request (a follow-up run on it asked them), not over finished work.
export function lookOf(t: {
  state?: Task["state"] | null;
  closed: Task["closed"];
  pr?: { state: PrState; autoMerged?: boolean } | null;
}): Look {
  if (t.state && ["building-image", "working", "stopping"].includes(t.state)) return "run";
  if (t.closed === "completed" || t.pr?.state === "merged") return "done";
  if (t.state === "needs-input") return "input";
  if (t.pr?.state === "ready") return "ready";
  if (t.state === "brainstorm" || t.state === "idle-brainstorm") return "talk";
  if (t.state === "error" || t.state === "interrupted") return "err";
  return "idle";
}

function statusOf(
  look: Look,
  t: {
    state?: Task["state"] | null;
    closed: Task["closed"];
    pr?: { state: PrState; autoMerged?: boolean } | null;
  },
) {
  // Merged with no human review: the graph says so, for a maintainer looking for them later.
  if (look === "done" && t.pr?.state === "merged" && t.pr.autoMerged) return "Merged by Deckhand";
  if (look === "done") return t.closed === "completed" ? "Implemented" : "Merged";
  if (look === "ready") return "Ready for review";
  if (look === "input" && t.pr?.state === "ready") return "Needs input, PR ready";
  if (t.closed === "not_planned") return "Closed, not planned";
  // "Done" in the list: its last run replied, which isn't implemented.
  if (t.state === "done") return "Run done";
  return t.state ? STATE_NAMES[t.state] : "Open";
}

// Never on the graph: inbox runs and discussions have no pull request and no "/after"; the
// issues an inbox files show once someone works on them.
const NOT_WORK: Task["kind"][] = ["idea", "bug", "discussion"];

// A brainstorm, from a reply on its way to its wrap-up: in the Brainstorm column, not on the
// graph. Its kind says it until "/stop", its mode after (board.mjs).
const BRAINSTORMING: Task["state"][] = [
  "queued",
  "building-image",
  "working",
  "stopping",
  "brainstorm",
  "idle-brainstorm",
];
const brainstorming = (t: Task) =>
  (t.kind === "brainstorm" || t.mode === "brainstorm") && BRAINSTORMING.includes(t.state);

// A brainstorm that is over, wrapped up: its issue is back in the backlog, not on the graph.
const brainstormed = (t: Task) =>
  t.mode === "brainstorm" && ["done", "error", "interrupted", "cancelled"].includes(t.state);

// A card of the Brainstorm column. `task`: null for one just started from the backlog.
export interface BrainstormCard {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  task: Task | null;
  // An action on it is on its way: Sending….
  sending: boolean;
}

// Where issue `key` goes once the last action sent on it is done: a brainstorm started or
// stopped stays in the column, any other action takes it to the graph. Undefined: none sent.
function columnOnceSent(key: string, pending: Pending[]): boolean | undefined {
  const p = pending.filter((p) => `${p.repo}#${p.number}` === key).at(-1);
  if (!p) return undefined;
  return p.action === "stop" || (p.action === "start" && p.mode === "brainstorm");
}

// The Brainstorm column's cards, in the board's order (most recent first): `tasks`' brainstorms
// as they will be once `pending` is done. One started from the backlog shows at once.
export function brainstormsOf(tasks: Task[], pending: Pending[] = []): BrainstormCard[] {
  const sent = (key: string) => pending.some((p) => `${p.repo}#${p.number}` === key);
  const cards: BrainstormCard[] = tasks
    .filter((t) => t.number !== null && (columnOnceSent(t.key, pending) ?? brainstorming(t)))
    .map((t) => ({
      key: t.key,
      repo: t.repo,
      number: t.number!,
      title: t.title,
      task: t,
      sending: sent(t.key),
    }));
  const known = new Set(tasks.map((t) => t.key));
  for (const p of pending) {
    const key = `${p.repo}#${p.number}`;
    if (known.has(key) || cards.some((c) => c.key === key) || !columnOnceSent(key, pending)) {
      continue;
    }
    cards.unshift({
      key,
      repo: p.repo,
      number: p.number,
      title: p.title,
      task: null,
      sending: true,
    });
  }
  return cards;
}

// The tasks and arrows as they will be once `pending` is done: a queued issue gets an arrow
// from what it waits for, a started one none, a parent laid out with its sub-issues ("plan")
// waits, its arrows the listener's to tell, a dequeued one leaves (unless it ran before:
// then it stays, without its arrows). A stopped brainstorm doesn't move. The keys it touches
// come back too.
function withPending(tasks: Task[], edges: Edge[], pending: Pending[]) {
  const touched = new Set<string>();
  for (const p of pending) {
    const key = `${p.repo}#${p.number}`;
    touched.add(key);
    if (p.action === "stop") continue;
    edges = edges.filter((e) => e.to !== key);
    const task = tasks.find((t) => t.key === key);
    if (p.action === "dequeue") {
      if (task && !task.runs.length) tasks = tasks.filter((t) => t !== task);
      continue;
    }
    if (p.action === "queue")
      edges = [...edges, { from: `${p.repo}#${p.after}`, to: key, kind: "after" }];
    if (task) continue;
    tasks = [
      ...tasks,
      {
        key,
        repo: p.repo,
        project: "",
        number: p.number,
        title: p.title,
        kind: "issue",
        mode: p.mode ?? null,
        replyTo: p.number,
        state: p.action === "start" ? "queued" : "waiting",
        since: 0,
        closed: null,
        pr: null,
        rerunnable: false,
        runs: [],
      },
    ];
  }
  return { tasks, edges, touched };
}

// Closed: implemented, or closed as not planned. A run on it isn't.
function isClosed(n: GraphNode): boolean {
  if (n.look === "run") return false;
  return n.look === "done" || n.closed === "not_planned";
}

// The nodes of `tasks` (one tab's, or all) and the issues they wait for, with the arrows
// between them. Brainstorms are the column's (brainstormsOf()), and those over the backlog's,
// unless an arrow touches them: what waits for one, or what it waits for, stays in sight.
// Closed ones are left out unless `showClosed`, or an issue waiting for one still runs; `hidden` counts them. A hidden node takes its arrows with it. `pending`: the
// actions on their way, drawn as done already, their nodes "Sending…"; `sending`: the keys of
// tasks whose answers are on their way, "Sending…" too.
export function graphOf(
  tasks: Task[],
  edges: Edge[],
  blockers: Blocker[],
  {
    showClosed = false,
    pending = [],
    sending: answered = [],
  }: { showClosed?: boolean; pending?: Pending[]; sending?: string[] } = {},
): { nodes: GraphNode[]; edges: Edge[]; hidden: number } {
  const real = new Set(tasks);
  const column = new Set(brainstormsOf(tasks, pending).map((c) => c.key));
  const expected = withPending(tasks, edges, pending);
  tasks = expected.tasks;
  edges = expected.edges;
  const linked = (key: string) => edges.some((e) => e.from === key || e.to === key);
  const elsewhere = (t: Task) =>
    column.has(t.key) || (brainstormed(t) && columnOnceSent(t.key, pending) === undefined);
  const nodes = new Map<string, GraphNode>();
  for (const t of tasks) {
    if (NOT_WORK.includes(t.kind)) continue;
    if (elsewhere(t) && !linked(t.key)) continue;
    const sending = expected.touched.has(t.key) || answered.includes(t.key);
    const look = sending ? "pending" : lookOf(t);
    nodes.set(t.key, {
      key: t.key,
      repo: t.repo,
      number: t.number,
      kind: t.kind,
      title: t.title,
      look,
      status: sending ? "Sending…" : statusOf(look, t),
      closed: t.closed,
      // Not on the board yet: nothing to open.
      task: real.has(t) ? t : null,
    });
  }
  const mine = edges.filter((e) => nodes.has(e.to));
  const others = new Map(blockers.map((b) => [b.key, b]));
  for (const e of mine) {
    if (nodes.has(e.from)) continue;
    const b = others.get(e.from);
    const at = e.from.lastIndexOf("#");
    const look = lookOf({ closed: b?.closed ?? null });
    nodes.set(e.from, {
      key: e.from,
      repo: b?.repo ?? e.from.slice(0, at),
      number: b?.number ?? (Number(e.from.slice(at + 1)) || null),
      kind: null,
      title: b?.title ?? null,
      look,
      status: statusOf(look, { closed: b?.closed ?? null }),
      closed: b?.closed ?? null,
      task: null,
    });
  }
  if (showClosed) return { nodes: [...nodes.values()], edges: mine, hidden: 0 };
  const runs = (key: string) => mine.some((e) => e.from === key && nodes.get(e.to)?.look === "run");
  const shown = [...nodes.values()].filter((n) => !isClosed(n) || runs(n.key));
  const keys = new Set(shown.map((n) => n.key));
  return {
    nodes: shown,
    edges: mine.filter((e) => keys.has(e.from) && keys.has(e.to)),
    hidden: nodes.size - shown.length,
  };
}

// An issue waiting for the maintainer ("Needs input": its questions, or a brainstorm's next
// comment, on the graph when an arrow touches it): starting it answers them first, or ends the
// brainstorm with a work run.
export const waitsForAnswers = (t: Task) =>
  inChip("input", t) && (t.kind === "issue" || t.kind === "brainstorm");

// A node a drag moves, on `repo`'s tab (none on All, or while its config has errors): only an
// issue's, and not what runs or ran. Those waiting for answers move whatever their last run was
// (a brainstorm's kind is "brainstorm"): not a pull request.
export const movable = (n: GraphNode, repo: string | null, blocked: boolean) =>
  !!repo &&
  !blocked &&
  n.look !== "pending" &&
  n.number !== null &&
  !!n.task &&
  (n.task.state === "waiting" ? n.kind === "issue" : waitsForAnswers(n.task));

// The work area's lists besides the backlog: the issues waiting for others, less those a
// Start or Remove on its way takes out of their wait; those waiting for answers, less those an
// action on its way takes (brainstorms are the column's).
export function workLists(tasks: Task[], pending: Pending[]) {
  const leaving = new Set(pending.filter((p) => p.action !== "queue").map((p) => p.number));
  const sent = new Set(pending.map((p) => p.number));
  return {
    waiting: tasks.filter(
      (t) => t.state === "waiting" && t.kind === "issue" && t.number && !leaving.has(t.number),
    ),
    answering: tasks.filter(
      (t) => waitsForAnswers(t) && t.state === "needs-input" && t.number && !sent.has(t.number),
    ),
  };
}

// Whether backlog issue `number` has open sub-issues: started or queued, it is laid out with
// them ("plan").
export const isParent = (backlog: Backlog | null, number: number) =>
  !!backlog?.issues.find((i) => i.number === number)?.subIssues;
