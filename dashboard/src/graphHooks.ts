// The board's state besides its model: its layout kept from one drawing to the next, a
// node dragged by the pointer, and the open questions a node's click or a drag opens
// (Board.tsx).
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { sendAnswers } from "./api";
import { type Layout, layout } from "./graphLayout";
import { type GraphNode, reorderable } from "./graphModel";
import type { Answers, Edge, Pending, Task, WorkAction, WorkResult } from "./types";

// The layout of `nodes`, keeping the last drawing's places on this tab (`repo`) and at this
// size: adding or moving an issue doesn't move the others. An issue just queued goes next to
// what it now waits for, wherever it was.
export function useKeptLayout(
  nodes: GraphNode[],
  edges: Edge[],
  pending: Pending[],
  { repo, narrow }: { repo: string | null; narrow: boolean },
): Layout {
  const last = useRef<{ on: string; shape: Layout } | null>(null);
  const queued = new Set(
    pending.filter((p) => p.action === "queue").map((p) => `${p.repo}#${p.number}`),
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
  return shape;
}

// Past this many pixels a press on a node is a drag, not a click.
const DRAG_PX = 6;

// A node being dragged: where the pointer went down, how far it moved.
export interface NodeDrag {
  key: string;
  number: number;
  // A waiting node (let go in the open, it stops waiting), not one waiting for answers.
  waits: boolean;
  // A queued one, which moves in the run order.
  queued: boolean;
  pointer: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  moved: boolean;
}

interface NodeDragEvents {
  // Each move once it is a drag, with the drag, and the end of it (null).
  onMove: (at: { x: number; y: number } | null, drag?: NodeDrag) => void;
  // Let go after it moved.
  onDrop: (drag: NodeDrag, at: { x: number; y: number }) => void;
}

// A movable node follows the pointer once it moved past DRAG_PX.
export function useNodeDrag({ onMove, onDrop }: NodeDragEvents) {
  const [drag, setDrag] = useState<NodeDrag | null>(null);
  // The node last pressed, drawn last (on top) from then on: moving it back among the others
  // when it is let go would cut its slide to its new place short.
  const [onTop, setOnTop] = useState<string | null>(null);
  // A drag ended on a node: the click that follows doesn't open it.
  const ended = useRef(false);

  const handlers = (n: GraphNode): JSX.HTMLAttributes<HTMLAnchorElement> => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setOnTop(n.key);
      setDrag({
        key: n.key,
        number: n.number!,
        waits: n.task?.state === "waiting",
        queued: !!n.task && reorderable(n.task),
        pointer: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dx: 0,
        dy: 0,
        moved: false,
      });
    },
    onPointerMove: (e) => {
      if (!drag || drag.pointer !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      const moved = drag.moved || Math.hypot(dx, dy) > DRAG_PX;
      const next = { ...drag, dx, dy, moved };
      setDrag(next);
      if (moved) onMove({ x: e.clientX, y: e.clientY }, next);
    },
    onPointerUp: (e) => {
      if (!drag || drag.pointer !== e.pointerId) return;
      setDrag(null);
      onMove(null);
      if (!drag.moved) return;
      ended.current = true;
      onDrop(drag, { x: e.clientX, y: e.clientY });
    },
    onPointerCancel: () => {
      setDrag(null);
      onMove(null);
    },
    // The browser's own drag of a link would take over from the pointer's.
    onDragStart: (e) => e.preventDefault(),
  });

  // The click a drag's end makes: true once, to be ignored.
  const justDragged = () => {
    const was = ended.current;
    ended.current = false;
    return was;
  };

  return { moving: drag?.moved ? drag : null, onTop, handlers, justDragged };
}

// An issue's start or queue that waits for its open questions to be answered; no action: a
// click on its node, which just answers them.
export interface Asking {
  task: Task;
  action: WorkAction | null;
}

// The open questions shown on `repo`'s graph, the tasks whose answers are on their way (their
// nodes say Sending… until api/state is read again, where their run continues), and what the
// last answers sent from a click said.
export function useAnswering(repo: string | null, refresh?: () => Promise<void>) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [sending, setSending] = useState<string[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    setAsking(null);
    setSaid(null);
  }, [repo]);

  // Answers sent from a click on the node. A refusal stays in the form.
  const answer = async (task: Task, body: Answers): Promise<WorkResult> => {
    setSaid(null);
    setSending((all) => [...all, task.key]);
    const result = await sendAnswers(task.repo, body);
    const done = () => setSending((all) => all.filter((k) => k !== task.key));
    if (result.error) done();
    else (refresh?.() ?? Promise.resolve()).finally(done);
    return result;
  };

  return {
    asking,
    // A click asks afresh: what the last answers said goes.
    ask: (task: Task, action: WorkAction | null) => {
      if (!action) setSaid(null);
      setAsking({ task, action });
    },
    close: () => setAsking(null),
    sending,
    said,
    // Once sent: the form goes, and answers sent alone (a click's, or with "Then…" unticked)
    // say what the listener said; an action's says it in the work area.
    sent: (message: string, withAction = !!asking?.action) => {
      if (!withAction) setSaid(message);
      setAsking(null);
    },
    answer,
  };
}
