// A repository's workflow editor (#1042, stage 4 of #899), its config page's Editor tab: a file
// of .deckhand/workflows/ beside its graph (WorkflowSteps.tsx), checked as it is typed by the
// orchestrator's own parser (listener/workflow-editor.mjs); a what-if dry run on a past pull
// request, its recorded history replayed up to the first step it never took, then the outcomes
// picked here; and Save, which opens a pull request with the file (the App's, saying who saved
// it), with `repo:config:write`. Nothing applies before that pull request is merged.
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useCan } from "./access";
import { getJson, postJson } from "./api";
import { ago } from "./format";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import type {
  DryRun,
  SavedWorkflow,
  TrailStep,
  WorkflowCheck,
  WorkflowError,
  WorkflowFiles,
  WorkflowStep,
} from "./types";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import { External } from "./ui/icons";
import { Notice } from "./ui/Surface";
import { marksOf, outcomeName, stepName, WorkflowSteps } from "./WorkflowSteps";
import styles from "./WorkflowEditor.module.css";

// A text's check waits for a pause in the typing.
const CHECK_MS = 300;
const NEW = "";

// A new file's text when the repository has no workflow of its own to start from.
const STARTER = `on: ready
vars:
  fixes: counter
steps:
  - run: review
  - repeat:
      - run: fix
        count: fixes
      - run: review
    max: fixes 2
`;

// How a dry run's step got its outcome, and how it ended.
const SOURCES: Record<TrailStep["source"], Plain> = {
  recorded: "editor.source.recorded",
  assumed: "editor.source.assumed",
  auto: "editor.source.auto",
  picked: "editor.source.picked",
};
const ENDS: Record<DryRun["end"], Plain> = {
  done: "editor.end.done",
  merged: "editor.end.merged",
  stopped: "editor.end.stopped",
  asking: "editor.end.asking",
};

const url = (repo: string, what = "") => `api/repos/${repo}/workflows${what}`;

export function WorkflowEditor({ repo, now }: { repo: string; now: number }) {
  const can = useCan();
  const [files, setFiles] = useState<WorkflowFiles | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // The file open: its name in .deckhand/workflows/, NEW for one not there yet.
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<WorkflowCheck | null>(null);
  // The last steps the text parsed to, drawn (faded) while it doesn't.
  const [drawn, setDrawn] = useState<{ steps: WorkflowStep[]; on: string[] } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const dry = useDryRun(repo, name || "workflow.yaml", text);

  async function read() {
    setReadError(null);
    const got = await getJson<WorkflowFiles>(url(repo));
    if (got.error) return setReadError(got.error);
    setFiles(got);
    pick(got, got.files[0]?.name ?? NEW);
  }
  useEffect(() => {
    void read();
  }, [repo]);

  function pick(from: WorkflowFiles, which: string) {
    const file = from.files.find((f) => f.name === which);
    setOpen(file ? file.name : NEW);
    setName(
      file ? file.name : from.files.some((f) => f.name === "review.yaml") ? "" : "review.yaml",
    );
    setText(file ? file.text : (from.builtIn.ready ?? STARTER));
    setDrawn(null);
  }

  // Checked as it is typed: the last answer for the latest text wins.
  const asked = useRef(0);
  useEffect(() => {
    if (open === null) return;
    const id = ++asked.current;
    const timer = setTimeout(async () => {
      const got = await postJson<WorkflowCheck>(url(repo, "/check"), {
        name: name || "workflow.yaml",
        text,
      });
      if (id !== asked.current) return;
      if (got.error) {
        setChecked({
          steps: null,
          on: [],
          errors: [{ file: null, line: null, message: got.error }],
        });
        return;
      }
      setChecked(got);
      if (got.steps) setDrawn({ steps: got.steps, on: got.on });
    }, CHECK_MS);
    return () => clearTimeout(timer);
  }, [repo, open, name, text]);

  // The editor's cursor to `line`, the line selected.
  function toLine(line: number) {
    const box = area.current;
    if (!box) return;
    const lines = text.split("\n");
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    box.focus();
    box.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    box.scrollTop = Math.max(0, (line - 4) * 19);
  }

  if (readError) {
    return (
      <div class={styles.tab}>
        <Notice tone="err">{t("editor.unreadable", { error: readError })}</Notice>
      </div>
    );
  }
  if (!files || open === null) {
    return (
      <div class={styles.tab}>
        <p class={styles.muted}>{t("editor.reading")}</p>
      </div>
    );
  }

  const file = files.files.find((f) => f.name === open) ?? null;
  const original = file?.text ?? null;
  const errors = checked?.errors ?? [];
  const marks = dry.result
    ? marksOf(dry.result.trail, dry.result.diverged?.line ?? null, dry.result.ask?.line ?? null)
    : null;
  return (
    <div class={styles.tab}>
      <p class={styles.intro}>{t("editor.intro")}</p>
      <div class={styles.pickRow}>
        <Field
          as="select"
          size="small"
          label={t("editor.file")}
          value={open}
          onChange={(e) => pick(files, (e.target as HTMLSelectElement).value)}
        >
          {files.files.map((f) => (
            <option key={f.name} value={f.name}>
              {f.file}
            </option>
          ))}
          <option value={NEW}>{t("editor.newFile")}</option>
        </Field>
        {open === NEW && (
          <Field
            size="small"
            label={t("editor.name")}
            help={t("editor.nameHelp")}
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value.trim())}
            spellcheck={false}
          />
        )}
        {file && (
          <a class={styles.link} href={file.url} target="_blank" rel="noreferrer">
            {t("editor.onGithub", { base: files.base })}
            <External size={13} />
          </a>
        )}
      </div>
      <Versions files={files} file={file?.file ?? null} on={checked?.on ?? drawn?.on ?? []} />
      <div class={styles.panes}>
        <section class={styles.pane} aria-labelledby="editor-yaml">
          <h2 id="editor-yaml" class={styles.title}>
            {file ? file.file : t("editor.newTitle")}
          </h2>
          <Yaml text={text} errors={errors} onText={setText} area={area} />
          <Problems errors={errors} pending={!checked} onLine={toLine} />
        </section>
        <section class={styles.pane} aria-labelledby="editor-graph">
          <h2 id="editor-graph" class={styles.title}>
            {t("editor.graphTitle")}
          </h2>
          {drawn ? (
            <WorkflowSteps
              steps={drawn.steps}
              on={drawn.on}
              marks={marks}
              onLine={toLine}
              stale={!checked?.steps}
            />
          ) : (
            <p class={styles.muted}>{t(checked ? "editor.noGraph" : "editor.checking")}</p>
          )}
        </section>
      </div>
      <DryRunPanel files={files} dry={dry} ready={!errors.length && !!checked?.steps} now={now} />
      <Save
        repo={repo}
        name={name}
        text={text}
        sha={file?.sha ?? null}
        changed={text !== original || !file}
        errors={errors.length > 0 || !checked}
        allowed={can.repo(repo, "repo:config:write")}
      />
    </div>
  );
}

