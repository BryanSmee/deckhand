// A popup at its button (Shell's New request menu, a task's All runs list): a click elsewhere
// closes it, and so does Tab; Escape too, focus back on its button. A fixed one (outside a
// box that scrolls, which would clip it) closes when the window resizes or a scroll moves its
// button, rather than drift from it. Other scrolls leave it open: a live run's log follows its
// end on every line. `onKey` sees the other keys.
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

interface Options {
  // The button and the popup: a click inside isn't elsewhere.
  box: RefObject<HTMLElement>;
  button: () => HTMLElement | null | undefined;
  fixed?: boolean;
  onKey?: (e: KeyboardEvent) => void;
}

export function usePopup(open: boolean, close: () => void, { box, button, fixed, onKey }: Options) {
  // The latest handlers, for the listeners added on opening.
  const latest = useRef({ close, button, onKey });
  latest.current = { close, button, onKey };
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
      if (target === document || target.contains(box.current)) shut();
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
