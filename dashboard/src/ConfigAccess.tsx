// The config page's access parts (ConfigPanel.tsx): the hosts its sandboxes reach, the host
// mounts and context repos it asks for, each granted or refused, and the operator's grant; and
// the rows and source tags the page's tables share.
import type { ComponentChildren } from "preact";
import type { Tone } from "./format";
import { t, tx } from "./i18n";
import type { Plain } from "./locales";
import type { ContextRow, Grant, MountRow, RepoConfig, Source } from "./types";
import { toneClass } from "./ui/Status";
import styles from "./ConfigPanel.module.css";

// The page's parts, for its links and folds. A fine config folds hosts, mounts, context repos
// and the grant into one ("access").
export type Part =
  "problems" | "runs" | "hosts" | "mounts" | "context" | "grant" | "access" | "yaml";
export const ACCESS: Part[] = ["hosts", "mounts", "context", "grant"];
export const anchor = (part: Part) => `config-${part}`;

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

// A row: its name, its value and note, its source's tag. Refused ones are tinted.
export function Row({
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

export function Hosts({ hosts }: { hosts: RepoConfig["effective"]["hosts"] }) {
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

export function Mounts({ mounts }: { mounts: MountRow[] }) {
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

// The repositories its runs read, each at its ref and folder: granted with the operator's pattern
// that lists it, or refused (it stops every run) with why.
export function ContextRepos({ repos }: { repos: ContextRow[] }) {
  return (
    <section id={anchor("context")} class={styles.section}>
      <h2>{t("config.context")}</h2>
      <ul class={`${styles.card} ${styles.rows}`} aria-label={t("config.context")}>
        {repos.map((c) => (
          <Row
            key={c.folder}
            name={c.repo}
            value={tx("config.contextAt", {
              ref: c.ref ? <code>{c.ref}</code> : t("config.contextDefaultBranch"),
              folder: <code>{c.folder}</code>,
            })}
            note={
              c.pattern
                ? tx("config.contextGranted", { pattern: <code>{c.pattern}</code> })
                : c.note
            }
            source={c.source}
          />
        ))}
      </ul>
    </section>
  );
}

export function GrantSection({ grant }: { grant: Grant | null }) {
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
    ? grant.grantFiles.map((f) => `policy/${f}`).join(t("list.comma"))
    : t("config.grantNoPolicy");
  const lists: [string, string][] = [
    ["files", grant.files.join(t("list.comma")) || t("config.grantNoFile")],
    ["policies", policies],
    ["hosts", grant.hosts.join(t("list.comma")) || t("config.none")],
  ];
  if (grant.cachedHosts.length)
    lists.push(["cached_hosts", grant.cachedHosts.join(t("list.comma"))]);
  if (grant.contextRepos.length)
    lists.push(["context_repos", grant.contextRepos.join(t("list.comma"))]);
  if (grant.mounts.length) {
    const roots = grant.mounts.map((m) =>
      m.readOnly ? t("config.grantRootReadOnly", { root: m.root }) : m.root,
    );
    lists.push(["mounts", roots.join(t("list.comma"))]);
  }
  if (grant.allowProjects.length)
    lists.push(["allow_projects", grant.allowProjects.join(t("list.comma"))]);
  lists.push(["limits", t("config.grantLimits", { cpus, memory, pids: String(pids) })]);
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
