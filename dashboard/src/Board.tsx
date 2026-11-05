// A repository's board (docs/design/dashboard-redesign.md › Pages › Board): the work queue
// (WorkQueue.tsx) beside what waits for what, as a graph (GraphDrawing.tsx) or as lanes
// (Lanes.tsx); on a phone, the lanes with the queue as a bottom sheet. An issue dropped on the
// graph starts, dropped on a node it waits for that one; a waiting node dragged away stops
// waiting, onto another node waits for that one instead. A stopped or failed issue's node moves
// like its backlog card, once the backlog lists it. An issue waiting for answers moves too, once
// they are in: the drag opens its open questions first (QuestionsDialog.tsx), and so does a
// click on its node. A brainstorm dropped on the graph starts work. A queued node dragged onto
// another queued node's left or right edge moves before or after it in the run order (the
// Queued tab does it too). While a drag goes on, the graph says what letting go does ("Queue
// #31 after #19"); each action shows at once, its node dashed ("Starting…"), before api/state
// is read again. Its shortcuts: the arrows move between the cards (the work queue's, the
// graph's or the lanes'), Enter opens the one selected, S, Q and B start it, queue it after
// another or brainstorm it (its card's buttons), V switches the view, C shows the closed
// issues, + − 0 zoom and fit, Space and a drag pan.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useCan } from "./access";
import { useRunOrder, useWorkArea } from "./api";
import {
  BRAINSTORM_TYPE,
  carriedCard,
  dragEnded,
  droppedIssue,
  ISSUE_TYPE,
  LINK_TYPES,
  type Look,
  QUEUED_TYPE,
} from "./dnd";
import { sameRepo } from "./format";
import { type DropLabel, GHOST_GRIP, GraphDrawing, nodeRef, PAD, targetsOf } from "./GraphDrawing";
import { useAnswering, useKeptLayout, useNodeDrag } from "./graphHooks";
import { dropTarget } from "./graphLayout";
import { GraphLegend } from "./GraphLegend";
import {
  brainstormsOf,
  graphOf,
  type GraphNode,
  inLine,
  isParent,
  nextInLine,
  movable,
  moveOnto,
  onEdge,
  reorderable,
  stillInLine,
  waitable,
  workLists,
} from "./graphModel";
import { typesOf, useDropZone } from "./hooks";
// `tr`: t() where a task is called `t`.
import { t as tr, tx } from "./i18n";
import { useHeldKey, useShortcuts, withKey } from "./keys";
import { formatRoute } from "./route";
import { Lanes } from "./Lanes";
import { QuestionsDialog } from "./QuestionsDialog";
import type { State, Task, WorkAction } from "./types";
import { Button, IconButton } from "./ui/Button";
import { Segmented, Switch } from "./ui/Choice";
import { Field } from "./ui/Field";
import * as Icon from "./ui/icons";
import { Sheet } from "./ui/Sheet";
import { type QueueTab, WorkQueue } from "./WorkQueue";
import styles from "./Board.module.css";

export type BoardView = "graph" | "lanes";

interface Props {
  state: State | null;
  // Reads api/state again: an action's node shows without waiting for the next tick.
  refresh?: () => Promise<void>;
  repo: string;
  // A phone: the queue as a sheet, smaller nodes, 44 px controls.
  narrow: boolean;
  // Closed issues (implemented, not planned) are drawn too.
  showClosed: boolean;
  onShowClosed: (show: boolean) => void;
  view: BoardView;
  onView: (view: BoardView) => void;
  // The page header, on a wide screen, with the board's own controls (Start in).
  header?: (controls: ComponentChildren) => ComponentChildren;
}

// What is dragged onto the graph: a card from the backlog or a stopped issue's node (or one
// waiting for answers), a brainstorm (Start in doesn't apply: it starts work), a waiting node
// (let go in the open, it stops waiting), a queued node (onto a queued node's left or right
// edge, it moves in the run order).
type Dragged = "new" | "brainstorm" | "waits" | "queued";

