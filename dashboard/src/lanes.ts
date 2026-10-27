// The board's lanes' names (issue #306): each chain of waiting issues is a lane (the Lanes
// view, the phone board, Ctrl K), named from what the listener knows of its issues
// (State.lanes, listener/lanes.mjs), else after its first issue.
import type { LaneLabel, LaneSource } from "./types";

export interface LaneName {
  name: string;
  // "fallback": nothing names it, "#18 and 3 more".
  source: LaneSource | "fallback";
}

// Which wins when the issues of a lane disagree: a name a maintainer typed (the latest), then
// a parent's title, then an inbox's.
const RANK: LaneSource[] = ["user", "parent", "inbox"];

// The name of the lane of issues `keys`, its first issue first. `labels`: State.lanes.
export function laneName(keys: string[], labels: Record<string, LaneLabel> = {}): LaneName {
  const found = keys.flatMap((key) => (labels[key] ? [labels[key]] : []));
  let best: LaneLabel | null = null;
  for (const label of found) {
    if (!best) best = label;
    else {
      const rank = RANK.indexOf(label.source) - RANK.indexOf(best.source);
      const newer = label.source === "user" && (label.at ?? 0) > (best.at ?? 0);
      if (rank < 0 || (rank === 0 && newer)) best = label;
    }
  }
  if (best) return { name: best.name, source: best.source };
  return { name: fallbackName(keys), source: "fallback" };
}

// "#18 and 3 more", "#18" alone; a pull request's key ("org/app#pr-19") is "#19".
export function fallbackName(keys: string[]): string {
  if (!keys.length) return "";
  const first = `#${keys[0].slice(keys[0].lastIndexOf("#") + 1).replace(/^pr-/, "")}`;
  return keys.length > 1 ? `${first} and ${keys.length - 1} more` : first;
}

// The lanes of the board's `nodes`: each group of issues linked by `edges` ("/after"), in the
// order of its first node, and in the order it runs: an issue after what it waits for (the
// longest path; a cycle stays in the nodes' order). `alone`: the nodes no arrow touches.
export function lanesOf<N extends { key: string }>(
  nodes: N[],
  edges: { from: string; to: string }[],
): { lanes: N[][]; alone: N[] } {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const links = edges.filter((e) => e.from !== e.to && byKey.has(e.from) && byKey.has(e.to));
  const near = new Map(nodes.map((n) => [n.key, [] as string[]]));
  for (const e of links) {
    near.get(e.from)!.push(e.to);
    near.get(e.to)!.push(e.from);
  }
  const seen = new Set<string>();
  const lanes: N[][] = [];
  const alone: N[] = [];
  for (const n of nodes) {
    if (seen.has(n.key)) continue;
    if (!near.get(n.key)!.length) {
      alone.push(n);
      continue;
    }
    const group = new Set([n.key]);
    for (const k of group) for (const m of near.get(k)!) group.add(m);
    for (const k of group) seen.add(k);
    // Each issue a step after the furthest of what it waits for: at most one pass per issue.
    const step = new Map([...group].map((k) => [k, 0]));
    for (let i = 0; i < group.size; i++) {
      for (const e of links) {
        if (
          group.has(e.to) &&
          step.get(e.to)! < step.get(e.from)! + 1 &&
          step.get(e.from)! < group.size
        )
          step.set(e.to, step.get(e.from)! + 1);
      }
    }
    const order = nodes.filter((m) => group.has(m.key));
    lanes.push(
      order.sort(
        (a, b) => step.get(a.key)! - step.get(b.key)! || nodes.indexOf(a) - nodes.indexOf(b),
      ),
    );
  }
  return { lanes, alone };
}
