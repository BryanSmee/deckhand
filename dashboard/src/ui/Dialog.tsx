// A modal dialog: its title and context line, a close button, the body, then a footer with
// the keyboard hint on the left and the actions on the right, main action last. Focus moves
// in, stays in, and goes back once closed (modal.ts); Escape or a click on the scrim (pressed
// and released there) closes it, and so does a link that opens another view (the address
// changes); Ctrl (⌘) Enter sends it. An alert (Stop) asks before something that can't be
// taken back: its icon, title and what it means, no close button. On a phone it is a sheet,
// the screen's width, from the bottom.
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { t, tx } from "../i18n";
import { isMac } from "../keys";
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
  // Left of the actions: what to do there ("Then queue it after #23"); else its keys, by
  // default the Ctrl Enter hint when it sends. Keys don't show on a phone.
  hint?: ComponentChildren;
  keys?: ComponentChildren;
  wide?: boolean;
  // Wider still: the shortcuts sheet's columns.
  size?: "full";
  // An alertdialog, with its icon over the title.
  alert?: boolean;
  icon?: ComponentChildren;
  children?: ComponentChildren;
}

export function Dialog({
  title,
  sub,
  onClose,
  onSubmit,
  actions,
  hint,
  keys,
  wide,
  size,
  alert,
  icon,
  children,
}: Props) {
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

  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const close = () => latest.current();
    addEventListener("hashchange", close);
    return () => removeEventListener("hashchange", close);
  }, []);

  const shownHint =
    hint !== undefined
      ? hint
      : keys !== undefined
        ? keys
        : onSubmit
          ? tx("ui.dialogSend", { keys: <Kbd>{isMac() ? "⌘ ↵" : "Ctrl ↵"}</Kbd> })
          : null;

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
        class={`${styles.dialog} ${wide ? styles.wide : ""} ${size ? styles[size] : ""}`}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={sub ? subId : undefined}
      >
        {alert ? (
          <div ref={body} class={`${styles.body} ${styles.alert}`}>
            {icon && <span class={styles.icon}>{icon}</span>}
            <h2 id={titleId} class={styles.title}>
              {title}
            </h2>
            {sub && (
              <p id={subId} class={styles.said}>
                {sub}
              </p>
            )}
            {children}
          </div>
        ) : (
          <>
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
                label={t("ui.close")}
                icon={<Close size={14} />}
                onClick={onClose}
              />
            </div>
            <div ref={body} class={styles.body}>
              {children}
            </div>
          </>
        )}
        {(actions || shownHint) && (
          <div class={styles.foot}>
            <span class={`${styles.hint} ${hint === undefined ? styles.keys : ""}`}>
              {shownHint}
            </span>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
