// What the graph draws (Graph.tsx): its nodes (each one's ref, status, "?" badge and title)
// and the arrows between them, or why there are none.
import type { JSX, RefObject } from "preact";
import type { Target } from "./Chooser";
import { kindName, numberOf, plural, shortRepo, shorten } from "./format";
import type { NodeDrag } from "./graphHooks";
import type { Layout } from "./graphLayout";
import type { GraphNode } from "./graphModel";
import { formatRoute } from "./route";
import type { Edge, Task } from "./types";
import styles from "./Graph.module.css";

// "#12", "PR #3", with the repo on the All tab when there is room: the number always shows.
export function nodeRef(
  n: Pick<GraphNode, "number" | "kind" | "repo">,
  showRepo: boolean,
  room: number,
): string {
  const number = numberOf(n);
  if (!showRepo || room < number.length + 3) return number;
  return `${shorten(shortRepo(n.repo), room - number.length - 1)} ${number}`;
}

// The nodes "Queue after…" offers (Chooser.tsx).
export const targetsOf = (nodes: GraphNode[]): Target[] =>
  nodes
    .filter((n) => n.number !== null)
    .map((n) => ({
      key: n.key,
      number: n.number!,
      label: `${nodeRef(n, false, 0)} ${shorten(n.title ?? "", 40)}`.trim(),
    }));

// A node whose click answers its questions in place: a task waiting for answers, with them
// parsed (a label alone opens the detail page).
export const asks = (n: GraphNode): n is GraphNode & { task: Task } =>
  n.look === "input" && !!n.task?.questions;

// The "?" badge's width: with the open question count, or alone (questions not in the format).
const badgeWidth = (n: GraphNode) => (n.task?.questions?.items ? 28 : 16);

// An arrow's head, and a held one's (what waits behind a failed issue).
export function ArrowMarkers() {
  return (
    <defs>
      {[
        ["arrow", styles.head],
        ["arrow-held", `${styles.head} ${styles.heldHead}`],
      ].map(([id, look]) => (
        <marker
          key={id}
          id={id}
          viewBox="0 0 8 8"
          refX="8"
          refY="4"
          markerWidth="8"
          markerHeight="8"
          orient="auto"
        >
          <path d="M0 0L8 4L0 8z" class={look} />
        </marker>
      ))}
    </defs>
  );
}

interface Props {
  n: GraphNode;
  // Where it is drawn (a drag's offset included), and the nodes' size.
  x: number;
  y: number;
  w: number;
  h: number;
  // The characters a line of it holds.
  chars: number;
  // The All tab: the ref says the repo.
  showRepo: boolean;
  href: string;
  // How many issues it waits for.
  waits: number;
  // Its classes besides its look: movable, a drop's target, being dragged.
  extra: string;
  // A click that answers its questions in place, or follows its link (undefined).
  onAsk?: () => void;
  // The click a drag's end makes: true once, to be ignored.
  justDragged: () => boolean;
  handlers: JSX.HTMLAttributes<HTMLAnchorElement>;
}

