// A chat's conversation (Chats.tsx): its runs' logs, oldest first, as turns (chatModel.ts):
// your messages and the agent's answers as bubbles, its tool calls folded between them with the
// run log's own items (Log.tsx ItemView), each run's sandbox starting as a fold of its own. Then
// your messages on their way (queued while the sandbox starts or resumes, or waits for a slot),
// what the chat does now, and the composer: Enter sends, Shift Enter adds a line. It follows the
// end as turns come, until you scroll up.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { sendChatMessage, useRunLogs } from "./api";
import { CHAT_STATES, chatState, runTurns, type Turn, waitingTurns } from "./chatModel";
import { dayTime, plural } from "./format";
import { ItemView } from "./Log";
import { PHASE_TITLES, shortDuration } from "./logModel";
import type { Chat, Run } from "./types";
import { IconButton } from "./ui/Button";
import { Fold } from "./ui/Fold";
import * as Icon from "./ui/icons";
import { StatusDot } from "./ui/Status";
import styles from "./Conversation.module.css";

// Near enough to the end to keep following it.
const NEAR_END = 40;
// How long a message that left `pending` stays shown before a log has it: a run takes it as it
// starts, and the chat's runs list it at the next poll.
const HOLD_MS = 15_000;

interface Props {
  chat: Chat;
  now: number;
  touch?: boolean;
  // The chat as the listener answered a message.
  onChat: (chat: Chat) => void;
}

export function Conversation({ chat, now, touch, onChat }: Props) {
  const runs = chat.runs.toReversed();
  const logs = useRunLogs(runs.map((r) => r.id));
  const [text, setText] = useState("");
  const [sending, setSending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The folds you opened or closed.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [following, setFollowing] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Messages seen waiting (or just sent), and when: shown a while after they leave `pending`,
  // until a log has them.
  const held = useRef(new Map<string, number>());

  const turns = runs.flatMap((run) => [
    startTurn(run, now),
    ...runTurns(run, logs[run.id]?.entries ?? [], run.finishedAt ?? now),
  ]);
  const logged = turns.flatMap((t) => (t.kind === "you" ? [t.text] : []));
  const at = Date.now();
  for (const p of chat.pending) held.current.set(p.text, at);
  for (const [said, seen] of held.current) {
    if (at - seen > HOLD_MS || logged.some((l) => l.includes(said.trim()))) {
      held.current.delete(said);
    }
  }
  const pending = chat.pending.map((p) => p.text);
  const kept = [...held.current.keys()].filter((t) => !pending.includes(t));
  const waiting = waitingTurns(
    { ...chat, pending: [...chat.pending, ...kept.map((t) => ({ text: t, queuedAt: 0 }))] },
    sending,
  );
  const all = [...turns, ...waiting];
  const state = chatState(chat);

  // The end in view as turns come, while following.
  const size = all.length + all.reduce((n, t) => n + ("items" in t ? t.items.length : 0), 0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [size, following, chat.status]);

  const isOpen = (id: string, fallback: boolean) => opened[id] ?? fallback;
  const toggle = (id: string, fallback: boolean) => (open: boolean) => {
    if (open !== isOpen(id, fallback)) setOpened((o) => ({ ...o, [id]: open }));
  };

  const send = async () => {
    const message = text;
    if (!message.trim() || !chat.reachable) return;
    setText("");
    setError(null);
    setFollowing(true);
    setSending((s) => [...s, message]);
    const said = await sendChatMessage(chat.id, message);
    setSending((s) => {
      const i = s.indexOf(message);
      return i < 0 ? s : [...s.slice(0, i), ...s.slice(i + 1)];
    });
    if (said.error) {
      setError(said.error);
      setText((current) => current || message);
      return;
    }
    // Delivered already, or queued: shown until its run's log has it.
    held.current.set(message, Date.now());
    onChat(said.chat);
  };

  // The box grows with its text, up to its CSS max-height.
  const grow = () => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(grow, [text]);

  const live = state === "starting" || state === "resuming" || state === "working";
  return (
    <div class={styles.conversation}>
      <div
        class={styles.scroll}
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END);
        }}
      >
        <div class={styles.turns} role="log" aria-label="Conversation">
          {!all.length && (
            <p class={styles.hint}>
              Ask anything about {chat.repo}: your first message starts its sandbox.
            </p>
          )}
          {all.map((turn) => (
            <TurnView key={turn.id} turn={turn} isOpen={isOpen} toggle={toggle} />
          ))}
        </div>
      </div>
      <form
        class={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <p class={styles.state} role="status">
          <StatusDot tone={CHAT_STATES[state].tone} pulse={live} />
          {chat.reachable
            ? CHAT_STATES[state].note
            : "You can no longer run the agent on this repository: you can only delete this chat."}
        </p>
        {error && (
          <p class={styles.failed} role="alert">
            Not sent: {error}
          </p>
        )}
        <div class={styles.row}>
          <textarea
            ref={box}
            class={styles.box}
            rows={1}
            aria-label="Message"
            placeholder={chat.reachable ? "Message the agent" : "This chat takes no messages"}
            disabled={!chat.reachable}
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
              e.preventDefault();
              void send();
            }}
          />
          <IconButton
            type="submit"
            variant="primary"
            size={touch ? "touch" : "default"}
            label="Send"
            title="Send (Enter; Shift Enter adds a line)"
            icon={<Icon.Send size={touch ? 20 : 16} />}
            disabled={!chat.reachable || !text.trim()}
          />
        </div>
      </form>
    </div>
  );
}

