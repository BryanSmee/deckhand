// Tabs (the work queue's, a task's runs): a tablist whose arrows, Home and End move between
// the tabs, and pick them, as the ARIA pattern has it. Only the picked tab is in the Tab order.
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { Count } from "./Count";
import styles from "./Tabs.module.css";

export interface Tab<T extends string> {
  id: T;
  label: ComponentChildren;
  count?: number;
  // The count waits on you.
  hot?: boolean;
}

interface Props<T extends string> {
  label: string;
  tabs: readonly Tab<T>[];
  selected: T;
  onSelect: (id: T) => void;
  // The panel the tabs show (its id).
  panel?: string;
  class?: string;
}

const MOVES: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_, n) => n - 1,
};

export function Tabs<T extends string>({
  label,
  tabs,
  selected,
  onSelect,
  panel,
  class: className,
}: Props<T>) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    const move = MOVES[e.key];
    if (!move) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === selected);
    const next = move(Math.max(i, 0), tabs.length);
    onSelect(tabs[next].id);
    list.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  };
  return (
    <div
      ref={list}
      class={[styles.tabs, className].filter(Boolean).join(" ")}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          class={styles.tab}
          aria-selected={t.id === selected}
          aria-controls={panel}
          tabIndex={t.id === selected ? 0 : -1}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
          {t.count !== undefined && " "}
          {t.count !== undefined && <Count n={t.count} hot={t.hot} />}
        </button>
      ))}
    </div>
  );
}
