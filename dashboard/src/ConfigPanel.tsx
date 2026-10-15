// One repository's config, read-only: what stops or worries its runs first (errors, refused
// settings and mounts, warnings), then what its runs get, each value tagged with where it comes
// from, the operator's grant, and the raw .deckhand.yaml. Read from GitHub when it opens and
// on Refresh; changing it is a commit on the default branch.
import { useRepoConfig } from "./api";
import { ago, REPO_LABELS as LABELS } from "./format";
import type { Grant, Repo, RepoConfig, Source } from "./types";
import styles from "./ConfigPanel.module.css";

const TAGS: Record<Source, string> = {
  repo: "from repo",
  operator: "from operator",
  refused: "refused",
};

function Tag({ source }: { source: Source }) {
  return <span class={`${styles.tag} ${styles[source]}`}>{TAGS[source]}</span>;
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
          {status && <span class={`${styles.status} ${styles[status]}`}>{LABELS[status]}</span>}
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
    ["hosts", grant.hosts.join(", ") || "none"],
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
