// What the board's graph draws (Board.tsx): its nodes (each one's number, state, place in the
// run order, "?" badge and two-line title, in its status tone) on a dotted canvas, the
// orthogonal arrows between them, and while something is dragged, what letting it go does. Or
// why there is nothing to draw.
import type { JSX, RefObject } from "preact";
import type { Target } from "./Chooser";
import type { Look } from "./dnd";
import { kindName, numberOf, plural, shortRepo, shorten } from "./format";
import type { NodeDrag } from "./graphHooks";
import type { Layout } from "./graphLayout";
import { type GraphNode, LOUD, moving, ordinal, TONES } from "./graphModel";
import { formatRoute } from "./route";
import type { Edge, Task } from "./types";
import { StatusDot, toneClass } from "./ui/Status";
import styles from "./Graph.module.css";

// Room around the drawing, for the focus ring and the arrows' ends.
export const PAD = 8;

// "#12", "PR #3", with the repo before it when asked and there is room: the number always
// shows.
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
      title: n.title ?? "",
      tone: TONES[n.look],
      status: n.status,
    }));

// A node whose click answers its questions in place: a task waiting for answers, with them
// parsed (a label alone opens the detail page).
export const asks = (n: GraphNode): n is GraphNode & { task: Task } =>
  n.look === "input" && !!n.task?.questions;

// What a node's link opens: its task, else its issue on GitHub.
export const nodeHref = (n: GraphNode, repo: string | null, github: string) =>
  n.task ? formatRoute({ repo, task: n.key, run: null }) : `${github}/${n.repo}/issues/${n.number}`;

// Its name for screen readers: "#24 Its title: Waiting, waits for 2 issues".
export function nodeLabel(n: GraphNode, waits: number): string {
  const count = n.task?.questions?.items?.length;
  return (
    `${nodeRef(n, false, 0)} ${n.title ?? ""}`.trim() +
    `: ${n.status}` +
    (n.position ? `, ${ordinal(n.position)} in line` : "") +
    (count ? `, ${plural(count, "question")}` : "") +
    (waits ? `, waits for ${plural(waits, "issue")}` : "")
  );
}

// A node's classes for its look: its tone, a border when it needs looking at, dimmed when
// done, dashed while an action on it is on its way. The lanes' compact nodes share them.
export function lookClasses(n: GraphNode, s: Record<string, string>): string {
  return [
    toneClass(TONES[n.look]),
    LOUD.includes(n.look) && s.loud,
    (n.look === "done" || n.look === "implemented") && s.done,
    n.look === "pending" && s.pending,
    n.look === "talk" && s.talk,
  ]
    .filter(Boolean)
    .join(" ");
}

// A queued node's place in the run order: "1st", "2nd"…
export function PlaceBadge({ n, class: className }: { n: GraphNode; class: string }) {
  if (!n.position) return null;
  return (
    <span class={className} aria-hidden="true" title={`${ordinal(n.position)} in line to start`}>
      {ordinal(n.position)}
    </span>
  );
}

// The "?" badge: with the open question count, or alone (questions not in the format).
export function QuestionBadge({ n, class: className }: { n: GraphNode; class: string }) {
  if (!asks(n)) return null;
  const count = n.task.questions?.items?.length;
  return (
    <span class={className} aria-hidden="true">
      {count ? `?${count}` : "?"}
    </span>
  );
}

// What clicking a node does: open its questions in place (`onAsk`), else follow its link.
// Ctrl/Cmd, Shift or a middle click always follow it, to its detail page.
export const nodeClick =
  (onAsk: (() => void) | undefined, justDragged: () => boolean = () => false) =>
  (e: MouseEvent) => {
    if (justDragged()) return e.preventDefault();
    if (!onAsk || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    onAsk();
  };

interface Props {
  n: GraphNode;
  // Where it is drawn (a drag's offset included), and the nodes' size.
  x: number;
  y: number;
  w: number;
  h: number;
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
  href,
  waits,
  extra,
  onAsk,
  justDragged,
  handlers,
}: Props) {
  const title = n.title ?? `${kindName(n)} ${nodeRef(n, false, 0)}`;
  return (
    <a
      href={href}
      role="listitem"
      data-card
      data-number={n.number ?? undefined}
      aria-label={nodeLabel(n, waits)}
      title={`${title} (${n.status})`}
      class={`${styles.node} ${lookClasses(n, styles)} ${extra}`}
      // Placed with a transform, which slides (Graph.module.css) when the place changes.
      style={{ transform: `translate(${x}px, ${y}px)`, width: `${w}px`, height: `${h}px` }}
      aria-haspopup={onAsk ? "dialog" : undefined}
      onClick={nodeClick(onAsk, justDragged)}
      {...handlers}
      {...(n.task ? {} : { target: "_blank", rel: "noreferrer" })}
    >
      <span class={styles.top}>
        <StatusDot tone={TONES[n.look]} pulse={moving(n)} />
        <span class={styles.ref}>{nodeRef(n, false, 0)}</span>
        <span class={styles.state}>{n.status}</span>
        <PlaceBadge n={n} class={styles.place} />
        <QuestionBadge n={n} class={styles.badge} />
      </span>
      <span class={styles.title}>{title}</span>
    </a>
  );
}

// An arrow's head, and a held one's (what waits behind a failed issue).
function ArrowMarkers() {
  return (
    <defs>
      {[
        ["arrow", styles.head],
        ["arrow-held", `${styles.head} ${styles.heldHead}`],
      ].map(([id, look]) => (
        <marker
          key={id}
          id={id}
          viewBox="0 0 8 10"
          refX="7"
          refY="5"
          markerWidth="7"
          markerHeight="10"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 0L8 5L0 10z" class={look} />
        </marker>
      ))}
    </defs>
  );
}

