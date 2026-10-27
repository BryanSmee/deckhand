// New request's idea, bug report or discussion (NewRequest.tsx): an idea or a bug report is
// sent as the App's comment on the repo's inbox issue, which starts the run a comment there
// would (listener/work.mjs sendToInbox()): its title, a blank line, then its details. A
// discussion is started as the App's in the repo's discussions category
// (listener/discussions.mjs). Once sent, the comment's or discussion's link, then the run on its
// task when api/state lists it.
import { useLayoutEffect, useState } from "preact/hooks";
import { sendToInbox, startDiscussion } from "./api";
import { useSubmit } from "./hooks";
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

const WORDS: Record<InboxKind, { send: string; title: string; details: string; what: string }> = {
  idea: {
    send: "Send idea",
    title: "What you'd like, in a line",
    details: "What you'd like, and why. Markdown works.",
    what: "the comment",
  },
  bug: {
    send: "Send bug report",
    title: "What goes wrong, in a line",
    details: "What goes wrong, and how to see it. Markdown works.",
    what: "the comment",
  },
  discussion: {
    send: "Start discussion",
    title: "The discussion's title",
    details: "What you'd like to talk over. Markdown works.",
    what: "the discussion",
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
  const taskOf = (key: string | null) => (key && tasks.find((t) => t.key === key)) || null;
  const discussion = kind === "discussion";
  // A discussion needs both; an entry, a title or details.
  const ready = discussion ? !!title.trim() && !!details.trim() : !!entryText(title, details);
  const words = WORDS[kind];

  // Before the paint: the footer's button says it with the form, not a frame later.
  useLayoutEffect(() => {
    onAction({
      label: words.send,
      pendingLabel: discussion ? "Starting…" : "Sending…",
      disabled: !ready,
      pending: sending,
    });
  }, [words.send, ready, sending]);

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
  const what = sent ? WORDS[sent.kind].what : "";

  return (
    <form id={id} class={styles.form} aria-label={WORDS[kind].send} onSubmit={send}>
      <fieldset class={styles.fields} disabled={sending}>
        <Field
          label="Title"
          // Where focus starts: the kind and repo are picked already, most of the time.
          autofocus
          placeholder={words.title}
          maxLength={256}
          value={title}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <Field
          as="textarea"
          label={
            discussion ? (
              "Details"
            ) : (
              <>
                Details <span class={styles.optional}>· optional</span>
              </>
            )
          }
          rows={5}
          placeholder={words.details}
          help={
            discussion
              ? "Deckhand answers in the discussion."
              : "The inbox run turns this into a ready-to-start issue, or asks you first. End a line with /effort high, /model or /agent to pick them for its run."
          }
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
          Sent:{" "}
          {sent.url ? (
            <a href={sent.url} target="_blank" rel="noreferrer">
              {what}
            </a>
          ) : (
            what
          )}
          {task && (
            <>
              {" · "}
              <a
                href={formatRoute({
                  repo: sent.repo,
                  task: task.key,
                  run: sent.kind === "discussion" ? null : (run?.id ?? null),
                })}
              >
                {sent.kind === "discussion"
                  ? "its thread"
                  : run
                    ? `its run (${run.status})`
                    : "the inbox's task"}
              </a>
            </>
          )}
        </p>
      )}
    </form>
  );
}
