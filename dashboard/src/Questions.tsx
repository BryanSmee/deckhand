// The open questions of a task waiting for input, as a form: per question its options as cards
// (radios, one at most picked: the box ticked in the issue, else the agent's pick, in advance; a
// second click takes it back) and a note; questions not in the set format as written, with one
// text box. Sending posts them as one App comment (listener/work.mjs `answer`). Before a start
// or a queue on the board (`then`), every question needs an answer, and the issue starts or
// queues with them. The fields are useAnswers()'s: the task's page shows them in a form of its
// own (Questions), the board in a dialog (QuestionsDialog.tsx).
import { useState } from "preact/hooks";
import { sendAnswers } from "./api";
import { isPrTask } from "./format";
import { useSubmit } from "./hooks";
import { t } from "./i18n";
import type { Answers, Questions as Asked, Task, WorkResult } from "./types";
import { Button } from "./ui/Button";
import { OptionCard } from "./ui/Choice";
import { Field } from "./ui/Field";
import styles from "./Questions.module.css";

interface Answer {
  options: number[];
  text: string;
}

// The option already ticked in the issue picked in advance, else the recommended one: only
// what is left needs filling in, and one tap accepts the agent's picks. A run's own ticks are
// the agent's, not answers: its recommended option goes first.
const initial = ({ items, source }: Asked): Answer[] =>
  (items ?? []).map((q) => {
    const ticked = source === "issue" ? q.options.findIndex((o) => o.checked) : -1;
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

export function useAnswers({ task, questions: q, submit, then, onSent }: Options) {
  const items = q.items;
  const [answers, setAnswers] = useState<Answer[]>(() => initial(q));
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
    if (unsendable || sending || task.number === null) return;
    // A pull request's own task ("#pr-12"): one that closes an issue is the issue's.
    const which = { number: task.number, ...(isPrTask(task) ? { pr: true } : {}) };
    const body: Answers = items ? { ...which, answers } : { ...which, text };
    const result = await run(body);
    if (result.error) return;
    setAnswers(initial(q));
    setText("");
    onSent(result.message ?? t("questions.sent"));
  };

  const hint =
    then && open > 0
      ? t(then === "start" ? "questions.answerToStart" : "questions.answerToQueue", {
          count: open,
        })
      : !then && !empty && open > 0
        ? t(q.source === "run" ? "questions.blankRun" : "questions.blankIssue", { count: open })
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
                    name={`${task.key} q${i}`}
                    checked={answers[i]?.options.includes(n)}
                    // A click, not a change: picked again, it takes the pick back.
                    onClick={() => pick(i, n)}
                    label={
                      <span>
                        {o.label}
                        {o.recommended && (
                          <span class={styles.pick}>{t("questions.recommended")}</span>
                        )}
                      </span>
                    }
                  />
                ))}
              </div>
            )}
            <Field
              as="textarea"
              label={t(item.options.length ? "questions.noteOn" : "questions.answerTo", {
                n: i + 1,
              })}
              hideLabel
              rows={item.options.length ? 1 : 2}
              placeholder={t(
                item.options.length ? "questions.notePlaceholder" : "questions.answerPlaceholder",
              )}
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
            label={t("questions.answers")}
            hideLabel
            rows={4}
            placeholder={t("questions.rawPlaceholder")}
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
  task,
  questions: q,
  onSent,
  submit = (body) => sendAnswers(task.repo, body),
}: Props) {
  const form = useAnswers({ task, questions: q, submit, onSent });
  return (
    <form
      class={styles.form}
      aria-label={t("questions.title")}
      // What the task page's `a` shortcut finds (Detail.tsx): not its label, which is translated.
      data-questions
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
        {t("questions.title")}
        <span class={styles.source}>
          {t(q.source === "run" ? "questions.fromRun" : "questions.inIssue")}
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
          pendingLabel={t("questions.sending")}
        >
          {t("questions.send")}
        </Button>
        {form.hint && <span class={styles.hint}>{form.hint}</span>}
      </div>
    </form>
  );
}
