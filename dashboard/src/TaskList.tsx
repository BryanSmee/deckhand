// The tab's tasks, found by the search box and filtered by the state chips: each row its title
// and time, then its number, repo, mode and pull request, its state on the right.
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import {
  CHIPS,
  type ChipId,
  inChip,
  isPrTask,
  kindName,
  matchesSearch,
  modeOf,
  numberOf,
  prName,
  prTitle,
  repoTabs,
  taskTone,
  titleOf,
  when,
} from "./format";
import type { Task } from "./types";
import { Field } from "./ui/Field";
import { FilterChip } from "./ui/FilterChip";
import { Search } from "./ui/icons";
import { StatusDot, stateName, toneClass } from "./ui/Status";
import styles from "./TaskList.module.css";

interface Props {
  tasks: Task[]; // the tab's
  chip: ChipId;
  onChip: (chip: ChipId) => void;
  query: string;
  onQuery: (query: string) => void;
  // The search box shows: always on a wide screen, once its button is pressed on a phone.
  searching: boolean;
  onSearching: (open: boolean) => void;
  selected: string | null;
  onSelect: (key: string) => void;
  showRepo: boolean; // the All tab: rows say their repo
  now: number;
  loading: boolean;
  // A phone's: 44 px targets.
  touch?: boolean;
}

// A key typed in a field is the field's, not a shortcut.
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function TaskList({
  tasks,
  chip,
  onChip,
  query,
  onQuery,
  searching,
  onSearching,
  selected,
  onSelect,
  showRepo,
  now,
  loading,
  touch,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const input = () => box.current?.querySelector("input");
  // The chips count what the search finds: a chip's count is the rows it shows.
  const found = tasks.filter((t) => matchesSearch(t, query));
  const visible = found.filter((t) => inChip(chip, t));
  // Named as their tabs are.
  const labels = new Map(repoTabs(tasks).map((r) => [r.repo.toLowerCase(), r.label]));

  // "/" goes to the search box, opening it first on a phone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      onSearching(true);
      input()?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onSearching]);
  // Opened on a phone: straight into it.
  useEffect(() => {
    if (touch && searching) input()?.focus();
  }, [touch, searching]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (query) onQuery("");
    else if (touch) onSearching(false);
    else (e.currentTarget as HTMLInputElement).blur();
  };
  return (
    <div class={`${styles.list} ${touch ? styles.touch : ""}`}>
      <div class={styles.filters}>
        {(searching || !!query) && (
          <div ref={box}>
            <Field
              label="Search tasks"
              hideLabel
              type="search"
              placeholder="Search tasks"
              lead={<Search size={15} />}
              hint={touch || query ? undefined : "/"}
              size={touch ? "touch" : "default"}
              value={query}
              onInput={(e) => onQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
          </div>
        )}
        <div class={styles.chips} role="group" aria-label="State">
          {CHIPS.map((c) => (
            <FilterChip
              key={c.id}
              class={styles.chip}
              pressed={c.id === chip}
              count={found.filter((t) => inChip(c.id, t)).length}
              onClick={() => onChip(c.id)}
            >
              {c.name}
            </FilterChip>
          ))}
        </div>
      </div>
      {visible.length ? (
        <ul class={styles.rows}>
          {visible.map((t) => (
            <li key={t.key}>
              <Row
                task={t}
                current={t.key === selected}
                repo={showRepo ? (labels.get(t.repo.toLowerCase()) ?? t.repo) : null}
                {...{ onSelect, now }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p class={styles.empty}>
          {loading
            ? "Loading…"
            : !tasks.length
              ? "No runs yet"
              : query.trim() && !found.length
                ? `No task matches “${query.trim()}”`
                : "Nothing in this state"}
        </p>
      )}
    </div>
  );
}

// What a row's second line says the task is: its mode ("work"), or its kind when that says
// more ("brainstorm", "bug report"), with the repo's own mode after it.
function kindOf(t: Task): string | null {
  if (t.kind === "issue" || t.kind === "pr") return t.mode;
  return [kindName(t).toLowerCase(), modeOf(t)].filter(Boolean).join(" · ");
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
  const tone = taskTone(t);
  const kind = kindOf(t);
  const parts = [
    repo && (
      <span key="repo" class={styles.repo}>
        {repo}
      </span>
    ),
    kind && <span key="kind">{kind}</span>,
    // A pull request's own task: its number already says it.
    t.pr && !isPrTask(t) && (
      <span key="pr" title={prTitle(t.pr)}>
        {prName(t.pr)}
      </span>
    ),
  ].filter(Boolean);
  return (
    <button type="button" class={styles.row} aria-current={current} onClick={() => onSelect(t.key)}>
      <StatusDot state={t.state} tone={tone} class={styles.dot} />
      <span class={styles.title} title={t.title ?? undefined}>
        {titleOf(t)}
      </span>
      <span class={styles.when}>{when(t, now)}</span>
      <span class={styles.sub}>
        <span class={styles.number}>{numberOf(t)}</span>
        {parts.map((p, i) => (
          <Fragment key={i}>
            {(i > 0 || numberOf(t)) && " · "}
            {p}
          </Fragment>
        ))}
      </span>
      <span class={`${styles.state} ${toneClass(tone)}`}>{stateName(t.state)}</span>
    </button>
  );
}
