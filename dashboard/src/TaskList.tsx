// The tab's tasks, filtered by the state chips: title first, then number, repo and mode.
import { CHIPS, type ChipId, inChip, numberOf, ownMode, repoTabs, titleOf, when } from "./format";
import { StateDot, StateLabel } from "./State";
import type { Task } from "./types";
import styles from "./TaskList.module.css";

interface Props {
  tasks: Task[]; // the tab's
  chip: ChipId;
  onChip: (chip: ChipId) => void;
  selected: string | null;
  onSelect: (key: string) => void;
  showRepo: boolean; // the All tab: rows say their repo
  now: number;
  loading: boolean;
}

export function TaskList({
  tasks,
  chip,
  onChip,
  selected,
  onSelect,
  showRepo,
  now,
  loading,
}: Props) {
  const visible = tasks.filter((t) => inChip(chip, t));
  // Named as their tabs are.
  const labels = new Map(repoTabs(tasks).map((r) => [r.repo, r.label]));
  return (
    <div class={styles.list}>
      <div class={styles.chips} role="group" aria-label="State">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            class={styles.chip}
            aria-pressed={c.id === chip}
            onClick={() => onChip(c.id)}
          >
            {c.name}
            <span>{tasks.filter((t) => inChip(c.id, t)).length}</span>
          </button>
        ))}
      </div>
      {visible.length ? (
        <ul class={styles.rows}>
          {visible.map((t) => (
            <li key={t.key}>
              <Row
                task={t}
                current={t.key === selected}
                repo={showRepo ? (labels.get(t.repo) ?? t.repo) : null}
                {...{ onSelect, now }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p class={styles.empty}>
          {loading ? "Loading…" : tasks.length ? "Nothing in this state" : "No runs yet"}
        </p>
      )}
    </div>
  );
}

function Row({
  task: t,
  current,
  repo,
  onSelect,
  now,
}: {
  task: Task;
  current: boolean;
  repo: string | null;
  onSelect: (key: string) => void;
  now: number;
}) {
  const own = ownMode(t.mode);
  return (
    <button type="button" class={styles.row} aria-current={current} onClick={() => onSelect(t.key)}>
      <span class={styles.dot}>
        <StateDot state={t.state} />
      </span>
      <span class={styles.title} title={t.title ?? undefined}>
        {titleOf(t)}
      </span>
      <span class={styles.when}>{when(t, now)}</span>
      <span class={styles.sub}>
        {numberOf(t)}
        {repo && (
          <>
            {" · "}
            <span class={styles.repo}>{repo}</span>
          </>
        )}
        {own && (
          <>
            {" · "}
            <span class={styles.mode}>{own}</span>
          </>
        )}
        {t.kind && !["issue", "pr"].includes(t.kind) && ` · ${t.kind}`}
      </span>
      <span class={styles.state}>
        <StateLabel state={t.state} />
      </span>
    </button>
  );
}
