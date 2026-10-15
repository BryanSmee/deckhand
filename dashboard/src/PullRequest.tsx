// A task's pull request: its state as a badge, and a link to it for the detail view.
import { PR_NAMES } from "./format";
import type { PullRequest } from "./types";
import styles from "./PullRequest.module.css";

export function PrBadge({ pr }: { pr: PullRequest }) {
  return (
    <span class={`${styles.badge} ${styles[pr.state]}`} title={`Pull request #${pr.number}`}>
      {PR_NAMES[pr.state]}
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