// A drag over the graph: the node it would queue after, what is dragged, where (drawing units).
interface Hover {
  target: string | null;
  what: Dragged;
  // Null: a link from elsewhere, read only once dropped.
  number: number | null;
  // A work queue card's state and title, for its ghost. Null: a link, or a node moved.
  look: Look | null;
  // A queued node's key, and where on its target it is (moveOnto()).
  key?: string;
  side: number;
  x: number;
  y: number;
}

const ZOOM = { min: 0.4, max: 1.6, step: 0.1 };
const clampZoom = (z: number) => Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, z)) * 100) / 100;

// The arrows, in SHORTCUTS.move's order: left, up, right, down.
const DIRECTIONS = [
  [-1, 0],
  [0, -1],
  [1, 0],
  [0, 1],
];

// The card nearest `from` in direction `index`: ahead of it on that axis, the least off it
// counting double. Without a layout (nothing measured), the next or previous one in the page.
export function nearestCard(cards: HTMLElement[], from: HTMLElement, index: number) {
  const [dx, dy] = DIRECTIONS[index];
  const at = cards.indexOf(from);
  const boxes = cards.map((c) => c.getBoundingClientRect());
  if (boxes.every((b) => !b.width && !b.height)) return cards[at + (dx + dy > 0 ? 1 : -1)] ?? null;
  const centre = (b: DOMRect) => [b.left + b.width / 2, b.top + b.height / 2];
  const [x, y] = centre(boxes[at]);
  let best: HTMLElement | null = null;
  let score = Infinity;
  cards.forEach((c, i) => {
    if (i === at) return;
    const [cx, cy] = centre(boxes[i]);
    const ahead = (cx - x) * dx + (cy - y) * dy;
    const off = Math.abs((cx - x) * dy) + Math.abs((cy - y) * dx);
    if (ahead <= 1 || ahead + 2 * off >= score) return;
    best = c;
    score = ahead + 2 * off;
  });
  return best;
}

