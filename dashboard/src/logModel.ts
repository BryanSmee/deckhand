// What the run log shows, from its entries: its sections (phases.ts), one per phase however
// often the run came back to it, each as items (a message, a tool call with its output, an
// image build step, the cached steps together…), what each item can be searched by, and the
// log as plain text for Copy and Download.
import { t } from "./i18n";
import type { Plain } from "./locales";
import { sections as phaseSections } from "./phases";
import type { Entry, Phase, StepStatus } from "./types";

// Starts the reply of a run that stopped to ask: for the listener, not for reading.
export const NEEDS_INPUT = "<!-- needs-input -->";

// The reply without the marker the listener reads (questions.mjs markerEnd()): at its start, or
// the first line that is the marker alone, outside code and before a numbered line. One quoted
// in a sentence or shown in a code block is the reply's text.
export function withoutMarker(text: string): string {
  const reply = text.trimStart();
  if (reply.startsWith(NEEDS_INPUT)) return reply.slice(NEEDS_INPUT.length).trim();
  const lines = reply.split("\n");
  let fenced = false;
  for (const [i, line] of lines.entries()) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    else if (fenced) continue;
    else if (line.trimEnd().replace(/^ {0,3}/, "") === NEEDS_INPUT) {
      lines.splice(i, 1);
      break;
    } else if (/^ ?\d{1,9}[.)]\s/.test(line)) break;
  }
  return lines.join("\n").trim();
}

export interface Step {
  step: number;
  stage: string | null;
  name: string;
  status: StepStatus;
  seconds: number | null;
  error: string | null;
  output: string[];
  // When it started (ms), if the log says.
  at?: number;
  // While it runs, or if the run ended with it running: for how long (timing()).
  time: Timing | null;
}

// Calls and steps that took less than this (s) show no time: the log stays quiet.
export const SLOW_SECONDS = 10;

// How long a tool call or a build step took: done, still running in a live run, or left
// running when the run ended (up to its end).
export interface Timing {
  seconds: number;
  state: "done" | "running" | "unfinished";
}

export interface Output {
  text: string;
  error: boolean;
  at?: number;
}

export type Item = { id: string } & (
  | { kind: "say"; text: string }
  // A chat owner's message.
  | { kind: "message"; text: string }
  | { kind: "note"; text: string }
  | { kind: "raw"; text: string }
  // `call`: the agent's id for it, which its outputs have too; `at`: when it came (ms).
  | {
      kind: "tool";
      name: string;
      text: string;
      call?: string;
      at?: number;
      outputs: Output[];
      time: Timing | null;
    }
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
  // Its commands and build steps that failed (isFailure()): counted, and opened by the "open
  // sections with errors" preference, but a command that exits non-zero is often expected.
  failures: number;
  // It went wrong (fails()): its dot is red.
  failed: boolean;
  // The run is in it now.
  current: boolean;
}

// Each phase's title's key, translated where it shows.
export const PHASE_TITLES: Record<Phase, Plain> = {
  setup: "log.phase.setup",
  image: "log.phase.image",
  work: "log.phase.work",
  push: "log.phase.push",
  "wrap-up": "log.phase.wrapUp",
};

export type Filter = "all" | "messages" | "tools" | "errors";

// A command or a build step that failed: what a section's badge counts.
export const isFailure = (item: Item): boolean =>
  (item.kind === "tool" && item.outputs.some((o) => o.error)) ||
  (item.kind === "output" && item.error) ||
  (item.kind === "step" && item.step.status === "error");

// What the Errors filter and Next error go through: failures, and a run that ended in error.
export const isError = (item: Item): boolean =>
  isFailure(item) || (item.kind === "result" && item.status === "error");

// Where a failed command or build step fails its section, not just itself: the image's build
// (a failed step stops it) and the push section (a refused push or a failed `gh pr` call may
// leave the pull request as it was). Elsewhere a command that exits non-zero is often expected.
export const failuresFail = (phase: Phase): boolean => phase === "image" || phase === "push";

