// An issue's open questions over the graph: before the drag that opened them starts or queues
// it, or on their own from a click on its node (Graph.tsx).
import type { Asking } from "./graphHooks";
import { nodeRef } from "./GraphDrawing";
import { useDismiss } from "./hooks";
import { Questions } from "./Questions";
import { Backdrop } from "./RepoDialog";
import { formatRoute } from "./route";
import type { Answers, Questions as Asked, WorkResult } from "./types";
import styles from "./Graph.module.css";

interface Props {
  asking: Asking & { task: { questions: Asked } };
  // The tab: null on All, where the ref says the repo.
  repo: string | null;
  submit: (body: Answers) => Promise<WorkResult>;
  onSent: (message: string) => void;
  onClose: () => void;
}

export function QuestionsDialog({
  asking: { task, action },
  repo,
  submit,
  onSent,
  onClose,
}: Props) {
  useDismiss(onClose);
  return (
    <Backdrop class={styles.backdrop} onClose={onClose}>
      <div
        class={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Answer ${nodeRef(task, false, 0)}'s questions`}
      >
        <p class={styles.asks}>
          <b>
            {(action?.action === "queue" || action?.action === "plan") && action.after
              ? `Answer them to queue #${task.number} after #${action.after}`
              : action
                ? `Answer them to start #${task.number}`
                : `${nodeRef(task, !repo, 60)} waits for your answers`}
          </b>
          {task.title}
          <a
            class={styles.details}
            href={formatRoute({ repo, task: task.key, run: null })}
            onClick={onClose}
          >
            Open details
          </a>
        </p>
        <Questions
          task={task}
          questions={task.questions}
          then={action ? ("after" in action && action.after ? "queue" : "start") : undefined}
          submit={submit}
          onSent={onSent}
          onCancel={onClose}
        />
      </div>
    </Backdrop>
  );
}
