// A modal dialog: its title and context line, a close button, the body, then a footer with
// the keyboard hint on the left and the actions on the right, main action last. Focus moves
// in, stays in (Tab wraps), and goes back where it was once closed; Escape or a click on the
// scrim closes it, Ctrl (⌘) Enter sends it.
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { IconButton } from "./Button";
import { Close } from "./icons";
import { Kbd } from "./Kbd";
import styles from "./Dialog.module.css";

interface Props {
  title: ComponentChildren;
  // The line under it: what it works on.
  sub?: ComponentChildren;
  onClose: () => void;
  // Ctrl Enter: the main action, when it can go.
  onSubmit?: () => void;
  // The actions, main one last.
  actions?: ComponentChildren;
  // Left of the actions; by default, the Ctrl Enter hint when it sends.
  hint?: ComponentChildren;
  wide?: boolean;
  children: ComponentChildren;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

export function Dialog({ title, sub, onClose, onSubmit, actions, hint, wide, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const subId = useId();
  // The latest handlers, for the listener added once.
  const latest = useRef({ onClose, onSubmit });
  latest.current = { onClose, onSubmit };

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const focusable = () => [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    // The first field or button of the body, else the close button.
    const first =
      body.current?.querySelector<HTMLElement>("[autofocus]") ??
      body.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      focusable()[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        latest.current.onClose();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && latest.current.onSubmit) {
        e.preventDefault();
        latest.current.onSubmit();
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
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, []);

  const shownHint =
    hint !== undefined ? (
      hint
    ) : onSubmit ? (
      <>
        <Kbd>{isMac() ? "⌘ ↵" : "Ctrl ↵"}</Kbd> to send
      </>
    ) : null;

  return (
    <div class={styles.scrim} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        class={`${styles.dialog} ${wide ? styles.wide : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={sub ? subId : undefined}
      >
        <div class={styles.head}>
          <div class={styles.heading}>
            <h2 id={titleId} class={styles.title}>
              {title}
            </h2>
            {sub && (
              <p id={subId} class={styles.sub}>
                {sub}
              </p>
            )}
          </div>
          <IconButton
            variant="ghost"
            size="small"
            label="Close"
            icon={<Close size={14} />}
            onClick={onClose}
          />
        </div>
        <div ref={body} class={styles.body}>
          {children}
        </div>
        {(actions || shownHint) && (
          <div class={styles.foot}>
            <span class={styles.hint}>{shownHint}</span>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
