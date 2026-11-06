// A repository's Policies tab (docs/design/dashboard-redesign.md › Pages › Settings › A
// repository's policies): the config check's errors first, as they refuse every decision a policy
// is asked for; a few lines on how policies work; a card per decision with each layer's allow and
// deny rules; the policy files, Deckhand's and the operator's merged by name, the repo's apart;
// each file's source, folded, its errors under their lines; and how to try them on a pull
// request. Read with the config (api/repos/<repo>/config).
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Tone } from "./format";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import { copyText } from "./logExport";
import type { Policies, PolicyError, PolicyFile, RepoConfig } from "./types";
import { Button, buttonClass } from "./ui/Button";
import { Code, linesOf } from "./ui/Code";
import { Alert, ChevronRight, External, Warning } from "./ui/icons";
import { StatusBadge } from "./ui/Status";
import styles from "./PolicyConfig.module.css";

const COMMAND = "Deckhand /mode policy";
// What allow_github and deny_github read, field by field.
const GITHUB_INPUT =
  "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config/policy-inputs.md#the-github-input";
// What deny_push reads.
const PUSH_INPUT =
  "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config/policy-inputs.md#the-push-input";
// What deny_run reads.
const RUN_INPUT =
  "https://github.com/BryanSmee/deckhand/blob/main/docs/repo-config/policy-inputs.md#the-run-input";

// The layer a file is evaluated in: Deckhand's and the operator's together, the repo's apart.
const layerOf = (f: PolicyFile) => (f.source === "repo" ? "repo" : "operator");
// Whether `e` is about `f`: opa placed it in a file of that name, in its layer (an error from
// before layers says none).
const isOf = (e: PolicyError, f: PolicyFile) =>
  f.active && e.file === f.name && (!e.layer || e.layer === layerOf(f));
// A file's errors: those opa placed in it. The rest (a timeout, a folder that can't be read)
// are the whole check's.
const errorsOf = (errors: PolicyError[], f: PolicyFile) => errors.filter((e) => isOf(e, f));
// An error placed in no file: whether each one compiles isn't known.
const unplaced = (files: PolicyFile[], errors: PolicyError[]) =>
  errors.some((e) => !files.some((f) => isOf(e, f)));

// The errors that refuse every decision: not a repo's allow rule that is only ignored
// (`ignored`), which refuses nothing.
export const refusing = (errors: PolicyError[]) => errors.filter((e) => !e.ignored);

// What the header's badge says while the check fails: how many files don't compile, or that
// the policies can't be checked at all. Null when they compile.
export function policyTrouble({ files, errors: all }: Policies): string | null {
  const errors = refusing(all);
  if (!errors.length) return null;
  const bad = files.filter((f) => errorsOf(errors, f).length).length;
  if (!bad) return t("policyConfig.trouble");
  return t("policyConfig.troubleFiles", { count: bad });
}

// Where each source's files are: Deckhand's image, the grants folder, the repo.
const FOLDERS = {
  deckhand: "deckhand/policy",
  operator: "grants/policy",
  repo: ".deckhand/policy",
};
const pathOf = (f: PolicyFile) => `${FOLDERS[f.source]}/${f.name}`;
// Whose file a source's is, as the effects and the sources' notes say it; and its tag. Keys,
// written when shown.
const OWNERS: Record<PolicyFile["source"], Plain> = {
  deckhand: "policyConfig.ownerDeckhand",
  operator: "policyConfig.ownerOperator",
  repo: "policyConfig.ownerRepo",
};
const TAGS: Record<PolicyFile["source"], Plain> = {
  deckhand: "policyConfig.tagDeckhand",
  operator: "policyConfig.tagOperator",
  repo: "policyConfig.tagRepo",
};
// The source of the file that replaces `f` (the one evaluated in its place), when it is
// replaced: Deckhand's by the operator's only, the repo's files being a layer of their own.
const replacedBy = (files: PolicyFile[], f: PolicyFile) =>
  f.active
    ? null
    : (files.find((o) => o.active && o.source === "operator" && o.name === f.name)?.source ?? null);
const keyOf = (f: PolicyFile) => `${f.source}/${f.name}`;
const foldId = (f: PolicyFile) => `policy-${f.source}-${f.name}`;
const lineId = (f: PolicyFile) => (n: number) => `${foldId(f)}-line-${n}`;
// The repo file's page on GitHub, where it is edited.
const editUrl = (url: string) => url.replace("/blob/", "/edit/");

