// The graph's work area panel: the repo's backlog (open issues with no task yet) and its
// waiting issues, with a button for each drag the graph takes (Start, Queue after…, Remove),
// for phones and keyboards. The drags themselves are the graph's (Graph.tsx).
import { useState } from "preact/hooks";
import type { WorkArea as Work } from "./api";
import type { Task, WorkAction } from "./types";
import styles from "./WorkArea.module.css";

// An issue a drop or "Queue after…" can put another one after: a node of the graph.
export interface Target {
  key: string;
  number: number;
  label: string;
}

// The drag's payload from the backlog: the issue's number (its link goes along, as text).
export const ISSUE_TYPE = "application/x-deckhand-issue";

interface Props {
  repo: string;
  work: Work;
  targets: Target[];
  // The repo's tasks that wait for others ("/after").
  waiting: Task[];
  mode: string;
  onMode: (mode: string) => void;
  // What a drop that couldn't be sent says (a link from another repo).
  notice: string | null;
}

// "Queue after…": the graph's issues to pick from, then Queue.
function Chooser({
  number,
  targets,
  disabled,
  onQueue,
  onCancel,
}: {
  number: number;
  targets: Target[];
  disabled: boolean;
  onQueue: (after: number) => void;
  onCancel: () => void;
}) {
  const options = targets.filter((t) => t.number !== number);
  const [after, setAfter] = useState(options[0]?.number ?? null);
  if (!options.length) {
    return (
      <div class={styles.chooser}>
        <span class={styles.note}>No issue on the graph to queue it after.</span>
        <button type="button" class={styles.button} onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div class={styles.chooser}>
      <select
        aria-label={`Queue #${number} after`}
        value={after ?? undefined}
        onChange={(e) => setAfter(Number(e.currentTarget.value))}
      >
        {options.map((t) => (
          <option key={t.key} value={t.number}>
            {t.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        class={styles.primary}
        disabled={disabled || after === null}
        onClick={() => after !== null && onQueue(after)}
      >
        Queue
      </button>
      <button type="button" class={styles.button} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function WorkArea({ repo, work, targets, waiting, mode, onMode, notice }: Props) {
  // The issue whose "Queue after…" is open.
  const [choosing, setChoosing] = useState<number | null>(null);
  const { backlog, busy, result } = work;
  const modes = backlog?.modes.length ? backlog.modes : ["work"];
  const blocked = !!backlog?.errors;
  const picked = mode === "work" ? {} : { mode };
  const act = (action: WorkAction) => {
    setChoosing(null);
    work.act(action);
  };
  const said = notice ?? result?.error ?? result?.message ?? null;
  const failed = !!(notice || result?.error);

  const chooser = (number: number, move: boolean) =>
    choosing === number && (
      <Chooser
        number={number}
        targets={targets}
        disabled={busy}
        onQueue={(after) => act({ action: "queue", number, after, ...(move ? {} : picked) })}
        onCancel={() => setChoosing(null)}
      />
    );
  const afterButton = (number: number) => (
    <button
      type="button"
      class={styles.button}
      aria-expanded={choosing === number}
      disabled={busy || blocked}
      onClick={() => setChoosing(choosing === number ? null : number)}
    >
      After…
    </button>
  );

  return (
    <section class={styles.panel} aria-label="Work area">
      <div class={styles.head}>
        <h2 class={styles.title}>Backlog</h2>
        <label class={styles.mode}>
          Start in
          <select value={mode} disabled={blocked} onChange={(e) => onMode(e.currentTarget.value)}>
            {modes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p class={styles.note}>
        Drag an issue (or a GitHub link to one) onto the graph to start it, next to an issue to
        queue it after that one. Drag a waiting issue away to cancel its wait.
      </p>
      {said && (
        <p class={`${styles.said} ${failed ? styles.failed : ""}`} role="status">
          {said}
        </p>
      )}
      {blocked && (
        <p class={`${styles.said} ${styles.failed}`}>
          {repo}'s .deckhand.yaml has errors: nothing starts until they are fixed.
        </p>
      )}
      {work.error && !backlog && (
        <p class={`${styles.said} ${styles.failed}`}>Can't read the issues ({work.error}).</p>
      )}
      {!backlog && !work.error ? (
        <p class={styles.note}>Loading…</p>
      ) : (
        backlog && (
          <ul class={styles.list} aria-label="Open issues with no task">
            {!backlog.issues.length && <li class={styles.note}>No open issue left to start.</li>}
            {backlog.issues.map((i) => (
              <li
                key={i.number}
                class={styles.issue}
                draggable={!blocked}
                onDragStart={(e) => {
                  e.dataTransfer?.setData(ISSUE_TYPE, String(i.number));
                  e.dataTransfer?.setData("text/uri-list", i.url);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
                }}
              >
                <div class={styles.row}>
                  <a class={styles.ref} href={i.url} target="_blank" rel="noreferrer">
                    #{i.number}
                  </a>
                  <span class={styles.name}>{i.title ?? `Issue #${i.number}`}</span>
                </div>
                <div class={styles.buttons}>
                  <button
                    type="button"
                    class={styles.primary}
                    disabled={busy || blocked}
                    aria-label={`Start #${i.number}`}
                    onClick={() => act({ action: "start", number: i.number, ...picked })}
                  >
                    Start
                  </button>
                  {afterButton(i.number)}
                </div>
                {chooser(i.number, false)}
              </li>
            ))}
          </ul>
        )
      )}
      {waiting.length > 0 && (
        <>
          <h2 class={styles.title}>Waiting</h2>
          <ul class={styles.list} aria-label="Waiting issues">
            {waiting.map((t) => (
              <li key={t.key} class={styles.issue}>
                <div class={styles.row}>
                  <span class={styles.ref}>#{t.number}</span>
                  <span class={styles.name}>{t.title ?? `Issue #${t.number}`}</span>
                </div>
                <span class={styles.note}>
                  after {(t.waitingFor ?? []).map((n) => `#${n}`).join(", ")}
                </span>
                <div class={styles.buttons}>
                  <button
                    type="button"
                    class={styles.button}
                    disabled={busy || blocked}
                    aria-label={`Start #${t.number} now`}
                    // Its wait's mode, as moving it keeps.
                    onClick={() => act({ action: "start", number: t.number! })}
                  >
                    Start now
                  </button>
                  {afterButton(t.number!)}
                  <button
                    type="button"
                    class={styles.button}
                    disabled={busy || blocked}
                    aria-label={`Remove #${t.number}'s wait`}
                    onClick={() => act({ action: "dequeue", number: t.number! })}
                  >
                    Remove
                  </button>
                </div>
                {chooser(t.number!, true)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
