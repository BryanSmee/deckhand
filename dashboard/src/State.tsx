// A task's or run's state: a coloured dot, a label, or both as a badge.
import { RUN_NAMES, STATE_NAMES, toneOf } from "./format";
import type { RunStatus, TaskState } from "./types";
import styles from "./State.module.css";

type Any = TaskState | RunStatus;

const nameOf = (state: Any) =>
  (STATE_NAMES as Record<string, string>)[state] ?? RUN_NAMES[state as RunStatus] ?? state;

export function StateDot({ state }: { state: Any }) {
  const tone = toneOf(state);
  return <span class={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />;
}

export function StateLabel({ state }: { state: Any }) {
  return <span class={`${styles.label} ${styles[toneOf(state)]}`}>{nameOf(state)}</span>;
}

export function StateBadge({ state }: { state: Any }) {
  const tone = toneOf(state);
  return (
    <span class={`${styles.badge} ${styles[tone]}`}>
      <span class={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />
      {nameOf(state)}
    </span>
  );
}
