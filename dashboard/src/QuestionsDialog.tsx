// An issue's open questions over the board: before the drag or button that opened them starts
// or queues it ("Then start it", "Then queue it after #n", ticked: untick it and only the
// answers go), or on their own from a click on its node (Board.tsx).
import { useId, useState } from "preact/hooks";
import type { Asking } from "./graphHooks";
import { nodeRef } from "./GraphDrawing";
import { plural } from "./format";
import { useAnswers } from "./Questions";
import { formatRoute } from "./route";
import type { Answers, Questions as Asked, WorkResult } from "./types";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Choice";
import { Dialog } from "./ui/Dialog";
import styles from "./Questions.module.css";

interface Props {
  asking: Asking & { task: { questions: Asked } };
  // The tab: null on All, where the ref says the repo.
  repo: string | null;
  // `then`: with the action they came before.
  submit: (body: Answers, then: boolean) => Promise<WorkResult>;
  onSent: (message: string, then: boolean) => void;
  onClose: () => void;
}

export function QuestionsDialog({
  asking: { task, action },
  repo,
  submit,
  onSent,
  onClose,
}: Props) {
  const [withAction, setWithAction] = useState(!!action);
  const then =
    withAction && action ? ("after" in action && action.after ? "queue" : "start") : undefined;
  const form = useAnswers({
    task,
    questions: task.questions,
    submit: (body) => submit(body, !!then),
    then,
    onSent: (message) => onSent(message, !!then),
  });
  const formId = useId();
  const after = action && "after" in action ? action.after : null;
  const items = task.questions.items;
  return (
    <Dialog
      wide
      title={items ? plural(items.length, "open question") : "Open questions"}
      sub={
        <>
          <span class="mono">{nodeRef(task, !repo, 60)}</span> {task.title} ·{" "}
          <a href={formatRoute({ repo, task: task.key, run: null })} onClick={onClose}>
            Open details
          </a>
        </>
      }
      onClose={onClose}
      onSubmit={() => void form.send()}
      hint={
        action ? (
          <Checkbox
            checked={withAction}
            onChange={setWithAction}
            disabled={form.sending}
            label={
              after ? (
                <span>
                  Then queue it after <span class="mono">#{after}</span>
                </span>
              ) : (
                "Then start it"
              )
            }
          />
        ) : undefined
      }
      actions={
        <>
          <Button variant="ghost" disabled={form.sending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={form.unsendable}
            pending={form.sending}
            pendingLabel="Sending…"
          >
            Send answers
          </Button>
        </>
      }
    >
      <form
        id={formId}
        class={styles.dialogForm}
        aria-label="Open questions"
        onSubmit={(e) => {
          e.preventDefault();
          void form.send();
        }}
      >
        {form.fields}
        {form.hint && <p class={styles.hint}>{form.hint}</p>}
        {form.error && (
          <p class={styles.error} role="alert">
            {form.error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
