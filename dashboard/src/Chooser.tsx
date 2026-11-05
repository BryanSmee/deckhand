// "Queue after…": the board's issues to pick from, filtered by number or title, then Queue. The
// arrows pick and Enter queues, from the filter; a tap picks, for touch. A work queue card's
// (WorkQueue.tsx), on every tab.
import { useId, useState } from "preact/hooks";
import type { Tone } from "./format";
import { t, tx } from "./i18n";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field } from "./ui/Field";
import { Check, Search } from "./ui/icons";
import { Kbd } from "./ui/Kbd";
import { StatusDot, toneClass } from "./ui/Status";
import styles from "./Chooser.module.css";

// An issue a drop or "Queue after…" can put another one after: a node of the graph.
export interface Target {
  key: string;
  number: number;
  // "#19 Retry failed webhook deliveries", for a drop's notice.
  label: string;
  title: string;
  // Where it stands, as the graph says it.
  tone: Tone;
  status: string;
}

// Opens "Queue #<number> after…": `queue` takes the issue picked.
export type QueueAfter = (number: number, queue: (after: number) => void) => void;

interface Props {
  number: number;
  targets: Target[];
  disabled: boolean;
  onQueue: (after: number) => void;
  onClose: () => void;
}

const matches = (t: Target, filter: string) => {
  const f = filter.trim().toLowerCase().replace(/^#/, "");
  return !f || String(t.number).startsWith(f) || t.title.toLowerCase().includes(f);
};

export function Chooser({ number, targets, disabled, onQueue, onClose }: Props) {
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const listId = useId();
  const options = targets.filter((t) => t.number !== number && matches(t, filter));
  // The pick stays while it is listed; otherwise the first one listed.
  const at = Math.max(
    0,
    options.findIndex((t) => t.number === picked),
  );
  const after = options[at]?.number ?? null;
  const queue = () => {
    if (after !== null && !disabled) onQueue(after);
  };
  const move = (step: number) => {
    if (!options.length) return;
    setPicked(options[(at + step + options.length) % options.length].number);
  };
  const optionId = (n: number) => `${listId}-${n}`;

  return (
    <Dialog
      title={tx("app.chooserTitle", { number: <span class="mono">#{number}</span> })}
      sub={t("app.chooserSub")}
      onClose={onClose}
      onSubmit={queue}
      keys={tx("app.chooserKeys", {
        arrows: (
          <>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </>
        ),
        enter: <Kbd>↵</Kbd>,
      })}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("app.chooserCancel")}
          </Button>
          <Button variant="primary" disabled={after === null || disabled} onClick={queue}>
            {after === null
              ? t("app.chooserQueue")
              : tx("app.chooserQueueAfter", { number: <span class="mono">#{after}</span> })}
          </Button>
        </>
      }
    >
      <div
        class={styles.chooser}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            move(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            queue();
          }
        }}
      >
        <Field
          label={t("app.chooserFilter")}
          hideLabel
          lead={<Search size={15} />}
          placeholder={t("app.chooserPlaceholder")}
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={after === null ? undefined : optionId(after)}
          value={filter}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <div id={listId} class={styles.list} role="listbox" aria-label={t("app.chooserIssues")}>
          {!options.length && (
            <p class={styles.empty}>
              {filter.trim() ? t("app.chooserNoMatch") : t("app.chooserNone")}
            </p>
          )}
          {options.map((t) => (
            <div
              key={t.key}
              id={optionId(t.number)}
              class={`${styles.pick} ${toneClass(t.tone)}`}
              role="option"
              aria-selected={t.number === after}
              onClick={() => setPicked(t.number)}
            >
              <StatusDot tone={t.tone} />
              <span class={`mono ${styles.number}`}>#{t.number}</span>
              <span class={styles.title}>{t.title}</span>
              <span class={styles.status}>{t.status}</span>
              <span class={styles.check}>{t.number === after && <Check size={16} />}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