export function Board({
  state,
  refresh,
  repo,
  narrow,
  showClosed,
  onShowClosed,
  view,
  onView,
  header,
}: Props) {
  const work = useWorkArea(repo, refresh);
  const order = useRunOrder(repo, refresh);
  const questions = useAnswering(repo, refresh);
  const [mode, setMode] = useState("work");
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<QueueTab>("backlog");
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<Hover | null>(null);
  const [options, setOptions] = useState(false);
  useEffect(() => {
    setMode("work");
    setNotice(null);
    setTab("backlog");
  }, [repo]);
  // A card's drag ended without leaving the graph (Escape): its ghost goes with it.
  useEffect(() => {
    const ended = () => setHover(null);
    document.addEventListener("dragend", ended);
    return () => document.removeEventListener("dragend", ended);
  }, []);
  const drawing = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Space held over the graph: a drag pans it instead of moving a node.
  const spaced = useHeldKey("space", view === "graph");
  const [panning, setPanning] = useState(false);

  // A move in the run order shows at once, over every repo's line as the listener moves it
  // (`everyLine`); this repo's tasks and queue are taken from it.
  const shown = inLine(state?.tasks ?? [], order.moving);
  const everyLine = shown.line;
  const tasks = shown.tasks.filter((t) => sameRepo(t.repo, repo));
  // Less those an action on its way takes out of the queue.
  const line = stillInLine(
    everyLine.filter((t) => sameRepo(t.repo, repo)),
    work.pending,
  );
  // What Run next can't pass is maybe another repo's.
  const nextKey = nextInLine(everyLine);
  const brainstorms = brainstormsOf(tasks, work.pending);
  const { nodes, edges, hidden } = graphOf(tasks, state?.edges ?? [], state?.blockers ?? [], {
    showClosed,
    pending: work.pending,
    sending: questions.sending,
  });
  const shape = useKeptLayout(nodes, edges, work.pending, { repo, narrow });
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const github = state?.githubUrl ?? "https://github.com";
  const now = state?.now ?? Date.now();
  // What the user may do here (access.ts): Start in offers the modes they may start, and a
  // drag moves only what they may move.
  const can = useCan();
  const starts = (mode: string | null | undefined) => can.start(repo, mode || "work");
  const manages = can.repo(repo, "runs:manage");
  const modes = (work.backlog?.modes ?? []).filter((m) => starts(m));
  // Work first when allowed, else the first mode they may start (none: Start in is left out).
  const first =
    !work.backlog?.modes?.length || modes.includes("work") ? "work" : (modes[0] ?? "work");
  const chosen = modes.includes(mode) ? mode : first;
  const picked = chosen === "work" ? {} : { mode: chosen };
  const startsAny = modes.length > 0 || (!work.backlog?.modes?.length && starts("work"));
  const blocked = !!work.backlog?.errors;
  const listed = new Set(work.backlog?.issues.map((i) => i.number));
  // A queued node moves in the run order (runs:manage); the others start or wait in their mode.
  const moves = (n: GraphNode) =>
    movable(n, repo, blocked, listed) &&
    (n.task && reorderable(n.task) ? manages : starts(n.task?.mode));
  const ask = manages ? (task: Task) => questions.ask(task, null) : null;
  const targets = targetsOf(nodes);
  const { waiting, answering } = workLists(tasks, work.pending);

  // Where (clientX, clientY) is in the drawing's units, and the node a drop there queues after.
  const at = (clientX: number, clientY: number) => {
    const box = drawing.current?.getBoundingClientRect();
    if (!box) return null;
    const x = (clientX - box.left) / zoom - PAD;
    const y = (clientY - box.top) / zoom - PAD;
    const target = dropTarget(shape, x, y);
    const hit = target && shape.boxes.find((b) => b.key === target);
    // Where on the target, 0 its left edge, 1 its right: a queued node's edges move it.
    const side = hit ? (x - hit.x) / shape.w : 0.5;
    return { x, y, target, side };
  };
  const targetAt = (clientX: number, clientY: number) => at(clientX, clientY)?.target ?? null;

  // An issue whose open questions a start or a queue asks first (unless its repo doesn't wait).
  const asked = (number: number | null) => {
    const task = tasks.find((t) => t.key === `${repo}#${number}`);
    return task?.state === "needs-input" && !!task.questions && task.waitForAnswers !== false;
  };

  // A queued node moved in the run order, from the graph's drag or the Queued tab.
  const reorder = (move: Parameters<typeof order.move>[0]) => {
    setNotice(null);
    void order.move(move).then((said) => said.error && setNotice(said.error));
  };

  // Issue `number` let go on the area, after `onto` (a node) or in the open. A waiting node
  // keeps its mode, and the open cancels its wait rather than starts it; a brainstorm starts
  // work. A backlog issue with open sub-issues is laid out with them ("plan").
  const dropped = (number: number, onto: string | null, what: Dragged) => {
    setNotice(null);
    const node = onto ? byKey.get(onto) : null;
    if (node?.number === number && sameRepo(node.repo, repo)) return;
    const mode = what === "new" ? picked : {};
    const parent = what === "new" && isParent(work.backlog, number);
    // Not the user's to do (access.ts): nothing happens, as nothing offered it.
    if (what === "waits" && !node && !manages) return;
    if (node?.number != null) {
      const after = node.number;
      return request({ action: parent ? "plan" : "queue", number, after, ...mode });
    }
    if (what === "waits") return request({ action: "dequeue", number });
    request({ action: parent ? "plan" : "start", number, ...mode });
  };

  // Whether queued task `key` let go on `node`'s middle (or on a node that isn't queued) queues
  // after it: it leaves the queue to wait for that issue.
  const queuesAfter = (key: string, node: GraphNode | null | undefined) => {
    const task = everyLine.find((t) => t.key === key);
    return (
      !!task &&
      waitable(task) &&
      node?.number != null &&
      node.key !== key &&
      sameRepo(node.repo, repo)
    );
  };

  // Queued task `key` let go on node `target` (`side`: where on it, as at()): on a queued
  // node's edges, it moves in the run order; elsewhere on a node, it queues after it. In the
  // open, or while another move is on its way, it stays where it is.
  const droppedQueued = (key: string, target: string | null, side: number) => {
    setNotice(null);
    if (order.moving || !target) return;
    if (onEdge(everyLine, key, target, side)) {
      const move = moveOnto(everyLine, key, target, side);
      if (move) reorder(move);
      return;
    }
    const node = byKey.get(target);
    const number = everyLine.find((t) => t.key === key)?.number;
    if (number == null || !queuesAfter(key, node)) return;
    request({ action: "queue", number, after: node!.number! });
  };

  // What letting go does, said where it would happen.
  const labelOf = (h: Hover): DropLabel | null => {
    const node = h.target ? byKey.get(h.target) : null;
    if (h.what === "queued") {
      const box = node && shape.boxes.find((b) => b.key === node.key);
      if (!node || !box || !h.key || order.moving) return null;
      let text: string;
      if (onEdge(everyLine, h.key, node.key, h.side)) {
        const move = moveOnto(everyLine, h.key, node.key, h.side);
        if (!move) return null;
        const where = move.after ? "drag.moveAfter" : "drag.moveBefore";
        text = tr(where, { number: h.number!, node: nodeRef(node, false, 0) });
      } else if (queuesAfter(h.key, node)) {
        text = tr("drag.leaveLine", { number: h.number!, node: nodeRef(node, false, 0) });
      } else return null;
      return { text, x: box.x, y: box.y >= 30 ? box.y - 30 : box.y + shape.h + 6 };
    }
    if (node && node.number === h.number) return null;
    const ref = h.number ? `#${h.number}` : tr("drag.theIssue");
    const parent = h.what === "new" && h.number !== null && isParent(work.backlog, h.number);
    const box = node && shape.boxes.find((b) => b.key === node.key);
    // Its open questions answered first: the same action, said after "Answer #31, then".
    const answers = h.what !== "waits" && asked(h.number);
    let text: string;
    if (node) {
      const after = { ref, node: nodeRef(node, false, 0) };
      if (parent) text = tr(answers ? "drag.answerLayOutAfter" : "drag.layOutAfter", after);
      else text = tr(answers ? "drag.answerQueueAfter" : "drag.queueAfter", after);
    } else if (h.what === "waits") text = tr("drag.removeWait", { ref });
    else if (h.what === "brainstorm")
      text = tr(answers ? "drag.answerStartWork" : "drag.startWork", { ref });
    else if (parent) text = tr(answers ? "drag.answerLayOut" : "drag.layOut", { ref });
    else if (picked.mode)
      text = tr(answers ? "drag.answerStartIn" : "drag.startIn", { ref, mode: picked.mode });
    else text = tr(answers ? "drag.answerStart" : "drag.start", { ref });
    if (box) return { text, x: box.x, y: box.y >= 30 ? box.y - 30 : box.y + shape.h + 6 };
    // Over a card's ghost, or under it near the top: not on it.
    if (h.look) {
      const x = h.x - GHOST_GRIP.x;
      const y = h.y - GHOST_GRIP.y;
      return { text, x, y: y >= 30 ? y - 30 : y + shape.h + 6 };
    }
    return { text, x: h.x + 14, y: h.y + 14 };
  };

  // An action, unless its issue has open questions: they are answered first, in a form.
  const request = (action: WorkAction) => {
    const task = tasks.find((t) => t.key === `${repo}#${action.number}`);
    if (action.action !== "dequeue" && asked(action.number) && task) {
      return questions.ask(task, action);
    }
    work.act(action);
  };

  const zone = useDropZone(
    (e) =>
      !blocked &&
      typesOf(e).some(
        (t) =>
          ([ISSUE_TYPE, ...LINK_TYPES].includes(t) && starts(picked.mode)) ||
          (t === BRAINSTORM_TYPE && starts("work")) ||
          (t === QUEUED_TYPE && manages),
      ),
    (e) => {
      dragEnded();
      // A Queued card from the work queue: as a queued node's drag.
      const queued = e.dataTransfer?.getData(QUEUED_TYPE);
      if (queued) {
        const where = at(e.clientX, e.clientY);
        return droppedQueued(queued, where?.target ?? null, where?.side ?? 0.5);
      }
      const brainstorm = !!Number(e.dataTransfer?.getData(BRAINSTORM_TYPE));
      const number = droppedIssue(e.dataTransfer, [BRAINSTORM_TYPE, ISSUE_TYPE], github, repo);
      if (!number) {
        setNotice(tr("board.notALink", { repo }));
        return;
      }
      dropped(number, targetAt(e.clientX, e.clientY), brainstorm ? "brainstorm" : "new");
    },
    {
      onOver: (e) => {
        const where = e && at(e.clientX, e.clientY);
        if (!where) return setHover(null);
        const card = carriedCard();
        if (card?.type === QUEUED_TYPE) {
          return setHover({
            ...where,
            what: "queued",
            number: card.number,
            key: card.key,
            look: null,
          });
        }
        const what = card?.type === BRAINSTORM_TYPE ? "brainstorm" : "new";
        const look = card && { status: card.status, title: card.title };
        setHover({ ...where, what, number: card?.number ?? null, look });
      },
    },
  );

  const dragged = (d: { waits: boolean; queued: boolean }): Dragged =>
    d.queued ? "queued" : d.waits ? "waits" : "new";
  const drag = useNodeDrag({
    onMove: (point, d) => {
      const where = point && at(point.x, point.y);
      if (!where || !d) return setHover(null);
      setHover({ ...where, what: dragged(d), number: d.number, key: d.key, look: null });
    },
    onDrop: (d, point) => {
      if (!d.queued) return dropped(d.number, targetAt(point.x, point.y), dragged(d));
      const where = at(point.x, point.y);
      droppedQueued(d.key, where?.target ?? null, where?.side ?? 0.5);
    },
  });

  const fit = () => {
    const box = canvas.current?.getBoundingClientRect();
    if (!box?.width || !shape.width) return setZoom(1);
    const room = Math.min(
      (box.width - 48) / (shape.width + 2 * PAD),
      (box.height - 96) / (shape.height + 2 * PAD),
    );
    setZoom(clampZoom(Math.min(1, Math.floor(room * 20) / 20)));
  };

  // The card selected: the one focus is in.
  const cards = () => [...(root.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [])];
  const selected = () =>
    (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-card]") ?? null;
  // A node is its link; a work queue card is selected itself (its link is GitHub's), so Enter
  // reaches `open` rather than the link.
  const select = (card: HTMLElement) => {
    if (!card.matches("a[href]")) card.tabIndex = -1;
    card.focus();
    card.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  // One of the card's buttons, else of the work queue's card for that issue (a graph node).
  const press = (action: string) => {
    const card = selected();
    if (!card) return false;
    const enabled = `[data-action="${action}"]:not(:disabled)`;
    const number = card.dataset.number;
    const button =
      card.querySelector<HTMLElement>(enabled) ??
      (number
        ? root.current?.querySelector<HTMLElement>(
            `[data-card][data-number="${number}"] ${enabled}`,
          )
        : null);
    if (!button) return false;
    button.click();
  };
  useShortcuts({
    move: (i) => {
      const all = cards();
      const from = selected();
      const next = from && all.includes(from) ? nearestCard(all, from, i) : all[0];
      if (!next) return false;
      select(next);
    },
    // A node opens by itself (Enter on a link is the link's). A work queue card: its task here,
    // else its issue on GitHub.
    open: () => {
      const card = selected();
      if (!card) return false;
      const task = tasks.find((t) => String(t.number) === card.dataset.number);
      if (task) return void (location.hash = formatRoute({ repo, task: task.key, run: null }));
      const link = card.querySelector<HTMLElement>("a[href]");
      if (!link) return false;
      link.click();
    },
    start: () => press("start"),
    queue: () => press("queue"),
    brainstorm: () => press("brainstorm"),
    view: () => onView(view === "graph" ? "lanes" : "graph"),
    closed: () => onShowClosed(!showClosed),
    zoom: (i) => {
      if (view !== "graph") return false;
      if (i === 2) return fit();
      setZoom(clampZoom(zoom + (i === 0 ? ZOOM.step : -ZOOM.step)));
    },
  });
  // Space and a drag: the canvas scrolls with the pointer.
  const pan = (e: PointerEvent) => {
    const el = canvas.current;
    if (!spaced || !el || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    setPanning(true);
    const move = (m: PointerEvent) => {
      el.scrollLeft = start.left - (m.clientX - start.x);
      el.scrollTop = start.top - (m.clientY - start.y);
    };
    const up = () => {
      setPanning(false);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  const said = notice
    ? { text: notice, failed: true }
    : work.result?.error
      ? { text: work.result.error, failed: true }
      : work.result?.message
        ? { text: work.result.message, failed: false }
        : questions.said
          ? { text: questions.said, failed: false }
          : null;

  const asking = questions.asking;
  const startIn = (
    <Field
      as="select"
      class={styles.startIn}
      label={tr("board.startIn")}
      hideLabel={!narrow}
      size={narrow ? "touch" : "small"}
      value={chosen}
      disabled={blocked}
      onChange={(e) => setMode(e.currentTarget.value)}
    >
      {(modes.length ? modes : ["work"]).map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </Field>
  );
  const closed = (
    <Switch
      label={tr("board.showClosed")}
      title={withKey(tr("board.showClosedHelp"), "closed")}
      checked={showClosed}
      onChange={onShowClosed}
    />
  );
  const views = [
    {
      value: "graph" as const,
      label: tr("board.graph"),
      title: withKey(tr("board.graph"), "view"),
    },
    {
      value: "lanes" as const,
      label: tr("board.lanes"),
      title: withKey(tr("board.lanes"), "view"),
    },
  ];

  const target = hover?.target ?? null;
  const graph = (
    <div class={styles.stage}>
      <div
        ref={canvas}
        class={`${styles.canvas} ${zone.over || drag.moving ? styles.over : ""} ${spaced ? styles.grab : ""} ${panning ? styles.panning : ""}`}
        aria-label={tr("board.canvas")}
        onPointerDownCapture={pan}
        {...zone.handlers}
      >
        <GraphDrawing
          loading={!state}
          nodes={nodes}
          edges={edges}
          hidden={hidden}
          onShowClosed={onShowClosed}
          shape={shape}
          drawing={drawing}
          zoom={zoom}
          repo={repo}
          github={github}
          target={target}
          label={hover ? labelOf(hover) : null}
          ghost={
            hover?.look && hover.number
              ? { ...hover.look, number: hover.number, x: hover.x, y: hover.y }
              : null
          }
          movable={moves}
          drag={drag}
          onAsk={ask}
        />
      </div>
      {!!nodes.length && <GraphLegend />}
    </div>
  );
  const lanes = (
    <div class={styles.lanes}>
      {!state ? (
        <p class={styles.empty}>{tr("graph.loading")}</p>
      ) : !nodes.length && hidden ? (
        <p class={styles.empty}>
          {tx("graph.nothingOpen", {
            show: (
              <button type="button" class={styles.show} onClick={() => onShowClosed(true)}>
                {tr("graph.showClosedIssues")}
              </button>
            ),
          })}
        </p>
      ) : (
        <Lanes
          repo={repo}
          nodes={nodes}
          edges={edges}
          labels={state.lanes}
          github={github}
          narrow={narrow}
          onAsk={ask}
          refresh={refresh}
        />
      )}
    </div>
  );

  return (
    <div class={`${styles.board} ${narrow ? styles.phone : ""}`} ref={root}>
      {!narrow &&
        header?.(
          startsAny ? (
            <span class={styles.startInBox}>{tx("board.startInBox", { select: startIn })}</span>
          ) : null,
        )}
      {asking?.task.questions && (
        <QuestionsDialog
          asking={{ ...asking, task: { ...asking.task, questions: asking.task.questions } }}
          repo={repo}
          submit={(body, then) =>
            then && asking.action
              ? work.act(asking.action, body)
              : questions.answer(asking.task, body)
          }
          onSent={questions.sent}
          onClose={questions.close}
        />
      )}
      <div class={styles.body}>
        {!narrow && (
          <WorkQueue
            repo={repo}
            work={work}
            cards={brainstorms}
            waiting={waiting}
            answering={answering}
            line={line}
            everyLine={everyLine}
            onMove={reorder}
            moving={!!order.moving}
            nextKey={nextKey}
            targets={targets}
            github={github}
            picked={picked}
            brainstorms={modes.includes("brainstorm")}
            said={said}
            tab={tab}
            onTab={setTab}
            touch={false}
            onAct={request}
            onNotice={setNotice}
            now={now}
          />
        )}
        <main class={styles.main}>
          {narrow ? (
            <div class={styles.phoneBar}>
              <Segmented
                class={styles.phoneViews}
                label={tr("board.view")}
                options={[views[1], views[0]]}
                value={view}
                onChange={onView}
              />
              <IconButton
                variant="ghost"
                size="touch"
                label={tr("board.options")}
                aria-haspopup="dialog"
                aria-expanded={options}
                icon={<Icon.More size={20} />}
                onClick={() => setOptions(true)}
              />
            </div>
          ) : (
            <div class={styles.toolbar}>
              <Segmented label={tr("board.view")} options={views} value={view} onChange={onView} />
              {closed}
              {view === "graph" && (
                <span class={styles.zoom}>
                  <IconButton
                    variant="ghost"
                    size="small"
                    label={tr("board.zoomOut")}
                    title={withKey(tr("board.zoomOut"), "zoom", 1)}
                    icon={<Icon.Minus size={14} />}
                    disabled={zoom <= ZOOM.min}
                    onClick={() => setZoom(clampZoom(zoom - ZOOM.step))}
                  />
                  <Button
                    variant="ghost"
                    size="small"
                    class={styles.percent}
                    title={tr("board.zoomReset")}
                    aria-label={tr("board.zoomResetLabel", { percent: Math.round(zoom * 100) })}
                    onClick={() => setZoom(1)}
                  >
                    {tr("board.percent", { percent: Math.round(zoom * 100) })}
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="small"
                    label={tr("board.zoomIn")}
                    title={withKey(tr("board.zoomIn"), "zoom", 0)}
                    icon={<Icon.Plus size={14} />}
                    disabled={zoom >= ZOOM.max}
                    onClick={() => setZoom(clampZoom(zoom + ZOOM.step))}
                  />
                  <Button
                    variant="ghost"
                    size="small"
                    title={withKey(tr("board.fit"), "zoom", 2)}
                    onClick={fit}
                  >
                    {tr("board.fit")}
                  </Button>
                </span>
              )}
            </div>
          )}
          {view === "graph" ? graph : lanes}
        </main>
        {narrow && (
          <WorkQueue
            repo={repo}
            work={work}
            cards={brainstorms}
            waiting={waiting}
            answering={answering}
            line={line}
            everyLine={everyLine}
            onMove={reorder}
            moving={!!order.moving}
            nextKey={nextKey}
            targets={targets}
            github={github}
            picked={picked}
            brainstorms={modes.includes("brainstorm")}
            said={said}
            tab={tab}
            onTab={setTab}
            touch
            onAct={request}
            onNotice={setNotice}
            now={now}
          />
        )}
      </div>
      {options && (
        <Sheet title={tr("board.options")} onClose={() => setOptions(false)}>
          {startsAny && startIn}
          {closed}
        </Sheet>
      )}
    </div>
  );
}
