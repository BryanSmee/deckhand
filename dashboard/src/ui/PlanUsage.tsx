// How much of each plan the runs used (api/state `plans`): a thin bar per limit window, its tone
// rising with it. `compact` in the page header (each plan's main windows), `phone` in the phone's
// top bar (each plan's most used window), else every window with its reset (the repositories
// sheet, Settings › Server). Nothing without a reading.
import type { PlanUsage, PlanWindow } from "../types";
import { ago, dayTime } from "../format";
import styles from "./PlanUsage.module.css";

// From this much used, the warning tone.
const WARN_AT = 0.75;
// A reading older than this says when it was taken.
const OLD_MS = 15 * 60_000;
// The windows the header shows per plan: its main ones, listed first.
const COMPACT_WINDOWS = 2;
// The plans the phone's top bar has room for, next to the switcher: the most used ones. The
// repositories sheet has them all.
const PHONE_PLANS = 2;

const WINDOW_NAMES: Record<string, string> = {
  "5h": "5h",
  "7d": "week",
  "7d_opus": "week (Opus)",
  "7d_sonnet": "week (Sonnet)",
};

export function windowName(w: PlanWindow): string {
  return w.label ?? WINDOW_NAMES[w.name] ?? w.name;
}

export type PlanTone = "ok" | "warn" | "danger" | "stale";

// Stale: read before its window reset, so its number no longer holds. Full, or the plan limited
// without saying which window: danger.
export function windowTone(plan: PlanUsage, w: PlanWindow, now: number): PlanTone {
  if (w.resetsAt !== null && w.resetsAt <= now) return "stale";
  const anyFull = plan.windows.some((x) => x.used >= 1);
  if (w.used >= 1 || (plan.limited && !anyFull)) return "danger";
  return w.used >= WARN_AT ? "warn" : "ok";
}

const percent = (used: number) => `${Math.round(used * 100)} %`;

// "Claude 5h: 42 % used, resets today 13:10", with when it was read once that is old.
export function windowText(plan: PlanUsage, w: PlanWindow, now: number): string {
  const tone = windowTone(plan, w, now);
  const parts = [`${plan.label} ${windowName(w)}: ${percent(w.used)} used`];
  if (tone === "stale") parts.push("read before its last reset, so no longer current");
  else if (plan.limited && plan.limitedUntil && (w.used >= 1 || tone === "danger"))
    parts.push(`limit reached until ${dayTime(plan.limitedUntil, now)}`);
  else if (w.resetsAt !== null) parts.push(`resets ${dayTime(w.resetsAt, now)}`);
  if (w.at !== null && (tone === "stale" || now - w.at > OLD_MS))
    parts.push(`as of ${ago(w.at, now)}`);
  return parts.join(", ");
}

function Bar({ plan, w, now }: { plan: PlanUsage; w: PlanWindow; now: number }) {
  const tone = windowTone(plan, w, now);
  return (
    <span class={`${styles.bar} ${styles[tone]}`} aria-hidden="true">
      <span style={{ width: `${Math.max(0, Math.min(1, w.used)) * 100}%` }} />
    </span>
  );
}

// The plans with a reading, each with the windows the form shows.
function shownPlans(plans: PlanUsage[] | undefined, pick: (p: PlanUsage) => PlanWindow[]) {
  return (plans ?? [])
    .map((plan) => ({ plan, windows: pick(plan) }))
    .filter((p) => p.windows.length);
}

// The header's windows: the main ones by name (the 5-hour and weekly limits), else the first
// ones; and while the plan is limited, a full window besides (a model's weekly limit, say), so
// that the limit shows.
const MAIN_WINDOWS = ["5h", "7d"];
export function compactWindows(plan: PlanUsage): PlanWindow[] {
  const main = plan.windows.filter((w) => MAIN_WINDOWS.includes(w.name));
  const picked = main.length ? main : plan.windows.slice(0, COMPACT_WINDOWS);
  const full = plan.limited ? plan.windows.filter((w) => w.used >= 1 && !picked.includes(w)) : [];
  return [...picked, ...full];
}

// The most used window, a current one before a stale one.
function mostUsed(plan: PlanUsage, now: number): PlanWindow[] {
  const ranked = [...plan.windows].sort(
    (a, b) =>
      Number(windowTone(plan, a, now) === "stale") - Number(windowTone(plan, b, now) === "stale") ||
      b.used - a.used,
  );
  return ranked.slice(0, 1);
}

export function PlanBars({
  plans,
  now,
  form = "full",
  class: className,
}: {
  plans: PlanUsage[] | undefined;
  now: number;
  form?: "compact" | "phone" | "full";
  class?: string;
}) {
  const shown = shownPlans(plans, (plan) =>
    form === "compact"
      ? compactWindows(plan)
      : form === "phone"
        ? mostUsed(plan, now)
        : plan.windows,
  );
  if (form === "phone" && shown.length > PHONE_PLANS) {
    const kept = [...shown]
      .sort((a, b) => b.windows[0].used - a.windows[0].used)
      .slice(0, PHONE_PLANS);
    shown.splice(0, shown.length, ...shown.filter((p) => kept.includes(p)));
  }
  if (!shown.length) return null;
  const cls = [styles.plans, styles[form], className].filter(Boolean).join(" ");
  if (form === "full")
    return (
      <div class={cls} role="group" aria-label="Plan usage">
        {shown.map(({ plan, windows }) => (
          <div key={plan.plan} class={styles.plan}>
            <span class={styles.planName}>
              {plan.label}
              {plan.limited && <span class={styles.limited}>limit reached</span>}
            </span>
            {windows.map((w) => (
              <div key={w.name} class={styles.row} role="img" aria-label={windowText(plan, w, now)}>
                <span class={styles.rowHead}>
                  <span>{windowName(w)}</span>
                  <span class={styles.value}>{percent(w.used)}</span>
                </span>
                <Bar plan={plan} w={w} now={now} />
                <span class={styles.note}>
                  {windowText(plan, w, now).split(", ").slice(1).join(", ")}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  return (
    <div class={cls} role="group" aria-label="Plan usage">
      {shown.map(({ plan, windows }) => (
        <span key={plan.plan} class={styles.plan}>
          {form === "compact" && <span class={styles.planName}>{plan.label}</span>}
          {windows.map((w) => {
            const text = windowText(plan, w, now);
            return (
              <span key={w.name} class={styles.item} role="img" aria-label={text} title={text}>
                <span class={styles.itemLabel}>
                  <span class={styles.itemName}>
                    {form === "phone" ? plan.label : windowName(w)}
                  </span>
                  <span class={styles.value}>{percent(w.used)}</span>
                </span>
                <Bar plan={plan} w={w} now={now} />
              </span>
            );
          })}
        </span>
      ))}
    </div>
  );
}
