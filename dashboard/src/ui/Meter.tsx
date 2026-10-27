// Run slots in use: a segment per slot, one bar when there are many. Upright on the sidebar's
// rail; `large` on Settings › Server.
import styles from "./Meter.module.css";

// More slots than this read as a bar.
const MAX_SEGMENTS = 12;

export function Meter({
  running,
  max,
  rail,
  large,
  title,
  class: className,
}: {
  running: number;
  max: number;
  rail?: boolean;
  large?: boolean;
  title?: string;
  class?: string;
}) {
  const label = `${running} of ${max} run slots in use`;
  const cls = [styles.meter, rail && styles.rail, large && styles.large, className]
    .filter(Boolean)
    .join(" ");
  if (max > MAX_SEGMENTS)
    return (
      <span class={`${cls} ${styles.bar}`} role="img" aria-label={label} title={title}>
        <span style={{ [rail ? "height" : "width"]: `${Math.min(100, (running / max) * 100)}%` }} />
      </span>
    );
  return (
    <span
      class={cls}
      style={rail ? undefined : { gridTemplateColumns: `repeat(${max}, minmax(0, 1fr))` }}
      role="img"
      aria-label={label}
      title={title}
    >
      {Array.from({ length: max }, (_, i) => (
        <span key={i} class={i < running ? styles.used : ""} />
      ))}
    </span>
  );
}
