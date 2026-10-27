// A run log's entries in sections, one per phase line the listener wrote (listener/runlog.mjs
// enterPhase()), with how many failures each has: what the run log folds into. A log from
// before phases is one work section; entries before the first phase line (the run's first
// line) go with the first section.
import type { Entry, Phase } from "./types";

export interface Section {
  phase: Phase;
  // When it started (ms), null for a log without phases.
  at: number | null;
  entries: Entry[];
  // Tool outputs with an error, image build steps that failed.
  failures: number;
}

export const isFailure = (e: Entry): boolean =>
  (e.kind === "output" && e.error) || (e.kind === "step" && e.status === "error");

export function sections(entries: Entry[]): Section[] {
  const out: Section[] = [];
  let leading: Entry[] = [];
  for (const e of entries) {
    if (e.kind === "phase") {
      out.push({ phase: e.phase, at: e.at, entries: leading, failures: 0 });
      leading = [];
      continue;
    }
    const current = out.at(-1);
    if (current) current.entries.push(e);
    else leading.push(e);
  }
  if (!out.length && leading.length)
    out.push({ phase: "work", at: null, entries: leading, failures: 0 });
  for (const s of out) s.failures = s.entries.filter(isFailure).length;
  return out;
}
