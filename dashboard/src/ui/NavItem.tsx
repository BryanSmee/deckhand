// A sidebar link: icon, label, then a count (hot when it waits on you). On the rail it is the
// icon alone, named by its label (aria-label and tooltip).
import type { ComponentChildren } from "preact";
import { Count } from "./Count";
import styles from "./NavItem.module.css";

interface Props {
  href: string;
  icon?: ComponentChildren;
  label: string;
  current?: boolean;
  count?: number;
  hot?: boolean;
  rail?: boolean;
  // After the label (a running dot).
  extra?: ComponentChildren;
}

export function NavItem({ href, icon, label, current, count, hot, rail, extra }: Props) {
  const counted = count !== undefined && count > 0;
  return (
    <a
      class={`${styles.nav} ${rail ? styles.rail : ""}`}
      href={href}
      aria-current={current ? "page" : undefined}
      aria-label={rail ? (counted ? `${label} (${count})` : label) : undefined}
      title={rail ? label : undefined}
    >
      {icon && <span class={styles.icon}>{icon}</span>}
      {!rail && <span class={styles.label}>{label}</span>}
      {!rail && extra}
      {counted && !rail && " "}
      {counted && <Count class={styles.count} n={count} hot={hot} />}
    </a>
  );
}
