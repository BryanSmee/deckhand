// The graph page: one node per issue, an arrow from each issue to what waits for it
// ("/after"), coloured by where it stands (graph.ts). A node opens its task. On a repo's tab
// it is a work area too (WorkArea.tsx): an issue dropped on it starts, dropped next to a node
// it waits for that one; a waiting node dragged away stops waiting, onto another node waits
// for that one instead. An issue waiting for answers moves too, once they are in: the drag
// opens its open questions first (Questions.tsx). Brainstorms have a column of their own
// between the backlog and the graph (Brainstorms.tsx): one dropped on the graph starts work.
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useWorkArea } from "./api";
import { Inbox } from "./Inbox";
import { Brainstorms } from "./Brainstorms";
import { inChip, kindName } from "./format";
import {
  brainstormsOf,
  dropTarget,
  graphOf,
  type GraphNode,
  issueOfLink,
  type Layout,
  layout,
  LOOKS,
  shorten,
} from "./graph";
import { Questions } from "./Questions";
import { formatRoute } from "./route";
import type { State, Task, WorkAction } from "./types";
import { BRAINSTORM_TYPE, ISSUE_TYPE, type Target, WorkArea } from "./WorkArea";
import styles from "./Graph.module.css";

interface Props {
  state: State | null;
  // Reads api/state again: an action's node shows without waiting for the next tick.
  refresh?: () => Promise<void>;
  repo: string | null;
  // A phone: smaller nodes; a long chain scrolls sideways.
  narrow: boolean;
  // Closed issues (implemented, not planned) are drawn too.
  showClosed: boolean;
  onShowClosed: (show: boolean) => void;
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
  // A waiting node (let go in the open, it stops waiting), not one waiting for answers.
  waits: boolean;
  pointer: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  moved: boolean;
}

// An issue waiting for the maintainer ("Needs input": its questions, or a brainstorm's next
// comment, on the graph when an arrow touches it): starting it answers them first, or ends the
// brainstorm with a work run.
const answers = (t: Task) => inChip("input", t) && (t.kind === "issue" || t.kind === "brainstorm");

// What is dragged onto the graph: a card from the backlog (or a node waiting for answers), a
// brainstorm (Start in doesn't apply: it starts work), a waiting node (let go in the open, it
// stops waiting).
type Dragged = "new" | "brainstorm" | "waits";

// Past this many pixels a press on a waiting node is a drag, not a click.
const DRAG_PX = 6;

