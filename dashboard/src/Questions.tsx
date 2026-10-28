// The open questions of a task waiting for input, as a form: per question its options as
// cards (radios, one at most picked: the box ticked on GitHub, else the agent's pick, in
// advance; a second click takes it back) and a note; questions not in the set format as
// written, with one text box. Sending posts them as one App comment (listener/work.mjs `answer`). Before a start or a queue on the
// board (`then`), every question needs an answer, and the issue starts or queues with them.
// The fields are useAnswers()'s: the task's page shows them in a form of its own (Questions),
// the board in a dialog (QuestionsDialog.tsx).
import { useState } from "preact/hooks";
import { sendAnswers } from "./api";
import { isPrTask } from "./format";
import { useSubmit } from "./hooks";
import type { Answers, Question, Questions as Asked, Task, WorkResult } from "./types";
import { Button } from "./ui/Button";
import { OptionCard } from "./ui/Choice";
import { Field } from "./ui/Field";
import styles from "./Questions.module.css";

interface Answer {
  options: number[];
  text: string;
}

// The option already ticked where it was asked picked in advance, else the recommended one:
// only what is left needs filling in, and one tap accepts the agent's picks.
const initial = (items: Question[] | null): Answer[] =>
  (items ?? []).map((q) => {
    const ticked = q.options.findIndex((o) => o.checked);
    const pick = ticked < 0 ? q.options.findIndex((o) => o.recommended) : ticked;
    return { options: pick < 0 ? [] : [pick], text: "" };
  });

interface Options {
  task: Task;
  questions: Asked;
  // What sends them: api/repos/<repo>/answer, or the board's action with them.
  submit: (body: Answers) => Promise<WorkResult>;
  // The board's action they come before.
  then?: "start" | "queue";
  // Once they are in: what the listener said.
  onSent: (message: string) => void;
}

export function useAnswers({ task: t, questions: q, submit, then, onSent }: Options) {
  const items = q.items;
  const [answers, setAnswers] = useState<Answer[]>(() => initial(items));
  const [text, setText] = useState("");
  const { sending, error, run } = useSubmit(submit);

  const set = (i: number, change: Partial<Answer>) =>
    setAnswers((all) => all.map((a, j) => (j === i ? { ...a, ...change } : a)));
  // One option per question: picking one drops the others; picked again, none is (the note
  // may answer).
  const pick = (i: number, option: number) =>
    set(i, { options: answers[i]?.options.includes(option) ? [] : [option] });

  const said = (a: Answer) => a.options.length > 0 || !!a.text.trim();
  const empty = items ? !answers.some(said) : !text.trim();
  const open = items ? answers.filter((a) => !said(a)).length : 0;
  // Before a start or a queue, nothing is left open.
  const unsendable = empty || (!!then && open > 0);

  const send = async () => {
    if (unsendable || sending || t.number === null) return;
    // A pull request's own task ("#pr-12"): one that closes an issue is the issue's.
    const which = { number: t.number, ...(isPrTask(t) ? { pr: true } : {}) };
    const body: Answers = items ? { ...which, answers } : { ...which, text };
    const result = await run(body);
    if (result.error) return;
    setAnswers(initial(items));
    setText("");
    onSent(result.message ?? "Answers sent.");
  };

  const hint =
    then && open > 0
      ? `Answer every question to ${then} it (${open} left).`
      : !then && !empty && open > 0
        ? `${open} left blank: ${q.source === "run" ? "the run sees which" : "it keeps waiting for them"}`
        : null;

  const fields = (
    <fieldset class={styles.fields} disabled={sending}>
      {items ? (
        items.map((item, i) => (
          <fieldset key={i} class={styles.question}>
            <legend class={styles.title}>
              {i + 1}. {item.title ?? item.text}
            </legend>
            {item.title && <p class={styles.text}>{item.text}</p>}
            {item.options.length > 0 && (
              <div class={styles.options}>
                {item.options.map((o, n) => (
                  <OptionCard
                    key={n}
                    name={`${t.key} q${i}`}
                    checked={answers[i]?.options.includes(n)}
                    // A click, not a change: picked again, it takes the pick back.
                    onClick={() => pick(i, n)}
                    label={
                      <span>
                        {o.label}
                        {o.recommended && <span class={styles.pick}>Recommended</span>}
                      </span>
                    }
                  />
                ))}
              </div>
            )}
            <Field
              as="textarea"
              label={`${item.options.length ? "Note on" : "Answer to"} question ${i + 1}`}
              hideLabel
              rows={item.options.length ? 1 : 2}
              placeholder={item.options.length ? "Another answer, or a note" : "Your answer"}
              value={answers[i]?.text ?? ""}
              onInput={(e) => set(i, { text: e.currentTarget.value })}
            />
          </fieldset>
        ))
      ) : (
        <>
          <div class={styles.raw}>{q.raw}</div>
          <Field
            as="textarea"
            label="Answers"
            hideLabel
            rows={4}
            placeholder="Answer them here, as you would in a comment"
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </>
      )}
    </fieldset>
  );

  return { fields, send, unsendable, sending, error, hint };
}

interface Props {
  task: Task;
  questions: Asked;
  onSent: (message: string) => void;
  submit?: (body: Answers) => Promise<WorkResult>;
}

// On the task's page: its own form, under the task's head.
export function Questions({
  task: t,
  questions: q,
  onSent,
  submit = (body) => sendAnswers(t.repo, body),
}: Props) {
  const form = useAnswers({ task: t, questions: q, submit, onSent });
  return (
    <form
      class={styles.form}
      aria-label="Open questions"
      onSubmit={(e) => {
        e.preventDefault();
        void form.send();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void form.send();
        }
      }}
    >
      <h2 class={styles.heading}>
        Open questions
        <span class={styles.source}>
          {q.source === "run" ? "from its last run" : "in the issue"}
        </span>
      </h2>
      {form.fields}
      <div class={styles.actions}>
        {form.error && (
          <p class={styles.error} role="alert">
            {form.error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          size="small"
          disabled={form.unsendable}
          pending={form.sending}
          pendingLabel="Sending…"
        >
          Send answers
        </Button>
        {form.hint && <span class={styles.hint}>{form.hint}</span>}
      </div>
    </form>
  );
}
