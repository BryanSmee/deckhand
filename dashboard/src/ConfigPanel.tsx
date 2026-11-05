// One repository's config (docs/design/dashboard-redesign.md › Pages › Settings › A repository's
// config): where it was read, Read again and Edit on GitHub, its tabs (Config, Policies:
// PolicyConfig.tsx, Capabilities: Capabilities.tsx); then what stops or worries its runs (each error with its key, its fix and a
// link to its line, the warnings, the auto-merge risk), or, when all is fine, a green banner and
// the facts at a glance, with the details folded but for what the repo sets. Then what its runs
// get, each value tagged with its source and filtered by it, the hosts, mounts, the operator's
// grant and the raw .deckhand.yaml, its bad lines marked. Read from GitHub when it opens and on
// Read again; changing it is a commit on the default branch.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useRepoConfig } from "./api";
import { Capabilities, capabilityTrouble } from "./Capabilities";
import { ago, type Tone } from "./format";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import { copyText } from "./logExport";
import { PolicyConfig, policyTrouble, refusing } from "./PolicyConfig";
import { RepoBadge } from "./RepoBadge";
import { type ConfigTab, formatRoute } from "./route";
import type { Grant, MountRow, Repo, RepoConfig, SettingRow, Source } from "./types";
import { Button, buttonClass } from "./ui/Button";
import { Segmented } from "./ui/Choice";
import { Code, linesOf } from "./ui/Code";
import { Count } from "./ui/Count";
import { Alert, Check, ChevronRight, External, Sync, Warning } from "./ui/icons";
import { StatusBadge, toneClass } from "./ui/Status";
import tabs from "./ui/Tabs.module.css";
import styles from "./ConfigPanel.module.css";

// A source's tag and its tone: unknown asks for a look (a grant to fix), unlike an unknown
// status; the operator's is quiet, most values are. Keys, written when shown.
const TAGS: Record<Source, [Plain, Tone | "quiet"]> = {
  repo: ["config.tagRepo", "run"],
  operator: ["config.tagOperator", "quiet"],
  refused: ["config.tagRefused", "err"],
  unknown: ["config.tagUnknown", "input"],
};

function Tag({ source }: { source: Source }) {
  const [label, tone] = TAGS[source];
  const cls = tone === "quiet" ? styles.quiet : toneClass(tone);
  return <span class={`${styles.tag} ${cls}`}>{t(label)}</span>;
}

// What stops its runs, each with the key it is about, how to fix it and its line in the file.
interface Problem {
  key: string | null;
  message: ComponentChildren;
  // The message as the file's marked line says it.
  text: string;
  fix?: ComponentChildren;
  line: number | null;
}

// The file's errors, the grants' (which the operator fixes), and what the repo asks for that
// isn't granted.
function problemsOf(config: RepoConfig): Problem[] {
  const ungranted = tx("config.ungranted", {
    allowGrant: <code>allow_grant</code>,
    policy: <code>policy/</code>,
    file: <code>.deckhand.yaml</code>,
  });
  const problems: Problem[] = config.errors.map((e) => ({
    key: e.key,
    message: e.message,
    text: e.message,
    fix: e.fix,
    line: e.line,
  }));
  const grantsError = config.grantsError;
  if (grantsError) {
    const { file, message: error } = grantsError;
    problems.push({
      key: null,
      message: file
        ? tx(grantsError.everyRepo ? "config.grantsFileErrorAny" : "config.grantsFileErrorThis", {
            file: <code>{file}</code>,
            error,
          })
        : t(grantsError.everyRepo ? "config.grantsErrorAny" : "config.grantsErrorThis", { error }),
      text: grantsError.message,
      fix: t("config.grantsFix"),
      line: null,
    });
  }
  for (const s of config.effective.settings.filter((s) => s.source === "refused")) {
    const text = t("config.settingRefused", { note: s.note ?? t("config.needsGrant") });
    problems.push({ key: s.key, message: text, text, fix: ungranted, line: s.line });
  }
  for (const m of config.effective.mounts.filter((m) => m.source === "refused")) {
    problems.push({
      key: "mounts",
      message: tx("config.mountRefused", { path: <code>{m.path}</code>, note: m.note ?? "" }),
      text: t("config.mountRefused", { path: m.path, note: m.note ?? "" }),
      fix: ungranted,
      line: m.line,
    });
  }
  return problems;
}

