// A workflow file's steps as a graph (#1042): the editor's live drawing of what it parses to
// (listener/workflow-editor.mjs stepView()), top to bottom. A condition splits into its two
// branches, side by side (stacked on a phone), a `repeat` is a box whose arrow goes back to its
// top. A dry run's path marks the steps it took, with their outcomes, the step where it left
// what the pull request did, and the one waiting for a pick. Nested lists, so a screen reader
// reads the same order; each step is a button that moves the editor to its line.
import type { ComponentChildren } from "preact";
import { t } from "./i18n";
import type { Plain } from "./locales";
import type { StepRun, TrailStep, WorkflowStep } from "./types";
import styles from "./WorkflowSteps.module.css";

const RUNS: Record<StepRun, Plain> = {
  ci: "workflow.node.ci",
  review: "workflow.node.review",
  fix: "workflow.node.fix",
  merge: "workflow.node.merge",
  rebase: "workflow.node.rebase",
};

// A step's name: its run's, or a comment's.
export function stepName(step: { run?: string; say?: string; comment?: string }): string {
  if (step.run) return step.run in RUNS ? t(RUNS[step.run as StepRun]) : step.run;
  if (step.say === "rounds-out" || step.comment === "rounds-out") return t("editor.roundsOut");
  return t("editor.comment");
}

// What a dry run says of each line: the outcomes of the steps it took there (a loop's step more
// than once), and whether it diverged there or waits there for a pick.
export interface StepMarks {
  taken: Map<number, TrailStep[]>;
  diverged: number | null;
  asked: number | null;
}

export function marksOf(trail: TrailStep[], diverged: number | null, asked: number | null) {
  const taken = new Map<number, TrailStep[]>();
  for (const step of trail) taken.set(step.line, [...(taken.get(step.line) ?? []), step]);
  return { taken, diverged, asked };
}

interface Props {
  steps: WorkflowStep[];
  on: string[];
  marks?: StepMarks | null;
  // A step clicked: its line.
  onLine?: (line: number) => void;
  // Drawn from an older text: the current one doesn't parse.
  stale?: boolean;
}

export function WorkflowSteps({ steps, on, marks = null, onLine, stale = false }: Props) {
  return (
    <div class={`${styles.graph} ${stale ? styles.stale : ""}`}>
      <ol class={styles.flow} aria-label={t("editor.graph")}>
        <li class={styles.item}>
          <span class={styles.event}>{t("editor.on", { events: on.join(", ") || "?" })}</span>
        </li>
        <Steps steps={steps} marks={marks} onLine={onLine} />
        <li class={styles.item}>
          <span class={styles.end}>{t("editor.end")}</span>
        </li>
      </ol>
    </div>
  );
}

type Inner = Pick<Props, "marks" | "onLine">;

function Steps({ steps, ...rest }: { steps: WorkflowStep[] } & Inner) {
  return (
    <>
      {steps.map((s) => (
        <li key={s.line} class={styles.item}>
          <Step step={s} {...rest} />
        </li>
      ))}
    </>
  );
}

function Step({ step, ...rest }: { step: WorkflowStep } & Inner) {
  if (step.kind === "repeat") {
    return (
      <div class={styles.loop}>
        <span class={styles.loopHead}>
          {step.max
            ? t("editor.repeat", { rounds: step.max.rounds, counter: step.max.var })
            : t("editor.repeatOpen")}
        </span>
        <ol class={styles.flow}>
          <Steps steps={step.repeat ?? []} {...rest} />
        </ol>
        <span class={styles.loopBack} aria-hidden="true">
          ↺ {t("editor.again")}
        </span>
      </div>
    );
  }
  const node = step.kind === "if" ? null : <Node step={step} {...rest} />;
  if (!step.if) return node;
  return (
    <div class={styles.decision}>
      <span class={styles.condition}>
        {t("editor.if")} <code>{step.if}</code>
      </span>
      <div class={styles.branches}>
        <Branch label={t("editor.yes")}>
          {node ? <li class={styles.item}>{node}</li> : <Steps steps={step.then ?? []} {...rest} />}
        </Branch>
        <Branch label={t("editor.no")}>
          {step.else?.length ? (
            <Steps steps={step.else} {...rest} />
          ) : (
            <li class={styles.item}>
              <span class={styles.skip}>{t("editor.skip")}</span>
            </li>
          )}
        </Branch>
      </div>
    </div>
  );
}

function Branch({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class={styles.branch}>
      <span class={styles.branchLabel}>{label}</span>
      <ol class={styles.flow}>{children}</ol>
    </div>
  );
}

function Node({ step, marks, onLine }: { step: WorkflowStep } & Inner) {
  const taken = marks?.taken.get(step.line) ?? [];
  const diverged = marks?.diverged === step.line;
  const asked = marks?.asked === step.line;
  const details = [
    step.agent && t("editor.agent", { agent: step.agent }),
    step.model,
    step.effort,
    step.instructions,
    step.count && t("editor.count", { counter: step.count }),
    step.set && t("editor.set", { flag: step.set }),
  ].filter(Boolean);
  const classes = [
    styles.node,
    step.run ? "" : styles.comment,
    taken.length ? styles.taken : "",
    diverged ? styles.diverged : "",
    asked ? styles.asked : "",
  ];
  return (
    <button
      type="button"
      class={classes.filter(Boolean).join(" ")}
      onClick={() => onLine?.(step.line)}
      title={t("editor.toLine", { line: step.line })}
    >
      <span class={styles.name}>
        {stepName(step)}
        <span class={styles.line}>{t("editor.line", { line: step.line })}</span>
      </span>
      {step.comment && step.comment !== "rounds-out" && (
        <span class={styles.detail}>“{step.comment}”</span>
      )}
      {details.length > 0 && <span class={styles.detail}>{details.join(" · ")}</span>}
      {diverged && <span class={styles.flag}>{t("editor.divergesHere")}</span>}
      {asked && <span class={styles.flag}>{t("editor.pickHere")}</span>}
      {taken.length > 0 && (
        <span class={styles.outcomes}>
          {taken.map((s, i) => (
            <span key={i} class={`${styles.outcome} ${styles[s.source]}`}>
              {outcomeName(s.run, s.outcome)}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

// An outcome's words: a step's (dry run's OUTCOMES) or a comment's.
const OUTCOMES: Record<string, Plain> = {
  "ci:passed": "editor.outcome.ci.passed",
  "ci:failed": "editor.outcome.ci.failed",
  "review:none": "editor.outcome.review.none",
  "review:low": "editor.outcome.review.low",
  "review:medium": "editor.outcome.review.medium",
  "review:high": "editor.outcome.review.high",
  "review:critical": "editor.outcome.review.critical",
  "review:refused": "editor.outcome.refused",
  "fix:pushed": "editor.outcome.fix.pushed",
  "fix:nothing-pushed": "editor.outcome.fix.nothing-pushed",
  "fix:none": "editor.outcome.fix.none",
  "merge:merged": "editor.outcome.merge.merged",
  "merge:refused": "editor.outcome.merge.refused",
  "rebase:rebased": "editor.outcome.rebase.rebased",
  "rebase:refused": "editor.outcome.refused",
  "comment:posted": "editor.outcome.comment.posted",
  "comment:nothing": "editor.outcome.comment.nothing",
};

export function outcomeName(run: string | undefined, outcome: string | null): string {
  if (outcome === null) return t("editor.outcome.unknown");
  const key = OUTCOMES[`${run ?? "comment"}:${outcome}`];
  return key ? t(key) : outcome;
}
