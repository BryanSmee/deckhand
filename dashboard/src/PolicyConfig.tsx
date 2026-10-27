// A repository's Policies tab (docs/design/dashboard-redesign.md › Pages › Settings › A
// repository's policies): the config check's errors first, as they refuse every decision a policy
// is asked for; one line on how policies work; a card per decision with its rules; the policy
// files, operator's and repo's, merged by name; each file's source, folded, its errors under their
// lines; and how to try them on a pull request. Read with the config (api/repos/<repo>/config).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { plural, type Tone } from "./format";
import { copyText } from "./logExport";
import type { Policies, PolicyError, PolicyFile, RepoConfig } from "./types";
import { Button, buttonClass } from "./ui/Button";
import { Code, linesOf } from "./ui/Code";
import { Alert, ChevronRight, External, Warning } from "./ui/icons";
import { StatusBadge } from "./ui/Status";
import styles from "./PolicyConfig.module.css";

const COMMAND = "Deckhand /mode policy";

// A file's errors: those opa placed in it. The rest (a timeout, a folder that can't be read)
// are the whole check's.
const errorsOf = (errors: PolicyError[], f: PolicyFile) =>
  f.active ? errors.filter((e) => e.file === f.name) : [];
// An error placed in no file: whether each one compiles isn't known.
const unplaced = (files: PolicyFile[], errors: PolicyError[]) =>
  errors.some((e) => !files.some((f) => f.active && f.name === e.file));

// What the header's badge says while the check fails: how many files don't compile, or that
// the policies can't be checked at all. Null when they compile.
export function policyTrouble({ files, errors }: Policies): string | null {
  if (!errors.length) return null;
  const bad = files.filter((f) => errorsOf(errors, f).length).length;
  if (!bad) return "Policy error";
  return bad === 1 ? "1 policy doesn't compile" : `${bad} policies don't compile`;
}

const pathOf = (f: PolicyFile) =>
  f.source === "operator" ? `grants/policy/${f.name}` : `.deckhand/policy/${f.name}`;
const keyOf = (f: PolicyFile) => `${f.source}/${f.name}`;
const foldId = (f: PolicyFile) => `policy-${f.source}-${f.name}`;
const lineId = (f: PolicyFile) => (n: number) => `${foldId(f)}-line-${n}`;
// The repo file's page on GitHub, where it is edited.
const editUrl = (url: string) => url.replace("/blob/", "/edit/");

// The decisions a policy is asked for: its rule, and what a denial does.
const DECISIONS: {
  rule: string;
  name: string;
  denies: string;
  refused: (until: string) => string;
}[] = [
  {
    rule: "deny_merge",
    name: "Auto-merge",
    denies: "A denial keeps the pull request for a human: it isn't merged.",
    refused: (until) => `Every auto-merge is refused ${until}.`,
  },
  {
    rule: "deny_review",
    name: "Automatic review",
    denies: "A denial skips the automatic review; /mode review still runs.",
    refused: (until) => `Automatic reviews are skipped ${until}; /mode review still runs.`,
  },
  {
    rule: "deny_fix",
    name: "Fix run",
    denies: "A denial starts no fix run; a comment on the pull request says why.",
    refused: (until) => `Every fix run is refused ${until}.`,
  },
];

// How many times a file defines `rule` (each definition is a rule of its own): at least once,
// as the listener found it, even when the text shown is cut before.
function definitions(f: PolicyFile, rule: string): number {
  const found = f.text.match(new RegExp(`^${rule}\\b`, "gm"))?.length ?? 0;
  return Math.max(found, 1);
}

// The files in the table's order: the listener's, a replaced operator file right after the
// repo file that replaces it.
function ordered(files: PolicyFile[]): PolicyFile[] {
  const replaced = (f: PolicyFile) => f.source === "operator" && !f.active;
  return files.flatMap((f) => {
    if (replaced(f)) return [];
    if (!f.replaces) return [f];
    return [f, ...files.filter((o) => replaced(o) && o.name === f.name)];
  });
}

// What fails, as the banner and the cards say it: the files that don't compile, or the check.
function failing(files: PolicyFile[], errors: PolicyError[]): string {
  const bad = files.filter((f) => errorsOf(errors, f).length).map((f) => f.name);
  if (!bad.length) return "until the policies can be checked";
  return `until ${bad.join(", ")} ${bad.length === 1 ? "compiles" : "compile"}`;
}

