// A task's or run's state as a badge (its word and dot) or a dot, in its tone (format.ts
// toneOf()). Colour is never alone: a dot sits next to the word, or names it to screen readers.
import { RUN_NAMES, STATE_NAMES, type Tone, toneOf } from "../format";
import type { RunStatus, TaskState } from "../types";
import styles from "./Status.module.css";

export type AnyState = TaskState | RunStatus;

export const stateName = (state: AnyState) =>
  (STATE_NAMES as Record<string, string>)[state] ?? RUN_NAMES[state as RunStatus] ?? state;

// What moves: a run going on, not one starting or stopping.
const MOVING: readonly AnyState[] = ["working", "running"];
// A brainstorm waits for its turn: outlined.
const OUTLINED: readonly AnyState[] = ["brainstorm"];

export const toneClass = (tone: Tone) => `s-${tone}`;

interface Props {
  state?: AnyState;
  // Instead of the state's (a task whose pull request is ready: format.ts taskTone()).
  tone?: Tone;
  // Instead of the state's name ("After #23").
  label?: string;
  class?: string;
}

export function StatusDot({
  state,
  tone,
  label,
  pulse,
  class: className,
}: Props & { pulse?: boolean }) {
  const t = tone ?? (state ? toneOf(state) : "idle");
  const moving = pulse ?? (state !== undefined && MOVING.includes(state));
  // Alone, it names itself; next to its word (no label given), it is decoration.
  const name = label ?? null;
  return (
    <span
      class={[styles.dot, toneClass(t), moving ? styles.pulse : "", className]
        .filter(Boolean)
        .join(" ")}
      role={name ? "img" : undefined}
      aria-label={name ?? undefined}
      aria-hidden={name ? undefined : "true"}
    />
  );
}

export function StatusBadge({
  state,
  tone,
  label,
  outline,
  pulse,
  title,
  class: className,
}: Props & { outline?: boolean; pulse?: boolean; title?: string }) {
  const t = tone ?? (state ? toneOf(state) : "idle");
  const outlined = outline ?? (state !== undefined && OUTLINED.includes(state));
  return (
    <span
      class={[styles.badge, toneClass(t), outlined ? styles.outline : "", className]
        .filter(Boolean)
        .join(" ")}
      title={title}
    >
      <StatusDot state={state} tone={t} pulse={pulse} />
      {label ?? (state ? stateName(state) : "")}
    </span>
  );
}