// The decisions a policy is asked for (its rules are `allow_<decision>` and
// `deny_<decision>`), what a denial does, and whether only built-in modes' runs make it (`builtIn`:
// a repo's allow rule for it is ignored). Keys and functions: written when shown.
const DECISIONS: {
  decision: string;
  name: Plain;
  denies: Plain;
  refused: (until: string) => string;
  builtIn?: boolean;
  // Without a deny rule: what still refuses it, when its allow rules depend on the input
  // (`files`: those that apply).
  allows?: (files: PolicyFile[]) => string;
}[] = [
  {
    decision: "run",
    name: "policyConfig.decisionRun",
    denies: "policyConfig.deniesRun",
    refused: (until) => t("policyConfig.refusedRun", { until }),
    // Deckhand's run.rego named only while it is the operator's layer's one allow_run.
    allows: (files) => {
      const allowing = files.filter(
        (f) => f.active && f.source !== "repo" && f.rules.includes("allow_run"),
      );
      const own = allowing.length === 1 && allowing[0].source === "deckhand";
      return t(own ? "policyConfig.allowsRunOwn" : "policyConfig.allowsRun");
    },
  },
  {
    decision: "merge",
    builtIn: true,
    name: "policyConfig.decisionMerge",
    denies: "policyConfig.deniesMerge",
    refused: (until) => t("policyConfig.refusedMerge", { until }),
  },
  {
    decision: "review",
    builtIn: true,
    name: "policyConfig.decisionReview",
    denies: "policyConfig.deniesReview",
    refused: (until) => t("policyConfig.refusedReview", { until }),
  },
  {
    decision: "fix",
    builtIn: true,
    name: "policyConfig.decisionFix",
    denies: "policyConfig.deniesFix",
    refused: (until) => t("policyConfig.refusedFix", { until }),
  },
  {
    decision: "link_branch",
    name: "policyConfig.decisionLinkBranch",
    denies: "policyConfig.deniesLinkBranch",
    refused: (until) => t("policyConfig.refusedLinkBranch", { until }),
  },
  {
    decision: "request_review",
    name: "policyConfig.decisionRequestReview",
    denies: "policyConfig.deniesRequestReview",
    refused: (until) => t("policyConfig.refusedRequestReview", { until }),
  },
  {
    decision: "github",
    name: "policyConfig.decisionGithub",
    denies: "policyConfig.deniesGithub",
    refused: (until) => t("policyConfig.refusedGithub", { until }),
    allows: () => t("policyConfig.allowsGithub"),
  },
  {
    decision: "push",
    name: "policyConfig.decisionPush",
    denies: "policyConfig.deniesPush",
    refused: (until) => t("policyConfig.refusedPush", { until }),
    allows: () => t("policyConfig.allowsPush"),
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
  if (!bad.length) return t("policyConfig.untilChecked");
  return t("policyConfig.untilCompiles", { files: bad.join(t("list.comma")), count: bad.length });
}

// Identifiers the model's paragraphs name, each in <code>, by its own name.
const code = <N extends string>(...names: N[]) =>
  Object.fromEntries(names.map((n) => [n, <code>{n}</code>])) as Record<N, VNode>;

export function PolicyConfig({ config }: { config: RepoConfig }) {
  const { files, errors: all, warnings } = config.policies;
  // The check's errors that refuse, and those that only say a rule is ignored: said with the
  // warnings, marked on their line.
  const errors = refusing(all);
  const ignored = all.filter((e) => e.ignored);
  // The source folds opened or closed by hand, over each one's default: open with an error.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  useEffect(() => setOpened({}), [config.repo.repo]);
  const isOpen = (f: PolicyFile) => opened[keyOf(f)] ?? errorsOf(all, f).length > 0;
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
          <b>{t("policyConfig.none")}</b>{" "}
          {tx("policyConfig.noneHelp", {
            files: <code>.deckhand/policy/*.rego</code>,
            base: <code>{config.base}</code>,
          })}
        </p>
      </div>
    );
  }
  const rows = ordered(files);
  const from = (source: PolicyFile["source"]) => files.filter((f) => f.source === source).length;
  const counts = [
    ...(from("deckhand") ? [t("policyConfig.fromDeckhand", { count: from("deckhand") })] : []),
    t("policyConfig.fromOperator", { count: from("operator") }),
    t("policyConfig.fromRepo", { count: from("repo") }),
  ].join(t("list.comma"));
  return (
    <div class={styles.page}>
      {errors.length > 0 && <Banner files={files} errors={errors} goLine={goLine} />}
      {warnings.length + ignored.length > 0 && (
        <section class={styles.warnings} aria-label={t("policyConfig.warnings")}>
          <Warning size={16} />
          <ul>
            {ignored.map((e) => (
              <li key={e.text}>
                <b>{t("policyConfig.ignored")}</b> · {e.text}
              </li>
            ))}
            {warnings.map((w) => (
              <li key={w}>
                <b>{t("policyConfig.warning")}</b> · {w}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p class={styles.model}>
        {tx("policyConfig.model", {
          allow: <b>allow</b>,
          deny: <b>deny</b>,
          base: <code>{config.base}</code>,
          modes: <code>modes:</code>,
        })}
      </p>
      <p class={styles.model}>
        {tx("policyConfig.githubInput", {
          ...code("allow_github", "deny_github", "action", "target", "change", "read_checks"),
          ...code("read_projects", "mode", "custom_mode", "reason", "conflict"),
          modes: <code>modes:</code>,
          review_fix: <code>review-fix</code>,
          ci_fix: <code>ci-fix</code>,
        })}{" "}
        <a href={GITHUB_INPUT} target="_blank" rel="noreferrer">
          {t("policyConfig.githubInputLink")}
        </a>
      </p>
      <p class={styles.model}>
        {tx(
          "policyConfig.pushInput",
          code("allow_push", "deny_push", "branch", "created", "deleted", "default_branch"),
        )}{" "}
        <a href={PUSH_INPUT} target="_blank" rel="noreferrer">
          {t("policyConfig.pushInputLink")}
        </a>
      </p>
      <p class={styles.model}>
        {tx("policyConfig.runInput", {
          ...code("allow_run", "deny_run", "mode", "custom_mode", "trigger", "comment"),
          ...code("dashboard", "inbox", "discussion", "sender", "target", "kind", "labels"),
          ...code("author"),
        })}{" "}
        <a href={RUN_INPUT} target="_blank" rel="noreferrer">
          {t("policyConfig.runInputLink")}
        </a>
      </p>
      <section class={styles.decisions} aria-label={t("policyConfig.decisions")}>
        {DECISIONS.map((d) => (
          <DecisionCard key={d.decision} decision={d} files={files} errors={errors} />
        ))}
      </section>
      <section class={styles.card} aria-labelledby="policy-files">
        <div class={styles.cardHead}>
          <h2 id="policy-files">{t("policyConfig.files")}</h2>
          <span class={styles.note}>
            {t("policyConfig.filesNote", { count: files.length, counts })}
          </span>
        </div>
        {files.length > 0 && (
          <>
            <div class={`${styles.file} ${styles.fileHead}`} aria-hidden="true">
              <span>{t("policyConfig.columnFile")}</span>
              <span>{t("policyConfig.columnFrom")}</span>
              <span>{t("policyConfig.columnEffect")}</span>
              <span>{t("policyConfig.columnRules")}</span>
              <span>{t("policyConfig.columnCompiles")}</span>
            </div>
            <ul class={styles.files} aria-label={t("policyConfig.files")}>
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
              .sort((a, b) => +!errorsOf(all, a).length - +!errorsOf(all, b).length)
              .map((f) => (
                <Source
                  key={keyOf(f)}
                  file={f}
                  by={replacedBy(files, f)}
                  errors={errorsOf(all, f)}
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
  // The file of its layer: a repo's and Deckhand's may share a name.
  const fileOf = (e: PolicyError) => files.find((f) => isOf(e, f)) ?? null;
  const at = (e: PolicyError) => `${e.file}${e.row !== null ? `:${e.row}` : ""}`;
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
          {one && first.file
            ? tx("policyConfig.fileFails", { file: <code>{at(first)}</code> })
            : one
              ? t("policyConfig.cantCheck")
              : t("policyConfig.errors", { count: errors.length })}
        </b>
        <span>{t("policyConfig.failClosed", { count: errors.length })}</span>
        {one && first.file ? (
          lineLink(first, t("policyConfig.lineLink", { row: String(first.row) }))
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
                {lineLink(e, t("policyConfig.line", { row: String(e.row) }))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// A rule's name that may wrap after its underscores (deny_request_review in a narrow card),
// rather than anywhere in a word; in a block of its own (styles.rule), so a short one moves to
// the next line whole.
const breakable = (rule: string) =>
  rule.split("_").flatMap((part, i) => (i ? ["_", <wbr key={i} />, part] : [part]));

// A decision: each layer's allow and deny rules and their files, and whether it is refused
// (no allow rule of the operator's, or while the check fails), only allowed (no deny rule), or
// decided by deny rules (active).
function DecisionCard({
  decision: d,
  files,
  errors,
}: {
  decision: (typeof DECISIONS)[number];
  files: PolicyFile[];
  errors: PolicyError[];
}) {
  const [allow, deny] = [`allow_${d.decision}`, `deny_${d.decision}`];
  // The active files of `layer` that define `rule`.
  const defining = (layer: "operator" | "repo", rule: string) =>
    files.filter((f) => f.active && layerOf(f) === layer && f.rules.includes(rule));
  const allowing = defining("operator", allow);
  const denying = [...defining("operator", deny), ...defining("repo", deny)];
  const repoAllowing = defining("repo", allow);
  const refused = errors.length > 0;
  const [tone, label]: [Tone, Plain] = refused
    ? ["err", "policyConfig.refused"]
    : !allowing.length
      ? ["err", "policyConfig.neverAllowed"]
      : denying.length
        ? ["done", "policyConfig.active"]
        : ["idle", "policyConfig.noDenyRule"];
  const text = refused
    ? d.refused(failing(files, errors))
    : !allowing.length
      ? d.refused(t("policyConfig.untilAllowed"))
      : denying.length
        ? t(d.denies)
        : (d.allows?.(files) ?? t("policyConfig.nothingDenies"));
  // A layer's rule as the note says it: its definitions, and their files.
  const said = (rule: string, list: PolicyFile[]) =>
    list.length
      ? `${rule} ×${list.reduce((n, f) => n + definitions(f, rule), 0)} (${list.map((f) => f.name).join(t("list.comma"))})`
      : t("policyConfig.noRule", { rule });
  const repoAllow = !repoAllowing.length
    ? t("policyConfig.noAllowRule")
    : t(d.builtIn ? "policyConfig.repoAllowIgnored" : "policyConfig.repoAllowOwn", {
        said: said(allow, repoAllowing),
      });
  return (
    <div class={styles.decision}>
      <span class={styles.decisionHead}>
        <span class={styles.key}>
          {t(d.name)} · <span class={styles.rule}>{breakable(d.decision)}</span>
        </span>
        <StatusBadge tone={tone} label={t(label)} />
      </span>
      <span class={styles.text}>{text}</span>
      <span class={styles.note}>
        {t("policyConfig.operatorRules", {
          allow: said(allow, allowing),
          deny: said(deny, defining("operator", deny)),
        })}
      </span>
      <span class={styles.note}>
        {t("policyConfig.repoRules", {
          allow: repoAllow,
          deny: said(deny, defining("repo", deny)),
        })}
      </span>
    </div>
  );
}

// What a file does to the defaults: `by`, the source of the file that replaces it.
function effectOf(f: PolicyFile, by: PolicyFile["source"] | null): string {
  if (by) return t("policyConfig.replacedBy", { owner: t(OWNERS[by]) });
  if (f.replaces) return t("policyConfig.replaces", { owner: t(OWNERS[f.replaces]) });
  return t(f.source === "repo" ? "policyConfig.added" : "policyConfig.kept");
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
      ? ["err", t("policyConfig.compilesError")]
      : unknown
        ? ["idle", t("policyConfig.compilesUnknown")]
        : ["done", t("policyConfig.compilesYes")];
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
        <span class={`${styles.tag} ${f.source === "repo" ? styles.repo : ""}`}>
          {t(TAGS[f.source])}
        </span>
      </span>
      <span class={styles.effect}>{effect}</span>
      <span class={styles.rules}>
        {f.rules.length
          ? f.rules.map((r) => `${r} ×${definitions(f, r)}`).join(t("list.comma"))
          : t("policyConfig.noRules")}
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
    ...(f.replaces
      ? [t("policyConfig.sourceReplaces", { owner: t(OWNERS[f.replaces]), name: f.name })]
      : []),
    ...(by ? [t("policyConfig.sourceReplacedBy", { owner: t(OWNERS[by]) })] : []),
    t("policyConfig.lines", { count: lines.length }),
    ...(f.truncated ? [t("policyConfig.truncated")] : []),
    ...(errors.length ? [t("policyConfig.sourceErrors", { count: errors.length })] : []),
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
            {t("policyConfig.edit")}
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
        <b>{t("policyConfig.try")}</b>
        <span>
          {tx("policyConfig.tryHelp", { command: <code class={styles.command}>{COMMAND}</code> })}
        </span>
      </div>
      <Button size="small" onClick={async () => setCopied(await copyText(COMMAND))}>
        {t(
          copied === null
            ? "policyConfig.copy"
            : copied
              ? "policyConfig.copied"
              : "policyConfig.copyFailed",
        )}
      </Button>
    </section>
  );
}
