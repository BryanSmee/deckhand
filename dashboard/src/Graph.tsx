// The graph page: one node per issue, an arrow from each issue to what waits for it
// ("/after"), coloured by where it stands (graph.ts). A node opens its task. On a repo's tab
// it is a work area too (WorkArea.tsx): an issue dropped on it starts, dropped next to a node
// it waits for that one; a waiting node dragged away stops waiting, onto another node waits
// for that one instead.
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useWorkArea } from "./api";
import { kindName } from "./format";
import { dropTarget, graphOf, type GraphNode, issueOfLink, layout, LOOKS, shorten } from "./graph";
import { formatRoute } from "./route";
import type { State } from "./types";
import { ISSUE_TYPE, type Target, WorkArea } from "./WorkArea";
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

// A waiting node being dragged: where the pointer went down, how far it moved.
interface NodeDrag {
  key: string;
  number: number;
  pointer: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  moved: boolean;
}

// Past this many pixels a press on a waiting node is a drag, not a click.
const DRAG_PX = 6;

export function Graph({ state, repo, vertical }: Props) {
  const [ref, width] = useWidth();
  const work = useWorkArea(repo);
  const [mode, setMode] = useState("work");
  const [notice, setNotice] = useState<string | null>(null);
  // Something is dragged over the area, and the node a drop there would queue after.
  const [over, setOver] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [nodeDrag, setNodeDrag] = useState<NodeDrag | null>(null);
  // A drag ended on a node: the click that follows doesn't open it.
  const dragEnded = useRef(false);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    setMode("work");
    setNotice(null);
  }, [repo]);
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
  const modes = work.backlog?.modes ?? [];
  const picked = mode === "work" || !modes.includes(mode) ? {} : { mode };
  const blocked = !!work.backlog?.errors;
  // Only a repo's issues move: what runs or ran stays where it is.
  const movable = (n: GraphNode) =>
    !!repo && !blocked && n.task?.state === "waiting" && n.kind === "issue" && n.number !== null;
  const targets: Target[] = repo
    ? nodes
        .filter((n) => n.number !== null)
        .map((n) => ({
          key: n.key,
          number: n.number!,
          label: `${refOf(n, false, 0)} ${shorten(n.title ?? "", 40)}`.trim(),
        }))
    : [];
  const waiting = tasks.filter((t) => t.state === "waiting" && t.kind === "issue" && t.number);

  // The node under the pointer, in the drawing's units (the viewBox starts at -4).
  const targetAt = (clientX: number, clientY: number) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return null;
    return dropTarget(shape, vertical, clientX - box.left - 4, clientY - box.top - 4);
  };

  // Issue `number` let go on the area, after `onto` (a node) or in the open. `waits`: it is a
  // waiting node, which the open cancels rather than starts, and which keeps its mode.
  const dropped = (number: number, onto: string | null, waits: boolean) => {
    setNotice(null);
    const node = onto ? byKey.get(onto) : null;
    if (node?.number === number && node.repo === repo) return;
    if (node?.number != null) {
      return work.act({ action: "queue", number, after: node.number, ...(waits ? {} : picked) });
    }
    work.act(waits ? { action: "dequeue", number } : { action: "start", number, ...picked });
  };

  const onDragOver = (e: DragEvent) => {
    const types = [...(e.dataTransfer?.types ?? [])];
    if (blocked || !types.some((t) => [ISSUE_TYPE, "text/uri-list", "text/plain"].includes(t))) {
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setOver(true);
    setTarget(targetAt(e.clientX, e.clientY));
  };
  const onDragLeave = (e: DragEvent) => {
    if ((e.currentTarget as Node).contains(e.relatedTarget as Node | null)) return;
    setOver(false);
    setTarget(null);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    setTarget(null);
    const data = e.dataTransfer;
    const own = Number(data?.getData(ISSUE_TYPE));
    const link = data?.getData("text/uri-list") || data?.getData("text/plain") || "";
    const number = own || (repo && issueOfLink(link, github, repo));
    if (!number) {
      setNotice(`That isn't a link to one of ${repo}'s issues.`);
      return;
    }
    dropped(number, targetAt(e.clientX, e.clientY), false);
  };

  // A waiting node follows the pointer once it moved past DRAG_PX.
  const nodeHandlers = (n: GraphNode): JSX.HTMLAttributes<HTMLAnchorElement> => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setNodeDrag({
        key: n.key,
        number: n.number!,
        pointer: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dx: 0,
        dy: 0,
        moved: false,
      });
    },
    onPointerMove: (e) => {
      if (!nodeDrag || nodeDrag.pointer !== e.pointerId) return;
      const dx = e.clientX - nodeDrag.x;
      const dy = e.clientY - nodeDrag.y;
      const moved = nodeDrag.moved || Math.hypot(dx, dy) > DRAG_PX;
      setNodeDrag({ ...nodeDrag, dx, dy, moved });
      if (moved) setTarget(targetAt(e.clientX, e.clientY));
    },
    onPointerUp: (e) => {
      if (!nodeDrag || nodeDrag.pointer !== e.pointerId) return;
      setNodeDrag(null);
      setTarget(null);
      if (!nodeDrag.moved) return;
      dragEnded.current = true;
      dropped(nodeDrag.number, targetAt(e.clientX, e.clientY), true);
    },
    onPointerCancel: () => {
      setNodeDrag(null);
      setTarget(null);
    },
    // The browser's own drag of a link would take over from the pointer's.
    onDragStart: (e) => e.preventDefault(),
  });

  // The node being dragged goes last: SVG paints in order, so it stays on top.
  const boxes = [...shape.boxes].sort(
    (a, b) => Number(a.key === nodeDrag?.key) - Number(b.key === nodeDrag?.key),
  );
  const drawing = !state ? (
    <p class={styles.empty}>Loading…</p>
  ) : !nodes.length ? (
    <p class={styles.empty}>No issues here yet.{repo ? " Drop one here to start it." : ""}</p>
  ) : (
    <svg
      ref={svg}
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
      {boxes.map((b) => {
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
        const moving = nodeDrag?.key === n.key && nodeDrag.moved ? nodeDrag : null;
        return (
          <a
            key={n.key}
            href={href}
            role="listitem"
            aria-label={label}
            class={`${styles.node} ${styles[n.look]} ${movable(n) ? styles.movable : ""} ${
              target === n.key && !moving ? styles.target : ""
            } ${moving ? styles.moving : ""}`}
            style={moving ? { transform: `translate(${moving.dx}px, ${moving.dy}px)` } : undefined}
            onClick={(e) => {
              if (!dragEnded.current) return;
              dragEnded.current = false;
              e.preventDefault();
            }}
            {...(movable(n) ? nodeHandlers(n) : {})}
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
  );

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
      {repo ? (
        <div class={styles.work}>
          <WorkArea
            repo={repo}
            work={work}
            targets={targets}
            waiting={waiting}
            mode={modes.includes(mode) ? mode : "work"}
            onMode={setMode}
            notice={notice}
          />
          <div
            class={`${styles.area} ${over || nodeDrag?.moved ? styles.over : ""}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {drawing}
          </div>
        </div>
      ) : (
        <>
          <p class={styles.hint}>Open a repository's tab to start or queue its issues here.</p>
          {drawing}
        </>
      )}
    </div>
  );
}
