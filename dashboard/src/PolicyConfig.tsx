// A repository's Policies tab (docs/design/dashboard-redesign.md › Pages › Settings › A
// repository's policies): the config check's errors first, as they refuse every decision a policy
// is asked for; one line on how policies work; a card per decision with its rules; the policy
// files, Deckhand's, the operator's and the repo's, merged by name; each file's source, folded, its errors under their
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
// What deny_github reads, field by field.
const GITHUB_INPUT =
  "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config.md#the-github-input";

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

// Where each source's files are: Deckhand's image, the grants folder, the repo.
const FOLDERS = {
  deckhand: "deckhand/policy",
  operator: "grants/policy",
  repo: ".deckhand/policy",
};
const pathOf = (f: PolicyFile) => `${FOLDERS[f.source]}/${f.name}`;
// Whose file a source's is, as the effects and the sources' notes say it.
const OWNERS = { deckhand: "Deckhand's", operator: "the operator's", repo: "the repo's" };
// The source of the file that replaces `f` (the one evaluated in its place), when it is replaced.
const replacedBy = (files: PolicyFile[], f: PolicyFile) =>
  f.active ? null : (files.find((o) => o.active && o.name === f.name)?.source ?? null);
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
  {
    rule: "deny_link_branch",
    name: "Linked branch",
    denies:
      "A denial links no branch to the issue as a work run starts; the run creates its branch itself.",
    refused: (until) => `No branch is linked to an issue ${until}.`,
  },
  {
    rule: "deny_github",
    name: "GitHub writes",
    denies:
      "A denial refuses a run's write to GitHub (REST or GraphQL); gh prints the messages to the agent.",
    refused: (until) => `Every run's write to GitHub is refused ${until}.`,
  },
];

// How many times a file defines `rule` (each definition is a rule of its own): at least once,
// as the listener found it, even when the text shown is cut before.
function definitions(f: PolicyFile, rule: string): number {
  const found = f.text.match(new RegExp(`^${rule}\\b`, "gm"))?.length ?? 0;
  return Math.max(found, 1);
}

// The files in the table's order: the listener's, the files a file replaces right after it,
// the nearest first.
function ordered(files: PolicyFile[]): PolicyFile[] {
  return files.flatMap((f) => {
    if (!f.active) return [];
    if (!f.replaces) return [f];
    return [f, ...files.filter((o) => !o.active && o.name === f.name).reverse()];
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
  const from = (source: PolicyFile["source"]) => files.filter((f) => f.source === source).length;
  const counts = [
    ...(from("deckhand") ? [`${from("deckhand")} from Deckhand`] : []),
    `${from("operator")} from the operator`,
    `${from("repo")} from the repo`,
  ].join(", ");
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
        Rules can only <b>deny</b>, and run after Deckhand's own gates. Deckhand's and the
        operator's files are the defaults, the operator's over Deckhand's; a repo file with the same
        name replaces one, any other name adds to them. The repo's are read from{" "}
        <code>{config.base}</code>.
      </p>
      <p class={styles.model}>
        <code>deny_github</code> reads the write (<code>action</code>, <code>target</code>,{" "}
        <code>change</code>) and the run: its <code>mode</code>, <code>custom_mode</code> (one of
        the repo's <code>modes:</code>), <code>light</code> and <code>reason</code> (
        <code>review-fix</code>, <code>ci-fix</code>, <code>conflict</code>, or null).{" "}
        <a href={GITHUB_INPUT} target="_blank" rel="noreferrer">
          The GitHub input
        </a>
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
            {plural(files.length, "file")} · {counts} · merged by name
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
                  by={replacedBy(files, f)}
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
                  by={replacedBy(files, f)}
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
          fixed, auto-merges, automatic reviews, fix runs and runs' writes to GitHub here are all
          refused with “policy error”. Runs started by a comment still start.
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
              .map((f) => (f.replaces ? `${f.name} (${f.source})` : f.name))
              .join(", ")}`
          : "none in any file"}
      </span>
    </div>
  );
}

// What a file does to the defaults: `by`, the source of the file that replaces it.
function effectOf(f: PolicyFile, by: PolicyFile["source"] | null): string {
  if (by) return `Replaced by ${OWNERS[by]}`;
  if (f.replaces) return `Replaces ${OWNERS[f.replaces]}`;
  return f.source === "repo" ? "Added" : "Default, kept";
}

// A file of the table: where it is, who brings it, what it does to the defaults, its rules,
// and whether it compiles. A replaced file is struck through.
function FileRow({
  file: f,
  by,
  errors: own,
  unknown,
}: {
  file: PolicyFile;
  by: PolicyFile["source"] | null;
  errors: PolicyError[];
  unknown: boolean;
}) {
  const effect = effectOf(f, by);
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
  by,
  errors,
  open,
  onToggle,
}: {
  file: PolicyFile;
  by: PolicyFile["source"] | null;
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
    ...(f.replaces ? [`replaces ${OWNERS[f.replaces]} ${f.name}`] : []),
    ...(by ? [`replaced by ${OWNERS[by]}: not evaluated`] : []),
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
