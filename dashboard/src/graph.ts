// The graph page's model: what each issue looks like, and where it goes. A layered layout
// drawn by hand: each issue that waits for others ("/after") goes in a column after theirs,
// left to right (top to bottom on a phone); issues with no arrow stand alone in a grid below.
import { STATE_NAMES } from "./format";
import type { Blocker, Edge, PrState, Task } from "./types";

// What a node looks like: the graph's own families, not the list's (format.ts toneOf()).
// Purple, GitHub's colour for merged, stays out: merged is implemented, green.
export type Look = "idle" | "input" | "run" | "err" | "ready" | "done";

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

// The nodes of `tasks` (one tab's, or all) and the issues they wait for, with the arrows
// between them.
export function graphOf(
  tasks: Task[],
  edges: Edge[],
  blockers: Blocker[],
): { nodes: GraphNode[]; edges: Edge[] } {
  const nodes = new Map<string, GraphNode>();
  for (const t of tasks) {
    const look = lookOf(t);
    nodes.set(t.key, {
      key: t.key,
      repo: t.repo,
      number: t.number,
      kind: t.kind,
      title: t.title,
      look,
      status: statusOf(look, t),
      task: t,
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
      task: null,
    });
  }
  return { nodes: [...nodes.values()], edges: mine };
}

// Sizes in SVG units (CSS pixels). A phone's columns are narrower: they sit side by side
// across its width.
export const SIZES = {
  wide: { w: 232, h: 56, layerGap: 56, rowGap: 16 },
  narrow: { w: 168, h: 56, layerGap: 40, rowGap: 12 },
};
// Between two groups of linked issues, and before the grid of the others.
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
  // Where the grid of issues without arrows starts; null when there are none.
  gridTop: number | null;
  width: number;
  height: number;
  w: number;
  h: number;
  // Between two columns (rows on a phone): where an arrow runs.
  gap: number;
}

// `keys` in the order they come (the board's: most recent first); `vertical`: a phone's
// top-to-bottom layout; `width`: what the page has, for the grid's columns.
export function layout(
  keys: string[],
  edges: { from: string; to: string }[],
  { vertical, width }: { vertical: boolean; width: number },
): Layout {
  const { w, h, layerGap, rowGap } = vertical ? SIZES.narrow : SIZES.wide;
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

  const boxes: Box[] = [];
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
        const along = l * (vertical ? h + layerGap : w + layerGap);
        const across = r * (vertical ? w + rowGap : h + rowGap);
        boxes.push(
          vertical ? { key: k, x: across, y: top + along } : { key: k, x: along, y: top + across },
        );
      });
    });
    // Groups go one under the other, whichever the direction.
    const extent = vertical
      ? layers.length * (h + layerGap) - layerGap
      : rows * (h + rowGap) - rowGap;
    top += extent + GROUP_GAP;
  }

  const alone = keys.filter((k) => !preds.get(k)!.length && !succs.get(k)!.length);
  const gridTop = alone.length ? top : null;
  const columns = Math.max(1, Math.floor((width + rowGap) / (w + rowGap)));
  alone.forEach((k, i) => {
    boxes.push({
      key: k,
      x: (i % columns) * (w + rowGap),
      y: top + Math.floor(i / columns) * (h + rowGap),
    });
  });

  const box = new Map(boxes.map((b) => [b.key, b]));
  const arrows = [...seen].map((pair) => {
    const [from, to] = pair.split(" ");
    const a = box.get(from)!;
    const b = box.get(to)!;
    // An elbow: out of the blocker, along the gap before the waiting issue's column, in.
    if (vertical) {
      const y1 = a.y + h;
      const mid = b.y - layerGap / 2;
      return { from, to, d: `M${a.x + w / 2} ${y1}V${mid}H${b.x + w / 2}V${b.y}` };
    }
    const x1 = a.x + w;
    const mid = b.x - layerGap / 2;
    return { from, to, d: `M${x1} ${a.y + h / 2}H${mid}V${b.y + h / 2}H${b.x}` };
  });

  const width_ = Math.max(0, ...boxes.map((b) => b.x + w));
  const height = Math.max(0, ...boxes.map((b) => b.y + h));
  return { boxes, arrows, gridTop, width: width_, height, w, h, gap: layerGap };
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
// (the gap below it, top to bottom) it lands in, where what waits for it goes. Null: dropped
// in the open, it starts (or stops waiting).
export function dropTarget(
  l: Pick<Layout, "boxes" | "w" | "h" | "gap">,
  vertical: boolean,
  x: number,
  y: number,
): string | null {
  const hit = l.boxes.find((b) =>
    vertical
      ? x >= b.x && x <= b.x + l.w && y >= b.y && y <= b.y + l.h + l.gap
      : x >= b.x && x <= b.x + l.w + l.gap && y >= b.y && y <= b.y + l.h,
  );
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
