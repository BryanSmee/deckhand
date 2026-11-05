// A chat's conversation, from its runs' logs (logModel.ts): the owner's messages and the
// agent's answers as turns, what the agent did between them (its tool calls, the listener's
// notes) folded as activity, and each run's sandbox starting (setup, the image's build) as one
// fold. Its messages still on their way (listener/chats.mjs `pending`, and those just sent)
// after them. Then what the chat is doing now, in words: chatState().
import { type Item, logSections } from "./logModel";
import type { Chat, Entry, Phase, Run } from "./types";

export type Turn =
  | { kind: "you"; id: string; text: string; waiting?: "queued" | "sent" | "sending" }
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
// sandbox or a slot), those it took that no log shows yet (`held`, holdMessages()), and those
// sent that it hasn't answered yet.
export function waitingTurns(chat: Chat, sending: string[], held: string[] = []): Turn[] {
  const queued: Turn[] = chat.pending.map((p, i) => ({
    kind: "you",
    id: `pending:${p.queuedAt}:${i}`,
    text: p.text,
    waiting: "queued",
  }));
  const taken: Turn[] = held.map((text, i) => ({
    kind: "you",
    id: `held:${i}`,
    text,
    waiting: "sent",
  }));
  const sent: Turn[] = sending.map((text, i) => ({
    kind: "you",
    id: `sending:${i}`,
    text,
    waiting: "sending",
  }));
  return [...queued, ...taken, ...sent];
}

// How long a message that left `pending` stays shown before a log has it: a run takes it as it
// starts, and the chat's runs list that run at the next poll.
export const HOLD_MS = 15_000;

// A message on its way, held: its text, when it was last seen waiting (or sent), and the logged
// messages there were then (their turns' ids): only a later one can be it.
export interface Held {
  text: string;
  seen: number;
  before: string[];
}

// The held messages at `now`: those still in `pending` (seen again), those `sent` since (held
// from now), and the others until a logged message that came after them has their text (a
// delivery joins the messages it takes) or HOLD_MS has passed. `logged`: your turns in the
// logs. `shown`: the held messages that `pending` doesn't list, to show after it.
export function holdMessages(
  held: Held[],
  {
    now,
    pending,
    sent = [],
    logged,
  }: { now: number; pending: string[]; sent?: string[]; logged: { id: string; text: string }[] },
): { held: Held[]; shown: string[] } {
  const ids = logged.map((l) => l.id);
  // Loose on purpose: a delivery joins the messages it takes into one text, so a held message is
  // any later logged message's part. A short one ("ok") may go early, inside a longer one: it is
  // only held HOLD_MS anyway.
  const isLogged = (h: Held) =>
    logged.some((l) => !h.before.includes(l.id) && l.text.includes(h.text.trim()));
  // Each pending message takes one held message of its text, the oldest.
  const waiting = [...pending];
  const next: Held[] = [];
  for (const h of held) {
    const at = waiting.indexOf(h.text);
    if (at >= 0) {
      waiting.splice(at, 1);
      next.push({ ...h, seen: now });
    } else if (now - h.seen <= HOLD_MS && !isLogged(h)) next.push(h);
  }
  for (const text of [...waiting, ...sent]) next.push({ text, seen: now, before: ids });
  // Shown apart from `pending`: the held ones it doesn't list, one per pending message of
  // their text taken out.
  const listed = [...pending];
  const shown: string[] = [];
  for (const h of next) {
    const at = listed.indexOf(h.text);
    if (at >= 0) listed.splice(at, 1);
    else shown.push(h.text);
  }
  return { held: next, shown };
}

// The chat's runs since its last reset, which dropped its session: the others are another
// conversation's, as far as the agent knows.
export const runsSinceReset = (chat: Chat) =>
  chat.runs.filter((r) => chat.resetAt === null || r.startedAt >= chat.resetAt);

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
  // Its run not listed yet, or still in its setup or image build: in the session of a run
  // before it, unless a reset dropped that session.
  const before = runsSinceReset(chat).filter((r) => r !== live).length;
  return before ? "resuming" : "starting";
}

// What the composer's line says of the chat now: a stopped chat with no run since its reset (or
// none at all) starts from a fresh clone; an agent at work may wait for your answer to its
// request for more permissions.
export function chatNote(chat: Chat, state: ChatState = chatState(chat)): string {
  if (state === "stopped" && !runsSinceReset(chat).length) {
    return "No sandbox now: your next message starts it, from a fresh clone of the repository.";
  }
  if (state === "working" && chat.requests.length) {
    return "The agent waits for your answer to its request above.";
  }
  return CHAT_STATES[state].note;
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
