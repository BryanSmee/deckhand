// The open task: its repo and title, the last reply's first line, its runs, and the log of
// the run shown (the latest unless one was picked).
import { ago, duration, githubUrl, kindName, numberOf, ownMode, runName, titleOf } from "./format";
import { Log } from "./Log";
import { PrLink } from "./PullRequest";
import { StateBadge, StateDot } from "./State";
import type { Run, Task } from "./types";
import styles from "./Detail.module.css";

interface Props {
  task: Task | null;
  run: Run | null;
  onRun: (id: string | null) => void;
  onBack: () => void;
  now: number;
  // api/state's githubUrl.
  github: string;
}

export function Detail({ task: t, run: r, onRun, onBack, now, github }: Props) {
  if (!t) {
    return (
      <div class={styles.detail}>
        <p class={styles.placeholder}>Pick an issue or pull request</p>
      </div>
    );
  }
  const url = githubUrl(t, github);
  const own = ownMode(t.mode);
  // The last reply: from the latest run that has one.
  const reply = t.runs.find((x) => x.summary);
  return (
    <div class={styles.detail}>
      <header class={styles.head}>
        <button type="button" class={styles.back} onClick={onBack}>
          ← Back
        </button>
        <a class={styles.repo} href={`${github}/${t.repo}`} target="_blank" rel="noreferrer">
          {t.repo}
        </a>
        <h1 class={styles.title}>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer">
              {titleOf(t)}
            </a>
          ) : (
            titleOf(t)
          )}{" "}
          <span class={styles.number}>{numberOf(t)}</span>
        </h1>
        <div class={styles.facts}>
          <StateBadge state={t.state} />
          <span>
            {kindName(t)}
            {own && ` · ${own} mode`}
          </span>
          {r && (
            <span>
              {new Date(r.startedAt).toLocaleString()} · {duration(r, now)}
              {r.model && ` · ${r.model}, ${r.effort} effort`}
            </span>
          )}
          {t.pr && <PrLink pr={t.pr} />}
          {url && t.replyTo !== t.number && t.replyTo !== t.pr?.number && (
            <a href={url} target="_blank" rel="noreferrer">
              Replies on #{t.replyTo}
            </a>
          )}
        </div>
        {reply && (
          <p class={styles.summary}>
            <b>Last reply</b>
            {reply.summary}
          </p>
        )}
      </header>
      {t.runs.length > 1 && (
        <nav class={styles.runs} aria-label="Runs">
          {t.runs.map((x, i) => (
            <button
              key={x.id}
              type="button"
              class={styles.run}
              aria-current={x.id === r?.id}
              title={i === 0 ? "Latest: follows the next runs" : x.id}
              onClick={() => onRun(i === 0 ? null : x.id)}
            >
              <StateDot state={x.status} />
              {runName(x)} · {x.status === "running" ? duration(x, now) : ago(x.startedAt, now)}
            </button>
          ))}
        </nav>
      )}
      {r ? (
        <Log runId={r.id} />
      ) : (
        <p class={styles.placeholder}>Waiting for the first run of {titleOf(t)} to start…</p>
      )}
    </div>
  );
}
