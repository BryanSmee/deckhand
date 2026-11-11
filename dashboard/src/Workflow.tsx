// The pull request lifecycle as a graph (listener/review-graph.mjs, #899): a repository's
// Workflow tab (WorkflowTab, ConfigPanel.tsx), and a task's (TaskWorkflow, ReviewLoop.tsx), its
// pull request's step highlighted and the policies' real decisions on it over the sample's.
// Each step in its state: on; off (grey, dashed: the settings turn it off); refused (solid
// orange: a missing grant, or the policies refused it); may be refused (an orange outline: a
// rule may refuse another pull request). The words go with the colour, and the reasons are
// listed under the graph, for screen readers and phones, which have no hover; the arrows, for
// screen readers, in a list of their own.
import { useEffect, useRef, useState } from "preact/hooks";
import { usePolled } from "./api";
import { t } from "./i18n";
import type { Plain } from "./locales";
import type {
  RepoConfig,
  Task,
  Workflow,
  WorkflowCondition,
  WorkflowNode,
  WorkflowNodeId,
  WorkflowReason,
  WorkflowState,
} from "./types";
import { Fold } from "./ui/Fold";
import { layoutWorkflow, NODE_H, NODE_W, nodeOf, withDecisions } from "./workflowLayout";
import styles from "./Workflow.module.css";

// Keys, read at render: the language may change meanwhile. An id this dashboard doesn't know
// yet (a newer listener's) shows as it is.
const NODES: Record<WorkflowNodeId, Plain> = {
  ready: "workflow.node.ready",
  ci: "workflow.node.ci",
  "ci-fix": "workflow.node.ci-fix",
  review: "workflow.node.review",
  fix: "workflow.node.fix",
  merge: "workflow.node.merge",
  rebase: "workflow.node.rebase",
  done: "workflow.node.done",
};
const STATES: Record<WorkflowState, Plain> = {
  on: "workflow.state.on",
  off: "workflow.state.off",
  refused: "workflow.state.refused",
  depends: "workflow.state.depends",
};
const CONDITIONS: Record<WorkflowCondition, Plain> = {
  ready: "workflow.when.ready",
  passed: "workflow.when.passed",
  "ci-over": "workflow.when.ci-over",
  failed: "workflow.when.failed",
  "no-ci-fix": "workflow.when.no-ci-fix",
  "ci-stopped": "workflow.when.ci-stopped",
  pushed: "workflow.when.pushed",
  "nothing-pushed": "workflow.when.nothing-pushed",
  blocking: "workflow.when.blocking",
  clean: "workflow.when.clean",
  "rounds-out": "workflow.when.rounds-out",
  "no-fix": "workflow.when.no-fix",
  fixed: "workflow.when.fixed",
  merged: "workflow.when.merged",
  conflict: "workflow.when.conflict",
  rebased: "workflow.when.rebased",
};
const named = <T extends string>(keys: Record<T, Plain>, id: string) => {
  const key = (keys as Record<string, Plain>)[id];
  return key ? t(key) : id;
};
const nodeName = (id: string) => named(NODES, id);
const stateName = (state: string) => named(STATES, state);

// A step's own numbers, or the setting that turns it on when it is off.
function detailOf(n: WorkflowNode): string {
  if (n.state === "off") return t("workflow.offKey", { key: n.key });
  const s = n.settings;
  switch (n.id) {
    case "ci":
      return s.minutes != null ? t("workflow.minutes", { minutes: s.minutes }) : "";
    case "ci-fix":
    case "fix":
      return s.rounds != null ? t("workflow.rounds", { count: s.rounds }) : "";
    case "review":
      return s.severity ? t("workflow.severity", { severity: s.severity }) : "";
    case "merge":
      return [s.method, s.minutes != null && t("workflow.minutes", { minutes: s.minutes })]
        .filter(Boolean)
        .join(" · ");
    case "rebase":
      return s.minutes != null ? t("workflow.every", { minutes: s.minutes }) : "";
    default:
      return "";
  }
}

// One reason, as the notes list it.
function reasonText(r: WorkflowReason): string {
  const repo = r.layer === "repo";
  if (r.rule && r.file) {
    const layer = r.layer ? t(repo ? "workflow.layer.repo" : "workflow.layer.operator") : "";
    return t("workflow.rule", { rule: r.rule, file: r.file, layer });
  }
  const message = r.message ?? "";
  if (!r.layer) return message;
  return t(repo ? "workflow.byLayer.repo" : "workflow.byLayer.operator", { message });
}

interface GraphProps {
  workflow: Workflow;
  // The step a task's pull request is at.
  current?: WorkflowNodeId | null;
  // The steps a real decision on it set (withDecisions()), the others the sample's.
  real?: Set<WorkflowNodeId>;
}

