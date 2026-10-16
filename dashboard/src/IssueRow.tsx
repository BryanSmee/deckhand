// A card's first line: the issue's number (a link to it, when given) and its title, or "Issue
// #n" until the title is known. The backlog's (WorkArea.tsx) and the Brainstorm column's.
import styles from "./WorkArea.module.css";

interface Props {
  number: number;
  title: string | null;
  // GitHub's page for it.
  href?: string;
  // Before the number: the repo's name, on the All tab.
  repo?: string;
}

export function IssueRow({ number, title, href, repo }: Props) {
  const ref = `${repo ? `${repo} ` : ""}#${number}`;
  const name = title ?? `Issue #${number}`;
  return (
    <div class={styles.row}>
      {href ? (
        <a class={styles.ref} href={href} target="_blank" rel="noreferrer">
          {ref}
        </a>
      ) : (
        <span class={styles.ref}>{ref}</span>
      )}
      <span class={styles.name} title={name}>
        {name}
      </span>
    </div>
  );
}
