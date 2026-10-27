// What the run log shows, from its entries: its sections (phases.ts), one per phase however
// often the run came back to it, each as items (a message, a tool call with its output, an
// image build step, the cached steps together…), what each item can be searched by, and the
// log as plain text for Copy and Download.
import { sections as phaseSections } from "./phases";
import type { Entry, Phase, StepStatus } from "./types";

// Starts the reply of a run that stopped to ask: for the listener, not for reading.
export const NEEDS_INPUT = "<!-- needs-input -->";

export interface Step {
  step: number;
  stage: string | null;
  name: string;
  status: StepStatus;
  seconds: number | null;
  error: string | null;
  output: string[];
}

export type Item = { id: string } & (
  | { kind: "say"; text: string }
  | { kind: "note"; text: string }
  | { kind: "raw"; text: string }
  | { kind: "tool"; name: string; text: string; outputs: { text: string; error: boolean }[] }
  // An output with no call before it.
  | { kind: "output"; text: string; error: boolean }
  | { kind: "result"; status: "ok" | "needs-input" | "error"; text: string; minutes: number }
  | { kind: "step"; step: Step }
  | { kind: "cached"; steps: Step[] }
);

export interface LogSection {
  phase: Phase;
  items: Item[];
  // Its time in all (s), each time the run was in it; null for a log without phases.
  seconds: number | null;
  failures: number;
  // The run is in it now.
  current: boolean;
}

export const PHASE_TITLES: Record<Phase, string> = {
  setup: "Setup",
  image: "Image build",
  work: "Work",
  push: "Push and pull request",
  "wrap-up": "Wrap-up",
};

export type Filter = "all" | "messages" | "tools" | "errors";

export const isError = (item: Item): boolean =>
  (item.kind === "tool" && item.outputs.some((o) => o.error)) ||
  (item.kind === "output" && item.error) ||
  (item.kind === "step" && item.step.status === "error") ||
  (item.kind === "result" && item.status === "error");

export function shown(item: Item, filter: Filter): boolean {
  if (filter === "messages") return item.kind === "say" || item.kind === "result";
  if (filter === "tools") return ["tool", "output", "step", "cached"].includes(item.kind);
  if (filter === "errors") return isError(item);
  return true;
}

// "#8 [build 2/4] RUN npm ci"
export const stepName = (s: Pick<Step, "step" | "stage" | "name">) =>
  `#${s.step} ${s.stage ? `[${s.stage}] ` : ""}${s.name}`;

// How a build step ended, as BuildKit says it ("DONE 41s"); "" while it runs.
export function stepStatus(s: Pick<Step, "status" | "seconds" | "error">): string {
  if (s.status === "done") return `DONE ${s.seconds}s`;
  if (s.status === "error") return `ERROR: ${s.error}`;
  return s.status === "running" ? "" : s.status.toUpperCase();
}

export const cachedLine = (steps: Step[]) =>
  steps.length === 1
    ? `${stepName(steps[0])} · CACHED`
    : `#${steps[0].step}–#${steps.at(-1)!.step} ${steps[0].name} … ${steps.at(-1)!.name} · CACHED`;

// A section's entries as items: a tool's outputs go with the call before it; an image build's
// steps once each, as the latest of their entries says, with their output, and the cached
// ones next to each other as one.
function itemsOf(phase: Phase, entries: Entry[]): Item[] {
  const out: Item[] = [];
  const steps = new Map<number, Step>();
  const id = () => `${phase}:${out.length}`;
  for (const e of entries) {
    const last = out.at(-1);
    if (e.kind === "output" && last?.kind === "tool") last.outputs.push(e);
    else if (e.kind === "tool") out.push({ id: id(), ...e, outputs: [] });
    else if (e.kind === "output") out.push({ id: id(), ...e });
    else if (e.kind === "text") out.push({ id: id(), kind: "say", text: e.text });
    else if (e.kind === "meta") out.push({ id: id(), kind: "note", text: e.text });
    else if (e.kind === "result")
      out.push({ id: id(), ...e, text: e.text.replace(NEEDS_INPUT, "").trim() });
    else if (e.kind === "step") {
      const known = steps.get(e.step);
      if (known) Object.assign(known, { ...e, output: known.output });
      else {
        const step: Step = { ...e, output: [] };
        steps.set(e.step, step);
        out.push({ id: id(), kind: "step", step });
      }
    } else if (e.kind === "raw") {
      const step = e.step === undefined ? undefined : steps.get(e.step);
      if (step) step.output.push(e.text);
      else
        out.push({
          id: id(),
          kind: "raw",
          text: e.step === undefined ? e.text : `#${e.step} ${e.text}`,
        });
    }
  }
  // Cached steps together, once their status is known.
  const merged: Item[] = [];
  for (const item of out) {
    const last = merged.at(-1);
    if (item.kind === "step" && item.step.status === "cached") {
      if (last?.kind === "cached") last.steps.push(item.step);
      else merged.push({ id: item.id, kind: "cached", steps: [item.step] });
    } else merged.push(item);
  }
  return merged;
}

