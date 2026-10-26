// A field: a label, its input, select or textarea, then help or an error (which the control
// is described by, and marked invalid with). A select gets its chevron; `lead` puts an icon
// before the text (search), `hint` a key after it ("/").
import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";
import { ChevronDown } from "./icons";
import { Kbd } from "./Kbd";
import styles from "./Field.module.css";

interface Common {
  label: ComponentChildren;
  // Hidden but still the control's name: a search box whose icon says it all.
  hideLabel?: boolean;
  help?: ComponentChildren;
  // Replaces the help, and marks the control invalid.
  error?: ComponentChildren;
  lead?: ComponentChildren;
  hint?: string;
  size?: "small" | "default" | "touch";
  class?: string;
}

type InputProps = Common &
  Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "label" | "size" | "class"> & { as?: "input" };
type SelectProps = Common &
  Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, "label" | "size" | "class"> & {
    as: "select";
  };
type TextareaProps = Common &
  Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "label" | "size" | "class"> & {
    as: "textarea";
  };

export type FieldProps = InputProps | SelectProps | TextareaProps;

const SIZES = { small: styles.small, default: "", touch: styles.touch };

export function Field(props: FieldProps) {
  const {
    label,
    hideLabel,
    help,
    error,
    lead,
    hint,
    size = "default",
    class: className,
    as = "input",
    id: given,
    ...control
  } = props;
  const auto = useId();
  const id = (given as string | undefined) ?? auto;
  const note = error ?? help;
  const noteId = note ? `${id}-note` : undefined;
  const trail = as === "select" ? <ChevronDown size={16} /> : hint ? <Kbd>{hint}</Kbd> : null;
  const classes = [
    styles.input,
    SIZES[size],
    lead ? styles.hasLead : "",
    trail && as !== "select" ? styles.hasHint : "",
  ]
    .filter(Boolean)
    .join(" ");
  const shared = {
    id,
    class: classes,
    "aria-invalid": error ? ("true" as const) : undefined,
    "aria-describedby": noteId,
  };
  const Tag = as as "input";
  return (
    <div class={[styles.field, className].filter(Boolean).join(" ")}>
      <label for={id} class={hideLabel ? styles.unseen : styles.label}>
        {label}
      </label>
      <span class={styles.affix}>
        {lead && <span class={styles.lead}>{lead}</span>}
        <Tag {...(control as JSX.InputHTMLAttributes<HTMLInputElement>)} {...shared} />
        {trail && <span class={styles.trail}>{trail}</span>}
      </span>
      {note && (
        <span id={noteId} class={error ? styles.error : styles.help}>
          {note}
        </span>
      )}
    </div>
  );
}
