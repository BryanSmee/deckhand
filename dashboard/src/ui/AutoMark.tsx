// An auto-picked task's mark (#589): the bolt in auto-pickup's tone, named for screen readers
// and on hover, where its rows used to say "Auto-pickup".
import { t } from "../i18n";
import * as Icon from "./icons";
import styles from "./AutoMark.module.css";

export function AutoMark({ size = 13, class: className }: { size?: number; class?: string }) {
  return (
    <span
      class={[styles.mark, className].filter(Boolean).join(" ")}
      role="img"
      aria-label={t("ui.autoPickup")}
      title={t("ui.autoPickup")}
    >
      <Icon.Auto size={size} />
    </span>
  );
}
