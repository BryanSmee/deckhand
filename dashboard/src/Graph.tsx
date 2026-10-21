// The graph page: one node per issue, an arrow from each issue to what waits for it
// ("/after"), coloured by where it stands (graphModel.ts). A node opens its task. On a repo's
// tab it is a work area too (WorkArea.tsx): an issue dropped on it starts, dropped next to a
// node it waits for that one; a waiting node dragged away stops waiting, onto another node waits
// for that one instead. An issue waiting for answers moves too, once they are in: the drag
// opens its open questions first (QuestionsDialog.tsx). A click on a node waiting for answers
// opens them too, on any tab: they go, and its run continues. Brainstorms have a column of their
// own between the backlog and the graph (Brainstorms.tsx): one dropped on the graph starts work.
import { useEffect, useRef, useState } from "preact/hooks";
import { useWorkArea } from "./api";
import { Brainstorms } from "./Brainstorms";
import { BRAINSTORM_TYPE, droppedIssue, ISSUE_TYPE, LINK_TYPES } from "./dnd";
import { GraphDrawing, targetsOf } from "./GraphDrawing";
import { useAnswering, useKeptLayout, useNodeDrag } from "./graphHooks";
import { dropTarget } from "./graphLayout";
import { GraphLegend } from "./GraphLegend";
import { brainstormsOf, graphOf, type GraphNode, isParent, movable, workLists } from "./graphModel";
import { typesOf, useDropZone } from "./hooks";
import { QuestionsDialog } from "./QuestionsDialog";
import type { State, WorkAction } from "./types";
import { WorkArea } from "./WorkArea";
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

// What is dragged onto the graph: a card from the backlog (or a node waiting for answers), a
// brainstorm (Start in doesn't apply: it starts work), a waiting node (let go in the open, it
// stops waiting).
type Dragged = "new" | "brainstorm" | "waits";

export function Graph({ state, refresh, repo, narrow, showClosed, onShowClosed }: Props) {
  const work = useWorkArea(repo, refresh);
  const questions = useAnswering(repo, refresh);
  const [mode, setMode] = useState("work");
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setMode("work");
    setNotice(null);
  }, [repo]);
  // The node a drop there would queue after.
  const [target, setTarget] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tasks = (state?.tasks ?? []).filter((t) => !repo || t.repo === repo);
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
  const targets = repo ? targetsOf(nodes) : [];
  const { waiting, answering } = workLists(tasks, work.pending);

  // The node under the pointer, in the drawing's units (the viewBox starts at -4).
  const targetAt = (clientX: number, clientY: number) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return null;
    return dropTarget(shape, clientX - box.left - 4, clientY - box.top - 4);
  };

  // Issue `number` let go on the area, after `onto` (a node) or in the open. A waiting node
  // keeps its mode, and the open cancels its wait rather than starts it; a brainstorm starts
  // work. A backlog issue with open sub-issues is laid out with them ("plan").
  const dropped = (number: number, onto: string | null, what: Dragged) => {
    setNotice(null);
    const node = onto ? byKey.get(onto) : null;
    if (node?.number === number && node.repo === repo) return;
    const mode = what === "new" ? picked : {};
    const parent = what === "new" && isParent(work.backlog, number);
    if (node?.number != null) {
      const after = node.number;
      return request({ action: parent ? "plan" : "queue", number, after, ...mode });
    }
    if (what === "waits") return request({ action: "dequeue", number });
    request({ action: parent ? "plan" : "start", number, ...mode });
  };

  // An action, unless its issue has open questions: they are answered first, in a form (unless
  // its repo doesn't wait for answers).
  const request = (action: WorkAction) => {
    const task = tasks.find((t) => t.key === `${repo}#${action.number}`);
    const asked = task?.state === "needs-input" && task.questions && task.waitForAnswers !== false;
    if (action.action !== "dequeue" && asked) return questions.ask(task, action);
    work.act(action);
  };

  const zone = useDropZone(
    (e) =>
      !blocked && typesOf(e).some((t) => [ISSUE_TYPE, BRAINSTORM_TYPE, ...LINK_TYPES].includes(t)),
    (e) => {
      const brainstorm = !!Number(e.dataTransfer?.getData(BRAINSTORM_TYPE));
      const number = droppedIssue(e.dataTransfer, [BRAINSTORM_TYPE, ISSUE_TYPE], github, repo);
      if (!number) {
        setNotice(
          `That isn't a link to one of ${repo}'s issues: drag an issue's card from the work area, or its link.`,
        );
        return;
      }
      dropped(number, targetAt(e.clientX, e.clientY), brainstorm ? "brainstorm" : "new");
    },
    { onOver: (e) => setTarget(e && targetAt(e.clientX, e.clientY)) },
  );

  const drag = useNodeDrag({
    onMove: (at) => setTarget(at && targetAt(at.x, at.y)),
    onDrop: (d, at) => dropped(d.number, targetAt(at.x, at.y), d.waits ? "waits" : "new"),
  });

  const drawing = (
    <GraphDrawing
      loading={!state}
      nodes={nodes}
      edges={edges}
      hidden={hidden}
      onShowClosed={onShowClosed}
      shape={shape}
      svg={svg}
      repo={repo}
      github={github}
      target={target}
      movable={moves}
      drag={drag}
      onAsk={(task) => questions.ask(task, null)}
    />
  );

  const asking = questions.asking;
  return (
    <div class={styles.page}>
      <GraphLegend showClosed={showClosed} onShowClosed={onShowClosed} />
      {questions.said && (
        <p class={styles.said} role="status">
          {questions.said}
        </p>
      )}
      {asking?.task.questions && (
        <QuestionsDialog
          asking={{ ...asking, task: { ...asking.task, questions: asking.task.questions } }}
          repo={repo}
          submit={(body) =>
            asking.action ? work.act(asking.action, body) : questions.answer(asking.task, body)
          }
          onSent={questions.sent}
          onClose={questions.close}
        />
      )}
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
          />
          <Brainstorms
            repo={repo}
            cards={brainstorms}
            targets={targets}
            busy={work.busy}
            blocked={blocked}
            github={github}
            onAct={request}
            onNotice={setNotice}
            now={now}
          />
          <div
            class={`${styles.area} ${zone.over || drag.moving ? styles.over : ""}`}
            {...zone.handlers}
          >
            {drawing}
          </div>
        </div>
      ) : (
        <>
          <p class={styles.hint}>Open a repository's tab to start or queue its issues here.</p>
          <div class={`${styles.work} ${styles.overview}`}>
            <Brainstorms repo={null} cards={brainstorms} github={github} now={now} />
            <div>{drawing}</div>
          </div>
        </>
      )}
    </div>
  );
}
