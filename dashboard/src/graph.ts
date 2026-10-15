// The graph page's model: what each issue looks like, and where it goes: the graph, or the
// Brainstorm column beside it (brainstormsOf()). A layered layout
// drawn by hand: each issue that waits for others ("/after") goes in a column after theirs,
// left to right at every width; issues with no arrow stand alone in one column below, top to
// bottom in the board's order, like the list.
import { STATE_NAMES } from "./format";
import type { Blocker, Edge, PrState, Task, WorkAction } from "./types";

// What a node looks like: the graph's own families, not the list's (format.ts toneOf()).
// Purple, GitHub's colour for merged, stays out: merged is implemented, green. "pending": an
// action on it is on its way to the listener; not in the legend, it lasts a few seconds.
export type Look = "idle" | "input" | "run" | "err" | "ready" | "done" | "pending";

export const LOOKS: { look: Look; name: string; means: string }[] = [
  { look: "idle", name: "Waiting", means: "for a blocker, queued, or nothing started" },
  { look: "input", name: "Needs input", means: "a question or a brainstorm waits for you" },
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

// What it does now wins over how it ended: a run on a closed issue is still a run.
export function lookOf(t: {
  state?: Task["state"] | null;
  closed: Task["closed"];
  pr?: { state: PrState } | null;
}): Look {
  if (t.state && ["building-image", "working", "stopping"].includes(t.state)) return "run";
  if (t.closed === "completed" || t.pr?.state === "merged") return "done";
  if (t.pr?.state === "ready") return "ready";
  if (t.state && ["needs-input", "brainstorm", "idle-brainstorm"].includes(t.state)) {
    return "input";
  }
  if (t.state === "error" || t.state === "interrupted") return "err";
  return "idle";
}

function statusOf(look: Look, t: { state?: Task["state"] | null; closed: Task["closed"] }) {
  if (look === "done") return t.closed === "completed" ? "Implemented" : "Merged";
  if (look === "ready") return "Ready for review";
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
  t.mode === "brainstorm" && ["done", "error", "interrupted"].includes(t.state);

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

// A work area action sent and not confirmed yet (api.ts useWorkArea()): the graph shows what
// it will do at once.
export type Pending = WorkAction & { repo: string; title: string | null };

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
// from what it waits for, a started one none, a dequeued one leaves (unless it ran before:
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
        state: p.action === "queue" ? "waiting" : "queued",
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
// unless an arrow touches them: what waits for one, or what it waits for, stays in sight. Closed ones are left out unless `showClosed`, or an issue waiting for one
// still runs; `hidden` counts them. A hidden node takes its arrows with it. `pending`: the
// actions on their way, drawn as done already, their nodes "Sending…".
export function graphOf(
  tasks: Task[],
  edges: Edge[],
  blockers: Blocker[],
  { showClosed = false, pending = [] }: { showClosed?: boolean; pending?: Pending[] } = {},
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
    const sending = expected.touched.has(t.key);
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

// Sizes in SVG units (CSS pixels). A phone's columns are narrower: a short chain still fits
// its width, a longer one scrolls sideways.
export const SIZES = {
  wide: { w: 232, h: 56, layerGap: 56, rowGap: 16 },
  narrow: { w: 148, h: 56, layerGap: 28, rowGap: 12 },
};
// Between two groups of linked issues, and before the column of the others.
const GROUP_GAP = 32;

export interface Box {
  key: string;
  x: number;
  y: number;
}

export interface Layout {
  boxes: Box[];
  // An SVG path per arrow, ending at the waiting issue.
  arrows: { from: string; to: string; d: string }[];
  // Where the column of issues without arrows starts; null when there are none.
  gridTop: number | null;
  width: number;
  height: number;
  w: number;
  h: number;
  // Between two columns: where an arrow runs.
  gap: number;
}

// `keys` in the order they come (the board's: most recent first); `narrow`: a phone's smaller
// nodes. `prev`: the last drawing, whose places are kept where they still fit (settle()):
// adding or moving an issue doesn't move the others.
export function layout(
  keys: string[],
  edges: { from: string; to: string }[],
  { narrow }: { narrow: boolean },
  prev: Pick<Layout, "boxes" | "gridTop"> | null = null,
): Layout {
  const sizes = narrow ? SIZES.narrow : SIZES.wide;
  const { w, h, layerGap, rowGap } = sizes;
  const order = new Map(keys.map((k, i) => [k, i]));
  const preds = new Map<string, string[]>(keys.map((k) => [k, []]));
  const succs = new Map<string, string[]>(keys.map((k) => [k, []]));
  const seen = new Set<string>();
  for (const { from, to } of edges) {
    if (!order.has(from) || !order.has(to) || from === to || seen.has(`${from} ${to}`)) continue;
    seen.add(`${from} ${to}`);
    preds.get(to)!.push(from);
    succs.get(from)!.push(to);
  }
  const linked = keys.filter((k) => preds.get(k)!.length || succs.get(k)!.length);

  let boxes: Box[] = [];
  // Each linked issue's column, which settle() keeps the arrows' direction by.
  const layerOf = new Map<string, number>();
  let top = 0;
  for (const group of components(linked, preds, succs)) {
    const layers = layersOf(group, preds, order);
    // Across a column: the first one in the board's order, then each next column by where
    // what it waits for sits (fewer crossings).
    const at = new Map<string, number>();
    let rows = 0;
    for (const layer of layers) {
      const mid = (k: string) => {
        const placed = preds.get(k)!.filter((p) => at.has(p));
        return placed.length
          ? placed.reduce((s, p) => s + at.get(p)!, 0) / placed.length
          : Infinity;
      };
      layer.sort((a, b) => mid(a) - mid(b) || order.get(a)! - order.get(b)!);
      layer.forEach((k, i) => at.set(k, i));
      rows = Math.max(rows, layer.length);
    }
    layers.forEach((layer, l) => {
      layer.forEach((k, r) => {
        layerOf.set(k, l);
        boxes.push({ key: k, x: l * (w + layerGap), y: top + r * (h + rowGap) });
      });
    });
    // Groups go one under the other.
    top += rows * (h + rowGap) - rowGap + GROUP_GAP;
  }

  const alone = keys.filter((k) => !preds.get(k)!.length && !succs.get(k)!.length);
  let gridTop = alone.length ? top : null;
  alone.forEach((k, i) => boxes.push({ key: k, x: 0, y: top + i * (h + rowGap) }));

  // Nothing kept (the first drawing, another tab): laid out afresh.
  const keeps = prev?.boxes.some((b) => order.has(b.key));
  const kept = keeps && settle(keys, preds, succs, layerOf, prev!, sizes);
  if (kept) {
    boxes = kept.boxes;
    gridTop = alone.length ? kept.gridTop : null;
  }

  const box = new Map(boxes.map((b) => [b.key, b]));
  const arrows = [...seen].map((pair) => {
    const [from, to] = pair.split(" ");
    const a = box.get(from)!;
    const b = box.get(to)!;
    // An elbow: out of the blocker, along the gap before the waiting issue's column, in.
    const x1 = a.x + w;
    const mid = b.x - layerGap / 2;
    return { from, to, d: `M${x1} ${a.y + h / 2}H${mid}V${b.y + h / 2}H${b.x}` };
  });

  const width = Math.max(0, ...boxes.map((b) => b.x + w));
  const height = Math.max(0, ...boxes.map((b) => b.y + h));
  return { boxes, arrows, gridTop, width, height, w, h, gap: layerGap };
}

// The last drawing's places, kept for the issues they still fit: each one a column after what
// it waits for, none on another. The others get a place near theirs: after what they wait
// for, or in a free row of the column of issues without arrows.
function settle(
  keys: string[],
  preds: Map<string, string[]>,
  succs: Map<string, string[]>,
  layerOf: Map<string, number>,
  prev: Pick<Layout, "boxes" | "gridTop">,
  { w, h, layerGap, rowGap }: { w: number; h: number; layerGap: number; rowGap: number },
): { boxes: Box[]; gridTop: number } {
  const step = w + layerGap;
  const row = h + rowGap;
  // An arrow that closes a cycle goes backwards anyway: only the others are kept forward.
  const forward = (from: string, to: string) => layerOf.get(from)! < layerOf.get(to)!;

  const placed = new Map<string, Box>();
  const old = new Map(prev.boxes.map((b) => [b.key, b]));
  for (const k of keys) if (old.has(k)) placed.set(k, { ...old.get(k)!, key: k });
  // What now comes before what it waits for moves; until nothing does.
  for (let changed = true; changed;) {
    changed = false;
    for (const [k, b] of placed) {
      const late = preds
        .get(k)!
        .some((p) => forward(p, k) && placed.has(p) && placed.get(p)!.x + step > b.x);
      if (late) changed = placed.delete(k);
    }
  }
  const clash = (a: Box, b: Box) =>
    a.key !== b.key && Math.abs(a.x - b.x) < w + rowGap && Math.abs(a.y - b.y) < h + rowGap;
  const free = (b: Box) => ![...placed.values()].some((o) => clash(o, b));
  // Two on the same place (a phone's smaller nodes, say): the first one in the board's order
  // keeps it.
  for (const k of keys) {
    const b = placed.get(k);
    if (!b) continue;
    placed.delete(k);
    if (free(b)) placed.set(k, b);
  }

  const bottom = Math.max(-GROUP_GAP, ...[...placed.values()].map((b) => b.y + h));
  const gridTop = prev.gridTop ?? bottom + GROUP_GAP;
  // Column by column, in the board's order: what an issue waits for is placed before it. A
  // kept issue that would now come too soon after it moves too, and goes back in the list.
  const rest = keys.filter((k) => !placed.has(k));
  const layer = (k: string) => layerOf.get(k) ?? 0;
  while (rest.length) {
    rest.sort((a, b) => layer(a) - layer(b) || keys.indexOf(a) - keys.indexOf(b));
    const k = rest.shift()!;
    const before = preds.get(k)!.filter((p) => forward(p, k) && placed.has(p));
    const lo = before.length ? Math.max(...before.map((p) => placed.get(p)!.x + step)) : 0;
    let after = succs.get(k)!.filter((n) => forward(k, n) && placed.has(n));
    for (const n of after.filter((n) => placed.get(n)!.x < lo + step)) {
      placed.delete(n);
      rest.push(n);
    }
    after = after.filter((n) => placed.has(n));
    let b: Box | undefined;
    if (before.length || after.length) {
      // Next to what it is linked to: the same row first, then the nearest free one.
      const a = before.length ? lo : Math.min(...after.map((n) => placed.get(n)!.x - step));
      const c = Math.min(...(before.length ? before : after).map((n) => placed.get(n)!.y));
      for (let i = 0; !b; i++) {
        const offset = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * row;
        const at = { key: k, x: a, y: c + offset };
        if (c + offset >= 0 && free(at)) b = at;
      }
    } else {
      // On its own (or the first of new linked ones): the first free row of the column.
      for (let i = 0; !b; i++) {
        const at = { key: k, x: 0, y: gridTop + i * row };
        if (free(at)) b = at;
      }
    }
    placed.set(k, b);
  }
  return { boxes: keys.map((k) => placed.get(k)!), gridTop };
}

// The groups of issues linked to each other, in the board's order of their first issue.
function components(
  keys: string[],
  preds: Map<string, string[]>,
  succs: Map<string, string[]>,
): string[][] {
  const done = new Set<string>();
  const groups: string[][] = [];
  for (const start of keys) {
    if (done.has(start)) continue;
    const group: string[] = [];
    const stack = [start];
    done.add(start);
    while (stack.length) {
      const k = stack.pop()!;
      group.push(k);
      for (const n of [...preds.get(k)!, ...succs.get(k)!]) {
        if (!done.has(n)) {
          done.add(n);
          stack.push(n);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

// Columns: each issue one after the last of those it waits for (the longest path). Issues
// waiting for each other (a cycle of "/after"s) are placed in the board's order, the arrow
// that closes the cycle going backwards.
function layersOf(group: string[], preds: Map<string, string[]>, order: Map<string, number>) {
  const inGroup = new Set(group);
  const layer = new Map<string, number>();
  const left = [...group].sort((a, b) => order.get(a)! - order.get(b)!);
  while (left.length) {
    // The first issue whose blockers are all placed; else (a cycle) the first one left.
    const i = Math.max(
      0,
      left.findIndex((k) => preds.get(k)!.every((p) => !inGroup.has(p) || layer.has(p))),
    );
    const [k] = left.splice(i, 1);
    const placed = preds.get(k)!.filter((p) => layer.has(p));
    layer.set(k, placed.length ? Math.max(...placed.map((p) => layer.get(p)!)) + 1 : 0);
  }
  const layers: string[][] = [];
  for (const [k, l] of layer) (layers[l] ??= []).push(k);
  return layers.map((l) => l ?? []);
}

// "#12 · Fix the queue" shortened to fit a node; a pull request's "PR #3".
export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// The issue a drop at (x, y) queues after: the one it lands on, or the one whose right side
// it lands in, where what waits for it goes. Null: dropped in the open, it starts (or stops
// waiting).
export function dropTarget(
  l: Pick<Layout, "boxes" | "w" | "h" | "gap">,
  x: number,
  y: number,
): string | null {
  const hit = l.boxes.find((b) => x >= b.x && x <= b.x + l.w + l.gap && y >= b.y && y <= b.y + l.h);
  return hit?.key ?? null;
}

// The issue number a dragged GitHub link names, if it is one of `repo`'s issues (or pull
// requests): "https://github.com/org/app/issues/12", with GitHub Enterprise's own address.
export function issueOfLink(text: string, github: string, repo: string): number | null {
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim();
    if (!url || url.startsWith("#")) continue;
    const base = `${github.replace(/\/$/, "")}/${repo}/`.toLowerCase();
    if (!url.toLowerCase().startsWith(base)) continue;
    const match = /^(?:issues|pull)\/(\d+)(?:[/?#]|$)/.exec(url.slice(base.length));
    if (match) return Number(match[1]);
  }
  return null;
}
