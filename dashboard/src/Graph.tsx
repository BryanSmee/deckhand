// The graph page: one node per issue, an arrow from each issue to what waits for it
// ("/after"), coloured by where it stands (graph.ts). Read-only: a node opens its task.
import { useEffect, useRef, useState } from "preact/hooks";
import { kindName } from "./format";
import { graphOf, type GraphNode, layout, LOOKS, shorten } from "./graph";
import { formatRoute } from "./route";
import type { State } from "./types";
import styles from "./Graph.module.css";

interface Props {
  state: State | null;
  repo: string | null;
  // A phone: top to bottom.
  vertical: boolean;
}

// The page's width, for the grid of issues without arrows.
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => el.clientWidth && setWidth(el.clientWidth - 32);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// "#12", "PR #3", with the repo on the All tab when there is room: the number always shows.
function refOf(n: GraphNode, showRepo: boolean, room: number): string {
  const number = n.number === null ? "" : n.kind === "pr" ? `PR #${n.number}` : `#${n.number}`;
  const repo = n.repo.slice(n.repo.indexOf("/") + 1);
  if (!showRepo || room < number.length + 3) return number;
  return `${shorten(repo, room - number.length - 1)} ${number}`;
}

export function Graph({ state, repo, vertical }: Props) {
  const [ref, width] = useWidth();
  const tasks = (state?.tasks ?? []).filter((t) => !repo || t.repo === repo);
  const { nodes, edges } = graphOf(tasks, state?.edges ?? [], state?.blockers ?? []);
  const shape = layout(
    nodes.map((n) => n.key),
    edges,
    { vertical, width },
  );
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const github = state?.githubUrl ?? "https://github.com";
  const chars = Math.floor((shape.w - 24) / 7);

  return (
    <div class={styles.page} ref={ref}>
      <ul class={styles.legend} aria-label="Legend">
        {LOOKS.map(({ look, name, means }) => (
          <li key={look} title={means}>
            <span class={`${styles.swatch} ${styles[look]}`} aria-hidden="true" />
            {name}
          </li>
        ))}
        <li title="It starts once the issue the arrow comes from is done">
          <span class={styles.arrowKey} aria-hidden="true" />
          waits for
        </li>
      </ul>
      {!state ? (
        <p class={styles.empty}>Loading…</p>
      ) : !nodes.length ? (
        <p class={styles.empty}>No issues here yet.</p>
      ) : (
        <svg
          class={styles.svg}
          width={shape.width + 8}
          height={shape.height + 8}
          viewBox={`-4 -4 ${shape.width + 8} ${shape.height + 8}`}
          role="list"
          aria-label={repo ? `Issues of ${repo}` : "Issues"}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 8 8"
              refX="8"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path d="M0 0L8 4L0 8z" class={styles.head} />
            </marker>
            <marker
              id="arrow-held"
              viewBox="0 0 8 8"
              refX="8"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path d="M0 0L8 4L0 8z" class={`${styles.head} ${styles.heldHead}`} />
            </marker>
          </defs>
          {shape.arrows.map((a) => {
            // Behind a failed issue, the chain holds: its arrows say so.
            const held = byKey.get(a.from)?.look === "err";
            return (
              <path
                key={`${a.from} ${a.to}`}
                d={a.d}
                class={`${styles.arrow} ${held ? styles.held : ""}`}
                marker-end={held ? "url(#arrow-held)" : "url(#arrow)"}
              />
            );
          })}
          {shape.boxes.map((b) => {
            const n = byKey.get(b.key)!;
            const ref = refOf(n, !repo, chars - n.status.length - 1);
            const title = n.title ?? `${kindName(n)} ${refOf(n, false, 0)}`;
            const waits = edges.filter((e) => e.to === n.key).length;
            const href = n.task
              ? formatRoute({ repo, task: n.key, run: null })
              : `${github}/${n.repo}/issues/${n.number}`;
            const label =
              `${ref} ${n.title ?? ""}`.trim() +
              `: ${n.status}` +
              (waits ? `, waits for ${waits} issue${waits > 1 ? "s" : ""}` : "");
            return (
              <a
                key={n.key}
                href={href}
                role="listitem"
                aria-label={label}
                class={`${styles.node} ${styles[n.look]}`}
                {...(n.task ? {} : { target: "_blank", rel: "noreferrer" })}
              >
                <title>{`${title} (${n.status})`}</title>
                <rect x={b.x} y={b.y} width={shape.w} height={shape.h} rx="8" />
                <text x={b.x + 12} y={b.y + 21} class={styles.ref}>
                  {ref}
                </text>
                <text x={b.x + shape.w - 12} y={b.y + 21} class={styles.status} text-anchor="end">
                  {n.status}
                </text>
                <text x={b.x + 12} y={b.y + 41} class={styles.title}>
                  {shorten(title, chars)}
                </text>
              </a>
            );
          })}
        </svg>
      )}
    </div>
  );
}
