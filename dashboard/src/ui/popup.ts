// A popup at its button (Shell's New request menu, a task's All runs list): a click elsewhere
// closes it, and so does Tab; Escape too, focus back on its button. A fixed one (outside a
// box that scrolls, which would clip it) closes when the window resizes or a scroll moves its
// button, rather than drift from it; with `onMove`, it follows its button instead while the
// button is still in view (a task's All runs: a live run's log scrolls the same box on every
// line). Other scrolls leave it open. `onKey` sees the other keys.
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

interface Options {
  // The button and the popup: a click inside isn't elsewhere.
  box: RefObject<HTMLElement>;
  button: () => HTMLElement | null | undefined;
  fixed?: boolean;
  onMove?: () => void;
  onKey?: (e: KeyboardEvent) => void;
}

// The button still shows in the box that scrolled (the page, for the document).
function inView(button: HTMLElement | null | undefined, scrolled: EventTarget | null) {
  if (!button) return false;
  const b = button.getBoundingClientRect();
  const v =
    scrolled instanceof Element
      ? scrolled.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
  return b.bottom > v.top && b.top < v.bottom;
}

export function usePopup(
  open: boolean,
  close: () => void,
  { box, button, fixed, onMove, onKey }: Options,
) {
  // The latest handlers, for the listeners added on opening.
  const latest = useRef({ close, button, onMove, onKey });
  latest.current = { close, button, onMove, onKey };
  useEffect(() => {
    if (!open) return;
    const shut = () => latest.current.close();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) shut();
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        shut();
        latest.current.button()?.focus();
      } else if (e.key === "Tab") shut();
      else latest.current.onKey?.(e);
    };
    const moved = (e: Event) => {
      const target = e.target as Node;
      if (target !== document && !target.contains(box.current)) return;
      const { onMove, button } = latest.current;
      if (onMove && inView(button(), e.target)) onMove();
      else shut();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", keys);
    if (fixed) {
      window.addEventListener("resize", shut);
      document.addEventListener("scroll", moved, true);
    }
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", keys);
      window.removeEventListener("resize", shut);
      document.removeEventListener("scroll", moved, true);
    };
  }, [open, fixed]);
}
