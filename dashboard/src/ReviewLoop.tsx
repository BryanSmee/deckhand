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
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
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
        title={t("reviewLoop.outdatedTitle", {
          reviewed: shortSha(outdated.reviewed),
          head: shortSha(outdated.head),
        })}
      >
        <Icon.Warning size={13} class={styles.mark} />
        {t("reviewLoop.outdated")}
      </span>
    </span>
  );
}

// Keys, read at render: the language may change meanwhile.
const ENDS: Record<string, Plain> = {
  reviewing: "reviewLoop.reviewing",
  fixing: "reviewLoop.fixing",
  checks: "reviewLoop.checks",
  ci: "reviewLoop.ci",
  "ci-fix": "reviewLoop.ciFix",
  rebasing: "reviewLoop.rebasing",
  "ci-failed": "reviewLoop.ciFailed",
  clean: "reviewLoop.clean",
  "rounds-out": "reviewLoop.roundsOut",
  fixed: "reviewLoop.fixed",
  stopped: "reviewLoop.stopped",
};

// Only maintainers' reviews, no loop: no fix round ran out, nothing stopped.
const MANUAL_ENDS: Record<string, Plain> = {
  clean: "reviewLoop.clean",
  "rounds-out": "reviewLoop.blocking",
  stopped: "reviewLoop.blocking",
};

// "Review loop · Fix rounds ran out", then "Last review: 2 high ↓" (LastReview);
// "Reviews · Nothing blocking" when no loop ran, only maintainers' reviews. "⚠ Outdated:
// reviewed abc1234, head is now def5678" beside the last review once a commit was pushed
// after it.
// `actions`: the task page's buttons for a loop that is over.
export function ReviewRounds({ task, actions }: { task: Task; actions?: ComponentChildren }) {
  const r = task.review;
  if (!r || (!r.history.length && !actions)) return null;
  const name = t(r.manual ? "reviewLoop.reviews" : "reviewLoop.loop");
  // An end this dashboard doesn't know yet: the listener's own word.
  const key = (r.manual && MANUAL_ENDS[r.loop]) || ENDS[r.loop];
  const end = key ? t(key) : r.loop;
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
              {tx("reviewLoop.outdatedLine", {
                reviewed: (
                  <a
                    class={styles.sha}
                    href={`${task.pr!.url}/commits/${outdated.reviewed}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortSha(outdated.reviewed)}
                  </a>
                ),
                head: <span class={styles.sha}>{shortSha(outdated.head)}</span>,
              })}
            </span>
          )}
        </div>
      )}
      {actions && <div class={styles.actions}>{actions}</div>}
    </section>
  );
}

const TREND = {
  better: { Arrow: Icon.ArrowDown, words: "reviewLoop.better" },
  worse: { Arrow: Icon.ArrowUp, words: "reviewLoop.worse" },
} as const;

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
  const arrow = trend && TREND[trend];
  const words = arrow && t(arrow.words);
  // An entry's title: who reviewed it, after which fix round.
  const entryTitle = (h: (typeof r.history)[number]) => {
    const blocking = h.blocking;
    if (h.manual) return t("reviewLoop.maintainer", { blocking });
    if (!h.round) return t("reviewLoop.first", { blocking });
    return r.rounds
      ? t("reviewLoop.afterRoundOf", { round: h.round, rounds: r.rounds, blocking })
      : t("reviewLoop.afterRound", { round: h.round, blocking });
  };
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
        <span class={styles.label}>{t("reviewLoop.last")}</span> {roundCounts(r.history[last])}
        {arrow && " "}
        {arrow && (
          <span role="img" aria-label={words!} class={styles[trend]} title={words!}>
            <arrow.Arrow size={14} />
          </span>
        )}
      </button>
      {open && (
        <ol
          id={id}
          class={styles.list}
          aria-label={t("reviewLoop.every")}
          data-popup={pinned || undefined}
        >
          {r.history.map((h, i) => (
            <li key={`${h.round}-${h.at}`} title={entryTitle(h)}>
              {/* Without a loop, no fix round between them: numbered in turn, never stuck. */}
              <span class={styles.round}>
                {r.manual ? `#${i + 1}` : t("reviewLoop.round", { round: h.round })}
              </span>{" "}
              <span class={styles.counts}>
                {roundCounts(h)}
                {!r.manual && noProgress(r.history, i) && (
                  <span class={styles.stuck}>{t("reviewLoop.noProgress")}</span>
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
