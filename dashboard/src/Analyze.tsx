// Analyze, from the dashboard's top bar: a run that reads a digest of a repo's recent runs
// and replies with what would make them faster or more reliable (listener/analysis.mjs).
// The form picks the repo, how many runs, their kinds and outcomes; the listener says how many
// match and about how many tokens the digest is, as the selection changes. Once started: the
// analysis's issue, then its task.
import { useEffect, useRef, useState } from "preact/hooks";
import { previewAnalysis, startAnalysis } from "./api";
import { formatRoute } from "./route";
import type { AnalysisPreview, AnalysisResult, AnalysisSelection, Outcome, Task } from "./types";
import inbox from "./Inbox.module.css";
import styles from "./Analyze.module.css";

export const DEFAULT_RUNS = 10;
const MAX_RUNS = 50;
// The preview waits for the selection to settle: typing a count asks once.
const PREVIEW_MS = 250;

const OUTCOMES: { id: Outcome; label: string }[] = [
  { id: "ok", label: "Success" },
  { id: "error", label: "Error" },
  { id: "needs-input", label: "Needs input" },
  { id: "interrupted", label: "Interrupted" },
  { id: "cancelled", label: "Cancelled" },
];

const KIND_LABELS: Record<string, string> = {
  work: "Work",
  brainstorm: "Brainstorm",
  idea: "Idea",
  bug: "Bug",
  discussion: "Discussion",
  onboarding: "Onboarding",
  analyze: "Analysis",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The repos the form offers: those api/state shows the user, by name.
export const analysisRepos = (inboxes: Record<string, unknown> | undefined, tasks: Task[]) =>
  [...new Set([...Object.keys(inboxes ?? {}), ...tasks.map((t) => t.repo)])].sort();

interface Props {
  repos: string[];
  tasks: Task[];
  // The tab open: picked first when it is offered.
  repo: string | null;
  onClose: () => void;
  preview?: (repo: string, selection: AnalysisSelection) => Promise<AnalysisPreview>;
  start?: (repo: string, selection: AnalysisSelection) => Promise<AnalysisResult>;
  // Once started: api/state read again, for the run.
  onSent?: () => void;
}

export function AnalyzeDialog({
  repos,
  tasks,
  repo: tab,
  onClose,
  preview = previewAnalysis,
  start = startAnalysis,
  onSent = () => {},
}: Props) {
  const [picked, setPicked] = useState(() => (tab && repos.includes(tab) ? tab : null));
  const repo = picked && repos.includes(picked) ? picked : (repos[0] ?? null);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // A link to the analysis's task opens it: the dialog goes.
    addEventListener("keydown", close);
    addEventListener("hashchange", onClose);
    return () => {
      removeEventListener("keydown", close);
      removeEventListener("hashchange", onClose);
    };
  }, []);

  return (
    <div class={inbox.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={inbox.dialog} role="dialog" aria-modal="true" aria-label="Analyze runs">
        <div class={inbox.head}>
          <h2 class={inbox.title}>Analyze recent runs</h2>
          <button type="button" class={inbox.close} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p class={inbox.note}>
          A run reads a digest of the runs you pick and replies on a new issue with what would make
          them faster or more reliable. It changes no code.
        </p>
        {!repo && <p class={inbox.note}>No repository has runs to analyze yet.</p>}
        {repo && (
          <>
            <label class={inbox.repo}>
              Repository
              <select value={repo} onChange={(e) => setPicked(e.currentTarget.value)}>
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <Analyze
              key={repo}
              repo={repo}
              tasks={tasks}
              preview={(selection) => preview(repo, selection)}
              start={(selection) => start(repo, selection)}
              onSent={onSent}
            />
          </>
        )}
      </div>
    </div>
  );
}

interface FormProps {
  repo: string;
  tasks: Task[];
  preview: (selection: AnalysisSelection) => Promise<AnalysisPreview>;
  start: (selection: AnalysisSelection) => Promise<AnalysisResult>;
  onSent: () => void;
}

