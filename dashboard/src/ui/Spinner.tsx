// A spinner, for what takes longer than 400 ms (Button shows its own). Says "Loading" unless
// its text next to it already does (`label={null}`). `tiny`: inside a status icon (CiStatus).
import styles from "./Spinner.module.css";

export function Spinner({
  size = "small",
  label = "Loading",
}: {
  size?: "tiny" | "small" | "large";
  label?: string | null;
}) {
  return (
    <span
      class={`${styles.spinner} ${size === "small" ? "" : styles[size]}`}
      role={label ? "status" : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : "true"}
    />
  );
}
