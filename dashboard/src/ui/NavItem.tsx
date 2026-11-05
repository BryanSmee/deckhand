// A sidebar link: icon, label, then a count (hot when it waits on you). On the rail it is the
// icon alone, named by its label (aria-label and tooltip), the count a dot on its corner: a
// number there covers a short repository name. Without an href it is a button (Notify me).
import type { ComponentChildren } from "preact";
import { t } from "../i18n";
import { Count } from "./Count";
import styles from "./NavItem.module.css";

interface Props {
  href?: string;
  onClick?: () => void;
  icon?: ComponentChildren;
  label: string;
  current?: boolean;
  count?: number;
  hot?: boolean;
  rail?: boolean;
  // After the label (a running dot).
  extra?: ComponentChildren;
  // Its tooltip, when the label doesn't say it all; the rail's is the label.
  title?: string;
}

export function NavItem(props: Props) {
  const { href, onClick, icon, label, current, count, hot, rail, extra, title } = props;
  const counted = count !== undefined && count > 0;
  const attrs = {
    class: `${styles.nav} ${rail ? styles.rail : ""}`,
    "aria-label": rail ? (counted ? t("ui.navCounted", { label, count }) : label) : undefined,
    title: rail ? label : title,
  };
  const content = (
    <>
      {icon && <span class={styles.icon}>{icon}</span>}
      {!rail && <span class={styles.label}>{label}</span>}
      {!rail && extra}
      {counted && !rail && " "}
      {counted &&
        (rail ? (
          <span class={`${styles.pip} ${hot ? styles.hot : ""}`} aria-hidden="true" />
        ) : (
          <Count n={count} hot={hot} />
        ))}
    </>
  );
  return href === undefined ? (
    <button {...attrs} type="button" onClick={onClick}>
      {content}
    </button>
  ) : (
    <a {...attrs} href={href} aria-current={current ? "page" : undefined}>
      {content}
    </a>
  );
}