// The log's sections, in the order the run first entered them. `end`: when the run ended, or
// now while it runs; `live`: it runs, and its last phase is the current section.
export function logSections(entries: Entry[], end: number, live: boolean): LogSection[] {
  const parts = phaseSections(entries);
  const byPhase = new Map<Phase, { entries: Entry[]; seconds: number | null }>();
  parts.forEach((p, i) => {
    const until = parts[i + 1]?.at ?? end;
    const seconds = p.at === null ? null : Math.max(0, (until - p.at) / 1000);
    const known = byPhase.get(p.phase);
    if (known) {
      known.entries.push(...p.entries);
      if (known.seconds !== null && seconds !== null) known.seconds += seconds;
    } else byPhase.set(p.phase, { entries: [...p.entries], seconds });
  });
  const lastPhase = parts.at(-1)?.phase;
  return [...byPhase].map(([phase, { entries: own, seconds }]) => {
    const items = itemsOf(phase, own);
    return {
      phase,
      items,
      seconds,
      failures: items.filter(isError).length,
      current: live && phase === lastPhase,
    };
  });
}

// The texts an item shows, which search reads, in the order it shows them.
export function fields(item: Item): string[] {
  switch (item.kind) {
    case "tool":
      return [item.text, ...item.outputs.map((o) => o.text)];
    case "step":
      return [
        item.step.name,
        ...item.step.output,
        ...(item.step.error ? [stepStatus(item.step)] : []),
      ];
    case "cached":
      return [cachedLine(item.steps)];
    default:
      return [item.text];
  }
}

// How often `query` is in `text`, any case, without overlaps.
export function count(text: string, query: string): number {
  if (!query) return 0;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

export interface Match {
  section: Phase;
  item: string;
}

// Where `query` is, among the items the filter shows: each match in order, the index of the
// first match of each field (`<item id>:<field index>`), and how many each section and item
// has.
export interface Search {
  matches: Match[];
  starts: Map<string, number>;
  hits: Map<string, number>;
}

export function search(list: LogSection[], query: string, filter: Filter): Search {
  const found: Search = { matches: [], starts: new Map(), hits: new Map() };
  if (!query) return found;
  const add = (key: string, n: number) => found.hits.set(key, (found.hits.get(key) ?? 0) + n);
  for (const s of list) {
    for (const item of s.items) {
      if (!shown(item, filter)) continue;
      fields(item).forEach((text, i) => {
        const n = count(text, query);
        if (!n) return;
        found.starts.set(`${item.id}:${i}`, found.matches.length);
        for (let k = 0; k < n; k++) found.matches.push({ section: s.phase, item: item.id });
        add(s.phase, n);
        add(item.id, n);
      });
    }
  }
  return found;
}

// The log as text, for Copy and Download: each section under its title.
export function plainText(list: LogSection[]): string {
  const lines: string[] = [];
  for (const s of list) {
    lines.push(`== ${PHASE_TITLES[s.phase]} ==`);
    for (const item of s.items) {
      switch (item.kind) {
        case "tool":
          lines.push(`[${item.name}] ${item.text}`);
          for (const o of item.outputs) lines.push(indent(o.error ? `ERROR: ${o.text}` : o.text));
          break;
        case "step": {
          const status = stepStatus(item.step);
          lines.push(stepName(item.step) + (status ? ` · ${status}` : ""));
          for (const o of item.step.output) lines.push(indent(o));
          break;
        }
        case "cached":
          lines.push(cachedLine(item.steps));
          break;
        case "note":
          lines.push(`› ${item.text}`);
          break;
        case "result":
          lines.push(`${resultTitle(item)}\n${item.text}`);
          break;
        default:
          lines.push(item.text);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

const indent = (text: string) => text.replace(/^/gm, "    ");

export const resultTitle = (r: { status: string; minutes: number }) =>
  r.status === "error"
    ? "Failed"
    : `${r.status === "ok" ? "Done" : "Needs input"} in ${r.minutes} min`;

// "6s", "2m 14s", "1h 3m".
export function shortDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
