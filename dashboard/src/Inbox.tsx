// New request's idea, bug report or discussion (NewRequest.tsx): an idea or a bug report is
// sent as the App's comment on the repo's inbox issue, which starts the run a comment there
// would (listener/work.mjs sendToInbox()): its title, a blank line, then its details. A
// discussion is started as the App's in the repo's discussions category
// (listener/discussions.mjs). Once sent, the comment's or discussion's link, then the run on its
// task when api/state lists it.
import { useLayoutEffect, useState } from "preact/hooks";
import { sendToInbox, startDiscussion } from "./api";
import { useSubmit } from "./hooks";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import type { Action } from "./NewRequest";
import { formatRoute } from "./route";
import type {
  DiscussionResult,
  DiscussionStart,
  InboxEntry,
  InboxResult,
  Inboxes,
  Task,
} from "./types";
import { Field } from "./ui/Field";
import styles from "./NewRequest.module.css";

export const INBOX_DOCS =
  "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config.md#inboxes";

export type InboxKind = "idea" | "bug" | "discussion";

// Keys, not texts: written at render, in the language picked then.
const WORDS: Record<InboxKind, { send: Plain; title: Plain; details: Plain; what: Plain }> = {
  idea: {
    send: "inbox.sendIdea",
    title: "inbox.ideaTitle",
    details: "inbox.ideaDetails",
    what: "inbox.theComment",
  },
  bug: {
    send: "inbox.sendBug",
    title: "inbox.bugTitle",
    details: "inbox.bugDetails",
    what: "inbox.theComment",
  },
  discussion: {
    send: "inbox.startDiscussion",
    title: "inbox.discussionTitle",
    details: "inbox.discussionDetails",
    what: "inbox.theDiscussion",
  },
};

// The comment an idea or a bug report is: its title, then its details.
export const entryText = (title: string, details: string) =>
  [title.trim(), details.trim()].filter(Boolean).join("\n\n");

interface Props {
  // The form's id: the footer's button sends it.
  id: string;
  repo: string;
  kind: InboxKind;
  inboxes: Inboxes;
  tasks: Task[];
  onAction: (action: Action) => void;
  onSent?: () => void;
  // The title already typed.
  title?: string;
  submit?: (repo: string, entry: InboxEntry) => Promise<InboxResult>;
  start?: (repo: string, discussion: DiscussionStart) => Promise<DiscussionResult>;
}

interface Sent {
  kind: InboxKind;
  repo: string;
  url: string | null;
  task: string | null;
  // The inbox task's newest run when it was sent: a newer one is the entry's.
  before: string | null;
}

// The title and details stay through a change of kind or repo: only a send clears them.
export function InboxForm({
  id,
  repo,
  kind,
  inboxes,
  tasks,
  onAction,
  onSent = () => {},
  title: typed = "",
  submit = sendToInbox,
  start = startDiscussion,
}: Props) {
  const [title, setTitle] = useState(typed);
  const [details, setDetails] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  const {
    sending,
    error,
    run: post,
  } = useSubmit((entry: { kind: InboxKind; repo: string; title: string; details: string }) =>
    entry.kind === "discussion"
      ? start(entry.repo, { title: entry.title.trim(), body: entry.details.trim() })
      : submit(entry.repo, { kind: entry.kind, text: entryText(entry.title, entry.details) }),
  );
  const taskOf = (key: string | null) => (key && tasks.find((x) => x.key === key)) || null;
  const discussion = kind === "discussion";
  // A discussion needs both; an entry, a title or details.
  const ready = discussion ? !!title.trim() && !!details.trim() : !!entryText(title, details);
  const words = WORDS[kind];
  const label = t(words.send);

  // Before the paint: the footer's button says it with the form, not a frame later. On its
  // text, not its key: a change of language says it again.
  useLayoutEffect(() => {
    onAction({
      label,
      pendingLabel: t(discussion ? "inbox.starting" : "inbox.sending"),
      disabled: !ready,
      pending: sending,
    });
  }, [label, ready, sending]);

  const send = async (e: Event) => {
    e.preventDefault();
    if (!ready || sending) return;
    // A new discussion is a task of its own: any run of it is the discussion's.
    const before = discussion
      ? null
      : (taskOf(`${repo}#${inboxes[kind === "idea" ? "ideas" : "bugs"]}`)?.runs[0]?.id ?? null);
    setSent(null);
    const result = await post({ kind, repo, title, details });
    if (result.error) return;
    setTitle("");
    setDetails("");
    setSent({ kind, repo, url: result.url ?? null, task: result.task ?? null, before });
    onSent();
  };

  const task = taskOf(sent?.task ?? null);
  const run = task?.runs[0] && task.runs[0].id !== sent?.before ? task.runs[0] : null;
  const what = sent ? t(WORDS[sent.kind].what) : "";

  const link = sent?.url ? (
    <a href={sent.url} target="_blank" rel="noreferrer">
      {what}
    </a>
  ) : (
    what
  );
  const taskLink = sent && task && (
    <a
      href={formatRoute({
        repo: sent.repo,
        task: task.key,
        run: sent.kind === "discussion" ? null : (run?.id ?? null),
      })}
    >
      {sent.kind === "discussion"
        ? t("inbox.itsThread")
        : run
          ? t("inbox.itsRun", { status: run.status })
          : t("inbox.inboxTask")}
    </a>
  );

  return (
    <form id={id} class={styles.form} aria-label={label} onSubmit={send}>
      <fieldset class={styles.fields} disabled={sending}>
        <Field
          label={t("inbox.title")}
          // Where focus starts: the kind and repo are picked already, most of the time.
          autofocus
          placeholder={t(words.title)}
          maxLength={256}
          value={title}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <Field
          as="textarea"
          label={
            discussion
              ? t("inbox.details")
              : tx("inbox.detailsOptional", {
                  optional: <span class={styles.optional}>{t("inbox.optional")}</span>,
                })
          }
          rows={5}
          placeholder={t(words.details)}
          help={discussion ? t("inbox.discussionHelp") : t("inbox.entryHelp")}
          value={details}
          onInput={(e) => setDetails(e.currentTarget.value)}
        />
      </fieldset>
      {error && (
        <p class={`${styles.said} ${styles.failed}`} role="alert">
          {error}
        </p>
      )}
      {sent && (
        <p class={styles.said} role="status">
          {task
            ? tx("inbox.sentWithTask", { what: link, task: taskLink })
            : tx("inbox.sent", { what: link })}
        </p>
      )}
    </form>
  );
}
