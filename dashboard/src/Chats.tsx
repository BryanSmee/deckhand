// Chats (#477): the user's own conversations with the agent on one of the repositories
// (listener/chats.mjs). The list, with how many they keep against the limit and New chat; the
// open chat's conversation (Conversation.tsx), its state and its menu (Reset, Delete, each
// asked first). On a phone the list and the conversation are separate screens, as a task's
// list and its detail are. What it reads is the chat's status and its runs' logs, nothing of its
// sandbox: a chat whose agent runs elsewhere shows the same way. On a repository's page
// (#/org/repo/chats) the list is that repository's chats, as its tasks are; on All, every one.
import { useEffect, useRef, useState } from "preact/hooks";
import { type NewChat, type Polled, createChat, deleteChat, resetChat } from "./api";
import { CHAT_STATES, chatState } from "./chatModel";
import { ChatPermissions } from "./ChatPermissions";
import { Conversation } from "./Conversation";
import { ago, sameRepo } from "./format";
import { t } from "./i18n";
import type { Plain } from "./locales";
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
  // The repository shown (null: All), whose chats are listed.
  repo: string | null;
  // The chat open, from the address (route.ts #/chats/<id>).
  open: string | null;
  // Opens a chat (null: the list) on that repository's page (null: All's).
  onOpen: (id: string | null, repo: string | null) => void;
  now: number;
  touch?: boolean;
}

const chatHref = (repo: string | null, id: string | null) =>
  formatRoute({ repo, task: null, run: null, page: "chats", chat: id });

// "3 of 4": the chats kept against CHATS_PER_USER.
export const keptText = (list: ChatList) =>
  t("chats.kept", { kept: list.chats.length, limit: list.limit });

// Why New chat can't go, or null.
export function newChatProblem(list: ChatList | null): string | null {
  if (!list) return t("chats.loading");
  if (list.limit === 0) return t("chats.noneAllowed");
  if (list.chats.length >= list.limit) {
    return t("chats.atLimit", { kept: list.chats.length, limit: list.limit });
  }
  if (!list.repos.length) return t("chats.noRepository");
  return null;
}

export function Chats({ polled, repo, open, onOpen, now, touch }: Props) {
  const list = polled.data;
  const [creating, setCreating] = useState(false);
  const listed = (repo ? list?.chats.filter((c) => sameRepo(c.repo, repo)) : list?.chats) ?? [];
  const chat = (open && listed.find((c) => c.id === open)) || null;
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
      <aside class={styles.side} aria-label={t("chats.yours")}>
        <ChatsList
          list={list}
          listed={listed}
          repo={repo}
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
            onBack={() => onOpen(null, repo)}
            onDeleted={() => {
              removed(chat.id);
              onOpen(null, repo);
            }}
          />
        ) : open && list?.chats.some((c) => c.id === open) ? null : (
          // (Another repository's chat: App moves the address to its repository's, no "No such
          // chat" meanwhile.)
          <p class={styles.empty}>
            {open && list
              ? repo
                ? t("chats.noSuchChatOn", { repo })
                : t("chats.noSuchChat")
              : listed.length
                ? t("chats.pick")
                : t("chats.intro")}
          </p>
        )}
      </main>
      {creating && list && (
        <NewChatDialog
          list={list}
          repo={repo}
          onClose={() => setCreating(false)}
          onCreated={(next) => {
            setCreating(false);
            shown(next);
            // On a repository's page, the new chat's: it may be another's.
            onOpen(next.id, repo && next.repo);
          }}
        />
      )}
    </div>
  );
}

