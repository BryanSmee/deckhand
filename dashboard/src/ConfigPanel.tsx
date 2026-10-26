// One repository's config, read-only: what stops or worries its runs first (errors, refused
// settings and mounts, warnings), then what its runs get, each value tagged with where it comes
// from, the operator's grant, and the raw .deckhand.yaml. Read from GitHub when it opens and
// on Refresh; changing it is a commit on the default branch.
import { useRepoConfig } from "./api";
import { ago } from "./format";
import { RepoBadge } from "./RepoBadge";
import type { Grant, Policies, Repo, RepoConfig, Source } from "./types";
import controls from "./controls.module.css";
import styles from "./ConfigPanel.module.css";

// A source's tag and its tone: unknown is yellow (a grant to fix), unlike an unknown status.
const TAGS: Record<Source, [string, string]> = {
  repo: ["from repo", controls.run],
  operator: ["from operator", controls.quiet],
  refused: ["refused", controls.err],
  unknown: ["unknown", controls.warn],
};

function Tag({ source }: { source: Source }) {
  const [label, tone] = TAGS[source];
  return <span class={`${styles.tag} ${tone}`}>{label}</span>;
}

interface Props {
  repo: string;
  // Its row in the list, if listed yet: the status until the config is read.
  row: Repo | null;
  onRow: (row: Repo) => void;
  onBack: () => void;
  now: number;
}

