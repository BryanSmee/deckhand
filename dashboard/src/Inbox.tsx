// A repo's inbox from the dashboard's top bar: an idea or a bug report, sent as the App's
// comment on the inbox issue, which starts the run a comment there would (listener/work.mjs
// sendToInbox()). Only the repos with an inbox, and the inboxes they have, are offered; once
// sent, the comment's link, then the run on the inbox's task when api/state lists it.
import { useEffect, useState } from "preact/hooks";
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

const hasInbox = (i: Inboxes | undefined) => !!(i?.ideas || i?.bugs);

// The repos the form offers: those with an inbox, by name.
export const inboxRepos = (inboxes: Record<string, Inboxes> | undefined) =>
  Object.keys(inboxes ?? {})
    .filter((r) => hasInbox(inboxes![r]))
    .sort();

interface DialogProps {
  // api/state's: the repos whose config the listener has read.
  inboxes: Record<string, Inboxes> | undefined;
  tasks: Task[];
  // The tab open: picked first when it has an inbox.
  repo: string | null;
  onClose: () => void;
  submit?: (repo: string, entry: InboxEntry) => Promise<InboxResult>;
  // Once sent: api/state read again, for the run.
  onSent?: () => void;
}

export function InboxDialog({
  inboxes,
  tasks,
  repo: tab,
  onClose,
  submit = sendToInbox,
  onSent = () => {},
}: DialogProps) {
  const repos = inboxRepos(inboxes);
  const [picked, setPicked] = useState(() => (tab && repos.includes(tab) ? tab : null));
  const repo = picked && repos.includes(picked) ? picked : (repos[0] ?? null);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // A link to the entry's run opens it: the dialog goes.
    addEventListener("keydown", close);
    addEventListener("hashchange", onClose);
    return () => {
      removeEventListener("keydown", close);
      removeEventListener("hashchange", onClose);
    };
  }, []);
  // The tab's repo, read and without an inbox: said, with the way to set one up.
  const without = tab && inboxes?.[tab] && !hasInbox(inboxes[tab]) ? tab : null;

  return (
    <div class={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={styles.dialog} role="dialog" aria-modal="true" aria-label="Send to an inbox">
        <div class={styles.head}>
          <h2 class={styles.title}>Send an idea or a bug report</h2>
          <button type="button" class={styles.close} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {(without || !repos.length) && (
          <p class={styles.note}>
            {without
              ? `${without} has no inbox for ideas or bug reports.`
              : inboxes
                ? "No repository has an inbox for ideas or bug reports."
                : "Loading…"}{" "}
            {inboxes && (
              <a href={INBOX_DOCS} target="_blank" rel="noreferrer">
                Set one up
              </a>
            )}
          </p>
        )}
        {repo && (
          <>
            <label class={styles.repo}>
              Repository
              <select value={repo} onChange={(e) => setPicked(e.currentTarget.value)}>
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <Inbox
              key={repo}
              repo={repo}
              inboxes={inboxes![repo]}
              tasks={tasks}
              submit={(entry) => submit(repo, entry)}
              onSent={onSent}
            />
          </>
        )}
      </div>
    </div>
  );
}

interface Props {
  repo: string;
  inboxes: Inboxes;
  tasks: Task[];
  submit: (entry: InboxEntry) => Promise<InboxResult>;
  onSent: () => void;
}

interface Sent {
  url: string | null;
  task: string | null;
  // The inbox task's newest run when it was sent: a newer one is the entry's.
  before: string | null;
}

// One repo's form: Idea or Bug (those it has), the text, Send.
function Inbox({ repo, inboxes, tasks, submit, onSent }: Props) {
  const offered = KINDS.filter((k) => inboxes[k.key]);
  const [picked, setPicked] = useState<InboxEntry["kind"] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
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
    <form class={styles.form} aria-label="Inbox" onSubmit={send}>
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
          rows={6}
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
      <div class={styles.actions}>
        <button type="submit" class={styles.send} disabled={!text.trim() || sending}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
