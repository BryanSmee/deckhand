// The open questions of a task waiting for input, as a form: per question its options as
// checkboxes, one at most ticked (the agent's pick, in advance), and a note; questions not in the set format as written,
// with one text box. Sending posts them as one App comment (listener/work.mjs `answer`). Opened
// by a drag on the graph (`then`), every question needs an answer, and the issue starts or
// queues with them.
import { useState } from "preact/hooks";
import { sendAnswers } from "./api";
import type { Answers, Question, Questions as Asked, Task, WorkResult } from "./types";
import styles from "./Questions.module.css";

interface Props {
  task: Task;
  questions: Asked;
  // Once they are in: what the listener said (api/state is read again).
  onSent: (message: string) => void;
  // What sends them: api/repos/<repo>/answer, or the graph's action with them.
  submit?: (body: Answers) => Promise<WorkResult>;
  // The graph's action they come before, and the way back from it.
  then?: "start" | "queue";
  onCancel?: () => void;
}

interface Answer {
  options: number[];
  text: string;
}

// The recommended option ticked in advance: one tap accepts the agent's picks.
const initial = (items: Question[] | null): Answer[] =>
  (items ?? []).map((q) => {
    const pick = q.options.findIndex((o) => o.recommended);
    return { options: pick < 0 ? [] : [pick], text: "" };
  });

export function Questions({
  task: t,
  questions: q,
  onSent,
  submit = (body) => sendAnswers(t.repo, body),
  then,
  onCancel,
}: Props) {
  const items = q.items;
  const [answers, setAnswers] = useState<Answer[]>(() => initial(items));
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (i: number, change: Partial<Answer>) =>
    setAnswers((all) => all.map((a, j) => (j === i ? { ...a, ...change } : a)));
  // One option per question: ticking one unticks the others; unticked, the note may answer.
  const toggle = (i: number, option: number, on: boolean) =>
    set(i, { options: on ? [option] : [] });

  const said = (a: Answer) => a.options.length > 0 || !!a.text.trim();
  const empty = items ? !answers.some(said) : !text.trim();
  const open = items ? answers.filter((a) => !said(a)).length : 0;
  // Before a start or a queue, nothing is left open.
  const unsendable = empty || (!!then && open > 0);

  const send = async (e: Event) => {
    e.preventDefault();
    if (unsendable || sending || t.number === null) return;
    // A pull request's own task ("#pr-12"): one that closes an issue is the issue's.
    const which = { number: t.number, ...(t.key.endsWith(`#pr-${t.number}`) ? { pr: true } : {}) };
    const body: Answers = items ? { ...which, answers } : { ...which, text };
    setSending(true);
    setError(null);
    const result: WorkResult = await submit(body);
    setSending(false);
    if (result.error) return setError(result.error);
    setAnswers(initial(items));
    setText("");
    onSent(result.message ?? "Answers sent.");
  };

  return (
    <form class={styles.form} aria-label="Open questions" onSubmit={send}>
      <h2 class={styles.heading}>
        Open questions
        <span class={styles.source}>
          {q.source === "run" ? "from its last run" : "in the issue"}
        </span>
      </h2>
      <fieldset class={styles.fields} disabled={sending}>
        {items ? (
          items.map((item, i) => (
            <fieldset key={i} class={styles.question}>
              <legend class={styles.title}>
                {i + 1}. {item.title ?? item.text}
              </legend>
              {item.title && <p class={styles.text}>{item.text}</p>}
              {item.options.length > 0 && (
                <ul class={styles.options}>
                  {item.options.map((o, n) => (
                    <li key={n}>
                      <label class={styles.option}>
                        <input
                          type="checkbox"
                          checked={answers[i]?.options.includes(n)}
                          onChange={(e) => toggle(i, n, e.currentTarget.checked)}
                        />
                        <span>
                          {o.label}
                          {o.recommended && <span class={styles.pick}>Recommended</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <textarea
                class={styles.note}
                rows={item.options.length ? 1 : 2}
                aria-label={`${item.options.length ? "Note on" : "Answer to"} question ${i + 1}`}
                placeholder={item.options.length ? "Another answer, or a note" : "Your answer"}
                value={answers[i]?.text ?? ""}
                onInput={(e) => set(i, { text: e.currentTarget.value })}
              />
            </fieldset>
          ))
        ) : (
          <>
            <div class={styles.raw}>{q.raw}</div>
            <textarea
              class={styles.note}
              rows={4}
              aria-label="Answers"
              placeholder="Answer them here, as you would in a comment"
              value={text}
              onInput={(e) => setText(e.currentTarget.value)}
            />
          </>
        )}
      </fieldset>
      <div class={styles.actions}>
        {error && (
          <p class={styles.error} role="alert">
            {error}
          </p>
        )}
        <button type="submit" class={styles.send} disabled={unsendable || sending}>
          {sending ? "Sending…" : then ? `Send answers and ${then}` : "Send answers"}
        </button>
        {onCancel && (
          <button type="button" class={styles.cancel} disabled={sending} onClick={onCancel}>
            Cancel
          </button>
        )}
        {then && open > 0 && (
          <span class={styles.hint}>
            Answer every question to {then} it ({open} left).
          </span>
        )}
        {!then && !empty && open > 0 && (
          <span class={styles.hint}>
            {open} left blank:{" "}
            {q.source === "run" ? "the run sees which" : "it keeps waiting for them"}
          </span>
        )}
      </div>
    </form>
  );
}
