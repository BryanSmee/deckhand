// A repository's board (docs/design/dashboard-redesign.md › Pages › Board): the work queue
// (WorkQueue.tsx) beside what waits for what, as a graph (GraphDrawing.tsx) or as lanes
// (Lanes.tsx); on a phone, the lanes with the queue as a bottom sheet. An issue dropped on the
// graph starts, dropped on a node it waits for that one; a waiting node dragged away stops
// waiting, onto another node waits for that one instead. An issue waiting for answers moves
// too, once they are in: the drag opens its open questions first (QuestionsDialog.tsx), and so
// does a click on its node. A brainstorm dropped on the graph starts work. While a drag goes
// on, the graph says what letting go does ("Queue #31 after #19"); each action shows at once,
// its node dashed ("Starting…"), before api/state is read again.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useWorkArea } from "./api";
import {
  BRAINSTORM_TYPE,
  carriedCard,
  dragEnded,
  droppedIssue,
  ISSUE_TYPE,
  LINK_TYPES,
} from "./dnd";
import { sameRepo } from "./format";
import { type DropLabel, GraphDrawing, nodeRef, PAD, targetsOf } from "./GraphDrawing";
import { useAnswering, useKeptLayout, useNodeDrag } from "./graphHooks";
import { dropTarget } from "./graphLayout";
import { GraphLegend } from "./GraphLegend";
import { brainstormsOf, graphOf, type GraphNode, isParent, movable, workLists } from "./graphModel";
import { typesOf, useDropZone } from "./hooks";
import { Lanes } from "./Lanes";
import { QuestionsDialog } from "./QuestionsDialog";
import type { State, WorkAction } from "./types";
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

// What is dragged onto the graph: a card from the backlog (or one waiting for answers), a
// brainstorm (Start in doesn't apply: it starts work), a waiting node (let go in the open, it
// stops waiting).
type Dragged = "new" | "brainstorm" | "waits";

// A drag over the graph: the node it would queue after, what is dragged, where (drawing units).
interface Hover {
  target: string | null;
  what: Dragged;
  // Null: a link from elsewhere, read only once dropped.
  number: number | null;
  x: number;
  y: number;
}

