// Where the Workflow graph's steps and arrows go (Workflow.tsx): a fixed grid, the steps by
// their `rank` (column) and `lane` (row), as listener/review-graph.mjs places them. The board's
// graphLayout.ts takes no cycles; this one draws the loops: an arrow between two steps of one
// column goes straight up or down, one to the next column straight across, one that skips a
// column over the top, and the others (loops back, steps of the lower row going on) under the
// grid, then up the gap before their step. Also which step a task's pull request is at
// (nodeOf()), and its real policy decisions over the sample's (withDecisions()).
import type {
  LoopState,
  PolicyDecision,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeId,
} from "./types";

export const NODE_W = 128;
export const NODE_H = 64;
const COL = 230; // a column's width: a step and the gap after it, its arrows' words in it
const ROW = 104; // a row's height
const TOP = 36; // room for the arrows over the top
const PAD = 12;
const BELOW = 18; // between two arrows under the grid

export interface PlacedNode extends WorkflowNode {
  x: number;
  y: number;
}

export interface PlacedEdge extends WorkflowEdge {
  d: string;
  // Where its words go, and which way they run from there.
  label: { x: number; y: number; anchor: "start" | "middle" | "end" };
}

export interface Layout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

export function layoutWorkflow({ nodes, edges }: Workflow): Layout {
  const placed = nodes.map((n) => ({ ...n, x: PAD + n.rank * COL, y: TOP + n.lane * ROW }));
  const at = new Map(placed.map((n) => [n.id, n]));
  const lanes = Math.max(1, ...nodes.map((n) => n.lane + 1));
  const ranks = Math.max(1, ...nodes.map((n) => n.rank + 1));
  const bottom = TOP + (lanes - 1) * ROW + NODE_H;
  // The gap before column `rank`, halfway between it and the one before.
  const gap = (rank: number) => PAD + rank * COL - (COL - NODE_W) / 2;
  let under = 0;
  const out: PlacedEdge[] = [];
  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    const midX = (n: PlacedNode) => n.x + NODE_W / 2;
    const midY = (n: PlacedNode) => n.y + NODE_H / 2;
    let d: string;
    let label: PlacedEdge["label"];
    if (a.rank === b.rank) {
      // Up or down one column: down on its left, up on its right, so a loop's two don't meet.
      const down = b.lane > a.lane;
      const x = midX(a) + (down ? -14 : 14);
      const [y1, y2] = down ? [a.y + NODE_H, b.y] : [a.y, b.y + NODE_H];
      d = `M${x},${y1} V${y2}`;
      label = { x: x + (down ? -6 : 6), y: (y1 + y2) / 2 + 4, anchor: down ? "end" : "start" };
    } else if (b.rank === a.rank + 1 && a.lane === b.lane) {
      d = `M${a.x + NODE_W},${midY(a)} H${b.x}`;
      label = { x: (a.x + NODE_W + b.x) / 2, y: midY(a) - 6, anchor: "middle" };
    } else if (b.rank > a.rank && a.lane === b.lane && a.lane === 0) {
      // Over the steps it skips.
      const y = TOP - 16;
      d = `M${midX(a) + 20},${a.y} V${y} H${midX(b) - 20} V${b.y}`;
      label = { x: (midX(a) + midX(b)) / 2, y: y - 4, anchor: "middle" };
    } else if (b.rank > a.rank && b.lane > a.lane) {
      // Down to a lower step further on: along the gap before it.
      const x = gap(b.rank);
      d = `M${a.x + NODE_W},${a.y + NODE_H * 0.75} H${x} V${midY(b)} H${b.x}`;
      label = { x: x + 6, y: (a.y + NODE_H * 0.75 + midY(b)) / 2 + 4, anchor: "start" };
    } else {
      // Under the grid: into the bottom of a step further on whose column has nothing under
      // it, else up the gap before the step, into its side.
      const y = bottom + 20 + under++ * BELOW;
      const from = `M${midX(a)},${a.y + NODE_H} V${y}`;
      const clear = b.rank > a.rank && !placed.some((n) => n.rank === b.rank && n.lane > b.lane);
      if (clear) {
        d = `${from} H${midX(b)} V${b.y + NODE_H}`;
      } else {
        const x = gap(b.rank);
        d = `${from} H${x} V${b.y + NODE_H * 0.75} H${b.x}`;
      }
      label = { x: (midX(a) + (clear ? midX(b) : gap(b.rank))) / 2, y: y - 4, anchor: "middle" };
    }
    out.push({ ...e, d, label });
  }
  return {
    width: PAD * 2 + (ranks - 1) * COL + NODE_W,
    height: bottom + 20 + under * BELOW + PAD,
    nodes: placed,
    edges: out,
  };
}

// Where each of reviewLoop()'s states is in the graph (listener/review-graph.mjs STATE_NODES).
export const STATE_NODES: Record<LoopState, WorkflowNodeId> = {
  reviewing: "review",
  fixing: "fix",
  checks: "merge",
  ci: "ci",
  "ci-fix": "ci-fix",
  rebasing: "rebase",
  "ci-failed": "done",
  clean: "done",
  "rounds-out": "done",
  fixed: "done",
  stopped: "done",
};

// The step a loop's state is at; an unknown state (a newer listener's) is at none.
export const nodeOf = (loop: string): WorkflowNodeId | null =>
  (STATE_NODES as Record<string, WorkflowNodeId>)[loop] ?? null;

// Which step a fix decision was about, from its input's `reason` (only the newest 3 keep their
// input): a fix run's, a CI fix run's or a conflict run's.
const FIX_NODES: Record<string, WorkflowNodeId> = {
  review: "fix",
  ci: "ci-fix",
  conflict: "rebase",
};

// The graph with pull request `pr`'s last real decisions (newest first, listener/decisions.mjs)
// over the sample's: a refused one makes its step refused, with its messages; an allowed one,
// on. The steps no decision was kept for keep the sample's state. → the graph, and the ids of
// the steps a real decision set.
export function withDecisions(
  workflow: Workflow,
  decisions: PolicyDecision[] | undefined,
  pr: number | null,
): { workflow: Workflow; real: Set<WorkflowNodeId> } {
  const last = new Map<WorkflowNodeId, PolicyDecision>();
  for (const d of decisions ?? []) {
    if (pr !== null && d.pr !== pr) continue;
    const reason = (d.input as { reason?: unknown } | null | undefined)?.reason;
    const id: WorkflowNodeId | null =
      d.decision === "review"
        ? "review"
        : d.decision === "merge"
          ? "merge"
          : d.decision === "fix"
            ? (FIX_NODES[String(reason ?? "review")] ?? null)
            : null;
    if (id && !last.has(id)) last.set(id, d);
  }
  const real = new Set<WorkflowNodeId>();
  const nodes = workflow.nodes.map((n) => {
    const d = last.get(n.id);
    // A step the settings turn off, or the grant refuses, stays so: no decision changes that.
    if (!d || n.state === "off" || (n.state === "refused" && !n.reasons.some((r) => r.layer))) {
      return n;
    }
    real.add(n.id);
    if (!d.denied) return { ...n, state: "on" as const, reasons: [] };
    const layer = d.layers?.find((l) => l.error || l.denies.length || l.allow === false)?.layer;
    return {
      ...n,
      state: "refused" as const,
      reasons: d.messages.map((message) => ({
        message,
        ...(layer === "repo" || layer === "operator" ? { layer } : {}),
      })),
    };
  });
  return { workflow: { ...workflow, nodes }, real };
}
