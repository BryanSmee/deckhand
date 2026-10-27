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
