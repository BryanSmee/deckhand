// The open task: its repo and title, the last reply's first line, its runs, and the log of
// the run shown (the latest unless one was picked). Waiting for input: its open questions, as
// a form to answer them. Its last run failed: a button to run it again. A discussion: its
// thread, to read and reply to, or the run's log.
import { useState } from "preact/hooks";
import { sendRerun } from "./api";
import { ago, duration, githubUrl, kindName, numberOf, ownMode, runName, titleOf } from "./format";
import { Log } from "./Log";
import { PrLink } from "./PullRequest";
import { Questions } from "./Questions";
import { StateBadge, StateDot } from "./State";
import { Thread } from "./Thread";
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
  // Reads api/state again (answers sent, a rerun queued).
  refresh?: () => Promise<void>;
}

export function Detail({ task: t, run: r, onRun, onBack, now, github, refresh }: Props) {
  // What the listener said of the answers sent or the rerun asked last, on that task's page.
  const [sent, setSent] = useState<{ key: string; message: string; error?: boolean } | null>(null);
  // The run whose rerun is on its way.
  const [rerunning, setRerunning] = useState<string | null>(null);
  // A discussion's page shows its thread, or the run's log.
  const [showLog, setShowLog] = useState(false);
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
  const asked = t.state === "needs-input" ? t.questions : undefined;
  // The latest run only, and only when it is the one shown.
  const failed = t.rerunnable && r && r.id === t.runs[0]?.id ? r : null;
  const discussion = t.kind === "discussion" && t.number !== null;
  const thread = discussion && !showLog;
  const again = async (run: Run) => {
    setRerunning(run.id);
    const said = await sendRerun(t.repo, run.id);
    setSent({ key: t.key, message: said.error ?? "Rerun queued.", error: !!said.error });
    if (!said.error) await refresh?.();
    setRerunning(null);
  };
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
          {!!t.waitingFor?.length && (
            <span>
              Next run after{" "}
              {t.waitingFor.map((n, i) => (
                <span key={n}>
                  {i > 0 && (i === t.waitingFor!.length - 1 ? " and " : ", ")}
                  <a href={`${github}/${t.repo}/issues/${n}`} target="_blank" rel="noreferrer">
                    #{n}
                  </a>
                </span>
              ))}
            </span>
          )}
          {url && t.replyTo !== t.number && t.replyTo !== t.pr?.number && (
            <a href={url} target="_blank" rel="noreferrer">
              Replies on #{t.replyTo}
            </a>
          )}
          {failed && (
            <button
              type="button"
              class={styles.rerun}
              disabled={rerunning === failed.id}
              title="Runs it again with the same comments and mode"
              onClick={() => again(failed)}
            >
              {rerunning === failed.id ? "Rerunning…" : "Rerun"}
            </button>
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
              onClick={() => {
                setShowLog(true);
                onRun(i === 0 ? null : x.id);
              }}
            >
              <StateDot state={x.status} />
              {runName(x)} · {x.status === "running" ? duration(x, now) : ago(x.startedAt, now)}
            </button>
          ))}
        </nav>
      )}
      {discussion && (
        <nav class={styles.views} aria-label="Show">
          <button type="button" aria-pressed={thread} onClick={() => setShowLog(false)}>
            Thread
          </button>
          <button type="button" aria-pressed={!thread} onClick={() => setShowLog(true)}>
            Log
          </button>
        </nav>
      )}
      {sent?.key === t.key && (
        <p class={sent.error ? styles.refused : styles.sent} role="status">
          {sent.message}
        </p>
      )}
      {asked && (
        <Questions
          key={`${t.key} ${asked.raw}`}
          task={t}
          questions={asked}
          onSent={(message) => {
            setSent({ key: t.key, message });
            refresh?.();
          }}
        />
      )}
      {thread ? (
        <Thread key={t.key} task={t} now={now} refresh={refresh} />
      ) : r ? (
        <Log runId={r.id} />
      ) : asked ? null : t.state === "needs-input" ? (
        // Labelled for its open questions (an inbox run filed it, or someone wrote it so).
        <p class={styles.placeholder}>Waiting for answers to its open questions on GitHub</p>
      ) : (
        <p class={styles.placeholder}>Waiting for the first run of {titleOf(t)} to start…</p>
      )}
    </div>
  );
}
