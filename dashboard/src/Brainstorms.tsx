// The Brainstorm column, between the backlog and the graph: the issues being brainstormed,
// from a reply on its way to the wrap-up. A backlog issue dropped on it starts a brainstorm; a
// card dragged onto the graph starts work (next to a node: after that one), onto the backlog
// stops the brainstorm ("/stop"). Each card has a button for each drag, for phones and
// keyboards. On the All tab (no `repo`) it only lists them.
import { useState } from "preact/hooks";
import { Chooser, type Target } from "./Chooser";
import { BRAINSTORM_TYPE, dragOf, droppedIssue, ISSUE_TYPE, LINK_TYPES } from "./dnd";
import { sameRepo, shortRepo, STATE_NAMES, when } from "./format";
import type { BrainstormCard } from "./graphModel";
import { typesOf, useDropZone } from "./hooks";
import { IssueRow } from "./IssueRow";
import type { WorkAction } from "./types";
import styles from "./WorkArea.module.css";

// What can be done to a brainstorm now: start work on it, or stop it. Not while a reply or its
// wrap-up is on its way (the listener refuses a busy issue).
const movable = (c: BrainstormCard) =>
  !c.sending && (c.task?.state === "brainstorm" || c.task?.state === "idle-brainstorm");

interface Props {
  // Null on the All tab: read-only, none of the rest is needed.
  repo: string | null;
  cards: BrainstormCard[];
  targets?: Target[];
  // An action on its way, or the repo's config with errors: no button works.
  busy?: boolean;
  blocked?: boolean;
  github: string;
  // The graph's, which opens an issue's open questions first.
  onAct?: (action: WorkAction) => void;
  // What a drop that couldn't be sent says.
  onNotice?: (notice: string | null) => void;
  // api/state's clock.
  now: number;
}

export function Brainstorms({
  repo,
  cards,
  targets = [],
  busy = false,
  blocked = false,
  github,
  onAct = () => {},
  onNotice = () => {},
  now,
}: Props) {
  const [choosing, setChoosing] = useState<number | null>(null);
  const act = (action: WorkAction) => {
    setChoosing(null);
    onNotice(null);
    onAct(action);
  };
  const zone = useDropZone(
    (e) => {
      const types = typesOf(e);
      return (
        !!repo &&
        !blocked &&
        !types.includes(BRAINSTORM_TYPE) &&
        types.some((t) => [ISSUE_TYPE, ...LINK_TYPES].includes(t))
      );
    },
    (e) => {
      const number = droppedIssue(e.dataTransfer, [ISSUE_TYPE], github, repo);
      if (!number) {
        onNotice(
          `That isn't a link to one of ${repo}'s issues: drag an issue's card from the backlog, or its link.`,
        );
        return;
      }
      if (cards.some((c) => c.number === number && sameRepo(c.repo, repo))) return;
      act({ action: "start", number, mode: "brainstorm" });
    },
  );

  return (
    <section
      class={`${styles.panel} ${styles.column} ${zone.over ? styles.over : ""}`}
      aria-label="Brainstorms"
      {...zone.handlers}
    >
      <h2 class={styles.title}>Brainstorm</h2>
      {repo && (
        <p class={styles.note}>
          Drop an issue here to brainstorm it. Drag a brainstorm onto the graph to start work, onto
          the backlog to stop it.
        </p>
      )}
      <ul class={styles.list} aria-label="Issues being brainstormed">
        {!cards.length && <li class={styles.note}>No brainstorm going on.</li>}
        {cards.map((c) => {
          const can = !!repo && !blocked && !busy && movable(c);
          const status = c.sending ? "Sending…" : c.task ? STATE_NAMES[c.task.state] : "";
          const time = !c.sending && c.task ? when(c.task, now) : "";
          const url = `${github}/${c.repo}/issues/${c.number}`;
          return (
            <li
              key={c.key}
              class={`${styles.issue} ${c.sending ? styles.sending : ""}`}
              draggable={!!repo && !blocked && movable(c)}
              onDragStart={dragOf(BRAINSTORM_TYPE, c.number, url)}
            >
              <IssueRow
                number={c.number}
                title={c.title}
                href={url}
                repo={repo ? undefined : shortRepo(c.repo)}
              />
              <span class={styles.note}>
                <span class={styles.state}>{status}</span>
                {time && ` · ${time}`}
              </span>
              {repo && (
                <div class={styles.buttons}>
                  <button
                    type="button"
                    class={styles.primary}
                    disabled={!can}
                    aria-label={`Start work on #${c.number}`}
                    onClick={() => act({ action: "start", number: c.number })}
                  >
                    Start work
                  </button>
                  <button
                    type="button"
                    class={styles.button}
                    aria-expanded={choosing === c.number}
                    disabled={!can}
                    onClick={() => setChoosing(choosing === c.number ? null : c.number)}
                  >
                    After…
                  </button>
                  <button
                    type="button"
                    class={styles.button}
                    disabled={!can}
                    aria-label={`Stop #${c.number}'s brainstorm`}
                    onClick={() => act({ action: "stop", number: c.number })}
                  >
                    Stop
                  </button>
                </div>
              )}
              {choosing === c.number && (
                <Chooser
                  number={c.number}
                  targets={targets}
                  disabled={busy}
                  onQueue={(after) => act({ action: "queue", number: c.number, after })}
                  onCancel={() => setChoosing(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
