// A pull request's review-and-fix loop (Task.review, listener/reviews.mjs reviewLoop()): the
// mark a ready row gets when the loop left blocking findings, and the Detail page's rounds,
// each review's counts with those that didn't lower the blocking ones marked.
import { findingsLeft, noProgress, roundCounts } from "./format";
import type { Task } from "./types";
import * as Icon from "./ui/icons";
import styles from "./ReviewLoop.module.css";

// "⚠ 2 high findings left after 3 fix rounds", or nothing.
export function FindingsLeft({ task, class: className }: { task: Task; class?: string }) {
  const text = findingsLeft(task);
  if (!text) return null;
  return (
    <span class={[styles.left, className].filter(Boolean).join(" ")}>
      <Icon.Warning size={13} class={styles.mark} />
      {text}
    </span>
  );
}

const ENDS: Record<string, string> = {
  reviewing: "Reviewing",
  fixing: "Fixing",
  checks: "Waiting for checks",
  ci: "Waiting for CI",
  "ci-fix": "Fixing CI",
  "ci-failed": "CI failed, not reviewed",
  clean: "Nothing blocking",
  "rounds-out": "Fix rounds ran out",
  fixed: "Fixed, not reviewed again",
  stopped: "Stopped",
};

// "Review loop · Fix rounds ran out", then R0 1 critical · 3 high → R1 2 high (no progress).
export function ReviewRounds({ task }: { task: Task }) {
  const r = task.review;
  if (!r?.history.length) return null;
  const of = r.rounds ? ` of ${r.rounds}` : "";
  return (
    <section class={styles.rounds} aria-label="Review loop">
      <h3>
        Review loop <span class={styles.state}>· {ENDS[r.loop] ?? r.loop}</span>
      </h3>
      <FindingsLeft task={task} />
      <ol class={styles.chain}>
        {r.history.map((h, i) => (
          <li
            key={`${h.round}-${h.at}`}
            title={`${h.round ? `Review after fix round ${h.round}${of}` : "First review"}: ${h.blocking} blocking${h.head ? ` · ${h.head.slice(0, 7)}` : ""}`}
          >
            <span class={styles.round}>R{h.round}</span> {roundCounts(h)}
            {noProgress(r.history, i) && <span class={styles.stuck}>no progress</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
