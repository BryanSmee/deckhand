// The repo's inbox from the dashboard: an idea or a bug report, sent as the App's comment on
// the inbox issue, which starts the run a comment there would (listener/work.mjs
// sendToInbox()). Only the inboxes the repo has are offered; once sent, the comment's link,
// then the run on the inbox's task when api/state lists it.
import { useState } from "preact/hooks";
import { sendToInbox } from "./api";
import { formatRoute } from "./route";
import type { InboxEntry, InboxResult, Inboxes, Task } from "./types";
import styles from "./Inbox.module.css";

export const INBOX_DOCS =
  "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config.md#inboxes";

const KINDS = [
  { kind: "idea", key: "ideas", label: "Idea" },
  { kind: "bug", key: "bugs", label: "Bug" },
] as const;

interface Props {
  repo: string;
  // api/state's for this repo; undefined while the listener hasn't read its config.
  inboxes: Inboxes | undefined;
  tasks: Task[];
  submit?: (entry: InboxEntry) => Promise<InboxResult>;
  // Once sent: api/state read again, for the run.
  onSent?: () => void;
}

interface Sent {
  url: string | null;
  task: string | null;
  // The inbox task's newest run when it was sent: a newer one is the entry's.
  before: string | null;
}

export function Inbox({
  repo,
  inboxes,
  tasks,
  submit = (entry) => sendToInbox(repo, entry),
  onSent = () => {},
}: Props) {
  const offered = KINDS.filter((k) => inboxes?.[k.key]);
  const [picked, setPicked] = useState<InboxEntry["kind"] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  if (!inboxes) return null;
  if (!offered.length) {
    return (
      <section class={styles.inbox} aria-label="Inbox">
        <h2 class={styles.title}>Inbox</h2>
        <p class={styles.note}>
          {repo} has no inbox for ideas or bug reports.{" "}
          <a href={INBOX_DOCS} target="_blank" rel="noreferrer">
            Set one up
          </a>
        </p>
      </section>
    );
  }
  const kind = offered.some((k) => k.kind === picked) ? picked! : offered[0].kind;
  const taskOf = (key: string | null) => (key && tasks.find((t) => t.key === key)) || null;

  const send = async (e: Event) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    const number = inboxes[kind === "idea" ? "ideas" : "bugs"];
    const before = taskOf(`${repo}#${number}`)?.runs[0]?.id ?? null;
    setSending(true);
    setError(null);
    setSent(null);
    const result = await submit({ kind, text });
    setSending(false);
    if (result.error) return setError(result.error);
    setText("");
    setSent({ url: result.url ?? null, task: result.task ?? null, before });
    onSent();
  };

  const task = taskOf(sent?.task ?? null);
  const run = task?.runs[0] && task.runs[0].id !== sent?.before ? task.runs[0] : null;

  return (
    <form class={styles.inbox} aria-label="Inbox" onSubmit={send}>
      <h2 class={styles.title}>Inbox</h2>
      <fieldset class={styles.fields} disabled={sending}>
        <div class={styles.kinds} role="radiogroup" aria-label="Kind">
          {offered.map((k) => (
            <label key={k.kind} class={styles.kind}>
              <input
                type="radio"
                name="inbox-kind"
                value={k.kind}
                checked={kind === k.kind}
                onChange={() => setPicked(k.kind)}
              />
              {k.label}
            </label>
          ))}
        </div>
        <textarea
          class={styles.text}
          rows={4}
          aria-label={kind === "idea" ? "The idea" : "The bug"}
          placeholder={
            kind === "idea"
              ? "What you'd like, as you would comment on the inbox"
              : "What goes wrong, and how to see it"
          }
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </fieldset>
      <div class={styles.actions}>
        <button type="submit" class={styles.send} disabled={!text.trim() || sending}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
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
              the comment
            </a>
          ) : (
            "the comment"
          )}
          {task && (
            <>
              {" · "}
              <a href={formatRoute({ repo, task: task.key, run: run?.id ?? null })}>
                {run ? `its run (${run.status})` : "the inbox's task"}
              </a>
            </>
          )}
        </p>
      )}
    </form>
  );
}