// One repo's form: how many runs, the kinds and outcomes, the preview, Analyze.
function Analyze({ repo, tasks, preview, start, onSent }: FormProps) {
  const [count, setCount] = useState(String(DEFAULT_RUNS));
  // null until the listener says which kinds the repo's runs have: then all of them.
  const [kinds, setKinds] = useState<string[] | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>(OUTCOMES.map((o) => o.id));
  const [seen, setSeen] = useState<AnalysisPreview | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<AnalysisResult | null>(null);
  const asked = useRef(0);

  const n = Number(count);
  const validCount = Number.isInteger(n) && n >= 1 && n <= MAX_RUNS;
  const selection: AnalysisSelection = { count: n, kinds: kinds ?? [], outcomes };

  useEffect(() => {
    if (!validCount) return;
    const mine = ++asked.current;
    const timer = setTimeout(async () => {
      const next = await preview(selection);
      if (mine !== asked.current) return;
      setSeen(next);
      if (kinds === null && next.kinds) setKinds(next.kinds);
    }, PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [count, kinds?.join(","), outcomes.join(",")]);

  const offered = seen?.kinds ?? [];
  const matching = kinds !== null && validCount && !seen?.error ? (seen?.included ?? 0) : 0;
  const ready = matching > 0 && !!kinds?.length && outcomes.length > 0 && !sending;

  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const send = async (e: Event) => {
    e.preventDefault();
    if (!ready) return;
    setSending(true);
    setError(null);
    setSent(null);
    const result = await start(selection);
    setSending(false);
    if (result.error) return setError(result.error);
    setSent(result);
    onSent();
  };

  const task = (sent?.task && tasks.find((t) => t.key === sent.task)) || null;

  return (
    <form class={inbox.form} aria-label="Analysis" onSubmit={send}>
      <fieldset class={inbox.fields} disabled={sending}>
        <label class={styles.count}>
          Runs to read
          <input
            type="number"
            min={1}
            max={MAX_RUNS}
            value={count}
            aria-invalid={!validCount}
            onInput={(e) => setCount(e.currentTarget.value)}
          />
          <span class={styles.hint}>the most recent, {MAX_RUNS} at most</span>
        </label>
        <div class={styles.group} role="group" aria-label="Kinds">
          <span class={styles.legend}>Kinds</span>
          {seen && !offered.length && <span class={styles.hint}>No finished runs yet.</span>}
          {offered.map((k) => (
            <label key={k} class={`${styles.chip} ${kinds?.includes(k) ? styles.on : ""}`}>
              <input
                type="checkbox"
                checked={!!kinds?.includes(k)}
                onChange={() => setKinds(toggle(kinds ?? [], k))}
              />
              {KIND_LABELS[k] ?? k}
            </label>
          ))}
        </div>
        <div class={styles.group} role="group" aria-label="Outcomes">
          <span class={styles.legend}>Outcomes</span>
          {OUTCOMES.map((o) => (
            <label key={o.id} class={`${styles.chip} ${outcomes.includes(o.id) ? styles.on : ""}`}>
              <input
                type="checkbox"
                checked={outcomes.includes(o.id)}
                onChange={() => setOutcomes(toggle(outcomes, o.id))}
              />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      <p class={styles.preview} role="status" aria-live="polite">
        {!validCount
          ? `Pick from 1 to ${MAX_RUNS} runs.`
          : seen?.error
            ? seen.error
            : !seen || kinds === null
              ? "Counting the runs…"
              : matching
                ? `${plural(matching, "run")} match, about ${(seen.tokens ?? 0).toLocaleString("en")} tokens to read.` +
                  (seen.left
                    ? ` ${plural(seen.left, "older run")} left out: over the digest's cap.`
                    : "")
                : "No run matches: pick other kinds or outcomes."}
      </p>
      <p class={styles.warning}>
        This is a large run: it uses the operator's Claude budget, on the model of light runs.
      </p>
      {error && (
        <p class={`${inbox.said} ${inbox.failed}`} role="alert">
          {error}
        </p>
      )}
      {sent && (
        <p class={inbox.said}>
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
      <div class={inbox.actions}>
        <button type="submit" class={inbox.send} disabled={!ready}>
          {sending ? "Starting…" : matching ? `Analyze ${plural(matching, "run")}` : "Analyze"}
        </button>
      </div>
    </form>
  );
}
