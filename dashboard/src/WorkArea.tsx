// The graph's work area panel: the repo's backlog (open issues with nothing live), its waiting
// issues and those waiting for answers, with a button for each drag the graph and the
// Brainstorm column take (Start, Brainstorm, Queue after…, Remove), for phones and keyboards.
// The drags themselves are the graph's (Graph.tsx) and the column's (Brainstorms.tsx), and so
// is the form an issue's open questions open first. A brainstorm dropped here stops.
import { useState } from "preact/hooks";
import type { WorkAreaState } from "./api";
import { Chooser, type Target } from "./Chooser";
import { BRAINSTORM_TYPE, dragOf, ISSUE_TYPE } from "./dnd";
import { issueList } from "./format";
import { typesOf, useDropZone } from "./hooks";
import { IssueRow } from "./IssueRow";
import type { Task, WorkAction } from "./types";
import styles from "./WorkArea.module.css";

interface Props {
  repo: string;
  work: WorkAreaState;
  targets: Target[];
  // The repo's tasks that wait for others ("/after").
  waiting: Task[];
  // Its issues waiting for answers: starting or queueing one asks its questions first.
  answering?: Task[];
  // GitHub's address, for the links the drag of a task's card carries.
  github?: string;
  mode: string;
  onMode: (mode: string) => void;
  // What a drop that couldn't be sent says (a link from another repo).
  notice: string | null;
  // Takes an action: the graph's, which opens an issue's open questions first.
  onAct?: (action: WorkAction) => void;
}

export function WorkArea({
  repo,
  work,
  targets,
  waiting,
  answering = [],
  github = "https://github.com",
  mode,
  onMode,
  notice,
  onAct = (action) => void work.act(action),
}: Props) {
  // The issue whose "Queue after…" is open.
  const [choosing, setChoosing] = useState<number | null>(null);
  const { backlog, busy, result } = work;
  // Those an action on its way takes: they come back if it fails.
  const sent = new Set(work.pending.map((p) => p.number));
  const issues = backlog?.issues.filter((i) => !sent.has(i.number)) ?? [];
  const modes = backlog?.modes.length ? backlog.modes : ["work"];
  const blocked = !!backlog?.errors;
  const picked = mode === "work" ? {} : { mode };
  const brainstorms = modes.includes("brainstorm");
  const act = (action: WorkAction) => {
    setChoosing(null);
    onAct(action);
  };
  // A brainstorm's card is dragged over the panel: let go, it stops.
  const zone = useDropZone(
    (e) => !blocked && typesOf(e).includes(BRAINSTORM_TYPE),
    (e) => {
      const number = Number(e.dataTransfer?.getData(BRAINSTORM_TYPE));
      if (number) act({ action: "stop", number });
    },
    { effect: "move" },
  );
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
    <section
      class={`${styles.panel} ${zone.over ? styles.over : ""}`}
      aria-label="Work area"
      {...zone.handlers}
    >
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
        queue it after that one, or onto the Brainstorm column to brainstorm it; one waiting for
        answers too, which asks them first. Drag a waiting issue away to cancel its wait.
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
            {!issues.length && <li class={styles.note}>No open issue left to start.</li>}
            {issues.map((i) => (
              <li
                key={i.number}
                class={styles.issue}
                draggable={!blocked}
                onDragStart={dragOf(ISSUE_TYPE, i.number, i.url)}
              >
                <IssueRow number={i.number} title={i.title} href={i.url} />
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
                  {brainstorms && (
                    <button
                      type="button"
                      class={styles.button}
                      disabled={busy || blocked}
                      aria-label={`Brainstorm #${i.number}`}
                      onClick={() => act({ action: "start", number: i.number, mode: "brainstorm" })}
                    >
                      Brainstorm
                    </button>
                  )}
                  {afterButton(i.number)}
                </div>
                {chooser(i.number, false)}
              </li>
            ))}
          </ul>
        )
      )}
      {answering.length > 0 && (
        <>
          <h2 class={styles.title}>Waiting for answers</h2>
          <ul class={styles.list} aria-label="Issues waiting for answers">
            {answering.map((t) => (
              <li
                key={t.key}
                class={styles.issue}
                draggable={!blocked}
                onDragStart={dragOf(
                  ISSUE_TYPE,
                  t.number!,
                  `${github}/${t.repo}/issues/${t.number}`,
                )}
              >
                <IssueRow number={t.number!} title={t.title} />
                {t.questions && (
                  <span class={styles.note}>Its open questions are asked before it starts.</span>
                )}
                <div class={styles.buttons}>
                  <button
                    type="button"
                    class={styles.primary}
                    disabled={busy || blocked}
                    aria-label={`Start #${t.number}`}
                    onClick={() => act({ action: "start", number: t.number!, ...picked })}
                  >
                    Start
                  </button>
                  {afterButton(t.number!)}
                </div>
                {chooser(t.number!, false)}
              </li>
            ))}
          </ul>
        </>
      )}
      {waiting.length > 0 && (
        <>
          <h2 class={styles.title}>Waiting</h2>
          <ul class={styles.list} aria-label="Waiting issues">
            {waiting.map((t) => (
              <li key={t.key} class={styles.issue}>
                <IssueRow number={t.number!} title={t.title} />
                <span class={styles.note}>after {issueList(t.waitingFor ?? [])}</span>
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
