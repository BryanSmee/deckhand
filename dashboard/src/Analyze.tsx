// New request's Analyze runs (NewRequest.tsx): a run that reads a digest of a repo's recent
// runs and replies with what would make them faster or more reliable (listener/analysis.mjs).
// The form picks how many runs, their kinds and outcomes; the listener says how many match and
// about how many tokens the digest is, as the selection changes. Once started: the analysis's
// issue, then its task.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { previewAnalysis, startAnalysis } from "./api";
import { plural, repoTabs, runKindName, uniqueRepos } from "./format";
import { useSubmit } from "./hooks";
import { number } from "./i18n";
import type { Action } from "./NewRequest";
import { formatRoute } from "./route";
import type { AnalysisPreview, AnalysisResult, AnalysisSelection, Outcome, Task } from "./types";
import { Field } from "./ui/Field";
import { FilterChip } from "./ui/FilterChip";
import styles from "./NewRequest.module.css";

export const DEFAULT_RUNS = 10;
// The preview waits for the selection to settle: typing a count asks once.
const PREVIEW_MS = 250;

const OUTCOMES: { id: Outcome; label: string }[] = [
  { id: "ok", label: "Success" },
  { id: "error", label: "Error" },
  { id: "needs-input", label: "Needs input" },
  { id: "interrupted", label: "Interrupted" },
  { id: "cancelled", label: "Cancelled" },
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
  const label = matching ? `Analyze ${plural(matching, "run")}` : "Analyze";
  // Before the paint: the footer's button says it with the form, not a frame later.
  useLayoutEffect(() => {
    onAction({ label, pendingLabel: "Starting…", disabled: !ready && !sending, pending: sending });
  }, [label, ready, sending]);

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

  return (
    <form id={id} class={styles.form} aria-label="Analysis" onSubmit={send}>
      <fieldset class={styles.fields} disabled={sending}>
        <Field
          type="number"
          label="Runs to read"
          class={styles.count}
          min={1}
          max={max ?? undefined}
          value={count}
          error={
            validCount
              ? undefined
              : max === null
                ? "Pick 1 run or more."
                : `Pick from 1 to ${max} runs.`
          }
          help={`The most recent${max !== null ? `, ${max} at most` : ""}.`}
          onInput={(e) => setCount(e.currentTarget.value)}
        />
        <div class={styles.group} role="group" aria-labelledby={`${id}-kinds`}>
          <span id={`${id}-kinds`} class={styles.legend}>
            Kinds
          </span>
          {seen && !offered.length && <span class={styles.help}>No finished runs yet.</span>}
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
            Outcomes
          </span>
          {OUTCOMES.map((o) => (
            <FilterChip
              key={o.id}
              pressed={outcomes.includes(o.id)}
              onClick={() => setOutcomes(toggle(outcomes, o.id))}
            >
              {o.label}
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
              ? "Counting the runs…"
              : matching
                ? `${plural(matching, "run")} match, about ${number(seen.tokens ?? 0)} tokens to read.` +
                  (seen.left
                    ? ` ${plural(seen.left, "older run")} left out: over the digest's cap.`
                    : "")
                : "No run matches: pick other kinds or outcomes."}
      </p>
      <p class={styles.warning}>
        This is a large run: it uses the operator's Claude budget, on the model of light runs.
      </p>
      {error && (
        <p class={`${styles.said} ${styles.failed}`} role="alert">
          {error}
        </p>
      )}
      {sent && (
        <p class={styles.said}>
          Started:{" "}
          {sent.url ? (
            <a href={sent.url} target="_blank" rel="noreferrer">
              issue #{sent.number}
            </a>
          ) : (
            `issue #${sent.number}`
          )}
          {task && (
            <>
              {" · "}
              <a href={formatRoute({ repo, task: task.key, run: task.runs[0]?.id ?? null })}>
                its run{task.runs[0] ? ` (${task.runs[0].status})` : ""}
              </a>
            </>
          )}
        </p>
      )}
    </form>
  );
}
