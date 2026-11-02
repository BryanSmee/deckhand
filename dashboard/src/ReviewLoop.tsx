// A pull request's review-and-fix loop (Task.review, listener/reviews.mjs reviewLoop()): the
// marks a ready row gets when the loop left blocking findings or a commit was pushed after its
// last review, and the Detail page's rounds: the last review's counts and its trend, every
// review's on hover, those that didn't lower the blocking ones marked, and once the loop is
// over, what the task page offers to do next (Review, Fix).
import type { ComponentChildren } from "preact";
import { useId, useRef, useState } from "preact/hooks";
import {
  findingsLeft,
  noProgress,
  reviewOutdated,
  reviewTrend,
  roundCounts,
  shortSha,
} from "./format";
import type { Task } from "./types";
import * as Icon from "./ui/icons";
import { usePopup } from "./ui/popup";
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

// "Review loop · Fix rounds ran out", then "Last review: 2 high ↓" (LastReview);
// "Reviews · Nothing blocking" when no loop ran, only maintainers' reviews. "· ⚠ Outdated:
// reviewed abc1234, head is now def5678" once a commit was pushed after the last one.
// `actions`: the task page's buttons for a loop that is over.
export function ReviewRounds({ task, actions }: { task: Task; actions?: ComponentChildren }) {
  const r = task.review;
  if (!r || (!r.history.length && !actions)) return null;
  const name = r.manual ? "Reviews" : "Review loop";
  const end = (r.manual && MANUAL_ENDS[r.loop]) || ENDS[r.loop] || r.loop;
  const outdated = reviewOutdated(task);
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
      {r.history.length > 0 && <LastReview task={task} />}
      {actions && <div class={styles.actions}>{actions}</div>}
    </section>
  );
}

const TREND = {
  better: { Arrow: Icon.ArrowDown, words: "better than the review before" },
  worse: { Arrow: Icon.ArrowUp, words: "worse than the review before" },
};

// "Last review: 2 high · 1 low ↓": the last review's counts, and whether it weighs less (a
// green arrow down) or more (a red one up) than the one before it (reviewTrend(); the points
// stay hidden). Hovering, focusing or tapping it lists every review, oldest first; Escape, a
// click elsewhere or Tab closes the list (ui/popup.ts), and so does the mouse leaving, unless
// focus is on the line.
function LastReview({ task }: { task: Task }) {
  const r = task.review!;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  usePopup(open, () => setOpen(false), { box, button: () => button.current });
  const last = r.history.length - 1;
  const trend = reviewTrend(r.history);
  const of = r.rounds ? ` of ${r.rounds}` : "";
  const t = trend && TREND[trend];
  return (
    <div
      ref={box}
      class={styles.last}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (document.activeElement !== button.current) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        class={styles.line}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onClick={() => {
          // Safari doesn't focus a button clicked: the popup's Escape brings focus back here.
          button.current?.focus();
          setOpen(true);
        }}
      >
        <span class={styles.label}>Last review:</span> {roundCounts(r.history[last])}
        {t && " "}
        {t && (
          <span role="img" aria-label={t.words} class={styles[trend]} title={t.words}>
            <t.Arrow size={14} />
          </span>
        )}
      </button>
      {open && (
        <ol id={id} class={styles.list} aria-label="Every review, oldest first" data-popup>
          {r.history.map((h, i) => (
            <li
              key={`${h.round}-${h.at}`}
              title={`${h.manual ? "A maintainer's review" : h.round ? `Review after fix round ${h.round}${of}` : "First review"}: ${h.blocking} blocking`}
            >
              {/* Without a loop, no fix round between them: numbered in turn, never stuck. */}
              <span class={styles.round}>{r.manual ? `#${i + 1}` : `R${h.round}`}</span>{" "}
              <span class={styles.counts}>
                {roundCounts(h)}
                {!r.manual && noProgress(r.history, i) && (
                  <span class={styles.stuck}>no progress</span>
                )}
              </span>{" "}
              <span class={styles.head}>{h.head ? shortSha(h.head) : ""}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