export function Graph({ state, refresh, repo, narrow, showClosed, onShowClosed }: Props) {
  const work = useWorkArea(repo, refresh);
  const [mode, setMode] = useState("work");
  const [notice, setNotice] = useState<string | null>(null);
  // Something is dragged over the area, and the node a drop there would queue after.
  const [over, setOver] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [nodeDrag, setNodeDrag] = useState<NodeDrag | null>(null);
  // The node last pressed, drawn last (on top) from then on: moving it back among the others
  // when it is let go would cut its slide to its new place short.
  const [onTop, setOnTop] = useState<string | null>(null);
  // An issue's start or queue that waits for its open questions to be answered.
  const [asking, setAsking] = useState<{ task: Task; action: WorkAction } | null>(null);
  // The last drawing, on this tab and at this size: its places are kept.
  const last = useRef<{ on: string; shape: Layout } | null>(null);
  // A drag ended on a node: the click that follows doesn't open it.
  const dragEnded = useRef(false);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    setMode("work");
    setNotice(null);
    setAsking(null);
  }, [repo]);
  useEffect(() => {
    if (!asking) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setAsking(null);
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [asking]);
  const tasks = (state?.tasks ?? []).filter((t) => !repo || t.repo === repo);
  const brainstorms = brainstormsOf(tasks, work.pending);
  const { nodes, edges, hidden } = graphOf(tasks, state?.edges ?? [], state?.blockers ?? [], {
    showClosed,
    pending: work.pending,
  });
  // An issue just queued goes next to what it now waits for, wherever it was.
  const queued = new Set(
    work.pending.filter((p) => p.action === "queue").map((p) => `${p.repo}#${p.number}`),
  );
  const on = `${repo} ${narrow}`;
  const prev = last.current?.on === on ? last.current.shape : null;
  const shape = layout(
    nodes.map((n) => n.key),
    edges,
    { narrow },
    prev && { ...prev, boxes: prev.boxes.filter((b) => !queued.has(b.key)) },
  );
  last.current = { on, shape };
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const github = state?.githubUrl ?? "https://github.com";
  const chars = Math.floor((shape.w - 24) / 7);
  const modes = work.backlog?.modes ?? [];
  const picked = mode === "work" || !modes.includes(mode) ? {} : { mode };
  const blocked = !!work.backlog?.errors;
  // Only a repo's issues move: what runs or ran stays where it is. Those waiting for answers
  // move whatever their last run was (a brainstorm's kind is "brainstorm"): not a pull request.
  const movable = (n: GraphNode) =>
    !!repo &&
    !blocked &&
    n.look !== "pending" &&
    n.number !== null &&
    !!n.task &&
    (n.task.state === "waiting" ? n.kind === "issue" : answers(n.task));
  const targets: Target[] = repo
    ? nodes
        .filter((n) => n.number !== null)
        .map((n) => ({
          key: n.key,
          number: n.number!,
          label: `${refOf(n, false, 0)} ${shorten(n.title ?? "", 40)}`.trim(),
        }))
    : [];
  const sentFor = (number: number) => work.pending.some((p) => p.number === number);
  // Less those a Start or Remove on its way takes out of their wait.
  const leaving = new Set(work.pending.filter((p) => p.action !== "queue").map((p) => p.number));
  const waiting = tasks.filter(
    (t) => t.state === "waiting" && t.kind === "issue" && t.number && !leaving.has(t.number),
  );
  // Brainstorms are the column's.
  const answering = tasks.filter(
    (t) => answers(t) && t.state === "needs-input" && t.number && !sentFor(t.number),
  );

  // The node under the pointer, in the drawing's units (the viewBox starts at -4).
  const targetAt = (clientX: number, clientY: number) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return null;
    return dropTarget(shape, clientX - box.left - 4, clientY - box.top - 4);
  };

  // Issue `number` let go on the area, after `onto` (a node) or in the open. A waiting node
  // keeps its mode, and the open cancels its wait rather than starts it; a brainstorm starts
  // work.
  const dropped = (number: number, onto: string | null, what: Dragged) => {
    setNotice(null);
    const node = onto ? byKey.get(onto) : null;
    if (node?.number === number && node.repo === repo) return;
    const mode = what === "new" ? picked : {};
    if (node?.number != null) {
      return request({ action: "queue", number, after: node.number, ...mode });
    }
    request(
      what === "waits" ? { action: "dequeue", number } : { action: "start", number, ...mode },
    );
  };

  // An action, unless its issue has open questions: they are answered first, in a form (unless
  // its repo doesn't wait for answers).
  const request = (action: WorkAction) => {
    const task = tasks.find((t) => t.key === `${repo}#${action.number}`);
    const asks = task?.state === "needs-input" && task.questions && task.waitForAnswers !== false;
    if (action.action !== "dequeue" && asks) {
      setAsking({ task, action });
      return;
    }
    work.act(action);
  };

  const onDragOver = (e: DragEvent) => {
    const types = [...(e.dataTransfer?.types ?? [])];
    const ours = [ISSUE_TYPE, BRAINSTORM_TYPE, "text/uri-list", "text/plain"];
    if (blocked || !types.some((t) => ours.includes(t))) {
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
    const brainstorm = Number(data?.getData(BRAINSTORM_TYPE));
    const own = brainstorm || Number(data?.getData(ISSUE_TYPE));
    const link = data?.getData("text/uri-list") || data?.getData("text/plain") || "";
    const number = own || (repo && issueOfLink(link, github, repo));
    if (!number) {
      setNotice(
        `That isn't a link to one of ${repo}'s issues: drag an issue's card from the work area, or its link.`,
      );
      return;
    }
    dropped(number, targetAt(e.clientX, e.clientY), brainstorm ? "brainstorm" : "new");
  };

  // A waiting node follows the pointer once it moved past DRAG_PX.
  const nodeHandlers = (n: GraphNode): JSX.HTMLAttributes<HTMLAnchorElement> => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setOnTop(n.key);
      setNodeDrag({
        key: n.key,
        number: n.number!,
        waits: n.task?.state === "waiting",
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
      dropped(nodeDrag.number, targetAt(e.clientX, e.clientY), nodeDrag.waits ? "waits" : "new");
    },
    onPointerCancel: () => {
      setNodeDrag(null);
      setTarget(null);
    },
    // The browser's own drag of a link would take over from the pointer's.
    onDragStart: (e) => e.preventDefault(),
  });

  // In an order that doesn't change as nodes come and go, so none is moved in the page (which
  // would cut its slide short); the one pressed last goes last: SVG paints in order.
  const boxes = [...shape.boxes].sort(
    (a, b) =>
      Number(a.key === onTop) - Number(b.key === onTop) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const drawing = !state ? (
    <p class={styles.empty}>Loading…</p>
  ) : !nodes.length && hidden ? (
    <p class={styles.empty}>
      Nothing open here.{" "}
      <button type="button" class={styles.show} onClick={() => onShowClosed(true)}>
        Show closed issues
      </button>
    </p>
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
            // As a style too, where browsers can slide it along with its nodes.
            style={{ d: `path("${a.d}")` }}
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
        // Placed with a transform, which slides (Graph.module.css) when the place changes.
        const x = b.x + (moving?.dx ?? 0);
        const y = b.y + (moving?.dy ?? 0);
        return (
          <a
            key={n.key}
            href={href}
            role="listitem"
            aria-label={label}
            class={`${styles.node} ${styles[n.look]} ${movable(n) ? styles.movable : ""} ${
              target === n.key && !moving ? styles.target : ""
            } ${moving ? styles.moving : ""}`}
            style={{ transform: `translate(${x}px, ${y}px)` }}
            onClick={(e) => {
              if (!dragEnded.current) return;
              dragEnded.current = false;
              e.preventDefault();
            }}
            {...(movable(n) ? nodeHandlers(n) : {})}
            {...(n.task ? {} : { target: "_blank", rel: "noreferrer" })}
          >
            <title>{`${title} (${n.status})`}</title>
            <rect width={shape.w} height={shape.h} rx="8" />
            <text x={12} y={21} class={styles.ref}>
              {ref}
            </text>
            {n.look === "pending" && (
              <circle class={styles.spinner} cx={shape.w - 18} cy={17} r={5} aria-hidden="true" />
            )}
            <text
              x={shape.w - (n.look === "pending" ? 30 : 12)}
              y={21}
              class={styles.status}
              text-anchor="end"
            >
              {n.status}
            </text>
            <text x={12} y={41} class={styles.title}>
              {shorten(title, chars)}
            </text>
          </a>
        );
      })}
    </svg>
  );

  return (
    <div class={styles.page}>
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
        <li class={styles.toggle}>
          <label title="Issues closed as completed or not planned, and merged pull requests">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => onShowClosed(e.currentTarget.checked)}
            />
            Show closed
          </label>
        </li>
      </ul>
      {repo ? (
        <div class={styles.work}>
          <WorkArea
            repo={repo}
            work={work}
            targets={targets}
            waiting={waiting}
            answering={answering}
            github={github}
            mode={modes.includes(mode) ? mode : "work"}
            onMode={setMode}
            notice={notice}
            onAct={request}
          >
            <Inbox
              key={repo}
              repo={repo}
              inboxes={state?.inboxes?.[repo]}
              tasks={state?.tasks ?? []}
              onSent={() => void refresh?.()}
            />
          </WorkArea>
          <Brainstorms
            repo={repo}
            cards={brainstorms}
            targets={targets}
            busy={work.busy}
            blocked={blocked}
            github={github}
            onAct={request}
            onNotice={setNotice}
          />
          <div
            class={`${styles.area} ${over || nodeDrag?.moved ? styles.over : ""}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {drawing}
          </div>
          {asking?.task.questions && (
            <div
              class={styles.backdrop}
              onClick={(e) => e.target === e.currentTarget && setAsking(null)}
            >
              <div
                class={styles.dialog}
                role="dialog"
                aria-modal="true"
                aria-label={`Answer #${asking.task.number}'s questions`}
              >
                <p class={styles.asks}>
                  <b>
                    {asking.action.action === "queue"
                      ? `Answer them to queue #${asking.task.number} after #${asking.action.after}`
                      : `Answer them to start #${asking.task.number}`}
                  </b>
                  {asking.task.title}
                </p>
                <Questions
                  task={asking.task}
                  questions={asking.task.questions}
                  then={asking.action.action === "queue" ? "queue" : "start"}
                  submit={(body) => work.act(asking.action, body)}
                  onSent={() => setAsking(null)}
                  onCancel={() => setAsking(null)}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <p class={styles.hint}>Open a repository's tab to start or queue its issues here.</p>
          <div class={`${styles.work} ${styles.overview}`}>
            <Brainstorms
              repo={null}
              cards={brainstorms}
              targets={[]}
              busy={false}
              blocked={false}
              github={github}
              onAct={() => {}}
              onNotice={() => {}}
            />
            <div>{drawing}</div>
          </div>
        </>
      )}
    </div>
  );
}
