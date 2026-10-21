// A task's pull request: its state as a badge, and a link to it for the detail view.
import { PR_NAMES } from "./format";
import type { PullRequest } from "./types";
import styles from "./PullRequest.module.css";

// "Merged by Deckhand": no human reviewed it (`review.merge`), so it is told apart.
export function PrBadge({ pr }: { pr: PullRequest }) {
  const auto = pr.state === "merged" && pr.autoMerged;
  return (
    <span
      class={`${styles.badge} ${styles[pr.state]}${auto ? ` ${styles.auto}` : ""}`}
      title={
        auto
          ? `Pull request #${pr.number}, merged by Deckhand with no human review`
          : `Pull request #${pr.number}`
      }
    >
      {auto ? "Merged by Deckhand" : PR_NAMES[pr.state]}
    </span>
  );
}

export function PrLink({ pr }: { pr: PullRequest }) {
  return (
    <span class={styles.link}>
      <a href={pr.url} target="_blank" rel="noreferrer">
        Pull request #{pr.number}
      </a>
      <PrBadge pr={pr} />
    </span>
  );
}
