// A task's or run's state in the views not redrawn yet: the dot and badge are the
// components' (ui/Status.tsx); the label is the word alone, in its tone.
import { toneOf } from "./format";
import { type AnyState, StatusBadge, StatusDot, stateName, toneClass } from "./ui/Status";
import styles from "./State.module.css";

export const StateDot = StatusDot;
export const StateBadge = StatusBadge;

export function StateLabel({ state }: { state: AnyState }) {
  return <span class={`${styles.label} ${toneClass(toneOf(state))}`}>{stateName(state)}</span>;
}
