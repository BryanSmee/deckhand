// "Queue after…": the graph's issues to pick from, then Queue. A backlog card's (WorkArea.tsx)
// and a brainstorm's (Brainstorms.tsx).
import { useState } from "preact/hooks";
import styles from "./WorkArea.module.css";

// An issue a drop or "Queue after…" can put another one after: a node of the graph.
export interface Target {
  key: string;
  number: number;
  label: string;
}

interface Props {
  number: number;
  targets: Target[];
  disabled: boolean;
  onQueue: (after: number) => void;
  onCancel: () => void;
}

export function Chooser({ number, targets, disabled, onQueue, onCancel }: Props) {
  const options = targets.filter((t) => t.number !== number);
  const [after, setAfter] = useState(options[0]?.number ?? null);
  if (!options.length) {
    return (
      <div class={styles.chooser}>
        <span class={styles.note}>No issue on the graph to queue it after.</span>
        <button type="button" class={styles.button} onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div class={styles.chooser}>
      <select
        aria-label={`Queue #${number} after`}
        value={after ?? undefined}
        onChange={(e) => setAfter(Number(e.currentTarget.value))}
      >
        {options.map((t) => (
          <option key={t.key} value={t.number}>
            {t.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        class={styles.primary}
        disabled={disabled || after === null}
        onClick={() => after !== null && onQueue(after)}
      >
        Queue
      </button>
      <button type="button" class={styles.button} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
