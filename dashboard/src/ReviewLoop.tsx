// A pull request's review-and-fix loop (Task.review, listener/reviews.mjs reviewLoop()): the
// marks a ready row gets when the loop left blocking findings or a commit was pushed after its
// last review, and the Detail page's rounds, each review's counts with those that didn't lower
// the blocking ones marked, and once the loop is over, what the task page offers to do next
// (Review, Fix).
import type { ComponentChildren } from "preact";
import { findingsLeft, noProgress, reviewOutdated, roundCounts, shortSha } from "./format";
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

// A ready row's marks: what the loop left (FindingsLeft) and "⚠ Review outdated", or nothing.
export function ReviewMarks({ task, class: className }: { task: Task; class?: string }) {
  const outdated = reviewOutdated(task);
  if (!outdated) return <FindingsLeft task={task} class={className} />;
  return (
    <span class={[styles.marks, className].filter(Boolean).join(" ")}>
      <FindingsLeft task={task} />
      <span
        class={styles.left}
        title={`Reviewed ${shortSha(outdated.reviewed)}, head is now ${shortSha(outdated.head)}`}
      >
        <Icon.Warning size={13} class={styles.mark} />
        Review outdated
      </span>
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

// Only maintainers' reviews, no loop: no fix round ran out, nothing stopped.
const MANUAL_ENDS: Record<string, string> = {
  clean: "Nothing blocking",
  "rounds-out": "Blocking findings",
  stopped: "Blocking findings",
};

// "Review loop · Fix rounds ran out", then R0 1 critical · 3 high → R1 2 high (no progress);
// "Reviews · Nothing blocking" when no loop ran, only maintainers' reviews. "· ⚠ Outdated:
// reviewed abc1234, head is now def5678" once a commit was pushed after the last one.
// `actions`: the task page's buttons for a loop that is over.
export function ReviewRounds({ task, actions }: { task: Task; actions?: ComponentChildren }) {
  const r = task.review;
  if (!r || (!r.history.length && !actions)) return null;
  const of = r.rounds ? ` of ${r.rounds}` : "";
  const name = r.manual ? "Reviews" : "Review loop";
  const end = (r.manual && MANUAL_ENDS[r.loop]) || ENDS[r.loop] || r.loop;
  const outdated = reviewOutdated(task);
  const last = r.history.length - 1;
  return (
    <section class={styles.rounds} aria-label={name}>
      <h3>
        {name} <span class={styles.state}>· {end}</span>
        {outdated && (
          <span class={styles.outdated}>
            {" · "}
            <Icon.Warning size={13} class={styles.mark} />
            Outdated: reviewed{" "}
            <a
              class={styles.sha}
              href={`${task.pr!.url}/commits/${outdated.reviewed}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortSha(outdated.reviewed)}
            </a>
            , head is now <span class={styles.sha}>{shortSha(outdated.head)}</span>
          </span>
        )}
      </h3>
      <FindingsLeft task={task} />
      <ol class={styles.chain}>
        {r.history.map((h, i) => (
          <li
            key={`${h.round}-${h.at}`}
            title={`${h.manual ? "A maintainer's review" : h.round ? `Review after fix round ${h.round}${of}` : "First review"}: ${h.blocking} blocking${h.head ? ` · ${shortSha(h.head)}` : ""}`}
          >
            <span class={styles.round}>R{h.round}</span> {roundCounts(h)}
            {noProgress(r.history, i) && <span class={styles.stuck}>no progress</span>}
            {i === last && h.head && <span class={styles.head}>{shortSha(h.head)}</span>}
          </li>
        ))}
      </ol>
      {actions && <div class={styles.actions}>{actions}</div>}
    </section>
  );
}