// A run's start, between two of them: when, and whether it resumed the session.
function startTurn(run: Run, now: number): Turn {
  const resumed = run.mode === "continue" || run.mode === "restore";
  return {
    kind: "note",
    id: `${run.id}:start`,
    text: `${resumed ? "Sandbox resumed" : "Sandbox started"} ${dayTime(run.startedAt, now)}`,
  };
}

function TurnView({
  turn,
  isOpen,
  toggle,
}: {
  turn: Turn;
  isOpen: (id: string, fallback: boolean) => boolean;
  toggle: (id: string, fallback: boolean) => (open: boolean) => void;
}) {
  switch (turn.kind) {
    case "you":
      return (
        <div class={`${styles.turn} ${styles.you}`}>
          <p class={`${styles.bubble} ${turn.waiting ? styles.waiting : ""}`}>{turn.text}</p>
          {turn.waiting && (
            <span class={styles.meta}>
              {turn.waiting === "sending"
                ? "Sending…"
                : "Queued: the agent gets it once its sandbox is ready"}
            </span>
          )}
        </div>
      );
    case "agent":
      return (
        <div class={`${styles.turn} ${styles.agent}`}>
          <p class={styles.bubble}>{turn.text}</p>
        </div>
      );
    case "note":
      return <p class={styles.note}>{turn.text}</p>;
    case "error":
      return (
        <p class={styles.error} role="alert">
          {turn.text}
        </p>
      );
    case "activity": {
      const tools = turn.items.filter((i) => i.kind === "tool").length;
      const failed = turn.items.some(
        (i) =>
          (i.kind === "tool" && i.outputs.some((o) => o.error)) || (i.kind === "output" && i.error),
      );
      const title = tools ? plural(tools, "tool call") : plural(turn.items.length, "line");
      return (
        <Fold
          class={styles.fold}
          title={title}
          tone={failed ? "err" : "done"}
          open={isOpen(turn.id, false)}
          onToggle={toggle(turn.id, false)}
        >
          <div class={styles.items}>
            {turn.items.map((item) => (
              <ItemView key={item.id} item={item} isOpen={isOpen} toggle={toggle} />
            ))}
          </div>
        </Fold>
      );
    }
    case "sandbox": {
      const opens = turn.failed;
      return (
        <Fold
          class={styles.fold}
          title={turn.current ? `${PHASE_TITLES[turn.phase]}…` : PHASE_TITLES[turn.phase]}
          tone={turn.failed ? "err" : turn.current ? "run" : "done"}
          pulse={turn.current}
          meta={<span class={styles.mono}>{shortDuration(turn.seconds)}</span>}
          open={isOpen(turn.id, opens)}
          onToggle={toggle(turn.id, opens)}
        >
          <div class={styles.items}>
            {turn.items.map((item) => (
              <ItemView key={item.id} item={item} isOpen={isOpen} toggle={toggle} />
            ))}
          </div>
        </Fold>
      );
    }
  }
}