// The page's parts, for its links and folds. A fine config folds hosts, mounts and the grant
// into one ("access").
type Part = "problems" | "runs" | "hosts" | "mounts" | "grant" | "access" | "yaml";
const anchor = (part: Part) => `config-${part}`;
const lineAnchor = (n: number) => `config-line-${n}`;

// After the render that opens its fold.
function scrollTo(id: string) {
  setTimeout(() => document.getElementById(id)?.scrollIntoView?.({ block: "start" }));
}

interface Props {
  repo: string;
  // Its tab, when not Config.
  tab?: ConfigTab;
  // Its row in the list, if listed yet: the status until the config is read.
  row: Repo | null;
  onRow: (row: Repo) => void;
  onBack: () => void;
  now: number;
}

// Its tabs: links, so each has its address (route.ts). Labels are keys, written when shown.
const TABS: { id: ConfigTab | undefined; label: Plain }[] = [
  { id: undefined, label: "config.tabConfig" },
  { id: "policies", label: "config.tabPolicies" },
  { id: "capabilities", label: "config.tabCapabilities" },
];

export function ConfigPanel({ repo, tab, row, onRow, onBack, now }: Props) {
  const { config, error, loading, refresh } = useRepoConfig(repo, onRow);
  const status = (config?.repo ?? row)?.status;
  // The folds opened or closed by hand, over each one's default.
  const [opened, setOpened] = useState<Partial<Record<Part, boolean>>>({});
  useEffect(() => setOpened({}), [repo]);
  const toggle = (part: Part) => (open: boolean) => setOpened((o) => ({ ...o, [part]: open }));
  const repositories = formatRoute(ROUTE);
  const trouble = config ? (policyTrouble(config.policies) ?? capabilityTrouble(config)) : null;
  // The modes whose runs wouldn't start (capabilities that don't hold).
  const stopped = config?.capabilities.modes.filter((m) => m.errors.length).length ?? 0;
  return (
    <div class={styles.panel}>
      <header class={styles.head}>
        <div class={styles.headText}>
          <nav class={styles.crumbs} aria-label={t("config.breadcrumb")}>
            <a href={repositories}>{t("config.crumbSettings")}</a> ›{" "}
            <a
              href={repositories}
              onClick={(e) => {
                e.preventDefault();
                onBack();
              }}
            >
              {t("config.crumbRepositories")}
            </a>{" "}
            ›
          </nav>
          <div class={styles.titleRow}>
            <h1>{repo}</h1>
            {status && <RepoBadge status={status} />}
            {trouble && <StatusBadge tone="err" label={trouble} />}
          </div>
          {config && (
            <span class={styles.read}>
              {config.file
                ? tx("config.readFile", {
                    file: <code>.deckhand.yaml</code>,
                    base: <code>{config.base}</code>,
                    sha: <code>{config.file.sha.slice(0, 7)}</code>,
                    when: ago(config.readAt, now),
                  })
                : tx("config.readNoFile", {
                    file: <code>.deckhand.yaml</code>,
                    base: <code>{config.base}</code>,
                    when: ago(config.readAt, now),
                  })}
            </span>
          )}
        </div>
        <span class={styles.actions}>
          <Button
            size="small"
            icon={<Sync size={14} />}
            pending={loading && !!config}
            pendingLabel={t("config.reading")}
            disabled={loading}
            onClick={refresh}
            title={t("config.readAgainHelp")}
          >
            {t("config.readAgain")}
          </Button>
          {config?.file && (
            <a
              class={buttonClass("secondary", "small")}
              href={config.file.editUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("config.editOnGithub")}
              <External size={13} />
            </a>
          )}
        </span>
        <nav class={`${tabs.tabs} ${styles.tabs}`} aria-label={t("config.tabs")}>
          {TABS.map((it) => (
            <a
              key={it.label}
              class={tabs.tab}
              href={formatRoute({ ...ROUTE, config: repo, ...(it.id ? { configTab: it.id } : {}) })}
              aria-current={it.id === tab ? "page" : undefined}
            >
              {t(it.label)}
              {it.id === "policies" && !!config && refusing(config.policies.errors).length > 0 && (
                <>
                  {" "}
                  <Count n={refusing(config.policies.errors).length} class={styles.errCount} />
                </>
              )}
              {it.id === "capabilities" && stopped > 0 && (
                <>
                  {" "}
                  <Count n={stopped} class={styles.errCount} />
                </>
              )}
            </a>
          ))}
        </nav>
      </header>
      {error && (
        <p class={styles.failed} role="alert">
          {t("config.unreadable", { error })}
        </p>
      )}
      {!config && loading && <p class={styles.loading}>{t("config.readingGithub")}</p>}
      {config &&
        (tab === "policies" ? (
          <PolicyConfig config={config} />
        ) : tab === "capabilities" ? (
          <Capabilities config={config} />
        ) : (
          <Body config={config} opened={opened} toggle={toggle} setOpened={setOpened} />
        ))}
    </div>
  );
}

