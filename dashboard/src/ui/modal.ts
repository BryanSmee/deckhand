// What a modal (Dialog, Sheet) does with focus and keys: focus moves in (an [autofocus]
// element, else the first focusable one of `first`'s box, else of the modal), stays in (Tab
// wraps), and goes back where it was once closed. Escape closes; `onKey` sees the other keys.
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Options {
  onClose: () => void;
  onKey?: (e: KeyboardEvent) => void;
  // Where focus starts; the modal itself by default.
  first?: RefObject<HTMLElement>;
}

export function useFocusTrap(box: RefObject<HTMLElement>, { onClose, onKey, first }: Options) {
  // The latest handlers, for the listener added once.
  const latest = useRef({ onClose, onKey });
  latest.current = { onClose, onKey };

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const focusable = () => [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const start =
      first?.current?.querySelector<HTMLElement>("[autofocus]") ??
      first?.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      focusable()[0];
    start?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        latest.current.onClose();
      } else if (e.key === "Tab") {
        const all = focusable();
        if (!all.length) return e.preventDefault();
        const at = all.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && at <= 0) {
          e.preventDefault();
          all[all.length - 1].focus();
        } else if (!e.shiftKey && at === all.length - 1) {
          e.preventDefault();
          all[0].focus();
        } else if (at === -1) {
          e.preventDefault();
          all[0].focus();
        }
      } else latest.current.onKey?.(e);
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      before?.focus?.();
    };
  }, []);
}
