// "Queue after…": the graph's issues to pick from, then Queue. A work queue card's
// (WorkQueue.tsx).
import { useState } from "preact/hooks";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import styles from "./WorkQueue.module.css";

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
  // A phone's 44 px controls, or the panel's small ones.
  size?: "small" | "touch";
  onQueue: (after: number) => void;
  onCancel: () => void;
}

export function Chooser({ number, targets, disabled, size = "small", onQueue, onCancel }: Props) {
  const options = targets.filter((t) => t.number !== number);
  const [after, setAfter] = useState(options[0]?.number ?? null);
  if (!options.length) {
    return (
      <div class={styles.chooser}>
        <span class={styles.meta}>No issue on the graph to queue it after.</span>
        <Button size={size} variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div class={styles.chooser}>
      <Field
        as="select"
        class={styles.pick}
        label={`Queue #${number} after`}
        hideLabel
        size={size}
        value={after ?? undefined}
        onChange={(e) => setAfter(Number(e.currentTarget.value))}
      >
        {options.map((t) => (
          <option key={t.key} value={t.number}>
            {t.label}
          </option>
        ))}
      </Field>
      <Button
        size={size}
        variant="primary"
        disabled={disabled || after === null}
        onClick={() => after !== null && onQueue(after)}
      >
        Queue
      </Button>
      <Button size={size} variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