const ROUTE = { repo: null, task: null, run: null, page: "settings" } as const;

interface BodyProps {
  config: RepoConfig;
  opened: Partial<Record<Part, boolean>>;
  toggle: (part: Part) => (open: boolean) => void;
  setOpened: (f: (o: Partial<Record<Part, boolean>>) => Partial<Record<Part, boolean>>) => void;
}

function Body({ config, opened, toggle, setOpened }: BodyProps) {
  const problems = problemsOf(config);
  const { settings, hosts, mounts, grant } = config.effective;
  // Nothing to say but that its runs start: the details fold. The policies' errors don't stop
  // runs: they have their own tab.
  const fine = !!config.file && !problems.length && !config.warnings.length;
  const fromRepo = settings.filter((s) => s.source !== "operator");
  const repoMounts = mounts.length > 0;
  // A fold's state: by hand, else open for what the repo sets (or always, with problems).
  const defaults: Partial<Record<Part, boolean>> = fine
    ? { runs: fromRepo.length > 0, access: repoMounts, yaml: false }
    : { yaml: true };
  const isOpen = (part: Part) => opened[part] ?? defaults[part] ?? true;
  // A link to a part (or a line) opens its fold, then shows it.
  const go = (part: Part, id = anchor(part)) => {
    const fold = fine && ["hosts", "mounts", "grant"].includes(part) ? "access" : part;
    setOpened((o) => ({ ...o, [fold]: true }));
    scrollTo(id);
  };
  const goLine = (n: number) => go("yaml", lineAnchor(n));
  const marks = new Map<number, string[]>();
  for (const p of problems) {
    if (p.line !== null) marks.set(p.line, [...(marks.get(p.line) ?? []), p.text]);
  }
  const parts: [Part, string, number?][] = [
    ...(problems.length
      ? [["problems", t("config.tocProblems"), problems.length] as [Part, string, number]]
      : []),
    ["runs", t("config.runsGet")],
    ["hosts", t("config.tocHosts")],
    ...(repoMounts ? [["mounts", t("config.mounts")] as [Part, string]] : []),
    ["grant", t("config.grant")],
    ...(config.file ? [["yaml", ".deckhand.yaml"] as [Part, string]] : []),
  ];
  const access = (
    <>
      <Hosts hosts={hosts} />
      {repoMounts && <Mounts mounts={mounts} />}
      <GrantSection grant={grant} />
    </>
  );
  return (
    <div class={styles.layout}>
      <main class={styles.main}>
        {config.repo.autoMerge && <AutoMergeBox isPrivate={config.repo.private} />}
        {problems.length > 0 && (
          <section id={anchor("problems")} class={styles.problems} role="alert">
            <h2>
              <Alert size={18} />
              {t("config.problemsTitle")}
            </h2>
            <ul>
              {problems.map((p, i) => (
                <li key={i}>
                  <span class={styles.problem}>
                    {p.key && (
                      <>
                        <code class={styles.key}>{p.key}</code>:{" "}
                      </>
                    )}
                    {p.message}
                  </span>
                  {p.line !== null && (
                    <button type="button" class={styles.lineLink} onClick={() => goLine(p.line!)}>
                      {t("config.line", { line: p.line })}
                    </button>
                  )}
                  {p.fix && <span class={styles.fix}>{p.fix}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {config.warnings.length > 0 && (
          <section class={styles.warnings} aria-label={t("config.warnings")}>
            <Warning size={16} />
            <ul>
              {config.warnings.map((w, i) => (
                <li key={i}>
                  <b>{t("config.warning")}</b> ·{" "}
                  {w.key && (
                    <>
                      <code>{w.key}</code>:{" "}
                    </>
                  )}
                  {w.message}
                  {w.line !== null && config.file && (
                    <>
                      {" "}
                      <button type="button" class={styles.lineLink} onClick={() => goLine(w.line!)}>
                        {t("config.line", { line: w.line })}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {fine && <Fine config={config} />}
        {!config.file && (
          <p class={styles.muted}>{tx("config.noFile", { file: <code>.deckhand.yaml</code> })}</p>
        )}

        <RunsGet settings={settings} fine={fine} open={isOpen("runs")} onToggle={toggle("runs")} />

        {fine ? (
          <Fold
            part="access"
            title={t("config.accessFold")}
            meta={[
              t("config.hostsCount", { count: hosts.length }),
              repoMounts ? t("config.mountsCount", { count: mounts.length }) : t("config.noMounts"),
              ...(grant?.allowResearch ? [t("config.researchOn")] : []),
            ].join(" · ")}
            open={isOpen("access")}
            onToggle={toggle("access")}
          >
            <div class={styles.foldBody}>{access}</div>
          </Fold>
        ) : (
          access
        )}

        {config.file && (
          <Yaml
            text={config.file.text}
            marks={marks}
            open={isOpen("yaml")}
            onToggle={toggle("yaml")}
          />
        )}
      </main>
      <aside class={styles.side}>
        <nav class={styles.toc} aria-label={t("config.onThisPage")}>
          <h2>{t("config.onThisPage")}</h2>
          {parts.map(([part, label, count]) => (
            <button key={part} type="button" onClick={() => go(part)}>
              {label}
              {count !== undefined && <span class={styles.tocCount}>{count}</span>}
            </button>
          ))}
        </nav>
        <div class={styles.changing}>
          <h2>{t("config.changing")}</h2>
          <p>
            {tx("config.changingHelp", {
              file: <code>.deckhand.yaml</code>,
              base: <code>{config.base}</code>,
            })}
          </p>
        </div>
      </aside>
    </div>
  );
}

// A fine config: says so, then the facts at a glance.
function Fine({ config }: { config: RepoConfig }) {
  const { settings, hosts, mounts } = config.effective;
  const value = (key: string) => settings.find((s) => s.key === key);
  const model = value("model")?.value;
  const effort = value("effort")?.value;
  const parallel = value("max_parallel");
  return (
    <>
      <section class={styles.fine} role="status">
        <span class={styles.fineIcon}>
          <Check size={18} />
        </span>
        <div>
          <h2>{t("config.fineTitle")}</h2>
          <p>{t("config.fineText")}</p>
        </div>
      </section>
      <dl class={styles.facts} aria-label={t("config.glance")}>
        <div>
          <dt>{t("config.glanceModel")}</dt>
          <dd>
            {[model, effort && t("config.glanceEffort", { effort })].filter(Boolean).join(" · ")}
          </dd>
        </div>
        <div>
          <dt>{t("config.glanceParallel")}</dt>
          <dd>
            {parallel?.value}
            {parallel?.note && <span class={styles.factNote}> · {parallel.note}</span>}
          </dd>
        </div>
        <div>
          <dt>{t("config.glanceUsers")}</dt>
          <dd>{value("users")?.value}</dd>
        </div>
        <div>
          <dt>{t("config.glanceAccess")}</dt>
          <dd>
            {hosts.length} · {mounts.length || t("config.none")}
          </dd>
        </div>
      </dl>
    </>
  );
}

// A card that folds: its title, a meta line, and its body when open.
function Fold({
  part,
  title,
  meta,
  open,
  onToggle,
  actions,
  children,
}: {
  part: Part;
  title: ComponentChildren;
  meta?: ComponentChildren;
  open: boolean;
  onToggle: (open: boolean) => void;
  // At the summary's end; a click there doesn't fold it.
  actions?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <details
      id={anchor(part)}
      class={`${styles.card} ${styles.fold}`}
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span class={styles.chevron}>
          <ChevronRight size={14} />
        </span>
        <h2>{title}</h2>
        {meta && <span class={styles.meta}>{meta}</span>}
        {actions}
      </summary>
      {children}
    </details>
  );
}

type Filter = "all" | Source;

// Labels are keys, written when shown.
const FILTERS: [Filter, Plain][] = [
  ["all", "config.filterAll"],
  ["repo", "config.filterRepo"],
  ["operator", "config.filterOperator"],
  ["refused", "config.filterRefused"],
  ["unknown", "config.filterUnknown"],
];

// What its runs get, filtered by source. A fine config folds it, and shows the repo's own
// values until asked for the operator's.
function RunsGet({
  settings,
  fine,
  open,
  onToggle,
}: {
  settings: SettingRow[];
  fine: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [all, setAll] = useState(false);
  const count = (f: Filter) =>
    f === "all" ? settings.length : settings.filter((s) => s.source === f).length;
  const own = settings.filter((s) => s.source !== "operator");
  if (fine) {
    const shown = all || !own.length ? settings : own;
    const more = settings.length - shown.length;
    return (
      <Fold
        part="runs"
        title={t("config.runsGet")}
        meta={t("config.runsMeta", { count: settings.length, own: own.length })}
        open={open}
        onToggle={onToggle}
      >
        <Rows rows={shown} />
        {more > 0 && (
          <button type="button" class={styles.more} onClick={() => setAll(true)}>
            {t("config.showMore", { count: more })}
          </button>
        )}
      </Fold>
    );
  }
  const shown = filter === "all" ? settings : settings.filter((s) => s.source === filter);
  return (
    <section id={anchor("runs")} class={styles.section}>
      <div class={styles.sectionHead}>
        <h2>{t("config.runsGet")}</h2>
        <Segmented
          label={t("config.show")}
          class={styles.filter}
          value={filter}
          onChange={setFilter}
          options={FILTERS.filter(
            ([f]) => f === "all" || f === "repo" || f === "operator" || count(f) > 0,
          ).map(([value, label]) => ({
            value,
            label: t(label),
            // A space: "Refused 1" to screen readers; the flex gap shows it.
            extra: (
              <>
                {" "}
                <span class={`${styles.segCount} ${value === "refused" ? styles.segErr : ""}`}>
                  {count(value)}
                </span>
              </>
            ),
          }))}
        />
      </div>
      <div class={styles.card}>
        <Rows rows={shown} />
        {!shown.length && <p class={styles.empty}>{t("config.noRows")}</p>}
      </div>
      <p class={styles.aside}>{t("config.narrowOnly")}</p>
    </section>
  );
}

function Rows({ rows }: { rows: SettingRow[] }) {
  return (
    <ul class={styles.rows} aria-label={t("config.settingsList")}>
      {rows.map((s) => (
        <Row key={s.key} name={s.key} value={s.value} note={s.note} source={s.source} />
      ))}
    </ul>
  );
}

// A row: its name, its value and note, its source's tag. Refused ones are tinted.
function Row({
  name,
  value,
  note,
  source,
}: {
  name: ComponentChildren;
  value?: ComponentChildren;
  note?: ComponentChildren;
  source: Source;
}) {
  return (
    <li class={`${styles.row} ${source === "refused" ? styles.refused : ""}`}>
      <code class={styles.key}>{name}</code>
      <span class={styles.cell}>
        {value !== undefined && <span class={styles.value}>{value}</span>}
        {note && <span class={styles.note}>{note}</span>}
      </span>
      <Tag source={source} />
    </li>
  );
}

function Hosts({ hosts }: { hosts: RepoConfig["effective"]["hosts"] }) {
  return (
    <section id={anchor("hosts")} class={styles.section}>
      <h2>{t("config.hostsTitle")}</h2>
      <ul class={`${styles.card} ${styles.rows}`} aria-label={t("config.hostsList")}>
        {hosts.map((h) => (
          <Row key={h.host} name={h.host} note={h.note} source={h.source} />
        ))}
      </ul>
    </section>
  );
}

function Mounts({ mounts }: { mounts: MountRow[] }) {
  return (
    <section id={anchor("mounts")} class={styles.section}>
      <h2>{t("config.mounts")}</h2>
      <ul class={`${styles.card} ${styles.rows}`} aria-label={t("config.mounts")}>
        {mounts.map((m) => (
          <Row
            key={m.path}
            name={m.path}
            value={t(m.readOnly ? "config.readOnly" : "config.readWrite")}
            note={m.note}
            source={m.source}
          />
        ))}
      </ul>
    </section>
  );
}

function GrantSection({ grant }: { grant: Grant | null }) {
  return (
    <section id={anchor("grant")} class={styles.section}>
      <h2>{t("config.grant")}</h2>
      {grant ? <GrantCard grant={grant} /> : <p class={styles.muted}>{t("config.grantUnknown")}</p>}
    </section>
  );
}

// Its switches as on/off pills, the grants the operator's policies give (`allow_grant`), then
// what its files list.
function GrantCard({ grant }: { grant: Grant }) {
  const { cpus, memory, pids } = grant.limits;
  const flags: [string, boolean | string][] = [
    ["dockerfile", grant.allowDockerfile],
    ["branch_docker_images", grant.allowBranchDockerImages],
    ["docker", grant.allowDocker],
    ["research", grant.allowResearch],
    ["workflows", grant.allowWorkflows],
    ["workflow_secrets", grant.allowWorkflowSecrets],
    ["auto_merge", grant.allowAutoMerge],
    ["machines", grant.allowMachines],
  ];
  const policies = grant.grantFiles.length
    ? grant.grantFiles.map((f) => `policy/${f}`).join(", ")
    : t("config.grantNoPolicy");
  const lists: [string, string][] = [
    ["files", grant.files.join(", ") || t("config.grantNoFile")],
    ["policies", policies],
    ["hosts", grant.hosts.join(", ") || t("config.none")],
  ];
  if (grant.cachedHosts.length) lists.push(["cached_hosts", grant.cachedHosts.join(", ")]);
  if (grant.mounts.length) {
    const roots = grant.mounts.map((m) =>
      m.readOnly ? t("config.grantRootReadOnly", { root: m.root }) : m.root,
    );
    lists.push(["mounts", roots.join(", ")]);
  }
  if (grant.allowProjects.length) lists.push(["allow_projects", grant.allowProjects.join(", ")]);
  lists.push(["limits", t("config.grantLimits", { cpus, memory, pids })]);
  return (
    <div class={styles.card}>
      <ul class={styles.flags} aria-label={t("config.grantSwitches")}>
        {flags.map(([key, value]) => (
          <li key={key}>
            <code class={styles.key}>{key}</code>
            <span class={`${styles.pill} ${value ? styles.on : styles.off}`}>
              {value === true ? t("config.on") : value === false ? t("config.off") : value}
            </span>
          </li>
        ))}
      </ul>
      <ul class={styles.lists} aria-label={t("config.grantLists")}>
        {lists.map(([key, value]) => (
          <li key={key}>
            <code class={styles.key}>{key}</code>
            <span>{value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The file with its line numbers, each line with errors marked and their messages under it.
function Yaml({
  text,
  marks,
  open,
  onToggle,
}: {
  text: string;
  marks: Map<number, string[]>;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  // Whether the last Copy worked (null: none yet).
  const [copied, setCopied] = useState<boolean | null>(null);
  const lines = linesOf(text);
  const bad = [...marks.values()].flat().length;
  return (
    <Fold
      part="yaml"
      title={<code>.deckhand.yaml</code>}
      meta={[
        t("config.yamlLines", { count: lines.length }),
        ...(bad ? [t("config.yamlErrors", { count: bad })] : []),
      ].join(" · ")}
      open={open}
      onToggle={onToggle}
      actions={
        <Button
          size="small"
          variant="ghost"
          class={styles.copy}
          onClick={async (e) => {
            e.preventDefault();
            setCopied(await copyText(text));
          }}
        >
          {t(copied === null ? "config.copy" : copied ? "config.copied" : "config.copyFailed")}
        </Button>
      }
    >
      <Code lines={lines} marks={marks} lineId={lineAnchor} />
    </Fold>
  );
}

const AUTO_MERGE_DOCS =
  "https://github.com/BryanSmee/deckhand/blob/main/docs/security.md#auto-merge";

// What auto-merge gives up, at the top of the panel: it is on (granted and in the config).
function AutoMergeBox({ isPrivate }: { isPrivate: boolean }) {
  return (
    <section class={styles.autoMerge} role="note">
      <h2>
        <Warning size={18} />
        {t("config.autoMergeTitle")}
      </h2>
      <p>{t("config.autoMergeText")}</p>
      {!isPrivate && (
        <p>
          {tx("config.autoMergePublic", {
            lead: <strong>{t("config.autoMergePublicLead")}</strong>,
          })}
        </p>
      )}
      <p>
        <a href={AUTO_MERGE_DOCS} target="_blank" rel="noreferrer">
          {t("config.autoMergeDocs")}
        </a>
      </p>
    </section>
  );
}