// What letting the drag go does, and where it says so: over its target, or at the pointer.
export interface DropLabel {
  text: string;
  x: number;
  y: number;
}

// A work queue card dragged over the graph, drawn as a node at the pointer (drawing units):
// the browser's own drag image is hidden (dnd.ts).
export interface Ghost extends Look {
  number: number;
  x: number;
  y: number;
}

// Where the pointer holds the ghost, from its top left corner: by its number.
export const GHOST_GRIP = { x: 24, y: 18 };

function GhostView({ ghost, w, h }: { ghost: Ghost; w: number; h: number }) {
  return (
    <div
      class={`${styles.node} ${styles.moving} ${styles.ghost}`}
      style={{
        transform: `translate(${PAD + ghost.x - GHOST_GRIP.x}px, ${PAD + ghost.y - GHOST_GRIP.y}px)`,
        width: `${w}px`,
        height: `${h}px`,
      }}
      aria-hidden="true"
    >
      <span class={styles.top}>
        <span class={styles.ref}>#{ghost.number}</span>
        <span class={styles.state}>{ghost.status}</span>
      </span>
      <span class={styles.title}>{ghost.title}</span>
    </div>
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
  // The drawing's own box: where a drop lands is read from it.
  drawing: RefObject<HTMLDivElement>;
  zoom: number;
  repo: string;
  github: string;
  // The node a drop would queue after, and what the drop does.
  target: string | null;
  label: DropLabel | null;
  ghost: Ghost | null;
  // Which nodes move, and the drag of one (graphHooks.ts useNodeDrag()).
  movable: (n: GraphNode) => boolean;
  drag: {
    moving: NodeDrag | null;
    onTop: string | null;
    handlers: (n: GraphNode) => JSX.HTMLAttributes<HTMLAnchorElement>;
    justDragged: () => boolean;
  };
  // A click on a node waiting for answers: its questions, in place.
  // Null: the user may not answer here (runs:manage), the node opens its task.
  onAsk: ((task: Task) => void) | null;
}

export function GraphDrawing({
  loading,
  nodes,
  edges,
  hidden,
  onShowClosed,
  shape,
  drawing,
  zoom,
  repo,
  github,
  target,
  label,
  ghost,
  movable,
  drag,
  onAsk,
}: DrawingProps) {
  const message = loading ? (
    <p class={styles.empty}>Loading…</p>
  ) : !nodes.length && hidden ? (
    <p class={styles.empty}>
      Nothing open here.{" "}
      <button type="button" class={styles.show} onClick={() => onShowClosed(true)}>
        Show closed issues
      </button>
    </p>
  ) : !nodes.length ? (
    <p class={styles.empty}>No issues here yet. Drop one here to start it.</p>
  ) : null;
  // A drag's ghost and what letting go does, over the drawing.
  const dragged = (
    <>
      {ghost && <GhostView ghost={ghost} w={shape.w} h={shape.h} />}
      {label && (
        <span
          class={styles.dropLabel}
          style={{ transform: `translate(${PAD + label.x}px, ${PAD + label.y}px)` }}
          aria-hidden="true"
        >
          {label.text}
        </span>
      )}
    </>
  );
  // Nothing to draw: an empty drawing under the message all the same, where a card dragged
  // there shows (the browser's own image is hidden).
  if (message) {
    return (
      <>
        {message}
        <div class={styles.plane}>
          <div ref={drawing} class={styles.drawing} style={{ transform: `scale(${zoom})` }}>
            {dragged}
          </div>
        </div>
      </>
    );
  }
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const width = shape.width + 2 * PAD;
  const height = shape.height + 2 * PAD;
  // In an order that doesn't change as nodes come and go, so none is moved in the page (which
  // would cut its slide short); the one pressed last goes last, on top.
  const boxes = [...shape.boxes].sort(
    (a, b) =>
      Number(a.key === drag.onTop) - Number(b.key === drag.onTop) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return (
    // Sized as the drawing looks at this zoom, so the canvas scrolls by what shows.
    <div class={styles.plane} style={{ width: `${width * zoom}px`, height: `${height * zoom}px` }}>
      <div
        ref={drawing}
        class={styles.drawing}
        style={{ width: `${width}px`, height: `${height}px`, transform: `scale(${zoom})` }}
        role="list"
        aria-label={`Issues of ${repo}`}
      >
        <svg
          class={styles.arrows}
          width={width}
          height={height}
          viewBox={`${-PAD} ${-PAD} ${width} ${height}`}
          aria-hidden="true"
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
        </svg>
        {boxes.map((b) => {
          const n = byKey.get(b.key)!;
          const moving = drag.moving?.key === n.key ? drag.moving : null;
          return (
            <GraphNodeView
              key={n.key}
              n={n}
              x={PAD + b.x + (moving?.dx ?? 0) / zoom}
              y={PAD + b.y + (moving?.dy ?? 0) / zoom}
              w={shape.w}
              h={shape.h}
              href={nodeHref(n, repo, github)}
              waits={edges.filter((e) => e.to === n.key).length}
              extra={[
                movable(n) && styles.movable,
                target === n.key && !moving && styles.target,
                moving && styles.moving,
              ]
                .filter(Boolean)
                .join(" ")}
              onAsk={asks(n) && onAsk ? () => onAsk(n.task) : undefined}
              justDragged={drag.justDragged}
              handlers={movable(n) ? drag.handlers(n) : {}}
            />
          );
        })}
        {dragged}
      </div>
    </div>
  );
}
