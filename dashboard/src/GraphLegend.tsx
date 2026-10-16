// The graph's legend: each look, the arrow, and "Show closed".
import { LOOKS } from "./graphModel";
import styles from "./Graph.module.css";

interface Props {
  showClosed: boolean;
  onShowClosed: (show: boolean) => void;
}

export function GraphLegend({ showClosed, onShowClosed }: Props) {
  return (
    <ul class={styles.legend} aria-label="Legend">
      {LOOKS.map(({ look, name, means }) => (
        <li key={look} title={means}>
          <span class={`${styles.swatch} ${styles[look]}`} aria-hidden="true" />
          {name}
        </li>
      ))}
      <li title="It starts once the issue the arrow comes from is done">
        <span class={styles.arrowKey} aria-hidden="true" />
        waits for
      </li>
      <li class={styles.toggle}>
        <label title="Issues closed as completed or not planned, and merged pull requests">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => onShowClosed(e.currentTarget.checked)}
          />
          Show closed
        </label>
      </li>
    </ul>
  );
}
