// The choices: Checkbox, Switch (role="switch"), Segmented (buttons with aria-pressed, or
// links with aria-current for views), OptionCard (a radio as a card). Each is a real input,
// button or link, so the keyboard and screen readers get them for free.
import type { ComponentChildren, JSX } from "preact";
import styles from "./Choice.module.css";

type Box = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type" | "label" | "onChange"> & {
  label: ComponentChildren;
  onChange?: (checked: boolean) => void;
};

export function Checkbox({ label, onChange, class: className, ...rest }: Box) {
  return (
    <label class={[styles.check, className].filter(Boolean).join(" ")}>
      <input {...rest} type="checkbox" onChange={(e) => onChange?.(e.currentTarget.checked)} />
      {label}
    </label>
  );
}

export function Switch({ label, onChange, class: className, ...rest }: Box) {
  return (
    <label class={[styles.switch, className].filter(Boolean).join(" ")}>
      <input
        {...rest}
        type="checkbox"
        role="switch"
        onChange={(e) => onChange?.(e.currentTarget.checked)}
      />
      <span class={styles.track} aria-hidden="true" />
      {label}
    </label>
  );
}

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ComponentChildren;
  // Only the icon shows; the label names it.
  iconOnly?: boolean;
  // A view: a link, current when it is the value.
  href?: string;
}

interface SegmentedProps<T extends string> {
  // The group's name.
  label: string;
  options: readonly Segment<T>[];
  value: T;
  onChange?: (value: T) => void;
  class?: string;
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  class: className,
}: SegmentedProps<T>) {
  return (
    <div class={[styles.seg, className].filter(Boolean).join(" ")} role="group" aria-label={label}>
      {options.map((o) => {
        const cls = `${styles.segItem} ${o.iconOnly ? styles.segIcon : ""}`;
        const content = (
          <>
            {o.icon}
            {!o.iconOnly && o.label}
          </>
        );
        const name = o.iconOnly ? o.label : undefined;
        return o.href !== undefined ? (
          <a
            key={o.value}
            class={cls}
            href={o.href}
            aria-current={o.value === value ? "page" : undefined}
            aria-label={name}
            title={name}
          >
            {content}
          </a>
        ) : (
          <button
            key={o.value}
            type="button"
            class={cls}
            aria-pressed={o.value === value}
            aria-label={name}
            title={name}
            onClick={() => onChange?.(o.value)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

type OptionProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type" | "label"> & {
  label: ComponentChildren;
  help?: ComponentChildren;
};

export function OptionCard({ label, help, class: className, ...rest }: OptionProps) {
  return (
    <label class={[styles.opt, className].filter(Boolean).join(" ")}>
      <input {...rest} type="radio" />
      <span class={styles.optText}>
        {label}
        {help && <span class={styles.optHelp}>{help}</span>}
      </span>
    </label>
  );
}
