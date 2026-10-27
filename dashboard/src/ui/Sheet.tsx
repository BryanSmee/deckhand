// A bottom sheet, the phone's menu: its title, a close button and what it lists. Modal like
// Dialog (modal.ts): Escape or a tap on the scrim closes it, and so does following a link in
// it (the page it opens is behind).
import type { ComponentChildren } from "preact";
import { useId, useRef } from "preact/hooks";
import { IconButton } from "./Button";
import { Close } from "./icons";
import { useFocusTrap } from "./modal";
import styles from "./Sheet.module.css";

interface Props {
  title: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
}

export function Sheet({ title, onClose, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(box, { onClose, first: body });
  return (
    <div
      class={styles.scrim}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        class={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a[href]")) onClose();
        }}
      >
        <div class={styles.head}>
          <h2 id={titleId} class={styles.title}>
            {title}
          </h2>
          <IconButton
            variant="ghost"
            size="touch"
            label="Close"
            icon={<Close size={18} />}
            onClick={onClose}
          />
        </div>
        <div ref={body} class={styles.body}>
          {children}
        </div>
      </div>
    </div>
  );
}