const ZOOM = { min: 0.4, max: 1.6, step: 0.1 };
const clampZoom = (z: number) => Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, z)) * 100) / 100;

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
  const drawing = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);

  const tasks = (state?.tasks ?? []).filter((t) => sameRepo(t.repo, repo));
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
  const modes = work.backlog?.modes ?? [];
  const picked = mode === "work" || !modes.includes(mode) ? {} : { mode };
  const blocked = !!work.backlog?.errors;
  const moves = (n: GraphNode) => movable(n, repo, blocked);
  const targets = targetsOf(nodes);
  const { waiting, answering } = workLists(tasks, work.pending);

  // Where (clientX, clientY) is in the drawing's units, and the node a drop there queues after.
  const at = (clientX: number, clientY: number) => {
    const box = drawing.current?.getBoundingClientRect();
    if (!box) return null;
    const x = (clientX - box.left) / zoom - PAD;
    const y = (clientY - box.top) / zoom - PAD;
    return { x, y, target: dropTarget(shape, x, y) };
  };
  const targetAt = (clientX: number, clientY: number) => at(clientX, clientY)?.target ?? null;

  // An issue whose open questions a start or a queue asks first (unless its repo doesn't wait).
  const asked = (number: number | null) => {
    const task = tasks.find((t) => t.key === `${repo}#${number}`);
    return task?.state === "needs-input" && !!task.questions && task.waitForAnswers !== false;
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
    if (node?.number != null) {
      const after = node.number;
      return request({ action: parent ? "plan" : "queue", number, after, ...mode });
    }
    if (what === "waits") return request({ action: "dequeue", number });
    request({ action: parent ? "plan" : "start", number, ...mode });
  };

  // What letting go does, said where it would happen.
  const labelOf = (h: Hover): DropLabel | null => {
    const node = h.target ? byKey.get(h.target) : null;
    if (node && node.number === h.number) return null;
    const ref = h.number ? `#${h.number}` : "the issue";
    const parent = h.what === "new" && h.number !== null && isParent(work.backlog, h.number);
    const box = node && shape.boxes.find((b) => b.key === node.key);
    let text: string;
    if (node) text = `${parent ? "Lay out" : "Queue"} ${ref} after ${nodeRef(node, false, 0)}`;
    else if (h.what === "waits") text = `Remove ${ref}'s wait`;
    else if (h.what === "brainstorm") text = `Start work on ${ref}`;
    else if (parent) text = `Lay out ${ref} and its sub-issues`;
    else text = `Start ${ref}${picked.mode ? ` in ${picked.mode}` : ""}`;
    if (h.what !== "waits" && asked(h.number)) {
      text = `Answer ${ref}, then ${text[0].toLowerCase()}${text.slice(1).replace(` ${ref}`, "")}`;
    }
    if (box) return { text, x: box.x, y: box.y >= 30 ? box.y - 30 : box.y + shape.h + 6 };
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
      !blocked && typesOf(e).some((t) => [ISSUE_TYPE, BRAINSTORM_TYPE, ...LINK_TYPES].includes(t)),
    (e) => {
      dragEnded();
      const brainstorm = !!Number(e.dataTransfer?.getData(BRAINSTORM_TYPE));
      const number = droppedIssue(e.dataTransfer, [BRAINSTORM_TYPE, ISSUE_TYPE], github, repo);
      if (!number) {
        setNotice(
          `That isn't a link to one of ${repo}'s issues: drag an issue's card from the work queue, or its link.`,
        );
        return;
      }
      dropped(number, targetAt(e.clientX, e.clientY), brainstorm ? "brainstorm" : "new");
    },
    {
      onOver: (e) => {
        const where = e && at(e.clientX, e.clientY);
        if (!where) return setHover(null);
        const card = carriedCard();
        const what = card?.type === BRAINSTORM_TYPE ? "brainstorm" : "new";
        setHover({ ...where, what, number: card?.number ?? null });
      },
    },
  );

  const drag = useNodeDrag({
    onMove: (point, d) => {
      const where = point && at(point.x, point.y);
      if (!where || !d) return setHover(null);
      setHover({ ...where, what: d.waits ? "waits" : "new", number: d.number });
    },
    onDrop: (d, point) => dropped(d.number, targetAt(point.x, point.y), d.waits ? "waits" : "new"),
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
      label="Start in"
      hideLabel={!narrow}
      size={narrow ? "touch" : "small"}
      value={modes.includes(mode) ? mode : "work"}
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
      label="Show closed"
      title="Issues closed as completed or not planned, and merged pull requests"
      checked={showClosed}
      onChange={onShowClosed}
    />
  );
  const views = [
    { value: "graph" as const, label: "Graph" },
    { value: "lanes" as const, label: "Lanes" },
  ];

  const target = hover?.target ?? null;
  const graph = (
    <div class={styles.stage}>
      <div
        ref={canvas}
        class={`${styles.canvas} ${zone.over || drag.moving ? styles.over : ""}`}
        aria-label="What waits for what"
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
          movable={moves}
          drag={drag}
          onAsk={(task) => questions.ask(task, null)}
        />
      </div>
      {!!nodes.length && <GraphLegend />}
    </div>
  );
  const lanes = (
    <div class={styles.lanes}>
      {!state ? (
        <p class={styles.empty}>Loading…</p>
      ) : !nodes.length && hidden ? (
        <p class={styles.empty}>
          Nothing open here.{" "}
          <button type="button" class={styles.show} onClick={() => onShowClosed(true)}>
            Show closed issues
          </button>
        </p>
      ) : (
        <Lanes
          repo={repo}
          nodes={nodes}
          edges={edges}
          labels={state.lanes}
          github={github}
          narrow={narrow}
          onAsk={(task) => questions.ask(task, null)}
          refresh={refresh}
        />
      )}
    </div>
  );

  return (
    <div class={`${styles.board} ${narrow ? styles.phone : ""}`}>
      {!narrow && header?.(<span class={styles.startInBox}>Start in {startIn}</span>)}
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
                label="Board view"
                options={[views[1], views[0]]}
                value={view}
                onChange={onView}
              />
              <IconButton
                variant="ghost"
                size="touch"
                label="Board options"
                aria-haspopup="dialog"
                aria-expanded={options}
                icon={<Icon.More size={20} />}
                onClick={() => setOptions(true)}
              />
            </div>
          ) : (
            <div class={styles.toolbar}>
              <Segmented label="Board view" options={views} value={view} onChange={onView} />
              {closed}
              {view === "graph" && (
                <span class={styles.zoom}>
                  <IconButton
                    variant="ghost"
                    size="small"
                    label="Zoom out"
                    icon={<Icon.Minus size={14} />}
                    disabled={zoom <= ZOOM.min}
                    onClick={() => setZoom(clampZoom(zoom - ZOOM.step))}
                  />
                  <Button
                    variant="ghost"
                    size="small"
                    class={styles.percent}
                    title="Back to 100%"
                    aria-label={`Zoom ${Math.round(zoom * 100)}%: back to 100%`}
                    onClick={() => setZoom(1)}
                  >
                    {Math.round(zoom * 100)}%
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="small"
                    label="Zoom in"
                    icon={<Icon.Plus size={14} />}
                    disabled={zoom >= ZOOM.max}
                    onClick={() => setZoom(clampZoom(zoom + ZOOM.step))}
                  />
                  <Button variant="ghost" size="small" onClick={fit}>
                    Fit
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
        <Sheet title="Board options" onClose={() => setOptions(false)}>
          {startIn}
          {closed}
        </Sheet>
      )}
    </div>
  );
}