export function ConfigPanel({ repo, row, onRow, onBack, now }: Props) {
  const { config, error, loading, refresh } = useRepoConfig(repo, onRow);
  const status = (config?.repo ?? row)?.status;
  const refusedMounts = config?.effective.mounts.filter((m) => m.source === "refused") ?? [];
  const refusedSettings = config?.effective.settings.filter((s) => s.source === "refused") ?? [];
  const refused = refusedSettings.length + refusedMounts.length;
  return (
    <div class={styles.panel}>
      <div class={styles.head}>
        <button type="button" class={styles.back} onClick={onBack}>
          ← Repositories
        </button>
        <h2>
          {repo}
          {status && <RepoBadge status={status} />}
        </h2>
        <div class={styles.toolbar}>
          {config && (
            <span class={styles.read}>
              {config.file ? (
                <>
                  <code>.deckhand.yaml</code> on <code>{config.base}</code>, blob{" "}
                  <code>{config.file.sha.slice(0, 7)}</code> ·{" "}
                  <a href={config.file.url} target="_blank" rel="noreferrer">
                    on GitHub
                  </a>
                </>
              ) : (
                <>
                  No <code>.deckhand.yaml</code> on <code>{config.base}</code>
                </>
              )}{" "}
              · read {ago(config.readAt, now)}
            </span>
          )}
          <button
            type="button"
            class={styles.refresh}
            disabled={loading}
            onClick={refresh}
            title="Read its config from GitHub again"
          >
            {loading && config ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {error && (
          <p class={styles.failed} role="alert">
            Couldn't read it ({error}).
          </p>
        )}
      </div>
      {!config && loading && <p class={styles.muted}>Reading it from GitHub…</p>}
      {config && (
        <>
          {config.repo.autoMerge && (
            <AutoMergeBox
              isPrivate={config.repo.private}
              preview={
                !!config.effective.grant?.allowPreview &&
                !!config.effective.grant.acknowledgeAutoMergePreview
              }
            />
          )}
          {(config.errors.length > 0 || config.grantsError || refused > 0) && (
            <div class={`${styles.box} ${styles.errors}`} role="alert">
              <strong>No run starts until these are fixed</strong>
              <ul>
                {config.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
                {config.grantsError && <GrantsErrorItem error={config.grantsError} />}
                {refusedSettings.map((s) => (
                  <li key={s.key}>
                    {s.key}: {s.note}
                  </li>
                ))}
                {refusedMounts.map((m) => (
                  <li key={m.path}>
                    mounts: <code>{m.path}</code>: {m.note}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {config.warnings.length > 0 && (
            <div class={`${styles.box} ${styles.warnings}`}>
              <strong>Warnings</strong>
              <ul>
                {config.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {!config.file && (
            <p class={styles.muted}>
              Its runs get the operator's defaults: every value below is the operator's.
            </p>
          )}

          <h3>What its runs get</h3>
          <table class={styles.table}>
            <tbody>
              {config.effective.settings.map((s) => (
                <tr key={s.key}>
                  <th scope="row">
                    <code>{s.key}</code>
                  </th>
                  <td>
                    <span class={styles.value}>{s.value}</span>
                    {s.note && <span class={styles.note}>{s.note}</span>}
                  </td>
                  <td class={styles.source}>
                    <Tag source={s.source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Hosts its sandboxes may reach</h3>
          <table class={styles.table}>
            <tbody>
              {config.effective.hosts.map((h) => (
                <tr key={h.host}>
                  <th scope="row">
                    <code>{h.host}</code>
                  </th>
                  <td>{h.note && <span class={styles.note}>{h.note}</span>}</td>
                  <td class={styles.source}>
                    <Tag source={h.source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {config.effective.mounts.length > 0 && (
            <>
              <h3>Host mounts</h3>
              <table class={styles.table}>
                <tbody>
                  {config.effective.mounts.map((m) => (
                    <tr key={m.path}>
                      <th scope="row">
                        <code>{m.path}</code>
                      </th>
                      <td>
                        <span class={styles.value}>{m.readOnly ? "read-only" : "read-write"}</span>
                        {m.note && <span class={styles.note}>{m.note}</span>}
                      </td>
                      <td class={styles.source}>
                        <Tag source={m.source} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3>The operator's grant</h3>
          {config.effective.grant ? (
            <GrantTable grant={config.effective.grant} />
          ) : (
            <p class={styles.muted}>Unknown: the operator's grants have errors.</p>
          )}

          <PolicySection policies={config.policies} />

          {config.file && (
            <>
              <h3>
                <code>.deckhand.yaml</code>
              </h3>
              <pre class={styles.raw}>{config.file.text}</pre>
            </>
          )}
        </>
      )}
    </div>
  );
}

// The policy files that apply, their `deny_*` rules, and the config check's errors: those
// don't stop runs, they refuse every decision a policy is asked for (fail closed).
function PolicySection({ policies }: { policies: Policies | undefined }) {
  if (!policies) return null;
  const { files, errors, warnings } = policies;
  return (
    <>
      <h3>Policies</h3>
      {errors.length > 0 && (
        <div class={`${styles.box} ${styles.errors}`} role="alert">
          <strong>Every decision a policy is asked for refuses until these are fixed</strong>
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div class={`${styles.box} ${styles.warnings}`}>
          <strong>Policy warnings</strong>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {files.length === 0 ? (
        <p class={styles.muted}>
          None: no <code>.deckhand/policy/*.rego</code> on the default branch, and none in the
          operator's grants folder. Only the built-in gates decide.
        </p>
      ) : (
        <table class={styles.table}>
          <tbody>
            {files.map((f) => (
              <tr key={f.name}>
                <th scope="row">
                  {f.url ? (
                    <a href={f.url} target="_blank" rel="noreferrer">
                      <code>{f.name}</code>
                    </a>
                  ) : (
                    <code>{f.name}</code>
                  )}
                </th>
                <td>
                  <span class={styles.value}>
                    {f.rules.length ? f.rules.join(", ") : "no deny_* rule"}
                  </span>
                  <span class={styles.note}>
                    {f.source === "operator"
                      ? "policy/ in the operator's grants folder"
                      : f.replaces
                        ? ".deckhand/policy/, replaces the operator's file of this name"
                        : ".deckhand/policy/"}
                  </span>
                </td>
                <td class={styles.source}>
                  <Tag source={f.source} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// Which grant to fix, and whether it stops this repository's runs or every one.
function GrantsErrorItem({ error }: { error: NonNullable<RepoConfig["grantsError"]> }) {
  const where = error.everyRepo ? "any repository" : "this repository";
  return (
    <li>
      {error.file ? (
        <>
          <code>{error.file}</code> in the operator's grants folder
        </>
      ) : (
        "The operator's grants folder"
      )}{" "}
      has errors, so no run starts in {where}: {error.message}
    </li>
  );
}

const AUTO_MERGE_DOCS =
  "https://github.com/BryanSmee/deckhand/blob/main/docs/security.md#auto-merge";

// What auto-merge gives up, at the top of the panel: it is on (granted and in the config).
// `preview`: its preview hook is granted, and acknowledged with auto-merge.
function AutoMergeBox({ isPrivate, preview }: { isPrivate: boolean; preview: boolean }) {
  return (
    <div class={`${styles.box} ${styles.errors}`} role="note">
      <strong>Auto-merge: no human review</strong>
      <p>
        Deckhand merges its own pull requests here after its review (and fix run) finds nothing
        blocking. Model output reaches the default branch with nobody reading it: a prompt injection
        in an issue or comment, or a wrong fix, ships, and runs the repository's workflows on the
        default branch with its secrets.
      </p>
      {!isPrivate && (
        <p>
          <strong>This repository is public:</strong> anyone can comment, so anyone can try to steer
          what gets merged.
        </p>
      )}
      {preview && (
        <p>
          <strong>Its preview hook runs the default branch as root on the host</strong>{" "}
          (acknowledge_automerge_and_preview_is_highly_dangerous): an auto-merged change can reach
          root on the host with nobody reading it.
        </p>
      )}
      <p>
        <a href={AUTO_MERGE_DOCS} target="_blank" rel="noreferrer">
          What it gives up, and its gates
        </a>
      </p>
    </div>
  );
}

function GrantTable({ grant }: { grant: Grant }) {
  const { cpus, memory, pids } = grant.limits;
  const files = grant.files.length
    ? grant.files.join(", ")
    : "none: nothing beyond what every repository gets";
  const rows: [string, string][] = [
    ["files", files],
    ["allow_dockerfile", String(grant.allowDockerfile)],
    ["allow_branch_docker_images", String(grant.allowBranchDockerImages)],
    ["allow_preview", String(grant.allowPreview)],
    ["allow_docker", String(grant.allowDocker)],
    ["allow_research", String(grant.allowResearch)],
    ["allow_workflows", String(grant.allowWorkflows)],
    ["allow_auto_merge", String(grant.allowAutoMerge)],
    [
      "acknowledge_automerge_and_preview_is_highly_dangerous",
      String(grant.acknowledgeAutoMergePreview),
    ],
    ["hosts", grant.hosts.join(", ") || "none"],
    ["cached_hosts", grant.cachedHosts.join(", ") || "none"],
    [
      "mounts",
      grant.mounts.map((m) => `${m.root}${m.readOnly ? " (read-only)" : ""}`).join(", ") || "none",
    ],
    ["limits", `${cpus} CPUs, ${memory} memory, ${pids} processes`],
  ];
  return (
    <table class={styles.table}>
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key}>
            <th scope="row">
              <code>{key}</code>
            </th>
            <td colSpan={2}>
              <span class={styles.value}>{value}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
