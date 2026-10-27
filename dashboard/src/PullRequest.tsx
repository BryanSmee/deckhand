// What the repo's policies last decided about a task's pull request.
import { ago } from "./format";
import type { PolicyDecision } from "./types";
import styles from "./PullRequest.module.css";

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