// What makes a section fail: a failure where failuresFail(), or the agent ending in error.
export const fails = (phase: Phase, item: Item): boolean =>
  (failuresFail(phase) && isFailure(item)) || (item.kind === "result" && item.status === "error");

export function shown(item: Item, filter: Filter): boolean {
  if (filter === "messages") return ["say", "message", "result"].includes(item.kind);
  if (filter === "tools") return ["tool", "output", "step", "cached"].includes(item.kind);
  if (filter === "errors") return isError(item);
  return true;
}

// An MCP tool's name, `mcp__<server>__<tool>` whichever agent ran it, as its server and its
// tool; Playwright's without the `browser_` all of them start with. Null for the others
// (Bash, Read…).
export function toolLabel(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  const [, server, tool] = m;
  return { server, tool: server === "playwright" ? tool.replace(/^browser_/, "") : tool };
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

type ToolItem = Extract<Item, { kind: "tool" }>;

// A section's entries as items: a tool's outputs go with their call, by its id (`calls`: the
// log's, by id and by entry, as a call's output may come in the next section), else with the
// call before them;
// an image build's steps once each, as the latest of their entries says, with their output,
// and the cached ones next to each other as one.
// `ended`: calls that came whole (`done`), and those still without output when the agent's
// turn ended (a `result`): done, though their output never made it to the log.
interface Calls {
  byId: Map<string, ToolItem>;
  byEntry: Map<Entry, ToolItem>;
  ended: Set<ToolItem>;
}

function itemsOf(phase: Phase, entries: Entry[], calls: Calls): Item[] {
  const out: Item[] = [];
  const steps = new Map<number, Step>();
  const id = () => `${phase}:${out.length}`;
  for (const e of entries) {
    const last = out.at(-1);
    if (e.kind === "output") {
      const output: Output = {
        text: e.text,
        error: e.error,
        ...(e.at !== undefined && { at: e.at }),
      };
      // One with an id no call has (its call's line was cut) stands on its own.
      const call = e.id ? calls.byId.get(e.id) : last?.kind === "tool" ? last : null;
      if (call) call.outputs.push(output);
      else out.push({ id: id(), kind: "output", ...output });
    } else if (e.kind === "tool") {
      const { id: call, done: _, ...rest } = e;
      const item: ToolItem = { id: id(), ...rest, ...(call && { call }), outputs: [], time: null };
      if (call) calls.byId.set(call, item);
      if (e.done) calls.ended.add(item);
      calls.byEntry.set(e, item);
      out.push(item);
    } else if (e.kind === "text") out.push({ id: id(), kind: "say", text: e.text });
    else if (e.kind === "message") out.push({ id: id(), kind: "message", text: e.text });
    else if (e.kind === "meta") out.push({ id: id(), kind: "note", text: e.text });
    else if (e.kind === "result") {
      for (const call of calls.byEntry.values()) if (!call.outputs.length) calls.ended.add(call);
      out.push({ id: id(), ...e, text: withoutMarker(e.text) });
    } else if (e.kind === "step") {
      const known = steps.get(e.step);
      if (known) Object.assign(known, { ...e, output: known.output, at: known.at ?? e.at });
      else {
        const step: Step = { ...e, output: [], time: null };
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
  const calls: Calls = { byId: new Map(), byEntry: new Map(), ended: new Set() };
  const list = [...byPhase].map(([phase, { entries: own, seconds }]) => {
    const items = itemsOf(phase, own, calls);
    return {
      phase,
      items,
      seconds,
      failures: items.filter(isFailure).length,
      failed: items.some((i) => fails(phase, i)),
      current: live && phase === lastPhase,
    };
  });
  // The call the log ends with, if it does.
  const final = entries.findLast((e) => e.kind !== "phase");
  const lastCall = final && calls.byEntry.get(final);
  for (const s of list) {
    for (const item of s.items) {
      if (item.kind === "tool") {
        // Without an id, a call with no output only runs while nothing came after it: for some
        // agents (Antigravity), whether a call has one to come isn't known.
        const pending =
          !item.outputs.length && !calls.ended.has(item) && (!!item.call || item === lastCall);
        const to = item.outputs.at(-1)?.at ?? null;
        item.time = timing(item.at, to, { pending, end, live });
      } else if (item.kind === "step" && item.step.status === "running") {
        // A live run's build step runs while its build does.
        if (!live || s.current)
          item.step.time = timing(item.step.at, null, { pending: true, end, live });
      }
    }
  }
  return list;
}

// A call or step from `from` to `to` (ms), or, `pending`, still going: until `end` (now in a
// live run, else when it ended). Null when the log has no times, or when it took less than
// SLOW_SECONDS: an unfinished one shows whatever its time.
function timing(
  from: number | undefined,
  to: number | null,
  { pending, end, live }: { pending: boolean; end: number; live: boolean },
): Timing | null {
  if (from === undefined) return null;
  const until = pending ? end : to;
  if (until === null) return null;
  const seconds = Math.max(0, (until - from) / 1000);
  const state = !pending ? "done" : live ? "running" : "unfinished";
  if (state !== "unfinished" && seconds < SLOW_SECONDS) return null;
  return { seconds, state };
}

// A running call's or step's time, as a timer: "0:42", "12:05", "1:02:09".
export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const mm = `${Math.floor((s % 3600) / 60)}`;
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

// What a call or a step says of its time: "12s", "⏱ 0:42" while it runs, "4m 05s, unfinished".
export function timeLabel(time: Timing): string {
  if (time.state === "running") return `⏱ ${clock(time.seconds)}`;
  const took = shortDuration(time.seconds);
  return time.state === "unfinished" ? t("log.unfinished", { time: took }) : took;
}

// The texts an item shows, which search reads, in the order it shows them; an MCP call's full
// name last, as its icon only shows it on hover.
export function fields(item: Item): string[] {
  switch (item.kind) {
    case "tool":
      return [
        item.text,
        ...item.outputs.map((o) => o.text),
        ...(toolLabel(item.name) ? [item.name] : []),
      ];
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

// `query`, any case, as typed: no character of it is special. Global: reset lastIndex, or use
// it with matchAll() and replace().
export const matcher = (query: string) =>
  new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

// How often `query` is in `text`, any case, without overlaps.
export function count(text: string, query: string): number {
  return query ? [...text.matchAll(matcher(query))].length : 0;
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
    lines.push(`== ${t(PHASE_TITLES[s.phase])} ==`);
    for (const item of s.items) {
      switch (item.kind) {
        case "tool":
          lines.push(`[${item.name}] ${item.text}${item.time ? ` · ${timeLabel(item.time)}` : ""}`);
          for (const o of item.outputs) lines.push(indent(o.error ? `ERROR: ${o.text}` : o.text));
          break;
        case "step": {
          const status = stepStatus(item.step);
          const time = item.step.time ? ` · ${timeLabel(item.step.time)}` : "";
          lines.push(stepName(item.step) + (status ? ` · ${status}` : "") + time);
          for (const o of item.step.output) lines.push(indent(o));
          break;
        }
        case "cached":
          lines.push(cachedLine(item.steps));
          break;
        case "note":
          lines.push(`› ${item.text}`);
          break;
        case "message":
          lines.push(t("log.youSaid", { text: item.text }));
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
    ? t("log.resultFailed")
    : t(r.status === "ok" ? "log.resultDone" : "log.resultNeedsInput", { min: r.minutes });

// "6s", "2m 14s", "1h 3m".
export function shortDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return t("log.seconds", { s });
  if (s < 3600)
    return t("log.minutesSeconds", { m: Math.floor(s / 60), s: String(s % 60).padStart(2, "0") });
  return t("log.hoursMinutes", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
}
