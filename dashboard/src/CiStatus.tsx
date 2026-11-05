// What CI says of a task's pull request (#436): a turning ring while it runs, a red cross when
// it failed, a green check when it passed; nothing without any run. Its title lists the runs.
// As a link (the task header, the Overview), it opens the failed run, else the pull request's
// Checks tab; in a row that is a button already (All's list), it is only an icon.
import { t } from "./i18n";
import * as Icon from "./ui/icons";
import { Spinner } from "./ui/Spinner";
import styles from "./CiStatus.module.css";
import type { CiRun, PullRequest } from "./types";

const MARKS: Record<CiRun["state"], string> = { failed: "✗", running: "…", passed: "✓" };

// "CI running", "CI failed: test, lint", "CI passed".
export function ciLabel(pr: PullRequest): string | null {
  const ci = pr.ci;
  if (!ci || ci.state === "none") return null;
  if (ci.state !== "failed") return t(ci.state === "running" ? "ci.running" : "ci.passed");
  const names = ci.runs.filter((r) => r.state === "failed").map((r) => r.name);
  return names.length ? t("ci.failedRuns", { names: names.join(t("list.comma")) }) : t("ci.failed");
}

export function CiStatus({
  pr,
  link = false,
  class: className = "",
}: {
  pr: PullRequest;
  link?: boolean;
  class?: string;
}) {
  const label = ciLabel(pr);
  if (!label || !pr.ci) return null;
  const { state, runs } = pr.ci;
  const title = [label, ...runs.map((r) => `${MARKS[r.state]} ${r.name}`)].join("\n");
  const icon =
    state === "failed" ? (
      <Icon.Close size={10} />
    ) : state === "passed" ? (
      <Icon.Check size={10} />
    ) : (
      <Spinner size="tiny" label={null} />
    );
  const classes = `${styles.ci} ${styles[state]} ${className}`;
  if (!link) {
    return (
      <span class={classes} role="img" aria-label={label} title={title}>
        {icon}
      </span>
    );
  }
  const failed = runs.find((r) => r.state === "failed" && r.url);
  const href = state === "failed" && failed?.url ? failed.url : `${pr.url}/checks`;
  return (
    <a
      class={classes}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={title}
    >
      {icon}
    </a>
  );
}
