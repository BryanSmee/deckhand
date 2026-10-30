// A task's All runs: the button at the end of its run tabs, and the list of every run it opens,
// newest first and numbered from the oldest (#1), the one shown ticked. A popover under the
// button on a desktop, a Sheet on a phone. A listbox: arrows, Home and End move, Enter picks,
// Escape closes; focus goes back to the button (modal.ts). Detail.tsx shows it past 3 runs.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { dayTime, duration, runName } from "./format";
import type { Run } from "./types";
import { Count } from "./ui/Count";
import * as Icon from "./ui/icons";
import { useFocusTrap } from "./ui/modal";
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
  const button = useRef<HTMLButtonElement>(null);
  const pick = (id: string) => {
    setOpen(false);
    onPick(id);
  };
  const list = <RunList runs={runs} current={current} now={now} touch={touch} onPick={pick} />;
  return (
    <>
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
        <Icon.ChevronDown size={14} />
      </button>
      {open &&
        (touch ? (
          <Sheet title="All runs" onClose={() => setOpen(false)}>
            {list}
          </Sheet>
        ) : (
          <Popover anchor={button} onClose={() => setOpen(false)}>
            {list}
          </Popover>
        ))}
    </>
  );
}

// Under its button, kept on the screen; fixed, so the tab row's scroll doesn't clip it. A
// click elsewhere closes it, and so does the page scrolling or resizing under it.
function Popover({
  anchor,
  onClose,
  children,
}: {
  anchor: { current: HTMLElement | null };
  onClose: () => void;
  children: ComponentChildren;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at] = useState(() => {
    const r = anchor.current?.getBoundingClientRect();
    return { top: (r?.bottom ?? 0) + 4, left: r?.left ?? 0 };
  });
  useFocusTrap(box, { onClose, first: box });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const over = el.getBoundingClientRect().right - (window.innerWidth - 8);
    if (over > 0) el.style.left = `${Math.max(8, at.left - over)}px`;
  }, []);
  useEffect(() => {
    const inside = (e: Event) =>
      box.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node);
    const away = (e: Event) => !inside(e) && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("resize", onClose);
    document.addEventListener("scroll", away, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("resize", onClose);
      document.removeEventListener("scroll", away, true);
    };
  }, []);
  return (
    <div
      ref={box}
      class={styles.popover}
      data-popup
      style={{ top: `${at.top}px`, left: `${at.left}px` }}
    >
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
  // The option in the Tab order, which the arrows move: the run shown's at first.
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      runs.findIndex((x) => x.id === current),
    ),
  );
  const onKeyDown = (e: KeyboardEvent) => {
    const move = MOVES[e.key];
    if (move) {
      e.preventDefault();
      const next = move(active, runs.length);
      setActive(next);
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
          onFocus={() => setActive(i)}
        >
          <span class={styles.number}>#{runs.length - i}</span>{" "}
          <StatusDot state={x.status} label={stateName(x.status)} />{" "}
          <span class={styles.text}>
            <span class={styles.name}>
              {runName(x)}
              {x.speed === "fast" && " · fast"}
            </span>{" "}
            <span class={styles.when}>
              {dayTime(x.startedAt, now)} · {duration(x, now)}
            </span>
          </span>
          <span class={styles.check}>{x.id === current && <Icon.Check size={14} />}</span>
        </div>
      ))}
    </div>
  );
}
