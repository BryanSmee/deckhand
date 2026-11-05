// Chats (#477): the user's own conversations with the agent on one of the repositories
// (listener/chats.mjs). The list, with how many they keep against the limit and New chat; the
// open chat's conversation (Conversation.tsx), its state and its menu (Reset, Delete, each
// asked first). On a phone the list and the conversation are separate screens, as a task's
// list and its detail are. What it reads is the chat's status and its runs' logs, nothing of its
// sandbox: a chat whose agent runs elsewhere shows the same way.
import { useEffect, useRef, useState } from "preact/hooks";
import { type NewChat, type Polled, createChat, deleteChat, resetChat } from "./api";
import { CHAT_STATES, chatState } from "./chatModel";
import { Conversation } from "./Conversation";
import { ago } from "./format";
import { formatRoute } from "./route";
import type { Chat, Chats as ChatList } from "./types";
import { Button, IconButton } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field } from "./ui/Field";
import * as Icon from "./ui/icons";
import { usePopup } from "./ui/popup";
import { StatusBadge, StatusDot } from "./ui/Status";
import styles from "./Chats.module.css";

interface Props {
  // api/chats, which App reads (api.ts useChats()): the sidebar counts them too.
  polled: Polled<ChatList>;
  // The chat open, from the address (route.ts #/chats/<id>).
  open: string | null;
  onOpen: (id: string | null) => void;
  now: number;
  touch?: boolean;
}

const chatHref = (id: string | null) =>
  formatRoute({ repo: null, task: null, run: null, page: "chats", chat: id });

// "3 of 4": the chats kept against CHATS_PER_USER.
export const keptText = (list: ChatList) => `${list.chats.length} of ${list.limit}`;

// Why New chat can't go, or null.
export function newChatProblem(list: ChatList | null): string | null {
  if (!list) return "Loading…";
  if (list.limit === 0) return "No chats here: CHATS_PER_USER is 0.";
  if (list.chats.length >= list.limit) {
    return `You keep ${keptText(list)} chats, the most you may: delete one to start another.`;
  }
  if (!list.repos.length) return "No repository lets you start a chat.";
  return null;
}

export function Chats({ polled, open, onOpen, now, touch }: Props) {
  const list = polled.data;
  const [creating, setCreating] = useState(false);
  const chat = (open && list?.chats.find((c) => c.id === open)) || null;
  // A chat just made or changed: shown as it answered, until the next poll.
  const shown = (next: Chat) =>
    polled.show((last) => {
      if (!last) return last;
      const others = last.chats.filter((c) => c.id !== next.id);
      return { ...last, chats: [next, ...others] };
    });
  const removed = (id: string) =>
    polled.show((last) => last && { ...last, chats: last.chats.filter((c) => c.id !== id) });

  return (
    <div class={`${styles.page} ${open ? styles.reading : ""}`}>
      <aside class={styles.side} aria-label="Your chats">
        <ChatsList
          list={list}
          error={polled.error}
          open={open}
          now={now}
          onNew={() => setCreating(true)}
        />
      </aside>
      <main class={styles.main}>
        {chat ? (
          <ChatView
            key={chat.id}
            chat={chat}
            now={now}
            touch={touch}
            onChat={shown}
            onBack={() => onOpen(null)}
            onDeleted={() => {
              removed(chat.id);
              onOpen(null);
            }}
          />
        ) : (
          <p class={styles.empty}>
            {open && list
              ? "No such chat: it was deleted, or it isn't yours."
              : list?.chats.length
                ? "Pick a chat, or start a new one."
                : "Start a chat to ask the agent about a repository, or to try things in a sandbox of its own. It can read the repository's issues and pull requests, but writes nothing on GitHub."}
          </p>
        )}
      </main>
      {creating && list && (
        <NewChatDialog
          list={list}
          onClose={() => setCreating(false)}
          onCreated={(next) => {
            setCreating(false);
            shown(next);
            onOpen(next.id);
          }}
        />
      )}
    </div>
  );
}

