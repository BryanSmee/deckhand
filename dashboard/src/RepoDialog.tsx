// A dialog of the top bar that works on one repository (Feedback, Analyze): its title and ×,
// what it says first, the repo picked (the tab open when it is offered), then its form.
// Escape, a click beside it or a link that opens another view closes it.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useDismiss } from "./hooks";
import styles from "./Dialog.module.css";

interface Props {
  // Its accessible name, and its heading.
  label: string;
  title: string;
  // The repos offered, and the tab open.
  repos: string[];
  tab: string | null;
  onClose: () => void;
  // Above the repo: what it does, or why no repo is offered.
  notes?: ComponentChildren;
  // The picked repo's form (keyed by it: picking another starts afresh).
  children: (repo: string) => ComponentChildren;
}

export function RepoDialog({ label, title, repos, tab, onClose, notes, children }: Props) {
  const [picked, setPicked] = useState(() => (tab && repos.includes(tab) ? tab : null));
  const repo = picked && repos.includes(picked) ? picked : (repos[0] ?? null);
  useDismiss(onClose);
  return (
    <Backdrop class={styles.backdrop} onClose={onClose}>
      <div class={styles.dialog} role="dialog" aria-modal="true" aria-label={label}>
        <div class={styles.head}>
          <h2 class={styles.title}>{title}</h2>
          <button type="button" class={styles.close} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {notes}
        {repo && (
          <>
            <label class={styles.repo}>
              Repository
              <select value={repo} onChange={(e) => setPicked(e.currentTarget.value)}>
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            {children(repo)}
          </>
        )}
      </div>
    </Backdrop>
  );
}

// The page darkened behind a dialog: a click on it (not in the dialog) closes it.
export function Backdrop({
  class: className,
  onClose,
  children,
}: {
  class: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class={className} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {children}
    </div>
  );
}
