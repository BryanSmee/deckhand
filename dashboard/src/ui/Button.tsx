// The one button: secondary unless told otherwise, one primary per view. Pending shows at
// once (its pending label, "Starting…"), a spinner only after 400 ms; the button keeps its
// width throughout, pending label or not. IconButton is the icon-only form: it must name
// itself.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type ShortcutId, withKey } from "../keys";
import { Spinner } from "./Spinner";
import styles from "./Button.module.css";

export type Variant = "secondary" | "primary" | "ghost" | "danger" | "danger-solid";
export type Size = "small" | "default" | "touch";

const VARIANTS: Record<Variant, string> = {
  secondary: "",
  primary: styles.primary,
  ghost: styles.ghost,
  danger: styles.danger,
  "danger-solid": styles.dangerSolid,
};
const SIZES: Record<Size, string> = { small: styles.small, default: "", touch: styles.touch };

// The delay before a spinner: quicker answers never show one.
export const SPINNER_DELAY = 400;

export function buttonClass(
  variant: Variant = "secondary",
  size: Size = "default",
  extra?: string,
) {
  return [styles.button, VARIANTS[variant], SIZES[size], extra].filter(Boolean).join(" ");
}

type Native = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "icon" | "size">;

export interface ButtonProps extends Native {
  variant?: Variant;
  size?: Size;
  // Before the label.
  icon?: ComponentChildren;
  // Its action is on its way.
  pending?: boolean;
  // What it says then ("Starting…"); the button is sized for it from the start. Without
  // one it keeps its label, and the spinner takes the icon's place (or covers the label).
  pendingLabel?: string;
  // Its shortcut, which its tooltip names ("Stop (Shift S)").
  shortcut?: ShortcutId;
}

// True once `on` has held for `ms`.
function useLate(on: boolean, ms: number) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return setLate(false);
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return late;
}

export function Button({
  variant,
  size,
  icon,
  pending,
  pendingLabel,
  class: className,
  type = "button",
  disabled,
  onClick,
  children,
  shortcut,
  title,
  ...rest
}: ButtonProps) {
  const waiting = Boolean(pending);
  const late = useLate(waiting, SPINNER_DELAY);
  const busyLabel = pendingLabel ?? null;
  // Without a pending label, the spinner shows in the label's place, never beside it.
  const spinning = late && !busyLabel;
  return (
    <button
      {...rest}
      title={
        shortcut
          ? withKey((title as string) ?? (typeof children === "string" ? children : ""), shortcut)
          : title
      }
      type={type}
      class={buttonClass(variant, size, className as string | undefined)}
      disabled={disabled}
      aria-busy={waiting ? "true" : undefined}
      aria-disabled={waiting ? "true" : undefined}
      // Pending: it stays focusable, but a second click doesn't send it again.
      onClick={(e) => {
        if (waiting) return e.preventDefault();
        onClick?.(e);
      }}
    >
      <span class={styles.stack}>
        <span class={`${styles.layer} ${waiting && busyLabel ? styles.hidden : ""}`}>
          {icon !== undefined && (
            // The spinner in the icon's own cell: the icon fades out under it.
            <span class={styles.stack}>
              <span class={`${styles.layer} ${spinning ? styles.faded : ""}`}>{icon}</span>
              {spinning && (
                <span class={styles.layer}>
                  <Spinner label={null} />
                </span>
              )}
            </span>
          )}
          {children !== undefined && children !== null && (
            // No icon to take the place of: the spinner covers the label, which stays its
            // width and its name (faded, not hidden).
            <span class={spinning && icon === undefined ? styles.faded : ""}>{children}</span>
          )}
        </span>
        {spinning && icon === undefined && (
          <span class={styles.layer}>
            <Spinner label={null} />
          </span>
        )}
        {busyLabel !== null && (
          <span
            class={`${styles.layer} ${waiting ? "" : styles.hidden}`}
            aria-hidden={waiting ? undefined : "true"}
          >
            <span class={late ? "" : styles.hidden}>
              <Spinner label={null} />
            </span>
            {busyLabel}
          </span>
        )}
      </span>
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon" | "pendingLabel"> {
  // Its name, for screen readers and as its tooltip.
  label: string;
  icon: ComponentChildren;
}

export function IconButton({ label, icon, class: className, title, ...rest }: IconButtonProps) {
  return (
    <Button
      {...rest}
      class={[styles.icon, className].filter(Boolean).join(" ")}
      aria-label={label}
      title={title ?? label}
      icon={icon}
    />
  );
}
