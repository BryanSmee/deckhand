// The repositories the App is installed on: which have a .deckhand.yaml (and whether it has
// errors), which are being onboarded (with their issue), and a button that starts onboarding
// on the others. A repository's name opens its config (ConfigPanel); Manage App links to the
// App on GitHub, where repositories are added or removed. The toolbar also says which Deckhand
// runs and since when (api/state's `server`).
import type { RepoList } from "./api";
import { ConfigPanel } from "./ConfigPanel";
import { ago, uptime, versionUrl } from "./format";
import { useNow } from "./hooks";
import { ManageApp } from "./ManageApp";
import { RepoBadge } from "./RepoBadge";
import type { Repo, RepoStatus, ServerInfo } from "./types";
import styles from "./Repos.module.css";

// The ones that need the maintainer first, then by name (the listener sorts by name).
const ORDER: RepoStatus[] = ["invalid", "not-onboarded", "onboarding", "unknown", "configured"];

export function notOnboarded(repos: Repo[] | null): number {
  return repos?.filter((r) => r.status === "not-onboarded").length ?? 0;
}

interface Props {
  list: RepoList;
  onBack: () => void;
  // The repository whose config is open, and how to open one (null: back to the list).
  open?: string | null;
  onOpen?: (repo: string | null) => void;
  // api/state's, and its clock: the uptime counts on it, refreshed with the state.
  server?: ServerInfo | null;
  serverNow?: number;
}

// "Deckhand edge-1713fa6 · up 3 d 4 h · Node 26.1.0", the version linked to its code.
function Version({ server, now }: { server: ServerInfo; now: number }) {
  const url = versionUrl(server);
  return (
    <span class={styles.version}>
      Deckhand{" "}
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {server.version}
        </a>
      ) : (
        server.version
      )}
      {" · "}
      <span title={`Since ${new Date(server.startedAt).toLocaleString()}`}>
        up {uptime(server.startedAt, now)}
      </span>
      {` · Node ${server.node.replace(/^v/, "")}`}
    </span>
  );
}

export function Repos({
  list,
  onBack,
  open = null,
  onOpen = () => {},
  server = null,
  serverNow,
}: Props) {
  const { repos, app, listedAt, error, starting, failed, onboard } = list;
  const now = useNow();
  if (open) {
    return (
      <section class={styles.page} aria-label={`${open} configuration`}>
        <ConfigPanel
          repo={open}
          row={repos?.find((r) => r.repo === open) ?? null}
          onRow={list.update}
          onBack={() => onOpen(null)}
          now={now}
        />
      </section>
    );
  }
  const sorted = [...(repos ?? [])].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status),
  );
  const waiting = notOnboarded(repos);
  return (
    <section class={styles.page} aria-labelledby="repos-title">
      <div class={styles.head}>
        <button type="button" class={styles.back} onClick={onBack}>
          ← Runs
        </button>
        <h2 id="repos-title">Repositories</h2>
        <p class={styles.lead}>
          Where the App is installed and <code>ALLOWED_REPOS</code> lets it run.
          {repos &&
            (waiting
              ? ` ${waiting} without a .deckhand.yaml: onboarding opens an issue where Claude proposes one.`
              : " All of them are set up or being onboarded.")}
          {repos && " Open one to see its config and what its runs get."}
        </p>
        <div class={styles.toolbar}>
          {listedAt !== null && <span class={styles.read}>Listed {ago(listedAt, now)}</span>}
          <button
            type="button"
            class={styles.refresh}
            disabled={list.refreshing}
            onClick={list.refresh}
            title="List the installations' repositories and read every config again"
          >
            {list.refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {app && <ManageApp app={app} />}
          {list.refreshError && (
            <span class={styles.failed} role="alert">
              Couldn't refresh ({list.refreshError})
            </span>
          )}
          {server && <Version server={server} now={serverNow ?? now} />}
        </div>
      </div>
      {error && <p class={styles.error}>Can't list the repositories ({error}).</p>}
      {!repos && !error && <p class={styles.empty}>Loading…</p>}
      {repos?.length === 0 && (
        <p class={styles.empty}>
          The App isn't installed on any allowed repository yet.
          {app && (
            <>
              {" "}
              <a href={app.installUrl} target="_blank" rel="noreferrer">
                Install the App on a repository
              </a>
            </>
          )}
        </p>
      )}
      {sorted.length > 0 && (
        <ul class={styles.rows}>
          {sorted.map((r) => (
            <li key={r.repo} class={styles.row}>
              <div class={styles.name}>
                <button
                  type="button"
                  class={styles.open}
                  title={`${r.repo}: its config`}
                  onClick={() => onOpen(r.repo)}
                >
                  {r.repo}
                </button>
                {r.private && <span class={styles.private}>private</span>}
                {r.autoMerge && (
                  <span
                    class={styles.autoMerge}
                    title="Deckhand merges its own pull requests after its review: nobody reads them before they reach the default branch"
                  >
                    Auto-merge: no human review
                  </span>
                )}
              </div>
              <RepoBadge status={r.status} class={styles.status} />
              <div class={styles.action}>
                {r.status === "onboarding" && r.issue && (
                  <a href={r.issue.url} target="_blank" rel="noreferrer">
                    Issue #{r.issue.number}
                  </a>
                )}
                {r.status === "not-onboarded" &&
                  (r.issues ? (
                    <button
                      type="button"
                      class={styles.start}
                      disabled={starting !== null}
                      onClick={() => onboard(r.repo)}
                    >
                      {starting === r.repo ? "Starting…" : "Start onboarding"}
                    </button>
                  ) : (
                    <span class={styles.note}>Issues are disabled: can't be onboarded</span>
                  ))}
                {r.status === "invalid" && (
                  <span class={styles.note}>No run starts: open it to see why</span>
                )}
                {r.status === "unknown" && (
                  <span class={styles.note}>GitHub didn't answer: see the listener's logs</span>
                )}
              </div>
              {failed?.repo === r.repo && (
                <p class={styles.failed} role="alert">
                  {failed.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