export function WorkflowGraph({ workflow, current = null, real }: GraphProps) {
  const layout = layoutWorkflow(workflow);
  const scroll = useRef<HTMLDivElement>(null);
  // On a phone, the graph scrolls sideways: to the pull request's step, when it is out of sight.
  const at = layout.nodes.find((n) => n.id === current)?.x ?? null;
  useEffect(() => {
    const box = scroll.current;
    if (!box || at === null || at + NODE_W <= box.clientWidth) return;
    box.scrollLeft = at - 24;
  }, [at]);
  const noted = workflow.nodes.filter((n) => n.state === "refused" || n.state === "depends");
  return (
    <figure class={styles.figure}>
      <div class={styles.scroll} ref={scroll}>
        <div
          class={styles.plane}
          style={{ width: `${layout.width}px`, height: `${layout.height}px` }}
        >
          <svg class={styles.arrows} width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <marker
                id="workflow-head"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 z" class={styles.head} />
              </marker>
            </defs>
            {layout.edges.map((e) => (
              <g key={`${e.from}-${e.to}`}>
                <path
                  d={e.d}
                  class={`${styles.arrow} ${e.back ? styles.back : ""}`}
                  marker-end="url(#workflow-head)"
                />
                {/* One line a condition, the last on the label's line, the others above;
                    all on one line where the label says it has the room. */}
                <text
                  class={styles.when}
                  x={e.label.x}
                  y={e.label.y - (e.label.inline ? 0 : (e.when.length - 1) * 13)}
                  text-anchor={e.label.anchor}
                >
                  {e.label.inline
                    ? e.when.map((w) => named(CONDITIONS, w)).join(" / ")
                    : e.when.map((w, i) => (
                        <tspan key={w} x={e.label.x} dy={i ? 13 : 0}>
                          {named(CONDITIONS, w)}
                        </tspan>
                      ))}
                </text>
              </g>
            ))}
          </svg>
          <ol class={styles.nodes} aria-label={t("workflow.graph")}>
            {layout.nodes.map((n) => {
              const here = n.id === current;
              const detail = detailOf(n);
              return (
                <li
                  key={n.id}
                  class={[styles.node, styles[n.state], here ? styles.current : ""]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    left: `${n.x}px`,
                    top: `${n.y}px`,
                    width: `${NODE_W}px`,
                    height: `${NODE_H}px`,
                  }}
                  title={n.reasons.map(reasonText).join("\n") || undefined}
                  aria-current={here ? "step" : undefined}
                >
                  <span class={styles.name}>{nodeName(n.id)}</span>
                  {detail && <span class={styles.detail}>{detail}</span>}
                  {(n.state === "refused" || n.state === "depends" || here) && (
                    <span class={styles.state}>
                      {here ? t("workflow.current") : stateName(n.state)}
                    </span>
                  )}
                  {n.state === "on" && !here && (
                    <span class={styles.hidden}>{stateName(n.state)}</span>
                  )}
                </li>
              );
            })}
          </ol>
          {/* The arrows are drawn for the eye: their words, for screen readers. */}
          <ul class={styles.hidden} aria-label={t("workflow.edges")}>
            {layout.edges.map((e) => (
              <li key={`${e.from}-${e.to}`}>
                {t("workflow.edge", {
                  from: nodeName(e.from),
                  to: nodeName(e.to),
                  when: e.when.map((w) => named(CONDITIONS, w)).join(" / "),
                })}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <figcaption class={styles.legend} aria-label={t("workflow.legend")}>
        {(["on", "off", "refused", "depends"] as const).map((s) => (
          <span key={s} class={styles.key}>
            <span class={`${styles.swatch} ${styles[s]}`} aria-hidden="true" />
            {stateName(s)}
          </span>
        ))}
        {current && (
          <span class={styles.key}>
            <span class={`${styles.swatch} ${styles.current}`} aria-hidden="true" />
            {t("workflow.current")}
          </span>
        )}
      </figcaption>
      {noted.length > 0 && (
        <section class={styles.notes} aria-label={t("workflow.notes")}>
          <ul>
            {noted.map((n) => (
              <li key={n.id}>
                <span class={`${styles.swatch} ${styles[n.state]}`} aria-hidden="true" />
                <span>
                  <strong>{nodeName(n.id)}</strong> · {stateName(n.state)}
                  {real && workflow.sample && n.reasons.some((r) => r.layer || r.rule) && (
                    <span class={styles.source}>
                      {" "}
                      ({t(real.has(n.id) ? "workflow.real" : "workflow.fromSample")})
                    </span>
                  )}
                  {n.reasons.length > 0 && (
                    <ul class={styles.reasons}>
                      {n.reasons.map((r, i) => (
                        <li key={i}>{reasonText(r)}</li>
                      ))}
                    </ul>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </figure>
  );
}

// A repository's Workflow tab: its lifecycle, on a sample pull request.
export function WorkflowTab({ config }: { config: RepoConfig }) {
  const { workflow } = config;
  if (!workflow) return null;
  return (
    <div class={styles.tab}>
      <p class={styles.intro}>{t("workflow.intro")}</p>
      <p class={styles.muted}>{t(workflow.sample ? "workflow.sample" : "workflow.noPolicies")}</p>
      <WorkflowGraph workflow={workflow} />
    </div>
  );
}

// A task's lifecycle, folded: read from GitHub (its repo's config) once opened, its pull
// request's step highlighted, its real decisions over the sample's.
export function TaskWorkflow({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const read = usePolled<RepoConfig>(open ? `api/repos/${task.repo}/config` : null, null);
  const current = task.review ? nodeOf(task.review.loop) : null;
  const shown =
    read.data?.workflow &&
    withDecisions(read.data.workflow, task.decisions, task.pr?.number ?? null);
  return (
    <Fold
      title={t("workflow.show")}
      meta={current ? nodeName(current) : undefined}
      open={open}
      onToggle={setOpen}
      class={styles.fold}
    >
      {shown ? (
        <WorkflowGraph workflow={shown.workflow} current={current} real={shown.real} />
      ) : read.error ? (
        <p class={styles.muted} role="alert">
          {t("workflow.unreadable", { error: read.error })}
        </p>
      ) : (
        <p class={styles.muted}>{t("workflow.read")}</p>
      )}
    </Fold>
  );
}
