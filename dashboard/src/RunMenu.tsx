// A task's All runs: the button at the end of its tab row, and the list of every run it opens,
// newest first and numbered from the oldest (#1), the one shown ticked. A popover under the
// button on a desktop, a Sheet on a phone. A listbox: arrows, Home and End move, Enter picks,
// Escape closes (Tab too, the popover); focus goes back to the button. Detail.tsx shows it past 3 runs.
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { dayTime, duration, runName } from "./format";
import type { Run } from "./types";
import { Count } from "./ui/Count";
import * as Icon from "./ui/icons";
import { usePopup } from "./ui/popup";
import { Sheet } from "./ui/Sheet";
import { StatusDot, stateName } from "./ui/Status";
import tabStyles from "./ui/Tabs.module.css";
import styles from "./RunMenu.module.css";

interface Props {
  // Every run, newest first.
  runs: readonly Run[];
  // The run shown.
  current: string | null;
  onPick: (id: string) => void;
  now: number;
  touch?: boolean;
}

export function RunMenu({ runs, current, onPick, now, touch }: Props) {
  const [open, setOpen] = useState(false);
  // Bumped when a scroll moves the button: the popover moves with it.
  const [moved, setMoved] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pick = (id: string) => {
    button.current?.focus();
    setOpen(false);
    onPick(id);
  };
  // A Sheet is modal and has its own keys; the popover is a popup's (ui/popup.ts).
  usePopup(open && !touch, () => setOpen(false), {
    box,
    button: () => button.current,
    fixed: true,
    onMove: () => setMoved((n) => n + 1),
  });
  const list = <RunList runs={runs} current={current} now={now} touch={touch} onPick={pick} />;
  return (
    <div ref={box} class={styles.menu}>
      <button
        ref={button}
        type="button"
        class={`${tabStyles.tab} ${styles.button}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          // Where focus goes back to (Safari doesn't focus a button clicked).
          button.current?.focus();
          setOpen(!open);
        }}
      >
        All runs <Count n={runs.length} />
        <Icon.ChevronDown size={14} class={styles.chevron} />
      </button>
      {open &&
        (touch ? (
          <Sheet title="All runs" onClose={() => setOpen(false)}>
            {list}
          </Sheet>
        ) : (
          <Popover anchor={button} moved={moved}>
            {list}
          </Popover>
        ))}
    </div>
  );
}

// The popover's height at most, and the room under its button below which it opens above.
const MAX_HEIGHT = 420;
const MIN_HEIGHT = 200;

// Under its button (above it in a short window), kept on the screen, and moved with it; fixed, so the tab row's scroll
// doesn't clip it. Focus starts on the run shown.
function Popover({
  anchor,
  moved,
  children,
}: {
  anchor: { current: HTMLElement | null };
  moved: number;
  children: ComponentChildren;
}) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const r = anchor.current?.getBoundingClientRect();
    if (!el || !r) return;
    const right = window.innerWidth - 8 - el.getBoundingClientRect().width;
    el.style.left = `${Math.max(8, Math.min(r.left, right))}px`;
    // As tall as the room below allows (#1, at its bottom, stays reachable), or above the
    // button when a short window leaves more room there.
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < MIN_HEIGHT && above > below;
    el.style.maxHeight = `${Math.max(0, Math.min(MAX_HEIGHT, up ? above : below))}px`;
    el.style.top = up ? `${r.top - 4 - el.getBoundingClientRect().height}px` : `${r.bottom + 4}px`;
  }, [moved]);
  useLayoutEffect(() => {
    box.current?.querySelector<HTMLElement>("[role=option][tabindex='0']")?.focus();
  }, []);
  return (
    <div ref={box} class={styles.popover} data-popup>
      {children}
    </div>
  );
}

const MOVES: Record<string, (i: number, n: number) => number> = {
  ArrowDown: (i, n) => Math.min(i + 1, n - 1),
  ArrowUp: (i) => Math.max(i - 1, 0),
  Home: () => 0,
  End: (_, n) => n - 1,
};

function RunList({ runs, current, now, touch, onPick }: Props & { onPick: (id: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  // The option in the Tab order, which the arrows move: the run shown's at first. By its id: a
  // run that starts while the list is open puts every row a place lower.
  const [activeId, setActiveId] = useState(current ?? runs[0]?.id);
  const active = Math.max(
    0,
    runs.findIndex((x) => x.id === activeId),
  );
  const onKeyDown = (e: KeyboardEvent) => {
    const move = MOVES[e.key];
    if (move) {
      e.preventDefault();
      const next = move(active, runs.length);
      setActiveId(runs[next]?.id);
      list.current?.querySelectorAll<HTMLElement>("[role=option]")[next]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (runs[active]) onPick(runs[active].id);
    }
  };
  return (
    <div
      ref={list}
      role="listbox"
      aria-label="All runs, newest first"
      class={`${styles.list} ${touch ? styles.touch : ""}`}
      onKeyDown={onKeyDown}
    >
      {runs.map((x, i) => (
        <div
          key={x.id}
          role="option"
          aria-selected={x.id === current}
          tabIndex={i === active ? 0 : -1}
          class={styles.option}
          title={x.id}
          onClick={() => onPick(x.id)}
          onFocus={() => setActiveId(x.id)}
        >
          <span class={styles.number}>#{runs.length - i}</span>{" "}
          <StatusDot state={x.status} label={stateName(x.status)} />{" "}
          <span class={styles.text}>
            <span class={styles.name}>
              {runName(x)}
              {x.speed === "fast" && " · fast"}
            </span>{" "}
            <span class={styles.when}>
              {dayTime(x.startedAt, now, false)} ·{" "}
              <span class={styles.took}>{duration(x, now)}</span>
            </span>
          </span>
          <span class={styles.check}>{x.id === current && <Icon.Check size={14} />}</span>
        </div>
      ))}
    </div>
  );
}
