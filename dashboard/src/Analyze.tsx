// New request's Analyze runs (NewRequest.tsx): a run that reads a digest of a repo's recent
// runs and replies with what would make them faster or more reliable (listener/analysis.mjs).
// The form picks how many runs, their kinds and outcomes; the listener says how many match and
// about how many tokens the digest is, as the selection changes. Once started: the analysis's
// issue, then its task.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { previewAnalysis, startAnalysis } from "./api";
import { repoTabs, runKindName, uniqueRepos } from "./format";
import { useSubmit } from "./hooks";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import type { Action } from "./NewRequest";
import { formatRoute } from "./route";
import type { AnalysisPreview, AnalysisResult, AnalysisSelection, Outcome, Task } from "./types";
import { Field } from "./ui/Field";
import { FilterChip } from "./ui/FilterChip";
import styles from "./NewRequest.module.css";

export const DEFAULT_RUNS = 10;
// The preview waits for the selection to settle: typing a count asks once.
const PREVIEW_MS = 250;

const OUTCOMES: { id: Outcome; label: Plain }[] = [
  { id: "ok", label: "request.outcomeOk" },
  { id: "error", label: "request.outcomeError" },
  { id: "needs-input", label: "request.outcomeNeedsInput" },
  { id: "interrupted", label: "request.outcomeInterrupted" },
  { id: "cancelled", label: "request.outcomeCancelled" },
];

// The repos the form offers: those api/state shows the user, by name.
export const analysisRepos = (inboxes: Record<string, unknown> | undefined, tasks: Task[]) =>
  uniqueRepos([...repoTabs(tasks).map((t) => t.repo), ...Object.keys(inboxes ?? {})]).sort();

interface Props {
  // The form's id: the footer's button sends it.
  id: string;
  repo: string;
  tasks: Task[];
  onAction: (action: Action) => void;
  onSent?: () => void;
  preview?: (repo: string, selection: AnalysisSelection) => Promise<AnalysisPreview>;
  start?: (repo: string, selection: AnalysisSelection) => Promise<AnalysisResult>;
}

// One repo's form (keyed by it: another repo starts afresh): how many runs, the kinds and
// outcomes, the preview; the footer's Analyze.
export function AnalyzeForm({
  id,
  repo,
  tasks,
  onAction,
  onSent = () => {},
  preview = previewAnalysis,
  start = startAnalysis,
}: Props) {
  const [count, setCount] = useState(String(DEFAULT_RUNS));
  // null until the listener says which kinds the repo's runs have: then all of them.
  const [kinds, setKinds] = useState<string[] | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>(OUTCOMES.map((o) => o.id));
  const [seen, setSeen] = useState<AnalysisPreview | null>(null);
  const [sent, setSent] = useState<AnalysisResult | null>(null);
  const { sending, error, run } = useSubmit((selection: AnalysisSelection) =>
    start(repo, selection),
  );
  const asked = useRef(0);

  // The listener's limit, once a preview said it.
  const [max, setMax] = useState<number | null>(null);
  const n = Number(count);
  const validCount = Number.isInteger(n) && n >= 1 && (max === null || n <= max);
  const selection: AnalysisSelection = { count: n, kinds: kinds ?? [], outcomes };

  useEffect(() => {
    if (!validCount) return;
    const mine = ++asked.current;
    const timer = setTimeout(async () => {
      const next = await preview(repo, selection);
      if (mine !== asked.current) return;
      setSeen(next);
      if (next.max) setMax(next.max);
      if (kinds === null && next.kinds) setKinds(next.kinds);
    }, PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [count, kinds?.join(","), outcomes.join(",")]);

  const offered = seen?.kinds ?? [];
  const matching = kinds !== null && validCount && !seen?.error ? (seen?.included ?? 0) : 0;
  const ready = matching > 0 && !!kinds?.length && outcomes.length > 0 && !sending;
  const label = matching ? t("request.analyzeRuns", { count: matching }) : t("request.analyze");
  const pendingLabel = t("request.starting");
  // Before the paint: the footer's button says it with the form, not a frame later.
  useLayoutEffect(() => {
    onAction({ label, pendingLabel, disabled: !ready && !sending, pending: sending });
  }, [label, pendingLabel, ready, sending]);

  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const send = async (e: Event) => {
    e.preventDefault();
    if (!ready) return;
    setSent(null);
    const result = await run(selection);
    if (result.error) return;
    setSent(result);
    onSent();
  };

  const task = (sent?.task && tasks.find((t) => t.key === sent.task)) || null;
  const issue = sent ? t("request.issue", { number: sent.number ?? "" }) : "";

  return (
    <form id={id} class={styles.form} aria-label={t("request.analysis")} onSubmit={send}>
      <fieldset class={styles.fields} disabled={sending}>
        <Field
          type="number"
          label={t("request.runsToRead")}
          class={styles.count}
          min={1}
          max={max ?? undefined}
          value={count}
          error={
            validCount
              ? undefined
              : max === null
                ? t("request.pickOneOrMore")
                : t("request.pickUpTo", { max })
          }
          help={max !== null ? t("request.mostRecentMax", { max }) : t("request.mostRecent")}
          onInput={(e) => setCount(e.currentTarget.value)}
        />
        <div class={styles.group} role="group" aria-labelledby={`${id}-kinds`}>
          <span id={`${id}-kinds`} class={styles.legend}>
            {t("request.kinds")}
          </span>
          {seen && !offered.length && (
            <span class={styles.help}>{t("request.noFinishedRuns")}</span>
          )}
          {offered.map((k) => (
            <FilterChip
              key={k}
              pressed={!!kinds?.includes(k)}
              onClick={() => setKinds(toggle(kinds ?? [], k))}
            >
              {runKindName(k)}
            </FilterChip>
          ))}
        </div>
        <div class={styles.group} role="group" aria-labelledby={`${id}-outcomes`}>
          <span id={`${id}-outcomes`} class={styles.legend}>
            {t("request.outcomes")}
          </span>
          {OUTCOMES.map((o) => (
            <FilterChip
              key={o.id}
              pressed={outcomes.includes(o.id)}
              onClick={() => setOutcomes(toggle(outcomes, o.id))}
            >
              {t(o.label)}
            </FilterChip>
          ))}
        </div>
      </fieldset>
      <p class={styles.preview} role="status" aria-live="polite">
        {!validCount
          ? ""
          : seen?.error
            ? seen.error
            : !seen || kinds === null
              ? t("request.counting")
              : matching
                ? t("request.matching", { count: matching, tokens: seen.tokens ?? 0 }) +
                  // A sentence of its own after the first: joined as sentences are.
                  (seen.left ? ` ${t("request.leftOut", { count: seen.left })}` : "")
                : t("request.noMatch")}
      </p>
      <p class={styles.warning}>{t("request.warning")}</p>
      {error && (
        <p class={`${styles.said} ${styles.failed}`} role="alert">
          {error}
        </p>
      )}
      {sent && (
        <p class={styles.said}>
          {tx("request.started", {
            issue: sent.url ? (
              <a href={sent.url} target="_blank" rel="noreferrer">
                {issue}
              </a>
            ) : (
              issue
            ),
          })}
          {task && (
            <>
              {" · "}
              <a href={formatRoute({ repo, task: task.key, run: task.runs[0]?.id ?? null })}>
                {task.runs[0]
                  ? t("request.itsRunStatus", { status: task.runs[0].status })
                  : t("request.itsRun")}
              </a>
            </>
          )}
        </p>
      )}
    </form>
  );
}