// The chats listed (`listed`: the repository's, or all of them), under how many the user keeps
// of the most they may: all of them, the limit being theirs.
function ChatsList({
  list,
  listed,
  repo,
  error,
  open,
  now,
  onNew,
}: {
  list: ChatList | null;
  listed: Chat[];
  repo: string | null;
  error: string | null;
  open: string | null;
  now: number;
  onNew: () => void;
}) {
  const problem = newChatProblem(list);
  return (
    <div class={styles.list}>
      <div class={styles.listHead}>
        <h2 class={styles.heading}>
          {t("chats.yours")}
          {list && (
            <span class={styles.kept} title={t("chats.keptTitle")}>
              {keptText(list)}
            </span>
          )}
        </h2>
        <Button
          variant="primary"
          size="small"
          icon={<Icon.Plus />}
          disabled={!!problem}
          title={problem ?? undefined}
          onClick={onNew}
        >
          {t("chats.newChat")}
        </Button>
      </div>
      {list && problem && <p class={styles.limit}>{problem}</p>}
      {error && (
        <p class={styles.failed} role="alert">
          {t("chats.cantRead", { error })}
        </p>
      )}
      {!list && !error && <p class={styles.limit}>{t("chats.loading")}</p>}
      {list && !listed.length && (
        <p class={styles.limit}>{repo ? t("chats.noneOn", { repo }) : t("chats.none")}</p>
      )}
      <ul class={styles.items}>
        {listed.map((c) => {
          const state = CHAT_STATES[chatState(c)];
          return (
            <li key={c.id}>
              <a
                class={styles.item}
                href={chatHref(repo, c.id)}
                aria-current={c.id === open ? "page" : undefined}
              >
                <StatusDot tone={state.tone} pulse={state.tone === "run"} label={t(state.label)} />
                <span class={styles.itemTitle}>{c.title ?? t("chats.newChat")}</span>
                <span class={styles.itemMeta}>
                  {repo ? ago(c.lastActiveAt, now) : `${c.repo} · ${ago(c.lastActiveAt, now)}`}
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
  const [asking, setAsking] = useState<MenuPick | null>(null);
  const picks = [
    chat.agent,
    chat.model,
    chat.effort && t("chats.effort", { effort: chat.effort }),
  ].filter(Boolean);
  return (
    <section class={styles.chat} aria-label={chat.title ?? t("chats.newChat")}>
      <header class={styles.chatHead}>
        {touch && (
          <IconButton
            variant="ghost"
            size="touch"
            label={t("chats.back")}
            icon={<Icon.ChevronLeft size={20} />}
            onClick={onBack}
          />
        )}
        <div class={styles.chatTitle}>
          <h2>{chat.title ?? t("chats.newChat")}</h2>
          <span class={styles.context}>
            {chat.repo}
            {picks.length > 0 && ` · ${picks.join(" · ")}`}
          </span>
        </div>
        <StatusBadge
          tone={state.tone}
          label={t(state.label)}
          pulse={state.tone === "run"}
          title={t(state.note)}
        />
        <ChatMenu touch={touch} onPick={setAsking} />
      </header>
      <Conversation chat={chat} now={now} touch={touch} onChat={onChat} />
      {asking === "permissions" && (
        <Dialog
          wide
          // The panel has its own heading and explanation: the chat it is for, here.
          title={chat.title ?? t("chats.newChat")}
          sub={chat.repo}
          onClose={() => setAsking(null)}
          actions={
            <Button variant="ghost" onClick={() => setAsking(null)}>
              {t("chats.close")}
            </Button>
          }
        >
          <ChatPermissions chatId={chat.id} />
        </Dialog>
      )}
      {(asking === "reset" || asking === "delete") && (
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

// What the chat's menu opens: its permissions (ChatPermissions.tsx, #478), or Reset or Delete.
type MenuPick = "permissions" | "reset" | "delete";

// The chat's menu: Permissions, then Reset and Delete, each asked first (ConfirmDialog). Escape, Tab or a click
// elsewhere closes it (ui/popup.ts); arrows move through it.
function ChatMenu({ touch, onPick }: { touch?: boolean; onPick: (what: MenuPick) => void }) {
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
  const pick = (what: MenuPick) => {
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
        label={t("chats.menu")}
        icon={<Icon.More size={touch ? 20 : 16} />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div class={styles.menu} role="menu" aria-label={t("chats.menu")}>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            class={styles.menuItem}
            onClick={() => pick("permissions")}
          >
            <Icon.Settings size={15} />
            {t("chats.permissionsItem")}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            class={styles.menuItem}
            onClick={() => pick("reset")}
          >
            <Icon.Reset size={15} />
            {t("chats.resetItem")}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            class={`${styles.menuItem} ${styles.danger}`}
            onClick={() => pick("delete")}
          >
            <Icon.Trash size={15} />
            {t("chats.deleteItem")}
          </button>
        </div>
      )}
    </div>
  );
}

// Keys: written when shown.
const CONFIRM: Record<"reset" | "delete", Record<"title" | "sub" | "action" | "pending", Plain>> = {
  reset: {
    title: "chats.resetTitle",
    sub: "chats.resetSub",
    action: "chats.resetAction",
    pending: "chats.resetting",
  },
  delete: {
    title: "chats.deleteTitle",
    sub: "chats.deleteSub",
    action: "chats.deleteAction",
    pending: "chats.deleting",
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
      title={t(text.title)}
      sub={t(text.sub)}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("chats.cancel")}
          </Button>
          <Button
            variant="danger-solid"
            pending={pending}
            pendingLabel={t(text.pending)}
            onClick={() => void go()}
          >
            {t(text.action)}
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

// New chat: the repository (those whose `users` include you, with `runs:start:chat`; the one
// shown first, if one of them), then the agent, model and effort (the repository's by
// default), and a first message, which starts its sandbox (none: the chat waits for one).
function NewChatDialog({
  list,
  repo,
  onClose,
  onCreated,
}: {
  list: ChatList;
  repo: string | null;
  onClose: () => void;
  onCreated: (chat: Chat) => void;
}) {
  const [form, setForm] = useState<NewChat>({
    repo: (repo && list.repos.find((r) => sameRepo(r, repo))) || list.repos[0] || "",
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
      title={t("chats.newChat")}
      sub={t("chats.newSub")}
      onClose={onClose}
      onSubmit={() => void create()}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("chats.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!!problem}
            pending={pending}
            pendingLabel={t("chats.starting")}
            onClick={() => void create()}
          >
            {t("chats.start")}
          </Button>
        </>
      }
    >
      <div class={styles.form}>
        {problem && <p class={styles.limit}>{problem}</p>}
        <Field
          as="select"
          label={t("chats.repository")}
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
            label={t("chats.agent")}
            value={form.agent ?? ""}
            onChange={(e) => set({ agent: pick(e.currentTarget.value) })}
          >
            <option value="">{t("chats.repositoryDefault")}</option>
            {list.agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.label}
              </option>
            ))}
          </Field>
          <Field
            as="select"
            label={t("chats.model")}
            value={form.model ?? ""}
            onChange={(e) => set({ model: pick(e.currentTarget.value) })}
          >
            <option value="">{t("chats.repositoryDefault")}</option>
            {list.models.map((m) => (
              <option key={m} value={m}>
                {m[0].toUpperCase() + m.slice(1)}
              </option>
            ))}
          </Field>
          <Field
            as="select"
            label={t("chats.effortLabel")}
            value={form.effort ?? ""}
            onChange={(e) => set({ effort: pick(e.currentTarget.value) })}
          >
            <option value="">{t("chats.repositoryDefault")}</option>
            {list.efforts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Field>
        </div>
        <Field
          as="textarea"
          label={t("chats.firstMessage")}
          help={t("chats.firstMessageHelp")}
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
