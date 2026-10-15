// The repositories the App is installed on: which have a .deckhand.yaml (and whether it has
// errors), which are being onboarded (with their issue), and a button that starts onboarding
// on the others. A repository's name opens its config (ConfigPanel).
import { useEffect, useState } from "preact/hooks";
import type { RepoList } from "./api";
import { ConfigPanel } from "./ConfigPanel";
import { ago, REPO_LABELS as LABELS } from "./format";
import type { Repo, RepoStatus } from "./types";
import styles from "./Repos.module.css";

// The ones that need the maintainer first, then by name (the listener sorts by name).
const ORDER: RepoStatus[] = ["invalid", "not-onboarded", "onboarding", "unknown", "configured"];

export function notOnboarded(repos: Repo[] | null): number {
  return repos?.filter((r) => r.status === "not-onboarded").length ?? 0;
}

// The clock "read … ago" is compared with, ticking.
export function useNow(everyMs = 15000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

interface Props {
  list: RepoList;
  onBack: () => void;
  // The repository whose config is open, and how to open one (null: back to the list).
  open?: string | null;
  onOpen?: (repo: string | null) => void;
}

export function Repos({ list, onBack, open = null, onOpen = () => {} }: Props) {
  const { repos, listedAt, error, starting, failed, onboard } = list;
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
          {list.refreshError && (
            <span class={styles.failed} role="alert">
              Couldn't refresh ({list.refreshError})
            </span>
          )}
        </div>
      </div>
      {error && <p class={styles.error}>Can't list the repositories ({error}).</p>}
      {!repos && !error && <p class={styles.empty}>Loading…</p>}
      {repos?.length === 0 && (
        <p class={styles.empty}>The App isn't installed on any allowed repository yet.</p>
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
              </div>
              <span class={`${styles.status} ${styles[r.status]}`}>{LABELS[r.status]}</span>
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
