// The graph's legend, a small card floating on its canvas: each tone, and the arrow.
import { LOOKS } from "./graphModel";
import { StatusDot } from "./ui/Status";
import styles from "./Graph.module.css";

export function GraphLegend() {
  return (
    <ul class={styles.legend} aria-label="Legend">
      {LOOKS.map(({ tone, name, means }) => (
        <li key={tone} title={means}>
          <StatusDot tone={tone} />
          {name}
        </li>
      ))}
      <li title="It starts once the issue the arrow comes from is done">
        <span class={styles.arrowKey} aria-hidden="true" />
        waits for
      </li>
    </ul>
  );
}
