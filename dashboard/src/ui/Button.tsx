// The one button: secondary unless told otherwise, one primary per view. Pending shows at
// once (its pending label, "Starting…"), a spinner only after 400 ms, the button as wide as
// before. IconButton is the icon-only form: it must name
// itself.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
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
  // one it keeps its label, and the spinner takes the icon's place.
  pendingLabel?: string;
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
  ...rest
}: ButtonProps) {
  const waiting = Boolean(pending);
  const late = useLate(waiting, SPINNER_DELAY);
  const busyLabel = pendingLabel ?? null;
  return (
    <button
      {...rest}
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
          {late && !busyLabel ? <Spinner label={null} /> : icon}
          {children}
        </span>
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

export function IconButton({ label, icon, class: className, ...rest }: IconButtonProps) {
  return (
    <Button
      {...rest}
      class={[styles.icon, className].filter(Boolean).join(" ")}
      aria-label={label}
      title={label}
    >
      {icon}
    </Button>
  );
}
