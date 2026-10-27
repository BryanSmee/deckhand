// A file's text with its line numbers, each line with errors marked and their messages under
// it: a repository's .deckhand.yaml and its policy files.
import { Fragment } from "preact";
import styles from "./Code.module.css";

interface Props {
  // Its lines, without the file's last newline.
  lines: string[];
  // Line number → its errors.
  marks?: Map<number, string[]>;
  // A line's id, for links to it.
  lineId?: (n: number) => string;
  class?: string;
}

export const linesOf = (text: string) => text.replace(/\n$/, "").split("\n");

export function Code({ lines, marks, lineId, class: className }: Props) {
  return (
    <pre class={[styles.code, className].filter(Boolean).join(" ")}>
      {lines.map((line, i) => {
        const n = i + 1;
        const notes = marks?.get(n);
        return (
          <Fragment key={n}>
            <span id={lineId?.(n)} class={`${styles.line} ${notes ? styles.bad : ""}`}>
              <span class={styles.n}>{n}</span>
              <span class={styles.src}>{line || " "}</span>
            </span>
            {notes?.map((note, k) => (
              <span key={k} class={styles.annotation}>
                {note}
              </span>
            ))}
          </Fragment>
        );
      })}
    </pre>
  );
}
