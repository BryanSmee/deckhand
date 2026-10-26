// A fold (details/summary): a chevron that turns, a status dot, its title and a meta line on
// the right; its body below when open. Folds nest (a tool call inside a run's section).
import type { ComponentChildren } from "preact";
import type { Tone } from "../format";
import { ChevronRight } from "./icons";
import { StatusDot } from "./Status";
import styles from "./Fold.module.css";

interface Props {
  title: ComponentChildren;
  tone?: Tone;
  meta?: ComponentChildren;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ComponentChildren;
  class?: string;
}

export function Fold({ title, tone, meta, open, onToggle, children, class: className }: Props) {
  return (
    <details
      class={[styles.fold, className].filter(Boolean).join(" ")}
      open={open}
      onToggle={(e) => onToggle?.((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class={`${styles.summary} ${tone ? styles.dotted : ""}`}>
        <span class={styles.chevron}>
          <ChevronRight size={14} />
        </span>
        {tone && <StatusDot tone={tone} />}
        <span class={styles.title}>{title}</span>
        <span class={styles.meta}>{meta}</span>
      </summary>
      <div class={styles.body}>{children}</div>
    </details>
  );
}
