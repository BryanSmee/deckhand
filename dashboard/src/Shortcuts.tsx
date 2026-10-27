// The `?` sheet: every shortcut of the table (keys.ts SHORTCUTS), grouped by where it works.
import { Fragment } from "preact";
import { GROUPS, SHORTCUTS, type ShortcutId, shownKeys } from "./keys";
import { formatRoute } from "./route";
import { Dialog } from "./ui/Dialog";
import { Kbd } from "./ui/Kbd";
import styles from "./Shortcuts.module.css";

const IDS = Object.keys(SHORTCUTS) as ShortcutId[];

export function Keys({ id }: { id: ShortcutId }) {
  return (
    <span class={styles.keys}>
      {shownKeys(id).map((part, i) =>
        typeof part === "string" ? (
          <span key={i} class={styles.then}>
            {part}
          </span>
        ) : (
          <Fragment key={i}>
            {part.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </Fragment>
        ),
      )}
    </span>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const preferences = formatRoute({
    repo: null,
    task: null,
    run: null,
    page: "settings",
    section: "preferences",
  });
  return (
    <Dialog
      title="Keyboard shortcuts"
      sub={
        <>
          Press <Kbd>?</Kbd> anywhere to see them
        </>
      }
      size="full"
      onClose={onClose}
      hint={
        <span>
          Shortcuts never fire while you type in a field. On a Mac, Ctrl reads ⌘.{" "}
          <a href={preferences} onClick={onClose}>
            Turn them off in Preferences
          </a>
        </span>
      }
    >
      <div class={styles.groups}>
        {GROUPS.map((g) => (
          <section key={g} class={styles.group} aria-labelledby={`keys-${g}`}>
            <h3 id={`keys-${g}`} class={styles.heading}>
              {g}
            </h3>
            <dl class={styles.list}>
              {IDS.filter((id) => SHORTCUTS[id].group === g).map((id) => (
                <div key={id} class={styles.row}>
                  <dt>{SHORTCUTS[id].label}</dt>
                  <dd>
                    <Keys id={id} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
