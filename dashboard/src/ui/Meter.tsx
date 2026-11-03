// Run slots in use: a segment per slot, one bar when there are many. Upright on the sidebar's
// rail; `large` on Settings › Server. With `auto` (State.autoPickup), its last `slots` are
// auto-pickup's: dashed while free, filled from the far end in the auto-pickup tone by the
// auto-picked runs, and in the standard one, still dashed, by the standard runs borrowing them.
import styles from "./Meter.module.css";
import { plural } from "../format";

// More slots than this read as a bar.
const MAX_SEGMENTS = 12;

export interface MeterAuto {
  slots: number;
  running: number;
}

// How the slots split: `reserved` at the end, `auto` of them held by auto-picked runs (from the
// end), `standard` runs filling from the start, into the reserved ones once theirs are full.
export function meterZones(running: number, max: number, auto?: MeterAuto) {
  const reserved = Math.min(max, Math.max(0, auto?.slots ?? 0));
  const held = Math.min(reserved, Math.max(0, auto?.running ?? 0));
  const standard = Math.min(max - held, Math.max(0, running - held));
  return { reserved, auto: held, standard };
}

export function Meter({
  running,
  max,
  auto,
  rail,
  large,
  title,
  class: className,
}: {
  running: number;
  max: number;
  auto?: MeterAuto;
  rail?: boolean;
  large?: boolean;
  title?: string;
  class?: string;
}) {
  const zones = meterZones(running, max, auto);
  const label =
    `${running} of ${max} run slots in use` +
    (auto ? `, ${zones.auto} of ${plural(zones.reserved, "auto-pickup slot")} in use` : "");
  const cls = [styles.meter, rail && styles.rail, large && styles.large, className]
    .filter(Boolean)
    .join(" ");
  const size = rail ? "height" : "width";
  const share = (n: number) => `${Math.min(100, (n / max) * 100)}%`;
  if (max > MAX_SEGMENTS)
    return (
      <span
        class={`${cls} ${styles.bar} ${auto ? styles.zoned : ""}`}
        role="img"
        aria-label={label}
        title={title}
      >
        <span class={styles.fill} style={{ [size]: share(auto ? zones.standard : running) }} />
        {auto && zones.reserved > 0 && (
          <span class={styles.zone} style={{ [size]: share(zones.reserved) }} />
        )}
        {auto && zones.auto > 0 && (
          <span class={styles.autoFill} style={{ [size]: share(zones.auto) }} />
        )}
      </span>
    );
  // The first reserved slot, and the first one an auto-picked run holds.
  const firstReserved = max - zones.reserved;
  const firstAuto = max - zones.auto;
  const segment = (i: number) => {
    if (!auto) return i < running ? styles.used : "";
    if (i >= firstAuto) return `${styles.reserved} ${styles.auto}`;
    const used = i < zones.standard ? styles.used : "";
    return i >= firstReserved ? `${styles.reserved} ${used}` : used;
  };
  return (
    <span
      class={cls}
      style={rail ? undefined : { gridTemplateColumns: `repeat(${max}, minmax(0, 1fr))` }}
      role="img"
      aria-label={label}
      title={title}
    >
      {Array.from({ length: max }, (_, i) => (
        <span key={i} class={segment(i)} />
      ))}
    </span>
  );
}
