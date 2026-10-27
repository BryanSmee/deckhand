// A count next to a tab, a nav item or a repository; `hot` when it waits on you.
import styles from "./Count.module.css";

export function Count({ n, hot, class: className }: { n: number; hot?: boolean; class?: string }) {
  return (
    <span class={[styles.count, hot ? styles.hot : "", className].filter(Boolean).join(" ")}>
      {n}
    </span>
  );
}