export function GraphNodeView({
  n,
  x,
  y,
  w,
  h,
  chars,
  showRepo,
  href,
  waits,
  extra,
  onAsk,
  justDragged,
  handlers,
}: Props) {
  const badge = asks(n) ? badgeWidth(n) : 0;
  // "Needs input, PR ready" where it fits, its first part where it doesn't.
  const room = chars - Math.ceil(badge / 7);
  const status = n.status.length + 5 > room ? n.status.split(",")[0] : n.status;
  const ref = nodeRef(n, showRepo, room - status.length - 1);
  const count = n.task?.questions?.items?.length;
  const right = n.look === "pending" ? 30 : badge ? badge + 16 : 12;
  // The bold ref takes about 7.5px a character, the status 6: on a phone's narrow node the
  // status is left to its tooltip and label (the look says it) rather than drawn over it.
  const fits = 12 + ref.length * 7.5 + 8 + status.length * 6 <= w - right;
  const title = n.title ?? `${kindName(n)} ${nodeRef(n, false, 0)}`;
  const label =
    `${ref} ${n.title ?? ""}`.trim() +
    `: ${n.status}` +
    (count ? `, ${plural(count, "question")}` : "") +
    (waits ? `, waits for ${plural(waits, "issue")}` : "");
  return (
    <a
      href={href}
      role="listitem"
      aria-label={label}
      class={`${styles.node} ${styles[n.look]} ${extra}`}
      // Placed with a transform, which slides (Graph.module.css) when the place changes.
      style={{ transform: `translate(${x}px, ${y}px)` }}
      aria-haspopup={onAsk ? "dialog" : undefined}
      onClick={(e) => {
        if (justDragged()) return e.preventDefault();
        // Ctrl/Cmd, Shift or a middle click follow the link to its detail page.
        if (!onAsk || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        onAsk();
      }}
      {...handlers}
      {...(n.task ? {} : { target: "_blank", rel: "noreferrer" })}
    >
      <title>{`${title} (${n.status})`}</title>
      <rect width={w} height={h} rx="8" />
      <text x={12} y={21} class={styles.ref}>
        {ref}
      </text>
      {n.look === "pending" && (
        <circle class={styles.spinner} cx={w - 18} cy={17} r={5} aria-hidden="true" />
      )}
      {badge > 0 && (
        <g class={styles.badge} aria-hidden="true">
          <rect x={w - 10 - badge} y={9} width={badge} height={16} rx={8} />
          <text x={w - 10 - badge / 2} y={21} text-anchor="middle">
            {count ? `?${count}` : "?"}
          </text>
        </g>
      )}
      {fits && (
        <text x={w - right} y={21} class={styles.status} text-anchor="end">
          {status}
        </text>
      )}
      <text x={12} y={41} class={styles.title}>
        {shorten(title, chars)}
      </text>
    </a>
  );
}

interface DrawingProps {
  // api/state not read yet.
  loading: boolean;
  nodes: GraphNode[];
  edges: Edge[];
  // Closed issues left out (Show closed is off).
  hidden: number;
  onShowClosed: (show: boolean) => void;
  shape: Layout;
  svg: RefObject<SVGSVGElement>;
  repo: string | null;
  github: string;
  // The node a drop would queue after.
  target: string | null;
  // Which nodes move, and the drag of one (graphHooks.ts useNodeDrag()).
  movable: (n: GraphNode) => boolean;
  drag: {
    moving: NodeDrag | null;
    onTop: string | null;
    handlers: (n: GraphNode) => JSX.HTMLAttributes<HTMLAnchorElement>;
    justDragged: () => boolean;
  };
  // A click on a node waiting for answers: its questions, in place.
  onAsk: (task: Task) => void;
}

export function GraphDrawing({
  loading,
  nodes,
  edges,
  hidden,
  onShowClosed,
  shape,
  svg,
  repo,
  github,
  target,
  movable,
  drag,
  onAsk,
}: DrawingProps) {
  if (loading) return <p class={styles.empty}>Loading…</p>;
  if (!nodes.length && hidden) {
    return (
      <p class={styles.empty}>
        Nothing open here.{" "}
        <button type="button" class={styles.show} onClick={() => onShowClosed(true)}>
          Show closed issues
        </button>
      </p>
    );
  }
  if (!nodes.length) {
    return (
      <p class={styles.empty}>No issues here yet.{repo ? " Drop one here to start it." : ""}</p>
    );
  }
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const chars = Math.floor((shape.w - 24) / 7);
  // In an order that doesn't change as nodes come and go, so none is moved in the page (which
  // would cut its slide short); the one pressed last goes last: SVG paints in order.
  const boxes = [...shape.boxes].sort(
    (a, b) =>
      Number(a.key === drag.onTop) - Number(b.key === drag.onTop) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return (
    <svg
      ref={svg}
      class={styles.svg}
      width={shape.width + 8}
      height={shape.height + 8}
      viewBox={`-4 -4 ${shape.width + 8} ${shape.height + 8}`}
      role="list"
      aria-label={repo ? `Issues of ${repo}` : "Issues"}
    >
      <ArrowMarkers />
      {shape.arrows.map((a) => {
        // Behind a failed issue, the chain holds: its arrows say so.
        const held = byKey.get(a.from)?.look === "err";
        return (
          <path
            key={`${a.from} ${a.to}`}
            d={a.d}
            // As a style too, where browsers can slide it along with its nodes.
            style={{ d: `path("${a.d}")` }}
            class={`${styles.arrow} ${held ? styles.held : ""}`}
            marker-end={held ? "url(#arrow-held)" : "url(#arrow)"}
          />
        );
      })}
      {boxes.map((b) => {
        const n = byKey.get(b.key)!;
        const moving = drag.moving?.key === n.key ? drag.moving : null;
        return (
          <GraphNodeView
            key={n.key}
            n={n}
            x={b.x + (moving?.dx ?? 0)}
            y={b.y + (moving?.dy ?? 0)}
            w={shape.w}
            h={shape.h}
            chars={chars}
            showRepo={!repo}
            href={
              n.task
                ? formatRoute({ repo, task: n.key, run: null })
                : `${github}/${n.repo}/issues/${n.number}`
            }
            waits={edges.filter((e) => e.to === n.key).length}
            extra={[
              movable(n) && styles.movable,
              target === n.key && !moving && styles.target,
              moving && styles.moving,
            ]
              .filter(Boolean)
              .join(" ")}
            onAsk={asks(n) ? () => onAsk(n.task) : undefined}
            justDragged={drag.justDragged}
            handlers={movable(n) ? drag.handlers(n) : {}}
          />
        );
      })}
    </svg>
  );
}
