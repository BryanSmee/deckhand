// The graph's legend, a small card floating on its canvas: each tone, and the arrow.
import { LOOKS } from "./graphModel";
import { t } from "./i18n";
import { StatusDot } from "./ui/Status";
import styles from "./Graph.module.css";

export function GraphLegend() {
  return (
    <ul class={styles.legend} aria-label={t("graph.legend")}>
      {LOOKS.map(({ tone, name, means }) => (
        <li key={tone} title={t(means)}>
          <StatusDot tone={tone} />
          {t(name)}
        </li>
      ))}
      <li title={t("graph.waitsForHelp")}>
        <span class={styles.arrowKey} aria-hidden="true" />
        {t("graph.waitsFor")}
      </li>
    </ul>
  );
}
