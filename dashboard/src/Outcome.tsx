// A run's outcome, above its log: how it ended and its pull request, its reply (three lines on
// a phone), what to do next (Open pull request, Rerun, Dismiss), then its facts: the branch and its
// commits, the change's size (the latest run's only: the pull request is the task's), how long, on which model, and where it replies. A run going on
// says so instead.
import { AUTH_NAMES, duration, plural, PR_NAMES, type Tone } from "./format";
import type { Auth, PullRequest, Run, Task } from "./types";
import { Button, buttonClass } from "./ui/Button";
import * as Icon from "./ui/icons";
import { StatusBadge } from "./ui/Status";
import styles from "./Outcome.module.css";

interface Props {
  task: Task;
  run: Run;
  now: number;
  github: string;
  touch?: boolean;
  // The run may run again (its task's last, failed or lost).
  onRerun?: () => void;
  rerunning?: boolean;
  // Its failure may stop asking for attention (its task's last, failed, lost or stopped).
  onDismiss?: () => void;
  dismissing?: boolean;
}

const PR_TONES: Record<PullRequest["state"], Tone> = {
  draft: "idle",
  ready: "ready",
  merged: "done",
  closed: "idle",
};

function prBadge(pr: PullRequest): string {
  if (pr.state === "merged") return pr.autoMerged ? "Merged by Deckhand" : "Merged";
  if (pr.state === "draft") return "Draft pull request";
  return `Pull request ${PR_NAMES[pr.state].toLowerCase()}`;
}

// The Claude credential a run used (Run.auth), next to its model: the plan, already paid for,
// the API key, billed per token, or a gateway's. Plain text, styled like the facts around it
// (a chip in the desktop Outcome). Nothing for runs off Anthropic, or older ones.
export function AuthTag({ auth, class: className }: { auth?: Auth | null; class?: string }) {
  if (!auth) return null;
  const { label, variable } = AUTH_NAMES[auth];
  return (
    <span class={className} title={`Ran on ${variable}`}>
      {label}
    </span>
  );
}

export function Outcome(props: Props) {
  const { task: t, run: r, now, github, touch, onRerun, rerunning, onDismiss, dismissing } = props;
  // The task's pull request is its latest run's work: an older run's says nothing of it.
  const pr = r.id === t.runs[0]?.id ? t.pr : null;
  const live = r.status === "running";
  const size = touch ? "touch" : "small";
  const replyUrl = r.replyTo !== null ? `${github}/${t.repo}/issues/${r.replyTo}` : null;
  const changed =
    pr?.additions !== undefined && pr.deletions !== undefined ? (
      <span class={styles.mono}>
        +{pr.additions} −{pr.deletions}
      </span>
    ) : null;
  const commits = pr?.commits !== undefined ? plural(pr.commits, "commit") : null;
  const actions = (
    <>
      {pr && (
        <a class={buttonClass("primary", size)} href={pr.url} target="_blank" rel="noreferrer">
          Open pull request <span class={styles.mono}>#{pr.number}</span>
        </a>
      )}
      {onRerun && (
        <Button
          variant={pr ? "secondary" : "primary"}
          size={size}
          pending={rerunning}
          pendingLabel="Rerunning…"
          shortcut="rerun"
          title="Runs it again with the same comments and mode"
          onClick={onRerun}
        >
          Rerun
        </Button>
      )}
      {onDismiss && (
        <Button
          size={size}
          pending={dismissing}
          pendingLabel="Dismissing…"
          title="It stops waiting on you until another run"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      )}
    </>
  );
  return (
    <section class={styles.outcome} aria-label="Outcome">
      <div class={styles.top}>
        {!touch && <h3 class={styles.h}>Outcome</h3>}
        <StatusBadge state={r.status} label={live ? "Working" : undefined} />
        {pr && <StatusBadge tone={PR_TONES[pr.state]} label={prBadge(pr)} />}
        {!touch && <span class={styles.actions}>{actions}</span>}
      </div>
      {live ? (
        <p class={`${styles.reply} ${styles.working}`}>Working… the log below follows it live.</p>
      ) : (
        r.summary && <p class={styles.reply}>{r.summary}</p>
      )}
      {touch ? (
        <span class={styles.line}>
          {[
            changed,
            commits,
            <span class={styles.mono}>{duration(r, now)}</span>,
            r.auth && <AuthTag auth={r.auth} />,
          ]
            .filter(Boolean)
            .map((part, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {part}
              </span>
            ))}
        </span>
      ) : (
        <div class={styles.facts}>
          {r.branch && (
            <a
              class={styles.fact}
              href={`${github}/${t.repo}/tree/${encodeURIComponent(r.branch)}`}
              target="_blank"
              rel="noreferrer"
            >
              <Icon.Branch size={14} />
              {commits ? `${commits} · ` : ""}
              {r.branch}
            </a>
          )}
          {changed && (
            <span class={styles.fact}>
              {changed}
              {pr?.changedFiles !== undefined && ` in ${plural(pr.changedFiles, "file")}`}
            </span>
          )}
          <span class={styles.fact}>
            <span class={styles.mono}>{duration(r, now)}</span>
            {r.model && ` · ${r.model}`}
            {r.effort && ` · ${r.effort} effort`}
            {r.speed === "fast" && " · fast"}
          </span>
          <AuthTag auth={r.auth} class={styles.fact} />
          {replyUrl && (
            <a class={styles.fact} href={replyUrl} target="_blank" rel="noreferrer">
              Reply on #{r.replyTo}
            </a>
          )}
        </div>
      )}
      {touch && (pr || onRerun || onDismiss) && <div class={styles.phoneActions}>{actions}</div>}
    </section>
  );
}
