// A chat's conversation (Chats.tsx): its runs' logs, oldest first, as turns (chatModel.ts):
// your messages and the agent's answers as bubbles, its tool calls folded between them with the
// run log's own items (Log.tsx ItemView), each run's sandbox starting as a fold of its own. Then
// your messages on their way (queued while the sandbox starts or resumes, or waits for a slot),
// what the chat does now, its agent's requests for more permissions waiting for you
// (PermissionCard.tsx), and the composer: Enter sends, Shift Enter adds a line. It follows the
// end as turns come, until you scroll up. A reset is marked where it dropped the session. Only
// the last RUNS_SHOWN runs stream their logs at first (a stream each): the earlier ones on
// demand.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { sendChatMessage, useRunLogs } from "./api";
import {
  CHAT_STATES,
  chatNote,
  chatState,
  type Held,
  holdMessages,
  runTurns,
  type Turn,
  waitingTurns,
} from "./chatModel";
import { dayTime } from "./format";
import { t } from "./i18n";
import type { Plain } from "./locales";
import { ItemView } from "./Log";
import { PermissionCard } from "./PermissionCard";
import { PHASE_TITLES, shortDuration } from "./logModel";
import type { Chat, Run } from "./types";
import { Button, IconButton } from "./ui/Button";
import { Fold } from "./ui/Fold";
import { Markdown } from "./ui/Markdown";
import * as Icon from "./ui/icons";
import { StatusDot } from "./ui/Status";
import styles from "./Conversation.module.css";

// Near enough to the end to keep following it.
const NEAR_END = 40;
// The runs shown at first, and how many more each Show earlier adds.
export const RUNS_SHOWN = 5;

interface Props {
  chat: Chat;
  now: number;
  touch?: boolean;
  // The chat as the listener answered a message.
  onChat: (chat: Chat) => void;
}

export function Conversation({ chat, now, touch, onChat }: Props) {
  const [shownRuns, setShownRuns] = useState(RUNS_SHOWN);
  const runs = chat.runs.slice(0, shownRuns).toReversed();
  const earlier = chat.runs.length - runs.length;
  const logs = useRunLogs(runs.map((r) => r.id));
  const [text, setText] = useState("");
  const [sending, setSending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The folds you opened or closed.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [following, setFollowing] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Messages seen waiting (or just sent): shown a while after they leave `pending`, until a
  // log has them (chatModel.ts holdMessages()).
  const held = useRef<Held[]>([]);

  const turns: Turn[] = [];
  // Where the last reset dropped the session, if a run had one: before the first run after it.
  const resetAt = chat.resetAt;
  let reset = resetAt === null || !chat.runs.some((r) => r.startedAt < resetAt);
  for (const run of runs) {
    if (!reset && run.startedAt >= resetAt!) {
      turns.push(resetTurn(resetAt!, now));
      reset = true;
    }
    turns.push(startTurn(run, now));
    turns.push(...runTurns(run, logs[run.id]?.entries ?? [], run.finishedAt ?? now));
  }
  if (!reset) turns.push(resetTurn(resetAt!, now));
  const logged = turns.flatMap((t) => (t.kind === "you" ? [{ id: t.id, text: t.text }] : []));
  const loggedNow = useRef(logged);
  loggedNow.current = logged;
  const hold = holdMessages(held.current, {
    now,
    pending: chat.pending.map((p) => p.text),
    logged,
  });
  held.current = hold.held;
  const waiting = waitingTurns(chat, sending, hold.shown);
  const all = [...turns, ...waiting];
  const state = chatState(chat);

  // The end in view as turns come, while following.
  const size =
    all.length +
    chat.requests.length +
    all.reduce((n, t) => n + ("items" in t ? t.items.length : 0), 0);
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
    // The logged messages before it: its own may stream in before the listener answers.
    const before = loggedNow.current;
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
    held.current = holdMessages(held.current, {
      now,
      pending: [],
      sent: [message],
      logged: before,
    }).held;
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
        <div class={styles.turns} role="log" aria-label={t("chats.conversation")}>
          {earlier > 0 && (
            <Button
              variant="ghost"
              size="small"
              class={styles.earlier}
              onClick={() => setShownRuns((n) => n + RUNS_SHOWN)}
            >
              {t("chats.showEarlier", { count: earlier })}
            </Button>
          )}
          {!all.length && <p class={styles.hint}>{t("chats.empty", { repo: chat.repo })}</p>}
          {all.map((turn) => (
            <TurnView key={turn.id} turn={turn} isOpen={isOpen} toggle={toggle} />
          ))}
          {chat.requests.map((request) => (
            <PermissionCard
              key={request.id}
              chatId={chat.id}
              request={request}
              now={now}
              onChat={onChat}
            />
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
          {chat.reachable ? chatNote(chat, state) : t("chats.unreachable")}
        </p>
        {error && (
          <p class={styles.failed} role="alert">
            {t("chats.notSent", { error })}
          </p>
        )}
        <div class={styles.row}>
          <textarea
            ref={box}
            class={styles.box}
            rows={1}
            aria-label={t("chats.message")}
            placeholder={t(chat.reachable ? "chats.messagePlaceholder" : "chats.noMessages")}
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
            label={t("chats.send")}
            title={t("chats.sendTitle")}
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
    text: t(resumed ? "chats.sandboxResumed" : "chats.sandboxStarted", {
      when: dayTime(run.startedAt, now),
    }),
  };
}

// A reset, at its time: the agent remembers nothing of the turns above it.
function resetTurn(at: number, now: number): Turn {
  return {
    kind: "note",
    id: `reset:${at}`,
    text: t("chats.chatReset", { when: dayTime(at, now) }),
  };
}

// What a message on its way says: sent from here, waiting in the listener's queue, or taken
// by a run whose log hasn't shown it yet. Keys: written when shown.
const WAITING: Record<"sending" | "queued" | "sent", Plain> = {
  sending: "chats.sending",
  queued: "chats.queued",
  sent: "chats.sent",
};

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
          {turn.waiting && <span class={styles.meta}>{t(WAITING[turn.waiting])}</span>}
        </div>
      );
    case "agent":
      return (
        <div class={`${styles.turn} ${styles.agent}`}>
          <Markdown class={styles.bubble} text={turn.text} />
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
      const title = tools
        ? t("chats.toolCalls", { count: tools })
        : t("chats.lines", { count: turn.items.length });
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
          title={
            turn.current
              ? t("chats.phaseNow", { phase: t(PHASE_TITLES[turn.phase]) })
              : t(PHASE_TITLES[turn.phase])
          }
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
