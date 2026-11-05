// The tab's tasks, found by the search box and filtered by the state chips: each row its title
// and time, then its number, repo, mode, pull request and review round, its state on the right;
// under them, what a review-and-fix loop left on a ready pull request.
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import {
  CHIPS,
  type ChipId,
  inChip,
  isPrTask,
  isReady,
  kindName,
  loopLine,
  matchesSearch,
  modeOf,
  numberOf,
  prName,
  prTitle,
  repoTabs,
  taskStatus,
  titleOf,
  when,
  whenTitle,
} from "./format";
import { locale, t } from "./i18n";
import { useShortcuts, useShortcutsOn, withKey } from "./keys";
import { CiStatus } from "./CiStatus";
import { ReviewMarks } from "./ReviewLoop";
import type { Task } from "./types";
import { AutoMark } from "./ui/AutoMark";
import { Field } from "./ui/Field";
import { FilterChip } from "./ui/FilterChip";
import { Search } from "./ui/icons";
import { StatusDot, toneClass } from "./ui/Status";
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
  const root = useRef<HTMLDivElement>(null);
  const [shortcuts] = useShortcutsOn();
  const input = () => box.current?.querySelector("input");
  // The chips count what the search finds: a chip's count is the rows it shows.
  const found = tasks.filter((task) => matchesSearch(task, query));
  const visible = found.filter((task) => inChip(chip, task));
  // Named as their tabs are.
  const labels = new Map(repoTabs(tasks).map((r) => [r.repo.toLowerCase(), r.label]));

  // "/" goes to the search box, opening it first on a phone.
  useShortcuts({
    search: () => {
      onSearching(true);
      input()?.focus();
    },
  });
  // The task J and K moved to, in sight.
  useEffect(() => {
    root.current?.querySelector("[aria-current=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
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
    <div class={`${styles.list} ${touch ? styles.touch : ""}`} ref={root}>
      <div class={styles.filters}>
        {(searching || !!query) && (
          <div ref={box}>
            <Field
              label={t("taskList.search")}
              hideLabel
              type="search"
              placeholder={t("taskList.search")}
              lead={<Search size={15} />}
              hint={touch || query || !shortcuts ? undefined : "/"}
              size={touch ? "touch" : "default"}
              value={query}
              onInput={(e) => onQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
          </div>
        )}
        <div class={styles.chips} role="group" aria-label={t("taskList.state")}>
          {CHIPS.map((c, i) => (
            <FilterChip
              key={c.id}
              title={withKey(t("taskList.filter", { name: t(c.name) }), "filter", i)}
              class={styles.chip}
              pressed={c.id === chip}
              count={found.filter((task) => inChip(c.id, task)).length}
              onClick={() => onChip(c.id)}
            >
              {t(c.name)}
            </FilterChip>
          ))}
        </div>
      </div>
      {visible.length ? (
        <ul class={styles.rows}>
          {visible.map((task) => (
            <li key={task.key}>
              <Row
                task={task}
                current={task.key === selected}
                repo={showRepo ? (labels.get(task.repo.toLowerCase()) ?? task.repo) : null}
                {...{ onSelect, now }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p class={styles.empty}>
          {loading
            ? t("taskList.loading")
            : !tasks.length
              ? t("taskList.noRuns")
              : query.trim() && !found.length
                ? t("taskList.noMatch", { query: query.trim() })
                : t("taskList.noneInState")}
        </p>
      )}
    </div>
  );
}

// What a row's second line says the task is: its mode ("work"), or its kind when that says
// more ("brainstorm", "bug report"), with the repo's own mode after it.
function kindOf(task: Task): string | null {
  if (task.kind === "issue" || task.kind === "pr") return task.mode;
  return [kindName(task).toLocaleLowerCase(locale()), modeOf(task)].filter(Boolean).join(" · ");
}

function Row({
  task,
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
  const { tone, label } = taskStatus(task);
  const kind = kindOf(task);
  const parts = [
    repo && (
      <span key="repo" class={styles.repo}>
        {repo}
      </span>
    ),
    kind && <span key="kind">{kind}</span>,
    // A pull request's own task: its number already says it.
    task.pr && !isPrTask(task) && (
      <span key="pr">
        <span title={prTitle(task.pr)}>{prName(task.pr)}</span>
        <CiStatus pr={task.pr} class={styles.ci} />
      </span>
    ),
    loopLine(task) && <span key="loop">{loopLine(task)}</span>,
  ].filter(Boolean);
  return (
    <button
      type="button"
      class={styles.row}
      aria-current={current}
      onClick={() => onSelect(task.key)}
    >
      <StatusDot state={task.state} tone={tone} class={styles.dot} />
      <span class={styles.title} title={task.title ?? undefined}>
        {titleOf(task)}
      </span>
      <span class={styles.when} title={whenTitle(task, now) ?? undefined}>
        {when(task, now)}
      </span>
      <span class={styles.sub}>
        <span class={styles.number}>{numberOf(task)}</span>
        {/* A pull request's own task: its CI beside its number. */}
        {task.pr && isPrTask(task) && <CiStatus pr={task.pr} class={styles.ci} />}
        {/* Picked by auto-pickup: its mark beside the number, where an ellipsis can't hide it. */}
        {task.autoPickup && <AutoMark class={styles.auto} />}
        {parts.map((p, i) => (
          <Fragment key={i}>
            {(i > 0 || numberOf(task)) && " · "}
            {p}
          </Fragment>
        ))}
      </span>
      <span class={`${styles.state} ${toneClass(tone)}`}>{label}</span>
      {isReady(task) && <ReviewMarks task={task} class={styles.left} />}
    </button>
  );
}