export function PolicyConfig({ config }: { config: RepoConfig }) {
  const { files, errors, warnings } = config.policies;
  // The source folds opened or closed by hand, over each one's default: open with an error.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  useEffect(() => setOpened({}), [config.repo.repo]);
  const isOpen = (f: PolicyFile) => opened[keyOf(f)] ?? errorsOf(errors, f).length > 0;
  const toggle = (f: PolicyFile) => (open: boolean) =>
    setOpened((o) => (o[keyOf(f)] === open ? o : { ...o, [keyOf(f)]: open }));
  // A link to an error's line opens its file, then shows the line.
  const goLine = (f: PolicyFile, n: number) => {
    setOpened((o) => ({ ...o, [keyOf(f)]: true }));
    setTimeout(() => document.getElementById(lineId(f)(n))?.scrollIntoView?.({ block: "center" }));
  };
  if (!files.length && !errors.length) {
    return (
      <div class={styles.page}>
        <p class={styles.none}>
          <b>No policies: only the built-in gates decide.</b> A repository adds some as{" "}
          <code>.deckhand/policy/*.rego</code> on <code>{config.base}</code>, the operator in their
          grants folder.
        </p>
      </div>
    );
  }
  const rows = ordered(files);
  const operator = files.filter((f) => f.source === "operator").length;
  return (
    <div class={styles.page}>
      {errors.length > 0 && <Banner files={files} errors={errors} goLine={goLine} />}
      {warnings.length > 0 && (
        <section class={styles.warnings} aria-label="Policy warnings">
          <Warning size={16} />
          <ul>
            {warnings.map((w) => (
              <li key={w}>
                <b>Warning</b> · {w}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p class={styles.model}>
        Rules can only <b>deny</b>, and run after Deckhand's own gates. The operator's files are the
        defaults; a repo file with the same name replaces one, any other name adds to them. They're
        read from <code>{config.base}</code>.
      </p>
      <section class={styles.decisions} aria-label="Decisions">
        {DECISIONS.map((d) => (
          <DecisionCard key={d.rule} decision={d} files={files} errors={errors} />
        ))}
      </section>
      <section class={styles.card} aria-labelledby="policy-files">
        <div class={styles.cardHead}>
          <h2 id="policy-files">Policy files</h2>
          <span class={styles.note}>
            {plural(files.length, "file")} · {operator} from the operator, {files.length - operator}{" "}
            from the repo · merged by name
          </span>
        </div>
        {files.length > 0 && (
          <>
            <div class={`${styles.file} ${styles.fileHead}`} aria-hidden="true">
              <span>File</span>
              <span>From</span>
              <span>Effect</span>
              <span>Rules</span>
              <span>Compiles</span>
            </div>
            <ul class={styles.files} aria-label="Policy files">
              {rows.map((f) => (
                <FileRow
                  key={keyOf(f)}
                  file={f}
                  errors={errorsOf(errors, f)}
                  unknown={unplaced(files, errors)}
                />
              ))}
            </ul>
            {[...rows]
              // The files with an error first: they start open.
              .sort((a, b) => +!errorsOf(errors, a).length - +!errorsOf(errors, b).length)
              .map((f) => (
                <Source
                  key={keyOf(f)}
                  file={f}
                  errors={errorsOf(errors, f)}
                  open={isOpen(f)}
                  onToggle={toggle(f)}
                />
              ))}
          </>
        )}
      </section>
      <TryThem />
    </div>
  );
}

// The check fails: what that refuses, and a link to each error's line.
function Banner({
  files,
  errors,
  goLine,
}: {
  files: PolicyFile[];
  errors: PolicyError[];
  goLine: (f: PolicyFile, n: number) => void;
}) {
  const fileOf = (e: PolicyError) => files.find((f) => f.active && f.name === e.file) ?? null;
  const at = (e: PolicyError) => `${e.file}${e.row !== null ? `:${e.row}` : ""}`;
  const refuses = "every decision a policy is asked for refuses";
  const [first] = errors;
  const one = errors.length === 1;
  const lineLink = (e: PolicyError, label: ComponentChildren) => {
    const f = fileOf(e);
    return f && e.row !== null ? (
      <button type="button" class={styles.lineLink} onClick={() => goLine(f, e.row!)}>
        {label}
      </button>
    ) : null;
  };
  return (
    <section class={styles.banner} role="alert">
      <Alert size={18} />
      <div class={styles.bannerText}>
        <b>
          {one && first.file ? (
            <>
              <code>{at(first)}</code> doesn't compile: {refuses}
            </>
          ) : one ? (
            <>The policies can't be checked: {refuses}</>
          ) : (
            <>
              {plural(errors.length, "policy error")}: {refuses}
            </>
          )}
        </b>
        <span>
          Policies fail closed, and the files are checked together. Until {one ? "it's" : "they're"}{" "}
          fixed, auto-merges, automatic reviews and fix runs here are all refused with “policy
          error”. Runs started by a comment aren't affected.
        </span>
        {one && first.file ? (
          lineLink(first, `Line ${first.row} ↓`)
        ) : (
          <ul class={styles.errors}>
            {errors.map((e, i) => (
              <li key={i}>
                {e.file ? (
                  <>
                    <code>{at(e)}</code>: {e.message}
                  </>
                ) : (
                  e.text
                )}{" "}
                {lineLink(e, `line ${e.row} ↓`)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// A decision: its rules and their files, and whether it is asked (active), not (no rules), or
// refused while the check fails.
function DecisionCard({
  decision: d,
  files,
  errors,
}: {
  decision: (typeof DECISIONS)[number];
  files: PolicyFile[];
  errors: PolicyError[];
}) {
  const own = files.filter((f) => f.active && f.rules.includes(d.rule));
  const rules = own.reduce((n, f) => n + definitions(f, d.rule), 0);
  const refused = errors.length > 0;
  const [tone, label]: [Tone, string] = refused
    ? ["err", "Refused"]
    : own.length
      ? ["done", "Active"]
      : ["idle", "No rules"];
  return (
    <div class={styles.decision}>
      <span class={styles.decisionHead}>
        <span class={styles.key}>
          {d.name} · {d.rule}
        </span>
        <StatusBadge tone={tone} label={label} />
      </span>
      <span class={styles.text}>
        {!refused
          ? own.length
            ? d.denies
            : "Nothing denies it: only Deckhand's own gates decide."
          : own.length
            ? d.refused(failing(files, errors))
            : "No rule of its own, but refused too while the files don't compile."}
      </span>
      <span class={styles.note}>
        {own.length
          ? `${plural(rules, "rule")} · ${own
              .map((f) => (f.replaces ? `${f.name} (repo)` : f.name))
              .join(", ")}`
          : "none in any file"}
      </span>
    </div>
  );
}

const EFFECTS = {
  kept: "Default, kept",
  replaced: "Replaced by the repo's",
  replaces: "Replaces the operator's",
  added: "Added",
};

// A file of the table: where it is, who brings it, what it does to the operator's defaults,
// its rules, and whether it compiles. A replaced operator file is struck through.
function FileRow({
  file: f,
  errors: own,
  unknown,
}: {
  file: PolicyFile;
  errors: PolicyError[];
  unknown: boolean;
}) {
  const effect =
    f.source === "operator"
      ? f.active
        ? EFFECTS.kept
        : EFFECTS.replaced
      : f.replaces
        ? EFFECTS.replaces
        : EFFECTS.added;
  const [tone, compiles]: [Tone, string] = !f.active
    ? ["idle", "—"]
    : own.length
      ? ["err", "Error"]
      : unknown
        ? ["idle", "Unknown"]
        : ["done", "Yes"];
  return (
    <li
      class={[styles.file, !f.active && styles.gone, own.length > 0 && styles.bad]
        .filter(Boolean)
        .join(" ")}
    >
      <span class={styles.fileName}>
        {f.active ? <span class={styles.key}>{f.name}</span> : <s class={styles.key}>{f.name}</s>}
        <span class={styles.path}>{pathOf(f)}</span>
      </span>
      <span class={styles.from}>
        <span class={`${styles.tag} ${f.source === "repo" ? styles.repo : ""}`}>{f.source}</span>
      </span>
      <span class={styles.effect}>{effect}</span>
      <span class={styles.rules}>
        {f.rules.length
          ? f.rules.map((r) => `${r} ×${definitions(f, r)}`).join(", ")
          : "no deny_* rule"}
      </span>
      <span class={styles.compiles}>
        <StatusBadge tone={tone} label={compiles} />
      </span>
    </li>
  );
}

// A file's source, folded: its lines numbered, its errors under their lines, and Edit on
// GitHub for a repo file.
function Source({
  file: f,
  errors,
  open,
  onToggle,
}: {
  file: PolicyFile;
  errors: PolicyError[];
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const lines = linesOf(f.text);
  const marks = new Map<number, string[]>();
  for (const e of errors) {
    if (e.row !== null) marks.set(e.row, [...(marks.get(e.row) ?? []), e.message]);
  }
  const meta = [
    ...(f.replaces ? [`replaces the operator's ${f.name}`] : []),
    ...(!f.active ? ["replaced by the repo's: not evaluated"] : []),
    plural(lines.length, "line"),
    ...(f.truncated ? ["its first 20 KB"] : []),
    ...(errors.length ? [plural(errors.length, "error")] : []),
  ].join(" · ");
  return (
    <details
      id={foldId(f)}
      class={styles.source}
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span class={styles.chevron}>
          <ChevronRight size={14} />
        </span>
        <span class={styles.key}>{pathOf(f)}</span>
        <span class={styles.note}>{meta}</span>
        {f.url && (
          <a
            class={`${buttonClass("ghost", "small")} ${styles.edit}`}
            href={editUrl(f.url)}
            target="_blank"
            rel="noreferrer"
          >
            Edit on GitHub
            <External size={13} />
          </a>
        )}
      </summary>
      {open && <Code lines={lines} marks={marks} lineId={lineId(f)} class={styles.code} />}
    </details>
  );
}

// `/mode policy`: each rule on a pull request as it is now, and the command to copy.
function TryThem() {
  // Whether the last Copy worked (null: none yet).
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <section class={styles.try}>
      <div class={styles.tryText}>
        <b>Try them on a pull request</b>
        <span>
          Comment <code class={styles.command}>{COMMAND}</code> on it: Deckhand replies with each
          rule's result and the input it saw. Nothing is reviewed, fixed or merged.
        </span>
      </div>
      <Button size="small" onClick={async () => setCopied(await copyText(COMMAND))}>
        {copied === null ? "Copy the command" : copied ? "Copied" : "Couldn't copy"}
      </Button>
    </section>
  );
}
