// Surfaces and feedback: Card, Notice (in a status tone), Toast (a message and its action),
// Skeleton (what is loading, where it will be).
import type { ComponentChildren, JSX } from "preact";
import type { Tone } from "../format";
import { Alert, Check, Warning } from "./icons";
import { toneClass } from "./Status";
import styles from "./Surface.module.css";

const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

type CardProps = JSX.HTMLAttributes<HTMLElement> & { as?: "div" | "section" | "article" };

export function Card({ as = "div", class: className, children, ...rest }: CardProps) {
  const Tag = as as "div";
  return (
    <Tag
      {...(rest as JSX.HTMLAttributes<HTMLDivElement>)}
      class={join(styles.card, className as string)}
    >
      {children}
    </Tag>
  );
}

const NOTICE_ICONS: Partial<Record<Tone, ComponentChildren>> = {
  done: <Check />,
  err: <Alert />,
  input: <Warning />,
};

// An error is an alert (read at once); the rest a status.
export function Notice({
  tone,
  icon,
  children,
  class: className,
}: {
  tone: Tone;
  icon?: ComponentChildren | null;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <div
      class={join(styles.notice, toneClass(tone), className)}
      role={tone === "err" ? "alert" : "status"}
    >
      {icon === undefined ? NOTICE_ICONS[tone] : icon}
      <span>{children}</span>
    </div>
  );
}

export function Toast({
  children,
  action,
  class: className,
}: {
  children: ComponentChildren;
  // A small button ("View", "Undo").
  action?: ComponentChildren;
  class?: string;
}) {
  return (
    <div class={join(styles.toast, className)} role="status">
      <span>{children}</span>
      {action}
    </div>
  );
}

export function Skeleton({
  width = "100%",
  height = 10,
  class: className,
}: {
  width?: number | string;
  height?: number | string;
  class?: string;
}) {
  return (
    <span class={join(styles.skeleton, className)} style={{ width, height }} aria-hidden="true" />
  );
}
