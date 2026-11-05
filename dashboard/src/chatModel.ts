// A chat's conversation, from its runs' logs (logModel.ts): the owner's messages and the
// agent's answers as turns, what the agent did between them (its tool calls, the listener's
// notes) folded as activity, and each run's sandbox starting (setup, the image's build) as one
// fold. Its messages still on their way (listener/chats.mjs `pending`, and those just sent)
// after them. Then what the chat is doing now, in words: chatState().
import { type Item, logSections } from "./logModel";
import type { Chat, Entry, Phase, Run } from "./types";

export type Turn =
  | { kind: "you"; id: string; text: string; waiting?: "queued" | "sending" }
  | { kind: "agent"; id: string; text: string }
  // The agent's tool calls between two turns, and the listener's or the agent's notes.
  | { kind: "activity"; id: string; items: Item[] }
  | { kind: "note"; id: string; text: string }
  // A part of a run before or after its work (its setup, its image's build): `current` while
  // the run is in it, `failed` when it went wrong.
  | {
      kind: "sandbox";
      id: string;
      phase: Phase;
      items: Item[];
      seconds: number;
      current: boolean;
      failed: boolean;
    }
  // A run that ended in error: its reason.
  | { kind: "error"; id: string; text: string };

// One run's turns: `entries`, its log so far; `end`, when it ended (now while it runs).
export function runTurns(run: Run, entries: Entry[], end: number): Turn[] {
  const live = run.status === "running";
  const turns: Turn[] = [];
  // The agent said something since the last message: its result repeats it.
  let said = false;
  const id = (item: Item) => `${run.id}:${item.id}`;
  // Its items' ids made the chat's: each run's log numbers its own from 0.
  const own = (item: Item): Item => ({ ...item, id: id(item) });
  for (const section of logSections(entries, end, live)) {
    const sandbox: Turn & { kind: "sandbox" } = {
      kind: "sandbox",
      id: `${run.id}:${section.phase}`,
      phase: section.phase,
      items: [],
      seconds: section.seconds ?? 0,
      current: section.current,
      failed: section.failed,
    };
    const work = section.phase === "work";
    for (const item of section.items) {
      if (item.kind === "message") {
        said = false;
        turns.push({ kind: "you", id: id(item), text: item.text });
      } else if (item.kind === "say") {
        said = true;
        turns.push({ kind: "agent", id: id(item), text: item.text });
      } else if (item.kind === "result") {
        // Its text repeats the agent's last words: shown when it said none (some agents).
        if (item.status === "error") {
          turns.push({ kind: "error", id: id(item), text: item.text || "The agent failed." });
        } else if (item.text.trim() && !said) {
          turns.push({ kind: "agent", id: id(item), text: item.text });
        }
        said = false;
      } else if (work && item.kind === "note") {
        turns.push({ kind: "note", id: id(item), text: item.text });
      } else if (!work) {
        if (!sandbox.items.length) turns.push(sandbox);
        sandbox.items.push(own(item));
      } else {
        const last = turns.at(-1);
        if (last?.kind === "activity") last.items.push(own(item));
        else turns.push({ kind: "activity", id: id(item), items: [own(item)] });
      }
    }
  }
  return turns;
}

// The messages still on their way, after the logs': the listener's `pending` (waiting for the
// sandbox or a slot), and those sent that it hasn't answered yet.
export function waitingTurns(chat: Chat, sending: string[]): Turn[] {
  const queued: Turn[] = chat.pending.map((p, i) => ({
    kind: "you",
    id: `pending:${p.queuedAt}:${i}`,
    text: p.text,
    waiting: "queued",
  }));
  const sent: Turn[] = sending.map((text, i) => ({
    kind: "you",
    id: `sending:${i}`,
    text,
    waiting: "sending",
  }));
  return [...queued, ...sent];
}

// What the chat does now, for its header and the composer's line: its word, its tone, and a
// sentence. "Starting" while its sandbox starts (again: "Resuming"), "Waiting for a slot" while
// its message waits for one of MAX_RUNNING_CHATS.
export type ChatState = "starting" | "resuming" | "waiting" | "working" | "idle" | "stopped";

export function chatState(chat: Chat): ChatState {
  if (chat.status === "idle") return "idle";
  if (chat.status === "stopped") return "stopped";
  if (chat.queued) return "waiting";
  const live = chat.runs.find((r) => r.status === "running");
  if (live && live.phase === "work") return "working";
  // Its run not listed yet, or still in its setup or image build.
  const before = chat.runs.filter((r) => r !== live).length;
  return before ? "resuming" : "starting";
}

export const CHAT_STATES: Record<
  ChatState,
  { label: string; tone: "run" | "idle" | "input" | "done"; note: string }
> = {
  starting: {
    label: "Starting",
    tone: "run",
    note: "Its sandbox starts: a clone of the repository.",
  },
  resuming: {
    label: "Resuming",
    tone: "run",
    note: "Its sandbox starts again, in the same session.",
  },
  waiting: {
    label: "Waiting for a slot",
    tone: "input",
    note: "Other chats' sandboxes take every slot: it starts when one is free.",
  },
  working: { label: "Running", tone: "run", note: "The agent is on it." },
  idle: { label: "Idle", tone: "done", note: "Its sandbox waits for your next message." },
  stopped: {
    label: "Stopped",
    tone: "idle",
    note: "No sandbox now: your next message starts it again, where the chat left off.",
  },
};