function ChatsList({
  list,
  error,
  open,
  now,
  onNew,
}: {
  list: ChatList | null;
  error: string | null;
  open: string | null;
  now: number;
  onNew: () => void;
}) {
  const problem = newChatProblem(list);
  return (
    <div class={styles.list}>
      <div class={styles.listHead}>
        <h1 class={styles.heading}>
          Chats
          {list && (
            <span class={styles.kept} title="The chats you keep, of the most you may">
              {keptText(list)}
            </span>
          )}
        </h1>
        <Button
          variant="primary"
          size="small"
          icon={<Icon.Plus />}
          disabled={!!problem}
          title={problem ?? undefined}
          onClick={onNew}
        >
          New chat
        </Button>
      </div>
      {list && problem && <p class={styles.limit}>{problem}</p>}
      {error && (
        <p class={styles.failed} role="alert">
          Can't read your chats ({error})
        </p>
      )}
      {!list && !error && <p class={styles.limit}>Loading…</p>}
      {list && !list.chats.length && <p class={styles.limit}>No chats yet.</p>}
      <ul class={styles.items}>
        {list?.chats.map((c) => {
          const state = CHAT_STATES[chatState(c)];
          return (
            <li key={c.id}>
              <a
                class={styles.item}
                href={chatHref(c.id)}
                aria-current={c.id === open ? "page" : undefined}
              >
                <StatusDot tone={state.tone} pulse={state.tone === "run"} label={state.label} />
                <span class={styles.itemTitle}>{c.title ?? "New chat"}</span>
                <span class={styles.itemMeta}>
                  {c.repo} · {ago(c.lastActiveAt, now)}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The open chat: its header (its way back on a phone, its title, repository and settings, its
// state, its menu), then the conversation and the composer.
function ChatView({
  chat,
  now,
  touch,
  onChat,
  onBack,
  onDeleted,
}: {
  chat: Chat;
  now: number;
  touch?: boolean;
  onChat: (chat: Chat) => void;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const state = CHAT_STATES[chatState(chat)];
  const [asking, setAsking] = useState<"reset" | "delete" | null>(null);
  const picks = [chat.agent, chat.model, chat.effort && `${chat.effort} effort`].filter(Boolean);
  return (
    <section class={styles.chat} aria-label={chat.title ?? "New chat"}>
      <header class={styles.chatHead}>
        {touch && (
          <IconButton
            variant="ghost"
            size="touch"
            label="Back to your chats"
            icon={<Icon.ChevronLeft size={20} />}
            onClick={onBack}
          />
        )}
        <div class={styles.chatTitle}>
          <h2>{chat.title ?? "New chat"}</h2>
          <span class={styles.context}>
            {chat.repo}
            {picks.length > 0 && ` · ${picks.join(" · ")}`}
          </span>
        </div>
        <StatusBadge
          tone={state.tone}
          label={state.label}
          pulse={state.tone === "run"}
          title={state.note}
        />
        <ChatMenu touch={touch} onPick={setAsking} />
      </header>
      <Conversation chat={chat} now={now} touch={touch} onChat={onChat} />
      {asking && (
        <ConfirmDialog
          chat={chat}
          what={asking}
          onClose={() => setAsking(null)}
          onDone={(next) => {
            setAsking(null);
            if (next) onChat(next);
            else onDeleted();
          }}
        />
      )}
    </section>
  );
}

// The chat's menu: Reset and Delete, each asked first (ConfirmDialog). Escape, Tab or a click
// elsewhere closes it (ui/popup.ts); arrows move through it.
function ChatMenu({
  touch,
  onPick,
}: {
  touch?: boolean;
  onPick: (what: "reset" | "delete") => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = () => box.current?.querySelector<HTMLElement>("[aria-haspopup]");
  const items = () => [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);
  usePopup(open, () => setOpen(false), {
    box,
    button,
    onKey: (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const all = items();
      const at = all.indexOf(document.activeElement as HTMLElement);
      all[(at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    },
  });
  const pick = (what: "reset" | "delete") => {
    // Focus back on the menu's button: the dialog gives it back there once closed.
    button()?.focus();
    setOpen(false);
    onPick(what);
  };
  return (
    <div class={styles.menuBox} ref={box}>
      <IconButton
        variant="ghost"
        size={touch ? "touch" : "small"}
        label="Chat menu"
        icon={<Icon.More size={touch ? 20 : 16} />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div class={styles.menu} role="menu" aria-label="Chat menu">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            class={styles.menuItem}
            onClick={() => pick("reset")}
          >
            <Icon.Reset size={15} />
            Reset…
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            class={`${styles.menuItem} ${styles.danger}`}
            onClick={() => pick("delete")}
          >
            <Icon.Trash size={15} />
            Delete…
          </button>
        </div>
      )}
    </div>
  );
}

const CONFIRM = {
  reset: {
    title: "Reset this chat?",
    sub: "Its sandbox stops, and its clone of the repository and the agent's session are dropped: what the agent changed there and what it remembers of this conversation are lost. The chat stays, and your next message starts from a fresh clone.",
    action: "Reset the chat",
    pending: "Resetting…",
  },
  delete: {
    title: "Delete this chat?",
    sub: "Its sandbox stops, and the chat goes with its clone of the repository, the agent's session and the whole conversation. This can't be undone.",
    action: "Delete the chat",
    pending: "Deleting…",
  },
};

function ConfirmDialog({
  chat,
  what,
  onClose,
  onDone,
}: {
  chat: Chat;
  what: "reset" | "delete";
  onClose: () => void;
  // The chat as reset, or null once deleted.
  onDone: (chat: Chat | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = CONFIRM[what];
  const go = async () => {
    setPending(true);
    setError(null);
    if (what === "reset") {
      const said = await resetChat(chat.id);
      setPending(false);
      if (said.error) return setError(said.error);
      return onDone(said.chat);
    }
    const said = await deleteChat(chat.id);
    setPending(false);
    if (said.error) return setError(said.error);
    onDone(null);
  };
  return (
    <Dialog
      alert
      icon={what === "reset" ? <Icon.Reset size={18} /> : <Icon.Trash size={18} />}
      title={text.title}
      sub={text.sub}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger-solid"
            pending={pending}
            pendingLabel={text.pending}
            onClick={() => void go()}
          >
            {text.action}
          </Button>
        </>
      }
    >
      {error && (
        <p class={styles.failed} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

// New chat: the repository (those whose `users` include you, with `runs:start:chat`), then
// the agent, model and effort (the repository's by default), and a first message, which starts
// its sandbox (none: the chat waits for one).
function NewChatDialog({
  list,
  onClose,
  onCreated,
}: {
  list: ChatList;
  onClose: () => void;
  onCreated: (chat: Chat) => void;
}) {
  const [form, setForm] = useState<NewChat>({
    repo: list.repos[0] ?? "",
    agent: null,
    model: null,
    effort: null,
    message: null,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<NewChat>) => setForm((f) => ({ ...f, ...patch }));
  const pick = (value: string) => (value === "" ? null : value);
  const problem = newChatProblem(list);
  const create = async () => {
    if (problem || pending || !form.repo) return;
    setPending(true);
    setError(null);
    const said = await createChat({ ...form, message: form.message?.trim() || null });
    setPending(false);
    if (said.error) return setError(said.error);
    onCreated(said.chat);
  };
  return (
    <Dialog
      title="New chat"
      sub="A sandbox of its own on the repository, read-only on GitHub. It stops after a while without a message, and starts again with the next one."
      onClose={onClose}
      onSubmit={() => void create()}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!!problem}
            pending={pending}
            pendingLabel="Starting…"
            onClick={() => void create()}
          >
            Start the chat
          </Button>
        </>
      }
    >
      <div class={styles.form}>
        {problem && <p class={styles.limit}>{problem}</p>}
        <Field
          as="select"
          label="Repository"
          value={form.repo}
          disabled={!list.repos.length}
          onChange={(e) => set({ repo: e.currentTarget.value })}
        >
          {list.repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Field>
        <div class={styles.picks}>
          <Field
            as="select"
            label="Agent"
            value={form.agent ?? ""}
            onChange={(e) => set({ agent: pick(e.currentTarget.value) })}
          >
            <option value="">The repository's</option>
            {list.agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.label}
              </option>
            ))}
          </Field>
          <Field
            as="select"
            label="Model"
            value={form.model ?? ""}
            onChange={(e) => set({ model: pick(e.currentTarget.value) })}
          >
            <option value="">The repository's</option>
            {list.models.map((m) => (
              <option key={m} value={m}>
                {m[0].toUpperCase() + m.slice(1)}
              </option>
            ))}
          </Field>
          <Field
            as="select"
            label="Effort"
            value={form.effort ?? ""}
            onChange={(e) => set({ effort: pick(e.currentTarget.value) })}
          >
            <option value="">The repository's</option>
            {list.efforts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Field>
        </div>
        <Field
          as="textarea"
          label="First message"
          help="Optional: it starts the sandbox. Ctrl Enter starts the chat."
          rows={4}
          value={form.message ?? ""}
          onInput={(e) => set({ message: e.currentTarget.value })}
        />
        {error && (
          <p class={styles.failed} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
