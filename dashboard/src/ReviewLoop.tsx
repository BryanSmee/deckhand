// A pull request's review-and-fix loop (Task.review, listener/reviews.mjs reviewLoop()): the
// marks a ready row gets when the loop left blocking findings or a commit was pushed after its
// last review, and the Detail page's rounds: the last review's counts and its trend, every
// review's on hover, those that didn't lower the blocking ones marked, and once the loop is
// over, what the task page offers to do next (Review, Fix).
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
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
// "Reviews · Nothing blocking" when no loop ran, only maintainers' reviews. "⚠ Outdated:
// reviewed abc1234, head is now def5678" beside the last review once a commit was pushed
// after it.
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
      </h3>
      <FindingsLeft task={task} />
      {r.history.length > 0 && (
        <div class={styles.lastRow}>
          <LastReview task={task} />
          {outdated && (
            <span class={styles.outdated}>
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
        </div>
      )}
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
// stay hidden). Hovering it lists every review, oldest first, until the mouse leaves or Escape:
// a preview that leaves focus and the page's keys alone. Focusing or clicking it pins the list, a popup's
// (ui/popup.ts): Escape, a click elsewhere or Tab closes it, and so does a click on the line.
function LastReview({ task }: { task: Task }) {
  const r = task.review!;
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hover || pinned;
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  // Escape closes the list, then focuses the line (ui/popup.ts): that focus mustn't pin it
  // again. Set while the popup closes, cleared once its handler is done.
  const closing = useRef(false);
  // Pinned before the click's pointer went down: the press itself focuses the line, which pins.
  const wasPinned = useRef(false);
  // Closed by the keys or a click, the list stays shut under a mouse at rest on the line.
  const close = () => {
    closing.current = true;
    setPinned(false);
    setHover(false);
    queueMicrotask(() => (closing.current = false));
  };
  usePopup(pinned, close, { box, button: () => button.current });
  // A preview closes on Escape too, leaving focus and the key to whatever has them.
  useEffect(() => {
    if (!hover || pinned) return;
    const keys = (e: KeyboardEvent) => e.key === "Escape" && setHover(false);
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [hover, pinned]);
  // Focus that left with the window (another tab, another app) comes back to the line on its
  // own: no one asked for the list then.
  const away = useRef(false);
  const last = r.history.length - 1;
  const trend = reviewTrend(r.history);
  const of = r.rounds ? ` of ${r.rounds}` : "";
  const t = trend && TREND[trend];
  return (
    <div
      ref={box}
      class={styles.last}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        ref={button}
        type="button"
        class={styles.line}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onFocus={() => {
          if (!closing.current && !away.current) setPinned(true);
          away.current = false;
        }}
        onBlur={() => (away.current = !document.hasFocus())}
        onPointerDown={() => (wasPinned.current = pinned)}
        onClick={(e) => {
          // Enter or Space (no pointer, detail 0): the list is as the line's focus left it.
          const before = e.detail ? wasPinned.current : pinned;
          if (before) return close();
          // Safari doesn't focus a button clicked: the popup's Escape brings focus back here.
          button.current?.focus();
          setPinned(true);
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
        <ol
          id={id}
          class={styles.list}
          aria-label="Every review, oldest first"
          data-popup={pinned || undefined}
        >
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
