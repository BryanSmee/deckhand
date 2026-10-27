// A run log's entries in sections, one per phase line the listener wrote (listener/runlog.mjs
// enterPhase()): what the run log folds into (logModel.ts). A log from
// before phases is one work section; entries before the first phase line (the run's first
// line) go with the first section.
import type { Entry, Phase } from "./types";

export interface Section {
  phase: Phase;
  // When it started (ms), null for a log without phases.
  at: number | null;
  entries: Entry[];
}

export function sections(entries: Entry[]): Section[] {
  const out: Section[] = [];
  let leading: Entry[] = [];
  for (const e of entries) {
    if (e.kind === "phase") {
      out.push({ phase: e.phase, at: e.at, entries: leading });
      leading = [];
      continue;
    }
    const current = out.at(-1);
    if (current) current.entries.push(e);
    else leading.push(e);
  }
  if (!out.length && leading.length) out.push({ phase: "work", at: null, entries: leading });
  return out;
}
