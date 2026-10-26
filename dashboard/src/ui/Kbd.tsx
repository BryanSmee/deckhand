// A key, or a chord ("Ctrl ↵"), as the shortcuts and the dialogs' footers show them.
import type { ComponentChildren } from "preact";
import styles from "./Kbd.module.css";

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class={styles.kbd}>{children}</kbd>;
}
