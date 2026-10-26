// A run's log: Claude's text, its tool calls with their output folded in, the listener's
// notes and the result. Follows the end while it is there; scrolling up stops that.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useRunLog } from "./api";
import type { Entry } from "./types";
import styles from "./Log.module.css";

// Starts the reply of a run that stopped to ask: for the listener, not for reading.
const NEEDS_INPUT = "<!-- needs-input -->";

type Block =
  | Exclude<Entry, { kind: "tool" } | { kind: "output" }>
  | { kind: "tool"; name: string; text: string; outputs: { text: string; error: boolean }[] }
  | { kind: "output"; text: string; error: boolean };

// A tool's output goes with the call before it.
export function blocks(entries: Entry[]): Block[] {
  const out: Block[] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (e.kind === "output" && last?.kind === "tool") last.outputs.push(e);
    else if (e.kind === "tool") out.push({ ...e, outputs: [] });
    else out.push(e);
  }
  return out;
}

export function stepLine(s: Extract<Entry, { kind: "step" }>): string {
  const name = s.stage ? `[${s.stage}] ${s.name}` : s.name;
  const status =
    s.status === "done"
      ? `DONE ${s.seconds}s`
      : s.status === "error"
        ? `ERROR: ${s.error}`
        : s.status === "running"
          ? ""
          : s.status.toUpperCase();
  return `#${s.step} ${name}${status ? ` · ${status}` : ""}`;
}

export function Log({ runId }: { runId: string }) {
  const { entries } = useRunLog(runId);
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => setFollowing(true), [runId]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [entries, following]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  return (
    <div class={styles.log}>
      <div class={styles.scroll} ref={scroller} onScroll={onScroll} data-testid="log">
        {blocks(entries).map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </div>
      {!following && (
        <button type="button" class={styles.follow} onClick={() => setFollowing(true)}>
          ↓ Follow
        </button>
      )}
    </div>
  );
}

function BlockView({ block: b }: { block: Block }) {
  switch (b.kind) {
    case "text":
      return <div class={`${styles.entry} ${styles.text}`}>{b.text}</div>;
    case "meta":
      return <div class={`${styles.entry} ${styles.meta}`}>{b.text}</div>;
    case "raw":
    case "output":
      return (
        <div class={`${styles.entry} ${styles.raw}`}>
          <pre class={styles.pre}>{b.text}</pre>
        </div>
      );
    // Until the log folds into its phases: a step as BuildKit wrote it, no phase marks.
    case "step":
      return (
        <div class={`${styles.entry} ${styles.raw}`}>
          <pre class={styles.pre}>{stepLine(b)}</pre>
        </div>
      );
    case "phase":
      return null;
    case "tool":
      return (
        <details class={`${styles.entry} ${styles.tool}`} open={b.outputs.some((o) => o.error)}>
          <summary>
            <span class={styles.name}>{b.name}</span>
            <pre class={styles.pre}>{b.text || " "}</pre>
          </summary>
          {b.outputs.map((o, i) => (
            <div key={i} class={`${styles.out} ${o.error ? styles.error : ""}`}>
              <pre class={styles.pre}>{o.text || "(no output)"}</pre>
            </div>
          ))}
        </details>
      );
    case "result": {
      const title =
        b.status === "error"
          ? "Failed"
          : `${b.status === "ok" ? "Done" : "Needs input"} in ${b.minutes} min`;
      return (
        <div class={`${styles.entry} ${styles.result} ${styles[b.status] ?? ""}`}>
          <strong>{title}</strong>
          {b.text.replace(NEEDS_INPUT, "").trim()}
        </div>
      );
    }
  }
}
