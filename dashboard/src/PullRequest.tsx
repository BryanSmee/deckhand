// A task's pull request: its state as a badge, a link to it for the detail view, and what the
// repo's policies last decided about it.
import { ago, PR_NAMES } from "./format";
import type { PolicyDecision, PullRequest } from "./types";
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

const DECISIONS: Record<PolicyDecision["decision"], string> = {
  merge: "Auto-merge",
  review: "Automatic review",
  fix: "Fix run",
};

// The task's last policy decisions, newest first: which rule, refused or let through, and why.
export function PolicyDecisions({
  decisions,
  now,
}: {
  decisions: PolicyDecision[] | undefined;
  now: number;
}) {
  if (!decisions?.length) return null;
  return (
    <section class={styles.decisions} aria-label="Policy decisions">
      <b>Policies</b>
      <ul>
        {decisions.map((d) => (
          <li key={`${d.at}-${d.rule}`}>
            <span class={`${styles.verdict} ${d.denied ? styles.denied : styles.allowed}`}>
              {d.denied ? "Denied" : "Allowed"}
            </span>{" "}
            {DECISIONS[d.decision] ?? d.decision} of #{d.pr} (<code>{d.rule}</code>) ·{" "}
            <span class={styles.when}>{ago(d.at, now)}</span>
            {d.messages.length > 0 && (
              <ul class={styles.messages}>
                {d.messages.map((m, i) => (
                  <li key={i}>
                    <code>{m}</code>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