// The text, its line numbers beside it, the lines with errors marked.
function Yaml({
  text,
  errors,
  onText,
  area,
}: {
  text: string;
  errors: WorkflowError[];
  onText: (text: string) => void;
  area: RefObject<HTMLTextAreaElement>;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const bad = new Set(errors.filter((e) => !e.file && e.line).map((e) => e.line));
  const count = text.split("\n").length;
  return (
    <div class={styles.yaml}>
      <div class={styles.gutter} ref={gutter} aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <span key={i} class={bad.has(i + 1) ? styles.badLine : ""}>
            {i + 1}
          </span>
        ))}
      </div>
      <textarea
        ref={area}
        class={styles.text}
        value={text}
        aria-label={t("editor.text")}
        aria-invalid={errors.length ? "true" : undefined}
        spellcheck={false}
        autocapitalize="off"
        autocomplete="off"
        wrap="off"
        onInput={(e) => onText((e.target as HTMLTextAreaElement).value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = (e.target as HTMLElement).scrollTop;
        }}
        onKeyDown={(e) => {
          // Tab indents (two spaces, YAML's), rather than leaving the editor.
          if (e.key !== "Tab" || e.shiftKey) return;
          e.preventDefault();
          const box = e.target as HTMLTextAreaElement;
          const at = box.selectionStart;
          onText(`${text.slice(0, at)}  ${text.slice(box.selectionEnd)}`);
          requestAnimationFrame(() => box.setSelectionRange(at + 2, at + 2));
        }}
      />
    </div>
  );
}

