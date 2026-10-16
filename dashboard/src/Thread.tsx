// A discussion task's thread (listener/discussions.mjs): the opening post, the comments with
// their replies, Deckhand's answers among them, as text. A reply box under each thread and one
// for a new comment: each is the App's comment on GitHub, and the run a comment there starts
// (taken mid-run when one is going). Read again now and then: comments written on GitHub show
// up too.
import { useState } from "preact/hooks";
import { sendDiscussionComment, useThread } from "./api";
import { ago, plural } from "./format";
import { useSubmit } from "./hooks";
import type { DiscussionComment, Post, Task, WorkResult } from "./types";
import styles from "./Thread.module.css";

interface Props {
  task: Task;
  now: number;
  // Reads api/state again: the run a comment started.
  refresh?: () => Promise<void>;
}

export function Thread({ task, now, refresh }: Props) {
  const number = task.number ?? 0;
  const { thread, error, reload } = useThread(task.repo, number);
  // The thread whose reply box is open.
  const [replying, setReplying] = useState<string | null>(null);
  const sent = async (c: DiscussionComment) => {
    const said = await sendDiscussionComment(task.repo, number, c);
    if (!said.error) {
      setReplying(null);
      await Promise.all([reload(), refresh?.()]);
    }
    return said;
  };

  if (!thread) {
    return (
      <p class={error ? styles.failed : styles.placeholder} role={error ? "alert" : undefined}>
        {error ?? "Reading the discussion…"}
      </p>
    );
  }
  return (
    <section class={styles.thread} aria-label="Discussion">
      {error && (
        <p class={styles.failed} role="alert">
          {error}
        </p>
      )}
      <Message post={thread.post} now={now} opening />
      {thread.more > 0 && (
        <p class={styles.more}>
          {plural(thread.more, "earlier comment")}{" "}
          {thread.url && (
            <a href={thread.url} target="_blank" rel="noreferrer">
              on GitHub
            </a>
          )}
        </p>
      )}
      {thread.comments.map((c) => (
        <div key={c.id} class={styles.comment}>
          <Message post={c} now={now} />
          {(c.replies.length > 0 || c.more > 0 || replying === c.id) && (
            <div class={styles.replies}>
              {c.more > 0 && (
                <p class={styles.more}>
                  {plural(c.more, "earlier reply", "earlier replies")}{" "}
                  {c.url && (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      on GitHub
                    </a>
                  )}
                </p>
              )}
              {c.replies.map((r) => (
                <Message key={r.id} post={r} now={now} />
              ))}
              {replying === c.id && (
                <Compose
                  label="Reply"
                  onSend={(text) => sent({ text, replyTo: c.id })}
                  onCancel={() => setReplying(null)}
                />
              )}
            </div>
          )}
          {replying !== c.id && (
            <button type="button" class={styles.reply} onClick={() => setReplying(c.id)}>
              Reply
            </button>
          )}
        </div>
      ))}
      <Compose label="Comment" onSend={(text) => sent({ text })} />
    </section>
  );
}

function Message({ post, now, opening = false }: { post: Post; now: number; opening?: boolean }) {
  const at = post.at ? Date.parse(post.at) : NaN;
  return (
    <article
      class={`${styles.post} ${post.deckhand ? styles.deckhand : ""} ${opening ? styles.opening : ""}`}
    >
      <header class={styles.by}>
        <b>{post.deckhand ? "Deckhand" : post.author ? `@${post.author}` : "ghost"}</b>
        {!Number.isNaN(at) && (
          <time dateTime={post.at!} title={new Date(at).toLocaleString()}>
            {ago(at, now)}
          </time>
        )}
        {post.url && (
          <a href={post.url} target="_blank" rel="noreferrer">
            on GitHub
          </a>
        )}
      </header>
      <div class={styles.body}>{post.body}</div>
    </article>
  );
}

// A text box and Send: the comment's, or a thread's reply. Keeps the text on a refusal.
function Compose({
  label,
  onSend,
  onCancel,
}: {
  label: string;
  onSend: (text: string) => Promise<WorkResult>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const { sending, error, run } = useSubmit(onSend);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    const said = await run(text);
    if (!said.error) setText("");
  };
  return (
    <form class={styles.compose} aria-label={label} onSubmit={submit}>
      <textarea
        class={styles.text}
        rows={label === "Reply" ? 3 : 4}
        aria-label={label === "Reply" ? "Your reply" : "Your comment"}
        placeholder={label === "Reply" ? "Reply in this thread" : "Add a comment to the discussion"}
        value={text}
        disabled={sending}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      {error && (
        <p class={styles.failed} role="alert">
          {error}
        </p>
      )}
      <div class={styles.actions}>
        {onCancel && (
          <button type="button" class={styles.cancel} onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" class={styles.send} disabled={!text.trim() || sending}>
          {sending ? "Sending…" : label}
        </button>
      </div>
    </form>
  );
}
