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
import { t } from "./i18n";
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
  const found = tasks.filter((t) => matchesSearch(t, query));
  const visible = found.filter((t) => inChip(chip, t));
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
              count={found.filter((t) => inChip(c.id, t)).length}
              onClick={() => onChip(c.id)}
            >
              {t(c.name)}
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
  const { tone, label } = taskStatus(t);
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
      <span key="pr">
        <span title={prTitle(t.pr)}>{prName(t.pr)}</span>
        <CiStatus pr={t.pr} class={styles.ci} />
      </span>
    ),
    loopLine(t) && <span key="loop">{loopLine(t)}</span>,
  ].filter(Boolean);
  return (
    <button type="button" class={styles.row} aria-current={current} onClick={() => onSelect(t.key)}>
      <StatusDot state={t.state} tone={tone} class={styles.dot} />
      <span class={styles.title} title={t.title ?? undefined}>
        {titleOf(t)}
      </span>
      <span class={styles.when} title={whenTitle(t, now) ?? undefined}>
        {when(t, now)}
      </span>
      <span class={styles.sub}>
        <span class={styles.number}>{numberOf(t)}</span>
        {/* A pull request's own task: its CI beside its number. */}
        {t.pr && isPrTask(t) && <CiStatus pr={t.pr} class={styles.ci} />}
        {/* Picked by auto-pickup: its mark beside the number, where an ellipsis can't hide it. */}
        {t.autoPickup && <AutoMark class={styles.auto} />}
        {parts.map((p, i) => (
          <Fragment key={i}>
            {(i > 0 || numberOf(t)) && " · "}
            {p}
          </Fragment>
        ))}
      </span>
      <span class={`${styles.state} ${toneClass(tone)}`}>{label}</span>
      {isReady(t) && <ReviewMarks task={t} class={styles.left} />}
    </button>
  );
}
