// A modal dialog: its title and context line, a close button, the body, then a footer with
// the keyboard hint on the left and the actions on the right, main action last. Focus moves
// in, stays in, and goes back once closed (modal.ts); Escape or a click on the scrim (pressed
// and released there) closes it, Ctrl (⌘) Enter sends it.
import type { ComponentChildren } from "preact";
import { useId, useRef } from "preact/hooks";
import { IconButton } from "./Button";
import { Close } from "./icons";
import { Kbd } from "./Kbd";
import { useFocusTrap } from "./modal";
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

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

export function Dialog({ title, sub, onClose, onSubmit, actions, hint, wide, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const titleId = useId();
  const subId = useId();
  useFocusTrap(box, {
    onClose,
    first: body,
    onKey: (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && onSubmit) {
        e.preventDefault();
        onSubmit();
      }
    },
  });

  const shownHint =
    hint !== undefined ? (
      hint
    ) : onSubmit ? (
      <>
        <Kbd>{isMac() ? "⌘ ↵" : "Ctrl ↵"}</Kbd> to send
      </>
    ) : null;

  return (
    <div
      class={styles.scrim}
      // A click on the scrim closes it, not a drag that ends there (selecting a field's
      // text, say): the press must have started on the scrim too.
      onPointerDown={(e) => (pressed.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (pressed.current && e.target === e.currentTarget) onClose();
        pressed.current = false;
      }}
    >
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
