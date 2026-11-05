// A run's outcome, above its log: how it ended and its pull request, its reply (three lines on
// a phone), what to do next (Open pull request, Rerun, Dismiss), then its facts: the branch and its
// commits, the change's size (the latest run's only: the pull request is the task's), how long, on which model, and where it replies. A run going on
// says so instead.
import { AUTH_NAMES, duration, readyStatus, STATE_NAMES, type Tone } from "./format";
// `tr`: t() where the task is called `t`.
import { t as tr, tx } from "./i18n";
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

// Its tone and word: a ready one's as the task's (readyStatus()), purple only when clean.
function prBadge(t: Task, pr: PullRequest): { tone: Tone; label: string } {
  if (pr.state === "merged")
    return {
      tone: "done",
      label: pr.autoMerged ? tr("detail.mergedByDeckhand") : tr("outcome.merged"),
    };
  if (pr.state === "draft") return { tone: "idle", label: tr("outcome.draft") };
  if (pr.state !== "ready") return { tone: "idle", label: tr("outcome.closed") };
  const label = tr("outcome.ready");
  // Still in its review loop: on its way, like the task.
  const ready = readyStatus({ pr, review: t.review });
  if (!ready)
    return {
      tone: "run",
      label: tr("outcome.withStatus", { label, status: tr(STATE_NAMES["in-review"]) }),
    };
  return {
    tone: ready.tone,
    label:
      ready.tone === "ready" ? label : tr("outcome.withStatus", { label, status: ready.label }),
  };
}

// The Claude credential a run used (Run.auth), next to its model: the plan, already paid for,
// the API key, billed per token, or a gateway's. Plain text, styled like the facts around it
// (a chip in the desktop Outcome). Nothing for runs off Anthropic, or older ones.
export function AuthTag({ auth, class: className }: { auth?: Auth | null; class?: string }) {
  if (!auth) return null;
  const { label, variable } = AUTH_NAMES[auth];
  return (
    <span class={className} title={tr("outcome.ranOn", { variable })}>
      {tr(label)}
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
  const commits = pr?.commits !== undefined ? tr("outcome.commits", { count: pr.commits }) : null;
  const actions = (
    <>
      {pr && (
        <a class={buttonClass("primary", size)} href={pr.url} target="_blank" rel="noreferrer">
          {tx("outcome.openPr", { number: <span class={styles.mono}>#{pr.number}</span> })}
        </a>
      )}
      {onRerun && (
        <Button
          variant={pr ? "secondary" : "primary"}
          size={size}
          pending={rerunning}
          pendingLabel={tr("detail.rerunning")}
          shortcut="rerun"
          title={tr("detail.rerunHelp")}
          onClick={onRerun}
        >
          {tr("detail.rerun")}
        </Button>
      )}
      {onDismiss && (
        <Button
          size={size}
          pending={dismissing}
          pendingLabel={tr("detail.dismissing")}
          title={tr("detail.dismissHelp")}
          onClick={onDismiss}
        >
          {tr("detail.dismiss")}
        </Button>
      )}
    </>
  );
  return (
    <section class={styles.outcome} aria-label={tr("outcome.outcome")}>
      <div class={styles.top}>
        {!touch && <h3 class={styles.h}>{tr("outcome.outcome")}</h3>}
        <StatusBadge state={r.status} label={live ? tr(STATE_NAMES.working) : undefined} />
        {pr && <StatusBadge {...prBadge(t, pr)} />}
        {!touch && <span class={styles.actions}>{actions}</span>}
      </div>
      {live ? (
        <p class={`${styles.reply} ${styles.working}`}>{tr("outcome.working")}</p>
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
              {pr?.changedFiles !== undefined
                ? tx("outcome.changedIn", { changed, count: pr.changedFiles })
                : changed}
            </span>
          )}
          <span class={styles.fact}>
            <span class={styles.mono}>{duration(r, now)}</span>
            {r.model && ` · ${r.model}`}
            {r.effort && ` · ${tr("detail.effort", { effort: r.effort })}`}
            {r.speed === "fast" && ` · ${tr("detail.fast")}`}
          </span>
          <AuthTag auth={r.auth} class={styles.fact} />
          {replyUrl && (
            <a class={styles.fact} href={replyUrl} target="_blank" rel="noreferrer">
              {tr("outcome.replyOn", { number: r.replyTo! })}
            </a>
          )}
        </div>
      )}
      {touch && (pr || onRerun || onDismiss) && <div class={styles.phoneActions}>{actions}</div>}
    </section>
  );
}