function Problems({
  errors,
  pending,
  onLine,
}: {
  errors: WorkflowError[];
  pending: boolean;
  onLine: (line: number) => void;
}) {
  if (pending) return <p class={styles.muted}>{t("editor.checking")}</p>;
  if (!errors.length) {
    return (
      <p class={styles.valid} role="status">
        {t("editor.valid")}
      </p>
    );
  }
  return (
    <div role="alert" class={styles.errors}>
      <p>{t("editor.errors", { count: errors.length })}</p>
      <ul>
        {errors.map((e, i) => (
          <li key={i}>
            {e.line && !e.file ? (
              <button type="button" class={styles.lineLink} onClick={() => onLine(e.line!)}>
                {t("editor.line", { line: e.line })}
              </button>
            ) : e.file ? (
              <code>
                {e.file}
                {e.line ? `:${e.line}` : ""}
              </code>
            ) : null}{" "}
            {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

// How many open pull requests run this workflow now, at which version: each keeps the one it
// started with, so a saved change applies to those that start once it is merged.
function Versions({
  files,
  file,
  on,
}: {
  files: WorkflowFiles;
  file: string | null;
  on: string[];
}) {
  // A new file on an event replaces Deckhand's own workflow there: its pull requests.
  const rows = files.running.filter((r) =>
    file ? r.file === file : !r.file && on.includes(r.event),
  );
  const current = rows.reduce((n, r) => n + r.current, 0);
  const older = rows.reduce((n, r) => n + r.older, 0);
  return (
    <p class={styles.muted} role="status">
      {current + older === 0
        ? t("editor.versions.none")
        : t(file ? "editor.versions.file" : "editor.versions.builtIn", {
            count: current,
          })}
      {older > 0 && ` ${t("editor.versions.older", { count: older })}`}
    </p>
  );
}

interface DryRunState {
  pr: number | null;
  setPr: (pr: number | null) => void;
  picks: string[];
  result: DryRun | null;
  error: string | null;
  running: boolean;
  run: (picks?: string[]) => Promise<void>;
  reset: () => void;
}

// The dry run's state: a pull request, the picks so far, the last answer. A new text or pull
// request starts it over.
function useDryRun(repo: string, name: string, text: string): DryRunState {
  const [pr, setPr] = useState<number | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [result, setResult] = useState<DryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const reset = () => {
    setPicks([]);
    setResult(null);
    setError(null);
  };
  useEffect(reset, [text, pr]);
  async function run(next: string[] = []) {
    if (pr === null) return;
    setRunning(true);
    const got = await postJson<DryRun>(url(repo, "/dry-run"), { name, text, pr, picks: next });
    setRunning(false);
    if (got.error) return setError(got.error);
    setError(null);
    setPicks(next);
    setResult(got);
  }
  return { pr, setPr, picks, result, error, running, run, reset };
}

function DryRunPanel({
  files,
  dry,
  ready,
  now,
}: {
  files: WorkflowFiles;
  dry: DryRunState;
  ready: boolean;
  now: number;
}) {
  const { result } = dry;
  return (
    <section class={styles.section} aria-labelledby="editor-dry-run">
      <h2 id="editor-dry-run" class={styles.title}>
        {t("editor.dryRun")}
      </h2>
      <p class={styles.muted}>{t("editor.dryRunHelp")}</p>
      {files.pulls.length === 0 ? (
        <p class={styles.muted}>{t("editor.noPulls")}</p>
      ) : (
        <div class={styles.pickRow}>
          <Field
            as="select"
            size="small"
            label={t("editor.pull")}
            value={dry.pr === null ? "" : String(dry.pr)}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              dry.setPr(v ? Number(v) : null);
            }}
          >
            <option value="">{t("editor.pickPull")}</option>
            {files.pulls.map((p) => (
              <option key={p.number} value={p.number}>
                {t("editor.pullRow", {
                  number: p.number,
                  reviews: p.reviews,
                  fixes: p.fixes,
                  when: ago(p.at, now),
                })}
                {p.merged ? ` · ${t("editor.merged")}` : ""}
              </option>
            ))}
          </Field>
          <Button
            size="small"
            variant="primary"
            disabled={dry.pr === null || !ready}
            pending={dry.running && !result}
            onClick={() => dry.run([])}
            title={ready ? undefined : t("editor.fixFirst")}
          >
            {t(result ? "editor.runAgain" : "editor.run")}
          </Button>
        </div>
      )}
      {dry.error && <Notice tone="err">{dry.error}</Notice>}
      {result && <Trail result={result} dry={dry} />}
    </section>
  );
}

function Trail({ result, dry }: { result: DryRun; dry: DryRunState }) {
  const { trail, diverged, ask } = result;
  const step = (i: number) => {
    const s = trail[i];
    return (
      <li key={i} class={styles.trailStep}>
        <span class={styles.trailName}>
          {stepName(s)} <span class={styles.lineNo}>{t("editor.line", { line: s.line })}</span>
        </span>
        <span class={styles.trailOutcome}>{outcomeName(s.run, s.outcome)}</span>
        <span class={`${styles.source} ${styles[s.source]}`}>{t(SOURCES[s.source])}</span>
      </li>
    );
  };
  const before = diverged ? trail.slice(0, diverged.index) : trail;
  const after = diverged ? trail.slice(diverged.index) : [];
  return (
    <div class={styles.trail}>
      <p class={styles.muted}>
        {tx("editor.replaying", {
          pr: result.pr.url ? (
            <a href={result.pr.url} target="_blank" rel="noreferrer">
              #{result.pr.number} {result.pr.title}
            </a>
          ) : (
            `#${result.pr.number}`
          ),
          count: result.history.length,
        })}
      </p>
      <ol class={styles.steps}>{before.map((_, i) => step(i))}</ol>
      {diverged && (
        <p class={styles.divergence} role="status">
          {diverged.expected
            ? t("editor.diverged", {
                step: stepName({ run: diverged.run }),
                did: `${stepName(diverged.expected)} (${outcomeName(diverged.expected.run, diverged.expected.outcome)})`,
              })
            : t("editor.historyEnds", { step: stepName({ run: diverged.run }) })}
        </p>
      )}
      {after.length > 0 && (
        <ol class={styles.steps} start={diverged!.index + 1}>
          {after.map((_, i) => step(diverged!.index + i))}
        </ol>
      )}
      {ask ? (
        <fieldset class={styles.ask}>
          <legend>{t("editor.ask", { step: stepName({ run: ask.run }), line: ask.line })}</legend>
          <div class={styles.options}>
            {ask.options.map((o) => (
              <Button
                key={o}
                size="small"
                disabled={dry.running}
                onClick={() => dry.run([...dry.picks, o])}
              >
                {outcomeName(ask.run, o)}
              </Button>
            ))}
          </div>
        </fieldset>
      ) : (
        <p class={styles.endLine} role="status">
          {t(ENDS[result.end])}
          {result.leftover.length > 0 &&
            ` ${t("editor.leftover", {
              steps: result.leftover
                .map((s) => `${stepName(s)} (${outcomeName(s.run, s.outcome)})`)
                .join(", "),
            })}`}
        </p>
      )}
      {dry.picks.length > 0 && (
        <div class={styles.options}>
          <Button size="small" variant="ghost" onClick={() => dry.run(dry.picks.slice(0, -1))}>
            {t("editor.undoPick")}
          </Button>
          <Button size="small" variant="ghost" onClick={() => dry.run([])}>
            {t("editor.startOver")}
          </Button>
        </div>
      )}
    </div>
  );
}

// Save: a pull request with the file, opened by the App on the user's behalf.
function Save({
  repo,
  name,
  text,
  sha,
  changed,
  errors,
  allowed,
}: {
  repo: string;
  name: string;
  text: string;
  sha: string | null;
  changed: boolean;
  errors: boolean;
  allowed: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<(SavedWorkflow & { name: string; text: string }) | null>(null);
  // Saved as it is: a second click would open a second pull request for the same change.
  const again = !!saved && saved.name === name && saved.text === text;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [text, name]);
  async function save() {
    setSaving(true);
    const got = await postJson<SavedWorkflow>(url(repo, "/save"), { name, text, sha });
    setSaving(false);
    if (got.error) return setError(got.error);
    setSaved({ ...got, name, text });
  }
  return (
    <section class={styles.section} aria-labelledby="editor-save">
      <h2 id="editor-save" class={styles.title}>
        {t("editor.saveTitle")}
      </h2>
      <p class={styles.muted}>{t("editor.saveHelp")}</p>
      <div class={styles.options}>
        <Button
          variant="primary"
          disabled={!allowed || !changed || errors || !name || saving || again}
          pending={saving}
          pendingLabel={t("editor.saving")}
          onClick={save}
        >
          {t("editor.save")}
        </Button>
      </div>
      {!allowed && (
        <p class={styles.muted}>
          {tx("editor.saveDenied", { permission: <code>repo:config:write</code> })}
        </p>
      )}
      {allowed && errors && <p class={styles.muted}>{t("editor.saveErrors")}</p>}
      {error && <Notice tone="err">{error}</Notice>}
      {saved && (
        <Notice tone="done">
          {tx("editor.saved", {
            pr: (
              <a href={saved.url} target="_blank" rel="noreferrer">
                #{saved.number}
              </a>
            ),
          })}
        </Notice>
      )}
    </section>
  );
}
