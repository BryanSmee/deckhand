// The Backlog tab's filters (WorkQueue.tsx): its text field (an issue's number and title), its
// labels (a list to tick, opened from a button: an issue with any of those ticked shows, ""
// for one with none) and "Hide sub-issues" (those whose parent is listed: starting the parent
// lays them out). The labels are kept per repository, the toggle once for all (prefs.ts); the
// text isn't kept. A label ticked that no listed issue has any more is left out of the filter,
// and of the list.
import { useId, useRef, useState } from "preact/hooks";
import { t } from "./i18n";
import type { BacklogIssue, BacklogLabel } from "./types";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Choice";
import { Count } from "./ui/Count";
import { Field } from "./ui/Field";
import { FilterChip } from "./ui/FilterChip";
import * as Icon from "./ui/icons";
import styles from "./BacklogFilter.module.css";

// "No label"'s entry: GitHub's label names are never empty.
export const NO_LABEL = "";

export interface LabelCount extends BacklogLabel {
  count: number;
}

// The labels `issues` have, by name, with how many have each; "No label" last, when some have none.
export function labelCounts(issues: readonly BacklogIssue[]): LabelCount[] {
  const found = new Map<string, LabelCount>();
  let none = 0;
  for (const issue of issues) {
    if (!issue.labels?.length) none++;
    for (const l of issue.labels ?? []) {
      const known = found.get(l.name);
      if (known) known.count++;
      else found.set(l.name, { ...l, count: 1 });
    }
  }
  const named = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return none ? [...named, { name: NO_LABEL, color: null, count: none }] : named;
}

// Those of `ticked` some issue still has.
export const tickedOf = (counts: readonly LabelCount[], ticked: readonly string[]) =>
  ticked.filter((name) => counts.some((l) => l.name === name));

// A sub-issue whose parent is among `issues`.
export function hiddenSubIssue(issue: BacklogIssue, listed: ReadonlySet<number>) {
  return issue.parent !== undefined && listed.has(issue.parent);
}

// What the labels ticked (any of them; none: every issue) and the toggle leave of `issues`.
// The labels first: a sub-issue is hidden only when its parent shows, which lays it out (a
// `bug` under an epic that isn't one still shows when `bug` is ticked).
export function narrowBacklog(
  issues: readonly BacklogIssue[],
  ticked: readonly string[],
  hideSubIssues: boolean,
): BacklogIssue[] {
  const labels = new Set(tickedOf(labelCounts(issues), ticked));
  const labelled = issues.filter((i) => {
    if (!labels.size) return true;
    const names = i.labels?.length ? i.labels.map((l) => l.name) : [NO_LABEL];
    return names.some((n) => labels.has(n));
  });
  if (!hideSubIssues) return labelled;
  const shown = new Set(labelled.map((i) => i.number));
  return labelled.filter((i) => !hiddenSubIssue(i, shown));
}

// What the text field leaves: `#<n> <title>` holds its words, as typed.
export function matchesText(issue: BacklogIssue, text: string) {
  const words = text.trim().toLowerCase();
  return !words || `#${issue.number} ${issue.title ?? ""}`.toLowerCase().includes(words);
}

// A label's swatch: GitHub's colour, the border's when it has none (No label).
export function Swatch({ color }: { color: string | null }) {
  return (
    <span
      class={styles.swatch}
      style={color && /^[0-9a-f]{6}$/i.test(color) ? { background: `#${color}` } : undefined}
      aria-hidden="true"
    />
  );
}

interface Props {
  // Every issue the backlog lists (before these filters): the labels offered are theirs.
  issues: readonly BacklogIssue[];
  // How many the labels and the toggle leave: the text field's placeholder.
  count: number;
  text: string;
  onText: (text: string) => void;
  ticked: readonly string[];
  onTicked: (labels: string[]) => void;
  hideSubIssues: boolean;
  onHideSubIssues: (on: boolean) => void;
  touch: boolean;
}

export function BacklogFilter({
  issues,
  count,
  text,
  onText,
  ticked,
  onTicked,
  hideSubIssues,
  onHideSubIssues,
  touch,
}: Props) {
  const [open, setOpen] = useState(false);
  // The row, whose labels' button focus goes back to (Button takes no ref).
  const row = useRef<HTMLDivElement>(null);
  const listId = useId();
  const counts = labelCounts(issues);
  const on = tickedOf(counts, ticked);
  // Offered when an issue has a label, or is a sub-issue of another listed one.
  const labelled = counts.some((l) => l.name !== NO_LABEL);
  const listed = new Set(issues.map((i) => i.number));
  const subs = issues.some((i) => hiddenSubIssue(i, listed));
  // From all those kept: a label gone keeps its tick, for when it comes back.
  const tick = (name: string, checked: boolean) =>
    onTicked(checked ? [...ticked, name] : ticked.filter((n) => n !== name));
  const size = touch ? "touch" : "small";

  return (
    <div class={`${styles.filters} ${touch ? styles.touch : ""}`}>
      <div ref={row} class={styles.row}>
        <Field
          class={styles.text}
          label={t("queue.filter")}
          hideLabel
          size={size}
          lead={<Icon.Search size={14} />}
          placeholder={t("queue.filterPlaceholder", { count })}
          value={text}
          onInput={(e) => onText(e.currentTarget.value)}
        />
        {(labelled || on.length > 0) && (
          <Button
            size={size}
            variant={on.length ? "primary" : "secondary"}
            icon={<Icon.Filters size={14} />}
            aria-label={t("queue.labelsAria")}
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            {t("queue.labels")}
            {on.length > 0 && <Count n={on.length} class={styles.count} />}
          </Button>
        )}
        {(subs || hideSubIssues) && (
          <FilterChip
            class={touch ? styles.touchChip : styles.chip}
            pressed={hideSubIssues}
            onClick={() => onHideSubIssues(!hideSubIssues)}
          >
            {t("queue.hideSubIssues")}
          </FilterChip>
        )}
      </div>
      {open && (labelled || on.length > 0) && (
        <div
          id={listId}
          role="group"
          aria-label={t("queue.labelsList")}
          class={styles.labels}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            setOpen(false);
            row.current?.querySelector<HTMLElement>(`[aria-controls="${listId}"]`)?.focus();
          }}
        >
          <ul class={styles.options}>
            {counts.map((l) => (
              <li key={l.name}>
                <Checkbox
                  class={styles.option}
                  checked={on.includes(l.name)}
                  onChange={(checked) => tick(l.name, checked)}
                  label={
                    <>
                      <Swatch color={l.color} />
                      <span class={styles.name}>
                        {l.name === NO_LABEL ? t("queue.noLabel") : l.name}
                      </span>
                      <span class={styles.n}>{l.count}</span>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
          {on.length > 0 && (
            <Button size={size} variant="ghost" class={styles.clear} onClick={() => onTicked([])}>
              {t("queue.clearLabels")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
