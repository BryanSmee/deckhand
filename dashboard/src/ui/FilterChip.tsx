// A filter chip: a toggle button (aria-pressed) with its count.
import type { ComponentChildren, JSX } from "preact";
import styles from "./FilterChip.module.css";

type Props = Omit<JSX.HTMLAttributes<HTMLButtonElement>, "count"> & {
  pressed: boolean;
  count?: number;
  children: ComponentChildren;
};

export function FilterChip({ pressed, count, children, class: className, ...rest }: Props) {
  return (
    <button
      {...rest}
      type="button"
      class={[styles.chip, className].filter(Boolean).join(" ")}
      aria-pressed={pressed}
    >
      {children}
      {/* A space: "Running 3" to screen readers; the flex gap shows it. */}
      {count !== undefined && " "}
      {count !== undefined && <span class={styles.n}>{count}</span>}
    </button>
  );
}
